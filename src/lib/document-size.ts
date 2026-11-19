export const canvasAnchors = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const
export type CanvasAnchor = typeof canvasAnchors[number]
export type DocumentSizeMode = 'image' | 'canvas'
export type DocumentDimensions = { width: number; height: number }

export const documentSizeLabels = { image: '图像尺寸', canvas: '画布尺寸' } as const
export const photoSizeMaxSide = 16_384
export const photoSizeMaxPixels = 32_000_000

export function canvasResizeOffset(current: DocumentDimensions, next: DocumentDimensions, anchor: CanvasAnchor) {
  const index = canvasAnchors.indexOf(anchor)
  const column = index % 3
  const row = Math.floor(index / 3)
  return {
    x: Math.floor((next.width - current.width) * column / 2),
    y: Math.floor((next.height - current.height) * row / 2)
  }
}
