import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Crop, Download, FlipHorizontal2, FlipVertical2, Focus, History, LoaderCircle, Palette, Redo2, RotateCcw, RotateCw, ScanFace, SlidersHorizontal, Sparkles, Undo2, WandSparkles } from 'lucide-react'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { ImageLayerEditor } from './PosterEditor'
import { EditorInspector, EditorToolSurface, type EditorPanel } from './EditorToolSurface'
import { EditorHistoryPanel } from './EditorHistoryPanel'
import { LocalPhotoEditor } from './LocalPhotoEditor'
import { PhotoCropEditor } from './PhotoCropEditor'
import { PhotoSizeEditor } from './PhotoSizeEditor'
import type { Adjustments, Artwork, ArtworkVersion, ModelConfig } from '@/types'
import type { PhotoOperation, PhotoSelectionReference, SavedPhotoEdit } from '@/lib/photo-edits'
import type { CropBox } from '@/lib/photo-crop'
import type { EditorHistory, EditorHistoryEntry } from '@/lib/editor-history'
import { documentSizeLabels, type DocumentSizeMode } from '@/lib/document-size'

type Props = {
  artwork: Artwork
  models: ModelConfig[]
  onClose(): void
  onSaved(path: string): void
  onVersionChange(selection: { artworkId: string; versionId: string }): void
}

const initial: Adjustments = { brightness: 100, contrast: 100, saturation: 100, rotation: 0, flipX: false, flipY: false }
const editorTools = [
  { id: 'adjust', label: '调整', name: '基础调整', icon: SlidersHorizontal },
  { id: 'crop', label: '裁剪', name: '黄金构图裁剪', icon: Crop },
  { id: 'grade', label: '调色', name: '调色', icon: Palette },
  { id: 'local', label: '精修', name: '局部精修', icon: Focus },
  { id: 'retouch', label: '磨皮', name: '人像磨皮', icon: ScanFace },
  { id: 'ai', label: '图生图', name: 'AI 图生图', icon: Sparkles },
] as const
const photoTools = ['crop', 'grade', 'local'] as const
type PhotoTool = typeof photoTools[number]
type Tool = typeof editorTools[number]['id'] | 'layers' | 'size'
type PhotoWorkspace = {
  selectedId: string
  versionId: string
  versionNumber: number
  recipe?: PhotoOperation[]
  initialBox?: CropBox
  initialAngle?: number
}
const isPhotoTool = (tool: Tool): tool is PhotoTool => tool === 'crop' || tool === 'grade' || tool === 'local'

export function ImageEditor({ artwork, models, onClose, onSaved, onVersionChange }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [adjust, setAdjust] = useState(initial)
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  const [versions, setVersions] = useState<ArtworkVersion[]>([])
  const [activeVersionId, setActiveVersionId] = useState('')
  const [tool, setTool] = useState<Tool>('adjust')
  const [panel, setPanel] = useState<EditorPanel>('properties')
  const [sizeMode, setSizeMode] = useState<DocumentSizeMode>('image')
  const [actualSize, setActualSize] = useState(false)
  const [rendered, setRendered] = useState<{ src: string; width: number; height: number }>()
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
  const [layerSeedId, setLayerSeedId] = useState<string>()
  const [layerSourceId, setLayerSourceId] = useState<string>()
  const [photoSelection, setPhotoSelection] = useState<PhotoSelectionReference>()
  const [workspaces, setWorkspaces] = useState<Partial<Record<PhotoTool, PhotoWorkspace>>>({})
  const [openingWorkspace, setOpeningWorkspace] = useState(false)
  const [history, setHistory] = useState<EditorHistory>()
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyNavigating, setHistoryNavigating] = useState(false)
  const [editCommitting, setEditCommitting] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyNavigation, setHistoryNavigation] = useState<{ revision: number; view: EditorHistoryEntry['view'] }>()
  const historyRef = useRef<EditorHistory>()
  const navigationPending = useRef(false)
  const workspaceRequest = useRef(0)
  const activeVersion = versions.find(version => version.id === activeVersionId)
  const image = activeVersion?.src || artwork.src
  const simpleTool = tool === 'adjust' || tool === 'retouch' || tool === 'ai'
  const activeWorkspace = isPhotoTool(tool) && workspaces[tool]?.selectedId === activeVersionId ? workspaces[tool] : undefined
  const layerVersionNumber = versions.find(version => version.id === (layerSourceId || layerSeedId))?.versionNumber
  const canvasReady = rendered?.src === image
  const historyBusy = historyNavigating || editCommitting || applying || generating || retouching

  const acceptHistory = useCallback((next: EditorHistory, restore?: 'open' | 'navigate') => {
    if (historyRef.current && next.revision <= historyRef.current.revision) return
    historyRef.current = next
    setHistory(next)
    setHistoryError('')
    if (!restore) return
    const step = next.entries[next.cursor]
    if (!step) return
    workspaceRequest.current++
    setOpeningWorkspace(false)
    setWorkspaces({})
    setPhotoSelection(undefined)
    setAdjust(initial)
    setActiveVersionId(step.versionId)
    setMessage(undefined)
    if (restore === 'navigate') setHistoryNavigation({ revision: next.revision, view: step.view })
    if (step.view === 'poster') {
      setLayerSeedId(current => current || step.versionId)
      setTool('layers')
      setPanel(current => current === 'history' ? current : 'layers')
    } else {
      setTool('adjust')
      setPanel(current => current === 'history' ? current : 'properties')
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let versionRequest = 0
    const restoreHistory = async () => {
      try {
        const next = await window.studio.getEditorHistory(artwork.id)
        if (!disposed) acceptHistory(next, !historyRef.current && next.entries.length > 1 ? 'open' : undefined)
      } catch {
        if (!disposed) setHistoryError('读取编辑历史失败')
      } finally {
        if (!disposed) setHistoryLoading(false)
      }
    }
    const refresh = () => {
      const request = ++versionRequest
      return window.studio.listArtworkVersions(artwork.id).then(items => {
        if (disposed || request !== versionRequest) return
        setVersions(items)
        setActiveVersionId(id => id || items.find(item => item.isCurrent)?.id || items[0]?.id || '')
      }).catch(error => { if (!disposed && request === versionRequest) setMessage(error instanceof Error ? error.message : '版本读取失败') })
        .finally(() => { if (!disposed && request === versionRequest) setLoading(false) })
    }
    void refresh()
    const unsubscribe = window.studio.onMcpWorkspaceChanged(change => {
      if (change.type === 'artwork_versions_changed' && change.artworkId === artwork.id) void refresh()
      if (change.type === 'artwork_version_applied' && change.result.version.artworkId === artwork.id) {
        if (!change.viaHistory) {
          setActiveVersionId(change.result.version.id)
          setTool('adjust')
        }
        void refresh()
      }
      if (change.type === 'editor_history_changed' && change.history.artworkId === artwork.id) {
        acceptHistory(change.history, change.reason === 'navigate' ? 'navigate' : undefined)
      }
    })
    void restoreHistory()
    return () => { disposed = true; unsubscribe() }
  }, [acceptHistory, artwork.id])

  const navigateHistory = useCallback(async (cursor: number) => {
    const current = historyRef.current
    if (historyBusy || navigationPending.current || !current || cursor < 0 || cursor >= current.entries.length || cursor === current.cursor) return
    navigationPending.current = true
    setHistoryNavigating(true)
    setHistoryError('')
    try {
      acceptHistory(await window.studio.navigateEditorHistory(artwork.id, current.revision, cursor), 'navigate')
    } catch (cause) {
      try { acceptHistory(await window.studio.getEditorHistory(artwork.id)) }
      catch { /* Retain the last history and surface the navigation error. */ }
      setHistoryError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '切换编辑历史失败')
    } finally {
      navigationPending.current = false
      setHistoryNavigating(false)
    }
  }, [acceptHistory, artwork.id, historyBusy])

  useEffect(() => {
    const handleHistoryKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && (key !== 'y' || !event.ctrlKey || event.shiftKey)) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.isContentEditable || target?.closest('textarea, input:not([type="range"]):not([type="checkbox"]):not([type="radio"])')) return
      const current = historyRef.current
      if (!current) return
      event.preventDefault()
      if (!event.repeat) void navigateHistory(current.cursor + (key === 'y' || event.shiftKey ? 1 : -1))
    }
    window.addEventListener('keydown', handleHistoryKey)
    return () => window.removeEventListener('keydown', handleHistoryKey)
  }, [navigateHistory])

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      if (!canvas.current) return
      draw(img, canvas.current, adjust)
      setRendered({ src: image, width: canvas.current.width, height: canvas.current.height })
    }
    img.src = image
    return () => { img.onload = null }
  }, [image, adjust])

  useEffect(() => {
    setAdjust(initial)
    setWorkspaces({})
    setPhotoSelection(undefined)
    setOpeningWorkspace(false)
    return () => { workspaceRequest.current++ }
  }, [activeVersionId])
  useEffect(() => {
    const versionId = (tool === 'layers' ? layerSourceId || layerSeedId : activeWorkspace?.versionId) || activeVersionId
    if (versionId) onVersionChange({ artworkId: artwork.id, versionId })
  }, [activeVersionId, activeWorkspace?.versionId, artwork.id, layerSeedId, layerSourceId, onVersionChange, tool])

  const patch = (next: Partial<Adjustments>) => setAdjust(current => ({ ...current, ...next }))
  const save = async () => {
    if (!canvas.current || !canvasReady) return
    try {
      const data = canvas.current.toDataURL(`image/${format}`, .92)
      const path = await window.studio.saveImage(data, `ai-design-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`)
      if (path) { setMessage(`已导出到 ${path}`); onSaved(path) }
    } catch (error) { setMessage(error instanceof Error ? error.message : '导出图片失败') }
  }

  const createVersion = async () => {
    const config = imageModels.find(model => model.id === modelId)
    if (historyBusy || !config || !prompt.trim() || !activeVersion) return
    setGenerating(true)
    setMessage(undefined)
    try {
      const [src] = await window.studio.generate({ config, prompt: prompt.trim(), size, count: 1, quality, image: activeVersion.src })
      const version = await window.studio.saveArtworkVersion({ id: crypto.randomUUID(), artworkId: artwork.id, src, prompt: prompt.trim(), createdAt: Date.now() })
      setVersions(items => items.some(item => item.id === version.id) ? items : [version, ...items])
      setActiveVersionId(version.id)
      setTool('adjust')
      setPanel('versions')
      setPrompt('')
      setMessage(`V${version.versionNumber} 已生成`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '图生图失败，请检查模型配置') }
    finally { setGenerating(false) }
  }

  const applyVersion = async () => {
    if (historyBusy || !activeVersion || activeVersion.isCurrent) return
    setApplying(true)
    try {
      const applied = await window.studio.applyArtworkVersion(artwork.id, activeVersion.id)
      if (!applied) throw new Error('版本不存在')
      setVersions(items => items.map(item => ({ ...item, isCurrent: item.id === applied.id })))
    } catch (error) { setMessage(error instanceof Error ? error.message : '应用版本失败') }
    finally { setApplying(false) }
  }

  const openTool = async (next: Tool) => {
    if (historyBusy || (!activeVersion && next !== 'adjust')) return
    if (tool === next && openingWorkspace) { setPanel('properties'); return }
    const request = ++workspaceRequest.current
    setTool(next)
    setPanel(next === 'layers' ? 'layers' : 'properties')
    setOpeningWorkspace(false)
    setMessage(undefined)
    if (next === 'layers') {
      setLayerSeedId(current => current || activeVersion?.id)
      return
    }
    if (!isPhotoTool(next) || !activeVersion || workspaces[next]?.selectedId === activeVersion.id) return
    if (next === 'local') {
      setWorkspaces(current => ({ ...current, local: { selectedId: activeVersion.id, versionId: activeVersion.id, versionNumber: activeVersion.versionNumber } }))
      return
    }
    setOpeningWorkspace(true)
    try {
      const recipe = await window.studio.getPhotoEditRecipe({ artworkId: artwork.id, versionId: activeVersion.id })
      if (request !== workspaceRequest.current) return
      const crop = recipe?.operations.find(operation => operation.type === 'crop')
      const initialBox = next === 'crop' && recipe?.operations.length === 1 ? crop?.box : undefined
      const initialAngle = initialBox && crop?.angle
      const grade = next === 'grade' && !crop ? recipe : undefined
      const base = recipe && (grade || initialBox) ? versions.find(version => version.id === recipe.versionId) : activeVersion
      if (!base) throw new Error('编辑配方的底图已不存在')
      setWorkspaces(current => ({ ...current, [next]: { selectedId: activeVersion.id, versionId: base.id, versionNumber: base.versionNumber,
        recipe: grade?.operations, initialBox, initialAngle } }))
    } catch (error) {
      if (request === workspaceRequest.current) setMessage(error instanceof Error ? error.message : '读取编辑配方失败')
    } finally {
      if (request === workspaceRequest.current) setOpeningWorkspace(false)
    }
  }

  const openSize = (mode: DocumentSizeMode) => {
    if (historyBusy || !activeVersion) return
    workspaceRequest.current++
    setOpeningWorkspace(false)
    setSizeMode(mode)
    setTool('size')
    setPanel('properties')
    setMessage(undefined)
  }

  const onPhotoEditSaved = (version: SavedPhotoEdit) => {
    setActiveVersionId(version.versionId)
    setTool('adjust')
    setPanel(current => current === 'history' ? current : 'versions')
    setMessage(`已另存为 V${version.versionNumber}`)
  }

  const openPanel = (next: EditorPanel) => {
    if (next === 'layers' && tool !== 'layers') void openTool('layers')
    else setPanel(next)
  }

  const viewVersion = (versionId: string) => {
    if (historyBusy) return
    if (versionId !== activeVersionId || !simpleTool) {
      setActiveVersionId(versionId)
      setTool('adjust')
    }
  }

  const retouchPortrait = async () => {
    if (!activeVersion || historyBusy) return
    setRetouching(true)
    setMessage(undefined)
    try {
      const { version, faceCount } = await window.studio.retouchPortrait({ artworkId: artwork.id, versionId: activeVersion.id, smoothing, brighten, faces })
      setVersions(items => items.some(item => item.id === version.id) ? items : [version, ...items])
      setActiveVersionId(version.id)
      setTool('adjust')
      setPanel('versions')
      setMessage(`已处理 ${faceCount} 张人脸，结果保存为 V${version.versionNumber}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '人像磨皮失败')
    } finally { setRetouching(false) }
  }

  const toolProperties = tool === 'adjust' ? <>
    <Control name="亮度" value={adjust.brightness} onChange={value => patch({ brightness: value })} />
    <Control name="对比度" value={adjust.contrast} onChange={value => patch({ contrast: value })} />
    <Control name="饱和度" value={adjust.saturation} onChange={value => patch({ saturation: value })} />
    <div className="mt-6"><Label>变换</Label><div className="mt-2 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation - 90 })}><RotateCcw className="h-4 w-4" />左转</Button><Button variant="outline" onClick={() => patch({ rotation: adjust.rotation + 90 })}><RotateCw className="h-4 w-4" />右转</Button><Button variant={adjust.flipX ? 'secondary' : 'outline'} onClick={() => patch({ flipX: !adjust.flipX })}><FlipHorizontal2 className="h-4 w-4" />水平</Button><Button variant={adjust.flipY ? 'secondary' : 'outline'} onClick={() => patch({ flipY: !adjust.flipY })}><FlipVertical2 className="h-4 w-4" />垂直</Button></div></div>
  </> : tool === 'retouch' ? <>
    <p className="mb-4 text-xs leading-5 text-slate-500">对选中版本的人脸进行本地磨皮和提亮，结果保存为新版本。</p>
    <Control name="磨皮强度" value={smoothing} max={100} onChange={setSmoothing} />
    <Control name="提亮强度" value={brighten} max={30} onChange={setBrighten} />
    <Label htmlFor="retouch-faces">处理范围</Label>
    <select id="retouch-faces" className="setting-select mt-2" value={faces} onChange={event => setFaces(event.target.value as typeof faces)}>
      <option value="all">所有人脸</option><option value="primary">主要人脸</option>
    </select>
    <Button className="mt-5 w-full" onClick={retouchPortrait} disabled={!activeVersion || historyBusy || (!smoothing && !brighten)}>
      {retouching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{retouching ? '正在处理…' : '磨皮并保存新版本'}
    </Button>
  </> : <>
    <Label htmlFor="edit-prompt">编辑要求</Label><Textarea id="edit-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：保持人物不变，将背景改成海边日落…" className="mt-2 min-h-28 resize-none leading-5" />
    <div className="mt-4"><Label>图生图模型</Label><select value={modelId} onChange={event => setModelId(event.target.value)} className="setting-select mt-2"><option value="" disabled>选择模型</option>{imageModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div>
    <div className="mt-4 grid grid-cols-2 gap-3"><div><Label>尺寸</Label><select value={size} onChange={event => setSize(event.target.value)} className="setting-select mt-2"><option value="1024x1024">1:1 方图</option><option value="1536x1024">3:2 横图</option><option value="1024x1536">2:3 竖图</option></select></div><div><Label>质量</Label><select value={quality} onChange={event => setQuality(event.target.value as typeof quality)} className="setting-select mt-2"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div></div>
    {!imageModels.length && <p className="mt-3 text-xs leading-5 text-amber-600">请先关闭编辑器，在模型配置中添加图生图模型。</p>}
    <Button onClick={createVersion} disabled={!prompt.trim() || !modelId || historyBusy || !activeVersion} className="mt-5 h-10 w-full bg-gradient-to-r from-violet-600 to-fuchsia-600">{generating ? <><LoaderCircle className="h-4 w-4 animate-spin" />正在生成新版本…</> : <><Sparkles className="h-4 w-4" />生成新版本</>}</Button>
  </>

  const name = editorTools.find(item => item.id === tool)?.name ?? '图层合成'
  const versionHistory = <div className="space-y-2" aria-label="图片版本">
    {versions.map(version => <button key={version.id} type="button" disabled={historyBusy} aria-pressed={version.id === activeVersionId} onClick={() => viewVersion(version.id)}
      className={`flex w-full items-center gap-2 rounded-lg border p-1.5 text-left text-xs ${version.id === activeVersionId ? 'border-violet-300 bg-violet-50 text-violet-950' : 'border-slate-200 bg-white hover:border-slate-400'}`}>
      <img src={version.src} alt="" className="size-10 shrink-0 rounded-md bg-slate-100 object-cover" />
      <span className="font-semibold">V{version.versionNumber}</span>
      {version.isCurrent && <span className="ml-auto flex items-center gap-1 whitespace-nowrap pr-1 text-[11px] text-emerald-700"><Check className="size-3.5" />画布当前</span>}
    </button>)}
    {!versions.length && <p className="py-2 text-xs text-slate-500">{loading ? '正在读取版本…' : '暂无版本'}</p>}
  </div>
  const editingHistory = history || historyLoading
    ? <EditorHistoryPanel history={history} disabled={historyBusy} onGoTo={cursor => void navigateHistory(cursor)} />
    : <p className="py-2 text-xs text-slate-600">编辑历史暂不可用</p>

  return <div className="image-workbench" aria-label="图片编辑器">
    <header className="editor-titlebar drag-region">
      <div className="no-drag flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <Button variant="ghost" size="icon" aria-label="返回画布" title="返回画布" className="size-8 shrink-0" onClick={onClose}><ArrowLeft className="size-4" /></Button>
        <h1 className="shrink-0 text-sm font-semibold">图片编辑器</h1>
        {activeVersion && <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700">V{activeVersion.versionNumber}</span>}
        <div className="flex shrink-0 items-center gap-0.5 border-l pl-1.5" aria-label="编辑历史操作">
          <Button variant="ghost" size="icon" className="size-8" aria-label="撤销" title="撤销（⌘Z 或 Ctrl+Z）"
            disabled={historyBusy || !history?.cursor} onClick={() => history && void navigateHistory(history.cursor - 1)}><Undo2 className="size-4" /></Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label="重做" title="重做（⌘⇧Z 或 Ctrl+Shift+Z）"
            disabled={historyBusy || !history || history.cursor >= history.entries.length - 1}
            onClick={() => history && void navigateHistory(history.cursor + 1)}><Redo2 className="size-4" /></Button>
          <Button variant={panel === 'history' ? 'secondary' : 'ghost'} size="icon" className="size-8" aria-label="历史面板" title="历史面板"
            aria-pressed={panel === 'history'} onClick={() => setPanel(current => current === 'history' ? (tool === 'layers' ? 'layers' : 'properties') : 'history')}>
            <History className="size-4" />
          </Button>
        </div>
      </div>
      {simpleTool && <div className="no-drag flex min-w-0 flex-wrap items-center gap-1.5 max-sm:ml-auto">
        {activeVersion && !activeVersion.isCurrent && <Button size="sm" variant="outline" onClick={applyVersion} disabled={historyBusy} aria-label="应用到画布" title="应用到画布" className="px-2">
          {applying ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}<span className="hidden min-[440px]:inline">应用到画布</span></Button>}
        <select aria-label="导出格式" value={format} onChange={event => setFormat(event.target.value as typeof format)}>
          <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
        </select>
        <Button size="sm" aria-label="导出图片" onClick={save} disabled={loading || !canvasReady || historyNavigating} className="px-2.5"><Download className="size-3.5" /><span>导出</span></Button>
      </div>}
    </header>
    {historyError && <p className="shrink-0 border-b bg-red-50 px-4 py-2 text-xs text-red-700" role="alert">{historyError}</p>}
    <EditorInspector.Provider value={{ panel, openPanel, versions: versionHistory, history: editingHistory, canOpenLayers: Boolean(activeVersion) && !historyBusy }}>
      <div className="editor-workspace">
        <nav className="editor-tools" aria-label="图片编辑工具">
          {editorTools.map(({ id, label, name, icon: Icon }) => <button key={id} type="button" aria-pressed={tool === id} aria-label={id === 'crop' ? label : name}
            title={name} disabled={historyBusy || (id !== 'adjust' && !activeVersion)} onClick={() => void openTool(id)}>
            <Icon className="size-4" aria-hidden="true" /><span>{label}</span>
          </button>)}
        </nav>
        <div className="min-h-0 min-w-0 flex-1">
          <div className={simpleTool || (!activeWorkspace && tool !== 'layers' && tool !== 'size') ? 'h-full' : 'hidden'}>
            <EditorToolSurface name={name} options={simpleTool && <>
              <Button size="sm" variant="outline" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>适合窗口</Button>
              <Button size="sm" variant="outline" aria-pressed={actualSize} onClick={() => setActualSize(true)}>100%</Button>
              {tool === 'adjust' && <Button size="sm" variant="outline" onClick={() => setAdjust(initial)}><Undo2 className="size-3.5" />重置</Button>}
              {tool === 'adjust' && (['image', 'canvas'] as const).map(mode => <Button key={mode} size="sm" variant="outline"
                disabled={!activeVersion || historyBusy} onClick={() => openSize(mode)}>{documentSizeLabels[mode]}</Button>)}
            </>}
              properties={simpleTool ? toolProperties : <p className="text-xs text-slate-600">{openingWorkspace ? '正在读取编辑配方…' : '点工具重新加载'}</p>}
              footer={message && <p role="status" className="max-h-16 overflow-auto break-words text-xs leading-5 text-slate-600">{message}</p>}
              status={<>
                {canvasReady && rendered && <><span>{rendered.width} × {rendered.height} px</span><span>{actualSize ? '100%' : '适合窗口'}</span></>}
                {panel === 'versions' && message && <span role="status" className="truncate" title={message}>{message}</span>}
              </>}>
              <div className={actualSize ? 'absolute inset-0 overflow-auto' : 'flex h-full w-full items-center justify-center'}>
                <div className={actualSize ? 'grid min-h-full min-w-full w-max place-items-center p-5' : 'flex h-full w-full items-center justify-center'}>
                  <canvas ref={canvas} className={`checkerboard block rounded-sm shadow-xl ${actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}`} aria-label="图片" />
                </div>
              </div>
              {(loading || openingWorkspace && !simpleTool) && <div className="absolute inset-0 flex items-center justify-center bg-white/60" role="status" aria-label="正在加载"><LoaderCircle className="size-6 animate-spin text-violet-600" /></div>}
            </EditorToolSurface>
          </div>
          {photoTools.map(mode => {
            const workspace = workspaces[mode]
            if (!workspace || workspace.selectedId !== activeVersionId) return null
            const props = { artworkId: artwork.id, versionId: workspace.versionId, versionNumber: workspace.versionNumber,
              onSaved: onPhotoEditSaved, saveDisabled: historyNavigating, onSavingChange: setEditCommitting }
            return <div key={mode} className={tool === mode ? 'h-full' : 'hidden'}>
              {mode === 'crop' ? <PhotoCropEditor {...props} initialBox={workspace.initialBox} initialAngle={workspace.initialAngle} /> : <LocalPhotoEditor {...props} mode={mode} recipe={workspace.recipe}
                onSelectionChange={tool === mode ? setPhotoSelection : undefined} />}
            </div>
          })}
          {tool === 'size' && activeVersion && <PhotoSizeEditor key={`${sizeMode}:${activeVersion.id}`} artworkId={artwork.id}
            versionId={activeVersion.id} mode={sizeMode} disabled={historyNavigating} onClose={() => void openTool('adjust')}
            onSaved={onPhotoEditSaved} onSavingChange={setEditCommitting} />}
          {layerSeedId && <div className={tool === 'layers' ? 'h-full' : 'hidden'}>
            <ImageLayerEditor artwork={artwork} versionId={layerSeedId} versionNumber={layerVersionNumber} models={models} photoSelection={photoSelection}
              historyNavigating={historyNavigating} historyNavigation={historyNavigation} onBusyChange={setEditCommitting} onSourceChange={setLayerSourceId} />
          </div>}
        </div>
      </div>
    </EditorInspector.Provider>
  </div>
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
