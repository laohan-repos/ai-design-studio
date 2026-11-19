import type { ModelConfig } from '../types'

export const modelPresets = {
  openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.6-flare' },
  constreet: { label: 'Constreet GPT-Image-2', baseUrl: 'https://api.constreet.cc/v1', model: 'gpt-image-2' }
} as const

export const openaiImageModels = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini']

export const apiRoot = (value: string) => value.trim().replace(/\/+$/, '').replace(/\/images\/(?:generations|edits)$/i, '').replace(/\/models$/i, '')

export const imageEndpoint = (value: string, taskType: ModelConfig['taskType']) => `${apiRoot(value)}/images/${taskType === 'text-to-image' ? 'generations' : 'edits'}`

export function normalizeModelConfig(model: ModelConfig): ModelConfig {
  const provider = model.provider === 'openai' || model.provider === 'constreet' ? model.provider : 'compatible'
  return {
    ...model,
    provider,
    baseUrl: imageEndpoint(provider === 'openai' ? modelPresets.openai.baseUrl : model.baseUrl, model.taskType),
    apiKey: model.apiKey.trim(),
    model: model.model.trim(),
    proxyEnabled: Boolean(model.proxyEnabled),
    proxyUrl: model.proxyUrl?.trim() || ''
  }
}

export function proxyRules(value: string): string {
  if (!value.trim()) throw new Error('请填写代理地址，例如 http://127.0.0.1:7890')
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw new Error('代理地址无效，请填写完整地址，例如 http://127.0.0.1:7890') }
  const defaultPorts: Record<string, string> = { 'http:': '80', 'https:': '443', 'socks5:': '1080' }
  if (!defaultPorts[url.protocol]) throw new Error('代理仅支持 HTTP、HTTPS 和 SOCKS5 协议')
  if (!url.hostname || url.port === '0' || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('代理地址只能包含协议、主机和端口，不应包含路径或查询参数')
  if (url.username || url.password) throw new Error('暂不支持带用户名和密码的代理，请使用无需认证的本机代理')
  return `${url.protocol}//${url.hostname}:${url.port || defaultPorts[url.protocol]}`
}

export function createModelConfig(taskType: ModelConfig['taskType']): ModelConfig {
  return normalizeModelConfig({
    id: crypto.randomUUID(),
    name: taskType === 'text-to-image' ? '文生图模型' : '图片编辑模型',
    provider: 'openai',
    taskType,
    baseUrl: modelPresets.openai.baseUrl,
    apiKey: '',
    model: modelPresets.openai.model
  })
}
