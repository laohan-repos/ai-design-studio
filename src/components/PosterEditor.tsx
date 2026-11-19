import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Download, Layers3, LoaderCircle, Undo2 } from 'lucide-react'
import type { Artwork } from '@/types'
import { posterSizes, type PosterDocument, type PosterImage, type PosterOperation, type PosterOutput, type PosterPoint, type PosterText } from '@/lib/poster'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

type Props = { artwork: Artwork; versionId?: string; onBack(): void }
type Apply = (operation: PosterOperation) => Promise<boolean>
const tabs = [{ id: 'background', label: '背景' }, { id: 'subject', label: '主体' }, { id: 'shadow', label: '阴影' }, { id: 'text', label: '文字' }] as const

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试'
}

export function PosterEditor({ artwork, versionId, onBack }: Props) {
  const [poster, setPoster] = useState<PosterDocument>()
  const [preview, setPreview] = useState<PosterImage>()
  const [source, setSource] = useState<string>()
  const [sourceRatio, setSourceRatio] = useState(1)
  const [points, setPoints] = useState<PosterPoint[]>()
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('subject')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [size, setSize] = useState<PosterOutput['size']>('current')
  const [format, setFormat] = useState<PosterOutput['format']>('png')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const accept = (updated: PosterDocument) => setPoster(current => current && updated.revision <= current.revision ? current : updated)
  useEffect(() => {
    let closed = false
    const unsubscribe = window.studio.onMcpWorkspaceChanged(change => {
      if (change.type === 'poster_updated' && change.poster.artworkId === artwork.id) accept(change.poster)
    })
    window.studio.openPoster(artwork.id, versionId).then(updated => {
      if (!closed) accept(updated)
    }).catch(cause => { if (!closed) setError(messageFrom(cause)) })
    return () => { closed = true; unsubscribe() }
  }, [artwork.id, versionId])

  useEffect(() => {
    if (!poster) return
    let closed = false
    setRefreshing(true)
    window.studio.previewPoster(artwork.id, size).then(result => {
      if (!closed) setPreview(result)
    }).catch(cause => {
      if (!closed) { setPreview(undefined); setError(messageFrom(cause)) }
    }).finally(() => { if (!closed) setRefreshing(false) })
    return () => { closed = true }
  }, [artwork.id, poster, size])

  const run = async (action: () => Promise<void>) => {
    if (busy) return false
    setBusy(true); setError(''); setMessage('')
    try { await action(); return true }
    catch (cause) { setError(messageFrom(cause)); return false }
    finally { setBusy(false) }
  }

  const apply: Apply = operation => run(async () => {
    if (!poster) return
    accept(await window.studio.editPoster({ artworkId: artwork.id, revision: poster.revision, operations: [operation] }))
  })

  const beginSelection = () => run(async () => {
    if (!source) setSource(await window.studio.getPosterSource(artwork.id))
    setPoints(poster?.mask.type === 'polygon' ? poster.mask.points : [])
  })

  const finishSelection = async () => {
    if (points && points.length >= 3 && await apply({ op: 'set_mask', mask: { type: 'polygon', points } })) setPoints(undefined)
  }

  const exportImage = () => run(async () => {
    const result = await window.studio.exportPoster(artwork.id, { size, format })
    setMessage(`已导出 ${result.width} × ${result.height}：${result.path}`)
  })

  return <div className="fixed inset-0 z-[60] flex flex-col bg-white">
    <header className="drag-region flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 pb-2 pt-1 md:px-5 md:py-3">
      <div className="no-drag flex min-w-0 items-center gap-2 max-sm:pl-16 md:gap-3">
        <Button variant="ghost" size="icon" aria-label="返回图片编辑器" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
        <Layers3 className="h-4 w-4 shrink-0 text-violet-600" />
        <div className="min-w-0"><h2 className="text-sm font-semibold">分层海报</h2><p className="max-w-72 truncate text-xs text-slate-500">{artwork.prompt || '未命名图片'}</p></div>
      </div>
      <div className="no-drag flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2">
        <Button variant="outline" size="sm" aria-label="撤销" title="撤销" className="max-[420px]:w-8 max-[420px]:px-0" disabled={busy || !poster?.canUndo || Boolean(points)} onClick={() => run(async () => { if (poster) accept(await window.studio.undoPoster(artwork.id, poster.revision)) })}>
          <Undo2 className="h-4 w-4" /><span className="hidden min-[420px]:inline">撤销</span>
        </Button>
        <select aria-label="导出比例" className="h-8 rounded-md border bg-white px-2 text-xs" value={size} disabled={Boolean(points)} onChange={event => setSize(event.target.value as PosterOutput['size'])}>
          <option value="current">当前尺寸</option><option value="square">方图 1:1</option><option value="portrait">竖图 2:3</option>
        </select>
        <select aria-label="导出格式" className="h-8 rounded-md border bg-white px-2 text-xs" value={format} onChange={event => setFormat(event.target.value as PosterOutput['format'])}>
          <option value="png">PNG</option><option value="jpeg">JPEG</option>
        </select>
        <Button size="sm" aria-label="导出海报" disabled={busy || !preview || Boolean(points)} onClick={exportImage}><Download className="h-4 w-4" /><span className="sm:hidden">导出</span><span className="hidden sm:inline">导出海报</span></Button>
      </div>
    </header>

    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <main className={`checkerboard flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 overflow-hidden p-3 md:gap-3 md:p-5 ${points ? 'flex-1' : 'h-[43%] shrink-0 md:h-auto md:flex-1'}`}>
        {points && source ? <>
          <div className="flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]">
            <div className="relative cursor-crosshair" style={{ width: `min(100cqw, ${sourceRatio * 100}cqh)`, aspectRatio: sourceRatio }} onClick={event => {
              if (points.length >= 160) return
              const box = event.currentTarget.getBoundingClientRect()
              setPoints([...points, { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }])
            }}>
              <img src={source} draggable={false} alt="请沿原图主体边缘依次标出选区顶点" className="block w-full" onLoad={event => { const img = event.currentTarget; setSourceRatio(img.naturalWidth / img.naturalHeight) }} />
              {points.length >= 3 && <div className="pointer-events-none absolute inset-0 bg-violet-500/25" style={{ clipPath: `polygon(${points.map(point => `${point.x * 100}% ${point.y * 100}%`).join(',')})` }} />}
              {points.map((point, index) => <span key={index} className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet-600 shadow" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />)}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 rounded-lg border bg-white p-1.5 sm:gap-2 sm:p-2">
            <span className="w-full px-1 text-center text-xs text-slate-600 sm:w-auto">沿主体轮廓点击 · {points.length} 个点</span>
            <Button size="sm" variant="ghost" onClick={() => setPoints(points.slice(0, -1))} disabled={busy || !points.length}>撤回一点</Button>
            <Button size="sm" variant="ghost" onClick={() => setPoints([])} disabled={busy || !points.length}>清空</Button>
            <Button size="sm" variant="outline" onClick={() => setPoints(undefined)} disabled={busy}>取消</Button>
            <Button size="sm" onClick={finishSelection} disabled={busy || points.length < 3}>应用选区</Button>
          </div>
        </> : preview ? <>
          <img alt="海报预览" src={preview.src} className="block min-h-0 max-h-full max-w-full rounded-sm object-contain shadow-lg" />
          <span className="shrink-0 rounded-md border bg-white px-2 py-1 text-xs tabular-nums text-slate-600">{preview.width} × {preview.height}{refreshing ? ' · 更新预览中' : ''}</span>
        </> : refreshing || !error ? <LoaderCircle className="h-6 w-6 animate-spin text-violet-600" /> : <span className="rounded-md border bg-white p-3 text-xs text-slate-600">预览暂不可用，可调整图层后重试。</span>}
      </main>

      <aside className={`min-h-0 min-w-0 flex-1 flex-col border-t bg-white md:flex md:w-[344px] md:flex-none md:border-l md:border-t-0 ${points ? 'hidden' : 'flex'}`}>
        <div className="shrink-0 border-b p-2 md:p-4">
          <h3 className="hidden text-sm font-semibold md:block">图层</h3>
          <div className="grid grid-cols-4 gap-1 md:mt-3">
            {tabs.map(item => <Button key={item.id} size="sm" variant={tab === item.id ? 'secondary' : 'ghost'} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</Button>)}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {poster && <fieldset disabled={busy || Boolean(points)} className="min-w-0 disabled:opacity-60" key={`${tab}-${poster.revision}`}>
            {tab === 'background' && <BackgroundControls poster={poster} artwork={artwork} apply={apply} />}
            {tab === 'subject' && <SubjectControls poster={poster} apply={apply} beginSelection={beginSelection} />}
            {tab === 'shadow' && <ShadowControls poster={poster} apply={apply} />}
            {tab === 'text' && <TextControls poster={poster} apply={apply} />}
          </fieldset>}
        </div>
        {(error || message) && <p role={error ? 'alert' : 'status'} className={`max-h-24 shrink-0 overflow-y-auto break-all border-t p-3 text-xs leading-5 md:p-4 ${error ? 'text-red-600' : 'text-slate-600'}`}>{error || message}</p>}
      </aside>
    </div>
  </div>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-xs font-medium text-slate-700"><span>{label}</span>{children}</label>
}

function NumberField({ label, name, value, min, max, step }: { label: string; name: string; value: number; min: number; max: number; step?: 'any' }) {
  return <Field label={label}><Input type="number" name={name} defaultValue={value} min={min} max={max} step={step} required /></Field>
}

function ColorField({ label, name, value }: { label: string; name: string; value: string }) {
  return <Field label={label}><Input type="color" name={name} defaultValue={value} className="px-2 py-1" /></Field>
}

function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()
  return new FormData(event.currentTarget)
}

function BackgroundControls({ poster, artwork, apply }: { poster: PosterDocument; artwork: Artwork; apply: Apply }) {
  const background = poster.background
  const [type, setType] = useState(background.type)
  const [selectedAsset, setSelectedAsset] = useState(background.type === 'image' ? background.artworkId : '')
  const [assets, setAssets] = useState<Artwork[]>([])
  const [assetError, setAssetError] = useState(false)
  useEffect(() => {
    if (type !== 'image') return
    let closed = false
    window.studio.listArtworks(artwork.canvasId).then(items => { if (!closed) setAssets(items.filter(item => item.id !== artwork.id)) })
      .catch(() => { if (!closed) setAssetError(true) })
    return () => { closed = true }
  }, [type, artwork.id, artwork.canvasId])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const form = formValues(event)
    const color = String(form.get('color'))
    if (type === 'transparent') void apply({ op: 'set_background', background: { type } })
    if (type === 'solid') void apply({ op: 'set_background', background: { type, color } })
    if (type === 'gradient') void apply({ op: 'set_background', background: { type, top: color, bottom: String(form.get('bottom')) } })
    if (type === 'image' && form.get('artwork')) {
      const id = String(form.get('artwork'))
      void apply({ op: 'set_background', background: { type, artworkId: id, versionId: background.type === 'image' && background.artworkId === id ? background.versionId : undefined } })
    }
  }
  return <form className="space-y-3" onSubmit={submit}>
    <Field label="背景类型"><select className="setting-select" value={type} onChange={event => setType(event.target.value as typeof type)}>
      <option value="transparent">透明</option><option value="solid">纯色</option><option value="gradient">渐变</option><option value="image">画布图片</option>
    </select></Field>
    {type === 'solid' && <ColorField label="背景颜色" name="color" value={background.type === 'solid' ? background.color : '#eee6da'} />}
    {type === 'gradient' && <div className="grid grid-cols-2 gap-3">
      <ColorField label="顶部颜色" name="color" value={background.type === 'gradient' ? background.top : '#f5ede2'} />
      <ColorField label="底部颜色" name="bottom" value={background.type === 'gradient' ? background.bottom : '#d6b997'} />
    </div>}
    {type === 'image' && <Field label="用作背景的图片"><select className="setting-select" name="artwork" required value={selectedAsset} onChange={event => setSelectedAsset(event.target.value)}>
      <option value="">选择图片</option>
      {background.type === 'image' && !assets.some(asset => asset.id === background.artworkId) && <option value={background.artworkId}>当前背景图</option>}
      {assets.map(asset => <option key={asset.id} value={asset.id}>{asset.prompt || '未命名图片'}</option>)}
    </select></Field>}
    {type === 'image' && assetError && <p className="text-xs text-red-600">读取背景图片失败</p>}
    <Button type="submit" size="sm">应用背景</Button>
  </form>
}

function SubjectControls({ poster, apply, beginSelection }: { poster: PosterDocument; apply: Apply; beginSelection(): void }) {
  const { subject, mask } = poster
  return <div className="space-y-5">
    <form className="space-y-3" onSubmit={event => {
      const form = formValues(event)
      void apply({ op: 'set_mask', mask: { type: 'edge_color', tolerance: Number(form.get('tolerance')) } })
    }}>
      <p className="text-xs leading-5 text-slate-500">{mask.type === 'none' ? '当前使用原图' : mask.type === 'edge_color' ? '当前使用纯色抠图蒙版' : '当前使用手动选区蒙版'}</p>
      <NumberField label="去纯色背景的容差" name="tolerance" value={mask.type === 'edge_color' ? mask.tolerance : 32} min={1} max={150} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit">去纯色背景</Button>
        <Button size="sm" type="button" variant="outline" onClick={beginSelection}>手动描边</Button>
        {mask.type !== 'none' && <Button size="sm" type="button" variant="ghost" onClick={() => apply({ op: 'set_mask', mask: { type: 'none' } })}>移除蒙版</Button>}
      </div>
    </form>
    <form className="space-y-3 border-t pt-4" onSubmit={event => {
      const form = formValues(event)
      const n = (name: string) => Number(form.get(name))
      void apply({ op: 'set_subject', subject: {
        x: n('x'), y: n('y'), width: n('width'), height: n('height'), rotation: n('rotation'),
        brightness: n('brightness'), saturation: n('saturation'), opacity: n('opacity') / 100, visible: form.has('visible')
      } })
    }}>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="横坐标" name="x" value={subject.x} min={-8192} max={8192} />
        <NumberField label="纵坐标" name="y" value={subject.y} min={-8192} max={8192} />
        <NumberField label="宽度" name="width" value={subject.width} min={1} max={8192} />
        <NumberField label="高度" name="height" value={subject.height} min={1} max={8192} />
        <NumberField label="旋转角度" name="rotation" value={subject.rotation} min={-180} max={180} step="any" />
        <NumberField label="不透明度 %" name="opacity" value={Math.round(subject.opacity * 100)} min={0} max={100} />
        <NumberField label="亮度 %" name="brightness" value={subject.brightness} min={0} max={200} />
        <NumberField label="饱和度 %" name="saturation" value={subject.saturation} min={0} max={200} />
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="visible" defaultChecked={subject.visible} />显示主体</label>
      <Button type="submit" size="sm" variant="outline">应用主体设置</Button>
    </form>
  </div>
}

function ShadowControls({ poster, apply }: { poster: PosterDocument; apply: Apply }) {
  return <form className="space-y-3" onSubmit={event => {
    const form = formValues(event)
    void apply({ op: 'set_shadow', shadow: { visible: form.has('visible'), color: String(form.get('color')), opacity: Number(form.get('opacity')) / 100 } })
  }}>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="visible" defaultChecked={poster.shadow.visible} />显示接触阴影</label>
    <ColorField label="阴影颜色" name="color" value={poster.shadow.color} />
    <NumberField label="阴影不透明度 %" name="opacity" value={Math.round(poster.shadow.opacity * 100)} min={0} max={100} />
    <Button type="submit" size="sm">应用阴影</Button>
  </form>
}

function TextControls({ poster, apply }: { poster: PosterDocument; apply: Apply }) {
  const [selected, setSelected] = useState(poster.textLayers.at(-1)?.id || '')
  const layer = poster.textLayers.find(item => item.id === selected)
  const add = (price: boolean) => {
    const scale = poster.width / 1080
    const layer: PosterText = {
      id: crypto.randomUUID(), text: price ? '¥ 99' : '商品标题', x: Math.round(poster.width * .08),
      y: Math.round(poster.height * (price ? .16 : .06)), width: Math.round(poster.width * .84),
      fontSize: Math.max(8, Math.round((price ? 42 : 70) * scale)), color: '#272033', align: 'left', weight: 'bold', visible: true
    }
    void apply({ op: 'upsert_text', layer })
  }
  return <div className="space-y-3">
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={poster.textLayers.length >= 12} onClick={() => add(false)}>添加标题</Button>
      <Button size="sm" variant="outline" disabled={poster.textLayers.length >= 12} onClick={() => add(true)}>添加价格</Button>
    </div>
    {layer && <>
      <Field label="文字图层"><select className="setting-select" value={selected} onChange={event => setSelected(event.target.value)}>
        {poster.textLayers.map(item => <option value={item.id} key={item.id}>{item.text.slice(0, 36)}</option>)}
      </select></Field>
      <form key={layer.id} className="space-y-3" onSubmit={event => {
        const form = formValues(event)
        void apply({ op: 'upsert_text', layer: { ...layer, text: String(form.get('text')), color: String(form.get('color')),
          x: Number(form.get('x')), y: Number(form.get('y')), width: Number(form.get('width')), fontSize: Number(form.get('fontSize')),
          align: String(form.get('align')) as PosterText['align'], weight: form.has('bold') ? 'bold' : 'regular', visible: form.has('visible') } })
      }}>
        <Field label="内容"><Textarea name="text" defaultValue={layer.text} maxLength={300} required className="min-h-16 resize-y" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="横坐标" name="x" value={layer.x} min={-8192} max={8192} />
          <NumberField label="纵坐标" name="y" value={layer.y} min={-8192} max={8192} />
          <NumberField label="文字框宽度" name="width" value={layer.width} min={1} max={8192} />
          <NumberField label="字号" name="fontSize" value={layer.fontSize} min={1} max={1000} />
          <ColorField label="文字颜色" name="color" value={layer.color} />
          <Field label="对齐"><select className="setting-select" name="align" defaultValue={layer.align}>
            <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
          </select></Field>
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="bold" defaultChecked={layer.weight === 'bold'} />加粗</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="visible" defaultChecked={layer.visible} />显示文字</label>
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm">应用文字</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => apply({ op: 'remove_text', layerId: layer.id })}>移除文字层</Button>
        </div>
      </form>
    </>}
  </div>
}
