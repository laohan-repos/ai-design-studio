import { contextBridge, ipcRenderer } from 'electron'

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
  generate: (payload: unknown) => ipcRenderer.invoke('image:generate', payload),
  saveImage: (dataUrl: string, name: string) => ipcRenderer.invoke('image:save', dataUrl, name)
})
