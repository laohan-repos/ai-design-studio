import { useEffect, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, ImageIcon, LoaderCircle, PlugZap, WandSparkles, X, XCircle } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { createModelConfig, imageEndpoint, modelPresets, normalizeModelConfig, openaiImageModels, proxyRules } from '@/lib/models'
import type { ModelConfig, ModelTestResult } from '@/types'

type Props = { open: boolean; models: ModelConfig[]; onClose(): void; onSave(models: ModelConfig[]): Promise<void> }
const normalize = (models: ModelConfig[]) => (['text-to-image', 'image-to-image'] as const).map(taskType => {
  const saved = models.find(model => model.taskType === taskType)
  return saved ? normalizeModelConfig(saved) : createModelConfig(taskType)
})

export function ModelDialog({ open, models, onClose, onSave }: Props) {
  const [drafts, setDrafts] = useState<ModelConfig[]>([])
  const [selected, setSelected] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [testResult, setTestResult] = useState<ModelTestResult>()
  useEffect(() => { if (open) { const next = normalize(structuredClone(models)); setDrafts(next); setSelected(next[0].id); setShowKey(false); setTestResult(undefined); setSaveError(undefined) } }, [open, models])
  if (!open) return null
  const current = drafts.find(x => x.id === selected) || drafts[0]
  const update = (patch: Partial<ModelConfig>) => { setTestResult(undefined); setSaveError(undefined); setDrafts(list => list.map(x => x.id === current.id ? { ...x, ...patch } : x)) }
  const changeProvider = (provider: ModelConfig['provider']) => {
    if (provider === current.provider) return
    if (provider === 'compatible') { update({ provider }); return }
    const preset = modelPresets[provider]
    update({ provider, baseUrl: imageEndpoint(preset.baseUrl, current.taskType), model: preset.model, apiKey: '' })
  }
  const save = async () => {
    if (saving) return
    if (drafts.some(model => !model.name.trim() || !model.baseUrl.trim() || !model.model.trim())) {
      setSaveError('请填写两种模型的显示名称、API 地址和模型 ID')
      return
    }
    try { drafts.forEach(model => { if (model.provider === 'openai' && model.proxyEnabled) proxyRules(model.proxyUrl || '') }) }
    catch (error) { setSaveError(error instanceof Error ? error.message : '代理配置无效'); return }
    setSaving(true); setSaveError(undefined)
    try { await onSave(drafts.map(normalizeModelConfig)) }
    catch (error) { setSaveError(error instanceof Error ? error.message : '模型配置保存失败，请重试') }
    finally { setSaving(false) }
  }
  const testConnection = async () => {
    if (!current) return
    setTesting(true); setTestResult(undefined)
    try { setTestResult(await window.studio.testModel(current)) }
    catch (error) { setTestResult({ ok: false, modelFound: false, message: error instanceof Error ? error.message : '测试失败' }) }
    finally { setTesting(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-600/30 p-3 backdrop-blur-sm sm:p-6" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose() }}>
    <div role="dialog" aria-modal="true" aria-labelledby="model-dialog-title" className="flex h-[600px] max-h-full w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl md:flex-row">
      <aside className="shrink-0 border-b bg-slate-50 p-3 md:w-64 md:border-b-0 md:border-r md:p-4">
        <div className="mb-2 flex items-center justify-between md:mb-4">
          <div><h2 id="model-dialog-title" className="font-semibold">模型配置</h2><p className="mt-1 hidden text-xs text-muted-foreground md:block">管理图像生成服务</p></div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={saving} aria-label="关闭模型配置" className="md:hidden"><X className="h-4 w-4" /></Button>
        </div>
        <div className="grid grid-cols-2 gap-2">{drafts.map(model => <button key={model.id} disabled={saving || testing} aria-pressed={model.id === current?.id} onClick={() => { setSelected(model.id); setTestResult(undefined); setShowKey(false) }} className={`flex h-10 items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm font-medium transition md:h-24 md:flex-col ${model.id === current?.id ? 'border-violet-500 bg-violet-50 text-violet-700 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300'}`}>{model.taskType === 'text-to-image' ? <WandSparkles className="h-4 w-4 md:h-6 md:w-6" /> : <ImageIcon className="h-4 w-4 md:h-6 md:w-6" />}<span>{model.taskType === 'text-to-image' ? '文生图' : '图生图'}</span></button>)}</div>
        {current && <div className="mt-4 hidden rounded-2xl bg-violet-100/70 p-4 md:block"><div className="flex items-center justify-between"><div className="font-semibold text-violet-800">{current.name}</div><span className="rounded-full bg-white/80 px-2 py-1 text-[10px] font-medium text-violet-700">{current.taskType === 'text-to-image' ? '文生图' : '图生图'}</span></div><div className="mt-2 truncate text-sm text-violet-500">{current.model}</div></div>}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="hidden h-16 shrink-0 items-center justify-between border-b px-6 md:flex"><div className="font-medium">连接设置</div><Button variant="ghost" size="icon" onClick={onClose} disabled={saving} aria-label="关闭模型配置"><X className="h-4 w-4" /></Button></div>
        {current ? <fieldset disabled={saving || testing} className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 md:space-y-5 md:p-6">
          <Field label="显示名称" htmlFor="model-name"><Input id="model-name" value={current.name} onChange={e => update({ name: e.target.value })} placeholder="如：OpenAI Image" /></Field>
          <Field label="服务类型" htmlFor="model-provider"><select id="model-provider" value={current.provider} onChange={e => changeProvider(e.target.value as ModelConfig['provider'])} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="openai">OpenAI 官方</option><option value="constreet">Constreet GPT-Image-2</option><option value="compatible">自定义 OpenAI Images 兼容接口</option></select></Field>
          <Field label="API 完整地址" htmlFor="model-base-url"><Input id="model-base-url" value={current.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1/images/generations" readOnly={current.provider === 'openai'} className={current.provider === 'openai' ? 'bg-slate-50 text-slate-500' : ''} /></Field>
          {current.provider === 'openai' && <div className="space-y-3 rounded-xl border bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3"><div><Label htmlFor="model-proxy-enabled">使用代理</Label><p className="mt-1 text-xs leading-5 text-muted-foreground">连接测试、图片生成和图片下载均使用此代理。</p></div><input id="model-proxy-enabled" type="checkbox" checked={Boolean(current.proxyEnabled)} onChange={e => update({ proxyEnabled: e.target.checked })} className="h-4 w-4 shrink-0 accent-violet-600" /></div>
            {current.proxyEnabled ? <Field label="代理地址" htmlFor="model-proxy-url"><Input id="model-proxy-url" value={current.proxyUrl || ''} onChange={e => update({ proxyUrl: e.target.value })} placeholder="http://127.0.0.1:7890" spellCheck={false} /><p className="text-xs leading-5 text-muted-foreground">支持 HTTP、HTTPS、SOCKS5，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。</p></Field> : <p className="text-xs leading-5 text-muted-foreground">当前直连 OpenAI。文生图和图生图可分别配置代理。</p>}
          </div>}
          <Field label="API Key" htmlFor="model-api-key"><div className="relative"><Input id="model-api-key" type={showKey ? 'text' : 'password'} value={current.apiKey} onChange={e => update({ apiKey: e.target.value })} placeholder={current.provider === 'openai' ? '填写 OpenAI API Key' : '填写当前服务的 API Key'} className="pr-10" /><button className="absolute right-3 top-2.5 text-muted-foreground" onClick={() => setShowKey(v => !v)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></Field>
          <Field label="模型 ID" htmlFor="model-id"><Input id="model-id" value={current.model} onChange={e => update({ model: e.target.value })} placeholder={current.provider === 'openai' ? modelPresets.openai.model : 'gpt-image-2'} list={current.provider === 'openai' ? 'openai-image-models' : undefined} readOnly={current.provider === 'constreet'} className={current.provider === 'constreet' ? 'bg-slate-50 text-slate-500' : ''} />{current.provider === 'openai' && <><datalist id="openai-image-models">{openaiImageModels.map(model => <option key={model} value={model} />)}</datalist><p className="text-xs leading-5 text-muted-foreground">可选择建议模型，也可填写你的 OpenAI 账户已开通的图片模型 ID。</p></>}</Field>
          <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" onClick={testConnection} disabled={saving || testing || !current.baseUrl.trim() || !current.apiKey.trim() || !current.model.trim()}>{testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}{testing ? '正在测试…' : '测试连接'}</Button>{testResult && <div role="status" className={`flex min-w-0 items-center gap-1.5 text-xs max-sm:w-full ${testResult.ok ? (testResult.modelFound ? 'text-emerald-600' : 'text-amber-600') : 'text-red-600'}`}>{testResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}<span className="break-words">{testResult.message}{testResult.latencyMs ? ` · ${testResult.latencyMs}ms` : ''}</span></div>}</div>
          {testResult?.proxySuggestion && <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-slate-50 p-3 text-xs text-slate-600">
            <span className="break-all">本机环境的代理地址 {testResult.proxySuggestion}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => update({ proxyEnabled: true, proxyUrl: testResult.proxySuggestion })}>填入代理地址</Button>
          </div>}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-700">{current.provider === 'openai' ? '使用 OpenAI 官方图片服务，文生图和图生图可分别配置模型。' : '使用所选服务提供的图片模型和 API Key。'} API Key 保存在本机，仅发送给所选服务。</div>
        </fieldset> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">正在读取模型配置…</div>}
        {saveError && <div role="alert" className="px-6 pb-3 text-xs text-red-600">{saveError}</div>}
        <div className="flex min-h-14 shrink-0 items-center justify-end gap-2 border-t px-4 md:h-16 md:px-6"><Button variant="outline" onClick={onClose} disabled={saving}>取消</Button><Button onClick={save} disabled={saving || testing}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />}{saving ? '正在保存…' : '保存配置'}</Button></div>
      </main>
    </div>
  </div>
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) { return <div className="space-y-2"><Label htmlFor={htmlFor}>{label}</Label>{children}</div> }
