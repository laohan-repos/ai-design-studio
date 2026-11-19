/// <reference types="vite/client" />
/// <reference types="electron-vite/node" />

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
    saveArtworkVersion(version: Omit<import('./types').ArtworkVersion, 'versionNumber' | 'isCurrent'>): Promise<import('./types').ArtworkVersion>
    applyArtworkVersion(artworkId: string, versionId: string): Promise<import('./types').ArtworkVersion | undefined>
    retouchPortrait(input: import('./lib/retouch').RetouchInput): Promise<import('./lib/retouch').RetouchResult>
    generate(payload: import('./types').GeneratePayload): Promise<string[]>
    generateCanvasArtwork(input: import('./types').CanvasGeneration): Promise<import('./types').GeneratedArtwork>
    openPoster(id: string, versionId?: string): Promise<import('./lib/poster').PosterDocument>
    editPoster(input: { artworkId: string; revision: number; operations: import('./lib/poster').PosterOperation[] }): Promise<import('./lib/poster').PosterDocument>
    undoPoster(id: string, revision: number): Promise<import('./lib/poster').PosterDocument>
    previewPoster(id: string, size?: import('./lib/poster').PosterOutput['size']): Promise<import('./lib/poster').PosterImage>
    getPosterSource(id: string): Promise<string>
    exportPoster(id: string, options: import('./lib/poster').PosterOutput): Promise<{ path: string; width: number; height: number; revision: number }>
    getMcpStatus(): Promise<import('./types').McpStatus>
    setMcpEnabled(enabled: boolean): Promise<import('./types').McpStatus>
    copyMcpConnection(format: 'codex' | 'token'): Promise<void>
    onMcpWorkspaceChanged(listener: (change: import('./types').McpWorkspaceChange) => void): () => void
    saveImage(dataUrl: string, name: string): Promise<string | null>
  }
}
