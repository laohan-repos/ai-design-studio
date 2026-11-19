import { useRef, useState, type PointerEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Ellipsis, Folder, Pencil, Trash2 } from 'lucide-react'
import type { Artwork } from '@/types'
import type { ArtworkGroup } from '@/lib/canvas-groups'

const ungrouped = 'ungrouped'

type Props = {
  groups: ArtworkGroup[]
  artworks: Artwork[]
  selectedIds: string[]
  onOpenArtwork(artworkId: string): void
  onFocusGroup(artworkIds: string[]): void
  onRename(group: ArtworkGroup): void
  onDelete(group: ArtworkGroup): void
  onReorder(groupIds: string[]): void
  onAssign(artworkIds: string[], groupId: string | null): void
}

export function CanvasArtworkGroups({
  groups, artworks, selectedIds, onOpenArtwork, onFocusGroup,
  onRename, onDelete, onReorder, onAssign,
}: Props) {
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [menu, setMenu] = useState<string>()
  const [dropTarget, setDropTarget] = useState<string>()
  const sidebar = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ pointerId: number; x: number; y: number; artworkIds: string[]; moved: boolean }>()
  const preventClick = useRef(false)
  const itemsByGroup = new Map<string | null, Artwork[]>()
  const groupIds = new Set(groups.map(group => group.id))
  for (const artwork of artworks) {
    const id = artwork.groupId && groupIds.has(artwork.groupId) ? artwork.groupId : null
    const bucket = itemsByGroup.get(id)
    if (bucket) bucket.push(artwork)
    else itemsByGroup.set(id, [artwork])
  }

  function reorder(index: number, step: -1 | 1) {
    const ids = groups.map(group => group.id)
    const destination = index + step
    if (destination < 0 || destination >= ids.length) return
    const [moved] = ids.splice(index, 1)
    ids.splice(destination, 0, moved)
    onReorder(ids)
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, artworkId: string) {
    preventClick.current = false
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const artworkIds = selectedIds.includes(artworkId) ? selectedIds : [artworkId]
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, artworkIds, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function updateDrag(event: PointerEvent<HTMLButtonElement>, finish = false) {
    const drag = gesture.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6
    const target = drag.moved && document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-artwork-group]')
    const key = target && sidebar.current?.contains(target) ? target.dataset.artworkGroup : undefined
    if (!finish) {
      setDropTarget(key)
      return
    }
    gesture.current = undefined
    setDropTarget(undefined)
    if (!drag.moved) return
    preventClick.current = true
    window.setTimeout(() => { preventClick.current = false }, 0)
    if (key === undefined) return
    const groupId = key === ungrouped ? null : key
    const ids = drag.artworkIds.filter(id => artworks.some(item => item.id === id && (item.groupId ?? null) !== groupId))
    if (ids.length) onAssign(ids, groupId)
  }

  function artworkRows(items: Artwork[]) {
    return items.map(artwork => <button key={artwork.id} type="button" onPointerDown={event => startDrag(event, artwork.id)}
      onPointerMove={event => updateDrag(event)} onPointerUp={event => updateDrag(event, true)}
      onLostPointerCapture={() => { gesture.current = undefined; setDropTarget(undefined) }}
      onClick={() => { if (!preventClick.current) onOpenArtwork(artwork.id) }}
      className={`flex w-full min-w-0 select-none items-center gap-2 rounded-lg p-1.5 text-left transition hover:bg-slate-50 ${selectedIds.includes(artwork.id) ? 'bg-violet-50 text-violet-700' : 'text-slate-600'}`}>
      <img src={artwork.src} alt="" draggable={false} className="size-8 shrink-0 rounded-md border bg-slate-100 object-cover" />
      <span className="min-w-0 flex-1 truncate text-[10px]">{artwork.prompt || '未命名图片'}</span>
    </button>)
  }

  function groupRow(group: ArtworkGroup | null, index: number) {
    const groupId = group?.id ?? null
    const key = groupId ?? ungrouped
    const name = group?.name ?? '未分组'
    const items = itemsByGroup.get(groupId) ?? []
    const expanded = !collapsed.includes(key)
    const toggle = () => setCollapsed(values => expanded ? [...values, key] : values.filter(value => value !== key))
    return <div key={key} className="space-y-0.5">
      <div data-artwork-group={key}
        className={`flex min-w-0 items-center rounded-md ${dropTarget === key ? 'bg-violet-100 ring-1 ring-inset ring-violet-400' : 'hover:bg-slate-50'}`}>
        <button type="button" aria-label={`${expanded ? '收起' : '展开'}「${name}」`} aria-expanded={expanded} onClick={toggle}
          className="grid size-8 shrink-0 place-items-center rounded-md text-slate-500 hover:text-violet-700">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-slate-700 hover:text-violet-700"
          title={items.length ? `在画布中定位「${name}」` : name} onClick={() => {
            if (!expanded) toggle()
            if (items.length) onFocusGroup(items.map(item => item.id))
          }}>
          <Folder className="size-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0 truncate">{name}</span>
          <span className="ml-auto shrink-0 pr-1 text-[10px] tabular-nums text-slate-500">{items.length}</span>
        </button>
        {group && <button type="button" aria-label={`「${name}」分组操作`} aria-expanded={menu === key}
          onClick={() => setMenu(current => current === key ? undefined : key)} className="grid size-8 shrink-0 place-items-center rounded-md text-slate-500 hover:text-violet-700">
          <Ellipsis className="size-4" />
        </button>}
      </div>
      {group && menu === key && <div className="ml-2 flex flex-wrap items-center gap-1 rounded-md bg-slate-50 p-1">
        <button type="button" onClick={() => { setMenu(undefined); onRename(group) }} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-700 hover:bg-white"><Pencil className="size-3" />重命名</button>
        <button type="button" aria-label={`上移「${name}」`} disabled={index === 0} onClick={() => reorder(index, -1)}
          className="rounded p-1 text-slate-600 hover:bg-white disabled:opacity-40"><ArrowUp className="size-4" /></button>
        <button type="button" aria-label={`下移「${name}」`} disabled={index === groups.length - 1} onClick={() => reorder(index, 1)}
          className="rounded p-1 text-slate-600 hover:bg-white disabled:opacity-40"><ArrowDown className="size-4" /></button>
        <button type="button" onClick={() => { setMenu(undefined); onDelete(group) }} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"><Trash2 className="size-3" />删除分组</button>
      </div>}
      {expanded && items.length > 0 && <div className="ml-4 space-y-0.5 border-l border-slate-100 pl-1">{artworkRows(items)}</div>}
    </div>
  }

  return <div ref={sidebar} className="ml-5 mt-1 space-y-1 border-l border-violet-100 pl-2" aria-label="画布分组">
    {groups.map((group, index) => groupRow(group, index))}
    {groups.length > 0 ? groupRow(null, -1)
      : artworks.length ? artworkRows(artworks) : <p className="px-2 py-1 text-[10px] text-slate-500">暂无图片</p>}
  </div>
}
