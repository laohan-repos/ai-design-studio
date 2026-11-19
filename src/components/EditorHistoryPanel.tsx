import { useEffect, useRef } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { EditorHistory } from '@/lib/editor-history'

export function EditorHistoryPanel({ history, disabled, onGoTo }: {
  history?: EditorHistory
  disabled: boolean
  onGoTo(index: number): void
}) {
  const active = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    active.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [history?.revision])

  if (!history) return <div className="flex items-center gap-2 py-2 text-xs text-slate-600" role="status">
    <LoaderCircle className="size-4 animate-spin text-violet-600" />正在读取历史
  </div>

  return <ol aria-label="编辑历史" className="space-y-1">
    {history.entries.map((entry, index) => {
      const current = index === history.cursor
      return <li key={index}>
        <button type="button" ref={current ? active : undefined} aria-current={current ? 'step' : undefined}
          disabled={disabled || current} onClick={() => onGoTo(index)}
          className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs focus-visible:outline focus-visible:outline-violet-500
            ${current ? 'bg-violet-100 font-medium text-violet-800' : index > history.cursor ? 'text-slate-500 hover:bg-slate-100' : 'text-slate-700 hover:bg-slate-100'}`}>
          <span className="min-w-0 flex-1 break-words">{entry.label}</span>
          {current && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
        </button>
      </li>
    })}
  </ol>
}
