/**
 * Expose DSH tools to the CLI over a loopback MCP bridge.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/bridge/tools
 */

import { createToolBridge, toMcpInputSchema } from './mcp.js'
import { hasExposedToolsChoice } from '../config/store.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** Tool names the CLI already provides itself, used only to flag the overlap. */
const CLI_TOOL_NAMES = new Set([
  'bash', 'powershell', 'read', 'write', 'edit', 'grep', 'glob',
  'web_fetch', 'web_search', 'view_image', 'tool_search', 'defer_execute_tool',
])

/**
 * The tool choice to serve when the user has never made one.
 *
 * Every cataloged tool except `run_code` and the names the CLI already
 * provides itself: the point of the bridge is DSH-only capability, and a
 * bridged duplicate would only shadow the CLI native one. The list is
 * therefore live — it follows whatever the Host currently registers.
 * @param schemas - the Host tool schemas (`tools.schemas(agent)`).
 * @returns the default exposed tool names, in catalog order.
 */
function defaultExposedTools(schemas) {
  if (!Array.isArray(schemas)) return []
  return schemas
    .map(schema => schema?.name)
    .filter(name => typeof name === 'string' && name !== '' && name !== 'run_code' && !CLI_TOOL_NAMES.has(name))
}

/**
 * Bridge DSH's own tools into the CLI over MCP.
 *
 * The CLI will never call back into the Host by itself, but it does speak MCP and
 * takes an inline `--mcp-config` per invocation. So this starts a loopback
 * listener, ships a stdio shim the CLI can spawn, and answers `tools/list` /
 * `tools/call` from the Host's own registry. Calls run through `tools.execute`,
 * which means the normal policy and approval pipeline applies — the model is not
 * handed a back door.
 *
 * Registration waits for both services because `tools` is read through the Host
 * context: a headless composition without them simply never bridges.
 *
 * @param ctx - the plugin's Cordis context.
 * @param adapter - the provider adapter that will pass the config to each turn.
 * @param settings - the live settings state (which tools are exposed).
 */
function installToolBridge(ctx, adapter, settings) {
  if (typeof ctx.inject !== 'function') return
  // The shim lives beside this module: `src/bridge/shim.mjs`. The relative
  // reference must stay in step with this file's own directory — it was once
  // written as `./src/bridge/shim.mjs` when the code lived at the package root,
  // which resolved to a path that does not exist and made every shim spawn die
  // with ERR_MODULE_NOT_FOUND.
  const shimPath = fileURLToPath(new URL('./shim.mjs', import.meta.url))
  const services = { tools: undefined, agents: undefined }
  const bridge = createToolBridge({
    logger: ctx.logger,
    resolveTools: sessionId => listBridgeTools(services, settings, sessionId),
    executeTool: request => runBridgeTool(services, settings, request),
  })
  adapter.attachToolBridge(bridge, shimPath)
  ctx.inject(['tools', 'agents'], (inner) => {
    const read = name => (typeof inner.get === 'function' ? inner.get(name) : inner[name])
    services.tools = read('tools')
    services.agents = read('agents')
    adapter.attachToolServices(services)
    void bridge.start()
    inner.effect(() => () => { void bridge.close() }, 'dsh-connect-codebuddy-cli: MCP tool bridge')
  })
}

/**
 * The tool list that governs the bridge: the stored choice when the settings
 * file carries one, otherwise the live default — everything the Host
 * registers except `run_code` and the CLI overlaps.
 * @param services - the injected services.
 * @param settings - the live settings state.
 * @param sessionId - the DSH session id.
 * @returns the effective exposed tool names.
 */
function effectiveExposedTools(services, settings, sessionId) {
  const stored = Array.isArray(settings.exposedTools) ? settings.exposedTools : []
  if (hasExposedToolsChoice()) return stored
  const agent = agentOf(services, sessionId)
  if (agent === undefined || services.tools === undefined) return stored
  try {
    return defaultExposedTools(services.tools.schemas(agent))
  } catch {
    return stored
  }
}
/**
 * Resolve the agent that owns one DSH session.
 * @param services - the injected `tools`/`agents` services.
 * @param sessionId - the DSH session id.
 * @returns the agent, or `undefined` when it is not running.
 */
function agentOf(services, sessionId) {
  if (services.agents === undefined || typeof services.agents.get !== 'function') return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return services.agents.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * The MCP tool list for one session: only what the user enabled, never the ptc
 * transport, and never a tool the model could use to start another model call.
 * @param services - the injected services.
 * @param settings - the live settings state.
 * @param sessionId - the DSH session id.
 * @returns MCP tool descriptors.
 */
function listBridgeTools(services, settings, sessionId) {
  const agent = agentOf(services, sessionId)
  if (agent === undefined || services.tools === undefined) return []
  let schemas
  try {
    schemas = services.tools.schemas(agent)
  } catch {
    return []
  }
  // The stored choice when the settings file carries one; otherwise the live
  // default — everything except `run_code` and the CLI overlaps.
  const chosen = hasExposedToolsChoice() ? settings.exposedTools : defaultExposedTools(schemas)
  const exposed = new Set(chosen)
  if (exposed.size === 0) return []
  return schemas
    .filter(schema => schema.name !== 'run_code' && exposed.has(schema.name))
    .map(schema => ({
      name: schema.name,
      description: typeof schema.description === 'string' && schema.description !== ''
        ? schema.description
        : `DSH tool ${schema.name}`,
      inputSchema: toMcpInputSchema(schema.parameters),
    }))
}

/**
 * Run one bridged tool through the Host's dispatch pipeline.
 * @param services - the injected services.
 * @param settings - the live settings state.
 * @param request - `{ sessionId, name, arguments }`.
 * @returns `{ ok, text, isError }`.
 */
async function runBridgeTool(services, settings, request) {
  const name = request.name
  if (!effectiveExposedTools(services, settings, request.sessionId).includes(name)) return { ok: false, error: `工具 ${name} 没有启用` }
  if (name === 'run_code') return { ok: false, error: 'run_code 不能作为桥接工具' }
  const agent = agentOf(services, request.sessionId)
  if (agent === undefined) return { ok: false, error: '会话不在运行中，无法执行该工具' }
  if (services.tools === undefined || typeof services.tools.execute !== 'function') {
    return { ok: false, error: '宿主没有提供工具执行接口' }
  }
  const result = await services.tools.execute({
    callId: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    rootCallId: undefined,
    name,
    arguments: request.arguments ?? {},
    agent,
    // The Host's dispatch reads this signal, so omitting it fails inside the
    // pipeline rather than at the boundary.
    signal: request.signal ?? new AbortController().signal,
  })
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return { ok: true, text, ...(result?.isError === true ? { isError: true } : {}) }
}

/**
 * Whether the step advertises only the ptc transport.
 *
 * DSH's `wireSchemas` publishes every tool in native mode and exactly
 * `run_code` in ptc mode, so a request whose tool list is empty or holds only
 * `run_code` is one where a reported call cannot be dispatched. An absent
 * list means the request carried no tools at all, which is the same situation.
 * @param tools - the request's advertised tool schemas.
 * @returns true when tool cards cannot be dispatched this step.
 */
function isCollapsedToolset(tools) {
  if (!Array.isArray(tools)) return false
  return tools.every(tool => tool?.name === 'run_code')
}

export {
  CLI_TOOL_NAMES,
  agentOf,
  defaultExposedTools,
  effectiveExposedTools,
  installToolBridge,
  isCollapsedToolset,
  listBridgeTools,
  runBridgeTool,
}
