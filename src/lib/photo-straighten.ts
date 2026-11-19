import { moveCrop, type CropAspect, type CropBox, type Size } from './photo-crop'

export const maxStraightenAngle = 45

export function cropFitsStraighten(box: CropBox, image: Size, angle = 0) {
  if (box.x < 0 || box.y < 0 || box.x + box.width > image.width || box.y + box.height > image.height) return false
  if (!angle) return true
  const radians = angle * Math.PI / 180
  const cos = Math.cos(radians), sin = Math.sin(radians)
  const x = box.x + (box.width - image.width) / 2
  const y = box.y + (box.height - image.height) / 2
  // Inset the rotated edges slightly to avoid transparent interpolation at the boundary.
  const inset = Math.min(0.5, Math.min(image.width, image.height) / 8)
  const halfWidth = (Math.abs(cos) * box.width + Math.abs(sin) * box.height) / 2
  const halfHeight = (Math.abs(sin) * box.width + Math.abs(cos) * box.height) / 2
  return Math.abs(cos * x + sin * y) + halfWidth <= image.width / 2 - inset + 1e-9
    && Math.abs(-sin * x + cos * y) + halfHeight <= image.height / 2 - inset + 1e-9
}

export function constrainStraightenedCrop(
  initial: CropBox, image: Size, angle: number, candidateAt: (fraction: number) => CropBox
): CropBox {
  const candidate = candidateAt(1)
  if (cropFitsStraighten(candidate, image, angle)) return candidate
  let low = 0, high = 1, valid = initial
  for (let step = 0; step < 26; step++) {
    const middle = (low + high) / 2
    const box = candidateAt(middle)
    if (cropFitsStraighten(box, image, angle)) {
      low = middle
      valid = box
    } else high = middle
  }
  return valid
}

export function fitStraightenedCrop(preferred: CropBox, image: Size, angle: number, aspect?: CropAspect): CropBox | undefined {
  if (cropFitsStraighten(preferred, image, angle)) return preferred
  const ratio = aspect && aspect !== 'original' ? aspect.split(':').map(Number) : undefined
  const atCenter = (scale: number) => {
    let width = Math.max(1, Math.round(preferred.width * scale))
    let height = Math.max(1, Math.round(preferred.height * scale))
    if (ratio) {
      const [w, h] = ratio
      const units = Math.max(1, Math.round(Math.min(preferred.width / w, preferred.height / h) * scale))
      width = w * units
      height = h * units
    }
    return { x: Math.round((image.width - width) / 2), y: Math.round((image.height - height) / 2), width, height }
  }
  const minimum = atCenter(0)
  if (!cropFitsStraighten(minimum, image, angle)) return undefined
  const centered = constrainStraightenedCrop(minimum, image, angle, atCenter)
  const dx = preferred.x + (preferred.width - centered.width) / 2 - centered.x
  const dy = preferred.y + (preferred.height - centered.height) / 2 - centered.y
  return constrainStraightenedCrop(centered, image, angle, fraction => moveCrop(centered, image, dx * fraction, dy * fraction))
}

export function horizonCorrection(start: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  return -Math.atan2(dx < 0 ? -dy : dy, Math.abs(dx)) * 180 / Math.PI
}
