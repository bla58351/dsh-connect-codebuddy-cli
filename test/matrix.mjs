/**
 * Adapter test matrix: the behaviours the plugin must hold, exercised against
 * the real CLI with no DSH process involved.
 *
 * Run: node test/matrix.mjs
 */
import { apply, PROVIDER_ID, usageOf } from '../index.js'
import { FALLBACK_TOOL_NAME } from '../src/bridge/cards.js'
import { contextWindowFor } from '../src/cli/catalog.js'
import { buildArgs, DEFAULT_MAX_TURNS, readProductModels } from '../src/cli/session.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSettings } from '../src/config/store.js'

// Live tests must not inherit hidden models or keep-alive choices from the
// developer's real profile, and they must leave every CLI process behind them.
const liveHome = mkdtempSync(join(tmpdir(), 'dsh-matrix-'))
process.env.DSH_HOME = liveHome
writeSettings({ hiddenModels: [], keepAliveSeconds: 0 })
const liveAdapters = new Set()

/**
 * A stand-in `tools` service, as the Host's registry would supply.
 *
 * Cards are dispatched only through definitions registered here, and DSH admits
 * one only when it existed before the step's tool set was frozen, so the card
 * tests read this registry rather than a dispatch hook.
 */
function fakeTools() {
  const registry = new Map()
  const whens = new Map()
  return {
    registry,
    whens,
    get(name) { return registry.get(name) },
    register(definition, options) {
      if (registry.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
      registry.set(definition.name, definition)
      whens.set(definition.name, options?.when)
      return () => { registry.delete(definition.name); whens.delete(definition.name) }
    },
  }
}

/** Build a fresh adapter, capturing what `apply` registers. */
function makeAdapter(config = { binary: '', models: [], cwd: '' }) {
  let adapter
  const logs = []
  const listeners = {}
  const tools = fakeTools()
  const agent = { session: { header: { cwd: process.cwd() } } }
  const services = {
    tools,
    agents: { get: () => agent },
    approval: {
      effectivePolicy: () => 'ask',
      // These are explicit live execution tests. Offline steps cover denial;
      // here the fake user approves each real tool exactly once.
      request: async () => 'allowed-once',
    },
  }
  apply(
    {
      llm: { registerAdapter: (_providers, registered) => { adapter = registered } },
      logger: { info: m => logs.push(`info: ${m}`), warn: m => logs.push(`warn: ${m}`) },
      on: (event, listener) => { listeners[event] = listener },
      get: name => services[name],
      reflect: { get: name => services[name] },
    },
    config,
  )
  liveAdapters.add(adapter)
  return { adapter, logs, listeners, tools }
}

/**
 * Run one turn the way DSH does: a step per assistant message, dispatching each
 * step's tool calls through the plugin's own waterfall before asking for the
 * next one.
 *
 * The loop is what makes a tool-using turn work, so a harness that stopped
 * after the first step would only ever see the CLI's first message.
 */
async function turn(adapter, { model, text, sessionId, signal, effort, tools, registered, history }) {
  const human = { id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  // DSH projects the whole conversation. Passing that projection between calls
  // is what distinguishes a new turn from a rewind to a different history.
  const messages = Array.isArray(history) ? [...history, human] : [human]
  const steps = []
  const dispatched = []
  let threw
  try {
    for (let index = 0; index < 12; index += 1) {
      const options = { provider: PROVIDER_ID, model, messages, toolHistory: [], sessionId, signal, ...effort === undefined ? {} : { reasoningEffort: effort }, ...tools === undefined ? {} : { tools } }
      const prepared = await adapter.prepareCall(PROVIDER_ID, model, signal)
      const chunks = []
      for await (const chunk of prepared.stream(options)) chunks.push(chunk)
      steps.push({ chunks, text: chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), reasoning: chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('') })
      const cards = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call').map(c => c.block)
      if (cards.length === 0) break
      messages.push({ id: `a${index}`, role: 'assistant', source: { kind: 'assistant' }, content: cards.map(c => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })) })
      for (const card of cards) {
        const definition = registered?.registry.get(card.name)
        const definitionFound = definition !== undefined
        let body = ''
        if (definitionFound) {
          const value = await definition.execute(JSON.parse(card.arguments), { callId: card.id })
          body = definition.output.render(JSON.parse(card.arguments), value)[0]?.text ?? ''
        }
        dispatched.push({ card, body, definitionFound })
        messages.push({ id: `t${index}`, role: 'tool', source: { kind: 'tool', callId: card.id }, toolCallId: card.id, isError: false, content: [{ type: 'text', text: body }] })
      }
    }
  } catch (error) {
    threw = error
  }
  const chunks = steps.flatMap(entry => entry.chunks)
  const last = steps.at(-1) ?? { chunks: [] }
  return {
    chunks,
    steps,
    threw,
    text: steps.map(entry => entry.text).join(''),
    reasoning: steps.map(entry => entry.reasoning).join(''),
    usage: [...last.chunks].reverse().find(c => c.type === 'usage')?.usage,
    finish: last.chunks.find(c => c.type === 'finish')?.reason,
    messages,
    dispatched,
  }
}

/** Assert one condition, recording pass/fail rather than aborting. */
const results = []
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

const unique = Date.now().toString(36)

try {
// --- 1. Catalog surface -----------------------------------------------------
{
  const { adapter } = makeAdapter()
  const models = await adapter.listModels(PROVIDER_ID)
  check('listModels returns a non-empty catalog', models.length > 0, `${models.length} models`)
  check('every model carries provider + id + name', models.every(m => m.provider === PROVIDER_ID && typeof m.id === 'string' && m.id !== '' && typeof m.name === 'string' && m.name !== ''))
  check('providerInfo().id equals the route', adapter.providerInfo(PROVIDER_ID).id === PROVIDER_ID)

  const info = await adapter.resolveModel(PROVIDER_ID, 'deepseek-v4-pro')
  check('resolveModel echoes provider and id', info.provider === PROVIDER_ID && info.id === 'deepseek-v4-pro')
  check('resolveModel supplies a non-empty name', typeof info.name === 'string' && info.name !== '', info.name)

  const flash = await adapter.resolveModel(PROVIDER_ID, 'deepseek-v4.1-flash')
  check('known model reports a context window', Number.isInteger(flash.context?.contextWindow) && flash.context.contextWindow > 0, String(flash.context?.contextWindow))
  check('known model reports reasoning efforts', Array.isArray(flash.reasoning?.efforts) && flash.reasoning.efforts.length > 0, JSON.stringify(flash.reasoning?.efforts?.map(e => e.id)))
}

// --- 2. Config filter -------------------------------------------------------
{
  const { adapter } = makeAdapter({ binary: '', models: ['glm-5.3'], cwd: '' })
  const models = await adapter.listModels(PROVIDER_ID)
  check('config.models restricts the advertised catalog', models.length === 1 && models[0].id === 'glm-5.3', models.map(m => m.id).join(','))
}

// --- 3. Bad binary ----------------------------------------------------------
{
  const { adapter, logs } = makeAdapter({ binary: 'C:/does/not/exist/codebuddy', models: [], cwd: '' })
  const models = await adapter.listModels(PROVIDER_ID)
  check('missing binary advertises nothing', models.length === 0)
  check('missing binary is reported once', logs.filter(l => l.startsWith('warn')).length === 1)
  const outcome = await turn(adapter, { model: 'glm-5.3', text: 'hi', sessionId: 'x' })
  check('missing binary refuses the turn', outcome.threw !== undefined, String(outcome.threw?.message).slice(0, 60))
}

// --- 4. .cmd rejection ------------------------------------------------------
{
  const { adapter } = makeAdapter({ binary: 'C:/Users/x/AppData/Roaming/npm/codebuddy.cmd', models: [], cwd: '' })
  const models = await adapter.listModels(PROVIDER_ID)
  check('.cmd wrapper is rejected on win32', process.platform !== 'win32' || models.length === 0)
}

// --- 5. Real turns ---------------------------------------------------------
{
  const { adapter } = makeAdapter()
  const first = await turn(adapter, { model: 'glm-5.3', text: 'Reply with exactly: ALPHA', sessionId: `t-${unique}` })
  check('turn produces text', first.text.trim() === 'ALPHA', JSON.stringify(first.text))
  check('turn produces a finish chunk', first.finish?.kind === 'stop')
  check('turn reports usage', first.usage !== undefined && first.usage.inputTokens > 0, JSON.stringify(first.usage))
  check('reasoning and text use distinct indices', first.steps.every(entry => distinctIndices(entry.chunks)))
  check('no tool-call chunks are emitted', first.chunks.every(c => c.type !== 'tool-call-delta'))
  check('text contains no tool markup', !/<｜｜DSML/u.test(first.text), first.text.slice(0, 80))

  const second = await turn(adapter, { model: 'glm-5.3', text: 'What token did you just say? Reply with just it.', sessionId: `t-${unique}`, history: first.messages })
  check('same session id resumes history', second.text.trim().toUpperCase() === 'ALPHA', JSON.stringify(second.text))

  const fresh = await turn(adapter, { model: 'glm-5.3', text: 'What token did you just say? Reply with just it.', sessionId: `f-${unique}` })
  check('a different session id has no history', fresh.text.trim().toUpperCase() !== 'ALPHA', JSON.stringify(fresh.text.slice(0, 60)))
}

// --- 6. Reasoning ----------------------------------------------------------
{
  const { adapter } = makeAdapter()
  // A prompt that requires actual arithmetic reliably triggers the model's
  // thinking channel; a one-line factual question often gets answered straight
  // from the text channel, which would test nothing about translation.
  const outcome = await turn(adapter, {
    model: 'deepseek-v4-pro',
    text: 'A train leaves at 3pm at 60km/h. Another leaves the same station at 4pm at 80km/h on the same route. At what clock time does the second catch the first? Think it through, then give the time.',
    sessionId: `r-${unique}`,
  })
  check('reasoning model streams reasoning text', outcome.reasoning.length > 0, `${outcome.reasoning.length} chars`)
  check('reasoning does not swallow the answer', outcome.text.trim() !== '')
  check('reasoning and answer occupy different indices', outcome.steps.every(entry => distinctIndices(entry.chunks)))
}

// --- 7. Effort -------------------------------------------------------------
{
  const { adapter } = makeAdapter()
  const outcome = await turn(adapter, { model: 'glm-5.3', text: 'Reply with exactly: EFFORT', sessionId: `e-${unique}`, effort: 'low' })
  check('declared effort is accepted', outcome.threw === undefined && outcome.text.trim() === 'EFFORT', JSON.stringify(outcome.text))
}

{
  // The menu used to be gated on what `product.json` declared, which covers
  // only 7 of the 16 models the CLI advertises. `deepseek-v4-pro` therefore had
  // no effort menu at all, even though the CLI honours `--effort` for it
  // (measured: 61 characters of thinking at `low`, 242 at `max`). Every model
  // must now advertise the same ladder.
  const { adapter } = makeAdapter()
  const models = await adapter.listModels(PROVIDER_ID)
  const ladder = models.map(m => (m.reasoning?.efforts ?? []).map(e => e.id).join(','))
  check('every model advertises the same effort ladder', new Set(ladder).size === 1, [...new Set(ladder)].join(' | '))
  check('the ladder is the four tiers the menu offers', ladder[0] === 'low,medium,high,max', ladder[0])
  check('each effort carries a non-empty name', models.every(m => (m.reasoning?.efforts ?? []).every(e => typeof e.name === 'string' && e.name !== '')))

  // A model the manifest never heard of is exactly the case that regressed.
  const pro = models.find(m => m.id === 'deepseek-v4-pro')
  check('an unmapped model still gets an effort menu', pro?.reasoning?.efforts.length === 4, JSON.stringify(pro?.reasoning))

  // Defaults follow the installed manifest, not a hard-coded value from an
  // older CLI release. The same model can gain, remove, or change its default.
  const cli = adapter.describeCli()
  const deployment = adapter.deployment(cli.packageRoot)
  const manifest = readProductModels(cli.packageRoot, deployment.name)
  const declaredDefault = id => {
    const reasoning = manifest.get(id)?.reasoning ?? {}
    return reasoning.defaultEffort ?? reasoning.effort
  }
  const glm = models.find(m => m.id === 'glm-5.3')
  check('a declared default is preselected', declaredDefault('glm-5.3') !== undefined && glm?.reasoning?.defaultEffort === declaredDefault('glm-5.3'), JSON.stringify({ expected: declaredDefault('glm-5.3'), actual: glm?.reasoning?.defaultEffort }))
  const withoutDefault = models.find(model => declaredDefault(model.id) === undefined)
  check('an unmapped model invents no default', withoutDefault !== undefined && withoutDefault.reasoning?.defaultEffort === undefined, withoutDefault?.id)

  // The flag has to reach the CLI for an unmapped model too.
  const outcome = await turn(adapter, { model: 'deepseek-v4-pro', text: 'Reply with exactly: TIER', sessionId: `e2-${unique}`, effort: 'max' })
  check('an unmapped model accepts a chosen effort', outcome.threw === undefined && outcome.text.trim() === 'TIER', JSON.stringify(outcome.text))
}

// --- 8. Cancellation -------------------------------------------------------
{
  const { adapter } = makeAdapter()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 2500)
  const started = Date.now()
  const outcome = await turn(adapter, { model: 'deepseek-v4-pro', text: 'Write eight paragraphs about glaciers.', sessionId: `c-${unique}`, signal: controller.signal })
  const elapsed = Date.now() - started
  check('cancellation ends the turn promptly', elapsed < 12000, `${elapsed}ms`)
  check('cancellation does not hang', outcome.chunks.length >= 0)
  check('cancellation is reported as a failure, not a clean stop', outcome.threw !== undefined, String(outcome.threw?.message).slice(0, 60))
}

// --- 9. Unusable session id ------------------------------------------------
{
  const { adapter } = makeAdapter()
  const outcome = await turn(adapter, { model: 'glm-5.3', text: 'Reply OK', sessionId: 'DSH:Session:ABC123' })
  // The adapter hashes the id into a safe slug, so this must SUCCEED — proving
  // the derivation shields DSH's arbitrary ids from the CLI's filename rules.
  check('colon-bearing session id still works via derivation', outcome.threw === undefined && outcome.text.trim() !== '', JSON.stringify(outcome.text.slice(0, 40)))
}

// --- 10. Unknown model -----------------------------------------------------
{
  const { adapter } = makeAdapter()
  const outcome = await turn(adapter, { model: 'not-a-real-model', text: 'Reply OK', sessionId: `u-${unique}` })
  check('unknown model fails with a reported reason', outcome.threw !== undefined, String(outcome.threw?.message).slice(0, 80))
}

// --- 11. Prompt selection ---------------------------------------------------
{
  // DSH interleaves injected context after the human turn, all with
  // role:'user'. The adapter must answer the human text, not the reminder.
  const { latestUserText } = await import('../index.js')
  const shaped = [
    { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'REAL QUESTION' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd is ...' }] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] },
  ]
  check('prompt selection skips trailing injected context', latestUserText(shaped) === 'REAL QUESTION', latestUserText(shaped))
  // `dsh-time-context` appends a `role: 'user'` message whose source kind is
  // `time-context`, AFTER the human turn. Selecting by position made the CLI
  // receive only a timestamp, and it rightly answered "I don't see a request".
  const timed = [
    ...shaped,
    {
      role: 'user',
      source: { kind: 'time-context', form: 'snapshot' },
      content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: 2026-10-30T16:24:57+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\nElapsed since the preceding model-visible message: 30m 46s.' }],
    },
  ]
  check('prompt selection ignores a trailing time-context stamp',
    latestUserText(timed) === 'REAL QUESTION', JSON.stringify(latestUserText(timed).slice(0, 60)))
  check('prompt selection still prefers a human turn over a stamp alone',
    latestUserText([timed[1], timed[4]]) === 'REAL QUESTION', JSON.stringify(latestUserText([timed[1], timed[4]])))
  check('prompt selection falls back when sources are absent',
    latestUserText([{ role: 'user', content: [{ type: 'text', text: 'BARE' }] }]) === 'BARE')
  check('prompt selection ignores non-text blocks gracefully',
    latestUserText([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image' }, { type: 'text', text: 'caption' }] }]).includes('caption'))
  check('prompt selection returns empty for no user turn', latestUserText([{ role: 'assistant', content: [] }]) === '')
}

// --- 12. Tools -------------------------------------------------------------
{
  // The CLI runs its own tool loop inside one invocation. DSH executes every
  // `tool-call` block it is given, so the adapter reports the work as real
  // tool-call blocks paired with a display-only executor registered for that
  // agent — the card renders, and the tool never runs twice.
  const { adapter, tools } = makeAdapter()
  const probe = `tmp-tool-${unique}.txt`
  const outcome = await turn(adapter, {
    model: 'glm-5.3',
    // A path that exists whatever directory the matrix is started from: the CLI
    // runs in the process working directory, and the workspace root has no
    // package.json of its own.
    text: `Read the file dsh-connect-codebuddy-cli/package.json and reply with just its "name" value.`,
    sessionId: `x-${unique}`,
    registered: tools,
  })
  check('a tool-using turn still answers', outcome.threw === undefined && outcome.text.trim() !== '', JSON.stringify(outcome.text.slice(0, 60)))
  check('the answer reflects real file content', outcome.text.includes('dsh-connect-codebuddy-cli'), JSON.stringify(outcome.text.slice(0, 60)))
  check('tool activity is no longer reasoning text', !outcome.reasoning.includes('Running '), outcome.reasoning.slice(0, 90).replaceAll('\n', ' / '))
  check('every block type is one DSH can assemble',
    outcome.chunks.every(c => c.type !== 'block-start' || ['text', 'reasoning', 'tool-call'].includes(c.blockType)))

  const write = await turn(adapter, {
    model: 'glm-5.3',
    text: `Create a file named ${probe} containing exactly TOOLFILE, then reply DONE.`,
    sessionId: `x-${unique}`,
    registered: tools,
  })
  const { readFileSync, existsSync, rmSync } = await import('node:fs')
  const created = existsSync(probe) ? readFileSync(probe, 'utf8').trim() : ''
  if (existsSync(probe)) rmSync(probe)
  check('the CLI really wrote the file', created === 'TOOLFILE', JSON.stringify(created))
  check('the write is reported as a tool call', write.chunks.some(c => c.type === 'block-end' && c.block?.type === 'tool-call'),
    write.chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call').map(c => c.block.name).join(','))
}

/** True when no index carries both reasoning and text deltas. */
function distinctIndices(chunks) {
  const kinds = new Map()
  for (const chunk of chunks) {
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') continue
    const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
    const seen = kinds.get(chunk.index)
    if (seen === undefined) kinds.set(chunk.index, kind)
    else if (seen !== kind) return false
  }
  return true
}

// --- 13. Context metering -------------------------------------------------
// The composer meter divides `pressureTokens` by `contextWindow`. Both sides
// regressed once already: a duplicated cache share doubled the numerator, and
// a turn-total `result` usage overwrote the per-step sample.
{
  // CodeBuddy reports `input_tokens` as the WHOLE prompt with cache reads
  // already folded in; DSH re-adds the cached shares, so they must be removed
  // here. 162 + 2944 === 3106 is the identity measured off a real turn.
  const wire = { input_tokens: 3106, cache_read_input_tokens: 2944, cache_creation_input_tokens: 0, output_tokens: 198 }
  const mapped = usageOf(wire)
  const pressure = mapped.inputTokens + (mapped.cacheReadTokens ?? 0) + (mapped.cacheWriteTokens ?? 0)
  check('cached shares are not counted twice', pressure === 3106, `reconstructed ${pressure}, CLI reported 3106`)
  check('uncached input is the remainder', mapped.inputTokens === 162, JSON.stringify(mapped))

  // A fresh, uncached prompt must survive unchanged.
  const plain = usageOf({ input_tokens: 3039, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 108 })
  check('an uncached prompt maps unchanged', plain.inputTokens === 3039, JSON.stringify(plain))

  // Cache writes count too, and a wire that genuinely excludes them from
  // `input_tokens` must not produce a negative count.
  const writes = usageOf({ input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 200, output_tokens: 10 })
  check('cache writes are subtracted as well', writes.inputTokens === 300, JSON.stringify(writes))
  const over = usageOf({ input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 10 })
  check('an over-reported cache share clamps at zero', over.inputTokens === 0, JSON.stringify(over))

  // All-zero usage means the CLI reported nothing at all.
  check('all-zero usage maps to undefined', usageOf({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }) === undefined)

  // The denominator has to match the budget the CLI auto-compacts against.
  // `glm-5.3` declares no `contextWindow` at all and runs on its 1M ceiling;
  // `deepseek-v4.1-flash` declares a 300k default under the same 1M ceiling.
  check('a model with only maxInputTokens still gets a window', contextWindowFor({ maxInputTokens: 1000000 }) === 1000000)
  check('an explicit defaultLength wins over the ceiling', contextWindowFor({ contextWindow: { defaultLength: 300000 }, maxInputTokens: 1000000 }) === 300000)
  check('an absent manifest declares no window', contextWindowFor(undefined) === undefined)
}

// --- 14. Native tool cards -------------------------------------------------
{
  // DSH draws a card only for a `tool-call` block and dispatches every such
  // block, so the reported call must name a display-only definition that was
  // admitted before that step's tool set was frozen. A definition registered
  // from inside dispatch arrived too late and made DSH answer
  // `ToolNotFoundError`; nothing is registered that way any more.
  const { adapter: cardAdapter, tools } = makeAdapter()
  check('the fallback card tool is registered before the first turn', tools.registry.has(FALLBACK_TOOL_NAME))
  const admittedWhen = tools.whens.get(FALLBACK_TOOL_NAME)
  check('the card tools are admitted only for this provider', admittedWhen?.({ modelSelection: { provider: PROVIDER_ID } }) === true && admittedWhen?.({ modelSelection: { provider: 'deepseek' } }) === false)

  const cardFile = `tmp-card-${unique}.txt`
  const carded = await turn(cardAdapter, {
    model: 'glm-5.3',
    text: `Use the Write tool to create ${cardFile} containing exactly CARD-OK, then reply DONE.`,
    sessionId: `c-${unique}`,
    registered: tools,
  })
  const { existsSync, rmSync } = await import('node:fs')
  const cardWrote = existsSync(cardFile)
  if (cardWrote) rmSync(cardFile)

  const blocks = carded.chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call')
  const deltas = carded.chunks.filter(c => c.type === 'tool-call-delta')
  check('the tool call is reported as a card', blocks.length > 0, `${blocks.length} block(s)`)
  check('every card is introduced by a delta', blocks.every(b => deltas.some(d => d.index === b.index)))
  check('the card carries the CLI call id', blocks.every(b => typeof b.block.id === 'string' && b.block.id !== ''))
  check('card arguments are valid JSON', blocks.every((b) => { try { JSON.parse(b.block.arguments); return true } catch { return false } }))
  check('a name seen for the first time rides the fallback card',
    blocks.every(b => b.block.name === FALLBACK_TOOL_NAME), blocks.map(b => b.block.name).join(','))
  check('the fallback card carries the CLI tool name first', blocks.every((b) => {
    const keys = Object.keys(JSON.parse(b.block.arguments))
    return keys[0] === 'tool'
  }), blocks.map(b => Object.keys(JSON.parse(b.block.arguments))[0]).join(','))
  check('a CLI tool name is registered for the steps that follow', tools.registry.has('Write'), [...tools.registry.keys()].join(','))

  const first = blocks[0]
  if (first === undefined) {
    check('a card executor replays the CLI output', false, 'no tool call was produced')
  } else {
    // turn() already dispatched the card once. Inspect that real dispatch; a
    // second dispatch would consume nothing and is not how DSH uses the tool.
    const result = carded.dispatched.find(entry => entry.card.id === first.block.id)
    check('the card gets a resolvable executor', result?.definitionFound === true, first.block.name)
    check('the card body shows the CLI output', result?.body !== '' && result.body.includes(cardFile), JSON.stringify(result?.body?.slice(0, 80)))
  }
}

// --- 15. ptc fallback ------------------------------------------------------
{
  // In ptc mode DSH advertises only `run_code` and rejects every other call
  // before dispatch. Such a result never concludes the turn, so a card would
  // make DSH ask the CLI again for a second answer. The turn must fall back to
  // reporting the activity as text.
  const { adapter } = makeAdapter()
  const prompt = 'Use the Bash tool to run exactly `echo PTC-PROBE`, then reply with just the output.'
  const collapsed = await turn(adapter, {
    model: 'glm-5.3',
    text: prompt,
    sessionId: `ptc-${unique}`,
    tools: [{ name: 'run_code', description: 'x', parameters: {} }],
  })
  check('a collapsed toolset emits no tool cards', collapsed.chunks.every(c => c.type !== 'tool-call-delta'))
  check('a collapsed toolset still reports the activity', collapsed.reasoning.includes('Running '), collapsed.reasoning.slice(0, 60))
  check('a collapsed toolset still finishes', collapsed.finish?.kind === 'stop')

  const empty = await turn(adapter, { model: 'glm-5.3', text: prompt, sessionId: `ptc2-${unique}`, tools: [] })
  check('an empty tool list emits no tool cards', empty.chunks.every(c => c.type !== 'tool-call-delta'))

  const native = await turn(adapter, {
    model: 'glm-5.3',
    text: prompt,
    sessionId: `nat-${unique}`,
    tools: [{ name: 'Bash', description: 'b', parameters: {} }, { name: 'run_code', description: 'r', parameters: {} }],
  })
  check('a native toolset emits a card', native.chunks.some(c => c.type === 'tool-call-delta'),
    native.chunks.filter(c => c.type === 'tool-call-delta').map(c => c.name).join(','))
}

// --- 16. turn budget ------------------------------------------------------
{
  // `--max-turns` counts model calls, not tool calls, so a task that waits for
  // each result before deciding the next step spends a turn per step. A cap of
  // 30 failed such a run at exactly turn 30, so the default must be the CLI's
  // own 200 rather than a tighter guess.
  check('the default budget matches the CLI default', DEFAULT_MAX_TURNS === 200, String(DEFAULT_MAX_TURNS))

  const argv = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: 'p', entry: 'e' })
  const cap = argv[argv.indexOf('--max-turns') + 1]
  check('the default budget reaches the CLI', cap === '200', cap)

  const overridden = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: 'p', entry: 'e', maxTurns: 400 })
  check('an explicit budget overrides the default', overridden[overridden.indexOf('--max-turns') + 1] === '400')

  // A bad config value must fall back to the default rather than pass through.
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const argvBad = buildArgs({ model: 'glm-5.3', sessionId: 's', systemPromptFile: 'p', entry: 'e', maxTurns: bad })
    check(`a budget of ${String(bad)} falls back to the default`, argvBad[argvBad.indexOf('--max-turns') + 1] === '200', String(bad))
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  for (const failure of failed) console.log(`FAILED: ${failure.label} ${failure.detail}`)
  process.exitCode = 1
}
} finally {
  for (const adapter of liveAdapters) await adapter.dispose()
  rmSync(liveHome, { recursive: true, force: true })
}
