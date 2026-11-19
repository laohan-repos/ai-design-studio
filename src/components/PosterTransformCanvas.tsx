import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { RotateCw } from 'lucide-react'
import type { PosterBox, PosterDocument, PosterImage, PosterImageTransform, PosterOutput, PosterTransformPreview } from '@/lib/poster'
import { posterBoxLimit, posterCoordinateLimit } from '@/lib/poster-limits'

type ImageLayerId = PosterTransformPreview['layerId']
type Point = { x: number; y: number }
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Edge = 'n' | 'e' | 's' | 'w'
type Handle = Corner | Edge | 'rotate'
type LayerGeometry = { id: ImageLayerId; box: PosterBox; bounds: PosterBox; rotation: number; opacity: number; stretch: boolean }
type Gesture = {
  artworkId: string
  size: PosterOutput['size']
  revision: number
  pointerId?: number
  geometry: LayerGeometry
  start: Point
  scale: Point
  handle?: Handle
  rotationOrigin?: Point
  transform: PosterImageTransform
}
type Draft = {
  gesture: Gesture
  transform: PosterImageTransform
  rendered?: { transform: PosterImageTransform; preview: PosterImage }
}
type Props = {
  poster: PosterDocument
  preview: PosterImage
  size: PosterOutput['size']
  selectedLayerId: string
  disabled: boolean
  onSelect(layerId: ImageLayerId): void
  onTransform(layerId: ImageLayerId, transform: PosterImageTransform): Promise<boolean>
}

const cornerLabels: Record<Corner, string> = { nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角' }
const edgeLabels: Record<Edge, string> = { n: '顶部', e: '右侧', s: '底部', w: '左侧' }
const oppositeCorner: Record<Corner, Corner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }
const arrowSteps: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }
}

function imageLayerId(id: string): id is ImageLayerId {
  return id === 'subject' || id.startsWith('image:')
}

function layerGeometry(poster: PosterDocument, preview: PosterImage, id: string): LayerGeometry | undefined {
  if (!imageLayerId(id)) return
  const bounds = preview.imageBounds[id]
  const layer = id === 'subject' ? poster.subject : poster.imageLayers.find(item => id === `image:${item.id}`)
  if (!bounds || !layer?.visible) return
  const { x, y, width, height, opacity, rotation = 0 } = layer
  return { id, box: { x, y, width, height }, bounds, rotation, opacity, stretch: id === 'subject' && Boolean(poster.subject.stretch) }
}

const coordinate = (value: number) => Math.max(-posterCoordinateLimit, Math.min(posterCoordinateLimit, Math.round(value)))
const radians = (angle: number) => angle * Math.PI / 180
const centerOf = (box: PosterBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

function rotatePoint(point: Point, bounds: PosterBox, angle: number, scale: Point): Point {
  if (!angle) return point
  const rotation = radians(angle)
  const center = centerOf(bounds)
  const x = (point.x - center.x) * scale.x
  const y = (point.y - center.y) * scale.y
  return {
    x: center.x + (x * Math.cos(rotation) - y * Math.sin(rotation)) / scale.x,
    y: center.y + (x * Math.sin(rotation) + y * Math.cos(rotation)) / scale.y
  }
}

function includesPoint(layer: LayerGeometry, point: Point, scale: Point) {
  const { bounds, rotation } = layer
  const { x, y } = rotatePoint(point, bounds, -rotation, scale)
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
}

function cornerPosition(bounds: PosterBox, corner: Corner): Point {
  return {
    x: corner.endsWith('e') ? bounds.x + bounds.width : bounds.x,
    y: corner.startsWith('s') ? bounds.y + bounds.height : bounds.y
  }
}

function transformBox(layer: LayerGeometry, delta: Point, scale: Point, corner?: Corner): PosterBox {
  const { box, bounds, rotation } = layer
  if (!corner) return { ...box, x: coordinate(box.x + delta.x), y: coordinate(box.y + delta.y) }

  const anchor = rotatePoint(cornerPosition(bounds, oppositeCorner[corner]), bounds, rotation, scale)
  const handle = rotatePoint(cornerPosition(bounds, corner), bounds, rotation, scale)
  const diagonalX = (handle.x - anchor.x) * scale.x
  const diagonalY = (handle.y - anchor.y) * scale.y
  // Project onto the visible diagonal so a rotated subject scales around the opposite handle.
  const change = (delta.x * scale.x * diagonalX + delta.y * scale.y * diagonalY) / (diagonalX ** 2 + diagonalY ** 2)
  const minimum = Math.max(1 / box.width, 1 / box.height)
  const maximum = Math.min(posterBoxLimit / box.width, posterBoxLimit / box.height)
  const factor = Math.max(minimum, Math.min(maximum, 1 + change))
  return {
    x: coordinate(anchor.x + (box.x - anchor.x) * factor),
    y: coordinate(anchor.y + (box.y - anchor.y) * factor),
    width: Math.round(box.width * factor),
    height: Math.round(box.height * factor)
  }
}

function stretchBox(layer: LayerGeometry, delta: Point, scale: Point, edge: Edge): PosterImageTransform {
  const horizontal = edge === 'e' || edge === 'w'
  const direction = edge === 'e' || edge === 's' ? 1 : -1
  const angle = radians(layer.rotation)
  const axis = horizontal ? { x: Math.cos(angle), y: Math.sin(angle) } : { x: -Math.sin(angle), y: Math.cos(angle) }
  const unit = horizontal ? scale.x : scale.y
  const oldSize = horizontal ? layer.bounds.width : layer.bounds.height
  const travel = direction * (delta.x * scale.x * axis.x + delta.y * scale.y * axis.y)
  const nextSize = Math.max(1, Math.min(posterBoxLimit, Math.round(oldSize + travel / unit)))
  if (nextSize === Math.round(oldSize)) return layer.box

  // Half the local size change moves the center, leaving the opposite edge in place.
  const shift = direction * (nextSize - oldSize) * unit / 2
  const center = centerOf(layer.bounds)
  const baseline = layer.id === 'subject' && !layer.stretch ? layer.bounds : layer.box
  const width = horizontal ? nextSize : Math.max(1, Math.round(baseline.width))
  const height = horizontal ? Math.max(1, Math.round(baseline.height)) : nextSize
  return {
    x: coordinate(center.x + shift * axis.x / scale.x - width / 2),
    y: coordinate(center.y + shift * axis.y / scale.y - height / 2),
    width, height,
    ...(layer.id === 'subject' ? { stretch: true } : {})
  }
}

function rotateTransform(layer: LayerGeometry, angle: number): PosterImageTransform {
  const adjustment = ((angle + 180) % 360 + 360) % 360 - 180
  if (Math.abs(adjustment) < 0.05) return layer.box
  const combined = layer.rotation + adjustment
  const rotation = Math.round((((combined + 180) % 360 + 360) % 360 - 180) * 10) / 10
  return rotation === layer.rotation ? layer.box : { ...layer.box, rotation }
}

function sameTransform(a: PosterImageTransform, b: PosterImageTransform) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height &&
    a.rotation === b.rotation && a.stretch === b.stretch
}

function resizeTransform(geometry: LayerGeometry, delta: Point, scale: Point, handle?: Handle): PosterImageTransform {
  return handle && handle.length === 1 ? stretchBox(geometry, delta, scale, handle as Edge)
    : transformBox(geometry, delta, scale, handle as Corner | undefined)
}

function applyDrag(gesture: Gesture, client: Point): PosterImageTransform {
  const { start, scale, geometry, handle, rotationOrigin } = gesture
  const delta = { x: (client.x - start.x) / scale.x, y: (client.y - start.y) / scale.y }
  if (rotationOrigin) {
    const x = client.x - rotationOrigin.x, y = client.y - rotationOrigin.y
    if (Math.hypot(x, y) < 2) return gesture.transform
    const startAngle = Math.atan2(start.y - rotationOrigin.y, start.x - rotationOrigin.x)
    return rotateTransform(geometry, (Math.atan2(y, x) - startAngle) * 180 / Math.PI)
  }
  return resizeTransform(geometry, delta, scale, handle)
}

function displayBounds(geometry: LayerGeometry, box: PosterImageTransform): PosterBox {
  if (box.stretch) return box
  const { bounds, box: initial } = geometry
  const sx = box.width / initial.width
  const sy = box.height / initial.height
  return {
    x: box.x + (bounds.x - initial.x) * sx,
    y: box.y + (bounds.y - initial.y) * sy,
    width: bounds.width * sx,
    height: bounds.height * sy
  }
}

function handleAt(target: EventTarget): Handle | undefined {
  if (!(target instanceof Element)) return
  const handle = target.closest<HTMLElement>('[data-transform-rotate], [data-transform-corner], [data-transform-edge]')
  if (!handle) return
  if (handle.hasAttribute('data-transform-rotate')) return 'rotate'
  return (handle.dataset.transformCorner || handle.dataset.transformEdge) as Handle
}

function resizeCursor(angle: number) {
  const directions = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize']
  return directions[((Math.round(angle / 45) % 4) + 4) % 4]
}

export function PosterTransformCanvas({ poster, preview, size, selectedLayerId, disabled, onSelect, onTransform }: Props) {
  const frame = useRef<HTMLDivElement>(null)
  const active = useRef<Gesture>()
  const pending = useRef<{ gesture: Gesture; transform: PosterImageTransform }>()
  const rendering = useRef(false)
  const [draft, setDraft] = useState<Draft>()
  const editable = !disabled && preview.revision === poster.revision
  const selected = preview.revision === poster.revision ? layerGeometry(poster, preview, selectedLayerId) : undefined
  const live = draft?.gesture.artworkId === poster.artworkId && draft.gesture.size === size &&
    draft.gesture.revision === preview.revision ? draft : undefined
  const selection = live?.gesture.geometry.id === selectedLayerId ? live.gesture.geometry : selected
  const rendered = live?.rendered
  const liveBounds = live && rendered && sameTransform(live.transform, rendered.transform) ? rendered.preview.imageBounds[live.gesture.geometry.id] : undefined
  const selectedDraft = selection === live?.gesture.geometry ? live : undefined
  const bounds = selection && (selectedDraft ? liveBounds ?? displayBounds(selection, selectedDraft.transform) : selection.bounds)
  const rotation = selectedDraft?.transform.rotation ?? selection?.rotation ?? 0

  const clear = useCallback(() => {
    const pointerId = active.current?.pointerId
    active.current = undefined
    pending.current = undefined
    if (pointerId !== undefined && frame.current?.hasPointerCapture(pointerId)) frame.current.releasePointerCapture(pointerId)
    setDraft(undefined)
  }, [])

  useEffect(() => {
    const gesture = active.current
    if (!gesture) return
    const stale = gesture.artworkId !== poster.artworkId || gesture.size !== size || gesture.revision !== preview.revision
    if (stale || (gesture.pointerId !== undefined && (disabled || gesture.revision !== poster.revision || gesture.geometry.id !== selectedLayerId))) clear()
  }, [clear, disabled, poster.artworkId, poster.revision, preview.revision, selectedLayerId, size])

  useEffect(() => () => {
    active.current = undefined
    pending.current = undefined
  }, [])

  async function renderLatest() {
    const request = pending.current
    pending.current = undefined
    if (request) {
      const { gesture, transform } = request
      try {
        const { rotation, stretch, ...box } = transform
        const image = await window.studio.previewPoster(gesture.artworkId, gesture.size, {
          revision: gesture.revision, layerId: gesture.geometry.id, box, rotation, stretch
        })
        if (active.current === gesture && (gesture.pointerId !== undefined || sameTransform(transform, gesture.transform))) {
          setDraft(current => current?.gesture === gesture ? { ...current, rendered: { transform, preview: image } } : current)
        }
      } catch {
        // A concurrent edit can invalidate a transient render. The committed preview will refresh separately.
      }
    }
    if (pending.current) requestAnimationFrame(() => void renderLatest())
    else rendering.current = false
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!editable || active.current || event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const scale = { x: rect.width / poster.width, y: rect.height / poster.height }
    const point = { x: (event.clientX - rect.left) / scale.x, y: (event.clientY - rect.top) / scale.y }
    const handle = handleAt(event.target)
    let layer = selected
    if (!handle && (!selected || !includesPoint(selected, point, scale))) {
      layer = undefined
      for (const id of poster.layerOrder.slice().reverse()) {
        const candidate = layerGeometry(poster, preview, id)
        if (candidate?.opacity && includesPoint(candidate, point, scale)) { layer = candidate; break }
      }
    }
    if (!layer) return
    if (layer.id !== selectedLayerId) onSelect(layer.id)
    const center = centerOf(layer.bounds)
    active.current = {
      artworkId: poster.artworkId, revision: poster.revision, size, pointerId: event.pointerId,
      geometry: layer, start: { x: event.clientX, y: event.clientY }, scale, handle, transform: layer.box,
      rotationOrigin: handle === 'rotate' ? { x: rect.left + center.x * scale.x, y: rect.top + center.y * scale.y } : undefined
    }
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function update(event: PointerEvent<HTMLDivElement>, finish = false) {
    const gesture = active.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (!editable) { clear(); return }
    const transform = applyDrag(gesture, { x: event.clientX, y: event.clientY })
    if (!sameTransform(transform, gesture.transform)) {
      gesture.transform = transform
      setDraft(current => ({ gesture, transform, rendered: current?.gesture === gesture ? current.rendered : undefined }))
      pending.current = { gesture, transform }
      if (!rendering.current) {
        rendering.current = true
        requestAnimationFrame(() => void renderLatest())
      }
    }
    if (!finish) return
    if (sameTransform(transform, gesture.geometry.box)) { clear(); return }
    gesture.pointerId = undefined
    void onTransform(gesture.geometry.id, transform).then(saved => {
      if (!saved && active.current === gesture) clear()
    }, () => { if (active.current === gesture) clear() })
  }

  function cancel(event: PointerEvent<HTMLDivElement>) {
    if (active.current?.pointerId === event.pointerId) clear()
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && active.current?.pointerId !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      clear()
      return
    }
    const step = arrowSteps[event.key]
    if (!editable || active.current || !selected || !step) return
    event.preventDefault()
    event.stopPropagation()
    const multiplier = event.shiftKey ? 10 : 1
    const handle = handleAt(event.target)
    const scale = { x: preview.width / poster.width, y: preview.height / poster.height }
    const transform = handle === 'rotate' ? rotateTransform(selected, (step.x || step.y) * multiplier)
      : resizeTransform(selected, { x: step.x * multiplier, y: step.y * multiplier }, scale, handle)
    if (!sameTransform(transform, selected.box)) void onTransform(selected.id, transform)
  }

  const ratio = preview.width / preview.height
  const rotationAnchor = bounds && rotatePoint({ x: centerOf(bounds).x, y: bounds.y }, bounds, rotation,
    { x: preview.width / poster.width, y: preview.height / poster.height })
  const rotationHandlePosition = (position: number, offset: number, axis: number) =>
    `clamp(12px, calc(${position / axis * 100}% ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}px), calc(100% - 12px))`
  return <div className="flex h-full w-full items-center justify-center [container-type:size]">
    <div ref={frame} className={`relative touch-none select-none rounded-sm focus-visible:outline focus-visible:outline-violet-500 ${editable && selected ? 'cursor-move' : ''}`}
      role="group" aria-label="海报画布，拖动图片移动，拖动角点缩放，拖动边缘拉伸" tabIndex={0}
      style={{ width: `min(100cqw, ${ratio * 100}cqh)`, aspectRatio: ratio }}
      onPointerDown={start} onPointerMove={event => update(event)} onPointerUp={event => update(event, true)}
      onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={nudge}>
      <img alt="图层合成预览" src={rendered?.preview.src ?? preview.src} draggable={false}
        className="checkerboard pointer-events-none absolute inset-0 block size-full rounded-sm shadow-xl" />
      {bounds && selection && <div className="pointer-events-none absolute border border-violet-600 shadow-[0_0_0_1px_rgba(255,255,255,0.6)]"
        style={{ left: `${bounds.x / poster.width * 100}%`, top: `${bounds.y / poster.height * 100}%`,
          width: `${bounds.width / poster.width * 100}%`, height: `${bounds.height / poster.height * 100}%`, transform: `rotate(${rotation}deg)` }}>
        {(Object.keys(cornerLabels) as Corner[]).map(corner => <button key={corner} type="button"
          data-transform-corner={corner} disabled={!editable} aria-label={`从${cornerLabels[corner]}缩放图层`}
          className="pointer-events-auto absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center focus-visible:outline focus-visible:outline-violet-300 disabled:pointer-events-none"
          style={{ left: corner.endsWith('e') ? '100%' : 0, top: corner.startsWith('s') ? '100%' : 0,
            cursor: resizeCursor(rotation + (corner === 'nw' || corner === 'se' ? 45 : 135)) }}>
          <span className="pointer-events-none size-2.5 rounded-sm border border-violet-600 bg-white shadow" />
        </button>)}
        {(Object.keys(edgeLabels) as Edge[]).map(edge => <button key={edge} type="button"
          data-transform-edge={edge} disabled={!editable} aria-label={`从${edgeLabels[edge]}拉伸图层`}
          className="pointer-events-auto absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center focus-visible:outline focus-visible:outline-violet-300 disabled:pointer-events-none"
          style={{ left: edge === 'w' ? 0 : edge === 'e' ? '100%' : '50%', top: edge === 'n' ? 0 : edge === 's' ? '100%' : '50%',
            cursor: resizeCursor(rotation + (edge === 'n' || edge === 's' ? 90 : 0)) }}>
          <span className="pointer-events-none size-2 rounded-full border border-violet-600 bg-white shadow" />
        </button>)}
      </div>}
      {rotationAnchor && <button type="button" data-transform-rotate="" disabled={!editable} aria-label="旋转图层" title="拖动旋转，方向键微调"
        className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded-full border border-violet-600 bg-white text-violet-700 shadow focus-visible:outline focus-visible:outline-violet-300 disabled:pointer-events-none"
        style={{ left: rotationHandlePosition(rotationAnchor.x, Math.sin(radians(rotation)) * 26, poster.width),
          top: rotationHandlePosition(rotationAnchor.y, -Math.cos(radians(rotation)) * 26, poster.height) }}>
        <RotateCw className="pointer-events-none size-3.5" aria-hidden="true" />
      </button>}
    </div>
  </div>
}
