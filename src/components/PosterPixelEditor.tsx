import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { PhotoInspection, PhotoMask, PhotoPoint, PhotoSelection } from '@/lib/photo-edits'
import { hasPhotoArea } from '@/lib/photo-geometry'
import type { PosterDocument, PosterMaskLayerId } from '@/lib/poster'
import { posterPixelMaxRadius, posterPixelMinRadius } from '@/lib/poster-limits'
import type { PosterPixelStroke, PosterPixelView, PosterRegionPreview } from '@/lib/poster-pixels'
import type { ModelConfig } from '@/types'
import { EditorToolSurface } from './EditorToolSurface'
import { PhotoSelectionCanvas } from './PhotoSelectionCanvas'
import { PosterPixelCanvas } from './PosterPixelCanvas'
import { Button } from './ui/button'

type PixelTool = PosterPixelStroke['type'] | 'remove' | 'redraw'
type Props = {
  poster: PosterDocument
  layerId: PosterMaskLayerId
  layerName: string
  models: ModelConfig[]
  initialSelection?: PhotoMask
  disabled: boolean
  sourceGeneration: number
  error: string
  onPaint(stroke: PosterPixelStroke): Promise<boolean>
  onApplyRegion(draftId: string): Promise<boolean>
  onClose(): void
}

const pixelTools = [
  { id: 'brush', label: '画笔' },
  { id: 'eraser', label: '橡皮擦' },
  { id: 'clone', label: '仿制图章' },
  { id: 'remove', label: '移除物体' },
  { id: 'redraw', label: '局部重绘' }
] as const
const selectionTools = [
  { id: 'rectangle', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'polygon', label: '描边' },
  { id: 'brush', label: '画笔选区' }
] as const
const emptySelection: PhotoMask = { include: [], exclude: [], feather: 0 }
const selectionLimit = 12
const readableError = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : fallback

export function PosterPixelEditor({ poster, layerId, layerName, models, initialSelection, disabled, sourceGeneration,
  error, onPaint, onApplyRegion, onClose }: Props) {
  const { artworkId, revision } = poster
  const [tool, setTool] = useState<PixelTool>('brush')
  const [image, setImage] = useState<{ view: PosterPixelView; generation: number }>()
  const [imageError, setImageError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [activity, setActivity] = useState<'preview' | 'apply'>()
  const activeRequest = useRef(0)
  const pending = useRef(false)
  const [draft, setDraft] = useState<{ view: PosterRegionPreview; generation: number }>()
  const [color, setColor] = useState('#272033')
  const [radius, setRadius] = useState(0.02)
  const [opacity, setOpacity] = useState(1)
  const [source, setSource] = useState<PhotoPoint>()
  const [picking, setPicking] = useState(false)
  const [selectionTool, setSelectionTool] = useState<PhotoSelection['type']>('rectangle')
  const [selectionMode, setSelectionMode] = useState<'include' | 'exclude'>('include')
  const [selection, setSelection] = useState(initialSelection ?? emptySelection)
  const [polygon, setPolygon] = useState<PhotoPoint[]>([])
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')

  const region = tool === 'remove' || tool === 'redraw'
  const ready = image?.view.revision === revision && image.generation === sourceGeneration
  const result = draft?.view.revision === revision && draft.generation === sourceGeneration ? draft.view : undefined
  const locked = disabled || !ready || Boolean(activity)
  const editModels = models.filter(model => model.taskType === 'image-to-image' && model.apiKey.trim() && model.model.trim())
  const selectedModel = editModels.find(model => model.id === modelId) ?? editModels[0]
  const canPreview = !locked && !result && !polygon.length && Boolean(selection.include.length || selection.exclude?.length) &&
    (tool !== 'redraw' || Boolean(selectedModel && prompt.trim()))
  const activeShapes = selection[selectionMode] ?? []

  useEffect(() => {
    let current = true
    setImageError('')
    setPreviewError('')
    setDraft(undefined)
    setActivity(undefined)
    window.studio.inspectPosterLayerPixels({ artworkId, layerId, revision }).then(view => {
      if (current) setImage({ view, generation: sourceGeneration })
    }, cause => {
      if (!current) return
      setImage(undefined)
      setImageError(readableError(cause, '无法读取图层像素'))
    })
    return () => {
      current = false
      activeRequest.current++
      pending.current = false
    }
  }, [artworkId, layerId, revision, sourceGeneration])

  async function run(phase: 'preview' | 'apply', action: (isCurrent: () => boolean) => Promise<void>) {
    if (pending.current) return
    pending.current = true
    const request = ++activeRequest.current
    const isCurrent = () => activeRequest.current === request
    setActivity(phase)
    setPreviewError('')
    try { await action(isCurrent) }
    catch (cause) { if (isCurrent()) setPreviewError(readableError(cause, '像素编辑失败')) }
    finally {
      if (isCurrent()) {
        pending.current = false
        setActivity(undefined)
      }
    }
  }

  function generatePreview() {
    if (!canPreview || !region) return
    void run('preview', async isCurrent => {
      const input = { artworkId, layerId, revision, selection }
      const view = await window.studio.previewPosterLayerRegion(tool === 'remove' ? { ...input, mode: tool }
        : { ...input, mode: tool, prompt: prompt.trim(), modelId: selectedModel!.id })
      if (isCurrent()) setDraft({ view, generation: sourceGeneration })
    })
  }

  function applyResult() {
    if (!result || locked) return
    void run('apply', async isCurrent => {
      if (await onApplyRegion(result.draftId) && isCurrent()) setDraft(undefined)
    })
  }

  function addShape(shape: PhotoSelection) {
    if (locked || activeShapes.length >= selectionLimit) return
    setSelection(current => ({ ...current, [selectionMode]: [...(current[selectionMode] ?? []), shape] }))
  }

  function selectTool(next: PixelTool) {
    if (next === tool) return
    setTool(next)
    setPicking(false)
    setPolygon([])
    setDraft(undefined)
    setPreviewError('')
  }

  const view = image?.view
  const frame: PhotoInspection | undefined = view && {
    artworkId, versionId: '', src: view.src,
    width: view.width, height: view.height, imageWidth: view.width, imageHeight: view.height,
    crop: { x: 0, y: 0, width: view.width, height: view.height }
  }
  const displayedError = previewError || imageError || error

  return <EditorToolSurface name="像素编辑" options={<Button size="sm" disabled={disabled || activity === 'apply'} onClick={onClose}>完成</Button>}
    status={<>
      <span className="truncate">{layerName}</span>
      {view && <span>{view.width} × {view.height} px</span>}
      {activity === 'preview' ? <span>正在生成预览</span> : !ready && !imageError ? <span>正在更新</span> : null}
    </>}
    properties={<>
      <fieldset aria-label="像素编辑工具" disabled={disabled || Boolean(activity)} className="mb-4 flex flex-wrap gap-1.5 border-b pb-3">
        {pixelTools.map(({ id, label }) => <Button size="sm" key={id} variant={id === tool ? 'secondary' : 'outline'}
          aria-pressed={id === tool} onClick={() => selectTool(id)}>{label}</Button>)}
      </fieldset>
      {region ? <fieldset disabled={locked} className="min-w-0 space-y-3">
        {result ? <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={applyResult}>应用结果</Button>
          <Button size="sm" variant="outline" onClick={() => setDraft(undefined)}>返回选区</Button>
        </div> : <>
          <div className="grid grid-cols-4 gap-1" aria-label="像素编辑选区工具">
            {selectionTools.map(({ id, label }) => <Button key={id} size="sm" className="min-w-0 px-0.5"
              variant={id === selectionTool ? 'secondary' : 'outline'} aria-pressed={id === selectionTool}
              onClick={() => { setSelectionTool(id); setPolygon([]) }}>{label}</Button>)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={selectionMode === 'include' ? 'secondary' : 'outline'} aria-pressed={selectionMode === 'include'}
              onClick={() => { setSelectionMode('include'); setPolygon([]) }}>加选</Button>
            <Button size="sm" variant={selectionMode === 'exclude' ? 'secondary' : 'outline'} aria-pressed={selectionMode === 'exclude'}
              onClick={() => { setSelectionMode('exclude'); setPolygon([]) }}>减选</Button>
            {selectionTool === 'polygon' && <Button size="sm" variant="outline"
              disabled={polygon.length < 3 || !hasPhotoArea(polygon) || activeShapes.length >= selectionLimit}
              onClick={() => { addShape({ type: 'polygon', points: polygon }); setPolygon([]) }}>闭合描边</Button>}
          </div>
          {selectionTool === 'brush' && <PixelRange label="选区画笔大小" min={0.2} max={25} step={0.1}
            value={Math.max(0.002, radius)} onChange={setRadius} />}
          <PixelRange label="羽化" min={0} max={8} step={0.1} value={selection.feather ?? 0}
            onChange={feather => setSelection(current => ({ ...current, feather }))} />
          {tool === 'redraw' && <>
            {selectedModel ? <label className="block space-y-1.5 text-xs font-medium">
              <span>图生图模型</span>
              <select className="setting-select" value={selectedModel.id} onChange={event => setModelId(event.currentTarget.value)}>
                {editModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label> : <p className="text-xs text-slate-600">请先在模型设置中配置图生图模型。</p>}
            <label className="block space-y-1.5 text-xs font-medium">
              <span>重绘提示词</span>
              <textarea className="min-h-20 w-full resize-y rounded-md border bg-white p-2 text-sm" value={prompt}
                onChange={event => setPrompt(event.currentTarget.value)} placeholder="描述选区内要生成的内容" maxLength={4000} />
            </label>
          </>}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={!canPreview} onClick={generatePreview}>
              {activity === 'preview' && <LoaderCircle className="size-3.5 animate-spin" />}生成预览
            </Button>
            <Button size="sm" variant="ghost" disabled={!selection.include.length && !selection.exclude?.length && !polygon.length}
              onClick={() => { setSelection(emptySelection); setPolygon([]) }}>清空选区</Button>
          </div>
        </>}
      </fieldset> : <fieldset disabled={locked} className="min-w-0 space-y-3">
        {tool === 'brush' && <label className="flex items-center justify-between gap-3 text-xs font-medium">
          <span>画笔颜色</span>
          <input type="color" className="h-8 w-12 rounded-md border bg-white px-1 py-0.5"
            value={color} onChange={event => setColor(event.currentTarget.value)} />
        </label>}
        <PixelRange label="画笔大小" min={posterPixelMinRadius * 100} max={posterPixelMaxRadius * 100} step={0.01}
          value={radius} onChange={setRadius} />
        <PixelRange label="画笔不透明度" min={1} max={100} step={1} value={opacity} onChange={setOpacity} />
        {tool === 'clone' && <>
          <Button type="button" size="sm" variant={picking ? 'secondary' : 'outline'} aria-pressed={picking}
            onClick={() => setPicking(value => !value)}>选择取样点</Button>
          <p className="text-xs text-slate-600">{picking ? '在图层上点一下取样。' : '按住 Alt 或 Option 单击取样。'}</p>
        </>}
      </fieldset>}
      {displayedError && <p role="alert" className="mt-3 break-words text-xs text-red-600">{displayedError}</p>}
    </>}>
    {region && result && view ? <div className="grid h-full w-full grid-cols-2 gap-2 sm:gap-4" aria-label="像素编辑前后对比">
      {[{ label: '编辑前', src: view.src }, { label: '编辑预览', src: result.src }].map(item =>
        <figure key={item.label} className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-1.5">
          <figcaption className="rounded bg-white px-2 py-1 text-xs">{item.label}</figcaption>
          <img src={item.src} alt={item.label} className="checkerboard block min-h-0 max-h-full max-w-full rounded-sm object-contain shadow-lg" />
        </figure>)}
    </div> : region && frame ? <PhotoSelectionCanvas image={frame} alt="图层原图，可绘制像素编辑选区"
      tool={selectionTool} brushRadius={Math.max(0.002, radius)} mask={selection} polygon={polygon}
      disabled={locked || activeShapes.length >= selectionLimit}
      onPoint={point => setPolygon(current => current.length < 160 ? [...current, point] : current)} onShape={addShape} />
    : !region && view ? <PosterPixelCanvas key={layerId} view={view} tool={tool} color={color} radius={radius} opacity={opacity}
      source={source} pickingSource={picking} disabled={locked} onSource={point => { setSource(point); setPicking(false) }} onPaint={onPaint} />
    : imageError ? <span className="text-xs text-slate-600">图层预览暂不可用。</span>
    : <LoaderCircle aria-label="正在读取图层" className="size-6 animate-spin text-violet-600" />}
  </EditorToolSurface>
}

function PixelRange({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number; onChange(value: number): void
}) {
  const percent = Math.round(value * 10_000) / 100
  return <label className="block space-y-1.5 text-xs font-medium">
    <span className="flex items-center justify-between">{label}<span className="tabular-nums">{percent}%</span></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={percent}
      className="block w-full accent-violet-600" onChange={event => onChange(Number(event.currentTarget.value) / 100)} />
  </label>
}
