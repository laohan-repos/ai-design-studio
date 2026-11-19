import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import type { PhotoFrame, PhotoMask, PhotoPoint, PhotoRegion, RenderPhotoOperation } from '../src/lib/photo-edits'
import type { PhotoColors } from '../src/lib/color-grade'
import { applyColorGrade, summarizePixels } from './color-grading'
import { drawSelectionMask } from './selection-mask'
import { goldenGrid, suggestGoldenCrops, type CropBox, type CropComposition, type CropPlacement } from '../src/lib/photo-crop'
import { cropFitsStraighten } from '../src/lib/photo-straighten'
import { canvasResizeOffset, photoSizeMaxPixels, type DocumentDimensions } from '../src/lib/document-size'

type PhotoImage = Image | Canvas
type Repair = Extract<RenderPhotoOperation, { type: 'heal' | 'clone' }>
type SizeOperation = Extract<RenderPhotoOperation, { type: 'resize' | 'canvas_size' }>
type PixelOperation = Exclude<RenderPhotoOperation, SizeOperation | { type: 'crop' }>
type Pixel = readonly [number, number, number]

export type PhotoWork = { bytes: Uint8Array; region?: PhotoRegion } & (
  { type: 'inspect' } | { type: 'mask'; mask: PhotoMask }
  | { type: 'preview' | 'render'; operations: RenderPhotoOperation[] }
)
export type PhotoWorkResult = PhotoFrame & { before?: Uint8Array; after: Uint8Array; cropBox?: CropBox; cropAngle?: number; outputSize?: DocumentDimensions }
export type PhotoColorWork = { type: 'colors'; bytes: Uint8Array; region?: PhotoRegion; samples: { label: string; region: PhotoRegion }[] }
export type PhotoCropWork = { type: 'crops'; bytes: Uint8Array; composition: CropComposition }
export type PhotoCropWorkResult = { imageWidth: number; imageHeight: number;
  candidates: (CropPlacement & { overlay: Uint8Array; preview: Uint8Array })[] }

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

function isPixelOperation(operation: RenderPhotoOperation): operation is PixelOperation {
  return operation.type !== 'crop' && operation.type !== 'resize' && operation.type !== 'canvas_size'
}

function ramp(value: number, start: number, end: number) {
  const t = clamp((value - start) / (end - start))
  return t * t * (3 - 2 * t)
}

function photoFrame(image: PhotoImage, region?: PhotoRegion, fullSize = false): PhotoFrame {
  const { width: imageWidth, height: imageHeight } = image
  const x = region ? Math.min(imageWidth - 1, Math.floor(region.x * imageWidth)) : 0
  const y = region ? Math.min(imageHeight - 1, Math.floor(region.y * imageHeight)) : 0
  const right = region ? Math.min(imageWidth, Math.ceil((region.x + region.width) * imageWidth)) : imageWidth
  const bottom = region ? Math.min(imageHeight, Math.ceil((region.y + region.height) * imageHeight)) : imageHeight
  return frameForBox(image, { x, y, width: right - x, height: bottom - y }, fullSize ? Infinity : region ? 1400 : 960)
}

function frameForBox(image: PhotoImage, crop: CropBox, limit: number): PhotoFrame {
  const { width: imageWidth, height: imageHeight } = image
  const scale = Math.min(1, limit / Math.max(crop.width, crop.height))
  return { imageWidth, imageHeight, crop, width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)) }
}

function cropOverlay(image: PhotoImage, box: CropBox, limit: number, angle = 0) {
  const frame = frameForBox(image, { x: 0, y: 0, width: image.width, height: image.height }, limit)
  const context = createCanvas(frame.width, frame.height).getContext('2d')
  drawFrame(context, image, frame, angle)
  const left = box.x * frame.width / image.width
  const top = box.y * frame.height / image.height
  const width = box.width * frame.width / image.width
  const height = box.height * frame.height / image.height
  const right = left + width, bottom = top + height
  context.fillStyle = 'rgba(15,23,42,0.56)'
  context.fillRect(0, 0, frame.width, top)
  context.fillRect(0, bottom, frame.width, frame.height - bottom)
  context.fillRect(0, top, left, height)
  context.fillRect(right, top, frame.width - right, height)
  context.strokeStyle = 'rgba(255,255,255,0.86)'
  context.lineWidth = 1.5
  context.strokeRect(left, top, width, height)
  context.strokeStyle = 'rgba(255,255,255,0.62)'
  context.lineWidth = 1
  context.beginPath()
  for (const fraction of goldenGrid) {
    context.moveTo(left + width * fraction, top)
    context.lineTo(left + width * fraction, bottom)
    context.moveTo(left, top + height * fraction)
    context.lineTo(right, top + height * fraction)
  }
  context.stroke()
  return context.canvas
}

function cropImage(image: PhotoImage, box: CropBox, limit: number, angle = 0) {
  const frame = frameForBox(image, box, limit)
  const context = createCanvas(frame.width, frame.height).getContext('2d')
  drawFrame(context, image, frame, angle)
  return context.canvas
}

function drawFrame(context: SKRSContext2D, image: PhotoImage, frame: PhotoFrame, angle = 0) {
  const { x, y, width, height } = frame.crop
  if (angle) {
    const cx = image.width / 2, cy = image.height / 2
    context.save()
    context.scale(frame.width / width, frame.height / height)
    context.translate(cx - x, cy - y)
    context.rotate(angle * Math.PI / 180)
    context.drawImage(image, -cx, -cy)
    context.restore()
    return
  }
  context.drawImage(image, x, y, width, height, 0, 0, frame.width, frame.height)
}

function sizeImage(image: PhotoImage, operation: SizeOperation, limit: number) {
  const { width, height } = operation
  if (width * height > photoSizeMaxPixels) throw new Error('调整后的图像不能超过 3200 万像素')
  const scale = Math.min(1, limit / Math.max(width, height))
  const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.scale(canvas.width / width, canvas.height / height)
  if (operation.type === 'resize') context.drawImage(image, 0, 0, width, height)
  else {
    const offset = canvasResizeOffset(image, operation, operation.anchor)
    context.drawImage(image, offset.x, offset.y)
  }
  return canvas
}

function adjustTone(data: Uint8ClampedArray, operation: Extract<RenderPhotoOperation, { type: 'tone' }>, mask?: Uint8ClampedArray) {
  const exposure = 2 ** (operation.exposure ?? 0)
  const contrast = 1 + (operation.contrast ?? 0) * 0.005
  const shadows = (operation.shadows ?? 0) * 0.48
  const highlights = (operation.highlights ?? 0) * 0.46
  const temperature = (operation.temperature ?? 0) * 0.30
  const tint = (operation.tint ?? 0) * 0.18
  const saturation = 1 + (operation.saturation ?? 0) * 0.01
  const redness = (operation.redness ?? 0) * 0.30
  for (let i = 0; i < data.length; i += 4) {
    const weight = mask ? mask[i + 3] / 255 : 1
    if (!weight || !data[i + 3]) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const light = luma(r, g, b)
    const shadowWeight = ramp(light, 0, 64) * (1 - ramp(light, 72, 181))
    const highlightWeight = ramp(light, 147, 248)
    const nextLight = (light * exposure - 127.5) * contrast + 127.5 + shadows * shadowWeight + highlights * highlightWeight
    const reduceRed = redness * ramp(r - g, 6, 48) * ramp(light, 40, 125)
    data[i] = r + (nextLight + (r - light) * saturation + temperature + tint * 0.44 - reduceRed - r) * weight
    data[i + 1] = g + (nextLight + (g - light) * saturation - tint + reduceRed * 0.51 - g) * weight
    data[i + 2] = b + (nextLight + (b - light) * saturation - temperature + tint * 0.44 - b) * weight
  }
}

function adjustTexture(context: SKRSContext2D, data: Uint8ClampedArray, amount: number, mask?: Uint8ClampedArray) {
  if (!amount) return
  const { width, height } = context.canvas
  const guide = createCanvas(width, height).getContext('2d')
  guide.filter = `blur(${clamp(Math.min(width, height) * 0.003, 1.2, 8)}px)`
  guide.drawImage(context.canvas, 0, 0)
  const blurred = guide.getImageData(0, 0, width, height).data
  for (let i = 0; i < data.length; i += 4) {
    const weight = mask ? mask[i + 3] / 255 : 1
    if (!weight || !data[i + 3] || !blurred[i + 3]) continue
    const details = luma(data[i], data[i + 1], data[i + 2]) - luma(blurred[i], blurred[i + 1], blurred[i + 2])
    const change = clamp(details, -32, 32) * amount * 0.007 * weight
    data[i] += change
    data[i + 1] += change
    data[i + 2] += change
  }
}

function repairSpot(data: Uint8ClampedArray, width: number, height: number, operation: Repair) {
  const toPixel = ({ x, y }: PhotoPoint) => ({ x: Math.round(x * (width - 1)), y: Math.round(y * (height - 1)) })
  const radius = Math.max(1, Math.round(operation.radius * Math.min(width, height)))
  const target = toPixel(operation.target)
  const indexOf = (x: number, y: number) => (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4
  const ringSamples = (point: PhotoPoint): Pixel => {
    const sum = [0, 0, 0]
    let count = 0
    for (let angle = 0; angle < 12; angle++) {
      const rad = angle / 6 * Math.PI
      const i = indexOf(Math.round(point.x + Math.cos(rad) * radius), Math.round(point.y + Math.sin(rad) * radius))
      if (data[i + 3] < 128) continue
      for (let channel = 0; channel < 3; channel++) sum[channel] += data[i + channel]
      count++
    }
    return [sum[0] / Math.max(1, count), sum[1] / Math.max(1, count), sum[2] / Math.max(1, count)]
  }
  const targetColor = ringSamples(target)
  let source = operation.source && toPixel(operation.source)
  if (!source) {
    let best = Infinity
    for (let angle = 0; angle < 8; angle++) {
      const rad = angle / 4 * Math.PI
      const x = Math.round(target.x + Math.cos(rad) * radius * 2.5)
      const y = Math.round(target.y + Math.sin(rad) * radius * 2.5)
      if (x < radius || y < radius || x >= width - radius || y >= height - radius || data[indexOf(x, y) + 3] < 128) continue
      const color = ringSamples({ x, y })
      const distance = Math.hypot(color[0] - targetColor[0], color[1] - targetColor[1], color[2] - targetColor[2])
      if (distance < best) { best = distance; source = { x, y } }
    }
  }
  if (!source) throw new Error('附近没有可用的取样位置，请指定取样点或缩小笔刷')
  const sourceColor = ringSamples(source)
  const correction = targetColor.map((value, channel) => operation.type === 'heal' ? clamp(value - sourceColor[channel], -48, 48) : 0)
  const diameter = radius * 2 + 1
  const samples = new Uint8ClampedArray(diameter * diameter * 4)
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const from = indexOf(source.x + x, source.y + y)
      samples.set(data.subarray(from, from + 4), ((y + radius) * diameter + x + radius) * 4)
    }
  }
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const column = target.x + x, row = target.y + y
      if (column < 0 || column >= width || row < 0 || row >= height) continue
      const blend = (1 - ramp(Math.hypot(x, y) / radius, 0.38, 1)) * operation.strength * 0.01
      if (!blend) continue
      const from = ((y + radius) * diameter + x + radius) * 4
      const to = indexOf(column, row)
      if (!samples[from + 3] || !data[to + 3]) continue
      for (let channel = 0; channel < 3; channel++) {
        data[to + channel] += (clamp(samples[from + channel] + correction[channel], 0, 255) - data[to + channel]) * blend
      }
    }
  }
}

function editPhoto(image: Image, operations: PixelOperation[]) {
  const { width, height } = image
  const context = createCanvas(width, height).getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, width, height)
  for (const operation of operations) {
    if (operation.type === 'heal' || operation.type === 'clone') {
      repairSpot(pixels.data, width, height, operation)
    } else {
      const mask = operation.mask && drawSelectionMask(width, height, operation.mask).getContext('2d').getImageData(0, 0, width, height).data
      if (operation.type === 'tone') adjustTone(pixels.data, operation, mask)
      else if (operation.type === 'grade') applyColorGrade(pixels.data, operation.settings, mask)
      else {
        context.putImageData(pixels, 0, 0)
        adjustTexture(context, pixels.data, operation.amount, mask)
      }
    }
  }
  context.putImageData(pixels, 0, 0)
  return context.canvas
}

export async function renderPhotoWork(work: PhotoWork): Promise<PhotoWorkResult> {
  const image = await loadImage(Buffer.from(work.bytes))
  if (image.width * image.height > 32_000_000) throw new Error('照片超过 3200 万像素，请缩小后重试')
  const frame = photoFrame(image, work.type === 'render' ? undefined : work.region, work.type === 'render')

  if (work.type === 'preview' || work.type === 'render') {
    const crop = work.operations.find(operation => operation.type === 'crop')
    const pixels = work.operations.filter(isPixelOperation)
    if (crop) {
      const { box: cropBox, angle } = crop
      if (!cropFitsStraighten(cropBox, image, angle)) {
        throw new Error(angle ? '裁剪框超出旋转后的图像范围，请缩小裁剪框' : '裁剪框超出源图尺寸，请重新选择区域')
      }
      const edited = pixels.length ? editPhoto(image, pixels) : image
      const cropped = cropImage(edited, cropBox, work.type === 'render' ? Infinity : 960, angle)
      const after = await cropped.encode('png')
      const before = work.type === 'preview' ? await cropOverlay(image, cropBox, 960, angle).encode('png') : undefined
      return { ...frame, before, after, cropBox, ...(angle && { cropAngle: angle }) }
    }
    const size = work.operations.find(operation => operation.type === 'resize' || operation.type === 'canvas_size')
    if (size) {
      const edited = pixels.length ? editPhoto(image, pixels) : image
      const output = sizeImage(edited, size, work.type === 'render' ? Infinity : 960)
      const before = work.type === 'preview' ? await cropImage(image, frame.crop, 960).encode('png') : undefined
      return { ...frame, before, after: await output.encode('png'), outputSize: { width: size.width, height: size.height } }
    }
    if (work.type === 'render') return { ...frame, after: await editPhoto(image, pixels).encode('png') }
  }

  const display = createCanvas(frame.width, frame.height).getContext('2d')
  drawFrame(display, image, frame)
  if (work.type === 'inspect') return { ...frame, after: await display.canvas.encode('png') }
  if (work.type === 'mask') {
    const mask = drawSelectionMask(image.width, image.height, work.mask).getContext('2d')
    mask.filter = 'none'
    mask.globalCompositeOperation = 'source-in'
    mask.fillStyle = '#7c3aed'
    mask.fillRect(0, 0, image.width, image.height)
    display.globalAlpha = 0.44
    drawFrame(display, mask.canvas, frame)
    return { ...frame, after: await display.canvas.encode('png') }
  }
  const before = await display.canvas.encode('png')
  display.clearRect(0, 0, frame.width, frame.height)
  drawFrame(display, editPhoto(image, work.operations.filter(isPixelOperation)), frame)
  return { ...frame, before, after: await display.canvas.encode('png') }
}

export async function renderCropSuggestions(work: PhotoCropWork): Promise<PhotoCropWorkResult> {
  const image = await loadImage(Buffer.from(work.bytes))
  if (image.width * image.height > 32_000_000) throw new Error('照片超过 3200 万像素，请缩小后重试')
  const suggestions = suggestGoldenCrops(image, work.composition)
  const candidates: PhotoCropWorkResult['candidates'] = []
  for (const crop of suggestions) {
    candidates.push({ ...crop, overlay: await cropOverlay(image, crop.box, 720).encode('png'),
      preview: await cropImage(image, crop.box, 720).encode('png') })
  }
  return { imageWidth: image.width, imageHeight: image.height, candidates }
}

export async function inspectPhotoColors(work: PhotoColorWork): Promise<PhotoColors> {
  const image = await loadImage(Buffer.from(work.bytes))
  if (image.width * image.height > 32_000_000) throw new Error('照片超过 3200 万像素，请缩小后重试')
  const sample = (region?: PhotoRegion) => {
    const frame = photoFrame(image, region)
    const scale = Math.min(1, 640 / Math.max(frame.width, frame.height))
    frame.width = Math.max(1, Math.round(frame.width * scale))
    frame.height = Math.max(1, Math.round(frame.height * scale))
    const context = createCanvas(frame.width, frame.height).getContext('2d')
    drawFrame(context, image, frame)
    return context.getImageData(0, 0, frame.width, frame.height).data
  }
  const histogram: PhotoColors['histogram'] = {
    luminance: Array(32).fill(0), red: Array(32).fill(0), green: Array(32).fill(0), blue: Array(32).fill(0)
  }
  return { imageWidth: image.width, imageHeight: image.height, histogram,
    summary: summarizePixels(sample(work.region), histogram),
    samples: work.samples.map(({ label, region }) => ({ label, ...summarizePixels(sample(region)) })) }
}
