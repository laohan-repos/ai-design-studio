import { parentPort, workerData } from 'node:worker_threads'
import { inspectPhotoColors, renderCropSuggestions, renderPhotoWork, type PhotoColorWork, type PhotoCropWork, type PhotoCropWorkResult, type PhotoWork, type PhotoWorkResult } from './photo-edit-render'
import type { PhotoColors } from '../src/lib/color-grade'

export type PhotoWorkerReply = { ok: true; result: PhotoWorkResult | PhotoColors | PhotoCropWorkResult } | { ok: false; message: string }

const work = workerData as PhotoWork | PhotoColorWork | PhotoCropWork
void (work.type === 'colors' ? inspectPhotoColors(work) : work.type === 'crops' ? renderCropSuggestions(work) : renderPhotoWork(work)).then(result => {
  parentPort?.postMessage({ ok: true, result } satisfies PhotoWorkerReply)
}).catch(error => {
  const message = error instanceof Error && /^(照片超过|附近没有|裁剪框超出)/.test(error.message)
    ? error.message : '无法完成局部精修，请检查图片和操作参数'
  parentPort?.postMessage({ ok: false, message } satisfies PhotoWorkerReply)
})
