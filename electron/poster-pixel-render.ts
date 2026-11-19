import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import { photoSizeMaxPixels } from '../src/lib/document-size'
import type { PhotoMask, PhotoPoint, PhotoSelection } from '../src/lib/photo-edits'
import type { PosterPixelRect, PosterPixelStroke } from '../src/lib/poster-pixels'
import { drawNormalizedBrush, drawSelectionMask } from './selection-mask'

type SelectedPixels = { rect: PosterPixelRect; alpha: Uint8Array }
type ReplacementPixels = { rect: PosterPixelRect; data: Uint8ClampedArray }
type RegionEdit = { mode: 'remove'; selection: PhotoMask }
  | { mode: 'redraw'; selection: PhotoMask; generate(image: Buffer, mask: Buffer): Promise<Buffer> }

const redrawSize = 1024
const maskReadRows = 64

function clipRect(image: Pick<Canvas, 'width' | 'height'>, left: number, top: number, right: number, bottom: number): PosterPixelRect {
  const x = Math.max(0, Math.floor(left))
  const y = Math.max(0, Math.floor(top))
  return { x, y, width: Math.max(0, Math.min(image.width, Math.ceil(right)) - x), height: Math.max(0, Math.min(image.height, Math.ceil(bottom)) - y) }
}

function expandRect(image: Canvas, { x, y, width, height }: PosterPixelRect, margin: number) {
  return clipRect(image, x - margin, y - margin, x + width + margin, y + height + margin)
}

export async function composePixelTiles(source: Buffer | Image, tiles: { x: number; y: number; bytes: Buffer }[]): Promise<Canvas> {
  const image = Buffer.isBuffer(source) ? await loadImage(source) : source
  if (!image.width || !image.height || image.width * image.height > photoSizeMaxPixels) {
    throw new Error('图层像素编辑支持不超过 3200 万像素的图片')
  }
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  for (const { x, y, bytes } of tiles) {
    const tile = await loadImage(bytes)
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || !tile.width || !tile.height
      || x + tile.width > canvas.width || y + tile.height > canvas.height) {
      throw new Error('像素图块超出图层范围')
    }
    context.clearRect(x, y, tile.width, tile.height)
    context.drawImage(tile, x, y)
  }
  return canvas
}

function brushInRect(context: SKRSContext2D, canvas: Canvas, rect: PosterPixelRect, points: PhotoPoint[], radius: number) {
  const local = points.map(({ x, y }) => ({ x: (x * canvas.width - rect.x) / rect.width, y: (y * canvas.height - rect.y) / rect.height }))
  drawNormalizedBrush(context, local, radius / Math.min(rect.width, rect.height))
}

export function paintPosterPixels(canvas: Canvas, stroke: PosterPixelStroke): PosterPixelRect {
  const { width, height } = canvas
  const radius = Math.max(0.5, stroke.radius * Math.min(width, height))
  const margin = radius + 1
  const xs = stroke.points.map(point => point.x * width)
  const ys = stroke.points.map(point => point.y * height)
  const bounds = clipRect(canvas, Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin)
  const context = canvas.getContext('2d')

  if (stroke.type === 'clone') {
    const shiftX = Math.round((stroke.source.x - stroke.points[0].x) * width)
    const shiftY = Math.round((stroke.source.y - stroke.points[0].y) * height)
    const rect = clipRect(canvas, Math.max(bounds.x, -shiftX), Math.max(bounds.y, -shiftY),
      Math.min(bounds.x + bounds.width, width - shiftX), Math.min(bounds.y + bounds.height, height - shiftY))
    if (!rect.width || !rect.height) throw new Error('取样范围超出图层，请重新选择取样点')
    const patch = createCanvas(rect.width, rect.height)
    const paint = patch.getContext('2d')
    brushInRect(paint, canvas, rect, stroke.points, radius)
    paint.globalCompositeOperation = 'source-in'
    // Copy onto a separate surface before changing the source, even when the areas overlap.
    paint.drawImage(canvas, rect.x + shiftX, rect.y + shiftY, rect.width, rect.height, 0, 0, rect.width, rect.height)
    context.save()
    context.globalAlpha = stroke.opacity
    context.drawImage(patch, rect.x, rect.y)
    context.restore()
    return rect
  }

  context.save()
  context.globalAlpha = stroke.opacity
  context.globalCompositeOperation = stroke.type === 'eraser' ? 'destination-out' : 'source-over'
  const color = stroke.type === 'brush' ? stroke.color : '#ffffff'
  context.fillStyle = color
  context.strokeStyle = color
  drawNormalizedBrush(context, stroke.points, radius / Math.min(width, height))
  context.restore()
  return bounds
}

function selectionBounds(canvas: Canvas, selection: PhotoMask) {
  const { width, height } = canvas
  if (!selection.include.length) return { x: 0, y: 0, width, height }
  let left = width, top = height, right = 0, bottom = 0
  for (const shape of selection.include) {
    if (shape.type === 'rectangle' || shape.type === 'ellipse') {
      const { x, y, width: w, height: h } = shape.box
      left = Math.min(left, x * width)
      top = Math.min(top, y * height)
      right = Math.max(right, (x + w) * width)
      bottom = Math.max(bottom, (y + h) * height)
    } else {
      const radius = shape.type === 'brush' ? shape.radius * Math.min(width, height) : 0
      for (const point of shape.points) {
        left = Math.min(left, point.x * width - radius)
        top = Math.min(top, point.y * height - radius)
        right = Math.max(right, point.x * width + radius)
        bottom = Math.max(bottom, point.y * height + radius)
      }
    }
  }
  return clipRect(canvas, left - 1, top - 1, right + 1, bottom + 1)
}

function localSelection(canvas: Canvas, rect: PosterPixelRect, selection: PhotoMask): PhotoMask {
  const point = ({ x, y }: PhotoPoint) => ({ x: (x * canvas.width - rect.x) / rect.width, y: (y * canvas.height - rect.y) / rect.height })
  const shortSideScale = Math.min(canvas.width, canvas.height) / Math.min(rect.width, rect.height)
  const shape = (item: PhotoSelection): PhotoSelection => {
    if (item.type === 'rectangle' || item.type === 'ellipse') {
      return { type: item.type, box: { ...point(item.box), width: item.box.width * canvas.width / rect.width, height: item.box.height * canvas.height / rect.height } }
    }
    return item.type === 'polygon' ? { type: 'polygon', points: item.points.map(point) }
      : { type: 'brush', points: item.points.map(point), radius: item.radius * shortSideScale }
  }
  return { include: selection.include.map(shape), exclude: selection.exclude?.map(shape), feather: (selection.feather ?? 0.01) * shortSideScale }
}

function readMask(mask: Canvas, rect: PosterPixelRect, alpha: Uint8Array, mode: 'copy' | 'subtract' | 'limit') {
  const context = mask.getContext('2d')
  for (let row = 0; row < rect.height; row += maskReadRows) {
    const rows = Math.min(maskReadRows, rect.height - row)
    const data = context.getImageData(rect.x, rect.y + row, rect.width, rows).data
    for (let i = 3, dest = row * rect.width; i < data.length; i += 4, dest++) {
      if (mode === 'copy') alpha[dest] = data[i]
      else if (mode === 'subtract') alpha[dest] = Math.max(0, alpha[dest] - data[i])
      else alpha[dest] = Math.min(alpha[dest], data[i])
    }
  }
  // Release the full-size native scratch surface before drawing or decoding another one.
  mask.width = 1
  mask.height = 1
}

function rasterSelection(canvas: Canvas, selection: PhotoMask): SelectedPixels {
  const rect = selectionBounds(canvas, selection)
  if (!rect.width || !rect.height) throw new Error('选区没有可编辑像素')
  const alpha = new Uint8Array(rect.width * rect.height)
  const local = localSelection(canvas, rect, selection)
  const frame = { x: 0, y: 0, width: rect.width, height: rect.height }
  readMask(drawSelectionMask(rect.width, rect.height, { include: local.include, feather: 0 }), frame, alpha, 'copy')
  if (local.exclude?.length) {
    const excluded = drawSelectionMask(rect.width, rect.height, { include: local.exclude, feather: 0 })
    // Subtract coverage directly so two identical antialiased shapes cancel at the edge.
    readMask(excluded, frame, alpha, 'subtract')
  }

  const blur = (selection.feather ?? 0.01) * Math.min(canvas.width, canvas.height)
  if (blur) {
    const padded = expandRect(canvas, rect, Math.ceil(blur * 4))
    const mask = drawSelectionMask(padded.width, padded.height, localSelection(canvas, padded, selection))
    // Feather into the existing shape only, so neither the surrounding pixels nor a subtracted area can change.
    readMask(mask, { ...rect, x: rect.x - padded.x, y: rect.y - padded.y }, alpha, 'limit')
  }

  let left = rect.width, top = rect.height, right = 0, bottom = 0
  for (let y = 0, i = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++, i++) {
      if (!alpha[i]) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }
  }
  if (right <= left || bottom <= top) throw new Error('选区没有可编辑像素')
  if (!left && !top && right === rect.width && bottom === rect.height) return { rect, alpha }
  const width = right - left, height = bottom - top
  const cropped = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const start = (top + y) * rect.width + left
    cropped.set(alpha.subarray(start, start + width), y * width)
  }
  return { rect: { x: rect.x + left, y: rect.y + top, width, height }, alpha: cropped }
}

function fillFromSurroundings(canvas: Canvas, selection: SelectedPixels): ReplacementPixels {
  const rect = expandRect(canvas, selection.rect, 1)
  const { width, height } = rect
  const data = canvas.getContext('2d').getImageData(rect.x, rect.y, width, height).data
  // 0 = usable source/filled pixel, 1 = unfilled selection, 2 = current or next boundary.
  const state = new Uint8Array(width * height)
  const offset = (selection.rect.y - rect.y) * width + selection.rect.x - rect.x
  for (let y = 0; y < selection.rect.height; y++) {
    for (let x = 0; x < selection.rect.width; x++) {
      if (selection.alpha[y * selection.rect.width + x]) state[offset + y * width + x] = 1
    }
  }
  let frontier: number[] = []
  let next: number[] = []
  const neighbors = new Int32Array(4)
  function nearby(index: number) {
    let count = 0
    const x = index % width
    if (x > 0) neighbors[count++] = index - 1
    if (x + 1 < width) neighbors[count++] = index + 1
    if (index >= width) neighbors[count++] = index - width
    if (index + width < state.length) neighbors[count++] = index + width
    return count
  }
  for (let i = 0; i < state.length; i++) {
    if (state[i] !== 1) continue
    const count = nearby(i)
    for (let n = 0; n < count; n++) {
      if (state[neighbors[n]] !== 0) continue
      state[i] = 2
      frontier.push(i)
      break
    }
  }
  if (!frontier.length) throw new Error('选区周围没有可用于填充的像素，请缩小选区')

  // Advance in rings from pixels outside the selection, averaging the available
  // neighboring colors in premultiplied alpha to preserve transparent backgrounds.
  while (frontier.length) {
    for (const index of frontier) {
      let r = 0, g = 0, b = 0, alpha = 0, samples = 0
      const count = nearby(index)
      for (let n = 0; n < count; n++) {
        if (state[neighbors[n]] !== 0) continue
        const from = neighbors[n] * 4
        const weight = data[from + 3]
        r += data[from] * weight
        g += data[from + 1] * weight
        b += data[from + 2] * weight
        alpha += weight
        samples++
      }
      const to = index * 4
      data[to] = alpha ? r / alpha : 0
      data[to + 1] = alpha ? g / alpha : 0
      data[to + 2] = alpha ? b / alpha : 0
      data[to + 3] = alpha / samples
    }
    for (const index of frontier) state[index] = 0
    for (const index of frontier) {
      const count = nearby(index)
      for (let n = 0; n < count; n++) {
        const pixel = neighbors[n]
        if (state[pixel] !== 1) continue
        state[pixel] = 2
        next.push(pixel)
      }
    }
    frontier.length = 0
    const empty = frontier
    frontier = next
    next = empty
  }
  return { rect, data }
}

function modelFrame(rect: PosterPixelRect): PosterPixelRect {
  const scale = redrawSize / Math.max(rect.width, rect.height)
  const width = Math.max(1, Math.round(rect.width * scale))
  const height = Math.max(1, Math.round(rect.height * scale))
  return { x: Math.floor((redrawSize - width) / 2), y: Math.floor((redrawSize - height) / 2), width, height }
}

function redrawMask(selection: SelectedPixels, context: PosterPixelRect, frame: PosterPixelRect) {
  const canvas = createCanvas(redrawSize, redrawSize)
  const paint = canvas.getContext('2d')
  const mask = paint.createImageData(redrawSize, redrawSize)
  const { rect, alpha } = selection
  const fromImageX = (x: number) => Math.floor(context.x + (x + 0.5) * context.width / frame.width) - rect.x
  const fromImageY = (y: number) => Math.floor(context.y + (y + 0.5) * context.height / frame.height) - rect.y
  for (let i = 3; i < mask.data.length; i += 4) mask.data[i] = 255
  let editable = false
  for (let y = 0; y < frame.height; y++) {
    const row = fromImageY(y)
    if (row < 0 || row >= rect.height) continue
    for (let x = 0; x < frame.width; x++) {
      const column = fromImageX(x)
      if (column < 0 || column >= rect.width || !alpha[row * rect.width + column]) continue
      mask.data[((frame.y + y) * redrawSize + frame.x + x) * 4 + 3] = 0
      editable = true
    }
  }
  if (!editable) {
    const first = alpha.findIndex(value => value > 0)
    const x = Math.floor((rect.x + first % rect.width + 0.5 - context.x) * frame.width / context.width)
    const y = Math.floor((rect.y + Math.floor(first / rect.width) + 0.5 - context.y) * frame.height / context.height)
    mask.data[((frame.y + y) * redrawSize + frame.x + x) * 4 + 3] = 0
  }
  paint.putImageData(mask, 0, 0)
  return canvas
}

async function redrawRegion(canvas: Canvas, selection: SelectedPixels, generate: Extract<RegionEdit, { mode: 'redraw' }>['generate']): Promise<ReplacementPixels> {
  const { rect } = selection
  const surrounding = expandRect(canvas, rect, Math.max(16, Math.round(Math.max(rect.width, rect.height) / 4)))
  const frame = modelFrame(surrounding)
  const input = createCanvas(redrawSize, redrawSize)
  const context = input.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, surrounding.x, surrounding.y, surrounding.width, surrounding.height, frame.x, frame.y, frame.width, frame.height)
  const [image, mask] = await Promise.all([input.encode('png'), redrawMask(selection, surrounding, frame).encode('png')])
  const bytes = await generate(image, mask)
  const result = await loadImage(bytes).catch(() => { throw new Error('模型返回了无法读取的图片') })
  if (!result.width || !result.height || result.width * result.height > photoSizeMaxPixels) throw new Error('模型返回的图片尺寸无效')

  const sx = frame.width * result.width / (surrounding.width * redrawSize)
  const sy = frame.height * result.height / (surrounding.height * redrawSize)
  const x = frame.x * result.width / redrawSize + (rect.x - surrounding.x) * sx
  const y = frame.y * result.height / redrawSize + (rect.y - surrounding.y) * sy
  const replacement = createCanvas(rect.width, rect.height)
  const paint = replacement.getContext('2d')
  paint.imageSmoothingQuality = 'high'
  paint.drawImage(result, x, y, rect.width * sx, rect.height * sy, 0, 0, rect.width, rect.height)
  return { rect, data: paint.getImageData(0, 0, rect.width, rect.height).data }
}

function applySelection(canvas: Canvas, selection: SelectedPixels, replacement: ReplacementPixels) {
  const context = canvas.getContext('2d')
  const { x, y, width, height } = selection.rect
  const offset = (y - replacement.rect.y) * replacement.rect.width + x - replacement.rect.x
  for (let row = 0; row < height; row += maskReadRows) {
    const rows = Math.min(maskReadRows, height - row)
    const part = context.getImageData(x, y + row, width, rows)
    const original = part.data
    for (let py = row, destination = 0; py < row + rows; py++) {
      for (let px = 0; px < width; px++, destination += 4) {
        const mix = selection.alpha[py * width + px] / 255
        if (!mix) continue
        const source = (offset + py * replacement.rect.width + px) * 4
        const keep = original[destination + 3] * (1 - mix)
        const insert = replacement.data[source + 3] * mix
        const alpha = keep + insert
        for (let channel = 0; channel < 3; channel++) {
          original[destination + channel] = alpha
            ? (original[destination + channel] * keep + replacement.data[source + channel] * insert) / alpha : 0
        }
        original[destination + 3] = alpha
      }
    }
    context.putImageData(part, x, y + row)
  }
}

export async function editPosterPixelRegion(canvas: Canvas, input: RegionEdit): Promise<PosterPixelRect> {
  const selection = rasterSelection(canvas, input.selection)
  const replacement = input.mode === 'remove' ? fillFromSurroundings(canvas, selection) : await redrawRegion(canvas, selection, input.generate)
  applySelection(canvas, selection, replacement)
  return selection.rect
}
