import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { join, extname } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { productName } from '../package.json'
import appIcon from '../src/assets/chutu-app-icon.png?asset'
import { StudioDatabase } from './database'
import { apiRoot, imageEndpoint, normalizeModelConfig, proxyRules } from '../src/lib/models'
import { fetchModel, ModelNetworkError, suggestLocalModelProxy } from './model-network'
import { prepareCanvasGeneration } from './canvas-generation'
import { LocalMcp } from './local-mcp'
import { createStudioMcpTools } from './mcp-tools'
import { PosterService } from './poster-service'
import { createPortraitRetouch } from './retouch-service'
import { describeEditorContext, PhotoEdits } from './photo-edits'
import { editorSelectionInput, type EditorSelection } from '../src/lib/photo-edits'
import { artworkGroupChangeInput, listArtworkGroupsInput, type ArtworkGroupChangeInput } from '../src/lib/canvas-groups'
import type { PosterOutput } from '../src/lib/poster'
import type { CanvasGeneration, GeneratePayload, McpWorkspaceChange, ModelConfig } from '../src/types'

const onePerTask = (models: ModelConfig[]) => (['text-to-image', 'image-to-image'] as const).map(taskType => models.find(model => model.taskType === taskType)).filter((model): model is ModelConfig => Boolean(model))

// Keep using the existing data directory after the user-facing product rename.
app.setName(productName)
app.setPath('userData', join(app.getPath('appData'), 'lumina-ai-design-studio'))
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()
const editorSelections = new WeakMap<Electron.WebContents, EditorSelection>()

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 320, minHeight: 460,
    title: productName, icon: appIcon, titleBarStyle: 'hiddenInset', backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.on('did-start-loading', () => { editorSelections.delete(win.webContents) })
  win.webContents.on('did-fail-load', (_event, code, description) => console.error('[renderer:load]', code, description))
  win.webContents.on('console-message', (_event, level, message, line, source) => console.log(`[renderer:${level}]`, message, `${source}:${line}`))
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadFile(join(__dirname, '../../out/renderer/index.html'))
}

if (isPrimaryInstance) void app.whenReady().then(async () => {
  app.dock?.setIcon(appIcon)
  const database = await StudioDatabase.open(join(app.getPath('userData'), 'lumina-studio.db'))
  if (!database.listModels().length) {
    try {
      const legacy = JSON.parse(await readFile(join(app.getPath('userData'), 'models.json'), 'utf8')) as Array<ModelConfig & { supportsImage?: boolean }>
      if (legacy.length) await database.saveModels(legacy.slice(0, 1).map(model => ({ ...model, taskType: 'text-to-image' })))
    } catch { /* no legacy configuration */ }
  }
  const storedModels = database.listModels()
  const uniqueModels = onePerTask(storedModels).map(normalizeModelConfig)
  if (uniqueModels.length !== storedModels.length || uniqueModels.some((model, index) => model.baseUrl !== storedModels[index]?.baseUrl)) await database.saveModels(uniqueModels)
  const prepareGeneration = (input: CanvasGeneration) => prepareCanvasGeneration(database, generateImage, input)
  const publish = (change: McpWorkspaceChange) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      try { window.webContents.send('mcp:workspace-changed', change) }
      catch { /* A window can close after the data has been saved. */ }
    }
  }
  const generateRegion = async (modelId: string, prompt: string, image: Buffer, mask: Buffer) => {
    const config = database.listModels().find(model => model.id === modelId && model.taskType === 'image-to-image')
    if (!config) throw new Error('请在模型配置中选择可用的图生图模型')
    const [result] = await generateImage({
      config, prompt, image: `data:image/png;base64,${image.toString('base64')}`, size: '1024x1024', quality: 'medium', count: 1
    }, mask)
    const match = result?.match(/^data:image\/[\w.+-]+;base64,(.+)$/)
    if (!match) throw new Error('模型没有返回可用的重绘图片')
    return Buffer.from(match[1], 'base64')
  }
  const posters = new PosterService(database, join(app.getPath('downloads'), 'AI设计助手'),
    poster => publish({ type: 'poster_updated', poster }), publish, generateRegion)
  const retouch = createPortraitRetouch(database, publish)
  const photoEdits = new PhotoEdits(database, publish)
  const editorContext = () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    return describeEditorContext(database, window && editorSelections.get(window.webContents))
  }
  const applyVersion = async (artworkId: string, versionId: string) => {
    const result = await database.applyArtworkVersion(artworkId, versionId)
    if (!result) throw new Error('找不到指定的图片版本')
    publish({ type: 'artwork_version_applied', result })
    publish({ type: 'editor_history_changed', history: database.getEditorHistory(artworkId), reason: 'edit' })
    return result.version
  }
  const changeArtworkGroups = async (input: ArtworkGroupChangeInput) => {
    const result = await database.changeArtworkGroups(input)
    publish({ type: 'canvas_groups_changed', result })
    return result
  }
  const mcp = new LocalMcp(join(app.getPath('userData'), 'mcp-settings.json'), createStudioMcpTools(
    database, prepareGeneration, publish, posters, { retouch, applyVersion }, { photoEdits, editorContext }, changeArtworkGroups))
  ipcMain.handle('portrait:retouch', (_e, input: unknown) => retouch(input))
  ipcMain.on('photo:editor-context', (event, input: unknown) => {
    const parsed = editorSelectionInput.safeParse(input)
    if (parsed.success) editorSelections.set(event.sender, parsed.data)
  })
  ipcMain.handle('photo:inspect', (_e, input: unknown) => photoEdits.inspect(input))
  ipcMain.handle('photo:inspect-colors', (_e, input: unknown) => photoEdits.inspectColors(input))
  ipcMain.handle('photo:suggest-crops', (_e, input: unknown) => photoEdits.suggestCrops(input))
  ipcMain.handle('photo:edit-recipe', (_e, input: unknown) => photoEdits.recipe(input))
  ipcMain.handle('photo:preview-mask', (_e, input: unknown) => photoEdits.previewMask(input))
  ipcMain.handle('photo:preview-edit', (_e, input: unknown) => photoEdits.preview(input))
  ipcMain.handle('photo:save-edit', (_e, draftId: string) => photoEdits.save(draftId))
  ipcMain.handle('editor-history:get', (_e, artworkId: string) => posters.getEditorHistory(artworkId))
  ipcMain.handle('editor-history:navigate', (_e, artworkId: string, revision: number, cursor: number) => posters.navigateEditorHistory(artworkId, revision, cursor))
  ipcMain.handle('poster:open', (_e, id: string, versionId?: string) => posters.open(id, versionId))
  ipcMain.handle('poster:edit', (_e, input: unknown) => posters.edit(input))
  ipcMain.handle('poster:undo', (_e, id: string, revision: number) => posters.undo(id, revision))
  ipcMain.handle('poster:preview', (_e, id: string, size?: PosterOutput['size'], transform?: unknown) => posters.preview(id, size, transform))
  ipcMain.handle('poster:layer-mask-preview', (_e, id: string, layerId: unknown, revision: number) => posters.previewLayerMask(id, layerId, revision))
  ipcMain.handle('poster:pixels-inspect', (_e, input: unknown) => posters.inspectLayerPixels(input))
  ipcMain.handle('poster:pixels-paint', (_e, input: unknown) => posters.paintLayerPixels(input))
  ipcMain.handle('poster:pixels-region-preview', (_e, input: unknown) => posters.previewLayerRegion(input))
  ipcMain.handle('poster:pixels-region-save', (_e, draftId: string) => posters.saveLayerRegion(draftId))
  ipcMain.handle('poster:source', async (_e, id: string) => {
    const source = await posters.previewSubjectSource(id)
    return `data:image/png;base64,${source.toString('base64')}`
  })
  ipcMain.handle('poster:export', (_e, id: string, options: PosterOutput) => posters.export(id, options))
  app.on('before-quit', () => { void mcp.close() })
  ipcMain.handle('mcp:status', () => mcp.getStatus())
  ipcMain.handle('mcp:set-enabled', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('无效的 MCP 服务状态')
    return mcp.setEnabled(enabled)
  })
  ipcMain.handle('mcp:copy-connection', async (_e, format: unknown) => {
    const { url, token } = await mcp.getConnection()
    if (format === 'token') clipboard.writeText(token)
    else if (format === 'codex') clipboard.writeText(`[mcp_servers.ai_design_studio]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`)
    else throw new Error('无效的连接配置格式')
  })
  ipcMain.handle('models:list', () => database.listModels())
  ipcMain.handle('models:save', async (_e, models: ModelConfig[]) => {
    const normalized = onePerTask(models).map(normalizeModelConfig)
    normalized.forEach(model => { if (model.provider === 'openai' && model.proxyEnabled) proxyRules(model.proxyUrl || '') })
    await database.saveModels(normalized)
    return true
  })
  ipcMain.handle('model:test', async (_e, model: ModelConfig) => testModelConnection(model))
  ipcMain.handle('canvases:list', () => database.listCanvases())
  ipcMain.handle('canvases:create', async (_e, id: string, name: string) => database.createCanvas(id, name))
  ipcMain.handle('canvases:rename', async (_e, id: string, name: string) => database.renameCanvas(id, name))
  ipcMain.handle('artworks:list', (_e, canvasId: string) => database.listArtworks(canvasId))
  ipcMain.handle('canvas-groups:list', (_e, canvasId: unknown) => database.listArtworkGroups(listArtworkGroupsInput.parse({ canvasId }).canvasId))
  ipcMain.handle('canvas-groups:change', (_e, input: unknown) => changeArtworkGroups(artworkGroupChangeInput.parse(input)))
  ipcMain.handle('artworks:save', async (_e, artworks) => { await database.saveArtworks(artworks); return true })
  ipcMain.handle('artworks:move', async (_e, id: string, x: number, y: number) => { await database.moveArtwork(id, x, y); return true })
  ipcMain.handle('artworks:delete', async (_e, id: string) => {
    const result = await database.deleteArtwork(id)
    publish({ type: 'artwork_deleted', ...result })
    return true
  })
  ipcMain.handle('artwork-versions:list', (_e, artworkId: string) => database.listArtworkVersions(artworkId))
  ipcMain.handle('artwork-versions:save', (_e, version) => database.saveArtworkVersion(version))
  ipcMain.handle('artwork-versions:apply', (_e, artworkId: string, versionId: string) => applyVersion(artworkId, versionId))
  ipcMain.handle('image:generate', async (_e, payload) => generateImage(payload))
  ipcMain.handle('canvas:generate-artwork', (_e, input: CanvasGeneration) => prepareGeneration(input)())
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
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) { void createWindow(); return }
    if (window.isMinimized()) window.restore()
    window.focus()
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

async function testModelConnection(config: ModelConfig) {
  config = normalizeModelConfig(config)
  if (!config.apiKey.trim()) return { ok: false, modelFound: false, message: '请先填写 API Key' }
  const startedAt = Date.now()
  try {
    const endpoint = `${apiRoot(config.baseUrl)}/models`
    const response = await fetchModel(config, endpoint, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15_000) })
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
    if (error instanceof ModelNetworkError) {
      const proxySuggestion = config.provider === 'openai' && !config.proxyEnabled ? suggestLocalModelProxy() : undefined
      return { ok: false, modelFound: false, message: error.message, proxySuggestion }
    }
    return { ok: false, modelFound: false, message: error instanceof Error ? error.message : '无法连接模型服务' }
  }
}

async function generateImage(payload: GeneratePayload, editMask?: Buffer) {
  const { prompt, size, count, quality, image } = payload
  const config = normalizeModelConfig(payload.config)
  if (!config.apiKey) throw new Error('请先在模型配置中填写 API Key')
  if (!config.model) throw new Error('请先在模型配置中填写模型 ID')
  const endpoint = imageEndpoint(config.baseUrl, image ? 'image-to-image' : 'text-to-image')
  let body: BodyInit
  let headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` }
  if (image) {
    const form = new FormData()
    form.append('model', config.model); form.append('prompt', prompt); form.append('size', size); form.append('quality', quality); form.append('n', String(count))
    const match = image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
    if (!match) throw new Error('参考图片格式无效，请重新上传图片')
    const [, mime, content] = match
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
    if (config.provider === 'openai' && !extensions[mime]) throw new Error('OpenAI 图片编辑支持 PNG、JPEG 和 WebP 参考图片，请转换格式后重试')
    form.append('image[]', new Blob([Buffer.from(content, 'base64')], { type: mime }), `reference.${extensions[mime] || 'png'}`)
    if (editMask) form.append('mask', new Blob([Uint8Array.from(editMask)], { type: 'image/png' }), 'selection.png')
    body = form
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ model: config.model, prompt, size, quality, n: count })
  }
  const response = await fetchModel(config, endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(600_000) })
  const raw = await response.text()
  if (!response.ok) {
    let message = raw
    try { message = JSON.parse(raw)?.error?.message || raw } catch { /* keep raw */ }
    throw new Error(message || `请求失败（${response.status}）`)
  }
  const json = JSON.parse(raw)
  const items = json.data || json.images || []
  if (!Array.isArray(items) || !items.length) throw new Error('模型没有返回可用图片，请检查模型 ID 和服务配置')
  return Promise.all(items.map(async (item: any) => {
    const b64 = item.b64_json || item.base64
    if (b64) return `data:image/png;base64,${b64}`
    if (item.url) {
      const remote = await fetchModel(config, item.url, { signal: AbortSignal.timeout(600_000) })
      if (!remote.ok) throw new Error('生成成功，但下载图片失败')
      const mime = remote.headers.get('content-type') || 'image/png'
      return `data:${mime};base64,${Buffer.from(await remote.arrayBuffer()).toString('base64')}`
    }
    throw new Error('模型返回中没有可用图片')
  }))
}
