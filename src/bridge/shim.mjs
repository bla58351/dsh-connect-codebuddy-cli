/**
 * The stdio half of the DSH tool bridge.
 *
 * The CodeBuddy CLI spawns this file as an MCP server (`--mcp-config` names the
 * command). It speaks MCP over stdin/stdout — the only transport the CLI can use
 * without opening a socket itself — and forwards every call to the bridge the
 * plugin runs on loopback HTTP.
 *
 * It holds no tool logic on purpose: the Host owns the registry, the schemas, and
 * the policy, and a shim that cached any of that could serve a stale answer after
 * a plugin was enabled or a session switched.
 *
 * @module dsh-connect-codebuddy-cli/mcp-shim
 */
import { BRIDGE_ENV } from './mcp.js'

const url = process.env[BRIDGE_ENV.url] ?? ''
const token = process.env[BRIDGE_ENV.token] ?? ''
const session = process.env[BRIDGE_ENV.session] ?? ''

/** Write one JSON-RPC message. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * Ask the bridge for its tool list.
 * @returns the MCP tool descriptors, or an empty list when unreachable.
 */
async function listTools() {
  if (url === '') return []
  try {
    const response = await fetch(`${url}/tools?session=${encodeURIComponent(session)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) return []
    const body = await response.json()
    return Array.isArray(body?.tools) ? body.tools : []
  } catch {
    return []
  }
}

/**
 * Run one tool through the bridge.
 * @param name - the tool name.
 * @param args - its arguments.
 * @returns the MCP result object.
 */
async function callTool(name, args) {
  if (url === '') return { content: [{ type: 'text', text: 'DSH 工具桥未启动。' }], isError: true }
  try {
    const response = await fetch(`${url}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session, name, arguments: args }),
    })
    const body = await response.json()
    if (body?.ok !== true) {
      return { content: [{ type: 'text', text: String(body?.error ?? '调用失败') }], isError: true }
    }
    return {
      content: [{ type: 'text', text: typeof body.text === 'string' ? body.text : '' }],
      ...(body.isError === true ? { isError: true } : {}),
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `调用 DSH 工具失败：${String(error?.message ?? error)}` }], isError: true }
  }
}

/**
 * Handle one decoded JSON-RPC message.
 * @param message - the parsed message.
 */
async function handle(message) {
  const id = message?.id
  const method = message?.method
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-tools', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: await listTools() } })
    return
  }
  if (method === 'tools/call') {
    const result = await callTool(message.params?.name, message.params?.arguments ?? {})
    send({ jsonrpc: '2.0', id, result })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim() === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    void handle(message)
  }
})