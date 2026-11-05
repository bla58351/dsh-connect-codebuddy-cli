/**
 * Locating, launching, and reading the CodeBuddy CLI.
 *
 * This module owns everything that is about the CLI as a *process*: where its
 * JS entry lives, which argv/env a one-turn call needs, how its NDJSON frames
 * are decoded, and how a live child is torn down. It knows nothing about
 * DSH's `LlmAdapter` contract — `index.js` translates frames into chunks.
 *
 * ## Why the JS entry and never the shim
 *
 * The installed `codebuddy`/`cbc` commands on PATH are `.cmd` batch wrappers.
 * Spawning one means going through `cmd.exe`, which re-parses the command line
 * and would re-interpret values this adapter passes (`--model`,
 * `--session-id`, the system-prompt path). We therefore always run
 * `node <package>/bin/codebuddy` with `shell: false`, and there is deliberately
 * no fallback to whatever `codebuddy` happens to be first on PATH: that
 * process would inherit the user's CodeBuddy login.
 *
 * @module dsh-connect-codebuddy-cli/cli
 */

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** The JS entry, relative to a global `node_modules` directory. */
const CLI_PACKAGE_PATH = join('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')

/**
 * The product manifests that ship beside the entry, relative to the package root.
 *
 * The CLI bundles one file per deployment and their numbers differ: the
 * international build bills `deepseek-v4.1-flash` at ×0.00, the domestic IoA
 * build charges ×0.11 for the same id. Reading the wrong file shows a
 * multiplier the account is not actually charged — that is exactly the bug this
 * mapping exists to prevent.
 */
const PRODUCT_MANIFESTS = {
  international: 'product.json',
  domestic: 'product.ioa.json',
}

/**
 * Suffix the domestic deployment puts on its own roster ids.
 *
 * The domestic manifest lists most models as `glm-5.3-ioa` rather than
 * `glm-5.3`, while the CLI's own `--model` help advertises the unsuffixed id.
 * The suffix is a deployment naming detail, not a different model: where both
 * spellings exist they carry the same multiplier (`glm-5.3` and `glm-5.3-ioa`
 * are both ×0.79).
 */
const DOMESTIC_ID_SUFFIX = '-ioa'

/** The manifest used when the deployment cannot be determined. */
const PRODUCT_MANIFEST = PRODUCT_MANIFESTS.international

/** Terminal frames larger than this are treated as corruption, not data. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** How long a killed child gets to exit before we stop waiting for it. */
const EXIT_GRACE_MS = 3000

/**
 * Every directory a global install of the CLI could live in, most likely first.
 *
 * Each entry spells out its own layout because a global npm prefix is not
 * shaped the same way on every platform: on POSIX a prefix holds
 * `<prefix>/lib/node_modules`, while on Windows `%APPDATA%\npm` holds
 * `<npm>/node_modules` directly and has no `lib` level at all.
 * @returns candidate `node_modules` roots, deduplicated.
 */
function cliModuleDirs() {
  const home = homedir()
  const dirs = []
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') dirs.push(join(appData, 'npm', 'node_modules'))
  dirs.push(join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))
  for (const prefix of [join(home, '.npm-global'), '/usr/local', '/opt/homebrew', join(home, '.local')]) {
    dirs.push(join(prefix, 'lib', 'node_modules'))
  }
  dirs.push(join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules'))
  dirs.push(join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'))
  const localAppData = process.env['LOCALAPPDATA']
  if (typeof localAppData === 'string' && localAppData !== '') {
    dirs.push(join(localAppData, 'pnpm', 'global', '5', 'node_modules'))
    dirs.push(join(localAppData, 'Yarn', 'Data', 'global', 'node_modules'))
  }
  dirs.push(join(home, '.config', 'yarn', 'global', 'node_modules'))
  return dirs
}

/**
 * Version-manager roots whose install path carries a version segment, so each
 * needs one level of expansion rather than a fixed suffix.
 * @returns candidate version roots.
 */
function versionedCliRoots() {
  const home = homedir()
  const roots = [
    join(home, '.nvm', 'versions', 'node'),
    join(home, 'n', 'versions', 'node'),
    join(home, '.fnm', 'node-versions'),
    join(home, '.local', 'share', 'fnm', 'node-versions'),
    join(home, '.volta', 'tools', 'image', 'node'),
  ]
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') roots.push(join(appData, 'fnm', 'node-versions'))
  return roots
}

/**
 * Expand one directory's children into CLI entries, ignoring unreadable ones.
 * @param dir - version root to enumerate.
 * @param separator - path segments appended below each child.
 * @returns candidate entry paths, possibly empty.
 */
function childrenOf(dir, separator) {
  const out = []
  try {
    for (const child of readdirSync(dir)) out.push(join(dir, child, ...separator))
  } catch {
    // A missing version manager is not an error; it just contributes nothing.
  }
  return out
}

/**
 * Every path a global install of the CLI could live at, most likely first.
 * @returns candidate entry paths, deduplicated.
 */
export function cliEntryCandidates() {
  const out = [...cliModuleDirs().map(dir => join(dir, CLI_PACKAGE_PATH))]
  for (const versions of versionedCliRoots()) {
    out.push(...childrenOf(versions, ['lib', 'node_modules', CLI_PACKAGE_PATH]))
    out.push(...childrenOf(versions, ['installation', 'lib', 'node_modules', CLI_PACKAGE_PATH]))
  }
  return [...new Set(out)]
}

/**
 * Resolve the CLI's JS entry file.
 * @param configured - an explicit entry path from plugin config, or `''`.
 * @returns the entry path plus the package root, or a reason the route cannot run.
 */
export function resolveCliEntry(configured) {
  const binary = typeof configured === 'string' ? configured.trim() : ''
  if (binary !== '') {
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(binary)) {
      return {
        ok: false,
        entry: '',
        packageRoot: '',
        reason:
          `cli.binary 指向了 ${binary}，那是一个批处理包装；运行它要经过 cmd.exe，会把 --model / --session-id ` +
          `当成命令解释。请改成同一个包里的 JS 入口（…/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy）。`,
      }
    }
    if (!existsSync(binary)) {
      return { ok: false, entry: '', packageRoot: '', reason: `cli.binary 指定的路径不存在：${binary}` }
    }
    return { ok: true, entry: binary, packageRoot: packageRootOf(binary) }
  }
  for (const candidate of cliEntryCandidates()) {
    if (existsSync(candidate)) return { ok: true, entry: candidate, packageRoot: packageRootOf(candidate) }
  }
  return {
    ok: false,
    entry: '',
    packageRoot: '',
    reason:
      '没有找到本机安装的 CodeBuddy CLI（已查过 npm/pnpm/yarn 全局目录与 nvm/fnm/volta 的版本目录）。' +
      '请先安装 @tencent-ai/codebuddy-code，或在插件配置里用 cli.binary 指定它的绝对路径' +
      '（要指向包内的 bin/codebuddy，不要指向 .cmd 包装）。不会回退到 PATH 上的 codebuddy —— ' +
      '那样会把 CodeBuddy 登录凭据交给一个来源不明的程序。',
  }
}

/**
 * The package root that owns one resolved entry.
 * @param entry - `<root>/bin/codebuddy`.
 * @returns `<root>`, or `''` when the entry is not laid out that way.
 */
function packageRootOf(entry) {
  const marker = `${join('bin', 'codebuddy')}`
  return entry.endsWith(marker) ? entry.slice(0, -marker.length).replace(/[\\/]$/u, '') : ''
}

/**
 * The manifest file a deployment's multipliers come from.
 * @param deployment - `'domestic'` or `'international'`.
 * @returns the file name, relative to the package root.
 */
export function productManifestFor(deployment) {
  return PRODUCT_MANIFESTS[deployment] ?? PRODUCT_MANIFEST
}

/**
 * Read the CLI's model catalog from the product manifest.
 *
 * The manifest is authoritative for *display* facts (names, context windows,
 * image support, effort ladders). It is deliberately NOT authoritative for
 * *membership*: it also lists models this account cannot call, so the
 * selectable set comes from the CLI's own `--model` help text (see
 * `catalog.js`). Only the ids present in both are advertised.
 * @param packageRoot - resolved package root, or `''`.
 * @returns `{ id → manifest entry }`, empty when the manifest is unreadable.
 */
export function readProductModels(packageRoot, deployment = 'international') {
  if (packageRoot === '') return new Map()
  const file = PRODUCT_MANIFESTS[deployment] ?? PRODUCT_MANIFEST
  const path = join(packageRoot, file)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const models = Array.isArray(parsed?.models) ? parsed.models : []
    const byId = new Map()
    for (const model of models) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      byId.set(model.id, model)
    }
    // Answer to the id the CLI advertises as well as the deployment's own
    // spelling, but never let an alias overwrite a real entry.
    for (const model of models) {
      if (typeof model?.id !== 'string' || !model.id.endsWith(DOMESTIC_ID_SUFFIX)) continue
      const base = model.id.slice(0, -DOMESTIC_ID_SUFFIX.length)
      if (base !== '' && !byId.has(base)) byId.set(base, model)
    }
    return byId
  } catch {
    return new Map()
  }
}

/**
 * Ask the CLI for the model catalog its own `/model` menu shows.
 *
 * The TUI menu, the Web UI's model list, and ACP clients all read the same
 * `getModelsInfo` answer, and ACP is the only one of those a bridge can ask
 * without a terminal: `initialize` then `session/new` returns
 * `models.availableModels`, each entry carrying `_meta.credits`.
 *
 * This is the multiplier that matters. It is neither the bundled international
 * manifest nor the domestic one: for `glm-5.3` the catalog says ×0.69 while both
 * files say ×0.79, and `deepseek-v4.1-flash` is ×0.11 where the international
 * file says ×0.00. Reading a file therefore cannot reproduce the menu.
 *
 * Costs no model call — no prompt is ever sent — but it does start a second CLI
 * process, so callers cache the answer.
 *
 * @param entry - resolved JS entry.
 * @param cwd - working directory for the probe session.
 * @param options - `{ timeoutMs, env }`; `env` carries the serving account's home overrides.
 * @returns `{ ok: true, models: Map<id, {name, credits}> }` or `{ ok: false, reason }`.
 */
export function probeAcpModelCatalog(entry, cwd, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20_000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [entry, '--acp', '--no-session-persistence'], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
        env: { ...process.env, ...(options.env !== null && typeof options.env === 'object' ? options.env : {}) },
      })
    } catch (error) {
      resolve({ ok: false, reason: `无法启动 CLI：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let settled = false
    let buffer = ''
    const models = new Map()
    const timer = setTimeout(() => finish({ ok: false, reason: '等待模型目录超时' }), timeoutMs)
    /**
     * Settle once, and always leave the probe process gone.
     * @param value - the outcome.
     */
    function finish(value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch {}
      try { child.kill() } catch {}
      resolve(value)
    }
    /** Write one JSON-RPC message. */
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch {}
    }
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame?.id === 1) {
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd(), mcpServers: [] } })
          continue
        }
        if (frame?.id !== 2) continue
        const available = frame?.result?.models?.availableModels
        if (!Array.isArray(available)) {
          finish({ ok: false, reason: 'CLI 没有返回模型目录' })
          return
        }
        for (const model of available) {
          const id = typeof model?.modelId === 'string' ? model.modelId : ''
          if (id === '') continue
          models.set(id, {
            name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
            credits: typeof model?._meta?.credits === 'string' ? model._meta.credits : '',
          })
        }
        finish({ ok: true, models })
      }
    })
    child.on('error', (error) => finish({ ok: false, reason: `CLI 进程出错：${error instanceof Error ? error.message : String(error)}` }))
    child.on('close', () => finish({ ok: false, reason: 'CLI 在返回模型目录前退出' }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  })
}

/**
 * Read the model ids the installed CLI advertises on its own command line.
 *
 * `--help` is a static string in the CLI build, so this is the one membership
 * answer that needs no network, no login, and no per-model probe.
 * @param entry - resolved JS entry.
 * @returns the advertised ids in CLI order, or `[]` when help cannot be read.
 */
export function readAdvertisedModelIds(entry) {
  try {
    const help = readHelpText(entry)
    if (help === '') return []
    const match = /--model <model>[\s\S]*?Currently supported: \(([^)]*)\)/u.exec(help)
    if (match === null) return []
    return match[1]
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '')
  } catch {
    return []
  }
}

/** How long a captured `--help` text stays trusted, keyed by entry. */
const HELP_TTL_MS = 10 * 60 * 1000

/** Captured help texts with the time they were read; failures are cached too. */
const helpCache = new Map()

/**
 * Extract the CLI's `--help` output.
 *
 * The help string lives in the package's build output, but the exact file that
 * carries it differs between releases, so this asks the CLI itself. The spawn
 * is synchronous — `listModels()` may be called while building the GUI catalog
 * — so the answer is cached for a few minutes: without it, every model-picker
 * refresh, page open, and warm-up froze the host's event loop for the full
 * start-up of a child process. A failed read is cached briefly as well, so a
 * broken install is not re-spawned on every catalog read.
 * @param entry - resolved JS entry.
 * @returns the help text, or `''` when it could not be captured.
 */
function readHelpText(entry) {
  const key = typeof entry === 'string' ? entry : ''
  if (key === '') return ''
  const cached = helpCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < HELP_TTL_MS) return cached.text
  const text = readHelpTextUncached(key)
  helpCache.set(key, { text, at: Date.now() })
  return text
}

/** Run `--help` once. */
function readHelpTextUncached(entry) {
  try {
    const out = execFileSync(process.execPath, [entry, '--help'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof out === 'string' ? out : ''
  } catch (error) {
    // `--help` exits non-zero on some builds while still printing usage.
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    return stdout
  }
}

/**
 * Derive the CodeBuddy session id that carries one DSH session's history.
 *
 * The CLI treats `--session-id` as create-or-resume and stores it as a file
 * name under `~/.codebuddy/projects/<cwd-slug>/`, so the value must be
 * filename-safe on every platform. DSH session ids are opaque and may contain
 * anything (`:` is legal there and fatal here), so this maps them into a
 * stable lowercase slug with a short content hash to keep distinct DSH
 * sessions distinct.
 * @param sessionId - DSH session id, or `undefined` for a one-off turn.
 * @returns a filename-safe CodeBuddy session id.
 */
export function codebuddySessionId(sessionId) {
  const source = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'anonymous'
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return `dsh-${slug === '' ? 'session' : slug}-${hash.toString(16).padStart(8, '0')}`
}

/**
 * Where the CLI will persist one session's transcript.
 *
 * The CLI stores each session as `<sessionId>.jsonl` under
 * `~/.codebuddy/projects/<cwd-slug>/` — observed on disk rather than
 * documented, so this resolves both segments the same way the CLI's own
 * storage does and treats any unreadable path as "no transcript".
 * @param cwd - the working directory the CLI will run in, or `undefined`.
 * @param sessionId - the CodeBuddy session id.
 * @param configDir - the serving account's explicit CLI config dir, or `''` for the host account.
 * @returns the transcript path, or `''` when it cannot be determined.
 */
export function codebuddyTranscriptPath(cwd, sessionId, configDir = '') {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const directory = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  // Observed layout: `E:\Docs\a b` -> `e-Docs-a-b`. The drive letter is
  // lowercased and joined by a dash, case is preserved, and every run of
  // non-alphanumerics (colon, backslash, slash, spaces) collapses to one dash.
  // A POSIX-style Git-Bash cwd (`/e/...`) is normalized to its Windows form
  // first, because the CLI itself always runs Windows-native here.
  let windows = directory.split('\\').join('/')
  if (/^\/[A-Za-z]\//u.test(windows)) windows = `${windows[1].toUpperCase()}:${windows.slice(2)}`
  const slug = windows
    .replace(/^([A-Za-z]):\//u, (_, drive) => `${drive.toLowerCase()}-`)
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  // The CLI resolves its config root in this same order: `CODEBUDDY_CONFIG_DIR`
  // first, then `CODEBUDDY_HOME`, then `~/.codebuddy`. The account pool pins
  // `CODEBUDDY_CONFIG_DIR` per account home, so the transcript path computed for
  // a pooled account only lands on the file the CLI actually writes when this
  // reads the same variable first — a mismatch made rollback deletion and the
  // handoff "transcript exists" check silent no-ops.
  const home = typeof configDir === 'string' && configDir !== ''
    ? configDir
    : process.env.CODEBUDDY_CONFIG_DIR ?? process.env.CODEBUDDY_HOME ?? join(homedir(), '.codebuddy')
  return join(home, 'projects', slug === '' ? '-' : slug, `${sessionId}.jsonl`)
}

// The chat prompt moved to prompt.js so the settings page can show the exact
// text it defaults to; re-exported here for the tests that check it.
import { CHAT_SYSTEM_PROMPT } from '../config/prompt.js'

export { CHAT_SYSTEM_PROMPT }


/**
 * How many agent-loop turns one CLI call may take.
 *
 * A turn that uses tools is not one round trip: the CLI runs the whole loop
 * itself (call tool, read the result, call another, then answer), and the cap
 * counts *model calls*, not tool calls. Tool calls issued in one model turn are
 * free; a step that has to wait for each result before deciding the next one
 * costs a turn per step. A single tool-using answer was measured at 5–18 turns,
 * and a task that walks a list one element at a time crosses 30 while behaving
 * perfectly reasonably — `--max-turns 30` failed such a run at exactly turn 30.
 *
 * The value therefore matches what the CLI itself uses when no flag is given
 * (`resolveDefaultMaxTurns` falls back to 200 in print mode), so the bridge
 * bounds a runaway loop no more tightly than the CLI would on its own, and an
 * ordinary long task no longer dies halfway. `maxTurns` overrides it per call.
 */
const DEFAULT_MAX_TURNS = 200

/** Lazily created private directory holding per-process prompt and MCP files. */
let scratchDir = ''

/**
 * Create the process's private scratch directory once.
 *
 * `mkdtempSync` avoids predictable shared names; the explicit chmod also covers
 * platforms whose default directory mode would otherwise let another local user
 * read the MCP bearer token. Windows ignores POSIX modes and uses the temp ACL.
 * @returns the private scratch directory.
 */
function ensureScratchDir() {
  if (scratchDir === '') {
    scratchDir = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-'))
    if (process.platform !== 'win32') chmodSync(scratchDir, 0o700)
  }
  return scratchDir
}

/** Keep a caller-supplied key from becoming a path or an overlong single name. */
function scratchKeyFor(key) {
  const value = typeof key === 'string' && key !== '' ? key : 'shared'
  return value.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 160)
}

/** Write one private file, tightening an existing file's mode on rewrite too. */
function writePrivateFile(path, body) {
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
}

/**
 * Prompts already on disk, keyed by the session key the caller passed.
 *
 * One file per session is what makes concurrent CLI launches safe: a side
 * request (the session title) and the real turn each spawn a CLI that reads
 * the prompt file seconds after being started, so a single shared file was
 * rewritten by whichever session resolved its prompt last — and any session's
 * `close()` deleted it out from under the other. Both files also record the
 * text they hold, so an unchanged prompt is not rewritten on reuse.
 */
const scratchPrompts = new Map()

/**
 * Write a system prompt to a file the CLI can read.
 *
 * The prompt is passed by file rather than by argv so it cannot be re-parsed as
 * a command line and does not count against platform argv limits.
 *
 * An empty prompt means "let the CLI use its own": the caller gets `''` back and
 * must not pass `--system-prompt-file`, which is how the CodeBuddy-prompt mode
 * works.
 * @param text - the prompt to write; defaults to the bridge's chat brief.
 * @param key - which session this prompt belongs to; distinct sessions get
 *   distinct files so a concurrent launch cannot read another's rules.
 * @returns the absolute path of the prompt file, or `''` for no override.
 */
export function writeSystemPromptFile(text = CHAT_SYSTEM_PROMPT, key = 'shared') {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') return ''
  const sessionKey = scratchKeyFor(key)
  const cached = scratchPrompts.get(sessionKey)
  const path = join(ensureScratchDir(), `chat-system-prompt-${sessionKey}.txt`)
  if (cached === undefined || cached.path !== path || cached.body !== body) {
    writePrivateFile(path, body)
    scratchPrompts.set(sessionKey, { path, body })
  }
  return path
}

/**
 * Remove one session's prompt file.
 *
 * Called when that session's CLI is gone. Only the named file goes: an earlier
 * spelling deleted a single shared file, which could remove the prompt a
 * concurrently launching CLI had not read yet.
 * @param key - the session key the prompt was written under.
 */
export function cleanupSystemPromptFile(key = 'shared') {
  const sessionKey = scratchKeyFor(key)
  const cached = scratchPrompts.get(sessionKey)
  if (cached === undefined) return
  scratchPrompts.delete(sessionKey)
  try {
    unlinkSync(cached.path)
  } catch {
    // Best effort: the OS will clean the temp directory anyway.
  }
}

/** MCP files owned by individual CLI processes, keyed like prompt files. */
const scratchMcpConfigs = new Map()

/**
 * Write one CLI call's `--mcp-config` payload to a private file.
 *
 * There is deliberately no inline-JSON fallback: a temporary-file failure must
 * disable this optional bridge, not put its bearer token on the process command
 * line. Each process owns a distinct key, so its close cannot delete a sibling's
 * configuration.
 * @param key - the owning CLI process's scratch key.
 * @param config - the JSON text from the bridge's `configFor`.
 * @returns the absolute path of the config file, or `''` when it cannot be written.
 */
export function writeMcpConfigFile(key, config) {
  if (typeof config !== 'string' || config === '') return ''
  const sessionKey = scratchKeyFor(key)
  const path = join(ensureScratchDir(), `mcp-config-${sessionKey}.json`)
  try {
    writePrivateFile(path, config)
    scratchMcpConfigs.set(sessionKey, path)
  } catch {
    return ''
  }
  return path
}

/**
 * Remove only the MCP configuration owned by one CLI process.
 * @param key - the owning CLI process's scratch key.
 */
export function cleanupMcpConfigFile(key = 'shared') {
  const sessionKey = scratchKeyFor(key)
  const path = scratchMcpConfigs.get(sessionKey)
  if (path === undefined) return
  scratchMcpConfigs.delete(sessionKey)
  try { unlinkSync(path) } catch {}
}

/** The CLI permission modes this plugin is willing to pass. */
const CLI_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'])

/**
 * Deny reasons the CLI reads as "the prompt was cancelled" rather than as an
 * answer.
 *
 * `isSyntheticDeny` in the CLI matches these prefixes and the dual-channel
 * `AskUserQuestion` race then discards the reply and keeps waiting. They are
 * listed here so a deny this plugin sends is never mistaken for a cancelled
 * prompt.
 */
const SYNTHETIC_DENY_PREFIXES = ['prompt ended', 'cancelled', 'timeout waiting for user response', 'this is an unattended automated session']

/** How many answered request ids a session remembers, so a repeat cannot re-approve. */
const ANSWERED_PERMISSION_LIMIT = 512

/**
 * Make a deny reason safe to send back to the CLI.
 *
 * The text is trimmed and, when it would otherwise begin with one of the
 * CLI's synthetic-deny prefixes, prefixed with a marker so the CLI reads it as
 * this plugin's answer.
 * @param reason - the text this plugin wants to send.
 * @returns a non-empty reason that no CLI prefix rule can swallow.
 */
export function safeDenyReason(reason) {
  const text = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'DSH 拒绝了这个工具调用'
  const lower = text.toLowerCase()
  return SYNTHETIC_DENY_PREFIXES.some(prefix => lower.startsWith(prefix)) ? `DSH 拒绝了：${text}` : text
}

/**
 * Derive the CLI `--permission-mode` from DSH's own permission setting.
 *
 * The two sides have to agree. DSH already decided, per session, whether tool
 * calls are approved automatically or by the user; the CLI is a separate
 * process with its own file access, so a mode that disagrees would either
 * re-open a decision DSH has settled or let the CLI decide on its own:
 *
 * - `read-only` sandbox → `dontAsk`: the CLI denies every write and shell call
 *   in-process, which is what a read-only sandbox means. Nothing is left for a
 *   human to approve.
 * - `danger-full-access` + `never` approval → `bypassPermissions`: the user has
 *   already said no prompt and no restriction, so there is nothing to ask.
 * - everything else → `default`: the only mode measured to hand every gated
 *   native tool (Write, Edit, Bash, PowerShell, REPL, MCP wrapper) to the
 *   driver as a `control_request`. Those requests are then forwarded to DSH's
 *   approval seam, which is how the DSH user actually approves or rejects them.
 *   Under a `never` approval policy DSH answers `rejected` there, so the call is
 *   denied — fail closed, never a silent allow.
 *
 * `auto` is deliberately unreachable: it is the one mode that decides
 * approvals in-process with a model reviewer, so the driver sees no request at
 * all and the DSH user is never consulted.
 * @param policy - `{ sandboxMode, approvalPolicy }`; anything missing defaults to DSH's own default preset.
 * @returns one of the CLI's permission mode names.
 */
export function permissionModeFor(policy = {}) {
  const sandboxMode = policy.sandboxMode === 'read-only' || policy.sandboxMode === 'danger-full-access' ? policy.sandboxMode : 'workspace-write'
  const approvalPolicy = policy.approvalPolicy === 'never' ? 'never' : 'ask'
  if (sandboxMode === 'read-only') return 'dontAsk'
  if (approvalPolicy === 'never') return sandboxMode === 'danger-full-access' ? 'bypassPermissions' : 'dontAsk'
  return 'default'
}

/**
 * Build the argv for one non-interactive turn.
 *
 * `--input-format stream-json` makes the prompt arrive on stdin instead of
 * argv, which is what keeps arbitrarily long or quote-bearing user text
 * intact.
 *
 * `--tools default` is what makes the CLI a real agent rather than a chat
 * completion. `--permission-mode` is derived from the DSH permission setting
 * by {@link permissionModeFor} and defaults to `default`, the mode that
 * forwards every gated tool to the driver; an unrecognised value falls back to
 * that mode rather than to a permissive one.
 * @param options - the resolved call.
 * @returns argv *after* the entry, ready for `spawn(process.execPath, [entry, ...])`.
 */
export function buildArgs(options) {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--tools',
    'default',
    '--permission-mode',
    typeof options.permissionMode === 'string' && CLI_PERMISSION_MODES.has(options.permissionMode) ? options.permissionMode : 'default',
    '--max-turns',
    String(Number.isSafeInteger(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : DEFAULT_MAX_TURNS),
    '--model',
    options.model,
    '--session-id',
    options.sessionId,

    // Disabling auto-memory removes the `<system-reminder data-role="memory">`
    // block the CLI otherwise injects, which is both irrelevant to a chat
    // bridge and the bulk of the input prompt. It must be nested under
    // `memory`; a top-level `autoMemoryEnabled` is ignored.
    '--settings',
    JSON.stringify({ memory: { autoMemoryEnabled: false } }),
  ]
  // No file means no override: the CLI then runs on its own coding-agent prompt,
  // which is exactly the CodeBuddy-prompt mode.
  if (typeof options.systemPromptFile === 'string' && options.systemPromptFile !== '') {
    args.push('--system-prompt-file', options.systemPromptFile)
  }
  if (options.effort !== undefined) args.push('--effort', options.effort)
  // An inline MCP config is the whole tool bridge: it is scoped to this process,
  // so the user's own `codebuddy mcp` list is never touched.
  if (typeof options.mcpConfig === 'string' && options.mcpConfig !== '') args.push('--mcp-config', options.mcpConfig)
  return args
}

/**
 * Open one CLI process bound to a CodeBuddy session.
 *
 * A stream-json invocation is not one turn: after `result` the CLI parks and
 * waits for the next user message on stdin — its own `streamJsonDrainTrigger`
 * exists for exactly that long-poll. Keeping the process therefore removes the
 * per-message start-up cost, and the process only stops when `close` is called.
 *
 * Each DSH call owns one turn on the session: `send` starts it, `next` yields
 * frames until that turn's `result`. Nothing here decides how long an idle
 * session lives — that belongs to the adapter's keep-alive policy.
 *
 * Permission questions are answered by `options.requestPermission` when the
 * caller supplies one. Without it — a bare CLI use, or a composition with no
 * approval service — every question is denied: the CLI can then still finish
 * the turn with a tool error, whereas an unanswered question hangs the process
 * forever and an invented `allowed` would approve a call nobody reviewed.
 *
 * @param options - the resolved CLI call (`entry`, model, sessionId, cwd, …,
 * plus an optional `permissionMode` and `requestPermission`).
 * @returns a live session.
 */
export function openCli(options) {
  return new CliSession(options)
}

/** One long-lived CLI child process. */
export class CliSession {
  /** Frames decoded but not yet handed to a turn. */
  #queue = []

  /** Resolver waiting for the next frame, when the queue is empty. */
  #notify

  /** Partially decoded stdout line. */
  #stdout = ''

  /** Tail of stderr, kept for diagnosing a child that died without a result. */
  #stderr = ''

  /** Set once the child is gone. */
  #closed = false

  /** Set once the current turn was cancelled. */
  #cancelled = false

  /** Failure reported by the spawn itself. */
  #spawnError

  /** The child process. */
  #child

  /** The signal of the turn in flight. */
  #signal

  /** The abort listener installed for the turn in flight. */
  #abortListener

  /** Whether a turn is waiting for its result. */
  #active = false

  /** The scratch-prompt key this session's system prompt was written under. */
  #promptKey

  /** The scratch key whose MCP configuration this process alone owns. */
  #mcpConfigKey

  /**
   * Permission questions already sent to the caller and not yet answered.
   *
   * A `control_request` is answered exactly once. The entry is removed before
   * the answer is written, so a repeated frame with the same id cannot be
   * approved twice, and a session that dies mid-question cannot resolve a
   * callback that no longer has a process to answer.
   */
  #pendingPermissions = new Set()

  /**
   * Request ids this session has already answered.
   *
   * Bounded: a long-lived session answers one entry per gated tool call, so an
   * unbounded set would grow with the conversation. The CLI never repeats an id
   * within one process, but a bounded memory here is cheaper than trusting that.
   */
  #answeredPermissions = new Set()

  /**
   * Settles once the child is gone.
   *
   * A question can be waiting on a human when the process dies; the answer then
   * has no reader, and awaiting it forever would pin the callback's closure.
   * Racing the question against this promise lets that wait end.
   */
  #closedPromise

  /** @type {(value: undefined) => void} */
  #resolveClosed = () => {}

  /** The resolved call this process was started with. */
  options

  /**
   * @param options - the resolved CLI call.
   */
  constructor(options) {
    this.options = options
    this.#closedPromise = new Promise((resolve) => { this.#resolveClosed = resolve })
    // The prompt key rides on the resolved call (the adapter passes the CLI
    // session id); a keyless caller shares the legacy file name.
    this.#promptKey = typeof options.promptKey === 'string' && options.promptKey !== '' ? options.promptKey : 'shared'
    this.#mcpConfigKey = typeof options.mcpConfigKey === 'string' && options.mcpConfigKey !== '' ? options.mcpConfigKey : this.#promptKey
    const child = spawn(process.execPath, [options.entry, ...buildArgs(options)], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: options.cwd,
      env: { ...process.env, ...options.env, CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      detached: process.platform !== 'win32',
    })
    this.#child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.#decode(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.#stderr += chunk
      if (this.#stderr.length > MAX_FRAME_BYTES) this.#stderr = this.#stderr.slice(-MAX_FRAME_BYTES)
    })
    child.on('error', (error) => {
      this.#spawnError = error
      this.#closed = true
      this.#resolveClosed()
      this.#wake()
    })
    // A write after the CLI exits raises EPIPE; that is a normal end, not a fault.
    child.stdin.on('error', () => {})
    child.on('close', (code, signal) => {
      this.#closed = true
      this.#active = false
      this.#resolveClosed()
      this.#wake()
    })
  }

  /** @returns true while the child is still running. */
  get alive() {
    return this.#closed !== true && this.#spawnError === undefined
  }

  /** @returns true while a turn is waiting for its result. */
  get busy() {
    return this.#active === true
  }

  /**
   * Start one turn on this session.
   *
   * @param prompt - the user's text.
   * @param signal - cancellation for this turn only; a parked session ignores
   *   a stale abort from the turn that already finished.
   */
  send(prompt, signal, images) {
    if (!this.alive) throw new Error('CodeBuddy CLI 进程已退出')
    this.#bindSignal(signal)
    this.#active = true
    try {
      // One frame per turn, written in a single call. Node buffers a write that
      // outruns the pipe, so a large image payload (4 MiB per image, at most 4)
      // is held in this process's memory until the CLI drains it — bounded by
      // the frame cap and short-lived, which is why no drain loop is needed
      // here: there is exactly one frame per turn and nothing else competes for
      // the pipe.
      this.#child.stdin.write(`${JSON.stringify(userFrame(prompt, images))}\n`)
    } catch {
      this.#cancelled = true
      this.#active = false
      this.#killTree()
    }
  }

  /**
   * Read the next frame.
   *
   * `result` ends the turn but not the session: that frame is handed to the
   * caller and the process stays parked on its stdin.
   * @returns `{ frame }`, or `{ done: true }` once the child is gone.
   */
  async next() {
    while (true) {
      if (this.#queue.length > 0) {
        const frame = this.#queue.shift()
        if (frame?.type === 'result') this.#active = false
        return { frame }
      }
      if (this.#closed) {
        if (this.#cancelled) return { done: true }
        if (this.#spawnError !== undefined) throw this.#spawnError
        if (this.#active) {
          this.#active = false
          // A child that died without a `result` frame is the one failure mode
          // the frame stream cannot explain; the reason is on stderr.
          const detail = this.#stderr.trim()
          if (detail !== '') throw new Error(`CodeBuddy CLI 在给出结果前退出了：${detail.slice(-800)}`)
        }
        return { done: true }
      }
      await new Promise((resolve) => {
        this.#notify = resolve
      })
    }
  }

  /** Stop the process and release its scratch prompt file. */
  async close() {
    if (this.#closed && this.#child.exitCode !== null) {
      this.#cleanup()
      return
    }
    this.#closed = true
    this.#active = false
    // A question still waiting on a human has no reader left once the session
    // is closed, so end that wait too.
    this.#resolveClosed()
    this.#bindSignal(undefined)
    try {
      this.#child.stdin.end()
    } catch {
      // EPIPE after exit is expected.
    }
    await settleBounded(this.#killTree(), EXIT_GRACE_MS)
    await reapSpawned(this.#child, this.#spawnError)
    if (this.#spawnError === undefined && this.#child.exitCode === null && this.#child.signalCode === null) {
      // A graceful signal is only the first attempt. Disposal must not return
      // while an uncooperative model process can still touch the filesystem.
      await settleBounded(this.#killTree(true), EXIT_GRACE_MS)
      await reapSpawned(this.#child, this.#spawnError)
    }
    this.#cleanup()
  }

  /** Resolve one waiter, if any. */
  #wake() {
    if (this.#notify === undefined) return
    const resume = this.#notify
    this.#notify = undefined
    resume()
  }

  /**
   * Bind this turn's cancellation signal, dropping the previous turn's.
   * @param signal - the signal, or `undefined` to just drop the listener.
   */
  #bindSignal(signal) {
    if (this.#abortListener !== undefined && this.#signal !== undefined) {
      this.#signal.removeEventListener('abort', this.#abortListener)
    }
    this.#abortListener = undefined
    this.#signal = signal
    if (signal === undefined) return
    const listener = () => {
      // A parked session must not die because a finished turn was aborted.
      if (!this.#active) return
      this.#cancelled = true
      this.#killTree()
      this.#wake()
    }
    signal.addEventListener('abort', listener, { once: true })
    this.#abortListener = listener
    if (signal.aborted === true) listener()
  }

  /**
   * Answer a permission question, routing it through the caller's approval
   * callback when there is one.
   *
   * The answer is never invented here. A `control_request` means the CLI
   * stopped because *it* decided this call needs a human; the only party
   * entitled to say yes is the caller's approval seam, and the only safe
   * default when it is missing or throws is `allowed: false`.
   *
   * A deny carries no `interrupt`: the CLI turns an interrupted denial into a
   * whole-turn abort with an empty reply, while a plain deny lets the model
   * read the error and adapt. `interrupt` is reserved for `ExitPlanMode`, where
   * a plain denial leaves the CLI waiting for another decision.
   *
   * @param frame - the `control_request` frame.
   */
  async #answerControlRequest(frame) {
    const requestId = frame?.request_id
    if (typeof requestId !== 'string' || requestId === '') return
    // One answer per request id, whatever the CLI repeats.
    if (this.#pendingPermissions.has(requestId) || this.#answeredPermissions.has(requestId)) return
    this.#pendingPermissions.add(requestId)
    let decision
    try {
      decision = await this.#decidePermission(frame)
    } catch (error) {
      decision = { allowed: false, reason: safeDenyReason(`审批通道出错：${error instanceof Error ? error.message : String(error)}`) }
    } finally {
      this.#pendingPermissions.delete(requestId)
      // Keep the id out of a bounded window: the newest ids are the ones a
      // repeat could plausibly name.
      this.#answeredPermissions.add(requestId)
      if (this.#answeredPermissions.size > ANSWERED_PERMISSION_LIMIT) {
        const oldest = this.#answeredPermissions.values().next().value
        this.#answeredPermissions.delete(oldest)
      }
    }
    const response = { allowed: decision.allowed === true, reason: decision.reason }
    if (decision.allowed === true && decision.updatedInput !== undefined) response.updatedInput = decision.updatedInput
    // `interrupt` aborts the whole turn for every tool but ExitPlanMode.
    if (decision.allowed !== true && decision.toolName === 'ExitPlanMode') response.interrupt = true
    this.#writeControlResponse(requestId, response)
  }

  /**
   * Ask the caller's approval callback about one request.
   *
   * Fail closed at every branch: no callback, an unknown request shape, a
   * callback that throws, or a callback that returns something that is not an
   * explicit allow all produce a deny with a reason the model can read.
   * @param frame - the `control_request` frame.
   * @returns `{ allowed, reason, toolName, updatedInput? }`.
   */
  async #decidePermission(frame) {
    const request = frame?.request
    const toolName = typeof request?.tool_name === 'string' && request.tool_name !== '' ? request.tool_name : ''
    const input = request?.input !== null && typeof request?.input === 'object' ? request.input : {}
    const toolUseId = typeof request?.tool_use_id === 'string' && request.tool_use_id !== '' ? request.tool_use_id : undefined
    if (request?.subtype !== 'can_use_tool') {
      return { allowed: false, reason: safeDenyReason(`不支持的权限请求类型：${String(request?.subtype ?? '缺失')}`) }
    }
    if (toolName === '') return { allowed: false, reason: safeDenyReason('权限请求缺少工具名') }
    const requestPermission = this.options?.requestPermission
    if (typeof requestPermission !== 'function') {
      return { allowed: false, reason: safeDenyReason(`没有可用的审批通道，已拒绝 ${toolName}`), toolName }
    }
    // A question outlives its process: the child can exit while a human is
    // still deciding, and waiting on an answer nobody can deliver would keep
    // this callback alive forever.
    const answer = await Promise.race([
      requestPermission({
        toolName,
        input,
        toolUseId,
        requestId: frame.request_id,
        sessionId: this.options?.sessionId,
        // The signal of the turn that is waiting on this answer, so a cancelled
        // turn can cancel the prompt instead of leaving it open.
        signal: this.#signal,
      }),
      this.#closedPromise.then(() => ({ allowed: false, reason: 'CodeBuddy CLI 已退出，审批作废' })),
    ])
    if (answer?.allowed !== true) {
      return { allowed: false, reason: safeDenyReason(answer?.reason ?? `已拒绝 ${toolName}`), toolName }
    }
    // The allow is scoped to the request that was reviewed: the callback may
    // narrow the arguments, and whatever it did not return stays as it was.
    return {
      allowed: true,
      reason: typeof answer.reason === 'string' && answer.reason !== '' ? answer.reason : '已批准',
      toolName,
      ...answer.updatedInput !== undefined && answer.updatedInput !== null ? { updatedInput: answer.updatedInput } : {},
    }
  }

  /**
   * Write one `control_response` line to the child's stdin.
   * @param requestId - the id from the request being answered.
   * @param response - the decision payload (`allowed`, `reason`, optionally `updatedInput`/`interrupt`).
   */
  #writeControlResponse(requestId, response) {
    try {
      this.#child.stdin.write(`${JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      })}\n`)
    } catch {
      // The child exited between the frame and the answer; the turn is already
      // over, so there is nothing left to unblock.
    }
  }

  /** Decode complete lines from the stdout buffer, keeping the tail. */
  #decode(chunk) {
    this.#stdout += chunk
    if (this.#stdout.length > MAX_FRAME_BYTES) {
      this.#stdout = ''
      this.#queue.push({ type: 'error', error: 'CodeBuddy CLI produced an oversized frame; the turn was abandoned' })
      this.#killTree()
      return
    }
    const lines = this.#stdout.split('\n')
    this.#stdout = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (text === '') continue
      let frame
      try {
        frame = JSON.parse(text)
      } catch {
        // A line that is not JSON is diagnostics, not a frame; dropping it is
        // strictly better than failing a turn that is otherwise streaming.
        continue
      }
      // Answered off the frame path: the answer may wait on a human, and the
      // frames after this one must keep flowing to the turn meanwhile.
      if (frame?.type === 'control_request') void this.#answerControlRequest(frame)
      this.#queue.push(frame)
    }
    this.#wake()
  }

  /**
   * Terminate the whole process tree, escalating after the graceful attempt.
   * @param force - use SIGKILL on POSIX; Windows taskkill is always forced.
   * @returns a promise for the Windows taskkill helper, otherwise `undefined`.
   */
  #killTree(force = false) {
    const child = this.#child
    if (child.exitCode !== null || child.signalCode !== null) return
    let taskkill
    if (process.platform === 'win32') {
      try {
        taskkill = new Promise((resolve) => {
          const helper = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          helper.once('error', () => resolve(undefined))
          helper.once('close', () => resolve(undefined))
        })
      } catch {
        // Fall through to the direct kill below.
      }
    } else {
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // The group may already be gone.
      }
    }
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // Already dead.
    }
    return taskkill
  }

  /** Remove only the scratch files this CLI process owns. */
  #cleanup() {
    cleanupSystemPromptFile(this.#promptKey)
    cleanupMcpConfigFile(this.#mcpConfigKey)
  }
}

/** Wait for an optional kill helper without letting it hang disposal. */
async function settleBounded(promise, timeoutMs) {
  if (promise === undefined) return
  let timer
  try {
    await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Wait a bounded time for a child to exit after being killed.
 *
 * A child that already reported a spawn error has no process to wait for; a
 * failed spawn used to sit out the full grace period, which made disposing
 * several broken sessions noticeably slow.
 * @param target - the spawned child.
 */
async function reap(target) {
  if (target.exitCode !== null || target.signalCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, EXIT_GRACE_MS)
    target.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Resolve immediately when the child never started; otherwise wait for exit. */
function reapSpawned(target, spawnError) {
  return spawnError !== undefined ? Promise.resolve() : reap(target)
}
/**
 * The one NDJSON frame a non-interactive turn accepts as its user message.
 *
 * Images ride along as sibling content blocks in the Anthropic shape the CLI
 * parses (`{type:'image', source:{type:'base64', media_type, data}}`). The CLI
 * persists each one into its own blob store and the model reads it back through
 * `ViewImage`, so the frame only has to carry the bytes.
 *
 * @param prompt - the user's text.
 * @param images - `[{ mediaType, data }]`, base64 payloads.
 * @returns the frame object, ready to serialize.
 */
export function userFrame(prompt, images = []) {
  const content = [{ type: 'text', text: prompt }]
  for (const image of Array.isArray(images) ? images : []) {
    if (typeof image?.data !== 'string' || image.data === '') continue
    const mediaType = typeof image.mediaType === 'string' && image.mediaType !== '' ? image.mediaType : 'image/png'
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: image.data } })
  }
  return {
    type: 'user',
    message: { role: 'user', content },
  }
}

/**
 * Describe why the CLI cannot be run, for display in the model picker.
 * @param reason - the resolution failure.
 * @returns a one-line message.
 */
export function unavailableMessage(reason) {
  return `CodeBuddy CLI 不可用：${reason}`
}

export { CLI_PACKAGE_PATH, DEFAULT_MAX_TURNS, EXIT_GRACE_MS, MAX_FRAME_BYTES }
