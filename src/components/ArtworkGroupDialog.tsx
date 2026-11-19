import { useState, type FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import type { ArtworkGroup, ArtworkGroupChangeInput, CanvasGroupingChange } from '@/lib/canvas-groups'

export type GroupDialog =
  | { canvasId: string; type: 'create' }
  | { canvasId: string; type: 'rename'; group: ArtworkGroup }
  | { canvasId: string; type: 'delete'; group: ArtworkGroup }
  | { canvasId: string; type: 'assign'; artworkIds: string[]; groupId: string | null }

export function ArtworkGroupDialog({ dialog, groups, onClose, onSaved }: {
  dialog: GroupDialog
  groups: ArtworkGroup[]
  onClose(): void
  onSaved(result: CanvasGroupingChange): void
}) {
  const [name, setName] = useState(dialog.type === 'rename' ? dialog.group.name : '')
  const [groupId, setGroupId] = useState(dialog.type === 'assign' ? dialog.groupId ?? '' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const naming = dialog.type === 'create' || dialog.type === 'rename'
  const titles = { create: '新建分组', rename: '重命名分组', delete: '删除分组', assign: '移动到分组' }
  const actions = { create: '创建', rename: '保存', delete: '删除分组', assign: '移动' }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || (naming && !name.trim())) return
    const { canvasId, type } = dialog
    let input: ArtworkGroupChangeInput
    switch (type) {
      case 'assign': input = { type, canvasId, artworkIds: dialog.artworkIds, groupId: groupId || null }; break
      case 'delete': input = { type, canvasId, groupId: dialog.group.id }; break
      case 'rename': input = { type, canvasId, groupId: dialog.group.id, name: name.trim() }; break
      case 'create': input = { type, canvasId, name: name.trim() }; break
    }
    setBusy(true)
    setError('')
    try { onSaved(await window.studio.changeArtworkGroups(input)) }
    catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '分组操作失败')
    } finally { setBusy(false) }
  }

  return <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/25 p-3 backdrop-blur-[2px]"
    onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose() }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (!busy) onClose()
    }}>
    <form role={dialog.type === 'delete' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="group-dialog-title"
      onSubmit={submit} className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl border bg-white p-4 shadow-2xl sm:p-5">
      <h2 id="group-dialog-title" className="mb-4 text-base font-semibold">{titles[dialog.type]}</h2>
      {naming && <label className="block space-y-1.5 text-xs font-medium text-slate-700">
        <span>分组名称</span>
        <Input autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} disabled={busy} />
      </label>}
      {dialog.type === 'assign' && <label className="block space-y-1.5 text-xs text-slate-700">
        <span>{dialog.artworkIds.length} 张图片的目标分组</span>
        <select autoFocus value={groupId} onChange={event => setGroupId(event.target.value)} className="setting-select" disabled={busy}>
          <option value="">未分组</option>
          {groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      {dialog.type === 'delete' && <p className="break-words text-sm leading-6 text-slate-600">删除「{dialog.group.name}」后，其中的图片会回到「未分组」。</p>}
      {error && <p role="alert" className="mt-3 break-words text-xs text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" autoFocus={dialog.type === 'delete'} disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" variant={dialog.type === 'delete' ? 'destructive' : 'default'} disabled={busy || (naming && !name.trim())}>
          {busy && <LoaderCircle className="size-4 animate-spin" />}{actions[dialog.type]}
        </Button>
      </div>
    </form>
  </div>
}
