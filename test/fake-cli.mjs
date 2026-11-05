/**
 * A stand-in for the CodeBuddy CLI: two assistant messages in one turn, the
 * first ending on a `Write` call, and the exact frame order the real CLI uses
 * (`stream_event`s, then one `assistant` frame per block, then the `user` frame
 * carrying the tool result).
 *
 * It exists so the step machinery can be tested without a model: the frame
 * shapes are copied from a recorded turn (`recon/cb2/tsp.jsonl`), not invented.
 *
 * Each invocation appends one line to the file named by
 * `DSH_CODEBUDDY_FAKE_COUNTER`, which is how a test proves that a whole turn —
 * including its continuation steps — ran in a single CLI process.
 */
import { appendFileSync } from 'node:fs'

const CALL_ID = 'call_fake_0001'
const SECOND_CALL_ID = 'call_fake_0002'
const FILE = 'fake-probe.txt'

const counter = process.env['DSH_CODEBUDDY_FAKE_COUNTER']
if (typeof counter === 'string' && counter !== '') appendFileSync(counter, `${process.pid}\n`)

// Record the argv this turn was launched with, so a test can assert on flags
// the adapter is responsible for passing through (`--max-turns` in particular)
// without needing a real model.
const argvLog = process.env['DSH_CODEBUDDY_FAKE_ARGV']
if (typeof argvLog === 'string' && argvLog !== '') appendFileSync(argvLog, `${JSON.stringify(process.argv.slice(2))}\n`)
const envLog = process.env['DSH_CODEBUDDY_FAKE_ENV']
if (typeof envLog === 'string' && envLog !== '') {
  appendFileSync(envLog, `${JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    USERPROFILE: process.env.USERPROFILE ?? '',
    HOME: process.env.HOME ?? '',
    CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR ?? '',
  })}\n`)
}

/** Write one NDJSON frame. */
function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/** Emit a message start and its opening block. */
function blockStart(index, contentBlock) {
  send({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: contentBlock } })
}

/** Emit one delta for a block. */
function delta(index, body) {
  send({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: body } })
}

/** Close one block. */
function blockStop(index) {
  send({ type: 'stream_event', event: { type: 'content_block_stop', index } })
}

/** Emit a full assistant message as text deltas. */
function textMessage(index, text) {
  blockStart(index, { type: 'text', text: '' })
  for (const word of text.split(' ')) delta(index, { type: 'text_delta', text: `${word} ` })
  blockStop(index)
}

const usage = { input_tokens: 2600, cache_creation_input_tokens: 0, cache_read_input_tokens: 2400, output_tokens: 24 }

/** The call id a permission scenario uses for the request at `index`. */
function permissionCallId(index) {
  return `call_fake_perm_000${index + 1}`
}

/**
 * The permission questions this scenario asks, in order.
 *
 * The real CLI asks exactly one `can_use_tool` question per gated tool call, so
 * the default is one `Write`; a test can override the list — a second call, a
 * different tool, hostile arguments — through `DSH_CODEBUDDY_FAKE_PERMISSION_TOOLS`.
 * @returns an array of `{ tool_name, input }`.
 */
function permissionRequests() {
  const raw = process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TOOLS']
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // A malformed override falls through to the default rather than crashing
      // the fake, which would read as a bridge failure in the test output.
    }
  }
  return [{ tool_name: 'Write', input: { content: 'FAKE-CONTENT', file_path: FILE } }]
}

/** Append one received `control_response`, so a test can assert on the answer. */
function recordApproval(entry) {
  const log = process.env['DSH_CODEBUDDY_FAKE_APPROVALS']
  if (typeof log === 'string' && log !== '') appendFileSync(log, `${JSON.stringify(entry)}\n`)
}

/**
 * Replay a turn that stops to ask permission, the way the real CLI does under
 * `--permission-mode default`.
 *
 * The questions are emitted after the assistant message that contains the
 * matching `tool_use` blocks, and the rest of the turn waits for each answer:
 * that ordering is what makes an unanswered request hang the real process, so
 * the fake waits too — but only for `DSH_CODEBUDDY_FAKE_PERMISSION_TIMEOUT_MS`,
 * after which it reports the stall and exits. A bridge that forgets to answer
 * therefore fails the test instead of hanging the suite.
 */
function emitPermissionTurn() {
  const requests = permissionRequests()
  const timeoutMs = Number(process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TIMEOUT_MS'] ?? 30_000)
  const answers = new Map()
  const waiters = new Map()
  let buffer = ''

  /** Wait for the answer to one request id; `undefined` means it never came. */
  const waitFor = requestId => new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(requestId)
      resolve(undefined)
    }, timeoutMs)
    waiters.set(requestId, value => {
      clearTimeout(timer)
      resolve(value)
    })
  })

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(String.fromCharCode(10))
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame?.type !== 'control_response') continue
      const requestId = frame?.response?.request_id
      recordApproval(frame)
      const waiter = waiters.get(requestId)
      if (waiter !== undefined) {
        waiters.delete(requestId)
        waiter(frame)
      } else {
        answers.set(requestId, frame)
      }
    }
  })
  process.stdin.resume()

  send({ type: 'system', subtype: 'init', session_id: 'fake' })
  send({ type: 'system', subtype: 'status', status: 'running' })
  send({ type: 'stream_event', event: { type: 'message_start' } })
  textMessage(0, 'I need permission before touching the files.')
  requests.forEach((request, index) => {
    blockStart(index + 1, { type: 'tool_use', id: permissionCallId(index), name: request.tool_name, input: {} })
    delta(index + 1, { type: 'input_json_delta', partial_json: JSON.stringify(request.input ?? {}) })
    blockStop(index + 1)
  })
  send({ type: 'stream_event', event: { type: 'message_delta', usage } })
  send({ type: 'stream_event', event: { type: 'message_stop' } })
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I need permission before touching the files.' }] } })

  const settled = requests.map(async (request, index) => {
    const requestId = `perm_fake_${index + 1}`
    send({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: request.tool_name,
        input: request.input ?? {},
        tool_use_id: permissionCallId(index),
      },
      _meta: { model: 'glm-5.3', permission_mode: 'default' },
    })
    const frame = answers.get(requestId) ?? await waitFor(requestId)
    return frame
  })

  Promise.all(settled).then((frames) => {
    const missing = frames.findIndex(frame => frame === undefined)
    if (missing !== -1) {
      // A request the bridge never answered. Report it as a failed turn, which
      // is the only observable a hung CLI process can produce.
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`permission request ${missing + 1} was never answered`], usage })
      process.stdout.write('', () => process.exit(1))
      return
    }
    const decisions = frames.map((frame, index) => {
      const inner = frame?.response?.response
      const allowed = inner?.allowed === true
      return {
        allowed,
        reason: typeof inner?.reason === 'string' ? inner.reason : '',
        index,
      }
    })
    if (process.env['DSH_CODEBUDDY_FAKE_PERMISSION_NO_USER_RESULT'] !== '1') {
      send({
        type: 'user',
        message: {
          role: 'user',
          content: decisions.map(decision => ({
            type: 'tool_result',
            tool_use_id: permissionCallId(decision.index),
            content: [{ type: 'text', text: decision.allowed ? `Ran ${requests[decision.index].tool_name}` : decision.reason }],
            is_error: !decision.allowed,
          })),
        },
      })
    }
    const granted = decisions.filter(decision => decision.allowed).length
    const denied = decisions.length - granted
    send({ type: 'stream_event', event: { type: 'message_start' } })
    textMessage(0, `FAKE-DONE allowed=${granted} denied=${denied}`)
    send({ type: 'stream_event', event: { type: 'message_delta', usage } })
    send({ type: 'stream_event', event: { type: 'message_stop' } })
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `FAKE-DONE allowed=${granted} denied=${denied}` }] } })
    // A denied tool is a tool error, not a failed turn: the real CLI still
    // finishes `subtype: "success"` with exit 0.
    send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `FAKE-DONE allowed=${granted} denied=${denied}`,
      usage: { input_tokens: 5200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4800, output_tokens: 48 },
      ...denied > 0 ? { permission_denials: decisions.filter(decision => !decision.allowed).map(decision => ({ tool_name: requests[decision.index].tool_name, tool_use_id: permissionCallId(decision.index), reason: decision.reason })) } : {},
    })
    process.stdout.write('', () => process.exit(0))
  })
}

/**
 * Replay one turn.
 *
 * Everything the fake says belongs to a single user message: the assistant's
 * text and tool call, then the tool result the real CLI reports, then the
 * answer. Emitting it per message is what lets a warm session answer again.
 */
function emitTurn() {
if (process.env['DSH_CODEBUDDY_FAKE_TEXT_ONLY'] === '1') {
  send({ type: 'stream_event', event: { type: 'message_start' } })
  textMessage(0, 'TEXT-ONLY-DONE')
  send({ type: 'stream_event', event: { type: 'message_stop' } })
  send({ type: 'result', subtype: 'success', is_error: false, result: 'TEXT-ONLY-DONE', usage })
  return
}
const failure = process.env['DSH_CODEBUDDY_FAKE_FAILURE']
if (failure === '429' && String(process.env.CODEBUDDY_CONFIG_DIR ?? '').includes('a0')) {
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['HTTP 429: too many requests'], usage })
  return
}
if (failure === 'after-text') {
  send({ type: 'stream_event', event: { type: 'message_start' } })
  textMessage(0, 'PARTIAL-OUTPUT')
  send({ type: 'stream_event', event: { type: 'message_stop' } })
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['unknown failure after partial output'], usage })
  return
}
if (failure === 'after-tool') {
  send({ type: 'stream_event', event: { type: 'message_start' } })
  blockStart(0, { type: 'tool_use', id: CALL_ID, name: 'Write', input: {} })
  delta(0, { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: FILE, content: 'SIDE-EFFECT' }) })
  blockStop(0)
  send({ type: 'stream_event', event: { type: 'message_stop' } })
  send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL_ID, content: 'Wrote side effect', is_error: false }] } })
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['HTTP 429 after tool side effect'], usage })
  return
}
send({ type: 'system', subtype: 'init', session_id: 'fake' })
send({ type: 'system', subtype: 'status', status: 'running' })

// --- message 1: a sentence, then a Write call ------------------------------
send({ type: 'stream_event', event: { type: 'message_start' } })
blockStart(0, { type: 'thinking', thinking: '' })
delta(0, { type: 'thinking_delta', thinking: 'I should write the file first.' })
blockStop(0)
textMessage(1, 'Writing the file now.')
blockStart(2, { type: 'tool_use', id: CALL_ID, name: 'Write', input: {} })
delta(2, { type: 'input_json_delta', partial_json: '{"content":"FAKE-CONTENT","file_path":"' })
delta(2, { type: 'input_json_delta', partial_json: `${FILE}"}` })
blockStop(2)

// The `two` scenario puts a second call in the same message, so the step has to
// wait for both results before it may settle.
const twoCall = process.env['DSH_CODEBUDDY_FAKE_SCENARIO'] === 'two'
if (twoCall) {
  blockStart(3, { type: 'tool_use', id: SECOND_CALL_ID, name: 'Read', input: {} })
  delta(3, { type: 'input_json_delta', partial_json: `{"file_path":"${FILE}"}` })
  blockStop(3)
}

send({ type: 'stream_event', event: { type: 'message_delta', usage } })
send({ type: 'stream_event', event: { type: 'message_stop' } })
send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Writing the file now.' }] } })
send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: CALL_ID, name: 'Write', input: { content: 'FAKE-CONTENT', file_path: FILE } }] } })

// The result arrives only after the message closed, which is the ordering the
// step machinery has to survive: DSH dispatches the card as soon as the step
// settles, so the step may not settle before this frame has been read.
send({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: CALL_ID, content: [{ type: 'text', text: `Wrote ${FILE}` }], is_error: false },
        ...twoCall
          ? [{ type: 'tool_result', tool_use_id: SECOND_CALL_ID, content: [{ type: 'text', text: `Read ${FILE}` }], is_error: false }]
          : [],
      ],
    },
  })

  // --- message 2: the answer, with no tool call ---------------------------
  send({ type: 'stream_event', event: { type: 'message_start' } })
  textMessage(0, 'FAKE-DONE wrote the file.')
  send({ type: 'stream_event', event: { type: 'message_delta', usage } })
  send({ type: 'stream_event', event: { type: 'message_stop' } })
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE-DONE wrote the file.' }] } })
  send({ type: 'result', subtype: 'success', is_error: false, result: 'FAKE-DONE wrote the file.', usage: { input_tokens: 5200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4800, output_tokens: 48 } })

  }

if (process.env['DSH_CODEBUDDY_FAKE_IGNORE_TERM'] === '1') {
  process.on('SIGTERM', () => {})
  process.stdin.resume()
  setInterval(() => {}, 60_000)
} else if (process.argv.includes('--acp')) {
  // Minimal ACP catalog: the multiplier varies with the isolated account home,
  // which lets the offline suite catch a probe that accidentally uses the host.
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(String.fromCharCode(10))
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      if (frame?.id === 1) {
        send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (frame?.id === 2) {
        const pooled = typeof process.env.CODEBUDDY_CONFIG_DIR === 'string' && process.env.CODEBUDDY_CONFIG_DIR.includes('codebuddy-homes')
        send({ jsonrpc: '2.0', id: 2, result: { models: { availableModels: [{ modelId: 'glm-5.3', name: 'GLM', _meta: { credits: pooled ? 'x0.88 credits' : 'x0.11 credits' } }] } } })
      }
    }
  })
  process.stdin.resume()
} else if (process.env['DSH_CODEBUDDY_FAKE_SCENARIO'] === 'permission') {
  // Answers can arrive before the whole turn has been emitted, so this scenario
  // owns stdin from the start rather than relying on a later listener.
  emitPermissionTurn()
} else if (process.env['DSH_CODEBUDDY_FAKE_STAY_ALIVE'] === '1') {
  // Parked like the real CLI: every further user message starts another turn,
  // and the process stays alive on stdin instead of exiting after one turn.
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(String.fromCharCode(10))
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') {
      const inputLog = process.env['DSH_CODEBUDDY_FAKE_INPUT']
      if (typeof inputLog === 'string' && inputLog !== '') appendFileSync(inputLog, `${JSON.stringify(line)}\n`)
      setTimeout(emitTurn, 20)
    }
  })
  process.stdin.resume()
} else if (process.env['DSH_CODEBUDDY_FAKE_ECHO_FIRST'] === '1') {
  // Test probe: report the text of the first user frame back through the
  // result, so a test can assert exactly what the adapter sent to the CLI.
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(String.fromCharCode(10))
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let text = ''
      try {
        const frame = JSON.parse(line)
        const block = frame?.message?.content?.find(part => part?.type === 'text')
        text = typeof block?.text === 'string' ? block.text : ''
      } catch { text = '' }
      send({ type: 'system', subtype: 'init', session_id: 'fake' })
      send({ type: 'result', subtype: 'success', is_error: false, result: `ECHO:${text}`, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } })
      // process.exit would truncate a pending stdout pipe flush — long frames
      // arrived cut short. Drain first, then exit.
      process.stdout.write('', () => process.exit(0))
    }
  })
  process.stdin.resume()
} else {
  setTimeout(emitTurn, 120)
}
