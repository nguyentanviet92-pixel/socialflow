/**
 * /hermes/settings — 5 sections for configuring Hermes
 *   1. Model & Provider — switch provider/model, test API key
 *   2. Skills — list + edit + create + delete
 *   3. Quality Gate — threshold, max retry
 *   4. Fallback chain — drag-reorder, timeout
 *   5. Memory & Learning — toggles, nuclear deletes
 *
 * All saves: optimistic + toast (VN language).
 */
import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Trash2, GripVertical, AlertTriangle, Check, Loader } from 'lucide-react'
import api from '../../lib/api'
import SkillsEditor from './SkillsEditor'

const asArray = (d) => Array.isArray(d) ? d
  : Array.isArray(d?.items) ? d.items
  : Array.isArray(d?.data) ? d.data
  : []

// ───────────────────────────────────────────────────────────
// SECTION 1: Model & Provider
// ───────────────────────────────────────────────────────────
function ModelSection() {
  const qc = useQueryClient()
  const { data: cfgData, isLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })

  const providers = cfgData?.providers || {}
  const cfg = cfgData?.config || {}
  const [form, setForm] = useState({
    provider: 'deepseek', model: '', api_key: '', base_url: '',
    max_tokens: 500, temperature: 0.7,
  })
  const [testing, setTesting] = useState(null) // null | 'pending' | result object

  useEffect(() => {
    if (cfg && !isLoading) {
      setForm(f => ({
        provider: cfg.provider || 'deepseek',
        model: cfg.model || '',
        api_key: '', // always blank; user enters new or leaves empty
        base_url: cfg.base_url || '',
        max_tokens: cfg.max_tokens ?? 500,
        temperature: cfg.temperature ?? 0.7,
      }))
    }
  }, [cfgData])

  const modelOptions = providers[form.provider]?.models || []
  // Auto-set base_url when provider changes. Model: keep user-typed value if it
  // looks custom (contains /), otherwise default to first preset.
  useEffect(() => {
    if (providers[form.provider]) {
      setForm(f => {
        const keepModel = f.model && (f.model.includes('/') || modelOptions.includes(f.model))
        return {
          ...f,
          base_url: providers[f.provider].base_url,
          model: keepModel ? f.model : modelOptions[0] || '',
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.provider, providers])

  // Reject obvious garbage as api_key — prevents the past bug where the test
  // error toast string got pasted in and corrupted hermes_config.
  const looksLikeApiKey = (k) => {
    if (!k || typeof k !== 'string') return false
    const trimmed = k.trim()
    if (trimmed.length < 10 || trimmed.length > 200) return false
    if (/\s/.test(trimmed)) return false                          // no whitespace
    if (/[^\x20-\x7e]/.test(trimmed)) return false                // ASCII printable only
    if (/error|failed|invalid|thất bại/i.test(trimmed)) return false  // looks like an error msg
    if (/[{}[\]:,]/.test(trimmed)) return false                   // looks like JSON / object
    return true
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        provider: form.provider,
        model: form.model,
        base_url: form.base_url,
        max_tokens: parseInt(form.max_tokens),
        temperature: parseFloat(form.temperature),
      }
      if (form.api_key && form.api_key.trim().length > 0) {
        if (!looksLikeApiKey(form.api_key)) {
          throw new Error('API key không hợp lệ — chứa ký tự lạ hoặc trông giống error message. Test trước rồi mới Lưu.')
        }
        payload.api_key = form.api_key.trim()
      }
      await api.put('/ai-hermes/config', payload)
    },
    onSuccess: () => {
      toast.success('Đã lưu cài đặt model')
      setForm(f => ({ ...f, api_key: '' }))   // clear field after save (key now stored on server)
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const testConnection = async () => {
    if (!form.api_key) {
      toast.error('Nhập API key để test')
      return
    }
    setTesting('pending')
    try {
      const res = await api.post('/ai-hermes/config/test', {
        provider: form.provider,
        model: form.model,
        api_key: form.api_key,
        base_url: form.base_url,
      })
      setTesting(res.data)
      if (res.data.ok) {
        toast.success(`Kết nối OK (${res.data.latency_ms}ms)`)
      } else {
        toast.error(`Test thất bại: ${res.data.error}`)
      }
    } catch (err) {
      setTesting({ ok: false, error: err.message })
      toast.error(`Test lỗi: ${err.message}`)
    }
  }

  // Quick-switch presets — 1 click to swap provider+model without typing
  const quickSwitch = (provider, model) => {
    const baseUrl = providers[provider]?.base_url || ''
    setForm(f => ({ ...f, provider, model, base_url: baseUrl, api_key: '' }))
    toast.success(`Đã đổi sang ${provider} / ${model} — nhập API key rồi Test + Lưu`)
  }

  const QUICK_PRESETS = [
    { p: 'deepseek', m: 'deepseek-chat',           label: 'DeepSeek V3',         color: 'text-info' },
    { p: 'deepseek', m: 'deepseek-v4-pro',         label: 'DeepSeek V4 Pro',     color: 'text-info' },
    { p: 'kimi',     m: 'kimi-k2.6',               label: 'Kimi K2.6',           color: 'text-cyan-500' },
    { p: 'openai',   m: 'gpt-4o-mini',             label: 'GPT-4o-mini',         color: 'text-emerald-600' },
    { p: 'gemini',   m: 'gemini-2.0-flash',        label: 'Gemini 2.0 Flash',    color: 'text-purple-500' },
    { p: 'groq',     m: 'llama-3.3-70b-versatile', label: 'Groq Llama 3.3',      color: 'text-red-500' },
  ]

  if (isLoading) return <div className="p-6 text-app-muted font-mono-ui">Đang tải cấu hình...</div>

  return (
    <div className="p-6 font-mono-ui max-w-2xl">
      <h2 className="text-app-primary text-base mb-1">1. Model & Provider</h2>
      <p className="text-app-muted text-xs mb-4">Chọn nhà cung cấp LLM và thông số cho Hermes.</p>

      {/* Quick-switch */}
      <div className="mb-6 p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
        <div className="text-[10px] uppercase text-app-muted mb-2">Đổi nhanh provider/model</div>
        <div className="flex flex-wrap gap-2">
          {QUICK_PRESETS.map(({ p, m, label, color }) => {
            const active = form.provider === p && form.model === m
            return (
              <button
                key={`${p}/${m}`}
                onClick={() => quickSwitch(p, m)}
                className={`text-xs px-3 py-1.5 ${active ? 'text-hermes' : color + ' hover:opacity-80'}`}
                style={{
                  background: active ? 'var(--hermes-dim)' : 'var(--bg-base)',
                  border: '1px solid ' + (active ? 'var(--hermes-fade)' : 'var(--border)'),
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div className="text-[10px] text-app-dim mt-2">
          Click 1 preset → fill provider+model+base_url → nhập API key của provider đó → Test → Lưu
        </div>
      </div>

      <div className="space-y-4">
        {/* Provider */}
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">Provider</label>
          <select
            value={form.provider}
            onChange={(e) => setForm(f => ({ ...f, provider: e.target.value }))}
            className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
            style={{ border: '1px solid var(--border-bright)' }}
          >
            {Object.keys(providers).map(p => (
              <option key={p} value={p}>{providers[p].label || p}</option>
            ))}
          </select>
          <div className="text-[10px] text-app-muted mt-1 font-mono-ui">
            {providers[form.provider]?.base_url}
          </div>
        </div>

        {/* Model — datalist cho gợi ý + type tuỳ ý */}
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">
            Model <span className="text-app-dim">(chọn preset hoặc gõ model ID bất kỳ)</span>
          </label>
          <input
            type="text"
            list="model-options"
            value={form.model}
            onChange={(e) => setForm(f => ({ ...f, model: e.target.value }))}
            placeholder="vd: nousresearch/hermes-3-llama-3.1-70b"
            className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm font-mono-ui"
            style={{ border: '1px solid var(--border-bright)' }}
          />
          <datalist id="model-options">
            {modelOptions.map(m => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {modelOptions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {modelOptions.slice(0, 6).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, model: m }))}
                  className={`text-[10px] px-2 py-0.5 font-mono-ui ${
                    form.model === m ? 'text-hermes' : 'text-app-muted hover:text-app-primary'
                  }`}
                  style={{
                    background: form.model === m ? 'var(--hermes-dim)' : 'var(--bg-elevated)',
                    border: '1px solid ' + (form.model === m ? 'var(--hermes-fade)' : 'var(--border)'),
                  }}
                >
                  {m}
                </button>
              ))}
              {modelOptions.length > 6 && (
                <span className="text-[10px] text-app-dim self-center ml-1">
                  +{modelOptions.length - 6} khác (gõ tên)
                </span>
              )}
            </div>
          )}
        </div>

        {/* API Key */}
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">
            API Key {cfgData?.api_key_set && <span className="text-hermes">(đã set)</span>}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={form.api_key}
              onChange={(e) => setForm(f => ({ ...f, api_key: e.target.value }))}
              placeholder={cfgData?.api_key_set ? 'Để trống nếu không đổi' : 'sk-...'}
              className="flex-1 px-3 py-2 bg-app-elevated text-app-primary text-sm"
              style={{ border: '1px solid var(--border-bright)' }}
            />
            <button
              onClick={testConnection}
              disabled={testing === 'pending' || !form.api_key}
              className="btn-ghost whitespace-nowrap"
            >
              {testing === 'pending' ? <Loader size={12} className="animate-spin" /> : 'Test kết nối'}
            </button>
          </div>
          {testing && testing !== 'pending' && (
            <div className={`mt-2 text-xs ${testing.ok ? 'text-hermes' : 'text-danger'}`}>
              {testing.ok
                ? `✓ OK (${testing.latency_ms}ms) · "${testing.response_preview}"`
                : `✗ ${testing.error}`}
            </div>
          )}
        </div>

        {/* Base URL */}
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">Base URL</label>
          <input
            type="text"
            value={form.base_url}
            onChange={(e) => setForm(f => ({ ...f, base_url: e.target.value }))}
            className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
            style={{ border: '1px solid var(--border-bright)' }}
          />
        </div>

        {/* Max tokens + Temperature */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] uppercase text-app-muted mb-1">Max tokens</label>
            <input
              type="number"
              min={50}
              max={8000}
              value={form.max_tokens}
              onChange={(e) => setForm(f => ({ ...f, max_tokens: parseInt(e.target.value) || 500 }))}
              className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
              style={{ border: '1px solid var(--border-bright)' }}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase text-app-muted mb-1">
              Temperature: <span className="text-hermes">{form.temperature.toFixed(2)}</span>
            </label>
            <input
              type="range" min={0} max={2} step={0.05}
              value={form.temperature}
              onChange={(e) => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
              className="w-full"
            />
          </div>
        </div>

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="btn-hermes"
        >
          {save.isPending ? 'Đang lưu...' : 'Lưu'}
        </button>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: ChatGPT / OAuth — instruction and credentials for custom GPT actions
// ───────────────────────────────────────────────────────────
function OauthSection() {
  const domain = window.location.origin
  const [apiKey, setApiKey] = useState('')
  const [loadingKey, setLoadingKey] = useState(false)
  const [gptLink, setGptLink] = useState(localStorage.getItem('socialflow_gpt_link') || '')
  const [editingGptLink, setEditingGptLink] = useState(false)

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text)
    toast.success(`Đã sao chép ${label}`)
  }

  const handleSaveGptLink = () => {
    localStorage.setItem('socialflow_gpt_link', gptLink)
    setEditingGptLink(false)
    toast.success('Đã lưu link Custom GPT thành công!')
  }

  const handleGenerateApiKey = async () => {
    try {
      setLoadingKey(true)
      const res = await api.get('/auth/apikey')
      setApiKey(res.data.apikey)
      toast.success('Đã tạo API Key dài hạn!')
    } catch (err) {
      toast.error('Không thể tạo API Key: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoadingKey(false)
    }
  }

  return (
    <div className="p-6 font-mono-ui max-w-2xl space-y-8">
      {/* 🚀 QUICK ACCESS CONNECT BUTTON */}
      {gptLink && (
        <div className="p-1 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 shadow-xl">
          <a
            href={gptLink}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-4 px-6 rounded-lg text-sm font-semibold text-black flex items-center justify-center gap-3 transition-all hover:opacity-90 text-center"
            style={{
              background: 'linear-gradient(135deg, #06b6d4 0%, #10b981 100%)',
              color: '#000',
              textDecoration: 'none',
              fontWeight: 'bold',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            <span className="text-xl animate-bounce">🚀</span>
            <span>MỞ TRÌNH DUYỆT - KẾT NỐI & ỦY QUYỀN CHATGPT NGAY</span>
          </a>
        </div>
      )}

      {/* GPT LINK SETTINGS */}
      <div className="p-4 rounded-lg bg-app-elevated border border-app-border space-y-3">
        <div className="text-xs font-semibold text-app-primary flex items-center justify-between">
          <span className="flex items-center gap-2">🔗 Link Custom GPT của hệ thống:</span>
          {editingGptLink ? (
            <button onClick={handleSaveGptLink} className="text-[10px] text-hermes hover:underline">Lưu lại</button>
          ) : (
            <button onClick={() => setEditingGptLink(true)} className="text-[10px] text-hermes hover:underline">Sửa link</button>
          )}
        </div>
        {editingGptLink ? (
          <input
            type="text"
            placeholder="https://chatgpt.com/g/g-xxxxx-space-computer"
            value={gptLink}
            onChange={(e) => setGptLink(e.target.value)}
            className="w-full px-3 py-2 bg-black text-app-primary text-xs border border-app-border rounded outline-none focus:border-hermes"
          />
        ) : (
          <div className="text-xs text-app-muted truncate">
            {gptLink || <span className="italic text-app-muted/50">Chưa cấu hình link Custom GPT (Admin hãy dán link Custom GPT của bạn sau khi tạo xong vào đây để hiển thị nút kết nối 1-click cho người dùng)</span>}
          </div>
        )}
      </div>

      <hr className="border-app-border" />

      {/* METHOD 1: OAUTH */}
      <div>
        <h2 className="text-app-primary text-base mb-1">Phương thức 1: Kết nối bằng OAuth 2.0 (Tiêu chuẩn)</h2>
        <p className="text-app-muted text-xs mb-6">
          Đăng nhập ủy quyền trực tiếp thông qua luồng đăng nhập của Space Computer.
        </p>

        <div className="space-y-6">
          {/* Connection status */}
          <div className="p-4 rounded-lg flex items-center justify-between" style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}>
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚡</span>
              <div>
                <div className="text-sm font-semibold text-hermes">OAuth 2.0 Status: ACTIVE</div>
                <div className="text-[10px] text-app-muted">Sẵn sàng nhận kết nối từ OpenAI / Custom GPTs</div>
              </div>
            </div>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-950/30 text-emerald-400 border border-emerald-500/20">
              ● Đang chạy
            </span>
          </div>

          {/* Credentials table */}
          <div className="space-y-4">
            <div className="text-app-primary text-sm font-semibold mb-2">Thông số cấu hình trên ChatGPT Action</div>
            
            <div className="space-y-3">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-app-muted">Client ID</label>
                  <button onClick={() => copyToClipboard('socialflow', 'Client ID')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value="socialflow"
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-app-muted">Client Secret</label>
                  <button onClick={() => copyToClipboard('socialflow-secret', 'Client Secret')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value="socialflow-secret"
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-app-muted">Authorization URL</label>
                  <button onClick={() => copyToClipboard(`${domain}/oauth/authorize`, 'Authorization URL')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={`${domain}/oauth/authorize`}
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-app-muted">Token URL</label>
                  <button onClick={() => copyToClipboard(`${domain}/oauth/token`, 'Token URL')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={`${domain}/oauth/token`}
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-hermes font-bold">Đường dẫn tự động Import OpenAPI Schema (CỰC NHANH)</label>
                  <button onClick={() => copyToClipboard(`${domain}/oauth/openapi.json`, 'Schema Import URL')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={`${domain}/oauth/openapi.json`}
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui border border-cyan-500/30"
                />
              </div>
            </div>
          </div>

          {/* Step-by-step instruction */}
          <div className="p-4 bg-app-elevated rounded border border-app-border space-y-2">
            <div className="text-xs font-semibold text-app-primary">📖 Hướng dẫn cấu hình Custom GPT:</div>
            <ol className="list-decimal list-inside text-[11px] text-app-muted space-y-1 leading-relaxed">
              <li>Truy cập mục <strong>My GPTs</strong> &rarr; <strong>Create a GPT</strong> &rarr; chọn tab <strong>Configure</strong> &rarr; cuộn xuống dưới chọn <strong>Create new Action</strong>.</li>
              <li>Tại phần <strong>Authentication</strong>, chọn <strong>OAuth</strong> và điền các thông số Client ID, Client Secret, Auth URL, Token URL tương ứng ở trên.</li>
              <li>Tại ô <strong>Schema</strong> bên dưới, bấm nút <strong>Import from URL</strong> (Import từ URL), dán đường dẫn màu xanh tự động Import OpenAPI Schema vừa copy ở trên và nhấn <strong>Import</strong>. Toàn bộ API sẽ tự động được khai báo ngay lập tức!</li>
              <li>Tại mục <strong>Authentication Type</strong>, chọn <strong>Basic</strong> (hoặc <strong>Post</strong>).</li>
              <li>Bấm <strong>Save</strong> để hoàn tất. Dán link Custom GPT của bạn vào ô "Link Custom GPT của hệ thống" ở đầu trang này để kích hoạt nút kết nối nhanh cho người dùng của bạn trên trình duyệt!</li>
            </ol>
          </div>
        </div>
      </div>

      <hr className="border-app-border" />

      {/* METHOD 2: API KEY (NO-OAUTH) */}
      <div>
        <h2 className="text-app-primary text-base mb-1">Phương thức 2: Kết nối bằng API Key (Giải pháp không cần OAuth - KHUYÊN DÙNG)</h2>
        <p className="text-app-muted text-xs mb-6">
          Kết nối nhanh chóng bằng cách nhúng trực tiếp API Key dài hạn vào ChatGPT mà không cần qua màn hình đăng nhập.
        </p>

        <div className="space-y-6">
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-xs text-app-primary font-semibold">Tạo API Token Dài Hạn (Hạn 10 năm)</label>
              {apiKey && (
                <button
                  onClick={() => copyToClipboard(apiKey, 'API Key')}
                  className="text-[10px] text-hermes hover:underline font-mono-ui"
                >
                  Sao chép API Key
                </button>
              )}
            </div>

            {apiKey ? (
              <textarea
                readOnly
                rows={4}
                value={apiKey}
                className="w-full px-3 py-2 bg-app-elevated text-app-primary text-[10px] font-mono-ui break-all leading-relaxed"
                style={{ border: '1px solid var(--hermes)', borderRadius: '6px' }}
              />
            ) : (
              <button
                onClick={handleGenerateApiKey}
                disabled={loadingKey}
                className="w-full py-3 px-4 rounded text-xs font-semibold bg-hermes hover:opacity-90 text-black flex items-center justify-center gap-2 transition-all"
              >
                {loadingKey ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Đang tạo API Key...
                  </>
                ) : (
                  'TẠO API KEY DÀI HẠN MỚI'
                )}
              </button>
            )}
          </div>

          {/* Step-by-step instruction */}
          <div className="p-4 bg-app-elevated rounded border border-app-border space-y-2">
            <div className="text-xs font-semibold text-app-primary">📖 Hướng dẫn kết nối bằng API Key:</div>
            <ol className="list-decimal list-inside text-[11px] text-app-muted space-y-1 leading-relaxed">
              <li>Nhấp nút <strong>TẠO API KEY DÀI HẠN MỚI</strong> ở trên và sao chép đoạn mã Token được tạo ra.</li>
              <li>Truy cập cấu hình Custom GPT của bạn &rarr; chọn <strong>Configure</strong> &rarr; chọn <strong>Create new Action</strong>.</li>
              <li>Tại phần <strong>Authentication</strong>, chọn <strong>API Key</strong>.</li>
              <li>Tại mục <strong>Auth Type</strong>, hãy chọn <strong>Bearer</strong>.</li>
              <li>Dán đoạn mã API Key đã sao chép ở trên vào ô mật khẩu/token và nhấn <strong>Save</strong>.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}


// ───────────────────────────────────────────────────────────
// SECTION 2: Skills (reuse SkillsEditor + Create + Delete)
// ───────────────────────────────────────────────────────────
function SkillsSection() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [newSkill, setNewSkill] = useState({ task_type: '', content: '' })

  const create = useMutation({
    mutationFn: async () => {
      await api.post('/ai-hermes/skills', newSkill)
    },
    onSuccess: () => {
      toast.success(`Đã tạo skill ${newSkill.task_type}`)
      setCreateOpen(false)
      setNewSkill({ task_type: '', content: '' })
      qc.invalidateQueries({ queryKey: ['hermes', 'skills'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div>
          <h2 className="text-app-primary text-base">2. Skills</h2>
          <p className="text-app-muted text-xs mt-0.5 font-mono-ui">Chỉnh sửa prompt của từng skill. Lưu = hot-reload không restart.</p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn-hermes flex items-center gap-1">
          <Plus size={12} /> TẠO SKILL MỚI
        </button>
      </div>

      <SkillsEditor />

      {/* Create modal */}
      {createOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setCreateOpen(false)}
        >
          <div
            className="bg-app-surface p-6 font-mono-ui w-full max-w-2xl"
            style={{ border: '1px solid var(--border-bright)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-app-primary text-base mb-4">Tạo skill mới</h3>
            <div className="space-y-3 text-sm">
              <div>
                <label className="block text-[10px] uppercase text-app-muted mb-1">
                  Task type (snake_case, 3-40 chars)
                </label>
                <input
                  type="text"
                  value={newSkill.task_type}
                  onChange={(e) => setNewSkill(s => ({ ...s, task_type: e.target.value.toLowerCase() }))}
                  placeholder="e.g. product_answer"
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-app-muted mb-1">Prompt content</label>
                <textarea
                  rows={12}
                  value={newSkill.content}
                  onChange={(e) => setNewSkill(s => ({ ...s, content: e.target.value }))}
                  placeholder="You are..."
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary resize-none"
                  style={{ border: '1px solid var(--border-bright)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setCreateOpen(false)} className="btn-ghost">Hủy</button>
                <button
                  onClick={() => create.mutate()}
                  disabled={!newSkill.task_type || newSkill.content.length < 10 || create.isPending}
                  className="btn-hermes"
                >
                  {create.isPending ? 'Đang tạo...' : 'Tạo'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION 3: Quality Gate
// ───────────────────────────────────────────────────────────
function QualityGateSection() {
  const qc = useQueryClient()
  const { data: cfgData } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })
  const cfg = cfgData?.config || {}
  const [threshold, setThreshold] = useState(6)
  const [maxRetry, setMaxRetry] = useState(2)

  useEffect(() => {
    if (cfg.quality_gate_threshold !== undefined) setThreshold(cfg.quality_gate_threshold)
    if (cfg.quality_gate_max_retry !== undefined) setMaxRetry(cfg.quality_gate_max_retry)
  }, [cfgData])

  const save = useMutation({
    mutationFn: async () => {
      await api.put('/ai-hermes/config', {
        quality_gate_threshold: threshold,
        quality_gate_max_retry: maxRetry,
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu Quality Gate')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  return (
    <div className="p-6 font-mono-ui max-w-2xl">
      <h2 className="text-app-primary text-base mb-1">3. Quality Gate</h2>
      <p className="text-app-muted text-xs mb-6">Ngưỡng chất lượng để chấp nhận comment. Thấp hơn = dễ pass, cao hơn = chặt.</p>

      <div className="space-y-4">
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">
            Điểm tối thiểu: <span className="text-hermes">{threshold}</span>/10
          </label>
          <input
            type="range" min={1} max={10} step={1}
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value))}
            className="w-full"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">Max retry khi reject</label>
          <input
            type="number" min={0} max={5}
            value={maxRetry}
            onChange={(e) => setMaxRetry(parseInt(e.target.value) || 0)}
            className="w-24 px-3 py-2 bg-app-elevated text-app-primary text-sm"
            style={{ border: '1px solid var(--border-bright)' }}
          />
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-hermes">
          {save.isPending ? 'Đang lưu...' : 'Lưu'}
        </button>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION 4: Fallback chain
// ───────────────────────────────────────────────────────────
function FallbackSection() {
  const qc = useQueryClient()
  const { data: cfgData } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })
  const cfg = cfgData?.config || {}
  const [chain, setChain] = useState(['nvidia', 'deepseek', 'kimi'])
  const [timeoutMs, setTimeoutMs] = useState(3000)
  const [dragIdx, setDragIdx] = useState(null)

  useEffect(() => {
    if (Array.isArray(cfg.fallback_chain)) setChain(cfg.fallback_chain)
    if (cfg.fallback_timeout_ms !== undefined) setTimeoutMs(cfg.fallback_timeout_ms)
  }, [cfgData])

  const save = useMutation({
    mutationFn: async () => {
      await api.put('/ai-hermes/config', {
        fallback_chain: chain,
        fallback_timeout_ms: timeoutMs,
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu fallback chain')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const reorder = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return
    const arr = [...chain]
    const [item] = arr.splice(fromIdx, 1)
    arr.splice(toIdx, 0, item)
    setChain(arr)
  }

  return (
    <div className="p-6 font-mono-ui max-w-2xl">
      <h2 className="text-app-primary text-base mb-1">4. Fallback chain</h2>
      <p className="text-app-muted text-xs mb-6">Nếu provider đầu fail, thử tiếp theo thứ tự. Kéo thả để sắp xếp.</p>

      <div className="space-y-2 mb-4">
        {chain.map((name, i) => (
          <div
            key={name}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx !== null) reorder(dragIdx, i)
              setDragIdx(null)
            }}
            className="flex items-center gap-3 px-3 py-2 bg-app-elevated cursor-move"
            style={{ border: '1px solid var(--border-bright)' }}
          >
            <GripVertical size={14} className="text-app-muted" />
            <span className="text-app-muted text-[10px] w-4">{i + 1}.</span>
            <span className="flex-1 text-app-primary">{name}</span>
            {i === 0 && <span className="text-[10px] text-hermes">PRIMARY</span>}
          </div>
        ))}
      </div>

      <div className="mb-4">
        <label className="block text-[10px] uppercase text-app-muted mb-1">
          Timeout (ms) trước khi chuyển sang fallback
        </label>
        <input
          type="number" min={500} max={30000}
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(parseInt(e.target.value) || 3000)}
          className="w-32 px-3 py-2 bg-app-elevated text-app-primary text-sm"
          style={{ border: '1px solid var(--border-bright)' }}
        />
      </div>

      <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-hermes">
        {save.isPending ? 'Đang lưu...' : 'Lưu'}
      </button>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION 5: Memory & Learning
// ───────────────────────────────────────────────────────────
function MemorySection() {
  const qc = useQueryClient()
  const { data: cfgData } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })
  const cfg = cfgData?.config || {}
  const [fewshot, setFewshot] = useState(true)
  const [memory, setMemory] = useState(true)
  const [minScore, setMinScore] = useState(4)
  const [confirmText, setConfirmText] = useState('')
  const [nickId, setNickId] = useState('')

  useEffect(() => {
    if (cfg.fewshot_enabled !== undefined) setFewshot(cfg.fewshot_enabled)
    if (cfg.memory_enabled !== undefined) setMemory(cfg.memory_enabled)
    if (cfg.fewshot_min_score !== undefined) setMinScore(cfg.fewshot_min_score)
  }, [cfgData])

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => asArray((await api.get('/accounts')).data),
  })

  const save = useMutation({
    mutationFn: async () => {
      await api.put('/ai-hermes/config', {
        fewshot_enabled: fewshot,
        memory_enabled: memory,
        fewshot_min_score: minScore,
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu cài đặt học')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const deleteAllFeedback = useMutation({
    mutationFn: async () => {
      await api.delete('/ai-hermes/feedback?confirm=XOAHET')
    },
    onSuccess: (res) => {
      toast.success(`Đã xoá ${res?.data?.deleted_rows || 0} feedback`)
      setConfirmText('')
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const deleteNickMemory = useMutation({
    mutationFn: async () => {
      await api.delete(`/ai-hermes/memory?account_id=${encodeURIComponent(nickId)}`)
    },
    onSuccess: (res) => {
      toast.success(`Đã xoá ${res?.data?.deleted_rows || 0} memory cho nick`)
      setNickId('')
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  return (
    <div className="p-6 font-mono-ui max-w-2xl">
      <h2 className="text-app-primary text-base mb-1">5. Memory & Learning</h2>
      <p className="text-app-muted text-xs mb-6">Bật/tắt các cơ chế học của Hermes, xoá dữ liệu đã tích luỹ.</p>

      <div className="space-y-4 mb-8">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={fewshot}
            onChange={(e) => setFewshot(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-app-primary">Bật few-shot injection (top-3 past high-score vào prompt)</span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={memory}
            onChange={(e) => setMemory(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-app-primary">Bật per-nick memory (inject từ ai_pilot_memory)</span>
        </div>
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">
            Min score để lưu example: <span className="text-hermes">{minScore}</span>/5
          </label>
          <input
            type="range" min={1} max={5}
            value={minScore}
            onChange={(e) => setMinScore(parseInt(e.target.value))}
            className="w-full max-w-xs"
          />
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-hermes">
          {save.isPending ? 'Đang lưu...' : 'Lưu'}
        </button>
      </div>

      {/* Danger zone */}
      <div className="p-4 mt-6" style={{ border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.06)' }}>
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={14} className="text-danger" />
          <span className="text-danger text-sm uppercase tracking-wider">Danger zone</span>
        </div>

        {/* Xoá feedback store */}
        <div className="mb-4">
          <div className="text-app-primary text-sm mb-1">Xoá toàn bộ feedback store</div>
          <p className="text-app-muted text-xs mb-2">Sẽ xoá hết past examples Hermes đã học. Không thể undo.</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder='Nhập "XOAHET" để xác nhận'
              className="flex-1 px-3 py-2 bg-app-elevated text-app-primary text-sm"
              style={{ border: '1px solid var(--border-bright)' }}
            />
            <button
              onClick={() => deleteAllFeedback.mutate()}
              disabled={confirmText !== 'XOAHET' || deleteAllFeedback.isPending}
              className="px-3 py-2 font-mono-ui text-xs uppercase"
              style={{
                background: confirmText === 'XOAHET' ? 'rgba(239,68,68,0.2)' : 'var(--bg-elevated)',
                color: confirmText === 'XOAHET' ? 'var(--danger)' : 'var(--text-muted)',
                border: '1px solid rgba(239,68,68,0.4)',
                cursor: confirmText === 'XOAHET' ? 'pointer' : 'not-allowed',
              }}
            >
              <Trash2 size={12} className="inline mr-1" />
              XOÁ HẾT
            </button>
          </div>
        </div>

        {/* Xoá memory 1 nick */}
        <div>
          <div className="text-app-primary text-sm mb-1">Xoá memory 1 nick</div>
          <p className="text-app-muted text-xs mb-2">Reset per-nick memory. Nick sẽ bắt đầu học lại từ đầu.</p>
          <div className="flex gap-2">
            <select
              value={nickId}
              onChange={(e) => setNickId(e.target.value)}
              className="flex-1 px-3 py-2 bg-app-elevated text-app-primary text-sm"
              style={{ border: '1px solid var(--border-bright)' }}
            >
              <option value="">Chọn nick...</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.username || a.id.slice(0, 8)} ({a.status})
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (!nickId) return
                if (confirm(`Xác nhận xoá memory cho ${accounts.find(a => a.id === nickId)?.username}?`)) {
                  deleteNickMemory.mutate()
                }
              }}
              disabled={!nickId || deleteNickMemory.isPending}
              className="px-3 py-2 font-mono-ui text-xs uppercase"
              style={{
                background: nickId ? 'rgba(239,68,68,0.2)' : 'var(--bg-elevated)',
                color: nickId ? 'var(--danger)' : 'var(--text-muted)',
                border: '1px solid rgba(239,68,68,0.4)',
                cursor: nickId ? 'pointer' : 'not-allowed',
              }}
            >
              <Trash2 size={12} className="inline mr-1" />
              XOÁ
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: SOUL — edit ~/.hermes/SOUL.md (Hermes personality)
// ───────────────────────────────────────────────────────────
function SoulSection() {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['hermes-soul'],
    queryFn: async () => (await api.get('/ai-hermes/soul')).data,
  })
  useEffect(() => {
    if (data && !loaded) { setDraft(data.content || ''); setLoaded(true) }
  }, [data, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveMut = useMutation({
    mutationFn: async () => (await api.put('/ai-hermes/soul', { content: draft })).data,
    onSuccess: () => {
      toast.success('SOUL đã cập nhật + hot-reload')
      qc.invalidateQueries({ queryKey: ['hermes-soul'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  const dirty = loaded && draft !== (data?.content || '')
  return (
    <div className="p-6 font-mono-ui">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-[11px] uppercase tracking-wider text-app-muted">SOUL — Hermes personality</div>
        <div className="flex-1 text-[10px] text-app-dim">{data?.path || '~/.hermes/SOUL.md'}</div>
        {dirty && <span className="text-[10px] text-warn">● unsaved</span>}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={isLoading}
        className="w-full font-mono-ui text-xs p-3"
        style={{
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          color: 'var(--text-primary)', minHeight: 420, borderRadius: 4, outline: 'none',
        }}
        placeholder="Bạn là Hermes, AI marketing assistant..."
      />
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => saveMut.mutate()}
          disabled={!dirty || saveMut.isPending}
          className="btn-hermes"
        >
          {saveMut.isPending ? 'Đang lưu…' : 'Lưu SOUL'}
        </button>
        <button
          onClick={() => { setDraft(data?.content || ''); }}
          disabled={!dirty}
          className="btn-ghost"
        >
          Hoàn tác
        </button>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: DECISIONS — all hermes_decisions across campaigns
// ───────────────────────────────────────────────────────────
function DecisionsSection() {
  const nav = useNavigate()
  const [outcomeFilter, setOutcomeFilter] = useState('')
  const { data: resp, isLoading } = useQuery({
    queryKey: ['hermes-decisions-global', outcomeFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '100' })
      if (outcomeFilter) params.set('outcome', outcomeFilter)
      return (await api.get(`/ai-hermes/decisions?${params}`)).data
    },
    refetchInterval: 20000,
  })
  const rows = useMemo(() => {
    const list = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : []
    return list.filter(r => r.decision_type !== 'orchestration_summary')
  }, [resp])

  return (
    <div className="p-6 font-mono-ui">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-[11px] uppercase tracking-wider text-app-muted">Decisions (global)</div>
        <select
          className="ml-auto px-2 py-1 text-xs"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 4 }}
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
        >
          <option value="">Tất cả</option>
          <option value="pending">Pending</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      {isLoading ? (
        <div className="text-app-muted text-sm">Đang tải…</div>
      ) : rows.length === 0 ? (
        <div className="text-app-muted text-sm">Chưa có quyết định nào.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th className="text-left py-2 text-[10px] uppercase text-app-muted">Thời gian</th>
              <th className="text-left py-2 text-[10px] uppercase text-app-muted">Loại</th>
              <th className="text-left py-2 text-[10px] uppercase text-app-muted">Target</th>
              <th className="text-left py-2 text-[10px] uppercase text-app-muted">Auto</th>
              <th className="text-left py-2 text-[10px] uppercase text-app-muted">Outcome</th>
              <th className="py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const outcomeColor = r.outcome === 'pending' ? 'text-warn'
                : r.outcome === 'failed' ? 'text-danger'
                : r.outcome === 'success' || r.outcome === 'user_approved' ? 'text-hermes'
                : 'text-app-muted'
              return (
                <tr key={r.id} className="hover-row" style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="py-2 text-app-muted tabular-nums">
                    {new Date(r.created_at).toLocaleString('vi-VN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-2">{r.action_type || r.decision_type}</td>
                  <td className="py-2 text-app-muted truncate max-w-xs">{r.target_name || '—'}</td>
                  <td className="py-2">{r.auto_applied ? '🤖' : '👤'}</td>
                  <td className={`py-2 ${outcomeColor}`}>{r.outcome || '—'}</td>
                  <td className="py-2">
                    {r.campaign_id && (
                      <button
                        onClick={() => nav(`/campaigns/${r.campaign_id}?tab=hermes`)}
                        className="text-hermes text-[10px] hover:underline"
                      >
                        Mở ↗
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: LEARNING — self-improvement timeline
// ───────────────────────────────────────────────────────────
function LearningSection() {
  const qc = useQueryClient()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['hermes-learning-log'],
    queryFn: async () => {
      const r = await api.get('/ai-hermes/learning-log?limit=60')
      return Array.isArray(r.data) ? r.data : (r.data?.data || [])
    },
    refetchInterval: 30000,
  })
  const runMut = useMutation({
    mutationFn: async () => (await api.post('/ai-hermes/daily-review', {})).data,
    onSuccess: () => {
      toast.success('Daily review đã chạy')
      qc.invalidateQueries({ queryKey: ['hermes-learning-log'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  return (
    <div className="p-6 font-mono-ui">
      <div className="flex items-center gap-3 mb-4">
        <div className="text-[11px] uppercase tracking-wider text-app-muted">Nhật ký học tập</div>
        <button
          onClick={() => runMut.mutate()}
          disabled={runMut.isPending}
          className="ml-auto btn-hermes"
        >
          {runMut.isPending ? 'Đang chạy (~20s)…' : 'Run Daily Review Now'}
        </button>
      </div>
      {isLoading ? (
        <div className="text-app-muted text-sm">Đang tải…</div>
      ) : rows.length === 0 ? (
        <div className="text-app-muted text-sm">
          Chưa có nhật ký. Cron tự chạy lúc 23:00 VN hàng ngày, hoặc bấm nút trên.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(r => {
            const decision = r.decision || {}
            const review = decision.review || {}
            const applied = decision.applied || {}
            return (
              <div
                key={r.id}
                className="p-3"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4 }}
              >
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[10px] text-app-muted tabular-nums">
                    {new Date(r.created_at).toLocaleString('vi-VN')}
                  </span>
                  <span className="text-xs">🧠 Self-review {decision.date || ''}</span>
                  {applied.skills_rewritten?.length > 0 && (
                    <span className="text-[10px] px-2 py-0.5 text-hermes" style={{ background: 'var(--hermes-dim)', borderRadius: 4 }}>
                      +{applied.skills_rewritten.length} skill rewrites
                    </span>
                  )}
                  {applied.feedback_purged > 0 && (
                    <span className="text-[10px] px-2 py-0.5 text-warn" style={{ background: 'rgba(249,115,22,0.1)', borderRadius: 4 }}>
                      purged {applied.feedback_purged}
                    </span>
                  )}
                </div>
                {r.outcome_detail && (
                  <div className="text-sm text-app-primary mb-2">"{r.outcome_detail}"</div>
                )}
                {review.summary && review.summary !== r.outcome_detail && (
                  <div className="text-xs text-app-muted mb-2">{review.summary}</div>
                )}
                {Array.isArray(review.insights) && review.insights.length > 0 && (
                  <ul className="text-xs text-app-muted space-y-0.5 ml-4">
                    {review.insights.map((s, i) => <li key={i}>• {s}</li>)}
                  </ul>
                )}
                {applied.skills_rewritten?.length > 0 && (
                  <div className="text-[10px] text-hermes mt-2">
                    Rewrote: {applied.skills_rewritten.map(s => s.task_type).join(', ')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: REPORTS — AI-generated campaign reports
// ───────────────────────────────────────────────────────────
function ReportsSection() {
  const [campaignId, setCampaignId] = useState('')
  const [report, setReport] = useState(null)

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns-for-reports'],
    queryFn: async () => {
      const r = await api.get('/campaigns')
      return Array.isArray(r.data) ? r.data : (r.data?.data || [])
    },
  })

  const genMut = useMutation({
    mutationFn: async () => (await api.post(`/ai-hermes/report/${campaignId}`, {})).data,
    onSuccess: (data) => { setReport(data); toast.success('Báo cáo đã tạo') },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  return (
    <div className="p-6 font-mono-ui">
      <div className="flex items-center gap-3 mb-4">
        <div className="text-[11px] uppercase tracking-wider text-app-muted">Weekly reports</div>
      </div>
      <div className="flex items-center gap-2 mb-4">
        <select
          value={campaignId}
          onChange={(e) => { setCampaignId(e.target.value); setReport(null) }}
          className="px-3 py-2 text-sm"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 4, minWidth: 280 }}
        >
          <option value="">— Chọn campaign —</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button
          onClick={() => genMut.mutate()}
          disabled={!campaignId || genMut.isPending}
          className="btn-hermes"
        >
          {genMut.isPending ? 'Đang tạo (~15s)…' : 'Tạo báo cáo'}
        </button>
      </div>
      {report && (
        <div
          className="p-4 space-y-4 text-sm"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4 }}
        >
          {report.executive_summary && (
            <div>
              <div className="text-[10px] uppercase text-app-muted mb-1">Tóm tắt</div>
              <div className="text-app-primary">{report.executive_summary}</div>
            </div>
          )}
          {Array.isArray(report.highlights) && report.highlights.length > 0 && (
            <div>
              <div className="text-[10px] uppercase text-app-muted mb-1">Điểm nổi bật</div>
              <ul className="space-y-1 ml-4">
                {report.highlights.map((s, i) => <li key={i} className="text-hermes">• {s}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(report.issues) && report.issues.length > 0 && (
            <div>
              <div className="text-[10px] uppercase text-app-muted mb-1">Vấn đề</div>
              <ul className="space-y-1 ml-4">
                {report.issues.map((s, i) => <li key={i} className="text-warn">⚠ {s}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(report.recommendations) && report.recommendations.length > 0 && (
            <div>
              <div className="text-[10px] uppercase text-app-muted mb-1">Đề xuất</div>
              <ul className="space-y-1 ml-4">
                {report.recommendations.map((s, i) => <li key={i} className="text-info">→ {s}</li>)}
              </ul>
            </div>
          )}
          {report.next_week_plan && (
            <div>
              <div className="text-[10px] uppercase text-app-muted mb-1">Kế hoạch tuần tới</div>
              <div className="text-app-primary italic">{report.next_week_plan}</div>
            </div>
          )}
          <div className="pt-2 flex gap-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(report, null, 2))
                toast.success('Đã copy JSON')
              }}
              className="btn-ghost"
            >
              Copy JSON
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// Main page
// ───────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────
// SECTION: Per-task model override
// User picks (provider, model) per skill/function so, e.g., relevance_review
// can run on cheap deepseek while comment_gen uses gpt-4o-mini. Saves to
// ai_settings.task_models; orchestrator.call() reads it every call.
// ───────────────────────────────────────────────────────────
const TASK_PRESETS = [
  { fn: 'relevance_review', label: 'Đánh giá bài viết', desc: 'Chấm điểm bài có đáng comment không' },
  { fn: 'comment_gen',      label: 'Sinh comment',       desc: 'Viết nội dung comment tự nhiên' },
  { fn: 'quality_gate',     label: 'Gate chất lượng comment', desc: 'Duyệt/reject comment trước khi post' },
  { fn: 'group_eval',       label: 'Đánh giá nhóm mới',  desc: 'Score nhóm mới phát hiện' },
  { fn: 'profile_eval',     label: 'Đánh giá profile',   desc: 'Scan thành viên trước kết bạn' },
  { fn: 'orchestrator',     label: 'Orchestrator',       desc: 'Ra quyết định điều phối chiến dịch' },
  { fn: 'self_reviewer',    label: 'Self-review hàng ngày', desc: 'Review & cải thiện skills' },
  { fn: 'reporter',         label: 'Báo cáo',            desc: 'Tổng hợp KPI + narrative' },
  { fn: 'cookie_death_analyzer', label: 'Phân tích cookie-death', desc: 'Tìm nguyên nhân nick chết' },
  { fn: 'caption_gen',      label: 'Viết caption',       desc: 'Caption cho post content' },
  { fn: 'ai_pilot',         label: 'AI Pilot (plan)',    desc: 'Lên kế hoạch chiến dịch' },
]
const PROVIDER_OPTIONS = ['', 'hermes', 'deepseek', 'openai', 'anthropic', 'gemini', 'groq', 'kimi']

function PerTaskModelSection() {
  const qc = useQueryClient()
  const { data: settings, isLoading } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: async () => (await api.get('/ai/settings')).data,
  })
  const [draft, setDraft] = useState({})
  useEffect(() => {
    if (settings?.task_models) setDraft(settings.task_models)
  }, [settings])

  const save = useMutation({
    mutationFn: async (task_models) => api.put('/ai/settings', { task_models }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-settings'] })
      toast.success('Đã lưu per-task model')
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })

  const setField = (fn, key, value) => {
    setDraft((d) => {
      const next = { ...d }
      const row = { ...(next[fn] || {}) }
      if (value === '') delete row[key]
      else row[key] = value
      if (Object.keys(row).length === 0) delete next[fn]
      else next[fn] = row
      return next
    })
  }

  const providers = settings?.providers || {}
  const providerKeys = Object.keys(providers).filter(k => providers[k]?.enabled)
  const providerList = providerKeys.length ? ['', ...providerKeys] : PROVIDER_OPTIONS

  if (isLoading) return <div className="p-6 text-app-muted">Đang tải…</div>

  return (
    <div className="p-6 font-mono-ui text-xs max-w-4xl">
      <div className="mb-4">
        <div className="text-app-primary text-sm mb-1">Per-task model override</div>
        <div className="text-app-muted text-[11px] leading-relaxed">
          Ghi đè (provider, model) cho từng loại tác vụ. Để trống = dùng default.
          Áp dụng cho TẤT CẢ chiến dịch (user-level). Orchestrator đọc mỗi lần gọi.
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)' }}>
        <div
          className="flex items-center gap-3 px-3 py-2 text-[10px] uppercase text-app-muted"
          style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}
        >
          <div className="w-52">Tác vụ</div>
          <div className="w-32">Provider</div>
          <div className="flex-1">Model</div>
        </div>
        {TASK_PRESETS.map(({ fn, label, desc }) => {
          const row = draft[fn] || {}
          return (
            <div
              key={fn}
              className="flex items-center gap-3 px-3 py-2"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div className="w-52">
                <div className="text-app-primary">{label}</div>
                <div className="text-app-dim text-[10px]">{desc} · <span className="text-app-muted">{fn}</span></div>
              </div>
              <select
                value={row.provider || ''}
                onChange={(e) => setField(fn, 'provider', e.target.value)}
                className="w-32 px-2 py-1 font-mono-ui text-xs"
                style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                {providerList.map(p => <option key={p} value={p}>{p || '(default)'}</option>)}
              </select>
              <input
                type="text"
                value={row.model || ''}
                onChange={(e) => setField(fn, 'model', e.target.value)}
                placeholder="(default model)"
                className="flex-1 px-2 py-1 font-mono-ui text-xs"
                style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          className="btn-hermes"
          disabled={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? 'Đang lưu…' : 'Lưu cấu hình'}
        </button>
        <div className="text-app-muted text-[11px]">
          Hiện đang override: {Object.keys(draft).length} / {TASK_PRESETS.length} tác vụ
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: Agent Playwright runtime (Hermes-controlled)
// Pulls GET /agent/runtime, PUTs the edited override back. Agent re-reads
// the config every 5 min, so tuning here takes effect on the next tick
// without rebuilding the Wails binary.
// ───────────────────────────────────────────────────────────
const RUNTIME_FIELDS = [
  { group: 'Rest / session (phút)' },
  { k: 'rest_min_minutes',    label: 'Rest min',    type: 'number', step: 1, unit: 'min', hint: 'Khoảng nghỉ tối thiểu giữa 2 session của 1 nick' },
  { k: 'rest_max_minutes',    label: 'Rest max',    type: 'number', step: 1, unit: 'min', hint: 'Khoảng nghỉ tối đa — jitter uniform [min, max]' },
  { k: 'session_min_minutes', label: 'Session min', type: 'number', step: 1, unit: 'min', hint: '1 session = 1 lượt mở browser làm việc' },
  { k: 'session_max_minutes', label: 'Session max', type: 'number', step: 1, unit: 'min', hint: 'Agent force nghỉ khi chạy quá mức này' },
  { group: 'Timeout Playwright (ms)' },
  { k: 'navigation_timeout_ms', label: 'Navigation', type: 'number', step: 1000, unit: 'ms', hint: 'page.goto / waitForNavigation' },
  { k: 'action_timeout_ms',     label: 'Action',     type: 'number', step: 500,  unit: 'ms', hint: 'click / type / waitForSelector' },
  { group: 'Viewport + UA' },
  { k: 'viewport_width',  label: 'Viewport W', type: 'number', step: 1, unit: 'px' },
  { k: 'viewport_height', label: 'Viewport H', type: 'number', step: 1, unit: 'px' },
  { k: 'user_agent',      label: 'User agent (null = auto)', type: 'text' },
  { k: 'default_language', label: 'Default lang', type: 'text' },
  { group: 'Concurrency' },
  { k: 'max_concurrent',      label: 'Max concurrent nicks', type: 'number', step: 1, hint: 'Số nick chạy song song trong agent' },
  { k: 'poll_interval_ms',    label: 'Poll interval',        type: 'number', step: 500, unit: 'ms' },
  { k: 'heartbeat_interval_ms', label: 'Heartbeat interval', type: 'number', step: 1000, unit: 'ms' },
  { group: 'Warm-up gate' },
  { k: 'enable_warmup_gate',     label: 'Bật warmup gate',       type: 'bool' },
  { k: 'warmup_join_block_days', label: 'Chặn join_group đến ngày', type: 'number', step: 1, unit: 'ngày', hint: 'Nick <N ngày không được join nhóm mới' },
]

function AgentPlaywrightSection() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['agent-runtime'],
    queryFn: async () => (await api.get('/agent/runtime')).data,
  })
  const [draft, setDraft] = useState({})
  useEffect(() => {
    if (data?.effective) setDraft(data.effective)
  }, [data])

  const save = useMutation({
    mutationFn: async (payload) => api.put('/agent/runtime', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-runtime'] })
      toast.success('Đã lưu. Agent đồng bộ trong vòng 5 phút.')
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })

  const reset = () => {
    if (data?.defaults) setDraft({ ...data.defaults })
  }

  const setField = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  const defaults = data?.defaults || {}

  if (isLoading) return <div className="p-6 text-app-muted">Đang tải…</div>

  return (
    <div className="p-6 font-mono-ui text-xs max-w-3xl">
      <div className="mb-4">
        <div className="text-app-primary text-sm mb-1">Agent Playwright runtime</div>
        <div className="text-app-muted text-[11px] leading-relaxed">
          Hermes điều khiển hành vi Playwright từ đây — không phải đổi code rồi build lại agent.
          Agent pull cấu hình mới mỗi 5 phút, hoặc đá restart để áp ngay.
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)' }}>
        {RUNTIME_FIELDS.map((row, idx) => {
          if (row.group) {
            return (
              <div
                key={`g-${idx}`}
                className="px-3 py-2 text-[10px] uppercase text-app-muted"
                style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}
              >
                {row.group}
              </div>
            )
          }
          const value = draft[row.k]
          const defVal = defaults[row.k]
          const changed = value !== defVal && value !== undefined
          return (
            <div
              key={row.k}
              className="flex items-center gap-3 px-3 py-2"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div className="w-48">
                <div className="text-app-primary">{row.label}</div>
                {row.hint && <div className="text-app-dim text-[10px]">{row.hint}</div>}
              </div>
              {row.type === 'bool' ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!value}
                    onChange={(e) => setField(row.k, e.target.checked)}
                  />
                  <span className="text-app-muted">{value ? 'Bật' : 'Tắt'}</span>
                </label>
              ) : (
                <input
                  type={row.type === 'number' ? 'number' : 'text'}
                  step={row.step || 1}
                  value={value === null || value === undefined ? '' : value}
                  onChange={(e) => {
                    let v = e.target.value
                    if (row.type === 'number') v = v === '' ? null : Number(v)
                    setField(row.k, v)
                  }}
                  placeholder={defVal === null ? '(auto)' : String(defVal ?? '')}
                  className="flex-1 px-2 py-1 font-mono-ui text-xs"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                />
              )}
              {row.unit && <span className="w-10 text-app-muted">{row.unit}</span>}
              {changed && <span className="w-6 text-warn" title="Khác default">•</span>}
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          className="btn-hermes"
          disabled={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? 'Đang lưu…' : 'Lưu cấu hình'}
        </button>
        <button className="btn-ghost" onClick={reset} disabled={save.isPending}>
          Reset về default
        </button>
        <div className="text-app-muted text-[11px]">
          Agent sync mỗi ~5 phút
        </div>
      </div>
    </div>
  )
}

const SECTIONS = [
  { key: 'model',     label: 'Model' },
  { key: 'oauth',     label: 'ChatGPT / OAuth' },
  { key: 'per_task',  label: 'Per-task model' },
  { key: 'agent_pw',  label: 'Agent Playwright' },
  { key: 'skills',    label: 'Skills' },
  { key: 'quality',   label: 'Quality' },
  { key: 'fallback',  label: 'Fallback' },
  { key: 'memory',    label: 'Memory' },
  { key: 'soul',      label: 'SOUL' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'learning',  label: 'Learning' },
  { key: 'reports',   label: 'Reports' },
]

export default function HermesSettings() {
  const [section, setSection] = useState('model')

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-8 px-6 py-4"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div>
          <div className="font-mono-ui text-[10px] uppercase text-app-muted">Hermes settings</div>
          <div className="text-app-primary text-lg mt-1">Cài đặt AI brain</div>
        </div>
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`px-4 py-2.5 ${section === s.key ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
            style={{
              borderBottom: section === s.key ? '2px solid var(--hermes)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {section === 'model'     && <ModelSection />}
        {section === 'oauth'     && <OauthSection />}
        {section === 'per_task'  && <PerTaskModelSection />}
        {section === 'agent_pw'  && <AgentPlaywrightSection />}
        {section === 'skills'    && <SkillsSection />}
        {section === 'quality'   && <QualityGateSection />}
        {section === 'fallback'  && <FallbackSection />}
        {section === 'memory'    && <MemorySection />}
        {section === 'soul'      && <SoulSection />}
        {section === 'decisions' && <DecisionsSection />}
        {section === 'learning'  && <LearningSection />}
        {section === 'reports'   && <ReportsSection />}
      </div>
    </div>
  )
}
