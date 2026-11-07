/**
 * One CLI turn, translated into DSH stream chunks one assistant message at a time.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/adapter/turn
 */

import { continuesTurn } from '../conversation/messages.js'
import { join } from 'node:path'
import { SPENT_TURN, cardArguments, recordPermissionDenials, recordToolResults, toolResults } from '../bridge/cards.js'

/**
 * One CodeBuddy turn, drained one assistant message at a time.
 *
 * DSH draws one row per assistant *message* and dispatches that message's
 * `tool-call` blocks only after the message settles. A whole CLI turn pushed
 * through a single message therefore had two visible faults, both of them
 * structural rather than cosmetic:
 *
 * - Every tool card landed after the entire reply. The row for a message is
 *   anchored at its first text delta and renders all of that message's text;
 *   cards are rows of their own, anchored later. So text that came after a call
 *   still rendered above it.
 * - The transcript folded the reply. A turn only counts as having an answer
 *   when its newest step's blocks are free of tool calls
 *   (`latestAnswer` in the Chat UI); a message carrying both text and calls
 *   matches nothing, so every row became a member of the collapsed process
 *   group.
 *
 * So the CLI's own message boundaries become DSH step boundaries. A step ends
 * at `message_stop` — after the results of that message's tool calls have been
 * recorded, because DSH dispatches those cards the instant the step settles —
 * and the next step resumes from frames the CLI has already produced. The CLI
 * runs unattended in between: it is only ever waiting on its own tools, so
 * holding a step costs no work and no extra process.
 */
class CodeBuddyTurn {
  /** Frames pulled from the CLI but not yet consumed by a step. */
  #buffered = []

  /** Set once the frame stream ended. */
  #streamEnded = false

  /** Set once this turn must not serve another step. */
  #finished = false

  /** Set once the session has been handed back to its owner. */
  #retired = false

  /** Set once the child has been asked to stop. */
  #closed = false

  /** Set once the terminal `result` frame has been read. */
  #sawResult = false

  /** Failure the terminal `result` frame reported, if any. */
  #failure

  /** Pre-flight error the CLI reported instead of running the turn. */
  #preflightError = ''

  /** How many steps this turn has served. */
  #steps = 0

  /** False once any step has exposed text, reasoning, or a tool call. */
  #replaySafe = true

  /** Whether a fresh account may replay this request without duplicating output or side effects. */
  get replaySafe() {
    return this.#replaySafe
  }

  /** Whether the terminal bookkeeping has been read out in the background. */
  #draining = false

  /** The turn's cancellation signal. */
  #signal

  /** The human text this turn answers; identifies its continuation steps. */
  prompt

  /** The account id this turn runs on (`'default'` for the host's own login). */
  accountId

  /** The CLI session this turn runs on. */
  #session

  /** Called once the turn is over, so the owner can park or close it. */
  #onDone

  /**
   * @param turn - the turn to serve: `{ session, prompt, signal, onDone }`.
   */
  constructor(turn) {
    this.prompt = turn.prompt
    this.accountId = typeof turn.accountId === 'string' && turn.accountId !== '' ? turn.accountId : 'default'
    this.#signal = turn.signal
    this.#session = turn.session
    this.#onDone = turn.onDone
  }

  /**
   * Whether this turn is the one a step belongs to.
   *
   * A continuation step is the same human prompt followed by the results of
   * the calls the previous step reported; that is exactly the shape DSH
   * produces between steps, and it cannot be confused with a new user message,
   * which always ends at human text plus injected reminders.
   * @param messages - the step's projected messages.
   * @param prompt - the human text the step answers.
   * @returns true when the step continues this turn.
   */
  serves(messages, prompt) {
    if (this.#finished || this.#closed) return false
    if (this.#steps === 0) return false
    if (this.prompt !== prompt) return false
    return continuesTurn(messages)
  }

  /**
   * Translate one CLI assistant message into DSH chunks.
   * @param options - this step's capabilities.
   * @param options.cardsUsable - whether a reported call can be dispatched, so
   *   one CLI message can be its own step.
   * @param options.cards - the registered display tools, when they are ready.
   * @param options.admitted - the tool names this step's tool set advertises.
   * @yields DSH stream chunks.
   */
  async *step({ cardsUsable, cards, admitted = new Set() }) {
    if (this.#finished || this.#closed) return
    this.#steps += 1
    const first = this.#steps === 1
    // A call can only be dispatched when a definition for its wire name was
    // admitted before this step's tool set was frozen.
    const dispatchable = cardsUsable === true && cards?.ready === true

    /** CLI content-block index → DSH block index, local to this message. */
    const indexMap = new Map()
    let nextIndex = 0
    /**
     * The tool call whose arguments are still streaming.
     *
     * The CLI reuses one content-block index for consecutive tool calls and
     * opens the next `tool_use` block without closing the previous one, so a
     * map keyed by index would silently overwrite the earlier call. A single
     * slot flushed on every new block start is what actually matches the
     * protocol: deltas always belong to the most recently opened block.
     */
    let pendingTool
    let sawText = false
    let sawReasoning = false
    let sawToolCall = false
    let usage
    let resultText = ''
    /** Whether this step reached the end of a CLI message. */
    let ended = false
    /** Whether a CLI message was already open in this step. */
    let opened = false
    /**
     * Call ids of this message whose results have not arrived yet.
     *
     * The CLI answers each call *before* opening its next message, so a step
     * that carries cards waits for these instead of settling early: DSH
     * dispatches the cards the moment the step settles, and a card whose result
     * has not been recorded would replay an empty body.
     */
    const awaiting = new Set()

    /** Map one CLI block index onto a fresh DSH index. */
    const dshIndex = (key) => {
      const existing = indexMap.get(key)
      if (existing !== undefined) return existing
      const assigned = nextIndex
      nextIndex += 1
      indexMap.set(key, assigned)
      return assigned
    }

    /**
     * Close the block still streaming, as a card when the step can dispatch.
     *
     * DSH draws a tool card only for a `tool-call` block, so the call is
     * reported with its CLI id and name — the id is what later pairs the card
     * with the recorded result. Arguments are re-serialized with the
     * identifying key first because the generic card summary shows the first
     * string value it finds, and CodeBuddy's own order (`content` before
     * `file_path`) would label a write with the file's contents.
     *
     * When the step cannot dispatch (ptc mode) the call would come back as an
     * error result that carries nothing usable, so it is reported as reasoning
     * text instead and the answer still arrives.
     */
    const flushTool = function* (call) {
      const argsRaw = reorderArguments(call.json)
      if (!dispatchable) {
        sawReasoning = true
        yield { type: 'reasoning-delta', index: call.index, text: `${toolSummary(call.name, call.json)}\n` }
        return
      }
      sawToolCall = true
      // The wire name is decided before the registration below: a name seen for
      // the first time cannot be admitted by this step, whose tool set was
      // frozen before the call existed, so it has to ride the fallback card.
      // Registering it then lets the steps that follow use the real name.
      const wireName = cards.wireName(call.name, admitted)
      cards.ensure(call.name)
      const argumentsJson = cardArguments(call.name, wireName, argsRaw)
      yield { type: 'tool-call-delta', index: call.index, id: call.id, name: wireName, argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: call.index, block: { type: 'tool-call', id: call.id, name: wireName, arguments: argumentsJson } }
      awaiting.add(call.id)
    }

    while (!ended) {
      const read = await this.#read()
      if (read.done === true) break
      const frame = read.frame

      if (frame?.type === 'error') {
        // A bare `error` frame is the CLI's pre-flight report — an unusable
        // session id, a missing install, an unknown conversation — and no
        // `result` follows it. Record it and let the step end.
        this.#noteError(frame)
        break
      }

      if (frame?.type === 'result') {
        recordPermissionDenials(frame)
        this.#noteResult(frame)
        if (usage === undefined) usage = usageOf(frame.usage)
        if (frame.is_error !== true && !sawText) {
          // No partial messages arrived (older CLI, or a build that ignores
          // --include-partial-messages). The result frame still carries the
          // full answer, so use it rather than losing the turn.
          resultText = typeof frame.result === 'string' ? frame.result : ''
        }
        break
      }

      if (frame?.type === 'user') {
        // `user` frames carry the tool results the CLI already acted on. They
        // are not replayed into the transcript — the assistant's own tool-call
        // blocks are the record — but the text is what the card's expanded
        // body shows, so it is captured against the CLI's call id.
        recordToolResults(frame)
        continue
      }

      if (frame?.type !== 'stream_event') continue
      const event = frame.event

      if (event?.type === 'message_start') {
        if (opened) {
          // The next assistant message is the next step's row, not this one's.
          this.#unread(frame)
          ended = true
          continue
        }
        // Block indices restart at 0 for every assistant message.
        opened = true
        pendingTool = undefined
        continue
      }

      if (event?.type === 'content_block_start') {
        const block = event.content_block
        if (block?.type === 'tool_use') {
          // A new tool block supersedes whatever was still streaming: the CLI
          // opens the next call without closing the previous one, so this is
          // the only point at which the earlier call is known to be complete.
          if (pendingTool !== undefined) yield* flushTool(pendingTool)
          // Hold the call until its arguments finish streaming, so the card
          // can show what is actually being touched. A tool whose arguments
          // never arrive is still reported at the next boundary.
          pendingTool = {
            index: dshIndex(`tool:${String(block.id ?? nextIndex)}`),
            id: typeof block.id === 'string' && block.id !== '' ? block.id : `call-${nextIndex}`,
            name: typeof block.name === 'string' && block.name !== '' ? block.name : 'a tool',
            json: '',
          }
        }
        continue
      }

      if (event?.type === 'content_block_delta') {
        const delta = event.delta
        if (delta?.type === 'thinking_delta') {
          const text = delta.thinking ?? ''
          if (text !== '') {
            sawReasoning = true
            yield { type: 'reasoning-delta', index: dshIndex(event.index), text }
          }
        } else if (delta?.type === 'text_delta') {
          const text = delta.text ?? ''
          if (text !== '') {
            sawText = true
            yield { type: 'text-delta', index: dshIndex(event.index), text }
          }
        } else if (delta?.type === 'input_json_delta') {
          // Tool arguments arrive as JSON fragments; accumulate them so the
          // call can be summarized once it is known to be complete.
          if (pendingTool !== undefined) pendingTool.json += delta.partial_json ?? ''
        }
        continue
      }

      if (event?.type === 'content_block_stop') {
        if (pendingTool !== undefined) {
          const call = pendingTool
          pendingTool = undefined
          yield* flushTool(call)
        }
        continue
      }

      if (event?.type === 'message_stop') {
        if (pendingTool !== undefined) {
          const call = pendingTool
          pendingTool = undefined
          yield* flushTool(call)
        }
        // Only a step boundary when this step can dispatch: in ptc mode every
        // message is reported as text, so the whole turn stays one row.
        if (dispatchable) ended = true
        continue
      }

      if (event?.type === 'message_delta') {
        // Last-wins per message: this is the prompt size of *that* request.
        usage = usageOf(event.usage) ?? usage
      }
      // `message_stop`, `system` and `assistant` frames need no translation;
      // `assistant` repeats the whole message the deltas already carried.
    }

    if (ended && awaiting.size > 0) {
      while (true) {
        if (![...awaiting].some(id => !toolResults.has(id))) break
        const read = await this.#read()
        if (read.done === true) break
        const frame = read.frame
        if (frame?.type === 'user') {
          recordToolResults(frame)
          continue
        }
        if (frame?.type === 'result') {
          this.#noteResult(frame)
          if (usage === undefined) usage = usageOf(frame.usage)
          break
        }
        if (frame?.type === 'error') {
          this.#noteError(frame)
          break
        }
        if (frame?.type === 'stream_event') {
          this.#unread(frame)
          break
        }
        // `system`, `assistant` and `file-history-snapshot` frames are
        // bookkeeping while the CLI's own tool call is completing.
      }
    }

    // This flag spans every DSH step in the CLI turn: an error can arrive in a
    // continuation after the tool call or partial text that forbids a replay.
    if (sawText || sawReasoning || sawToolCall) this.#replaySafe = false

    if (this.#failure !== undefined) {
      // The CLI answered with a failed turn (a quota rejection, for instance).
      // The process itself is healthy and is already parked on its stdin, so it
      // is handed back before the error is raised: the retry after a quota reset
      // should not pay for another start-up.
      this.#finished = true
      this.#retire()
      throw this.#failure
    }

    if (this.#preflightError !== '') {
      // The turn never started, so the session is of no further use — but the
      // owner still has to hear about it, or the child leaks until dispose.
      this.#finished = true
      this.#retire()
      throw new Error(this.#preflightError)
    }

    if (this.#signal?.aborted === true) {
      // The reader cancelled while the CLI was still working — including while
      // this step waited for a tool result. Reporting a clean stop here would
      // present a truncated answer as a finished one.
      this.#finished = true
      this.#retire()
      throw new Error('CodeBuddy CLI turn was cancelled')
    }

    if (!ended && !this.#sawResult) {
      // No message boundary and no `result` means the process ended without
      // finishing what it started — in practice, cancellation. DSH turns an
      // abort-classified failure into an interrupted assistant message that
      // keeps whatever text already streamed, which is the honest outcome.
      this.#finished = true
      this.#retire()
      throw new Error('CodeBuddy CLI turn was cancelled')
    }

    if (!sawText && resultText !== '') {
      yield { type: 'text-delta', index: dshIndex('result'), text: resultText }
      sawText = true
    }

    if (this.#sawResult) {
      // The turn is over — nothing else can belong to it. The session itself is
      // handed back rather than closed: the next message in this conversation
      // can reuse the parked process.
      this.#finished = true
      this.#retire()
    } else if (ended && awaiting.size === 0) {
      // A message without tool calls ends the CLI turn, so what remains is the
      // terminal bookkeeping. Read it out in the background so the child is
      // reaped instead of being left suspended on an unread pipe.
      this.#drain()
    }

    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }

    if (!sawText && !sawReasoning && !sawToolCall && first) {
      // Nothing visible was produced. DSH treats a terminal stop with zero
      // content as a degenerate completion, so say so instead of leaving an
      // empty assistant turn behind. A later step may legitimately be empty:
      // the CLI can end a turn on a tool call that produced no continuation.
      throw new Error('CodeBuddy CLI returned an empty response')
    }
  }

  /**
   * Read the next CLI frame, then the next one, without ever losing one.
   * @returns `{ frame }` or `{ done: true }` once the stream ended.
   */
  async #read() {
    if (this.#buffered.length > 0) return { frame: this.#buffered.shift() }
    if (this.#streamEnded) return { done: true }
    const next = await this.#session.next()
    if (next.done === true) {
      this.#streamEnded = true
      return { done: true }
    }
    return { frame: next.frame }
  }

  /**
   * Put a frame back for the next step to read first.
   * @param frame - the frame that belongs to the following message.
   */
  #unread(frame) {
    this.#buffered.unshift(frame)
  }

  /**
   * Record a pre-flight error the CLI reported instead of a turn.
   * @param frame - the CLI `error` frame.
   */
  #noteError(frame) {
    this.#preflightError = errorText(frame) || 'CodeBuddy CLI reported an error before starting'
  }

  /**
   * Record the terminal `result` frame's outcome.
   * @param frame - the CLI `result` frame.
   */
  #noteResult(frame) {
    this.#sawResult = true
    if (frame?.is_error === true && this.#failure === undefined) this.#failure = resultFailure(frame)
  }

  /**
   * Read the rest of the turn out and close the child.
   *
   * Called once the CLI has nothing left to say. Frames read here cannot belong
   * to a step — a message without tool calls is the turn's last one — so they
   * are only drained, not translated.
   */
  #drain() {
    if (this.#draining) return
    this.#draining = true
    this.#finished = true
    void (async () => {
      try {
        while (true) {
          const read = await this.#read()
          if (read.done === true) break
          if (read.frame?.type !== 'result') continue
          this.#noteResult(read.frame)
          // A kept-alive session never ends its frame stream, so waiting for
          // `done` here would hang the turn forever: `result` is the last frame
          // that belongs to this turn.
          break
        }
      } catch {
        // Draining is cleanup; the step already settled.
      } finally {
        this.#retire()
      }
    })()
  }

  /**
   * Hand the session back to its owner once this turn is over.
   *
   * The owner decides whether to park the process or close it. A turn never
   * tears the session down by itself, because the next message in the same
   * conversation can reuse it.
   */
  #retire() {
    if (this.#retired) return
    this.#retired = true
    try {
      this.#onDone?.(this)
    } catch {
      // Parking is best-effort; a failure must not fail a settled step.
    }
  }

  /**
   * Stop this turn and its session for real.
   *
   * Used when DSH abandons the turn — a new message replaced it, or the request
   * was cancelled — where keeping the process would leave a conversation the
   * user has moved on from.
   */
  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#finished = true
    this.#retired = true
    await this.#session.close()
  }
}

/**
 * Summarize one CLI tool call as a single display line.
 *
 * Used only on the fallback path, where a card cannot be dispatched. The line
 * names the tool and the single most identifying argument rather than dumping
 * the input, which can be an entire file body.
 * @param name - the CLI tool name.
 * @param json - the accumulated argument JSON, possibly empty or truncated.
 * @returns a one-line summary without a trailing newline.
 */
function toolSummary(name, json) {
  const input = parseToolInput(json)
  const target = toolTarget(input)
  const tool = typeof name === 'string' && name !== '' ? name : 'tool'
  return target === '' ? `Running ${tool}` : `Running ${tool} · ${target}`
}

/**
 * Pick the one argument that best identifies what a tool call acts on.
 *
 * Every tool names its subject differently (`file_path`, `command`, `pattern`,
 * `path`, `url`), so this tries the common ones in order of specificity and
 * truncates to keep a long command or path from dominating the line.
 * @param input - the parsed tool input.
 * @returns a short description, or `''` when nothing recognizable is present.
 */
function toolTarget(input) {
  if (input === undefined) return ''
  for (const key of ARGUMENT_PRIORITY) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = value.trim().replace(/\s+/gu, ' ')
      return text.length > 96 ? `${text.slice(0, 96)}…` : text
    }
  }
  return ''
}

/**
 * Re-serialize tool arguments with the identifying key first.
 *
 * The generic tool card derives its summary from the first string value it
 * finds in the argument object, and CodeBuddy serializes its inputs in an
 * arbitrary order — `Write` arrives as `{"content":"...","file_path":"..."}`,
 * which would label the card with an entire file body. Putting the subject
 * first makes the card read `probe.txt` instead.
 * @param json - the accumulated argument JSON, possibly empty or truncated.
 * @returns the reordered JSON, or the original text when it cannot be parsed.
 */
function reorderArguments(json) {
  const input = parseToolInput(json)
  if (input === undefined) return json
  const ordered = {}
  for (const key of ARGUMENT_PRIORITY) {
    if (Object.hasOwn(input, key)) ordered[key] = input[key]
  }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value
  }
  try {
    return JSON.stringify(ordered)
  } catch {
    return json
  }
}

/** Argument keys that identify a tool call's subject, most specific first. */
const ARGUMENT_PRIORITY = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'description']

/**
 * Parse accumulated tool-argument JSON, tolerating a partial or empty buffer.
 * @param json - the fragments joined so far.
 * @returns the parsed object, or `undefined` when it cannot be parsed yet.
 */
function parseToolInput(json) {
  if (typeof json !== 'string' || json.trim() === '') return undefined
  try {
    const value = JSON.parse(json)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the explanation out of a CLI `error` frame.
 *
 * The CLI has reported this both as a bare string and as an object
 * (`{ message }`, `{ code }`), so a string-only read silently drops the reason
 * and leaves the user with a generic failure.
 * @param frame - the CLI `error` frame.
 * @returns the message text, or `''` when the frame carries none.
 */
function errorText(frame) {
  const value = frame?.error ?? frame?.message
  if (typeof value === 'string' && value !== '') return value
  if (value !== null && typeof value === 'object') {
    for (const key of ['message', 'error', 'code', 'type']) {
      const text = value[key]
      if (typeof text === 'string' && text !== '') return text
    }
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Translate a CLI `result` failure into a thrown error.
 * @param frame - the terminal result frame.
 * @returns an error carrying the CLI's own explanation.
 */
function resultFailure(frame) {
  const errors = Array.isArray(frame.errors) ? frame.errors : []
  const detail = errors
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry !== null && typeof entry === 'object') {
        const message = entry.message ?? entry.error ?? entry.code
        return typeof message === 'string' ? message : JSON.stringify(entry)
      }
      return ''
    })
    .filter(text => text !== '')
    .join('; ')
  const message = detail !== '' ? detail : typeof frame.result === 'string' && frame.result !== '' ? frame.result : 'CodeBuddy CLI reported a failed turn'
  return new Error(message)
}

/**
 * Convert the CLI's token counts into DSH's usage shape.
 *
 * The one thing that needs care is what `input_tokens` counts. DSH reads
 * `inputTokens` as the *uncached* share and then reconstructs prompt size as
 * `inputTokens + cacheReadTokens + cacheWriteTokens` (`pressureFrom` in
 * `@deepseek-ai/dsh-token-meter`). CodeBuddy reports the opposite convention:
 * its `input_tokens` is already the whole prompt, cache reads included. Measured
 * against a real turn, `input_tokens: 3106` with `cache_read_input_tokens: 2944`
 * left `modelUsage.inputTokens: 162` as the uncached remainder — i.e.
 * `162 + 2944 === 3106`.
 *
 * Passing CodeBuddy's number through unchanged therefore made DSH add the
 * cached share a second time. A turn whose prompt was 19,435 tokens reported
 * `19435 + 18304 = 37,739`, and the composer meter — which divides that by the
 * context window — read roughly double. Subtracting the cached shares here
 * makes `pressureFrom` reconstruct the CLI's own prompt size exactly
 * (1,131 + 18,304 + 0 = 19,435), which is also the figure the CLI publishes as
 * `codebuddy.ai/contextUsed`.
 * @param usage - the CLI's `usage` object, or `undefined`.
 * @returns DSH usage, or `undefined` when the CLI reported nothing.
 */
function usageOf(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const outputTokens = numberOr(usage.output_tokens, 0)
  const cacheReadTokens = numberOr(usage.cache_read_input_tokens, 0)
  const cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, 0)
  const promptTokens = numberOr(usage.input_tokens, 0)
  if (promptTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return undefined
  // Cached shares are reported separately *and* already folded into
  // `input_tokens`; clamp so an unusual wire that really does exclude them
  // cannot produce a negative count.
  const inputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)
  return {
    inputTokens,
    outputTokens,
    ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/**
 * Read a non-negative count from an unknown value.
 * @param value - candidate count.
 * @param fallback - value to use when the candidate is not a usable number.
 * @returns a non-negative integer.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

export {
  ARGUMENT_PRIORITY,
  CodeBuddyTurn,
  errorText,
  numberOr,
  parseToolInput,
  reorderArguments,
  resultFailure,
  toolSummary,
  toolTarget,
  usageOf,
}
