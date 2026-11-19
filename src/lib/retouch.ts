import { z } from 'zod'
import type { ArtworkVersion } from '../types'

export const retouchInput = z.object({
  artworkId: z.string().trim().min(1).max(128),
  versionId: z.string().trim().min(1).max(128).optional(),
  smoothing: z.number().int().min(0).max(100).default(45),
  brighten: z.number().int().min(0).max(30).default(0),
  faces: z.enum(['all', 'primary']).default('all'),
  faceRegion: z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) })
    .refine(box => box.left < box.right && box.top < box.bottom, '选区的右侧和底部必须大于左侧和顶部').optional()
})

export type RetouchInput = z.input<typeof retouchInput>
export type RetouchOptions = Omit<z.output<typeof retouchInput>, 'artworkId' | 'versionId'>
export type RetouchResult = { version: ArtworkVersion; sourceVersionId: string; faceCount: number; width: number; height: number }
