/**
 * Render the CLI's own tool calls as native DSH cards without re-running them.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/bridge/cards
 */


/**
 * Tool results captured from the CLI, keyed by the CLI's own call id.
 *
 * The CLI runs its own tool loop inside the single process this adapter
 * spawned, so every result is already known by the time `#stream` finishes
 * draining. Recording them here lets the virtual tool registered for each
 * reported call return the CLI's real output instead of re-running anything.
 *
 * Entries are deleted as soon as the card consumes them, so a long-lived host
 * does not accumulate one string per tool call forever.
 */
const toolResults = new Map()

/**
 * Every call emitted by the CLI, including one whose result never arrives.
 *
 * A missing result must never turn into permission to execute the same tool in
 * DSH. The virtual executor can therefore return an explicit missing-result
 * error instead of falling through to the real tool.
 */
const cliToolCalls = new Set()
const MAX_KNOWN_TOOL_CALLS = 256

/** Remember one CLI-originated call before its result is known. */
function recordToolCall(callId) {
  if (typeof callId !== 'string' || callId === '') return
  cliToolCalls.add(callId)
  while (cliToolCalls.size > MAX_KNOWN_TOOL_CALLS) {
    const oldest = cliToolCalls.values().next()
    if (oldest.done === true) break
    cliToolCalls.delete(oldest.value)
  }
}

/**
 * Definitions this plugin registered as display-only executors.
 *
 * Tracked by identity so a real tool that happens to share the CLI's name is
 * never mistaken for one of ours: only definitions in this set may be
 * shadowed, and only they are removed when the card settles.
 */
const virtualTools = new WeakSet()

/**
 * Live virtual registrations, keyed by `${scope}|${tool name}`.
 *
 * A registration must not outlive its dispatch: `schemas(scope)` advertises
 * every tool in the agent's own layer, so a leaked definition would show up in
 * that agent's tool list on every later request. The key therefore carries the
 * calling agent's registry, not just the name — two agents can dispatch the
 * same CLI tool name concurrently, and a name-only key would let the second
 * registration overwrite the first's disposer and lose its pending count,
 * leaking the first into its agent's tool list. Calls within one scope may
 * still dispatch concurrently, so teardown is refcounted per key — the last
 * call to finish disposes the registration.
 */
const liveRegistrations = new Map()

/**
 * The scope key one dispatch belongs to.
 * @param exec - the `tools/execute` envelope.
 * @returns a stable string for the calling agent's registry, or `''`.
 */
const registrationScopeIds = new WeakMap()
let nextRegistrationScopeId = 0

function registrationScope(exec) {
  const scoped = exec?.agent?.ctx
  if (scoped === undefined) return ''
  const tools = typeof scoped.get === 'function' ? scoped.get('tools') : undefined
  if ((typeof tools !== 'object' || tools === null) && typeof tools !== 'function') return ''
  // Object coercion collapses every registry to "[object Object]". A WeakMap
  // keeps the actual agent registry as the identity without retaining it after
  // the agent is gone.
  let id = registrationScopeIds.get(tools)
  if (id === undefined) {
    nextRegistrationScopeId += 1
    id = `scope-${nextRegistrationScopeId}`
    registrationScopeIds.set(tools, id)
  }
  return id
}

/**
 * Maximum recorded results kept while awaiting their cards.
 *
 * A turn that never reaches dispatch (a cancelled or failed run) would
 * otherwise leave one entry per tool call behind forever. Results are consumed
 * in call order, so trimming the oldest is safe.
 */
const MAX_RECORDED_RESULTS = 64

/**
 * The stand-in for a continuation whose CLI turn already ended.
 *
 * The CLI can stop right after a tool call — max turns, an internal failure —
 * and DSH still asks for one more step because the message carried calls. That
 * step must not spawn a second CLI process: the message has been answered, and
 * asking again would append a duplicate answer. An empty step closes the turn.
 */
const SPENT_TURN = {
  /** A continuation can never be served by it. */
  serves: () => false,
  /** Nothing is running, so there is nothing to stop. */
  close: async () => {},
  /**
   * One empty step, which the loop reads as "the model had nothing to add".
   * @yields the terminal chunk only.
   */
  async *step() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

/**
 * Render the CLI's tool calls as native DSH tool cards.
 *
 * DSH only draws a tool card for a `tool-call` block, and it *executes* every
 * such block. The CLI has already run the tool, so the card needs an executor
 * that returns the recorded output without touching the filesystem. That
 * executor has to be a real, resolvable tool definition: `normalizeDispatchResult`
 * re-resolves the name and throws `ToolNotFoundError` for anything unknown, so a
 * `tools/execute` waterfall that merely answers with a value is not enough.
 *
 * Registration is therefore scoped to the calling agent (`exec.agent.ctx`).
 * A global registration would advertise the tool to every model's schema list;
 * scoping it means only the agent that actually made the call can see it, and
 * the registration is disposed the moment that card settles.
 *
 * The gate is the recorded result, not the shape of the dispatch: a call id
 * the CLI never reported is a call the model made on its own, and it goes to
 * the real executor untouched. Nothing here ends the turn — the loop must run
 * one more step to reach the CLI's next assistant message.
 * @param ctx - the plugin context.
 */
function installToolCardBridge(ctx) {
  if (typeof ctx.on !== 'function') return
  ctx.on('tools/execute', async (exec, next) => {
    if (exec === null || typeof exec !== 'object') return next()
    if (typeof exec.name !== 'string' || exec.name === '') return next()
    // `run_code` is the reserved ptc transport and must never be shadowed.
    if (exec.name === 'run_code') return next()
    const scoped = exec.agent?.ctx
    if (scoped === undefined) return next()
    const tools = typeof scoped.get === 'function' ? scoped.get('tools') : undefined
    if (tools === undefined || typeof tools.get !== 'function' || typeof tools.register !== 'function') return next()
    const existing = tools.get(exec.name, exec.agent)
    if (existing !== undefined && !virtualTools.has(existing)) return next()
    const callId = typeof exec.callId === 'string' ? exec.callId : ''
    // A result is enough, but a known CLI call with no result must also stay
    // display-only. Falling through in that case could execute a denied tool.
    if (!toolResults.has(callId) && !cliToolCalls.has(callId)) return next()

    const key = `${registrationScope(exec)}|${exec.name}`
    let registered = false
    try {
      if (existing === undefined) {
        const definition = virtualToolDefinition(exec.name)
        virtualTools.add(definition)
        const disposer = tools.register(definition)
        liveRegistrations.set(key, { disposer, pending: 0 })
        registered = true
      }
      const registration = liveRegistrations.get(key)
      if (registration !== undefined) registration.pending += 1
    } catch {
      // Registration failed before dispatch began; fall through exactly once.
      if (registered) releaseRegistration(key)
      return next()
    }

    // An executor failure is not a setup failure: never dispatch it twice.
    try {
      return await next()
    } finally {
      releaseRegistration(key)
    }
  })
}

/**
 * Retire one virtual registration once no in-flight call needs it.
 *
 * Called after the dispatch settles, whether it succeeded or threw, so a
 * failing card cannot pin a definition into the agent's tool list.
 * @param key - the `${scope}|${name}` key whose registration may now be idle.
 */
function releaseRegistration(key) {
  const registration = liveRegistrations.get(key)
  if (registration === undefined) return
  registration.pending -= 1
  if (registration.pending > 0) return
  liveRegistrations.delete(key)
  try {
    registration.disposer()
  } catch {
    // A registration torn down by scope disposal is already gone.
  }
}

/**
 * Build the display-only executor for one CLI tool name.
 *
 * The definition carries an empty parameter schema because the model never
 * calls it — it exists only to give the recorded call a resolvable body. Its
 * `render` returns the CLI's own output text, which is what the expanded card
 * shows. `execute` deliberately does *not* conclude the turn: the loop must go
 * on to the next step, which is the CLI's next assistant message, so its text
 * lands after the cards instead of before them.
 * @param name - the CLI's tool name, used verbatim.
 * @returns a tool definition that replays a recorded result.
 */
function virtualToolDefinition(name) {
  return {
    name,
    description: `Result of the ${name} call the CodeBuddy CLI already ran for this turn.`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: (_arguments, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    execute: async (_arguments, exec) => {
      const callId = typeof exec?.callId === 'string' ? exec.callId : ''
      const text = toolResults.get(callId) ?? 'CodeBuddy CLI 没有返回该调用的结果；为防止重复执行，DSH 没有再次运行它。'
      toolResults.delete(callId)
      cliToolCalls.delete(callId)
      return { text }
    },
  }
}

/**
 * Record the tool results a CLI `user` frame carries.
 *
 * The CLI reports each result as `{ type: 'tool_result', tool_use_id, content,
 * is_error }` inside a user message. Only the call id and the flattened text
 * matter here: the id pairs the result with the card that reported the call,
 * and the text is what the expanded card shows. Failed calls keep the CLI's own
 * explanation so the card renders its error state honestly.
 * @param frame - the CLI `user` frame.
 */
function recordToolResults(frame) {
  const content = frame?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block?.type !== 'tool_result') continue
    const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
    if (callId === '') continue
    const text = flattenResultContent(block.content)
    toolResults.set(callId, text)
    // Results are consumed in call order, so dropping the oldest keeps the
    // table bounded without ever discarding a result a pending card still needs.
    while (toolResults.size > MAX_RECORDED_RESULTS) {
      const oldest = toolResults.keys().next()
      if (oldest.done === true) break
      toolResults.delete(oldest.value)
    }
  }
}

/**
 * Record terminal `permission_denials` from a CLI result frame.
 *
 * Some CLI versions report a denied tool only here and never emit the normal
 * `user`/`tool_result` frame. Without this path a rejected call had no replay
 * body and could fall through to the real DSH executor.
 * @param frame - the CLI terminal result frame.
 */
function recordPermissionDenials(frame) {
  if (!Array.isArray(frame?.permission_denials)) return
  for (const denial of frame.permission_denials) {
    const callId = typeof denial?.tool_use_id === 'string' ? denial.tool_use_id : ''
    if (callId === '') continue
    const toolName = typeof denial?.tool_name === 'string' && denial.tool_name !== '' ? denial.tool_name : '工具'
    const text = typeof denial?.reason === 'string' && denial.reason.trim() !== ''
      ? denial.reason
      : `CodeBuddy CLI 拒绝了 ${toolName}，DSH 不会再次执行该调用。`
    toolResults.set(callId, text)
    while (toolResults.size > MAX_RECORDED_RESULTS) {
      const oldest = toolResults.keys().next()
      if (oldest.done === true) break
      toolResults.delete(oldest.value)
    }
  }
}

/**
 * Flatten a `tool_result` payload into displayable text.
 *
 * The CLI sends either a plain string or a list of content blocks; both shapes
 * appear in practice, and a result that is neither still has to produce
 * something the card can show.
 * @param content - the result payload.
 * @returns the flattened text, `''` when the payload carries nothing.
 */
function flattenResultContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry === null || typeof entry !== 'object') return ''
      return typeof entry.text === 'string' ? entry.text : ''
    })
    .filter(text => text !== '')
    .join('\n')
}

export {
  MAX_RECORDED_RESULTS,
  SPENT_TURN,
  flattenResultContent,
  installToolCardBridge,
  liveRegistrations,
  recordPermissionDenials,
  recordToolCall,
  recordToolResults,
  releaseRegistration,
  toolResults,
  virtualToolDefinition,
  virtualTools,
}
