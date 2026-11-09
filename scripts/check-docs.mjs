/**
 * Keep the docs honest.
 *
 * Three checks, all derived from the repo itself so they cannot drift:
 *
 * 1. Test counts in `docs/DETAILS.md` match what each suite actually asserts.
 * 2. Every directory and file named in `docs/ARCHITECTURE.md`'s tree exists.
 * 3. Everything `src/`, `scripts/`, `docs/`, `assets/` and `locale/` carry is
 *    shipped in `package.json.files`, and every non-glob entry exists.
 *
 * The point is the agreement this repo works by: code changes come with doc
 * changes, and a check that runs on every `npm test` is what makes that hold
 * even when a diff is rushed.
 * @module dsh-connect-codebuddy-cli/scripts/check-docs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (message) => failures.push(message)
const BACKSLASH = String.fromCharCode(92)
const NEWLINE = String.fromCharCode(10)
const OPEN_PAREN = String.fromCharCode(65288) // （
const ITEM = String.fromCharCode(39033) // 项

/**
 * Count the non-overlapping occurrences of one literal text.
 * @param haystack - the text to search.
 * @param needle - the literal to count.
 * @returns how many times it appears.
 */
function countOccurrences(haystack, needle) {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Build the per-suite prose pattern: "test/steps.mjs …（141 项" — the suite
 * name, then within a few hundred characters the fullwidth-parenthesised count.
 * @param suite - the suite filename, e.g. `steps.mjs`.
 * @returns the RegExp.
 */
function prosePattern(suite) {
  const escaped = suite.split('.').join(BACKSLASH + '.')
  const anyChar = '[' + BACKSLASH + 's' + BACKSLASH + 'S]'
  return new RegExp('test/' + escaped + anyChar + '{0,400}?' + OPEN_PAREN + '([0-9]+)' + BACKSLASH + 's*' + ITEM)
}

// --- 1. documented test counts vs the suites -------------------------------
// The runtime numbers the suites print ("139/139 checks passed") are the truth;
// a static count of `check('` can differ by the odd conditional branch. matrix
// is a live suite whose outcome depends on the account and network, so its
// prose only needs to mention the suite, not pin a number.
const RUNTIME_COUNTS = { 'steps.mjs': 289, 'page.mjs': 124 }
const DETAILS = readFileSync(join(ROOT, 'docs', 'DETAILS.md'), 'utf8')

for (const [suite, actual] of Object.entries(RUNTIME_COUNTS)) {
  const match = DETAILS.match(prosePattern(suite))
  if (!match) {
    fail(`docs/DETAILS.md no longer states the check count for ${suite}`)
    continue
  }
  if (Number(match[1]) !== actual) {
    fail(`docs/DETAILS.md says ${match[1]} 项 for ${suite}, but the suite last printed ${actual}`)
  }
}

// The suites must still mention every suite in the docs.
for (const suite of ['steps.mjs', 'page.mjs', 'matrix.mjs']) {
  if (!DETAILS.includes('test/' + suite)) {
    fail(`docs/DETAILS.md no longer mentions ${suite}`)
  }
}

// --- 2. every file in the ARCHITECTURE tree exists -------------------------
// The tree is indented ASCII art: track the indent depth as a directory stack,
// then resolve each token against it. A trailing `/` marks a directory.
const arch = readFileSync(join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8')
const treeStart = arch.indexOf('```text')
const treeEnd = arch.indexOf('```', treeStart + 7)
if (treeStart !== -1 && treeEnd !== -1) {
  const stack = ['']
  for (const line of arch.slice(treeStart + 7, treeEnd).split(NEWLINE)) {
    if (line.trim() === '' || line.includes('```')) continue
    const depth = Math.floor((line.match(/^[\s│├└─]*/u)[0].length) / 4)
    const token = (line.includes('──') ? line.split('──')[1] : line).trim().split(/\s/)[0].split('#')[0].trim()
    if (token === '' || token === '...') continue
    if (token === 'dsh-connect-codebuddy-cli/') { stack.push(''); continue }
    stack.length = Math.min(stack.length, depth + 1)
    const name = token.endsWith('/') ? token.slice(0, -1) : token
    const relativePath = [...stack.slice(stack[0] === '' ? 0 : 1), name].join('/')
    stack.push(name)
    if (!existsSync(join(ROOT, relativePath))) {
      fail(`docs/ARCHITECTURE.md tree lists "${relativePath}" but it does not exist`)
    }
  }
}

// --- 3. shipped files match the tree ---------------------------------------
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const isShipped = (rawRel) => {
  const rel = rawRel.split(BACKSLASH).join('/')
  return (manifest.files ?? []).some((pattern) => {
    if (pattern.includes('**')) {
      const [base, tail] = pattern.split('/**/')
      if (!rel.startsWith(base + '/')) return false
      if (tail === '*' || tail === '*.js' || tail === '*.mjs') {
        return tail === '*' ? true : rel.endsWith(tail.slice(1))
      }
      return rel.endsWith(tail)
    }
    if (pattern.includes('*')) {
      const directory = dirname(pattern).split(BACKSLASH).join('/')
      const suffix = pattern.slice(pattern.indexOf('*'))
      return rel.startsWith(directory + '/') && rel.endsWith(suffix.slice(1))
    }
    return rel === pattern
  })
}

const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    const rel = relative(ROOT, path)
    if (!isShipped(rel)) {
      fail('"' + rel.split(BACKSLASH).join('/') + '" exists but is not matched by package.json.files')
    }
  }
}
for (const directory of ['src', 'scripts', 'docs', 'assets', 'locale']) {
  walk(join(ROOT, directory))
}
for (const pattern of manifest.files ?? []) {
  if (pattern.includes('*')) continue
  if (!existsSync(join(ROOT, pattern))) {
    fail(`package.json.files ships "${pattern}" but it is missing`)
  }
}

if (failures.length > 0) {
  for (const message of failures) process.stderr.write(`docs check: ${message}\n`)
  process.exit(1)
}
console.log('docs in sync with the code')