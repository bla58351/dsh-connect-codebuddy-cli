/**
 * Run the plugin's test suites.
 *
 * Two tiers exist and they mean different things:
 *
 * - **offline** (`steps`, `page`): a fake CLI and a fake Host, no model call, no
 *   network. These are the gate — they must pass before anything ships.
 * - **live** (`matrix`, `tool`): they spawn the real CodeBuddy CLI and spend
 *   quota. They are useful when changing the CLI contract, but a failure there
 *   is often the account or the network rather than the code, so they run only
 *   when asked (`--live`).
 *
 * A suite that runs past the timeout is killed and counted as a failure: these
 * tests finish their work quickly, and a lingering process would otherwise hang
 * CI forever (the fake CLI's keep-alive timers keep the loop alive).
 * @module dsh-connect-codebuddy-cli/scripts/test
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Offline suites: no model call, no network. */
const OFFLINE = ['steps.mjs', 'page.mjs']

/** Live suites: spawn the real CLI and spend quota. */
const LIVE = ['matrix.mjs', 'tool.mjs']

/** How long one suite may take before it is killed. */
const TIMEOUT_MS = 240_000

const wanted = process.argv.includes('--live') ? [...OFFLINE, ...LIVE] : OFFLINE

/**
 * Run one suite and settle with its outcome.
 * @param file - the suite filename under `test/`.
 * @returns `{ file, code, killed, seconds }`.
 */
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(ROOT, 'test', file)], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve({ file, code: 1, killed: true, seconds: (Date.now() - started) / 1000 })
    }, TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ file, code: 1, killed: false, seconds: (Date.now() - started) / 1000 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ file, code: code ?? 1, killed: false, seconds: (Date.now() - started) / 1000 })
    })
  })
}

const results = []
for (const file of wanted) {
  process.stdout.write(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}\n`)
  results.push(await run(file))
}

const failed = results.filter(result => result.code !== 0)
process.stdout.write(`\n${'-'.repeat(60)}\n`)
for (const result of results) {
  const status = result.code === 0 ? 'ok  ' : result.killed ? 'timeout' : 'FAIL'
  process.stdout.write(`${status.padEnd(8)} ${result.file}  ${result.seconds.toFixed(1)}s\n`)
}
process.stdout.write(`${results.length - failed.length}/${results.length} suites passed\n`)
process.exitCode = failed.length === 0 ? 0 : 1