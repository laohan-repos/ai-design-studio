/// <reference types="vite/client" />

interface Window {
  studio: {
    listModels(): Promise<import('./types').ModelConfig[]>
    saveModels(models: import('./types').ModelConfig[]): Promise<boolean>
    testModel(model: import('./types').ModelConfig): Promise<import('./types').ModelTestResult>
    listCanvases(): Promise<import('./types').InfiniteCanvasRecord[]>
    createCanvas(id: string, name: string): Promise<import('./types').InfiniteCanvasRecord>
    renameCanvas(id: string, name: string): Promise<number>
    listArtworks(canvasId: string): Promise<import('./types').Artwork[]>
    saveArtworks(artworks: import('./types').Artwork[]): Promise<boolean>
    moveArtwork(id: string, x: number, y: number): Promise<boolean>
    deleteArtwork(id: string): Promise<boolean>
    listArtworkVersions(artworkId: string): Promise<import('./types').ArtworkVersion[]>
    saveArtworkVersion(version: Omit<import('./types').ArtworkVersion, 'isCurrent'>): Promise<boolean>
    applyArtworkVersion(artworkId: string, versionId: string): Promise<import('./types').ArtworkVersion | undefined>
    generate(payload: import('./types').GeneratePayload): Promise<string[]>
    saveImage(dataUrl: string, name: string): Promise<string | null>
  }
}
