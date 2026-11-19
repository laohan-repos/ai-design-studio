import type { CanvasGeneration, GeneratedArtwork, GeneratePayload } from '../src/types'
import type { StudioDatabase } from './database'

export function prepareCanvasGeneration(
  database: StudioDatabase,
  generateImage: (payload: GeneratePayload) => Promise<string[]>,
  input: CanvasGeneration
): () => Promise<GeneratedArtwork> {
  const { canvasId, modelId, size, quality } = input
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('请填写提示词')
  if (database.getCanvasArtworkCount(canvasId) === undefined) throw new Error('画布不存在')

  const config = database.listModels().find(model => model.taskType === 'text-to-image' && (!modelId || model.id === modelId))
  if (!config?.apiKey.trim() || !config.model.trim()) throw new Error('请先在应用中保存可用的文生图模型和 API Key')

  return async () => {
    if (database.getCanvasArtworkCount(canvasId) === undefined) throw new Error('目标画布已删除')
    const [src] = await generateImage({ config, prompt, size, quality, count: 1 })
    return database.addArtwork({ canvasId, src, prompt })
  }
}
