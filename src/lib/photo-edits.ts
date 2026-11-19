import { z } from 'zod'
import { hasPhotoArea } from './photo-geometry'
import { colorGrade, type PhotoColors } from './color-grade'
import { cropAspects, type CropBox } from './photo-crop'
import { maxStraightenAngle } from './photo-straighten'
import { canvasAnchors, photoSizeMaxPixels, photoSizeMaxSide, type DocumentDimensions } from './document-size'

const id = z.string().trim().min(1).max(128)
const unit = z.number().min(0).max(1)
const amount = z.number().min(-100).max(100)
const strength = z.number().min(1).max(100).default(85)
export const photoPoint = z.object({ x: unit, y: unit })
export const photoRegion = z.object({ x: unit, y: unit, width: unit.min(0.001), height: unit.min(0.001) })
  .refine(box => box.x + box.width <= 1.000000001 && box.y + box.height <= 1.000000001, '区域须位于原图内')
const polygon = z.array(photoPoint).min(3).max(160).refine(hasPhotoArea, '多边形选区需要有面积')
const selection = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rectangle'), box: photoRegion }),
  z.object({ type: z.literal('ellipse'), box: photoRegion }),
  z.object({ type: z.literal('polygon'), points: polygon }),
  z.object({ type: z.literal('brush'), points: z.array(photoPoint).min(1).max(160), radius: unit.min(0.002).max(0.25) })
])
export const photoMask = z.object({
  include: z.array(selection).max(12).describe('合并这些区域；传空数组时对全图应用减选'),
  exclude: z.array(selection).max(12).default([]).describe('保护这些区域，从选区中减去'),
  feather: unit.max(0.08).default(0.01).describe('选区边缘羽化，相对于原图短边')
}).refine(mask => mask.include.length || mask.exclude.length, '请提供加选或保护区域')
const pixelRepair = {
  target: photoPoint,
  radius: unit.min(0.002).max(0.10).describe('笔刷半径，相对于原图短边'),
  strength
}
export const pixelCropBox = z.object({ x: z.number().int().min(0).max(32000000), y: z.number().int().min(0).max(32000000),
  width: z.number().int().min(1).max(32000000), height: z.number().int().min(1).max(32000000) })
  .describe('整张指定版本的像素坐标。x、y 为左上角；拉直时按原宽高、绕原图中心旋转后的画面计坐标')
const photoDimension = z.number().int().min(1).max(photoSizeMaxSide)
const photoSize = { width: photoDimension, height: photoDimension }
export const photoOperation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('crop'), box: pixelCropBox,
    angle: z.number().min(-maxStraightenAngle).max(maxStraightenAngle).optional().describe('顺时针校正角度（度），省略为 0') }),
  z.object({ type: z.literal('resize'), ...photoSize })
    .refine(({ width, height }) => width * height <= photoSizeMaxPixels, '新图像不能超过 3200 万像素'),
  z.object({ type: z.literal('canvas_size'), ...photoSize, anchor: z.enum(canvasAnchors).default('center') })
    .refine(({ width, height }) => width * height <= photoSizeMaxPixels, '新画布不能超过 3200 万像素'),
  z.object({ type: z.literal('grade'), mask: photoMask.optional(), settings: colorGrade }),
  z.object({ type: z.literal('tone'), mask: photoMask.optional(), exposure: z.number().min(-2).max(2).optional(),
    contrast: amount.optional(), shadows: amount.optional(), highlights: amount.optional(),
    temperature: amount.optional(), tint: amount.optional(), saturation: amount.optional(), redness: amount.min(0).optional() })
    .refine(({ exposure, contrast, shadows, highlights, temperature, tint, saturation, redness }) =>
      Boolean(exposure || contrast || shadows || highlights || temperature || tint || saturation || redness), '调色至少需要一项调整'),
  z.object({ type: z.literal('texture'), mask: photoMask.optional(), amount: amount.refine(value => value !== 0, '纹理强度不能为 0') }),
  z.object({ type: z.literal('heal'), ...pixelRepair, source: photoPoint.optional() }),
  z.object({ type: z.literal('clone'), ...pixelRepair, source: photoPoint })
])

export const inspectPhotoInput = z.object({ artworkId: id, versionId: id.optional(), region: photoRegion.optional() })
export const suggestPhotoCropsInput = inspectPhotoInput.pick({ artworkId: true, versionId: true }).extend({
  aspect: z.enum(cropAspects).default('original'),
  focus: photoPoint.optional().describe('视觉重点在整张图上的归一化位置'),
  keep: z.array(photoRegion).max(12).default([]).describe('必须完整保留的区域，坐标均相对于整图'),
  horizon: z.object({ y: unit, placement: z.enum(['top','bottom','auto']).default('auto') }).optional()
    .describe('水平线的原图归一化纵坐标及期望对齐的黄金横线'),
  count: z.number().int().min(1).max(2).default(2)
})
export const photoRecipeInput = z.object({ artworkId: id, versionId: id })
export const inspectColorsInput = inspectPhotoInput.extend({
  samples: z.array(z.object({ label: z.string().trim().min(1).max(40), region: photoRegion })).max(8).default([])
})
export const previewMaskInput = inspectPhotoInput.extend({ versionId: id, mask: photoMask })
export const previewPhotoEditInput = inspectPhotoInput.extend({
  versionId: id,
  operations: z.array(photoOperation).min(1).max(16),
  region: photoRegion.optional().describe('同位置对比的范围；操作坐标仍以整张源图为准')
}).refine(({ operations, region }) => {
  const geometry = operations.findIndex(({ type }) => type === 'crop' || type === 'resize' || type === 'canvas_size')
  return geometry < 0 || (!region && geometry === operations.length - 1)
}, '裁剪或尺寸调整须作为最后一步，且预览以整张图为准')
export const editorSelectionInput = z.object({
  canvasId: id.optional(),
  selectedArtworkIds: z.array(id).max(512),
  editingArtworkId: id.optional(),
  viewedVersionId: id.optional()
})

export type PhotoPoint = z.infer<typeof photoPoint>
export type PhotoRegion = z.infer<typeof photoRegion>
export type PhotoSelection = z.infer<typeof selection>
export type PhotoMask = z.input<typeof photoMask>
export type PhotoSelectionReference = { artworkId: string; versionId: string; selection: PhotoMask }
export type PhotoOperation = z.input<typeof photoOperation>
export type RenderPhotoOperation = z.output<typeof photoOperation>
export type PhotoSizeOperation = Extract<PhotoOperation, { type: 'resize' | 'canvas_size' }>
export type PhotoEditPlan = z.output<typeof previewPhotoEditInput>
export type PhotoView = z.input<typeof inspectPhotoInput>
export type PhotoColorsView = z.input<typeof inspectColorsInput>
export type PhotoColorInspection = PhotoColors & { artworkId: string; versionId: string }
export type PhotoMaskView = z.input<typeof previewMaskInput>
export type PhotoEditRequest = z.input<typeof previewPhotoEditInput>
export type PhotoCropRequest = z.input<typeof suggestPhotoCropsInput>
export type EditorSelection = z.infer<typeof editorSelectionInput>

export type PhotoFrame = {
  width: number
  height: number
  imageWidth: number
  imageHeight: number
  crop: { x: number; y: number; width: number; height: number }
}
export type PhotoInspection = PhotoFrame & { artworkId: string; versionId: string; src: string }
export type PhotoEditPreview = PhotoFrame & {
  artworkId: string
  versionId: string
  draftId: string
  expiresAt: number
  before: string
  after: string
  cropBox?: CropBox
  cropAngle?: number
  outputSize?: DocumentDimensions
}
export type SavedPhotoEdit = { artworkId: string; sourceVersionId: string; versionId: string; versionNumber: number }
