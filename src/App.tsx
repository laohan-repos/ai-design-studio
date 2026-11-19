import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Brush, ChevronDown, ChevronUp, Download, Ellipsis, FolderInput, FolderPlus, ImagePlus, LayoutDashboard, LoaderCircle, Menu, Pencil, Plug, Plus, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react'
import logo from '@/assets/chutu-logo.png'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ModelDialog } from '@/components/ModelDialog'
import { McpDialog } from '@/components/McpDialog'
import { ImageEditor } from '@/components/ImageEditor'
import { InfiniteCanvas, type CanvasImage } from '@/components/InfiniteCanvas'
import { CanvasArtworkGroups } from '@/components/CanvasArtworkGroups'
import { ArtworkGroupDialog, type GroupDialog } from '@/components/ArtworkGroupDialog'
import type { GeneratedArtwork, InfiniteCanvasRecord, ModelConfig } from '@/types'
import type { ArtworkGroup, ArtworkGroupChangeInput } from '@/lib/canvas-groups'

function mergeArtworks(loaded: CanvasImage[], additions: CanvasImage[]) {
  const loadedIds = new Set(loaded.map(item => item.id))
  return [...additions.filter(item => !loadedIds.has(item.id)), ...loaded]
}

export default function App() {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [canvases, setCanvases] = useState<InfiniteCanvasRecord[]>([])
  const [activeCanvasId, setActiveCanvasId] = useState('')
  const activeCanvasIdRef = useRef('')
  const canvasRequest = useRef(0)
  const workspaceRevision = useRef(0)
  const [gallery, setGallery] = useState<CanvasImage[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [configOpen, setConfigOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [editing, setEditing] = useState<CanvasImage>()
  const [viewedVersion, setViewedVersion] = useState<{ artworkId: string; versionId: string }>()
  const [loadingCanvas, setLoadingCanvas] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [canvasName, setCanvasName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ canvasId: string; x: number; y: number; artwork?: CanvasImage }>()
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
  const [canvasGroups, setCanvasGroups] = useState<Record<string, ArtworkGroup[]>>({})
  const [groupDialog, setGroupDialog] = useState<GroupDialog>()
  const [focusArtworks, setFocusArtworks] = useState<{ ids: string[]; fit?: boolean }>()
  const [toast, setToast] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const activeCanvas = canvases.find(canvas => canvas.id === activeCanvasId)
  const selected = selectedIds.length === 1 ? gallery.find(item => item.id === selectedIds[0]) : undefined
  const textModels = models.filter(model => model.taskType === 'text-to-image')

  useEffect(() => {
    window.studio.updateEditorContext({ canvasId: editing?.canvasId || activeCanvasId || undefined, selectedArtworkIds: selectedIds.slice(0, 512),
      editingArtworkId: editing?.id, viewedVersionId: editing && viewedVersion?.artworkId === editing.id ? viewedVersion.versionId : undefined })
  }, [activeCanvasId, editing, selectedIds, viewedVersion])

  const readWorkspace = useCallback(async function readLatest<T>(read: () => Promise<T>): Promise<T> {
    const revision = workspaceRevision.current
    const data = await read()
    return revision === workspaceRevision.current ? data : readLatest(read)
  }, [])

  const openCanvas = useCallback(async (id: string) => {
    if (id === activeCanvasIdRef.current) return
    const request = ++canvasRequest.current
    activeCanvasIdRef.current = id
    setActiveCanvasId(id)
    setSelectedIds([])
    setGallery([])
    setFocusArtworks(undefined)
    if (!id) { setLoadingCanvas(false); return }
    setLoadingCanvas(true)
    try {
      const [artworks, grouping] = await readWorkspace(() => Promise.all([window.studio.listArtworks(id), window.studio.listArtworkGroups(id)]))
      if (request !== canvasRequest.current) return
      setGallery(items => mergeArtworks(artworks, items))
      setCanvasItems(items => ({ ...items, [id]: mergeArtworks(artworks, items[id] || []) }))
      setCanvasGroups(groups => ({ ...groups, [id]: grouping.groups }))
    } catch (error) {
      if (request === canvasRequest.current) setToast(error instanceof Error ? error.message : '画布加载失败')
    } finally {
      if (request === canvasRequest.current) setLoadingCanvas(false)
    }
  }, [readWorkspace])

  const showGeneratedArtwork = useCallback(({ artwork, artworkCount }: GeneratedArtwork) => {
    const { canvasId } = artwork
    setCanvases(items => items.map(canvas => {
      if (canvas.id !== canvasId) return canvas
      return { ...canvas, artworkCount, coverSrc: canvas.coverSrc || artwork.src, updatedAt: Math.max(canvas.updatedAt, artwork.createdAt) }
    }))
    setCanvasItems(items => ({ ...items, [canvasId]: mergeArtworks(items[canvasId] || [], [artwork]) }))
    if (activeCanvasIdRef.current === canvasId) setGallery(items => mergeArtworks(items, [artwork]))
  }, [])

  useEffect(() => {
    let closed = false
    const unsubscribe = window.studio.onMcpWorkspaceChanged(change => {
      if (change.type === 'poster_updated' || change.type === 'artwork_versions_changed' || change.type === 'editor_history_changed') return
      workspaceRevision.current++
      if (change.type === 'canvas_created') {
        setCanvases(items => items.some(canvas => canvas.id === change.canvas.id) ? items : [change.canvas, ...items])
        if (!activeCanvasIdRef.current) void openCanvas(change.canvas.id)
      } else if (change.type === 'canvas_renamed') {
        const { canvasId, name, updatedAt } = change
        setCanvases(items => items.map(canvas => canvas.id === canvasId ? { ...canvas, name, updatedAt } : canvas))
      } else if (change.type === 'canvas_deleted') {
        const { canvasId, nextCanvasId } = change
        setCanvases(items => items.filter(canvas => canvas.id !== canvasId))
        setExpandedCanvasIds(items => items.filter(id => id !== canvasId))
        setCanvasItems(items => Object.fromEntries(Object.entries(items).filter(([id]) => id !== canvasId)))
        setCanvasGroups(groups => Object.fromEntries(Object.entries(groups).filter(([id]) => id !== canvasId)))
        setGroupDialog(dialog => dialog?.canvasId === canvasId ? undefined : dialog)
        setContextMenu(menu => menu?.canvasId === canvasId ? undefined : menu)
        setRenamingCanvasId(id => id === canvasId ? undefined : id)
        setImageCanvasId(id => id === canvasId ? undefined : id)
        setEditing(item => item?.canvasId === canvasId ? undefined : item)
        setDeletingArtwork(item => item?.canvasId === canvasId ? undefined : item)
        if (activeCanvasIdRef.current === canvasId) void openCanvas(nextCanvasId ?? '')
      } else if (change.type === 'canvas_groups_changed') {
        const { canvasId, groups, assignment } = change.result
        setCanvasGroups(current => ({ ...current, [canvasId]: groups }))
        if (assignment?.artworkIds.length) {
          const ids = new Set(assignment.artworkIds)
          const update = (item: CanvasImage) => ids.has(item.id) ? { ...item, groupId: assignment.groupId } : item
          if (activeCanvasIdRef.current === canvasId) setGallery(items => items.map(update))
          setCanvasItems(items => items[canvasId] ? { ...items, [canvasId]: items[canvasId].map(update) } : items)
        }
      } else if (change.type === 'artwork_created') {
        showGeneratedArtwork(change.result)
      } else if (change.type === 'artwork_moved') {
        const { artworkId, canvasId, x, y, updatedAt } = change
        const move = (item: CanvasImage) => item.id === artworkId ? { ...item, x, y } : item
        if (activeCanvasIdRef.current === canvasId) setGallery(items => items.map(move))
        setCanvasItems(items => items[canvasId] ? { ...items, [canvasId]: items[canvasId].map(move) } : items)
        setCanvases(items => items.map(canvas => canvas.id === canvasId ? { ...canvas, updatedAt } : canvas))
      } else if (change.type === 'artwork_deleted') {
        const { artworkId, canvasId, artworkCount, updatedAt, coverSrc } = change
        const remaining = (items: CanvasImage[]) => items.filter(item => item.id !== artworkId)
        if (activeCanvasIdRef.current === canvasId) setGallery(remaining)
        setCanvasItems(items => items[canvasId] ? { ...items, [canvasId]: remaining(items[canvasId]) } : items)
        setSelectedIds(ids => ids.filter(id => id !== artworkId))
        setCanvases(items => items.map(canvas => canvas.id === canvasId ? { ...canvas, artworkCount, updatedAt, coverSrc } : canvas))
        setContextMenu(menu => menu?.artwork?.id === artworkId ? undefined : menu)
        setEditing(item => item?.id === artworkId ? undefined : item)
        setDeletingArtwork(item => item?.id === artworkId ? undefined : item)
      } else if (change.type === 'artwork_version_applied') {
        const { canvasId, version, isCover, updatedAt } = change.result
        const refresh = (item: CanvasImage) => item.id === version.artworkId ? { ...item, src: version.src, prompt: version.prompt } : item
        setGallery(items => items.map(refresh))
        setCanvasItems(items => ({ ...items, [canvasId]: (items[canvasId] || []).map(refresh) }))
        setCanvases(items => items.map(canvas => canvas.id === canvasId ? { ...canvas, updatedAt, coverSrc: isCover ? version.src : canvas.coverSrc } : canvas))
        setEditing(item => item && refresh(item))
        setToast(`已切换到 V${version.versionNumber}`)
      }
    })
    readWorkspace(() => Promise.all([window.studio.listModels(), window.studio.listCanvases()])).then(async ([savedModels, savedCanvases]) => {
      if (closed) return
      setModels(savedModels)
      setCanvases(items => {
        const existing = new Set(items.map(canvas => canvas.id))
        return [...items, ...savedCanvases.filter(canvas => !existing.has(canvas.id))]
      })
      if (!activeCanvasIdRef.current && savedCanvases[0]) await openCanvas(savedCanvases[0].id)
      else if (!activeCanvasIdRef.current) setLoadingCanvas(false)
    }).catch(error => {
      if (closed) return
      setToast(error instanceof Error ? error.message : '读取本地数据库失败')
      if (!activeCanvasIdRef.current) setLoadingCanvas(false)
    })
    return () => { closed = true; unsubscribe() }
  }, [openCanvas, readWorkspace, showGeneratedArtwork])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const toggleCanvas = async (id: string) => {
    if (expandedCanvasIds.includes(id)) { setExpandedCanvasIds(items => items.filter(item => item !== id)); return }
    setExpandedCanvasIds(items => [...items, id])
    if (canvasGroups[id] && canvasItems[id]) return
    try {
      const [artworks, grouping] = await readWorkspace(() => Promise.all([window.studio.listArtworks(id), window.studio.listArtworkGroups(id)]))
      setCanvasItems(items => ({ ...items, [id]: mergeArtworks(artworks, items[id] || []) }))
      setCanvasGroups(groups => ({ ...groups, [id]: grouping.groups }))
    } catch (error) { setToast(error instanceof Error ? error.message : '图片列表加载失败') }
  }

  const openArtwork = async (canvasId: string, artworkId: string) => {
    if (canvasId !== activeCanvasId) await openCanvas(canvasId)
    setSelectedIds([artworkId])
    setFocusArtworks({ ids: [artworkId] })
    setSidebarOpen(false)
  }

  const focusGroup = async (canvasId: string, ids: string[]) => {
    if (canvasId !== activeCanvasIdRef.current) await openCanvas(canvasId)
    if (canvasId !== activeCanvasIdRef.current) return
    setSelectedIds(ids)
    setFocusArtworks({ ids, fit: true })
    setSidebarOpen(false)
  }

  const changeGroups = async (input: ArtworkGroupChangeInput) => {
    try { await window.studio.changeArtworkGroups(input) }
    catch (error) {
      setToast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '分组操作失败')
    }
  }

  const assignSelection = () => {
    if (!activeCanvasId || !selectedIds.length) return
    const chosen = gallery.filter(item => selectedIds.includes(item.id))
    if (!chosen.length) return
    const groupId = chosen[0].groupId ?? null
    setGroupDialog({ type: 'assign', canvasId: activeCanvasId, artworkIds: chosen.map(item => item.id),
      groupId: chosen.every(item => (item.groupId ?? null) === groupId) ? groupId : null })
  }

  const showCreateDialog = () => {
    const names = new Set(canvases.map(canvas => canvas.name))
    let number = 1
    let name = '画布'
    while (names.has(name)) name = `画布 ${++number}`
    setCanvasName(name)
    setCreateDialogOpen(true)
  }

  const createCanvas = async () => {
    const name = canvasName.trim()
    if (!name) return
    setCreating(true)
    try {
      const canvas = await window.studio.createCanvas(crypto.randomUUID(), name)
      setCanvases(items => [canvas, ...items])
      canvasRequest.current++
      activeCanvasIdRef.current = canvas.id
      setActiveCanvasId(canvas.id)
      setGallery([])
      setFocusArtworks(undefined)
      setLoadingCanvas(false)
      setSelectedIds([])
      setSidebarOpen(false)
      setCreateDialogOpen(false)
      setCanvasName('')
      setToast('已新建画布')
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

  const showCanvasActions = (canvasId: string, x: number, y: number, artwork?: CanvasImage) => {
    setContextMenu({ canvasId, x: Math.max(8, Math.min(x, window.innerWidth - 200)),
      y: Math.max(8, Math.min(y, window.innerHeight - (artwork ? 202 : 166))), artwork })
  }

  useEffect(() => {
    if (!sidebarOpen && !contextMenu) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (contextMenu) setContextMenu(undefined)
      else setSidebarOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [sidebarOpen, contextMenu])

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
    const canvasId = imageCanvasId
    if (!generateModelId || !canvasId || !imagePrompt.trim()) return
    setGenerating(true)
    try {
      const result = await window.studio.generateCanvasArtwork({ canvasId, modelId: generateModelId, prompt: imagePrompt, size: imageSize, quality: imageQuality })
      showGeneratedArtwork(result)
      if (canvasId !== activeCanvasIdRef.current) await openCanvas(canvasId)
      else setSelectedIds([result.artwork.id])
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
    <header className="drag-region flex h-14 shrink-0 items-center gap-1 border-b bg-card/70 pl-[76px] pr-2 backdrop-blur-xl md:pl-20 md:pr-5">
      <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(open => !open)} aria-label="画布列表" aria-expanded={sidebarOpen} aria-controls="canvas-list" className="no-drag h-10 w-10 shrink-0 md:hidden"><Menu className="h-5 w-5" /></Button>
      <div className="no-drag ml-auto flex shrink-0 items-center gap-0.5 sm:gap-2">
        <Button variant="ghost" size="sm" onClick={() => setMcpOpen(true)} title="Agent 接入（MCP）" aria-label="Agent 接入（MCP）" className="max-sm:h-10 max-sm:w-10 max-sm:px-0"><Plug className="h-4 w-4" /><span className="hidden sm:inline">MCP</span></Button>
        <Button variant="ghost" size="icon" onClick={() => setConfigOpen(true)} title="模型配置"><Settings2 className="h-4 w-4" /></Button>
      </div>
    </header>

    <div className="flex min-h-0 flex-1">
      {sidebarOpen && <button type="button" tabIndex={-1} aria-label="关闭画布列表" className="fixed inset-0 top-14 z-30 bg-slate-950/30 md:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside id="canvas-list" className={`${sidebarOpen ? 'flex' : 'hidden'} fixed bottom-0 left-0 top-14 z-40 w-80 max-w-[calc(100%_-_2rem)] shrink-0 flex-col border-r bg-white shadow-xl md:static md:flex md:shadow-none`}>
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <img src={logo} alt="出图" draggable={false} className="pointer-events-none h-7 w-auto select-none object-contain" />
          <Button variant="ghost" size="icon" aria-label="收起画布列表" onClick={() => setSidebarOpen(false)} className="md:hidden"><X className="h-4 w-4" /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="space-y-2">
            {canvases.map(canvas => {
              const active = canvas.id === activeCanvasId
              const expanded = expandedCanvasIds.includes(canvas.id)
              const artworks = canvasItems[canvas.id] || []
              return <div key={canvas.id}>
                <div onContextMenu={event => { event.preventDefault(); showCanvasActions(canvas.id, event.clientX, event.clientY) }} className={`group flex w-full items-center rounded-xl border pr-2 transition ${active ? 'border-violet-300 bg-violet-50/80 shadow-sm shadow-violet-100' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                  <button onClick={() => {
                    void openCanvas(canvas.id)
                    if (window.matchMedia('(min-width: 768px)').matches) void toggleCanvas(canvas.id)
                    else setSidebarOpen(false)
                  }} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg ${canvas.coverSrc ? 'border bg-slate-100' : active ? 'bg-violet-600 text-white shadow-md shadow-violet-200' : 'border bg-white text-slate-400 group-hover:text-slate-600'}`}>{canvas.coverSrc ? <img src={canvas.coverSrc} alt="画布封面" className="h-full w-full object-cover" /> : <LayoutDashboard className="h-4 w-4" />}</span>
                    <span className="min-w-0 flex-1"><span className={`block truncate text-xs font-medium ${active ? 'text-violet-950' : 'text-slate-700'}`}>{canvas.name}</span><span className="mt-1 block text-[10px] text-slate-400">{canvas.artworkCount ? `${canvas.artworkCount} 个作品` : '空画布'} · {formatTime(canvas.updatedAt)}</span></span>
                  </button>
                  <Button size="icon" variant="ghost" aria-label={`${expanded ? '收起' : '展开'}「${canvas.name}」的作品`} aria-expanded={expanded} onClick={() => toggleCanvas(canvas.id)} className="h-10 w-10 shrink-0 text-slate-500 md:h-7 md:w-7">{expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
                </div>
                {expanded && <CanvasArtworkGroups groups={canvasGroups[canvas.id] ?? []}
                  artworks={artworks} selectedIds={active ? selectedIds : []}
                  onOpenArtwork={artworkId => void openArtwork(canvas.id, artworkId)}
                  onFocusGroup={ids => void focusGroup(canvas.id, ids)}
                  onRename={group => setGroupDialog({ type: 'rename', canvasId: canvas.id, group })}
                  onDelete={group => setGroupDialog({ type: 'delete', canvasId: canvas.id, group })}
                  onReorder={groupIds => void changeGroups({ type: 'reorder', canvasId: canvas.id, groupIds })}
                  onAssign={(artworkIds, groupId) => void changeGroups({ type: 'assign', canvasId: canvas.id, artworkIds, groupId })} />}
              </div>
            })}
          </div>
        </div>
        <div className="border-t p-3"><Button variant="outline" className="h-10 w-full border-dashed text-xs text-slate-600" onClick={showCreateDialog} disabled={creating}><Plus className="h-4 w-4" />新建画布</Button></div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-slate-50">
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-white px-3 md:px-5">
          <div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold">{activeCanvas?.name || '画布'}</span><span className="hidden shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 min-[420px]:inline">{selectedIds.length > 1 ? `已选择 ${selectedIds.length} 项` : gallery.length ? `${gallery.length} 个作品` : '空画布'}</span></div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {selectedIds.length > 0 && <Button size="sm" variant="outline" aria-label="移动到分组" title="移动到分组"
              onClick={assignSelection} className="max-sm:h-10 max-sm:w-10 max-sm:px-0"><FolderInput className="size-3.5" /><span className="hidden sm:inline">分组</span></Button>}
            {selected && <><Button size="sm" variant="outline" onClick={() => setEditing(selected)} className="max-sm:h-10"><Brush className="h-3.5 w-3.5" />编辑</Button><Button size="sm" variant="outline" aria-label="保存图片" title="保存图片" onClick={() => saveDirect(selected.src)} className="max-sm:h-10 max-sm:w-10 max-sm:px-0"><Download className="h-3.5 w-3.5" /><span className="hidden sm:inline">保存</span></Button></>}
            {activeCanvasId && <Button size="icon" variant="ghost" aria-label="画布操作" title="画布操作" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); showCanvasActions(activeCanvasId, rect.right - 192, rect.bottom + 4, selected) }} className="h-10 w-10"><Ellipsis className="h-5 w-5" /></Button>}
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={event => { importFile(event.target.files?.[0], uploadCanvasId || activeCanvasId); setUploadCanvasId(undefined); event.target.value = '' }} />
          {activeCanvasId && <InfiniteCanvas key={activeCanvasId} items={gallery} groups={canvasGroups[activeCanvasId] ?? []}
            selectedIds={selectedIds} focusArtworks={focusArtworks} onSelect={setSelectedIds} onMove={moveItems}
            onMoveEnd={commitMoves} onEdit={setEditing} onDelete={setDeletingArtwork} onUpload={() => requestUpload(activeCanvasId)} />}
          {!activeCanvasId && !loadingCanvas && <div className="absolute inset-0 grid place-items-center p-4"><Button variant="outline" onClick={showCreateDialog}><Plus className="h-4 w-4" />新建画布</Button></div>}
          {loadingCanvas && <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-50/70 backdrop-blur-sm"><div className="flex items-center gap-2 rounded-full border bg-white px-4 py-2 text-xs text-slate-500 shadow-lg"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在加载画布…</div></div>}
        </div>
      </main>
    </div>
    <ModelDialog open={configOpen} models={models} onClose={() => setConfigOpen(false)} onSave={saveModels} />
    {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
    {groupDialog && <ArtworkGroupDialog dialog={groupDialog} groups={canvasGroups[groupDialog.canvasId] ?? []}
      onClose={() => setGroupDialog(undefined)} onSaved={result => {
        if (groupDialog.type === 'create') {
          if (!expandedCanvasIds.includes(result.canvasId)) void toggleCanvas(result.canvasId)
          setToast('分组已创建')
        } else if (groupDialog.type === 'assign') setToast('图片分组已更新')
        setGroupDialog(undefined)
      }} />}
    {contextMenu && <div className="fixed inset-0 z-[60]" onMouseDown={() => setContextMenu(undefined)} onContextMenu={event => { event.preventDefault(); setContextMenu(undefined) }}>
      <div className="absolute w-48 rounded-xl border bg-white p-1.5 shadow-xl shadow-slate-900/15" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={event => event.stopPropagation()}>
        <button onClick={() => showRenameDialog(contextMenu.canvasId)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-slate-100"><Pencil className="h-3.5 w-3.5 text-slate-400" />修改画布名称</button>
        <button onClick={() => { setGroupDialog({ type: 'create', canvasId: contextMenu.canvasId }); setContextMenu(undefined) }} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-violet-50 hover:text-violet-700"><FolderPlus className="size-3.5 text-slate-400" />新建分组</button>
        <button onClick={() => showImageDialog(contextMenu.canvasId)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-violet-50 hover:text-violet-700"><ImagePlus className="h-3.5 w-3.5 text-slate-400" />新建图片</button>
        <button onClick={() => requestUpload(contextMenu.canvasId)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-slate-100"><Upload className="h-3.5 w-3.5 text-slate-400" />上传图片</button>
        {contextMenu.artwork && <button onClick={() => { setDeletingArtwork(contextMenu.artwork); setContextMenu(undefined) }} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" />删除选中图片</button>}
      </div>
    </div>}
    {createDialogOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/25 p-3 backdrop-blur-[2px] sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget && !creating) setCreateDialogOpen(false) }}>
      <form onSubmit={event => { event.preventDefault(); createCanvas() }} className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl border bg-white p-4 shadow-2xl shadow-slate-950/20 sm:p-5">
        <div className="mb-5"><div className="mb-1 text-base font-semibold text-slate-900">新建画布</div><p className="text-xs leading-5 text-slate-500">给画布起一个容易识别的名称，之后可以在左侧列表中切换。</p></div>
        <label htmlFor="canvas-name" className="mb-2 block text-xs font-medium text-slate-700">画布名称</label>
        <Input id="canvas-name" autoFocus value={canvasName} onChange={event => setCanvasName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !creating) setCreateDialogOpen(false) }} placeholder="例如：秋季新品视觉" className="h-10" />
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setCreateDialogOpen(false)} disabled={creating}>取消</Button><Button type="submit" disabled={!canvasName.trim() || creating} className="bg-violet-600 hover:bg-violet-700">{creating && <LoaderCircle className="h-4 w-4 animate-spin" />}创建画布</Button></div>
      </form>
    </div>}
    {renamingCanvasId && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/25 p-3 backdrop-blur-[2px] sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) setRenamingCanvasId(undefined) }}>
      <form onSubmit={event => { event.preventDefault(); renameCanvas() }} className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl border bg-white p-4 shadow-2xl shadow-slate-950/20 sm:p-5">
        <div className="mb-5"><div className="mb-1 text-base font-semibold text-slate-900">修改画布名称</div><p className="text-xs leading-5 text-slate-500">新名称会同步显示在画布列表和顶部标题中。</p></div>
        <label htmlFor="rename-canvas" className="mb-2 block text-xs font-medium text-slate-700">画布名称</label>
        <Input id="rename-canvas" autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenamingCanvasId(undefined) }} className="h-10" />
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRenamingCanvasId(undefined)}>取消</Button><Button type="submit" disabled={!renameValue.trim()} className="bg-violet-600 hover:bg-violet-700">保存</Button></div>
      </form>
    </div>}
    {imageCanvasId && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/25 p-3 backdrop-blur-[2px] sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget && !generating) setImageCanvasId(undefined) }}>
      <form onSubmit={event => { event.preventDefault(); generateImage() }} className="max-h-full w-full max-w-lg overflow-y-auto overscroll-contain rounded-2xl border bg-white p-4 shadow-2xl shadow-slate-950/20 sm:p-5">
        <div className="mb-5"><div className="mb-1 text-base font-semibold text-slate-900">新建图片</div><p className="text-xs leading-5 text-slate-500">图片将添加到「{canvases.find(canvas => canvas.id === imageCanvasId)?.name}」</p></div>
        <label htmlFor="image-prompt" className="mb-2 block text-xs font-medium text-slate-700">提示词</label>
        <Textarea id="image-prompt" autoFocus value={imagePrompt} onChange={event => setImagePrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !generating) setImageCanvasId(undefined) }} placeholder="描述你想要生成的画面、风格、构图和光线…" className="min-h-28 resize-none leading-6" />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="col-span-2 min-w-0 sm:col-span-1"><label className="mb-2 block text-xs font-medium text-slate-700">模型</label><select value={generateModelId} onChange={event => setGenerateModelId(event.target.value)} className="setting-select"><option value="" disabled>选择模型</option>{textModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div>
          <div><label className="mb-2 block text-xs font-medium text-slate-700">尺寸</label><select value={imageSize} onChange={event => setImageSize(event.target.value)} className="setting-select"><option value="1024x1024">1:1 方图</option><option value="1536x1024">3:2 横图</option><option value="1024x1536">2:3 竖图</option></select></div>
          <div><label className="mb-2 block text-xs font-medium text-slate-700">质量</label><select value={imageQuality} onChange={event => setImageQuality(event.target.value as typeof imageQuality)} className="setting-select"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
        </div>
        {!textModels.length && <button type="button" onClick={() => { setImageCanvasId(undefined); setConfigOpen(true) }} className="mt-3 text-xs text-violet-600 hover:underline">还没有文生图模型，先添加模型配置</button>}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setImageCanvasId(undefined)} disabled={generating}>取消</Button><Button type="submit" disabled={!imagePrompt.trim() || !generateModelId || generating} className="bg-gradient-to-r from-violet-600 to-fuchsia-600">{generating ? <><LoaderCircle className="h-4 w-4 animate-spin" />正在生成…</> : <><Sparkles className="h-4 w-4" />生成图片</>}</Button></div>
      </form>
    </div>}
    {deletingArtwork && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/30 p-3 backdrop-blur-[2px] sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) setDeletingArtwork(undefined) }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="delete-title" className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl border bg-white p-4 shadow-2xl shadow-slate-950/20 sm:p-5">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600"><AlertTriangle className="h-5 w-5" /></div>
        <div id="delete-title" className="text-base font-semibold text-slate-900">确认删除这张图片？</div>
        <p className="mt-2 text-xs leading-5 text-slate-500">“{deletingArtwork.prompt || '未命名图片'}”及其所有历史版本都会被永久删除，此操作无法撤销。</p>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={() => setDeletingArtwork(undefined)} disabled={deleting}>取消</Button><Button onClick={deleteArtwork} disabled={deleting} className="bg-red-600 text-white hover:bg-red-700">{deleting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}确认删除</Button></div>
      </div>
    </div>}
    {editing && <ImageEditor key={editing.id} artwork={editing} models={models} onVersionChange={setViewedVersion} onClose={() => { setEditing(undefined); setViewedVersion(undefined) }} onSaved={path => setToast(`已保存到 ${path}`)} />}
    {toast && <div className="fixed bottom-5 left-1/2 z-[80] w-max max-w-[calc(100%_-_1.5rem)] -translate-x-1/2 break-words rounded-lg border bg-card px-4 py-2.5 text-xs shadow-2xl sm:max-w-xl">{toast}</div>}
  </div>
}

function formatTime(timestamp: number) {
  const distance = Date.now() - timestamp
  if (distance < 60_000) return '刚刚'
  if (distance < 3_600_000) return `${Math.floor(distance / 60_000)} 分钟前`
  if (distance < 86_400_000) return `${Math.floor(distance / 3_600_000)} 小时前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp)
}
