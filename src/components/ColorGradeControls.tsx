import { useRef, useState, type PointerEvent } from 'react'
import { Plus, Undo2 } from 'lucide-react'
import { Button } from './ui/button'
import type { ColorBand, ColorGrade, ColorZone, CurveChannel, CurvePoint, PhotoColors } from '@/lib/color-grade'

const basic = { exposure: '曝光（EV）', temperature: '色温', tint: '色调', contrast: '对比度', shadows: '阴影', highlights: '高光', whites: '白色色阶', blacks: '黑色色阶', saturation: '饱和度', protectNeutrals: '低饱和保护' } as const
const channels = { rgb: 'RGB', red: '红', green: '绿', blue: '蓝' } as const
const curveColors = { rgb: '#6d28d9', red: '#dc2626', green: '#15803d', blue: '#2563eb' }
const bands: Record<ColorBand, { name: string; color: string }> = {
  red: { name: '红', color: '#ef4444' }, orange: { name: '橙', color: '#f97316' }, yellow: { name: '黄', color: '#eab308' },
  green: { name: '绿', color: '#22c55e' }, cyan: { name: '青', color: '#06b6d4' }, blue: { name: '蓝', color: '#3b82f6' },
  purple: { name: '紫', color: '#8b5cf6' }, magenta: { name: '洋红', color: '#ec4899' }
}
const zones = { shadows: '阴影', midtones: '中间调', highlights: '高光' } as const

function ColorRange({ label, value, onChange, min = -100, max = 100, step = 1 }: { label: string; value: number; onChange(value: number): void; min?: number; max?: number; step?: number }) {
  return <label className="block space-y-1 text-xs font-medium text-slate-700">
    <span className="flex justify-between gap-2"><span>{label}</span><span className="tabular-nums">{value}</span></span>
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} className="block w-full accent-violet-600" />
  </label>
}

const identity: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
const limit = (value: number, from = 0, to = 1) => Math.max(from, Math.min(to, value))

function Curve({ points, color, onChange }: { points: CurvePoint[]; color: string; onChange(points: CurvePoint[]): void }) {
  const [selected, setSelected] = useState(0)
  const active = useRef<number>()
  const index = Math.min(selected, points.length - 1)
  const point = points[index]
  const endpoint = index === 0 || index === points.length - 1
  const xMin = endpoint ? point.x : points[index - 1].x + 0.01
  const xMax = endpoint ? point.x : points[index + 1].x - 0.01

  const patch = (i: number, next: CurvePoint) => {
    const first = i === 0, last = i === points.length - 1
    const x = first ? 0 : last ? 1 : limit(next.x, points[i - 1].x + 0.01, points[i + 1].x - 0.01)
    onChange(points.map((value, j) => i === j ? { x, y: limit(next.y) } : value))
  }
  const location = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: limit((event.clientX - bounds.left) / bounds.width), y: 1 - limit((event.clientY - bounds.top) / bounds.height) }
  }
  const start = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    const next = location(event)
    const near = points.findIndex(p => Math.hypot(p.x - next.x, p.y - next.y) < 0.055)
    let target = near
    if (target < 0) {
      if (points.length >= 12) return
      target = points.findIndex(p => p.x > next.x)
      if (target < 1 || next.x - points[target - 1].x < 0.01 || points[target].x - next.x < 0.01) return
      onChange([...points.slice(0, target), next, ...points.slice(target)])
    }
    active.current = target
    setSelected(target)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const add = () => {
    const i = points.slice(1).reduce((best, current, j) => current.x - points[j].x > points[best + 1].x - points[best].x ? j : best, 0)
    const next = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 }
    onChange([...points.slice(0, i + 1), next, ...points.slice(i + 1)])
    setSelected(i + 1)
  }
  return <div className="space-y-2">
    <svg className="h-32 w-full cursor-crosshair touch-none overflow-visible rounded-md border bg-slate-50" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="调色曲线，点击添加控制点，拖动修改"
      onPointerDown={start} onPointerMove={event => { if (active.current !== undefined && active.current < points.length) patch(active.current, location(event)) }} onLostPointerCapture={() => { active.current = undefined }}>
      {[25, 50, 75].map(value => <path key={value} d={`M${value} 0 V100 M0 ${value} H100`} stroke="#e2e8f0" vectorEffect="non-scaling-stroke" />)}
      <path d="M0 100 L100 0" stroke="#94a3b8" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <polyline points={points.map(({ x, y }) => `${x * 100},${(1 - y) * 100}`).join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => <circle key={i} cx={p.x * 100} cy={(1 - p.y) * 100} r={i === index ? 2.5 : 1.8} fill={i === index ? color : 'white'} stroke={color} vectorEffect="non-scaling-stroke" />)}
    </svg>
    <div className="flex flex-wrap gap-1">
      <select aria-label="曲线控制点" className="h-8 rounded border bg-white px-1 text-xs" value={index} onChange={event => setSelected(Number(event.target.value))}>
        {points.map((p, i) => <option key={i} value={i}>{i + 1} · {Math.round(p.x * 100)}%</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={points.length >= 12} onClick={add}><Plus className="h-3.5 w-3.5" />添加点</Button>
      <Button size="sm" variant="ghost" disabled={endpoint} onClick={() => { onChange(points.filter((_, i) => i !== index)); setSelected(index - 1) }}>删除点</Button>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <ColorRange label="曲线输入" min={Math.round(xMin * 100)} max={Math.round(xMax * 100)} value={Math.round(point.x * 100)} onChange={value => patch(index, { ...point, x: value / 100 })} />
      <ColorRange label="曲线输出" min={0} value={Math.round(point.y * 100)} onChange={value => patch(index, { ...point, y: value / 100 })} />
    </div>
  </div>
}

export function ColorGradeControls({ value, onChange, colors, disabled }: { value: ColorGrade; onChange(value: ColorGrade): void; colors?: PhotoColors; disabled: boolean }) {
  const [panel, setPanel] = useState<'basic' | 'curves' | 'hsl' | 'wheels'>('basic')
  const [channel, setChannel] = useState<CurveChannel>('rgb')
  const [band, setBand] = useState<ColorBand>('orange')
  const [zone, setZone] = useState<ColorZone>('midtones')
  const histogram = colors?.histogram
  const sample = colors?.samples[0]
  const maxBin = histogram ? Math.max(1, ...Object.values(histogram).flat()) : 1
  const hsl = value.hsl?.[band] ?? {}
  const wheel = value.colorWheels?.[zone] ?? { hue: 42, saturation: 0 }
  return <fieldset disabled={disabled} className="min-w-0 space-y-3">
    {histogram && <section aria-label="底图直方图" className="rounded-lg border border-slate-200 bg-slate-50 p-2">
      <div className="mb-1 flex justify-between text-[10px] text-slate-600"><span>底图直方图</span><span>高光剪切 {colors.summary.lightClipping}%</span></div>
      <svg className="h-12 w-full" viewBox="0 0 31 36" preserveAspectRatio="none" aria-hidden="true">
        {(['luminance', 'red', 'green', 'blue'] as const).map((key, i) => <polyline key={key} fill="none" stroke={['#64748b','#ef4444','#16a34a','#2563eb'][i]} strokeWidth="1" opacity="0.75" vectorEffect="non-scaling-stroke" points={histogram[key].map((count, bin) => `${bin},${36 - 34 * count / maxBin}`).join(' ')} />)}
      </svg>
      {sample?.pixelCount ? <div className="mt-1 flex items-center gap-2 text-xs tabular-nums text-slate-700"><span className="size-4 shrink-0 rounded border" style={{ background: `rgb(${sample.rgb.join(',')})` }} />取样 RGB {sample.rgb.map(Math.round).join(' / ')}</div> : null}
    </section>}
    <div className="flex items-center gap-1">
      {([{ id: 'basic', name: '基础' }, { id: 'curves', name: '曲线' }, { id: 'hsl', name: 'HSL' }, { id: 'wheels', name: '分区' }] as const).map(tab => <Button key={tab.id} size="sm" className="min-w-0 flex-1 px-1" variant={panel === tab.id ? 'secondary' : 'ghost'} aria-pressed={panel === tab.id} onClick={() => setPanel(tab.id)}>{tab.name}</Button>)}
      <Button size="icon" variant="ghost" className="size-8" aria-label="重置调色" title="重置调色" onClick={() => onChange({})}><Undo2 className="h-4 w-4" /></Button>
    </div>
    {panel === 'basic' && <div className="grid grid-cols-2 gap-3">{(Object.keys(basic) as (keyof typeof basic)[]).map(key => <ColorRange key={key} label={basic[key]} min={key === 'exposure' ? -2 : key === 'protectNeutrals' ? 0 : -100} max={key === 'exposure' ? 2 : 100} step={key === 'exposure' ? 0.05 : 1} value={value[key] ?? 0} onChange={amount => onChange({ ...value, [key]: amount })} />)}</div>}
    {panel === 'curves' && <>
      <div className="grid grid-cols-4 gap-1">{(Object.keys(channels) as CurveChannel[]).map(key => <Button key={key} size="sm" variant={channel === key ? 'outline' : 'ghost'} aria-pressed={channel === key} onClick={() => setChannel(key)}>{channels[key]}</Button>)}</div>
      <Curve key={channel} points={value.curves?.[channel] ?? identity} color={curveColors[channel]} onChange={points => onChange({ ...value, curves: { ...value.curves, [channel]: points } })} />
    </>}
    {panel === 'hsl' && <>
      <div className="flex flex-wrap gap-1" aria-label="HSL 色带">{(Object.keys(bands) as ColorBand[]).map(key => <button type="button" key={key} aria-label={`${bands[key].name}色`} aria-pressed={band === key} title={`${bands[key].name}色`} onClick={() => setBand(key)} className={`grid size-7 place-items-center rounded ${band === key ? 'bg-slate-200' : ''}`}><span className="size-4 rounded-full" style={{ background: bands[key].color }} /></button>)}</div>
      {([{ id: 'hue', label: '色相' }, { id: 'saturation', label: '色带饱和度' }, { id: 'lightness', label: '色带明度' }] as const).map(field => <ColorRange key={field.id} label={field.label} min={field.id === 'hue' ? -60 : -100} max={field.id === 'hue' ? 60 : 100} value={hsl[field.id] ?? 0} onChange={amount => onChange({ ...value, hsl: { ...value.hsl, [band]: { ...hsl, [field.id]: amount } } })} />)}
    </>}
    {panel === 'wheels' && <>
      <div className="grid grid-cols-3 gap-1">{(Object.keys(zones) as ColorZone[]).map(key => <Button key={key} size="sm" variant={zone === key ? 'outline' : 'ghost'} aria-pressed={zone === key} onClick={() => setZone(key)}>{zones[key]}</Button>)}</div>
      <ColorRange label="分区色相" min={0} max={360} value={wheel.hue} onChange={hue => onChange({ ...value, colorWheels: { ...value.colorWheels, [zone]: { ...wheel, hue } } })} />
      <ColorRange label="分区着色力度" min={0} max={35} value={wheel.saturation} onChange={saturation => onChange({ ...value, colorWheels: { ...value.colorWheels, [zone]: { ...wheel, saturation } } })} />
    </>}
  </fieldset>
}
