import { useCallback, useEffect, useRef, useState } from 'react'
import { Focus, Hand, Minus, MousePointer2, Pencil, Plus, Scan, Trash2 } from 'lucide-react'
import { Button } from './ui/button'
import type { Artwork } from '@/types'

export type CanvasImage = Artwork
type Viewport = { x: number; y: number; zoom: number }
type Point = { x: number; y: number }
type Tool = 'select' | 'hand'
type Interaction =
  | { type: 'pan'; sx: number; sy: number; x: number; y: number }
  | { type: 'marquee'; sx: number; sy: number; cx: number; cy: number }
  | { type: 'nodes'; sx: number; sy: number; origins: Record<string, Point> }

type Props = {
  items: CanvasImage[]
  selectedIds: string[]
  focusArtwork?: { id: string; sequence: number }
  onSelect(ids: string[]): void
  onMove(updates: Array<{ id: string; x: number; y: number }>): void
  onMoveEnd(updates: Array<{ id: string; x: number; y: number }>): void
  onEdit(item: CanvasImage): void
  onDelete(item: CanvasImage): void
  onUpload(): void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const nodeHeight = (item: CanvasImage) => item.width + 72

export function InfiniteCanvas({ items, selectedIds, focusArtwork, onSelect, onMove, onMoveEnd, onEdit, onDelete, onUpload }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const interaction = useRef<Interaction>()
  const spacePressed = useRef(false)
  const [view, setView] = useState<Viewport>({ x: 120, y: 90, zoom: 1 })
  const viewRef = useRef(view)
  const [tool, setTool] = useState<Tool>('select')
  const [panning, setPanning] = useState(false)
  const [, forceCursor] = useState(0)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number }>()
  const [imageMenu, setImageMenu] = useState<{ item: CanvasImage; x: number; y: number }>()
  useEffect(() => { viewRef.current = view }, [view])

  const frameBounds = useCallback((targets: CanvasImage[], maxZoom = 1.35) => {
    const rect = host.current?.getBoundingClientRect(); if (!rect || !targets.length) return
    const minX = Math.min(...targets.map(i => i.x)); const minY = Math.min(...targets.map(i => i.y))
    const maxX = Math.max(...targets.map(i => i.x + i.width)); const maxY = Math.max(...targets.map(i => i.y + nodeHeight(i)))
    const contentW = Math.max(1, maxX - minX); const contentH = Math.max(1, maxY - minY)
    const zoom = clamp(Math.min((rect.width - 160) / contentW, (rect.height - 160) / contentH), .15, maxZoom)
    setView({ x: (rect.width - contentW * zoom) / 2 - minX * zoom, y: (rect.height - contentH * zoom) / 2 - minY * zoom, zoom })
  }, [])
  const fitAll = useCallback(() => {
    if (!items.length) { const rect = host.current?.getBoundingClientRect(); if (rect) setView({ x: rect.width / 2, y: rect.height / 2, zoom: 1 }); return }
    frameBounds(items)
  }, [items, frameBounds])
  const fitSelection = useCallback(() => {
    const selected = items.filter(item => selectedIds.includes(item.id))
    if (selected.length) frameBounds(selected, 2)
  }, [items, selectedIds, frameBounds])

  useEffect(() => {
    if (!focusArtwork) return
    const item = items.find(candidate => candidate.id === focusArtwork.id)
    const rect = host.current?.getBoundingClientRect()
    if (!item || !rect) return
    setView(current => ({
      ...current,
      x: rect.width / 2 - (item.x + item.width / 2) * current.zoom,
      y: rect.height / 2 - (item.y + nodeHeight(item) / 2) * current.zoom
    }))
  }, [focusArtwork?.sequence])

  useEffect(() => { if (items.length === 1) requestAnimationFrame(fitAll) }, [items.length, fitAll])
  useEffect(() => {
    const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)
    const down = (event: KeyboardEvent) => {
      if (editable(event.target)) return
      if (event.code === 'Space') { event.preventDefault(); spacePressed.current = true; forceCursor(value => value + 1) }
      if (event.key.toLowerCase() === 'v') setTool('select')
      if (event.key.toLowerCase() === 'h') setTool('hand')
      if (event.key === 'Escape') { onSelect([]); setImageMenu(undefined) }
      if (event.key === '1' && !event.shiftKey) setView(v => ({ ...v, zoom: 1 }))
      if ((event.key === '1' && event.shiftKey) || event.key === '0') fitAll()
      if (event.key === '2' && event.shiftKey) fitSelection()
      if (event.key === '=' || event.key === '+') zoomAtCenter(1.25)
      if (event.key === '-') zoomAtCenter(.8)
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { spacePressed.current = false; forceCursor(value => value + 1) } }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  })

  const zoomAtCenter = (factor: number) => {
    const rect = host.current?.getBoundingClientRect(); if (!rect) return
    setView(v => { const next = clamp(v.zoom * factor, .1, 4); const cx = rect.width / 2; const cy = rect.height / 2; return { x: cx - (cx - v.x) * next / v.zoom, y: cy - (cy - v.y) * next / v.zoom, zoom: next } })
  }
  useEffect(() => {
    const node = host.current; if (!node) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = node.getBoundingClientRect(); const current = viewRef.current
      if (event.ctrlKey || event.metaKey) {
        const next = clamp(current.zoom * Math.exp(-event.deltaY * .006), .1, 4)
        const px = event.clientX - rect.left; const py = event.clientY - rect.top
        setView({ x: px - (px - current.x) * next / current.zoom, y: py - (py - current.y) * next / current.zoom, zoom: next })
      } else if (event.shiftKey && !event.deltaX) setView(v => ({ ...v, x: v.x - event.deltaY }))
      else setView(v => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }))
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])
  const beginPan = (event: React.PointerEvent) => {
    event.preventDefault()
    host.current?.setPointerCapture(event.pointerId); setPanning(true)
    interaction.current = { type: 'pan', sx: event.clientX, sy: event.clientY, x: view.x, y: view.y }
  }
  const startCanvas = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || spacePressed.current || tool === 'hand') { beginPan(event); return }
    if (event.button !== 0) return
    const rect = host.current!.getBoundingClientRect(); const sx = event.clientX - rect.left; const sy = event.clientY - rect.top
    if (!event.shiftKey) onSelect([])
    event.currentTarget.setPointerCapture(event.pointerId)
    interaction.current = { type: 'marquee', sx, sy, cx: sx, cy: sy }
    setMarquee({ left: sx, top: sy, width: 0, height: 0 })
  }
  const startNode = (event: React.PointerEvent, item: CanvasImage) => {
    if (event.button === 1 || spacePressed.current || tool === 'hand') { event.stopPropagation(); beginPan(event); return }
    if (event.button !== 0) return
    event.stopPropagation()
    let next = selectedIds
    if (event.shiftKey) next = selectedIds.includes(item.id) ? selectedIds.filter(id => id !== item.id) : [...selectedIds, item.id]
    else if (!selectedIds.includes(item.id)) next = [item.id]
    if (!next.includes(item.id)) { onSelect(next); return }
    onSelect(next); host.current?.setPointerCapture(event.pointerId)
    interaction.current = { type: 'nodes', sx: event.clientX, sy: event.clientY, origins: Object.fromEntries(items.filter(candidate => next.includes(candidate.id)).map(candidate => [candidate.id, { x: candidate.x, y: candidate.y }])) }
  }
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = interaction.current; if (!active) return
    if (active.type === 'pan') setView(v => ({ ...v, x: active.x + event.clientX - active.sx, y: active.y + event.clientY - active.sy }))
    if (active.type === 'nodes') onMove(Object.entries(active.origins).map(([id, origin]) => ({ id, x: origin.x + (event.clientX - active.sx) / view.zoom, y: origin.y + (event.clientY - active.sy) / view.zoom })))
    if (active.type === 'marquee') {
      const rect = host.current!.getBoundingClientRect(); const cx = event.clientX - rect.left; const cy = event.clientY - rect.top
      active.cx = cx; active.cy = cy
      setMarquee({ left: Math.min(active.sx, cx), top: Math.min(active.sy, cy), width: Math.abs(cx - active.sx), height: Math.abs(cy - active.sy) })
    }
  }
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = interaction.current
    if (active?.type === 'nodes') onMoveEnd(Object.entries(active.origins).map(([id, origin]) => ({ id, x: origin.x + (event.clientX - active.sx) / view.zoom, y: origin.y + (event.clientY - active.sy) / view.zoom })))
    if (active?.type === 'marquee') {
      const left = (Math.min(active.sx, active.cx) - view.x) / view.zoom; const top = (Math.min(active.sy, active.cy) - view.y) / view.zoom
      const right = (Math.max(active.sx, active.cx) - view.x) / view.zoom; const bottom = (Math.max(active.sy, active.cy) - view.y) / view.zoom
      const hit = items.filter(item => item.x < right && item.x + item.width > left && item.y < bottom && item.y + nodeHeight(item) > top).map(item => item.id)
      onSelect(event.shiftKey ? Array.from(new Set([...selectedIds, ...hit])) : hit)
    }
    interaction.current = undefined; setPanning(false); setMarquee(undefined)
  }
  const cursor = panning ? 'cursor-grabbing' : spacePressed.current || tool === 'hand' ? 'cursor-grab' : 'cursor-default'

  const openImageMenu = (event: React.MouseEvent, item: CanvasImage) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = host.current?.getBoundingClientRect()
    if (!rect) return
    onSelect([item.id])
    setImageMenu({
      item,
      x: Math.min(event.clientX - rect.left, rect.width - 176),
      y: Math.min(event.clientY - rect.top, rect.height - 56)
    })
  }

  return <div ref={host} tabIndex={0} onPointerDown={startCanvas} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onContextMenu={event => event.preventDefault()} className={`relative h-full w-full touch-none overflow-hidden bg-[#f8f9fc] outline-none ${cursor}`} style={{ backgroundImage: 'radial-gradient(circle, #cfd3dc 1px, transparent 1.25px)', backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px` }}>
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_35%,rgba(240,242,247,.38)_100%)]" />
    <div className="absolute left-0 top-0 will-change-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: '0 0' }}>
      {items.map(item => <article key={item.id} onPointerDown={event => startNode(event, item)} onContextMenu={event => openImageMenu(event, item)} onDoubleClick={event => { event.stopPropagation(); onEdit(item) }} className={`absolute select-none overflow-hidden rounded-2xl bg-white shadow-[0_12px_40px_rgba(21,28,45,.12)] transition-[box-shadow] ${tool === 'hand' || spacePressed.current ? 'cursor-grab' : 'cursor-move'} ${selectedIds.includes(item.id) ? 'ring-[3px] ring-violet-500 shadow-[0_18px_55px_rgba(124,58,237,.2)]' : 'ring-1 ring-black/5 hover:ring-black/10'}`} style={{ left: item.x, top: item.y, width: item.width }}>
        <div className="flex aspect-square items-center justify-center bg-[#f1f2f6]"><img src={item.src} draggable={false} className="h-full w-full object-contain" /></div>
        <div className="border-t border-slate-100 bg-white px-4 py-3"><p className="line-clamp-2 text-xs leading-5 text-slate-500">{item.prompt}</p></div>
      </article>)}
    </div>
    {imageMenu && <div className="absolute inset-0 z-40" onPointerDown={event => { event.stopPropagation(); setImageMenu(undefined) }}>
      <div className="absolute w-40 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/15" style={{ left: imageMenu.x, top: imageMenu.y }} onPointerDown={event => event.stopPropagation()}>
        <button onClick={() => { onSelect([imageMenu.item.id]); onEdit(imageMenu.item); setImageMenu(undefined) }} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-slate-700 hover:bg-violet-50 hover:text-violet-700"><Pencil className="h-3.5 w-3.5 text-slate-400" />编辑</button>
        <button onClick={() => { onSelect([imageMenu.item.id]); onDelete(imageMenu.item); setImageMenu(undefined) }} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" />删除</button>
      </div>
    </div>}
    {marquee && <div className="pointer-events-none absolute border border-violet-500 bg-violet-500/10" style={marquee} />}
    {!items.length && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="pointer-events-auto max-w-sm rounded-3xl border border-slate-200/80 bg-white/90 px-10 py-9 text-center shadow-[0_20px_70px_rgba(31,41,55,.09)] backdrop-blur"><div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-600"><Hand className="h-6 w-6" /></div><h2 className="text-lg font-semibold text-slate-900">这是一张无限画布</h2><p className="mt-2 text-sm leading-6 text-slate-500">滚动平移，⌘ 滚轮缩放，按住 Space 拖动画布。像在 Figma 中一样操作。</p><Button variant="outline" className="mt-5" onClick={onUpload}>上传参考图</Button></div></div>}

    <div className="absolute left-4 top-4 flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg" onPointerDown={event => event.stopPropagation()}>
      <Button variant={tool === 'select' ? 'secondary' : 'ghost'} size="icon" onClick={() => setTool('select')} title="选择工具 (V)"><MousePointer2 className="h-4 w-4" /></Button>
      <Button variant={tool === 'hand' ? 'secondary' : 'ghost'} size="icon" onClick={() => setTool('hand')} title="抓手工具 (H)"><Hand className="h-4 w-4" /></Button>
    </div>
    <div className="absolute bottom-5 right-5 flex items-center gap-1 rounded-xl border border-slate-200 bg-white/95 p-1.5 shadow-lg shadow-slate-300/40 backdrop-blur" onPointerDown={event => event.stopPropagation()}>
      <Button variant="ghost" size="icon" onClick={() => zoomAtCenter(.8)} title="缩小 (-)"><Minus className="h-4 w-4" /></Button>
      <button onClick={() => setView(v => ({ ...v, zoom: 1 }))} className="w-14 text-center text-xs font-medium tabular-nums text-slate-600" title="100% (1)">{Math.round(view.zoom * 100)}%</button>
      <Button variant="ghost" size="icon" onClick={() => zoomAtCenter(1.25)} title="放大 (+)"><Plus className="h-4 w-4" /></Button>
      <div className="mx-1 h-5 w-px bg-slate-200" />
      <Button variant="ghost" size="icon" onClick={fitAll} title="适配全部 (Shift+1)"><Focus className="h-4 w-4" /></Button>
      <Button variant="ghost" size="icon" onClick={fitSelection} disabled={!selectedIds.length} title="适配选中 (Shift+2)"><Scan className="h-4 w-4" /></Button>
    </div>
    <div className="pointer-events-none absolute bottom-6 left-4 rounded-lg border border-slate-200 bg-white/85 px-2.5 py-1.5 text-[10px] text-slate-400 shadow-sm"><span className="font-medium text-slate-500">V</span> 选择 · <span className="font-medium text-slate-500">H / Space</span> 抓手 · <span className="font-medium text-slate-500">Shift</span> 多选 · <span className="font-medium text-slate-500">双击</span> 编辑</div>
  </div>
}
