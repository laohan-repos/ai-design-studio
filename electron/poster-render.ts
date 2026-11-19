import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import type { PosterBox, PosterContent, PosterImageLayer, PosterLayerMask, PosterMask, PosterText } from '../src/lib/poster'
import { drawNormalizedBrush, drawSelectionMask } from './selection-mask'

const maxSubjectMaskSide = 2048
const maxLayerMaskSide = 4096
type SourceImage = Image | Canvas
type RenderSource = Buffer | Canvas

function removeEdgeBackground(rgba: Uint8ClampedArray, width: number, height: number, mask: Extract<PosterMask, { type: 'edge_color' }>) {
  const last = width * height - 1
  const corners = [0, width - 1, last - width + 1, last]
  const channels = [0, 1, 2].map(channel => {
    if (mask.color) return Number.parseInt(mask.color.slice(channel * 2 + 1, channel * 2 + 3), 16)
    const samples = corners.map(pixel => rgba[pixel * 4 + channel]).sort((a, b) => a - b)
    return (samples[1] + samples[2]) / 2
  })
  const limit = mask.tolerance ** 2 * 3
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  const visit = (pixel: number) => {
    if (visited[pixel]) return
    visited[pixel] = 1
    const i = pixel * 4
    const distance = (rgba[i] - channels[0]) ** 2 + (rgba[i + 1] - channels[1]) ** 2 + (rgba[i + 2] - channels[2]) ** 2
    if (rgba[i + 3] && distance > limit) return
    rgba[i + 3] = 0
    queue[tail++] = pixel
  }
  for (let x = 0; x < width; x++) { visit(x); visit(x + width * (height - 1)) }
  for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1) }
  while (head < tail) {
    const pixel = queue[head++]
    const x = pixel % width
    if (x > 0) visit(pixel - 1)
    if (x < width - 1) visit(pixel + 1)
    if (pixel >= width) visit(pixel - width)
    if (pixel + width <= last) visit(pixel + width)
  }
  return queue.subarray(0, tail)
}

async function loadPosterImage(bytes: Buffer) {
  const image = await loadImage(bytes)
  if (!image.width || !image.height) throw new Error('无法读取原图，请使用 PNG、JPEG 或 WebP')
  return image
}

function loadRenderSource(source: RenderSource) {
  return Buffer.isBuffer(source) ? loadPosterImage(source) : source
}

function sourceCanvas(image: SourceImage, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  return createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
}

function rasterize(image: SourceImage, maxSide: number) {
  const canvas = sourceCanvas(image, maxSide)
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

function legacyLayerMask(source: Canvas, mask: PosterMask) {
  const { width, height } = source
  if (mask.type === 'polygon') {
    return drawSelectionMask(width, height, { include: [{ type: 'polygon', points: mask.points }], feather: 0 })
  }
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  if (mask.type === 'edge_color') {
    const pixels = source.getContext('2d').getImageData(0, 0, width, height).data
    const removed = removeEdgeBackground(pixels, width, height, mask)
    const alpha = context.createImageData(width, height)
    for (let i = 3; i < alpha.data.length; i += 4) alpha.data[i] = 255
    for (const pixel of removed) alpha.data[pixel * 4 + 3] = 0
    context.putImageData(alpha, 0, 0)
  } else context.fillRect(0, 0, width, height)
  return canvas
}

function renderLayerMask(source: Canvas, layerMask?: PosterLayerMask) {
  const { base, strokes } = layerMask ?? { base: { type: 'reveal' }, strokes: [] } as const
  const { width, height } = source
  const canvas = base.type === 'selection' ? drawSelectionMask(width, height, base.selection)
    : legacyLayerMask(source, base.type === 'legacy' ? base.mask : { type: 'none' })
  const context = canvas.getContext('2d')
  context.save()
  for (const { mode, points, radius } of strokes) {
    context.globalCompositeOperation = mode === 'hide' ? 'destination-out' : 'source-over'
    drawNormalizedBrush(context, points, radius)
  }
  context.restore()
  return canvas
}

function applyLayerMask(image: SourceImage, mask: PosterLayerMask | undefined, maxSide = maxLayerMaskSide, original = image): SourceImage {
  if (!mask || (mask.base.type === 'reveal' && !mask.strokes.length)) return image
  const source = rasterize(image, maxSide)
  const anchor = mask.base.type === 'legacy' && mask.base.mask.type === 'edge_color' && original !== image
    ? rasterize(original, maxSide)
    : source
  const alpha = renderLayerMask(anchor, mask)
  const context = source.getContext('2d')
  context.globalCompositeOperation = 'destination-in'
  context.drawImage(alpha, 0, 0)
  return source
}

export async function prepareSubject(bytes: Buffer, mask: PosterMask, layerMask?: PosterLayerMask, edited?: Canvas) {
  const image = await loadPosterImage(bytes)
  const canvas = sourceCanvas(image, maxSubjectMaskSide)
  const { width, height } = canvas
  const context = canvas.getContext('2d')
  if (mask.type === 'polygon') {
    context.beginPath()
    mask.points.forEach(({ x, y }, index) => {
      if (index === 0) context.moveTo(x * width, y * height)
      else context.lineTo(x * width, y * height)
    })
    context.closePath()
    context.clip()
  }
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height)
  if (mask.type === 'edge_color') {
    removeEdgeBackground(pixels.data, width, height, mask)
    context.putImageData(pixels, 0, 0)
  }
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels.data[(y * width + x) * 4 + 3]) continue
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
  if (right < 0 && mask.type !== 'none') throw new Error('蒙版没有保留主体，请减小容差或改用手动描边')
  const bounds = right < 0
    ? { x: 0, y: 0, width, height }
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
  const effectiveMask: PosterLayerMask | undefined = layerMask ?? (mask.type === 'none' ? undefined : { base: { type: 'legacy', mask }, strokes: [] })
  const fullSource = Boolean(layerMask || edited)
  const source = fullSource ? applyLayerMask(edited ?? image, effectiveMask, maxSubjectMaskSide, image) : canvas
  return { source, bounds, fullSource, sourceWidth: width, sourceHeight: height }
}

export type PreparedSubject = Awaited<ReturnType<typeof prepareSubject>>

function drawContactShadow(context: SKRSContext2D, rect: PosterBox, shadow: PosterContent['shadow']) {
  context.save()
  context.globalAlpha = shadow.opacity
  context.translate(rect.x + rect.width / 2, rect.y + rect.height * 0.98)
  context.scale(rect.width * 0.62, Math.max(2, rect.height * 0.065))
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1)
  gradient.addColorStop(0, shadow.color)
  gradient.addColorStop(1, `${shadow.color}00`)
  context.fillStyle = gradient
  context.fillRect(-1, -1, 2, 2)
  context.restore()
}

function drawText(context: SKRSContext2D, layer: PosterText) {
  context.font = `${layer.weight === 'bold' ? 700 : 400} ${layer.fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
  context.fillStyle = layer.color
  context.textBaseline = 'top'
  context.textAlign = layer.align
  const inset = layer.align === 'center' ? layer.width / 2 : layer.align === 'right' ? layer.width : 0
  const lineHeight = layer.fontSize * 1.22
  let y = layer.y
  for (const paragraph of layer.text.split('\n')) {
    let line = ''
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > layer.width) {
        context.fillText(line, layer.x + inset, y)
        line = ''
        y += lineHeight
      }
      line += character
    }
    context.fillText(line, layer.x + inset, y)
    y += lineHeight
  }
}

function rotateLayer(context: SKRSContext2D, box: PosterBox, rotation: number) {
  if (!rotation) return
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  context.translate(centerX, centerY)
  context.rotate(rotation * Math.PI / 180)
  context.translate(-centerX, -centerY)
}

function drawSubject(context: SKRSContext2D, content: PosterContent, { source, bounds, fullSource, sourceWidth, sourceHeight }: PreparedSubject): PosterBox {
  const { subject, shadow } = content
  const sx = subject.width / bounds.width
  const sy = subject.height / bounds.height
  const fit = Math.min(sx, sy)
  const scaleX = subject.stretch ? sx : fit
  const scaleY = subject.stretch ? sy : fit
  const width = subject.stretch ? subject.width : bounds.width * fit
  const height = subject.stretch ? subject.height : bounds.height * fit
  const rect = { x: subject.x + (subject.width - width) / 2, y: subject.y + subject.height - height, width, height }
  if (!subject.opacity) return rect
  context.save()
  rotateLayer(context, rect, subject.rotation)
  if (shadow.visible && shadow.opacity) drawContactShadow(context, rect, { ...shadow, opacity: shadow.opacity * subject.opacity })
  context.globalAlpha = subject.opacity
  context.filter = `brightness(${subject.brightness}%) saturate(${subject.saturation}%)`
  if (fullSource) {
    context.drawImage(source, rect.x - bounds.x * scaleX, rect.y - bounds.y * scaleY, sourceWidth * scaleX, sourceHeight * scaleY)
  } else context.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, rect.x, rect.y, rect.width, rect.height)
  context.restore()
  return rect
}

export async function renderPoster(content: PosterContent, sources: {
  subject?: PreparedSubject
  background?: RenderSource
  image(layer: PosterImageLayer): RenderSource | undefined | Promise<RenderSource | undefined>
}, jpeg: boolean, rasterSize: { width: number; height: number }) {
  const { width, height, background } = content
  const backgroundFrame = content.backgroundFrame ?? { x: 0, y: 0, width, height }
  const canvas = createCanvas(rasterSize.width, rasterSize.height)
  const context = canvas.getContext('2d')
  context.scale(rasterSize.width / width, rasterSize.height / height)
  const imageBounds: Record<string, PosterBox> = {}
  if (jpeg || background.type === 'solid') {
    context.fillStyle = background.type === 'solid' ? background.color : '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  if (background.type === 'gradient') {
    const gradient = context.createLinearGradient(0, backgroundFrame.y, 0, backgroundFrame.y + backgroundFrame.height)
    gradient.addColorStop(0, background.top)
    gradient.addColorStop(1, background.bottom)
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
  }
  if (sources.background) {
    const source = await loadRenderSource(sources.background)
    const image = applyLayerMask(source, content.layerMasks?.background)
    const frame = backgroundFrame
    const scale = Math.max(frame.width / source.width, frame.height / source.height)
    const coverWidth = source.width * scale
    const coverHeight = source.height * scale
    context.save()
    context.beginPath()
    context.rect(frame.x, frame.y, frame.width, frame.height)
    context.clip()
    context.drawImage(image, frame.x + (frame.width - coverWidth) / 2, frame.y + (frame.height - coverHeight) / 2, coverWidth, coverHeight)
    context.restore()
  }
  const texts = new Map(content.textLayers.map(layer => [`text:${layer.id}`, layer]))
  const images = new Map(content.imageLayers.map(layer => [`image:${layer.id}` as const, layer]))
  for (const id of content.layerOrder) {
    if (id === 'subject') {
      if (content.subject.visible && sources.subject) imageBounds[id] = drawSubject(context, content, sources.subject)
      continue
    }
    const text = texts.get(id)
    if (text?.visible) drawText(context, text)
    if (!id.startsWith('image:')) continue
    const imageId = id as `image:${string}`
    const layer = images.get(imageId)
    if (!layer?.visible) continue
    const source = await sources.image(layer)
    if (!source) continue
    const { x, y, width, height, opacity, rotation = 0 } = layer
    imageBounds[id] = { x, y, width, height }
    if (!opacity) continue
    const image = applyLayerMask(await loadRenderSource(source), content.layerMasks?.[imageId])
    context.save()
    rotateLayer(context, layer, rotation)
    context.globalAlpha = opacity
    context.drawImage(image, x, y, width, height)
    context.restore()
  }
  return { canvas, imageBounds }
}

export async function sourceThumbnail(source: RenderSource, maxSize = 800): Promise<Buffer> {
  return rasterize(await loadRenderSource(source), maxSize).encode('png')
}

export async function renderLayerMaskPreview(bytes: Buffer, mask: PosterLayerMask | undefined, subject: boolean, edited?: Canvas) {
  const maxSide = subject ? maxSubjectMaskSide : maxLayerMaskSide
  const source = rasterize(edited ?? await loadPosterImage(bytes), maxSide)
  const anchor = edited && mask?.base.type === 'legacy' && mask.base.mask.type === 'edge_color'
    ? rasterize(await loadPosterImage(bytes), maxSide)
    : source
  const alpha = renderLayerMask(anchor, mask)
  const preview = rasterize(source, 800)
  const maskPreview = rasterize(alpha, 800)
  const [sourceBytes, maskBytes] = await Promise.all([preview.encode('png'), maskPreview.encode('png')])
  return { sourceBytes, maskBytes, width: preview.width, height: preview.height }
}
