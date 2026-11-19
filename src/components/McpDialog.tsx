import { useEffect, useState } from 'react'
import { Copy, LoaderCircle, X } from 'lucide-react'
import type { McpStatus } from '@/types'
import { Button } from './ui/button'

export function McpDialog({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<McpStatus>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let closed = false
    window.studio.getMcpStatus().then(value => { if (!closed) setStatus(value) })
      .catch(() => { if (!closed) setMessage('读取 MCP 服务状态失败') })
    return () => { closed = true }
  }, [])

  const toggle = async () => {
    if (!status || busy) return
    setBusy(true)
    setMessage('')
    try { setStatus(await window.studio.setMcpEnabled(!status.running)) }
    catch { setMessage('修改 MCP 服务状态失败，请重试') }
    finally { setBusy(false) }
  }
  const copy = async (format: 'codex' | 'token') => {
    try {
      await window.studio.copyMcpConnection(format)
      setMessage(format === 'codex' ? '已复制 Codex 配置' : '已复制 MCP 访问令牌')
    } catch { setMessage('复制失败，请确认 MCP 服务已启动') }
  }

  return <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/25 p-3 backdrop-blur-[2px] sm:p-6"
    onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}
    onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose() }}>
    <section role="dialog" aria-modal="true" aria-labelledby="mcp-title" className="max-h-full min-w-0 w-full max-w-lg overflow-y-auto overscroll-contain rounded-2xl border bg-white p-4 shadow-2xl sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="mcp-title" className="text-base font-semibold">Agent 接入（MCP）</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">允许本机 Agent 管理画布，并使用已配置的文生图模型生成图片。</p>
        </div>
        <Button autoFocus variant="ghost" size="icon" aria-label="关闭 MCP 设置" disabled={busy} onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border bg-slate-50 p-3">
        <span role="status" className="text-sm font-medium">{status ? (status.running ? 'MCP 服务运行中' : 'MCP 服务已关闭') : '正在读取服务状态…'}</span>
        <Button size="sm" variant={status?.running ? 'outline' : 'default'} onClick={toggle} disabled={!status || busy}>
          {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {status?.running ? '停止服务' : '启动服务'}
        </Button>
      </div>
      {status?.error && <p role="alert" className="mt-3 text-xs text-red-600">{status.error}</p>}
      {status?.running && <div className="mt-4 space-y-3">
        <div>
          <label className="text-xs font-medium text-slate-600" htmlFor="mcp-url">Streamable HTTP 地址</label>
          <input id="mcp-url" readOnly value={status.url} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs text-slate-800" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => copy('codex')}><Copy className="h-3.5 w-3.5" />复制 Codex 配置</Button>
          <Button variant="outline" size="sm" onClick={() => copy('token')}>复制访问令牌</Button>
        </div>
        <p className="text-xs leading-5 text-slate-500">Agent 连接时需要 MCP 访问令牌。生图使用已保存的模型和代理，可能产生模型费用。</p>
      </div>}
      {message && <p role="status" className="mt-3 text-xs text-slate-600">{message}</p>}
    </section>
  </div>
}
