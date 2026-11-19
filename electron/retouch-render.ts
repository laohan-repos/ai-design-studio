import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { detectFaces, type Face } from './face-detector'
import type { RetouchOptions } from '../src/lib/retouch'

export type RetouchedImage = { bytes: Uint8Array; faceCount: number; width: number; height: number }
const clamp = (value: number, max = 1) => Math.max(0, Math.min(value, max))
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

function falloff(value: number, inner: number, outer: number) {
  const t = clamp((value - inner) / (outer - inner))
  return 1 - t * t * (3 - 2 * t)
}

function faceFrame(context: SKRSContext2D, face: Face) {
  const [eyeA, eyeB] = face.landmarks
  const [leftEye, rightEye] = eyeA.x < eyeB.x ? [eyeA, eyeB] : [eyeB, eyeA]
  const cx = (leftEye.x + rightEye.x) / 2
  const cy = (leftEye.y + rightEye.y) / 2
  const angle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const eyeGap = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
  const x0 = Math.max(0, Math.floor(face.x - face.width * 0.12))
  const y0 = Math.max(0, Math.floor(face.y - face.height * 0.12))
  const width = Math.min(context.canvas.width, Math.ceil(face.x + face.width * 1.12)) - x0
  const height = Math.min(context.canvas.height, Math.ceil(face.y + face.height * 1.12)) - y0
  return { cx, cy, cos, sin, eyeGap, x0, y0, width, height }
}

type FaceFrame = ReturnType<typeof faceFrame>

function blendFace(context: SKRSContext2D, face: Face, frame: FaceFrame, options: RetouchOptions) {
  const { cx, cy, cos, sin, eyeGap, x0, y0, width, height } = frame
  const [, , nose, lipA, lipB] = face.landmarks
  const mouth = { x: (lipA.x + lipB.x) / 2, y: (lipA.y + lipB.y) / 2 }
  const mouthY = -(mouth.x - cx) * sin + (mouth.y - cy) * cos
  const faceRadiusX = Math.min(face.width * 0.46, eyeGap * 1.09)
  const faceRadiusY = face.height * 0.46
  const focusX = (nose.x - cx) * cos * 0.32 + (nose.y - cy) * sin * 0.32
  const focusY = Math.min(face.height * 0.18, Math.max(face.height * 0.085, mouthY * 0.45))
  const original = context.getImageData(x0, y0, width, height)
  const { data } = original
  const sample = (x: number, y: number) => {
    const offset = (clamp(Math.round(y - y0), height - 1) * width + clamp(Math.round(x - x0), width - 1)) * 4
    const yValue = luma(data[offset], data[offset + 1], data[offset + 2])
    return { red: data[offset] - yValue, blue: data[offset + 2] - yValue, y: yValue }
  }
  const reference = [-0.56, 0.56].map(side => {
    const x = side * eyeGap
    const y = Math.max(face.height * 0.14, mouthY * 0.65)
    return sample(cx + x * cos - y * sin, cy + x * sin + y * cos)
  })

  const blurred = createCanvas(width, height).getContext('2d')
  const radius = Math.max(1, Math.min(16, Math.min(face.width, face.height) * 0.038))
  blurred.filter = `blur(${radius}px)`
  blurred.drawImage(context.canvas, x0, y0, width, height, 0, 0, width, height)
  const smooth = blurred.getImageData(0, 0, width, height).data
  const eyeWidth = eyeGap * 0.38
  const eyeHeight = face.height * 0.145
  const lipWidth = Math.max(eyeGap * 0.37, Math.hypot(lipA.x - lipB.x, lipA.y - lipB.y) * 0.78)
  const lipHeight = face.height * 0.115
  const mouthX = (mouth.x - cx) * cos + (mouth.y - cy) * sin
  const mix = options.smoothing * 0.0085
  const lift = options.brighten * 0.003

  for (let row = 0; row < height; row++) {
    const dy = y0 + row - cy
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 4
      if (data[offset + 3] < 128 || smooth[offset + 3] < 128) continue
      const dx = x0 + column - cx
      const x = dx * cos + dy * sin
      const y = -dx * sin + dy * cos
      const oval = ((x - focusX) / faceRadiusX) ** 2 + ((y - focusY) / faceRadiusY) ** 2
      if (oval >= 1) continue
      const eye = ((Math.abs(x) - eyeGap / 2) / eyeWidth) ** 2 + ((y + face.height * 0.035) / eyeHeight) ** 2
      const lips = ((x - mouthX) / lipWidth) ** 2 + ((y - mouthY) / lipHeight) ** 2
      const features = (1 - falloff(eye, 0.65, 1.7)) * (1 - falloff(lips, 0.58, 1.75))
      if (!features) continue

      const level = luma(data[offset], data[offset + 1], data[offset + 2])
      const red = data[offset] - level
      const blue = data[offset + 2] - level
      const [a, b] = reference
      const matchA = (red - a.red) ** 2 + (blue - a.blue) ** 2 + (Math.max(0, a.y - level) * 0.28) ** 2
      const matchB = (red - b.red) ** 2 + (blue - b.blue) ** 2 + (Math.max(0, b.y - level) * 0.28) ** 2
      const tone = falloff(Math.min(matchA, matchB), 18 ** 2, 55 ** 2)
      const mask = falloff(oval, 0.44, 1) * tone * features
      const contrast = Math.abs(level - luma(smooth[offset], smooth[offset + 1], smooth[offset + 2]))
      const soften = mask * mix * (0.25 + 0.75 * falloff(contrast, 5, 42))
      if (!mask) continue
      for (let channel = 0; channel < 3; channel++) {
        const input = data[offset + channel]
        data[offset + channel] = input + (smooth[offset + channel] - input) * soften + (255 - input) * lift * mask
      }
    }
  }
  context.putImageData(original, x0, y0)
}

function refineFace(context: SKRSContext2D, face: Face, frame: FaceFrame, options: RetouchOptions) {
  const { cx, cy, cos, sin, eyeGap, x0, y0, width, height } = frame
  const original = context.getImageData(x0, y0, width, height)
  const { data } = original
  const lowFrequency = createCanvas(width, height).getContext('2d')
  lowFrequency.filter = `blur(${Math.max(2, Math.min(18, eyeGap * 0.085))}px)`
  lowFrequency.drawImage(context.canvas, x0, y0, width, height, 0, 0, width, height)
  const guide = lowFrequency.getImageData(0, 0, width, height).data

  function cheekReference(side: number) {
    const x = side * eyeGap * 0.6
    const y = eyeGap * 0.62
    const column = clamp(Math.round(cx + x * cos - y * sin - x0), width - 1)
    const row = clamp(Math.round(cy + x * sin + y * cos - y0), height - 1)
    const index = (row * width + column) * 4
    const level = luma(guide[index], guide[index + 1], guide[index + 2])
    return { level, red: guide[index] - level, blue: guide[index + 2] - level }
  }

  const leftCheek = cheekReference(-1)
  const rightCheek = cheekReference(1)
  const [, , nose, lipA, lipB] = face.landmarks
  const lipDx = (lipA.x + lipB.x) / 2 - cx
  const lipDy = (lipA.y + lipB.y) / 2 - cy
  const lipX = (lipDx * cos + lipDy * sin) / eyeGap
  const lipY = (-lipDx * sin + lipDy * cos) / eyeGap
  const noseX = ((nose.x - cx) * cos + (nose.y - cy) * sin) / eyeGap
  const faceRadius = face.height / eyeGap * 0.4
  const shadowStrength = options.underEyeShadows * 0.0085
  const toneStrength = options.cheekTone * 0.01

  for (let row = 0; row < height; row++) {
    const dy = y0 + row - cy
    for (let column = 0; column < width; column++) {
      const index = (row * width + column) * 4
      if (data[index + 3] < 128) continue
      const dx = x0 + column - cx
      // Relative to the eye line, with +y below the eyes even if the head is tilted.
      const x = (dx * cos + dy * sin) / eyeGap
      const y = (-dx * sin + dy * cos) / eyeGap
      const side = x < 0 ? -1 : 1
      const reference = side < 0 ? leftCheek : rightCheek
      const eyeX = x - side * 0.5
      const underEye = falloff((eyeX / 0.35) ** 2 + ((y - 0.245) / 0.205) ** 2, 0.25, 1)
        * (1 - falloff(y, 0.095, 0.165))
      const cheek = falloff(((x - side * 0.63) / 0.49) ** 2 + ((y - 0.615) / 0.46) ** 2, 0.32, 1)
      if (!(underEye * shadowStrength || cheek * toneStrength)) continue

      const faceMask = falloff(((x - noseX * 0.18) / 1.12) ** 2 + ((y - 0.42) / faceRadius) ** 2, 0.58, 1)
      const lipMask = 1 - falloff(((x - lipX) / 0.44) ** 2 + ((y - lipY) / 0.22) ** 2, 0.65, 1.15)
      const level = luma(data[index], data[index + 1], data[index + 2])
      const skin = falloff(Math.hypot(data[index] - level - reference.red, data[index + 2] - level - reference.blue), 14, 44)
        * (1 - falloff(level, 42, 95))
      const mask = faceMask * lipMask * skin
      if (!mask) continue

      // Guide adjustments from low-frequency color so pores and fine lines remain in the source pixels.
      const guideLevel = luma(guide[index], guide[index + 1], guide[index + 2])
      const lift = clamp(reference.level - guideLevel - 2, 44) * underEye * shadowStrength * mask
      const toneMix = cheek * toneStrength * mask
      const red = Math.max(-14, Math.min(reference.red - (guide[index] - guideLevel), 14)) * toneMix
      const blue = Math.max(-14, Math.min(reference.blue - (guide[index + 2] - guideLevel), 14)) * toneMix
      const green = -(0.299 * red + 0.114 * blue) / 0.587
      data[index] += lift + red
      data[index + 1] += lift + green
      data[index + 2] += lift + blue
    }
  }
  context.putImageData(original, x0, y0)
}

function reduceDressHighlights(context: SKRSContext2D, options: NonNullable<RetouchOptions['dressHighlights']>) {
  const points = options.region.map(point => ({ x: point.x * context.canvas.width, y: point.y * context.canvas.height }))
  const x0 = Math.floor(Math.min(...points.map(point => point.x)))
  const y0 = Math.floor(Math.min(...points.map(point => point.y)))
  const width = Math.ceil(Math.max(...points.map(point => point.x))) - x0
  const height = Math.ceil(Math.max(...points.map(point => point.y))) - y0
  const maskContext = createCanvas(width, height).getContext('2d')
  maskContext.beginPath()
  maskContext.moveTo(points[0].x - x0, points[0].y - y0)
  for (const point of points.slice(1)) maskContext.lineTo(point.x - x0, point.y - y0)
  maskContext.closePath()
  maskContext.clip()
  maskContext.filter = `blur(${Math.min(24, Math.max(2, Math.min(width, height) * 0.022))}px)`
  maskContext.fill()

  const mask = maskContext.getImageData(0, 0, width, height).data
  const selection = context.getImageData(x0, y0, width, height)
  const { data } = selection
  const strength = options.strength * 0.46
  for (let index = 0; index < data.length; index += 4) {
    if (!mask[index + 3] || data[index + 3] < 128) continue
    const r = data[index], g = data[index + 1], b = data[index + 2]
    const level = luma(r, g, b)
    if (level <= 155) continue
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    const whiteFabric = falloff(chroma, 19, 68)
    const highlights = 1 - falloff(level, 155, 245)
    const reduction = strength * highlights * whiteFabric * (mask[index + 3] / 255)
    const scale = 1 - reduction / level
    data[index] *= scale
    data[index + 1] *= scale
    data[index + 2] *= scale
  }
  context.putImageData(selection, x0, y0)
}

export async function renderRetouch(bytes: Uint8Array, options: RetouchOptions, modelPath: string): Promise<RetouchedImage> {
  const image = await loadImage(Buffer.from(bytes))
  const { width, height } = image
  if (width * height > 32_000_000) throw new Error('照片超过 3200 万像素，请缩小后再试')
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  let faceCount = 0
  const smoothing = options.smoothing || options.brighten
  const refinement = options.underEyeShadows || options.cheekTone
  if (smoothing || refinement) {
    const detected = await detectFaces(image, modelPath)
    const box = options.faceRegion
    const faces = box ? detected.filter(face => {
      const x = (face.x + face.width / 2) / width
      const y = (face.y + face.height / 2) / height
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    }) : detected
    if (box && !faces.length) throw new Error('所选区域内未检测到清晰人脸')
    if (!faces.length) throw new Error('未检测到清晰人脸，请使用面部较清晰的照片')
    const targets = options.faces === 'primary' ? faces.slice(0, 1) : faces
    for (const face of targets) {
      const frame = faceFrame(context, face)
      if (frame.eyeGap < 6 || frame.width < 8 || frame.height < 8) continue
      if (smoothing) blendFace(context, face, frame, options)
      if (refinement) refineFace(context, face, frame, options)
      faceCount++
    }
    if (!faceCount) throw new Error('未检测到足够清晰的人脸，请使用面部较清晰的照片')
  }
  if (options.dressHighlights) reduceDressHighlights(context, options.dressHighlights)
  return { bytes: await canvas.encode('png'), faceCount, width, height }
}
