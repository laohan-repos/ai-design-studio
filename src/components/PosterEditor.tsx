import { useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import type { Artwork, ModelConfig } from '@/types'
import type { PhotoMask, PhotoSelectionReference } from '@/lib/photo-edits'
import type { EditorHistoryEntry } from '@/lib/editor-history'
import type { PosterDocument, PosterImage, PosterImageLayer, PosterMaskLayerId, PosterOperation, PosterOutput, PosterPoint, PosterText } from '@/lib/poster'
import { documentSizeLabels, type DocumentSizeMode } from '@/lib/document-size'
import { posterBoxLimit, posterCoordinateLimit, posterMaxPixels, posterMaxSide, posterMinSide } from '@/lib/poster-limits'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Slider } from './ui/slider'
import { Textarea } from './ui/textarea'
import { EditorInspector, EditorToolSurface } from './EditorToolSurface'
import { DocumentSizeForm, type SizeSettings } from './DocumentSizeForm'
import { PosterLayerList } from './PosterLayerList'
import { PosterMaskEditor, type PosterMaskMode } from './PosterMaskEditor'
import { PosterPixelEditor } from './PosterPixelEditor'
import { PosterTransformCanvas } from './PosterTransformCanvas'

type Props = {
  artwork: Artwork
  versionId: string
  versionNumber?: number
  models: ModelConfig[]
  photoSelection?: PhotoSelectionReference
  historyNavigating: boolean
  historyNavigation?: { revision: number; view: EditorHistoryEntry['view'] }
  onBusyChange(busy: boolean): void
  onSourceChange(versionId: string): void
}
type Apply = (operation: PosterOperation) => Promise<boolean>
type MaskSession = { layerId: PosterMaskLayerId; layerName: string; mode: PosterMaskMode; selection?: PhotoMask }
type PixelSession = { layerId: PosterMaskLayerId; layerName: string; selection?: PhotoMask }

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试'
}

function hasLayerMask(poster: PosterDocument, layerId: PosterMaskLayerId) {
  return Boolean(poster.layerMasks?.[layerId]) || (layerId === 'subject' && poster.mask.type !== 'none')
}

function hasImageLayer(poster: PosterDocument, layerId: PosterMaskLayerId) {
  if (layerId === 'subject') return true
  if (layerId === 'background') return poster.background.type === 'image'
  return poster.imageLayers.some(layer => `image:${layer.id}` === layerId)
}

export function ImageLayerEditor({ artwork, versionId, versionNumber, models, photoSelection, historyNavigating, historyNavigation, onBusyChange, onSourceChange }: Props) {
  const [poster, setPoster] = useState<PosterDocument>()
  const [preview, setPreview] = useState<{ image: PosterImage; size: PosterOutput['size']; generation: number }>()
  const [previewGeneration, setPreviewGeneration] = useState(0)
  const [source, setSource] = useState<string>()
  const [sourceRatio, setSourceRatio] = useState(1)
  const [points, setPoints] = useState<PosterPoint[]>()
  const [layerId, setLayerId] = useState('subject')
  const [maskSession, setMaskSession] = useState<MaskSession>()
  const [pixelSession, setPixelSession] = useState<PixelSession>()
  const editingLayerSource = Boolean(maskSession || pixelSession)
  const [busy, setBusy] = useState(false)
  const editing = useRef(false)
  const handledNavigation = useRef<number>()
  const [refreshing, setRefreshing] = useState(false)
  const [size, setSize] = useState<PosterOutput['size']>('current')
  const [sizeMode, setSizeMode] = useState<DocumentSizeMode>()
  const { panel, openPanel } = useContext(EditorInspector)
  const [format, setFormat] = useState<PosterOutput['format']>('png')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const accept = (updated: PosterDocument) => setPoster(current => current && updated.revision <= current.revision ? current : updated)
  useEffect(() => {
    let closed = false
    const unsubscribe = window.studio.onMcpWorkspaceChanged(change => {
      if (change.type === 'poster_updated' && change.poster.artworkId === artwork.id) accept(change.poster)
      if (change.type === 'artwork_deleted' || change.type === 'canvas_deleted') setPreviewGeneration(value => value + 1)
    })
    window.studio.openPoster(artwork.id, versionId).then(updated => {
      if (!closed) accept(updated)
    }).catch(cause => { if (!closed) setError(messageFrom(cause)) })
    return () => { closed = true; unsubscribe() }
  }, [artwork.id, versionId])

  const sourceVersionId = poster?.sourceVersionId
  useEffect(() => {
    if (sourceVersionId) onSourceChange(sourceVersionId)
  }, [sourceVersionId, onSourceChange])

  useEffect(() => {
    if (panel === 'layers') setSizeMode(undefined)
  }, [panel])

  useEffect(() => {
    if (!historyNavigation || handledNavigation.current === historyNavigation.revision) return
    handledNavigation.current = historyNavigation.revision
    setPoints(undefined)
    setSizeMode(undefined)
    setError('')
    setMessage('')
    setMaskSession(current => poster && historyNavigation.view === 'poster' && current?.mode === 'brush' && hasLayerMask(poster, current.layerId)
      ? current : undefined)
    setPixelSession(current => poster && historyNavigation.view === 'poster' && current && hasImageLayer(poster, current.layerId)
      ? current : undefined)
  }, [historyNavigation, poster])

  useEffect(() => {
    if (!poster || editingLayerSource) return
    let closed = false
    setRefreshing(true)
    window.studio.previewPoster(artwork.id, size).then(result => {
      if (!closed) setPreview({ image: result, size, generation: previewGeneration })
    }).catch(cause => {
      if (!closed) { setPreview(undefined); setError(messageFrom(cause)) }
    }).finally(() => { if (!closed) setRefreshing(false) })
    return () => { closed = true }
  }, [artwork.id, editingLayerSource, poster, previewGeneration, size])

  const run = async (action: () => Promise<void>) => {
    if (editing.current || historyNavigating) return false
    editing.current = true
    onBusyChange(true)
    setBusy(true); setError(''); setMessage('')
    try { await action(); return true }
    catch (cause) { setError(messageFrom(cause)); return false }
    finally { editing.current = false; setBusy(false); onBusyChange(false) }
  }

  const applyOperations = (operations: PosterOperation[]) => poster
    ? run(async () => accept(await window.studio.editPoster({ artworkId: artwork.id, revision: poster.revision, operations })))
    : Promise.resolve(false)
  const apply: Apply = operation => applyOperations([operation])

  const beginSelection = () => run(async () => {
    if (!poster) return
    setSource(await window.studio.getPosterSource(artwork.id))
    setPoints(poster.mask.type === 'polygon' ? poster.mask.points : [])
  })

  const finishSelection = async () => {
    if (points && points.length >= 3 && await apply({ op: 'set_mask', mask: { type: 'polygon', points } })) setPoints(undefined)
  }

  const exportImage = () => run(async () => {
    const result = await window.studio.exportPoster(artwork.id, { size, format })
    setMessage(`已导出 ${result.width} × ${result.height}：${result.path}`)
  })

  const addText = async (price: boolean) => {
    if (!poster) return
    const scale = poster.width / 1080
    const layer: PosterText = {
      id: crypto.randomUUID(), text: price ? '¥ 99' : '商品标题', x: Math.round(poster.width * .08),
      y: Math.round(poster.height * (price ? .16 : .06)), width: Math.round(poster.width * .84),
      fontSize: Math.max(8, Math.round((price ? 42 : 70) * scale)), color: '#272033', align: 'left', weight: 'bold', visible: true
    }
    if (await apply({ op: 'upsert_text', layer })) setLayerId(`text:${layer.id}`)
  }

  const text = layerId.startsWith('text:') ? poster?.textLayers.find(layer => layer.id === layerId.slice(5)) : undefined
  const image = layerId.startsWith('image:') ? poster?.imageLayers.find(layer => layer.id === layerId.slice(6)) : undefined
  const activeLayer = text || image || layerId === 'background' || layerId === 'shadow' ? layerId : 'subject'
  const layerName = image?.name ?? (text ? '文字' : activeLayer === 'background' ? '背景' : activeLayer === 'shadow' ? '阴影' : '主体')
  const background = activeLayer === 'background' && poster?.background.type === 'image' ? poster.background : undefined
  const maskLayerId: PosterMaskLayerId | undefined = image ? `image:${image.id}` : background ? 'background' : activeLayer === 'subject' ? 'subject' : undefined
  const layerSource = image ?? background ?? { artworkId: artwork.id, versionId: sourceVersionId }
  const matchingSelection = photoSelection && photoSelection.artworkId === layerSource.artworkId && photoSelection.versionId === layerSource.versionId
    ? photoSelection.selection : undefined
  const maskBase = maskLayerId && poster?.layerMasks?.[maskLayerId]?.base
  const controlsDisabled = busy || historyNavigating || Boolean(points)
  const matchingPreview = Boolean(preview && preview.image.revision === poster?.revision && preview.size === size && preview.generation === previewGeneration)

  function openSize(mode: DocumentSizeMode) {
    setSizeMode(mode)
    setSize('current')
    setError('')
    setMessage('')
    openPanel('properties')
  }

  async function applySize(mode: DocumentSizeMode, { width, height, anchor }: SizeSettings) {
    const operation = mode === 'image' ? { op: 'set_size' as const, width, height }
      : { op: 'set_canvas_size' as const, width, height, anchor }
    if (await apply(operation)) setMessage(`已调整为 ${width} × ${height} px`)
  }

  if (poster && maskSession) return <PosterMaskEditor poster={poster} layerId={maskSession.layerId} layerName={maskSession.layerName}
    initialMode={maskSession.mode} initialSelection={maskSession.selection} sourceGeneration={previewGeneration} hasMask={hasLayerMask(poster, maskSession.layerId)}
    busy={busy || historyNavigating} error={error} onEdit={apply} onClose={() => { setMaskSession(undefined); setError('') }} />

  if (poster && pixelSession) return <PosterPixelEditor key={pixelSession.layerId} poster={poster} layerId={pixelSession.layerId}
    layerName={pixelSession.layerName} initialSelection={pixelSession.selection} models={models} disabled={busy || historyNavigating}
    sourceGeneration={previewGeneration} error={error}
    onPaint={stroke => run(async () => accept(await window.studio.paintPosterLayerPixels({
      artworkId: artwork.id, layerId: pixelSession.layerId, revision: poster.revision, stroke
    })))}
    onApplyRegion={draftId => run(async () => accept(await window.studio.savePosterLayerRegion(draftId)))}
    onClose={() => {
      setPixelSession(undefined)
      setError('')
      if (panel !== 'history') openPanel('layers')
    }} />

  return <EditorToolSurface name={sizeMode ? documentSizeLabels[sizeMode] : '图层合成'} expandedCanvas={Boolean(points)}
    options={<>
        {poster && maskLayerId && !sizeMode && <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => {
          setMessage('')
          setError('')
          setPixelSession({ layerId: maskLayerId, layerName, selection: matchingSelection })
          openPanel('properties')
        }}>像素编辑</Button>}
        {sizeMode && <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => { setSizeMode(undefined); openPanel('layers') }}>返回合成</Button>}
        {(['image', 'canvas'] as const).filter(mode => mode !== sizeMode).map(mode => <Button key={mode} size="sm" variant="outline"
          disabled={!poster || controlsDisabled} onClick={() => openSize(mode)}>{documentSizeLabels[mode]}</Button>)}
        {!sizeMode && <>
        <select aria-label="导出比例" className="h-8 rounded-md border bg-white px-2 text-xs" value={size} disabled={controlsDisabled} onChange={event => setSize(event.target.value as PosterOutput['size'])}>
          <option value="current">当前尺寸</option><option value="square">方图 1:1</option><option value="portrait">竖图 2:3</option>
        </select>
        <select aria-label="导出格式" className="h-8 rounded-md border bg-white px-2 text-xs" value={format} onChange={event => setFormat(event.target.value as PosterOutput['format'])}>
          <option value="png">PNG</option><option value="jpeg">JPEG</option>
        </select>
        <Button size="sm" aria-label="导出合成图" disabled={controlsDisabled || !preview || !matchingPreview} onClick={exportImage}><Download className="h-4 w-4" /><span className="sm:hidden">导出</span><span className="hidden sm:inline">导出合成图</span></Button>
        </>}
    </>}
    layers={poster && !sizeMode && <PosterLayerList poster={poster} canvasId={artwork.canvasId} selectedLayerId={activeLayer} disabled={controlsDisabled}
      onSelect={setLayerId} onAddText={addText} onEdit={applyOperations} />}
    properties={<>
      {poster && sizeMode && <DocumentSizeForm key={`${sizeMode}:${poster.revision}`} mode={sizeMode} current={poster}
        min={posterMinSide} max={posterMaxSide} maxPixels={posterMaxPixels} disabled={controlsDisabled} onApply={value => void applySize(sizeMode, value)} />}
      {poster && !sizeMode && <fieldset disabled={controlsDisabled} className="min-w-0 disabled:opacity-60" key={`${activeLayer}-${poster.revision}`}>
        <legend className="mb-3 max-w-full truncate text-xs font-semibold text-slate-800" title={layerName}>{layerName}属性</legend>
        {image?.visible && matchingPreview && !preview?.image.imageBounds[`image:${image.id}`] &&
          <p className="mb-3 text-xs text-amber-700" role="status">源图片已不可用</p>}
        {maskLayerId && <MaskControls layerId={maskLayerId} hasMask={hasLayerMask(poster, maskLayerId)} selection={matchingSelection} apply={apply}
          onOpen={mode => {
            setError('')
            setMessage('')
            const selection = matchingSelection ?? (maskBase && maskBase.type === 'selection' ? maskBase.selection : undefined)
            setMaskSession({ layerId: maskLayerId, layerName, mode, selection })
          }} />}
        {image && <ImageControls layer={image} apply={apply} disabled={controlsDisabled} />}
        {activeLayer === 'background' && <BackgroundControls poster={poster} artwork={artwork} apply={apply} />}
        {activeLayer === 'subject' && <SubjectControls poster={poster} apply={apply} disabled={controlsDisabled} beginSelection={beginSelection} />}
        {activeLayer === 'shadow' && <ShadowControls poster={poster} apply={apply} />}
        {text && <TextControls layer={text} apply={apply} />}
      </fieldset>}
      {(error || message) && <p role={error ? 'alert' : 'status'} className={`mt-3 break-words text-xs leading-5 ${error ? 'text-red-600' : 'text-slate-600'}`}>{error || message}</p>}
    </>}
    status={preview && <>{versionNumber && <span>图片源 V{versionNumber}</span>}<span>{preview.image.width} × {preview.image.height} px</span>{refreshing && <span>正在更新</span>}</>}>
        {points && source ? <>
          <div className="flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]">
            <div className="relative cursor-crosshair" style={{ width: `min(100cqw, ${sourceRatio * 100}cqh)`, aspectRatio: sourceRatio }} onClick={event => {
              if (points.length >= 160) return
              const box = event.currentTarget.getBoundingClientRect()
              setPoints([...points, { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }])
            }}>
              <img src={source} draggable={false} alt="请沿原图主体边缘依次标出选区顶点" className="block w-full" onLoad={event => { const img = event.currentTarget; setSourceRatio(img.naturalWidth / img.naturalHeight) }} />
              {points.length >= 3 && <div className="pointer-events-none absolute inset-0 bg-violet-500/25" style={{ clipPath: `polygon(${points.map(point => `${point.x * 100}% ${point.y * 100}%`).join(',')})` }} />}
              {points.map((point, index) => <span key={index} className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet-600 shadow" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />)}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 rounded-lg border bg-white p-1.5 sm:gap-2 sm:p-2">
            <span className="w-full px-1 text-center text-xs text-slate-600 sm:w-auto">沿主体轮廓点击 · {points.length} 个点</span>
            <Button size="sm" variant="ghost" onClick={() => setPoints(points.slice(0, -1))} disabled={busy || !points.length}>撤回一点</Button>
            <Button size="sm" variant="ghost" onClick={() => setPoints([])} disabled={busy || !points.length}>清空</Button>
            <Button size="sm" variant="outline" onClick={() => setPoints(undefined)} disabled={busy}>取消</Button>
            <Button size="sm" onClick={finishSelection} disabled={busy || points.length < 3}>应用选区</Button>
          </div>
        </> : preview && poster ? <PosterTransformCanvas poster={poster} preview={preview.image} size={preview.size} selectedLayerId={activeLayer}
          disabled={controlsDisabled || Boolean(sizeMode) || refreshing || !matchingPreview} onSelect={setLayerId}
          onTransform={(id, transform) => id === 'subject'
            ? apply({ op: 'set_subject', subject: transform })
            : apply({ op: 'set_image', layerId: id.slice(6), layer: transform })} />
        : refreshing || !error ? <LoaderCircle className="h-6 w-6 animate-spin text-violet-600" /> : <span className="rounded-md border bg-white p-3 text-xs text-slate-600">预览暂不可用，可调整图层后重试。</span>}
  </EditorToolSurface>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-xs font-medium text-slate-700"><span>{label}</span>{children}</label>
}

function MaskControls({ layerId, hasMask, selection, apply, onOpen }: {
  layerId: PosterMaskLayerId
  hasMask: boolean
  selection?: PhotoMask
  apply: Apply
  onOpen(mode: PosterMaskMode): void
}) {
  const create = async (base: { type: 'reveal' } | { type: 'selection'; selection: PhotoMask }) => {
    if (await apply({ op: 'set_layer_mask', layerId, base })) onOpen('brush')
  }
  return <section aria-label="图层蒙版" className="mb-4 space-y-2 border-b pb-3">
    <h3 className="text-xs font-medium text-slate-700">蒙版</h3>
    <div className="flex flex-wrap gap-1.5">
      {hasMask
        ? <Button size="sm" variant="outline" onClick={() => onOpen('brush')}>编辑蒙版</Button>
        : <Button size="sm" variant="outline" onClick={() => void create({ type: 'reveal' })}>添加蒙版</Button>}
      <Button size="sm" variant="ghost" onClick={() => onOpen('selection')}>绘制选区</Button>
      {selection && <Button size="sm" variant="outline" onClick={() => void create({ type: 'selection', selection })}>选区转蒙版</Button>}
      {hasMask && <Button size="sm" variant="ghost" onClick={() => void apply({ op: 'set_layer_mask', layerId, base: null })}>移除蒙版</Button>}
    </div>
  </section>
}

function NumberField({ label, name, value, min, max, step }: { label: string; name: string; value: number; min: number; max: number; step?: 'any' }) {
  return <Field label={label}><Input type="number" name={name} defaultValue={value} min={min} max={max} step={step} required /></Field>
}

function ColorField({ label, name, value }: { label: string; name: string; value: string }) {
  return <Field label={label}><Input type="color" name={name} defaultValue={value} className="px-2 py-1" /></Field>
}

function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()
  return new FormData(event.currentTarget)
}

function BackgroundControls({ poster, artwork, apply }: { poster: PosterDocument; artwork: Artwork; apply: Apply }) {
  const background = poster.background
  const [type, setType] = useState(background.type)
  const [selectedAsset, setSelectedAsset] = useState(background.type === 'image' ? background.artworkId : '')
  const [assets, setAssets] = useState<Artwork[]>([])
  const [assetError, setAssetError] = useState(false)
  useEffect(() => {
    if (type !== 'image') return
    let closed = false
    window.studio.listArtworks(artwork.canvasId).then(items => { if (!closed) setAssets(items.filter(item => item.id !== artwork.id)) })
      .catch(() => { if (!closed) setAssetError(true) })
    return () => { closed = true }
  }, [type, artwork.id, artwork.canvasId])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const form = formValues(event)
    const color = String(form.get('color'))
    if (type === 'transparent') void apply({ op: 'set_background', background: { type } })
    if (type === 'solid') void apply({ op: 'set_background', background: { type, color } })
    if (type === 'gradient') void apply({ op: 'set_background', background: { type, top: color, bottom: String(form.get('bottom')) } })
    if (type === 'image' && form.get('artwork')) {
      const id = String(form.get('artwork'))
      void apply({ op: 'set_background', background: { type, artworkId: id, versionId: background.type === 'image' && background.artworkId === id ? background.versionId : undefined } })
    }
  }
  return <form className="space-y-3" onSubmit={submit}>
    <Field label="背景类型"><select className="setting-select" value={type} onChange={event => setType(event.target.value as typeof type)}>
      <option value="transparent">透明</option><option value="solid">纯色</option><option value="gradient">渐变</option><option value="image">画布图片</option>
    </select></Field>
    {type === 'solid' && <ColorField label="背景颜色" name="color" value={background.type === 'solid' ? background.color : '#eee6da'} />}
    {type === 'gradient' && <div className="grid grid-cols-2 gap-3">
      <ColorField label="顶部颜色" name="color" value={background.type === 'gradient' ? background.top : '#f5ede2'} />
      <ColorField label="底部颜色" name="bottom" value={background.type === 'gradient' ? background.bottom : '#d6b997'} />
    </div>}
    {type === 'image' && <Field label="用作背景的图片"><select className="setting-select" name="artwork" required value={selectedAsset} onChange={event => setSelectedAsset(event.target.value)}>
      <option value="">选择图片</option>
      {background.type === 'image' && !assets.some(asset => asset.id === background.artworkId) && <option value={background.artworkId}>当前背景图</option>}
      {assets.map(asset => <option key={asset.id} value={asset.id}>{asset.prompt || '未命名图片'}</option>)}
    </select></Field>}
    {type === 'image' && assetError && <p className="text-xs text-red-600">读取背景图片失败</p>}
    <Button type="submit" size="sm">应用背景</Button>
  </form>
}

function LayerOpacity({ opacity, disabled, onChange }: {
  opacity: number; disabled: boolean; onChange(opacity: number): Promise<boolean>
}) {
  const percent = Math.round(opacity * 100)
  const [value, setValue] = useState(percent)
  return <div className="space-y-2">
    <div className="flex items-center justify-between text-xs font-medium text-slate-700">
      <span>不透明度</span><span className="tabular-nums">{value}%</span>
    </div>
    <Slider aria-label="不透明度" min={0} max={100} step={1} value={[value]} disabled={disabled}
      onValueChange={([next]) => setValue(next)}
      onValueCommit={async ([next]) => {
        if (next !== percent && !await onChange(next / 100)) setValue(percent)
      }} />
  </div>
}

function ImageControls({ layer, apply, disabled }: { layer: PosterImageLayer; apply: Apply; disabled: boolean }) {
  const edit = (properties: Partial<Pick<PosterImageLayer, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'>>) =>
    apply({ op: 'set_image', layerId: layer.id, layer: properties })
  return <div className="space-y-4">
    <LayerOpacity opacity={layer.opacity} disabled={disabled} onChange={opacity => edit({ opacity })} />
    <form className="space-y-3 border-t pt-3" onSubmit={event => {
      const form = formValues(event)
      void edit({ x: Number(form.get('x')), y: Number(form.get('y')), width: Number(form.get('width')),
        height: Number(form.get('height')), rotation: Number(form.get('rotation')) })
    }}>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="横坐标" name="x" value={layer.x} min={-posterCoordinateLimit} max={posterCoordinateLimit} />
        <NumberField label="纵坐标" name="y" value={layer.y} min={-posterCoordinateLimit} max={posterCoordinateLimit} />
        <NumberField label="宽度" name="width" value={layer.width} min={1} max={posterBoxLimit} />
        <NumberField label="高度" name="height" value={layer.height} min={1} max={posterBoxLimit} />
        <NumberField label="旋转角度" name="rotation" value={layer.rotation ?? 0} min={-180} max={180} step="any" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline">应用变换</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void apply({ op: 'remove_image', layerId: layer.id })}>移除图层</Button>
      </div>
    </form>
  </div>
}

function SubjectControls({ poster, apply, disabled, beginSelection }: { poster: PosterDocument; apply: Apply; disabled: boolean; beginSelection(): void }) {
  const { subject, mask } = poster
  return <div className="space-y-5">
    <LayerOpacity opacity={subject.opacity} disabled={disabled} onChange={opacity => apply({ op: 'set_subject', subject: { opacity } })} />
    <form className="space-y-3" onSubmit={event => {
      const form = formValues(event)
      void apply({ op: 'set_mask', mask: { type: 'edge_color', tolerance: Number(form.get('tolerance')) } })
    }}>
      <NumberField label="去纯色背景的容差" name="tolerance" value={mask.type === 'edge_color' ? mask.tolerance : 32} min={1} max={150} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit">去纯色背景</Button>
        <Button size="sm" type="button" variant="outline" onClick={beginSelection}>手动描边</Button>
      </div>
    </form>
    <form className="space-y-3 border-t pt-4" onSubmit={event => {
      const form = formValues(event)
      const n = (name: string) => Number(form.get(name))
      void apply({ op: 'set_subject', subject: {
        x: n('x'), y: n('y'), width: n('width'), height: n('height'), rotation: n('rotation'),
        brightness: n('brightness'), saturation: n('saturation'), visible: form.has('visible')
      } })
    }}>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="横坐标" name="x" value={subject.x} min={-8192} max={8192} />
        <NumberField label="纵坐标" name="y" value={subject.y} min={-8192} max={8192} />
        <NumberField label="宽度" name="width" value={subject.width} min={1} max={8192} />
        <NumberField label="高度" name="height" value={subject.height} min={1} max={8192} />
        <NumberField label="旋转角度" name="rotation" value={subject.rotation} min={-180} max={180} step="any" />
        <NumberField label="亮度 %" name="brightness" value={subject.brightness} min={0} max={200} />
        <NumberField label="饱和度 %" name="saturation" value={subject.saturation} min={0} max={200} />
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="visible" defaultChecked={subject.visible} />显示主体</label>
      <Button type="submit" size="sm" variant="outline">应用主体设置</Button>
    </form>
  </div>
}

function ShadowControls({ poster, apply }: { poster: PosterDocument; apply: Apply }) {
  return <form className="space-y-3" onSubmit={event => {
    const form = formValues(event)
    void apply({ op: 'set_shadow', shadow: { visible: form.has('visible'), color: String(form.get('color')), opacity: Number(form.get('opacity')) / 100 } })
  }}>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="visible" defaultChecked={poster.shadow.visible} />显示接触阴影</label>
    <ColorField label="阴影颜色" name="color" value={poster.shadow.color} />
    <NumberField label="阴影不透明度 %" name="opacity" value={Math.round(poster.shadow.opacity * 100)} min={0} max={100} />
    <Button type="submit" size="sm">应用阴影</Button>
  </form>
}

function TextControls({ layer, apply }: { layer: PosterText; apply: Apply }) {
  return <form key={layer.id} className="space-y-3" onSubmit={event => {
    const form = formValues(event)
    void apply({ op: 'upsert_text', layer: { ...layer, text: String(form.get('text')), color: String(form.get('color')),
      x: Number(form.get('x')), y: Number(form.get('y')), width: Number(form.get('width')), fontSize: Number(form.get('fontSize')),
      align: String(form.get('align')) as PosterText['align'], weight: form.has('bold') ? 'bold' : 'regular', visible: form.has('visible') } })
  }}>
    <Field label="内容"><Textarea name="text" defaultValue={layer.text} maxLength={300} required className="min-h-16 resize-y" /></Field>
    <div className="grid grid-cols-2 gap-3">
      <NumberField label="横坐标" name="x" value={layer.x} min={-8192} max={8192} />
      <NumberField label="纵坐标" name="y" value={layer.y} min={-8192} max={8192} />
      <NumberField label="文字框宽度" name="width" value={layer.width} min={1} max={8192} />
      <NumberField label="字号" name="fontSize" value={layer.fontSize} min={1} max={1000} />
      <ColorField label="文字颜色" name="color" value={layer.color} />
      <Field label="对齐"><select className="setting-select" name="align" defaultValue={layer.align}>
        <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
      </select></Field>
    </div>
    <div className="flex gap-4">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="bold" defaultChecked={layer.weight === 'bold'} />加粗</label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="visible" defaultChecked={layer.visible} />显示文字</label>
    </div>
    <div className="flex gap-2">
      <Button type="submit" size="sm">应用文字</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => apply({ op: 'remove_text', layerId: layer.id })}>移除文字层</Button>
    </div>
  </form>
}
