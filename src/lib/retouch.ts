import { z } from 'zod'
import type { ArtworkVersion } from '../types'

const strength = z.number().int().min(0).max(100)
const fraction = z.number().min(0).max(1)
const dressRegion = z.array(z.object({ x: fraction, y: fraction })).min(3).max(160).refine(points => {
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)
  return Math.abs(area) > 0.000002
}, '白纱选区需要有面积')

export const retouchInput = z.object({
  artworkId: z.string().trim().min(1).max(128),
  versionId: z.string().trim().min(1).max(128).optional(),
  smoothing: strength.default(45),
  brighten: z.number().int().min(0).max(30).default(0),
  underEyeShadows: strength.default(0).describe('减轻眼下阴影，保留眼睛和眼周纹理'),
  cheekTone: strength.default(0).describe('均匀两颊肤色色差，保留纹理和明暗'),
  dressHighlights: z.object({
    strength: strength.min(1),
    region: dressRegion.describe('沿白纱边缘圈选的多边形，x、y 相对于整张源图，取值 0–1')
  }).optional().describe('压低圈选白纱中的浅色高光'),
  faces: z.enum(['all', 'primary']).default('all'),
  faceRegion: z.object({ left: fraction, top: fraction, right: fraction, bottom: fraction })
    .refine(box => box.left < box.right && box.top < box.bottom, '选区的右侧和底部必须大于左侧和顶部').optional()
})

export type RetouchInput = z.input<typeof retouchInput>
export type RetouchOptions = Omit<z.output<typeof retouchInput>, 'artworkId' | 'versionId'>
export type RetouchResult = { version: ArtworkVersion; sourceVersionId: string; faceCount: number; width: number; height: number }
