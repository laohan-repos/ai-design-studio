import { randomUUID } from 'node:crypto'
import worker from './retouch-worker?nodeWorker'
import type { RetouchResponse, RetouchWork } from './retouch-worker'
import type { RetouchedImage } from './retouch-render'
import { retouchInput, type RetouchResult } from '../src/lib/retouch'
import type { McpWorkspaceChange } from '../src/types'
import type { StudioDatabase } from './database'

function processPortrait(work: RetouchWork): Promise<RetouchedImage> {
  return new Promise((resolve, reject) => {
    const task = worker({ workerData: work, transferList: [work.bytes.buffer] })
    const timeout = setTimeout(() => {
      reject(new Error('人像处理超时，请缩小照片后重试'))
      void task.terminate()
    }, 40_000)
    task.once('message', (response: RetouchResponse) => {
      clearTimeout(timeout)
      if (response.ok) resolve(response.result)
      else reject(new Error(response.message))
    })
    task.once('error', () => {
      clearTimeout(timeout)
      reject(new Error('无法启动本地人像处理，请重启应用后重试'))
    })
    task.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error('本地人像处理未完成，请重试'))
    })
  })
}

export function createPortraitRetouch(database: StudioDatabase, publish: (change: McpWorkspaceChange) => void) {
  let working = false
  return async (input: unknown): Promise<RetouchResult> => {
    const { artworkId, versionId, ...options } = retouchInput.parse(input)
    if (!options.smoothing && !options.brighten && !options.underEyeShadows && !options.cheekTone && !options.dressHighlights) {
      throw new Error('请至少选择一项大于零的调整')
    }
    if (working) throw new Error('正在处理另一张照片，请稍候重试')
    const source = database.getArtworkSource(artworkId, versionId)
    if (!source) throw new Error('找不到指定的图片或版本')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(source.mime)) throw new Error('人像精修支持 PNG、JPEG 和 WebP 照片')
    working = true
    try {
      const { bytes, faceCount, width, height } = await processPortrait({ bytes: Uint8Array.from(source.bytes), options })
      const version = await database.saveArtworkVersion({
        id: randomUUID(), artworkId, createdAt: Date.now(), prompt: source.prompt,
        src: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
      })
      publish({ type: 'artwork_versions_changed', artworkId })
      return { version, sourceVersionId: source.versionId, faceCount, width, height }
    } finally { working = false }
  }
}
