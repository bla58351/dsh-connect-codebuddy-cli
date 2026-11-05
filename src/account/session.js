/**
 * Read what the plugin page shows about the local CodeBuddy installation.
 *
 * The CLI keeps its login session on disk, in the shared data directory of the
 * Tencent CodeBuddy extension. That file is the only local source of the signed
 * in account: the CLI's `--version`, `config list`, and its `stream-json` frames
 * carry no account identity, and it exposes no usage or balance API at all
 * (`/api/v1/auth/account/status` is the local web server's password login, not
 * the CodeBuddy account), so anything about credits would have to be invented.
 *
 * Only non-secret fields are returned. The access and refresh tokens in that
 * file are never read out of it: the page has no use for them, and copying a
 * bearer token into a browser reply would be a credential leak.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Directory (relative to `%LOCALAPPDATA%`) holding the extension's shared data. */
const SHARED_DATA = join('CodeBuddyExtension', 'Data', 'Public')

/** Folder under the shared data that one auth session file lives in. */
const AUTH_FOLDER = 'auth'

/** Auth id used when the product manifest cannot be read. */
const DEFAULT_AUTH_ID = 'Tencent-Cloud.coding-copilot'

/** How long a probed CLI version stays trusted, so the page can be reopened freely. */
const VERSION_TTL_MS = 5 * 60 * 1000

/** Last probed version, keyed by CLI entry. */
const versionCache = new Map()

/**
 * Locate the CLI and describe it.
 *
 * @param cli - the adapter's resolved CLI (`{ ok, entry, packageRoot, reason }`).
 * @param probeVersion - whether to run `--version` (offline callers pass false).
 * @returns a plain status object safe to send to the browser.
 */
export async function cliStatus(cli, probeVersion = true) {
  if (cli === null || typeof cli !== 'object' || cli.ok !== true) {
    return {
      installed: false,
      state: 'cli-missing',
      entry: '',
      packageRoot: '',
      version: '',
      reason: typeof cli?.reason === 'string' && cli.reason !== '' ? cli.reason : '没有找到本机安装的 CodeBuddy CLI。',
    }
  }
  const version = probeVersion ? await readCliVersion(cli.entry) : ''
  return {
    installed: true,
    state: 'cli-ready',
    entry: cli.entry,
    packageRoot: cli.packageRoot,
    version,
    reason: '',
  }
}

/**
 * Read the CLI's version string, spawning it at most once per few minutes.
 *
 * `--version` prints a bare version and exits, so this neither spends a model
 * call nor touches the account's quota. A failure is cached too: a broken
 * install should not be re-spawned on every page refresh.
 *
 * @param entry - absolute path to the CLI's JS entry.
 * @returns the version text, or `''` when it could not be read.
 */
export async function readCliVersion(entry) {
  const key = typeof entry === 'string' ? entry : ''
  if (key === '') return ''
  const cached = versionCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < VERSION_TTL_MS) return cached.version
  const version = await spawnVersion(key)
  versionCache.set(key, { version, at: Date.now() })
  return version
}

/**
 * Run `--version` once and collect the first non-empty output line.
 * @param entry - absolute path to the CLI's JS entry.
 * @returns the parsed version, or `''`.
 */
function spawnVersion(entry) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawn(process.execPath, [entry, '--version'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish('')
    }, 10_000)
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.on('error', () => finish(''))
    child.on('close', () => {
      const line = out.split('\n').map(text => text.trim()).find(text => text !== '') ?? ''
      finish(line)
    })
  })
}

/**
 * Whether the CLI can be authenticated from the environment instead of a file.
 *
 * The CLI accepts its own token through `CODEBUDDY_AUTH_TOKEN`/`CODEBUDDY_API_KEY`.
 * A deployment using either does not need the login session file, so the
 * "not signed in" pre-flight check must not fire there. Lives beside the login
 * readers: the adapter needs the same answer and must not depend on the host
 * page for it.
 * @returns true when one of those variables is set.
 */
export function hasEnvironmentToken() {
  for (const name of ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return true
  }
  return false
}

/** Hosts that route to the domestic deployment. */
const DOMESTIC_HOSTS = ['.codebuddy.cn', '.workbuddy.cn', '.tencent.com']

/**
 * Which deployment this session is signed in to.
 *
 * The CLI ships one product manifest per deployment and their numbers differ —
 * the international build lists `deepseek-v4.1-flash` at ×0.00 while the domestic
 * build charges ×0.03 for the same id. The login session records the site the
 * account belongs to (`auth.domain`), and that is what decides which file holds
 * the multipliers this account is actually charged.
 *
 * @param domain - the account's site, as recorded in the session file.
 * @returns `'domestic'` or `'international'`.
 */
export function deploymentFor(domain) {
  const value = typeof domain === 'string' ? domain.trim().toLowerCase() : ''
  if (value === '') return 'international'
  const bare = value.replace(/^[a-z]+:\/\//u, '').replace(/\/.*$/u, '')
  if (DOMESTIC_HOSTS.some(host => bare === host.slice(1) || bare.endsWith(host))) return 'domestic'
  return 'international'
}

/**
 * Read the signed-in account and its session metadata.
 *
 * @param packageRoot - the CLI's package root, used to find the product's auth id.
 * @param now - clock override for tests.
 * @param home - the account's home directory, or `''` for this process's own login.
 * @returns a plain account object; `signedIn: false` when no session exists.
 */
export function readAccount(packageRoot, now = Date.now(), home = '') {
  const authId = readAuthId(packageRoot)
  const directory = authDirectory(home)
  if (directory === '') {
    return { signedIn: false, state: 'no-shared-data', reason: '没有找到 CodeBuddy 的共享数据目录（%LOCALAPPDATA%/CodeBuddyExtension）。', account: undefined }
  }
  const file = findAuthFile(directory, authId)
  if (file === '') {
    return { signedIn: false, state: 'not-signed-in', reason: '没有找到登录会话文件，可能尚未登录 CodeBuddy CLI。', account: undefined }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { signedIn: false, state: 'unreadable', reason: `登录会话文件无法解析：${messageOf(error)}`, account: undefined }
  }
  const account = pickAccount(parsed, now)
  if (account === undefined) {
    return { signedIn: false, state: 'no-account', reason: '登录会话文件里没有账号信息。', account: undefined }
  }
  if (account.expired === true) {
    return { signedIn: false, state: 'expired', reason: '登录会话已经过期，需要重新登录 CodeBuddy CLI。', file, account }
  }
  return { signedIn: true, state: 'signed-in', reason: '', file, account }
}

/** How long a credit summary stays cached, so opening the page is not a request storm. */
const CREDITS_TTL_MS = 30_000

/** How long the credit request may take before it is reported as unavailable. */
const CREDITS_TIMEOUT_MS = 8_000

/** Cached credit summaries, keyed by the session file they came from. */
const creditsCache = new Map()

/**
 * Read the account's remaining credits (积分).
 *
 * The CLI itself exposes no balance anywhere: it only mentions credits inside a
 * rejected request ("credits exhausted", with a purchase link), and its model
 * catalog carries per-model consumption multipliers, not a balance. The number
 * lives in the account service the CodeBuddy console calls, and the CLI's own
 * login token authorizes it: `POST /billing/meter/get-user-resource-summary`
 * answers with the remaining total plus a per-source breakdown (plan base,
 * plan bonus, purchased, platform rewards).
 *
 * The token is read here and used here; it is never returned to the caller, so
 * it cannot reach the browser.
 *
 * @param packageRoot - the CLI's package root, used to find the product's auth id.
 * @param options - `{ now }`, `{ fresh: true }` to bypass the cache, or `{ home }`
 *   to read a specific account home's session instead of this process's own.
 * @returns the summary, or an `available: false` record explaining why not.
 */
export async function readCredits(packageRoot, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const home = typeof options.home === 'string' ? options.home : ''
  const authId = readAuthId(packageRoot)
  const directory = authDirectory(home)
  if (directory === '') {
    return { available: false, reason: '没有找到 CodeBuddy 的账号目录，无法读取积分。' }
  }
  const file = findAuthFile(directory, authId)
  if (file === '') {
    return { available: false, reason: '尚未登录 CodeBuddy CLI，无法读取积分。' }
  }
  const cached = creditsCache.get(file)
  if (options.fresh !== true && cached !== undefined && now - cached.at < CREDITS_TTL_MS) {
    return cached.value
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { available: false, reason: `登录会话文件无法解析：${messageOf(error)}` }
  }
  const token = parsed?.auth?.accessToken
  const domain = typeof parsed?.auth?.domain === 'string' && parsed.auth.domain !== '' ? parsed.auth.domain : 'www.codebuddy.cn'
  if (typeof token !== 'string' || token === '') {
    return { available: false, reason: '登录会话里没有访问令牌，无法读取积分。' }
  }
  const value = await requestCredits(domain, token)
  // Only a successful read is cached: a network blip should be retried on the
  // next open rather than pinned for half a minute.
  if (value.available === true) creditsCache.set(file, { value, at: now })
  return value
}

/**
 * Ask the account service for the credit summary.
 *
 * @param domain - the account's site, taken from the login session.
 * @param token - the session's bearer token.
 * @param fetchImpl - the fetch implementation, injectable for tests.
 * @returns the normalized summary.
 */
export async function requestCredits(domain, token, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return { available: false, reason: '当前运行环境没有 fetch，无法读取积分。' }
  }
  let response
  try {
    response = await fetchImpl(`https://${domain}/billing/meter/get-user-resource-summary`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    })
  } catch (error) {
    return { available: false, reason: `请求积分接口失败：${messageOf(error)}` }
  }
  if (!response.ok) {
    return { available: false, reason: `积分接口返回 HTTP ${response.status}。` }
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return { available: false, reason: `积分接口的响应无法解析：${messageOf(error)}` }
  }
  if (payload?.code !== 0) {
    const detail = typeof payload?.msg === 'string' && payload.msg !== '' ? payload.msg : `code ${String(payload?.code)}`
    return { available: false, reason: `积分接口拒绝了请求：${detail}` }
  }
  return summarizeCredits(payload.data)
}

/**
 * Reduce the account service's answer to what the page shows.
 *
 * Every number arrives as a decimal string; they are parsed once here so the
 * browser never has to do string arithmetic, and so a missing field degrades to
 * zero instead of `NaN`.
 *
 * @param data - the `data` member of the account service's reply.
 * @returns the display summary.
 */
export function summarizeCredits(data) {
  const total = numberOr(data?.TotalCredits, 0)
  const groups = Array.isArray(data?.CreditGroups)
    ? data.CreditGroups.map(group => ({
      name: typeof group?.Name === 'string' && group.Name !== '' ? group.Name : '积分',
      kind: typeof group?.Kind === 'string' ? group.Kind : '',
      remain: numberOr(group?.CycleRemainCapacity, 0),
      total: numberOr(group?.CycleTotalCapacity, 0),
      used: numberOr(group?.CycleUsedCapacity, 0),
      packs: numberOr(group?.TotalCount, 0),
    }))
    : []
  const used = groups.reduce((sum, group) => sum + group.used, 0)
  const granted = groups.reduce((sum, group) => sum + group.total, 0)
  return {
    available: true,
    reason: '',
    total,
    // The groups already account for every credit, so the used figure is their
    // sum; `granted` is what was ever issued in this cycle.
    used: used > 0 ? used : Math.max(0, granted - total),
    granted,
    plan: typeof data?.SubscriptionPackageName === 'string' ? data.SubscriptionPackageName : '',
    paid: data?.IsPaidUser === true,
    groups: groups.filter(group => group.total > 0 || group.remain > 0),
  }
}

/**
 * Parse a decimal string or number.
 * @param value - the raw value.
 * @param fallback - what to use when it is not a finite number.
 * @returns the number.
 */
function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Reduce the auth file to the fields the page displays.
 *
 * Expiry is worked out here rather than in the browser so the page cannot show
 * a stale "已过期" state after the session file changed on disk.
 *
 * @param parsed - the parsed auth session file.
 * @param now - clock override for tests.
 * @returns the display account, or `undefined` when the file carries no account.
 */
function pickAccount(parsed, now) {
  const account = parsed?.account
  if (account === null || typeof account !== 'object') return undefined
  const auth = parsed?.auth !== null && typeof parsed?.auth === 'object' ? parsed.auth : {}
  const expiresAt = typeof auth.expiresAt === 'number' ? auth.expiresAt : 0
  const issuedAt = typeof auth.lastRefreshTime === 'number' ? auth.lastRefreshTime : 0
  return {
    nickname: textOr(account.nickname, ''),
    phone: textOr(account.phoneNumber, ''),
    uin: textOr(account.uin, ''),
    kind: textOr(account.type, ''),
    domain: textOr(auth.domain, ''),
    enterprise: account.isCurrentOneIdEnterprise === true,
    accounts: Array.isArray(parsed?.accounts) ? parsed.accounts.length : 1,
    expiresAt,
    issuedAt,
    expired: expiresAt > 0 ? now >= expiresAt : false,
  }
}

/**
 * Whether the shared data directory exists at all.
 * @param home - the account's home directory, or `''` for this process's own.
 * @returns the auth directory path, or `''` when the platform has none.
 */
function authDirectory(home = '') {
  // The CLI derives this from its own `homedir()` — `USERPROFILE` on Windows,
  // `HOME` elsewhere — so an account's directory is derived from the account's
  // home argument, never by mutating this process's environment: a mutated
  // `USERPROFILE` stayed in force across the `await` points of a credit probe
  // and silently redirected every concurrent `homedir()` read.
  const base = typeof home === 'string' && home !== '' ? home : homedir()
  if (process.platform === 'win32') {
    // When the home has been redirected, the per-account `AppData\\Local` lives
    // under that home, which is what the CLI itself joins.
    return join(base, 'AppData', 'Local', SHARED_DATA, AUTH_FOLDER)
  }
  if (process.platform === 'darwin') return join(base, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', AUTH_FOLDER)
  return join(base, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', AUTH_FOLDER)
}

/**
 * Read the product's auth id from its manifest, falling back to the known id.
 * @param packageRoot - the CLI's package root.
 * @returns the auth id used in the session file's name.
 */
function readAuthId(packageRoot) {
  if (typeof packageRoot !== 'string' || packageRoot === '') return DEFAULT_AUTH_ID
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'product.json'), 'utf8'))
    const id = manifest?.authentication?.id
    return typeof id === 'string' && id !== '' ? id : DEFAULT_AUTH_ID
  } catch {
    return DEFAULT_AUTH_ID
  }
}

/**
 * Find the session file for one auth id.
 *
 * The name is `${authId}.info`; scanning is the fallback because the manifest
 * can name an id this build never wrote (`workbuddy-desktop.info` and friends
 * live in the same folder).
 *
 * @param directory - the auth folder.
 * @param authId - the expected auth id.
 * @returns the path to use, or `''`.
 */
function findAuthFile(directory, authId) {
  const exact = join(directory, `${authId}.info`)
  if (existsSync(exact)) return exact
  let entries
  try {
    entries = readdirSync(directory)
  } catch {
    return ''
  }
  for (const name of entries) {
    if (!name.endsWith('.info')) continue
    const candidate = join(directory, name)
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (parsed?.auth?.accessToken !== undefined && parsed?.account !== undefined) return candidate
    } catch {
      // Not a session file (an observation sidecar, or a half-written file).
    }
  }
  return ''
}

/**
 * Coerce an optional string field.
 * @param value - the raw value.
 * @param fallback - what to use when it is not a string.
 * @returns the string, or the fallback.
 */
function textOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * Describe an error without leaking anything but its message.
 * @param error - the thrown value.
 * @returns the message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}