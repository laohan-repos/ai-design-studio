import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, extname } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { StudioDatabase } from './database'

type ModelConfig = {
  id: string; name: string; provider: 'constreet' | 'compatible'; baseUrl: string;
  apiKey: string; model: string; taskType: 'text-to-image' | 'image-to-image'
}

const onePerTask = (models: ModelConfig[]) => (['text-to-image', 'image-to-image'] as const).map(taskType => models.find(model => model.taskType === taskType)).filter((model): model is ModelConfig => Boolean(model))
const apiRoot = (value: string) => value.trim().replace(/\/$/, '').replace(/\/images\/(?:generations|edits)$/i, '').replace(/\/models$/i, '')
const imageEndpoint = (value: string, action: 'generations' | 'edits') => `${apiRoot(value)}/images/${action}`
const withFullEndpoint = (model: ModelConfig): ModelConfig => ({ ...model, baseUrl: imageEndpoint(model.baseUrl, model.taskType === 'text-to-image' ? 'generations' : 'edits') })

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 720,
    titleBarStyle: 'hiddenInset', backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description) => console.error('[renderer:load]', code, description))
  win.webContents.on('console-message', (_event, level, message, line, source) => console.log(`[renderer:${level}]`, message, `${source}:${line}`))
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadFile(join(__dirname, '../../out/renderer/index.html'))
}

app.whenReady().then(async () => {
  const database = await StudioDatabase.open(join(app.getPath('userData'), 'lumina-studio.db'))
  if (!database.listModels().length) {
    try {
      const legacy = JSON.parse(await readFile(join(app.getPath('userData'), 'models.json'), 'utf8')) as Array<ModelConfig & { supportsImage?: boolean }>
      if (legacy.length) await database.saveModels(legacy.slice(0, 1).map(model => ({ ...model, taskType: 'text-to-image' })))
    } catch { /* no legacy configuration */ }
  }
  const storedModels = database.listModels()
  const uniqueModels = onePerTask(storedModels).map(withFullEndpoint)
  if (uniqueModels.length !== storedModels.length || uniqueModels.some((model, index) => model.baseUrl !== storedModels[index]?.baseUrl)) await database.saveModels(uniqueModels)
  ipcMain.handle('models:list', () => database.listModels())
  ipcMain.handle('models:save', async (_e, models: ModelConfig[]) => {
    await database.saveModels(onePerTask(models).map(withFullEndpoint))
    return true
  })
  ipcMain.handle('model:test', async (_e, model: ModelConfig) => testModelConnection(model))
  ipcMain.handle('artworks:list', () => database.listArtworks())
  ipcMain.handle('artworks:save', async (_e, artworks) => { await database.saveArtworks(artworks); return true })
  ipcMain.handle('artworks:move', async (_e, id: string, x: number, y: number) => { await database.moveArtwork(id, x, y); return true })
  ipcMain.handle('image:generate', async (_e, payload) => generateImage(payload))
  ipcMain.handle('image:save', async (_e, dataUrl: string, suggestedName: string) => {
    const extension = extname(suggestedName) || '.png'
    const result = await dialog.showSaveDialog({ defaultPath: suggestedName, filters: [{ name: '图片', extensions: [extension.slice(1)] }] })
    if (result.canceled || !result.filePath) return null
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    await writeFile(result.filePath, Buffer.from(base64, 'base64'))
    return result.filePath
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

async function testModelConnection(config: ModelConfig) {
  if (!config.apiKey.trim()) return { ok: false, modelFound: false, message: '请先填写 API Key' }
  const startedAt = Date.now()
  try {
    const endpoint = `${apiRoot(config.baseUrl)}/models`
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15_000) })
    const raw = await response.text()
    if (!response.ok) {
      let message = raw
      try { message = JSON.parse(raw)?.error?.message || raw } catch { /* keep response text */ }
      return { ok: false, modelFound: false, message: response.status === 401 || response.status === 403 ? 'API Key 无效或没有访问权限' : `连接失败（HTTP ${response.status}）：${message.slice(0, 180)}` }
    }
    let models: Array<{ id?: string }> = []
    try { const json = JSON.parse(raw); models = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [] } catch { /* endpoint is reachable */ }
    const modelFound = models.some(item => item.id === config.model)
    return { ok: true, modelFound, latencyMs: Date.now() - startedAt, message: modelFound ? `连接成功，已找到 ${config.model}` : `连接成功，但模型列表中未找到 ${config.model}` }
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ok: false, modelFound: false, message: isTimeout ? '连接超时，请检查网络或 API 地址' : `无法连接：${error instanceof Error ? error.message : '未知错误'}` }
  }
}

async function generateImage(payload: { config: ModelConfig; prompt: string; size: string; count: number; quality: 'low' | 'medium' | 'high'; image?: string }) {
  const { config, prompt, size, count, quality, image } = payload
  const endpoint = imageEndpoint(config.baseUrl, image ? 'edits' : 'generations')
  let body: BodyInit
  let headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` }
  if (image) {
    const form = new FormData()
    form.append('model', config.model); form.append('prompt', prompt); form.append('size', size); form.append('quality', quality); form.append('n', String(count))
    const [meta, content] = image.split(',')
    const mime = meta.match(/data:(.*?);/)?.[1] || 'image/png'
    form.append('image[]', new Blob([Buffer.from(content, 'base64')], { type: mime }), 'reference.png')
    body = form
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ model: config.model, prompt, size, quality, n: count })
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(600_000) })
  const raw = await response.text()
  if (!response.ok) {
    let message = raw
    try { message = JSON.parse(raw)?.error?.message || raw } catch { /* keep raw */ }
    throw new Error(message || `请求失败（${response.status}）`)
  }
  const json = JSON.parse(raw)
  const items = json.data || json.images || []
  return Promise.all(items.map(async (item: any) => {
    const b64 = item.b64_json || item.base64
    if (b64) return `data:image/png;base64,${b64}`
    if (item.url) {
      const remote = await fetch(item.url)
      if (!remote.ok) throw new Error('生成成功，但下载图片失败')
      const mime = remote.headers.get('content-type') || 'image/png'
      return `data:${mime};base64,${Buffer.from(await remote.arrayBuffer()).toString('base64')}`
    }
    throw new Error('模型返回中没有可用图片')
  }))
}
