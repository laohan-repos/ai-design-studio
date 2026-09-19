export type ModelConfig = {
  id: string
  name: string
  provider: 'constreet' | 'compatible'
  taskType: 'text-to-image' | 'image-to-image'
  baseUrl: string
  apiKey: string
  model: string
}

export type GeneratePayload = {
  config: ModelConfig
  prompt: string
  size: string
  count: number
  quality: 'low' | 'medium' | 'high'
  image?: string
}

export type Adjustments = { brightness: number; contrast: number; saturation: number; rotation: number; flipX: boolean; flipY: boolean }

export type Artwork = {
  id: string
  canvasId: string
  src: string
  prompt: string
  createdAt: number
  x: number
  y: number
  width: number
}

export type ArtworkVersion = {
  id: string
  artworkId: string
  src: string
  prompt: string
  createdAt: number
  versionNumber: number
  isCurrent: boolean
}

export type InfiniteCanvasRecord = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  artworkCount: number
  coverSrc?: string
}

export type ModelTestResult = {
  ok: boolean
  modelFound: boolean
  message: string
  latencyMs?: number
}
