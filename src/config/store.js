/**
 * Persist the choices the plugin page edits.
 *
 * DSH's own settings document is the canonical store for host preferences, but
 * this plugin needs its choices while it is answering `listModels` on a bare
 * headless host too, where that document may not be served at all. A small file
 * under the DSH home keeps the plugin self-contained and readable from every
 * composition the plugin runs in.
 *
 * The file records the models to *hide* rather than the models to show, so a
 * model the CLI starts advertising after an upgrade appears by default instead
 * of silently vanishing behind an older snapshot of the list.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CHAT_SYSTEM_PROMPT, normalizePromptMode } from './prompt.js'

/** Where the tool declaration rides: appended to the system prompt, or prepended to the first user message. */
export const DECLARATION_PLACEMENTS = ['system', 'first-user']

/**
 * Normalize a stored declaration placement.
 * @param value - the raw value.
 * @returns one of {@link DECLARATION_PLACEMENTS}, defaulting to `system`.
 */
export function normalizeDeclarationPlacement(value) {
  return typeof value === 'string' && DECLARATION_PLACEMENTS.includes(value) ? value : 'system'
}

/** Folder this plugin owns under the DSH home. */
const FOLDER = 'dsh-connect-codebuddy-cli'

/** File holding the settings. */
const FILE = 'settings.json'

/**
 * Resolve the settings file path.
 *
 * `DSH_HOME` is consulted first because the host sets it per profile, which is
 * what keeps two profiles from overwriting each other's model list.
 * @returns an absolute path.
 */
export function settingsPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, FOLDER, FILE)
}

/**
 * File holding the last conversation fingerprint per DSH session.
 *
 * A rollback is only detectable by comparing against what the CLI was last told,
 * and that comparison has to survive a host restart: otherwise a rewind followed
 * by a restart leaves the CLI's transcript holding turns DSH removed. One small
 * JSON document is enough — the value is a list of short strings.
 */
const HISTORY_FILE = 'histories.json'

/** Sessions whose fingerprint is retained; oldest are dropped first. */
export const MAX_TRACKED_SESSIONS = 64

/**
 * Resolve the fingerprint file path, next to the settings file.
 * @returns an absolute path.
 */
export function historiesPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, FOLDER, HISTORY_FILE)
}

/**
 * Read the stored fingerprints.
 *
 * A missing or damaged file means "nothing known yet" — the first message of a
 * conversation then simply records its own fingerprint.
 * @returns a `Map` of session id to signature list, in insertion order.
 */
export function readHistories() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(historiesPath(), 'utf8'))
  } catch {
    return new Map()
  }
  const result = new Map()
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(value)) continue
    result.set(sessionId, value.filter(entry => typeof entry === 'string'))
  }
  return result
}

/** Minimum gap between two fingerprint-file writes, in milliseconds. */
const HISTORIES_WRITE_INTERVAL_MS = 2_000

/** The pending flush timer, when a write is being coalesced. */
let historiesFlushTimer

/** When the file was last written, so the first write of a burst lands at once. */
let historiesLastWriteAt = 0

/**
 * Record the fingerprint map for persistence, coalescing rapid writes.
 *
 * Every new turn used to rewrite the file synchronously; a busy session pays
 * that once per message for a file nothing reads back between turns. The first
 * write after a quiet period lands immediately (a rollback fingerprint lost to
 * a crash right after it was detected is the bad case), calls inside the
 * window schedule one trailing flush, and {@link flushHistories} forces it
 * (used on adapter dispose).
 * @param histories - the map to persist.
 * @returns whether a write happened now (scheduled writes report `true` too,
 *   from the write that established the window).
 */
export function writeHistories(histories) {
  if (historiesFlushTimer !== undefined) {
    clearTimeout(historiesFlushTimer)
    historiesFlushTimer = undefined
  }
  const sinceLast = Date.now() - historiesLastWriteAt
  if (sinceLast >= HISTORIES_WRITE_INTERVAL_MS) {
    return flushHistories(histories)
  }
  const flush = () => {
    historiesFlushTimer = undefined
    flushHistories(histories)
  }
  historiesFlushTimer = setTimeout(flush, HISTORIES_WRITE_INTERVAL_MS - sinceLast)
  if (typeof historiesFlushTimer.unref === 'function') historiesFlushTimer.unref()
  return true
}

/** Write without debouncing; also exported for dispose paths. */
export function flushHistories(histories) {
  if (historiesFlushTimer !== undefined) {
    clearTimeout(historiesFlushTimer)
    historiesFlushTimer = undefined
  }
  const written = writeHistoriesNow(histories)
  if (written === true) historiesLastWriteAt = Date.now()
  return written
}

/** The actual file write. */
function writeHistoriesNow(histories) {
  const path = historiesPath()
  const document = {}
  const entries = [...histories.entries()]
  for (const [sessionId, value] of entries.slice(-MAX_TRACKED_SESSIONS)) {
    document[sessionId] = value
  }
  const text = `${JSON.stringify(document)}
`
  const temporary = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try { unlinkSync(temporary) } catch {}
    return false
  }
}

/**
 * Keep-alive used until the page changes it.
 *
 * Five minutes is long enough to cover a normal back-and-forth and short enough
 * that a forgotten process does not linger for hours.
 */
export const DEFAULT_KEEP_ALIVE_SECONDS = 300

/**
 * Tools bridged to the CLI before the user has chosen anything.
 *
 *  is the one that makes model-produced files — images included — show
 * up as deliverables in DSH; without it the model can only print a path. It is a
 * single tool with a short description, so the prompt cost is bounded, and the
 * page lets the user drop it.
 */
const DEFAULT_EXPOSED_TOOLS = ['present']

/** Upper bound the page accepts, so a typo cannot pin a process for a day. */
export const MAX_KEEP_ALIVE_SECONDS = 3600

/**
 * Normalize a keep-alive value.
 * @param value - the raw value, in seconds.
 * @param fallback - what to use when it is not a usable number.
 * @returns a whole number of seconds in `[0, MAX_KEEP_ALIVE_SECONDS]`.
 */
export function normalizeKeepAlive(value, fallback = DEFAULT_KEEP_ALIVE_SECONDS) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  const whole = Math.round(parsed)
  if (whole < 0) return 0
  return Math.min(MAX_KEEP_ALIVE_SECONDS, whole)
}

/**
 * Read the stored settings.
 *
 * A missing or damaged file is not an error: the plugin simply runs with the
 * defaults, which show every advertised model and keep the CLI warm for the
 * default delay.
 * @returns the parsed settings.
 */
export function readSettings() {
  const empty = {
    hiddenModels: [],
    keepAliveSeconds: DEFAULT_KEEP_ALIVE_SECONDS,
    exposedTools: [...DEFAULT_EXPOSED_TOOLS],
    promptMode: 'custom',
    customPrompt: CHAT_SYSTEM_PROMPT,
    declareTools: true,
    declarationPlacement: 'system',
  }
  let raw
  try {
    raw = readFileSync(settingsPath(), 'utf8')
  } catch {
    return empty
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  const hidden = Array.isArray(parsed?.hiddenModels)
    ? parsed.hiddenModels.filter(id => typeof id === 'string' && id !== '')
    : []
  // A file written before tools existed carries no key at all, which is not the
  // same as an explicit empty list: it predates the choice and gets the default.
  const exposedTools = Array.isArray(parsed?.exposedTools)
    ? parsed.exposedTools.filter(name => typeof name === 'string' && name !== '')
    : [...DEFAULT_EXPOSED_TOOLS]
  // The custom prompt defaults to the bridge's own text: that is what every turn
  // used before this choice existed, so an upgrade changes nothing until the
  // user edits the box.
  const customPrompt = typeof parsed?.customPrompt === 'string' && parsed.customPrompt.trim() !== ''
    ? parsed.customPrompt
    : CHAT_SYSTEM_PROMPT
  // A file written before the declaration switch existed carries no key; that
  // predates the choice, so it gets the on default rather than "off".
  const declareTools = parsed?.declareTools === false ? false : true
  const declarationPlacement = normalizeDeclarationPlacement(parsed?.declarationPlacement)
  return {
    hiddenModels: hidden,
    keepAliveSeconds: normalizeKeepAlive(parsed?.keepAliveSeconds),
    exposedTools,
    promptMode: normalizePromptMode(parsed?.promptMode),
    customPrompt,
    declareTools,
    declarationPlacement,
  }
}

/**
 * Replace the stored settings.
 *
 * Written through a temporary file and a rename so a reader never observes a
 * half-written document, and so a failed write leaves the previous values intact.
 * @param settings - `{ hiddenModels, keepAliveSeconds }`.
 * @returns whether the write succeeded.
 */
export function writeSettings(settings) {
  const path = settingsPath()
  const value = {
    hiddenModels: Array.isArray(settings?.hiddenModels)
      ? settings.hiddenModels.filter(id => typeof id === 'string' && id !== '')
      : [],
    keepAliveSeconds: normalizeKeepAlive(settings?.keepAliveSeconds),
    exposedTools: Array.isArray(settings?.exposedTools)
      ? settings.exposedTools.filter(name => typeof name === 'string' && name !== '')
      : [],
    promptMode: normalizePromptMode(settings?.promptMode),
    customPrompt: typeof settings?.customPrompt === 'string' && settings.customPrompt.trim() !== ''
      ? settings.customPrompt
      : CHAT_SYSTEM_PROMPT,
    declareTools: settings?.declareTools === false ? false : true,
    declarationPlacement: normalizeDeclarationPlacement(settings?.declarationPlacement),
  }
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try { unlinkSync(temporary) } catch {}
    return false
  }
}