import { z } from 'zod'
import { photoMask } from './photo-edits'
import { canvasAnchors, canvasResizeOffset, type CanvasAnchor } from './document-size'
import type { PosterPixelLayer } from './poster-pixels'
import { maxPosterImageLayers, maxPosterTextLayers, posterBoxLimit, posterCoordinateLimit, posterMaskMaxRadius, posterMaskMinRadius, posterMaskStrokePointLimit, posterMaxSide, posterMinSide } from './poster-limits'

export const posterId = z.string().trim().min(1).max(128)
const color = z.string().regex(/^#[0-9a-f]{6}$/i, '颜色须使用 #RRGGBB')
const dimension = z.number().int().min(posterMinSide).max(posterMaxSide)
const boxDimension = z.number().int().min(1).max(posterBoxLimit)
const coordinate = z.number().int().min(-posterCoordinateLimit).max(posterCoordinateLimit)
const fraction = z.number().min(0).max(1)
const point = z.object({ x: fraction, y: fraction })
const layerId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const imageLayerId = z.templateLiteral(['image:', layerId])
const posterLayerId = z.union([z.literal('subject'), imageLayerId, z.templateLiteral(['text:', layerId])])
const posterMaskLayerId = z.union([z.literal('subject'), imageLayerId, z.literal('background')])
const posterBox = z.object({ x: coordinate, y: coordinate, width: boxDimension, height: boxDimension })
const posterRotation = z.number().min(-180).max(180)
const posterTransformOptions = z.object({ rotation: posterRotation.optional(), stretch: z.boolean().optional() })

export const posterBackground = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transparent') }),
  z.object({ type: z.literal('solid'), color }),
  z.object({ type: z.literal('gradient'), top: color, bottom: color }),
  z.object({ type: z.literal('image'), artworkId: posterId, versionId: posterId.optional() })
])

export const posterMask = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('edge_color'), tolerance: z.number().int().min(1).max(150), color: color.optional() }),
  z.object({ type: z.literal('polygon'), points: z.array(point).min(3).max(160) })
])

const posterLayerMaskBase = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reveal') }),
  z.object({ type: z.literal('selection'), selection: photoMask })
])

const posterMaskStroke = z.object({
  mode: z.enum(['hide', 'restore']),
  radius: z.number().min(posterMaskMinRadius).max(posterMaskMaxRadius),
  points: z.array(point).min(1).max(posterMaskStrokePointLimit)
})

export const posterSubject = posterBox.extend({
  rotation: posterRotation, stretch: posterTransformOptions.shape.stretch, opacity: fraction,
  brightness: z.number().int().min(0).max(200), saturation: z.number().int().min(0).max(200), visible: z.boolean()
})

export const posterText = z.object({
  id: layerId,
  text: z.string().max(300).refine(value => Boolean(value.trim()), '文字不能为空'),
  x: coordinate, y: coordinate, width: boxDimension, fontSize: z.number().int().min(1).max(1000),
  color, weight: z.enum(['regular', 'bold']), align: z.enum(['left', 'center', 'right']), visible: z.boolean()
})

const shadow = z.object({ visible: z.boolean(), opacity: fraction, color })
const posterImageSettings = posterBox.extend({ rotation: posterTransformOptions.shape.rotation, opacity: fraction, visible: z.boolean() })

export const posterOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_size'), width: dimension, height: dimension }),
  z.object({ op: z.literal('set_canvas_size'), width: dimension, height: dimension, anchor: z.enum(canvasAnchors).default('center') }),
  z.object({ op: z.literal('set_background'), background: posterBackground }),
  z.object({ op: z.literal('set_mask'), mask: posterMask }),
  z.object({ op: z.literal('set_layer_mask'), layerId: posterMaskLayerId, base: posterLayerMaskBase.nullable() }),
  z.object({ op: z.literal('paint_layer_mask'), layerId: posterMaskLayerId, stroke: posterMaskStroke }),
  z.object({ op: z.literal('set_subject'), subject: posterSubject.partial() }),
  z.object({ op: z.literal('set_shadow'), shadow: shadow.partial() }),
  z.object({ op: z.literal('upsert_text'), layer: posterText }),
  z.object({ op: z.literal('remove_text'), layerId }),
  z.object({ op: z.literal('add_image'), layerId, artworkId: posterId, versionId: posterId.optional() }),
  z.object({ op: z.literal('set_image'), layerId, layer: posterImageSettings.partial() }),
  z.object({ op: z.literal('remove_image'), layerId }),
  z.object({ op: z.literal('reorder_layers'), order: z.array(posterLayerId).min(1).max(1 + maxPosterImageLayers + maxPosterTextLayers) })
])

export const posterEdit = z.object({
  artworkId: posterId,
  revision: z.number().int().min(1),
  operations: z.array(posterOperation).min(1).max(24)
})

export const posterOutput = z.object({
  size: z.enum(['current', 'square', 'portrait']).default('current'),
  format: z.enum(['png', 'jpeg']).default('png')
})

export const posterTransformPreview = posterTransformOptions.extend({
  revision: z.number().int().min(1),
  layerId: z.union([z.literal('subject'), imageLayerId]),
  box: posterBox
})

export const posterMaskPreviewInput = z.object({
  artworkId: posterId,
  layerId: posterMaskLayerId,
  revision: z.number().int().min(1)
})

export type PosterOperation = z.input<typeof posterOperation>
export type PosterOutput = z.output<typeof posterOutput>
export type PosterText = z.infer<typeof posterText>
export type PosterPoint = z.infer<typeof point>
export type PosterMask = z.infer<typeof posterMask>
export type PosterMaskLayerId = z.infer<typeof posterMaskLayerId>
export type PosterMaskStroke = z.infer<typeof posterMaskStroke>
export type PosterLayerMask = {
  base: z.input<typeof posterLayerMaskBase> | { type: 'legacy'; mask: PosterMask }
  strokes: PosterMaskStroke[]
}
export type PosterLayerMaskPreview = { source: string; mask: string; width: number; height: number; revision: number }
export type PosterBox = z.infer<typeof posterBox>
export type PosterImageTransform = PosterBox & z.infer<typeof posterTransformOptions>
export type PosterLayerId = z.infer<typeof posterLayerId>
export type PosterTransformPreview = z.infer<typeof posterTransformPreview>
export type PosterImageLayer = z.infer<typeof posterImageSettings> & {
  id: string
  artworkId: string
  versionId: string
  name: string
}

export type PosterContent = {
  width: number
  height: number
  background: z.infer<typeof posterBackground>
  backgroundFrame?: PosterBox
  subject: z.infer<typeof posterSubject>
  mask: PosterMask
  layerMasks?: Partial<Record<PosterMaskLayerId, PosterLayerMask>>
  pixelLayers?: Partial<Record<PosterMaskLayerId, PosterPixelLayer>>
  // Keep the old subject fit after a legacy mask has been removed.
  subjectMaskAnchor?: PosterMask
  shadow: z.infer<typeof shadow>
  textLayers: PosterText[]
  imageLayers: PosterImageLayer[]
  // Foreground order from bottom to top. The shadow is drawn with its subject.
  layerOrder: PosterLayerId[]
}

export type PosterDocument = PosterContent & {
  artworkId: string
  sourceVersionId: string
  revision: number
  canUndo: boolean
}

export type PosterImage = {
  src: string
  width: number
  height: number
  revision: number
  // Unrotated bounds in the original document's coordinates.
  imageBounds: Partial<Record<PosterLayerId, PosterBox>>
}

export const posterSizes = { square: { width: 1080, height: 1080 }, portrait: { width: 1080, height: 1620 } } as const

export function resizePoster(content: PosterContent, width: number, height: number): PosterContent {
  const sx = width / content.width
  const sy = height / content.height
  const scale = (value: number, ratio: number) => Math.round(value * ratio)
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const scaleBox = <T extends { x: number; y: number; width: number }>(box: T): T => ({
    ...box, x: clamp(scale(box.x, sx), -posterCoordinateLimit, posterCoordinateLimit),
    y: clamp(scale(box.y, sy), -posterCoordinateLimit, posterCoordinateLimit),
    width: clamp(scale(box.width, sx), 1, posterBoxLimit)
  })
  const scaleImage = <T extends PosterBox>(box: T): T => ({
    ...scaleBox(box), height: clamp(scale(box.height, sy), 1, posterBoxLimit)
  })
  return {
    ...content, width, height,
    backgroundFrame: content.backgroundFrame && scaleImage(content.backgroundFrame),
    subject: scaleImage(content.subject),
    imageLayers: content.imageLayers.map(scaleImage),
    textLayers: content.textLayers.map(layer => ({ ...scaleBox(layer), fontSize: clamp(scale(layer.fontSize, Math.min(sx, sy)), 1, 1000) }))
  }
}

export function shiftPosterCanvas(content: PosterContent, width: number, height: number, anchor: CanvasAnchor): PosterContent {
  const offset = canvasResizeOffset(content, { width, height }, anchor)
  const clamp = (value: number) => Math.max(-posterCoordinateLimit, Math.min(posterCoordinateLimit, value))
  const translate = <T extends { x: number; y: number }>(layer: T): T => ({
    ...layer, x: clamp(layer.x + offset.x), y: clamp(layer.y + offset.y)
  })
  const { background } = content
  const backgroundFrame = background.type === 'image' || background.type === 'gradient'
    ? translate(content.backgroundFrame ?? { x: 0, y: 0, width: content.width, height: content.height })
    : undefined
  return {
    ...content, width, height, backgroundFrame, subject: translate(content.subject),
    textLayers: content.textLayers.map(translate), imageLayers: content.imageLayers.map(translate)
  }
}
