import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { productName } from '../package.json'
import type { ArtworkVersion, CanvasGeneration, GeneratedArtwork, McpWorkspaceChange } from '../src/types'
import type { StudioDatabase } from './database'
import { posterEdit, posterId, posterOutput } from '../src/lib/poster'
import type { PosterService } from './poster-service'
import { retouchInput, type RetouchResult } from '../src/lib/retouch'

type Job = {
  jobId: string
  canvasId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  artworkId?: string
  error?: string
}

type JobEntry = { job: Job; requestId?: string; inputKey: string }
type PrepareGeneration = (input: CanvasGeneration) => () => Promise<GeneratedArtwork>

const id = z.string().trim().min(1).max(128)
const canvasName = z.string().trim().min(1).max(100)
const readOnly = { readOnlyHint: true, openWorldHint: false }
const localUpdate = { destructiveHint: false, openWorldHint: false }
const localDelete = { destructiveHint: true, openWorldHint: false }
const confirm = z.literal(true).describe('用户明确同意永久删除指定对象后才可传入 true')
const success = (data: Record<string, unknown>) => ({
  structuredContent: data,
  content: [{ type: 'text' as const, text: JSON.stringify(data) }]
})

export function createStudioMcpTools(
  database: StudioDatabase,
  prepareGeneration: PrepareGeneration,
  publish: (change: McpWorkspaceChange) => void,
  posters: PosterService,
  portrait: { retouch(input: unknown): Promise<RetouchResult>; applyVersion(artworkId: string, versionId: string): Promise<ArtworkVersion> }
) {
  const jobs = new Map<string, JobEntry>()
  let queue = Promise.resolve()
  let pending = 0

  function submitGeneration(input: CanvasGeneration, requestId?: string): Job {
    const inputKey = JSON.stringify(input)
    const previous = requestId && [...jobs.values()].find(entry => entry.requestId === requestId)
    if (previous) {
      if (previous.inputKey !== inputKey) throw new Error('该 requestId 已用于不同的生图参数')
      return previous.job
    }
    if (pending >= 8) throw new Error('生图任务队列已满，请等待已有任务完成')

    const generate = prepareGeneration(input)
    const job: Job = { jobId: randomUUID(), canvasId: input.canvasId, status: 'queued' }
    jobs.set(job.jobId, { job, requestId, inputKey })
    pending++
    queue = queue.then(async () => {
      job.status = 'running'
      try {
        const result = await generate()
        job.artworkId = result.artwork.id
        job.status = 'completed'
        publish({ type: 'artwork_created', result })
      } catch {
        job.status = 'failed'
        job.error = database.getCanvasArtworkCount(job.canvasId) === undefined
          ? '目标画布已删除，图片无法保存。'
          : '图片生成或保存失败，请在应用里检查文生图连接和本地存储。'
      } finally {
        pending--
        for (const [jobId, entry] of jobs) {
          if (jobs.size <= 100) break
          if (entry.job.status === 'completed' || entry.job.status === 'failed') jobs.delete(jobId)
        }
      }
    })
    return job
  }

  return () => {
    const server = new McpServer({ name: 'ai-design-studio', title: productName, version: '1.0.0' }, {
      instructions: '先列出画布并按 ID 选择目标。做海报时先打开海报，再按最新 revision 编辑，可预览或导出。generate_image 会调用已配置的文生图模型，提交后请用 get_image_job 查询原任务。'
    })
    server.registerTool('list_canvases', {
      description: '列出本机应用的画布、画布 ID 和作品数量。', annotations: readOnly
    }, () => success({ canvases: database.listCanvases(false) }))

    server.registerTool('create_canvas', {
      description: '新建一个空画布，返回画布 ID。已有合适画布时可直接使用它的 ID。',
      inputSchema: { name: canvasName }, annotations: localUpdate
    }, async ({ name }) => {
      const canvas = await database.createCanvas(randomUUID(), name)
      publish({ type: 'canvas_created', canvas })
      return success({ canvas })
    })

    server.registerTool('rename_canvas', {
      description: '修改指定画布的名称。先用 list_canvases 确认画布 ID。',
      inputSchema: { canvasId: id, name: canvasName }, annotations: localUpdate
    }, async ({ canvasId, name }) => {
      const updatedAt = await database.renameCanvas(canvasId, name)
      publish({ type: 'canvas_renamed', canvasId, name, updatedAt })
      return success({ canvasId, name, updatedAt })
    })

    server.registerTool('delete_canvas', {
      description: '永久删除指定画布及其中所有图片、历史版本和分层海报。先用 list_canvases 确认 ID 和作品数量，经用户同意后调用。',
      inputSchema: { canvasId: id, confirm }, annotations: localDelete
    }, async ({ canvasId }) => {
      const { artworkCount, nextCanvasId } = await database.deleteCanvas(canvasId)
      publish({ type: 'canvas_deleted', canvasId, nextCanvasId })
      return success({ canvasId, deleted: true, artworkCount })
    })

    server.registerTool('list_artworks', {
      description: '列出指定画布的图片 ID、提示词和位置，支持分页。',
      inputSchema: { canvasId: id, limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0) },
      annotations: readOnly
    }, ({ canvasId, limit, offset }) => {
      const total = database.getCanvasArtworkCount(canvasId)
      if (total === undefined) throw new Error('画布不存在')
      const artworks = database.listArtworkMetadata(canvasId, limit, offset)
      return success({ canvasId, artworks, total, nextOffset: offset + artworks.length < total ? offset + artworks.length : null })
    })

    server.registerTool('move_artwork', {
      description: '移动图片在所属画布上的位置。x、y 是图片左上角在画布坐标系中的绝对坐标，允许负值。可从 list_artworks 查看原坐标。',
      inputSchema: { artworkId: id, x: z.number().finite(), y: z.number().finite() }, annotations: localUpdate
    }, async ({ artworkId, x, y }) => {
      const result = await database.moveArtwork(artworkId, x, y)
      publish({ type: 'artwork_moved', ...result })
      return success(result)
    })

    server.registerTool('delete_artwork', {
      description: '永久删除指定图片及其历史版本和分层海报。先用 list_artworks 确认图片 ID，经用户同意后调用。',
      inputSchema: { artworkId: id, confirm }, annotations: localDelete
    }, async ({ artworkId }) => {
      const result = await database.deleteArtwork(artworkId)
      publish({ type: 'artwork_deleted', ...result })
      return success({ artworkId, canvasId: result.canvasId, deleted: true, artworkCount: result.artworkCount })
    })

    server.registerTool('generate_image', {
      description: '用应用保存的文生图模型生成一张图片并添加到指定画布。返回任务 ID，可能产生模型费用。重试提交时请使用同一个 requestId。',
      inputSchema: {
        canvasId: id,
        prompt: z.string().trim().min(1).max(32000),
        size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
        quality: z.enum(['low', 'medium', 'high']).default('medium'),
        requestId: id.optional().describe('同一次提交重试时复用此 ID')
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    }, ({ canvasId, prompt, size, quality, requestId }) => success({ ...submitGeneration({ canvasId, prompt, size, quality }, requestId) }))

    server.registerTool('get_image_job', {
      description: '查询生图任务状态。成功后返回已保存的图片 ID。',
      inputSchema: { jobId: id }, annotations: readOnly
    }, ({ jobId }) => {
      const entry = jobs.get(jobId)
      if (!entry) throw new Error('任务不存在。任务状态仅在当前应用进程中保留。')
      return success({ ...entry.job })
    })
    registerPosterTools(server, posters)
    server.registerTool('retouch_portrait', {
      description: '按 Agent 提供的策略在本机精调照片。先用 get_artwork_preview 看图，再选择适合的磨皮和提亮强度，建议自然磨皮从 20–40 开始。可按原图归一化坐标框选某张脸。结果保存为新版本，生成后可用 versionId 预览或手动应用。',
      inputSchema: retouchInput.extend({ smoothing: retouchInput.shape.smoothing.unwrap() }),
      annotations: { destructiveHint: false, openWorldHint: false }
    }, async input => {
      const { version, ...metadata } = await portrait.retouch(input)
      return success({ artworkId: version.artworkId, versionId: version.id, versionNumber: version.versionNumber, ...metadata })
    })
    server.registerTool('list_artwork_versions', {
      description: '列出指定图片的原图及所有编辑版本，返回可预览或应用的版本 ID。',
      inputSchema: { artworkId: id }, annotations: readOnly
    }, ({ artworkId }) => success({ artworkId, versions: database.listArtworkVersionMetadata(artworkId) }))
    server.registerTool('apply_artwork_version', {
      description: '将指定版本显示在画布上。原图和其他版本仍可切换。',
      inputSchema: { artworkId: id, versionId: id }, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ artworkId, versionId }) => {
      const version = await portrait.applyVersion(artworkId, versionId)
      return success({ artworkId, versionId, versionNumber: version.versionNumber })
    })
    return server
  }
}

function registerPosterTools(server: McpServer, posters: PosterService) {
  const localEdit = { destructiveHint: false, openWorldHint: false }
  const target = { artworkId: posterId }

  server.registerTool('get_artwork_preview', {
    description: '返回原图的 PNG 缩略图。绘制蒙版前，传入 open_poster 返回的 sourceVersionId 查看海报绑定的原图版本。',
    inputSchema: { ...target, versionId: posterId.optional() }, annotations: readOnly
  }, async ({ artworkId, versionId }) => {
    const bytes = await posters.previewSource(artworkId, versionId)
    return { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] }
  })

  server.registerTool('open_poster', {
    description: '创建或打开某张图片的可编辑海报，返回背景、主体蒙版、阴影、文字图层及 revision。versionId 只在首次创建时选择源版本。',
    inputSchema: { ...target, versionId: posterId.optional() }, annotations: localEdit
  }, async ({ artworkId, versionId }) => success({ poster: await posters.open(artworkId, versionId) }))

  server.registerTool('edit_poster', {
    description: '使用最新 revision 批量修改海报图层。位置、字号和尺寸以画布像素计。抠图用 edge_color 去除从边缘连通的近似纯色，或用 polygon 传入相对于整张原图的 0–1 坐标。upsert_text 用相同 id 修改原文字层。',
    inputSchema: posterEdit, annotations: localEdit
  }, async input => success({ poster: await posters.edit(input) }))

  server.registerTool('undo_poster_edit', {
    description: '使用当前 revision 撤销上一次海报编辑，返回新 revision。',
    inputSchema: { ...target, revision: z.number().int().min(1) }, annotations: localEdit
  }, async ({ artworkId, revision }) => success({ poster: await posters.undo(artworkId, revision) }))

  server.registerTool('preview_poster', {
    description: '预览海报图层合成结果，可查看方图或竖图排版。返回视觉模型可查看的 PNG 和目标尺寸。',
    inputSchema: { ...target, size: posterOutput.shape.size }, annotations: readOnly
  }, async ({ artworkId, size }) => {
    const { src, ...metadata } = await posters.preview(artworkId, size)
    return { structuredContent: metadata, content: [{ type: 'image', mimeType: 'image/png', data: src.slice(src.indexOf(',') + 1) }] }
  })

  server.registerTool('export_poster', {
    description: '按当前尺寸、1080×1080 方图或 1080×1620 竖图导出 PNG/JPEG 到下载目录下的 AI设计助手 文件夹，返回本机文件路径。',
    inputSchema: { ...target, ...posterOutput.shape, name: z.string().trim().min(1).max(70).optional() }, annotations: localEdit
  }, async ({ artworkId, size, format, name }) => success(await posters.export(artworkId, { size, format }, name)))
}
