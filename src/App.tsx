import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Brush, ChevronDown, ChevronUp, Download, ImagePlus, LayoutDashboard, LoaderCircle, Pencil, Plus, Settings2, Sparkles, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ModelDialog } from '@/components/ModelDialog'
import { ImageEditor } from '@/components/ImageEditor'
import { InfiniteCanvas, type CanvasImage } from '@/components/InfiniteCanvas'
import type { InfiniteCanvasRecord, ModelConfig } from '@/types'

export default function App() {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [canvases, setCanvases] = useState<InfiniteCanvasRecord[]>([])
  const [activeCanvasId, setActiveCanvasId] = useState('')
  const [gallery, setGallery] = useState<CanvasImage[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [configOpen, setConfigOpen] = useState(false)
  const [editing, setEditing] = useState<CanvasImage>()
  const [loadingCanvas, setLoadingCanvas] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [canvasName, setCanvasName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ canvasId: string; x: number; y: number }>()
  const [renamingCanvasId, setRenamingCanvasId] = useState<string>()
  const [renameValue, setRenameValue] = useState('')
  const [imageCanvasId, setImageCanvasId] = useState<string>()
  const [imagePrompt, setImagePrompt] = useState('')
  const [generateModelId, setGenerateModelId] = useState('')
  const [imageSize, setImageSize] = useState('1024x1024')
  const [imageQuality, setImageQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [generating, setGenerating] = useState(false)
  const [uploadCanvasId, setUploadCanvasId] = useState<string>()
  const [deletingArtwork, setDeletingArtwork] = useState<CanvasImage>()
  const [deleting, setDeleting] = useState(false)
  const [expandedCanvasIds, setExpandedCanvasIds] = useState<string[]>([])
  const [canvasItems, setCanvasItems] = useState<Record<string, CanvasImage[]>>({})
  const [focusArtwork, setFocusArtwork] = useState<{ id: string; sequence: number }>()
  const [toast, setToast] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const activeCanvas = canvases.find(canvas => canvas.id === activeCanvasId)
  const selected = selectedIds.length === 1 ? gallery.find(item => item.id === selectedIds[0]) : undefined
  const textModels = models.filter(model => model.taskType === 'text-to-image')

  useEffect(() => {
    Promise.all([window.studio.listModels(), window.studio.listCanvases()]).then(async ([savedModels, savedCanvases]) => {
      setModels(savedModels)
      setCanvases(savedCanvases)
      const first = savedCanvases[0]
      if (first) {
        setActiveCanvasId(first.id)
        const artworks = await window.studio.listArtworks(first.id)
        setGallery(artworks)
        setCanvasItems({ [first.id]: artworks })
      }
    }).catch(error => setToast(error instanceof Error ? error.message : '读取本地数据库失败'))
      .finally(() => setLoadingCanvas(false))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const openCanvas = async (id: string) => {
    if (id === activeCanvasId) return
    setActiveCanvasId(id)
    setSelectedIds([])
    setGallery([])
    setLoadingCanvas(true)
    try { const artworks = await window.studio.listArtworks(id); setGallery(artworks); setCanvasItems(items => ({ ...items, [id]: artworks })) }
    catch (error) { setToast(error instanceof Error ? error.message : '画布加载失败') }
    finally { setLoadingCanvas(false) }
  }

  const toggleCanvas = async (id: string) => {
    if (expandedCanvasIds.includes(id)) { setExpandedCanvasIds(items => items.filter(item => item !== id)); return }
    setExpandedCanvasIds(items => [...items, id])
    try {
      const artworks = id === activeCanvasId ? gallery : await window.studio.listArtworks(id)
      setCanvasItems(items => ({ ...items, [id]: artworks }))
    } catch (error) { setToast(error instanceof Error ? error.message : '图片列表加载失败') }
  }

  const openArtwork = async (canvasId: string, artworkId: string) => {
    if (canvasId !== activeCanvasId) await openCanvas(canvasId)
    setSelectedIds([artworkId])
    setFocusArtwork({ id: artworkId, sequence: Date.now() })
  }

  const showCreateDialog = () => {
    setCanvasName(`无限画布 ${canvases.length + 1}`)
    setCreateDialogOpen(true)
  }

  const createCanvas = async () => {
    const name = canvasName.trim()
    if (!name) return
    setCreating(true)
    try {
      const canvas = await window.studio.createCanvas(crypto.randomUUID(), name)
      setCanvases(items => [canvas, ...items])
      setActiveCanvasId(canvas.id)
      setGallery([])
      setSelectedIds([])
      setCreateDialogOpen(false)
      setCanvasName('')
      setToast('已新建无限画布')
    } catch (error) { setToast(error instanceof Error ? error.message : '新建画布失败') }
    finally { setCreating(false) }
  }

  const showRenameDialog = (canvasId: string) => {
    const canvas = canvases.find(item => item.id === canvasId)
    if (!canvas) return
    setContextMenu(undefined)
    setRenameValue(canvas.name)
    setRenamingCanvasId(canvasId)
  }

  const renameCanvas = async () => {
    const name = renameValue.trim()
    if (!name || !renamingCanvasId) return
    try {
      const updatedAt = await window.studio.renameCanvas(renamingCanvasId, name)
      setCanvases(items => items.map(canvas => canvas.id === renamingCanvasId ? { ...canvas, name, updatedAt } : canvas))
      setRenamingCanvasId(undefined)
      setToast('画布名称已修改')
    } catch (error) { setToast(error instanceof Error ? error.message : '修改名称失败') }
  }

  const showImageDialog = (canvasId: string) => {
    setContextMenu(undefined)
    setImageCanvasId(canvasId)
    setImagePrompt('')
    setGenerateModelId(textModels[0]?.id || '')
  }

  const generateImage = async () => {
    const config = textModels.find(model => model.id === generateModelId)
    const canvasId = imageCanvasId
    if (!config || !canvasId || !imagePrompt.trim()) return
    setGenerating(true)
    try {
      const [src] = await window.studio.generate({ config, prompt: imagePrompt.trim(), size: imageSize, count: 1, quality: imageQuality })
      const target = canvases.find(canvas => canvas.id === canvasId)
      const item: CanvasImage = {
        id: crypto.randomUUID(), canvasId, src, prompt: imagePrompt.trim(), createdAt: Date.now(),
        x: (target?.artworkCount || 0) * 36, y: (target?.artworkCount || 0) * 36, width: 320
      }
      await window.studio.saveArtworks([item])
      setCanvases(items => items.map(canvas => canvas.id === canvasId ? { ...canvas, artworkCount: canvas.artworkCount + 1, coverSrc: canvas.coverSrc || item.src, updatedAt: Date.now() } : canvas))
      setCanvasItems(items => ({ ...items, [canvasId]: [item, ...(items[canvasId] || [])] }))
      if (canvasId !== activeCanvasId) await openCanvas(canvasId)
      else { setGallery(items => [item, ...items]); setSelectedIds([item.id]) }
      setImageCanvasId(undefined)
      setToast('图片已生成并添加到画布')
    } catch (error) { setToast(error instanceof Error ? error.message : '生成失败，请检查模型配置') }
    finally { setGenerating(false) }
  }

  const importFile = (file?: File, targetCanvasId = activeCanvasId) => {
    if (!file || !file.type.startsWith('image/') || !targetCanvasId) return
    if (file.size > 20 * 1024 * 1024) { setToast('图片不能超过 20 MB'); return }
    const reader = new FileReader()
    reader.onload = async () => {
      const item: CanvasImage = {
        id: crypto.randomUUID(), canvasId: targetCanvasId, src: reader.result as string,
        prompt: file.name, createdAt: Date.now(), x: (canvases.find(canvas => canvas.id === targetCanvasId)?.artworkCount || 0) * 36, y: (canvases.find(canvas => canvas.id === targetCanvasId)?.artworkCount || 0) * 36, width: 320
      }
      try {
        await window.studio.saveArtworks([item])
        setCanvases(items => items.map(canvas => canvas.id === targetCanvasId ? { ...canvas, artworkCount: canvas.artworkCount + 1, coverSrc: canvas.coverSrc || item.src, updatedAt: Date.now() } : canvas))
        setCanvasItems(items => ({ ...items, [targetCanvasId]: [item, ...(items[targetCanvasId] || [])] }))
        if (targetCanvasId === activeCanvasId) { setGallery(items => [item, ...items]); setSelectedIds([item.id]) }
        else { await openCanvas(targetCanvasId); setSelectedIds([item.id]) }
        setToast('图片已添加到画布')
      } catch (error) { setToast(error instanceof Error ? error.message : '图片导入失败') }
    }
    reader.readAsDataURL(file)
  }

  const requestUpload = (canvasId: string) => {
    setContextMenu(undefined)
    setUploadCanvasId(canvasId)
    fileInput.current?.click()
  }

  const deleteArtwork = async () => {
    if (!deletingArtwork) return
    setDeleting(true)
    try {
      await window.studio.deleteArtwork(deletingArtwork.id)
      const remaining = gallery.filter(item => item.id !== deletingArtwork.id)
      setGallery(remaining)
      setCanvasItems(items => ({ ...items, [deletingArtwork.canvasId]: (items[deletingArtwork.canvasId] || []).filter(item => item.id !== deletingArtwork.id) }))
      setSelectedIds(items => items.filter(id => id !== deletingArtwork.id))
      setCanvases(items => items.map(canvas => canvas.id === deletingArtwork.canvasId ? { ...canvas, artworkCount: Math.max(0, canvas.artworkCount - 1), coverSrc: canvas.coverSrc === deletingArtwork.src ? remaining.at(-1)?.src : canvas.coverSrc, updatedAt: Date.now() } : canvas))
      setDeletingArtwork(undefined)
      setToast('图片已删除')
    } catch (error) { setToast(error instanceof Error ? error.message : '删除图片失败') }
    finally { setDeleting(false) }
  }

  const saveModels = async (items: ModelConfig[]) => {
    await window.studio.saveModels(items)
    setModels(items)
    setConfigOpen(false)
    setToast('模型配置已保存')
  }
  const saveDirect = async (src: string) => {
    const path = await window.studio.saveImage(src, `ai-design-${Date.now()}.png`)
    if (path) setToast(`已保存到 ${path}`)
  }
  const moveItems = (updates: Array<{ id: string; x: number; y: number }>) => setGallery(items => items.map(item => {
    const update = updates.find(candidate => candidate.id === item.id)
    return update ? { ...item, x: update.x, y: update.y } : item
  }))
  const commitMoves = (updates: Array<{ id: string; x: number; y: number }>) => {
    moveItems(updates)
    Promise.all(updates.map(item => window.studio.moveArtwork(item.id, item.x, item.y))).catch(() => setToast('画布位置保存失败'))
  }

  return <div className="flex h-full flex-col bg-background">
    <header className="drag-region flex h-14 shrink-0 items-center border-b bg-card/70 px-5 pl-20 backdrop-blur-xl">
      <div className="flex items-center gap-2.5"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/20"><Sparkles className="h-4 w-4 text-white" /></div><span className="text-sm font-semibold tracking-tight">AI设计助手</span></div>
      <div className="no-drag ml-auto"><Button variant="ghost" size="icon" onClick={() => setConfigOpen(true)} title="模型配置"><Settings2 className="h-4 w-4" /></Button></div>
    </header>

    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[320px] shrink-0 flex-col border-r bg-white">
        <div className="flex h-14 items-center justify-between border-b px-4">
          <div><h1 className="text-sm font-semibold text-slate-900">无限画布</h1><p className="mt-0.5 text-[10px] text-slate-400">{canvases.length} 个画布</p></div>
          <Button size="sm" onClick={showCreateDialog} disabled={creating} className="h-8 bg-slate-900 px-3 text-[11px] hover:bg-slate-800">{creating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}新建</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="space-y-2">
            {canvases.map(canvas => {
              const active = canvas.id === activeCanvasId
              const expanded = expandedCanvasIds.includes(canvas.id)
              const artworks = canvasItems[canvas.id] || []
              return <div key={canvas.id}>
                <button onClick={() => { openCanvas(canvas.id); toggleCanvas(canvas.id) }} onContextMenu={event => { event.preventDefault(); setContextMenu({ canvasId: canvas.id, x: Math.min(event.clientX, window.innerWidth - 208), y: Math.min(event.clientY, window.innerHeight - 152) }) }} className={`group flex w-full items-center rounded-xl border pr-2 text-left transition ${active ? 'border-violet-300 bg-violet-50/80 shadow-sm shadow-violet-100' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                  <span className="flex min-w-0 flex-1 items-center gap-3 p-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg ${canvas.coverSrc ? 'border bg-slate-100' : active ? 'bg-violet-600 text-white shadow-md shadow-violet-200' : 'border bg-white text-slate-400 group-hover:text-slate-600'}`}>{canvas.coverSrc ? <img src={canvas.coverSrc} alt="画布封面" className="h-full w-full object-cover" /> : <LayoutDashboard className="h-4 w-4" />}</span>
                    <span className="min-w-0 flex-1"><span className={`block truncate text-xs font-medium ${active ? 'text-violet-950' : 'text-slate-700'}`}>{canvas.name}</span><span className="mt-1 block text-[10px] text-slate-400">{canvas.artworkCount ? `${canvas.artworkCount} 个作品` : '空画布'} · {formatTime(canvas.updatedAt)}</span></span>
                  </span>
                  {!!canvas.artworkCount && <span className="flex h-7 w-7 shrink-0 items-center justify-center text-slate-400" aria-hidden="true">{expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>}
                </button>
                {expanded && <div className="ml-5 mt-1 space-y-1 border-l border-violet-100 pl-3">{artworks.map(artwork => <button key={artwork.id} onClick={() => openArtwork(canvas.id, artwork.id)} className={`flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition hover:bg-slate-50 ${selectedIds.includes(artwork.id) && active ? 'bg-violet-50 text-violet-700' : 'text-slate-600'}`}><img src={artwork.src} alt={artwork.prompt || '图片'} className="h-8 w-8 shrink-0 rounded-md border bg-slate-100 object-cover" /><span className="min-w-0 flex-1 truncate text-[10px]">{artwork.prompt || '未命名图片'}</span></button>)}{!artworks.length && <div className="px-2 py-2 text-[10px] text-slate-400">暂无图片</div>}</div>}
              </div>
            })}
          </div>
        </div>
        <div className="border-t p-3"><Button variant="outline" className="h-10 w-full border-dashed text-xs text-slate-600" onClick={showCreateDialog} disabled={creating}><Plus className="h-4 w-4" />新建无限画布</Button></div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-slate-50">
        <div className="flex h-14 shrink-0 items-center justify-between border-b bg-white px-5"><div><span className="text-sm font-semibold">{activeCanvas?.name || '无限画布'}</span><span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{selectedIds.length > 1 ? `已选择 ${selectedIds.length} 项` : gallery.length ? `${gallery.length} 个作品` : '空画布'}</span></div>{selected && <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setEditing(selected)}><Brush className="h-3.5 w-3.5" />编辑</Button><Button size="sm" variant="outline" onClick={() => saveDirect(selected.src)}><Download className="h-3.5 w-3.5" />保存</Button></div>}</div>
        <div className="relative min-h-0 flex-1">
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={event => { importFile(event.target.files?.[0], uploadCanvasId || activeCanvasId); setUploadCanvasId(undefined); event.target.value = '' }} />
          {activeCanvasId && <InfiniteCanvas key={activeCanvasId} items={gallery} selectedIds={selectedIds} focusArtwork={focusArtwork} onSelect={setSelectedIds} onMove={moveItems} onMoveEnd={commitMoves} onEdit={setEditing} onDelete={setDeletingArtwork} onUpload={() => requestUpload(activeCanvasId)} />}
          {loadingCanvas && <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-50/70 backdrop-blur-sm"><div className="flex items-center gap-2 rounded-full border bg-white px-4 py-2 text-xs text-slate-500 shadow-lg"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在加载画布…</div></div>}
        </div>
      </main>
    </div>
    <ModelDialog open={configOpen} models={models} onClose={() => setConfigOpen(false)} onSave={saveModels} />
    {contextMenu && <div className="fixed inset-0 z-[60]" onMouseDown={() => setContextMenu(undefined)} onContextMenu={event => { event.preventDefault(); setContextMenu(undefined) }}>
      <div className="absolute w-48 rounded-xl border bg-white p-1.5 shadow-xl shadow-slate-900/15" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={event => event.stopPropagation()}>
        <button onClick={() => showRenameDialog(contextMenu.canvasId)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-slate-100"><Pencil className="h-3.5 w-3.5 text-slate-400" />修改画布名称</button>
        <button onClick={() => showImageDialog(contextMenu.canvasId)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-violet-50 hover:text-violet-700"><ImagePlus className="h-3.5 w-3.5 text-slate-400" />新建图片</button>
        <button onClick={() => requestUpload(contextMenu.canvasId)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-slate-100"><Upload className="h-3.5 w-3.5 text-slate-400" />上传图片</button>
      </div>
    </div>}
    {createDialogOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/25 p-6 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget && !creating) setCreateDialogOpen(false) }}>
      <form onSubmit={event => { event.preventDefault(); createCanvas() }} className="w-full max-w-sm rounded-2xl border bg-white p-5 shadow-2xl shadow-slate-950/20">
        <div className="mb-5"><div className="mb-1 text-base font-semibold text-slate-900">新建无限画布</div><p className="text-xs leading-5 text-slate-500">给画布起一个容易识别的名称，之后可以在左侧列表中切换。</p></div>
        <label htmlFor="canvas-name" className="mb-2 block text-xs font-medium text-slate-700">画布名称</label>
        <Input id="canvas-name" autoFocus value={canvasName} onChange={event => setCanvasName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !creating) setCreateDialogOpen(false) }} placeholder="例如：秋季新品视觉" className="h-10" />
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setCreateDialogOpen(false)} disabled={creating}>取消</Button><Button type="submit" disabled={!canvasName.trim() || creating} className="bg-violet-600 hover:bg-violet-700">{creating && <LoaderCircle className="h-4 w-4 animate-spin" />}创建画布</Button></div>
      </form>
    </div>}
    {renamingCanvasId && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/25 p-6 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget) setRenamingCanvasId(undefined) }}>
      <form onSubmit={event => { event.preventDefault(); renameCanvas() }} className="w-full max-w-sm rounded-2xl border bg-white p-5 shadow-2xl shadow-slate-950/20">
        <div className="mb-5"><div className="mb-1 text-base font-semibold text-slate-900">修改画布名称</div><p className="text-xs leading-5 text-slate-500">新名称会同步显示在画布列表和顶部标题中。</p></div>
        <label htmlFor="rename-canvas" className="mb-2 block text-xs font-medium text-slate-700">画布名称</label>
        <Input id="rename-canvas" autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenamingCanvasId(undefined) }} className="h-10" />
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRenamingCanvasId(undefined)}>取消</Button><Button type="submit" disabled={!renameValue.trim()} className="bg-violet-600 hover:bg-violet-700">保存</Button></div>
      </form>
    </div>}
    {imageCanvasId && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/25 p-6 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget && !generating) setImageCanvasId(undefined) }}>
      <form onSubmit={event => { event.preventDefault(); generateImage() }} className="w-full max-w-lg rounded-2xl border bg-white p-5 shadow-2xl shadow-slate-950/20">
        <div className="mb-5"><div className="mb-1 text-base font-semibold text-slate-900">新建图片</div><p className="text-xs leading-5 text-slate-500">图片将添加到「{canvases.find(canvas => canvas.id === imageCanvasId)?.name}」</p></div>
        <label htmlFor="image-prompt" className="mb-2 block text-xs font-medium text-slate-700">提示词</label>
        <Textarea id="image-prompt" autoFocus value={imagePrompt} onChange={event => setImagePrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !generating) setImageCanvasId(undefined) }} placeholder="描述你想要生成的画面、风格、构图和光线…" className="min-h-28 resize-none leading-6" />
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div><label className="mb-2 block text-xs font-medium text-slate-700">模型</label><select value={generateModelId} onChange={event => setGenerateModelId(event.target.value)} className="setting-select"><option value="" disabled>选择模型</option>{textModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div>
          <div><label className="mb-2 block text-xs font-medium text-slate-700">尺寸</label><select value={imageSize} onChange={event => setImageSize(event.target.value)} className="setting-select"><option value="1024x1024">1:1 方图</option><option value="1536x1024">3:2 横图</option><option value="1024x1536">2:3 竖图</option></select></div>
          <div><label className="mb-2 block text-xs font-medium text-slate-700">质量</label><select value={imageQuality} onChange={event => setImageQuality(event.target.value as typeof imageQuality)} className="setting-select"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
        </div>
        {!textModels.length && <button type="button" onClick={() => { setImageCanvasId(undefined); setConfigOpen(true) }} className="mt-3 text-xs text-violet-600 hover:underline">还没有文生图模型，先添加模型配置</button>}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setImageCanvasId(undefined)} disabled={generating}>取消</Button><Button type="submit" disabled={!imagePrompt.trim() || !generateModelId || generating} className="bg-gradient-to-r from-violet-600 to-fuchsia-600">{generating ? <><LoaderCircle className="h-4 w-4 animate-spin" />正在生成…</> : <><Sparkles className="h-4 w-4" />生成图片</>}</Button></div>
      </form>
    </div>}
    {deletingArtwork && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/30 p-6 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) setDeletingArtwork(undefined) }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="delete-title" className="w-full max-w-sm rounded-2xl border bg-white p-5 shadow-2xl shadow-slate-950/20">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600"><AlertTriangle className="h-5 w-5" /></div>
        <div id="delete-title" className="text-base font-semibold text-slate-900">确认删除这张图片？</div>
        <p className="mt-2 text-xs leading-5 text-slate-500">“{deletingArtwork.prompt || '未命名图片'}”及其所有历史版本都会被永久删除，此操作无法撤销。</p>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={() => setDeletingArtwork(undefined)} disabled={deleting}>取消</Button><Button onClick={deleteArtwork} disabled={deleting} className="bg-red-600 text-white hover:bg-red-700">{deleting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}确认删除</Button></div>
      </div>
    </div>}
    {editing && <ImageEditor artwork={editing} models={models} onClose={() => setEditing(undefined)} onApplied={version => {
      setGallery(items => items.map(item => item.id === editing.id ? { ...item, src: version.src, prompt: version.prompt } : item))
      setCanvasItems(items => ({ ...items, [editing.canvasId]: (items[editing.canvasId] || []).map(item => item.id === editing.id ? { ...item, src: version.src, prompt: version.prompt } : item) }))
      setCanvases(items => items.map(canvas => canvas.id === editing.canvasId && canvas.coverSrc === editing.src ? { ...canvas, coverSrc: version.src } : canvas))
      setEditing(item => item ? { ...item, src: version.src, prompt: version.prompt } : item)
      setToast(`已切换到 V${version.versionNumber}`)
    }} onSaved={path => { setToast(`已保存到 ${path}`); setEditing(undefined) }} />}
    {toast && <div className="fixed bottom-5 left-1/2 z-[80] max-w-xl -translate-x-1/2 rounded-lg border bg-card px-4 py-2.5 text-xs shadow-2xl">{toast}</div>}
  </div>
}

function formatTime(timestamp: number) {
  const distance = Date.now() - timestamp
  if (distance < 60_000) return '刚刚'
  if (distance < 3_600_000) return `${Math.floor(distance / 60_000)} 分钟前`
  if (distance < 86_400_000) return `${Math.floor(distance / 3_600_000)} 小时前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp)
}
