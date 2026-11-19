import type { EditorHistory, EditorHistoryEntry } from '../src/lib/editor-history'
import type { PosterContent } from '../src/lib/poster'

type EditorHistoryStep = {
  entry: EditorHistoryEntry
  appliedVersionId?: string
  poster?: PosterContent
}

type EditorHistoryBaseline = {
  appliedVersionId: string
  poster?: PosterContent
}

export type StoredEditorHistory = {
  revision: number
  cursor: number
  steps: EditorHistoryStep[]
  baseline: EditorHistoryBaseline
}

const historyLimit = 60

export function describeEditorHistory(artworkId: string, state: StoredEditorHistory): EditorHistory {
  return { artworkId, revision: state.revision, cursor: state.cursor, entries: state.steps.map(step => step.entry) }
}

export function editorStateAt(history: StoredEditorHistory, cursor: number): EditorHistoryBaseline {
  let poster: PosterContent | undefined
  let appliedVersionId: string | undefined
  for (let index = cursor; index >= 0; index--) {
    const step = history.steps[index]
    poster ??= step.poster
    appliedVersionId ??= step.appliedVersionId
    if (poster && appliedVersionId) break
  }
  return { poster: poster ?? history.baseline.poster, appliedVersionId: appliedVersionId ?? history.baseline.appliedVersionId }
}

export function appendEditorHistory(history: StoredEditorHistory, step: EditorHistoryStep): StoredEditorHistory {
  const next = { ...history, revision: history.revision + 1, steps: [...history.steps.slice(0, history.cursor + 1), step] }
  const drop = Math.max(0, next.steps.length - historyLimit)
  return {
    ...next,
    baseline: drop ? editorStateAt(next, drop - 1) : next.baseline,
    steps: next.steps.slice(drop),
    cursor: next.steps.length - drop - 1
  }
}
