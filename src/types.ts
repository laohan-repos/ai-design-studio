import type { PosterDocument } from './lib/poster'
import type { CanvasGroupingChange } from './lib/canvas-groups'
import type { EditorHistory } from './lib/editor-history'

export type ModelConfig = {
  id: string
  name: string
  provider: 'openai' | 'constreet' | 'compatible'
  taskType: 'text-to-image' | 'image-to-image'
  baseUrl: string
  apiKey: string
  model: string
  proxyEnabled?: boolean
  proxyUrl?: string
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
  groupId?: string | null
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

export type CanvasGeneration = {
  canvasId: string
  modelId?: string
  prompt: string
  size: string
  quality: GeneratePayload['quality']
}

export type GeneratedArtwork = {
  artwork: Artwork
  artworkCount: number
}

export type McpWorkspaceChange =
  | { type: 'canvas_created'; canvas: InfiniteCanvasRecord }
  | { type: 'canvas_renamed'; canvasId: string; name: string; updatedAt: number }
  | { type: 'canvas_deleted'; canvasId: string; nextCanvasId?: string }
  | { type: 'canvas_groups_changed'; result: CanvasGroupingChange }
  | { type: 'artwork_created'; result: GeneratedArtwork }
  | { type: 'artwork_moved'; artworkId: string; canvasId: string; x: number; y: number; updatedAt: number }
  | { type: 'artwork_deleted'; artworkId: string; canvasId: string; artworkCount: number; updatedAt: number; coverSrc?: string }
  | { type: 'artwork_versions_changed'; artworkId: string }
  | { type: 'artwork_version_applied'; viaHistory?: boolean; result: { version: ArtworkVersion; canvasId: string; isCover: boolean; updatedAt: number } }
  | { type: 'poster_updated'; poster: PosterDocument }
  | { type: 'editor_history_changed'; history: EditorHistory; reason: 'edit' | 'navigate' }

export type McpStatus = { running: boolean; url: string; error?: string }

export type ModelTestResult = {
  ok: boolean
  modelFound: boolean
  message: string
  latencyMs?: number
  proxySuggestion?: string
}
