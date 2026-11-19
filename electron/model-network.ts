import { session, type Session } from 'electron'
import { createHash } from 'node:crypto'
import { proxyRules } from '../src/lib/models'
import type { ModelConfig } from '../src/types'

const proxySessions = new Map<string, Promise<Session>>()
const networkReasons: Array<[RegExp, string]> = [
  [/ETIMEDOUT|CONNECT_TIMEOUT|ERR_\w*TIMED_OUT/, '超时'],
  [/ECONNRESET|EPIPE|ERR_CONNECTION_(RESET|CLOSED)/, '时连接被重置'],
  [/ECONNREFUSED|ERR_(PROXY_)?CONNECTION_REFUSED|ERR_PROXY_CONNECTION_FAILED/, '被拒绝'],
  [/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/, '时无法解析域名'],
  [/\b(?:CERT_\w+|ERR_CERT_\w+|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/, '时 TLS 证书校验失败']
]

export function suggestLocalModelProxy(): string | undefined {
  const candidates = [process.env.https_proxy, process.env.HTTPS_PROXY, process.env.all_proxy, process.env.ALL_PROXY, process.env.http_proxy, process.env.HTTP_PROXY]
  for (const value of candidates) {
    if (!value) continue
    try {
      const { hostname } = new URL(value.trim())
      if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') return proxyRules(value)
    } catch { /* Ignore unsupported proxy URLs. */ }
  }
}

export function modelNetworkMessage(error: unknown, config: ModelConfig): string {
  const isOpenAI = config.provider === 'openai'
  const usesProxy = isOpenAI && config.proxyEnabled
  const group = usesProxy ? '代理连接' : isOpenAI ? '直连 OpenAI' : '模型服务连接'
  const message = error instanceof Error ? error.message : ''
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined
  const details = `${cause?.code ?? ''} ${message}`
  const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
  const reason = timedOut ? '超时' : networkReasons.find(([pattern]) => pattern.test(details))?.[1] ?? '失败'
  const hint = usesProxy ? '请确认代理软件已启动，协议和端口正确。' : isOpenAI ? '如果本机需要通过代理访问 OpenAI，请开启「使用代理」。' : '请检查 API 地址和网络。'
  return `${group}${reason}。${hint}`
}

export class ModelNetworkError extends Error {}

export async function fetchModel(config: ModelConfig, url: string, init?: RequestInit): Promise<Response> {
  if (config.provider !== 'openai' || !config.proxyEnabled) {
    try { return await fetch(url, init) }
    catch (error) { throw new ModelNetworkError(modelNetworkMessage(error, config), { cause: error }) }
  }
  const rules = proxyRules(config.proxyUrl || '')
  let pending = proxySessions.get(rules)
  if (!pending) {
    pending = (async () => {
      // Separate sessions keep concurrent model requests from changing each other's proxy.
      const partition = `openai-proxy-${createHash('sha256').update(rules).digest('hex')}`
      const network = session.fromPartition(partition, { cache: false })
      await network.setProxy({ mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<-loopback>' })
      return network
    })()
    proxySessions.set(rules, pending)
    pending.catch(() => proxySessions.delete(rules))
  }
  try {
    const network = await pending
    return await network.fetch(url, init)
  } catch (error) {
    throw new ModelNetworkError(modelNetworkMessage(error, config), { cause: error })
  }
}
