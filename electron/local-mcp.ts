import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpStatus } from '../src/types'

const host = '127.0.0.1'
const route = '/mcp'
type Settings = { enabled: boolean; token: string }

function fail(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    jsonrpc: '2.0', error: { code: -32000, message }, id: null
  }))
}

export class LocalMcp {
  private server?: Server
  private settings?: Settings
  private error?: string
  private operation: Promise<unknown>
  readonly url: string

  constructor(private filePath: string, private createTools: () => McpServer, private port = 38473) {
    this.url = `http://${host}:${port}${route}`
    this.operation = this.restore().catch(error => { this.error = this.describe(error) })
  }

  async getStatus(): Promise<McpStatus> {
    await this.operation.catch(() => undefined)
    return this.status()
  }

  setEnabled(enabled: boolean): Promise<McpStatus> {
    const update = this.operation.catch(() => undefined).then(async () => {
      try {
        if (enabled === Boolean(this.server) && !this.error) return this.status()
        const settings = { enabled, token: this.settings?.token ?? randomBytes(32).toString('base64url') }
        if (enabled) await this.start(settings.token)
        try { await this.save(settings) }
        catch (error) {
          if (enabled) await this.close()
          throw error
        }
        if (!enabled) await this.close()
        this.error = undefined
      } catch (error) { this.error = this.describe(error) }
      return this.status()
    })
    this.operation = update
    return update
  }

  async getConnection(): Promise<{ url: string; token: string }> {
    await this.operation.catch(() => undefined)
    if (!this.server || !this.settings) throw new Error('请先启动 MCP 服务')
    return { url: this.url, token: this.settings.token }
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private status(): McpStatus { return { running: Boolean(this.server), url: this.url, error: this.error } }

  private describe(error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EADDRINUSE') return `端口 ${this.port} 已被占用，请关闭占用程序后重试。`
    if (code === 'EPERM' || code === 'EACCES') return '当前环境限制了 MCP 服务启动，请检查应用的本机权限。'
    return 'MCP 服务配置或启动失败，请重试。'
  }

  private async restore() {
    let raw: string
    try { raw = await readFile(this.filePath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const settings = JSON.parse(raw) as Settings
    if (typeof settings.enabled !== 'boolean' || !/^[\w-]{43}$/.test(settings.token)) throw new Error('Invalid MCP settings')
    this.settings = settings
    if (settings.enabled) await this.start(settings.token)
  }

  private async save(settings: Settings) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
      this.settings = settings
    } finally { await rm(temporary, { force: true }) }
  }

  private async start(token: string) {
    if (this.server) return
    const authorization = Buffer.from(`Bearer ${token}`)
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
      void this.handle(request, response, authorization).catch(() => {
        if (!response.headersSent) fail(response, 500, 'Internal MCP error')
        else response.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, host, () => { server.off('error', reject); resolve() })
    })
    this.server = server
  }

  private async handle(request: IncomingMessage, response: ServerResponse, expected: Buffer) {
    const authority = `${host}:${this.port}`
    if (request.headers.host !== authority || (request.headers.origin && request.headers.origin !== `http://${authority}`)) {
      return fail(response, 403, 'Host or Origin is not allowed')
    }
    if (request.url !== route) return fail(response, 404, 'MCP endpoint not found')
    const actual = Buffer.from(request.headers.authorization ?? '')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      return fail(response, 401, 'MCP access token required')
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      return fail(response, 405, 'Use POST for this MCP endpoint')
    }

    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > 512 * 1024) {
        response.setHeader('Connection', 'close')
        return fail(response, 413, 'MCP request is too large')
      }
      chunks.push(chunk)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return fail(response, 400, 'Invalid JSON request') }

    const tools = this.createTools()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { void tools.close().catch(() => undefined) })
    await tools.connect(transport)
    await transport.handleRequest(request, response, body)
  }
}
