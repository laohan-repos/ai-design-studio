import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { PhotoMask, PhotoPoint, PhotoSelection } from '../src/lib/photo-edits'

export function drawNormalizedBrush(context: SKRSContext2D, points: PhotoPoint[], radius: number) {
  const { width, height } = context.canvas
  const [first, ...rest] = points
  const pixels = radius * Math.min(width, height)
  context.beginPath()
  if (!rest.length) {
    context.arc(first.x * width, first.y * height, pixels, 0, Math.PI * 2)
    context.fill()
    return
  }
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = pixels * 2
  context.moveTo(first.x * width, first.y * height)
  for (const point of rest) context.lineTo(point.x * width, point.y * height)
  context.stroke()
}

function drawSelection(context: SKRSContext2D, selection: PhotoSelection) {
  if (selection.type === 'brush') {
    drawNormalizedBrush(context, selection.points, selection.radius)
    return
  }
  const { width, height } = context.canvas
  context.beginPath()
  if (selection.type === 'rectangle' || selection.type === 'ellipse') {
    const box = selection.box
    const x = box.x * width, y = box.y * height, w = box.width * width, h = box.height * height
    if (selection.type === 'rectangle') context.rect(x, y, w, h)
    else context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  } else {
    const [first, ...rest] = selection.points
    context.moveTo(first.x * width, first.y * height)
    for (const point of rest) context.lineTo(point.x * width, point.y * height)
    context.closePath()
  }
  context.fill()
}

export function drawSelectionMask(width: number, height: number, mask: PhotoMask) {
  const context = createCanvas(width, height).getContext('2d')
  const blur = (mask.feather ?? 0.01) * Math.min(width, height)
  context.save()
  if (!mask.include.length) context.fillRect(0, 0, width, height)
  if (blur) context.filter = `blur(${blur}px)`
  for (const selection of mask.include) drawSelection(context, selection)
  context.globalCompositeOperation = 'destination-out'
  for (const selection of mask.exclude ?? []) drawSelection(context, selection)
  context.restore()
  return context.canvas
}
