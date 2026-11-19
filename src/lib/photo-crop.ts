import type { PhotoPoint, PhotoRegion } from './photo-edits'

export const cropAspects = ['original', '1:1', '3:2', '2:3', '4:5', '16:9', '9:16'] as const
export type CropAspect = typeof cropAspects[number]
export type Size = { width: number; height: number }
export type CropBox = Size & { x: number; y: number }
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se'
type Ratio = Size & { exact: boolean }
export type CropComposition = {
  aspect: CropAspect
  focus?: PhotoPoint
  keep?: PhotoRegion[]
  horizon?: { y: number; placement?: 'top' | 'bottom' | 'auto' }
  count?: number
}
export type CropPlacement = { box: CropBox; retainedPercent: number; focus?: PhotoPoint; horizon?: number }
export type CropSuggestion = CropPlacement & { overlay: string; preview: string }
export type SuggestedPhotoCrops = { artworkId: string; versionId: string; imageWidth: number; imageHeight: number; candidates: CropSuggestion[] }

export const goldenGrid = [(3 - Math.sqrt(5)) / 2, (Math.sqrt(5) - 1) / 2] as const
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function ratioFor(aspect: CropAspect, image: Size): Ratio {
  if (aspect === 'original') return { ...image, exact: false }
  const [width, height] = aspect.split(':').map(Number)
  return { width, height, exact: true }
}

function fitRatio(bounds: Size, ratio: Ratio, scale = 1): Size | undefined {
  const max = Math.min(bounds.width / ratio.width, bounds.height / ratio.height)
  const factor = ratio.exact ? Math.floor(max * scale + 1e-9) : max * scale
  const width = Math.min(bounds.width, Math.round(ratio.width * factor))
  const height = Math.min(bounds.height, Math.round(ratio.height * factor))
  return width > 0 && height > 0 ? { width, height } : undefined
}

export function cropAspectMatches(box: Size, image: Size, aspect: CropAspect) {
  const ratio = ratioFor(aspect, image)
  const delta = Math.abs(box.width * ratio.height - box.height * ratio.width)
  return ratio.exact ? delta === 0 : delta <= Math.max(ratio.width, ratio.height)
}

export function moveCrop(box: CropBox, image: Size, dx: number, dy: number): CropBox {
  return { ...box, x: clamp(Math.round(box.x + dx), 0, image.width - box.width), y: clamp(Math.round(box.y + dy), 0, image.height - box.height) }
}

export function fitCrop(image: Size, aspect: CropAspect, center = { x: image.width / 2, y: image.height / 2 }): CropBox | undefined {
  const size = fitRatio(image, ratioFor(aspect, image))
  return size && moveCrop({ ...size, x: 0, y: 0 }, image, center.x - size.width / 2, center.y - size.height / 2)
}

export function resizeCrop(box: CropBox, image: Size, corner: CropCorner, point: PhotoPoint, aspect?: CropAspect): CropBox {
  const east = corner.endsWith('e'), south = corner.startsWith('s')
  const anchorX = east ? box.x : box.x + box.width
  const anchorY = south ? box.y : box.y + box.height
  const maxWidth = east ? image.width - anchorX : anchorX
  const maxHeight = south ? image.height - anchorY : anchorY
  const dx = clamp((point.x - anchorX) * (east ? 1 : -1), 0, maxWidth)
  const dy = clamp((point.y - anchorY) * (south ? 1 : -1), 0, maxHeight)
  let width = Math.max(1, Math.round(dx)), height = Math.max(1, Math.round(dy))
  if (aspect) {
    const ratio = ratioFor(aspect, image)
    const r = ratio.width / ratio.height
    const distance = (dx * r + dy) / (r * r + 1)
    if (ratio.exact) {
      const max = Math.min(Math.floor(maxWidth / ratio.width), Math.floor(maxHeight / ratio.height))
      if (!max) return box
      const units = clamp(Math.round(distance / ratio.height), 1, max)
      width = ratio.width * units
      height = ratio.height * units
    } else {
      const max = Math.min(maxWidth / r, maxHeight)
      const h = clamp(distance, Math.min(max, Math.max(1, 1 / r)), max)
      width = clamp(Math.round(h * r), 1, maxWidth)
      height = clamp(Math.round(h), 1, maxHeight)
    }
  }
  return { x: east ? anchorX : anchorX - width, y: south ? anchorY : anchorY - height, width, height }
}

function overlap(a: CropBox, b: CropBox) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height / (a.width * a.height + b.width * b.height - width * height)
}

export function suggestGoldenCrops(image: Size, options: CropComposition): CropPlacement[] {
  const { focus, horizon } = options
  const protectedRegions = options.keep ?? []
  const required = { left: image.width, top: image.height, right: 0, bottom: 0 }
  for (const box of protectedRegions) {
    required.left = Math.min(required.left, Math.floor(box.x * image.width + 1e-8))
    required.top = Math.min(required.top, Math.floor(box.y * image.height + 1e-8))
    required.right = Math.max(required.right, Math.ceil((box.x + box.width) * image.width - 1e-8))
    required.bottom = Math.max(required.bottom, Math.ceil((box.y + box.height) * image.height - 1e-8))
  }
  if (focus) {
    required.left = Math.min(required.left, Math.floor(focus.x * image.width))
    required.top = Math.min(required.top, Math.floor(focus.y * image.height))
    required.right = Math.max(required.right, Math.ceil(focus.x * image.width))
    required.bottom = Math.max(required.bottom, Math.ceil(focus.y * image.height))
  }
  if (horizon) {
    required.top = Math.min(required.top, Math.floor(horizon.y * image.height))
    required.bottom = Math.max(required.bottom, Math.ceil(horizon.y * image.height))
  }

  const ratio = ratioFor(options.aspect, image)
  const placements: (CropPlacement & { score: number })[] = []
  const scales = focus || horizon ? [1, .96, .92, .87, .81, .74, .67, .59] : [1]
  const focusTargets = focus ? goldenGrid.flatMap(x => goldenGrid.map(y => ({ x, y }))) : [{ x: .5, y: .5 }]
  const horizonTargets = horizon?.placement === 'top' ? [goldenGrid[0]] : horizon?.placement === 'bottom' ? [goldenGrid[1]] : goldenGrid
  for (const scale of scales) {
    const size = fitRatio(image, ratio, scale)
    if (!size) continue
    const { width, height } = size
    const minX = Math.max(0, required.right - width), maxX = Math.min(image.width - width, required.left)
    const minY = Math.max(0, required.bottom - height), maxY = Math.min(image.height - height, required.top)
    if (minX > maxX || minY > maxY) continue
    for (const anchor of focusTargets) {
      for (const line of horizon ? horizonTargets : [.5]) {
        const centerX = (image.width - width) / 2, centerY = (image.height - height) / 2
        const xGoal = focus ? focus.x * image.width - anchor.x * width : centerX
        const yGoal = focus ? focus.y * image.height - anchor.y * height : centerY
        const lineGoal = horizon ? horizon.y * image.height - line * height : yGoal
        const yWeighted = horizon ? focus ? .56 * yGoal + .44 * lineGoal : lineGoal : yGoal
        const x = clamp(Math.round(xGoal), minX, maxX), y = clamp(Math.round(yWeighted), minY, maxY)
        const box = { x, y, width, height }
        const focal = focus && { x: (focus.x * image.width - x) / width, y: (focus.y * image.height - y) / height }
        const lineY = horizon && (horizon.y * image.height - y) / height
        const focusError = focal ? Math.hypot(focal.x - anchor.x, focal.y - anchor.y) : 0
        const lineError = lineY === undefined ? 0 : Math.abs(lineY - line)
        const sizeCost = (1 - scale * scale) * .13
        const outsideCenter = Math.hypot((x - centerX) / image.width, (y - centerY) / image.height) * .035
        placements.push({ box, focus: focal, horizon: lineY, retainedPercent: Math.round(1000 * width * height / (image.width * image.height)) / 10,
          score: focusError * .75 + lineError * .53 + sizeCost + outsideCenter })
      }
    }
  }

  const results: CropPlacement[] = []
  for (const { score: _, ...candidate } of placements.sort((a, b) => a.score - b.score)) {
    if (results.some(item => overlap(item.box, candidate.box) >= .90)) continue
    results.push(candidate)
    if (results.length >= (options.count ?? 2)) break
  }
  return results
}
