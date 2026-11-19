export type EditorHistoryEntry = {
  label: string
  kind: 'initial' | 'layers' | 'mask' | 'crop' | 'grade' | 'photo' | 'apply'
  view: 'photo' | 'poster'
  versionId: string
}

export type EditorHistory = {
  artworkId: string
  revision: number
  cursor: number
  entries: EditorHistoryEntry[]
}

export type EditorPhotoHistoryEdit = {
  kind: 'crop' | 'grade' | 'photo'
  label: string
  sourceVersionId: string
  expectedRevision?: number
}

export type EditorPosterHistoryEdit = {
  kind: 'layers' | 'mask'
  label: string
}
