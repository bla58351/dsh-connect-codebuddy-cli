/**
 * The `codebuddy` model provider route.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/adapter/adapter
 */

import { accountEnv, accountsPath, attachCredits, buildPool, cooldownFor, nextAccountId, pickAccount, rankPool, readAccounts, writeAccounts } from '../account/pool.js'
import { deploymentFor, hasEnvironmentToken, readAccount } from '../account/session.js'
import { describeReadiness } from '../account/readiness.js'
import { toolOrigin } from '../bridge/builtin-tools.js'
import { availableModels, creditsFor, modelInfoFor, parseCreditLabel, providerModelId } from '../cli/catalog.js'
import { CHAT_SYSTEM_PROMPT, codebuddySessionId, codebuddyTranscriptPath, openCli, permissionModeFor, probeAcpModelCatalog, productManifestFor, readAdvertisedModelIds, readProductModels, resolveCliEntry, unavailableMessage, writeMcpConfigFile, writeSystemPromptFile } from '../cli/session.js'
import { MAX_CUSTOM_PROMPT_CHARS, PROMPT_MODES, normalizePromptMode } from '../config/prompt.js'
import { MAX_TRACKED_SESSIONS, flushHistories, hasExposedToolsChoice, normalizeDeclarationPlacement, readHistories, writeHistories } from '../config/store.js'
import { CLI_TOOL_NAMES, agentOf, defaultExposedTools, isCollapsedToolset } from '../bridge/tools.js'
import { CodeBuddyTurn } from './turn.js'
import { SPENT_TURN } from '../bridge/cards.js'
import { continuesSignature, continuesTurn, conversationSignature, latestUserText } from '../conversation/messages.js'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { handoffDigest } from '../conversation/digest.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The provider route this plugin owns; must equal `providerInfo().id`. */
export const PROVIDER_ID = 'codebuddy'

/** Display name the Host shows for this route. */
export const PROVIDER_NAME = 'CodeBuddy'

/** How many user images one turn may forward. */
const MAX_TURN_IMAGES = 4

/** Byte cap for one request-sized image; the store re-encodes to fit. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** How long the live model catalog stays trusted before it is probed again. */
const CATALOG_TTL_MS = 10 * 60 * 1000

/** How many session ids each one-shot seed set may remember before the oldest is dropped. */
const MAX_SEEDED_SESSIONS = 512

/**
 * A Set that forgets its oldest member past a bound.
 *
 * The seeded markers exist to stop a warm process being re-seeded with the same
 * digest or declaration; they have no meaning for a session whose process is
 * long gone, so a long-lived host can drop the oldest ids without changing
 * behaviour. An unbounded Set once grew one entry per conversation forever.
 * @param limit - how many ids to remember.
 * @returns the bounded set.
 */
function boundedSeedSet(limit) {
  const set = new Set()
  const add = (value) => {
    if (set.has(value)) return
    set.add(value)
    if (set.size > limit) {
      const oldest = set.values().next()
      if (oldest.done !== true) set.delete(oldest.value)
    }
  }
  return { has: value => set.has(value), add, delete: value => set.delete(value), get size() { return set.size } }
}

/** CodeBuddy session ids this adapter has already seeded with a handoff digest. */
const handoffSeeded = boundedSeedSet(MAX_SEEDED_SESSIONS)

/** A CLI session id alone is not unique across isolated account homes. */
function accountSeedKey(sessionId, account) {
  return `${typeof account?.home === 'string' ? account.home : ''}\n${sessionId}`
}

/**
 * Translate the CLI's frames into DSH stream chunks.
 *
 * Three structural facts drive the design:
 *
 * - Reasoning and answer text arrive on **different** CLI content-block
 *   indices, and the CLI reuses those indices across every assistant message
 *   inside one turn. DSH identifies a block by index too, so every CLI index is
 *   remapped onto a fresh DSH index, and the map is cleared at each
 *   `message_start` — otherwise the second message's block 0 would be written
 *   into the first message's block 0 and the two would merge.
 * - The CLI runs its **own** tool loop: it calls a tool, receives the result,
 *   and continues, all inside the single process this adapter spawned. Tool
 *   calls are still reported as real `tool-call` blocks so DSH draws its native
 *   cards, but each is paired with a display-only executor registered for that
 *   agent (see {@link installToolCardBridge}) which replays the CLI's recorded
 *   output instead of running the tool a second time.
 * - That executor does *not* conclude the turn. DSH runs another step after a
 *   message's tool calls, and that step is where the CLI's next assistant
 *   message lands — which is what puts a message's cards before the next
 *   message's text instead of after all of it.
 */
class CodeBuddyAdapter {
  /** Resolved plugin configuration. */
  #config

  /** Cached resolution of the CLI entry, so the picker does not respawn help. */
  #cli

  /** Cached product manifest, keyed by package root. */
  #manifest

  /** Cached deployment resolution, keyed by package root. */
  #deployment

  /**
   * The live model catalog the CLI's own `/model` menu renders.
   *
   * Preferred over any bundled manifest for multipliers: it is what the account
   * is actually billed by, and it differs from every file the package ships.
   */
  #catalog = new Map()

  /** Probes in flight, keyed by account home so concurrent readers share one process per account. */
  #catalogPromise = new Map()

  /** The MCP bridge serving DSH tools to the CLI, once it is running. */
  #bridge

  /** Absolute path of the stdio shim the bridge's config points at. */
  #shimPath = ''

  /** The `tools`/`agents` services the bridge executes through. */
  #toolServices

  /** The Host's attachment service, used to read a user's images as bytes. */
  #attachments

  /** Set once a resolution failure has been reported. */
  #warned = false

  /**
   * Live CLI turns, keyed by DSH session id.
   *
   * A turn outlives one `stream()` call because DSH consumes it one assistant
   * message per step. A new human message in the same session replaces the
   * entry, which closes the abandoned child.
   */
  #turns = new Map()

  /**
   * Finished sessions kept warm for the keep-alive delay, keyed by DSH session.
   *
   * A parked process is bound to one conversation's CodeBuddy session id, so it
   * can only serve that conversation — which is exactly the common case: the
   * next message in the same chat.
   */
  #parked = new Map()

  /** Every live CLI session this adapter owns, parked or running. */
  #sessions = new Set()

  /** The DSH session this process served most recently. */
  #lastKey = ''

  /** The CLI model this process last served, used to warm the right backend. */
  #lastModel = ''

  /**
   * Per-account cooldowns after a failure, keyed by account id.
   *
   * In memory only: the windows are minutes, and a restarted bridge refusing an
   * account that has long recovered would be worse than re-trying it.
   */
  #cooldowns = new Map()

  /** The account each conversation's current turn runs on, keyed by DSH session id. */
  #sessionAccount = new Map()

  /** The account the most recent turn ran on — what the page shows as 当前使用. */
  #currentAccountId = ''

  /** Set once this adapter has probed the pool for the page. */
  #poolProbed = false

  /**
   * The conversation fingerprint each session had when its last turn started,
   * keyed by DSH session id.
   *
   * Kept per adapter rather than per process: a session edited in another window
   * is still this adapter's session, and comparing against what *it* last sent
   * is what reveals that the CLI's transcript no longer matches DSH's history.
   */
  #histories = new Map()

  /** Whether {@link #histories} was loaded from disk yet. */
  #historiesLoaded = false

  /** Optional logger captured from the plugin context. */
  #logger

  /** The plugin context, used to read the session's working directory. */
  #ctx

  /**
   * Settings the plugin page edits.
   *
   * Shared by reference with the page's RPC handler, so a switch takes effect
   * on the next `listModels` without rebuilding the adapter.
   */
  #settings

  /**
   * @param config - resolved plugin configuration.
   * @param logger - optional logger from the plugin context.
   * @param ctx - optional plugin context, for optional service lookups.
   * @param settings - the live settings state, when the page can edit it.
   */
  constructor(config, logger, ctx, settings = { hiddenModels: [] }) {
    this.#config = config
    this.#logger = logger
    this.#ctx = ctx
    this.#settings = settings
  }

  /**
   * Tell the Host that this provider's model list changed.
   *
   * The browser keeps one catalog built from `llm.listModels` and reloads it only
   * on `llm/adapters-updated`. That is the event the LLM service publishes when
   * adapters change; the provider's own list has no such trigger because the
   * service cannot know a plugin reads its models from a private file.
   *
   * Best-effort: an older llm service without the method simply means the picker
   * refreshes on the next natural reload.
   */
  announceModels() {
    try {
      this.#ctx?.llm?.emitAdaptersUpdated?.()
    } catch {
      // A failed announcement must not fail a save that already persisted.
    }
  }

  /**
   * Take the tool bridge the Host started for this adapter.
   * @param bridge - the loopback bridge.
   * @param shimPath - absolute path of the stdio shim it points the CLI at.
   */
  attachToolBridge(bridge, shimPath) {
    this.#bridge = bridge
    this.#shimPath = shimPath
  }

  /**
   * Take the `tools`/`agents` services the bridge executes through.
   * @param services - `{ tools, agents }`.
   */
  attachToolServices(services) {
    this.#toolServices = services
  }

  /**
   * Build the inline MCP config for one CLI process.
   *
   * Empty when no tool is enabled or the bridge has not come up: the CLI then
   * runs exactly as before, with no MCP server attached.
   * @param sessionId - the DSH session this turn belongs to.
   * @param fileKey - the owning CLI process's unique scratch key.
   * @returns the `--mcp-config` value, or `''`.
   */
  mcpConfigFor(sessionId, fileKey = sessionId) {
    if (this.#bridge === undefined || this.#shimPath === '') return ''
    if (this.#effectiveExposedTools().length === 0) return ''
    if (this.#bridge.ready !== true) return ''
    // The config carries the bridge's bearer token, so it is written to a
    // per-session file instead of riding in argv: a command line is readable
    // by every process on the machine and lands in crash reports, a file in
    // the user's temp directory is not. The CLI accepts a file path for
    // `--mcp-config` when the value does not parse as JSON.
    const config = this.#bridge.configFor(sessionId, this.#shimPath)
    return writeMcpConfigFile(fileKey, config)
  }

  /**
   * Describe the tools that can be bridged, for the settings page.
   * @returns `{ available, exposed, sessionId, bridge }`.
   */
  toolCatalog() {
    const exposed = this.#effectiveExposedTools()
    const base = { exposed, available: [], sessionId: '', bridge: this.#bridge?.ready === true }
    const services = this.#toolServices
    if (services === undefined || services.tools === undefined) return base
    const key = this.#lastKey !== '' ? this.#lastKey : latestSessionId()
    const agent = agentOf(services, key)
    if (agent === undefined) return { ...base, sessionId: key, note: 'no-session' }
    let schemas
    try {
      schemas = services.tools.schemas(agent)
    } catch {
      return { ...base, sessionId: key, note: 'unavailable' }
    }
    const enabled = new Set(exposed)
    return {
      ...base,
      sessionId: key,
      available: schemas
        .filter(schema => schema.name !== 'run_code')
        .map(schema => ({
          name: schema.name,
          description: typeof schema.description === 'string' ? schema.description : '',
          enabled: enabled.has(schema.name),
          overlap: CLI_TOOL_NAMES.has(String(schema.name).toLowerCase()),
          origin: toolOrigin(schema.name),
        })),
    }
  }

  /**
   * The tool list that governs this turn: the stored choice when the settings
   * file carries one, otherwise the live default — everything the Host
   * registers except what the CLI already provides itself.
   * @returns the effective exposed tool names.
   */
  #effectiveExposedTools() {
    const stored = Array.isArray(this.#settings.exposedTools) ? this.#settings.exposedTools : []
    if (hasExposedToolsChoice()) return stored
    const services = this.#toolServices
    if (services === undefined || services.tools === undefined) return stored
    const agent = agentOf(services, this.#lastKey !== '' ? this.#lastKey : latestSessionId())
    if (agent === undefined) return stored
    try {
      return defaultExposedTools(services.tools.schemas(agent))
    } catch {
      return stored
    }
  }

  /**
   * Read the user's images for this turn as base64 payloads.
   *
   * DSH hands an image-capable adapter `{type:'image', attachment}` blocks and
   * leaves the bytes to the attachment service, so the adapter has to fetch a
   * request-sized variant itself. A text-only model never sees these blocks —
   * the Host has already replaced them with deterministic placeholder text —
   * which is why no modality check belongs here.
   * @param messages - the step's projected messages.
   * @param signal - cancellation for this turn.
   * @returns `[{ mediaType, data }]`, at most {@link MAX_TURN_IMAGES}.
   */
  async #imagesFor(messages, signal) {
    if (this.#attachments === undefined || !Array.isArray(messages)) return []
    const human = [...messages].reverse().find(message => message?.source?.kind === 'user')
    const blocks = Array.isArray(human?.content) ? human.content : []
    const refs = blocks
      .filter(block => block?.type === 'image' && block.attachment !== undefined)
      .map(block => block.attachment)
      .slice(0, MAX_TURN_IMAGES)
    if (refs.length === 0) return []
    const images = []
    for (const ref of refs) {
      const width = Number(ref?.width)
      const height = Number(ref?.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        this.#warnOnce('a user image carried no usable dimensions, so it was not forwarded to the CLI')
        continue
      }
      try {
        const version = await this.#attachments.readImageRequest(ref, { width, height, maxBytes: MAX_IMAGE_BYTES }, signal)
        if (typeof version?.data === 'string' && version.data !== '') {
          images.push({ mediaType: typeof version.mediaType === 'string' ? version.mediaType : 'image/png', data: version.data })
        }
      } catch (error) {
        // One unreadable image must not fail the whole turn; the text still goes.
        this.#warnOnce(`a user image could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return images
  }

  /**
   * Take the Host's attachment service, used to read user images.
   * @param attachments - the service.
   */
  attachAttachments(attachments) {
    this.#attachments = attachments
  }

/**
   * Choose the system prompt for one CLI process.
   *
   * Three modes, three sources: the Host's own system-prompt message (so
   * switching to a CodeBuddy model keeps the rules the rest of the conversation
   * follows), the CLI's built-in coding-agent prompt (no override at all), or the
   * text this page stores. DSH's message is used verbatim; when a composition
   * sends none, the bridge's chat brief fills in rather than leaving the CLI with
   * no guidance.
   * @param options - DSH generate options for this step.
   * @returns the prompt text, or `''` for "no override".
   */
  #systemPromptText(options) {
    const mode = normalizePromptMode(this.#settings.promptMode)
    if (mode === 'codebuddy') return ''
    const declaration = this.#declarationPlacement() === 'first-user' ? '' : this.#toolDeclaration()
    if (mode === 'custom') {
      const text = this.#settings.customPrompt
      const base = typeof text === 'string' && text.trim() !== '' ? text : CHAT_SYSTEM_PROMPT
      return declaration === '' ? base : `${base}\n${declaration}`
    }
    const host = Array.isArray(options?.messages)
      ? options.messages.find(message => message?.source?.kind === 'system-prompt')
      : undefined
    const blocks = Array.isArray(host?.content) ? host.content : []
    const text = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    const base = text === '' ? CHAT_SYSTEM_PROMPT : text
    return declaration === '' ? base : `${base}\n${declaration}`
  }

  /**
   * Describe the prompt choice for the settings page.
   * @returns `{ mode, custom, defaultPrompt, modes, maxChars }`.
   */
  promptState() {
    return {
      mode: normalizePromptMode(this.#settings.promptMode),
      custom: this.#settings.customPrompt,
      defaultPrompt: CHAT_SYSTEM_PROMPT,
      modes: [...PROMPT_MODES],
      maxChars: MAX_CUSTOM_PROMPT_CHARS,
      declareTools: this.#settings.declareTools !== false,
      declarationPlacement: normalizeDeclarationPlacement(this.#settings.declarationPlacement),
      declaredTools: this.#declaredToolLines(),
    }
  }

  /**
   * One line per bridged tool, for the prompt declaration block.
   *
   * The description is DSH's own schema text, cut to one sentence: the point is
   * that the model knows the tool exists and when to reach for it, not a second
   * copy of the full parameter documentation (the MCP `tools/list` already
   * carries that).
   * @returns `['name — first sentence', …]`, empty when nothing is bridged.
   */
  #declaredToolLines() {
    const exposed = this.#effectiveExposedTools()
    if (exposed.length === 0) return []
    const services = this.#toolServices
    if (services === undefined || services.tools === undefined) return []
    const agent = agentOf(services, this.#lastKey !== '' ? this.#lastKey : latestSessionId())
    if (agent === undefined) return []
    let schemas
    try {
      schemas = services.tools.schemas(agent)
    } catch {
      return []
    }
    const byName = new Map(schemas.map(schema => [schema.name, schema]))
    const lines = []
    for (const name of exposed) {
      const schema = byName.get(name)
      if (schema === undefined) continue
      const description = typeof schema.description === 'string' ? schema.description : ''
      const sentence = description.split(/(?<=[.!?。！？])\s/u)[0]?.trim() ?? ''
      // Spell out the full MCP name: the declaration exists so the model can
      // call the tool without a discovery step, so it should not have to
      // assemble the `mcp__dsh__` prefix itself.
      const mcpName = `mcp__dsh__${name}`
      lines.push(sentence === '' ? mcpName : `${mcpName} — ${sentence}`)
    }
    return lines
  }

  /**
   * The declaration appended to the prompt when `declareTools` is on.
   *
   * Kept in English to match the prompts around it, and deliberately short:
   * it names the tools and their calling convention, because the CLI exposes
   * them behind a ToolSearch step the model does not always take on its own.
   * @returns the block, or `''`.
   */
  #declarationPlacement() {
    return normalizeDeclarationPlacement(this.#settings.declarationPlacement)
  }

  #toolDeclaration() {
    if (this.#settings.declareTools === false) return ''
    const lines = this.#declaredToolLines()
    if (lines.length === 0) return ''
    return [
      '',
      'Additional tools from the host application are available to you. They are exposed through',
      'MCP under the "dsh" server; their names start with "mcp__dsh__". When you need any of the',
      'capabilities below, call these tools directly (via ToolSearch/DeferExecuteTool) rather than',
      'approximating the result another way:',
      ...lines.map(line => `- ${line}`),
    ].join('\n')
  }

  /**
   * Expose the resolved CLI for the plugin page.
   *
   * The page reports whether the CLI was found and where, which is the first
   * thing to check when a CodeBuddy model will not answer.
   * @returns the resolved CLI (`{ ok, entry, packageRoot, reason }`).
   */
  describeCli() {
    return this.#resolveCli()
  }

  /** Provider display metadata; `id` must equal the registered route. */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * The home directory of the account currently serving, for the overview page.
   *
   * The page used to read the host's own login unconditionally; a conversation
   * bound to a pool account was then described by the wrong login. `''` is the
   * host's own (or no) binding.
   * @returns the serving account's home, or `''`.
   */
  currentAccountHome() {
    return this.#sessionAccount.get(this.#lastKey)?.home ?? ''
  }

  /** Use the runtime's default retry policy; CLI failures are not rate limits. */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * Advertise the models the GUI may offer.
   *
   * Membership comes from the CLI's own `--model` help text, because the
   * product manifest also lists models this account cannot call. A CLI that
   * cannot be found advertises nothing, which is how the picker ends up
   * without a group instead of with unusable entries.
   * @param _provider - the owned route.
   * @returns advertised model metadata.
   */
  async listModels(_provider) {
    const cli = this.#resolveCli()
    if (!cli.ok) {
      this.#warnOnce(cli.reason)
      return []
    }
    const ids = readAdvertisedModelIds(cli.entry)
    if (ids.length === 0) return []
    const manifest = this.#productModels(cli.packageRoot, this.currentAccountHome())
    const allowed = this.#config.models
    const filtered = allowed.length === 0 ? ids : ids.filter(id => allowed.includes(id))
    // Models switched off on the plugin page stay resolvable by id, so an
    // existing conversation keeps working; they only leave the picker.
    const hidden = this.#settings.hiddenModels
    const visible = hidden.length === 0 ? filtered : filtered.filter(id => !hidden.includes(id))
    return availableModels(visible, manifest, PROVIDER_ID).map(info => this.#decorate(info, manifest))
  }

  /**
   * Relabel one model with the live catalog's multiplier, when it has one.
   *
   * The Host's catalog projection keeps only id/name/description/reasoning, so a
   * multiplier can only reach the selector through the name — which is also why
   * the manifest path works that way.
   * @param info - the model info built from the manifest.
   * @param manifest - the deployment's manifest, used as the fallback source.
   * @returns the model info to advertise.
   */
  #decorate(info, manifest, home = this.currentAccountHome()) {
    const credit = this.creditFor(info.id, manifest, home)
    if (credit === undefined) return info
    const base = info.name.replace(/\s*·\s*×\d+(?:\.\d+)?$/u, '')
    return { ...info, name: `${base} · ${credit.label}`, credits: { ratio: credit.ratio, label: credit.label } }
  }

  /**
   * Resolve one model's multiplier, preferring the live catalog.
   * @param id - the CLI model id.
   * @param manifest - the deployment's manifest.
   * @returns `{ ratio, label, source }`, or `undefined` when neither knows it.
   */
  creditFor(id, manifest, home = this.currentAccountHome()) {
    const key = typeof home === 'string' ? home : ''
    const probed = this.#catalog.get(key)?.models?.get(id)
    const live = parseCreditLabel(probed?.credits)
    if (live !== undefined) return { ...live, source: 'catalog' }
    const fallback = creditsFor(manifest?.get(id))
    return fallback === undefined ? undefined : { ...fallback, source: 'manifest' }
  }

  /**
   * Start one account's catalog probe unless it is running or fresh.
   * @param home - the serving account's home, or `''` for the host login.
   * @returns the probe result, or `undefined` when it could not be read.
   */
  refreshModelCatalog(home = this.currentAccountHome()) {
    // Test seam: the probe spawns a CLI, which the offline step tests count.
    if (process.env.DSH_CODEBUDDY_NO_CATALOG_PROBE === '1') return Promise.resolve(undefined)
    const key = typeof home === 'string' ? home : ''
    if (this.#catalogPromise.has(key)) return this.#catalogPromise.get(key)
    const cached = this.#catalog.get(key)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return Promise.resolve(cached)
    const cli = this.#resolveCli()
    if (!cli.ok) return Promise.resolve(undefined)
    const env = accountEnv(key)
    const run = probeAcpModelCatalog(cli.entry, this.#turnCwd(''), {
      timeoutMs: 20_000,
      ...Object.keys(env).length > 0 ? { env } : {},
    })
      .then((result) => {
        if (result.ok === true) this.#catalog.set(key, { at: Date.now(), models: result.models })
        return this.#catalog.get(key)
      })
      .catch(() => this.#catalog.get(key))
      .finally(() => { this.#catalogPromise.delete(key) })
    this.#catalogPromise.set(key, run)
    return run
  }

  /**
   * Make a best-effort attempt to have a live catalog before answering.
   * @param budgetMs - how long a caller is willing to wait.
   * @param home - the serving account's home.
   * @returns the catalog when it arrived in time, otherwise `undefined`.
   */
  async ensureModelCatalog(budgetMs, home = this.currentAccountHome()) {
    const key = typeof home === 'string' ? home : ''
    const cached = this.#catalog.get(key)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached
    const probe = this.refreshModelCatalog(key)
    return Promise.race([
      probe,
      new Promise(resolve => setTimeout(resolve, budgetMs)).then(() => undefined),
    ])
  }

  /**
   * Describe where one account's displayed multipliers came from.
   * @param home - the serving account's home.
   * @returns `{ source, at, models }`.
   */
  catalogStatus(home = this.currentAccountHome()) {
    const key = typeof home === 'string' ? home : ''
    const catalog = this.#catalog.get(key)
    const at = catalog?.at ?? 0
    return {
      source: at === 0 ? 'manifest' : 'catalog',
      at,
      models: catalog?.models?.size ?? 0,
    }
  }

  /**
   * Describe one exact model.
   *
   * Unlike `listModels` this answers even for an unadvertised id, because
   * DSH routing accepts unlisted ids and only the picker needs membership.
   * @param provider - the owned route.
   * @param model - exact model id as passed to the CLI.
   * @returns resolved model metadata.
   */
  async resolveModel(provider, model, _signal) {
    const cli = this.#resolveCli()
    const home = this.currentAccountHome()
    const manifest = cli.ok ? this.#productModels(cli.packageRoot, home) : new Map()
    return this.#decorate(modelInfoFor(provider, model, manifest), manifest, home)
  }

  /**
   * Prepare one call: resolve the model and the CLI, then hand back a stream
   * entry point bound to them.
   * @param provider - the owned route.
   * @param model - exact model id.
   * @param signal - cancellation for this preparation.
   * @returns the resolved model plus a stream factory.
   */
  async prepareCall(provider, model, signal) {
    signal?.throwIfAborted()
    const cli = this.#resolveCli()
    if (!cli.ok) throw new Error(unavailableMessage(cli.reason))
    // The pool, not just the host login, decides whether any account can serve.
    // The final account is checked again in #turnFor once a conversation binding
    // is known. An explicit environment token needs no session file.
    if (!hasEnvironmentToken() && pickAccount(cli.packageRoot, this.#cooldowns) === undefined) {
      const account = readAccount(cli.packageRoot)
      const readiness = describeReadiness({ installed: true }, account)
      throw new Error(`${readiness.title}：${readiness.steps.map(step => step.command === '' ? step.label : `${step.label} → ${step.command}`).join('；')}`)
    }
    const home = this.currentAccountHome()
    const manifest = this.#productModels(cli.packageRoot, home)
    return {
      model: this.#decorate(modelInfoFor(provider, model, manifest), manifest, home),
      stream: options => this.#stream(options, cli),
    }
  }

  /**
   * Produce one step's chunks.
   *
   * One step is one *CLI assistant message*, not one whole CLI turn. DSH draws
   * one row per assistant message and dispatches that message's tool calls only
   * after it settles, so a whole turn packed into one message put every card
   * after the entire reply and left the turn without a text-only final step —
   * which is what made the transcript fold the answer into its collapsed
   * "process" group. {@link CodeBuddyTurn} owns the frames and hands them back
   * one message at a time.
   * @param options - DSH generate options for this step.
   * @param cli - the resolved CLI.
   * @yields DSH stream chunks.
   */
  async *#stream(options, cli) {
    if (process.env['DSH_CODEBUDDY_DEBUG_MESSAGES'] === '1') {
      // Diagnostic hook: shows exactly what DSH hands the adapter, which is
      // the only way to see how injected reminders are shaped.
      const shape = (Array.isArray(options.messages) ? options.messages : []).map((message, index) => ({
        index,
        role: message?.role,
        source: message?.source?.kind,
        blocks: (message?.content ?? []).map(block => block?.type),
        preview: (message?.content ?? [])
          .filter(block => block?.type === 'text')
          .map(block => String(block.text).slice(0, 120))
          .join(' / '),
      }))
      process.stderr.write(`[codebuddy] messages=${JSON.stringify(shape)}\n`)
    }
    const prompt = latestUserText(options.messages)
    if (prompt === '') {
      // A turn with no user text has nothing for the CLI to answer. Emitting an
      // empty finish is honest: DSH records an empty assistant turn.
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    /**
     * Whether this step can render tool cards.
     *
     * In `ptc` mode DSH collapses every tool but `run_code`, and the request
     * advertises exactly one schema. Such a call cannot be dispatched — it is
     * resolved before `tools/execute` runs and rejected as an error result,
     * which never carries a usable result. So the mode is read from the
     * advertised schema list (`assembly.tools`, surfaced on the request) and
     * the turn falls back to reporting tool activity as text, all of it in one
     * step.
     */
    const turn = await this.#turnFor(options, prompt, cli)
    try {
      // A side request never gets dispatchable cards: there is no step loop
      // behind it to serve the follow-up a tool call would require, so a
      // reported call left its turn waiting for a next step that never came —
      // the turn never retired and the session leaked. Tool activity is
      // reported as reasoning text instead, which is all a session title needs.
      const cards = typeof options.purpose === 'string' && options.purpose !== ''
        ? false
        : !isCollapsedToolset(options.tools)
      yield* turn.step({ cardsUsable: cards })
    } catch (error) {
      // Only an account-class rejection before *any* output or tool activity is
      // safe to answer elsewhere. Unknown failures and cancellation never replay
      // the user's request; a retry after a tool call could run it twice.
      const outcome = this.#noteAccountOutcome(turn.accountId, error)
      const accountFailure = outcome === 'rate-limited' || outcome === 'exhausted'
      if (accountFailure && turn.replaySafe !== false && options.signal?.aborted !== true && this.#hasAlternativeAccount(cli, turn.accountId)) {
        this.#logger?.info?.(`dsh-connect-codebuddy-cli: account ${turn.accountId} ${outcome}; switching accounts and retrying the turn`)
        this.#dropConversationProcesses(options.sessionId)
        const retry = await this.#turnFor(options, prompt, cli)
        yield* retry.step({ cardsUsable: typeof options.purpose === 'string' && options.purpose !== '' ? false : !isCollapsedToolset(options.tools) })
        return
      }
      throw error
    }
  }

  /**
   * Whether the pool has another usable account besides the failed one.
   * @param cli - the resolved CLI.
   * @param failedId - the account that just failed.
   * @returns true when switching is worth attempting.
   */
  #hasAlternativeAccount(cli, failedId) {
    const members = rankPool(buildPool(cli.packageRoot, this.#cooldowns))
    return members.some(member => member.excludedBy === undefined && member.account.id !== failedId)
  }

  /**
   * Stop every process a conversation owns and forget its account binding, so
   * the next turn is built fresh on whichever account the pool selects.
   * @param key - the DSH session id.
   */
  #dropConversationProcesses(key) {
    const running = this.#turns.get(key)
    if (running !== undefined) {
      this.#turns.delete(key)
      void running.close()
    }
    const parked = this.#parked.get(key)
    if (parked !== undefined) {
      clearTimeout(parked.timer)
      this.#parked.delete(key)
      void parked.session.close()
    }
    this.#sessionAccount.delete(key)
  }

  /**
   * The CLI turn serving this step.
   *
   * A step that follows a tool result belongs to the turn already running for
   * this session: the human text is the same and DSH has appended the calls'
   * results after it. Anything else starts a new turn, which replaces — and
   * so kills — whatever the session still had running. The manifest is resolved
   * per account here, because the pool picks the account and its login site
   * decides the deployment.
   * @param options - DSH generate options for this step.
   * @param prompt - the human text this step answers.
   * @param cli - the resolved CLI.
   * @returns the turn to consume.
   */
  /**
   * Record this step's conversation fingerprint and say whether it is a rewrite.
   *
   * A new user message only ever appends to what the model already saw, so the
   * previous fingerprint has to be a prefix of the current one. When it is not —
   * shorter, or diverging part-way — DSH rolled the conversation back (the
   * rewind plugin appends a marker with a `replace` surface op) or forked it, and
   * the CLI's own transcript now describes a conversation that no longer exists.
   * @param key - the DSH session id.
   * @param messages - this step's projected messages.
   * @returns true when the conversation was rewritten rather than extended.
   */
  #syncHistory(key, messages) {
    if (!this.#historiesLoaded) {
      this.#histories = readHistories()
      this.#historiesLoaded = true
    }
    const current = conversationSignature(messages)
    const previous = this.#histories.get(key)
    // Re-insert so the persisted order stays "least recently used first": the
    // store trims from the front when it runs out of room. The in-memory map
    // trims the same way — it used to grow one entry per conversation for the
    // life of the process.
    if (previous !== undefined) this.#histories.delete(key)
    this.#histories.set(key, current)
    while (this.#histories.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.#histories.keys().next()
      if (oldest.done === true) break
      this.#histories.delete(oldest.value)
    }
    writeHistories(this.#histories)
    if (previous === undefined) return false
    // A continuation step projects the same history, which is a prefix of
    // itself; only a new turn can grow it.
    return !continuesSignature(previous, current)
  }

  /**
   * Resolve a transcript inside the serving account's own CLI home.
   * @param key - the DSH session id.
   * @param sessionId - the derived CodeBuddy session id.
   * @param account - the account whose config dir owns the transcript.
   * @returns the transcript path.
   */
  #transcriptPath(key, sessionId, account = this.#sessionAccount.get(key)) {
    const env = accountEnv(account?.home ?? '')
    return codebuddyTranscriptPath(this.#turnCwd(key), sessionId, env.CODEBUDDY_CONFIG_DIR ?? '')
  }

  /**
   * Make the CLI forget a conversation it should no longer remember.
   *
   * The transcript is a plain file under the CLI's own home, named by the
   * session id this bridge derived — never one of the user's own CodeBuddy
   * sessions — so removing it only discards the bridge's copy. Both a running
   * turn and a warm parked process must stop first: a live CLI could rewrite the
   * file on its way out, and a parked one holds the stale history in memory.
   * Seeding is cleared too, so the rebuild that follows is allowed to happen.
   * @param key - the DSH session id.
   */
  async #forgetTranscript(key) {
    const account = this.#sessionAccount.get(key)
    const running = this.#turns.get(key)
    if (running !== undefined) {
      this.#turns.delete(key)
      try { await running.close() } catch { /* already gone */ }
    }
    const parked = this.#parked.get(key)
    if (parked !== undefined) {
      clearTimeout(parked.timer)
      this.#parked.delete(key)
      try { await parked.session.close() } catch { /* already gone */ }
    }
    const sessionId = codebuddySessionId(key)
    const path = this.#transcriptPath(key, sessionId, account)
    if (path !== '') {
      try {
        unlinkSync(path)
      } catch (error) {
        // A file that was never written is the normal case; anything else means
        // the CLI will resume the very turns the user just removed, so it must
        // not pass silently.
        if (error?.code !== 'ENOENT') {
          this.#logger?.warn?.(`dsh-connect-codebuddy-cli: could not delete the CLI transcript for a rolled-back conversation (${path}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    handoffSeeded.delete(accountSeedKey(sessionId, account))
    this.#sessionAccount.delete(key)
  }

  /**
   * Choose the account that serves a new turn.
   *
   * The pool is the default login plus every enabled profile; the ranking is
   * usable-first, then most credits. A conversation keeps the account its
   * previous turn used while that account stays usable — switching accounts
   * mid-conversation is exactly what a retry after a failure needs, not what a
   * follow-up message needs (it would lose the warm process and the CLI-side
   * transcript).
   * @param cli - the resolved CLI.
   * @param key - the DSH conversation whose existing binding takes precedence.
   * @returns the chosen member, or `undefined` when no account is usable.
   */
  #pickTurnAccount(cli, key = '') {
    const bound = this.#sessionAccount.get(key)
    if (bound !== undefined) {
      const usable = buildPool(cli.packageRoot, this.#cooldowns).find(member =>
        member.account.id === bound.id && member.account.home === bound.home && member.excludedBy === undefined)
      if (usable !== undefined) return usable
    }
    return pickAccount(cli.packageRoot, this.#cooldowns)
  }

  /**
   * Fail before spawning when no account can authenticate this turn.
   * @param cli - the resolved CLI.
   * @param account - the member selected for this turn.
   */
  #assertTurnAccount(cli, account) {
    if (hasEnvironmentToken() || account !== undefined) return
    const status = readAccount(cli.packageRoot)
    const readiness = describeReadiness({ installed: true }, status)
    throw new Error(`${readiness.title}：${readiness.steps.map(step => step.command === '' ? step.label : `${step.label} → ${step.command}`).join('；')}`)
  }

  /**
   * Record how an account's turn ended.
   *
   * The classifier reads the CLI's own failure text: a 429-style rejection and a
   * credits-exhausted message are the two outcomes worth switching accounts for,
   * and everything else is a transport-class blip with a short clock.
   * @param accountId - the account the turn ran on.
   * @param error - the failure the turn threw.
   * @returns the outcome name, or `''` when the failure is not an account one.
   */
  #noteAccountOutcome(accountId, error) {
    if (typeof accountId !== 'string' || accountId === '' || accountId === 'default') {
      // The default login has no sibling to switch to only in the sense that a
      // rollback lands here anyway; cooldown it like any other member so the
      // pool prefers a profile until it recovers.
      if (accountId !== 'default') return ''
    }
    const text = `${error?.message ?? error}`
    const outcome = classifyAccountFailure(text)
    const cooldown = cooldownFor(outcome)
    this.#cooldowns.set(accountId, cooldown)
    return outcome
  }

  /**
   * The account pool for the settings page.
   *
   * Probing every profile's login state is cheap (file reads); credits are the
   * only network cost, and {@link attachCredits} throttles those.
   * @param packageRoot - the CLI's package root.
   * @param options - `{ freshCredits, now, timeoutMs }` to bypass caches and bound the overall read.
   * @returns the ranked pool plus what the page needs to add an account.
   */
  async poolStatus(packageRoot, options = {}) {
    const pool = buildPool(packageRoot, this.#cooldowns)
    await attachCredits(packageRoot, pool, {
      now: options.now ?? Date.now(),
      fresh: options.freshCredits === true,
      timeoutMs: options.timeoutMs,
    })
    this.#poolProbed = true
    const ranked = rankPool(pool).map(member => ({
      id: member.account.id,
      label: member.account.label !== '' ? member.account.label : (member.nickname !== '' ? member.nickname : member.account.id),
      home: member.account.home,
      enabled: member.account.enabled !== true ? false : true,
      isDefault: member.account.id === 'default',
      current: member.account.id === this.#currentAccountId,
      signedIn: member.signedIn,
      nickname: member.nickname,
      domain: member.domain,
      deployment: member.deployment,
      credits: member.credits ?? undefined,
      excludedBy: member.excludedBy ?? '',
      retryAtMs: member.retryAtMs,
      reason: member.excludedBy === undefined ? '' : member.excludedBy,
    }))
    return {
      accounts: ranked,
      current: ranked.find(row => row.current === true) ?? undefined,
      cooldowns: [...this.#cooldowns.entries()].map(([id, value]) => ({ id, ...value })),
    }
  }

  /**
   * Save the currently serving account as a pool row.
   *
   * The user's own CLI login is a perfectly good pool member; registering it
   * gives it a name and lets the enabled/disabled switch apply to it too. The
   * default row stays in the registry as well — it is the same login, and the
   * two entries share one home (`''`), so no data is copied anywhere.
   * @param label - what to call the saved row.
   * @returns the refreshed pool.
   */
  saveCurrentAccount(label) {
    const { accounts } = readAccounts()
    const cli = this.#resolveCli()
    const home = ''
    const existing = accounts.find(row => row.home === home)
    const cleanLabel = typeof label === 'string' ? label.trim().slice(0, 60) : ''
    if (existing !== undefined) {
      if (cleanLabel !== '') existing.label = cleanLabel
      existing.enabled = true
    } else {
      accounts.push({ id: nextAccountId([...accounts, { id: 'default' }]), home, label: cleanLabel, enabled: true })
    }
    if (!writeAccounts(accounts)) throw new Error(`无法写入账号文件：${accountsPath()}`)
    return this.poolStatus(cli.ok === true ? cli.packageRoot : '')
  }

  async #turnFor(options, prompt, cli) {
    // Only a turn that actually starts a CLI call needs the image bytes: a
    // continuation reuses the running process, and resolving there would read
    // and re-encode the same image once per step.
    const images = async () => this.#imagesFor(options.messages, options.signal)
    const key = typeof options.sessionId === 'string' ? options.sessionId : ''
    const purpose = typeof options.purpose === 'string' ? options.purpose : ''
    // DSH runs side requests — the session title is the one observed — through
    // the same provider and session id, concurrently with the real turn. Such a
    // request is not the user's conversation: giving it the session's slot would
    // close the running CLI turn, and letting it reuse the derived session id
    // would write the title prompt into the user's CodeBuddy history. It
    // therefore gets its own throwaway turn and its own session id.
    if (purpose !== '') {
      // A side request follows the conversation's account when there is one, so
      // a title is generated by the same billing pool the answer comes from.
      const account = this.#pickTurnAccount(cli, key)
      this.#assertTurnAccount(cli, account)
      this.#currentAccountId = account?.account?.id ?? 'default'
      // The model metadata must reflect the deployment the *chosen* account is
      // signed in to, not whichever account happened to resolve first.
      const servingManifest = this.#productModels(cli.packageRoot, account?.account?.home ?? '')
      const sideCliId = key === '' ? codebuddySessionId(`anonymous-${randomUUID()}`) : codebuddySessionId(`${key}#${purpose}`)
      const session = this.#openSession(options, cli, servingManifest, sideCliId, account?.account, this.#agentFor(key), true)
      session.send(prompt, options.signal, await images())
      // The throwaway turn owns its session completely: onDone closes it through
      // #discard so the dead session also leaves #sessions — a direct
      // `session.close()` leaked one registry entry (and an inflated
      // `backendStatus().sessions` count) per side request.
      return new CodeBuddyTurn({
        session,
        prompt,
        signal: options.signal,
        onDone: () => { void this.#discard(key, session) },
        accountId: account?.account?.id ?? 'default',
      })
    }
    const running = this.#turns.get(key)
    if (running !== undefined && running.serves(options.messages, prompt)) return running
    if (running !== undefined) void running.close()
    if (continuesTurn(options.messages)) {
      // A continuation whose turn already ended — the CLI stopped after a tool
      // call without answering. Serving it would mean spawning a second CLI
      // process for the same message, which would answer it twice, so the step
      // is closed empty instead.
      this.#turns.delete(key)
      return SPENT_TURN
    }
    this.#lastKey = key
    this.#lastModel = providerModelId(options.model)
    // A DSH-side rollback rewrites the conversation the CLI has already read.
    // Detecting it here — before any warm process is reused — is what keeps the
    // model from answering with knowledge of turns the user just removed.
    // Anonymous one-shot calls have no stable DSH history to compare and must
    // never delete another request's transcript or reuse its warm process.
    const rewound = key === '' ? false : await this.#syncHistory(key, options.messages)
    if (rewound) {
      await this.#forgetTranscript(key)
      this.#logger?.info?.('dsh-connect-codebuddy-cli: conversation rolled back; rebuilt the CLI transcript from the surviving history')
    }
    const account = this.#pickTurnAccount(cli, key)
    this.#assertTurnAccount(cli, account)
    const servingManifest = this.#productModels(cli.packageRoot, account?.account?.home ?? '')
    const expected = {
      model: this.#lastModel,
      effort: effortFor(options.reasoningEffort, modelInfoFor(PROVIDER_ID, options.model, servingManifest)),
      cwd: this.#turnCwd(key),
      accountId: account?.account?.id ?? 'default',
      accountHome: account?.account?.home ?? '',
    }
    // Every startup-only input participates in reuse, not just the model.
    const parked = key === '' ? undefined : this.#takeParked(key, expected)
    if (parked !== undefined) {
      parked.send(prompt, options.signal, await images())
      const bound = this.#sessionAccount.get(key)
      this.#currentAccountId = bound?.id ?? 'default'
      const reused = new CodeBuddyTurn({ session: parked, prompt, signal: options.signal, onDone: () => this.#park(key, parked), accountId: bound?.id ?? 'default' })
      this.#turns.set(key, reused)
      return reused
    }
    this.#currentAccountId = expected.accountId
    this.#sessionAccount.set(key, account?.account ?? { id: 'default', home: '', label: '' })
    // A one-shot request gets a fresh CLI transcript even though its continuation
    // steps share the adapter's empty DSH key.
    const cliSessionId = key === '' ? codebuddySessionId(`anonymous-${randomUUID()}`) : codebuddySessionId(key)
    const session = this.#openSession(options, cli, servingManifest, cliSessionId, account?.account, this.#agentFor(key))
    // A conversation whose earlier turns another provider served arrives here
    // with the CLI transcript missing but DSH's history present: the CLI would
    // see only this message. The handoff digest condenses that history into the
    // first frame, once per conversation, and only when the transcript file
    // really is absent — so a resumed session is never seeded twice.
    const digest = handoffDigest(options.messages, rewound ? { reason: 'rewind' } : {})
    let promptForFrame = prompt
    const framePrefix = []
    const handoffKey = accountSeedKey(session.options.sessionId, account?.account)
    if (digest !== '' && !handoffSeeded.has(handoffKey)) {
      const transcript = this.#transcriptPath(key, session.options.sessionId, account?.account)
      if (transcript === '' || !existsSync(transcript)) {
        handoffSeeded.add(handoffKey)
        framePrefix.push(digest)
        this.#logger?.info?.(`dsh-connect-codebuddy-cli: seeded handoff digest (${digest.length} chars) into ${session.options.sessionId}`)
      }
    }
    // A 'first-user' declaration rides in the first frame of the process. In the
    // CodeBuddy-prompt mode this is the only channel it has — that mode sends no
    // system-prompt file at all. One shot per process: a parked process already
    // carries its list, and re-seeding would duplicate it.
    const declaration = this.#toolDeclaration()
    if (declaration !== '' && this.#declarationPlacement() === 'first-user') {
      // This branch only runs for a newly spawned process. Warm reuse returns
      // above, so the declaration is always current and never repeated in-process.
      framePrefix.push(declaration)
      this.#logger?.info?.(`dsh-connect-codebuddy-cli: seeded tool declaration (${declaration.length} chars) into the first frame of ${session.options.sessionId}`)
    }
    if (framePrefix.length > 0) promptForFrame = `${framePrefix.join('\n\n')}\n\n---\n\n${prompt}`

    session.send(promptForFrame, options.signal, await images())
    const turn = new CodeBuddyTurn({
      session,
      prompt,
      signal: options.signal,
      onDone: () => {
        if (key !== '') return this.#park(key, session)
        this.#turns.delete(key)
        this.#sessionAccount.delete(key)
        void this.#discard(key, session)
      },
      accountId: account?.account?.id ?? 'default',
    })
    this.#turns.set(key, turn)
    return turn
  }

  /**
   * Start a CLI session for one DSH conversation.
   * @param options - DSH generate options for this step.
   * @param cli - the resolved CLI.
   * @param manifest - the product manifest for this CLI.
   * @param sessionId - the derived CodeBuddy session id.
   * @param account - the pool account this process runs as, when one is bound.
   * @param agent - the DSH agent that owns the turn, used to route approvals.
   * @param sideRequest - true for a throwaway request beside the user's turn
   *   (the session title): it has no turn to ask about, so it may not prompt.
   * @returns the live session.
   */
  #openSession(options, cli, manifest, sessionId, account, agent, sideRequest = false) {
    const info = modelInfoFor(PROVIDER_ID, options.model, manifest)
    const permission = this.#permissionFor(agent)
    // Prompt and bearer-token files belong to this process, not merely to the
    // conversation: a warm replacement or a side request may start concurrently.
    const scratchKey = `${sessionId}-${randomUUID()}`
    const session = openCli({
      entry: cli.entry,
      model: providerModelId(options.model),
      sessionId,
      // The CLI is a separate process with its own file access, so its
      // permission mode is derived from the setting DSH already resolved for
      // this session rather than picked here.
      permissionMode: permission,
      // Every CLI permission question is routed to DSH's approval seam, so the
      // person using DSH is the one who answers it. A side request is denied
      // instead: it is not the turn the user is having, so there is nothing for
      // them to decide, and a title must never pop a permission prompt.
      //
      // The agent is resolved when the question is asked, not here: a warm
      // process is started before its next turn exists, so the agent it will
      // have to route through does not exist yet at start-up.
      requestPermission: sideRequest
        ? request => ({ allowed: false, reason: `旁路请求不能使用工具 ${request?.toolName ?? ''}，已拒绝` })
        : request => this.#askApproval(agent ?? this.#agentFor(options.sessionId), request),
      // The prompt file is per CLI session: two CLI processes can be starting
      // concurrently (a side request beside the real turn), and each must read
      // its own rules rather than whichever text was written last to a shared
      // file — and closing one must not delete the other's prompt.
      promptKey: scratchKey,
      mcpConfigKey: scratchKey,
      systemPromptFile: writeSystemPromptFile(this.#systemPromptText(options), scratchKey),
      effort: effortFor(options.reasoningEffort, info),
      cwd: this.#turnCwd(options.sessionId),
      // An empty home is the host's own login: no override at all, exactly the
      // pre-accounts behaviour. A real home runs the whole CLI as that account.
      ...(() => {
        const env = accountEnv(account?.home ?? '')
        return Object.keys(env).length === 0 ? {} : { env }
      })(),
      ...(this.#config.maxTurns > 0 ? { maxTurns: this.#config.maxTurns } : {}),
      ...(() => {
        // The DSH session id, not the derived CLI one: the bridge resolves the
        // agent that owns the session, and only the Host knows that id.
        const mcpConfig = this.mcpConfigFor(options.sessionId, scratchKey)
        return mcpConfig === '' ? {} : { mcpConfig }
      })(),
    })
    this.#sessions.add(session)
    return session
  }

  /**
   * Read the permission setting DSH resolved for one session.
   *
   * Both services are looked up opportunistically, so a composition without
   * them still runs: the absent cases fall back to DSH's own defaults
   * (`workspace-write` sandbox, `ask` approval), which is the mode that forwards
   * permission questions rather than settling them silently.
   * @param agent - the agent owning the turn, or `undefined` for a side call.
   * @returns the CLI permission mode name.
   */
  #permissionFor(agent) {
    const session = agent?.session
    let sandboxMode
    let approvalPolicy
    // `false` reads the service even when its providing fiber is not active
    // right now — the plugin is not declared to inject these, so the strict
    // read would throw instead of answering.
    try {
      const sandbox = this.#ctx?.get?.('sandboxPolicy', false)
      if (sandbox !== undefined && session !== undefined) sandboxMode = sandbox.resolve({ session })?.mode
    } catch {
      // A policy service that cannot answer is not a reason to fail the turn;
      // the default below is the conservative one.
    }
    try {
      const approval = this.#ctx?.get?.('approval', false)
      if (approval !== undefined && session !== undefined) approvalPolicy = approval.effectivePolicy(session)
    } catch {
      // Same: fall back to `ask`, which forwards the question to a human.
    }
    return permissionModeFor({ sandboxMode, approvalPolicy })
  }

  /**
   * Route one CLI permission question to DSH's approval seam.
   *
   * The CLI stopped mid-turn because it decided a tool call needs a human. This
   * method asks the same question DSH would ask for its own tools, so the person
   * using DSH sees one prompt and answers it once. Anything that prevents a real
   * answer — no approval service, no agent to route through, a call made outside
   * an open turn, a failing audit append — becomes a deny, never an allow: the
   * turn then ends with a tool error the model can read instead of a call nobody
   * reviewed.
   *
   * An `allowed-once` outcome grants exactly this request. It is not remembered,
   * so the next call asks again — a CLI-native tool approval says nothing about
   * the next CLI-native call, and nothing about MCP tools, which already run
   * through DSH's own pipeline.
   * @param agent - the agent that owns the turn.
   * @param request - the CLI request (`toolName`, `input`, `toolUseId`, `requestId`).
   * @returns `{ allowed, reason }`, never a bare boolean.
   */
  async #askApproval(agent, request) {
    const subject = approvalSubjectFor(request)
    const toolName = subject.toolName
    if (toolName === '') return { allowed: false, reason: '权限请求缺少工具名' }
    if (agent === undefined) return { allowed: false, reason: `无法审批 ${toolName}：该调用没有可路由的会话` }
    // `false` reads the service even when its providing fiber is not active
    // right now: this plugin does not declare `approval` in its inject list,
    // so the strict read would throw rather than answer.
    const approval = this.#ctx?.get?.('approval', false)
    if (approval === undefined) return { allowed: false, reason: `无法审批 ${toolName}：本部署没有审批服务` }
    // The CLI already decided the parameters; DSH reviews the same ones. Only
    // the tool name is shown as the decision subject — the input stays out of
    // the audit event, where it could carry file contents or a token.
    const reason = subject.bridged
      ? `CodeBuddy CLI 请求调用 DSH 工具 ${toolName}`
      : `CodeBuddy CLI 请求使用 ${toolName}`
    let outcome
    try {
      outcome = await approval.request({
        agent,
        toolName,
        // Approval is a decision about this invocation, not just this name. The
        // service may use the arguments to render or enforce path/command rules;
        // keeping them here is also what stops an allowed `Write` from becoming
        // an allow for a different, hostile path. The service still owns what
        // goes into its audit event — the bridge must not invent a second log.
        arguments: request?.input !== null && typeof request?.input === 'object' ? request.input : {},
        ...request?.toolUseId === undefined ? {} : { callId: request.toolUseId },
        reason,
        // A cancelled turn cancels the prompt instead of leaving the user with
        // a question whose answer can no longer reach anything.
        ...request?.signal === undefined ? {} : { signal: request.signal },
      })
    } catch (error) {
      // `approval.request` throws when no turn is open — the audit pair it
      // writes must be turn-enclosed — and can reject when the append fails.
      const message = error instanceof Error ? error.message : String(error)
      return { allowed: false, reason: `无法审批 ${toolName}：${message}` }
    }
    if (outcome === 'allowed-once') return { allowed: true, reason: `已批准 ${toolName}` }
    if (outcome === 'rejected') return { allowed: false, reason: `用户拒绝了 ${toolName}` }
    if (outcome === 'cancelled') return { allowed: false, reason: `对 ${toolName} 的审批被取消` }
    return { allowed: false, reason: `无法审批 ${toolName}：没有可用的审批通道` }
  }

  /**
   * Keep a finished session alive for the configured delay, then close it.
   *
   * The delay is the whole feature: a follow-up message inside the window is
   * answered by the process that is already warm, and one outside it is not.
   * @param key - the DSH session the process belongs to.
   * @param session - the finished session.
   */
  #park(key, session) {
    this.#turns.delete(key)
    const seconds = this.#settings.keepAliveSeconds
    if (seconds <= 0 || !session.alive) {
      void this.#discard(key, session)
      return
    }
    const parked = this.#parked.get(key)
    if (parked !== undefined) void this.#discard(key, parked.session)
    this.#parked.set(key, {
      session,
      account: this.#sessionAccount.get(key),
      expiresAt: Date.now() + seconds * 1000,
      timer: setTimeout(() => { void this.#discard(key, session) }, seconds * 1000),
    })
    if (typeof this.#parked.get(key)?.timer?.unref === 'function') this.#parked.get(key).timer.unref()
  }

  /**
   * Take a parked session for reuse, cancelling its expiry timer.
   *
   * Model, effort, cwd, and account are all fixed at process startup; any one
   * changing makes the parked process unsuitable for the next message.
   * @param key - the DSH session id.
   * @param expected - the startup configuration this turn requires.
   * @returns the session, or `undefined` when none is warm and usable.
   */
  #takeParked(key, expected) {
    const parked = this.#parked.get(key)
    if (parked === undefined) return undefined
    clearTimeout(parked.timer)
    this.#parked.delete(key)
    if (!parked.session.alive || parked.session.busy
      || parked.session.options.model !== expected.model
      || parked.session.options.effort !== expected.effort
      || parked.session.options.cwd !== expected.cwd
      || parked.account?.id !== expected.accountId
      || parked.account?.home !== expected.accountHome) {
      void parked.session.close()
      return undefined
    }
    return parked.session
  }

  /**
   * Drop one parked session and stop its process.
   * @param key - the DSH session id.
   * @param session - the session to close.
   */
  async #discard(key, session) {
    const parked = this.#parked.get(key)
    if (parked !== undefined && parked.session === session) {
      clearTimeout(parked.timer)
      this.#parked.delete(key)
    }
    this.#sessions.delete(session)
    await session.close()
  }

  /**
   * Stop every CLI process this adapter started.
   *
   * Called when the plugin is disposed, so a parked session cannot outlive the
   * host that owns it.
   */
  async dispose() {
    const sessions = [...this.#sessions]
    this.#sessions.clear()
    for (const parked of this.#parked.values()) clearTimeout(parked.timer)
    this.#parked.clear()
    this.#turns.clear()
    // Flush the pending fingerprint write *before* dropping the map: flushing
    // after the clear would persist an empty document and destroy the rollback
    // detection the file exists for.
    if (this.#historiesLoaded) flushHistories(this.#histories)
    this.#histories.clear()
    await Promise.all(sessions.map(session => session.close().catch(() => {})))
  }

  /**
   * Describe the CLI backend the page shows and warms.
   * @returns the keep-alive setting plus what is currently running.
   */
  backendStatus() {
    const parked = []
    for (const [key, entry] of this.#parked) {
      parked.push({ sessionId: key, expiresAt: entry.expiresAt, alive: entry.session.alive })
    }
    return {
      keepAliveSeconds: this.#settings.keepAliveSeconds,
      parked: parked.length,
      sessions: this.#sessions.size,
      expiresAt: parked.length > 0 ? Math.max(...parked.map(entry => entry.expiresAt)) : 0,
    }
  }

  /**
   * Re-arm every parked session from the current keep-alive setting.
   *
   * Raising the delay extends what is already warm; zero closes it, because
   * turning the feature off means "stop now".
   */
  applyKeepAlive() {
    const seconds = this.#settings.keepAliveSeconds
    for (const [key, parked] of this.#parked) {
      clearTimeout(parked.timer)
      if (seconds <= 0) {
        void this.#discard(key, parked.session)
        continue
      }
      parked.expiresAt = Date.now() + seconds * 1000
      parked.timer = setTimeout(() => { void this.#discard(key, parked.session) }, seconds * 1000)
      if (typeof parked.timer.unref === 'function') parked.timer.unref()
    }
  }

  /**
   * Drop every parked session because the prompt inputs changed.
   *
   * A parked process read its system prompt (mode, custom text, tool
   * declaration) once at start-up; the exposed-tool list rides in that prompt
   * too when the declaration is on. Keeping it warm would answer the next
   * message with yesterday's rules, so a prompt-affecting save discards the
   * warmth instead. The conversation itself loses nothing: the CLI transcript
   * is on disk, and the replacement process resumes it by session id.
   */
  discardParkedForPromptChange() {
    for (const [key, parked] of this.#parked) {
      clearTimeout(parked.timer)
      void this.#discard(key, parked.session)
    }
  }

  /**
   * Start the CLI backend without a turn, for the plugin page to pre-warm.
   *
   * A warm process is bound to a conversation, because the CLI's history lives
   * under its session id. The best candidate is therefore the conversation this
   * process last served, falling back to the most recently used DSH session on
   * disk; that is the one the user is most likely to return to.
   * @returns what was warmed, or why nothing could be.
   */
  async warm() {
    for (const [key, parked] of this.#parked) {
      if (parked.session.alive) {
        const seconds = this.#settings.keepAliveSeconds
        if (seconds > 0) {
          clearTimeout(parked.timer)
          parked.expiresAt = Date.now() + seconds * 1000
          parked.timer = setTimeout(() => { void this.#discard(key, parked.session) }, seconds * 1000)
          if (typeof parked.timer.unref === 'function') parked.timer.unref()
        }
        return { warmed: true, reused: true, sessionId: key, expiresAt: parked.expiresAt }
      }
      void this.#discard(key, parked.session)
    }
    if (this.#settings.keepAliveSeconds <= 0) {
      return { warmed: false, reason: '保活时长设为 0（关闭），没有启动 CLI 后端。' }
    }
    const cli = this.#resolveCli()
    if (!cli.ok) return { warmed: false, reason: unavailableMessage(cli.reason) }
    const key = this.#lastKey !== '' ? this.#lastKey : latestSessionId()
    if (key === '') return { warmed: false, reason: '还没有任何 DSH 会话，先发一条消息即可开始使用。' }
    // `--model` is fixed at start-up, so the warm process must use the model the
    // next message is most likely to ask for. The conversation this process last
    // served is the best guess; without one, prefer a model the user actually
    // keeps visible in the picker — the CLI advertises its whole roster and the
    // first id is arbitrary (and can be an expensive one) — and only then fall
    // back to that first id. A wrong guess costs nothing beyond one warm process
    // the keep-alive timer closes anyway.
    const advertised = readAdvertisedModelIds(cli.entry)
    const hidden = new Set(Array.isArray(this.#settings.hiddenModels) ? this.#settings.hiddenModels : [])
    const model = this.#lastModel !== ''
      ? this.#lastModel
      : (advertised.find(id => !hidden.has(id)) ?? advertised[0] ?? '')
    if (model === '') return { warmed: false, reason: 'CLI 没有声明任何模型，无法预热后端。' }
    const account = this.#pickTurnAccount(cli, key)
    if (account === undefined && !hasEnvironmentToken()) {
      return { warmed: false, reason: '没有已登录且可用的 CodeBuddy 账号，请先登录。' }
    }
    const manifest = this.#productModels(cli.packageRoot, account?.account?.home ?? '')
    const session = this.#openSession({ sessionId: key, model }, cli, manifest, codebuddySessionId(key), account?.account, this.#agentFor(key))
    this.#sessionAccount.set(key, account?.account ?? { id: 'default', home: '', label: '' })
    this.#currentAccountId = account?.account?.id ?? 'default'
    this.#park(key, session)
    const parked = this.#parked.get(key)
    return { warmed: true, reused: false, sessionId: key, expiresAt: parked?.expiresAt ?? 0 }
  }

  /**
   * Decide the directory the CLI's tools should act in.
   *
   * A tool-using turn is only honest if the tools see the same files the user
   * is looking at, so the CLI runs in the session's working directory — the one
   * the GUI shows — rather than in whatever directory happened to start the
   * host process. An explicit `config.cwd` wins, because a user who sets it
   * means it. Both services are looked up without declaring them in `inject`
   * so this plugin still activates in compositions that have no agent runtime.
   * @param sessionId - the DSH session id for this turn.
   * @returns the absolute directory, or `undefined` to inherit the host's.
   */
  #turnCwd(sessionId) {
    if (this.#config.cwd !== '') return this.#config.cwd
    const agents = this.#ctx?.reflect?.get?.('agents', false)
    const agent = typeof sessionId === 'string' ? agents?.get?.(sessionId) : undefined
    if (agent !== undefined) {
      const directory = this.#ctx?.reflect?.get?.('workingDirectory', false)
      const resolved = directory?.get?.(agent.session)
      if (typeof resolved === 'string' && resolved !== '') return resolved
      const headerCwd = agent.session?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
    }
    return undefined
  }

  /**
   * Resolve the DSH agent that owns a session.
   *
   * Approvals are audited to, and routed through, an agent's own session, so the
   * CLI's permission questions need the agent rather than its id. The registry is
   * read without declaring it in `inject` for the same reason `#turnCwd` does:
   * a composition with no agent runtime must still activate, and there every
   * question simply has no route and is denied.
   * @param sessionId - the DSH session id.
   * @returns the agent, or `undefined` when the Host cannot supply one.
   */
  #agentFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const agents = this.#ctx?.reflect?.get?.('agents', false)
    return agents?.get?.(sessionId)
  }

  /**
   * Resolve the CLI once and cache the answer.
   * @returns the resolution result.
   */
  #resolveCli() {
    if (this.#cli === undefined) this.#cli = resolveCliEntry(this.#config.binary)
    return this.#cli
  }

  /**
   * Which deployment this session belongs to, and the manifest that follows.
   *
   * The answer changes with the *account*, not with the package root: every
   * pool member shares one CLI installation, so the root is constant while the
   * login site — and therefore the manifest that carries this account's
   * multipliers — follows whichever account is in effect. The domain is read
   * from the account whose home is given (the serving account's binding when
   * one exists, the host's own login otherwise) and keys the cache.
   * @param packageRoot - resolved package root.
   * @param home - the account home the deployment should reflect, or `''`.
   * @returns `{ name, domain, manifest, label }`.
   */
  deployment(packageRoot, home = '') {
    const account = packageRoot === '' ? undefined : readAccount(packageRoot, Date.now(), typeof home === 'string' ? home : '')
    const domain = account?.account?.domain ?? ''
    if (this.#deployment === undefined || this.#deployment.root !== packageRoot || this.#deployment.domain !== domain) {
      const name = deploymentFor(domain)
      this.#deployment = {
        root: packageRoot,
        domain,
        name,
        manifest: productManifestFor(name),
        label: name === 'domestic' ? '国内' : '国际',
      }
    }
    return this.#deployment
  }

  /**
   * Read the product manifest for this deployment, once per package root and
   * login site.
   * @param packageRoot - resolved package root.
   * @param home - the account home the manifest should reflect, or `''`.
   * @returns `{ id → manifest entry }`.
   */
  #productModels(packageRoot, home = '') {
    const deployment = this.deployment(packageRoot, home)
    if (this.#manifest === undefined || this.#manifest.root !== packageRoot || this.#manifest.domain !== deployment.domain) {
      this.#manifest = { root: packageRoot, domain: deployment.domain, models: readProductModels(packageRoot, deployment.name) }
    }
    return this.#manifest.models
  }

  /**
   * Report a resolution failure once per process, at warn level.
   * @param reason - the resolution failure.
   */
  #warnOnce(reason) {
    if (this.#warned) return
    this.#warned = true
    // The logger is optional in a bare composition; a missing one is not fatal.
    this.#logger?.warn?.(`dsh-connect-codebuddy-cli: ${reason}`)
  }
}

/**
 * Classify one CLI failure into a cooldown outcome, from the failure text alone.
 *
 * Kept as an exported pure function so the offline suite can pin the
 * classification without a live account. The rate-limit branch must run first
 * (a 429 that mentions credits is a rate limit, not a drained balance) and the
 * credit branch needs an *exhaustion* word: the bare `credit` match once fired
 * on any message that merely mentions credits — including the success copy of
 * a credits reference — and cooled a healthy account for ten minutes.
 * @param text - the CLI's failure message.
 * @returns `'rate-limited'`, `'exhausted'`, or `'failed'`.
 */
export function classifyAccountFailure(text) {
  const message = typeof text === 'string' ? text : ''
  if (/\b429\b|rate.?limit|too many requests|too many concurrent|频繁/iu.test(message)) return 'rate-limited'
  if (/exhaust|insufficient|out of credits?|no credits? left|积分不足|积分已用完|余额不足|余额已不足|quota exceeded|quota exhausted|insufficient quota/iu.test(message)) return 'exhausted'
  return 'failed'
}

/**
 * Find the DSH session that was touched most recently on disk.
 *
 * Opening the plugin page should start the backend, but a warm CLI process is
 * bound to a conversation. When this process has not served a turn yet, the
 * newest session record is the best available guess at the conversation the
 * user is in — and if it is the wrong one, all that is wasted is one process
 * that the keep-alive timer closes again.
 * @returns the session id, or `''` when none is recorded.
 */
function latestSessionId() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  const directory = join(base, 'storages', 'session_projcache', 'sessions')
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return ''
  }
  let best = ''
  let bestAt = 0
  for (const name of names) {
    if (!name.startsWith('session-') || !name.endsWith('.json')) continue
    try {
      const at = statSync(join(directory, name)).mtimeMs
      if (at > bestAt) {
        bestAt = at
        best = name.slice(0, -'.json'.length)
      }
    } catch {
      // A record removed between the listing and the stat.
    }
  }
  return best
}

/**
 * Choose the effort flag for this call.
 *
 * DSH sends `reasoningEffort` only when the user picked one, so an absent
 * value means "let CodeBuddy use its own default" rather than "force a specific
 * level". The requested id is validated against the model's advertised ladder
 * and dropped when it does not belong: DSH would reject the call upstream
 * anyway, and silently omitting the flag is a better failure than passing an
 * id the CLI does not accept.
 * @param requested - DSH's requested effort id, if any.
 * @param info - the resolved model metadata.
 * @returns the CLI `--effort` value, or `undefined` to omit the flag.
 */
function effortFor(requested, info) {
  if (typeof requested !== 'string' || requested === '') return undefined
  const declared = info?.reasoning?.efforts ?? []
  if (declared.length === 0) return undefined
  return declared.some(effort => effort.id === requested) ? requested : undefined
}

/**
 * Resolve the tool a CLI permission request is really about.
 *
 * The CLI has two families of gated tool. A native tool (`Write`, `Bash`, …)
 * is executed by the CLI itself, so an approval here is the only review it
 * ever gets. A bridged DSH tool arrives wrapped: the CLI asks about
 * `DeferExecuteTool` and names the real target in `input.toolName` (`mcp__…`).
 * Those already run through DSH's own pipeline, so the wrapper's approval must
 * not be mistaken for one — the name shown to the user has to be the real tool.
 * @param request - the CLI request (`toolName`, `input`).
 * @returns `{ toolName, bridged }`.
 */
function approvalSubjectFor(request) {
  const name = typeof request?.toolName === 'string' ? request.toolName.trim() : ''
  const input = request?.input
  if (name === 'DeferExecuteTool' && input !== null && typeof input === 'object') {
    const target = typeof input.toolName === 'string' ? input.toolName.trim() : ''
    if (target !== '') return { toolName: target, bridged: true }
  }
  return { toolName: name, bridged: name.startsWith('mcp__') }
}

export {
  CATALOG_TTL_MS,
  CodeBuddyAdapter,
  MAX_IMAGE_BYTES,
  MAX_TURN_IMAGES,
  approvalSubjectFor,
  effortFor,
  handoffSeeded,
  latestSessionId,
}
