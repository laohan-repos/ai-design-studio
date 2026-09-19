import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('studio', {
  listModels: () => ipcRenderer.invoke('models:list'),
  saveModels: (models: unknown) => ipcRenderer.invoke('models:save', models),
  testModel: (model: unknown) => ipcRenderer.invoke('model:test', model),
  listArtworks: () => ipcRenderer.invoke('artworks:list'),
  saveArtworks: (artworks: unknown) => ipcRenderer.invoke('artworks:save', artworks),
  moveArtwork: (id: string, x: number, y: number) => ipcRenderer.invoke('artworks:move', id, x, y),
  generate: (payload: unknown) => ipcRenderer.invoke('image:generate', payload),
  saveImage: (dataUrl: string, name: string) => ipcRenderer.invoke('image:save', dataUrl, name)
})
