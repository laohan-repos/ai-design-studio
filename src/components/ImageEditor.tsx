import { useEffect, useRef, useState } from 'react'
import { Check, Download, FlipHorizontal2, FlipVertical2, History, Layers3, LoaderCircle, RotateCcw, RotateCw, Sparkles, Undo2, WandSparkles, X } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { PosterEditor } from './PosterEditor'
import type { Adjustments, Artwork, ArtworkVersion, ModelConfig } from '@/types'

type Props = {
  artwork: Artwork
  models: ModelConfig[]
  onClose(): void
  onSaved(path: string): void
}

const initial: Adjustments = { brightness: 100, contrast: 100, saturation: 100, rotation: 0, flipX: false, flipY: false }

export function ImageEditor({ artwork, models, onClose, onSaved }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [adjust, setAdjust] = useState(initial)
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  const [versions, setVersions] = useState<ArtworkVersion[]>([])
  const [activeVersionId, setActiveVersionId] = useState('')
  const [panel, setPanel] = useState<'adjust' | 'ai' | 'retouch'>('adjust')
  const [smoothing, setSmoothing] = useState(35)
  const [brighten, setBrighten] = useState(0)
  const [faces, setFaces] = useState<'all' | 'primary'>('all')
  const [retouching, setRetouching] = useState(false)
  const [prompt, setPrompt] = useState('')
  const imageModels = models.filter(model => model.taskType === 'image-to-image')
  const [modelId, setModelId] = useState(imageModels[0]?.id || '')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<string>()
  const [posterView, setPosterView] = useState<{ versionId?: string }>()
  const activeVersion = versions.find(version => version.id === activeVersionId)
  const image = activeVersion?.src || artwork.src

  useEffect(() => {
    let disposed = false
    const refresh = () => window.studio.listArtworkVersions(artwork.id).then(items => {
      if (disposed) return
      setVersions(items)
      setActiveVersionId(id => id || items.find(item => item.isCurrent)?.id || items[0]?.id || '')
    }).catch(error => { if (!disposed) setMessage(error instanceof Error ? error.message : '版本读取失败') })
      .finally(() => { if (!disposed) setLoading(false) })
    void refresh()
    const unsubscribe = window.studio.onMcpWorkspaceChanged(change => {
      if (change.type === 'artwork_versions_changed' && change.artworkId === artwork.id) void refresh()
      if (change.type === 'artwork_version_applied' && change.result.version.artworkId === artwork.id) {
        setActiveVersionId(change.result.version.id)
        void refresh()
      }
    })
    return () => { disposed = true; unsubscribe() }
  }, [artwork.id])

  useEffect(() => {
    const img = new Image()
    img.onload = () => { if (canvas.current) draw(img, canvas.current, adjust) }
    img.src = image
    return () => { img.onload = null }
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
      const version = await window.studio.saveArtworkVersion({ id: crypto.randomUUID(), artworkId: artwork.id, src, prompt: prompt.trim(), createdAt: Date.now() })
      setVersions(items => items.some(item => item.id === version.id) ? items : [version, ...items])
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
    } catch (error) { setMessage(error instanceof Error ? error.message : '应用版本失败') }
    finally { setApplying(false) }
  }

  const retouchPortrait = async () => {
    if (!activeVersion || retouching) return
    setRetouching(true)
    setMessage(undefined)
    try {
      const { version, faceCount } = await window.studio.retouchPortrait({ artworkId: artwork.id, versionId: activeVersion.id, smoothing, brighten, faces })
      setVersions(items => items.some(item => item.id === version.id) ? items : [version, ...items])
      setActiveVersionId(version.id)
      setMessage(`已处理 ${faceCount} 张人脸，结果保存为 V${version.versionNumber}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '人像磨皮失败')
    } finally { setRetouching(false) }
  }

  return <><div className="fixed inset-0 z-50 flex flex-col bg-slate-50" style={posterView ? { display: 'none' } : undefined}>
    <header className="drag-region flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-white px-3 pb-2 pt-1 md:px-5 md:py-3">
      <div className="no-drag flex min-w-0 items-center gap-2 max-sm:pl-16"><Button variant="ghost" size="icon" aria-label="关闭图片编辑器" onClick={onClose}><X className="h-4 w-4" /></Button><div><div className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold">图片编辑器{activeVersion && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">V{activeVersion.versionNumber}</span>}</div><div className="hidden text-[11px] text-muted-foreground md:block">本地调整 · AI 图生图 · 版本管理</div></div></div>
      <div className="no-drag flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2">
        <Button size="sm" variant="outline" onClick={() => setPosterView({ versionId: activeVersion?.id })} disabled={loading}><Layers3 className="h-4 w-4" />分层海报</Button>
        {activeVersion && !activeVersion.isCurrent && <Button size="sm" variant="outline" onClick={applyVersion} disabled={applying} aria-label="应用到画布" title="应用到画布" className="max-[420px]:w-8 max-[420px]:px-0">{applying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}<span className="hidden min-[420px]:inline sm:hidden">应用</span><span className="hidden sm:inline">应用到画布</span></Button>}
        <select aria-label="导出格式" className="h-8 rounded-md border bg-background px-1.5 text-xs sm:px-3" value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select>
        <Button size="sm" aria-label="导出图片" onClick={save}><Download className="h-4 w-4" /><span className="sm:hidden">导出</span><span className="hidden sm:inline">导出图片</span></Button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="checkerboard relative flex h-[41%] min-h-0 min-w-0 shrink-0 items-center justify-center overflow-hidden p-3 md:h-auto md:flex-1 md:p-10"><canvas ref={canvas} className="max-h-full max-w-full rounded-sm object-contain shadow-2xl" />{loading && <div className="absolute inset-0 flex items-center justify-center bg-white/60"><LoaderCircle className="h-6 w-6 animate-spin text-violet-600" /></div>}</div>
      <aside className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t bg-white md:w-80 md:flex-none md:border-l md:border-t-0">
        <div className="border-b p-3 md:p-4">
          <div className="mb-2 flex items-center justify-between sm:mb-3"><div className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-violet-500" />版本</div><span className="text-[10px] text-slate-400">{versions.length} 个版本</span></div>
          <div className="flex gap-2 overflow-x-auto pb-1">{versions.map(version => <button key={version.id} onClick={() => setActiveVersionId(version.id)} className={`relative w-14 shrink-0 overflow-hidden rounded-lg border-2 text-left transition sm:w-20 ${version.id === activeVersionId ? 'border-violet-500 shadow-sm' : 'border-transparent hover:border-slate-200'}`}><img src={version.src} alt={`版本 ${version.versionNumber}`} className="aspect-square w-full bg-slate-100 object-cover" /><span className="flex items-center justify-between bg-white px-2 py-1 text-[10px] font-medium text-slate-600">V{version.versionNumber}{version.isCurrent && <Check className="h-3 w-3 text-emerald-500" />}</span></button>)}</div>
        </div>
        <div className="grid grid-cols-3 gap-1 border-b p-2">
          {([{ id: 'adjust', label: '基础调整' }, { id: 'retouch', label: '人像磨皮' }, { id: 'ai', label: '图生图' }] as const).map(tab =>
            <button key={tab.id} aria-pressed={panel === tab.id} onClick={() => setPanel(tab.id)} className={`h-9 rounded-lg text-xs font-medium ${panel === tab.id ? 'bg-violet-50 text-violet-700' : 'text-slate-500 hover:bg-slate-50'}`}>{tab.label}</button>
          )}
        </div>
        <div className="p-4 md:p-5">
          {panel === 'adjust' ? <>
            <div className="mb-5 flex items-center justify-between"><span className="text-sm font-semibold">调整</span><Button variant="ghost" size="sm" onClick={() => setAdjust(initial)}><Undo2 className="h-3.5 w-3.5" />重置</Button></div>
            <Control name="亮度" value={adjust.brightness} onChange={value => patch({ brightness: value })} />
            <Control name="对比度" value={adjust.contrast} onChange={value => patch({ contrast: value })} />
            <Control name="饱和度" value={adjust.saturation} onChange={value => patch({ saturation: value })} />
            <div className="mt-6"><Label>变换</Label><div className="mt-2 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation - 90 })}><RotateCcw className="h-4 w-4" />左转</Button><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation + 90 })}><RotateCw className="h-4 w-4" />右转</Button><Button variant={adjust.flipX ? 'secondary' : 'outline'} onClick={() => patch({ flipX: !adjust.flipX })}><FlipHorizontal2 className="h-4 w-4" />水平</Button><Button variant={adjust.flipY ? 'secondary' : 'outline'} onClick={() => patch({ flipY: !adjust.flipY })}><FlipVertical2 className="h-4 w-4" />垂直</Button></div></div>
            <div className="mt-6 rounded-lg border bg-background/50 p-3 text-xs leading-5 text-muted-foreground">导出将在原图分辨率下渲染所有调整，不会降低画布尺寸。</div>
          </> : panel === 'retouch' ? <>
            <p className="mb-4 text-xs leading-5 text-slate-500">对选中版本的人脸进行本地磨皮和提亮，结果保存为新版本。</p>
            <Control name="磨皮强度" value={smoothing} max={100} onChange={setSmoothing} />
            <Control name="提亮强度" value={brighten} max={30} onChange={setBrighten} />
            <Label htmlFor="retouch-faces">处理范围</Label>
            <select id="retouch-faces" className="setting-select mt-2" value={faces} onChange={event => setFaces(event.target.value as typeof faces)}>
              <option value="all">所有人脸</option><option value="primary">主要人脸</option>
            </select>
            <Button className="mt-5 w-full" onClick={retouchPortrait} disabled={!activeVersion || retouching || (!smoothing && !brighten)}>
              {retouching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{retouching ? '正在处理…' : '磨皮并保存新版本'}
            </Button>
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
  </div>{posterView && <PosterEditor artwork={artwork} versionId={posterView.versionId} onBack={() => setPosterView(undefined)} />}</>
}

function Control({ name, value, onChange, max = 200 }: { name: string; value: number; max?: number; onChange(value: number): void }) { return <div className="mb-5 space-y-2"><div className="flex justify-between"><Label>{name}</Label><span className="text-xs tabular-nums text-muted-foreground">{value}%</span></div><Slider aria-label={name} min={0} max={max} step={1} value={[value]} onValueChange={next => onChange(next[0])} /></div> }

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
