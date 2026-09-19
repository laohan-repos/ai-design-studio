import { useEffect, useRef, useState } from 'react'
import { Download, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, Undo2, X } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Label } from './ui/label'
import type { Adjustments } from '@/types'

type Props = { image: string; onClose(): void; onSaved(path: string): void }
const initial: Adjustments = { brightness: 100, contrast: 100, saturation: 100, rotation: 0, flipX: false, flipY: false }

export function ImageEditor({ image, onClose, onSaved }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [adjust, setAdjust] = useState(initial)
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  useEffect(() => {
    const img = new Image(); img.onload = () => draw(img, canvas.current!, adjust); img.src = image
  }, [image, adjust])
  const patch = (p: Partial<Adjustments>) => setAdjust(a => ({ ...a, ...p }))
  const save = async () => { const data = canvas.current!.toDataURL(`image/${format}`, .92); const path = await window.studio.saveImage(data, `lumina-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`); if (path) onSaved(path) }
  return <div className="fixed inset-0 z-50 flex flex-col bg-slate-50">
    <header className="drag-region flex h-16 items-center justify-between border-b bg-white px-5"><div className="no-drag flex items-center gap-3"><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button><div><div className="text-sm font-semibold">图片编辑器</div><div className="text-[11px] text-muted-foreground">无损预览 · 导出时应用调整</div></div></div><div className="no-drag flex gap-2"><select className="h-9 rounded-md border bg-background px-3 text-sm" value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select><Button onClick={save}><Download className="h-4 w-4" />导出图片</Button></div></header>
    <div className="flex min-h-0 flex-1">
      <div className="checkerboard flex flex-1 items-center justify-center overflow-auto p-10"><canvas ref={canvas} className="max-h-full max-w-full rounded-sm object-contain shadow-2xl" /></div>
      <aside className="w-72 overflow-y-auto border-l bg-white p-5">
        <div className="mb-5 flex items-center justify-between"><span className="text-sm font-semibold">调整</span><Button variant="ghost" size="sm" onClick={() => setAdjust(initial)}><Undo2 className="h-3.5 w-3.5" />重置</Button></div>
        <Control name="亮度" value={adjust.brightness} onChange={v => patch({ brightness: v })} />
        <Control name="对比度" value={adjust.contrast} onChange={v => patch({ contrast: v })} />
        <Control name="饱和度" value={adjust.saturation} onChange={v => patch({ saturation: v })} />
        <div className="mt-6"><Label>变换</Label><div className="mt-2 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation - 90 })}><RotateCcw className="h-4 w-4" />左转</Button><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation + 90 })}><RotateCw className="h-4 w-4" />右转</Button><Button variant={adjust.flipX ? 'secondary' : 'outline'} onClick={() => patch({ flipX: !adjust.flipX })}><FlipHorizontal2 className="h-4 w-4" />水平</Button><Button variant={adjust.flipY ? 'secondary' : 'outline'} onClick={() => patch({ flipY: !adjust.flipY })}><FlipVertical2 className="h-4 w-4" />垂直</Button></div></div>
        <div className="mt-6 rounded-lg border bg-background/50 p-3 text-xs leading-5 text-muted-foreground">导出将在原图分辨率下渲染所有调整，不会降低画布尺寸。</div>
      </aside>
    </div>
  </div>
}

function Control({ name, value, onChange }: { name: string; value: number; onChange(v: number): void }) { return <div className="mb-5 space-y-2"><div className="flex justify-between"><Label>{name}</Label><span className="text-xs tabular-nums text-muted-foreground">{value}%</span></div><Slider min={0} max={200} step={1} value={[value]} onValueChange={v => onChange(v[0])} /></div> }

function draw(img: HTMLImageElement, canvas: HTMLCanvasElement, a: Adjustments) {
  const turns = ((a.rotation % 360) + 360) % 360
  const swap = turns === 90 || turns === 270
  canvas.width = swap ? img.naturalHeight : img.naturalWidth; canvas.height = swap ? img.naturalWidth : img.naturalHeight
  const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(a.rotation * Math.PI / 180); ctx.scale(a.flipX ? -1 : 1, a.flipY ? -1 : 1)
  ctx.filter = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%)`
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2); ctx.restore()
}
