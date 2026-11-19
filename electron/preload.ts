import { contextBridge, ipcRenderer } from 'electron'
import type { CanvasGeneration, McpWorkspaceChange } from '../src/types'
import type { PosterOperation, PosterOutput } from '../src/lib/poster'
import type { RetouchInput } from '../src/lib/retouch'

contextBridge.exposeInMainWorld('studio', {
  listModels: () => ipcRenderer.invoke('models:list'),
  saveModels: (models: unknown) => ipcRenderer.invoke('models:save', models),
  testModel: (model: unknown) => ipcRenderer.invoke('model:test', model),
  listCanvases: () => ipcRenderer.invoke('canvases:list'),
  createCanvas: (id: string, name: string) => ipcRenderer.invoke('canvases:create', id, name),
  renameCanvas: (id: string, name: string) => ipcRenderer.invoke('canvases:rename', id, name),
  listArtworks: (canvasId: string) => ipcRenderer.invoke('artworks:list', canvasId),
  saveArtworks: (artworks: unknown) => ipcRenderer.invoke('artworks:save', artworks),
  moveArtwork: (id: string, x: number, y: number) => ipcRenderer.invoke('artworks:move', id, x, y),
  deleteArtwork: (id: string) => ipcRenderer.invoke('artworks:delete', id),
  listArtworkVersions: (artworkId: string) => ipcRenderer.invoke('artwork-versions:list', artworkId),
  saveArtworkVersion: (version: unknown) => ipcRenderer.invoke('artwork-versions:save', version),
  applyArtworkVersion: (artworkId: string, versionId: string) => ipcRenderer.invoke('artwork-versions:apply', artworkId, versionId),
  retouchPortrait: (input: RetouchInput) => ipcRenderer.invoke('portrait:retouch', input),
  generate: (payload: unknown) => ipcRenderer.invoke('image:generate', payload),
  generateCanvasArtwork: (input: CanvasGeneration) => ipcRenderer.invoke('canvas:generate-artwork', input),
  openPoster: (id: string, versionId?: string) => ipcRenderer.invoke('poster:open', id, versionId),
  editPoster: (input: { artworkId: string; revision: number; operations: PosterOperation[] }) => ipcRenderer.invoke('poster:edit', input),
  undoPoster: (id: string, revision: number) => ipcRenderer.invoke('poster:undo', id, revision),
  previewPoster: (id: string, size?: PosterOutput['size']) => ipcRenderer.invoke('poster:preview', id, size),
  getPosterSource: (id: string) => ipcRenderer.invoke('poster:source', id),
  exportPoster: (id: string, options: PosterOutput) => ipcRenderer.invoke('poster:export', id, options),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  setMcpEnabled: (enabled: boolean) => ipcRenderer.invoke('mcp:set-enabled', enabled),
  copyMcpConnection: (format: 'codex' | 'token') => ipcRenderer.invoke('mcp:copy-connection', format),
  onMcpWorkspaceChanged: (listener: (change: McpWorkspaceChange) => void) => {
    const forward = (_event: Electron.IpcRendererEvent, change: McpWorkspaceChange) => listener(change)
    ipcRenderer.on('mcp:workspace-changed', forward)
    return () => { ipcRenderer.removeListener('mcp:workspace-changed', forward) }
  },
  saveImage: (dataUrl: string, name: string) => ipcRenderer.invoke('image:save', dataUrl, name)
})
