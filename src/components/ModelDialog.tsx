import { useEffect, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, ImageIcon, LoaderCircle, PlugZap, WandSparkles, X, XCircle } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import type { ModelConfig, ModelTestResult } from '@/types'

type Props = { open: boolean; models: ModelConfig[]; onClose(): void; onSave(models: ModelConfig[]): void }
const constreetEndpoint = (taskType: ModelConfig['taskType']) => `https://api.constreet.cc/v1/images/${taskType === 'text-to-image' ? 'generations' : 'edits'}`
const empty = (taskType: ModelConfig['taskType']): ModelConfig => ({ id: crypto.randomUUID(), name: taskType === 'text-to-image' ? '文生图模型' : '图片编辑模型', provider: 'constreet', taskType, baseUrl: constreetEndpoint(taskType), apiKey: '', model: 'gpt-image-2' })
const normalize = (models: ModelConfig[]) => {
  const text = models.find(model => model.taskType === 'text-to-image')
  const image = models.find(model => model.taskType === 'image-to-image')
  return [text ? { ...text, provider: text.provider === 'constreet' ? 'constreet' as const : 'compatible' as const, taskType: 'text-to-image' as const } : empty('text-to-image'), image ? { ...image, provider: image.provider === 'constreet' ? 'constreet' as const : 'compatible' as const, taskType: 'image-to-image' as const } : empty('image-to-image')]
}

export function ModelDialog({ open, models, onClose, onSave }: Props) {
  const [drafts, setDrafts] = useState<ModelConfig[]>([])
  const [selected, setSelected] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ModelTestResult>()
  useEffect(() => { if (open) { const next = normalize(structuredClone(models)); setDrafts(next); setSelected(next[0].id) } }, [open, models])
  if (!open) return null
  const current = drafts.find(x => x.id === selected) || drafts[0]
  const update = (patch: Partial<ModelConfig>) => { setTestResult(undefined); setDrafts(list => list.map(x => x.id === current.id ? { ...x, ...patch } : x)) }
  const testConnection = async () => {
    if (!current) return
    setTesting(true); setTestResult(undefined)
    try { setTestResult(await window.studio.testModel(current)) }
    catch (error) { setTestResult({ ok: false, modelFound: false, message: error instanceof Error ? error.message : '测试失败' }) }
    finally { setTesting(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-600/30 p-6 backdrop-blur-sm" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div className="flex h-[600px] w-full max-w-[860px] overflow-hidden rounded-2xl border bg-card shadow-2xl">
      <aside className="w-64 border-r bg-slate-50 p-4">
        <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">模型配置</h2><p className="mt-1 text-xs text-muted-foreground">管理图像生成服务</p></div></div>
        <div className="grid grid-cols-2 gap-2">{drafts.map(model => <button key={model.id} onClick={() => { setSelected(model.id); setTestResult(undefined) }} className={`flex h-24 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm font-medium transition ${model.id === current?.id ? 'border-violet-500 bg-violet-50 text-violet-700 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300'}`}>{model.taskType === 'text-to-image' ? <WandSparkles className="h-6 w-6" /> : <ImageIcon className="h-6 w-6" />}<span>{model.taskType === 'text-to-image' ? '文生图' : '图生图'}</span></button>)}</div>
        {current && <div className="mt-4 rounded-2xl bg-violet-100/70 p-4"><div className="flex items-center justify-between"><div className="font-semibold text-violet-800">{current.name}</div><span className="rounded-full bg-white/80 px-2 py-1 text-[10px] font-medium text-violet-700">{current.taskType === 'text-to-image' ? '文生图' : '图生图'}</span></div><div className="mt-2 truncate text-sm text-violet-500">{current.model}</div></div>}
      </aside>
      <main className="flex flex-1 flex-col">
        <div className="flex h-16 items-center justify-between border-b px-6"><div className="font-medium">连接设置</div><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button></div>
        {current ? <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <Field label="显示名称"><Input value={current.name} onChange={e => update({ name: e.target.value })} placeholder="如：OpenAI Image" /></Field>
          <Field label="服务类型"><select value={current.provider} onChange={e => update(e.target.value === 'constreet' ? { provider: 'constreet', baseUrl: constreetEndpoint(current.taskType), model: 'gpt-image-2' } : { provider: 'compatible' })} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="constreet">Constreet GPT-Image-2</option><option value="compatible">自定义 OpenAI Images 兼容接口</option></select></Field>
          <Field label="API 完整地址"><Input value={current.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder={constreetEndpoint(current.taskType)} /></Field>
          <Field label="API Key"><div className="relative"><Input type={showKey ? 'text' : 'password'} value={current.apiKey} onChange={e => update({ apiKey: e.target.value })} placeholder="sk-••••••••" className="pr-10" /><button className="absolute right-3 top-2.5 text-muted-foreground" onClick={() => setShowKey(v => !v)}>{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></Field>
          <Field label="模型 ID"><Input value={current.model} onChange={e => update({ model: e.target.value })} placeholder="gpt-image-2" readOnly={current.provider === 'constreet'} className={current.provider === 'constreet' ? 'bg-slate-50 text-slate-500' : ''} /></Field>
          <div className="flex items-center gap-3"><Button type="button" variant="outline" onClick={testConnection} disabled={testing || !current.baseUrl || !current.apiKey || !current.model}>{testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}{testing ? '正在测试…' : '测试连接'}</Button>{testResult && <div className={`flex min-w-0 items-center gap-1.5 text-xs ${testResult.ok ? (testResult.modelFound ? 'text-emerald-600' : 'text-amber-600') : 'text-red-600'}`}>{testResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}<span className="truncate">{testResult.message}{testResult.latencyMs ? ` · ${testResult.latencyMs}ms` : ''}</span></div>}</div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-700">{current.taskType === 'text-to-image' ? '文生图调用 /images/generations，并提交质量与尺寸。' : '图片编辑调用 /images/edits，通过 image[] 上传参考图片。'} API Key 仅由 Electron 主进程读取。</div>
        </div> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">点击左侧添加一个模型</div>}
        <div className="flex h-16 items-center justify-end gap-2 border-t px-6"><Button variant="outline" onClick={onClose}>取消</Button><Button onClick={() => onSave(drafts)}>保存配置</Button></div>
      </main>
    </div>
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div> }
