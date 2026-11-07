/**
 * Render the CLI's own tool calls as native DSH cards without re-running them.
 *
 * DSH draws a card only for a `tool-call` block, and it *dispatches* every such
 * block: the name has to resolve in the tool set that was frozen before the
 * model request, and the resolved definition has to have an `execute`. The CLI
 * has already run the tool, so the card needs a display-only definition that
 * returns the recorded output.
 *
 * That freezing is why the old design failed. It registered a definition from
 * inside the `tools/execute` waterfall, i.e. after admission, so dispatch threw
 * `ToolNotFoundError` ("unknown tool \"Bash\"") before the hook could help.
 * Admission only ever contains registrations that existed when the step's tool
 * set was resolved, so the definitions must be registered *ahead of the request*
 * and gated by `when` to the steps that can dispatch them.
 *
 * Two kinds of name are registered that way:
 *
 * - a fixed fallback, registered with the plugin, for a CLI tool name this
 *   process has never seen before and for any name DSH already owns;
 * - one display definition per CLI tool name, registered the first time that
 *   name appears, so later steps can show the real name on the card.
 *
 * A name is only used as-is when this module registered it *and* the step's tool
 * set advertises it; otherwise the fallback card carries the real name in its
 * arguments. Nothing here ever executes a real tool: a definition only ever
 * replays a recorded result, and a call without one gets an explicit message
 * instead of falling through.
 * @module dsh-connect-codebuddy-cli/bridge/cards
 */

/** The display-only tool name that always resolves, whatever the CLI calls its tool. */
const FALLBACK_TOOL_NAME = 'codebuddy_cli_call'

/**
 * Every name this process registered as a display-only tool.
 *
 * The registry outlives one plugin instance because the registrations do: a
 * reloaded adapter must still be able to tell a card name from a callable tool.
 * It lives in module scope — not on a handle — so the tool catalog and the MCP
 * bridge can ask before advertising one.
 */
const displayToolNames = new Set([FALLBACK_TOOL_NAME])

/**
 * Whether a Host tool name is a display-only card definition.
 *
 * Such a definition exists only so DSH can draw the card for a call the CLI
 * already ran. Advertising it as a callable tool would offer the model a tool
 * that can only replay a result, or report that none was recorded.
 * @param name - a tool name from the Host catalog.
 * @returns true when this module registered the name for card display.
 */
function isDisplayToolName(name) {
  return typeof name === 'string' && displayToolNames.has(name)
}

/**
 * Tool results captured from the CLI, keyed by the CLI's own call id.
 *
 * The CLI runs its own tool loop inside the single process this adapter
 * spawned, so every result is already known by the time the step that reports
 * the call has drained. Recording them here lets the display tool return the
 * CLI's real output instead of re-running anything.
 *
 * Entries are deleted as soon as the card consumes them, so a long-lived host
 * does not accumulate one string per tool call forever.
 */
const toolResults = new Map()

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
 * Build the display-only definition for one wire name.
 *
 * The definition carries an empty parameter schema because the model never
 * calls it — it exists only to give the recorded call a resolvable body. Its
 * `render` returns the CLI's own output text, which is what the expanded card
 * shows. `execute` deliberately does *not* conclude the turn: the loop must go
 * on to the next step, which is the CLI's next assistant message, so its text
 * lands after the cards instead of before them.
 * @param name - the wire name the card is dispatched under.
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
      return { text }
    },
  }
}

/**
 * Serialize a card's arguments for the wire name that will carry them.
 *
 * A card with the real CLI name keeps the CLI's own arguments, only reordered so
 * the identifying key leads the summary. A card on the fallback name would
 * otherwise render as "codebuddy_cli_call · <command>", so the CLI tool name is
 * put first — the generic card summary shows the first string value it finds.
 * @param cliName - the CLI's tool name.
 * @param wireName - the name the card is dispatched under.
 * @param rawJson - the arguments, already reordered, as JSON.
 * @returns the argument text the card reports.
 */
function cardArguments(cliName, wireName, rawJson) {
  if (wireName === cliName) return rawJson
  let parsed
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    parsed = undefined
  }
  const fields = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  return JSON.stringify({ tool: cliName, ...fields })
}

/**
 * Register the display-only tools cards are dispatched through.
 *
 * Registration happens when the `tools` service is available, which is before
 * the first turn of the plugin, and never from inside a dispatch. Every
 * registration is gated by `when` to the steps of this provider, so no other
 * model ever sees these names in its tool list.
 *
 * A composition without a `tools` service gets a handle that never becomes
 * ready, and the turn then reports tool activity as text instead of cards —
 * there is no step loop to dispatch them anyway.
 * @param ctx - the plugin context.
 * @param providerId - the provider route whose steps may dispatch the cards.
 * @returns the handle the turn consults for every reported call.
 */
function installToolCardBridge(ctx, providerId) {
  /**
   * One plugin's card registry.
   *
   * State lives on the handle rather than in module scope because several
   * plugin instances can share one process (tests build one per case), and a
   * definition owned by one must never be treated as owned by another.
   */
  const cards = {
    /** Whether the fallback definition is registered, i.e. cards can dispatch. */
    ready: false,
    /** Wire names this handle registered, and may therefore dispatch itself. */
    owned: new Set(),
    /** The `tools` service, once it exists. */
    service: undefined,
    /** The admission gate: only this provider's steps may dispatch a card. */
    when: context => context?.modelSelection?.provider === providerId,
    /**
     * Register one display definition, once.
     * @param name - the wire name to register.
     * @returns true when the name is registered and owned by this handle.
     */
    ensure(name) {
      if (typeof name !== 'string' || name === '') return false
      if (this.service === undefined) return false
      if (this.owned.has(name)) return true
      try {
        this.service.register(virtualToolDefinition(name), { when: this.when })
        this.owned.add(name)
        displayToolNames.add(name)
        return true
      } catch {
        // A real tool already owns the name (a lowercase `read`, say). It is
        // never shadowed: the card stays on the fallback name instead.
        return false
      }
    },
    /**
     * The name one reported call is dispatched under.
     * @param name - the CLI's tool name.
     * @param admitted - the names this step's tool set advertises.
     * @returns the CLI name when it is owned and admitted, else the fallback.
     */
    wireName(name, admitted) {
      if (this.owned.has(name) && admitted?.has?.(name) === true) return name
      return FALLBACK_TOOL_NAME
    },
  }
  /**
   * Point the handle at one `tools` service and register the fallback.
   *
   * A reloaded service invalidates what the old one owned, so both the owned
   * set and the readiness flag are reset first.
   * @param service - the Host's tool registry.
   */
  const attach = (service) => {
    cards.service = service !== null && typeof service === 'object' ? service : undefined
    cards.owned = new Set()
    cards.ready = false
    if (cards.service === undefined || typeof cards.service.register !== 'function') return
    cards.ready = cards.ensure(FALLBACK_TOOL_NAME)
  }
  // The registry is a core service, so it normally exists by the time a plugin
  // applies; a composition that installs it later is served by `inject`.
  if (typeof ctx?.get === 'function') {
    const direct = ctx.get('tools', false)
    if (direct !== undefined) {
      attach(direct)
      return cards
    }
  }
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools'], inner => attach(typeof inner.get === 'function' ? inner.get('tools') : inner['tools']))
  }
  return cards
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
  FALLBACK_TOOL_NAME,
  MAX_RECORDED_RESULTS,
  SPENT_TURN,
  cardArguments,
  flattenResultContent,
  installToolCardBridge,
  isDisplayToolName,
  recordPermissionDenials,
  recordToolResults,
  toolResults,
  virtualToolDefinition,
}