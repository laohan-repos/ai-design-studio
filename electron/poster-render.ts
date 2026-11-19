import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { PosterContent, PosterMask, PosterText } from '../src/lib/poster'

type Bounds = { x: number; y: number; width: number; height: number }
const maxMaskSide = 2048

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
}

export async function prepareSubject(bytes: Buffer, mask: PosterMask) {
  const image = await loadImage(bytes)
  if (!image.width || !image.height) throw new Error('无法读取原图，请使用 PNG、JPEG 或 WebP')
  const scale = Math.min(1, maxMaskSide / Math.max(image.width, image.height))
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
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
  if (right < 0) throw new Error('蒙版没有保留主体，请减小容差或改用手动描边')
  return { canvas, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } }
}

function drawContactShadow(context: SKRSContext2D, rect: Bounds, shadow: PosterContent['shadow']) {
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

export async function renderPoster(content: PosterContent, source: Buffer | undefined, backgroundImage: Buffer | undefined, jpeg: boolean): Promise<Canvas> {
  const { width, height, background, subject, mask, shadow, textLayers } = content
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  if (jpeg || background.type === 'solid') {
    context.fillStyle = background.type === 'solid' ? background.color : '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  if (background.type === 'gradient') {
    const gradient = context.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, background.top)
    gradient.addColorStop(1, background.bottom)
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
  }
  if (backgroundImage) {
    const image = await loadImage(backgroundImage)
    const scale = Math.max(width / image.width, height / image.height)
    context.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale)
  }
  if (subject.visible && subject.opacity && source) {
    const { canvas: product, bounds } = await prepareSubject(source, mask)
    const fit = Math.min(subject.width / bounds.width, subject.height / bounds.height)
    const fittedWidth = bounds.width * fit
    const fittedHeight = bounds.height * fit
    const rect = { x: subject.x + (subject.width - fittedWidth) / 2, y: subject.y + subject.height - fittedHeight, width: fittedWidth, height: fittedHeight }
    context.save()
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    context.translate(centerX, centerY)
    context.rotate(subject.rotation * Math.PI / 180)
    context.translate(-centerX, -centerY)
    if (shadow.visible && shadow.opacity) drawContactShadow(context, rect, { ...shadow, opacity: shadow.opacity * subject.opacity })
    context.globalAlpha = subject.opacity
    context.filter = `brightness(${subject.brightness}%) saturate(${subject.saturation}%)`
    context.drawImage(product, bounds.x, bounds.y, bounds.width, bounds.height, rect.x, rect.y, rect.width, rect.height)
    context.restore()
  }
  for (const layer of textLayers) if (layer.visible) drawText(context, layer)
  return canvas
}

export async function sourceThumbnail(bytes: Buffer, maxSize = 800): Promise<Buffer> {
  const image = await loadImage(bytes)
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height))
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.encode('png')
}
