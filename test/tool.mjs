/**
 * One real tool-using turn through the adapter, driven the way DSH drives it:
 * a step per assistant message, each step's tool calls dispatched through the
 * display tools the plugin registered before the turn, before the next step is
 * asked for.
 *
 * It prints one line per step so the shape is visible — a message's cards must
 * belong to that step, and the last step must carry no call at all, because
 * that is what the transcript needs in order to treat it as the answer.
 *
 * Requires an installed and logged-in CodeBuddy CLI.
 * Run: node test/tool.mjs [prompt]
 */
import { apply, PROVIDER_ID } from '../index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSettings } from '../src/config/store.js'

const liveHome = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
process.env.DSH_HOME = liveHome
writeSettings({ hiddenModels: [], keepAliveSeconds: 0 })

let adapter
const agent = { session: { header: { cwd: process.cwd() } } }
// The Host's tool registry: the plugin registers its display tools here before
// the first step, which is the only way DSH can dispatch a reported call.
const registry = new Map()
const tools = {
  get: name => registry.get(name),
  register(definition) {
    registry.set(definition.name, definition)
    return () => registry.delete(definition.name)
  },
}
const services = {
  tools,
  agents: { get: () => agent },
  approval: { effectivePolicy: () => 'ask', request: async () => 'allowed-once' },
}
apply(
  {
    llm: { registerAdapter: (_p, a) => { adapter = a } },
    logger: { info() {}, warn: m => console.log('[warn]', m) },
    on: () => {},
    get: name => services[name],
    reflect: { get: name => services[name] },
  },
  { binary: '', models: [], cwd: '' },
)

const model = 'glm-5.3'
const prompt = process.argv[2] ?? 'Read package.json and reply with just the "name" value.'
const sessionId = `tool-${Date.now().toString(36)}`
const human = { id: 'm', role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }
const messages = [human]
const steps = []

try {
for (let index = 0; index < 12; index += 1) {
  const prepared = await adapter.prepareCall(PROVIDER_ID, model)
  const chunks = []
  for await (const chunk of prepared.stream({ provider: PROVIDER_ID, model, messages, toolHistory: [], sessionId, tools: [{ name: 'Read' }, { name: 'Write' }, { name: 'Bash' }] })) {
    chunks.push(chunk)
  }
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  const cards = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call').map(c => c.block)
  steps.push({ text, reasoning, cards })
  if (cards.length === 0) break

  messages.push({ id: `a${index}`, role: 'assistant', source: { kind: 'assistant' }, content: cards.map(c => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })) })
  for (const card of cards) {
    const definition = registry.get(card.name)
    let body = ''
    if (definition === undefined) {
      console.log(`FAIL  no display tool is registered for ${card.name}`)
    } else {
      const value = await definition.execute(JSON.parse(card.arguments), { callId: card.id })
      body = definition.output.render(JSON.parse(card.arguments), value)[0]?.text ?? ''
    }
    messages.push({ id: `t${index}`, role: 'tool', source: { kind: 'tool', callId: card.id }, toolCallId: card.id, isError: false, content: [{ type: 'text', text: body }] })
    console.log(`  card ${card.name} ${card.arguments.slice(0, 60)} -> ${JSON.stringify(body.slice(0, 60))}`)
  }
}

steps.forEach((entry, index) => {
  console.log(`step ${index}: cards=${JSON.stringify(entry.cards.map(c => c.name))} reasoning=${entry.reasoning.length} text=${JSON.stringify(entry.text.slice(0, 80))}`)
})
const last = steps.at(-1)
console.log('\nsteps        :', steps.length)
console.log('answer step  :', last.cards.length === 0 ? 'has no tool call (correct)' : 'STILL CARRIES A CALL (the answer will be folded)')
console.log('answer text  :', JSON.stringify(last.text.trim().slice(0, 120)))
} finally {
  await adapter.dispose()
  rmSync(liveHome, { recursive: true, force: true })
}
