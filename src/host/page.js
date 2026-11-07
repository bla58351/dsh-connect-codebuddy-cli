/**
 * The plugin page: one RPC channel, its endpoints, and the save handlers.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/host/page
 */

import { accountsPath, prepareAccount, readAccounts, writeAccounts } from '../account/pool.js'
import { cliStatus, readAccount, readCredits } from '../account/session.js'
import { DEFAULT_MAX_TURNS, readAdvertisedModelIds, readProductModels } from '../cli/session.js'
import { MAX_CUSTOM_PROMPT_CHARS, normalizePromptMode } from '../config/prompt.js'
import { hasExposedToolsChoice, normalizeDeclarationPlacement, normalizeKeepAlive, settingsPath, writeSettings } from '../config/store.js'
import { describeReadiness } from './readiness.js'

/**
 * Serve the plugin page's data over the browser connection.
 *
 * The page cannot read the filesystem or spawn anything, so everything it shows
 * arrives through one RPC channel. Two facts decide how it is registered:
 *
 * - The channel is a *prefix route on the web server*, and `connection.register`
 *   reads `owner.webServer`. A context that never injected that service throws
 *   at registration time, so the owner has to be one that does — which is why
 *   this waits for both services through `ctx.inject` instead of looking the
 *   connection up reflectively at load time.
 * - Waiting must not be a hard dependency: a headless host serves no web page
 *   and must keep the provider route working. `ctx.inject` is exactly that — a
 *   missing service simply means this callback never runs.
 *
 * @param ctx - the plugin's Cordis context.
 * @param adapter - the provider adapter whose model list the page edits.
 * @param config - the resolved plugin configuration.
 * @param settings - the live settings state shared with the adapter.
 */
function installPluginPage(ctx, adapter, config, settings) {
  const state = { adapter, config, settings }
  /**
   * Register the channel on a context that injects both services.
   * @param owner - the injected context.
   */
  const attach = (owner) => {
    const connection = typeof owner.get === 'function' ? owner.get('connection') : owner.connection
    if (connection === undefined || connection === null) return
    const handler = (endpoint, payload, signal) => dispatchPageRequest(endpoint, payload, signal, state)
    if (typeof connection.register === 'function') {
      connection.register(owner, PAGE_CHANNEL, handler)
      ctx.logger?.info?.(`dsh-connect-codebuddy-cli: page rpc channel ${PAGE_CHANNEL} registered`)
      return
    }
    if (typeof connection.rpc?.handle === 'function') {
      connection.rpc.handle(PAGE_CHANNEL, handler)
      ctx.logger?.info?.(`dsh-connect-codebuddy-cli: page rpc channel ${PAGE_CHANNEL} registered (rpc.handle)`)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection', 'webServer'], attach)
    return
  }
  attach(ctx)
}

/** RPC channel the plugin page talks to. */
const PAGE_CHANNEL = '/codebuddy'

/**
 * Answer one request from the plugin page.
 *
 * @param endpoint - the requested action.
 * @param payload - the action's arguments.
 * @param signal - cancellation for this request.
 * @param state - the adapter, configuration, and live settings.
 * @returns a settled RPC result.
 */
async function dispatchPageRequest(endpoint, payload, signal, state) {
  try {
    if (signal?.aborted === true) return abortedResult()
    switch (endpoint) {
      case 'overview':
        return { ok: true, value: await buildOverview({ ...state, freshCredits: payload?.refresh === true }) }
      case 'save-models':
        return { ok: true, value: saveModels(state, payload) }
      case 'set-keep-alive':
        return { ok: true, value: setKeepAlive(state, payload) }
      case 'save-prompt':
        return { ok: true, value: savePrompt(state, payload) }
      case 'save-tools':
        return { ok: true, value: saveExposedTools(state, payload) }
      case 'accounts':
        return { ok: true, value: await saveAccounts(state, payload) }
      case 'prepare-account':
        return { ok: true, value: prepareAccountRow(state, payload) }
      case 'account-pool':
        return { ok: true, value: await state.adapter.poolStatus(cliRootOf(state), { freshCredits: payload?.fresh === true }) }
      case 'save-current-account':
        return { ok: true, value: state.adapter.saveCurrentAccount(typeof payload?.label === 'string' ? payload.label : '') }
      case 'warm': {
        const backend = await state.adapter.warm()
        // Opening the page is also the cheapest moment to refresh the live model
        // catalog: the user is waiting anyway, and no model call is involved.
        await state.adapter.ensureModelCatalog(6000)
        return { ok: true, value: { ...backend, backend: state.adapter.backendStatus(), catalog: state.adapter.catalogStatus() } }
      }
      default:
        return failedResult('unknown-endpoint', `未知的请求：${String(endpoint)}`)
    }
  } catch (error) {
    return failedResult('internal', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Collect everything the 概览 tab shows.
 *
 * @param state - the adapter, configuration, and live settings.
 * @returns the overview payload.
 */
async function buildOverview(state) {
  const { adapter, config, settings } = state
  const cli = adapter.describeCli()
  const status = await cliStatus(cli)
  // Start the live catalog probe but never block the page on it: the probe
  // costs a CLI start-up, and the manifest answers are a fine first paint. The
  // page reloads once the probe lands (see the `warm` endpoint).
  if (status.installed === true) void adapter.refreshModelCatalog()
  // The overview describes the account that is actually serving: when a pool
  // account owns the current conversation, the host's own login is not what the
  // user is talking to. The adapter exposes the serving account's home.
  const servingHome = adapter.currentAccountHome?.() ?? ''
  const account = status.installed
    ? readAccount(cli.packageRoot, Date.now(), typeof servingHome === 'string' ? servingHome : '')
    : { signedIn: false, reason: 'CLI 不可用，无法读取账号。', account: undefined }
  // Credits come from the account service the CLI's own token authorizes. A
  // slow or unreachable service must not delay the rest of the page, and it
  // must not turn the overview into an error, so it resolves to a record the
  // page can explain rather than a rejection.
  const credits = status.installed && account.signedIn === true
    ? await readCredits(cli.packageRoot, { fresh: state.freshCredits === true, home: typeof servingHome === 'string' ? servingHome : '' })
    : { available: false, reason: '未登录，无法读取积分。' }
  const models = modelChoices(adapter, config, settings)
  // The account pool is part of the first paint so the 账号 tab is never empty;
  // credit reads are cached and throttled, so this stays cheap.
  const pool = status.installed
    ? await adapter.poolStatus(cli.packageRoot, { freshCredits: state.freshCredits === true })
    : { accounts: [], cooldowns: [] }
  return {
    cli: status,
    account,
    readiness: describeReadiness(status, account),
    credits,
    models,
    accounts: pool,
    tools: adapter.toolCatalog(),
    prompt: adapter.promptState(),
    backend: adapter.backendStatus(),
    settingsPath: settingsPath(),
    maxTurns: config.maxTurns > 0 ? config.maxTurns : DEFAULT_MAX_TURNS,
  }
}

/**
 * Whether the CLI can be authenticated from the environment instead of a file.
 *
 * The answer moved to `account/session.js` (the adapter asks the same question
 * in its pre-flight check and must not import from the host layer); it is
 * re-exported here so this module's surface is unchanged.
 */
export { hasEnvironmentToken } from '../account/session.js'

/**
 * Build the model list the settings tab toggles.
 *
 * Every model the CLI advertises is listed, including the ones the plugin's own
 * `models` config excludes, so the page can explain why a model is missing from
 * the picker instead of leaving the user to guess.
 *
 * @param adapter - the provider adapter.
 * @param config - the resolved plugin configuration.
 * @param settings - the live settings state.
 * @returns the choice rows plus the counts the page shows.
 */
function modelChoices(adapter, config, settings) {
  const cli = adapter.describeCli()
  const advertised = cli.ok ? readAdvertisedModelIds(cli.entry) : []
  // The multiplier is manifest metadata, and the manifest is deployment-specific:
  // the page and the selector both read it through the adapter so they cannot
  // disagree about which deployment's numbers they are showing.
  const servingHome = adapter.currentAccountHome?.() ?? ''
  const deployment = cli.ok ? adapter.deployment(cli.packageRoot, servingHome) : undefined
  const manifest = cli.ok ? readProductModels(cli.packageRoot, deployment?.name ?? 'international') : new Map()
  const restricted = config.models
  const hidden = settings.hiddenModels
  const rows = advertised.map((id) => {
    const blocked = restricted.length > 0 && !restricted.includes(id)
    const credits = adapter.creditFor(id, manifest, servingHome)
    return {
      id,
      name: id,
      visible: !blocked && !hidden.includes(id),
      blocked,
      credits: credits?.label ?? '',
      ratio: credits?.ratio ?? undefined,
      creditsSource: credits?.source ?? '',
    }
  })
  return {
    rows,
    advertised: advertised.length,
    visible: rows.filter(row => row.visible).length,
    restricted: restricted.length > 0,
    catalog: adapter.catalogStatus(),
    deployment: deployment === undefined
      ? undefined
      : { name: deployment.name, label: deployment.label, domain: deployment.domain, manifest: deployment.manifest },
  }
}

/**
 * Replace the whole visible-model selection and persist it.
 *
 * The page saves a draft rather than one switch at a time, so the store is
 * rewritten once per save: the hidden set is recomputed from what the CLI
 * advertises now, which also drops ids the CLI stopped offering instead of
 * letting them accumulate.
 *
 * @param state - the adapter, configuration, and live settings.
 * @param payload - `{ visible: string[] }`.
 * @returns the refreshed model choices.
 */
function saveModels(state, payload) {
  const { adapter, config, settings } = state
  if (!Array.isArray(payload?.visible)) throw new Error('缺少 visible 参数。')
  const visible = payload.visible.filter(id => typeof id === 'string' && id !== '')
  const cli = adapter.describeCli()
  const advertised = cli.ok ? readAdvertisedModelIds(cli.entry) : []
  const selected = new Set(visible)
  const hiddenModels = advertised.filter(id => !selected.has(id))
  if (!writeSettings(settingsForWrite(settings, { hiddenModels }))) throw new Error(`无法写入设置文件：${settingsPath()}`)
  settings.hiddenModels = hiddenModels
  // The picker is a *cached* catalog in the browser: it only reloads when the
  // Host announces a topology change. Writing a private settings file is
  // invisible to it, so the save has to announce itself — otherwise the list the
  // user just edited keeps showing the old membership until the page reloads.
  adapter.announceModels()
  return modelChoices(adapter, config, settings)
}

/**
 * Store the CLI keep-alive delay and apply it to parked sessions.
 *
 * The value takes effect immediately: raising it extends the sessions already
 * parked, and setting it to zero closes them, because a user who turns the
 * feature off means "stop now" rather than "next time".
 *
 * @param state - the adapter, configuration, and live settings.
 * @param payload - `{ seconds }`.
 * @returns the new keep-alive state.
 */
function setKeepAlive(state, payload) {
  const { adapter, settings } = state
  const seconds = normalizeKeepAlive(payload?.seconds, settings.keepAliveSeconds)
  if (!writeSettings(settingsForWrite(settings, { keepAliveSeconds: seconds }))) {
    throw new Error(`无法写入设置文件：${settingsPath()}`)
  }
  settings.keepAliveSeconds = seconds
  adapter.applyKeepAlive()
  return adapter.backendStatus()
}

/**
 * Replace the set of DSH tools exposed to the CLI and persist it.
 *
 * Names are validated against what the Host currently advertises for the
 * session, so a stale page cannot enable a tool that no longer exists — and an
 * unknown name can never reach `tools.execute`.
 *
 * @param state - the adapter, configuration, and live settings.
 * @param payload - `{ names: string[] }`.
 * @returns the refreshed tool catalog.
 */
function saveExposedTools(state, payload) {
  const { adapter, settings } = state
  if (!Array.isArray(payload?.names)) throw new Error('缺少 names 参数。')
  const catalog = adapter.toolCatalog()
  const known = (catalog.available ?? []).map(entry => entry.name)
  const names = [...new Set(payload.names.filter(name => typeof name === 'string' && name !== ''))]
    .filter(name => name !== 'run_code' && known.includes(name))
  // With no live session the catalog is empty, which says nothing about which
  // tools exist — a save then must pass the draft through unchanged rather than
  // interpret "nothing is known" as "nothing was chosen" and wipe the list.
  const effective = known.length === 0 ? [...new Set(payload.names.filter(name => typeof name === 'string' && name !== '' && name !== 'run_code'))] : names
  if (!writeSettings(settingsForWrite(settings, { exposedTools: effective }))) {
    throw new Error(`无法写入设置文件：${settingsPath()}`)
  }
  settings.exposedTools = effective
  // The declaration rides in the system prompt a parked process already read;
  // dropping the warmth makes the next message start on the new list.
  adapter.discardParkedForPromptChange()
  return adapter.toolCatalog()
}

/**
 * Build the whole settings document for a write.
 *
 * Every save has to carry every field: the store replaces the file, so a save
 * that only meant to change one value would silently reset the others. Passing
 * the live state plus the change keeps that rule in one place.
 * @param settings - the live settings state.
 * @param change - the fields this save changes.
 * @returns the document to write.
 */
function settingsForWrite(settings, change) {
  const document = {
    hiddenModels: settings.hiddenModels,
    keepAliveSeconds: settings.keepAliveSeconds,
    promptMode: settings.promptMode,
    customPrompt: settings.customPrompt,
    declareTools: settings.declareTools !== false,
    declarationPlacement: normalizeDeclarationPlacement(settings.declarationPlacement),
    ...change,
  }
  // Only carry the tool list when a choice exists or this save makes one:
  // an untouched list keeps the file "no explicit choice" so the live
  // default keeps following the Host catalog.
  if (change.exposedTools !== undefined) document.exposedTools = change.exposedTools
  else if (hasExposedToolsChoice()) document.exposedTools = settings.exposedTools
  return document
}

/**
 * Store the system-prompt choice and, for the custom mode, its text.
 *
 * @param state - the adapter, configuration, and live settings.
 * @param payload - `{ mode, text }`.
 * @returns the new prompt state.
 */
function savePrompt(state, payload) {
  const { adapter, settings } = state
  const mode = normalizePromptMode(payload?.mode)
  const text = typeof payload?.text === 'string' ? payload.text : settings.customPrompt
  if (text.length > MAX_CUSTOM_PROMPT_CHARS) {
    throw new Error(`自定义提示词最多 ${MAX_CUSTOM_PROMPT_CHARS} 个字符，当前 ${text.length}。`)
  }
  // An empty custom prompt would mean "no prompt", which is the CodeBuddy mode;
  // keeping the previous text is friendlier than silently losing it.
  const customPrompt = text.trim() === '' ? settings.customPrompt : text
  const declareTools = payload?.declareTools === false ? false : payload?.declareTools === true ? true : settings.declareTools !== false
  const placement = normalizeDeclarationPlacement(payload?.declarationPlacement)
  if (!writeSettings(settingsForWrite(settings, { promptMode: mode, customPrompt, declareTools, declarationPlacement: placement }))) {
    throw new Error(`无法写入设置文件：${settingsPath()}`)
  }
  const promptChanged = settings.promptMode !== mode
    || settings.customPrompt !== customPrompt
    || (settings.declareTools !== false) !== (declareTools === true)
    || normalizeDeclarationPlacement(settings.declarationPlacement) !== placement
  settings.promptMode = mode
  settings.customPrompt = customPrompt
  settings.declareTools = declareTools
  settings.declarationPlacement = placement
  if (promptChanged) adapter.discardParkedForPromptChange()
  return adapter.promptState()
}

/**
 * Persist the account registry from the page.
 *
 * The page sends the complete row list; validation keeps the shape strict and
 * the count bounded. Saving does not touch live processes: a conversation keeps
 * running on the account it started with.
 * @param state - the adapter, configuration, and live settings.
 * @param payload - `{ accounts: [{ id, home, label, enabled }] }`.
 * @returns the refreshed pool.
 */
async function saveAccounts(state, payload) {
  const rows = Array.isArray(payload?.accounts) ? payload.accounts : []
  const seen = new Set()
  const accounts = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.id !== 'string' || raw.id === '' || seen.has(raw.id)) continue
    if (typeof raw.home !== 'string' || raw.home === '') continue
    seen.add(raw.id)
    accounts.push({
      id: raw.id,
      home: raw.home,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 60) : '',
      enabled: raw.enabled !== false,
    })
    if (accounts.length >= 20) break
  }
  if (!writeAccounts(accounts)) throw new Error(`无法写入账号文件：${accountsPath()}`)
  return state.adapter.poolStatus(cliRootOf(state))
}

/**
 * Create the next account's home directory and return the login command.
 *
 * Nothing is registered until the user has logged in inside that home and saved;
 * this only prepares the folder and tells the page what to run.
 * @param state - the adapter, configuration, and live settings.
 * @returns `{ id, home, command }`.
 */
function prepareAccountRow(state) {
  const { accounts } = readAccounts()
  const prepared = prepareAccount(accounts)
  return prepared
}

/**
 * The CLI's package root, for pool reads.
 * @param state - the page handler state.
 * @returns the root, or `''`.
 */
function cliRootOf(state) {
  const cli = state.adapter?.describeCli?.()
  return cli?.ok === true ? cli.packageRoot : ''
}

/**
 * Build an aborted RPC result.
 * @returns the RPC failure shape.
 */
function abortedResult() {
  return { ok: false, error: { code: 'aborted', message: '请求已取消', details: {} } }
}

/**
 * Build a failed RPC result.
 * @param code - a stable machine-readable code.
 * @param message - the human explanation.
 * @returns the RPC failure shape.
 */
function failedResult(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

export {
  PAGE_CHANNEL,
  abortedResult,
  buildOverview,
  cliRootOf,
  dispatchPageRequest,
  failedResult,
  installPluginPage,
  modelChoices,
  prepareAccountRow,
  saveAccounts,
  saveExposedTools,
  saveModels,
  savePrompt,
  setKeepAlive,
  settingsForWrite,
}
