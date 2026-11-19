import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { posterEdit, posterId, posterOutput, posterSizes, resizePoster } from '../src/lib/poster'
import type { PosterContent, PosterDocument, PosterImage, PosterOutput } from '../src/lib/poster'
import type { StoredPoster, StudioDatabase } from './database'
import { prepareSubject, renderPoster, sourceThumbnail } from './poster-render'

const maxPixels = 8_400_000
const historyLimit = 20
const initialContent: PosterContent = {
  ...posterSizes.square,
  background: { type: 'transparent' },
  subject: { x: 140, y: 240, width: 800, height: 720, opacity: 1, rotation: 0, brightness: 100, saturation: 100, visible: true },
  mask: { type: 'none' },
  shadow: { opacity: 0.24, color: '#202033', visible: false },
  textLayers: []
}

function describe({ artworkId, sourceVersionId, revision, content, history }: StoredPoster): PosterDocument {
  return { artworkId, sourceVersionId, revision, ...content, canUndo: history.length > 0 }
}

export class PosterService {
  constructor(private database: StudioDatabase, private exportDirectory: string, private onChange: (poster: PosterDocument) => void) {}

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

  async open(artworkId: string, versionId?: string): Promise<PosterDocument> {
    posterId.parse(artworkId)
    if (versionId !== undefined) posterId.parse(versionId)
    const existing = this.database.getPoster(artworkId)
    if (existing) return describe(existing)
    const source = this.source(artworkId, versionId)
    const poster = { artworkId, sourceVersionId: source.versionId, revision: 1, content: initialContent, history: [] }
    await this.database.savePoster(poster, 0)
    return describe(poster)
  }

  get(artworkId: string) { return describe(this.requirePoster(artworkId)) }

  async edit(input: unknown) {
    const { artworkId, revision, operations } = posterEdit.parse(input)
    const poster = this.requirePoster(artworkId, revision)
    let content = structuredClone(poster.content)
    let validateMask = false
    for (const operation of operations) {
      switch (operation.op) {
        case 'set_size':
          if (operation.width * operation.height > maxPixels) throw new Error('画布不能超过 840 万像素')
          content = resizePoster(content, operation.width, operation.height)
          break
        case 'set_background': {
          const background = operation.background
          content.background = background.type === 'image'
            ? { ...background, versionId: this.source(background.artworkId, background.versionId).versionId }
            : background
          break
        }
        case 'set_mask': content.mask = operation.mask; validateMask = true; break
        case 'set_subject': content.subject = { ...content.subject, ...operation.subject }; break
        case 'set_shadow': content.shadow = { ...content.shadow, ...operation.shadow }; break
        case 'upsert_text': {
          const index = content.textLayers.findIndex(layer => layer.id === operation.layer.id)
          if (index >= 0) content.textLayers[index] = operation.layer
          else {
            if (content.textLayers.length >= 12) throw new Error('每张海报最多支持 12 个文字图层')
            content.textLayers.push(operation.layer)
          }
          break
        }
        case 'remove_text': content.textLayers = content.textLayers.filter(layer => layer.id !== operation.layerId); break
      }
    }
    if (validateMask && content.mask.type !== 'none') await prepareSubject(this.source(artworkId, poster.sourceVersionId).bytes, content.mask)
    return this.commit({ ...poster, content, history: [...poster.history, poster.content].slice(-historyLimit) })
  }

  async undo(artworkId: string, revision: number) {
    const poster = this.requirePoster(artworkId, revision)
    const content = poster.history.at(-1)
    if (!content) throw new Error('当前没有可以撤销的修改')
    return this.commit({ ...poster, content, history: poster.history.slice(0, -1) })
  }

  private async commit(poster: StoredPoster) {
    const updated = { ...poster, revision: poster.revision + 1 }
    await this.database.savePoster(updated, poster.revision)
    const result = describe(updated)
    this.onChange(result)
    return result
  }

  async previewSource(artworkId: string, versionId?: string) {
    return sourceThumbnail(this.source(posterId.parse(artworkId), versionId).bytes)
  }

  private async render(artworkId: string, options: PosterOutput, maxSide?: number) {
    const poster = this.requirePoster(artworkId)
    let content = poster.content
    if (options.size !== 'current') {
      const { width, height } = posterSizes[options.size]
      content = resizePoster(content, width, height)
    }
    const { width, height } = content
    if (maxSide && Math.max(width, height) > maxSide) {
      const factor = maxSide / Math.max(width, height)
      content = resizePoster(content, Math.max(1, Math.round(width * factor)), Math.max(1, Math.round(height * factor)))
    }
    const source = content.subject.visible && content.subject.opacity ? this.source(artworkId, poster.sourceVersionId).bytes : undefined
    const background = content.background.type === 'image'
      ? this.database.getArtworkSource(content.background.artworkId, content.background.versionId)?.bytes
      : undefined
    const canvas = await renderPoster(content, source, background, options.format === 'jpeg')
    const bytes = options.format === 'jpeg' ? await canvas.encode('jpeg', 94) : await canvas.encode('png')
    return { bytes, width, height, revision: poster.revision }
  }

  async preview(artworkId: string, size: PosterOutput['size'] = 'current'): Promise<PosterImage> {
    const { bytes, ...metadata } = await this.render(artworkId, posterOutput.parse({ size }), 800)
    return { ...metadata, src: `data:image/png;base64,${bytes.toString('base64')}` }
  }

  async export(artworkId: string, options: PosterOutput, name = '海报') {
    const validated = posterOutput.parse(options)
    const { bytes, ...metadata } = await this.render(artworkId, validated)
    const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 70).replace(/^[.\s]+|[.\s]+$/g, '') || '海报'
    const extension = validated.format === 'jpeg' ? 'jpg' : 'png'
    await mkdir(this.exportDirectory, { recursive: true })
    const path = join(this.exportDirectory, `${safeName}-${randomUUID().slice(0, 8)}.${extension}`)
    await writeFile(path, bytes, { flag: 'wx' })
    return { ...metadata, path }
  }
}
