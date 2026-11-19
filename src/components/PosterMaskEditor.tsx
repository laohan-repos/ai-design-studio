import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { PhotoInspection, PhotoMask, PhotoPoint, PhotoSelection } from '@/lib/photo-edits'
import { hasPhotoArea } from '@/lib/photo-geometry'
import type { PosterDocument, PosterLayerMaskPreview, PosterMaskLayerId, PosterMaskStroke, PosterOperation } from '@/lib/poster'
import { EditorToolSurface } from './EditorToolSurface'
import { PhotoSelectionCanvas } from './PhotoSelectionCanvas'
import { PosterMaskCanvas } from './PosterMaskCanvas'
import { Button } from './ui/button'

export type PosterMaskMode = 'brush' | 'selection'
type Props = {
  poster: PosterDocument
  layerId: PosterMaskLayerId
  layerName: string
  initialMode: PosterMaskMode
  initialSelection?: PhotoMask
  sourceGeneration: number
  hasMask: boolean
  busy: boolean
  error: string
  onEdit(operation: PosterOperation): Promise<boolean>
  onClose(): void
}

const selectionTools = [
  { id: 'rectangle', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'polygon', label: '描边' },
  { id: 'brush', label: '画笔' }
] as const
const emptySelection: PhotoMask = { include: [], exclude: [], feather: 0 }

export function PosterMaskEditor({ poster, layerId, layerName, initialMode, initialSelection, sourceGeneration, hasMask,
  busy, error, onEdit, onClose }: Props) {
  const [mode, setMode] = useState(initialMode)
  const [preview, setPreview] = useState<{ image: PosterLayerMaskPreview; generation: number }>()
  const [previewError, setPreviewError] = useState('')
  const [tool, setTool] = useState<PhotoSelection['type']>('rectangle')
  const [selection, setSelection] = useState(initialSelection ?? emptySelection)
  const [selectionMode, setSelectionMode] = useState<'include' | 'exclude'>('include')
  const [polygon, setPolygon] = useState<PhotoPoint[]>([])
  const [strokeMode, setStrokeMode] = useState<PosterMaskStroke['mode']>('hide')
  const [radius, setRadius] = useState(0.02)
  const [showOverlay, setShowOverlay] = useState(false)
  const { artworkId, revision } = poster
  const ready = preview?.image.revision === revision && preview.generation === sourceGeneration
  const hasSelection = Boolean(selection.include.length || selection.exclude?.length)

  useEffect(() => {
    let active = true
    setPreviewError('')
    window.studio.getPosterLayerMaskPreview(artworkId, layerId, revision).then(image => {
      if (active) setPreview({ image, generation: sourceGeneration })
    }).catch(reason => {
      if (!active) return
      setPreview(undefined)
      setPreviewError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '无法读取图层蒙版')
    })
    return () => { active = false }
  }, [artworkId, layerId, revision, sourceGeneration])

  const disabled = busy || !ready
  const selectedShapes = selection[selectionMode] ?? []
  const addShape = (shape: PhotoSelection) => {
    if (disabled || selectedShapes.length >= 12) return
    setSelection(current => ({ ...current, [selectionMode]: [...(current[selectionMode] ?? []), shape] }))
  }
  const convertSelection = async () => {
    if (await onEdit({ op: 'set_layer_mask', layerId, base: { type: 'selection', selection } })) {
      setMode('brush')
      setStrokeMode('hide')
    }
  }
  const image = preview?.image
  const frame: PhotoInspection | undefined = image && {
    artworkId, versionId: '', src: image.source,
    width: image.width, height: image.height, imageWidth: image.width, imageHeight: image.height,
    crop: { x: 0, y: 0, width: image.width, height: image.height }
  }

  return <EditorToolSurface name={mode === 'selection' ? '绘制选区' : '编辑蒙版'}
    options={<Button size="sm" disabled={busy} onClick={onClose}>完成</Button>}
    status={<>
      <span className="truncate">{layerName}</span>
      {image && <span>{image.width} × {image.height} px</span>}
      {!ready && !previewError && <span>正在更新</span>}
    </>}
    properties={<>
      {mode === 'selection' ? <fieldset disabled={disabled} className="min-w-0 space-y-3">
        <div className="grid grid-cols-4 gap-1" aria-label="选区工具">
          {selectionTools.map(({ id, label }) => <Button key={id} size="sm" className="min-w-0 px-1"
            variant={tool === id ? 'secondary' : 'outline'} aria-pressed={tool === id}
            onClick={() => { setTool(id); setPolygon([]) }}>{label}</Button>)}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={selectionMode === 'include' ? 'secondary' : 'outline'} aria-pressed={selectionMode === 'include'}
            onClick={() => { setSelectionMode('include'); setPolygon([]) }}>加选</Button>
          <Button size="sm" variant={selectionMode === 'exclude' ? 'secondary' : 'outline'} aria-pressed={selectionMode === 'exclude'}
            onClick={() => { setSelectionMode('exclude'); setPolygon([]) }}>减选</Button>
          {tool === 'polygon' && <Button size="sm" variant="outline" disabled={polygon.length < 3 || !hasPhotoArea(polygon) || selectedShapes.length >= 12}
            onClick={() => { addShape({ type: 'polygon', points: polygon }); setPolygon([]) }}>闭合描边</Button>}
        </div>
        <MaskRange label="羽化" min={0} max={8} value={selection.feather ?? 0.01}
          onChange={feather => setSelection(current => ({ ...current, feather }))} />
        {tool === 'brush' && <MaskRange label="画笔大小" min={0.2} max={25} value={radius} onChange={setRadius} />}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" disabled={!hasSelection || polygon.length > 0} onClick={() => void convertSelection()}>选区转蒙版</Button>
          <Button size="sm" variant="ghost" disabled={!hasSelection && !polygon.length}
            onClick={() => { setSelection(emptySelection); setPolygon([]) }}>清空选区</Button>
        </div>
        {selectedShapes.length >= 12 && <p role="status" className="text-xs text-slate-600">当前组最多支持 12 个选区。</p>}
      </fieldset> : <fieldset disabled={disabled || !hasMask} className="min-w-0 space-y-4">
        <div className="flex gap-1.5" aria-label="蒙版画笔">
          <Button size="sm" variant={strokeMode === 'hide' ? 'secondary' : 'outline'} aria-pressed={strokeMode === 'hide'}
            onClick={() => setStrokeMode('hide')}>隐藏</Button>
          <Button size="sm" variant={strokeMode === 'restore' ? 'secondary' : 'outline'} aria-pressed={strokeMode === 'restore'}
            onClick={() => setStrokeMode('restore')}>恢复</Button>
        </div>
        <MaskRange label="画笔大小" min={0.2} max={25} value={radius} onChange={setRadius} />
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={showOverlay} onChange={event => setShowOverlay(event.currentTarget.checked)} />显示蒙版叠加
        </label>
      </fieldset>}
      {mode === 'brush' && !hasMask && <p className="mt-3 text-xs text-slate-600">当前图层没有蒙版。</p>}
      {(previewError || error) && <p role="alert" className="mt-3 break-words text-xs text-red-600">{previewError || error}</p>}
    </>}>
    {mode === 'selection' && frame ? <PhotoSelectionCanvas image={frame} alt="图层原图，可绘制蒙版选区" tool={tool}
      brushRadius={radius} mask={selection} polygon={polygon} disabled={disabled || selectedShapes.length >= 12}
      onPoint={point => setPolygon(current => current.length < 160 ? [...current, point] : current)}
      onShape={addShape} />
      : mode === 'brush' && image ? <PosterMaskCanvas key={layerId} preview={image} mode={strokeMode} radius={radius} disabled={disabled || !hasMask}
        showOverlay={showOverlay} onStroke={stroke => onEdit({ op: 'paint_layer_mask', layerId, stroke })} />
      : !previewError ? <LoaderCircle aria-label="正在读取图层" className="size-6 animate-spin text-violet-600" />
        : <p className="text-xs text-slate-600">图层预览暂不可用。</p>}
  </EditorToolSurface>
}

function MaskRange({ label, min, max, value, onChange }: {
  label: string; min: number; max: number; value: number; onChange(value: number): void
}) {
  return <label className="block space-y-1.5 text-xs font-medium text-slate-700">
    <span className="flex items-center justify-between">{label}<span className="tabular-nums">{Math.round(value * 1000) / 10}%</span></span>
    <input type="range" aria-label={label} min={min} max={max} step={0.1} value={Math.round(value * 1000) / 10}
      className="block w-full accent-violet-600" onChange={event => onChange(Number(event.currentTarget.value) / 100)} />
  </label>
}
