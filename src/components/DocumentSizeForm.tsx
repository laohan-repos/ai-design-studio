import { useState } from 'react'
import { canvasAnchors, type CanvasAnchor, type DocumentDimensions, type DocumentSizeMode } from '@/lib/document-size'
import { Button } from './ui/button'
import { Input } from './ui/input'

export type SizeSettings = DocumentDimensions & { anchor: CanvasAnchor }
type Props = {
  mode: DocumentSizeMode
  current: DocumentDimensions
  min: number
  max: number
  maxPixels: number
  disabled: boolean
  onApply(settings: SizeSettings): void
  onPreview?(settings: SizeSettings): void
  onChange?(): void
}

const anchorNames = ['左上', '上', '右上', '左', '居中', '右', '左下', '下', '右下']

export function DocumentSizeForm({ mode, current, min, max, maxPixels, disabled, onApply, onPreview, onChange }: Props) {
  const [width, setWidth] = useState(String(current.width))
  const [height, setHeight] = useState(String(current.height))
  const [locked, setLocked] = useState(true)
  const [anchor, setAnchor] = useState<CanvasAnchor>('center')
  const settings = { width: Number(width), height: Number(height), anchor }
  const changed = settings.width !== current.width || settings.height !== current.height
  const validSide = (value: number) => Number.isSafeInteger(value) && value >= min && value <= max
  const valid = validSide(settings.width) && validSide(settings.height) && settings.width * settings.height <= maxPixels
  const ratio = current.width / current.height

  function updateDimension(axis: 'width' | 'height', value: string) {
    onChange?.()
    const amount = Number(value)
    if (axis === 'width') {
      setWidth(value)
      if (mode === 'image' && locked && amount > 0) setHeight(String(Math.max(1, Math.round(amount / ratio))))
    } else {
      setHeight(value)
      if (mode === 'image' && locked && amount > 0) setWidth(String(Math.max(1, Math.round(amount * ratio))))
    }
  }

  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault()
    if (valid && changed && !disabled) onApply(settings)
  }}>
    <fieldset className="min-w-0 space-y-4" disabled={disabled}>
      <p className="text-xs tabular-nums text-slate-600">当前 {current.width} × {current.height} px</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5 text-xs font-medium text-slate-700"><span>宽度（像素）</span>
          <Input type="number" value={width} required min={min} max={max} onChange={event => updateDimension('width', event.currentTarget.value)} />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-slate-700"><span>高度（像素）</span>
          <Input type="number" value={height} required min={min} max={max} onChange={event => updateDimension('height', event.currentTarget.value)} />
        </label>
      </div>
      {mode === 'image' ? <label className="flex items-center gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={locked} onChange={event => {
          const next = event.currentTarget.checked
          setLocked(next)
          if (next && Number(width) > 0) {
            setHeight(String(Math.max(1, Math.round(Number(width) / ratio))))
            onChange?.()
          }
        }} />锁定宽高比
      </label> : <fieldset className="space-y-2">
        <legend className="pb-1 text-xs font-medium text-slate-700">画布锚点</legend>
        <div className="inline-grid grid-cols-3 gap-1.5" aria-label="画布锚点" role="group">
          {canvasAnchors.map((position, index) => <Button type="button" key={position} size="sm" className="h-8 w-10 px-1"
            variant={position === anchor ? 'secondary' : 'outline'} aria-pressed={position === anchor}
            onClick={() => { setAnchor(position); onChange?.() }}>{anchorNames[index]}</Button>)}
        </div>
        <p className="text-xs leading-5 text-slate-600">按锚点扩展或裁切边缘，保留内容原有大小。</p>
      </fieldset>}
      {!valid && changed && <p className="text-xs leading-5 text-red-600" role="status">
        宽高须在 {min} 到 {max} 像素之间，总面积最多 {maxPixels / 10_000} 万像素。
      </p>}
      <div className="flex flex-wrap gap-2">
        {onPreview && <Button type="button" variant="outline" size="sm" disabled={!valid || !changed} onClick={() => onPreview(settings)}>预览尺寸</Button>}
        <Button type="submit" size="sm" disabled={!valid || !changed}>应用尺寸</Button>
      </div>
    </fieldset>
  </form>
}
