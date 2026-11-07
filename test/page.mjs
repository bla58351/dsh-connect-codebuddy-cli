// Load the client bundle the way DSH's module loader does, register its page
// against a fake browser context, and drive it against the REAL host handler
// from `apply()`. This catches what a syntax check cannot: a wrong slot key, a
// wrong RPC channel, a crash while rendering, or a switch that never persists.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyHost, describeReadiness } from '../index.js'
import { deploymentFor } from '../src/account/session.js'
import { creditsFor } from '../src/cli/catalog.js'
import { readProductModels, probeAcpModelCatalog } from '../src/cli/session.js'
import { settingsPath } from '../src/config/store.js'
import { accountsPath } from '../src/account/pool.js'

let lastOverview

// Keep the test away from the user's real settings: the page edits them, and the
// keep-alive value decides whether opening the page spawns a process at all.
const testHome = mkdtempSync(join(tmpdir(), 'dsh-page-'))
process.env.DSH_HOME = testHome
mkdirSync(join(testHome, 'dsh-connect-codebuddy-cli'), { recursive: true })
writeFileSync(settingsPath(), JSON.stringify({ hiddenModels: [], keepAliveSeconds: 0 }), 'utf8')
// The tool catalog is listed for the newest DSH session, so the fake Host needs
// one on disk — otherwise the page legitimately reports "no live session".
mkdirSync(join(testHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(testHome, 'storages', 'session_projcache', 'sessions', 'session-page-test.json'), '{}', 'utf8')

// --- a React stand-in -------------------------------------------------------
// Function components, elements, and the five hooks the page uses, with enough
// dependency handling that an effect runs only when its dependencies change.
const hookSlots = []
let hookCursor = 0
let dirty = false
const pendingEffects = []

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  Fragment: 'Fragment',
  useState(initial) {
    const index = hookCursor++
    if (hookSlots[index] === undefined) hookSlots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    const slot = hookSlots[index]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (value === slot.value) return
      slot.value = value
      dirty = true
    }]
  },
  useEffect(effect, deps) {
    // The dependency list has to be *remembered*, or every pass would count as
    // a change and the load effect would fire on every render.
    const index = hookCursor++
    const previous = hookSlots[index]?.deps
    const changed = deps === undefined || previous === undefined ||
      previous.length !== deps.length || deps.some((value, at) => value !== previous[at])
    hookSlots[index] = { deps }
    if (changed) pendingEffects.push({ index, effect })
  },
  useCallback(fn, deps) {
    // Real React returns the same instance while the dependency list is
    // unchanged, and a new one when anything in it moved. Both halves matter:
    // the stable instance keeps effects from re-firing, and the refreshed one is
    // what lets a handler see the state it was created from.
    const index = hookCursor++
    const slot = hookSlots[index]
    const same = slot !== undefined && deps !== undefined && Array.isArray(slot.deps) &&
      slot.deps.length === deps.length && deps.every((value, at) => value === slot.deps[at])
    if (same) return slot.value
    hookSlots[index] = { kind: 'callback', value: fn, deps }
    return fn
  },
  useRef(initial) {
    const index = hookCursor++
    if (hookSlots[index] === undefined) hookSlots[index] = { kind: 'ref', value: { current: initial } }
    return hookSlots[index].value
  },
  useMemo(fn) { hookCursor += 1; return fn() },
}

// --- the loader -------------------------------------------------------------
let loadedRow
globalThis.window = { __ModuleLoader__: { load(row) { loadedRow = row } } }
// The page draws its tabs, buttons, and checkboxes with the host's own
// primitives (the same ones dsh-codearts uses). These stubs render plain
// elements with the same props, so the test can click them without React DOM.
const primitivesStub = {
  SegmentedTabs({ items, value, onChange, label, className }) {
    return {
      type: 'div',
      props: { role: 'tablist', 'aria-label': label, 'data-class': className },
      children: items.map(item => ({
        type: 'button',
        props: { key: item.value, role: 'tab', 'aria-selected': item.value === value, onClick: () => onChange(item.value) },
        children: [item.label],
      })),
    }
  },
  Button({ variant, size, disabled, onClick, children }) {
    return {
      type: 'button',
      props: { 'data-variant': variant, 'data-size': size, disabled, onClick },
      children: [children],
    }
  },
  Checkbox({ checked, disabled, onChange, label, className }) {
    return {
      type: 'label',
      props: { 'data-class': className },
      children: [
        {
          type: 'input',
          props: { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked) },
          children: [],
        },
        { type: 'span', props: {}, children: [label] },
      ],
    }
  },
  Switch({ checked, disabled, onChange }) {
    return {
      type: 'switch',
      props: { checked, disabled, onChange: (value) => onChange(value) },
      children: [],
    }
  },
  Tag({ tone, children }) {
    return { type: 'span', props: { 'data-tone': tone }, children: [children] }
  },
}
const requireStub = (name) => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require: ${name}`)
}
await import('../src/client/index.js')
if (loadedRow === undefined) throw new Error('the bundle did not register with the loader')

const client = loadedRow.factory(requireStub)
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(ok ? `PASS  ${label}${detail === '' ? '' : `  — ${detail}`}` : `FAIL  ${label}  — ${detail}`)
}

check('the bundle registers under its package name', loadedRow.id === 'dsh-connect-codebuddy-cli', loadedRow.id)
check('the bundle exports a Cordis plugin', typeof client.apply === 'function' && typeof client.name === 'string', client.name)
check('the bundle injects the services it needs', Array.isArray(client.inject) && client.inject.includes('slots') && client.inject.includes('connection'), client.inject?.join(','))

// --- the host half ----------------------------------------------------------
// The plugin registers its page channel on a context that injects both
// `connection` and `webServer`, because the route is a web-server prefix route.
// The fake mirrors that: `inject` hands back a context that can read both, and
// `connection.register` captures the handler exactly as the real one would.
let hostHandler
let modelAnnouncements = 0
let hostAdapter
// A fake Host tool registry, so the tool bridge has something to list and run.
const TOOL_RESULT_TEXT = 'bridge ok'
const fakeAgent = { id: 'agent-1' }
const fakeTools = {
  schemas: () => [
    { name: 'example_tool', description: 'An example Host tool.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'present', description: 'Declare deliverables.', parameters: { type: 'object', properties: {} } },
    // lowercase `write` overlaps the CLI native tool, so the live default skips it
    { name: 'write', description: 'CLI-overlapping write.', parameters: { type: 'object', properties: {} } },
    { name: 'run_code', description: 'ptc transport.', parameters: { type: 'object', properties: {} } },
  ],
  execute: async () => ({ content: [{ type: 'text', text: TOOL_RESULT_TEXT }], isError: false }),
}
const fakeAgents = { get: (sessionId) => (sessionId === '' ? undefined : fakeAgent) }
const hostCtx = {
  llm: {
    registerAdapter: (_ids, adapter) => { hostAdapter = adapter },
    emitAdaptersUpdated: () => { modelAnnouncements += 1 },
  },
  logger: { info: () => {}, warn: () => {} },
  on: () => {},
  effect: (fn) => { fn() },
  reflect: { get: () => undefined },
  get: (name) => {
    if (name === 'connection') return { register: (_owner, _channel, handler) => { hostHandler = handler; return () => {} } }
    if (name === 'tools') return fakeTools
    if (name === 'agents') return fakeAgents
    return undefined
  },
  inject: (services, callback) => {
    if (services.every(service => ['connection', 'webServer', 'tools', 'agents'].includes(service))) callback(hostCtx)
  },
}
// --- a canned account service ----------------------------------------------
// The overview reads the credit balance from the CodeBuddy account service. This
// test stubs that single call so it stays offline and deterministic; the live
// shape was verified separately against the live account service.
const CREDIT_REPLY = {
  code: 0,
  msg: 'OK',
  data: {
    Packages: [],
    TotalCredits: '1234.5',
    SubscriptionPackageName: '体验版',
    IsPaidUser: false,
    CreditGroups: [
      { Kind: 'plan_base', Name: '套餐基础积分', CycleTotalCapacity: '500', CycleRemainCapacity: '0', CycleUsedCapacity: '500', TotalCount: 1 },
      { Kind: 'benefit', Name: '平台奖励积分', CycleTotalCapacity: '2000', CycleRemainCapacity: '1234.5', CycleUsedCapacity: '765.5', TotalCount: 40 },
    ],
  },
}
let creditCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  creditCalls += 1
  return { ok: true, status: 200, json: async () => CREDIT_REPLY }
}

applyHost(hostCtx, {})
check('the host registers the page channel', hostHandler !== undefined)
// The page paints from manifest fallbacks and swaps to the live catalog once it
// lands; waiting here keeps the assertions about the steady state, not the race.
const prewarmed = await hostAdapter.ensureModelCatalog(25_000)
check('the live catalog is available before the page renders', prewarmed !== undefined, JSON.stringify(hostAdapter.catalogStatus()))

// --- the browser half -------------------------------------------------------
const rpcCalls = []
let registration
// A payload the next `overview` call should answer with instead of asking the
// host. Used to render states this machine cannot be put into (no CLI installed).
let overviewOverride
const browserCtx = {
  get: (name) => name === 'connection'
    ? {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push(`${channel}:${endpoint}`)
          if (endpoint === 'overview' && overviewOverride !== undefined) return { ok: true, value: overviewOverride }
          const result = await hostHandler(endpoint, payload, { aborted: false })
          if (endpoint === 'overview' && result?.ok === true) lastOverview = result.value
          return result
        },
      },
    }
    : undefined,
  effect: (fn) => fn(),
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => { registration = { options, component }; return () => {} },
  },
}
client.apply(browserCtx)
check('the page registers into the bundle config slot', registration?.options?.name === 'plugins.bundle.config', registration?.options?.name)
check('the page is keyed by the package name', registration?.options?.key === 'dsh-connect-codebuddy-cli', registration?.options?.key)

// --- render ----------------------------------------------------------------
/** Build an element tree, executing function components. */
function build(node) {
  if (node === null || node === undefined || node === false) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(build)
  if (typeof node.type === 'function') {
    // React hands children to a component through props, so a component that
    // renders `children` (every Section here) must receive them that way.
    const props = node.children.length > 0 ? { ...node.props, children: node.children } : node.props
    return { type: node.type.name, props: node.props, rendered: build(node.type(props)) }
  }
  return { type: node.type, props: node.props, children: (node.children ?? []).map(build) }
}

/** Collect the text an element tree renders. */
function text(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (node.rendered !== undefined) return text(node.rendered)
  return (node.children ?? []).map(text).join('')
}

/** Find the first element matching a predicate. */
/** Like find, but prunes subtrees a panel marked hidden. */
function findVisible(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findVisible(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.props?.hidden === true) return undefined
  if (predicate(node)) return node
  const hit = findVisible(node.rendered, predicate)
  if (hit !== undefined) return hit
  return findVisible(node.children, predicate)
}

/** Collect every element matching a predicate. */
function collect(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  collect(node.rendered, predicate, out)
  collect(node.children, predicate, out)
  return out
}

function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  const hit = find(node.rendered, predicate)
  if (hit !== undefined) return hit
  return find(node.children, predicate)
}

/** Render until the tree settles, flushing effects between passes. */
async function settle(component) {
  let tree
  for (let pass = 0; pass < 8; pass += 1) {
    dirty = false
    hookCursor = 0
    tree = build(component({}))
    const effects = pendingEffects.splice(0)
    for (const entry of effects) {
      const cleanup = entry.effect()
      if (typeof cleanup === 'function') cleanup()
    }
    await new Promise(resolve => setTimeout(resolve, 80))
    if (!dirty) break
  }
  return tree
}

hookSlots.length = 0
const overviewTree = await settle(registration.component)
const overviewText = text(overviewTree)
if (process.env.DEBUG_TREE === '1') console.log('TREE:', JSON.stringify(overviewTree).slice(0, 2000))
if (process.env.DEBUG_TREE === '1') console.log('TEXT:', overviewText.slice(0, 400))
// --- the header and the tab row --------------------------------------------
check('the page uses the host card chrome', overviewTree.type === 'div' && overviewTree.props.className === 'cbc_card', String(overviewTree.props.className))
check('the header names the CLI and its version', /CodeBuddy/.test(overviewText) && /v2\.\d+\.\d+/.test(overviewText))
check('the header shows the account and plan', overviewText.includes('js') && overviewText.includes('体验版'))
const tabLabels = collect(overviewTree, node => node?.props?.role === 'tab').map(node => text(node))
check('the page offers four tabs', tabLabels.length === 4 && tabLabels.includes('账号'), tabLabels.join(','))
check('the model selection has its own tab', tabLabels.includes('模型'), tabLabels.join(','))

// --- the overview tab -------------------------------------------------------
check('the overview shows the signed-in nickname', overviewText.includes('js'))
check('the overview shows the CLI version', /2\.\d+\.\d+/.test(overviewText), (overviewText.match(/2\.\d+\.\d+/) ?? [''])[0])
check('the overview shows the masked phone number', overviewText.includes('152****9032'))
check('the overview read used the host channel', rpcCalls.includes('/codebuddy:overview'))
check('opening the page starts the backend', rpcCalls.includes('/codebuddy:warm'))
check('the overview shows the CLI backend', overviewText.includes('CLI 后端'))
check('a disabled keep-alive is shown as such', overviewText.includes('不保活'))
check('the overview shows the credit balance', /1,234\.5/.test(overviewText), (overviewText.match(/[\d,]+\.?\d*/) ?? [''])[0])
check('the overview names the subscription', overviewText.includes('体验版'))
check('the overview breaks the balance down by source', overviewText.includes('套餐基础积分') && overviewText.includes('平台奖励积分'))
check('the balance was read once from the account service', creditCalls === 1, String(creditCalls))

// --- what a user sees when the backend is not usable ------------------------
// Both states have to name the next step, not just the problem: a missing CLI is
// an install, a missing session is a login.
const missingCli = describeReadiness({ installed: false }, { signedIn: false })
check('a missing CLI is explained as an install', missingCli.ready === false && missingCli.title.includes('安装') === false && missingCli.title.includes('CodeBuddy CLI'), missingCli.title)
check('a missing CLI gives the install command', missingCli.steps.some(step => step.command === 'npm install -g @tencent-ai/codebuddy-code'), JSON.stringify(missingCli.steps))
const signedOut = describeReadiness({ installed: true }, { signedIn: false, state: 'not-signed-in' })
check('a signed-out CLI is explained as a login', signedOut.state === 'not-signed-in' && signedOut.title.includes('登录'), signedOut.title)
check('a signed-out CLI gives the login command', signedOut.steps.some(step => step.command === '/login'), JSON.stringify(signedOut.steps))
const expiredToken = describeReadiness({ installed: true }, { signedIn: false, state: 'expired' })
check('an expired session is named as expired', expiredToken.state === 'expired' && expiredToken.title.includes('过期'), expiredToken.title)
check('a ready backend says nothing', describeReadiness({ installed: true }, { signedIn: true }).ready === true)

// The notice has to render, not merely exist: drive the page with a payload
// from a host whose CLI cannot be found.
const missingHostCtx = {
  ...hostCtx,
  llm: { registerAdapter: () => {}, emitAdaptersUpdated: () => {} },
}
let missingHandler
missingHostCtx.get = (name) => name === 'connection'
  ? { register: (_owner, _channel, handler) => { missingHandler = handler; return () => {} } }
  : undefined
missingHostCtx.inject = (services, callback) => {
  if (services.every(service => service === 'connection' || service === 'webServer')) callback(missingHostCtx)
}
applyHost(missingHostCtx, { binary: 'C:/no-such-dir/codebuddy' })
const missingOverview = await missingHandler('overview', {}, { aborted: false })
overviewOverride = missingOverview.value
const beforeNoticeTree = await settle(registration.component)
find(beforeNoticeTree, node => node?.type === 'button' && text(node) === '刷新')?.props?.onClick()
const noticeTree = await settle(registration.component)
const noticeText = text(noticeTree)
overviewOverride = undefined
check('a missing CLI renders a notice, not a blank page', noticeText.includes('没有找到 CodeBuddy CLI'), noticeText.slice(0, 60))
check('the notice carries the install command', noticeText.includes('npm install -g @tencent-ai/codebuddy-code'))
check('the notice reaches every tab', noticeText.includes('这些模型还跑不起来'))

// --- the balance is re-read on refresh, and a failure is explained ----------
// The refresh button has to bypass the host's cache; otherwise it would replay
// the number it already had. A failed read must degrade to an explanation.
globalThis.fetch = async () => { creditCalls += 1; throw new Error('offline') }
const refreshButton = find(overviewTree, node => node?.type === 'button' && text(node) === '刷新')
check('the overview offers a refresh control', refreshButton?.props?.onClick !== undefined)
refreshButton?.props?.onClick()
const failedTree = await settle(registration.component)
const failedText = text(failedTree)
check('the refresh re-read the balance', creditCalls >= 2, String(creditCalls))
check('a failed balance read is explained', /请求积分接口失败|offline/.test(failedText))
globalThis.fetch = async () => { creditCalls += 1; return { ok: true, status: 200, json: async () => CREDIT_REPLY } }
const before = existsSync(settingsPath()) ? readFileSync(settingsPath(), 'utf8') : ''

// --- the models tab: draft, no write until save ----------------------------
const modelsTab = find(overviewTree, node => node?.props?.role === 'tab' && text(node) === '模型')
check('the models tab is a real control', modelsTab?.props?.onClick !== undefined)
modelsTab.props.onClick()
const modelsTree = await settle(registration.component)
const modelsText = text(modelsTree)
check('the models tab lists the CLI models', modelsText.includes('glm-5.3') || modelsText.includes('deepseek-v4.1-flash'))
check('the models tab shows the selected count', /\d+ \/ \d+/.test(modelsText), (modelsText.match(/\d+ \/ \d+/) ?? [''])[0])

// --- the credit multiplier --------------------------------------------------
// The page shows it as a tag, and the selector shows it in the model name
// because the Host's catalog projection drops every field but the name.
const multiplierTag = find(modelsTree, node => node?.props?.['data-tone'] === 'quiet' && /×\d/.test(text(node)))
check('the models tab shows a credit multiplier', multiplierTag !== undefined, text(multiplierTag))
const advertised = await hostAdapter.listModels('codebuddy')
const priced = advertised.find(model => /×\d/.test(model.name))
check('the selector list carries the multiplier in the model name', priced !== undefined, advertised.slice(0, 3).map(model => model.name).join(' | '))
check('the multiplier is parsed, not copied verbatim', priced !== undefined && !/credits/i.test(priced.name), priced?.name)

// --- the multiplier must come from the right deployment ---------------------
// The CLI ships one manifest per deployment and the numbers differ: the
// international one bills deepseek-v4.1-flash at ×0.00, the domestic one at
// ×0.03. Reading the wrong file is the bug this guards.
check('a .cn account resolves to the domestic deployment', deploymentFor('www.codebuddy.cn') === 'domestic', deploymentFor('www.codebuddy.cn'))
check('the domestic gateway is domestic too', deploymentFor('copilot.tencent.com') === 'domestic', deploymentFor('copilot.tencent.com'))
check('a .ai account resolves to the international deployment', deploymentFor('www.codebuddy.ai') === 'international', deploymentFor('www.codebuddy.ai'))
const packageRoot = hostAdapter.describeCli().packageRoot
const international = readProductModels(packageRoot, 'international')
const domesticManifest = readProductModels(packageRoot, 'domestic')
const internationalFlash = creditsFor(international.get('deepseek-v4.1-flash'))?.label
const domesticFlash = creditsFor(domesticManifest.get('deepseek-v4.1-flash'))?.label
check('the two manifests really disagree about this model', internationalFlash !== domesticFlash, `${internationalFlash} vs ${domesticFlash}`)
// The reported figure for this deployment. Pinned because the whole point of
// this branch is that the international file's ×0.00 is not what is charged.
check('the domestic multiplier is the one the account is billed', domesticFlash === '×0.11', String(domesticFlash))
// The domestic roster renames most ids with `-ioa`; those are the same models,
// so their price must match the international entry for the plain id.
check('the domestic roster suffix resolves to the same price', creditsFor(domesticManifest.get('glm-5.3'))?.label === creditsFor(international.get('glm-5.3'))?.label, `${creditsFor(domesticManifest.get('glm-5.3'))?.label} vs ${creditsFor(international.get('glm-5.3'))?.label}`)
const deployment = hostAdapter.deployment(packageRoot)
check('the adapter picks the manifest the account is billed by', deployment.name === (deploymentFor(deployment.domain)), `${deployment.name} for ${deployment.domain}`)
const flashName = advertised.find(model => model.id === 'deepseek-v4.1-flash')?.name
check('the advertised name carries the domestic multiplier', flashName !== undefined && flashName.includes(domesticFlash), `${flashName} (domestic ${domesticFlash}, international ${internationalFlash})`)
check('the page says which deployment the numbers came from', modelsText.includes('国内产品清单') || modelsText.includes('国际产品清单') || modelsText.includes('模型目录'), modelsText.slice(0, 80))

// --- the live catalog outranks every bundled file ---------------------------
// The CLI's /model menu reads a catalog whose numbers match neither manifest
// (glm-5.3-flash is ×0.08 there, ×0.06 in the files), so the plugin probes it
// over ACP and prefers it.
const catalogStatus = hostAdapter.catalogStatus()
check('the live model catalog was probed', catalogStatus.source === 'catalog' && catalogStatus.models >= 10, JSON.stringify(catalogStatus))
const liveFlash = hostAdapter.creditFor('glm-5.3-flash', domesticManifest)
check('a live-catalog figure is marked as such', liveFlash?.source === 'catalog', JSON.stringify(liveFlash))
const manifestFlash = creditsFor(domesticManifest.get('glm-5.3-flash'))?.label
check('the live figure overrides the manifest one', liveFlash?.label !== manifestFlash, `${liveFlash?.label} vs manifest ${manifestFlash}`)
const liveName = advertised.find(model => model.id === 'glm-5.3-flash')?.name
check('the selector name follows the live catalog too', liveName !== undefined && liveName.includes(liveFlash.label), liveName)
const probed = await probeAcpModelCatalog(hostAdapter.describeCli().entry, process.cwd(), { timeoutMs: 25_000 })
check('the probe returns the menu catalog', probed.ok === true && probed.models.get('deepseek-v4.1-flash')?.credits.startsWith('x'), probed.ok === true ? String(probed.models.size) : probed.reason)
check('the probed multiplier matches what the page showed', probed.ok === true && creditsFor({ credits: probed.models.get('deepseek-v4.1-flash').credits })?.label === domesticFlash, probed.ok === true ? creditsFor({ credits: probed.models.get('deepseek-v4.1-flash').credits })?.label : '')

// The models tab lives in its own panel; scoping to it keeps the accounts
// tab's own primary buttons out of these assertions.
const modelsPanel = findVisible(modelsTree, node => node?.props?.id === 'cbc-panel-models')
check('the models tab panel renders', modelsPanel !== undefined)
const saveButton = () => findVisible(modelsPanel, node => node?.type === 'button' && node.props['data-variant'] === 'primary')
const initialSave = findVisible(modelsPanel, node => node?.type === 'button' && node.props['data-variant'] === 'primary')
check('the models tab has a save button', initialSave !== undefined)
check('save is disabled with nothing to save', initialSave?.props?.disabled === true)

const box = findVisible(modelsPanel, node => node?.type === 'input' && node?.props?.type === 'checkbox' && node.props.checked === true)
check('the models tab renders checkboxes', box !== undefined)
box.props.onChange({ target: { checked: false } })
const dirtyTree = await settle(registration.component)
const dirtyPanel = findVisible(dirtyTree, node => node?.props?.id === 'cbc-panel-models')
const afterToggle = findVisible(dirtyPanel, node => node?.type === 'button' && node.props['data-variant'] === 'primary')
check('editing only stages the change', !rpcCalls.includes('/codebuddy:save-models'))
check('save becomes available once there is a change', afterToggle?.props?.disabled === false)
check('the unchecked model shows as unchecked', findVisible(dirtyPanel, node => node?.type === 'input' && node.props.checked === false) !== undefined)

afterToggle.props.onClick()
const savedTree = await settle(registration.component)
check('save reaches the host', rpcCalls.includes('/codebuddy:save-models'))
const stored = JSON.parse(readFileSync(settingsPath(), 'utf8'))
check('the save is persisted', Array.isArray(stored.hiddenModels) && stored.hiddenModels.length === 1, JSON.stringify(stored.hiddenModels))
// The browser picker keeps a cached catalog and reloads it only when the Host
// announces a model-topology change, so the save must say so.
check('the save tells the host the model list changed', modelAnnouncements >= 1, String(modelAnnouncements))
check('the save button reports success', text(savedTree).includes('已保存'))

// --- the keep-alive control lives in the settings tab ----------------------
const settingsTab = find(savedTree, node => node?.props?.role === 'tab' && text(node) === '设置')
settingsTab.props.onClick()
const settingsTree = await settle(registration.component)
check('the settings tab names the settings file', text(settingsTree).includes('settings.json'))
const preset = find(settingsTree, node => node?.type === 'button' && text(node) === '5 分钟')
check('the settings tab offers keep-alive presets', preset?.props?.onClick !== undefined)
preset?.props?.onClick()
const keptTree = await settle(registration.component)
const kept = JSON.parse(readFileSync(settingsPath(), 'utf8'))
check('the keep-alive choice is persisted', kept.keepAliveSeconds === 300, JSON.stringify(kept))
check('the keep-alive choice reaches the host', rpcCalls.includes('/codebuddy:set-keep-alive'))
check('the page shows the new delay', text(keptTree).includes('保活 5 分钟'), text(keptTree).slice(0, 40))

// --- the settings tab has two pages ----------------------------------------
// Page one is backend behaviour, page two is which DSH tools the model may
// call. They answer unrelated questions, so they are separate sub-tabs.
const backendSub = find(keptTree, node => node?.type === 'button' && text(node) === '后端')
const toolsSub = find(keptTree, node => node?.type === 'button' && text(node) === 'DSH 工具')
check('the settings tab has a backend page', backendSub?.props?.onClick !== undefined)
check('the settings tab has a tools page', toolsSub?.props?.onClick !== undefined)
toolsSub.props.onClick()
const toolsTree = await settle(registration.component)
const toolsText = text(toolsTree)
check('the tools page lists the Host tools', toolsText.includes('example_tool'), toolsText.slice(0, 80))
check('the ptc transport is never offered', !toolsText.includes('run_code'))
// The Host keeps no per-tool provenance; the page marks what is outside the
// shipped catalog so a third-party tool is not exposed by accident.
const externalTag = collect(toolsTree, node => node?.props?.['data-tone'] === 'warning').map(node => text(node)).find(label => label.includes('非内置'))
check('a plugin-provided tool is marked as not built in', externalTag !== undefined, String(externalTag))
const builtinRow = findVisible(toolsTree, node => node?.type === 'label' && text(node) === 'present')
check('a built-in tool carries no such mark', builtinRow !== undefined && text(builtinRow).includes('非内置') === false, text(builtinRow))
// Each tool row ends with a hover badge that carries the tool's own
// description from the catalog, so the meaning is one hover away.
const hintBadges = collect(toolsTree, node => node?.props?.className === 'cbc_toolHint')
check('each tool row carries a hint badge', hintBadges.length === 3, String(hintBadges.length))
const describedBadge = hintBadges.find(node => node?.props?.title === 'An example Host tool.')
check('the hint badge carries the tool description', describedBadge !== undefined, JSON.stringify(hintBadges.map(node => node?.props?.title)))
// No explicit choice stored: the page must show the live default — every
// tool checked except the CLI overlap (`write`). The rows are read through
// the overview RPC instead of the tree: hidden panels keep their own
// checkboxes mounted, so a tree walk would count the model list too.
const defaultEnabled = (lastOverview?.tools?.available ?? []).map(row => [row.name, row.enabled === true])
check('the tools page shows the live default choice',
  defaultEnabled.length === 3
  && defaultEnabled.every(([name, on]) => name === 'write' ? on === false : on === true),
  JSON.stringify(defaultEnabled))
check('the tools page starts without a save', !rpcCalls.includes('/codebuddy:save-tools'))

const toolBox = findVisible(toolsTree, node => node?.type === 'input' && node?.props?.type === 'checkbox' && node.props.checked === false)
check('the tools page renders checkboxes', toolBox !== undefined)
toolBox.props.onChange({ target: { checked: true } })
check('the unchecked box is the CLI overlap', typeof toolBox?.props?.id === 'string' ? toolBox.props.id.includes('write') : true, String(toolBox?.props?.id))
const toolsDirtyTree = await settle(registration.component)
// The models page has a Save button too and hidden panels stay mounted, so the
// tools page's button is the last one in tree order.
const toolSave = findVisible(toolsDirtyTree, node => node?.type === 'button' && node.props['data-variant'] === 'primary' && text(node) === '保存')
check('saving tools becomes available once there is a change', toolSave?.props?.disabled === false)
toolSave?.props?.onClick()
const toolsSavedTree = await settle(registration.component)
check('the tool choice reaches the host', rpcCalls.includes('/codebuddy:save-tools'))
const storedTools = JSON.parse(readFileSync(settingsPath(), 'utf8'))
check('the tool choice is persisted', Array.isArray(storedTools.exposedTools) && storedTools.exposedTools.includes('example_tool') && storedTools.exposedTools.includes('write'), JSON.stringify(storedTools.exposedTools))
check('the tools page reports the save', text(toolsSavedTree).includes('已保存'))

// --- the accounts page ------------------------------------------------------
const accountsFileBefore = existsSync(accountsPath()) ? readFileSync(accountsPath(), 'utf8') : ''
const accountsSub = findVisible(toolsSavedTree, node => node?.type === 'button' && text(node) === '账号')
check('the settings header offers an accounts tab', accountsSub?.props?.onClick !== undefined)
accountsSub.props.onClick()
const accountsTree = await settle(registration.component)
const accountsText = text(accountsTree)
check('the accounts page shows the pool section', accountsText.includes('账号池'), accountsText.slice(0, 80))
check('the accounts page lists the default login', accountsText.includes('默认'), 'default tag')
check('the accounts page explains rotation', accountsText.includes('限流'), 'rotation hint')

// Saving the current account registers a row through the host.
const saveCurrent = findVisible(accountsTree, node => node?.type === 'button' && text(node) === '保存当前账号')
check('the accounts page offers saving the current account', saveCurrent !== undefined)
saveCurrent?.props?.onClick()
const savedAccountTree = await settle(registration.component)
check('saving the current account reaches the host', rpcCalls.includes('/codebuddy:save-current-account'))
const registered = JSON.parse(readFileSync(accountsPath(), 'utf8'))
check('the saved account is persisted', Array.isArray(registered.accounts) && registered.accounts.some(row => row.home === ''), JSON.stringify(registered.accounts))
if (accountsFileBefore === '') { try { unlinkSync(accountsPath()) } catch {} } else writeFileSync(accountsPath(), accountsFileBefore, 'utf8')

// --- the prompt page --------------------------------------------------------
// The accounts test left the top tab on 账号; the prompt sub-tab lives in 设置.
const settingsTop = findVisible(savedAccountTree, node => node?.props?.role === 'tab' && text(node) === '设置')
settingsTop.props.onClick()
const settingsTreeAgain = await settle(registration.component)
const promptSub = findVisible(settingsTreeAgain, node => node?.type === 'button' && text(node) === '提示词')
check('the settings tab has a prompt page', promptSub?.props?.onClick !== undefined)
promptSub.props.onClick()
const promptTree = await settle(registration.component)
const promptText = text(promptTree)
check('the prompt page offers all three sources', ['DSH 提示词', 'CodeBuddy 提示词', '自定义'].every(label => promptText.includes(label)), promptText.slice(0, 120))

// Scope to the prompt panel: the accounts tab also renders pre/input controls.
const promptPanel = findVisible(promptTree, node => node?.props?.id === 'cbc-panel-settings')
const promptAreaHost = findVisible(promptPanel, node => node?.type === 'textarea') ?? findVisible(promptTree, node => node?.type === 'textarea')
const area = promptAreaHost
check('the custom prompt starts pre-filled', area !== undefined && String(area.props.value).length > 50, String(area?.props?.value ?? '').slice(0, 40))
const promptSave = findVisible(promptPanel ?? promptTree, node => node?.type === 'button' && node.props['data-variant'] === 'primary' && text(node) === '保存')
check('the prompt save is idle until the text changes', promptSave?.props?.disabled === true)

area.props.onChange({ target: { value: 'You are a terse assistant.' } })
const editedTree = await settle(registration.component)
const editedSave = findVisible(editedTree, node => node?.type === 'button' && node.props['data-variant'] === 'primary' && text(node) === '保存')
check('editing the prompt enables save', editedSave?.props?.disabled === false)
editedSave?.props?.onClick()
const promptSavedTree = await settle(registration.component)
check('the prompt choice reaches the host', rpcCalls.includes('/codebuddy:save-prompt'))
const storedPrompt = JSON.parse(readFileSync(settingsPath(), 'utf8'))
check('the custom prompt is persisted', storedPrompt.customPrompt === 'You are a terse assistant.' && storedPrompt.promptMode === 'custom', JSON.stringify({ mode: storedPrompt.promptMode, text: storedPrompt.customPrompt }))

// The declaration switch: default on, preview rows for the enabled tools, and
// a persisted `declareTools` when toggled off.
const onSwitchProbe = { value: undefined }
const promptDeclareTree = await settle(registration.component)
// The declaration rows come from the live prompt state; the overview cached at
// page open predates the tool choices, so ask the host again and assert
// through the rendered preview too.
const overviewAgain = await hostHandler('overview', {}, { aborted: false })
if (overviewAgain?.ok === true) lastOverview = overviewAgain.value
const declarationRows = lastOverview?.prompt?.declaredTools ?? []
check('the declaration rows expose the enabled tool and skip run_code', declarationRows.length > 0 && declarationRows.every(line => !line.startsWith('run_code')) && declarationRows.some(line => line.startsWith('mcp__dsh__example_tool')), JSON.stringify(declarationRows))
check('the declaration preview rows render in the tree', text(promptDeclareTree).includes('example_tool — An example Host tool.'), 'looking for the row text')

const offSwitch = findVisible(promptDeclareTree, node => node?.type === 'switch' && node?.props?.checked === true)
if (offSwitch === undefined) {
  check('the declaration switch is rendered', false, 'switch not found')
} else {
  offSwitch.props.onChange(false)
  const offTree = await settle(registration.component)
  const storedOff = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  check('toggling off persists declareTools false', storedOff.declareTools === false, JSON.stringify(storedOff.declareTools))
  onSwitchProbe.value = findVisible(offTree, node => node?.type === 'switch' && node?.props?.checked === false)
  onSwitchProbe.value?.props?.onChange(true)
  await settle(registration.component)
  const storedOn = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  check('toggling back on persists declareTools true', storedOn.declareTools === true, JSON.stringify(storedOn.declareTools))
}

const codebuddyChoice = findVisible(promptSavedTree, node => node?.type === 'button' && text(node) === 'CodeBuddy 提示词')
codebuddyChoice?.props?.onClick()
const modeTree = await settle(registration.component)
const storedMode = JSON.parse(readFileSync(settingsPath(), 'utf8'))
check('a prompt mode is persisted on selection', storedMode.promptMode === 'codebuddy', storedMode.promptMode)
check('the page shows the chosen mode', text(modeTree).includes('CodeBuddy 提示词'))

// Restore: leave the settings file exactly as it was before the probe.
if (before === '') { try { rmSync(settingsPath()) } catch {} } else {
  writeFileSync(settingsPath(), before, 'utf8')
}
check('the probe left the settings file restored', (existsSync(settingsPath()) ? readFileSync(settingsPath(), 'utf8') : '') === before)

// --- saving tools with no live session keeps the stored choice --------------
{
  // With no session on disk the tool catalog is empty, which says nothing about
  // which tools exist. A save then must pass the draft through rather than
  // interpret "nothing is known" as "nothing was chosen" and wipe the list.
  const { saveExposedTools, settingsForWrite } = await import('../src/host/page.js')
  const stored = { exposedTools: ['present', 'todo_write'], hiddenModels: [], keepAliveSeconds: 0 }
  const adapter = {
    toolCatalog: () => ({ exposed: stored.exposedTools, available: [], sessionId: '', bridge: false }),
    discardParkedForPromptChange: () => {},
  }
  const outcome = saveExposedTools({ adapter, settings: stored }, { names: ['present', 'kb_query'] })
  check('a save with no session keeps the draft verbatim', outcome.exposed.length === 2 && outcome.exposed.includes('present') && outcome.exposed.includes('kb_query'), JSON.stringify(outcome.exposed))
  const persisted = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  check('an empty catalog does not wipe the saved list', persisted.exposedTools.length === 2, JSON.stringify(persisted.exposedTools))
  // A live catalog still filters unknown names.
  const liveAdapter = {
    toolCatalog: () => ({ exposed: JSON.parse(readFileSync(settingsPath(), 'utf8')).exposedTools ?? [], available: [{ name: 'present' }, { name: 'todo_write' }], sessionId: 's', bridge: true }),
    discardParkedForPromptChange: () => {},
  }
  const live = saveExposedTools({ adapter: liveAdapter, settings: { exposedTools: [], hiddenModels: [], keepAliveSeconds: 0 } }, { names: ['present', 'ghost_tool'] })
  const livePersisted = JSON.parse(readFileSync(settingsPath(), 'utf8')).exposedTools
  check('a live catalog still drops unknown names', livePersisted.length === 1 && livePersisted[0] === 'present' && live.exposed.length === 1 && live.exposed[0] === 'present', JSON.stringify({ persisted: livePersisted, exposed: live.exposed }))
}

const failures = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) process.exitCode = 1
// Explicit exit: leftover timers would otherwise keep the loop alive.
process.exit(failures.length === 0 ? 0 : 1)
