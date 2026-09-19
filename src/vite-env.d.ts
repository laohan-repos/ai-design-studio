/// <reference types="vite/client" />

interface Window {
  studio: {
    listModels(): Promise<import('./types').ModelConfig[]>
    saveModels(models: import('./types').ModelConfig[]): Promise<boolean>
    testModel(model: import('./types').ModelConfig): Promise<import('./types').ModelTestResult>
    listArtworks(): Promise<import('./types').Artwork[]>
    saveArtworks(artworks: import('./types').Artwork[]): Promise<boolean>
    moveArtwork(id: string, x: number, y: number): Promise<boolean>
    generate(payload: import('./types').GeneratePayload): Promise<string[]>
    saveImage(dataUrl: string, name: string): Promise<string | null>
  }
}
