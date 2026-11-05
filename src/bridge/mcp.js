/**
 * Expose DSH tools to the CodeBuddy CLI over MCP.
 *
 * The CLI runs its own agent loop and its own tools; it will never call into the
 * Host by itself. What it *does* support is MCP (`--mcp-config`, transports
 * stdio/sse/http, and an inline config per invocation), so the bridge is a
 * normal MCP server from the CLI's point of view and a thin dispatcher on this
 * side: the shim translates MCP/stdio, this module answers over loopback HTTP,
 * and `tools.execute` runs the real tool through the Host's own policy pipeline.
 *
 * Why HTTP on loopback rather than DSH's web server: the CLI must be able to
 * reach it as a plain process on the same machine, with no browser session and
 * no cookie, and it must not depend on the GUI port being open. The listener
 * binds 127.0.0.1 on an ephemeral port and every request needs a per-process
 * bearer token, so nothing else on the machine can drive Host tools through it.
 *
 * @module dsh-connect-codebuddy-cli/mcp-bridge
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

/** Env names the shim reads; the CLI passes them straight to the child. */
export const BRIDGE_ENV = {
  url: 'DSH_MCP_BRIDGE_URL',
  token: 'DSH_MCP_BRIDGE_TOKEN',
  session: 'DSH_MCP_BRIDGE_SESSION',
}

/**
 * Reduce a DSH parameter schema to what MCP accepts.
 *
 * MCP validates `inputSchema` as JSON Schema and rejects some constructs the
 * Host allows (notably a `$schema` declaration at the root). The shape the Host
 * produces is already `{type, properties, required}`, so a whitelist copy covers
 * every tool currently registered without inventing a translation for keywords
 * that do not appear.
 * @param parameters - the Host tool's `parameters`.
 * @returns an MCP-compatible input schema.
 */
export function toMcpInputSchema(parameters) {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { type: 'object', properties: {} }
  }
  const out = { type: 'object', properties: {} }
  if (typeof parameters.type === 'string') out.type = parameters.type
  if (parameters.properties !== null && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties)) {
    out.properties = parameters.properties
  }
  if (Array.isArray(parameters.required)) out.required = parameters.required.filter(name => typeof name === 'string')
  if (typeof parameters.additionalProperties === 'boolean') out.additionalProperties = parameters.additionalProperties
  if (typeof parameters.description === 'string' && parameters.description !== '') out.description = parameters.description
  return out
}

/**
 * Start the loopback bridge.
 *
 * @param options - `{ resolveTools(sessionId), executeTool(request), logger }`.
 * @returns the bridge handle.
 */
export function createToolBridge(options) {
  const token = randomBytes(24).toString('hex')
  let server
  let port = 0
  let closed = false

  /**
   * Answer one authorised request with JSON.
   * @param request - the node request.
   * @param response - the node response.
   * @param authorized - whether the bearer token matched.
   * @param body - the value to serialize.
   * @param status - the HTTP status.
   */
  const reply = (response, authorized, body, status = 200) => {
    const payload = JSON.stringify(authorized === true ? body : { ok: false, error: 'unauthorized' })
    response.writeHead(authorized === true ? status : 401, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }

  /** @returns whether the request carries this bridge's token. */
  const authorized = (request) => {
    const header = request.headers.authorization
    return typeof header === 'string' && header === `Bearer ${token}`
  }

  /** Read a JSON request body with a small cap. */
  const readBody = (request) => new Promise((resolve) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) request.destroy()
    })
    request.on('end', () => {
      try { resolve(JSON.parse(raw === '' ? '{}' : raw)) } catch { resolve(undefined) }
    })
    request.on('error', () => resolve(undefined))
  })

  const instance = {
    /** The port the listener bound, once ready. */
    get port() {
      return port
    },

    /**
     * Register the `--mcp-config` value that points the CLI at this bridge.
     * @param sessionId - the DSH session the tools belong to.
     * @param shimPath - absolute path of the stdio shim.
     * @returns the inline JSON configuration, or `''` when the bridge is not up.
     */
    configFor(sessionId, shimPath) {
      if (port === 0) return ''
      return JSON.stringify({
        mcpServers: {
          dsh: {
            command: process.execPath,
            args: [shimPath],
            env: {
              [BRIDGE_ENV.url]: `http://127.0.0.1:${port}`,
              [BRIDGE_ENV.token]: token,
              [BRIDGE_ENV.session]: sessionId,
              // The CLI spawns the shim; on desktop `process.execPath` is the
              // Electron binary, which only behaves as node with this set.
              ELECTRON_RUN_AS_NODE: '1',
            },
          },
        },
      })
    },

    /** @returns whether the listener is up. */
    get ready() {
      return port !== 0
    },

    /** Start listening on loopback; resolves once the port is known. */
    start() {
      return new Promise((resolve) => {
        if (closed || server !== undefined) return resolve(instance)
        server = createServer(async (request, response) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const ok = authorized(request)
          if (url.pathname === '/tools') {
            if (request.method !== 'GET') return reply(response, ok, { ok: false, error: 'method not allowed' }, 405)
            if (!ok) return reply(response, false, {})
            const sessionId = url.searchParams.get('session') ?? ''
            try {
              const tools = await options.resolveTools(sessionId)
              reply(response, true, { tools })
            } catch (error) {
              options.logger?.warn?.(`dsh-connect-codebuddy-cli: MCP tool list failed: ${messageOf(error)}`)
              reply(response, true, { tools: [] })
            }
            return
          }
          if (url.pathname === '/call') {
            if (request.method !== 'POST') return reply(response, ok, { ok: false, error: 'method not allowed' }, 405)
            if (!ok) return reply(response, false, {})
            const body = await readBody(request)
            if (body === undefined || typeof body?.name !== 'string' || body.name === '') {
              return reply(response, true, { ok: false, error: 'bad request' }, 400)
            }
            // A dropped client must cancel the tool, not leave it running.
            const controller = new AbortController();
            request.on('close', () => controller.abort());
            try {
              const result = await options.executeTool({
                sessionId: typeof body.session === 'string' ? body.session : '',
                name: body.name,
                arguments: body.arguments ?? {},
                signal: controller.signal,
              })
              reply(response, true, result)
            } catch (error) {
              const detail = messageOf(error)
              options.logger?.warn?.(`dsh-connect-codebuddy-cli: MCP tool call failed: ${detail}`)
              reply(response, true, { ok: false, error: detail })
            }
            return
          }
          reply(response, ok, { ok: false, error: 'not found' }, 404)
        })
        server.on('error', (error) => {
          options.logger?.warn?.(`dsh-connect-codebuddy-cli: MCP bridge failed to listen: ${messageOf(error)}`)
          resolve(undefined)
        })
        server.listen(0, '127.0.0.1', () => {
          const address = server?.address()
          port = typeof address === 'object' && address !== null ? address.port : 0
          resolve(instance)
        })
      })
    },

    /** Stop the listener. */
    async close() {
      closed = true
      port = 0
      if (server === undefined) return
      const dying = server
      server = undefined
      await new Promise(resolve => dying.close(() => resolve(undefined)))
    },
  }
  return instance
}

/**
 * Describe an error without leaking its stack.
 * @param error - the thrown value.
 * @returns the message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}