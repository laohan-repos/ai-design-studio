import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Eye, EyeOff, GripVertical, Image, ImagePlus, Layers2, LoaderCircle, Square, Type } from 'lucide-react'
import type { PosterDocument, PosterLayerId, PosterOperation } from '@/lib/poster'
import { maxPosterImageLayers, maxPosterTextLayers } from '@/lib/poster-limits'
import type { Artwork } from '@/types'
import { Button } from './ui/button'

type Props = {
  poster: PosterDocument
  canvasId: string
  selectedLayerId: string
  disabled: boolean
  onSelect(layerId: string): void
  onAddText(price: boolean): void
  onEdit(operations: PosterOperation[]): Promise<boolean>
}

type DropTarget = { layerId: PosterLayerId; edge: 'above' | 'below' }
const dragType = 'application/x-poster-layer'

export function PosterLayerList({ poster, canvasId, selectedLayerId, disabled, onSelect, onAddText, onEdit }: Props) {
  const [picking, setPicking] = useState(false)
  const [drop, setDrop] = useState<DropTarget>()
  const dragging = useRef<PosterLayerId | undefined>(undefined)
  const topFirst = [...poster.layerOrder].reverse()
  const remaining = maxPosterImageLayers - poster.imageLayers.length
  const edit = (operation: PosterOperation) => { void onEdit([operation]) }

  function moveLayer(source: PosterLayerId, target: DropTarget) {
    if (disabled || source === target.layerId || !topFirst.includes(source)) return
    const order = topFirst.filter(id => id !== source)
    const index = order.indexOf(target.layerId)
    if (index < 0) return
    order.splice(index + (target.edge === 'below' ? 1 : 0), 0, source)
    if (order.some((id, i) => id !== topFirst[i])) edit({ op: 'reorder_layers', order: order.reverse() })
  }

  function getDropTarget(event: DragEvent<HTMLDivElement>, layerId: PosterLayerId): DropTarget {
    const rect = event.currentTarget.getBoundingClientRect()
    return { layerId, edge: event.clientY < rect.top + rect.height / 2 ? 'above' : 'below' }
  }

  function finishDrag() {
    dragging.current = undefined
    setDrop(undefined)
  }

  return <section className="mb-4 space-y-2 border-b pb-3" aria-label="图层列表">
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="outline" disabled={disabled || remaining <= 0} aria-expanded={picking}
        title={remaining <= 0 ? `最多添加 ${maxPosterImageLayers} 个图片图层` : undefined} onClick={() => setPicking(value => !value)}>
        <ImagePlus className="size-3.5" />添加图片
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled || poster.textLayers.length >= maxPosterTextLayers} onClick={() => onAddText(false)}><Type className="size-3.5" />添加标题</Button>
      <Button size="sm" variant="ghost" disabled={disabled || poster.textLayers.length >= maxPosterTextLayers} onClick={() => onAddText(true)}>添加价格</Button>
    </div>
    {picking && <PosterImagePicker canvasId={canvasId} disabled={disabled} remaining={remaining} onClose={() => setPicking(false)}
      onAdd={async artworkIds => {
        const layers = artworkIds.map(artworkId => ({ op: 'add_image' as const, artworkId, layerId: crypto.randomUUID() }))
        if (!await onEdit(layers)) return
        onSelect(`image:${layers[layers.length - 1].layerId}`)
        setPicking(false)
      }} />}
    <div className="rounded-lg border bg-white" onDragLeave={event => {
      if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDrop(undefined)
    }}>
      {topFirst.map((id, index) => {
        const image = id.startsWith('image:') ? poster.imageLayers.find(layer => layer.id === id.slice(6)) : undefined
        const text = id.startsWith('text:') ? poster.textLayers.find(layer => layer.id === id.slice(5)) : undefined
        const label = image?.name ?? text?.text ?? '主体'
        const visible = image?.visible ?? text?.visible ?? poster.subject.visible
        const toggle = () => {
          if (image) edit({ op: 'set_image', layerId: image.id, layer: { visible: !visible } })
          else if (text) edit({ op: 'upsert_text', layer: { ...text, visible: !visible } })
          else edit({ op: 'set_subject', subject: { visible: !visible } })
        }
        return <Fragment key={id}>
          <div className="relative border-b" onDragOver={event => {
            if (disabled || !dragging.current || !event.dataTransfer.types.includes(dragType)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDrop(dragging.current === id ? undefined : getDropTarget(event, id))
          }} onDrop={event => {
            if (!dragging.current || !event.dataTransfer.types.includes(dragType)) return
            event.preventDefault()
            moveLayer(dragging.current, getDropTarget(event, id))
            finishDrag()
          }}>
            <LayerRow label={label} icon={text ? Type : Image} selected={selectedLayerId === id} disabled={disabled} onSelect={() => onSelect(id)} visible={visible} onToggle={toggle}
              handle={<button type="button" disabled={topFirst.length < 2} aria-disabled={disabled || topFirst.length < 2} draggable={!disabled && topFirst.length > 1}
                className="grid size-9 shrink-0 cursor-grab place-items-center text-slate-500 hover:text-violet-800 active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-30"
                aria-label={`调整图层顺序：${label}`} title="拖动排序，或按上下方向键"
                onDragStart={event => {
                  dragging.current = id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(dragType, id)
                  event.dataTransfer.setDragImage(event.currentTarget.parentElement ?? event.currentTarget, 18, 18)
                }} onDragEnd={finishDrag} onKeyDown={event => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                  event.preventDefault()
                  const up = event.key === 'ArrowUp'
                  const adjacent = topFirst[index + (up ? -1 : 1)]
                  if (adjacent) moveLayer(id, { layerId: adjacent, edge: up ? 'above' : 'below' })
                }}><GripVertical className="size-3.5" aria-hidden="true" /></button>} />
            {drop?.layerId === id && <span aria-hidden="true" className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-violet-600 ${drop.edge === 'above' ? '-top-px' : '-bottom-px'}`} />}
          </div>
          {id === 'subject' && <div className="border-b">
            <LayerRow label="阴影" icon={Layers2} selected={selectedLayerId === 'shadow'} disabled={disabled} onSelect={() => onSelect('shadow')}
              visible={poster.shadow.visible} onToggle={() => edit({ op: 'set_shadow', shadow: { visible: !poster.shadow.visible } })} />
          </div>}
        </Fragment>
      })}
      <LayerRow label="背景" icon={Square} selected={selectedLayerId === 'background'} disabled={disabled} onSelect={() => onSelect('background')} />
    </div>
  </section>
}

function LayerRow({ label, icon: Icon, selected, disabled, onSelect, visible, onToggle, handle }: {
  label: string
  icon: typeof Image
  selected: boolean
  disabled: boolean
  onSelect(): void
  visible?: boolean
  onToggle?(): void
  handle?: ReactNode
}) {
  return <div className={`flex min-w-0 ${selected ? 'bg-violet-50 text-violet-900' : 'hover:bg-slate-50'}`}>
    {onToggle ? <button type="button" className="grid size-9 shrink-0 place-items-center text-slate-600 hover:text-violet-800 disabled:opacity-50"
      aria-label={`${visible ? '隐藏' : '显示'}${label}`} title={visible ? '隐藏图层' : '显示图层'} disabled={disabled} onClick={onToggle}>
      {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </button> : <span className="w-9 shrink-0" aria-hidden="true" />}
    <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 text-left text-xs font-medium disabled:opacity-50"
      aria-pressed={selected} title={label} disabled={disabled} onClick={onSelect}>
      <Icon className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{label}</span>
    </button>
    {handle}
  </div>
}

function PosterImagePicker({ canvasId, disabled, remaining, onAdd, onClose }: {
  canvasId: string
  disabled: boolean
  remaining: number
  onAdd(artworkIds: string[]): Promise<void>
  onClose(): void
}) {
  const [artworks, setArtworks] = useState<Artwork[]>()
  const [selection, setSelection] = useState<string[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    window.studio.listArtworks(canvasId).then(items => {
      if (current) setArtworks(items)
    }).catch(() => {
      if (current) setFailed(true)
    })
    return () => { current = false }
  }, [canvasId])

  return <fieldset className="space-y-2 rounded-lg border bg-white p-2" disabled={disabled}>
    <legend className="px-1 text-xs font-medium">选择画布图片</legend>
    {failed ? <p role="alert" className="text-xs text-red-600">读取画布图片失败</p> : !artworks
      ? <div role="status" aria-label="正在读取画布图片" className="flex justify-center py-3"><LoaderCircle className="size-4 animate-spin text-violet-600" /></div>
      : artworks.length === 0 ? <p className="text-xs text-slate-600">画布里暂无图片</p>
      : <div className="max-h-48 divide-y overflow-y-auto">
        {artworks.map(artwork => {
          const checked = selection.includes(artwork.id)
          const label = artwork.prompt.trim() || '未命名图片'
          return <label key={artwork.id} className="flex cursor-pointer items-center gap-2 py-1.5 text-xs" title={label}>
            <input type="checkbox" checked={checked} disabled={!checked && selection.length >= remaining}
              onChange={event => {
                const include = event.currentTarget.checked
                setSelection(current => include ? [...current, artwork.id] : current.filter(id => id !== artwork.id))
              }} />
            <img src={artwork.src} alt="" loading="lazy" className="size-9 shrink-0 rounded border bg-slate-50 object-contain" />
            <span className="min-w-0 truncate">{label}</span>
          </label>
        })}
      </div>}
    <div className="flex gap-1.5">
      <Button size="sm" disabled={selection.length === 0 || selection.length > remaining} onClick={() => void onAdd(selection)}>
        {selection.length ? `添加 ${selection.length} 张` : '添加'}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
    </div>
  </fieldset>
}
