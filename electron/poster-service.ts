import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'
import type { EditorHistory, EditorPosterHistoryEdit } from '../src/lib/editor-history'
import { posterEdit, posterId, posterMaskPreviewInput, posterOutput, posterSizes, posterTransformPreview, resizePoster, shiftPosterCanvas } from '../src/lib/poster'
import type { PosterContent, PosterDocument, PosterImage, PosterImageLayer, PosterLayerMask, PosterLayerMaskPreview, PosterMaskLayerId, PosterOperation, PosterOutput, PosterTransformPreview } from '../src/lib/poster'
import { maxPosterImageLayers, maxPosterTextLayers, posterMaskStrokeLimit, posterMaxPixels, posterPixelTileSize } from '../src/lib/poster-limits'
import {
  posterPixelInput, posterPixelPaintInput, posterRegionInput,
  type PosterPixelInput, type PosterPixelLayer, type PosterPixelRect, type PosterPixelTileWrite, type PosterPixelView, type PosterRegionPreview
} from '../src/lib/poster-pixels'
import type { McpWorkspaceChange } from '../src/types'
import type { StoredPoster, StudioDatabase } from './database'
import { prepareSubject, renderLayerMaskPreview, renderPoster, sourceThumbnail } from './poster-render'
import { composePixelTiles, editPosterPixelRegion, paintPosterPixels } from './poster-pixel-render'

const initialContent: PosterContent = {
  ...posterSizes.square,
  background: { type: 'transparent' },
  subject: { x: 140, y: 240, width: 800, height: 720, opacity: 1, rotation: 0, brightness: 100, saturation: 100, visible: true },
  mask: { type: 'none' },
  shadow: { opacity: 0.24, color: '#202033', visible: false },
  textLayers: [],
  imageLayers: [],
  layerOrder: ['subject']
}

function describe({ artworkId, sourceVersionId, revision, content }: StoredPoster, history: EditorHistory): PosterDocument {
  return { artworkId, sourceVersionId, revision, ...content, canUndo: history.cursor > 0 }
}

type LayerSettings = ImageSettings & { stretch?: boolean }

function layerEditLabel(settings: LayerSettings, previous: LayerSettings | undefined, fallback: string) {
  if (settings.rotation !== undefined && settings.rotation !== (previous?.rotation ?? 0)) return '旋转图层'
  const changed = (key: keyof ImageSettings) => settings[key] !== undefined && settings[key] !== previous?.[key]
  const width = changed('width')
  const height = changed('height')
  if ((settings.stretch !== undefined && settings.stretch !== Boolean(previous?.stretch)) ||
    (settings.stretch && (width || height)) || (previous && width !== height)) return '拉伸图层'
  if (width || height || changed('x') || changed('y')) return '移动或缩放图层'
  if (changed('opacity')) return '调整不透明度'
  if (changed('visible')) return settings.visible ? '显示图层' : '隐藏图层'
  return fallback
}

function describePosterOperation(operation: PosterOperation, content: PosterContent): EditorPosterHistoryEdit {
  switch (operation.op) {
    case 'set_mask':
      return { kind: 'mask', label: { none: '移除蒙版', edge_color: '去纯色背景', polygon: '主体描边蒙版' }[operation.mask.type] }
    case 'set_layer_mask':
      return { kind: 'mask', label: !operation.base ? '移除蒙版' : operation.base.type === 'selection' ? '选区转蒙版' : '添加蒙版' }
    case 'paint_layer_mask':
      return { kind: 'mask', label: operation.stroke.mode === 'hide' ? '画笔隐藏' : '画笔恢复' }
    case 'set_subject':
      return { kind: 'layers', label: layerEditLabel(operation.subject, content.subject, '调整主体属性') }
    case 'set_image':
      return { kind: 'layers', label: layerEditLabel(operation.layer, content.imageLayers.find(layer => layer.id === operation.layerId), '编辑图片图层') }
    default:
      return { kind: 'layers', label: {
        set_size: '调整图像尺寸', set_canvas_size: '调整画布尺寸', set_background: '更换背景', set_shadow: '调整接触阴影',
        upsert_text: '编辑文字图层', remove_text: '移除文字图层', add_image: '添加图片图层',
        remove_image: '移除图片图层', reorder_layers: '调整图层顺序'
      }[operation.op] }
  }
}

function describePosterEdit(operations: PosterOperation[], content: PosterContent): EditorPosterHistoryEdit {
  const changes = operations.map(operation => describePosterOperation(operation, content))
  const first = changes[0]
  if (changes.length === 1) return first
  const kind = changes.every(change => change.kind === 'mask') ? 'mask' : 'layers'
  const label = changes.every(change => change.label === first.label) ? first.label : kind === 'mask' ? '批量编辑蒙版' : '批量编辑海报'
  return { kind, label: `${label}（${changes.length} 项）` }
}

const revealedMask: PosterLayerMask = { base: { type: 'reveal' }, strokes: [] }
const pngDataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
const regionDraftLifetime = 5 * 60_000
const maxRegionDrafts = 8

type PixelPatch = { layer: PosterPixelLayer; writes: PosterPixelTileWrite[] }
type RegionDraft = {
  target: PosterPixelInput
  patch: PixelPatch
  label: string
  expiresAt: number
  saving?: Promise<PosterDocument>
  saved?: PosterDocument
}

function storedPixelTiles(layer: PosterPixelLayer | undefined, bytes: Map<string, Buffer>) {
  return Object.entries(layer?.tiles ?? {}).map(([position, id]) => {
    const [x, y] = position.split(',').map(Number)
    const image = bytes.get(id)
    if (!image) throw new Error('图层的部分像素数据已丢失')
    return { x, y, bytes: image }
  })
}

async function composeStoredPixels(source: Buffer | Image, layer: PosterPixelLayer | undefined, bytes: Map<string, Buffer>) {
  const canvas = await composePixelTiles(source, storedPixelTiles(layer, bytes))
  if (layer && (canvas.width !== layer.width || canvas.height !== layer.height)) throw new Error('图层像素尺寸与底图不匹配')
  return canvas
}

function sampleTile(canvas: Canvas, image: Image | Canvas, rect: PosterPixelRect) {
  if (canvas.width !== rect.width) canvas.width = rect.width
  if (canvas.height !== rect.height) canvas.height = rect.height
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, rect.width, rect.height)
  context.drawImage(image, -rect.x, -rect.y)
  const { data } = context.getImageData(0, 0, rect.width, rect.height)
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

async function pixelPatch(canvas: Canvas, original: Image, rect: PosterPixelRect, previous?: PosterPixelLayer): Promise<PixelPatch> {
  const { width, height } = canvas
  const tiles = { ...previous?.tiles }
  const writes = new Map<string, PosterPixelTileWrite>()
  const size = posterPixelTileSize
  const tile = createCanvas(size, size), baseTile = createCanvas(size, size)
  const right = Math.min(width, rect.x + rect.width), bottom = Math.min(height, rect.y + rect.height)
  for (let y = Math.max(0, Math.floor(rect.y / size) * size); y < bottom; y += size) {
    for (let x = Math.max(0, Math.floor(rect.x / size) * size); x < right; x += size) {
      const frame = { x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) }
      const position = `${x},${y}`
      if (sampleTile(tile, canvas, frame).equals(sampleTile(baseTile, original, frame))) {
        delete tiles[position]
        continue
      }
      const bytes = await tile.encode('png')
      const id = createHash('sha256').update(bytes).digest('hex')
      if (tiles[position] === id) continue
      tiles[position] = id
      writes.set(id, { id, bytes })
    }
  }
  return { layer: { width, height, tiles }, writes: [...writes.values()] }
}

function existingLayerMask(content: PosterContent, id: PosterMaskLayerId): PosterLayerMask | undefined {
  return content.layerMasks?.[id] ?? (id === 'subject' && content.mask.type !== 'none'
    ? { base: { type: 'legacy', mask: content.mask }, strokes: [] }
    : undefined)
}

function clearLayerMask(content: PosterContent, id: PosterMaskLayerId) {
  if (content.layerMasks) delete content.layerMasks[id]
}

function clearLayerPixels(content: PosterContent, id: PosterMaskLayerId) {
  if (content.pixelLayers) delete content.pixelLayers[id]
}

type ImageSettings = Extract<PosterOperation, { op: 'set_image' }>['layer']

function setImageLayer(layers: PosterImageLayer[], id: string, settings: ImageSettings) {
  const index = layers.findIndex(layer => layer.id === id)
  if (index < 0) throw new Error('找不到图片图层')
  const updated = [...layers]
  const changes = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
  updated[index] = { ...layers[index], ...changes }
  return updated
}

export class PosterService {
  private preparedSubject?: { key: string; result: ReturnType<typeof prepareSubject> }
  private regionDrafts = new Map<string, RegionDraft>()

  constructor(
    private database: StudioDatabase,
    private exportDirectory: string,
    private onChange: (poster: PosterDocument) => void,
    private publish?: (change: McpWorkspaceChange) => void,
    private generateRegion?: (modelId: string, prompt: string, image: Buffer, mask: Buffer) => Promise<Buffer>
  ) {}

  private requirePoster(artworkId: string, revision?: number) {
    const poster = this.database.getPoster(posterId.parse(artworkId))
    if (!poster) throw new Error('这张图还没有海报，请先创建或打开海报')
    if (revision !== undefined && revision !== poster.revision) throw new Error('海报已更新，请读取最新版本后再编辑')
    return poster
  }

  private source(artworkId: string, versionId?: string) {
    const source = this.database.getArtworkSource(artworkId, versionId)
    if (!source) throw new Error('找不到指定的图片或版本')
    return source
  }

  private async addImageLayer(content: PosterContent, { layerId, artworkId, versionId }: Extract<PosterOperation, { op: 'add_image' }>) {
    if (content.imageLayers.length >= maxPosterImageLayers) throw new Error(`每张海报最多支持 ${maxPosterImageLayers} 个新增图片图层`)
    if (content.imageLayers.some(layer => layer.id === layerId)) throw new Error('图片图层 ID 已存在')
    const source = this.source(artworkId, versionId)
    const image = await loadImage(source.bytes).catch(() => { throw new Error('无法读取图片，请使用 PNG、JPEG 或 WebP') })
    if (!image.width || !image.height) throw new Error('图片尺寸无效')
    const scale = Math.min(1, content.width * 0.45 / image.width, content.height * 0.45 / image.height)
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    content.imageLayers.push({
      id: layerId, artworkId, versionId: source.versionId,
      name: source.prompt.trim().slice(0, 80) || '图片',
      x: Math.round((content.width - width) / 2), y: Math.round((content.height - height) / 2),
      width, height, opacity: 1, visible: true
    })
    content.layerOrder.push(`image:${layerId}`)
  }

  private async getPreparedSubject(artworkId: string, versionId: string, mask: PosterContent['mask'], replacement?: PosterLayerMask,
    pixels?: PosterPixelLayer, tileBytes?: Map<string, Buffer>) {
    const key = JSON.stringify([artworkId, versionId, mask, replacement, pixels])
    if (this.preparedSubject?.key === key) return this.preparedSubject.result
    const bytes = this.source(artworkId, versionId).bytes
    const result = (async () => {
      const edited = pixels && tileBytes && await composeStoredPixels(bytes, pixels, tileBytes)
      return prepareSubject(bytes, mask, replacement, edited)
    })()
    const prepared = { key, result }
    this.preparedSubject = prepared
    void prepared.result.catch(() => { if (this.preparedSubject === prepared) this.preparedSubject = undefined })
    return prepared.result
  }

  private layerReference(poster: StoredPoster, content: PosterContent, id: PosterMaskLayerId) {
    if (id === 'subject') return { artworkId: poster.artworkId, versionId: poster.sourceVersionId }
    if (id === 'background') {
      if (content.background.type !== 'image') throw new Error('只有图片背景支持此操作')
      return content.background
    }
    const layer = content.imageLayers.find(item => `image:${item.id}` === id)
    if (!layer) throw new Error('找不到图片图层')
    return layer
  }

  private async pixelSnapshot(input: PosterPixelInput) {
    const poster = this.requirePoster(input.artworkId, input.revision)
    const reference = this.layerReference(poster, poster.content, input.layerId)
    const source = this.source(reference.artworkId, reference.versionId).bytes
    const layer = poster.content.pixelLayers?.[input.layerId]
    const tiles = this.database.getPosterPixelTiles(input.artworkId, Object.values(layer?.tiles ?? {}))
    const original = await loadImage(source)
    const canvas = await composeStoredPixels(original, layer, tiles)
    return { poster, original, canvas, layer }
  }

  private async pixelView(canvas: Canvas, revision: number): Promise<PosterPixelView> {
    return { src: pngDataUrl(await sourceThumbnail(canvas, 1000)), width: canvas.width, height: canvas.height, revision }
  }

  async inspectLayerPixels(input: unknown): Promise<PosterPixelView> {
    const target = posterPixelInput.parse(input)
    const { canvas } = await this.pixelSnapshot(target)
    return this.pixelView(canvas, target.revision)
  }

  async paintLayerPixels(input: unknown): Promise<PosterDocument> {
    const { stroke, ...target } = posterPixelPaintInput.parse(input)
    const { poster, original, canvas, layer } = await this.pixelSnapshot(target)
    const rect = paintPosterPixels(canvas, stroke)
    const patch = await pixelPatch(canvas, original, rect, layer)
    return this.commitPixelPatch(poster, target.layerId, patch, { brush: '画笔', eraser: '橡皮擦', clone: '仿制图章' }[stroke.type])
  }

  async previewLayerRegion(input: unknown): Promise<PosterRegionPreview> {
    const target = posterRegionInput.parse(input)
    const region = target.mode === 'remove'
      ? { mode: 'remove', selection: target.selection } as const
      : { mode: 'redraw', selection: target.selection,
          generate: (image: Buffer, mask: Buffer) => {
            if (!this.generateRegion) throw new Error('尚未配置局部重绘模型')
            return this.generateRegion(target.modelId, target.prompt, image, mask)
          } } as const
    const { original, canvas, layer } = await this.pixelSnapshot(target)
    const rect = await editPosterPixelRegion(canvas, region)
    const patch = await pixelPatch(canvas, original, rect, layer)
    const view = await this.pixelView(canvas, target.revision)
    const { artworkId, layerId, revision } = target
    this.requirePoster(artworkId, revision)
    const now = Date.now()
    for (const [id, draft] of this.regionDrafts) {
      if (!draft.saving && (draft.expiresAt <= now || this.regionDrafts.size >= maxRegionDrafts)) this.regionDrafts.delete(id)
    }
    if (this.regionDrafts.size >= maxRegionDrafts) throw new Error('正在保存其他局部编辑，请稍候重试')
    const draftId = randomUUID()
    this.regionDrafts.set(draftId, {
      target: { artworkId, layerId, revision }, patch,
      expiresAt: now + regionDraftLifetime, label: target.mode === 'remove' ? '移除物体' : '局部重绘'
    })
    return { ...view, draftId }
  }

  async saveLayerRegion(draftId: unknown): Promise<PosterDocument> {
    const draft = this.regionDrafts.get(posterId.parse(draftId))
    if (!draft || (!draft.saving && draft.expiresAt <= Date.now())) throw new Error('局部编辑预览已过期，请重新预览')
    if (draft.saved) return draft.saved
    if (draft.saving) return draft.saving
    const poster = this.requirePoster(draft.target.artworkId, draft.target.revision)
    draft.saving = this.commitPixelPatch(poster, draft.target.layerId, draft.patch, draft.label)
    try {
      draft.saved = await draft.saving
      draft.patch.writes.length = 0
      return draft.saved
    } finally { draft.saving = undefined }
  }

  private commitPixelPatch(poster: StoredPoster, layerId: PosterMaskLayerId, patch: PixelPatch, label: string) {
    const pixelLayers = { ...poster.content.pixelLayers }
    if (Object.keys(patch.layer.tiles).length) pixelLayers[layerId] = patch.layer
    else delete pixelLayers[layerId]
    const content = { ...poster.content, pixelLayers }
    return this.commit({ ...poster, content }, { kind: 'layers', label }, patch.writes)
  }

  async open(artworkId: string, versionId?: string): Promise<PosterDocument> {
    posterId.parse(artworkId)
    if (versionId !== undefined) posterId.parse(versionId)
    const existing = this.database.getPoster(artworkId)
    if (existing) return describe(existing, this.getEditorHistory(artworkId))
    const source = this.source(artworkId, versionId)
    const poster = { artworkId, sourceVersionId: source.versionId, revision: 1, content: initialContent, history: [] }
    await this.database.savePoster(poster, 0)
    return describe(poster, this.getEditorHistory(artworkId))
  }

  get(artworkId: string) { return describe(this.requirePoster(artworkId), this.getEditorHistory(artworkId)) }

  getEditorHistory(artworkId: string) {
    return this.database.getEditorHistory(posterId.parse(artworkId))
  }

  async navigateEditorHistory(artworkId: string, revision: number, cursor: number) {
    const { history, poster, applied } = await this.database.navigateEditorHistory(posterId.parse(artworkId), revision, cursor)
    if (applied) this.publish?.({ type: 'artwork_version_applied', viaHistory: true, result: applied })
    if (poster) this.onChange(describe(poster, history))
    this.publish?.({ type: 'editor_history_changed', history, reason: 'navigate' })
    return history
  }

  async edit(input: unknown) {
    const { artworkId, revision, operations } = posterEdit.parse(input)
    const poster = this.requirePoster(artworkId, revision)
    let content = structuredClone(poster.content)
    let validateMask = false
    for (const operation of operations) {
      switch (operation.op) {
        case 'set_size':
        case 'set_canvas_size':
          if (operation.width * operation.height > posterMaxPixels) throw new Error('海报不能超过 840 万像素')
          content = operation.op === 'set_size'
            ? resizePoster(content, operation.width, operation.height)
            : shiftPosterCanvas(content, operation.width, operation.height, operation.anchor)
          break
        case 'set_background': {
          const background = operation.background
          const previous = content.background
          content.background = background.type === 'image'
            ? { ...background, versionId: this.source(background.artworkId, background.versionId).versionId }
            : background
          if (content.background.type !== 'image' || previous.type !== 'image' ||
            content.background.artworkId !== previous.artworkId || content.background.versionId !== previous.versionId) {
            clearLayerMask(content, 'background')
            clearLayerPixels(content, 'background')
            delete content.backgroundFrame
          }
          break
        }
        case 'set_mask':
          content.mask = operation.mask
          clearLayerMask(content, 'subject')
          delete content.subjectMaskAnchor
          validateMask = true
          break
        case 'set_layer_mask': {
          const { layerId, base } = operation
          const reference = this.layerReference(poster, content, layerId)
          if (base) {
            this.source(reference.artworkId, reference.versionId)
            content.layerMasks ??= {}
            content.layerMasks[layerId] = { base, strokes: [] }
          } else {
            clearLayerMask(content, layerId)
            if (layerId === 'subject' && content.mask.type !== 'none') {
              content.subjectMaskAnchor = content.mask
              content.mask = { type: 'none' }
            }
          }
          break
        }
        case 'paint_layer_mask': {
          const { layerId, stroke } = operation
          const reference = this.layerReference(poster, content, layerId)
          const layerMask = existingLayerMask(content, layerId) ?? revealedMask
          if (layerMask.strokes.length >= posterMaskStrokeLimit) {
            throw new Error(`每层蒙版最多支持 ${posterMaskStrokeLimit} 笔，请撤销或重建蒙版`)
          }
          this.source(reference.artworkId, reference.versionId)
          content.layerMasks ??= {}
          content.layerMasks[layerId] = { ...layerMask, strokes: [...layerMask.strokes, stroke] }
          break
        }
        case 'set_subject': content.subject = { ...content.subject, ...operation.subject }; break
        case 'set_shadow': content.shadow = { ...content.shadow, ...operation.shadow }; break
        case 'upsert_text': {
          const index = content.textLayers.findIndex(layer => layer.id === operation.layer.id)
          if (index >= 0) content.textLayers[index] = operation.layer
          else {
            if (content.textLayers.length >= maxPosterTextLayers) throw new Error(`每张海报最多支持 ${maxPosterTextLayers} 个文字图层`)
            content.textLayers.push(operation.layer)
            content.layerOrder.push(`text:${operation.layer.id}`)
          }
          break
        }
        case 'remove_text':
          content.textLayers = content.textLayers.filter(layer => layer.id !== operation.layerId)
          content.layerOrder = content.layerOrder.filter(id => id !== `text:${operation.layerId}`)
          break
        case 'add_image': await this.addImageLayer(content, operation); break
        case 'set_image':
          content.imageLayers = setImageLayer(content.imageLayers, operation.layerId, operation.layer)
          break
        case 'remove_image':
          content.imageLayers = content.imageLayers.filter(layer => layer.id !== operation.layerId)
          content.layerOrder = content.layerOrder.filter(id => id !== `image:${operation.layerId}`)
          clearLayerMask(content, `image:${operation.layerId}`)
          clearLayerPixels(content, `image:${operation.layerId}`)
          break
        case 'reorder_layers': {
          const order = new Set(operation.order)
          if (operation.order.length !== content.layerOrder.length || content.layerOrder.some(id => !order.has(id))) {
            throw new Error('图层排序必须包含每个现有图层，且每层只出现一次')
          }
          content.layerOrder = operation.order
          break
        }
      }
    }
    if (validateMask && content.mask.type !== 'none') await this.getPreparedSubject(artworkId, poster.sourceVersionId, content.mask)
    return this.commit({ ...poster, content }, describePosterEdit(operations, poster.content))
  }

  async undo(artworkId: string, revision: number) {
    this.requirePoster(artworkId, revision)
    const history = this.getEditorHistory(artworkId)
    if (history.cursor === 0) throw new Error('当前没有可以撤销的修改')
    await this.navigateEditorHistory(artworkId, history.revision, history.cursor - 1)
    return this.get(artworkId)
  }

  private async commit(poster: StoredPoster, change: EditorPosterHistoryEdit, pixelTiles?: PosterPixelTileWrite[]) {
    const updated = { ...poster, revision: poster.revision + 1 }
    await this.database.savePoster(updated, poster.revision, change, pixelTiles)
    const history = this.getEditorHistory(poster.artworkId)
    const result = describe(updated, history)
    this.onChange(result)
    this.publish?.({ type: 'editor_history_changed', history, reason: 'edit' })
    return result
  }

  async previewSource(artworkId: string, versionId?: string) {
    return sourceThumbnail(this.source(posterId.parse(artworkId), versionId).bytes)
  }

  async previewSubjectSource(artworkId: string) {
    const poster = this.requirePoster(artworkId)
    const source = this.source(artworkId, poster.sourceVersionId).bytes
    const layer = poster.content.pixelLayers?.subject
    if (!layer) return sourceThumbnail(source)
    const tiles = this.database.getPosterPixelTiles(artworkId, Object.values(layer.tiles))
    return sourceThumbnail(await composeStoredPixels(source, layer, tiles))
  }

  async previewLayerMask(artworkId: string, layerId: unknown, revision: number): Promise<PosterLayerMaskPreview> {
    const input = posterMaskPreviewInput.parse({ artworkId, layerId, revision })
    const poster = this.requirePoster(input.artworkId, input.revision)
    const reference = this.layerReference(poster, poster.content, input.layerId)
    const bytes = this.source(reference.artworkId, reference.versionId).bytes
    const mask = existingLayerMask(poster.content, input.layerId)
    const layer = poster.content.pixelLayers?.[input.layerId]
    const edited = layer && await composeStoredPixels(bytes, layer, this.database.getPosterPixelTiles(artworkId, Object.values(layer.tiles)))
    const { sourceBytes, maskBytes, width, height } = await renderLayerMaskPreview(bytes, mask, input.layerId === 'subject', edited)
    return { source: pngDataUrl(sourceBytes), mask: pngDataUrl(maskBytes), width, height, revision: poster.revision }
  }

  private async render(artworkId: string, options: PosterOutput, maxSide?: number, transform?: PosterTransformPreview) {
    const poster = this.requirePoster(artworkId, transform?.revision)
    let content = poster.content
    if (transform) {
      const { layerId, box, rotation, stretch } = transform
      const settings = rotation === undefined ? box : { ...box, rotation }
      content = layerId === 'subject'
        ? { ...content, subject: { ...content.subject, ...settings, stretch: stretch ?? content.subject.stretch } }
        : { ...content, imageLayers: setImageLayer(content.imageLayers, layerId.slice('image:'.length), settings) }
    }
    if (options.size !== 'current') {
      const { width, height } = posterSizes[options.size]
      content = resizePoster(content, width, height)
    }
    const { width, height } = content
    const factor = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1
    const raster = { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }
    const tileIds = Object.values(content.pixelLayers ?? {}).flatMap(layer => Object.values(layer?.tiles ?? {}))
    const tiles = this.database.getPosterPixelTiles(artworkId, tileIds)
    const layerSource = (id: PosterMaskLayerId, bytes: Buffer | undefined) => {
      const pixels = content.pixelLayers?.[id]
      return bytes && pixels ? composeStoredPixels(bytes, pixels, tiles) : bytes
    }
    const subjectMask = content.layerMasks?.subject ?? (content.subjectMaskAnchor ? revealedMask : undefined)
    const subject = content.subject.visible && (maxSide || content.subject.opacity)
      ? await this.getPreparedSubject(artworkId, poster.sourceVersionId, content.subjectMaskAnchor ?? content.mask, subjectMask,
        content.pixelLayers?.subject, tiles).catch(error => {
        if (content.subject.opacity) throw error
        return undefined
      })
      : undefined
    const background = content.background.type === 'image'
      ? await layerSource('background', this.database.getArtworkSource(content.background.artworkId, content.background.versionId)?.bytes)
      : undefined
    const { canvas, imageBounds } = await renderPoster(content, {
      subject, background,
      image: layer => {
        const bytes = this.database.getArtworkSource(layer.artworkId, layer.versionId)?.bytes
        return layer.opacity ? layerSource(`image:${layer.id}`, bytes) : bytes
      }
    }, options.format === 'jpeg', raster)
    const bytes = options.format === 'jpeg' ? await canvas.encode('jpeg', 94) : await canvas.encode('png')
    const sx = poster.content.width / width
    const sy = poster.content.height / height
    const documentBounds = options.size === 'current' ? imageBounds : Object.fromEntries(
      Object.entries(imageBounds).map(([id, box]) => [id, { x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy }])
    )
    return { bytes, width, height, imageBounds: documentBounds, revision: poster.revision }
  }

  async preview(artworkId: string, size: PosterOutput['size'] = 'current', transform?: unknown): Promise<PosterImage> {
    const { bytes, ...metadata } = await this.render(artworkId, posterOutput.parse({ size }), 800, posterTransformPreview.optional().parse(transform))
    return { ...metadata, src: pngDataUrl(bytes) }
  }

  async export(artworkId: string, options: PosterOutput, name = '海报') {
    const validated = posterOutput.parse(options)
    const { bytes, width, height, revision } = await this.render(artworkId, validated)
    const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 70).replace(/^[.\s]+|[.\s]+$/g, '') || '海报'
    const extension = validated.format === 'jpeg' ? 'jpg' : 'png'
    await mkdir(this.exportDirectory, { recursive: true })
    const path = join(this.exportDirectory, `${safeName}-${randomUUID().slice(0, 8)}.${extension}`)
    await writeFile(path, bytes, { flag: 'wx' })
    return { width, height, revision, path }
  }
}
