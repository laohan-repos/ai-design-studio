import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Check, Crop, Crosshair, RotateCcw, Ruler } from 'lucide-react'
import { Button } from './ui/button'
import { EditorToolSurface } from './EditorToolSurface'
import type { PhotoEditPreview, PhotoInspection, PhotoPoint, SavedPhotoEdit } from '@/lib/photo-edits'
import { cropAspectMatches, cropAspects, fitCrop, goldenGrid, moveCrop, resizeCrop,
  type CropAspect, type CropBox, type CropCorner, type CropSuggestion } from '@/lib/photo-crop'
import { constrainStraightenedCrop, cropFitsStraighten, fitStraightenedCrop, horizonCorrection, maxStraightenAngle } from '@/lib/photo-straighten'

type Props = {
  artworkId: string
  versionId: string
  versionNumber: number
  initialBox?: CropBox
  initialAngle?: number
  saveDisabled?: boolean
  onSaved(version: SavedPhotoEdit): void
  onSavingChange?(saving: boolean): void
}
type AspectChoice = CropAspect | 'free'
type CropGesture = { pointerId: number; start: PhotoPoint } & (
  { type: 'straighten' } | { type: 'crop'; initial: CropBox; corner?: CropCorner }
)
const cornerLabels: Record<CropCorner, string> = { nw: '左上', ne: '右上', sw: '左下', se: '右下' }
const fullImage = ({ imageWidth, imageHeight }: PhotoInspection) => ({ x: 0, y: 0, width: imageWidth, height: imageHeight })
const percent = (value: number, length: number) => `${value * 100 / length}%`
const handlePosition = (value: number, length: number) => `clamp(12px, ${percent(value, length)}, calc(100% - 12px))`
const cornerPoint = (box: CropBox, corner: CropCorner) => ({
  x: box.x + (corner.endsWith('e') ? box.width : 0),
  y: box.y + (corner.startsWith('s') ? box.height : 0),
})

export function PhotoCropEditor({ artworkId, versionId, versionNumber, initialBox, initialAngle = 0, saveDisabled, onSaved, onSavingChange }: Props) {
  const [image, setImage] = useState<PhotoInspection>()
  const [box, setBox] = useState<CropBox>()
  const [aspect, setAspect] = useState<AspectChoice>('original')
  const [angle, setAngle] = useState(initialAngle)
  const [angleText, setAngleText] = useState(String(initialAngle))
  const [straightening, setStraightening] = useState(false)
  const [horizon, setHorizon] = useState<{ start: PhotoPoint; end: PhotoPoint }>()
  const [grid, setGrid] = useState(true)
  const [pickFocus, setPickFocus] = useState(false)
  const [focus, setFocus] = useState<PhotoPoint>()
  const [candidates, setCandidates] = useState<CropSuggestion[]>([])
  const [activeCandidate, setActiveCandidate] = useState<number>()
  const [preview, setPreview] = useState<PhotoEditPreview>()
  const [compare, setCompare] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const gesture = useRef<CropGesture>()
  const preferredBox = useRef<CropBox>()
  const size = image && { width: image.imageWidth, height: image.imageHeight }

  useEffect(() => {
    let active = true
    window.studio.inspectPhoto({ artworkId, versionId }).then(result => {
      if (!active) return
      const original = fullImage(result)
      const restored = initialBox && cropFitsStraighten(initialBox, original, initialAngle)
      const restoredBox = restored ? initialBox : original
      const restoredAngle = restored ? initialAngle : 0
      setImage(result)
      setBox(restoredBox)
      preferredBox.current = restoredBox
      setAngle(restoredAngle)
      setAngleText(String(restoredAngle))
      setAspect(restored ? cropAspects.find(key => cropAspectMatches(initialBox, original, key)) ?? 'free' : 'original')
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : '读取原图失败') })
    return () => { active = false }
  }, [artworkId, versionId, initialBox, initialAngle])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await work() }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '裁剪失败') }
    finally { setBusy(false) }
  }

  function updateBox(next: CropBox, candidate?: number, preferred = next) {
    preferredBox.current = preferred
    setBox(next)
    setActiveCandidate(candidate)
    setPreview(undefined)
    setCompare(false)
    setStatus('')
    setError('')
  }

  function selectAspect(next: AspectChoice) {
    if (!size || !box) return
    const preferred = next === 'free' ? box : fitCrop(size, next, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    const adjusted = preferred && fitStraightenedCrop(preferred, size, angle, next === 'free' ? undefined : next)
    if (!adjusted) { setError('这张图片太小，无法裁成该比例'); return }
    setAspect(next)
    setCandidates([])
    updateBox(adjusted, undefined, preferred)
  }

  function setStraightenAngle(value: number) {
    if (!size || !box || !Number.isFinite(value)) {
      setAngleText(String(angle))
      return
    }
    const next = Math.max(-maxStraightenAngle, Math.min(maxStraightenAngle, Math.round(value * 10) / 10))
    if (next === angle) {
      setAngleText(String(angle))
      setStraightening(false)
      setHorizon(undefined)
      return
    }
    const preferred = preferredBox.current ?? box
    const adjusted = fitStraightenedCrop(preferred, size, next, aspect === 'free' ? undefined : aspect)
    if (!adjusted) {
      setAngleText(String(angle))
      setError('此角度下没有足够的图像区域，请缩小角度或更换画幅比例')
      return
    }
    setAngle(next)
    setAngleText(String(next))
    setStraightening(false)
    setHorizon(undefined)
    setCandidates([])
    setPickFocus(false)
    updateBox(adjusted, undefined, preferred)
  }

  function resetCrop() {
    if (!image) return
    const preferred = fullImage(image)
    const adjusted = fitStraightenedCrop(preferred, preferred, angle, 'original')
    if (!adjusted) {
      setError('此角度下没有足够的图像区域保留原比例')
      return
    }
    setAspect('original')
    setCandidates([])
    setPickFocus(false)
    updateBox(adjusted, undefined, preferred)
  }

  function toggleStraightening() {
    setCompare(false)
    setPickFocus(false)
    setHorizon(undefined)
    setStraightening(value => !value)
    setError('')
  }

  function suggest() {
    if (!box) return
    void run(async () => {
      const targetAspect = aspect === 'free' ? 'original' : aspect
      const result = await window.studio.suggestPhotoCrops({ artworkId, versionId, aspect: targetAspect, focus, count: 2 })
      setCandidates(result.candidates)
      if (!result.candidates.length) { setError('当前比例在这张图上无法生成裁剪框'); return }
      setPickFocus(false)
      setAspect(targetAspect)
      updateBox(result.candidates[0].box, 0)
      setStatus(focus ? '已按选中的重点计算裁法' : '已给出居中裁法，点选重点可生成黄金构图建议')
    })
  }

  function previewCrop() {
    if (!box) return
    setPickFocus(false)
    setStraightening(false)
    void run(async () => {
      setPreview(await window.studio.previewPhotoEdit({ artworkId, versionId, operations: [{ type: 'crop', box, ...(angle && { angle }) }] }))
      setCompare(true)
      setStatus('已生成裁剪对比，可另存版本')
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

  function location(event: PointerEvent<HTMLDivElement>) {
    const frame = event.currentTarget.getBoundingClientRect()
    const fraction = (value: number, start: number, length: number) => Math.min(1, Math.max(0, (value - start) / length))
    return { x: fraction(event.clientX, frame.left, frame.width) * size!.width, y: fraction(event.clientY, frame.top, frame.height) * size!.height }
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!size || !box || busy || event.button !== 0 || gesture.current) return
    const point = location(event)
    if (straightening) {
      gesture.current = { type: 'straighten', pointerId: event.pointerId, start: point }
      setHorizon({ start: point, end: point })
      setError('')
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (pickFocus) {
      setFocus({ x: point.x / size.width, y: point.y / size.height })
      setPickFocus(false)
      setCandidates([])
      setActiveCandidate(undefined)
      setStatus('已选中构图重点')
      return
    }
    const handle = (event.target as HTMLElement).dataset.cropHandle as CropCorner | undefined
    const inside = point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
    if (!handle && !inside) return
    gesture.current = { type: 'crop', pointerId: event.pointerId, initial: box, start: point, corner: handle }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function dragBox(initial: CropBox, dx: number, dy: number, corner?: CropCorner) {
    if (!size) return initial
    const origin = corner && cornerPoint(initial, corner)
    const candidateAt = (fraction: number) => corner && origin
      ? resizeCrop(initial, size, corner, { x: origin.x + dx * fraction, y: origin.y + dy * fraction }, aspect === 'free' ? undefined : aspect)
      : moveCrop(initial, size, dx * fraction, dy * fraction)
    return constrainStraightenedCrop(initial, size, angle, candidateAt)
  }

  function update(event: PointerEvent<HTMLDivElement>, finish: boolean) {
    const drag = gesture.current
    if (!drag || drag.pointerId !== event.pointerId || !size) return
    const point = location(event)
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y
    if (finish) gesture.current = undefined
    if (drag.type === 'straighten') {
      setHorizon(finish ? undefined : { start: drag.start, end: point })
      if (!finish) return
      const { width, height } = event.currentTarget.getBoundingClientRect()
      if (Math.hypot(dx * width / size.width, dy * height / size.height) < 8) {
        setError('请沿需要拉直的边缘拖出一条线')
        return
      }
      const correction = horizonCorrection(drag.start, point)
      if (Math.abs(correction) > maxStraightenAngle) {
        setError('请沿接近水平的边缘拖出参考线')
        return
      }
      setStraightenAngle(correction)
      return
    }
    if (!dx && !dy && box === drag.initial) return
    const next = dragBox(drag.initial, dx, dy, drag.corner)
    if (next.x !== box?.x || next.y !== box?.y || next.width !== box?.width || next.height !== box?.height) updateBox(next)
  }

  function nudge(event: KeyboardEvent, corner?: CropCorner) {
    if (!box || !size || busy || straightening) return
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    if (!direction) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 10 : 1
    let dx = direction[0] * step, dy = direction[1] * step
    if (corner && aspect !== 'free') {
      const sideX = corner.endsWith('e') ? 1 : -1
      const sideY = corner.startsWith('s') ? 1 : -1
      const [width, height] = aspect === 'original'
        ? [Math.max(1, size.width / size.height), Math.max(1, size.height / size.width)]
        : aspect.split(':').map(Number)
      const units = dx * sideX + dy * sideY
      dx = units * width * sideX
      dy = units * height * sideY
    }
    const next = dragBox(box, dx, dy, corner)
    if (next.x !== box.x || next.y !== box.y || next.width !== box.width || next.height !== box.height) updateBox(next)
  }

  const changed = box && size && (angle !== 0 || box.width !== size.width || box.height !== size.height)
  return <EditorToolSurface name="黄金构图裁剪"
    options={<>
      {compare && <Button size="sm" variant="outline" onClick={() => setCompare(false)}>返回裁剪</Button>}
    </>}
    properties={<div className="space-y-4">
          <section className="space-y-2" aria-label="裁剪比例">
            <div className="flex items-center justify-between text-xs text-slate-600"><span className="font-medium text-slate-700">画幅比例</span>{box && <span className="tabular-nums">{box.width} × {box.height} px</span>}</div>
            <div className="grid grid-cols-4 gap-1">{([...cropAspects, 'free'] as const).map(key => <Button key={key} size="sm" variant={aspect === key ? 'secondary' : 'outline'} className="min-w-0 px-1" aria-pressed={aspect === key} disabled={busy || !size} onClick={() => selectAspect(key)}>{key === 'original' ? '原比例' : key === 'free' ? '自由' : key}</Button>)}</div>
            <label className="flex h-9 items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} className="size-4 accent-violet-600" />显示黄金网格</label>
            <Button size="sm" variant="ghost" disabled={busy || !image} onClick={resetCrop}><RotateCcw className="h-3.5 w-3.5" />重置裁剪框</Button>
          </section>
          <section className="space-y-2 border-t pt-3" aria-label="拉直照片">
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant={straightening ? 'secondary' : 'outline'} aria-pressed={straightening} disabled={busy || !image} onClick={toggleStraightening}><Ruler className="h-3.5 w-3.5" />拉直</Button>
              {angle !== 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStraightenAngle(0)}>重置角度</Button>}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-700">角度
                <input aria-label="角度" type="range" className="min-w-0 flex-1 accent-violet-600"
                  min={-maxStraightenAngle} max={maxStraightenAngle} step={0.1} value={angle} disabled={busy || !image}
                  onChange={event => setStraightenAngle(event.currentTarget.valueAsNumber)} />
              </label>
              <div className="flex items-center gap-1 text-xs text-slate-600">
                <input aria-label="拉直角度" type="number" className="h-8 w-[4.5rem] rounded-md border border-slate-200 bg-white px-1.5 text-right text-xs"
                  min={-maxStraightenAngle} max={maxStraightenAngle} step={0.1} disabled={busy || !image}
                  value={angleText} onChange={event => setAngleText(event.currentTarget.value)}
                  onBlur={() => setStraightenAngle(angleText.trim() ? Number(angleText) : angle)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
                    if (event.key === 'Escape') { event.stopPropagation(); setAngleText(String(angle)) }
                  }} />°
              </div>
            </div>
          </section>
          {angle === 0 && !straightening && <section className="space-y-2 border-t pt-3" aria-label="推荐裁法">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={pickFocus ? 'secondary' : 'outline'} disabled={busy || !image} onClick={() => { setCompare(false); setPickFocus(value => !value) }}><Crosshair className="h-3.5 w-3.5" />{focus ? '重选重点' : '点选重点'}</Button>
              <Button size="sm" variant="outline" disabled={busy || !image} onClick={suggest}>推荐裁法</Button>
              {focus && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setFocus(undefined); setCandidates([]); setActiveCandidate(undefined); setPickFocus(false) }}>清除重点</Button>}
            </div>
            {candidates.length > 0 && <div className="grid grid-cols-2 gap-2">{candidates.map((item, index) => <button key={index} disabled={busy} aria-pressed={activeCandidate === index} onClick={() => updateBox(item.box, index)} className={`overflow-hidden rounded-md border text-left text-xs ${activeCandidate === index ? 'border-violet-500 bg-violet-50' : 'border-slate-200'}`}>
              <img src={item.preview} alt={`裁法 ${index + 1} 缩略图`} className="h-20 w-full bg-slate-100 object-contain" />
              <span className="block p-1.5">裁法 {index + 1} · 保留 {item.retainedPercent}%</span>
            </button>)}</div>}
          </section>}
          {(error || status) && <p role={error ? 'alert' : 'status'} className={`break-words text-xs leading-5 ${error ? 'text-red-600' : 'text-slate-600'}`}>{error || status}</p>}
    </div>}
    footer={<div className="flex gap-2">
          <Button size="sm" className="min-w-0 flex-1" variant={preview ? 'outline' : 'default'} disabled={busy || !changed} onClick={previewCrop}><Crop className="h-3.5 w-3.5" />预览裁剪</Button>
          <Button size="sm" className="min-w-0 flex-1" disabled={busy || !preview || saveDisabled} onClick={saveVersion}><Check className="h-3.5 w-3.5" />另存版本</Button>
    </div>}
    status={size && <><span>V{versionNumber}</span><span>{size.width} × {size.height} px</span>{changed && <span>裁剪为 {box.width} × {box.height} px</span>}</>}>
        {compare && preview ? <div className="grid h-full w-full grid-cols-2 gap-2 md:gap-4">
          {[{ label: preview.cropAngle ? '拉直后的裁剪框' : '原图裁剪框', src: preview.before }, { label: '裁剪后', src: preview.after }].map(item => <figure key={item.label} className="flex min-h-0 min-w-0 flex-col items-center gap-1">
            <figcaption className="shrink-0 rounded bg-white px-2 py-1 text-xs">{item.label}</figcaption>
            <img alt={item.label} src={item.src} className="min-h-0 max-w-full flex-1 object-contain" />
          </figure>)}
        </div> : image && box && size ? <div className="flex h-full w-full items-center justify-center [container-type:size]">
          <div className={`relative touch-none select-none overflow-hidden rounded-sm focus-visible:outline focus-visible:outline-violet-500 ${straightening ? 'cursor-crosshair' : angle ? 'bg-slate-950' : ''}`} tabIndex={0}
            aria-label={straightening ? '拉直画布，拖动标出水平参考线' : '裁剪画布，可拖动裁剪框或使用方向键移动'}
            style={{ width: `min(100cqw, ${size.width / size.height * 100}cqh)`, aspectRatio: size.width / size.height }}
            onPointerDown={start} onPointerMove={event => update(event, false)} onPointerUp={event => update(event, true)}
            onLostPointerCapture={() => { gesture.current = undefined; setHorizon(undefined) }} onKeyDown={event => nudge(event)}>
            <img draggable={false} alt="待裁剪的源图" src={image.src} className="pointer-events-none block h-full w-full"
              style={angle && !straightening ? { transform: `rotate(${angle}deg)` } : undefined} />
            {!straightening && <div className={`absolute border border-white/90 shadow-[0_0_0_9999px_rgba(15,23,42,0.62)] ${pickFocus ? 'pointer-events-none' : 'cursor-move'}`}
              style={{ left: percent(box.x, size.width), top: percent(box.y, size.height), width: percent(box.width, size.width), height: percent(box.height, size.height) }}>
              {grid && goldenGrid.map(fraction => <div key={fraction} aria-hidden="true" className="pointer-events-none absolute inset-0">
                <span className="absolute inset-y-0 border-l border-white/70" style={{ left: `${fraction * 100}%` }} />
                <span className="absolute inset-x-0 border-t border-white/70" style={{ top: `${fraction * 100}%` }} />
              </div>)}
            </div>}
            {!pickFocus && !straightening && (Object.keys(cornerLabels) as CropCorner[]).map(corner => {
              const { x, y } = cornerPoint(box, corner)
              return <button type="button" key={corner} aria-label={`调整${cornerLabels[corner]}角`} data-crop-handle={corner} disabled={busy}
                className={`absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center focus-visible:outline focus-visible:outline-violet-300 ${corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
                style={{ left: handlePosition(x, size.width), top: handlePosition(y, size.height) }}
                onKeyDown={event => nudge(event, corner)}><span className="pointer-events-none size-2.5 rounded-sm border border-violet-400 bg-white shadow" /></button>
            })}
            {focus && angle === 0 && !straightening && <span aria-hidden="true" className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet-600 shadow" style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }} />}
            {horizon && <span aria-hidden="true" className="pointer-events-none absolute h-0.5 origin-left bg-white shadow-[0_0_0_1px_#7c3aed]"
              style={{ left: percent(horizon.start.x, size.width), top: percent(horizon.start.y, size.height),
                width: percent(Math.hypot(horizon.end.x - horizon.start.x, horizon.end.y - horizon.start.y), size.width),
                transform: `rotate(${Math.atan2(horizon.end.y - horizon.start.y, horizon.end.x - horizon.start.x)}rad)` }} />}
          </div>
        </div> : <div className="grid h-full place-items-center text-sm text-slate-600">{error || '正在读取照片…'}</div>}
        {pickFocus && <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-white px-2 py-1 text-xs">在原图上点一下视觉重点</span>}
        {straightening && <span className="pointer-events-none absolute bottom-2 left-1/2 max-w-full -translate-x-1/2 rounded bg-white px-2 py-1 text-center text-xs">拖动标出地平线或其他应当水平的边缘</span>}
  </EditorToolSurface>
}
