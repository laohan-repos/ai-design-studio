import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { PosterLayerMaskPreview, PosterMaskStroke, PosterPoint } from '@/lib/poster'
import { posterMaskStrokePointLimit } from '@/lib/poster-limits'
import { resampleStroke } from '@/lib/stroke-points'

type Props = {
  preview: PosterLayerMaskPreview
  mode: PosterMaskStroke['mode']
  radius: number
  disabled: boolean
  showOverlay: boolean
  onStroke(stroke: PosterMaskStroke): Promise<boolean>
}
type MaskImages = { preview: PosterLayerMaskPreview; source: HTMLImageElement; mask: HTMLImageElement }
type Gesture = {
  pointerId?: number
  preview: PosterLayerMaskPreview
  stroke: PosterMaskStroke
}
function decodeImage(src: string) {
  const image = new Image()
  image.src = src
  return image.decode().then(() => image)
}

function paintStroke(context: CanvasRenderingContext2D, stroke: PosterMaskStroke, width: number, height: number) {
  const radius = stroke.radius * Math.min(width, height)
  const [first, ...rest] = stroke.points
  context.save()
  context.globalCompositeOperation = stroke.mode === 'hide' ? 'destination-out' : 'source-over'
  context.beginPath()
  if (rest.length) {
    context.lineWidth = radius * 2
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = '#fff'
    context.moveTo(first.x * width, first.y * height)
    for (const point of rest) context.lineTo(point.x * width, point.y * height)
    context.stroke()
  } else {
    context.fillStyle = '#fff'
    context.arc(first.x * width, first.y * height, radius, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
}

export function PosterMaskCanvas({ preview, mode, radius, disabled, showOverlay, onStroke }: Props) {
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const maskCanvas = useRef<HTMLCanvasElement>()
  const cursor = useRef<SVGCircleElement>(null)
  const gesture = useRef<Gesture>()
  const paint = useRef<() => void>(() => {})
  const nextFrame = useRef<number>()
  const [images, setImages] = useState<MaskImages>()
  const [failed, setFailed] = useState(false)
  const ready = images?.preview === preview
  const { width, height } = images?.preview ?? preview
  const ratio = width / height

  useEffect(() => {
    let current = true
    setFailed(false)
    Promise.all([decodeImage(preview.source), decodeImage(preview.mask)]).then(([source, mask]) => {
      if (current) setImages({ preview, source, mask })
    }, () => { if (current) setFailed(true) })
    return () => { current = false }
  }, [preview])

  const schedulePaint = useCallback(() => {
    if (nextFrame.current !== undefined) return
    nextFrame.current = requestAnimationFrame(() => {
      nextFrame.current = undefined
      paint.current()
    })
  }, [])

  const clearGesture = useCallback(() => {
    const pointerId = gesture.current?.pointerId
    gesture.current = undefined
    if (pointerId !== undefined && frame.current?.hasPointerCapture(pointerId)) frame.current.releasePointerCapture(pointerId)
    schedulePaint()
  }, [schedulePaint])

  useLayoutEffect(() => {
    const active = gesture.current
    if (!active) return
    if (active.pointerId === undefined ? ready && active.preview !== preview : disabled || active.preview !== preview) clearGesture()
  }, [clearGesture, disabled, preview, ready])

  useLayoutEffect(() => {
    paint.current = () => {
      if (!images) return
      const context = canvas.current?.getContext('2d')
      if (!context) return
      const { width, height } = images.preview
      const mask = maskCanvas.current ??= document.createElement('canvas')
      if (mask.width !== width) mask.width = width
      if (mask.height !== height) mask.height = height
      const alpha = mask.getContext('2d')
      if (!alpha) return
      alpha.clearRect(0, 0, width, height)
      alpha.drawImage(images.mask, 0, 0, width, height)
      const active = gesture.current
      if (active?.preview === images.preview) paintStroke(alpha, active.stroke, width, height)

      context.clearRect(0, 0, width, height)
      context.save()
      if (showOverlay) {
        context.fillStyle = 'rgba(239, 68, 68, 0.48)'
        context.fillRect(0, 0, width, height)
        context.globalCompositeOperation = 'destination-out'
        context.drawImage(mask, 0, 0)
        context.globalCompositeOperation = 'destination-atop'
        context.drawImage(images.source, 0, 0, width, height)
      } else {
        context.drawImage(images.source, 0, 0, width, height)
        context.globalCompositeOperation = 'destination-in'
        context.drawImage(mask, 0, 0)
      }
      context.restore()
    }
    paint.current()
  }, [images, showOverlay])

  useEffect(() => () => {
    if (nextFrame.current !== undefined) cancelAnimationFrame(nextFrame.current)
    nextFrame.current = undefined
    gesture.current = undefined
  }, [])

  function pointsAt(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const relative = (value: number, offset: number, size: number) => Math.min(1, Math.max(0, (value - offset) / size))
    const point = (sample: { clientX: number; clientY: number }): PosterPoint => ({
      x: relative(sample.clientX, bounds.left, bounds.width),
      y: relative(sample.clientY, bounds.top, bounds.height)
    })
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
    return [...samples.map(point), point(event)]
  }

  function placeCursor(point?: PosterPoint, activeRadius = radius) {
    if (!cursor.current) return
    cursor.current.style.visibility = point ? 'visible' : 'hidden'
    if (!point) return
    cursor.current.setAttribute('cx', String(point.x * width))
    cursor.current.setAttribute('cy', String(point.y * height))
    cursor.current.setAttribute('r', String(activeRadius * Math.min(width, height)))
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (disabled || !ready || gesture.current || event.button !== 0) return
    const point = pointsAt(event).at(-1)!
    placeCursor(point)
    gesture.current = { pointerId: event.pointerId, preview, stroke: { mode, radius, points: [point] } }
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    schedulePaint()
  }

  function update(event: PointerEvent<HTMLDivElement>, finish = false) {
    const active = gesture.current
    if (disabled || !ready || (active && active.pointerId !== event.pointerId)) return
    const samples = pointsAt(event)
    placeCursor(samples.at(-1), active?.stroke.radius)
    if (!active) return
    const minimumStep = Math.min(1.5, Math.max(0.25, active.stroke.radius * Math.min(width, height) * 0.04))
    for (const [index, point] of samples.entries()) {
      const previous = active.stroke.points.at(-1)!
      const threshold = finish && index === samples.length - 1 ? 0.01 : minimumStep
      if (Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height) >= threshold) active.stroke.points.push(point)
    }
    if (active.stroke.points.length > posterMaskStrokePointLimit * 4) {
      active.stroke.points = resampleStroke(active.stroke.points, posterMaskStrokePointLimit * 2, width, height)
    }
    schedulePaint()
    if (!finish) return

    active.pointerId = undefined
    active.stroke.points = resampleStroke(active.stroke.points, posterMaskStrokePointLimit, width, height)
    placeCursor()
    void onStroke(active.stroke).then(saved => {
      if (!saved && gesture.current === active) clearGesture()
    }, () => { if (gesture.current === active) clearGesture() })
  }

  function cancel(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return
    placeCursor()
    clearGesture()
  }

  return <div className="flex h-full w-full items-center justify-center [container-type:size]">
    <div ref={frame} aria-label="图层蒙版画布" role="group" tabIndex={0}
      className={`checkerboard relative touch-none select-none overflow-hidden rounded-sm shadow-lg focus-visible:outline focus-visible:outline-violet-500 ${ready && !disabled ? 'cursor-none' : ''}`}
      style={{ width: `min(100cqw, ${ratio * 100}cqh)`, aspectRatio: ratio }}
      onPointerDown={start} onPointerMove={event => update(event)} onPointerUp={event => update(event, true)}
      onPointerLeave={() => placeCursor()} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onKeyDown={event => {
        if (event.key !== 'Escape' || gesture.current?.pointerId === undefined) return
        event.preventDefault()
        event.stopPropagation()
        placeCursor()
        clearGesture()
      }}>
      <canvas ref={canvas} width={width} height={height} aria-label="蒙版效果预览"
        className="pointer-events-none absolute inset-0 block size-full" />
      {!failed && !images && <span role="status" className="absolute inset-0 grid place-items-center text-xs text-slate-600">正在读取蒙版…</span>}
      {failed && <span role="alert" className="absolute inset-0 grid place-items-center bg-white/75 text-xs text-red-600">读取蒙版预览失败</span>}
      <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 size-full">
        <circle ref={cursor} fill="none" stroke="white" vectorEffect="non-scaling-stroke"
          className={ready && !disabled ? undefined : 'hidden'} style={{ visibility: 'hidden', filter: 'drop-shadow(0 0 1px #111827)' }} />
      </svg>
    </div>
  </div>
}
