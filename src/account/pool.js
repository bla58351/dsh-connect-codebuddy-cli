/**
 * Multiple CodeBuddy accounts, and which one serves the next turn.
 *
 * The CLI reads its login session from a fixed location under the user's home
 * (`%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/<authId>.info`) and its
 * sessions from `~/.codebuddy`. Both derive from `os.homedir()`, which honours
 * `USERPROFILE` on Windows — so one account is one home directory. A profile
 * directory that has been logged into once (the user runs `codebuddy` with the
 * environment the page copies) owns exactly one login, and launching the CLI
 * with that environment runs the whole CLI as that account: its model list, its
 * credits, its sessions, its per-model environment (domestic/international).
 *
 * Rotation is deliberately modelled on dsh-connect-trae's account pool: a
 * cooldown per outcome, ranked best-first, and the default (no-env) login
 * participates as an ordinary member. What differs is the mechanism — this
 * bridge spawns a CLI subprocess rather than calling an HTTP API, so "probe"
 * means reading the account's own session file and its credits endpoint, and
 * "switch" means launching the next process with that account's environment.
 *
 * Secrets never leave this module's callers: the page sees ids, nicknames,
 * domains, credit numbers, and states — never tokens.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'

import { readAccount, readCredits, deploymentFor } from './session.js'

/** Folder under the DSH home holding the account registry. */
const FOLDER = 'dsh-connect-codebuddy-cli'

/** File holding the account list. */
const FILE = 'accounts.json'

/** Where per-account homes live, under the DSH home. */
const HOMES_FOLDER = 'codebuddy-homes'

/** Sessions kept in the registry, so a stale page cannot grow it forever. */
const MAX_ACCOUNTS = 20

/** Cooldown after a rate limit, before the account may serve again. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000

/** Cooldown after credits ran out — longer, because a top-up does not land mid-session. */
export const EXHAUSTED_COOLDOWN_MS = 10 * 60_000

/** Cooldown after a transport failure; short, because these are usually blips. */
export const FAILED_COOLDOWN_MS = 30_000

/** How long a credits probe stays trusted. */
const CREDITS_TTL_MS = 60_000

/** Registry format version; readers accept exactly this. */
const FORMAT_VERSION = 1

/**
 * Resolve the registry file path under the DSH home.
 * @returns an absolute path.
 */
export function accountsPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, FOLDER, FILE)
}

/**
 * Resolve the folder holding per-account home directories.
 * @returns an absolute path.
 */
export function homesRoot() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, FOLDER, HOMES_FOLDER)
}

/**
 * The environment that runs the CLI as one account.
 *
 * `USERPROFILE` relocates where the CLI looks for its login session (it joins
 * `homedir()`/`AppData/Local/CodeBuddyExtension/...`) and `CODEBUDDY_CONFIG_DIR`
 * relocates everything under `~/.codebuddy` — sessions, settings, local state.
 * Both are needed: sharing either would mix two accounts' data. On POSIX the
 * session directory derives from `HOME` instead of `USERPROFILE`, so both are
 * pinned there — without it every pool member would read the host's own login.
 * @param homeDir - the account's home directory, or `''` for the host's own.
 * @returns environment variables to merge into the child process.
 */
export function accountEnv(homeDir) {
  if (typeof homeDir !== 'string' || homeDir === '') return {}
  const env = {
    USERPROFILE: homeDir,
    CODEBUDDY_CONFIG_DIR: join(homeDir, '.codebuddy'),
  }
  if (process.platform !== 'win32') env.HOME = homeDir
  return env
}

/**
 * One normalized account row.
 * @typedef {object} AccountRow
 * @property {string} id stable identifier (`a1`, `a2`, …).
 * @property {string} home the account's home directory; `''` is the host's own login.
 * @property {string} label what the page shows.
 * @property {boolean} enabled whether the pool may use it.
 */

/**
 * Read the stored account rows.
 *
 * A missing or damaged file is not an error: the pool then holds only the
 * default account, which is the pre-accounts behaviour.
 * @returns `{ version, accounts }` with accounts as {@link AccountRow}s.
 */
export function readAccounts() {
  const fallback = { version: FORMAT_VERSION, accounts: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(accountsPath(), 'utf8'))
  } catch {
    return fallback
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.accounts)) {
    return fallback
  }
  const accounts = []
  for (const raw of parsed.accounts) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.id !== 'string' || raw.id === '') continue
    if (typeof raw.home !== 'string') continue
    accounts.push({
      id: raw.id,
      home: raw.home,
      label: typeof raw.label === 'string' ? raw.label : '',
      enabled: raw.enabled !== false,
    })
  }
  return { version: FORMAT_VERSION, accounts: accounts.slice(0, MAX_ACCOUNTS) }
}

/**
 * Replace the stored account rows.
 * @param accounts - the rows to persist.
 * @returns whether the write succeeded.
 */
export function writeAccounts(accounts) {
  const path = accountsPath()
  const rows = Array.isArray(accounts) ? accounts.slice(0, MAX_ACCOUNTS) : []
  const text = `${JSON.stringify({ version: FORMAT_VERSION, accounts: rows }, null, 2)}\n`
  const temporary = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try { unlinkSync(temporary) } catch {}
    return false
  }
}

/**
 * The next unused account id.
 * @param accounts - the current rows.
 * @returns an id like `a3`.
 */
export function nextAccountId(accounts) {
  const used = new Set(Array.isArray(accounts) ? accounts.map(row => row.id) : [])
  for (let index = 1; index <= MAX_ACCOUNTS; index += 1) {
    const id = `a${index}`
    if (!used.has(id)) return id
  }
  return `a${Date.now().toString(36)}`
}

/**
 * Prepare (or reuse) one account's home directory.
 * @param accounts - current rows, used for the id.
 * @returns `{ id, home, command }` — the command the user runs to log in.
 */
export function prepareAccount(accounts) {
  const id = nextAccountId(accounts)
  const home = join(homesRoot(), id)
  mkdirSync(join(home, '.codebuddy'), { recursive: true })
  const env = [
    `USERPROFILE "${home}"`,
    `CODEBUDDY_CONFIG_DIR "${join(home, '.codebuddy')}"`,
  ]
  return {
    id,
    home,
    command: accountLoginCommand(home),
    envNote: env.join('  '),
  }
}

/** Quote one literal for a POSIX single-quoted shell word. */
function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

/** Quote one literal for a PowerShell single-quoted string. */
function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Build the login command for one isolated account home.
 * @param home - the account's isolated home directory.
 * @param platform - the target platform, injectable for offline tests.
 * @returns a shell command that cannot redirect login into the host account.
 */
export function accountLoginCommand(home, platform = process.platform) {
  const config = (platform === 'win32' ? win32 : posix).join(home, '.codebuddy')
  if (platform === 'win32') {
    return `$env:USERPROFILE=${powershellQuote(home)}; $env:CODEBUDDY_CONFIG_DIR=${powershellQuote(config)}; codebuddy`
  }
  return `HOME=${posixQuote(home)} USERPROFILE=${posixQuote(home)} CODEBUDDY_CONFIG_DIR=${posixQuote(config)} codebuddy`
}

/**
 * Read one account's login state from its own home.
 *
 * The default account (empty home) reads the host's own session, exactly as
 * `readAccount` always has. The home is passed through as a parameter: an
 * earlier spelling mutated `process.env.USERPROFILE` around the read, which
 * stayed in force across `await` points and silently redirected every
 * concurrent `homedir()`-derived path in the process.
 * @param packageRoot - the CLI's package root.
 * @param home - the account's home directory, or `''`.
 * @param now - clock override for tests.
 * @returns the same shape `readAccount` returns.
 */
export function accountState(packageRoot, home, now = Date.now()) {
  return readAccount(packageRoot, now, typeof home === 'string' ? home : '')
}

/**
 * Read one account's credit balance from its own home.
 * @param packageRoot - the CLI's package root.
 * @param home - the account's home directory, or `''`.
 * @param options - `{ now }` for tests.
 * @returns the same shape `readCredits` returns.
 */
export async function accountCredits(packageRoot, home, options = {}) {
  return readCredits(packageRoot, { ...options, home: typeof home === 'string' ? home : '' })
}

/**
 * One pool member with everything selection needs.
 * @typedef {object} PoolMember
 * @property {AccountRow} account the row.
 * @property {boolean} signedIn whether its login session exists and is live.
 * @property {string} nickname the display name, when known.
 * @property {string} domain the login's site.
 * @property {'domestic'|'international'} deployment which manifest its models follow.
 * @property {object|undefined} credits the last credit summary, when fresh.
 * @property {string|undefined} excludedBy why it cannot serve now.
 * @property {number} retryAtMs when its cooldown ends.
 */

/**
 * Build the pool: every enabled account plus the host's own login, each with
 * its state and any cooldown still in force.
 *
 * Cooldowns live in memory, not in the registry: they are short (a rate-limit
 * window, a top-up), they mean nothing across a host restart, and persisting
 * them would make a restarted bridge refuse accounts that have long recovered.
 * @param packageRoot - the CLI's package root.
 * @param cooldowns - `Map<id, { until, reason }>` from the adapter.
 * @param now - clock override for tests.
 * @returns the members, registry order preserved.
 */
export function buildPool(packageRoot, cooldowns = new Map(), now = Date.now()) {
  const { accounts } = readAccounts()
  const rows = [...accounts, { id: 'default', home: '', label: '默认账号', enabled: true }]
  const members = []
  for (const row of rows) {
    if (row.enabled !== true) continue
    const state = accountState(packageRoot, row.home, now)
    const signedIn = state.signedIn === true
    const member = {
      account: row,
      signedIn,
      nickname: signedIn ? (state.account?.nickname ?? '') : '',
      domain: signedIn ? (state.account?.domain ?? '') : '',
      deployment: deploymentFor(signedIn ? (state.account?.domain ?? '') : ''),
      credits: undefined,
      excludedBy: undefined,
      retryAtMs: 0,
    }
    const cooldown = cooldowns.get(row.id)
    if (cooldown !== undefined && now < cooldown.until) {
      member.excludedBy = cooldown.reason
      member.retryAtMs = cooldown.until
    }
    else if (!signedIn) {
      member.excludedBy = state.reason !== '' ? 'not-signed-in' : 'unusable'
    }
    members.push(member)
  }
  return members
}

/** Maximum concurrent account-service requests. */
const CREDITS_CONCURRENCY = 4

/** Overall page budget; individual requests also have their own timeout. */
const CREDITS_OVERALL_TIMEOUT_MS = 10_000

/**
 * Attach fresh-enough credit summaries with bounded concurrency and a total
 * page deadline. A fresh read bypasses both cache layers and reaches the account
 * service; a slow account cannot hold the whole overview open indefinitely.
 * @param packageRoot - the CLI's package root.
 * @param members - the pool from {@link buildPool}, mutated in place.
 * @param options - `{ now, fresh, timeoutMs }`; a numeric legacy value means `now`.
 */
export async function attachCredits(packageRoot, members, options = {}) {
  const normalized = typeof options === 'number' ? { now: options } : options
  const now = typeof normalized.now === 'number' ? normalized.now : Date.now()
  const fresh = normalized.fresh === true
  const pending = []
  for (const member of members) {
    if (member.signedIn !== true) continue
    const cached = memberCredits.get(member.account.id)
    if (!fresh && cached !== undefined && now - cached.at < CREDITS_TTL_MS) {
      member.credits = cached.value
      continue
    }
    if (!fresh && now - (creditProbeTimes.get(member.account.id) ?? 0) < CREDITS_TTL_MS) continue
    pending.push(member)
  }
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const member = pending[cursor]
      cursor += 1
      if (!fresh) creditProbeTimes.set(member.account.id, now)
      try {
        const value = await accountCredits(packageRoot, member.account.home, { now, fresh })
        if (value.available === true) {
          memberCredits.set(member.account.id, { value, at: now })
          member.credits = value
        }
      } catch {
        // One failed account stays unavailable without blocking the others.
      }
    }
  }
  const workers = Array.from({ length: Math.min(CREDITS_CONCURRENCY, pending.length) }, () => worker())
  const timeoutMs = Number.isSafeInteger(normalized.timeoutMs) && normalized.timeoutMs > 0
    ? normalized.timeoutMs
    : CREDITS_OVERALL_TIMEOUT_MS
  let timer
  try {
    await Promise.race([
      Promise.all(workers),
      new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Last credit-probe time per account id, so page refreshes do not hammer the endpoint. */
const creditProbeTimes = new Map()

/** Cached credit summaries per account id. */
const memberCredits = new Map()

/**
 * Rank the pool best-first.
 *
 * 1. usable outranks excluded;
 * 2. among the usable, more credits first (an account about to run dry is the
 *    worst daily driver, and there is no expiry tracking to weigh against);
 * 3. among the excluded, the one whose cooldown ends first goes first, so the
 *    "why excluded" list reads in the order relief arrives.
 * @param members - the pool from {@link buildPool}.
 * @returns the same members, best first.
 */
export function rankPool(members) {
  const creditOf = member => (member.credits?.available === true ? member.credits.total : -1)
  return [...members].sort((left, right) => {
    const leftUsable = left.excludedBy === undefined
    const rightUsable = right.excludedBy === undefined
    if (leftUsable !== rightUsable) return leftUsable ? -1 : 1
    if (leftUsable) {
      const byCredits = creditOf(right) - creditOf(left)
      if (byCredits !== 0) return byCredits
      return left.account.id < right.account.id ? -1 : 1
    }
    if (left.retryAtMs !== right.retryAtMs) return left.retryAtMs - right.retryAtMs
    return left.account.id < right.account.id ? -1 : 1
  })
}

/**
 * Pick the account that serves the next turn.
 * @param packageRoot - the CLI's package root.
 * @param cooldowns - the adapter's cooldown map.
 * @param now - clock override for tests.
 * @returns the member, or `undefined` when nothing is usable.
 */
export function pickAccount(packageRoot, cooldowns = new Map(), now = Date.now()) {
  const pool = rankPool(buildPool(packageRoot, cooldowns, now))
  return pool.find(member => member.excludedBy === undefined)
}

/**
 * Cooldown to apply for one failure outcome.
 * @param outcome - `'rate-limited'`, `'exhausted'`, or `'failed'`.
 * @param now - clock override for tests.
 * @returns `{ until, reason }`.
 */
export function cooldownFor(outcome, now = Date.now()) {
  if (outcome === 'rate-limited') return { until: now + RATE_LIMIT_COOLDOWN_MS, reason: 'rate-limited' }
  if (outcome === 'exhausted') return { until: now + EXHAUSTED_COOLDOWN_MS, reason: 'out-of-credit' }
  return { until: now + FAILED_COOLDOWN_MS, reason: 'failed' }
}
