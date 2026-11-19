import { parentPort, workerData } from 'node:worker_threads'
import modelPath from './assets/yunet/face_detection_yunet_2026may.onnx?asset'
import { renderRetouch, type RetouchedImage } from './retouch-render'
import type { RetouchOptions } from '../src/lib/retouch'

export type RetouchWork = { bytes: Uint8Array<ArrayBuffer>; options: RetouchOptions }
export type RetouchResponse = { ok: true; result: RetouchedImage } | { ok: false; message: string }

const { bytes, options } = workerData as RetouchWork
void renderRetouch(bytes, options, modelPath).then(result => {
  const image = Uint8Array.from(result.bytes)
  parentPort?.postMessage({ ok: true, result: { ...result, bytes: image } } satisfies RetouchResponse, [image.buffer])
}).catch(error => {
  const message = error instanceof Error && /^(未检测到|所选区域|照片超过)/.test(error.message)
    ? error.message : '本地人像处理失败，请确认图片可打开后重试'
  parentPort?.postMessage({ ok: false, message } satisfies RetouchResponse)
})
