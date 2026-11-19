import { createCanvas, type Image } from '@napi-rs/canvas'
import { readFile } from 'node:fs/promises'
import { InferenceSession, Tensor, env } from 'onnxruntime-web'

type Point = { x: number; y: number }
export type Face = { x: number; y: number; width: number; height: number; landmarks: [Point, Point, Point, Point, Point] }
type Detection = Face & { score: number }
const size = 640
const strides = [8, 16, 32] as const

function overlap(a: Face, b: Face) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const area = width * height
  return area / (a.width * a.height + b.width * b.height - area)
}

export async function detectFaces(image: Image, modelPath: string): Promise<Face[]> {
  const scale = Math.min(size / image.width, size / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, width, height)
  const { data } = context.getImageData(0, 0, size, size)
  const plane = size * size
  const input = new Float32Array(plane * 3)
  for (let index = 0; index < plane; index++) {
    input[index] = data[index * 4 + 2]
    input[plane + index] = data[index * 4 + 1]
    input[plane * 2 + index] = data[index * 4]
  }

  env.wasm.numThreads = 1
  const session = await InferenceSession.create(await readFile(modelPath), { executionProviders: ['wasm'] })
  try {
    const output = await session.run({ [session.inputNames[0]]: new Tensor('float32', input, [1, 3, size, size]) })
    const candidates: Detection[] = []
    // YuNet predicts offsets relative to each output grid cell, at three resolutions.
    for (const stride of strides) {
      const classes = output[`cls_${stride}`].data as Float32Array
      const objects = output[`obj_${stride}`].data as Float32Array
      const boxes = output[`bbox_${stride}`].data as Float32Array
      const points = output[`kps_${stride}`].data as Float32Array
      const columns = size / stride
      for (let i = 0; i < classes.length; i++) {
        const score = Math.sqrt(Math.max(0, Math.min(1, classes[i])) * Math.max(0, Math.min(1, objects[i])))
        if (score < 0.8) continue
        const column = i % columns
        const row = Math.floor(i / columns)
        const centerX = (column + boxes[i * 4]) * stride
        const centerY = (row + boxes[i * 4 + 1]) * stride
        const w = Math.exp(boxes[i * 4 + 2]) * stride
        const h = Math.exp(boxes[i * 4 + 3]) * stride
        if (centerX >= width || centerY >= height || Math.min(w, h) < 22) continue
        const landmark = (index: number): Point => ({
          x: (column + points[i * 10 + index * 2]) * stride / scale,
          y: (row + points[i * 10 + index * 2 + 1]) * stride / scale
        })
        candidates.push({
          x: (centerX - w / 2) / scale, y: (centerY - h / 2) / scale, width: w / scale, height: h / scale, score,
          landmarks: [landmark(0), landmark(1), landmark(2), landmark(3), landmark(4)]
        })
      }
    }
    const selected: Face[] = []
    for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
      if (selected.some(face => overlap(face, candidate) > 0.3)) continue
      selected.push(candidate)
      if (selected.length >= 16) break
    }
    return selected.sort((a, b) => b.width * b.height - a.width * a.height)
  } finally { await session.release() }
}
