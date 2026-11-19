import { z } from 'zod'
import { photoMask, photoPoint } from './photo-edits'
import { posterId, posterMaskPreviewInput } from './poster'
import { posterPixelMaxRadius, posterPixelMinRadius, posterPixelStrokePointLimit } from './poster-limits'

export const posterPixelInput = posterMaskPreviewInput

const stroke = {
  radius: z.number().min(posterPixelMinRadius).max(posterPixelMaxRadius),
  opacity: z.number().positive().max(1),
  points: z.array(photoPoint).min(1).max(posterPixelStrokePointLimit)
}

export const posterPixelStroke = z.discriminatedUnion('type', [
  z.object({ type: z.literal('brush'), ...stroke, color: z.string().regex(/^#[0-9a-f]{6}$/i, '颜色须使用 #RRGGBB') }),
  z.object({ type: z.literal('eraser'), ...stroke }),
  z.object({ type: z.literal('clone'), ...stroke, source: photoPoint })
])

export const posterPixelPaintInput = posterPixelInput.extend({ stroke: posterPixelStroke })

export const posterRegionInput = z.discriminatedUnion('mode', [
  posterPixelInput.extend({ mode: z.literal('remove'), selection: photoMask }),
  posterPixelInput.extend({ mode: z.literal('redraw'), selection: photoMask, prompt: z.string().trim().min(1).max(4000), modelId: posterId })
])

export type PosterPixelStroke = z.input<typeof posterPixelStroke>
export type PosterPixelInput = z.input<typeof posterPixelInput>
export type PosterPixelPaintInput = z.input<typeof posterPixelPaintInput>
export type PosterPixelView = { src: string; width: number; height: number; revision: number }
export type PosterRegionInput = z.input<typeof posterRegionInput>
export type PosterRegionPreview = PosterPixelView & { draftId: string }
export type PosterPixelRect = { x: number; y: number; width: number; height: number }

export type PosterPixelLayer = {
  width: number
  height: number
  // Map tile origins ("x,y" in source pixels) to immutable PNG IDs.
  tiles: Record<string, string>
}

export type PosterPixelTileWrite = { id: string; bytes: Uint8Array }
