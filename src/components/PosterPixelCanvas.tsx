import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { posterPixelStrokePointLimit } from '@/lib/poster-limits'
import type { PosterPixelStroke, PosterPixelView } from '@/lib/poster-pixels'
import type { PosterPoint } from '@/lib/poster'
import { resampleStroke } from '@/lib/stroke-points'

type Props = {
  view: PosterPixelView
  tool: PosterPixelStroke['type']
  color: string
  radius: number
  opacity: number
  source?: PosterPoint
  pickingSource: boolean
  disabled: boolean
  onSource(point: PosterPoint): void
  onPaint(stroke: PosterPixelStroke): Promise<boolean>
}
type Gesture = { pointerId?: number; view: PosterPixelView; stroke: PosterPixelStroke }

function drawStrokePath(context: CanvasRenderingContext2D, points: PosterPoint[], radius: number, width: number, height: number, color: string) {
  const [first, ...rest] = points
  context.beginPath()
  if (!rest.length) {
    context.fillStyle = color
    context.arc(first.x * width, first.y * height, radius, 0, Math.PI * 2)
    context.fill()
    return
  }
  context.strokeStyle = color
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = radius * 2
  context.moveTo(first.x * width, first.y * height)
  for (const point of rest) context.lineTo(point.x * width, point.y * height)
  context.stroke()
}

function drawPixelStroke(
  context: CanvasRenderingContext2D, before: HTMLImageElement, stroke: PosterPixelStroke, width: number, height: number,
  original: Pick<PosterPixelView, 'width' | 'height'>, stamp: () => HTMLCanvasElement
) {
  const sourceShortSide = Math.min(original.width, original.height)
  const radius = Math.max(0.5, stroke.radius * sourceShortSide) * Math.min(width, height) / sourceShortSide
  context.save()
  context.globalAlpha = stroke.opacity
  if (stroke.type === 'clone') {
    // Sample the unchanged pre-stroke raster so overlapping dabs cannot feed back into the clone.
    const clone = stamp()
    const sample = clone.getContext('2d')
    if (sample) {
      const first = stroke.points[0]
      const dx = -Math.round((stroke.source.x - first.x) * original.width) * width / original.width
      const dy = -Math.round((stroke.source.y - first.y) * original.height) * height / original.height
      sample.clearRect(0, 0, width, height)
      sample.save()
      drawStrokePath(sample, stroke.points, radius, width, height, '#fff')
      sample.globalCompositeOperation = 'source-in'
      sample.drawImage(before, dx, dy, width, height)
      sample.restore()
      context.drawImage(clone, 0, 0)
    }
  } else {
    if (stroke.type === 'eraser') context.globalCompositeOperation = 'destination-out'
    drawStrokePath(context, stroke.points, radius, width, height, stroke.type === 'brush' ? stroke.color : '#fff')
  }
  context.restore()
}

function pointsAt(event: PointerEvent<HTMLDivElement>) {
  const bounds = event.currentTarget.getBoundingClientRect()
  const relative = (value: number, origin: number, span: number) => Math.max(0, Math.min(1, (value - origin) / span))
  const point = (input: { clientX: number; clientY: number }) => ({
    x: relative(input.clientX, bounds.left, bounds.width), y: relative(input.clientY, bounds.top, bounds.height)
  })
  const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
  return [...samples.map(point), point(event)]
}

export function PosterPixelCanvas({ view, tool, color, radius, opacity, source, pickingSource, disabled, onSource, onPaint }: Props) {
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cloneCanvas = useRef<HTMLCanvasElement>()
  const cursor = useRef<SVGCircleElement>(null)
  const active = useRef<Gesture>()
  const redraw = useRef<() => void>(() => {})
  const animation = useRef<number>()
  const [loaded, setLoaded] = useState<{ view: PosterPixelView; image: HTMLImageElement }>()
  const [failed, setFailed] = useState(false)
  const width = loaded?.image.naturalWidth ?? 1
  const height = loaded?.image.naturalHeight ?? 1
  const ready = view === loaded?.view
  const ratio = loaded ? width / height : view.width / view.height
  const selecting = tool === 'clone' && pickingSource

  useEffect(() => {
    let current = true
    const image = new Image()
    image.src = view.src
    setFailed(false)
    image.decode().then(() => {
      if (current) setLoaded({ view, image })
    }, () => { if (current) setFailed(true) })
    return () => { current = false }
  }, [view])

  const clear = useCallback(() => {
    const pointer = active.current?.pointerId
    active.current = undefined
    if (pointer !== undefined && frame.current?.hasPointerCapture(pointer)) frame.current.releasePointerCapture(pointer)
    if (cursor.current) cursor.current.style.visibility = 'hidden'
    redraw.current()
  }, [])

  useLayoutEffect(() => {
    const gesture = active.current
    if (!gesture) return
    if (gesture.pointerId === undefined ? ready && gesture.view !== view : disabled || gesture.view !== view) clear()
  }, [clear, disabled, ready, view])

  useLayoutEffect(() => {
    redraw.current = () => {
      if (!loaded) return
      const context = canvas.current?.getContext('2d')
      if (!context) return
      const { naturalWidth: width, naturalHeight: height } = loaded.image
      context.clearRect(0, 0, width, height)
      context.drawImage(loaded.image, 0, 0, width, height)
      const gesture = active.current
      if (gesture?.view !== loaded.view) return
      drawPixelStroke(context, loaded.image, gesture.stroke, width, height, loaded.view, () => {
        const scratch = cloneCanvas.current ??= document.createElement('canvas')
        if (scratch.width !== width) scratch.width = width
        if (scratch.height !== height) scratch.height = height
        return scratch
      })
    }
    redraw.current()
  }, [loaded])

  useEffect(() => () => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current)
    animation.current = undefined
    active.current = undefined
  }, [])

  function placeCursor(point?: PosterPoint, activeRadius = radius) {
    if (!cursor.current) return
    cursor.current.style.visibility = point ? 'visible' : 'hidden'
    if (!point) return
    cursor.current.setAttribute('cx', String(point.x * width))
    cursor.current.setAttribute('cy', String(point.y * height))
    cursor.current.setAttribute('r', String(Math.max(0.5, activeRadius * Math.min(width, height))))
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (disabled || !ready || active.current || event.button !== 0) return
    const point = pointsAt(event).at(-1)!
    if (tool === 'clone' && (selecting || event.altKey)) {
      event.preventDefault()
      onSource(point)
      return
    }
    if (tool === 'clone' && !source) return
    const base = { radius, opacity, points: [point] }
    const stroke: PosterPixelStroke = tool === 'brush' ? { ...base, type: tool, color }
      : tool === 'clone' ? { ...base, type: tool, source: source! } : { ...base, type: tool }
    active.current = { pointerId: event.pointerId, view, stroke }
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    placeCursor(point)
    redraw.current()
  }

  function update(event: PointerEvent<HTMLDivElement>, finish = false) {
    const gesture = active.current
    if (disabled || !ready || (gesture && gesture.pointerId !== event.pointerId)) return
    const samples = pointsAt(event)
    placeCursor(samples.at(-1), gesture?.stroke.radius)
    if (!gesture) return
    const { stroke } = gesture
    const minimumStep = Math.min(1.5, Math.max(0.25, stroke.radius * Math.min(width, height) * 0.04))
    for (const [index, point] of samples.entries()) {
      const previous = stroke.points.at(-1)!
      const threshold = finish && index === samples.length - 1 ? 0.01 : minimumStep
      if (Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height) >= threshold) stroke.points.push(point)
    }
    if (stroke.points.length > posterPixelStrokePointLimit * 4) {
      stroke.points = resampleStroke(stroke.points, posterPixelStrokePointLimit * 2, width, height)
    }
    if (!finish) {
      if (animation.current === undefined) animation.current = requestAnimationFrame(() => {
        animation.current = undefined
        redraw.current()
      })
      return
    }

    gesture.pointerId = undefined
    stroke.points = resampleStroke(stroke.points, posterPixelStrokePointLimit, width, height)
    redraw.current()
    placeCursor()
    void onPaint(stroke).then(saved => {
      if (!saved && active.current === gesture) clear()
    }, () => { if (active.current === gesture) clear() })
  }

  function cancel(event: PointerEvent<HTMLDivElement>) {
    if (active.current?.pointerId === event.pointerId) clear()
  }

  const customCursor = ready && !disabled && !selecting && (tool !== 'clone' || source)
  return <div className="flex h-full w-full items-center justify-center [container-type:size]">
    <div className={`checkerboard relative touch-none select-none overflow-hidden rounded-sm shadow-lg focus-visible:outline focus-visible:outline-violet-500 ${customCursor ? 'cursor-none' : 'cursor-crosshair'}`}
      ref={frame} role="group" aria-label="图层像素画布" tabIndex={0}
      style={{ width: `min(100cqw, ${ratio * 100}cqh)`, aspectRatio: ratio }}
      onPointerDown={start} onPointerMove={updateEvent => update(updateEvent)} onPointerUp={updateEvent => update(updateEvent, true)}
      onPointerLeave={() => placeCursor()} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onKeyDown={event => {
        if (event.key !== 'Escape' || active.current?.pointerId === undefined) return
        event.preventDefault()
        event.stopPropagation()
        clear()
      }}>
      <canvas ref={canvas} width={width} height={height} aria-label="像素编辑预览" className="pointer-events-none absolute inset-0 size-full" />
      {!failed && !loaded && <span role="status" className="absolute inset-0 grid place-items-center text-xs text-slate-600">正在读取图层…</span>}
      {failed && <span role="alert" className="absolute inset-0 grid place-items-center bg-white/75 text-xs text-red-600">读取图层预览失败</span>}
      <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 size-full">
        {tool === 'clone' && source && <circle cx={source.x * width} cy={source.y * height} r={Math.max(2, radius * Math.min(width, height) / 2)}
          fill="none" stroke="#34d399" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        <circle ref={cursor} fill="none" stroke="white" vectorEffect="non-scaling-stroke" className={customCursor ? undefined : 'hidden'}
          style={{ visibility: 'hidden', filter: 'drop-shadow(0 0 1px #111827)' }} />
      </svg>
    </div>
  </div>
}
