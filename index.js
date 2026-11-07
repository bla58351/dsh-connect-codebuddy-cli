/**
 * The `codebuddy` LLM provider route.
 *
 * DSH owns the conversation, the transcript, and every pixel the user sees.
 * This plugin owns exactly one thing: when a turn's selected model belongs to
 * CodeBuddy, the tokens are produced by the locally installed CodeBuddy CLI
 * rather than by an HTTP API. There is no API key here — the CLI already holds
 * the user's login, and this adapter runs it as a subprocess.
 *
 * ## How one turn maps onto one CLI call
 *
 * The CLI keeps its own conversation history on disk, keyed by `--session-id`.
 * So instead of replaying DSH's transcript into the CLI, this adapter derives a
 * stable CodeBuddy session id from DSH's session id and sends only the newest
 * user turn: CodeBuddy resumes its own copy of the history, exactly as the
 * user's CodeBuddy CLI session would. That keeps DSH's transcript and the
 * CLI's transcript from having to agree about anything except the current
 * message.
 *
 * One CLI call still serves one user message, but it is drained in several DSH
 * steps: each CLI assistant message becomes one DSH assistant message, so the
 * tool calls of a message are dispatched — and drawn — before the next message's
 * text. See {@link CodeBuddyTurn}.
 *
 * @module dsh-connect-codebuddy-cli
 */
import { readSettings } from './src/config/store.js'
import { CodeBuddyAdapter, PROVIDER_ID, PROVIDER_NAME } from './src/adapter/adapter.js'
import { installToolCardBridge } from './src/bridge/cards.js'
import { installToolBridge } from './src/bridge/tools.js'
import { installAttachments } from './src/host/attachments.js'
import { installPluginPage } from './src/host/page.js'

/**
 * Cordis plugin name; must match the manifest `name`.
 */
export const name = 'dsh-connect-codebuddy-cli'

/**
 * `llm` is required to register the route. Without it the row stays inactive
 * instead of throwing in a composition that has no model runtime.
 */
export const inject = ['llm']

/**
 * Plugin configuration, declared as a Standard Schema.
 *
 * The Loader validates every row's `config` through this at activation and
 * fills the defaults, and the Plugin Manager reads the same contract. `validate`
 * receives the raw row config and returns either `{ value }` with the
 * normalized config or `{ issues }` to reject it.
 *
 * Everything is optional: the defaults auto-detect the CLI and advertise
 * whatever it says it supports.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-connect-codebuddy-cli',
    /** @param input - the raw row config. */
    validate(input) {
      const raw = input === null || typeof input !== 'object' ? {}
        : input
      if (raw.binary !== undefined && typeof raw.binary !== 'string') {
        return { issues: [{ message: '`binary` must be a string' }] }
      }
      if (raw.models !== undefined && (!Array.isArray(raw.models) || raw.models.some(model => typeof model !== 'string'))) {
        return { issues: [{ message: '`models` must be an array of strings' }] }
      }
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') {
        return { issues: [{ message: '`cwd` must be a string' }] }
      }
      if (raw.maxTurns !== undefined && (typeof raw.maxTurns !== 'number' || !Number.isSafeInteger(raw.maxTurns) || raw.maxTurns < 0)) {
        return { issues: [{ message: '`maxTurns` must be a non-negative integer' }] }
      }
      return {
        value: {
          binary: raw.binary ?? '',
          models: raw.models ?? [],
          cwd: raw.cwd ?? '',
          maxTurns: raw.maxTurns ?? 0,
        },
      }
    },
  },
}

/**
 * Register the adapter.
 * @param ctx - the plugin's Cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = {
    binary: typeof config?.binary === 'string' ? config.binary : '',
    models: Array.isArray(config?.models) ? config.models.filter(id => typeof id === 'string' && id !== '') : [],
    cwd: typeof config?.cwd === 'string' ? config.cwd : '',
    maxTurns: typeof config?.maxTurns === 'number' && Number.isSafeInteger(config.maxTurns) && config.maxTurns > 0 ? config.maxTurns : 0,
  }
  // One shared, mutable copy of the page-edited settings: the adapter reads it
  // on every `listModels`, so a switch on the plugin page takes effect for the
  // next model-picker read without reloading the plugin.
  const settings = readSettings()
  const adapter = new CodeBuddyAdapter(resolved, ctx.logger, ctx, settings)
  // Cards need their display tools registered before the first step's tool set
  // is frozen: DSH only dispatches names that were admitted up front.
  adapter.attachToolCards(installToolCardBridge(ctx, PROVIDER_ID))
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  installPluginPage(ctx, adapter, resolved, settings)
  installToolBridge(ctx, adapter, settings)
  installAttachments(ctx, adapter)
  // Warm the live catalog in the background: the model picker and the page both
  // read multipliers from it, and it costs no model call.
  void adapter.refreshModelCatalog()
  // A parked CLI process must not outlive the host that owns it.
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { void adapter.dispose() }, 'dsh-connect-codebuddy-cli: cli sessions')
  ctx.logger?.info?.(`dsh-connect-codebuddy-cli: registered provider route "${PROVIDER_ID}"`)
}

// The public surface stays here: tests and other bundles import these names from
// the package root, so moving the implementation must not move the API.
export { PROVIDER_ID, PROVIDER_NAME } from './src/adapter/adapter.js'
export { describeReadiness } from './src/host/readiness.js'
export { handoffDigest, handoffMessageText } from './src/conversation/digest.js'
export { conversationSignature, continuesSignature, latestUserText } from './src/conversation/messages.js'
export { usageOf } from './src/adapter/turn.js'
