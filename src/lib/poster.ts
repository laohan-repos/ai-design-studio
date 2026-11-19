import { z } from 'zod'

export const posterId = z.string().trim().min(1).max(128)
const color = z.string().regex(/^#[0-9a-f]{6}$/i, '颜色须使用 #RRGGBB')
const dimension = z.number().int().min(64).max(4096)
const boxDimension = z.number().int().min(1).max(8192)
const coordinate = z.number().int().min(-8192).max(8192)
const fraction = z.number().min(0).max(1)
const point = z.object({ x: fraction, y: fraction })

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

export const posterSubject = z.object({
  x: coordinate, y: coordinate, width: boxDimension, height: boxDimension,
  rotation: z.number().min(-180).max(180), opacity: fraction,
  brightness: z.number().int().min(0).max(200), saturation: z.number().int().min(0).max(200), visible: z.boolean()
})

export const posterText = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  text: z.string().max(300).refine(value => Boolean(value.trim()), '文字不能为空'),
  x: coordinate, y: coordinate, width: boxDimension, fontSize: z.number().int().min(1).max(1000),
  color, weight: z.enum(['regular', 'bold']), align: z.enum(['left', 'center', 'right']), visible: z.boolean()
})

const shadow = z.object({ visible: z.boolean(), opacity: fraction, color })

export const posterOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_size'), width: dimension, height: dimension }),
  z.object({ op: z.literal('set_background'), background: posterBackground }),
  z.object({ op: z.literal('set_mask'), mask: posterMask }),
  z.object({ op: z.literal('set_subject'), subject: posterSubject.partial() }),
  z.object({ op: z.literal('set_shadow'), shadow: shadow.partial() }),
  z.object({ op: z.literal('upsert_text'), layer: posterText }),
  z.object({ op: z.literal('remove_text'), layerId: posterText.shape.id })
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

export type PosterOperation = z.infer<typeof posterOperation>
export type PosterOutput = z.output<typeof posterOutput>
export type PosterText = z.infer<typeof posterText>
export type PosterPoint = z.infer<typeof point>
export type PosterMask = z.infer<typeof posterMask>

export type PosterContent = {
  width: number
  height: number
  background: z.infer<typeof posterBackground>
  subject: z.infer<typeof posterSubject>
  mask: PosterMask
  shadow: z.infer<typeof shadow>
  textLayers: PosterText[]
}

export type PosterDocument = PosterContent & {
  artworkId: string
  sourceVersionId: string
  revision: number
  canUndo: boolean
}

export type PosterImage = { src: string; width: number; height: number; revision: number }

export const posterSizes = { square: { width: 1080, height: 1080 }, portrait: { width: 1080, height: 1620 } } as const

export function resizePoster(content: PosterContent, width: number, height: number): PosterContent {
  const sx = width / content.width
  const sy = height / content.height
  const scale = (value: number, ratio: number) => Math.round(value * ratio)
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const scaleBox = <T extends { x: number; y: number; width: number }>(box: T): T => ({
    ...box, x: clamp(scale(box.x, sx), -8192, 8192), y: clamp(scale(box.y, sy), -8192, 8192),
    width: clamp(scale(box.width, sx), 1, 8192)
  })
  return {
    ...content, width, height,
    subject: { ...scaleBox(content.subject), height: clamp(scale(content.subject.height, sy), 1, 8192) },
    textLayers: content.textLayers.map(layer => ({ ...scaleBox(layer), fontSize: clamp(scale(layer.fontSize, Math.min(sx, sy)), 1, 1000) }))
  }
}
