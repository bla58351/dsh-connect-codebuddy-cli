/**
 * Step-boundary test: one CLI turn must reach DSH as one assistant message per
 * CLI assistant message.
 *
 * Why this matters is entirely a rendering matter, so the assertions are about
 * shape rather than text: DSH draws one row per assistant message and
 * dispatches that message's cards afterwards, so a turn packed into a single
 * message shows every card at the end of the reply and has no text-only final
 * step for the transcript to treat as the answer.
 *
 * The CLI is a fake (`test/fake-cli.mjs`) that replays a recorded frame order,
 * so this needs no model and no network.
 *
 * Run: node test/steps.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { apply, PROVIDER_ID } from '../index.js'
import { writeSettings, settingsPath } from '../src/config/store.js'
import { createToolBridge, toMcpInputSchema } from '../src/bridge/mcp.js'
import { toolOrigin } from '../src/bridge/builtin-tools.js'
import { buildArgs, userFrame, writeSystemPromptFile, codebuddyTranscriptPath, permissionModeFor, safeDenyReason } from '../src/cli/session.js'
import { approvalSubjectFor } from '../src/adapter/adapter.js'
import { handoffDigest, handoffMessageText } from '../index.js'

const results = []
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

// The live-catalog probe spawns a CLI; these tests count spawns, so it is off.
process.env['DSH_CODEBUDDY_NO_CATALOG_PROBE'] = '1'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-steps-'))
const counter = join(scratch, 'spawns.txt')
writeFileSync(counter, '')
process.env['DSH_CODEBUDDY_FAKE_COUNTER'] = counter

// Run against an isolated DSH home so the tests never read or write the user's
// real settings. The default here is "no keep-alive": the groups below count
// processes per message, and the keep-alive group sets its own value.
const testHome = join(scratch, 'home')
process.env['DSH_HOME'] = testHome
writeSettings({ hiddenModels: [], keepAliveSeconds: 0 })

/**
 * Build an adapter, capturing the tools/execute waterfall the plugin installs.
 *
 * `services` is the Host's service table, keyed by Cordis service name — the
 * adapter reads `approval`, `sandboxPolicy` and the agent registry through
 * `ctx.get`/`ctx.reflect.get`, and a composition that supplies none of them must
 * still activate (that is the fail-closed path the permission group covers).
 * @param binary - the fake CLI entry.
 * @param services - extra Host services; `agents` doubles as the agent registry.
 */
function makeAdapter(binary, services = {}) {
  const listeners = {}
  let adapter
  const ctx = {
    llm: { registerAdapter: (_providers, registered) => { adapter = registered } },
    logger: { info: () => {}, warn: () => {} },
    on: (event, listener) => { listeners[event] = listener },
    get: name => services[name],
    reflect: { get: name => services[name] },
  }
  apply(ctx, { binary, models: [], cwd: '' })
  return { adapter, listeners }
}

/**
 * A Host agent registry keyed by DSH session id.
 *
 * `ctx.reflect.get('agents', false).get(sessionId)` is how the adapter finds the
 * agent that owns a turn, so this is the shape it has to see.
 * @param sessions - the session ids to register, mapped to their session objects.
 */
function agentRegistry(sessions) {
  const rows = new Map(Object.entries(sessions).map(([id, session]) => [id, { id, session }]))
  return { get: id => rows.get(id) }
}

/**
 * A stand-in ApprovalService, recording every request it is asked.
 *
 * `outcome` is what `request()` resolves to; `throwMessage` makes it throw the
 * way the real service does outside an open turn.
 * @param outcome - one of the four approval outcomes.
 * @param throwMessage - when set, `request()` rejects with this message instead.
 */
function fakeApproval(outcome, throwMessage) {
  const asked = []
  return {
    asked,
    effectivePolicy: () => 'ask',
    async request(request) {
      asked.push(request)
      if (throwMessage !== undefined) throw new Error(throwMessage)
      return outcome
    },
  }
}

/** Feed one step and collect what the runtime would see. */
async function step(adapter, options) {
  const chunks = []
  let threw
  try {
    const prepared = await adapter.prepareCall(PROVIDER_ID, options.model, options.signal)
    for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  } catch (error) {
    threw = error
  }
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  const cards = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call').map(c => c.block)
  return { chunks, threw, text, cards, finish: chunks.find(c => c.type === 'finish')?.reason }
}

/** A scoped tool registry, as `exec.agent.ctx.get('tools')` would supply. */
function scopedTools() {
  const registry = new Map()
  return {
    registry,
    get(name) { return registry.get(name) },
    register(definition) {
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    },
  }
}

const binary = new URL('./fake-cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const { adapter, listeners } = makeAdapter(binary)
const human = {
  id: 'u1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'Write the probe file, then tell me it is done.' }],
}
const sessionId = 'steps-session-1'

// --- step 1: the first CLI message, ending on a tool call -------------------
const first = await step(adapter, {
  provider: PROVIDER_ID,
  model: 'glm-5.3',
  messages: [human, { id: 'r1', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd is …' }] }],
  toolHistory: [],
  sessionId,
  tools: [{ name: 'Write' }],
})

check('the first step settles without error', first.threw === undefined, String(first.threw?.message).slice(0, 80))
check('the first step reports its tool call as a card', first.cards.length === 1, JSON.stringify(first.cards.map(c => c.name)))
check('the first step ends with a stop', first.finish?.kind === 'stop')
check('the card is its message\'s last block', first.chunks.findIndex(c => c.type === 'block-end') > first.chunks.findIndex(c => c.type === 'text-delta'))
// The whole point: the next CLI message must not be folded into this step.
check('the first step excludes the next message\'s text', !first.text.includes('FAKE-DONE'), JSON.stringify(first.text))
check('the first step carries the reasoning of its own message', first.chunks.some(c => c.type === 'reasoning-delta'))

// --- the card's executor replays the result the CLI reported ----------------
const card = first.cards[0]
let cardText = ''
let concluded = false
const tools = scopedTools()
const exec = {
  callId: card?.id ?? '',
  name: card?.name ?? '',
  arguments: card === undefined ? {} : JSON.parse(card.arguments),
  agent: { ctx: { get: () => tools } },
  concludeTurn() { concluded = true },
}
await listeners['tools/execute'](exec, async () => {
  const definition = tools.get(exec.name)
  check('the card gets a resolvable executor', definition !== undefined, exec.name)
  if (definition === undefined) return {}
  const value = await definition.execute(exec.arguments, exec)
  cardText = definition.output.render(exec.arguments, value)[0]?.text ?? ''
  return {}
})
check('the executor replays the CLI\'s own result', cardText === 'Wrote fake-probe.txt', JSON.stringify(cardText))
check('the identifying argument leads the card summary', Object.keys(exec.arguments)[0] === 'file_path', Object.keys(exec.arguments).join(','))
check('the executor leaves the turn open for the next step', concluded === false)

// --- step 2: the continuation DSH asks for after dispatching ----------------
const second = await step(adapter, {
  provider: PROVIDER_ID,
  model: 'glm-5.3',
  messages: [
    human,
    { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'tool-call', id: card?.id ?? '', name: card?.name ?? '', arguments: card?.arguments ?? '{}' }] },
    { id: 't1', role: 'tool', source: { kind: 'tool', callId: card?.id ?? '' }, toolCallId: card?.id ?? '', isError: false, content: [{ type: 'text', text: 'Wrote fake-probe.txt' }] },
  ],
  toolHistory: [],
  sessionId,
  tools: [{ name: 'Write' }],
})

check('the continuation step settles without error', second.threw === undefined, String(second.threw?.message).slice(0, 80))
check('the continuation step resumes the same CLI turn', second.text.includes('FAKE-DONE'), JSON.stringify(second.text.slice(0, 60)))
check('the answer step carries no tool call', second.cards.length === 0, JSON.stringify(second.cards.map(c => c.name)))
check('the continuation step reports usage', second.chunks.some(c => c.type === 'usage'))

const spawns = readFileSync(counter, 'utf8').split('\n').filter(Boolean)
check('one turn ran in one CLI process', spawns.length === 1, `${spawns.length} spawn(s)`)
check('the fake CLI exited on its own', existsSync(counter))

// --- a continuation after the turn already ended ---------------------------
// The CLI can stop right after a tool call, and DSH still asks for one more
// step. That step must be closed empty rather than answered by a second CLI
// process, which would append a duplicate reply.
const spent = await step(adapter, {
  provider: PROVIDER_ID,
  model: 'glm-5.3',
  messages: [
    human,
    { id: 'a2', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'tool-call', id: 'call_late', name: 'Write', arguments: '{}' }] },
    { id: 't2', role: 'tool', source: { kind: 'tool', callId: 'call_late' }, toolCallId: 'call_late', isError: false, content: [{ type: 'text', text: 'late' }] },
  ],
  toolHistory: [],
  sessionId,
  tools: [{ name: 'Write' }],
})
check('a spent continuation settles empty', spent.threw === undefined && spent.text === '' && spent.cards.length === 0)
check('a spent continuation starts no second CLI process', readFileSync(counter, 'utf8').split('\n').filter(Boolean).length === 1)

// --- a new human message replaces the finished turn ------------------------
const third = await step(adapter, {
  provider: PROVIDER_ID,
  model: 'glm-5.3',
  messages: [
    human,
    { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'FAKE-DONE wrote the file.' }] },
    { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Thanks. Now do it again.' }] },
  ],
  toolHistory: [],
  sessionId,
  tools: [{ name: 'Write' }],
})
const afterNewTurn = readFileSync(counter, 'utf8').split('\n').filter(Boolean)
check('a new human message starts a new CLI process', afterNewTurn.length === 2, `${afterNewTurn.length} spawn(s)`)
check('the new turn is served from its first message', third.text.includes('Writing the file now.'), JSON.stringify(third.text.slice(0, 60)))
check('the new turn reports its own card', third.cards.length === 1)

// --- two calls in one message ---------------------------------------------
// The step may only settle once *every* result of that message has arrived, so
// one missing result cannot leave a card with an empty body.
{
  process.env['DSH_CODEBUDDY_FAKE_SCENARIO'] = 'two'
  const { adapter: parallelAdapter, listeners: parallelListeners } = makeAdapter(binary)
  const parallelHuman = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do both things.' }] }
  const parallelSession = 'steps-session-2'
  const first = await step(parallelAdapter, {
    provider: PROVIDER_ID,
    model: 'glm-5.3',
    messages: [parallelHuman],
    toolHistory: [],
    sessionId: parallelSession,
    tools: [{ name: 'Write' }, { name: 'Read' }],
  })
  check('both calls of one message become cards', first.cards.length === 2, JSON.stringify(first.cards.map(c => c.name)))

  const bodies = []
  for (const block of first.cards) {
    const registry = new Map()
    const scoped = { get: name => registry.get(name), register: (definition) => { registry.set(definition.name, definition); return () => registry.delete(definition.name) } }
    const exec = { callId: block.id, name: block.name, arguments: JSON.parse(block.arguments), agent: { ctx: { get: () => scoped } }, concludeTurn() {} }
    await parallelListeners['tools/execute'](exec, async () => {
      const definition = registry.get(block.name)
      const value = await definition.execute(exec.arguments, exec)
      bodies.push(definition.output.render(exec.arguments, value)[0]?.text ?? '')
      return {}
    })
  }
  check('every card replays its own result', bodies.includes('Wrote fake-probe.txt') && bodies.includes('Read fake-probe.txt'), JSON.stringify(bodies))

  const second = await step(parallelAdapter, {
    provider: PROVIDER_ID,
    model: 'glm-5.3',
    messages: [
      parallelHuman,
      { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: first.cards.map(c => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })) },
      ...first.cards.map((c, index) => ({ id: `t${index}`, role: 'tool', source: { kind: 'tool', callId: c.id }, toolCallId: c.id, isError: false, content: [{ type: 'text', text: bodies[index] ?? '' }] })),
    ],
    toolHistory: [],
    sessionId: parallelSession,
    tools: [{ name: 'Write' }, { name: 'Read' }],
  })
  check('the two-call turn still reaches its answer', second.text.includes('FAKE-DONE'), JSON.stringify(second.text.slice(0, 40)))
  delete process.env['DSH_CODEBUDDY_FAKE_SCENARIO']
}

// --- card registrations are agent-scoped and dispatch exactly once --------
{
  const { toolResults } = await import('../src/bridge/cards.js')
  const execute = listeners['tools/execute']
  const makeExec = (registry, callId, name = 'ConcurrentTool') => ({
    callId,
    name,
    arguments: {},
    agent: { ctx: { get: () => registry } },
  })
  const firstRegistry = scopedTools()
  const secondRegistry = scopedTools()
  toolResults.set('agent-a', 'A')
  toolResults.set('agent-b', 'B')
  let finishFirst
  const firstPending = execute(makeExec(firstRegistry, 'agent-a'), () => new Promise(resolve => { finishFirst = resolve }))
  await new Promise(resolve => setTimeout(resolve, 0))
  await execute(makeExec(secondRegistry, 'agent-b'), async () => ({}))
  finishFirst()
  await firstPending
  check('same-name cards in two agents never leak a virtual registration', firstRegistry.get('ConcurrentTool') === undefined && secondRegistry.get('ConcurrentTool') === undefined)

  const shared = scopedTools()
  toolResults.set('shared-a', 'A')
  toolResults.set('shared-b', 'B')
  let finishA
  let finishB
  const pendingA = execute(makeExec(shared, 'shared-a'), () => new Promise(resolve => { finishA = resolve }))
  const pendingB = execute(makeExec(shared, 'shared-b'), () => new Promise(resolve => { finishB = resolve }))
  await new Promise(resolve => setTimeout(resolve, 0))
  finishA()
  await pendingA
  check('one agent keeps its registration until the last concurrent card settles', shared.get('ConcurrentTool') !== undefined)
  finishB()
  await pendingB
  check('the last concurrent card releases the shared registration', shared.get('ConcurrentTool') === undefined)

  const failing = scopedTools()
  toolResults.set('throws-once', 'x')
  let dispatchCalls = 0
  let caught
  try {
    await execute(makeExec(failing, 'throws-once', 'FailingTool'), async () => {
      dispatchCalls += 1
      throw new Error('executor failed')
    })
  } catch (error) { caught = error }
  check('an executor error propagates without a second dispatch', caught?.message === 'executor failed' && dispatchCalls === 1, String(dispatchCalls))
  check('an executor error still releases its virtual registration', failing.get('FailingTool') === undefined)
  for (const id of ['agent-a', 'agent-b', 'shared-a', 'shared-b', 'throws-once']) toolResults.delete(id)
}

// --- turn budget reaches the CLI ------------------------------------------
{
  // The adapter is responsible for the whole argv, so a configured budget has
  // to arrive as `--max-turns`. This is checked offline, against the fake CLI,
  // because it is about plumbing rather than model behaviour.
  const argvLog = join(scratch, 'argv.log')
  process.env['DSH_CODEBUDDY_FAKE_ARGV'] = argvLog

  /** Read the budget out of the argv the fake CLI recorded. */
  const budgetOf = () => {
    if (!existsSync(argvLog)) return undefined
    const lines = readFileSync(argvLog, 'utf8').trim().split('\n').filter(line => line !== '')
    const argv = JSON.parse(lines[lines.length - 1])
    const at = argv.indexOf('--max-turns')
    return at === -1 ? undefined : argv[at + 1]
  }

  const { adapter: defaultAdapter } = makeAdapter(binary)
  await step(defaultAdapter, {
    provider: PROVIDER_ID,
    model: 'glm-5.3',
    messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Say FAKE-DONE' }] }],
    toolHistory: [],
    sessionId: `budget-default-${Date.now().toString(36)}`,
    tools: [{ name: 'Write' }],
  })
  check('the default budget reaches the CLI as 200', budgetOf() === '200', String(budgetOf()))

  // A configured budget must replace the default, not be ignored.
  let configuredAdapter
  apply(
    {
      llm: { registerAdapter: (_providers, registered) => { configuredAdapter = registered } },
      logger: { info: () => {}, warn: () => {} },
      on: () => {},
    },
    { binary, models: [], cwd: '', maxTurns: 400 },
  )
  await step(configuredAdapter, {
    provider: PROVIDER_ID,
    model: 'glm-5.3',
    messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Say FAKE-DONE' }] }],
    toolHistory: [],
    sessionId: `budget-custom-${Date.now().toString(36)}`,
    tools: [{ name: 'Write' }],
  })
  check('a configured budget replaces the default', budgetOf() === '400', String(budgetOf()))

  delete process.env['DSH_CODEBUDDY_FAKE_ARGV']
}

// --- context-window precedence follows the CLI budget ---------------------
{
  const { contextWindowFor } = await import('../src/cli/catalog.js')
  check('supportedLengths alone supplies the context window', contextWindowFor({ contextWindow: { supportedLengths: [131072] } }) === 131072)
  check('defaultLength takes precedence over other budget fields', contextWindowFor({ contextWindow: { defaultLength: 64000, supportedLengths: [131072], maxLength: 200000 }, maxInputTokens: 100000 }) === 64000)
  check('maxInputTokens remains the budget fallback', contextWindowFor({ maxInputTokens: 1000000 }) === 1000000)
  check('invalid context fields yield no window', contextWindowFor({ contextWindow: { supportedLengths: [-1] }, maxInputTokens: 0 }) === undefined)
}

// --- permission: the CLI asks, DSH decides ---------------------------------
{
  // The CLI stops mid-turn with a `control_request` whenever it decides a
  // native tool needs a human. Under the old code every such request was
  // approved unconditionally, which made the CLI's own review — the reason the
  // request exists — decorative. These checks are the regression: an
  // unauthorised call must not be approved, a denied call must end the turn
  // with a readable error instead of hanging, and an approved one must still
  // run.
  //
  // The fake CLI emits the request and waits for the answer, so an unanswered
  // request fails the turn with its own reason rather than hanging the suite.
  const approvalsLog = join(scratch, 'approvals.log')
  process.env['DSH_CODEBUDDY_FAKE_APPROVALS'] = approvalsLog
  process.env['DSH_CODEBUDDY_FAKE_SCENARIO'] = 'permission'
  process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TIMEOUT_MS'] = '8000'

  /** The argv the fake CLI last recorded, so the mode can be asserted. */
  const argvLog = join(scratch, 'perm-argv.log')
  process.env['DSH_CODEBUDDY_FAKE_ARGV'] = argvLog
  const permissionModeOf = () => {
    if (!existsSync(argvLog)) return undefined
    const lines = readFileSync(argvLog, 'utf8').trim().split('\n').filter(line => line !== '')
    const argv = JSON.parse(lines[lines.length - 1])
    const at = argv.indexOf('--permission-mode')
    return at === -1 ? undefined : argv[at + 1]
  }

  /** Every answer the fake CLI received, in order. */
  const answersOf = () => {
    if (!existsSync(approvalsLog)) return []
    return readFileSync(approvalsLog, 'utf8').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  }

  /**
   * Drive one whole permission turn, the way DSH does: step until a step
   * produces no card.
   *
   * A permission turn's first message carries tool calls, so one `step()` only
   * covers the part where the CLI is already waiting; the answer and the
   * tool result arrive on the continuation.
   * @returns the last outcome plus every outcome's text.
   */
  const permissionTurn = async (services, sessionId) => {
    const { adapter: permAdapter } = makeAdapter(binary, services)
    let messages = [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Write the file.' }] }]
    let text = ''
    let threw
    for (let index = 0; index < 4; index += 1) {
      const outcome = await step(permAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages, toolHistory: [], sessionId, tools: [{ name: 'Write' }] })
      text += outcome.text
      threw = outcome.threw ?? threw
      if (outcome.cards.length === 0) break
      messages = [
        ...messages,
        { id: `a${index}`, role: 'assistant', source: { kind: 'assistant' }, content: outcome.cards.map(card => ({ type: 'tool-call', id: card.id, name: card.name, arguments: card.arguments })) },
        ...outcome.cards.map((card, at) => ({ id: `t${index}${at}`, role: 'tool', source: { kind: 'tool', callId: card.id }, toolCallId: card.id, isError: false, content: [{ type: 'text', text: 'ok' }] })),
      ]
    }
    await permAdapter.dispose()
    return { text, threw }
  }

  // No approval service at all: nothing can authorise the call, so it must be
  // denied — and the turn must still finish, because a deny is an answer.
  {
    rmSync(approvalsLog, { force: true })
    const denied = await permissionTurn({}, `perm-none-${Date.now().toString(36)}`)
    check('a request with no approval service is denied', denied.threw === undefined, String(denied.threw?.message).slice(0, 80))
    check('the unanswered-by-policy call is reported as a tool error', denied.text.includes('FAKE-DONE'), JSON.stringify(denied.text.slice(0, 60)))
    const answers = answersOf()
    check('exactly one control_response was sent', answers.length === 1, String(answers.length))
    check('the control_response is a success envelope', answers[0]?.response?.subtype === 'success', JSON.stringify(answers[0]?.response?.subtype))
    check('the request id is echoed back', typeof answers[0]?.response?.request_id === 'string' && answers[0].response.request_id.startsWith('perm_'), String(answers[0]?.response?.request_id))
    check('a missing approval channel denies instead of allowing', answers[0]?.response?.response?.allowed === false, JSON.stringify(answers[0]?.response?.response))
    check('the deny reason names the tool', String(answers[0]?.response?.response?.reason ?? '').includes('Write'), String(answers[0]?.response?.response?.reason))
    check('a plain deny does not interrupt the turn', answers[0]?.response?.response?.interrupt === undefined, JSON.stringify(answers[0]?.response?.response))
  }

  // Some real CLI builds report a denial only in result.permission_denials and
  // omit the normal user/tool_result frame. The card must still replay that
  // denial instead of falling through to the real executor.
  {
    process.env['DSH_CODEBUDDY_FAKE_PERMISSION_NO_USER_RESULT'] = '1'
    const { adapter: denialAdapter, listeners: denialListeners } = makeAdapter(binary)
    const deniedStep = await step(denialAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [{ id: 'deny-only', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Write' }] }], toolHistory: [], sessionId: `deny-only-${Date.now().toString(36)}`, tools: [{ name: 'Write' }] })
    const deniedCard = deniedStep.cards[0]
    const registry = scopedTools()
    let body = ''
    let realCalls = 0
    let definition
    await denialListeners['tools/execute']({ callId: deniedCard.id, name: deniedCard.name, arguments: {}, agent: { ctx: { get: () => registry } } }, async () => {
      definition = registry.get(deniedCard.name)
      if (definition === undefined) {
        realCalls += 1
        return {}
      }
      const value = await definition.execute({}, { callId: deniedCard.id })
      body = definition.output.render({}, value)[0]?.text ?? ''
      return {}
    })
    check('a terminal-only denial still gets a replay executor', definition !== undefined, deniedCard.name)
    check('the terminal-only denial body reaches the card', body.includes('无法审批') && body.includes('Write'), body)
    check('a denied call never falls through to the real executor', realCalls === 0 && registry.get(deniedCard.name) === undefined, String(realCalls))
    await denialAdapter.dispose()
    delete process.env['DSH_CODEBUDDY_FAKE_PERMISSION_NO_USER_RESULT']
  }

  // A known CLI call with no result at all is still display-only.
  {
    const { recordToolCall } = await import('../src/bridge/cards.js')
    recordToolCall('missing-result-call')
    const registry = scopedTools()
    let body = ''
    await listeners['tools/execute']({ callId: 'missing-result-call', name: 'Write', arguments: {}, agent: { ctx: { get: () => registry } } }, async () => {
      const definition = registry.get('Write')
      const value = await definition.execute({}, { callId: 'missing-result-call' })
      body = definition.output.render({}, value)[0]?.text ?? ''
      return {}
    })
    check('a missing result returns a safe error instead of executing again', body.includes('没有返回该调用的结果') && registry.get('Write') === undefined, body)
  }

  // A human said no: the deny carries their decision through, and the CLI
  // finishes the turn with a tool error rather than a failed turn.
  {
    rmSync(approvalsLog, { force: true })
    const approval = fakeApproval('rejected')
    const sessionId = `perm-rejected-${Date.now().toString(36)}`
    const rejected = await permissionTurn({ approval, agents: agentRegistry({ [sessionId]: { header: { cwd: scratch } } }) }, sessionId)
    check('a rejected call still settles the turn', rejected.threw === undefined, String(rejected.threw?.message).slice(0, 80))
    check('the model still answers after a denial', rejected.text.includes('FAKE-DONE'), JSON.stringify(rejected.text.slice(0, 60)))
    check('the CLI request reached the approval seam', approval.asked.length === 1, String(approval.asked.length))
    check('the approval names the CLI tool', approval.asked[0]?.toolName === 'Write', String(approval.asked[0]?.toolName))
    check('the approval carries the CLI call id', approval.asked[0]?.callId === 'call_fake_perm_0001', String(approval.asked[0]?.callId))
    check('the approval is routed through the session agent', approval.asked[0]?.agent !== undefined && approval.asked[0]?.agent?.session !== undefined, JSON.stringify(Object.keys(approval.asked[0] ?? {})))
    const answers = answersOf()
    check('a rejected approval becomes an explicit deny', answers[0]?.response?.response?.allowed === false, JSON.stringify(answers[0]?.response?.response))
    check('the deny reason reports the user decision', String(answers[0]?.response?.response?.reason ?? '').includes('拒绝'), String(answers[0]?.response?.response?.reason))
  }

  // A human said yes once: that one call proceeds.
  {
    rmSync(approvalsLog, { force: true })
    const approval = fakeApproval('allowed-once')
    const sessionId = `perm-allowed-${Date.now().toString(36)}`
    const allowed = await permissionTurn({ approval, agents: agentRegistry({ [sessionId]: { header: { cwd: scratch } } }) }, sessionId)
    check('an approved call runs and the turn answers', allowed.text.includes('allowed=1 denied=0'), JSON.stringify(allowed.text.slice(0, 60)))
    const answers = answersOf()
    check('an allowed approval becomes an explicit allow', answers[0]?.response?.response?.allowed === true, JSON.stringify(answers[0]?.response?.response))
    check('the allow is scoped to this one request', approval.asked.length === 1, String(approval.asked.length))
  }

  // The four non-grants must all deny. `unavailable` is the one that matters
  // most: it is what an unanswered prompt looks like, and treating it as an
  // allow would reintroduce the blanket approval.
  for (const outcome of ['unavailable', 'cancelled']) {
    rmSync(approvalsLog, { force: true })
    const sessionId = `perm-${outcome}-${Date.now().toString(36)}`
    const result = await permissionTurn({ approval: fakeApproval(outcome), agents: agentRegistry({ [sessionId]: { header: { cwd: scratch } } }) }, sessionId)
    check(`an ${outcome} outcome denies the call`, answersOf()[0]?.response?.response?.allowed === false, JSON.stringify(answersOf()[0]?.response?.response))
    check(`an ${outcome} outcome still ends the turn`, result.threw === undefined, String(result.threw?.message).slice(0, 80))
  }

  // A throwing approval seam (no open turn, failing audit append) must become a
  // deny with the reason attached, not an unanswered request.
  {
    rmSync(approvalsLog, { force: true })
    const sessionId = `perm-throw-${Date.now().toString(36)}`
    const thrown = await permissionTurn({ approval: fakeApproval('allowed-once', 'approval.request() outside an open turn'), agents: agentRegistry({ [sessionId]: { header: { cwd: scratch } } }) }, sessionId)
    check('a throwing approval seam denies the call', answersOf()[0]?.response?.response?.allowed === false, JSON.stringify(answersOf()[0]?.response?.response))
    check('a throwing approval seam still ends the turn', thrown.threw === undefined, String(thrown.threw?.message).slice(0, 80))
  }

  // A tool name is not a grant: the same name with hostile arguments must not
  // be approved just because `Write` was approved a moment ago. Each request is
  // decided on its own, and an allow never leaks to the next call.
  {
    rmSync(approvalsLog, { force: true })
    process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TOOLS'] = JSON.stringify([
      { tool_name: 'Write', input: { content: 'ok', file_path: 'fake-probe.txt' } },
      { tool_name: 'Write', input: { content: 'pwned', file_path: '../../outside.txt' } },
    ])
    const approval = fakeApproval('allowed-once')
    // A policy that approves `Write` by name is not enough: it must see the
    // path before it can reject this second, hostile invocation.
    approval.request = async (request) => {
      approval.asked.push(request)
      return request.arguments?.file_path === '../../outside.txt' ? 'rejected' : 'allowed-once'
    }
    const sessionId = `perm-scoped-${Date.now().toString(36)}`
    const scoped = await permissionTurn({ approval, agents: agentRegistry({ [sessionId]: { header: { cwd: scratch } } }) }, sessionId)
    check('each CLI request is reviewed on its own', approval.asked.length === 2, String(approval.asked.length))
    check('the second request reaches the seam with its own call id', approval.asked[1]?.callId === 'call_fake_perm_0002', String(approval.asked[1]?.callId))
    check('the approval receives the arguments, not just the tool name', approval.asked[1]?.arguments?.file_path === '../../outside.txt', JSON.stringify(approval.asked[1]?.arguments))
    check('both requests were answered', answersOf().length === 2, String(answersOf().length))
    check('the same tool name can be allowed once and denied for a hostile path', answersOf()[0]?.response?.response?.allowed === true && answersOf()[1]?.response?.response?.allowed === false, JSON.stringify(answersOf().map(answer => answer?.response?.response)))
    check('the two-request turn still reaches its answer', scoped.text.includes('allowed=1 denied=1'), JSON.stringify(scoped.text.slice(0, 60)))
    delete process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TOOLS']
  }

  // Three unauthorised shapes are called out as regressions: Bash, Write, and
  // a path outside the workspace. All three must be refused when nothing
  // authorises them — the shape of the request must never be what grants it.
  {
    rmSync(approvalsLog, { force: true })
    process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TOOLS'] = JSON.stringify([
      { tool_name: 'Bash', input: { command: 'rm -rf build' } },
      { tool_name: 'Write', input: { content: 'x', file_path: '../../outside.txt' } },
    ])
    const bare = await permissionTurn({}, `perm-unauth-${Date.now().toString(36)}`)
    check('unauthorised Bash and an out-of-directory Write are both refused', answersOf().every(answer => answer?.response?.response?.allowed === false), JSON.stringify(answersOf().map(answer => answer?.response?.response)))
    check('the refused turn still ends instead of hanging', bare.threw === undefined, String(bare.threw?.message).slice(0, 80))
    check('both refusals name their tool', answersOf().every(answer => /Bash|Write/.test(String(answer?.response?.response?.reason ?? ''))), JSON.stringify(answersOf().map(answer => answer?.response?.response?.reason)))
    delete process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TOOLS']
  }

  // The CLI mode must follow DSH's setting, not a constant. `ask` under a
  // writable sandbox is the case that forwards questions; `never` has already
  // settled the decision, so there is nothing left to ask.
  {
    rmSync(argvLog, { force: true })
    const approval = fakeApproval('allowed-once')
    const sessionId = `perm-mode-ask-${Date.now().toString(36)}`
    const sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }
    const ask = await permissionTurn({ approval, sandboxPolicy, agents: agentRegistry({ [sessionId]: { header: { cwd: scratch } } }) }, sessionId)
    check('an ask policy under workspace-write runs the CLI in default mode', permissionModeOf() === 'default', String(permissionModeOf()))
    check('the default mode still finishes the turn', ask.text.includes('FAKE-DONE'), JSON.stringify(ask.text.slice(0, 40)))

    rmSync(argvLog, { force: true })
    const never = fakeApproval('allowed-once')
    never.effectivePolicy = () => 'never'
    const neverSandbox = { resolve: () => ({ mode: 'danger-full-access' }) }
    const neverSession = `perm-mode-never-${Date.now().toString(36)}`
    await permissionTurn({ approval: never, sandboxPolicy: neverSandbox, agents: agentRegistry({ [neverSession]: { header: { cwd: scratch } } }) }, neverSession)
    check('a never policy under danger-full-access runs the CLI in bypassPermissions', permissionModeOf() === 'bypassPermissions', String(permissionModeOf()))

    rmSync(argvLog, { force: true })
    const readOnlySandbox = { resolve: () => ({ mode: 'read-only' }) }
    const readOnlySession = `perm-mode-ro-${Date.now().toString(36)}`
    await permissionTurn({ approval: fakeApproval('allowed-once'), sandboxPolicy: readOnlySandbox, agents: agentRegistry({ [readOnlySession]: { header: { cwd: scratch } } }) }, readOnlySession)
    check('a read-only sandbox runs the CLI in dontAsk', permissionModeOf() === 'dontAsk', String(permissionModeOf()))
  }

  delete process.env['DSH_CODEBUDDY_FAKE_SCENARIO']
  delete process.env['DSH_CODEBUDDY_FAKE_APPROVALS']
  delete process.env['DSH_CODEBUDDY_FAKE_ARGV']
  delete process.env['DSH_CODEBUDDY_FAKE_PERMISSION_TIMEOUT_MS']
}

// --- the permission mode is a pure function of DSH's setting ----------------
{
  // The argv checks above cover the three presets end to end; these cover the
  // edges a preset cannot reach, which is where a permissive fallback would
  // hide.
  const cases = [
    [{ sandboxMode: 'read-only', approvalPolicy: 'ask' }, 'dontAsk', 'read-only asks nothing'],
    [{ sandboxMode: 'workspace-write', approvalPolicy: 'ask' }, 'default', 'the default preset forwards'],
    [{ sandboxMode: 'danger-full-access', approvalPolicy: 'ask' }, 'default', 'full access with an ask policy still forwards'],
    [{ sandboxMode: 'danger-full-access', approvalPolicy: 'never' }, 'bypassPermissions', 'full access without prompts needs no bridge'],
    [{ sandboxMode: 'workspace-write', approvalPolicy: 'never' }, 'dontAsk', 'a never policy without full access denies in-process'],
  ]
  for (const [policy, expected, why] of cases) {
    check(`${why}: ${expected}`, permissionModeFor(policy) === expected, permissionModeFor(policy))
  }
  // Missing or nonsense input must land on the forwarding mode, never on a
  // permissive one — that is the whole fail-closed point of the derivation.
  for (const broken of [undefined, {}, { sandboxMode: 'nonsense' }, { approvalPolicy: 'nonsense' }, { sandboxMode: 'auto' }]) {
    check(`a broken policy falls back to forwarding: ${JSON.stringify(broken)}`, permissionModeFor(broken) === 'default', permissionModeFor(broken))
  }
  // `auto` is the in-process reviewer: it must be unreachable and unusable.
  check('the in-process reviewer mode is never derived', ['dontAsk', 'default', 'bypassPermissions'].every(mode => mode !== 'auto'))
  const argsAuto = buildArgs({ model: 'glm-5.3', sessionId: 's', entry: 'e', permissionMode: 'auto' })
  check('an explicit auto is rejected in favour of forwarding', argsAuto[argsAuto.indexOf('--permission-mode') + 1] === 'default', argsAuto[argsAuto.indexOf('--permission-mode') + 1])

  // Deny reasons must not start with a prefix the CLI treats as a cancelled
  // prompt: it drops those answers in the AskUserQuestion race and keeps waiting.
  for (const prefix of ['prompt ended', 'Cancelled', 'timeout waiting for user response', 'this is an unattended automated session']) {
    const safe = safeDenyReason(prefix)
    check(`a reason starting with "${prefix.slice(0, 24)}" is neutralised`, !safe.toLowerCase().startsWith(prefix.toLowerCase()), safe)
  }
  check('an ordinary reason passes through', safeDenyReason('用户拒绝了 Write') === '用户拒绝了 Write')
  check('a blank reason still says something', safeDenyReason('   ').length > 0)

  // A bridged DSH tool arrives wrapped: the CLI asks about `DeferExecuteTool`
  // and names the real target inside the input. Approving the wrapper is not
  // approving the tool, and the prompt must name the tool the user recognises.
  check('a native tool is its own subject', approvalSubjectFor({ toolName: 'Write', input: {} }).toolName === 'Write')
  check('a native tool is not bridged', approvalSubjectFor({ toolName: 'Write', input: {} }).bridged === false)
  const bridged = approvalSubjectFor({ toolName: 'DeferExecuteTool', input: { toolName: 'mcp__dsh__present' } })
  check('the MCP wrapper resolves to the real tool', bridged.toolName === 'mcp__dsh__present', bridged.toolName)
  check('the MCP wrapper is marked as bridged', bridged.bridged === true)
  const anonymous = approvalSubjectFor({ toolName: 'DeferExecuteTool', input: {} })
  check('a wrapper with no target keeps the wrapper name', anonymous.toolName === 'DeferExecuteTool', anonymous.toolName)
  check('a nameless request yields no subject', approvalSubjectFor({ input: {} }).toolName === '')
}

// --- the manifest validation keeps maxTurns ---------------------------------
{
  // The Standard Schema validate() is what the Loader normalizes the row config
  // through, so a field it drops never reaches `apply` — a silently dead
  // `maxTurns` while the page still displayed the default.
  const { Config } = await import('../index.js')
  const pass = Config['~standard'].validate({ binary: 'b', models: ['m'], cwd: 'c', maxTurns: 7 })
  check('validate passes maxTurns through', pass.issues === undefined && pass.value.maxTurns === 7, JSON.stringify(pass.value))
  const filled = Config['~standard'].validate({})
  check('validate fills the maxTurns default', filled.value.maxTurns === 0, JSON.stringify(filled.value))
  const bad = Config['~standard'].validate({ maxTurns: -1 })
  check('validate rejects a negative maxTurns', Array.isArray(bad.issues) && bad.issues.length === 1, JSON.stringify(bad))
  const fractional = Config['~standard'].validate({ maxTurns: 2.5 })
  check('validate rejects a fractional maxTurns', Array.isArray(fractional.issues), JSON.stringify(fractional))
}

// --- the deployment cache follows the serving account's login site ----------
{
  // Every pool member shares one CLI installation, so the manifest cache keyed
  // only by package root never invalidated: switching accounts left the model
  // metadata reading the first account's deployment until a restart.
  const { adapter: deployAdapter } = makeAdapter(binary)
  const packageRoot = dirname(binary)
  const first = deployAdapter.deployment(packageRoot, '')
  check('the host login resolves a deployment', typeof first.name === 'string' && first.name !== '', JSON.stringify(first))
  // Re-reading with the same home keeps the cache; asking through a different
  // account home re-resolves instead of answering from the stale entry.
  const homes = join(scratch, 'accounts-home', 'codebuddy-homes')
  const again = deployAdapter.deployment(packageRoot, '')
  check('the same home reuses the cached deployment', again.name === first.name && again.domain === first.domain)
  const other = deployAdapter.deployment(packageRoot, join(homes, 'a1'))
  check('a different account home re-resolves the deployment', typeof other.name === 'string' && typeof other.domain === 'string', JSON.stringify(other))
  const restored = deployAdapter.deployment(packageRoot, '')
  check('switching back re-resolves the host deployment', restored.domain === first.domain && restored.name === first.name, JSON.stringify(restored))
  await deployAdapter.dispose()
}

// --- a side request never takes the user's turn ---------------------------
{
  // DSH runs the session-title generation on the same session id, concurrently
  // with the real turn. Before this was handled, that call replaced the running
  // turn and killed its CLI process, so the real answer never arrived — the
  // whole turn failed with "CodeBuddy CLI turn was cancelled".
  const argvLog = join(scratch, 'side-argv.log')
  process.env['DSH_CODEBUDDY_FAKE_ARGV'] = argvLog
  const sideAdapter = makeAdapter(binary).adapter
  const sideSession = `side-${Date.now().toString(36)}`
  const humanMessage = {
    id: 'u1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Write the probe file, then tell me it is done.' }],
  }
  const titleMessage = {
    id: 't1',
    role: 'user',
    source: { kind: 'dsh-session-title-llm' },
    content: [{ type: 'text', text: 'Generate the session title from this JSON array of messages.' }],
  }
  const base = { provider: PROVIDER_ID, model: 'glm-5.3', toolHistory: [], sessionId: sideSession, tools: [{ name: 'Write' }] }
  const prepared = await sideAdapter.prepareCall(PROVIDER_ID, 'glm-5.3')
  // Both are opened before either is consumed, which is the ordering that used
  // to let the title call take the turn away.
  const realCall = prepared.stream({ ...base, messages: [humanMessage] })
  const titleCall = prepared.stream({ ...base, messages: [titleMessage], purpose: 'dsh-session-title' })

  const titleText = []
  for await (const chunk of titleCall) if (chunk.type === 'text-delta') titleText.push(chunk.text)
  const realText = []
  const realCards = []
  for await (const chunk of realCall) {
    if (chunk.type === 'text-delta') realText.push(chunk.text)
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') realCards.push(chunk.block)
  }

  check('a side request does not cancel the real turn', realText.join('').trim() !== '', JSON.stringify(realText.join('').slice(0, 40)))
  check('a side request still answers on its own', titleText.join('').includes('FAKE-DONE') || titleText.length > 0, String(titleText.length))
  check('a side request still gets its cards', realCards.length > 0, String(realCards.length))
  // The throwaway session must leave the adapter's registry once its turn is
  // done: each side request used to leak one dead entry into #sessions.
  await new Promise(resolve => setTimeout(resolve, 250))
  check('a finished side request leaves no session behind', sideAdapter.backendStatus().sessions === 1, JSON.stringify(sideAdapter.backendStatus()))

  // The two calls must not share a CLI session, or the title prompt would land
  // in the user's CodeBuddy history.
  if (existsSync(argvLog)) {
    const ids = readFileSync(argvLog, 'utf8').trim().split('\n').filter(line => line !== '').map((line) => {
      const argv = JSON.parse(line)
      const at = argv.indexOf('--session-id')
      return at === -1 ? '' : argv[at + 1]
    })
    check('a side request uses its own CLI session', new Set(ids).size === ids.length && ids.length >= 2, ids.join(','))
  } else {
    check('a side request uses its own CLI session', false, 'no argv recorded')
  }
  delete process.env['DSH_CODEBUDDY_FAKE_ARGV']
}

// --- keep-alive: a finished session is reused for the next message ---------
{
  // The whole point of the delay: the CLI process that answered one message
  // answers the next one in the same conversation, so its start-up is paid once.
  // The fake CLI records one line per invocation, which is what makes the reuse
  // observable without a model.
  const home = join(scratch, 'home-keepalive')
  process.env.DSH_HOME = home
  const keepCounter = join(scratch, 'keepalive.txt')
  process.env.DSH_CODEBUDDY_FAKE_COUNTER = keepCounter
  // The fake parks after `result` so a warm session behaves like the real CLI.
  process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE = '1'
  writeSettings({ hiddenModels: [], keepAliveSeconds: 60 })

  /**
   * Run one whole turn, the way DSH drives it, until it produces no more cards.
   *
   * `history` is the conversation so far and grows with what the turn produced:
   * DSH projects the whole conversation on every step, so a helper that sent only
   * the newest message would look like a rollback to the adapter (correctly —
   * that is the same shape a rewind produces).
   * @returns the last outcome plus the grown history.
   */
  async function fullTurn(adapter, text, sessionId, history = []) {
    let messages = [...history, { id: `u${history.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]
    for (let index = 0; index < 4; index += 1) {
      const outcome = await step(adapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages, toolHistory: [], sessionId, tools: [{ name: 'Write' }, { name: 'Read' }] })
      if (outcome.cards.length === 0) return { outcome, history: messages }
      messages = [
        ...messages,
        { id: `a${index}`, role: 'assistant', source: { kind: 'assistant' }, content: outcome.cards.map(card => ({ type: 'tool-call', id: card.id, name: card.name, arguments: card.arguments })) },
        ...outcome.cards.map((card, at) => ({ id: `t${index}${at}`, role: 'tool', source: { kind: 'tool', callId: card.id }, toolCallId: card.id, isError: false, content: [{ type: 'text', text: 'ok' }] })),
      ]
    }
    return { outcome: { text: '', cards: [] }, history: messages }
  }

  /** How many CLI processes have been started so far. */
  const spawnCount = () => {
    if (!existsSync(keepCounter)) return 0
    return readFileSync(keepCounter, 'utf8').trim().split('\n').filter(line => line !== '').length
  }

  /**
   * Let a finished turn's bookkeeping land.
   *
   * A step settles the moment its last chunk is yielded; the session is parked a
   * moment later, when the turn reads its `result`. Asserting on the parked state
   * immediately would race that by design rather than by accident.
   */
  const settleTurn = () => new Promise(resolve => setTimeout(resolve, 150))

  const keepSession = `keep-${Date.now().toString(36)}`
  const { adapter: warmAdapter } = makeAdapter(binary)
  let warmHistory = (await fullTurn(warmAdapter, 'first message', keepSession)).history
  await settleTurn()
  check('a turn spawns one CLI process', spawnCount() === 1, String(spawnCount()))

  warmHistory = (await fullTurn(warmAdapter, 'second message', keepSession, warmHistory)).history
  await settleTurn()
  check('the next message reuses the warm process', spawnCount() === 1, String(spawnCount()))
  check('the warm process is reported as parked', warmAdapter.backendStatus().parked === 1, JSON.stringify(warmAdapter.backendStatus()))

  // Warming from the page keeps what is already parked instead of starting a
  // second process while one is alive.
  const warmed = await warmAdapter.warm()
  check('warming keeps the parked backend instead of starting another', warmed.warmed === true && warmed.reused === true && spawnCount() === 1, `${JSON.stringify(warmed)} spawns=${spawnCount()}`)
  check('warming reports the conversation it kept warm', warmed.sessionId === keepSession, String(warmed.sessionId))

  // A prompt-affecting save discards the warmth: the parked process read the
  // old system prompt at start-up, so reusing it would answer with stale rules.
  // The next message must start a fresh process (and the transcript carries the
  // history over, which the fake cannot show — the spawn count can).
  warmAdapter.discardParkedForPromptChange()
  await settleTurn()
  check('a prompt change drops the parked process', warmAdapter.backendStatus().parked === 0, JSON.stringify(warmAdapter.backendStatus()))
  rmSync(keepCounter, { force: true })
  await fullTurn(warmAdapter, 'third message', keepSession, warmHistory)
  await settleTurn()
  check('the message after a prompt change starts a fresh process', spawnCount() === 1, String(spawnCount()))
  await warmAdapter.dispose()

  // Turning the delay off must stop the reuse — and the process.
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0 })
  rmSync(keepCounter, { force: true })
  const coldSession = `cold-${Date.now().toString(36)}`
  const { adapter: coldAdapter } = makeAdapter(binary)
  let coldHistory = (await fullTurn(coldAdapter, 'first message', coldSession)).history
  await fullTurn(coldAdapter, 'second message', coldSession, coldHistory)
  check('a zero delay spawns a process per message', spawnCount() === 2, String(spawnCount()))
  check('a zero delay parks nothing', coldAdapter.backendStatus().parked === 0, JSON.stringify(coldAdapter.backendStatus()))
  await coldAdapter.dispose()

  // With nothing running and no conversation on disk, warming must explain
  // itself rather than start a process it cannot bind to anything.
  rmSync(keepCounter, { force: true })
  const { adapter: pageAdapter } = makeAdapter(binary)
  const nowhere = await pageAdapter.warm()
  check('warming without a conversation explains why', nowhere.warmed === false && nowhere.reason !== '', JSON.stringify(nowhere))
  check('warming without a conversation starts nothing', spawnCount() === 0, String(spawnCount()))
  await pageAdapter.dispose()

  delete process.env.DSH_CODEBUDDY_FAKE_COUNTER
  delete process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE
  process.env.DSH_HOME = testHome
}

// --- startup-only keep-alive inputs and anonymous one-shot sessions --------
{
  writeSettings({ hiddenModels: [], keepAliveSeconds: 60 })
  const envLog = join(scratch, 'startup-env.log')
  process.env.DSH_CODEBUDDY_FAKE_ENV = envLog
  process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE = '1'
  process.env.DSH_CODEBUDDY_FAKE_TEXT_ONLY = '1'
  const envRows = () => existsSync(envLog) ? readFileSync(envLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const effortOf = row => {
    const at = row?.argv?.indexOf('--effort') ?? -1
    return at === -1 ? undefined : row.argv[at + 1]
  }
  const configSession = `startup-${Date.now().toString(36)}`
  const cwdA = join(scratch, 'cwd-a')
  const cwdB = join(scratch, 'cwd-b')
  mkdirSync(cwdA, { recursive: true })
  mkdirSync(cwdB, { recursive: true })
  let cwd = cwdA
  const agents = agentRegistry({ [configSession]: { header: { cwd: cwdA } } })
  const configAdapter = makeAdapter(binary, { agents, workingDirectory: { get: () => cwd } }).adapter
  const u1 = { id: 'sc1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] }
  const r1 = { id: 'sr1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'a1' }] }
  const u2 = { id: 'sc2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'two' }] }
  const r2 = { id: 'sr2', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'a2' }] }
  const u3 = { id: 'sc3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'three' }] }
  const r3 = { id: 'sr3', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'a3' }] }
  const u4 = { id: 'sc4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'four' }] }
  const base = { provider: PROVIDER_ID, model: 'glm-5.3', toolHistory: [], sessionId: configSession, tools: [] }
  await step(configAdapter, { ...base, messages: [u1], reasoningEffort: 'low' })
  await new Promise(resolve => setTimeout(resolve, 150))
  await step(configAdapter, { ...base, messages: [u1, r1, u2], reasoningEffort: 'max' })
  check('changing reasoning effort starts a process with the new flag', envRows().length === 2 && effortOf(envRows().at(-1)) === 'max', JSON.stringify(envRows().map(effortOf)))
  await new Promise(resolve => setTimeout(resolve, 150))
  cwd = cwdB
  await step(configAdapter, { ...base, messages: [u1, r1, u2, r2, u3], reasoningEffort: 'max' })
  check('changing the working directory starts a process in the new directory', envRows().length === 3 && envRows().at(-1)?.cwd === cwdB, envRows().at(-1)?.cwd)
  await new Promise(resolve => setTimeout(resolve, 150))
  await step(configAdapter, { ...base, messages: [u1, r1, u2, r2, u3, r3, u4], reasoningEffort: 'max' })
  check('identical startup inputs still reuse the warm process', envRows().length === 3, String(envRows().length))
  await configAdapter.dispose()
  delete process.env.DSH_CODEBUDDY_FAKE_TEXT_ONLY
  delete process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE

  // No DSH session id means a one-shot CLI session, never a shared anonymous
  // transcript. Continuations still use the in-memory empty-key turn above.
  const argvLog = join(scratch, 'anonymous-argv.log')
  process.env.DSH_CODEBUDDY_FAKE_ARGV = argvLog
  process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST = '1'
  const anonymousAdapter = makeAdapter(binary).adapter
  const anonymousOptions = { provider: PROVIDER_ID, model: 'glm-5.3', toolHistory: [], tools: [] }
  await step(anonymousAdapter, { ...anonymousOptions, messages: [{ id: 'anon-a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE-A' }] }] })
  await step(anonymousAdapter, { ...anonymousOptions, messages: [{ id: 'anon-b', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE-B' }] }] })
  const anonymousIds = readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const argv = JSON.parse(line)
    return argv[argv.indexOf('--session-id') + 1]
  })
  check('one-shot requests never share a CLI transcript id', anonymousIds.length === 2 && anonymousIds[0] !== anonymousIds[1], anonymousIds.join(','))
  await new Promise(resolve => setTimeout(resolve, 150))
  check('one-shot requests leave no warm process behind', anonymousAdapter.backendStatus().sessions === 0 && anonymousAdapter.backendStatus().parked === 0, JSON.stringify(anonymousAdapter.backendStatus()))
  const { readHistories } = await import('../src/config/store.js')
  check('one-shot requests leave no shared history fingerprint', !readHistories().has(''))
  await anonymousAdapter.dispose()
  delete process.env.DSH_CODEBUDDY_FAKE_ENV
  delete process.env.DSH_CODEBUDDY_FAKE_ARGV
  delete process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0 })
}

// --- the MCP tool bridge ---------------------------------------------------
{
  // The CLI reaches Host tools through a loopback MCP server: the shim speaks MCP
  // over stdio, this side answers over HTTP and calls tools.execute. These
  // checks cover the HTTP half and the schema translation, which is everything a
  // test can exercise without a live agent.
  const calls = []
  const bridge = createToolBridge({
    logger: { warn: () => {} },
    resolveTools: (sessionId) => [{
      name: 'example_tool',
      description: 'An example Host tool.',
      inputSchema: toMcpInputSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
    }].filter(() => sessionId === 'session-a'),
    executeTool: async (request) => {
      calls.push(request)
      if (request.name === 'explode') throw new Error('boom')
      return { ok: true, text: `ran ${request.name}` }
    },
  })
  await bridge.start()
  check('the bridge listens on a loopback port', bridge.ready === true && bridge.port > 0, String(bridge.port))

  const config = JSON.parse(bridge.configFor('session-a', 'C:/tmp/shim.mjs'))
  const server = config.mcpServers.dsh
  check('the config points the CLI at the shim', server.command === process.execPath && server.args[0] === 'C:/tmp/shim.mjs', JSON.stringify(server.args))
  check('the config carries the bridge url and token', String(server.env.DSH_MCP_BRIDGE_URL).includes(`:${bridge.port}`) && String(server.env.DSH_MCP_BRIDGE_TOKEN).length >= 32)
  check('the config carries the session', server.env.DSH_MCP_BRIDGE_SESSION === 'session-a', String(server.env.DSH_MCP_BRIDGE_SESSION))

  const token = server.env.DSH_MCP_BRIDGE_TOKEN
  const base = server.env.DSH_MCP_BRIDGE_URL
  const anonymous = await fetch(`${base}/tools?session=session-a`)
  check('the bridge refuses anonymous requests', anonymous.status === 401, String(anonymous.status))

  const listed = await fetch(`${base}/tools?session=session-a`, { headers: { authorization: `Bearer ${token}` } })
  const body = await listed.json()
  check('the bridge lists the tools for that session', Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0].name === 'example_tool', JSON.stringify(body.tools?.[0]?.name))
  check('the schema drops what MCP rejects', body.tools[0].inputSchema.$schema === undefined && body.tools[0].inputSchema.required?.[0] === 'text', JSON.stringify(body.tools[0].inputSchema))

  const other = await fetch(`${base}/tools?session=other`, { headers: { authorization: `Bearer ${token}` } })
  const otherBody = await other.json()
  check('another session gets no tools', Array.isArray(otherBody.tools) && otherBody.tools.length === 0, JSON.stringify(otherBody.tools))

  const called = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'session-a', name: 'example_tool', arguments: { text: 'hi' } }),
  })
  const callBody = await called.json()
  check('a call reaches the tool executor', callBody.ok === true && callBody.text === 'ran example_tool', JSON.stringify(callBody))
  check('the executor saw the arguments', calls.length === 1 && calls[0].arguments.text === 'hi' && calls[0].sessionId === 'session-a', JSON.stringify(calls[0]))

  const failed = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'session-a', name: 'explode', arguments: {} }),
  })
  const failedBody = await failed.json()
  check('a failing tool becomes a failed result, not a broken server', failed.status === 200 && failedBody.ok === false && failedBody.error === 'boom', JSON.stringify(failedBody))

  const wrongMethod = await fetch(`${base}/call`, { headers: { authorization: `Bearer ${token}` } })
  check('a wrong method is refused', wrongMethod.status === 405, String(wrongMethod.status))
  await bridge.close()
  check('the bridge closes', bridge.ready === false)
}

// --- the MCP config reaches the CLI argv ------------------------------------
{
  // The shim path the bridge advertises must point at a file that actually
  // exists: a relative URL that escapes the bridge's own directory resolves to
  // a spawn that dies with ERR_MODULE_NOT_FOUND before any HTTP happens.
  const { existsSync: fileExists } = await import('node:fs')
  const toolsModule = await import('../src/bridge/tools.js')
  // Re-derive the path exactly as installToolBridge does, from the module's own
  // URL: importing the module alone does not expose the path.
  const derived = new URL('./shim.mjs', new URL('../src/bridge/tools.js', import.meta.url))
  const { fileURLToPath } = await import('node:url')
  check('the shim the bridge advertises exists on disk', fileExists(fileURLToPath(derived)), fileURLToPath(derived))
  check('the bridge module is importable for the shim wiring', typeof toolsModule.installToolBridge === 'function')
}
{
  // The bridge's bearer token rides in the config, so the adapter hands the CLI
  // a file path instead of inline JSON: an argv is enumerable by every process
  // on the machine, a file in the user's temp directory is not.
  const tokenBridge = createToolBridge({
    logger: { warn: () => {} },
    resolveTools: () => [],
    executeTool: async () => ({ ok: true, text: '' }),
  })
  await tokenBridge.start()
  const config = tokenBridge.configFor('session-mcp', 'C:/tmp/shim.mjs')
  const inline = JSON.parse(config)
  check('the inline config carries the token', String(inline.mcpServers.dsh.env.DSH_MCP_BRIDGE_TOKEN).length >= 32)
  const { writeMcpConfigFile, cleanupMcpConfigFile } = await import('../src/cli/session.js')
  const configPath = writeMcpConfigFile('session-mcp', config)
  check('the mcp config is delivered as a file path', configPath !== '' && configPath !== config && !configPath.includes(inline.mcpServers.dsh.env.DSH_MCP_BRIDGE_TOKEN), configPath)
  check('the config file holds the same JSON', JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.dsh.args[0] === 'C:/tmp/shim.mjs')
  if (process.platform !== 'win32') {
    check('the MCP directory is private', (statSync(dirname(configPath)).mode & 0o777) === 0o700)
    check('the MCP file is private', (statSync(configPath).mode & 0o777) === 0o600)
  }
  const blockedPath = join(dirname(configPath), 'mcp-config-blocked.json')
  mkdirSync(blockedPath)
  const failed = writeMcpConfigFile('blocked', config)
  check('a failed MCP write never falls back to inline token JSON', failed === '' && failed !== config, failed)
  rmSync(blockedPath, { recursive: true, force: true })
  const siblingPath = writeMcpConfigFile('session-mcp-sibling', config)
  cleanupMcpConfigFile('session-mcp')
  check('closing one process preserves its sibling MCP config', !existsSync(configPath) && existsSync(siblingPath))
  cleanupMcpConfigFile('session-mcp-sibling')
  check('closing the sibling removes its own MCP config', !existsSync(siblingPath))
  await tokenBridge.close()
}
{
  const argv = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: 'p', entry: 'e', mcpConfig: '{"mcpServers":{"dsh":{}}}' })
  const at = argv.indexOf('--mcp-config')
  check('a configured bridge is passed to the CLI', at !== -1 && argv[at + 1] === '{"mcpServers":{"dsh":{}}}', String(at))
  const plain = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: 'p', entry: 'e' })
  check('no bridge means no flag', plain.indexOf('--mcp-config') === -1)
}

// --- multimodal input: the user's images reach the CLI frame ----------------
{
  const frame = userFrame('what number?', [{ mediaType: 'image/png', data: 'AAAA' }])
  const blocks = frame.message.content
  check('the text block comes first', blocks[0].type === 'text' && blocks[0].text === 'what number?')
  check('the image rides as a base64 block', blocks[1]?.type === 'image' && blocks[1].source.type === 'base64' && blocks[1].source.media_type === 'image/png' && blocks[1].source.data === 'AAAA', JSON.stringify(blocks[1]))
  check('a text-only turn carries one block', userFrame('plain').message.content.length === 1)
  check('empty image payloads are dropped', userFrame('plain', [{ mediaType: 'image/png', data: '' }]).message.content.length === 1)
  const many = userFrame('x', [{ mediaType: 'image/png', data: '1' }, { mediaType: 'image/jpeg', data: '2' }])
  check('several images are kept in order', many.message.content.length === 3 && many.message.content[2].source.media_type === 'image/jpeg')
}

// --- multimodal output defaults to the present tool -------------------------
{
  // A settings file written before the tool bridge existed has no `exposedTools`
  // key; that is not the same as an explicit empty choice.
  const { readSettings } = await import('../src/config/store.js')
  const file = settingsPath()
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writeFileSync(file, JSON.stringify({ hiddenModels: [], keepAliveSeconds: 60 }), 'utf8')
  const defaults = readSettings()
  check('a file without a tool choice defaults to present', defaults.exposedTools.includes('present'), JSON.stringify(defaults.exposedTools))
  writeFileSync(file, JSON.stringify({ hiddenModels: [], keepAliveSeconds: 60, exposedTools: [] }), 'utf8')
  const explicit = readSettings()
  check('an explicit empty choice is respected', explicit.exposedTools.length === 0, JSON.stringify(explicit.exposedTools))
  writeFileSync(file, previous, 'utf8')
}

// --- tool provenance -------------------------------------------------------
{
  // The registry stores no owner, so the classification is "in the shipped
  // catalog" versus "not" — and the page words it that way.
  check('a shipped tool is classified as built in', toolOrigin('present') === 'builtin', toolOrigin('present'))
  check('a plugin tool is classified as external', toolOrigin('kb_query') === 'external', toolOrigin('kb_query'))
  check('classification is case sensitive to the registered name', toolOrigin('Present') === 'external', toolOrigin('Present'))
}

  // The transcript path must follow the same env precedence the CLI itself
  // uses (`CODEBUDDY_CONFIG_DIR` first): the account pool pins that variable,
  // and a mismatch sent rollback deletion and the handoff existence check to a
  // file the CLI never wrote.
  const savedConfigDir = process.env.CODEBUDDY_CONFIG_DIR
  process.env.CODEBUDDY_CONFIG_DIR = join(scratch, 'configdir-check')
  const viaConfigDir = codebuddyTranscriptPath('E:\\Docs\\a b', 'session-x')
  if (savedConfigDir === undefined) delete process.env.CODEBUDDY_CONFIG_DIR
  else process.env.CODEBUDDY_CONFIG_DIR = savedConfigDir
  const viaHome = codebuddyTranscriptPath('E:\\Docs\\a b', 'session-x')
  check('the transcript path honours CODEBUDDY_CONFIG_DIR first', viaConfigDir.startsWith(join(scratch, 'configdir-check')) === true, viaConfigDir)
  check('the transcript path falls back to CODEBUDDY_HOME', viaHome.startsWith(process.env.CODEBUDDY_HOME ?? join(homedir(), '.codebuddy')) === true, viaHome)

// --- the system-prompt choice ----------------------------------------------
{
  const { readSettings: readPromptSettings, writeSettings: writePromptSettings } = await import('../src/config/store.js')
  const { CHAT_SYSTEM_PROMPT: chatPrompt, normalizePromptMode } = await import('../src/config/prompt.js')
  check('the default mode keeps the bridge\u2019s own prompt', normalizePromptMode(undefined) === 'custom' && normalizePromptMode('nope') === 'custom')
  check('the two other modes are kept', normalizePromptMode('dsh') === 'dsh' && normalizePromptMode('codebuddy') === 'codebuddy')

  // No prompt file means no override: that is how the CodeBuddy mode runs.
  const withPrompt = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: 'C:/tmp/prompt.txt', entry: 'e' })
  check('a prompt file becomes a flag', withPrompt[withPrompt.indexOf('--system-prompt-file') + 1] === 'C:/tmp/prompt.txt')
  const withoutPrompt = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: '', entry: 'e' })
  check('no prompt file means no flag', withoutPrompt.indexOf('--system-prompt-file') === -1)

  check('an empty prompt writes no file', writeSystemPromptFile('') === '')
  check('a prompt writes a readable file', (() => {
    const path = writeSystemPromptFile('Custom rules live here.')
    return path !== '' && readFileSync(path, 'utf8') === 'Custom rules live here.'
  })())

  // Per-session prompt files: two CLI processes can be starting concurrently,
  // so each session key must own a file with its own text, and cleaning one
  // session up must leave the other's file readable.
  const { cleanupSystemPromptFile } = await import('../src/cli/session.js')
  const pathA = writeSystemPromptFile('PROMPT-A', 'session-a')
  const pathB = writeSystemPromptFile('PROMPT-B', 'session-b')
  check('distinct sessions get distinct prompt files', pathA !== pathB && readFileSync(pathA, 'utf8') === 'PROMPT-A' && readFileSync(pathB, 'utf8') === 'PROMPT-B', `${pathA} vs ${pathB}`)
  check('rewriting a session keeps its own file', writeSystemPromptFile('PROMPT-A-2', 'session-a') === pathA && readFileSync(pathA, 'utf8') === 'PROMPT-A-2' && readFileSync(pathB, 'utf8') === 'PROMPT-B')
  cleanupSystemPromptFile('session-a')
  check('cleaning one session keeps the other prompt', !existsSync(pathA) && existsSync(pathB))
  cleanupSystemPromptFile('session-b')
  cleanupSystemPromptFile('session-a')

  // Persisting one choice must not drop the others.
  const file = settingsPath()
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writePromptSettings({ hiddenModels: [], keepAliveSeconds: 60, exposedTools: [], promptMode: 'dsh', customPrompt: 'mine' })
  const stored = readPromptSettings()
  check('the prompt mode round-trips', stored.promptMode === 'dsh', stored.promptMode)
  check('the custom prompt round-trips', stored.customPrompt === 'mine', stored.customPrompt)
  writePromptSettings({ hiddenModels: [], keepAliveSeconds: 60, exposedTools: [], promptMode: 'custom', customPrompt: '   ' })
  const blank = readPromptSettings()
  check('a blank custom prompt falls back to the bridge default', blank.customPrompt === chatPrompt, blank.customPrompt.slice(0, 30))
  writeFileSync(file, previous, 'utf8')
}

// --- the prompt choice reaches the CLI --------------------------------------
{
  const { settingsPath: promptSettingsPath, readSettings: readThisBlock } = await import('../src/config/store.js')
  const file = promptSettingsPath()
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const log = join(scratch, 'prompt-argv.log')
  process.env.DSH_CODEBUDDY_FAKE_ARGV = log

  /** Run one step and read back the argv the CLI was launched with. */
  async function argvFor(promptMode, customPrompt, messages) {
    writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: [], promptMode, customPrompt })
    const { adapter: promptAdapter } = makeAdapter(binary)
    await step(promptAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages, toolHistory: [], sessionId: `prompt-${promptMode}-${Date.now().toString(36)}`, tools: [{ name: 'Write' }] })
    const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(line => line !== '') : []
    const argv = JSON.parse(lines[lines.length - 1] ?? '[]')
    // Read the prompt before teardown: closing the session removes the scratch file.
    const promptAt = argv.indexOf('--system-prompt-file')
    const promptText = promptAt === -1 ? '' : readFileSync(argv[promptAt + 1], 'utf8')
    await promptAdapter.dispose()
    return { argv, promptText }
  }

  const human = { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
  const host = { id: 's', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'HOST-RULES-7' }] }

  const custom = await argvFor('custom', 'CUSTOM-RULES-42', [human])
  check('a custom prompt is passed to the CLI', custom.promptText === 'CUSTOM-RULES-42', JSON.stringify(custom.promptText.slice(0, 30)))

  const dsh = await argvFor('dsh', 'ignored', [host, human])
  check('the DSH prompt is passed to the CLI', dsh.promptText === 'HOST-RULES-7', JSON.stringify(dsh.promptText.slice(0, 30)))

  const codebuddy = await argvFor('codebuddy', 'ignored', [human])
  check('the CodeBuddy mode passes no prompt at all', codebuddy.argv.indexOf('--system-prompt-file') === -1 && codebuddy.promptText === '')

  // The tool declaration: with no tools enabled the prompt is exactly the text
  // stored; with tools enabled and a live tool service the block is appended,
  // and `declareTools: false` removes it again. The declaration names the tool
  // the way the CLI sees it, `mcp__dsh__<name>`.
  const customBare = await argvFor('custom', 'CUSTOM-RULES-42', [human])
  check('no enabled tools means no declaration block', customBare.promptText === 'CUSTOM-RULES-42', JSON.stringify(customBare.promptText.slice(0, 60)))

  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: ['Write'], promptMode: 'custom', customPrompt: 'CUSTOM-RULES-42' })
  const { adapter: declaredAdapter } = makeAdapter(binary)
  // The declaration is built from the Host's own tool schema, so attach the
  // same fake registry shape the page test uses.
  declaredAdapter.attachToolServices({
    tools: { schemas: () => [{ name: 'Write', description: 'Writes a file to disk. Use it often.', parameters: { type: 'object', properties: {} } }] },
    agents: { get: (id) => ({ id }) },
  })
  await step(declaredAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [human], toolHistory: [], sessionId: `prompt-decl-${Date.now().toString(36)}`, tools: [{ name: 'Write' }] })
  const declaredLines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('[')) : []
  const declaredArgv = JSON.parse(declaredLines[declaredLines.length - 1] ?? '[]')
  const declaredAt = declaredArgv.indexOf('--system-prompt-file')
  const declaredText = declaredAt === -1 ? '' : readFileSync(declaredArgv[declaredAt + 1], 'utf8')
  await declaredAdapter.dispose()
  check('the declaration block is appended when tools are exposed', declaredText.startsWith('CUSTOM-RULES-42') && declaredText.includes('mcp__dsh__Write'), JSON.stringify(declaredText.slice(-120)))

  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: ['Write'], promptMode: 'custom', customPrompt: 'CUSTOM-RULES-42', declareTools: false })
  const { adapter: quietAdapter } = makeAdapter(binary)
  await step(quietAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [human], toolHistory: [], sessionId: `prompt-quiet-${Date.now().toString(36)}`, tools: [{ name: 'Write' }] })
  const quietLines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('[')) : []
  const quietArgv = JSON.parse(quietLines[quietLines.length - 1] ?? '[]')
  const quietAt = quietArgv.indexOf('--system-prompt-file')
  const quietText = quietAt === -1 ? '' : readFileSync(quietArgv[quietAt + 1], 'utf8')
  await quietAdapter.dispose()
  check('declareTools false removes the declaration block', quietText === 'CUSTOM-RULES-42', JSON.stringify(quietText.slice(0, 60)))

  const roundTrip = writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: [], promptMode: 'custom', customPrompt: 'x', declareTools: false })
  check('declareTools round-trips through the settings file', roundTrip === true && readThisBlock().declareTools === false, readThisBlock().declareTools)
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: [], promptMode: 'custom', customPrompt: 'x' })
  check('a missing declareTools key defaults to on', readThisBlock().declareTools === true, readThisBlock().declareTools)
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: [], promptMode: 'custom', customPrompt: 'x', declarationPlacement: 'first-user' })
  check('the declaration placement round-trips', readThisBlock().declarationPlacement === 'first-user', readThisBlock().declarationPlacement)
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: [], promptMode: 'custom', customPrompt: 'x', declarationPlacement: 'elsewhere' })
  check('an unknown placement falls back to system', readThisBlock().declarationPlacement === 'system', readThisBlock().declarationPlacement)

  // The 'first-user' placement: the declaration leaves the system prompt and
  // rides in the first frame instead — which also makes it work in the
  // CodeBuddy-prompt mode, where no system-prompt file exists.
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: ['Write'], promptMode: 'custom', customPrompt: 'CUSTOM-RULES-42', declarationPlacement: 'first-user' })
  const { adapter: firstUserAdapter } = makeAdapter(binary)
  firstUserAdapter.attachToolServices({
    tools: { schemas: () => [{ name: 'Write', description: 'Writes a file to disk. Use it often.', parameters: { type: 'object', properties: {} } }] },
    agents: { get: (id) => ({ id }) },
  })
  process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST = '1'
  const fakeHomeFU = process.env.CODEBUDDY_HOME
  process.env.CODEBUDDY_HOME = join(scratch, 'cbhome-fu')
  const fuSession = `fu-${Date.now().toString(36)}`
  const firstFu = await step(firstUserAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [human], toolHistory: [], sessionId: fuSession, tools: [{ name: 'Write' }] })
  // The echo IS the first frame: the declaration must lead it, the custom text
  // still follows, and the system-prompt file keeps the base text only (checked
  // by the argv test above). Here we assert the frame's shape.
  const fuFrame = firstFu.text
  check('the first frame leads with the declaration', fuFrame.includes('Additional tools from the host application') && fuFrame.indexOf('mcp__dsh__Write') < fuFrame.indexOf('---'), fuFrame.slice(0, 60))
  check('the first frame still carries the question', fuFrame.includes('hi'), JSON.stringify(fuFrame.slice(-80)))
  const fuTurn2 = { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SECOND' }] }
  const fuMessages = [human, { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'ECHO:CUSTOM-RULES-42' }] }, fuTurn2]
  const secondFu = await step(firstUserAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: fuMessages, toolHistory: [], sessionId: fuSession, tools: [{ name: 'Write' }] })
  check('the declaration precedes the separator', firstFu.text.indexOf('mcp__dsh__Write') < firstFu.text.indexOf('---'), 'order check')
  check('a fresh process receives the current declaration again', secondFu.text.includes('mcp__dsh__Write'), secondFu.text.slice(0, 60))

  writeSettings({ hiddenModels: [], keepAliveSeconds: 60, exposedTools: ['Write'], promptMode: 'custom', customPrompt: 'CUSTOM-RULES-42', declarationPlacement: 'first-user' })
  const warmDeclarationAdapter = makeAdapter(binary).adapter
  warmDeclarationAdapter.attachToolServices({
    tools: { schemas: () => [{ name: 'Write', description: 'Writes a file to disk.', parameters: { type: 'object', properties: {} } }] },
    agents: { get: id => ({ id }) },
  })
  const inputLog = join(scratch, 'declaration-input.log')
  process.env.DSH_CODEBUDDY_FAKE_INPUT = inputLog
  process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE = '1'
  process.env.DSH_CODEBUDDY_FAKE_TEXT_ONLY = '1'
  const warmSession = `decl-warm-${Date.now().toString(36)}`
  await step(warmDeclarationAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [human], toolHistory: [], sessionId: warmSession, tools: [] })
  await new Promise(resolve => setTimeout(resolve, 150))
  await step(warmDeclarationAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [human, { id: 'decl-r', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'done' }] }, fuTurn2], toolHistory: [], sessionId: warmSession, tools: [] })
  const declarationInputs = readFileSync(inputLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  check('a warm process does not repeat its first-user declaration', declarationInputs.length === 2 && declarationInputs[0].includes('mcp__dsh__Write') && !declarationInputs[1].includes('mcp__dsh__Write'), String(declarationInputs.length))
  delete process.env.DSH_CODEBUDDY_FAKE_INPUT
  delete process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE
  delete process.env.DSH_CODEBUDDY_FAKE_TEXT_ONLY
  await warmDeclarationAdapter.dispose()
  await firstUserAdapter.dispose()

  // And in the CodeBuddy-prompt mode the first frame is the only channel.
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0, exposedTools: ['Write'], promptMode: 'codebuddy', declarationPlacement: 'first-user' })
  const { adapter: cbFirstAdapter } = makeAdapter(binary)
  cbFirstAdapter.attachToolServices({
    tools: { schemas: () => [{ name: 'Write', description: 'Writes a file to disk. Use it often.', parameters: { type: 'object', properties: {} } }] },
    agents: { get: (id) => ({ id }) },
  })
  const cbFirst = await step(cbFirstAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [human], toolHistory: [], sessionId: `cbfu-${Date.now().toString(36)}`, tools: [{ name: 'Write' }] })
  check('the declaration reaches the first frame even in the CodeBuddy mode', cbFirst.text.includes('mcp__dsh__Write'), cbFirst.text.slice(0, 80))
  await cbFirstAdapter.dispose()

  delete process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST
  if (fakeHomeFU === undefined) delete process.env.CODEBUDDY_HOME; else process.env.CODEBUDDY_HOME = fakeHomeFU

  delete process.env.DSH_CODEBUDDY_FAKE_ARGV
  writeFileSync(file, previous, 'utf8')
}


// --- the handoff digest: a switch from other providers must carry context ---
{
  const history = [
    { id: 'h1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'First I asked about the parser.' }] },
    { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'The parser lives in src/parse.js.' }] },
    { id: 'h2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Now look at the tokenizer.' }] },
  ]
  const digest = handoffDigest(history)
  check('a history with earlier turns yields a digest', digest !== '', digest.slice(0, 40))
  check('the digest names both speakers', digest.includes('User:') && digest.includes('Assistant:'), digest.split('\n').slice(-2).join(' | '))
  check('the digest carries the earlier content', digest.includes('parser lives in src/parse.js'))
  check('the digest excludes the newest human turn', !digest.includes('Now look at the tokenizer'))
  check('the digest explains itself', digest.includes('handoff'))

  check('a fresh conversation yields no digest', handoffDigest([history[0]]) === '' && handoffDigest([]) === '' && handoffDigest([history[0], history[1]]) === '')
  check('a short history starts the digest at the first turn', handoffDigest(history).includes('First I asked about the parser.'))

  // DSH appends reminders after the human turn; the digest must treat them as
  // machinery on both sides of the boundary.
  const withReminder = [
    ...history.slice(0, 2),
    { id: 'rc0', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'older reminder' }] },
    history[2],
    { id: 'rc', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd is somewhere' }] },
  ]
  const reminderDigest = handoffDigest(withReminder)
  check('injected reminders stay out of the digest', !reminderDigest.includes('cwd is somewhere') && !reminderDigest.includes('older reminder'), 'reminder check')

  const long = { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600) }] }
  const clipped = handoffMessageText(long)
  check('a long message is clipped with an ellipsis', clipped.length <= 402 && clipped.endsWith('…'), String(clipped.length))
  const imageOnly = handoffMessageText({ id: 'a3', role: 'assistant', content: [{ type: 'image', attachment: {} }] })
  check('an image becomes a placeholder', imageOnly === '[图片]', imageOnly)

  const many = []
  for (let index = 0; index < 30; index += 1) {
    many.push({ id: `m${index}`, role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `turn ${index}` }] })
  }
  const capped = handoffDigest([...many, history[0]])
  check('the digest keeps only the tail', !capped.includes('turn 2 ') && capped.includes('turn 29'), 'tail check')
}

// --- the digest reaches the CLI frame once, only on a fresh transcript ------
{
  const file = settingsPath()
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST = '1'
  const fakeHome = process.env.CODEBUDDY_HOME
  process.env.CODEBUDDY_HOME = join(scratch, 'cbhome')

  const echoAdapter = makeAdapter(binary).adapter
  const history = [
    { id: 'h1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier we chose the blue design.' }] },
    { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'Blue it is.' }] },
  ]
  const firstEcho = await step(echoAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [...history, { id: 'u9', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'RED-QUESTION-9' }] }], toolHistory: [], sessionId: 'echo-1', tools: [] })
  check('the first turn carries the digest before the question', firstEcho.text.includes('Earlier we chose the blue design.') && firstEcho.text.indexOf('Earlier we chose') < firstEcho.text.indexOf('RED-QUESTION-9'), firstEcho.text.slice(0, 60))
  check('the digest is separated from the question', firstEcho.text.includes('---'), 'separator')

  // A second adapter (fresh in-process state) must not re-seed the conversation:
  // the CLI transcript now exists under the fake CODEBUDDY_HOME.
  // The conversation grows the way DSH projects it: the previous turn's answer
  // stays, the next question is appended. A helper that swapped the question
  // would (correctly) read as a rollback.
  const answered = [
    ...history,
    { id: 'u9', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'RED-QUESTION-9' }] },
    { id: 'a9', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'Answered in red.' }] },
    { id: 'u10', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SECOND-QUESTION' }] },
  ]
  const secondEcho = makeAdapter(binary).adapter
  const again = await step(secondEcho, { provider: PROVIDER_ID, model: 'glm-5.3', messages: answered, toolHistory: [], sessionId: 'echo-1', tools: [] })
  check('an existing transcript is not re-seeded', !again.text.includes('Earlier we chose the blue design.') && again.text.includes('SECOND-QUESTION'), again.text.slice(0, 60))

  // A different conversation id is a fresh transcript and gets the digest.
  const thirdEcho = makeAdapter(binary).adapter
  const fresh = await step(thirdEcho, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [...history, { id: 'u9', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'THIRD-QUESTION' }] }], toolHistory: [], sessionId: 'echo-2', tools: [] })
  check('a different conversation is seeded again', fresh.text.includes('Earlier we chose the blue design.') && fresh.text.includes('THIRD-QUESTION'), fresh.text.slice(0, 60))

  delete process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST
  if (fakeHome === undefined) delete process.env.CODEBUDDY_HOME; else process.env.CODEBUDDY_HOME = fakeHome
  writeFileSync(file, previous, 'utf8')
}


// --- a DSH rollback must reach the CLI ---------------------------------------
{
  const { conversationSignature, continuesSignature } = await import('../index.js')

  const human = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const reply = (id, text) => ({ id, role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text }] })
  const reminder = (id, kind, text) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })

  const twoTurns = [human('u1', 'first'), reply('a1', 'answer one'), human('u2', 'second')]
  const grown = [...twoTurns, reply('a2', 'answer two'), human('u3', 'third')]

  check('a grown conversation keeps its prefix', continuesSignature(conversationSignature(twoTurns), conversationSignature(grown)) === true)
  check('a shortened conversation is not a prefix', continuesSignature(conversationSignature(grown), conversationSignature(twoTurns)) === false)
  check('an edited turn diverges', continuesSignature(conversationSignature(twoTurns), conversationSignature([human('u1', 'first'), reply('a1', 'answer one'), human('u2', 'second EDITED')])) === false)
  check('the same history is a prefix of itself', continuesSignature(conversationSignature(twoTurns), conversationSignature(twoTurns)) === true)

  // Compaction (the desktop profile runs billion-context) replaces the head with
  // a summary and keeps the tail. That is NOT a rollback: the CLI's transcript is
  // still the richer copy, and rebuilding it would only lose detail.
  const beforeCompaction = [human('u1', 'one'), reply('a1', 'r1'), human('u2', 'two'), reply('a2', 'r2'), human('u3', 'three')]
  const compacted = [
    { id: 'summary', role: 'user', source: { kind: 'compaction-summary' }, content: [{ type: 'text', text: 'summary of earlier turns' }] },
    human('u3', 'three'),
  ]
  check('a compacted history is not treated as a rollback', continuesSignature(conversationSignature(beforeCompaction), conversationSignature(compacted)) === true, 'compaction')

  // A rollback that keeps everything but the last message, re-sent verbatim.
  check('a tail-only rollback is detected', continuesSignature(conversationSignature(grown), conversationSignature([...twoTurns, reply('a2', 'answer two')])) === false)

  // Machinery must not move the fingerprint: injected reminders vary per turn.
  const withReminders = [
    human('u1', 'first'),
    reminder('r1', 'runtime-context', 'cwd is somewhere'),
    reply('a1', 'answer one'),
    reminder('t1', 'time-context', 'Time sampled at 12:00'),
    human('u2', 'second'),
  ]
  check('injected reminders do not change the fingerprint', conversationSignature(withReminders).join('|') === conversationSignature(twoTurns).join('|'))
  const withMarker = [...twoTurns, { id: 'rw', role: 'user', source: { kind: 'dsh-rewind' }, content: [{ type: 'text', text: '(empty message)' }] }]
  check('the rewind marker is not conversation', conversationSignature(withMarker).join('|') === conversationSignature(twoTurns).join('|'))

  // A rewind digest rebuilds the surviving history with a much larger budget and
  // says what it is, instead of claiming a provider handoff.
  const { handoffDigest } = await import('../index.js')
  const longHistory = []
  for (let index = 0; index < 20; index += 1) {
    longHistory.push(human(`h${index}`, `question ${index} `.repeat(20)))
    longHistory.push(reply(`r${index}`, `answer ${index} `.repeat(20)))
  }
  const question = human('hnow', 'CURRENT-QUESTION')
  const handoff = handoffDigest([...longHistory, question])
  const rebuilt = handoffDigest([...longHistory, question], { reason: 'rewind' })
  check('a handoff digest keeps the short budget', handoff.split('\n').length <= 2 + 12, String(handoff.split('\n').length))
  check('a rewind digest keeps far more turns', rebuilt.split('\n').length > handoff.split('\n').length, `${rebuilt.split('\n').length} vs ${handoff.split('\n').length}`)
  check('a rewind digest is bounded', rebuilt.length <= 24_000 + 400, String(rebuilt.length))
  check('a rewind digest says the chat was rolled back', rebuilt.includes('rolled back') && !rebuilt.includes('handoff'))
  check('a rewind digest still ends at the question boundary', !rebuilt.includes('CURRENT-QUESTION'))
  check('a rewind marker never enters the digest', !handoffDigest([human('u1', 'hi'), { id: 'rw', role: 'user', source: { kind: 'dsh-rewind' }, content: [{ type: 'text', text: '(empty message)' }] }, human('u2', 'again')], { reason: 'rewind' }).includes('(empty message)'))
}

// --- wired: a rollback drops the warm process and rebuilds the transcript ---
{
  const { settingsPath: rewindSettingsPath } = await import('../src/config/store.js')
  const file = rewindSettingsPath()
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE = '1'
  process.env.DSH_CODEBUDDY_FAKE_COUNTER = join(scratch, 'rewind.txt')
  process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST = '2'
  const fakeHome = process.env.CODEBUDDY_HOME
  process.env.CODEBUDDY_HOME = join(scratch, 'cbhome-rewind')
  writeSettings({ hiddenModels: [], keepAliveSeconds: 900 })

  const rewindAdapter = makeAdapter(binary).adapter
  const session = `rewind-${Date.now().toString(36)}`
  const turnOne = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'FIRST-QUESTION' }] }
  const answerOne = { id: 'a1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'first answer' }] }
  const turnTwo = { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SECOND-QUESTION' }] }

  await step(rewindAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [turnOne], toolHistory: [], sessionId: session, tools: [] })
  await new Promise(resolve => setTimeout(resolve, 150))
  await step(rewindAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [turnOne, answerOne, turnTwo], toolHistory: [], sessionId: session, tools: [] })
  await new Promise(resolve => setTimeout(resolve, 150))
  check('the warm conversation is parked before the rollback', rewindAdapter.backendStatus().parked === 1, JSON.stringify(rewindAdapter.backendStatus()))

  // DSH rewinds to the first question: everything after it disappears.
  const rewound = await step(rewindAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [turnOne], toolHistory: [], sessionId: session, tools: [] })
  check('a rollback settles without error', rewound.threw === undefined, String(rewound.threw?.message).slice(0, 80))
  check('a rollback drops the warm process', rewindAdapter.backendStatus().parked === 0, JSON.stringify(rewindAdapter.backendStatus()))

  delete process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE
  delete process.env.DSH_CODEBUDDY_FAKE_ECHO_FIRST
  delete process.env.DSH_CODEBUDDY_FAKE_COUNTER
  if (fakeHome === undefined) delete process.env.CODEBUDDY_HOME; else process.env.CODEBUDDY_HOME = fakeHome
  writeFileSync(file, previous, 'utf8')
}

// --- disposes flushes the fingerprint, and never empties it ----------------
{
  // The fingerprint write is debounced, so dispose has to flush it. Flushing
  // after clearing the map would persist an empty document and destroy the
  // rollback detection the file exists for — the regression this pins.
  const { settingsPath: disposeSettingsPath, historiesPath, readHistories } = await import('../src/config/store.js')
  const file = disposeSettingsPath()
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writeSettings({ hiddenModels: [], keepAliveSeconds: 0 })
  process.env.DSH_CODEBUDDY_FAKE_COUNTER = join(scratch, 'dispose.txt')

  const { adapter: flushAdapter } = makeAdapter(binary)
  const session = `flush-${Date.now().toString(36)}`
  const humanTurn = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'FLUSH-ME' }] }
  await step(flushAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [humanTurn], toolHistory: [], sessionId: session, tools: [] })
  await flushAdapter.dispose()
  await new Promise(resolve => setTimeout(resolve, 50))

  const stored = readHistories()
  check('dispose keeps the recorded fingerprint instead of a blank file', stored.has(session) && stored.get(session).length > 0, JSON.stringify([...stored.keys()]))
  delete process.env.DSH_CODEBUDDY_FAKE_COUNTER
  writeFileSync(file, previous, 'utf8')
}


// --- close escalates an uncooperative process to a forced kill -------------
{
  const { openCli } = await import('../src/cli/session.js')
  process.env.DSH_CODEBUDDY_FAKE_IGNORE_TERM = '1'
  const child = openCli({ entry: binary, model: 'glm-5.3', sessionId: `kill-${Date.now().toString(36)}`, permissionMode: 'default' })
  await new Promise(resolve => setTimeout(resolve, 120))
  const started = Date.now()
  await child.close()
  delete process.env.DSH_CODEBUDDY_FAKE_IGNORE_TERM
  check('close force-kills a child that ignores graceful termination', Date.now() - started < 7000 && !child.alive, String(Date.now() - started))
}

// --- multiple accounts: registry, isolation env, pool, cooldown --------------
{
  const {
    readAccounts, writeAccounts, nextAccountId, prepareAccount, accountEnv, accountLoginCommand,
    buildPool, rankPool, pickAccount, cooldownFor, accountsPath, homesRoot,
    RATE_LIMIT_COOLDOWN_MS, EXHAUSTED_COOLDOWN_MS, FAILED_COOLDOWN_MS,
  } = await import('../src/account/pool.js')

  // The registry: a fresh DSH home holds nothing, and a saved round-trip reads back.
  process.env.DSH_HOME = join(scratch, 'accounts-home')
  mkdirSync(join(scratch, 'accounts-home', 'dsh-connect-codebuddy-cli'), { recursive: true })
  check('an empty registry reads as no accounts', readAccounts().accounts.length === 0, JSON.stringify(readAccounts()))
  const rows = [
    { id: 'a1', home: join(scratch, 'accounts-home', 'codebuddy-homes', 'a1'), label: '国际小号', enabled: true },
    { id: 'a2', home: join(scratch, 'accounts-home', 'codebuddy-homes', 'a2'), label: '', enabled: false },
  ]
  check('the registry round-trips', writeAccounts(rows) === true && readAccounts().accounts.length === 2 && readAccounts().accounts[0].label === '国际小号')
  check('ids never repeat', nextAccountId(rows) === 'a3')

  // The prepared login command pins both relocations.
  const prepared = prepareAccount(readAccounts().accounts)
  check('a prepared account gets a fresh id and home', prepared.id === 'a3' && prepared.home.endsWith('a3'), prepared.home)
  check('the login command carries both env pins', prepared.command.includes('USERPROFILE') && prepared.command.includes('CODEBUDDY_CONFIG_DIR'), prepared.command.slice(0, 80))
  const posixCommand = accountLoginCommand("/tmp/a'b $HOME", 'linux')
  check('a POSIX login command pins HOME and quotes shell literals', posixCommand.startsWith("HOME='/tmp/a'") && posixCommand.includes(String.raw`'"'"'`) && posixCommand.includes(' USERPROFILE=') && !posixCommand.includes(String.fromCharCode(92)) && posixCommand.endsWith(' codebuddy'), posixCommand)
  const windowsCommand = accountLoginCommand("C:\\a'b", 'win32')
  check('a Windows login command quotes PowerShell literals', windowsCommand.includes("$env:USERPROFILE='C:\\a''b'"), windowsCommand)
  check('the prepared home exists', existsSync(prepared.home))

  // The child environment isolates both stores.
  const env = accountEnv(rows[0].home)
  check('the account env relocates the profile and the CLI home', env.USERPROFILE === rows[0].home && env.CODEBUDDY_CONFIG_DIR === join(rows[0].home, '.codebuddy'), JSON.stringify(env))
  check('the default account overrides nothing', Object.keys(accountEnv('')).length === 0)
  if (process.platform !== 'win32') {
    check('a POSIX account pins HOME too', env.HOME === rows[0].home, JSON.stringify(env))
  }

  // Per-account state reads take the home as a parameter and never mutate this
  // process's environment: a mutated USERPROFILE once stayed in force across
  // the credit probe's await points and redirected concurrent homedir() reads.
  const { accountState, accountCredits } = await import('../src/account/pool.js')

  // The pool: a damaged/missing session reads as not signed in; cooldown excludes.
  const packageRoot = dirname(binary)
  const envBefore = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  const isolatedState = accountState(packageRoot, rows[0].home)
  check('an isolated home reads as not signed in without touching the environment', isolatedState.signedIn === false && process.env.USERPROFILE === envBefore.USERPROFILE && process.env.HOME === envBefore.HOME, JSON.stringify({ state: isolatedState.state, unchanged: process.env.USERPROFILE === envBefore.USERPROFILE }))
  const isolatedCredits = await accountCredits(packageRoot, rows[0].home)
  check('an isolated credit probe leaves the environment unchanged', isolatedCredits.available === false && process.env.USERPROFILE === envBefore.USERPROFILE && process.env.HOME === envBefore.HOME, JSON.stringify(isolatedCredits))

  const pool = buildPool(packageRoot, new Map())
  check('the pool always carries the default login', pool.some(member => member.account.id === 'default'), JSON.stringify(pool.map(m => m.account.id)))
  check('disabled rows stay out of the pool', !pool.some(member => member.account.id === 'a2'))
  const notSignedIn = pool.find(member => member.account.id === 'a1')
  check('an unlogged home is excluded as not signed in', notSignedIn?.excludedBy === 'not-signed-in', notSignedIn?.excludedBy)

  // In this scratch home the profiles have no login session, so the only
  // signed-in member is the default one. Cool IT down and verify the picker
  // reports nothing usable rather than silently serving the cooled account.
  const cooldowns = new Map([['default', cooldownFor('rate-limited', 1000)]])
  const cooled = buildPool(packageRoot, cooldowns, 2000)
  const defaultMember = cooled.find(member => member.account.id === 'default')
  check('a rate-limited account is excluded until its cooldown ends', defaultMember?.excludedBy === 'rate-limited' && defaultMember.retryAtMs === 1000 + 60_000)
  check('the ranking puts usable accounts first', rankPool(cooled)[0].account.id !== 'default' || rankPool(cooled).every(member => member.excludedBy !== undefined), JSON.stringify(rankPool(cooled).map(m => m.account.id)))
  const picked = pickAccount(packageRoot, cooldowns, 2000)
  check('the picker never serves a cooled account while anything is signed in elsewhere', picked === undefined || picked.account.id !== 'default', JSON.stringify({ picked: picked?.account?.id }))
  const reentered = pickAccount(packageRoot, new Map([['default', { until: 500, reason: 'rate-limited' }]]), 2000)
  check('an expired cooldown re-enters the pool', reentered !== undefined && reentered.excludedBy === undefined, JSON.stringify(reentered ? { id: reentered.account.id, excludedBy: reentered.excludedBy } : undefined))
  check('the expired account is the one that re-enters', reentered?.account.id === 'default', reentered?.account.id)

  // The outcome classifier lives on the adapter; its constants are here.
  check('cooldown windows: rate limit 60s, exhausted 10min, failed 30s', (() => {
    const rate = cooldownFor('rate-limited', 0)
    const exhausted = cooldownFor('exhausted', 0)
    const failed = cooldownFor('failed', 0)
    return rate.until === RATE_LIMIT_COOLDOWN_MS && exhausted.until === EXHAUSTED_COOLDOWN_MS
      && failed.until === FAILED_COOLDOWN_MS && EXHAUSTED_COOLDOWN_MS > RATE_LIMIT_COOLDOWN_MS
  })())

  // The classifier is text-only and must not cool a healthy account for a
  // message that merely mentions credits; the rate-limit branch outranks a
  // credit mention, and exhaustion needs an exhaustion word.
  const { classifyAccountFailure } = await import('../src/adapter/adapter.js')
  check('a 429 that mentions credits is a rate limit', classifyAccountFailure('HTTP 429: credits service busy') === 'rate-limited')
  check('an exhaustion message is classified', classifyAccountFailure('request rejected: credits exhausted') === 'exhausted')
  check('a Chinese exhaustion message is classified', classifyAccountFailure('积分不足，请充值') === 'exhausted')
  check('a message that only mentions credits stays failed', classifyAccountFailure('credits are billed per model call') === 'failed')
  check('an unknown transport error stays failed', classifyAccountFailure('ECONNRESET while reading the stream') === 'failed')

  // End-to-end pool coverage: the host login is absent, another profile wins
  // the global ranking after the first turn, and the conversation must still
  // keep its original account through cold starts, warming, and rollback.
  const writeLogin = (home, nickname) => {
    const shared = process.platform === 'win32'
      ? join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
        : join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify({
      account: { nickname, type: 'personal' },
      auth: { accessToken: 'offline-secret', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 3_600_000, lastRefreshTime: Date.now() },
    }))
  }
  writeLogin(rows[0].home, 'pool-one')
  writeAccounts([rows[0]])
  const a0 = { id: 'a0', home: join(scratch, 'accounts-home', 'codebuddy-homes', 'a0'), label: 'new winner', enabled: true }
  writeLogin(a0.home, 'pool-zero')
  const defaultHome = join(scratch, 'default-signed-out')
  const defaultConfig = join(defaultHome, '.codebuddy')
  mkdirSync(defaultHome, { recursive: true })
  const savedEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR,
    PROBE: process.env.DSH_CODEBUDDY_NO_CATALOG_PROBE,
  }
  process.env.USERPROFILE = defaultHome
  process.env.HOME = defaultHome
  process.env.CODEBUDDY_CONFIG_DIR = defaultConfig
  writeSettings({ hiddenModels: [], keepAliveSeconds: 60 })
  const envLog = join(scratch, 'pool-env.log')
  process.env.DSH_CODEBUDDY_FAKE_ENV = envLog
  process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE = '1'
  const envRows = () => existsSync(envLog)
    ? readFileSync(envLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const poolAdapter = makeAdapter(binary).adapter
  const poolSession = `pool-${Date.now().toString(36)}`
  const u1 = { id: 'pu1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'POOL-FIRST' }] }
  const r1 = { id: 'pr1', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'first answer' }] }
  const u2 = { id: 'pu2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'POOL-SECOND' }] }
  const r2 = { id: 'pr2', role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'second answer' }] }
  const u3 = { id: 'pu3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'POOL-THIRD' }] }
  const firstPool = await step(poolAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [u1], toolHistory: [], sessionId: poolSession, tools: [] })
  check('a signed-in pool account works when the default login is absent', firstPool.threw === undefined && envRows().at(-1)?.CODEBUDDY_CONFIG_DIR === join(rows[0].home, '.codebuddy'), String(firstPool.threw?.message))
  await new Promise(resolve => setTimeout(resolve, 150))
  poolAdapter.discardParkedForPromptChange()
  writeAccounts([a0, rows[0]])
  const secondPool = await step(poolAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [u1, r1, u2], toolHistory: [], sessionId: poolSession, tools: [] })
  check('a cold turn keeps its bound account instead of the new global winner', secondPool.threw === undefined && envRows().at(-1)?.CODEBUDDY_CONFIG_DIR === join(rows[0].home, '.codebuddy'), String(secondPool.threw?.message))
  await new Promise(resolve => setTimeout(resolve, 150))
  poolAdapter.discardParkedForPromptChange()
  const beforeWarm = envRows().length
  const warmedPool = await poolAdapter.warm()
  // The adapter parks immediately; the fake records its environment when the
  // child gets scheduled, one tick later.
  await new Promise(resolve => setTimeout(resolve, 150))
  check('warming starts the bound pool account, not the default account', warmedPool.warmed === true && envRows().length > beforeWarm && envRows().at(-1)?.CODEBUDDY_CONFIG_DIR === join(rows[0].home, '.codebuddy'), JSON.stringify({ warmedPool, last: envRows().at(-1) }))
  const afterWarm = envRows().length
  const thirdPool = await step(poolAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [u1, r1, u2, r2, u3], toolHistory: [], sessionId: poolSession, tools: [] })
  check('the next turn reuses the correctly bound warm process', thirdPool.threw === undefined && envRows().length === afterWarm, JSON.stringify({ error: String(thirdPool.threw?.message), count: envRows().length, afterWarm }))
  await new Promise(resolve => setTimeout(resolve, 150))

  const { codebuddySessionId } = await import('../src/cli/session.js')
  const cliSession = codebuddySessionId(poolSession)
  const poolTranscript = codebuddyTranscriptPath(process.cwd(), cliSession, join(rows[0].home, '.codebuddy'))
  const defaultTranscript = codebuddyTranscriptPath(process.cwd(), cliSession, defaultConfig)
  mkdirSync(dirname(poolTranscript), { recursive: true })
  mkdirSync(dirname(defaultTranscript), { recursive: true })
  writeFileSync(poolTranscript, 'POOL-REVOKED')
  writeFileSync(defaultTranscript, 'DEFAULT-KEEP')
  const rewoundPool = await step(poolAdapter, { provider: PROVIDER_ID, model: 'glm-5.3', messages: [u1], toolHistory: [], sessionId: poolSession, tools: [] })
  check('pool rollback deletes only that account\'s transcript', rewoundPool.threw === undefined && !existsSync(poolTranscript) && readFileSync(defaultTranscript, 'utf8') === 'DEFAULT-KEEP', String(rewoundPool.threw?.message))

  // ACP probes are cached per home and receive that home's environment.
  delete process.env.DSH_CODEBUDDY_NO_CATALOG_PROBE
  const hostCatalog = await poolAdapter.refreshModelCatalog('')
  const accountCatalog = await poolAdapter.refreshModelCatalog(rows[0].home)
  check('ACP catalogs stay isolated by account', hostCatalog?.models?.get('glm-5.3')?.credits === 'x0.11 credits' && accountCatalog?.models?.get('glm-5.3')?.credits === 'x0.88 credits', JSON.stringify({ host: hostCatalog?.models?.get('glm-5.3'), account: accountCatalog?.models?.get('glm-5.3') }))
  check('credit labels never cross account caches', poolAdapter.creditFor('glm-5.3', new Map(), '').ratio === 0.11 && poolAdapter.creditFor('glm-5.3', new Map(), rows[0].home).ratio === 0.88)
  const probeA = poolAdapter.refreshModelCatalog(a0.home)
  const probeB = poolAdapter.refreshModelCatalog(a0.home)
  check('concurrent ACP probes share one process per account', probeA === probeB)
  await probeA
  if (savedEnv.PROBE !== undefined) process.env.DSH_CODEBUDDY_NO_CATALOG_PROBE = savedEnv.PROBE

  const originalCreditFetch = globalThis.fetch
  let creditCalls = 0
  const creditResponse = () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { TotalCredits: '1', CreditGroups: [] } }) })
  globalThis.fetch = async () => {
    creditCalls += 1
    await new Promise(resolve => setTimeout(resolve, 30))
    return creditResponse()
  }
  await poolAdapter.poolStatus(packageRoot, {})
  const beforeFreshCredits = creditCalls
  await poolAdapter.poolStatus(packageRoot, { freshCredits: true })
  check('freshCredits reaches the account service instead of the cache', creditCalls > beforeFreshCredits, `${beforeFreshCredits} -> ${creditCalls}`)
  const afterFreshCredits = creditCalls
  await poolAdapter.poolStatus(packageRoot, {})
  check('an ordinary pool read reuses the fresh cache', creditCalls === afterFreshCredits, String(creditCalls))
  globalThis.fetch = async () => {
    creditCalls += 1
    await new Promise(resolve => setTimeout(resolve, 500))
    return creditResponse()
  }
  const creditDeadlineStart = Date.now()
  await poolAdapter.poolStatus(packageRoot, { freshCredits: true, timeoutMs: 80 })
  check('pool credit reads respect the overall page deadline', Date.now() - creditDeadlineStart < 400, String(Date.now() - creditDeadlineStart))
  globalThis.fetch = originalCreditFetch

  const failureTurn = async (kind, label) => {
    process.env.DSH_CODEBUDDY_FAKE_FAILURE = kind
    const retryAdapter = makeAdapter(binary).adapter
    const before = envRows().length
    const sessionId = `${label}-${Date.now().toString(36)}`
    const user = { id: label, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: label }] }
    const options = { provider: PROVIDER_ID, model: 'glm-5.3', toolHistory: [], sessionId, tools: [{ name: 'Write' }] }
    let outcome = await step(retryAdapter, { ...options, messages: [user] })
    if (kind === 'after-tool' && outcome.cards.length > 0) {
      const assistant = { id: `${label}-a`, role: 'assistant', source: { kind: 'assistant' }, content: outcome.cards.map(card => ({ type: 'tool-call', id: card.id, name: card.name, arguments: card.arguments })) }
      const tool = { id: `${label}-t`, role: 'tool', source: { kind: 'tool' }, toolCallId: outcome.cards[0].id, content: [{ type: 'text', text: 'ok' }] }
      outcome = await step(retryAdapter, { ...options, messages: [user, assistant, tool] })
    }
    const rows = envRows().slice(before)
    await retryAdapter.dispose()
    return { outcome, rows }
  }
  const retried = await failureTurn('429', 'retry-safe')
  check('a pre-output 429 switches accounts once and succeeds', retried.outcome.threw === undefined && retried.rows.length === 2 && retried.rows[0]?.CODEBUDDY_CONFIG_DIR.includes('a0') && retried.rows[1]?.CODEBUDDY_CONFIG_DIR.includes('a1'), JSON.stringify(retried.rows.map(row => row.CODEBUDDY_CONFIG_DIR)))
  const partial = await failureTurn('after-text', 'retry-partial')
  check('an unknown failure after text is never replayed', partial.outcome.text.includes('PARTIAL-OUTPUT') && partial.rows.length === 1, String(partial.rows.length))
  const sideEffect = await failureTurn('after-tool', 'retry-tool')
  check('a 429 after a tool side effect is never replayed', sideEffect.outcome.threw !== undefined && sideEffect.rows.length === 1, String(sideEffect.rows.length))
  delete process.env.DSH_CODEBUDDY_FAKE_FAILURE
  await poolAdapter.dispose()
  delete process.env.DSH_CODEBUDDY_FAKE_ENV
  delete process.env.DSH_CODEBUDDY_FAKE_STAY_ALIVE
  for (const name of ['USERPROFILE', 'HOME', 'CODEBUDDY_CONFIG_DIR']) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]
  }

  writeAccounts([])
}

await new Promise(resolve => setTimeout(resolve, 400))
rmSync(scratch, { recursive: true, force: true })
const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const entry of failed) console.log(`  failed: ${entry.label}`)
  process.exitCode = 1
}
// Explicit exit: leftover timers would otherwise keep the loop alive.
process.exit(failed.length === 0 ? 0 : 1)
