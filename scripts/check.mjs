/**
 * Parse every shipped module without running it.
 *
 * `node --check` catches the mistakes a plain import would not reach early: a
 * stray brace in a file nothing imports yet, or the client bundle, which the
 * Host only loads in a browser.
 * @module dsh-connect-codebuddy-cli/scripts/check
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every `.js`/`.mjs` file under a directory, recursively.
 * @param directory - the directory to walk.
 * @returns the absolute paths, sorted.
 */
async function modulesUnder(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...await modulesUnder(path))
      continue
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) found.push(path)
  }
  return found.sort()
}

const targets = [join(ROOT, 'index.js'), ...await modulesUnder(join(ROOT, 'src'))]
let failures = 0
for (const file of targets) {
  try {
    await run(process.execPath, ['--check', file])
  } catch (error) {
    failures += 1
    process.stderr.write(`${relative(ROOT, file)}: ${error.stderr ?? error.message}\n`)
  }
}
process.stdout.write(`${targets.length - failures}/${targets.length} modules parse\n`)
process.exitCode = failures === 0 ? 0 : 1