import { useEffect, useState } from 'react'
import { Check, Minus, Pipette, Plus, Scan, Trash2 } from 'lucide-react'
import { Button } from './ui/button'
import { EditorToolSurface } from './EditorToolSurface'
import { PhotoSelectionCanvas, type PhotoTool } from './PhotoSelectionCanvas'
import { ColorGradeControls } from './ColorGradeControls'
import type { PhotoColorInspection, PhotoEditPreview, PhotoInspection, PhotoMask, PhotoOperation, PhotoPoint, PhotoRegion, PhotoSelection, PhotoSelectionReference, SavedPhotoEdit } from '@/lib/photo-edits'
import type { ColorGrade } from '@/lib/color-grade'
import { hasPhotoArea } from '@/lib/photo-geometry'
import { hasColorGradeChanges } from '@/lib/color-grade-values'

type Props = {
  artworkId: string
  versionId: string
  versionNumber: number
  mode?: 'local' | 'grade'
  recipe?: PhotoOperation[]
  saveDisabled?: boolean
  onSaved(version: SavedPhotoEdit): void
  onSavingChange?(saving: boolean): void
  onSelectionChange?(selection?: PhotoSelectionReference): void
}
const tools = [{ id: 'rectangle', label: '矩形' }, { id: 'ellipse', label: '椭圆' }, { id: 'polygon', label: '描边' }, { id: 'brush', label: '画笔' }] as const
const toneNames = {
  exposure: '曝光', shadows: '阴影', highlights: '高光', redness: '减红',
  temperature: '色温', tint: '色调', saturation: '饱和度', contrast: '对比度'
}
type ToneKey = keyof typeof toneNames
const toneKeys = Object.keys(toneNames) as ToneKey[]
const neutralTone = { exposure: 0, shadows: 0, highlights: 0, redness: 0, temperature: 0, tint: 0, saturation: 0, contrast: 0 }
const operationLabel = { grade: '调色', tone: '基础调色', texture: '纹理', heal: '点修', clone: '克隆', crop: '裁剪',
  resize: '图像尺寸', canvas_size: '画布尺寸' }
const emptyMask = { include: [], exclude: [], feather: 0.01 }

function Range({ label, value, onChange, min = 0, max = 100, step = 1 }: { label: string; value: number; onChange(value: number): void; min?: number; max?: number; step?: number }) {
  return <label className="block space-y-1 text-xs text-slate-700">
    <span className="flex items-center justify-between font-medium"><span>{label}</span><span className="tabular-nums">{value}</span></span>
    <input type="range" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} className="block w-full accent-violet-600" />
  </label>
}

export function LocalPhotoEditor({ artworkId, versionId, versionNumber, mode = 'local', recipe, saveDisabled, onSaved, onSavingChange, onSelectionChange }: Props) {
  const grading = mode === 'grade'
  const firstGradeIndex = recipe?.findIndex(operation => operation.type === 'grade') ?? -1
  const firstGrade = recipe?.[firstGradeIndex]
  const [original, setOriginal] = useState<PhotoInspection>()
  const [crop, setCrop] = useState<PhotoInspection>()
  const [overlay, setOverlay] = useState<PhotoInspection>()
  const [zoomPicking, setZoomPicking] = useState(false)
  const [kind, setKind] = useState<PhotoOperation['type']>(grading ? 'grade' : 'tone')
  const [colors, setColors] = useState<PhotoColorInspection>()
  const [loadingColors, setLoadingColors] = useState(grading)
  const [samplePicking, setSamplePicking] = useState(false)
  const [grade, setGrade] = useState<ColorGrade>(firstGrade?.type === 'grade' ? firstGrade.settings : {})
  const [editingGrade, setEditingGrade] = useState(firstGradeIndex >= 0 ? firstGradeIndex : undefined)
  const [tool, setTool] = useState<PhotoTool>('ellipse')
  const [maskMode, setMaskMode] = useState<'include' | 'exclude'>('include')
  const [mask, setMask] = useState<PhotoMask>(firstGrade?.type === 'grade' ? firstGrade.mask ?? emptyMask : emptyMask)
  const [polygon, setPolygon] = useState<PhotoPoint[]>([])
  const [brushRadius, setBrushRadius] = useState(0.018)
  const [tone, setTone] = useState(neutralTone)
  const [texture, setTexture] = useState(0)
  const [strength, setStrength] = useState(85)
  const [target, setTarget] = useState<PhotoPoint>()
  const [source, setSource] = useState<PhotoPoint>()
  const [pickSource, setPickSource] = useState(false)
  const [operations, setOperations] = useState<PhotoOperation[]>(recipe ?? [])
  const [preview, setPreview] = useState<PhotoEditPreview>()
  const [showComparison, setShowComparison] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const repairing = kind === 'heal' || kind === 'clone'

  useEffect(() => {
    let active = true
    window.studio.inspectPhoto({ artworkId, versionId }).then(result => { if (active) setOriginal(result) })
      .catch(() => { if (active) setError('读取照片失败') })
    return () => { active = false }
  }, [artworkId, versionId])

  useEffect(() => {
    if (!grading) return
    let active = true
    setLoadingColors(true)
    window.studio.inspectPhotoColors({ artworkId, versionId }).then(result => { if (active) setColors(result) })
      .catch(() => { if (active) setError('读取底图直方图失败') })
      .finally(() => { if (active) setLoadingColors(false) })
    return () => { active = false }
  }, [artworkId, versionId, grading])

  useEffect(() => {
    if (!grading) return
    setPreview(undefined)
    setShowComparison(false)
    setStatus('')
  }, [grade, mask, grading, editingGrade])

  const selectedMask = mask.include.length || mask.exclude?.length ? mask : undefined
  useEffect(() => {
    onSelectionChange?.(selectedMask ? { artworkId, versionId, selection: selectedMask } : undefined)
  }, [artworkId, onSelectionChange, selectedMask, versionId])

  const operation: PhotoOperation | undefined = kind === 'grade'
    ? hasColorGradeChanges(grade) ? { type: 'grade', settings: grade, mask: selectedMask } : undefined
    : kind === 'tone'
    ? toneKeys.some(key => tone[key] !== 0) ? { type: 'tone', mask: selectedMask, ...tone } : undefined
    : kind === 'texture' ? texture ? { type: 'texture', mask: selectedMask, amount: texture } : undefined
    : kind === 'heal' ? target ? { type: 'heal', target, source, radius: brushRadius, strength } : undefined
    : target && source ? { type: 'clone', target, source, radius: brushRadius, strength } : undefined
  const nextOperations = grading && operation
    ? editingGrade === undefined ? [...operations, operation] : operations.map((item, index) => index === editingGrade ? operation : item)
    : operations

  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await work() }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败') }
    finally { setBusy(false) }
  }

  function addShape(shape: PhotoSelection) {
    if (zoomPicking) {
      setZoomPicking(false)
      if (shape.type !== 'rectangle') return
      void run(async () => {
        setOverlay(undefined)
        setCrop(await window.studio.inspectPhoto({ artworkId, versionId, region: shape.box }))
      })
      return
    }
    const shapes = mask[maskMode] ?? []
    if (shapes.length >= 12) { setError('每组最多 12 个选区'); return }
    if (shape.type === 'polygon' && !hasPhotoArea(shape.points)) { setError('请确保描边选区有面积'); return }
    setMask({ ...mask, [maskMode]: [...shapes, shape] })
    setError('')
  }

  function pickPoint(point: PhotoPoint) {
    if (samplePicking) {
      const size = 0.016
      const origin = (value: number) => Math.max(0, Math.min(1 - size, value - size / 2))
      setSamplePicking(false)
      void run(async () => setColors(await window.studio.inspectPhotoColors({ artworkId, versionId,
        samples: [{ label: '取样点', region: { x: origin(point.x), y: origin(point.y), width: size, height: size } }] })))
    } else if (repairing) {
      if (pickSource) { setSource(point); setPickSource(false) }
      else setTarget(point)
    } else setPolygon(points => points.length < 160 ? [...points, point] : points)
  }

  function clearDraft() {
    setPreview(undefined)
    setShowComparison(false)
    setStatus('')
  }

  function queueOperation() {
    if (!operation || polygon.length || (operations.length >= 16 && editingGrade === undefined)) return
    clearDraft()
    setOperations(grading ? nextOperations : [...operations, operation])
    setEditingGrade(undefined)
    setGrade({})
    setMask({ include: [], exclude: [], feather: mask.feather })
    setMaskMode('include')
    setOverlay(undefined)
    setTone(neutralTone)
    setTexture(0)
    setTarget(undefined)
    setSource(undefined)
    setPickSource(false)
    setStatus('已添加操作')
  }

  function editGrade(index: number) {
    const step = operations[index]
    if (step.type !== 'grade') return
    setEditingGrade(index)
    setGrade(step.settings)
    setMask(step.mask ?? emptyMask)
    setMaskMode('include')
    setPolygon([])
    setOverlay(undefined)
  }

  function viewMask() {
    if (!selectedMask) return
    void run(async () => {
      const region = crop && normalizedCrop(crop)
      setOverlay(await window.studio.previewPhotoMask({ artworkId, versionId, mask: selectedMask, region }))
      setShowComparison(false)
    })
  }

  function createPreview() {
    void run(async () => {
      const region = crop && normalizedCrop(crop)
      setPreview(await window.studio.previewPhotoEdit({ artworkId, versionId, operations: nextOperations, region }))
      setShowComparison(true)
      setStatus('已生成对比，可另存版本')
    })
  }

  function saveVersion() {
    if (!preview || saveDisabled) return
    void run(async () => {
      onSavingChange?.(true)
      try { onSaved(await window.studio.savePhotoEdit(preview.draftId)) }
      finally { onSavingChange?.(false) }
    })
  }

  function changeKind(next: PhotoOperation['type']) {
    setKind(next)
    setShowComparison(false)
    setOverlay(undefined)
    setZoomPicking(false)
    setPolygon([])
    setPickSource(false)
  }

  const frame = crop || original
  return <EditorToolSurface name={grading ? '调色' : '局部精修'}
    options={<>
        <Button size="sm" aria-pressed={zoomPicking} variant={zoomPicking ? 'secondary' : 'outline'} disabled={busy || !frame} onClick={() => { setZoomPicking(value => !value); setSamplePicking(false); setShowComparison(false); setOverlay(undefined); setPolygon([]) }}><Scan className="h-3.5 w-3.5" />框选放大</Button>
        <Button size="sm" variant="outline" disabled={busy || !frame} onClick={() => { setCrop(undefined); setOverlay(undefined); setShowComparison(false); setZoomPicking(false); setSamplePicking(false) }}>全图</Button>
        <Button size="sm" variant="outline" disabled={busy || !selectedMask || repairing || Boolean(polygon.length)} onClick={overlay ? () => setOverlay(undefined) : viewMask}>{overlay ? '返回编辑' : '查看蒙版'}</Button>
        {grading && <Button size="sm" aria-pressed={samplePicking} variant={samplePicking ? 'secondary' : 'outline'} disabled={busy || !frame} onClick={() => { setSamplePicking(value => !value); setZoomPicking(false); setShowComparison(false); setOverlay(undefined) }}><Pipette className="h-3.5 w-3.5" />颜色取样</Button>}
        {showComparison && <Button size="sm" variant="outline" onClick={() => setShowComparison(false)}>返回编辑</Button>}
    </>}
    properties={<div className="space-y-4">
          {grading ? <ColorGradeControls value={grade} colors={colors} disabled={busy} onChange={setGrade} /> : <div className="grid grid-cols-4 gap-1" aria-label="修图工具">
            {(['tone', 'heal', 'clone', 'texture'] as const).map(item => <Button key={item} size="sm" variant={kind === item ? 'secondary' : 'ghost'} aria-pressed={kind === item} onClick={() => changeKind(item)}>{item === 'tone' ? '调色' : operationLabel[item]}</Button>)}
          </div>}
          {repairing ? <div className="space-y-3">
            <p className="text-xs text-slate-600">{pickSource ? '在图上点击取样位置' : '在图上点击要修复的位置'}</p>
            <div className="flex flex-wrap gap-1"><Button size="sm" variant={pickSource ? 'secondary' : 'outline'} onClick={() => { setPickSource(value => !value); setShowComparison(false); setOverlay(undefined) }}>{source ? '重选取样点' : '选择取样点'}</Button>{source && <Button size="sm" variant="ghost" onClick={() => setSource(undefined)}>清除取样点</Button>}</div>
            <Range label="修复强度" min={1} value={strength} onChange={setStrength} />
          </div> : <fieldset disabled={busy} className="min-w-0 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-600"><span>{mask.include.length ? `${mask.include.length} 个选区` : '作用范围为全图'}{mask.exclude?.length ? `，保护 ${mask.exclude.length} 处` : ''}</span><Button size="sm" variant="ghost" onClick={() => { setMask({ include: [], exclude: [], feather: mask.feather }); setOverlay(undefined); setPolygon([]); setMaskMode('include') }}>清空选区</Button></div>
            <div className="grid grid-cols-4 gap-1">{tools.map(item => <Button key={item.id} size="sm" variant={tool === item.id ? 'secondary' : 'ghost'} aria-pressed={tool === item.id} onClick={() => { setTool(item.id); setPolygon([]); setOverlay(undefined); setShowComparison(false) }}>{item.label}</Button>)}</div>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant={maskMode === 'include' ? 'secondary' : 'outline'} onClick={() => { setMaskMode('include'); setOverlay(undefined); setShowComparison(false) }}><Plus className="h-3.5 w-3.5" />加选</Button>
              <Button size="sm" variant={maskMode === 'exclude' ? 'secondary' : 'outline'} onClick={() => { setMaskMode('exclude'); setOverlay(undefined); setShowComparison(false) }}><Minus className="h-3.5 w-3.5" />保护区域</Button>
              {tool === 'polygon' && <Button size="sm" variant="outline" disabled={polygon.length < 3} onClick={() => { addShape({ type: 'polygon', points: polygon }); setPolygon([]) }}>闭合描边</Button>}
            </div>
            <Range label="羽化（原图短边 %）" max={8} step={0.5} value={Math.round((mask.feather ?? .01) * 1000) / 10} onChange={value => { setOverlay(undefined); setMask(current => ({ ...current, feather: value / 100 })) }} />
          </fieldset>}
          {(repairing || tool === 'brush') && <Range label="笔刷半径（原图短边 %）" min={0.2} max={10} step={0.1} value={Math.round(brushRadius * 1000) / 10} onChange={value => setBrushRadius(value / 100)} />}
          {kind === 'tone' && <div className="grid grid-cols-2 gap-3">{toneKeys.map(key => <Range key={key} label={toneNames[key]} min={key === 'redness' ? 0 : key === 'exposure' ? -2 : -100} max={key === 'exposure' ? 2 : 100} step={key === 'exposure' ? 0.1 : 1} value={tone[key]} onChange={value => setTone(current => ({ ...current, [key]: value }))} />)}</div>}
          {kind === 'texture' && <Range label="纹理（左柔化，右锐化）" min={-100} value={texture} onChange={setTexture} />}
          <Button size="sm" variant="outline" className="w-full" disabled={busy || !operation || Boolean(polygon.length) || (operations.length >= 16 && editingGrade === undefined)} onClick={queueOperation}><Plus className="h-3.5 w-3.5" />{editingGrade === undefined ? grading ? '添加调色步骤' : '添加操作' : '保存此步调整'}</Button>
          {operations.length > 0 && <ol className="space-y-1 border-t pt-2 text-xs text-slate-700" aria-label="待预览操作">{operations.map((op, index) => <li key={index} className="flex min-w-0 items-center justify-between rounded bg-slate-50 pl-2">
            <span>{index + 1}. {operationLabel[op.type]}{'mask' in op && (op.mask ? ' · 局部' : ' · 全图')}{editingGrade === index ? ' · 编辑中' : ''}</span>
            <div className="flex shrink-0">
              {grading && op.type === 'grade' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => editGrade(index)}>编辑此步</Button>}
              <Button size="icon" variant="ghost" className="size-8" aria-label={`移除第 ${index + 1} 项`} disabled={busy} onClick={() => {
                setOperations(items => items.filter((_, i) => i !== index))
                if (editingGrade === index) { setEditingGrade(undefined); setGrade({}); setMask(emptyMask) }
                else if (editingGrade !== undefined && index < editingGrade) setEditingGrade(editingGrade - 1)
                clearDraft()
              }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </li>)}</ol>}
          {(error || status) && <p role={error ? 'alert' : 'status'} className={`break-words text-xs leading-5 ${error ? 'text-red-600' : 'text-slate-600'}`}>{error || status}</p>}
    </div>}
    footer={<div className="flex gap-2">
          <Button className="min-w-0 flex-1" size="sm" variant={preview ? 'outline' : 'default'} disabled={busy || !frame || loadingColors || !nextOperations.length || nextOperations.length > 16 || Boolean(polygon.length) || (editingGrade !== undefined && !operation)} onClick={createPreview}>{busy ? '处理中…' : '预览对比'}</Button>
          <Button className="min-w-0 flex-1" size="sm" disabled={busy || !preview || saveDisabled} onClick={saveVersion}><Check className="h-3.5 w-3.5" />另存版本</Button>
    </div>}
    status={frame && <><span>V{versionNumber}</span><span>{frame.crop.width} × {frame.crop.height} px</span>{crop && <span>局部视图</span>}</>}>
        {showComparison && preview ? <div className="grid h-full w-full grid-cols-2 gap-2 md:gap-4">
          {([{ label: '修图前', src: preview.before }, { label: '修图后', src: preview.after }]).map(item => <figure key={item.label} className="flex min-h-0 min-w-0 flex-col items-center gap-1">
            <figcaption className="shrink-0 rounded bg-white px-2 py-1 text-xs text-slate-700">{item.label}</figcaption>
            <img src={item.src} alt={item.label} className="min-h-0 max-w-full flex-1 object-contain" />
          </figure>)}
        </div> : overlay ? <img src={overlay.src} alt="羽化后的蒙版叠加预览" className="max-h-full max-w-full object-contain" />
          : frame ? <PhotoSelectionCanvas image={frame} tool={zoomPicking ? 'rectangle' : repairing || samplePicking ? 'point' : tool} brushRadius={brushRadius}
            mask={!zoomPicking && !repairing && !samplePicking ? mask : undefined} polygon={zoomPicking || repairing || samplePicking ? [] : polygon}
            target={repairing ? target : undefined} source={repairing ? source : undefined} disabled={busy} onPoint={pickPoint} onShape={addShape} />
          : <span className="rounded bg-white px-3 py-2 text-xs text-slate-600">{error || '正在读取照片…'}</span>}
        {zoomPicking && <span className="pointer-events-none absolute bottom-2 rounded bg-white px-2 py-1 text-xs text-slate-700">在图上拖框放大</span>}
        {samplePicking && <span className="pointer-events-none absolute bottom-2 rounded bg-white px-2 py-1 text-xs text-slate-700">点击想要取样的区域</span>}
  </EditorToolSurface>
}

function normalizedCrop(frame: PhotoInspection): PhotoRegion {
  const { crop, imageWidth, imageHeight } = frame
  return { x: crop.x / imageWidth, y: crop.y / imageHeight, width: Math.max(0.001, crop.width / imageWidth), height: Math.max(0.001, crop.height / imageHeight) }
}
