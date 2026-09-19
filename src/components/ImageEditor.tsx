import { useEffect, useRef, useState } from 'react'
import { Check, Download, FlipHorizontal2, FlipVertical2, History, LoaderCircle, RotateCcw, RotateCw, Sparkles, Undo2, WandSparkles, X } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import type { Adjustments, Artwork, ArtworkVersion, ModelConfig } from '@/types'

type Props = {
  artwork: Artwork
  models: ModelConfig[]
  onClose(): void
  onSaved(path: string): void
  onApplied(version: ArtworkVersion): void
}

const initial: Adjustments = { brightness: 100, contrast: 100, saturation: 100, rotation: 0, flipX: false, flipY: false }

export function ImageEditor({ artwork, models, onClose, onSaved, onApplied }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [adjust, setAdjust] = useState(initial)
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  const [versions, setVersions] = useState<ArtworkVersion[]>([])
  const [activeVersionId, setActiveVersionId] = useState('')
  const [panel, setPanel] = useState<'adjust' | 'ai'>('adjust')
  const [prompt, setPrompt] = useState('')
  const imageModels = models.filter(model => model.taskType === 'image-to-image')
  const [modelId, setModelId] = useState(imageModels[0]?.id || '')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<string>()
  const activeVersion = versions.find(version => version.id === activeVersionId)
  const image = activeVersion?.src || artwork.src

  useEffect(() => {
    window.studio.listArtworkVersions(artwork.id).then(items => {
      setVersions(items)
      setActiveVersionId(items.find(item => item.isCurrent)?.id || items[0]?.id || '')
    }).catch(error => setMessage(error instanceof Error ? error.message : '版本读取失败'))
      .finally(() => setLoading(false))
  }, [artwork.id])

  useEffect(() => {
    const img = new Image()
    img.onload = () => draw(img, canvas.current!, adjust)
    img.src = image
  }, [image, adjust])

  useEffect(() => { setAdjust(initial) }, [activeVersionId])

  const patch = (next: Partial<Adjustments>) => setAdjust(current => ({ ...current, ...next }))
  const save = async () => {
    const data = canvas.current!.toDataURL(`image/${format}`, .92)
    const path = await window.studio.saveImage(data, `ai-design-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`)
    if (path) onSaved(path)
  }

  const createVersion = async () => {
    const config = imageModels.find(model => model.id === modelId)
    if (!config || !prompt.trim() || !activeVersion) return
    setGenerating(true)
    setMessage(undefined)
    try {
      const [src] = await window.studio.generate({ config, prompt: prompt.trim(), size, count: 1, quality, image: activeVersion.src })
      const version: ArtworkVersion = {
        id: crypto.randomUUID(), artworkId: artwork.id, src, prompt: prompt.trim(), createdAt: Date.now(),
        versionNumber: Math.max(0, ...versions.map(item => item.versionNumber)) + 1, isCurrent: false
      }
      await window.studio.saveArtworkVersion(version)
      setVersions(items => [version, ...items])
      setActiveVersionId(version.id)
      setPrompt('')
      setMessage(`V${version.versionNumber} 已生成`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '图生图失败，请检查模型配置') }
    finally { setGenerating(false) }
  }

  const applyVersion = async () => {
    if (!activeVersion || activeVersion.isCurrent) return
    setApplying(true)
    try {
      const applied = await window.studio.applyArtworkVersion(artwork.id, activeVersion.id)
      if (!applied) throw new Error('版本不存在')
      setVersions(items => items.map(item => ({ ...item, isCurrent: item.id === applied.id })))
      onApplied({ ...activeVersion, isCurrent: true })
    } catch (error) { setMessage(error instanceof Error ? error.message : '应用版本失败') }
    finally { setApplying(false) }
  }

  return <div className="fixed inset-0 z-50 flex flex-col bg-slate-50">
    <header className="drag-region flex h-16 items-center justify-between border-b bg-white px-5">
      <div className="no-drag flex items-center gap-3"><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button><div><div className="flex items-center gap-2 text-sm font-semibold">图片编辑器{activeVersion && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">V{activeVersion.versionNumber}</span>}</div><div className="text-[11px] text-muted-foreground">本地调整 · AI 图生图 · 版本管理</div></div></div>
      <div className="no-drag flex gap-2">{activeVersion && !activeVersion.isCurrent && <Button variant="outline" onClick={applyVersion} disabled={applying}>{applying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}应用到画布</Button>}<select className="h-9 rounded-md border bg-background px-3 text-sm" value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select><Button onClick={save}><Download className="h-4 w-4" />导出图片</Button></div>
    </header>
    <div className="flex min-h-0 flex-1">
      <div className="checkerboard relative flex flex-1 items-center justify-center overflow-auto p-10"><canvas ref={canvas} className="max-h-full max-w-full rounded-sm object-contain shadow-2xl" />{loading && <div className="absolute inset-0 flex items-center justify-center bg-white/60"><LoaderCircle className="h-6 w-6 animate-spin text-violet-600" /></div>}</div>
      <aside className="w-80 overflow-y-auto border-l bg-white">
        <div className="border-b p-4">
          <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-violet-500" />版本</div><span className="text-[10px] text-slate-400">{versions.length} 个版本</span></div>
          <div className="flex gap-2 overflow-x-auto pb-1">{versions.map(version => <button key={version.id} onClick={() => setActiveVersionId(version.id)} className={`relative w-20 shrink-0 overflow-hidden rounded-lg border-2 text-left transition ${version.id === activeVersionId ? 'border-violet-500 shadow-sm' : 'border-transparent hover:border-slate-200'}`}><img src={version.src} alt={`版本 ${version.versionNumber}`} className="aspect-square w-full bg-slate-100 object-cover" /><span className="flex items-center justify-between bg-white px-2 py-1 text-[10px] font-medium text-slate-600">V{version.versionNumber}{version.isCurrent && <Check className="h-3 w-3 text-emerald-500" />}</span></button>)}</div>
        </div>
        <div className="grid grid-cols-2 gap-1 border-b p-2"><button onClick={() => setPanel('adjust')} className={`flex h-9 items-center justify-center gap-2 rounded-lg text-xs font-medium ${panel === 'adjust' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50'}`}><Undo2 className="h-3.5 w-3.5" />基础调整</button><button onClick={() => setPanel('ai')} className={`flex h-9 items-center justify-center gap-2 rounded-lg text-xs font-medium ${panel === 'ai' ? 'bg-violet-50 text-violet-700' : 'text-slate-500 hover:bg-slate-50'}`}><WandSparkles className="h-3.5 w-3.5" />图生图</button></div>
        <div className="p-5">
          {panel === 'adjust' ? <>
            <div className="mb-5 flex items-center justify-between"><span className="text-sm font-semibold">调整</span><Button variant="ghost" size="sm" onClick={() => setAdjust(initial)}><Undo2 className="h-3.5 w-3.5" />重置</Button></div>
            <Control name="亮度" value={adjust.brightness} onChange={value => patch({ brightness: value })} />
            <Control name="对比度" value={adjust.contrast} onChange={value => patch({ contrast: value })} />
            <Control name="饱和度" value={adjust.saturation} onChange={value => patch({ saturation: value })} />
            <div className="mt-6"><Label>变换</Label><div className="mt-2 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation - 90 })}><RotateCcw className="h-4 w-4" />左转</Button><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation + 90 })}><RotateCw className="h-4 w-4" />右转</Button><Button variant={adjust.flipX ? 'secondary' : 'outline'} onClick={() => patch({ flipX: !adjust.flipX })}><FlipHorizontal2 className="h-4 w-4" />水平</Button><Button variant={adjust.flipY ? 'secondary' : 'outline'} onClick={() => patch({ flipY: !adjust.flipY })}><FlipVertical2 className="h-4 w-4" />垂直</Button></div></div>
            <div className="mt-6 rounded-lg border bg-background/50 p-3 text-xs leading-5 text-muted-foreground">导出将在原图分辨率下渲染所有调整，不会降低画布尺寸。</div>
          </> : <>
            <div className="mb-4"><div className="text-sm font-semibold">AI 图生图</div><p className="mt-1 text-xs leading-5 text-slate-500">以当前选中的版本为参考，生成一个新版本。</p></div>
            <Label htmlFor="edit-prompt">编辑要求</Label><Textarea id="edit-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：保持人物不变，将背景改成海边日落…" className="mt-2 min-h-28 resize-none leading-5" />
            <div className="mt-4"><Label>图生图模型</Label><select value={modelId} onChange={event => setModelId(event.target.value)} className="setting-select mt-2"><option value="" disabled>选择模型</option>{imageModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div>
            <div className="mt-4 grid grid-cols-2 gap-3"><div><Label>尺寸</Label><select value={size} onChange={event => setSize(event.target.value)} className="setting-select mt-2"><option value="1024x1024">1:1 方图</option><option value="1536x1024">3:2 横图</option><option value="1024x1536">2:3 竖图</option></select></div><div><Label>质量</Label><select value={quality} onChange={event => setQuality(event.target.value as typeof quality)} className="setting-select mt-2"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div></div>
            {!imageModels.length && <p className="mt-3 text-xs leading-5 text-amber-600">请先关闭编辑器，在模型配置中添加图生图模型。</p>}
            <Button onClick={createVersion} disabled={!prompt.trim() || !modelId || generating || !activeVersion} className="mt-5 h-10 w-full bg-gradient-to-r from-violet-600 to-fuchsia-600">{generating ? <><LoaderCircle className="h-4 w-4 animate-spin" />正在生成新版本…</> : <><Sparkles className="h-4 w-4" />生成新版本</>}</Button>
          </>}
          {message && <div className="mt-4 rounded-lg border bg-slate-50 p-3 text-xs leading-5 text-slate-600">{message}</div>}
        </div>
      </aside>
    </div>
  </div>
}

function Control({ name, value, onChange }: { name: string; value: number; onChange(value: number): void }) { return <div className="mb-5 space-y-2"><div className="flex justify-between"><Label>{name}</Label><span className="text-xs tabular-nums text-muted-foreground">{value}%</span></div><Slider min={0} max={200} step={1} value={[value]} onValueChange={next => onChange(next[0])} /></div> }

function draw(img: HTMLImageElement, canvas: HTMLCanvasElement, adjustment: Adjustments) {
  const turns = ((adjustment.rotation % 360) + 360) % 360
  const swap = turns === 90 || turns === 270
  canvas.width = swap ? img.naturalHeight : img.naturalWidth
  canvas.height = swap ? img.naturalWidth : img.naturalHeight
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.save()
  context.translate(canvas.width / 2, canvas.height / 2)
  context.rotate(adjustment.rotation * Math.PI / 180)
  context.scale(adjustment.flipX ? -1 : 1, adjustment.flipY ? -1 : 1)
  context.filter = `brightness(${adjustment.brightness}%) contrast(${adjustment.contrast}%) saturate(${adjustment.saturation}%)`
  context.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
  context.restore()
}
