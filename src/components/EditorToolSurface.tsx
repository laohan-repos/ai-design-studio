import { createContext, useContext, type ReactNode } from 'react'
import { History, Layers3, SlidersHorizontal, Images } from 'lucide-react'

const panels = [
  { id: 'properties', label: '属性', icon: SlidersHorizontal },
  { id: 'layers', label: '图层', icon: Layers3 },
  { id: 'versions', label: '版本', icon: Images },
  { id: 'history', label: '历史', icon: History },
] as const

export type EditorPanel = (typeof panels)[number]['id']

export const EditorInspector = createContext<{
  panel: EditorPanel
  openPanel(panel: EditorPanel): void
  versions: ReactNode
  history: ReactNode
  canOpenLayers: boolean
}>({ panel: 'properties', openPanel: () => {}, versions: null, history: null, canOpenLayers: false })

type Props = {
  name: string
  options?: ReactNode
  children: ReactNode
  properties: ReactNode
  layers?: ReactNode
  footer?: ReactNode
  status?: ReactNode
  expandedCanvas?: boolean
}

export function EditorToolSurface({ name, options, children, properties, layers, footer, status, expandedCanvas = false }: Props) {
  const inspector = useContext(EditorInspector)
  const showProperties = inspector.panel === 'properties' || inspector.panel === 'layers'
  return <div className="editor-surface">
    <div className="editor-tool-options">
      <h2>{name}</h2>
      {options}
    </div>
    <div className={`editor-document ${expandedCanvas && inspector.panel !== 'history' ? 'editor-document-expanded' : ''}`}>
      <main aria-label="图片预览" className="editor-stage">
        <div className="editor-preview">{children}</div>
        {status && <div className="editor-status">{status}</div>}
      </main>
      <aside className="editor-dock" aria-label="编辑面板">
        <nav className="editor-dock-tabs" aria-label="编辑面板切换">
          {panels.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={inspector.panel === id}
            disabled={id === 'layers' && !inspector.canOpenLayers} onClick={() => inspector.openPanel(id)}>
            <Icon className="size-3.5" aria-hidden="true" />{label}
          </button>)}
        </nav>
        <div className="editor-panel [scrollbar-gutter:stable]" hidden={!showProperties}>
          {inspector.panel === 'layers' && layers}
          {properties}
        </div>
        {inspector.panel === 'versions' && <div className="editor-panel">{inspector.versions}</div>}
        {inspector.panel === 'history' && <div className="editor-panel">{inspector.history}</div>}
        {showProperties && footer && <div className="editor-panel-footer">{footer}</div>}
      </aside>
    </div>
  </div>
}
