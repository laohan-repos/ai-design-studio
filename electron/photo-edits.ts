import { randomUUID } from 'node:crypto'
import worker from './photo-edit-worker?nodeWorker'
import type { PhotoColorWork, PhotoCropWork, PhotoCropWorkResult, PhotoWork, PhotoWorkResult } from './photo-edit-render'
import type { PhotoColors } from '../src/lib/color-grade'
import type { SuggestedPhotoCrops } from '../src/lib/photo-crop'
import type { PhotoWorkerReply } from './photo-edit-worker'
import type { StudioDatabase } from './database'
import type { McpWorkspaceChange } from '../src/types'
import {
  inspectColorsInput, inspectPhotoInput, photoRecipeInput, previewMaskInput, previewPhotoEditInput, suggestPhotoCropsInput,
  type EditorSelection, type PhotoColorInspection, type PhotoEditPlan, type PhotoEditPreview, type PhotoInspection, type SavedPhotoEdit
} from '../src/lib/photo-edits'

const expiresAfter = 20 * 60_000
const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
type Draft = { plan: PhotoEditPlan; expiresAt: number; saved?: SavedPhotoEdit; saving?: Promise<SavedPhotoEdit> }

function processPhoto(work: PhotoWork): Promise<PhotoWorkResult>
function processPhoto(work: PhotoColorWork): Promise<PhotoColors>
function processPhoto(work: PhotoCropWork): Promise<PhotoCropWorkResult>
function processPhoto(work: PhotoWork | PhotoColorWork | PhotoCropWork) {
  return new Promise<PhotoWorkResult | PhotoColors | PhotoCropWorkResult>((resolve, reject) => {
    const bytes = Uint8Array.from(work.bytes)
    const task = worker({ workerData: { ...work, bytes }, transferList: [bytes.buffer] })
    const timer = setTimeout(() => {
      reject(new Error('局部精修超时，可缩小图片或分批执行操作'))
      void task.terminate()
    }, 45_000)
    task.once('message', (response: PhotoWorkerReply) => {
      clearTimeout(timer)
      if (response.ok) resolve(response.result)
      else reject(new Error(response.message))
    })
    task.once('error', () => {
      clearTimeout(timer)
      reject(new Error('无法启动本地修图进程'))
    })
    task.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('本地修图进程提前退出'))
    })
  })
}

export function describeEditorContext(database: StudioDatabase, selection?: EditorSelection) {
  const canvas = selection?.canvasId && database.listCanvases(false).find(item => item.id === selection.canvasId)
  if (!canvas) return { canvas: null, selectedArtworks: [], target: null }
  const ids = [...new Set(selection.selectedArtworkIds)]
  const selectedArtworks = ids.flatMap(id => {
    const artwork = database.getArtworkReference(id)
    return artwork?.canvasId === canvas.id ? [artwork] : []
  })
  const editing = selection.editingArtworkId && database.getArtworkReference(selection.editingArtworkId)
  const only = !selectedArtworks.length && canvas.artworkCount === 1 && database.listArtworkMetadata(canvas.id, 1, 0)[0]
  const fallback = only ? database.getArtworkReference(only.id) : undefined
  const viewed = editing && editing.canvasId === canvas.id ? editing : undefined
  const target = viewed || (selectedArtworks.length === 1 ? selectedArtworks[0] : fallback)
  const viewedVersion = viewed && selection.viewedVersionId
    && database.listArtworkVersionMetadata(viewed.artworkId).find(version => version.id === selection.viewedVersionId)
  return {
    canvas: { id: canvas.id, name: canvas.name, artworkCount: canvas.artworkCount },
    selectedArtworks,
    target: target ? { ...target, versionId: viewedVersion ? viewedVersion.id : target.currentVersionId,
      reason: viewed ? 'editing' : selectedArtworks.length === 1 ? 'selected' : 'only_artwork' } : null
  }
}

export class PhotoEdits {
  private drafts = new Map<string, Draft>()
  private running = 0

  constructor(private database: StudioDatabase, private publish: (change: McpWorkspaceChange) => void) {}

  private source(artworkId: string, versionId?: string) {
    const source = this.database.getArtworkSource(artworkId, versionId)
    if (!source) throw new Error('找不到指定的图片或版本')
    return source
  }

  private async process<Result>(work: () => Promise<Result>) {
    if (this.running >= 2) throw new Error('正在处理其他照片，请稍候重试')
    this.running++
    try { return await work() }
    finally { this.running-- }
  }

  async inspect(input: unknown): Promise<PhotoInspection> {
    const { artworkId, versionId, region } = inspectPhotoInput.parse(input)
    const source = this.source(artworkId, versionId)
    const { before: _, after, ...frame } = await this.process(() => processPhoto({ type: 'inspect', bytes: source.bytes, region }))
    return { ...frame, artworkId, versionId: source.versionId, src: dataUrl(after) }
  }

  async previewMask(input: unknown): Promise<PhotoInspection> {
    const { artworkId, versionId, region, mask } = previewMaskInput.parse(input)
    const source = this.source(artworkId, versionId)
    const { before: _, after, ...frame } = await this.process(() => processPhoto({ type: 'mask', bytes: source.bytes, region, mask }))
    return { ...frame, artworkId, versionId, src: dataUrl(after) }
  }

  async inspectColors(input: unknown): Promise<PhotoColorInspection> {
    const { artworkId, versionId, region, samples } = inspectColorsInput.parse(input)
    const source = this.source(artworkId, versionId)
    const colors = await this.process(() => processPhoto({ type: 'colors', bytes: source.bytes, region, samples }))
    return { artworkId, versionId: source.versionId, ...colors }
  }

  async suggestCrops(input: unknown): Promise<SuggestedPhotoCrops> {
    const { artworkId, versionId, ...composition } = suggestPhotoCropsInput.parse(input)
    const source = this.source(artworkId, versionId)
    const { candidates, ...size } = await this.process(() => processPhoto({ type: 'crops', bytes: source.bytes, composition }))
    return { artworkId, versionId: source.versionId, ...size,
      candidates: candidates.map(({ overlay, preview, ...candidate }) => ({ ...candidate, overlay: dataUrl(overlay), preview: dataUrl(preview) })) }
  }

  recipe(input: unknown): PhotoEditPlan | null {
    const { artworkId, versionId } = photoRecipeInput.parse(input)
    const stored = this.database.getArtworkEditRecipe(artworkId, versionId)
    return stored ? previewPhotoEditInput.parse(JSON.parse(stored)) : null
  }

  async preview(input: unknown): Promise<PhotoEditPreview> {
    const plan = previewPhotoEditInput.parse(input)
    const { artworkId, versionId, operations, region } = plan
    const source = this.source(artworkId, versionId)
    const { before, after, ...frame } = await this.process(() => processPhoto({ type: 'preview', bytes: source.bytes, operations, region }))
    if (!before) throw new Error('无法生成修图对比')

    const now = Date.now()
    for (const [id, draft] of this.drafts) {
      if (!draft.saving && (draft.expiresAt <= now || this.drafts.size >= 32)) this.drafts.delete(id)
    }
    const draftId = randomUUID()
    const expiresAt = now + expiresAfter
    this.drafts.set(draftId, { plan, expiresAt })
    return { ...frame, artworkId, versionId, draftId, expiresAt, before: dataUrl(before), after: dataUrl(after) }
  }

  async save(draftId: string): Promise<SavedPhotoEdit> {
    const draft = this.drafts.get(draftId)
    if (!draft || (!draft.saving && draft.expiresAt <= Date.now())) throw new Error('预览已过期，请重新生成对比')
    if (draft.saved) return draft.saved
    if (draft.saving) return draft.saving
    draft.saving = this.saveDraft(draftId, draft.plan)
    try {
      draft.saved = await draft.saving
      return draft.saved
    } finally { draft.saving = undefined }
  }

  private async saveDraft(draftId: string, { artworkId, versionId, operations }: PhotoEditPlan): Promise<SavedPhotoEdit> {
    const expectedRevision = this.database.getEditorHistory(artworkId).revision
    const source = this.source(artworkId, versionId)
    const { after } = await this.process(() => processPhoto({ type: 'render', bytes: source.bytes, operations }))
    const final = operations.at(-1)
    const isSize = final?.type === 'resize' || final?.type === 'canvas_size'
    const kind = final?.type === 'crop' ? 'crop'
      : !isSize && operations.some(operation => operation.type === 'grade') ? 'grade' : 'photo'
    const recipe = kind === 'photo' ? undefined : JSON.stringify({ artworkId, versionId, operations })
    const label = final?.type === 'resize' ? '调整图像尺寸'
      : final?.type === 'canvas_size' ? '调整画布尺寸'
      : final?.type === 'crop' && final.angle ? '拉直并裁剪'
      : { crop: '裁剪', grade: '调色', photo: '局部精修' }[kind]
    const version = await this.database.saveArtworkVersion({ id: draftId, artworkId, src: dataUrl(after),
      prompt: source.prompt, createdAt: Date.now() }, recipe, {
      kind, label, sourceVersionId: versionId, expectedRevision
    })
    this.publish({ type: 'artwork_versions_changed', artworkId })
    this.publish({ type: 'editor_history_changed', history: this.database.getEditorHistory(artworkId), reason: 'edit' })
    return { artworkId, sourceVersionId: versionId, versionId: version.id, versionNumber: version.versionNumber }
  }
}
