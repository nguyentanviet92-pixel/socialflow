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
import { Plus, Trash2, GripVertical, AlertTriangle, Check, Loader, ArrowLeft, ChevronRight, Globe, Settings2, RefreshCw } from 'lucide-react'
import api, { API_BASE } from '../../lib/api'
import SkillsEditor from './SkillsEditor'

const asArray = (d) => Array.isArray(d) ? d
  : Array.isArray(d?.items) ? d.items
  : Array.isArray(d?.data) ? d.data
  : []

// ───────────────────────────────────────────────────────────
// SECTION 1: Model & Provider constants and tabs
// ───────────────────────────────────────────────────────────
export const DEFAULT_FALLBACK_CHAIN = [
  { provider: 'nvidia',    model: 'meta/llama-3.3-70b-instruct',  enabled: true  },
  { provider: 'groq',      model: 'llama-3.3-70b-versatile',      enabled: true  },
  { provider: 'deepseek',  model: 'deepseek-chat',                enabled: true  },
  { provider: 'openai',    model: 'gpt-4o-mini',                  enabled: false },
  { provider: 'gemini',    model: 'gemini-2.5-flash',             enabled: false },
  { provider: 'kimi',      model: 'moonshot-v1-128k',             enabled: false },
  { provider: 'anthropic', model: 'claude-sonnet-4-6',            enabled: false },
];

export const PROVIDER_KEY_MAP = {
  nvidia:    'NVIDIA_API_KEY',
  groq:      'GROQ_API_KEY',
  deepseek:  'DEEPSEEK_API_KEY',
  kimi:      'KIMI_API_KEY',
  openai:    'OPENAI_API_KEY',
  gemini:    'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export const PROVIDER_BASE_URLS = {
  nvidia:    'https://integrate.api.nvidia.com/v1',
  groq:      'https://api.groq.com/openai/v1',
  deepseek:  'https://api.deepseek.com/v1',
  kimi:      'https://api.moonshot.cn/v1',
  openai:    'https://api.openai.com/v1',
  gemini:    'https://generativelanguage.googleapis.com/v1beta/openai/',
  anthropic: 'https://api.anthropic.com/v1',
};

export const PROVIDER_MODELS = {
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct',            label: 'Llama 3.3 70B ⭐' },
    { id: 'meta/llama-3.1-8b-instruct',             label: 'Llama 3.1 8B (fast)' },
    { id: 'openai/gpt-oss-120b',                    label: 'GPT OSS 120B' },
    { id: 'deepseek-ai/deepseek-r1',                label: 'DeepSeek R1 (reasoning)' },
    { id: 'deepseek-ai/deepseek-v3',                label: 'DeepSeek V3 (chat)' },
    { id: 'deepseek-ai/deepseek-v4-flash',          label: 'DeepSeek V4 Flash (1M ctx)' },
    { id: 'moonshotai/kimi-k2',                     label: 'Kimi K2 (200K ctx)' },
    { id: 'nvidia/nemotron-3-super-120b',           label: 'Nemotron 3 Super 120B' },
    { id: 'minimaxai/minimax-m2.7',                 label: 'MiniMax M2.7' },
    { id: 'zhipuai/glm-5.1',                        label: 'GLM-5.1 (multilingual)' },
    { id: 'qwen/qwen3-235b-a22b',                   label: 'Qwen3 235B MoE' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile',                label: 'Llama 3.3 70B [PROD] 280t/s ⭐' },
    { id: 'llama-3.1-8b-instant',                   label: 'Llama 3.1 8B [PROD] 560t/s' },
    { id: 'openai/gpt-oss-120b',                    label: 'GPT OSS 120B [PROD] 500t/s' },
    { id: 'openai/gpt-oss-20b',                     label: 'GPT OSS 20B [PROD] 1000t/s ⚡' },
    { id: 'qwen/qwen3-32b',                         label: 'Qwen3 32B [PREVIEW] 400t/s 🧠' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout [PREVIEW] 750t/s' },
    { id: 'moonshotai/kimi-k2-instruct-0905',       label: 'Kimi K2 [PREVIEW]' },
  ],
  deepseek: [
    { id: 'deepseek-chat',     label: 'DeepSeek V3 Chat ⭐' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1 Reasoner' },
  ],
  kimi: [
    { id: 'kimi-k2-0711-preview', label: 'Kimi K2 (latest)' },
    { id: 'moonshot-v1-128k',     label: 'Moonshot v1 128K ⭐' },
    { id: 'moonshot-v1-32k',      label: 'Moonshot v1 32K' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini ⭐' },
    { id: 'gpt-4o',      label: 'GPT-4o' },
    { id: 'o3-mini',     label: 'o3-mini (reasoning)' },
    { id: 'o3',          label: 'o3 (flagship)' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash ⭐' },
    { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (stable)' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6 ⭐' },
    { id: 'claude-opus-4-6',          label: 'Claude Opus 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast)' },
  ],
};

const PROVIDER_LABELS = {
  nvidia: 'NVIDIA NIM (Free tier)',
  groq: 'Groq (fast + free tier)',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  kimi: 'Kimi (Moonshot)',
  anthropic: 'Anthropic',
};

function ModelSection({ defaultSubTab = 'active' }) {
  const qc = useQueryClient()
  const { data: cfgData, isLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })

  const providers = cfgData?.providers || {}
  const cfg = cfgData?.config || {}
  
  const [subTab, setSubTab] = useState(defaultSubTab) // 'active' | 'keys' | 'fallback'
  
  // Tab 1 Form State
  const [form, setForm] = useState({
    provider: 'nvidia',
    model: 'meta/llama-3.3-70b-instruct',
    api_key: '',
    base_url: 'https://integrate.api.nvidia.com/v1',
    max_tokens: 500,
    temperature: 0.7,
  })
  const [customModelMode, setCustomModelMode] = useState(false)
  const [customModelInput, setCustomModelInput] = useState('')
  const [testingActive, setTestingActive] = useState(null)

  // Tab 2 Form State (keys dict)
  const [keysForm, setKeysForm] = useState({})
  const [testingKeys, setTestingKeys] = useState({})

  // Tab 3 Form State (fallback chain list)
  const [chainForm, setChainForm] = useState([])
  const [dragIdx, setDragIdx] = useState(null)

  // Keep subTab synced with defaults when switching views from sidebar
  useEffect(() => {
    setSubTab(defaultSubTab)
  }, [defaultSubTab])

  // Sync from backend config
  useEffect(() => {
    if (cfg && !isLoading) {
      const activeProvider = cfg.provider || 'nvidia'
      const activeModel = cfg.model || 'meta/llama-3.3-70b-instruct'
      
      const isPreset = PROVIDER_MODELS[activeProvider]?.some(m => m.id === activeModel)
      setCustomModelMode(!isPreset)
      if (!isPreset) {
        setCustomModelInput(activeModel)
      }

      setForm({
        provider: activeProvider,
        model: activeModel,
        api_key: '',
        base_url: cfg.base_url || PROVIDER_BASE_URLS[activeProvider] || '',
        max_tokens: cfg.max_tokens ?? 500,
        temperature: cfg.temperature ?? 0.7,
      })

      // Keys mapping
      const initialKeys = {}
      Object.keys(PROVIDER_KEY_MAP).forEach(prov => {
        const envKey = PROVIDER_KEY_MAP[prov]
        initialKeys[envKey] = cfg.fallback_keys?.[envKey] || ''
      })
      setKeysForm(initialKeys)

      // Fallback chain reorder
      let initialChain = cfg.fallback_chain || []
      if (!Array.isArray(initialChain) || initialChain.length === 0) {
        initialChain = DEFAULT_FALLBACK_CHAIN
      }
      // Ensure all 7 providers exist in the list
      const existingProviders = initialChain.map(item => item.provider)
      const missing = DEFAULT_FALLBACK_CHAIN.filter(d => !existingProviders.includes(d.provider))
      setChainForm([...initialChain, ...missing])
    }
  }, [cfgData, isLoading])

  const looksLikeApiKey = (k) => {
    if (!k || typeof k !== 'string') return false
    const trimmed = k.trim()
    if (trimmed.length < 10 || trimmed.length > 200) return false
    if (/\s/.test(trimmed)) return false
    if (/[^\x20-\x7e]/.test(trimmed)) return false
    if (/error|failed|invalid|thất bại/i.test(trimmed)) return false
    if (/[{}[\]:,]/.test(trimmed)) return false
    return true
  }

  // Tab 1 actions
  const saveActive = useMutation({
    mutationFn: async () => {
      const selectedModel = customModelMode ? customModelInput.trim() : form.model
      if (!selectedModel) {
        throw new Error('Vui lòng chọn hoặc điền Model ID')
      }

      const payload = {
        provider: form.provider,
        model: selectedModel,
        base_url: form.base_url,
        max_tokens: parseInt(form.max_tokens),
        temperature: parseFloat(form.temperature),
      }

      if (form.api_key && form.api_key.trim().length > 0) {
        if (!looksLikeApiKey(form.api_key)) {
          throw new Error('API key không hợp lệ — chứa ký tự lạ hoặc trông giống error message.')
        }
        payload.api_key = form.api_key.trim()
        
        // Also update fallback_keys
        const envKey = PROVIDER_KEY_MAP[form.provider]
        if (envKey) {
          payload.fallback_keys = {
            ...keysForm,
            [envKey]: form.api_key.trim()
          }
        }
      }

      await api.put('/ai-hermes/config', payload)
    },
    onSuccess: () => {
      toast.success('Đã lưu cài đặt model mặc định')
      setForm(f => ({ ...f, api_key: '' }))
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const testActiveConnection = async () => {
    const selectedModel = customModelMode ? customModelInput.trim() : form.model
    const envKey = PROVIDER_KEY_MAP[form.provider]
    const currentKey = form.api_key || keysForm[envKey] || ''
    
    if (!currentKey) {
      toast.error('Nhập API key hoặc cấu hình key trong Tab 2 trước')
      return
    }

    setTestingActive('pending')
    try {
      const res = await api.post('/ai-hermes/config/test', {
        provider: form.provider,
        model: selectedModel,
        api_key: currentKey,
        base_url: form.base_url,
      })
      setTestingActive(res.data)
      if (res.data.ok) {
        toast.success(`Kết nối OK (${res.data.latency_ms}ms)`)
      } else {
        toast.error(`Test thất bại: ${res.data.error}`)
      }
    } catch (err) {
      setTestingActive({ ok: false, error: err.message })
      toast.error(`Test lỗi: ${err.message}`)
    }
  }

  // Tab 2 actions
  const saveAllKeys = useMutation({
    mutationFn: async () => {
      // Validate all edited keys
      const cleanKeys = {}
      for (const envKey of Object.keys(keysForm)) {
        const val = keysForm[envKey] || ''
        if (val && !val.includes('...') && val !== '***') {
          if (!looksLikeApiKey(val)) {
            throw new Error(`API key của ${envKey} không hợp lệ — chứa ký tự lạ hoặc trông giống error message.`)
          }
        }
        cleanKeys[envKey] = val.trim()
      }

      await api.put('/ai-hermes/config', {
        fallback_keys: cleanKeys
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu tất cả API Keys')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const testKeyConnection = async (prov) => {
    const envKey = PROVIDER_KEY_MAP[prov]
    const key = keysForm[envKey] || ''
    if (!key) {
      toast.error(`Nhập API key cho ${PROVIDER_LABELS[prov]} để test`)
      return
    }

    setTestingKeys(prev => ({ ...prev, [prov]: 'pending' }))
    const defaultModel = PROVIDER_MODELS[prov]?.[0]?.id || ''
    const defaultUrl = PROVIDER_BASE_URLS[prov] || ''

    try {
      const res = await api.post('/ai-hermes/config/test', {
        provider: prov,
        model: defaultModel,
        api_key: key,
        base_url: defaultUrl,
      })
      setTestingKeys(prev => ({ ...prev, [prov]: res.data }))
      if (res.data.ok) {
        toast.success(`Kết nối ${prov.toUpperCase()} OK (${res.data.latency_ms}ms)`)
      } else {
        toast.error(`Kết nối ${prov.toUpperCase()} lỗi: ${res.data.error}`)
      }
    } catch (err) {
      setTestingKeys(prev => ({ ...prev, [prov]: { ok: false, error: err.message } }))
      toast.error(`Test lỗi: ${err.message}`)
    }
  }

  // Tab 3 actions
  const saveChain = useMutation({
    mutationFn: async () => {
      await api.put('/ai-hermes/config', {
        fallback_chain: chainForm
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu thứ tự fallback chain')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const reorder = (fromIdx, toIdx) => {
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= chainForm.length || toIdx >= chainForm.length) return
    const arr = [...chainForm]
    const [item] = arr.splice(fromIdx, 1)
    arr.splice(toIdx, 0, item)
    setChainForm(arr)
  }

  const QUICK_PRESETS = [
    { p: 'chatgpt-oauth', m: 'custom-gpt',         label: '🤖 ChatGPT (OAuth)',  color: 'text-cyan-400 font-bold' },
    { p: 'nvidia',   m: 'meta/llama-3.3-70b-instruct', label: 'NVIDIA Llama 3.3',    color: 'text-amber-500' },
    { p: 'nvidia',   m: 'deepseek-ai/deepseek-r1',     label: 'NVIDIA DeepSeek R1',  color: 'text-amber-500 font-bold' },
    { p: 'deepseek', m: 'deepseek-chat',           label: 'DeepSeek V3',         color: 'text-info' },
    { p: 'kimi',     m: 'kimi-k2-0711-preview',    label: 'Kimi K2',             color: 'text-cyan-500' },
    { p: 'openai',   m: 'gpt-4o-mini',             label: 'GPT-4o-mini',         color: 'text-emerald-600' },
    { p: 'gemini',   m: 'gemini-2.5-flash',        label: 'Gemini 2.5 Flash',    color: 'text-purple-500' },
    { p: 'groq',     m: 'llama-3.3-70b-versatile', label: 'Groq Llama 3.3',      color: 'text-red-500' },
  ]

  const quickSwitch = (provider, model) => {
    if (provider === 'chatgpt-oauth') {
      const targetUrl = cfgData?.config?.gpt_link || 'https://chatgpt.com'
      window.open(targetUrl, '_blank')
      setForm(f => ({
        ...f,
        provider: 'openai',
        model: 'chatgpt-action',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
      }))
      setCustomModelMode(false)
      toast.success('Đã chọn ChatGPT OAuth và mở tab mới để ủy quyền kết nối! 🚀')
      return
    }
    const baseUrl = PROVIDER_BASE_URLS[provider] || ''
    setForm(f => ({ ...f, provider, model, base_url: baseUrl, api_key: '' }))
    setCustomModelMode(false)
    toast.success(`Đã đổi sang ${provider} / ${model} — Lưu cấu hình để kích hoạt`)
  }

  const activeModels = PROVIDER_MODELS[form.provider] || []

  return (
    <div className="p-6 font-mono-ui max-w-3xl">
      <h2 className="text-app-primary text-base mb-1">1. Model & Provider</h2>
      <p className="text-app-muted text-xs mb-6">Cấu hình LLM chính, API Keys riêng biệt, và thứ tự Fallback khi có lỗi.</p>

      {/* Sub-tab selection */}
      <div className="flex gap-2 mb-6 border-b border-border pb-2">
        <button
          type="button"
          onClick={() => setSubTab('active')}
          className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-all border-b-2 ${
            subTab === 'active'
              ? 'text-hermes border-hermes'
              : 'text-app-muted border-transparent hover:text-app-primary'
          }`}
          style={{ marginBottom: '-9px' }}
        >
          Tab 1: Model mặc định
        </button>
        <button
          type="button"
          onClick={() => setSubTab('keys')}
          className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-all border-b-2 ${
            subTab === 'keys'
              ? 'text-hermes border-hermes'
              : 'text-app-muted border-transparent hover:text-app-primary'
          }`}
          style={{ marginBottom: '-9px' }}
        >
          Tab 2: Quản lý API Keys
        </button>
        <button
          type="button"
          onClick={() => setSubTab('fallback')}
          className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-all border-b-2 ${
            subTab === 'fallback'
              ? 'text-hermes border-hermes'
              : 'text-app-muted border-transparent hover:text-app-primary'
          }`}
          style={{ marginBottom: '-9px' }}
        >
          Tab 3: Thứ tự Fallback
        </button>
      </div>

      {/* SUBTAB 1: Active Model */}
      {subTab === 'active' && (
        <div className="space-y-4 max-w-2xl">
          {/* Quick-presets */}
          <div className="p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
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
          </div>

          {/* Provider dropdown */}
          <div>
            <label className="block text-[10px] uppercase text-app-muted mb-1">Provider chính</label>
            <select
              value={form.provider}
              onChange={(e) => {
                const newProv = e.target.value
                const defaultModel = PROVIDER_MODELS[newProv]?.[0]?.id || ''
                const defaultUrl = PROVIDER_BASE_URLS[newProv] || ''
                setForm(f => ({
                  ...f,
                  provider: newProv,
                  model: defaultModel,
                  base_url: defaultUrl,
                  api_key: '',
                }))
                setCustomModelMode(false)
              }}
              className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
              style={{ border: '1px solid var(--border-bright)' }}
            >
              {Object.keys(PROVIDER_LABELS).map(p => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </div>

          {/* Model selection */}
          <div>
            <label className="block text-[10px] uppercase text-app-muted mb-1">Model mặc định</label>
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setCustomModelMode(false)}
                className={`text-[10px] px-3 py-1 ${!customModelMode ? 'bg-hermes text-white' : 'bg-app-elevated text-app-muted'}`}
                style={{ border: '1px solid var(--border-bright)' }}
              >
                Chọn từ Preset
              </button>
              <button
                type="button"
                onClick={() => setCustomModelMode(true)}
                className={`text-[10px] px-3 py-1 ${customModelMode ? 'bg-hermes text-white' : 'bg-app-elevated text-app-muted'}`}
                style={{ border: '1px solid var(--border-bright)' }}
              >
                Nhập Model ID tự do
              </button>
            </div>

            {!customModelMode ? (
              <select
                value={form.model}
                onChange={(e) => setForm(f => ({ ...f, model: e.target.value }))}
                className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm font-mono-ui"
                style={{ border: '1px solid var(--border-bright)' }}
              >
                {activeModels.map(m => (
                  <option key={m.id} value={m.id}>{m.label} ({m.id})</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                placeholder="Ví dụ: deepseek-ai/deepseek-r1"
                className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm font-mono-ui"
                style={{ border: '1px solid var(--border-bright)' }}
              />
            )}
          </div>

          {/* API Key */}
          <div>
            <label className="block text-[10px] uppercase text-app-muted mb-1">
              API Key <span className="text-app-dim">(nếu không điền sẽ lấy key trong Tab 2)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={form.api_key}
                onChange={(e) => setForm(f => ({ ...f, api_key: e.target.value }))}
                placeholder={keysForm[PROVIDER_KEY_MAP[form.provider]] ? `Cấu hình sẵn: ${keysForm[PROVIDER_KEY_MAP[form.provider]]}` : 'Chưa cấu hình API Key'}
                className="flex-1 px-3 py-2 bg-app-elevated text-app-primary text-sm"
                style={{ border: '1px solid var(--border-bright)' }}
              />
              <button
                type="button"
                onClick={testActiveConnection}
                disabled={testingActive === 'pending'}
                className="btn-ghost whitespace-nowrap"
              >
                {testingActive === 'pending' ? <Loader size={12} className="animate-spin" /> : '🔌 Test kết nối'}
              </button>
            </div>
            {testingActive && testingActive !== 'pending' && (
              <div className={`mt-2 text-xs ${testingActive.ok ? 'text-hermes' : 'text-danger'}`}>
                {testingActive.ok
                  ? `✓ Kết nối thành công (${testingActive.latency_ms}ms) · Phản hồi: "${testingActive.response_preview}"`
                  : `✗ Lỗi kết nối: ${testingActive.error}`}
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
            type="button"
            onClick={() => saveActive.mutate()}
            disabled={saveActive.isPending}
            className="btn-hermes"
          >
            {saveActive.isPending ? 'Đang lưu…' : '💾 Lưu cấu hình'}
          </button>
        </div>
      )}

      {/* SUBTAB 2: Manage API Keys */}
      {subTab === 'keys' && (
        <div className="space-y-4">
          <p className="text-app-muted text-xs">Cấu hình API Key độc lập cho từng nhà cung cấp. Keys được tự động masked che giấu.</p>
          
          <div className="overflow-x-auto" style={{ border: '1px solid var(--border)' }}>
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-app-elevated font-mono-ui border-b border-border text-app-muted uppercase text-[10px] tracking-wider">
                  <th className="p-3">Provider</th>
                  <th className="p-3">API Key (Env Variable)</th>
                  <th className="p-3 text-right">Hành động</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.keys(PROVIDER_KEY_MAP).map(prov => {
                  const envKey = PROVIDER_KEY_MAP[prov]
                  const keyVal = keysForm[envKey] || ''
                  const isConfigured = keyVal && keyVal !== '***'
                  const testRes = testingKeys[prov]

                  return (
                    <tr key={prov} className="hover:bg-app-elevated/40">
                      <td className="p-3 font-semibold text-app-primary">
                        {PROVIDER_LABELS[prov]}
                        {form.provider === prov && (
                          <span className="ml-2 text-[9px] bg-hermes-dim text-hermes px-1.5 py-0.5 rounded font-normal uppercase">Primary</span>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-col gap-1">
                          <input
                            type="password"
                            value={keyVal}
                            onChange={(e) => setKeysForm({ ...keysForm, [envKey]: e.target.value })}
                            placeholder={isConfigured ? '••••••••' : 'Chưa cấu hình API Key'}
                            className="px-2 py-1 bg-app-base text-app-primary text-sm font-mono-ui w-64"
                            style={{ border: '1px solid var(--border)' }}
                          />
                          <span className="text-[10px] text-app-dim">{envKey}</span>
                        </div>
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex gap-2">
                          <button
                            type="button"
                            onClick={() => testKeyConnection(prov)}
                            disabled={testRes === 'pending'}
                            className="px-2 py-1 bg-app-base hover:bg-app-elevated border border-border text-[11px] rounded text-app-primary transition-all"
                          >
                            {testRes === 'pending' ? <Loader size={10} className="animate-spin inline mr-1" /> : '🔌 Test'}
                          </button>
                        </div>
                        {testRes && testRes !== 'pending' && (
                          <div className={`text-[10px] mt-1 ${testRes.ok ? 'text-hermes' : 'text-danger'}`}>
                            {testRes.ok ? `✓ OK (${testRes.latency_ms}ms)` : `✗ Lỗi`}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => saveAllKeys.mutate()}
              disabled={saveAllKeys.isPending}
              className="btn-hermes"
            >
              {saveAllKeys.isPending ? 'Đang lưu…' : '💾 Lưu tất cả API Keys'}
            </button>
          </div>
        </div>
      )}

      {/* SUBTAB 3: Fallback Chain */}
      {subTab === 'fallback' && (
        <div className="space-y-4">
          <p className="text-app-muted text-xs">Sắp xếp chuỗi fallback (thứ tự ưu tiên từ trên xuống dưới). Khi provider trước gặp lỗi rate limit (429) hoặc server down (5xx), hệ thống tự động gọi provider tiếp theo.</p>

          <div className="space-y-2 max-w-2xl">
            {chainForm.map((item, i) => {
              const envKey = PROVIDER_KEY_MAP[item.provider]
              const hasKey = keysForm[envKey] && keysForm[envKey] !== ''
              const providerLabel = PROVIDER_LABELS[item.provider] || item.provider
              const active = item.enabled

              return (
                <div
                  key={item.provider}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx !== null) reorder(dragIdx, i)
                    setDragIdx(null)
                  }}
                  className={`flex items-center gap-3 px-3 py-2 bg-app-elevated rounded border transition-all ${
                    active ? 'border-border-bright opacity-100' : 'border-border opacity-50'
                  }`}
                  style={{ background: 'var(--bg-elevated)' }}
                >
                  <GripVertical size={14} className="text-app-muted cursor-move" />
                  
                  {/* Enabled Checkbox */}
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(e) => {
                      const updated = [...chainForm]
                      updated[i] = { ...item, enabled: e.target.checked }
                      setChainForm(updated)
                    }}
                    className="cursor-pointer"
                  />

                  {/* Priority number */}
                  <span className="text-app-muted text-[10px] w-6">#{i + 1}</span>

                  {/* Provider name */}
                  <span className="text-app-primary text-xs font-semibold w-32">{providerLabel}</span>

                  {/* Model selector dropdown */}
                  <div className="flex-1">
                    <select
                      value={item.model}
                      onChange={(e) => {
                        const updated = [...chainForm]
                        updated[i] = { ...item, model: e.target.value }
                        setChainForm(updated)
                      }}
                      className="px-2 py-1 bg-app-base text-app-primary text-xs font-mono-ui border border-border rounded max-w-xs"
                    >
                      {(PROVIDER_MODELS[item.provider] || []).map(m => (
                        <option key={m.id} value={m.id}>{m.label || m.id}</option>
                      ))}
                    </select>
                  </div>

                  {/* Key configuration alert warning */}
                  {!hasKey && (
                    <span className="text-[10px] text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded flex items-center gap-1">
                      <AlertTriangle size={10} /> Chưa có API Key (bị skip)
                    </span>
                  )}

                  {/* Up/Down buttons for mobile/backup click reordering */}
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => reorder(i, i - 1)}
                      className="p-1 hover:bg-app-base rounded text-app-muted hover:text-app-primary disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={i === chainForm.length - 1}
                      onClick={() => reorder(i, i + 1)}
                      className="p-1 hover:bg-app-base rounded text-app-muted hover:text-app-primary disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => saveChain.mutate()}
              disabled={saveChain.isPending}
              className="btn-hermes"
            >
              {saveChain.isPending ? 'Đang lưu…' : '💾 Lưu thứ tự'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// SECTION: ChatGPT / OAuth — instruction and credentials for custom GPT actions
// ───────────────────────────────────────────────────────────
function OauthSection() {
  const domain = window.location.origin
  // Fallback to domain if API_BASE is relative or empty
  let apiDomain = API_BASE
  if (!apiDomain || !apiDomain.startsWith('http')) {
    apiDomain = domain
  }

  const [apiKey, setApiKey] = useState('')
  const [loadingKey, setLoadingKey] = useState(false)
  const [gptLink, setGptLink] = useState('')
  const [editingGptLink, setEditingGptLink] = useState(false)

  const qc = useQueryClient()
  const { data: cfgData, isLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })

  const dbGptLink = cfgData?.config?.gpt_link || ''
  useEffect(() => {
    if (dbGptLink) {
      setGptLink(dbGptLink)
    }
  }, [dbGptLink])

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text)
    toast.success(`Đã sao chép ${label}`)
  }

  const saveConfig = useMutation({
    mutationFn: async (newLink) => {
      await api.put('/ai-hermes/config', { gpt_link: newLink })
    },
    onSuccess: () => {
      toast.success('Đã lưu cấu hình Custom GPT thành công!')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
      setEditingGptLink(false)
    },
    onError: (err) => {
      toast.error(`Lỗi: ${err.response?.data?.error || err.message}`)
    }
  })

  const handleSaveGptLink = () => {
    saveConfig.mutate(gptLink)
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
      <div className="p-1 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 shadow-xl">
        {gptLink ? (
          <a
            href={gptLink}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-4 px-6 rounded-lg text-sm font-semibold text-black flex flex-col items-center justify-center gap-1 transition-all hover:opacity-90 text-center"
            style={{
              background: 'linear-gradient(135deg, #06b6d4 0%, #10b981 100%)',
              color: '#000',
              textDecoration: 'none',
              fontWeight: 'bold',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xl animate-bounce">🚀</span>
              <span>KẾT NỐI & ỦY QUYỀN CHATGPT NGAY (KÊNH CHÍNH THỨC)</span>
            </div>
            <span className="text-[10px] text-black/70 font-normal">Đăng nhập tài khoản Space Computer để Custom GPT bắt đầu hoạt động</span>
          </a>
        ) : (
          <a
            href="https://chatgpt.com"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-4 px-6 rounded-lg text-sm font-semibold text-black flex flex-col items-center justify-center gap-1 transition-all hover:opacity-90 text-center"
            style={{
              background: 'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)',
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 'bold',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xl animate-pulse">⚡</span>
              <span>⚡ MỞ CHATGPT & CẤU HÌNH CUSTOM GPT</span>
            </div>
            <span className="text-[10px] text-white/80 font-normal">Chưa dán link Custom GPT của bạn. Bấm để truy cập ChatGPT, tạo Custom GPT và dán link vào ô bên dưới!</span>
          </a>
        )}
      </div>

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
            {gptLink || <span className="italic text-app-muted/50">Chưa cấu hình link Custom GPT (Admin dán link Custom GPT của bạn sau khi tạo xong vào đây để lưu hệ thống cho mọi người dùng)</span>}
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
                  <button onClick={() => copyToClipboard(`${apiDomain}/oauth/authorize`, 'Authorization URL')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={`${apiDomain}/oauth/authorize`}
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-app-muted">Token URL</label>
                  <button onClick={() => copyToClipboard(`${apiDomain}/oauth/token`, 'Token URL')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={`${apiDomain}/oauth/token`}
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs font-mono-ui"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] uppercase text-hermes font-bold">Đường dẫn tự động Import OpenAPI Schema (CỰC NHANH)</label>
                  <button onClick={() => copyToClipboard(`${apiDomain}/oauth/openapi.json`, 'Schema Import URL')} className="text-[10px] text-hermes hover:underline">Copy</button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={`${apiDomain}/oauth/openapi.json`}
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

// FallbackSection has been consolidated into ModelSection Tab 3

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

const AUDIT_MODELS = [
  { id: 'nvidia:meta/llama-3.3-70b-instruct', name: 'NVIDIA Llama 3.3 70B (Khuyên dùng)', badge: 'NVIDIA' },
  { id: 'nvidia:nvidia/llama-3.1-nemotron-70b-instruct', name: 'NVIDIA Nemotron 70B (Đánh giá tốt)', badge: 'NVIDIA' },
  { id: 'nvidia:meta/llama-3.1-405b-instruct', name: 'NVIDIA Llama 3.1 405B (Chất lượng cao)', badge: 'NVIDIA' },
  { id: 'kimi:kimi-k2.6', name: 'Kimi K2.6 (Khuyên dùng - Cực mạnh tiếng Việt)', badge: 'Kimi' },
  { id: 'kimi:kimi-k2-thinking', name: 'Kimi K2 Thinking (Suy luận sâu)', badge: 'Kimi' },
  { id: 'kimi:kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo (Nhanh)', badge: 'Kimi' },
  { id: 'groq:llama-3.3-70b-versatile', name: 'Groq Llama 3.3 70B (Tốc độ nhanh)', badge: 'Groq' },
  { id: 'groq:qwen/qwen3-32b', name: 'Groq Qwen 3 32B', badge: 'Groq' },
  { id: 'nvidia:deepseek-ai/deepseek-r1', name: 'DeepSeek R1 via NVIDIA (Suy luận)', badge: 'Reasoning' },
  { id: 'deepseek:deepseek-reasoner', name: 'DeepSeek R1 Direct', badge: 'Reasoning' },
  { id: 'deepseek:deepseek-chat', name: 'DeepSeek V3', badge: 'DeepSeek' },
  { id: 'openrouter:anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', badge: 'Claude' },
  { id: 'openai:gpt-4o', name: 'GPT-4o (Đa dụng)', badge: 'OpenAI' },
  { id: 'gemini:gemini-2.5-pro-preview-05-06', name: 'Gemini 2.5 Pro', badge: 'Gemini' }
]

function WpAuditSection() {
  const qc = useQueryClient()
  const { data: cfgData, isLoading: isCfgLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })

  const cfg = cfgData?.config || {}

  // Multi-site WordPress config
  const [sites, setSites] = useState([])
  const [activeSiteIdx, setActiveSiteIdx] = useState(0)
  const [insideSiteIdx, setInsideSiteIdx] = useState(null)
  const [quickInput, setQuickInput] = useState('')
  const [quickScanning, setQuickScanning] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('wp_audit_selected_model') || 'kimi:kimi-k2-thinking'
  })

  // Google Analytics & Search Console states
  const [gscSiteUrl, setGscSiteUrl] = useState('')
  const [gscCredsJson, setGscCredsJson] = useState('')
  const [ga4PropertyId, setGa4PropertyId] = useState('')
  const [ga4CredsJson, setGa4CredsJson] = useState('')
  const [cacheHours, setCacheHours] = useState(24)

  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [jobId, setJobId] = useState(null)

  const triggerSync = async () => {
    setSyncing(true)
    setSyncStatus('Khởi chạy đồng bộ…')
    try {
      const res = await api.post('/ai-hermes/hermes/dashboard/sync')
      const jId = res.data.job_id
      setJobId(jId)
      pollSyncStatus(jId)
    } catch (err) {
      setSyncing(false)
      toast.error('Lỗi khởi chạy đồng bộ: ' + err.message)
    }
  }

  const pollSyncStatus = (jId) => {
    const timer = setInterval(async () => {
      try {
        const res = await api.get(`/ai-hermes/hermes/dashboard/sync/status/${jId}`)
        const data = res.data
        if (data.status === 'completed') {
          clearInterval(timer)
          setSyncing(false)
          setSyncStatus(null)
          toast.success('Đồng bộ Google Search Console & GA4 hoàn tất! 🎉')
          qc.invalidateQueries({ queryKey: ['hermes', 'dashboard'] })
        } else if (data.status === 'failed') {
          clearInterval(timer)
          setSyncing(false)
          setSyncStatus('Lỗi: ' + data.error)
          toast.error('Đồng bộ thất bại: ' + data.error)
        } else {
          setSyncStatus(`Đang đồng bộ (${data.progress}%)`)
        }
      } catch (err) {
        // Suppress network errors from breaking poll
      }
    }, 2000)
  }

  // Sync config from backend
  useEffect(() => {
    if (cfg && !isCfgLoading) {
      const existingSites = cfg.wp_sites || []
      // Backward compat: if no wp_sites but has wp_url, migrate
      if (existingSites.length === 0 && cfg.wp_url) {
        setSites([{ name: 'Default', url: cfg.wp_url, token: cfg.wp_token || '' }])
      } else {
        setSites(existingSites.length > 0 ? existingSites : [{ name: '', url: '', token: '' }])
      }
      setGscSiteUrl(cfg.gsc_site_url || '')
      setGscCredsJson(cfg.gsc_credentials_json || '')
      setGa4PropertyId(cfg.ga4_property_id || '')
      setGa4CredsJson(cfg.ga4_credentials_json || '')
      setCacheHours(cfg.analytics_cache_hours ?? 24)
    }
  }, [cfgData, isCfgLoading])

  const addSite = () => setSites(prev => [...prev, { name: '', url: '', token: '' }])
  const removeSite = (idx) => {
    setSites(prev => prev.filter((_, i) => i !== idx))
    if (activeSiteIdx >= sites.length - 1) setActiveSiteIdx(Math.max(0, sites.length - 2))
    if (insideSiteIdx === idx) setInsideSiteIdx(null)
  }
  const updateSite = (idx, field, value) => {
    setSites(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s))
  }

  const saveConfig = useMutation({
    mutationFn: async () => {
      const cleanSites = sites
        .filter(s => s.url?.trim())
        .map(s => ({
          name: (s.name || '').trim() || new URL(s.url.trim()).hostname,
          url: s.url.trim(),
          // Only send token if not masked
          ...(s.token && !s.token.includes('...') && s.token !== '***' ? { token: s.token.trim() } : {}),
        }))

      const payload = {
        wp_sites: cleanSites,
        gsc_site_url: gscSiteUrl.trim(),
        ga4_property_id: ga4PropertyId.trim(),
        analytics_cache_hours: Number(cacheHours) || 24
      }

      if (gscCredsJson && !gscCredsJson.includes('•')) {
        payload.gsc_credentials_json = gscCredsJson.trim()
      }
      if (ga4CredsJson && !ga4CredsJson.includes('•')) {
        payload.ga4_credentials_json = ga4CredsJson.trim()
      }

      await api.put('/ai-hermes/config', payload)
    },
    onSuccess: () => {
      toast.success('Đã lưu cấu hình thành công')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  // Testing connection state
  const [testingConnection, setTestingConnection] = useState(false)
  const testConnection = async (idx) => {
    setTestingConnection(true)
    try {
      const res = await api.get(`/ai-hermes/wp/posts?per_page=1&site_idx=${idx}`)
      if (res.data && res.data.posts) {
        toast.success(`Kết nối "${sites[idx]?.name || sites[idx]?.url}" thành công! 🚀`)
      } else {
        toast.error('Không thể tải bài viết từ WordPress')
      }
    } catch (err) {
      toast.error(`Kết nối lỗi: ${err.response?.data?.error || err.message}`)
    } finally {
      setTestingConnection(false)
    }
  }

  // Post List state
  const [posts, setPosts] = useState([])
  const [loadingPosts, setLoadingPosts] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [showAuditPopup, setShowAuditPopup] = useState(false)
  const [auditPopupData, setAuditPopupData] = useState(null)
  const [auditLoadingProgress, setAuditLoadingProgress] = useState(0)
  const [auditLoadingTitle, setAuditLoadingTitle] = useState('')

  const hasSites = sites.some(s => s.url?.trim())

  // Categories list
  const { data: catData, refetch: refetchCategories } = useQuery({
    queryKey: ['hermes', 'wp-categories', activeSiteIdx],
    queryFn: async () => (await api.get(`/ai-hermes/wp/categories?site_idx=${activeSiteIdx}`)).data,
    enabled: hasSites && insideSiteIdx !== null,
  })
  const categories = catData?.categories || []
  const [selectedCategory, setSelectedCategory] = useState('')

  const loadPosts = async (resetPage = false) => {
    if (insideSiteIdx === null) return
    setLoadingPosts(true)
    const nextPage = resetPage ? 1 : page
    try {
      const catParam = selectedCategory ? `&category_id=${selectedCategory}` : ''
      const res = await api.get(`/ai-hermes/wp/posts?page=${nextPage}&per_page=10&search=${encodeURIComponent(search)}${catParam}&site_idx=${activeSiteIdx}`)
      const fetched = res.data.posts || []
      
      if (resetPage) {
        setPosts(fetched)
      } else {
        setPosts(prev => [...prev, ...fetched])
      }
      
      setPage(nextPage + 1)
      setHasMore(fetched.length === 10)
    } catch (err) {
      toast.error(`Lỗi tải bài viết: ${err.response?.data?.error || err.message}`)
    } finally {
      setLoadingPosts(false)
    }
  }

  // Run initial load or when site/category changes
  useEffect(() => {
    if (hasSites && insideSiteIdx !== null) {
      loadPosts(true)
    }
  }, [selectedCategory, activeSiteIdx, insideSiteIdx])

  const startAuditProgressSim = (titleText) => {
    setAuditLoadingTitle(titleText)
    setAuditLoadingProgress(1)
    return setInterval(() => {
      setAuditLoadingProgress(prev => {
        if (prev < 4) return prev + 1
        return prev
      })
    }, 4500)
  }

  const handleQuickScan = async () => {
    if (!quickInput.trim()) return toast.error('Vui lòng nhập URL hoặc ID bài viết')
    setQuickScanning(true)
    let progressInterval = null
    try {
      const input = quickInput.trim()
      progressInterval = startAuditProgressSim(input)
      let postId = null
      let postInfo = null

      if (/^\d+$/.test(input)) {
        postId = parseInt(input)
        const res = await api.get(`/ai-hermes/wp/posts?page=1&per_page=1&site_idx=${activeSiteIdx}&search=${postId}`)
        if (res.data && res.data.posts && res.data.posts.length > 0) {
          postInfo = res.data.posts.find(p => p.id === postId)
        }
      } else {
        // Resolve URL or slug
        const res = await api.get(`/ai-hermes/wp/resolve?url=${encodeURIComponent(input)}&site_idx=${activeSiteIdx}`)
        if (res.data && res.data.post) {
          postId = res.data.post.id
          postInfo = res.data.post
        }
      }

      if (!postId) {
        throw new Error('Không tìm thấy bài viết tương ứng với URL/ID này')
      }

      // Run audit
      const auditRes = await api.post(`/ai-hermes/wp/audit/${postId}?site_idx=${activeSiteIdx}&model=${encodeURIComponent(selectedModel)}`)
      if (auditRes.data && auditRes.data.audit) {
        const auditData = { ...auditRes.data, post: postInfo || { id: postId } }
        try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(auditData)) } catch {}
        toast.success('Đã hoàn thành Audit bài viết! 📊')
        setAuditPopupData(auditData)
        setShowAuditPopup(true)
      } else {
        toast.error('Audit thất bại: Không nhận được kết quả phân tích')
      }
    } catch (err) {
      toast.error(`Quét nhanh lỗi: ${err.response?.data?.error || err.message}`)
    } finally {
      setQuickScanning(false)
      if (progressInterval) clearInterval(progressInterval)
      setAuditLoadingProgress(0)
    }
  }



  // Audit Results state
  const [auditResults, setAuditResults] = useState({})
  const [auditingId, setAuditingId] = useState(null)
  const [activeAuditId, setActiveAuditId] = useState(null)

  const nav = useNavigate()

  const runAudit = async (postId) => {
    setAuditingId(postId)
    let progressInterval = null
    try {
      const postInfo = posts.find(p => p.id === postId) || { id: postId }
      const postTitle = postInfo.title?.rendered || `ID: ${postId}`
      progressInterval = startAuditProgressSim(postTitle)
      const res = await api.post(`/ai-hermes/wp/audit/${postId}?site_idx=${activeSiteIdx}&model=${encodeURIComponent(selectedModel)}`)
      if (res.data && res.data.audit) {
        const auditData = { ...res.data, post: postInfo }
        setAuditResults(prev => ({ ...prev, [postId]: auditData }))
        // Save to sessionStorage for the audit result page
        try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(auditData)) } catch {}
        toast.success('Đã hoàn thành Audit bài viết! 📊')
        setAuditPopupData(auditData)
        setShowAuditPopup(true)
      } else {
        toast.error('Audit thất bại: Không nhận được kết quả phân tích')
      }
    } catch (err) {
      toast.error(`Lỗi Audit: ${err.response?.data?.error || err.message}`)
    } finally {
      setAuditingId(null)
      if (progressInterval) clearInterval(progressInterval)
      setAuditLoadingProgress(0)
    }
  }


  const handleCopy = (text, label) => {
    navigator.clipboard.writeText(text)
    toast.success(`Đã copy ${label}`)
  }

  const isAnyAuditing = auditingId !== null || quickScanning

  if (isCfgLoading) {
    return <div className="p-6 text-app-muted font-mono-ui text-xs">Đang tải cấu hình…</div>
  }

  return (
    <div className="p-6 font-mono-ui text-xs max-w-4xl space-y-6">
      <div>
        <h3 className="text-app-primary text-sm mb-1">WordPress Post Audit via REST API</h3>
        <p className="text-app-muted text-[11px]">Fetch các bài viết từ WordPress và tiến hành audit chất lượng SEO/GEO/Topic Cluster.</p>
      </div>

      {insideSiteIdx === null ? (
        // DASHBOARD VIEW: List of configured sites
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-app-primary font-bold text-xs uppercase tracking-wider flex items-center gap-1.5">
              <Globe className="w-4 h-4 text-hermes" /> WordPress Sites ({sites.filter(s => s.url?.trim()).length})
            </h4>
            <div className="flex gap-2">
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="btn-ghost px-3 py-1 text-xs font-semibold border border-border rounded flex items-center gap-1"
              >
                <Settings2 className="w-3.5 h-3.5" /> {showConfig ? 'Đóng cấu hình' : 'Quản lý sites'}
              </button>
              <button
                onClick={addSite}
                className="btn-hermes px-3 py-1 text-xs font-semibold rounded flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Thêm site
              </button>
            </div>
          </div>

          {/* Config Editor Panel (Toggled) */}
          {showConfig && (
            <div className="p-4 bg-app-elevated space-y-4 border border-border rounded">
              <div className="space-y-3">
                {sites.map((site, idx) => (
                  <div key={idx} className="p-3 bg-app-base border border-border rounded space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase text-app-muted font-bold">Site #{idx + 1}</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => testConnection(idx)}
                          disabled={testingConnection || !site.url}
                          className="text-[10px] text-hermes hover:underline font-semibold"
                        >
                          {testingConnection ? '...' : 'Test'}
                        </button>
                        {sites.length > 1 && (
                          <button
                            onClick={() => removeSite(idx)}
                            className="text-[10px] text-danger hover:underline font-semibold"
                          >
                            Xoá
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase text-app-dim mb-0.5">Tên</label>
                        <input
                          type="text"
                          value={site.name || ''}
                          onChange={(e) => updateSite(idx, 'name', e.target.value)}
                          placeholder="Tino Blog"
                          className="w-full px-2 py-1 bg-app-elevated border border-border text-app-primary rounded text-xs font-mono-ui"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase text-app-dim mb-0.5">Site URL</label>
                        <input
                          type="text"
                          value={site.url || ''}
                          onChange={(e) => updateSite(idx, 'url', e.target.value)}
                          placeholder="https://tino.vn/blog"
                          className="w-full px-2 py-1 bg-app-elevated border border-border text-app-primary rounded text-xs font-mono-ui"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase text-app-dim mb-0.5">
                          Token <span className="normal-case font-normal">(user:app_pass)</span>
                        </label>
                        <input
                          type="password"
                          value={site.token || ''}
                          onChange={(e) => updateSite(idx, 'token', e.target.value)}
                          placeholder="admin:xxxx xxxx xxxx"
                          className="w-full px-2 py-1 bg-app-elevated border border-border text-app-primary rounded text-xs"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    saveConfig.mutate()
                    setShowConfig(false)
                  }}
                  disabled={saveConfig.isPending}
                  className="btn-hermes px-4 py-1.5 text-xs font-semibold rounded"
                >
                  {saveConfig.isPending ? 'Đang lưu…' : 'Lưu tất cả'}
                </button>
                <span className="text-[10px] text-app-dim">
                  ℹ️ Tạo App Password tại WP Admin → Users → Application Passwords
                </span>
              </div>
            </div>
          )}

          {/* Grid of Site Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {sites.filter(s => s.url?.trim()).map((site, idx) => (
              <div
                key={idx}
                onClick={() => {
                  setActiveSiteIdx(idx)
                  setInsideSiteIdx(idx)
                }}
                className="p-4 bg-app-elevated border border-border hover:border-hermes/60 rounded cursor-pointer transition-all duration-150 group flex items-center justify-between"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base">🌐</span>
                    <span className="font-bold text-app-primary text-sm group-hover:text-hermes transition-colors truncate block">
                      {site.name || 'Default Site'}
                    </span>
                  </div>
                  <div className="text-app-muted text-[11px] font-mono-ui truncate max-w-xs">{site.url}</div>
                </div>
                <ChevronRight className="w-5 h-5 text-app-muted group-hover:text-hermes group-hover:translate-x-0.5 transition-all" />
              </div>
            ))}
            {sites.filter(s => s.url?.trim()).length === 0 && (
              <div className="col-span-2 text-center p-8 bg-app-elevated border border-dashed border-border rounded text-app-muted">
                Chưa có WordPress site nào được cấu hình. Hãy click "Quản lý sites" để cấu hình.
              </div>
            )}
          </div>

          {/* Google Analytics & Search Console Configuration Section */}
          <div className="p-4 bg-app-elevated border border-border rounded space-y-4 mt-6">
            <div className="flex items-center justify-between border-b border-border pb-2.5">
              <h4 className="font-bold text-app-primary text-xs uppercase tracking-wider flex items-center gap-1.5">
                📊 Cấu hình Google Search Console & GA4
              </h4>
              <button
                onClick={triggerSync}
                disabled={syncing || saveConfig.isPending}
                className="btn-hermes px-3 py-1.5 text-xs font-semibold rounded flex items-center gap-1.5"
              >
                {syncing ? (
                  <>
                    <Loader className="w-3.5 h-3.5 animate-spin" /> {syncStatus}
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" /> Đồng bộ ngay
                  </>
                )}
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GSC Site URL</label>
                <input
                  type="text"
                  value={gscSiteUrl}
                  onChange={(e) => setGscSiteUrl(e.target.value)}
                  placeholder="https://tino.vn/"
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded font-mono-ui text-xs"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GA4 Property ID</label>
                <input
                  type="text"
                  value={ga4PropertyId}
                  onChange={(e) => setGa4PropertyId(e.target.value)}
                  placeholder="123456789"
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded font-mono-ui text-xs"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GSC Credentials JSON (Service Account)</label>
                <textarea
                  value={gscCredsJson}
                  onChange={(e) => setGscCredsJson(e.target.value)}
                  placeholder='{"type": "service_account", ...}'
                  rows={4}
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded font-mono text-xs leading-normal"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GA4 Credentials JSON (Service Account)</label>
                <textarea
                  value={ga4CredsJson}
                  onChange={(e) => setGa4CredsJson(e.target.value)}
                  placeholder='{"type": "service_account", ...}'
                  rows={4}
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded font-mono text-xs leading-normal"
                />
              </div>
            </div>
            
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <button
                onClick={() => saveConfig.mutate()}
                disabled={saveConfig.isPending}
                className="btn-hermes px-4 py-1.5 text-xs font-semibold rounded"
              >
                {saveConfig.isPending ? 'Đang lưu…' : 'Lưu cấu hình Google'}
              </button>
              <span className="text-[10px] text-app-dim">
                ℹ️ Phải cấp quyền Service Account Email làm Viewer trong GA4 và Search Console.
              </span>
            </div>
          </div>
        </div>
      ) : (
        // INSIDE SITE VIEW: Load posts browser & quick URL scanning
        <div className="space-y-6">
          {/* Breadcrumb / Site Header */}
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setInsideSiteIdx(null)}
                className="btn-ghost p-1 border border-border rounded text-app-muted hover:text-app-primary"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h4 className="text-app-primary font-bold text-sm">
                  {sites[insideSiteIdx]?.name || 'WordPress Site'}
                </h4>
                <div className="text-app-dim text-[11px] font-mono-ui">{sites[insideSiteIdx]?.url}</div>
              </div>
            </div>
            <button
              onClick={() => testConnection(insideSiteIdx)}
              disabled={testingConnection}
              className="text-[11px] btn-ghost px-3 py-1 border border-border rounded text-app-primary font-semibold flex items-center gap-1"
            >
              {testingConnection ? <Loader className="w-3 h-3 animate-spin" /> : 'Test kết nối'}
            </button>
          </div>

          {/* Quick Scan / URL Input Section */}
          <div className="p-4 bg-app-elevated border border-border rounded space-y-3">
            <h5 className="font-bold text-app-primary text-xs uppercase tracking-wider flex items-center gap-1.5">
              🚀 Quét nhanh bài viết bằng URL hoặc ID
            </h5>
            <p className="text-app-muted text-[11px]">Dán link bài viết trực tiếp hoặc nhập ID từ WordPress để tiến hành audit ngay.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleQuickScan()}
                placeholder="Ví dụ: https://tino.vn/blog/api-model-ai/ hoặc 12345"
                className="flex-1 px-3 py-1.5 bg-app-base border border-border text-app-primary rounded font-mono-ui text-xs"
              />
              <button
                onClick={handleQuickScan}
                disabled={isAnyAuditing || !quickInput.trim()}
                className="btn-hermes px-4 py-1.5 text-xs font-semibold rounded flex items-center gap-1.5"
              >
                {quickScanning ? (
                  <>
                    <Loader className="w-3.5 h-3.5 animate-spin" /> Đang quét…
                  </>
                ) : (
                  'Quét ngay'
                )}
              </button>
            </div>
          </div>

          {/* Browser Section */}
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center justify-between">
              <h4 className="text-app-primary font-bold text-xs uppercase tracking-wider">🔍 Browse Posts từ WordPress</h4>
              <div className="flex gap-2 items-center">
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value)
                    localStorage.setItem('wp_audit_selected_model', e.target.value)
                  }}
                  className="px-2 py-1 bg-app-elevated border border-border text-app-primary rounded font-mono-ui text-xs"
                >
                  {AUDIT_MODELS.map(m => (
                    <option key={m.id} value={m.id}>🤖 {m.name}</option>
                  ))}
                </select>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="px-2 py-1 bg-app-elevated border border-border text-app-primary rounded font-mono-ui text-xs"
                >
                  <option value="">📂 Tất cả danh mục</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.count})</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    refetchCategories()
                    loadPosts(true)
                    toast.success('Đã tải lại danh mục & bài viết 🔄')
                  }}
                  className="btn-ghost p-1 border border-border rounded text-app-muted hover:text-app-primary"
                  title="Làm mới chủ đề & bài viết"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <div className="flex">

                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && loadPosts(true)}
                    placeholder="Tìm kiếm bài viết..."
                    className="px-2 py-1 bg-app-base border border-border text-app-primary w-48 rounded-l border-r-0 font-mono-ui text-xs"
                  />
                  <button
                    onClick={() => loadPosts(true)}
                    className="btn-hermes px-3 py-1 rounded-r text-xs border border-hermes font-semibold"
                  >
                    Tìm
                  </button>
                </div>
            </div>
          </div>




          <div className="border border-border rounded overflow-hidden">
            <div
              className="flex items-center gap-3 px-3 py-2 text-[10px] uppercase text-app-muted"
              style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}
            >
              <div className="w-12 text-center">ID</div>
              <div className="flex-1">Tiêu đề</div>
              <div className="w-48">Slug</div>
              <div className="w-32">Ngày đăng</div>
              <div className="w-24 text-center">Hành động</div>
            </div>

            {posts.length === 0 && !loadingPosts ? (
              <div className="p-6 text-center text-app-muted">Không tìm thấy bài viết nào</div>
            ) : (
              posts.map((post) => {
                const audited = auditResults[post.id]
                return (
                  <div key={post.id} className="border-b border-border last:border-0">
                    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-app-elevated/40">
                      <div className="w-12 text-center text-app-muted font-bold">{post.id}</div>
                      <div className="flex-1 min-w-0">
                        <a
                          href={post.link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-app-primary font-semibold hover:text-hermes truncate block"
                          dangerouslySetInnerHTML={{ __html: post.title?.rendered }}
                        />
                      </div>
                      <div className="w-48 truncate text-app-dim">{post.slug}</div>
                      <div className="w-32 text-app-muted">{new Date(post.date).toLocaleDateString('vi-VN')}</div>
                      <div className="w-24 text-center">
                        <button
                          onClick={() => {
                            if (audited) {
                              try { sessionStorage.setItem(`wp_audit_${post.id}`, JSON.stringify(audited)) } catch {}
                              nav(`/hermes/wp-audit/${post.id}`, { state: audited })
                            } else {
                              runAudit(post.id)
                            }
                          }}
                          disabled={isAnyAuditing}
                          className={`px-3 py-1 text-xs font-semibold rounded w-full ${
                            audited
                              ? 'border border-hermes text-hermes hover:bg-hermes/10'
                              : 'btn-hermes text-white'
                          }`}
                        >
                          {auditingId === post.id ? (
                            <Loader className="w-3 h-3 animate-spin mx-auto text-app-primary" />
                          ) : audited ? (
                            'Xem Audit'
                          ) : (
                            'Audit'
                          )}
                        </button>
                      </div>

                    </div>

                    {/* Audit result panel inside table row */}
                    {activeAuditId === post.id && audited && (
                      <div className="p-4 bg-app-base border-t border-border space-y-4">
                        <div className="flex justify-between items-center border-b border-border pb-2">
                          <div>
                            <span className="font-bold text-app-primary text-sm">📊 KẾT QUẢ AUDIT</span>
                            <span className="ml-3 text-[10px] px-2 py-0.5 rounded uppercase font-bold bg-hermes/20 text-hermes border border-hermes/30">
                              Type: {audited.audit.post_type}
                            </span>
                            {audited.audit.pillar_topic && (
                              <span className="ml-2 text-[10px] px-2 py-0.5 rounded bg-app-elevated border border-border text-app-primary">
                                Pillar Topic: {audited.audit.pillar_topic}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => setActiveAuditId(null)}
                            className="text-app-muted hover:text-app-primary font-semibold"
                          >
                            [Đóng Panel]
                          </button>
                        </div>

                        {/* Scores */}
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-center">
                          <div className="text-center p-3 bg-app-elevated border border-border rounded flex flex-col justify-center">
                            <span className="text-[10px] text-app-muted uppercase">Điểm tổng thể</span>
                            <span className="text-2xl font-bold text-hermes mt-1">{audited.audit.audit_score}/100</span>
                          </div>
                          <div className="col-span-4 grid grid-cols-2 md:grid-cols-4 gap-2">
                            {Object.entries(audited.audit.score_breakdown || {}).map(([key, val]) => (
                              <div key={key} className="p-2 bg-app-elevated/50 rounded border border-border">
                                <div className="text-[9px] uppercase text-app-muted">{key.replace('_', ' ')}</div>
                                <div className="flex items-center justify-between mt-1">
                                  <span className="font-bold text-app-primary">{val}/25</span>
                                  <span className="text-[9px] text-app-dim">{Math.round((val/25)*100)}%</span>
                                </div>
                                <div className="w-full bg-app-base h-1 mt-1 rounded-full overflow-hidden">
                                  <div className="bg-hermes h-full" style={{ width: `${(val/25)*100}%` }}></div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Critical Issues */}
                        <div className="space-y-2">
                          <div className="font-bold text-xs text-app-primary uppercase flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4 text-warn" /> Vấn đề nghiêm trọng ({audited.audit.critical_issues?.length || 0})
                          </div>
                          <div className="space-y-1.5">
                            {audited.audit.critical_issues?.map((issue, i) => (
                              <div
                                key={i}
                                className="p-2.5 rounded border border-l-4 space-y-1"
                                style={{
                                  background: 'var(--bg-elevated)',
                                  borderLeftColor: issue.severity === 'critical' ? 'var(--error)' : issue.severity === 'high' ? 'var(--warn)' : 'var(--info)'
                                }}
                              >
                                <div className="flex justify-between items-center text-[10px]">
                                  <span className="font-bold uppercase text-app-primary">
                                    [{issue.severity.toUpperCase()}] {issue.category} · <span className="text-app-muted">Location: {issue.location}</span>
                                  </span>
                                </div>
                                <div className="text-app-primary font-semibold text-xs">{issue.issue}</div>
                                <div className="text-app-muted text-[11px] leading-relaxed">👉 {issue.fix}</div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Suggestions */}
                        <div className="space-y-4">
                          <h5 className="font-bold text-xs text-app-primary uppercase border-b border-border pb-1">✏️ ĐỀ XUẤT CHỈNH SỬA & TỐI ƯU</h5>
                          
                          {/* Title / Meta Titles */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {audited.audit.suggestions?.title && (
                              <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                                <div className="flex justify-between items-center text-[10px] text-app-muted uppercase">
                                  <span>Tiêu đề đề xuất</span>
                                  <button
                                    onClick={() => handleCopy(audited.audit.suggestions.title, 'Tiêu đề đề xuất')}
                                    className="text-hermes hover:underline"
                                  >
                                    Copy
                                  </button>
                                </div>
                                <div className="text-app-primary font-bold text-xs">{audited.audit.suggestions.title}</div>
                              </div>
                            )}

                            {audited.audit.suggestions?.meta_title && (
                              <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                                <div className="flex justify-between items-center text-[10px] text-app-muted uppercase">
                                  <span>Meta Title mới</span>
                                  <button
                                    onClick={() => handleCopy(audited.audit.suggestions.meta_title, 'Meta Title mới')}
                                    className="text-hermes hover:underline"
                                  >
                                    Copy
                                  </button>
                                </div>
                                <div className="text-app-primary font-bold text-xs">{audited.audit.suggestions.meta_title}</div>
                              </div>
                            )}
                          </div>

                          {/* Meta Description */}
                          {audited.audit.suggestions?.meta_description && (
                            <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                              <div className="flex justify-between items-center text-[10px] text-app-muted uppercase">
                                <span>Meta Description mới</span>
                                <button
                                  onClick={() => handleCopy(audited.audit.suggestions.meta_description, 'Meta Description mới')}
                                  className="text-hermes hover:underline"
                                >
                                  Copy
                                </button>
                              </div>
                              <div className="text-app-primary text-xs leading-relaxed">{audited.audit.suggestions.meta_description}</div>
                            </div>
                          )}

                          {/* GEO Intro Paragraph */}
                          {audited.audit.suggestions?.intro_paragraph && (
                            <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                              <div className="flex justify-between items-center text-[10px] text-app-muted uppercase">
                                <span>Đoạn mở bài GEO-optimized (Direct Answer)</span>
                                <button
                                  onClick={() => handleCopy(audited.audit.suggestions.intro_paragraph, 'Mở bài')}
                                  className="text-hermes hover:underline"
                                >
                                  Copy
                                </button>
                              </div>
                              <div className="text-app-primary text-xs leading-relaxed italic">"{audited.audit.suggestions.intro_paragraph}"</div>
                            </div>
                          )}

                          {/* H2 Structure */}
                          {audited.audit.suggestions?.h2_structure && audited.audit.suggestions.h2_structure.length > 0 && (
                            <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                              <div className="flex justify-between items-center text-[10px] text-app-muted uppercase">
                                <span>Cấu trúc H2 đề xuất</span>
                                <button
                                  onClick={() => handleCopy(audited.audit.suggestions.h2_structure.join('\n'), 'Cấu trúc H2')}
                                  className="text-hermes hover:underline"
                                >
                                  Copy
                                </button>
                              </div>
                              <ul className="list-disc list-inside space-y-1 text-app-primary text-xs">
                                {audited.audit.suggestions.h2_structure.map((h, i) => (
                                  <li key={i}>{h}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* FAQ Block */}
                          {audited.audit.suggestions?.faq_block && audited.audit.suggestions.faq_block.length > 0 && (
                            <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                              <div className="flex justify-between items-center text-[10px] text-app-muted uppercase">
                                <span>FAQ Block đề xuất</span>
                                <button
                                  onClick={() => {
                                    const faqText = audited.audit.suggestions.faq_block.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')
                                    handleCopy(faqText, 'FAQ Block')
                                  }}
                                  className="text-hermes hover:underline"
                                >
                                  Copy toàn bộ
                                </button>
                              </div>
                              <div className="space-y-2.5 text-xs">
                                {audited.audit.suggestions.faq_block.map((faq, i) => (
                                  <div key={i} className="space-y-1">
                                    <div className="font-bold text-app-primary">Q: {faq.q}</div>
                                    <div className="text-app-muted">A: {faq.a}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Internal Links */}
                          {audited.audit.suggestions?.internal_links_to_add && audited.audit.suggestions.internal_links_to_add.length > 0 && (
                            <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                              <div className="text-[10px] text-app-muted uppercase">Internal Links cần thêm</div>
                              <div className="space-y-2 text-xs">
                                {audited.audit.suggestions.internal_links_to_add.map((l, i) => (
                                  <div key={i} className="flex items-start gap-1 justify-between">
                                    <div>
                                      <span className="font-bold text-app-primary">"{l.anchor}"</span>
                                      <span className="text-app-muted mx-1">→</span>
                                      <span className="text-app-dim italic">{l.note}</span>
                                    </div>
                                    <button
                                      onClick={() => handleCopy(l.anchor, 'Anchor text')}
                                      className="text-hermes hover:underline text-[10px]"
                                    >
                                      Copy Anchor
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Semantic keywords & entities */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {audited.audit.suggestions?.missing_entities && audited.audit.suggestions.missing_entities.length > 0 && (
                              <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                                <div className="text-[10px] text-app-muted uppercase">Entities còn thiếu</div>
                                <div className="flex flex-wrap gap-1.5">
                                  {audited.audit.suggestions.missing_entities.map((e, i) => (
                                    <span key={i} className="px-2 py-0.5 bg-app-base border border-border rounded text-[10px] text-app-primary">{e}</span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {audited.audit.suggestions?.missing_lsi_keywords && audited.audit.suggestions.missing_lsi_keywords.length > 0 && (
                              <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                                <div className="text-[10px] text-app-muted uppercase">LSI Keywords còn thiếu</div>
                                <div className="flex flex-wrap gap-1.5">
                                  {audited.audit.suggestions.missing_lsi_keywords.map((kw, i) => (
                                    <span key={i} className="px-2 py-0.5 bg-app-base border border-border rounded text-[10px] text-app-primary">{kw}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* New Cluster Posts Needed */}
                          {audited.audit.suggestions?.new_cluster_posts_needed && audited.audit.suggestions.new_cluster_posts_needed.length > 0 && (
                            <div className="p-3 bg-app-elevated rounded border border-border space-y-1.5">
                              <div className="text-[10px] text-app-muted uppercase">Bài viết cluster cần tạo thêm</div>
                              <ul className="list-disc list-inside space-y-1 text-xs text-app-primary">
                                {audited.audit.suggestions.new_cluster_posts_needed.map((p, i) => (
                                  <li key={i}>{p}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* GEO Quick wins */}
                          {audited.audit.geo_quick_wins && audited.audit.geo_quick_wins.length > 0 && (
                            <div className="p-3 rounded border border-hermes/30 bg-hermes/10 space-y-1.5">
                              <div className="text-[10px] text-hermes uppercase font-bold">🌟 GEO Quick Wins (Cải thiện nhanh)</div>
                              <ul className="list-decimal list-inside space-y-1 text-xs text-app-primary font-semibold">
                                {audited.audit.geo_quick_wins.map((w, i) => (
                                  <li key={i}>{w}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}

            {/* Pagination / Load more */}
            {posts.length > 0 && hasMore && (
              <div className="p-3 text-center border-t border-border">
                <button
                  onClick={() => loadPosts(false)}
                  disabled={loadingPosts}
                  className="btn-ghost px-4 py-1 text-xs font-semibold rounded border border-border"
                >
                  {loadingPosts ? 'Đang tải…' : 'Tải thêm bài viết'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )}

    {/* ─── AUDIT RUNNING LOADING POPUP MODAL ─── */}
    {isAnyAuditing && auditLoadingProgress > 0 && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(8px)' }}>
        <div 
          className="w-full max-w-md rounded-2xl p-6 md:p-8 space-y-6 shadow-2xl relative animate-in fade-in zoom-in duration-200 text-left border border-border"
          style={{ 
            background: 'var(--bg-surface)', 
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)'
          }}
        >
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-1 bg-hermes/10 border border-hermes/20">
              <Loader className="w-5 h-5 text-hermes animate-spin" />
            </div>
            <h3 className="text-base font-bold text-app-primary">Đang tiến hành Audit bài viết...</h3>
            <p 
              className="text-xs text-app-muted font-semibold line-clamp-2 max-w-sm mx-auto font-mono-ui"
              dangerouslySetInnerHTML={{ __html: auditLoadingTitle }}
            />
          </div>

          {/* Progress Steps List */}
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-3 text-xs">
              <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center font-bold ${
                auditLoadingProgress > 1 ? 'bg-green text-white' : auditLoadingProgress === 1 ? 'bg-hermes text-white animate-pulse' : 'bg-app-base border border-border text-app-muted'
              }`}>
                {auditLoadingProgress > 1 ? '✓' : '1'}
              </span>
              <span className={auditLoadingProgress === 1 ? 'text-hermes font-bold' : auditLoadingProgress > 1 ? 'text-app-muted line-through' : 'text-app-dim'}>
                📡 Đang kết nối WordPress & tải nội dung bài viết
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center font-bold ${
                auditLoadingProgress > 2 ? 'bg-green text-white' : auditLoadingProgress === 2 ? 'bg-hermes text-white animate-pulse' : 'bg-app-base border border-border text-app-muted'
              }`}>
                {auditLoadingProgress > 2 ? '✓' : '2'}
              </span>
              <span className={auditLoadingProgress === 2 ? 'text-hermes font-bold' : auditLoadingProgress > 2 ? 'text-app-muted line-through' : 'text-app-dim'}>
                🔍 Phân tích cấu trúc bài viết (H1, H2, Meta, Links)
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center font-bold ${
                auditLoadingProgress > 3 ? 'bg-green text-white' : auditLoadingProgress === 3 ? 'bg-hermes text-white animate-pulse' : 'bg-app-base border border-border text-app-muted'
              }`}>
                {auditLoadingProgress > 3 ? '✓' : '3'}
              </span>
              <span className={auditLoadingProgress === 3 ? 'text-hermes font-bold' : auditLoadingProgress > 3 ? 'text-app-muted line-through' : 'text-app-dim'}>
                🤖 Gửi dữ liệu cho AI chấm điểm (SEO, GEO & LSI Keywords)
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center font-bold ${
                auditLoadingProgress > 4 ? 'bg-green text-white' : auditLoadingProgress === 4 ? 'bg-hermes text-white animate-pulse' : 'bg-app-base border border-border text-app-muted'
              }`}>
                {auditLoadingProgress > 4 ? '✓' : '4'}
              </span>
              <span className={auditLoadingProgress === 4 ? 'text-hermes font-bold' : 'text-app-dim'}>
                📊 Tính toán điểm số thành phần & lưu kết quả
              </span>
            </div>
          </div>

          {/* Animated loading bar */}
          <div className="w-full bg-app-base h-1.5 rounded-full overflow-hidden relative">
            <div 
              className="h-full bg-hermes rounded-full transition-all duration-500" 
              style={{ width: `${(auditLoadingProgress / 4) * 100}%` }}
            ></div>
          </div>

          <div className="text-center text-[10px] text-app-muted font-mono-ui">
            Quá trình phân tích chuyên sâu có thể mất khoảng 15-25 giây. Vui lòng không đóng trang.
          </div>
        </div>
      </div>
    )}

    {/* ─── AUDIT COMPLETE POPUP MODAL ─── */}
    {showAuditPopup && auditPopupData && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(8px)' }}>
        <div 
          className="w-full max-w-lg rounded-2xl p-6 md:p-8 space-y-6 shadow-2xl relative animate-in fade-in zoom-in duration-200 text-left"
          style={{ 
            background: 'var(--bg-surface)', 
            border: '1px solid var(--border)',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
          }}
        >
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-2" style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}>
              <span className="text-2xl animate-bounce">🎉</span>
            </div>
            <h3 className="text-lg font-bold text-app-primary">Hoàn thành Audit bài viết!</h3>
            <p 
              className="text-xs text-app-muted font-semibold line-clamp-2 max-w-sm mx-auto"
              dangerouslySetInnerHTML={{ __html: auditPopupData.post?.title?.rendered }}
            />
            <span className="inline-block text-[10px] uppercase font-bold px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--hermes)' }}>
              ID: {auditPopupData.post_id} | Mode: {auditPopupData.audit?.post_type || 'cluster'}
            </span>
          </div>

          {/* Score Wheel Overview */}
          <div className="flex flex-col items-center justify-center py-2 space-y-2">
            <div className="relative w-28 h-28 flex items-center justify-center">
              {/* SVG Progress Circle */}
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 112 112">
                <circle cx="56" cy="56" r="48" fill="none" stroke="var(--border)" strokeWidth="6" />
                <circle 
                  cx="56" 
                  cy="56" 
                  r="48" 
                  fill="none" 
                  stroke={(auditPopupData.audit?.audit_score || 0) >= 70 ? '#22c55e' : (auditPopupData.audit?.audit_score || 0) >= 50 ? '#eab308' : '#ef4444'} 
                  strokeWidth="8" 
                  strokeDasharray={2 * Math.PI * 48}
                  strokeDashoffset={2 * Math.PI * 48 * (1 - (auditPopupData.audit?.audit_score || 0) / 100)}
                  strokeLinecap="round"
                  style={{ transition: 'stroke-dashoffset 1s ease-in-out' }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span className="text-3xl font-extrabold text-app-primary font-mono-ui" style={{ lineHeight: 1 }}>{auditPopupData.audit?.audit_score || 0}</span>
                <span className="text-[9px] uppercase tracking-wider text-app-dim font-bold mt-0.5">/100 Điểm</span>
              </div>
            </div>
          </div>

          {/* Breakdown progress rows */}
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(auditPopupData.audit?.score_breakdown || {}).map(([key, val]) => (
              <div key={key} className="p-2.5 rounded-xl border border-border" style={{ background: 'var(--bg-elevated)' }}>
                <div className="text-[9px] uppercase text-app-dim font-bold tracking-wider">{key.replace('_', ' ')}</div>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="font-mono-ui font-extrabold text-app-primary text-sm">{val}/25</span>
                  <span className="text-[9px] font-mono-ui text-app-muted">{Math.round((val/25)*100)}%</span>
                </div>
                <div className="w-full bg-app-base h-1.5 mt-1.5 rounded-full overflow-hidden">
                  <div 
                    className="h-full rounded-full" 
                    style={{ 
                      width: `${(val/25)*100}%`,
                      background: val >= 18 ? '#22c55e' : val >= 12 ? '#eab308' : '#ef4444'
                    }}
                  ></div>
                </div>
              </div>
            ))}
          </div>

          {/* Stats counts banner */}
          <div className="flex items-center justify-around p-3 rounded-xl border border-border text-center font-mono-ui text-[10px]" style={{ background: 'var(--bg-elevated)' }}>
            <div>
              <div className="text-app-dim uppercase font-bold">Vấn đề nghiêm trọng</div>
              <div className="text-sm font-extrabold mt-0.5" style={{ color: '#ef4444' }}>
                {auditPopupData.audit?.critical_issues?.length || 0}
              </div>
            </div>
            <div className="w-px h-6 bg-border"></div>
            <div>
              <div className="text-app-dim uppercase font-bold">GEO Quick Wins</div>
              <div className="text-sm font-extrabold mt-0.5 text-hermes">
                {auditPopupData.audit?.geo_quick_wins?.length || 0}
              </div>
            </div>
            <div className="w-px h-6 bg-border"></div>
            <div>
              <div className="text-app-dim uppercase font-bold">Entities / Keywords</div>
              <div className="text-sm font-extrabold mt-0.5 text-app-primary">
                {(auditPopupData.audit?.suggestions?.missing_entities?.length || 0) + (auditPopupData.audit?.suggestions?.missing_lsi_keywords?.length || 0)}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowAuditPopup(false)}
              className="flex-1 btn-ghost border border-border py-2 text-xs font-semibold rounded-xl text-app-primary"
            >
              Đóng
            </button>
            <button
              onClick={() => {
                setShowAuditPopup(false)
                nav(`/hermes/wp-audit/${auditPopupData.post_id}`, { state: auditPopupData })
              }}
              className="flex-1 btn-hermes py-2 text-xs font-semibold rounded-xl text-white flex items-center justify-center gap-1.5"
            >
              Xem Đánh Giá Chi Tiết 👉
            </button>
          </div>
        </div>
      </div>
    )}
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

export default function HermesSettings({ defaultSection }) {
  const [section, setSection] = useState(defaultSection || 'model')

  useEffect(() => {
    if (defaultSection && defaultSection !== 'wp_audit') {
      setSection(defaultSection)
    }
  }, [defaultSection])


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
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider overflow-x-auto whitespace-nowrap"
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
        {section === 'model'     && <ModelSection defaultSubTab="active" />}
        {section === 'oauth'     && <OauthSection />}
        {section === 'per_task'  && <PerTaskModelSection />}
        {section === 'agent_pw'  && <AgentPlaywrightSection />}
        {section === 'skills'    && <SkillsSection />}
        {section === 'quality'   && <QualityGateSection />}
        {section === 'fallback'  && <ModelSection defaultSubTab="fallback" />}
        {section === 'memory'    && <MemorySection />}
        {section === 'soul'      && <SoulSection />}
        {section === 'decisions' && <DecisionsSection />}
        {section === 'learning'  && <LearningSection />}
        {section === 'reports'   && <ReportsSection />}
      </div>
    </div>
  )
}
