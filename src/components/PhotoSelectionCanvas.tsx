import { useRef, useState, type PointerEvent } from 'react'
import type { PhotoInspection, PhotoMask, PhotoPoint, PhotoSelection } from '@/lib/photo-edits'

export type PhotoTool = PhotoSelection['type'] | 'point'
type Props = {
  image: PhotoInspection
  alt?: string
  tool: PhotoTool
  brushRadius: number
  mask?: PhotoMask
  polygon: PhotoPoint[]
  target?: PhotoPoint
  source?: PhotoPoint
  disabled: boolean
  onPoint(point: PhotoPoint): void
  onShape(shape: PhotoSelection): void
}

function boxBetween(first: PhotoPoint, last: PhotoPoint) {
  return { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width: Math.abs(first.x - last.x), height: Math.abs(first.y - last.y) }
}

export function PhotoSelectionCanvas({ image, alt = '精修照片，可在图上选择区域或点修位置', tool, brushRadius, mask, polygon, target, source, disabled, onPoint, onShape }: Props) {
  const gesture = useRef<{ pointer: number; points: PhotoPoint[] }>()
  const [drawing, setDrawing] = useState<PhotoSelection>()
  const { imageWidth, imageHeight, crop } = image
  const ratio = image.width / image.height
  const shortSide = Math.min(imageWidth, imageHeight)

  function pointAt(event: PointerEvent<HTMLDivElement>): PhotoPoint {
    const bounds = event.currentTarget.getBoundingClientRect()
    const relative = (value: number, offset: number, size: number) => Math.min(1, Math.max(0, (value - offset) / size))
    return { x: (crop.x + relative(event.clientX, bounds.left, bounds.width) * crop.width) / imageWidth,
      y: (crop.y + relative(event.clientY, bounds.top, bounds.height) * crop.height) / imageHeight }
  }

  function shapeAt(points: PhotoPoint[]): PhotoSelection | undefined {
    if (tool === 'brush') return { type: 'brush', points, radius: brushRadius }
    if (tool === 'rectangle' || tool === 'ellipse') {
      const box = boxBetween(points[0], points.at(-1)!)
      if (box.width >= 0.001 && box.height >= 0.001) return { type: tool, box }
    }
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || gesture.current) return
    const point = pointAt(event)
    if (tool === 'point' || tool === 'polygon') { onPoint(point); return }
    gesture.current = { pointer: event.pointerId, points: [point] }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrawing(shapeAt([point]))
  }

  function update(event: PointerEvent<HTMLDivElement>, finish: boolean) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId) return
    const point = pointAt(event)
    if (tool === 'brush') {
      const last = active.points.at(-1)!
      if (Math.hypot(point.x - last.x, point.y - last.y) > 0.0015) {
        if (active.points.length < 160) active.points.push(point)
        else active.points[159] = point
      }
    } else active.points[1] = point
    const shape = shapeAt([...active.points])
    if (finish) {
      gesture.current = undefined
      setDrawing(undefined)
      if (shape) onShape(shape)
    } else setDrawing(shape)
  }

  const placement = (point: PhotoPoint) => [point.x * imageWidth, point.y * imageHeight].join(',')
  function drawShape(shape: PhotoSelection, ink: string, key: string) {
    const paint = { fill: ink, fillOpacity: 0.22, stroke: ink, strokeWidth: 1.4, vectorEffect: 'non-scaling-stroke' }
    switch (shape.type) {
      case 'rectangle': return <rect key={key} {...paint} x={shape.box.x * imageWidth} y={shape.box.y * imageHeight} width={shape.box.width * imageWidth} height={shape.box.height * imageHeight} />
      case 'ellipse': return <ellipse key={key} {...paint} cx={(shape.box.x + shape.box.width / 2) * imageWidth} cy={(shape.box.y + shape.box.height / 2) * imageHeight} rx={shape.box.width * imageWidth / 2} ry={shape.box.height * imageHeight / 2} />
      case 'polygon': return <polygon key={key} {...paint} points={shape.points.map(placement).join(' ')} />
      case 'brush': return shape.points.length === 1
        ? <circle key={key} {...paint} cx={shape.points[0].x * imageWidth} cy={shape.points[0].y * imageHeight} r={shape.radius * shortSide} />
        : <polyline key={key} fill="none" stroke={ink} strokeWidth={shape.radius * shortSide * 2} strokeOpacity={0.35} strokeLinecap="round" strokeLinejoin="round" points={shape.points.map(placement).join(' ')} />
    }
  }

  return <div className="flex h-full w-full items-center justify-center [container-type:size]">
    <div className="relative cursor-crosshair touch-none select-none" style={{ width: `min(100cqw, ${ratio * 100}cqh)`, aspectRatio: ratio }}
      onPointerDown={start} onPointerMove={event => update(event, false)} onPointerUp={event => update(event, true)}
      onLostPointerCapture={() => { gesture.current = undefined; setDrawing(undefined) }}>
      <img src={image.src} alt={alt} draggable={false} className="pointer-events-none block h-full w-full rounded-sm object-fill shadow-lg" />
      <svg aria-hidden="true" viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        {mask?.include.map((shape, i) => drawShape(shape, '#8b5cf6', `include-${i}`))}
        {mask?.exclude?.map((shape, i) => drawShape(shape, '#f59e0b', `exclude-${i}`))}
        {drawing && drawShape(drawing, '#8b5cf6', 'drawing')}
        {polygon.length > 0 && <polyline fill="none" stroke="#8b5cf6" strokeWidth="2" vectorEffect="non-scaling-stroke" points={polygon.map(placement).join(' ')} />}
        {polygon.map((point, i) => <circle key={i} cx={point.x * imageWidth} cy={point.y * imageHeight} r={shortSide * 0.008} fill="#8b5cf6" stroke="white" vectorEffect="non-scaling-stroke" />)}
        {target && <circle cx={target.x * imageWidth} cy={target.y * imageHeight} r={brushRadius * shortSide} fill="none" stroke="#a78bfa" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {source && <circle cx={source.x * imageWidth} cy={source.y * imageHeight} r={brushRadius * shortSide} fill="none" stroke="#34d399" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  </div>
}
