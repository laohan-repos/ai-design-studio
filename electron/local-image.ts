import { loadImage } from '@napi-rs/canvas'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

const maxBytes = 20 * 1024 * 1024
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function readLocalFile(filePath: string) {
  if (!isAbsolute(filePath) || filePath.startsWith('//') || filePath.startsWith('\\\\') || filePath.includes('\0')) {
    throw new Error('请提供本机图片文件的绝对路径')
  }

  try {
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('指定路径须指向普通图片文件')
      const { size } = stat
      if (size > maxBytes) throw new Error('图片不能超过 20 MB')

      const bytes = Buffer.allocUnsafe(size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== size) throw new Error('读取时文件大小已变化，请重试')
      return bytes.subarray(0, size)
    } finally {
      await file.close()
    }
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case 'ENOENT':
      case 'ENOTDIR': throw new Error('找不到指定的图片文件')
      case 'EPERM':
      case 'EACCES': throw new Error('出图没有读取此文件的权限')
      case 'EISDIR': throw new Error('指定路径须指向普通图片文件')
      default: throw error
    }
  }
}

function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('本地导入支持 PNG、JPEG 和 WebP 图片')
}

export async function readLocalImage(filePath: string) {
  const bytes = await readLocalFile(filePath)
  const mimeType = imageMime(bytes)
  const image = await loadImage(bytes).catch(() => { throw new Error('无法解码图片，文件可能已损坏') })
  const { width: imageWidth, height: imageHeight } = image
  if (!imageWidth || !imageHeight) throw new Error('无法解码图片，文件可能已损坏')
  return {
    filename: basename(filePath), mimeType, imageWidth, imageHeight,
    src: `data:${mimeType};base64,${bytes.toString('base64')}`,
  }
}
