import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { documentSizeLabels, photoSizeMaxPixels, photoSizeMaxSide, type DocumentSizeMode } from '@/lib/document-size'
import type { PhotoEditPreview, PhotoInspection, PhotoSizeOperation, SavedPhotoEdit } from '@/lib/photo-edits'
import { DocumentSizeForm, type SizeSettings } from './DocumentSizeForm'
import { EditorToolSurface } from './EditorToolSurface'
import { Button } from './ui/button'

type Props = {
  artworkId: string
  versionId: string
  mode: DocumentSizeMode
  disabled: boolean
  onClose(): void
  onSaved(version: SavedPhotoEdit): void
  onSavingChange(saving: boolean): void
}

function operationOf(mode: DocumentSizeMode, { width, height, anchor }: SizeSettings): PhotoSizeOperation {
  return mode === 'image' ? { type: 'resize', width, height } : { type: 'canvas_size', width, height, anchor }
}

export function PhotoSizeEditor({ artworkId, versionId, mode, disabled, onClose, onSaved, onSavingChange }: Props) {
  const [image, setImage] = useState<PhotoInspection>()
  const [preview, setPreview] = useState<{ image: PhotoEditPreview; size: SizeSettings }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    window.studio.inspectPhoto({ artworkId, versionId }).then(result => {
      if (active) setImage(result)
    }, cause => {
      if (active) setError(messageFrom(cause))
    })
    return () => { active = false }
  }, [artworkId, versionId])

  async function run(size: SizeSettings, save: boolean) {
    if (busy || disabled) return
    setBusy(true)
    setError('')
    if (save) onSavingChange(true)
    try {
      const cached = preview?.size.width === size.width && preview.size.height === size.height && preview.size.anchor === size.anchor
      const frame = cached ? preview.image : await window.studio.previewPhotoEdit({ artworkId, versionId, operations: [operationOf(mode, size)] })
      setPreview({ image: frame, size })
      if (save) onSaved(await window.studio.savePhotoEdit(frame.draftId))
    } catch (cause) {
      setError(messageFrom(cause))
      setPreview(undefined)
    } finally {
      setBusy(false)
      if (save) onSavingChange(false)
    }
  }

  const dimensions = preview?.size ?? (image && { width: image.imageWidth, height: image.imageHeight })
  return <EditorToolSurface name={documentSizeLabels[mode]}
    options={<Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>返回调整</Button>}
    properties={<>
      {image && <DocumentSizeForm mode={mode} current={{ width: image.imageWidth, height: image.imageHeight }}
        min={1} max={photoSizeMaxSide} maxPixels={photoSizeMaxPixels} disabled={busy || disabled}
        onApply={size => void run(size, true)} onPreview={size => void run(size, false)} onChange={() => { setPreview(undefined); setError('') }} />}
      {error && <p className="mt-3 break-words text-xs leading-5 text-red-600" role="alert">{error}</p>}
    </>}
    status={dimensions && <><span>{dimensions.width} × {dimensions.height} px</span>{busy && <span>正在处理尺寸</span>}</>}>
    {preview || image ? <img alt={preview ? '尺寸调整预览' : '尺寸调整原图'} src={preview?.image.after ?? image?.src}
      className="checkerboard block min-h-0 max-h-full max-w-full rounded-sm object-contain shadow-xl" />
      : error ? <p className="text-xs text-slate-600">预览暂不可用</p> : <LoaderCircle aria-label="正在读取图片" className="size-6 animate-spin text-violet-600" />}
  </EditorToolSurface>
}

function messageFrom(reason: unknown) {
  return reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '尺寸调整失败'
}
