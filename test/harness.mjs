/**
 * End-to-end harness: drive the plugin's adapter exactly as the DSH runtime
 * would, with no DSH process involved.
 *
 * Usage:
 *   node test/harness.mjs                 # one text turn
 *   node test/harness.mjs <model> <text> <sessionId>
 */
import { apply, PROVIDER_ID } from '../index.js'

const model = process.argv[2] ?? 'deepseek-v4-pro'
const prompt = process.argv[3] ?? 'Explain in one sentence why the sky is blue.'
const sessionId = process.argv[4] ?? 'harness-session-1'

/** Collect the adapter registered by `apply`, without a real Cordis context. */
let adapter
const ctx = {
  llm: {
    registerAdapter(providers, registered) {
      if (!providers.includes(PROVIDER_ID)) throw new Error('unexpected provider route')
      adapter = registered
    },
  },
  logger: { info: m => console.log('[info]', m), warn: m => console.log('[warn]', m) },
}

apply(ctx, { binary: '', models: [], cwd: '' })
if (adapter === undefined) throw new Error('apply() did not register an adapter')

const userMessage = {
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'user' },
}

const controller = new AbortController()
const options = {
  provider: PROVIDER_ID,
  model,
  messages: [userMessage],
  toolHistory: [],
  sessionId,
  signal: controller.signal,
}

const started = Date.now()
const prepared = await adapter.prepareCall(PROVIDER_ID, model, controller.signal)
console.log('[prepared]', JSON.stringify(prepared.model))

const chunks = []
for await (const chunk of prepared.stream(options)) {
  chunks.push(chunk)
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
  else if (chunk.type === 'reasoning-delta') process.stdout.write('')
  else console.log('\n[chunk]', JSON.stringify(chunk).slice(0, 300))
}

const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
const usage = chunks.find(c => c.type === 'usage')?.usage
const finish = chunks.find(c => c.type === 'finish')?.reason

console.log('\n=== RESULT ===')
console.log('elapsedMs:', Date.now() - started)
console.log('chunks:', chunks.length)
console.log('reasoningChars:', reasoning.length)
console.log('textChars:', text.length)
console.log('text:', JSON.stringify(text).slice(0, 400))
console.log('usage:', JSON.stringify(usage))
console.log('finish:', JSON.stringify(finish))

if (finish === undefined) console.log('FAIL: no finish chunk')
if (text.trim() === '') console.log('FAIL: no text produced')
// A harness run that produced nothing must not report success.
if (finish === undefined || text.trim() === '') process.exitCode = 1
