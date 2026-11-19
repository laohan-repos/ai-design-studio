import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { productName } from '../package.json'
import type { ArtworkVersion, CanvasGeneration, GeneratedArtwork, McpWorkspaceChange } from '../src/types'
import type { StudioDatabase } from './database'
import { posterEdit, posterId, posterMaskPreviewInput, posterOutput } from '../src/lib/poster'
import { posterPixelInput, posterPixelPaintInput, posterRegionInput, type PosterRegionInput, type PosterRegionPreview } from '../src/lib/poster-pixels'
import type { PosterService } from './poster-service'
import { retouchInput, type RetouchResult } from '../src/lib/retouch'
import { inspectColorsInput, inspectPhotoInput, photoRecipeInput, previewMaskInput, previewPhotoEditInput, suggestPhotoCropsInput } from '../src/lib/photo-edits'
import type { describeEditorContext, PhotoEdits } from './photo-edits'
import { readLocalImage } from './local-image'
import { assignArtworksToGroupInput, createArtworkGroupInput, deleteArtworkGroupInput, listArtworkGroupsInput,
  renameArtworkGroupInput, reorderArtworkGroupsInput, type ArtworkGroupChangeInput, type CanvasGroupingChange } from '../src/lib/canvas-groups'

type Job = {
  jobId: string
  canvasId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  artworkId?: string
  error?: string
}

type JobEntry = { job: Job; requestId?: string; inputKey: string }
type PrepareGeneration = (input: CanvasGeneration) => () => Promise<GeneratedArtwork>
type ChangeArtworkGroups = (input: ArtworkGroupChangeInput) => Promise<CanvasGroupingChange>

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

type RedrawInput = Extract<PosterRegionInput, { mode: 'redraw' }>
type RegionJob = {
  jobId: string
  requestId?: string
  inputKey: string
  status: 'running' | 'completed' | 'failed'
  preview?: PosterRegionPreview
  error?: string
  finishedAt?: number
}

const regionJobLimit = 8
const regionJobLifetime = 5 * 60_000

function createRegionJobs(posters: PosterService) {
  const jobs = new Map<string, RegionJob>()

  function prune() {
    const now = Date.now()
    for (const [jobId, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt >= regionJobLifetime) jobs.delete(jobId)
    }
  }

  function submit(input: RedrawInput, requestId?: string) {
    prune()
    const inputKey = JSON.stringify(input)
    const previous = requestId && [...jobs.values()].find(job => job.requestId === requestId)
    if (previous) {
      if (previous.inputKey !== inputKey) throw new Error('该 requestId 已用于不同的重绘参数')
      return { jobId: previous.jobId, status: previous.status }
    }
    if ([...jobs.values()].filter(job => job.status === 'running').length >= 2) {
      throw new Error('正在生成其他局部重绘预览，请稍候重试')
    }
    if (jobs.size >= regionJobLimit) {
      const oldest = [...jobs.values()].find(job => job.status !== 'running')
      if (oldest) jobs.delete(oldest.jobId)
    }
    const job: RegionJob = { jobId: randomUUID(), requestId, inputKey, status: 'running' }
    jobs.set(job.jobId, job)
    void posters.previewLayerRegion(input).then(preview => {
      job.preview = preview
      job.status = 'completed'
    }, () => {
      job.error = '局部重绘失败，请检查图生图连接、选区和海报版本后重试。'
      job.status = 'failed'
    }).finally(() => { job.finishedAt = Date.now() })
    return { jobId: job.jobId, status: job.status }
  }

  function get(jobId: string) {
    prune()
    const job = jobs.get(jobId)
    if (!job) throw new Error('找不到该局部重绘任务，任务仅在当前进程内短期保留')
    return job
  }

  return { submit, get }
}

export function createStudioMcpTools(
  database: StudioDatabase,
  prepareGeneration: PrepareGeneration,
  publish: (change: McpWorkspaceChange) => void,
  posters: PosterService,
  portrait: { retouch(input: unknown): Promise<RetouchResult>; applyVersion(artworkId: string, versionId: string): Promise<ArtworkVersion> },
  photo: { photoEdits: PhotoEdits; editorContext: () => ReturnType<typeof describeEditorContext> },
  changeArtworkGroups: ChangeArtworkGroups
) {
  const jobs = new Map<string, JobEntry>()
  let queue = Promise.resolve()
  let pending = 0
  const regionJobs = createRegionJobs(posters)

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
      instructions: '用户说“这张”时用 get_editor_context 确定目标；按名称可用 list_canvases 和 list_artworks。整理图片先用 list_artwork_groups 查现有分组，按任务自定名称并优先复用合适的分组，再批量归组。修图先看指定版本和局部，再用 preview_photo_edit 返回对比。黄金构图先看图定位重点，通过 suggest_artwork_crop 给出裁法。用户要先看对比时停在预览，另存和应用各有独立工具。做海报时先打开海报，再按最新 revision 编辑。像素编辑先用 inspect_poster_layer_pixels 看目标图层。用 preview_poster_layer_region 预览移除或提交重绘，再用 get_poster_region_job 查询重绘预览。确认后用 save_poster_layer_region 应用。generate_image 调用已配置的文生图模型，用 get_image_job 查询任务。'
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
      description: '列出指定画布的图片 ID、提示词、位置和分组。可分页并按分组筛选。',
      inputSchema: { canvasId: id, limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0),
        groupId: id.nullable().optional().describe('省略时列出所有图片，传 null 只列未分组图片') },
      annotations: readOnly
    }, ({ canvasId, limit, offset, groupId }) => {
      if (groupId && !database.listArtworkGroups(canvasId).groups.some(group => group.id === groupId)) throw new Error('分组不在指定画布中')
      const total = database.getCanvasArtworkCount(canvasId, groupId)
      if (total === undefined) throw new Error('画布不存在')
      const artworks = database.listArtworkMetadata(canvasId, limit, offset, groupId)
      return success({ canvasId, artworks, total, nextOffset: offset + artworks.length < total ? offset + artworks.length : null })
    })
    registerArtworkGroupTools(server, database, changeArtworkGroups)

    server.registerTool('import_local_image', {
      description: '将本机的 PNG、JPEG 或 WebP 图片导入指定画布，最大 20 MB。先用 list_canvases 确认画布 ID，再传入用户指定的本机绝对路径。返回图片 ID 和像素尺寸。',
      inputSchema: {
        canvasId: id,
        filePath: z.string().min(1).max(4096).describe('图片在运行出图的电脑上的绝对文件路径')
      },
      annotations: localUpdate
    }, async ({ canvasId, filePath }) => {
      if (database.getCanvasArtworkCount(canvasId) === undefined) throw new Error('画布不存在')
      const { src, filename, ...metadata } = await readLocalImage(filePath)
      const result = await database.addArtwork({ canvasId, src, prompt: filename })
      publish({ type: 'artwork_created', result })
      return success({ canvasId, artworkId: result.artwork.id, filename, ...metadata })
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
    registerPosterTools(server, database, posters, regionJobs)
    registerPhotoTools(server, photo.photoEdits, photo.editorContext)
    server.registerTool('retouch_portrait', {
      description: '先用 get_artwork_preview 看指定版本，再在本机做自然磨皮、提亮、减轻眼下阴影、均匀两颊肤色或压白纱高光。各项可单独使用。可框选一张脸；压白纱高光须沿白纱圈选归一化多边形。结果另存版本，返回 versionId 用于预览。',
      inputSchema: retouchInput.extend({ smoothing: retouchInput.shape.smoothing.unwrap().default(0) }),
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

function registerArtworkGroupTools(server: McpServer, database: StudioDatabase, change: ChangeArtworkGroups) {
  server.registerTool('list_artwork_groups', {
    description: '按顺序列出指定画布的分组及每组图片数，包含未分组的图片数量。',
    inputSchema: listArtworkGroupsInput, annotations: readOnly,
  }, ({ canvasId }) => success(database.listArtworkGroups(canvasId)))

  server.registerTool('create_artwork_group', {
    description: '在指定画布新建一个空分组，返回 groupId。分组名由用户或 Agent 按任务决定。',
    inputSchema: createArtworkGroupInput, annotations: localUpdate,
  }, async input => success(await change({ type: 'create', ...input })))

  server.registerTool('rename_artwork_group', {
    description: '修改指定画布内某个分组的名称。',
    inputSchema: renameArtworkGroupInput, annotations: { ...localUpdate, idempotentHint: true },
  }, async input => success(await change({ type: 'rename', ...input })))

  server.registerTool('reorder_artwork_groups', {
    description: '调整画布内分组的顺序。先查询分组，再按期望顺序提交全部分组 ID。',
    inputSchema: reorderArtworkGroupsInput, annotations: { ...localUpdate, idempotentHint: true },
  }, async input => success(await change({ type: 'reorder', ...input })))

  server.registerTool('delete_artwork_group', {
    description: '删除指定分组，组内全部图片回到未分组并保留各自的历史版本。',
    inputSchema: deleteArtworkGroupInput, annotations: localDelete,
  }, async input => success(await change({ type: 'delete', ...input })))

  server.registerTool('assign_artworks_to_group', {
    description: '批量把指定画布中的图片放入一个分组。groupId 传 null 时，将这些图片移回未分组。',
    inputSchema: assignArtworksToGroupInput, annotations: { ...localUpdate, idempotentHint: true },
  }, async input => success(await change({ type: 'assign', ...input })))
}

function photoImage(src: string) {
  return { type: 'image' as const, mimeType: 'image/png', data: src.slice(src.indexOf(',') + 1) }
}

function registerPhotoTools(server: McpServer, photo: PhotoEdits, editorContext: () => ReturnType<typeof describeEditorContext>) {
  server.registerTool('get_editor_context', {
    description: '读取出图当前画布、已选图片和正在编辑的版本。优先采用编辑器或单选图片作为目标；有多个候选时结合用户指代确认。', annotations: readOnly
  }, () => success(editorContext()))

  server.registerTool('inspect_artwork', {
    description: '查看指定版本的全图或局部高清裁切。region 使用整张原图的 0–1 坐标；元数据返回原图尺寸和裁切像素位置。',
    inputSchema: inspectPhotoInput, annotations: readOnly
  }, async input => {
    const { src, ...metadata } = await photo.inspect(input)
    return { structuredContent: metadata, content: [photoImage(src)] }
  })

  server.registerTool('inspect_photo_colors', {
    description: '读取指定照片版本的亮度与 RGB 直方图，并按需对指定区域取样。samples 的坐标以整张源图为准。RGB、亮度取值 0–255，高光和暗部剪切以百分比返回。可先从肤色和白色布料取样，再决定调色策略。',
    inputSchema: inspectColorsInput, annotations: readOnly
  }, async input => success(await photo.inspectColors(input)))

  server.registerTool('suggest_artwork_crop', {
    description: '在指定版本上按 38.2% 与 61.8% 黄金网格推荐裁剪。先查看图，设定输出比例、归一化重点位置和必须保留的区域。返回最多两个裁剪框和效果图；空列表表示比例与保留区域冲突。将候选 box 交给 preview_photo_edit 的 crop 操作可生成可另存的预览。',
    inputSchema: suggestPhotoCropsInput, annotations: readOnly
  }, async input => {
    const { candidates, ...metadata } = await photo.suggestCrops(input)
    return {
      structuredContent: { ...metadata, candidates: candidates.map(({ overlay: _guide, preview: _preview, ...candidate }) => candidate) },
      content: candidates.length ? candidates.flatMap((item, index) => [
        { type: 'text' as const, text: `裁法 ${index + 1} · ${item.box.width} × ${item.box.height} · 第一张为原图裁剪框，第二张为裁后效果` },
        photoImage(item.overlay), photoImage(item.preview)
      ]) : [{ type: 'text' as const, text: '当前比例无法完整保留指定区域，可以换比例或调整保护范围。' }]
    }
  })

  server.registerTool('get_photo_edit_recipe', {
    description: '读取已经另存的调色或裁剪版本使用的配方，包含底图 versionId、操作和裁剪框。可以从底图调整配方并重新预览。',
    inputSchema: photoRecipeInput, annotations: readOnly
  }, input => success({ recipe: photo.recipe(input) }))

  server.registerTool('preview_photo_mask', {
    description: '在源图上叠加显示局部修图选区。支持矩形、椭圆、多边形和笔刷，include 加选，exclude 减选保护，feather 羽化。include 取空数组时先选整图再扣除保护区域。所有坐标相对于整张源图。',
    inputSchema: previewMaskInput, annotations: readOnly
  }, async input => {
    const { src, ...metadata } = await photo.previewMask(input)
    return { structuredContent: metadata, content: [photoImage(src)] }
  })

  server.registerTool('preview_photo_edit', {
    description: '按顺序执行调色、纹理、点修、克隆和几何编辑。裁剪（crop）可带顺时针拉直角度 angle，box 使用旋转后同尺寸画面的像素坐标。resize 缩放图像，canvas_size 按 anchor 扩展或裁切边缘。几何操作须放在最后。返回预览和临时 draftId。',
    inputSchema: previewPhotoEditInput, annotations: localUpdate
  }, async input => {
    const { before, after, ...metadata } = await photo.preview(input)
    return { structuredContent: metadata, content: [
      { type: 'text' as const, text: metadata.cropAngle ? '拉直后的裁剪框' : metadata.cropBox ? '原图上的裁剪框' : metadata.outputSize ? '尺寸调整前' : '修图前' }, photoImage(before),
      { type: 'text' as const, text: metadata.cropBox ? '裁剪后' : metadata.outputSize ? '尺寸调整后' : '修图后' }, photoImage(after)
    ] }
  })

  server.registerTool('save_photo_edit_version', {
    description: '将已预览的 draftId 另存为图片版本，返回 versionId。用户确认应用到画布时再调用 apply_artwork_version。',
    inputSchema: { draftId: id }, annotations: { ...localUpdate, idempotentHint: true }
  }, async ({ draftId }) => success(await photo.save(draftId)))
}

function registerPosterTools(server: McpServer, database: StudioDatabase, posters: PosterService, regionJobs: ReturnType<typeof createRegionJobs>) {
  const localEdit = { destructiveHint: false, openWorldHint: false }
  const target = { artworkId: posterId }

  server.registerTool('get_editor_history', {
    description: '读取指定图片的编辑时间线、当前 cursor 和历史 revision。时间线也记录图层变换、蒙版、尺寸、像素笔画和局部重绘。',
    inputSchema: target, annotations: readOnly
  }, ({ artworkId }) => success({ history: posters.getEditorHistory(artworkId) }))

  server.registerTool('navigate_editor_history', {
    description: '使用 get_editor_history 返回的历史 revision 跳到指定步骤。cursor 从 0 开始，向前或向后跳转可重做或撤销。',
    inputSchema: { ...target, revision: z.number().int().min(1), cursor: z.number().int().min(0) }, annotations: localEdit
  }, async ({ artworkId, revision, cursor }) => success({ history: await posters.navigateEditorHistory(artworkId, revision, cursor) }))

  server.registerTool('get_artwork_preview', {
    description: '返回原图的 PNG 缩略图。绘制蒙版前，传入 open_poster 返回的 sourceVersionId 查看海报绑定的原图版本。',
    inputSchema: { ...target, versionId: posterId.optional() }, annotations: readOnly
  }, async ({ artworkId, versionId }) => {
    const bytes = await posters.previewSource(artworkId, versionId)
    return { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] }
  })

  server.registerTool('open_poster', {
    description: '创建或打开某张图片的可编辑海报，返回背景、主体蒙版、阴影、图片和文字图层、从底到顶的 layerOrder 及 revision。versionId 只在首次创建时选择主体源版本。',
    inputSchema: { ...target, versionId: posterId.optional() }, annotations: localEdit
  }, async ({ artworkId, versionId }) => success({ poster: await posters.open(artworkId, versionId) }))

  server.registerTool('edit_poster', {
    description: '使用海报最新 revision 批量编辑。set_size 缩放排版，set_canvas_size 按 anchor 调整边缘并保持图层大小。set_image 支持位置、宽高、旋转和不透明度，主体拉伸使用 set_subject 的 stretch。add_image 将图片置于顶层，reorder_layers 传入从底到顶的全部前景图层 ID。set_layer_mask 创建蒙版、从选区转换或移除蒙版，paint_layer_mask 用 hide 和 restore 修边。set_mask 支持主体的纯色抠图或多边形描边。',
    inputSchema: posterEdit, annotations: localEdit
  }, async input => success({ poster: await posters.edit(input) }))

  server.registerTool('list_image_edit_models', {
    description: '列出已配置的图生图模型的 ID、名称、服务商和模型标识。局部重绘的 modelId 使用其中返回的 id。',
    annotations: readOnly
  }, () => success({ models: database.listModels()
    .filter(model => model.taskType === 'image-to-image' && model.apiKey.trim() && model.model.trim())
    .map(({ id, name, provider, model }) => ({ id, name, provider, model })) }))

  server.registerTool('inspect_poster_layer_pixels', {
    description: '查看当前图层的像素预览及原始像素尺寸。先用 open_poster 读取最新 revision。layerId 可用 subject、image:<图层 ID> 或图片 background。坐标相对于未变换的图层。',
    inputSchema: posterPixelInput, annotations: readOnly
  }, async input => {
    const { src, ...metadata } = await posters.inspectLayerPixels(input)
    return { structuredContent: metadata, content: [photoImage(src)] }
  })

  server.registerTool('preview_poster_layer_mask', {
    description: '查看指定图片图层的当前像素及蒙版透明度。第一张图为图层像素，第二张图的透明区域表示被蒙版隐藏的位置。',
    inputSchema: posterMaskPreviewInput, annotations: readOnly
  }, async ({ artworkId, layerId, revision }) => {
    const { source, mask, ...metadata } = await posters.previewLayerMask(artworkId, layerId, revision)
    return { structuredContent: metadata, content: [photoImage(source), photoImage(mask)] }
  })

  server.registerTool('paint_poster_layer_pixels', {
    description: '在当前图层提交一笔画笔、橡皮擦或连续仿制图章。points 是相对于整层原始像素的连续 0–1 坐标，radius 相对于短边。图章用 source 作为取样起点。每笔可通过编辑历史撤销。',
    inputSchema: posterPixelPaintInput, annotations: localEdit
  }, async input => success({ poster: await posters.paintLayerPixels(input) }))

  const [removeInput, redrawInput] = posterRegionInput.options
  server.registerTool('preview_poster_layer_region', {
    description: '预览选区内的物体移除或重绘。remove 在本机处理并返回图片和 draftId。redraw 使用已配置的图生图模型，可能产生费用，返回 jobId 后用 get_poster_region_job 查询。重试同一次重绘时复用 requestId。两种预览都须另行应用。',
    inputSchema: z.discriminatedUnion('mode', [removeInput, redrawInput.extend({ requestId: id.optional() })]),
    annotations: { destructiveHint: false, openWorldHint: true }
  }, async input => {
    if (input.mode === 'redraw') {
      const { requestId, ...redraw } = input
      return success(regionJobs.submit(redraw, requestId))
    }
    const { src, ...metadata } = await posters.previewLayerRegion(input)
    return { structuredContent: metadata, content: [photoImage(src)] }
  })

  server.registerTool('get_poster_region_job', {
    description: '查询局部重绘任务。完成后返回预览 PNG 和 draftId，确认后用 save_poster_layer_region 应用。',
    inputSchema: { jobId: id }, annotations: readOnly
  }, ({ jobId }) => {
    const job = regionJobs.get(jobId)
    if (!job.preview) return success({ jobId, status: job.status, ...(job.error && { error: job.error }) })
    const { src, ...metadata } = job.preview
    return { structuredContent: { jobId, status: job.status, ...metadata }, content: [photoImage(src)] }
  })

  server.registerTool('save_poster_layer_region', {
    description: '应用已确认的局部编辑 draftId，只把结果合入选区。海报版本变化后要重新生成预览。',
    inputSchema: { draftId: id }, annotations: { ...localEdit, idempotentHint: true }
  }, async ({ draftId }) => success({ poster: await posters.saveLayerRegion(draftId) }))

  server.registerTool('undo_poster_edit', {
    description: '使用当前海报 revision 撤销这张图片编辑时间线中的上一步，返回当前海报。',
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
