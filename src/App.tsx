import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Brush, ChevronDown, Download, Images, LoaderCircle, Settings2, Sparkles, Upload, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ModelDialog } from '@/components/ModelDialog'
import { ImageEditor } from '@/components/ImageEditor'
import { InfiniteCanvas, type CanvasImage } from '@/components/InfiniteCanvas'
import type { ModelConfig } from '@/types'

type Mode = 'text' | 'image'
export default function App() {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [activeIds, setActiveIds] = useState<Record<Mode, string>>({ text: '', image: '' })
  const [configOpen, setConfigOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('text')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [count, setCount] = useState(1)
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [reference, setReference] = useState<string>()
  const [gallery, setGallery] = useState<CanvasImage[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editing, setEditing] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const taskType = mode === 'text' ? 'text-to-image' : 'image-to-image'
  const availableModels = models.filter(model => model.taskType === taskType)
  const active = availableModels.find(model => model.id === activeIds[mode]) || availableModels[0]
  const selected = selectedIds.length === 1 ? gallery.find(x => x.id === selectedIds[0]) : undefined

  useEffect(() => {
    Promise.all([window.studio.listModels(), window.studio.listArtworks()]).then(([savedModels, savedArtworks]) => {
      setModels(savedModels); setGallery(savedArtworks)
      setActiveIds({ text: savedModels.find(item => item.taskType === 'text-to-image')?.id || '', image: savedModels.find(item => item.taskType === 'image-to-image')?.id || '' })
      if (!savedModels.length) setConfigOpen(true)
    }).catch(error => setToast(error instanceof Error ? error.message : '读取本地数据库失败'))
  }, [])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(undefined), 2600); return () => clearTimeout(timer) }, [toast])
  const canGenerate = !!active && !!prompt.trim() && !loading && (mode === 'text' || !!reference)

  const importFile = (file?: File) => {
    if (!file || !file.type.startsWith('image/')) return
    if (file.size > 20 * 1024 * 1024) { setToast('图片不能超过 20 MB'); return }
    const reader = new FileReader(); reader.onload = () => { setReference(reader.result as string); setMode('image') }; reader.readAsDataURL(file)
  }
  const generate = async () => {
    if (!canGenerate || !active) return
    setLoading(true)
    try {
      const images = await window.studio.generate({ config: active, prompt: prompt.trim(), size, count, quality, image: mode === 'image' ? reference : undefined })
      const start = gallery.length
      const next = images.map((src, index) => ({ id: crypto.randomUUID(), src, prompt: prompt.trim(), createdAt: Date.now(), x: ((start + index) % 3) * 360, y: Math.floor((start + index) / 3) * 430, width: 320 }))
      await window.studio.saveArtworks(next)
      setGallery(old => [...next, ...old]); setSelectedIds(next.map(item => item.id)); setToast(`已生成 ${images.length} 张图片`)
    } catch (error) { setToast(error instanceof Error ? error.message : '生成失败，请检查模型配置') }
    finally { setLoading(false) }
  }
  const saveDirect = async (src: string) => { const path = await window.studio.saveImage(src, `lumina-${Date.now()}.png`); if (path) setToast(`已保存到 ${path}`) }
  const saveModels = async (items: ModelConfig[]) => {
    await window.studio.saveModels(items); setModels(items)
    setActiveIds(previous => ({
      text: items.some(item => item.id === previous.text && item.taskType === 'text-to-image') ? previous.text : items.find(item => item.taskType === 'text-to-image')?.id || '',
      image: items.some(item => item.id === previous.image && item.taskType === 'image-to-image') ? previous.image : items.find(item => item.taskType === 'image-to-image')?.id || ''
    }))
    setConfigOpen(false); setToast('模型配置已保存')
  }
  const moveItems = (updates: Array<{ id: string; x: number; y: number }>) => setGallery(items => items.map(item => { const update = updates.find(candidate => candidate.id === item.id); return update ? { ...item, x: update.x, y: update.y } : item }))
  const commitMoves = (updates: Array<{ id: string; x: number; y: number }>) => { moveItems(updates); Promise.all(updates.map(item => window.studio.moveArtwork(item.id, item.x, item.y))).catch(() => setToast('画布位置保存失败')) }

  return <div className="flex h-full flex-col bg-background">
    <header className="drag-region flex h-14 shrink-0 items-center border-b bg-card/70 px-5 pl-20 backdrop-blur-xl">
      <div className="flex items-center gap-2.5"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/20"><Sparkles className="h-4 w-4 text-white" /></div><span className="text-sm font-semibold tracking-tight">Lumina</span><span className="rounded border bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Studio</span></div>
      <div className="no-drag ml-auto flex items-center gap-2">
        <div className="relative"><select value={active?.id || ''} onChange={e => setActiveIds(ids => ({ ...ids, [mode]: e.target.value }))} className="h-8 max-w-52 appearance-none rounded-md border bg-background py-1 pl-3 pr-8 text-xs outline-none focus:ring-2 focus:ring-ring"><option value="" disabled>{mode === 'text' ? '选择文生图模型' : '选择图生图模型'}</option>{availableModels.map(m => <option key={m.id} value={m.id}>{m.name} · {m.model}</option>)}</select><ChevronDown className="pointer-events-none absolute right-2 top-2 h-4 w-4 text-muted-foreground" /></div>
        <Button variant="ghost" size="icon" onClick={() => setConfigOpen(true)} title="模型配置"><Settings2 className="h-4 w-4" /></Button>
      </div>
    </header>

    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[360px] shrink-0 flex-col border-r bg-white">
        <div className="border-b p-4">
          <div className="grid grid-cols-2 rounded-lg bg-secondary/60 p-1">
            <button onClick={() => setMode('text')} className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition ${mode === 'text' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}><WandSparkles className="h-4 w-4" />文生图</button>
            <button onClick={() => setMode('image')} className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition ${mode === 'image' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}><Images className="h-4 w-4" />图生图</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {mode === 'image' && <div className="mb-5">
            <div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-muted-foreground">参考图片</label>{reference && <button onClick={() => setReference(undefined)} className="text-[11px] text-muted-foreground hover:text-foreground">移除</button>}</div>
            <input ref={fileInput} type="file" accept="image/*" hidden onChange={e => importFile(e.target.files?.[0])} />
            {reference ? <button className="group relative block h-40 w-full overflow-hidden rounded-xl border bg-slate-50" onClick={() => fileInput.current?.click()}><img src={reference} className="h-full w-full object-contain" /><div className="absolute inset-0 flex items-center justify-center bg-slate-900/35 text-white opacity-0 transition group-hover:opacity-100"><Upload className="h-5 w-5" /></div></button> : <button onClick={() => fileInput.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); importFile(e.dataTransfer.files[0]) }} className="flex h-40 w-full flex-col items-center justify-center rounded-xl border border-dashed bg-slate-50 text-muted-foreground transition hover:border-violet-400 hover:bg-violet-50/60 hover:text-violet-700"><div className="mb-3 rounded-xl border bg-white p-3 shadow-sm"><Upload className="h-5 w-5" /></div><span className="text-xs font-medium">拖入或点击上传图片</span><span className="mt-1 text-[10px] opacity-60">PNG、JPG、WebP · 最大 20 MB</span></button>}
          </div>}
          <div className="mb-5"><label className="mb-2 block text-xs font-medium text-muted-foreground">提示词</label><Textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate() }} placeholder={mode === 'text' ? '描述你想要生成的画面、风格、构图和光线…' : '描述你希望如何修改这张图片…'} className="min-h-36 resize-none leading-6" /><div className="mt-1.5 text-right text-[10px] text-muted-foreground">⌘ Enter 生成</div></div>
          <div className="grid grid-cols-2 gap-3"><Setting label="尺寸"><select value={size} onChange={e => setSize(e.target.value)} className="setting-select"><option value="auto">自动</option><option value="1024x1024">1:1 · 1024²</option><option value="1536x1024">3:2 · 横向</option><option value="1024x1536">2:3 · 纵向</option></select></Setting><Setting label="质量"><select value={quality} onChange={e => setQuality(e.target.value as typeof quality)} className="setting-select"><option value="low">低 · 快速测试</option><option value="medium">中 · 推荐</option><option value="high">高 · 最佳效果</option></select></Setting><Setting label="数量"><select value={count} onChange={e => setCount(Number(e.target.value))} className="setting-select"><option value={1}>1 张</option><option value={2}>2 张</option><option value={4}>4 张</option></select></Setting></div>
        </div>
        <div className="border-t p-4"><Button className="h-11 w-full bg-gradient-to-r from-violet-600 to-fuchsia-600 shadow-lg shadow-violet-600/15" disabled={!canGenerate} onClick={generate}>{loading ? <><LoaderCircle className="h-4 w-4 animate-spin" />正在创作…</> : <><Sparkles className="h-4 w-4" />生成图片<ArrowUp className="ml-auto h-4 w-4 opacity-60" /></>}</Button>{!active && <button onClick={() => setConfigOpen(true)} className="mt-2 w-full text-center text-[11px] text-violet-500 hover:underline">添加{mode === 'text' ? '文生图' : '图生图'}模型配置</button>}</div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-slate-50">
        <div className="flex h-14 shrink-0 items-center justify-between border-b bg-white px-5"><div><span className="text-sm font-semibold">无限画布</span><span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{selectedIds.length > 1 ? `已选择 ${selectedIds.length} 项` : gallery.length ? `${gallery.length} 个作品` : '空画布'}</span></div>{selected && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setEditing(selected.src)}><Brush className="h-3.5 w-3.5" />编辑</Button><Button size="sm" variant="outline" onClick={() => saveDirect(selected.src)}><Download className="h-3.5 w-3.5" />保存</Button></div>}</div>
        <div className="relative min-h-0 flex-1">
          <InfiniteCanvas items={gallery} selectedIds={selectedIds} onSelect={setSelectedIds} onMove={moveItems} onMoveEnd={commitMoves} onEdit={setEditing} onUpload={() => { setMode('image'); fileInput.current?.click() }} />
          {loading && <div className="pointer-events-none absolute left-1/2 top-6 flex -translate-x-1/2 items-center gap-2 rounded-full border border-violet-200 bg-white/95 px-4 py-2 text-xs font-medium text-violet-700 shadow-lg shadow-violet-200/50 backdrop-blur"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />模型正在创作图片…</div>}
        </div>
      </main>
    </div>
    <ModelDialog open={configOpen} models={models} onClose={() => setConfigOpen(false)} onSave={saveModels} />
    {editing && <ImageEditor image={editing} onClose={() => setEditing(undefined)} onSaved={path => { setToast(`已保存到 ${path}`); setEditing(undefined) }} />}
    {toast && <div className="fixed bottom-5 left-1/2 z-[80] max-w-xl -translate-x-1/2 rounded-lg border bg-card px-4 py-2.5 text-xs shadow-2xl">{toast}</div>}
  </div>
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="mb-2 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div> }
