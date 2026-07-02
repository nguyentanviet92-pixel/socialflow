import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { 
  Search, RefreshCw, AlertTriangle, ArrowRight, X, ExternalLink,
  ChevronLeft, ChevronRight, BarChart2, CheckCircle2, TrendingUp, Info, ArrowUpRight, Copy, Loader, Sliders,
  Globe, Plus, Settings2, Trash2, ArrowLeft, Send
} from 'lucide-react'
import { 
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip as ChartTooltip, ResponsiveContainer,
  LineChart, Line, Cell, Label
} from 'recharts'

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

export default function WpAuditDashboard() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const { pathname } = useLocation()

  // Sub-tabs: analytics | posts | config
  const [activeTab, setActiveTab] = useState(() => {
    if (pathname === '/hermes/wp-audit') return 'posts'
    return 'analytics'
  })

  useEffect(() => {
    if (pathname === '/hermes/wp-audit') {
      setActiveTab('posts')
    } else if (pathname === '/hermes/dashboard') {
      setActiveTab('analytics')
    }
  }, [pathname])

  // Common Configuration States
  const { data: cfgData, isLoading: isCfgLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })
  const cfg = cfgData?.config || {}
  const isGoogleConfigured = !!(cfg.gsc_site_url && cfg.gsc_credentials_json)

  // ----------------------------------------------------
  // SUB-TAB 1: SEO DASHBOARD STATES & QUERIES
  // ----------------------------------------------------
  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState('priority')
  const [filterGroup, setFilterGroup] = useState('all')
  const [analyticsPage, setAnalyticsPage] = useState(1)
  const analyticsLimit = 15

  const [selectedUrls, setSelectedUrls] = useState([])
  const [showCompareModal, setShowCompareModal] = useState(false)
  const [activeUrl, setActiveUrl] = useState(null)
  const [showDetailPanel, setShowDetailPanel] = useState(false)

  // Fetch overview
  const { data: overview, isLoading: isOverviewLoading, isRefetching: isOverviewRefetching, refetch: refetchOverview } = useQuery({
    queryKey: ['hermes', 'dashboard', 'overview', sortBy],
    queryFn: async () => {
      const res = await api.get(`/ai-hermes/dashboard/overview?sort_by=${sortBy}&limit=1000&page=1`)
      return res.data
    },
    enabled: isGoogleConfigured && activeTab === 'analytics',
  })

  // Synchronize Google Data
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState(null)
  const handleSync = async () => {
    setSyncing(true)
    setSyncProgress('Bắt đầu đồng bộ...')
    try {
      const res = await api.post('/ai-hermes/dashboard/sync')
      const jId = res.data.job_id
      const timer = setInterval(async () => {
        try {
          const statusRes = await api.get(`/ai-hermes/dashboard/sync/status/${jId}`)
          const status = statusRes.data
          if (status.status === 'completed') {
            clearInterval(timer)
            setSyncing(false)
            setSyncProgress(null)
            toast.success('Đồng bộ dữ liệu GSC + GA4 thành công! 🔄')
            refetchOverview()
          } else if (status.status === 'failed') {
            clearInterval(timer)
            setSyncing(false)
            setSyncProgress(null)
            toast.error(`Đồng bộ thất bại: ${status.error}`)
          } else {
            setSyncProgress(`Đang đồng bộ (${status.progress}%)`)
          }
        } catch {
          clearInterval(timer)
          setSyncing(false)
          setSyncProgress(null)
        }
      }, 2000)
    } catch (err) {
      setSyncing(false)
      setSyncProgress(null)
      toast.error('Lỗi khởi chạy đồng bộ: ' + err.message)
    }
  }

  // Filter & paginate analytics client-side
  const rawPages = overview?.pages || []
  const filteredPages = rawPages.filter(p => {
    const matchesSearch = p.page_title?.toLowerCase().includes(searchTerm.toLowerCase()) || p.url?.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesGroup = filterGroup === 'all' || p.opportunity_group === filterGroup
    return matchesSearch && matchesGroup
  })
  const paginatedPages = filteredPages.slice((analyticsPage - 1) * analyticsLimit, analyticsPage * analyticsLimit)
  const totalAnalyticsPages = Math.ceil(filteredPages.length / analyticsLimit)

  // Toggle selection
  const toggleSelectUrl = (url) => {
    setSelectedUrls(prev => 
      prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]
    )
  }

  // Active page detail query
  const { data: pageDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['hermes', 'dashboard', 'page', activeUrl],
    queryFn: async () => {
      const res = await api.get(`/ai-hermes/dashboard/page?url=${encodeURIComponent(activeUrl)}`)
      return res.data
    },
    enabled: !!activeUrl && showDetailPanel,
  })

  // Comparison query
  const { data: compareData, isLoading: isLoadingCompare } = useQuery({
    queryKey: ['hermes', 'dashboard', 'compare', selectedUrls],
    queryFn: async () => {
      const res = await api.post('/ai-hermes/dashboard/compare', { urls: selectedUrls })
      return res.data
    },
    enabled: selectedUrls.length > 0 && showCompareModal,
  })

  // Re-audit trigger
  const [auditingDetails, setAuditingDetails] = useState(false)
  const triggerReaudit = async (postId) => {
    if (!postId) return
    setAuditingDetails(true)
    toast.loading('Đang chạy lại audit...', { id: 'reaudit' })
    try {
      await api.post(`/ai-hermes/wp/audit/${postId}?force=true`)
      toast.success('Audit lại hoàn tất!', { id: 'reaudit' })
      setAuditingDetails(false)
      qc.invalidateQueries({ queryKey: ['hermes', 'dashboard', 'page', activeUrl] })
      refetchOverview()
    } catch (err) {
      toast.error('Audit lại thất bại: ' + err.message, { id: 'reaudit' })
      setAuditingDetails(false)
    }
  }

  // Format Helpers
  const formatPercent = (v) => `${(v * 100).toFixed(1)}%`
  const formatDuration = (s) => {
    const min = Math.floor(s / 60)
    const sec = s % 60
    return `${min}:${sec < 10 ? '0' : ''}${sec}`
  }

  // ----------------------------------------------------
  // SUB-TAB 2: POSTS BROWSER & AUDITING STATES
  // ----------------------------------------------------
  const [sites, setSites] = useState([])
  const [activeSiteIdx, setActiveSiteIdx] = useState(0)
  const [insideSiteIdx, setInsideSiteIdx] = useState(null)
  const [quickInput, setQuickInput] = useState('')
  const [quickScanning, setQuickScanning] = useState(false)
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('wp_audit_selected_model') || 'kimi:kimi-k2-thinking'
  })

  const [posts, setPosts] = useState([])
  const [loadingPosts, setLoadingPosts] = useState(false)
  const [postsSearch, setPostsSearch] = useState('')
  const [postsPage, setPostsPage] = useState(1)
  const [postsHasMore, setPostsHasMore] = useState(true)

  const [auditResults, setAuditResults] = useState({})
  const [auditingId, setAuditingId] = useState(null)
  const [auditLoadingProgress, setAuditLoadingProgress] = useState(0)
  const [auditLoadingTitle, setAuditLoadingTitle] = useState('')

  const hasSites = sites.some(s => s.url?.trim())

  // Categories list query
  const { data: catData, refetch: refetchCategories } = useQuery({
    queryKey: ['hermes', 'wp-categories', activeSiteIdx],
    queryFn: async () => (await api.get(`/ai-hermes/wp/categories?site_idx=${activeSiteIdx}`)).data,
    enabled: hasSites && insideSiteIdx !== null && activeTab === 'posts',
  })
  const categories = catData?.categories || []
  const [selectedCategory, setSelectedCategory] = useState('')

  // Sync sites list & default model from config schema
  useEffect(() => {
    if (cfg && !isCfgLoading) {
      const existingSites = cfg.wp_sites || []
      if (existingSites.length === 0 && cfg.wp_url) {
        setSites([{ name: 'Default', url: cfg.wp_url, token: cfg.wp_token || '' }])
      } else {
        setSites(existingSites.length > 0 ? existingSites : [{ name: '', url: '', token: '' }])
      }
      if (cfg.provider && cfg.model) {
        const configModelId = `${cfg.provider}:${cfg.model}`
        if (!localStorage.getItem('wp_audit_selected_model')) {
          setSelectedModel(configModelId)
        }
      }
    }
  }, [cfg, isCfgLoading])

  const loadPosts = async (resetPage = false) => {
    if (insideSiteIdx === null) return
    setLoadingPosts(true)
    const nextPage = resetPage ? 1 : postsPage
    try {
      const catParam = selectedCategory ? `&category_id=${selectedCategory}` : ''
      const res = await api.get(`/ai-hermes/wp/posts?page=${nextPage}&per_page=10&search=${encodeURIComponent(postsSearch)}${catParam}&site_idx=${activeSiteIdx}`)
      const fetched = res.data.posts || []
      if (resetPage) {
        setPosts(fetched)
      } else {
        setPosts(prev => [...prev, ...fetched])
      }
      setPostsPage(nextPage + 1)
      setPostsHasMore(fetched.length === 10)
    } catch (err) {
      toast.error(`Lỗi tải bài viết: ${err.response?.data?.error || err.message}`)
    } finally {
      setLoadingPosts(false)
    }
  }

  // Load posts on inside site change or category change
  useEffect(() => {
    if (hasSites && insideSiteIdx !== null && activeTab === 'posts') {
      loadPosts(true)
    }
  }, [selectedCategory, activeSiteIdx, insideSiteIdx, activeTab])

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
        try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(auditData)) } catch {}
        toast.success('Đã hoàn thành Audit bài viết! 📊')
        nav(`/hermes/wp-audit/${postId}`, { state: auditData })
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
        const res = await api.get(`/ai-hermes/wp/resolve?url=${encodeURIComponent(input)}&site_idx=${activeSiteIdx}`)
        if (res.data && res.data.post) {
          postId = res.data.post.id
          postInfo = res.data.post
        }
      }

      if (!postId) {
        throw new Error('Không tìm thấy bài viết tương ứng với URL/ID này')
      }

      const auditRes = await api.post(`/ai-hermes/wp/audit/${postId}?site_idx=${activeSiteIdx}&model=${encodeURIComponent(selectedModel)}`)
      if (auditRes.data && auditRes.data.audit) {
        const auditData = { ...auditRes.data, post: postInfo || { id: postId } }
        try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(auditData)) } catch {}
        toast.success('Đã hoàn thành Audit bài viết! 📊')
        nav(`/hermes/wp-audit/${postId}`, { state: auditData })
      } else {
        toast.error('Audit thất bại: Không nhận được kết quả')
      }
    } catch (err) {
      toast.error(`Quét nhanh lỗi: ${err.response?.data?.error || err.message}`)
    } finally {
      setQuickScanning(false)
      if (progressInterval) clearInterval(progressInterval)
      setAuditLoadingProgress(0)
    }
  }

  // ----------------------------------------------------
  // SUB-TAB 3: CONFIGURATION STATES
  // ----------------------------------------------------
  const [gscSiteUrl, setGscSiteUrl] = useState('')
  const [gscCredsJson, setGscCredsJson] = useState('')
  const [ga4PropertyId, setGa4PropertyId] = useState('')
  const [ga4CredsJson, setGa4CredsJson] = useState('')
  const [cacheHours, setCacheHours] = useState(24)

  useEffect(() => {
    if (cfg && !isCfgLoading) {
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
      toast.success('Đã lưu cấu hình API thành công')
      qc.invalidateQueries({ queryKey: ['hermes', 'config'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

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

  const isAnyAuditing = auditingId !== null || quickScanning
  const getOpportunityLabel = (group) => {
    switch (group) {
      case 'fix_gap': return '🔴 Fix gấp'
      case 'improve_content': return '🟠 Sửa Content'
      case 'promote': return '🟡 Tăng Quảng Bá'
      default: return '✅ Đang tốt'
    }
  }

  // Matrix Data mapping
  const matrixData = rawPages
    .filter(p => p.audit_score !== null)
    .map(p => ({
      name: p.page_title,
      url: p.url,
      x: p.audit_score,
      y: p.gsc_impressions || 0,
      z: p.gsc_clicks || 0,
      group: p.opportunity_group
    }))

  return (
    <div className="p-6 space-y-6 font-mono-ui min-h-full pb-20">
      
      {/* HEADER HUD BAR */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-app-primary text-xl font-bold flex items-center gap-2">
            🧠 SEO & WP Audit Central Hub
          </h2>
          <p className="text-app-muted text-xs mt-1">Nơi tập trung phân tích từ khóa, đo lường traffic và thực hiện Audit bài viết hàng loạt.</p>
        </div>
      </div>

      {/* SUB-TAB SELECTOR */}
      <div className="flex items-center gap-2 border-b border-border pb-px">
        {[
          { id: 'analytics', label: '📊 SEO Dashboard & Analytics' },
          { id: 'posts', label: '📝 Duyệt & Audit Bài Viết' },
          { id: 'config', label: '⚙️ Cấu hình API' }
        ].map(t => (
          <button
            key={t.id}
            onClick={() => {
              setActiveTab(t.id)
              if (t.id === 'posts') nav('/hermes/wp-audit')
              else if (t.id === 'analytics') nav('/hermes/dashboard')
            }}
            className={`px-4 py-2 text-xs font-bold border-b-2 transition-all ${
              activeTab === t.id 
                ? 'border-hermes text-hermes bg-hermes/5' 
                : 'border-transparent text-app-muted hover:text-app-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ----------------------------------------------------
          TAB 1: SEO DASHBOARD & ANALYTICS
          ---------------------------------------------------- */}
      {activeTab === 'analytics' && (
        <div className="space-y-6 animate-fadeIn">
          {!isGoogleConfigured ? (
            <div className="flex flex-col items-center justify-center p-12 text-center space-y-4 max-w-md mx-auto h-[40vh]">
              <AlertTriangle className="w-8 h-8 text-warn animate-bounce" />
              <div>
                <h4 className="text-app-primary font-bold">Chưa cấu hình kết nối Google API</h4>
                <p className="text-app-muted text-[11px] mt-1.5 leading-relaxed">
                  Vui lòng chuyển qua tab <strong>Cấu hình API</strong> bên cạnh để cài đặt Google Search Console & GA4 nhằm hiển thị số liệu Dashboard.
                </p>
              </div>
              <button onClick={() => setActiveTab('config')} className="btn-hermes px-4 py-2 text-xs font-semibold rounded-lg">
                Đi cấu hình ngay
              </button>
            </div>
          ) : (
            <>
              {/* Sync Actions Bar */}
              <div className="flex justify-between items-center bg-app-elevated border border-border p-3.5 rounded-xl">
                <span className="text-xs text-app-muted">Cập nhật lần cuối: {rawPages[0]?.fetched_at ? new Date(rawPages[0].fetched_at).toLocaleString('vi-VN') : 'Chưa đồng bộ'}</span>
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="btn-hermes px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-2"
                >
                  {syncing ? (
                    <>
                      <Loader className="w-3.5 h-3.5 animate-spin" /> {syncProgress}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" /> Đồng bộ dữ liệu GSC + GA4
                    </>
                  )}
                </button>
              </div>

              {/* Counts Banner */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { id: 'fix_gap', title: '🔴 Cần Fix gấp', count: overview?.group_totals?.fix_gap ?? 0, desc: 'Traffic cao + CTR thấp + Content yếu', border: 'border-l-4 border-l-red-500' },
                  { id: 'improve_content', title: '🟠 Sửa Content', count: overview?.group_totals?.improve_content ?? 0, desc: 'Traffic cao + CTR tốt + Content yếu', border: 'border-l-4 border-l-orange-500' },
                  { id: 'promote', title: '🟡 Tăng Quảng bá', count: overview?.group_totals?.promote ?? 0, desc: 'Nội dung tốt + Ít lượt hiển thị', border: 'border-l-4 border-l-yellow-500' },
                  { id: 'ok', title: '✅ Đang tốt', count: overview?.group_totals?.ok ?? 0, desc: 'Giữ vững hiệu suất tối ưu', border: 'border-l-4 border-l-green' }
                ].map(card => (
                  <div
                    key={card.id}
                    onClick={() => setFilterGroup(filterGroup === card.id ? 'all' : card.id)}
                    className={`p-4 bg-app-elevated border border-border rounded-xl cursor-pointer hover:border-hermes/40 transition-all ${card.border} ${filterGroup === card.id ? 'ring-1 ring-hermes' : ''}`}
                  >
                    <div className="text-[10px] text-app-dim uppercase font-bold tracking-wider">{card.title}</div>
                    <div className="text-3xl font-extrabold text-app-primary mt-1.5">{card.count}</div>
                    <div className="text-[10px] text-app-muted mt-1 leading-normal">{card.desc}</div>
                  </div>
                ))}
              </div>

              {/* Opportunity Matrix Scatter */}
              <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-3">
                <h4 className="text-xs uppercase tracking-wider text-app-primary font-bold">🎯 Ma trận Cơ hội Cải thiện (Opportunity Matrix)</h4>
                <div className="h-72 w-full pt-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                      <XAxis type="number" dataKey="x" name="Audit Score" domain={[0, 100]} stroke="var(--text-muted)" fontSize={10}>
                        <Label value="Điểm Audit →" offset={-10} position="insideBottom" fill="var(--text-muted)" fontSize={10} />
                      </XAxis>
                      <YAxis type="number" dataKey="y" name="Impressions" stroke="var(--text-muted)" fontSize={10}>
                        <Label value="Impressions ↑" angle={-90} position="insideLeft" fill="var(--text-muted)" fontSize={10} />
                      </YAxis>
                      <ZAxis type="number" dataKey="z" range={[40, 400]} name="Clicks" />
                      <ChartTooltip 
                        cursor={{ strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload
                            return (
                              <div className="p-3 bg-black border border-border rounded-lg font-mono-ui text-xs space-y-1">
                                <div className="font-bold text-app-primary">{data.name}</div>
                                <div className="text-app-muted text-[10px] truncate max-w-xs">{data.url}</div>
                                <div className="grid grid-cols-2 gap-x-4 pt-1 border-t border-border mt-1">
                                  <span className="text-app-muted">Audit:</span>
                                  <span className="text-app-primary text-right font-bold">{data.x}/100</span>
                                  <span className="text-app-muted">Impr:</span>
                                  <span className="text-app-primary text-right">{data.y.toLocaleString()}</span>
                                  <span className="text-app-muted">Clicks:</span>
                                  <span className="text-app-primary text-right">{data.z.toLocaleString()}</span>
                                </div>
                              </div>
                            )
                          }
                          return null
                        }}
                      />
                      <Scatter name="Pages" data={matrixData} onClick={(node) => {
                        setActiveUrl(node.url)
                        setShowDetailPanel(true)
                      }}>
                        {matrixData.map((entry, index) => {
                          let color = '#22c55e'
                          if (entry.group === 'fix_gap') color = '#ef4444'
                          else if (entry.group === 'improve_content') color = '#f97316'
                          else if (entry.group === 'promote') color = '#eab308'
                          return <Cell key={`cell-${index}`} fill={color} className="cursor-pointer" />
                        })}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Analytics Table */}
              <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1 max-w-md">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-app-muted" />
                      <input
                        type="text"
                        placeholder="Tìm kiếm tiêu đề hoặc URL..."
                        value={searchTerm}
                        onChange={(e) => {
                          setSearchTerm(e.target.value)
                          setAnalyticsPage(1)
                        }}
                        className="w-full pl-9 pr-4 py-2 bg-app-base border border-border text-app-primary rounded-lg text-xs"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {selectedUrls.length > 0 && (
                      <button onClick={() => setShowCompareModal(true)} className="btn-hermes px-4.5 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5">
                        <Sliders className="w-3.5 h-3.5" /> So sánh ({selectedUrls.length})
                      </button>
                    )}
                    <select
                      value={sortBy}
                      onChange={(e) => {
                        setSortBy(e.target.value)
                        setAnalyticsPage(1)
                      }}
                      className="px-2.5 py-1.5 bg-app-base border border-border text-app-primary rounded-lg text-xs font-mono-ui"
                    >
                      <option value="priority">🔥 Điểm Ưu Tiên</option>
                      <option value="impressions">👁️ Lượt Hiển Thị</option>
                      <option value="clicks">🖱️ Clicks</option>
                      <option value="audit_score">🧠 Điểm Audit</option>
                      <option value="position">📍 Thứ Hạng GSC</option>
                    </select>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono-ui border-collapse">
                    <thead>
                      <tr className="border-b border-border text-app-dim text-[10px] uppercase">
                        <th className="py-2.5 px-3 w-8"></th>
                        <th className="py-2.5 px-2">Page URL / Tiêu Đề</th>
                        <th className="py-2.5 px-2 text-center w-24">Điểm Audit</th>
                        <th className="py-2.5 px-2 text-right w-20">Impr</th>
                        <th className="py-2.5 px-2 text-right w-20">Clicks</th>
                        <th className="py-2.5 px-2 text-right w-20">CTR</th>
                        <th className="py-2.5 px-2 text-right w-16">Pos</th>
                        <th className="py-2.5 px-2 text-center w-28">Cơ Hội</th>
                      </tr>
                    </thead>
                    <tbody>
                      {isOverviewLoading ? (
                        <tr>
                          <td colSpan={8} className="py-12 text-center text-app-muted">Đang tải dữ liệu SEO Dashboard...</td>
                        </tr>
                      ) : paginatedPages.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-12 text-center text-app-muted">Không tìm thấy trang nào.</td>
                        </tr>
                      ) : (
                        paginatedPages.map((p) => {
                          const isChecked = selectedUrls.includes(p.url)
                          let scoreColor = 'text-danger'
                          if (p.audit_score >= 70) scoreColor = 'text-green'
                          else if (p.audit_score >= 50) scoreColor = 'text-warn'
                          return (
                            <tr key={p.url} className="border-b border-border/40 hover:bg-app-hover cursor-pointer">
                              <td className="py-3 px-3" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleSelectUrl(p.url)}
                                  disabled={selectedUrls.length >= 4 && !isChecked}
                                  className="rounded border-border text-hermes focus:ring-hermes"
                                />
                              </td>
                              <td className="py-3 px-2 min-w-0" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>
                                <div className="font-bold text-app-primary truncate max-w-sm md:max-w-md">{p.page_title}</div>
                                <div className="text-app-muted text-[10px] truncate max-w-sm md:max-w-md mt-0.5">{p.url}</div>
                              </td>
                              <td className="py-3 px-2 text-center font-bold" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>
                                <span className={p.audit_score !== null ? scoreColor : 'text-app-dim'}>
                                  {p.audit_score !== null ? `${p.audit_score}/100` : 'Chưa audit'}
                                </span>
                              </td>
                              <td className="py-3 px-2 text-right" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>{(p.gsc_impressions || 0).toLocaleString()}</td>
                              <td className="py-3 px-2 text-right" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>{(p.gsc_clicks || 0).toLocaleString()}</td>
                              <td className="py-3 px-2 text-right" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>{formatPercent(p.gsc_ctr || 0)}</td>
                              <td className="py-3 px-2 text-right font-bold text-app-primary" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>{(p.gsc_position || 0).toFixed(1)}</td>
                              <td className="py-3 px-2 text-center" onClick={() => { setActiveUrl(p.url); setShowDetailPanel(true) }}>
                                <span className={`px-2 py-0.5 text-[9px] font-bold rounded uppercase ${
                                  p.opportunity_group === 'fix_gap' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                                  p.opportunity_group === 'improve_content' ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' :
                                  p.opportunity_group === 'promote' ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' :
                                  'bg-green-500/10 text-green-400 border border-green-500/20'
                                }`}>
                                  {getOpportunityLabel(p.opportunity_group)}
                                </span>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {totalAnalyticsPages > 1 && (
                  <div className="flex items-center justify-between pt-4 border-t border-border/40">
                    <span className="text-[10px] text-app-dim">Hiển thị {paginatedPages.length} trên {filteredPages.length} trang</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setAnalyticsPage(p => Math.max(1, p - 1))} disabled={analyticsPage === 1} className="btn-ghost p-1.5 border border-border rounded text-app-muted hover:text-app-primary disabled:opacity-30">
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-xs px-3 py-1 font-bold bg-app-elevated border border-border text-app-primary rounded">{analyticsPage} / {totalAnalyticsPages}</span>
                      <button onClick={() => setAnalyticsPage(p => Math.min(totalAnalyticsPages, p + 1))} disabled={analyticsPage === totalAnalyticsPages} className="btn-ghost p-1.5 border border-border rounded text-app-muted hover:text-app-primary disabled:opacity-30">
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ----------------------------------------------------
          TAB 2: POSTS BROWSER (WP AUDIT MANAGER)
          ---------------------------------------------------- */}
      {activeTab === 'posts' && (
        <div className="space-y-6 animate-fadeIn">
          {insideSiteIdx === null ? (
            /* Choose WP Site view */
            <div className="space-y-4">
              <h4 className="text-app-primary font-bold text-xs uppercase tracking-wider flex items-center gap-1.5">
                🌐 Chọn WordPress Site để làm việc
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sites.filter(s => s.url?.trim()).map((site, idx) => (
                  <div
                    key={idx}
                    onClick={() => {
                      setActiveSiteIdx(idx)
                      setInsideSiteIdx(idx)
                    }}
                    className="p-4 bg-app-elevated border border-border hover:border-hermes rounded-xl cursor-pointer flex items-center justify-between group transition-all"
                  >
                    <div>
                      <div className="font-bold text-app-primary group-hover:text-hermes transition-colors text-sm">{site.name || 'Default Site'}</div>
                      <div className="text-[10px] text-app-dim mt-1 font-mono">{site.url}</div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-app-muted group-hover:text-hermes group-hover:translate-x-1 transition-all" />
                  </div>
                ))}
                {sites.filter(s => s.url?.trim()).length === 0 && (
                  <div className="col-span-2 text-center p-8 bg-app-elevated border border-dashed border-border rounded-xl text-app-muted">
                    Chưa cấu hình WordPress site nào. Hãy sang tab <strong>Cấu hình API</strong> để cấu hình site của bạn.
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Inside post list manager */
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div className="flex items-center gap-3">
                  <button onClick={() => setInsideSiteIdx(null)} className="btn-ghost p-1.5 border border-border rounded-lg text-app-muted hover:text-app-primary">
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div>
                    <h4 className="text-app-primary font-bold text-sm">{sites[insideSiteIdx]?.name}</h4>
                    <div className="text-app-dim text-[10px] font-mono">{sites[insideSiteIdx]?.url}</div>
                  </div>
                </div>
                <button onClick={() => testConnection(insideSiteIdx)} disabled={testingConnection} className="btn-ghost px-3 py-1.5 border border-border rounded-lg text-xs text-app-primary font-bold flex items-center gap-1.5">
                  {testingConnection ? <Loader className="w-3.5 h-3.5 animate-spin" /> : 'Test kết nối'}
                </button>
              </div>

              {/* Quick Scan */}
              <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-3">
                <h5 className="font-bold text-app-primary text-xs uppercase tracking-wider flex items-center gap-1.5">🚀 Quét nhanh bằng URL hoặc ID bài viết</h5>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={quickInput}
                    onChange={(e) => setQuickInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleQuickScan()}
                    placeholder="Dán link bài viết hoặc ID từ WordPress..."
                    className="flex-1 px-3 py-1.5 bg-app-base border border-border text-app-primary rounded-lg text-xs"
                  />
                  <button onClick={handleQuickScan} disabled={isAnyAuditing || !quickInput.trim()} className="btn-hermes px-4 py-1.5 text-xs font-semibold rounded-lg">
                    {quickScanning ? 'Đang quét...' : 'Quét ngay'}
                  </button>
                </div>
              </div>

              {/* Browser and Filters */}
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-app-primary font-bold text-xs uppercase tracking-wider">🔍 Duyệt bài viết từ WordPress</h4>
                  <div className="flex flex-wrap gap-2 items-center">
                    {(() => {
                      const configModelId = cfg.provider && cfg.model ? `${cfg.provider}:${cfg.model}` : null
                      const modelOptions = [...AUDIT_MODELS]
                      if (configModelId && !modelOptions.some(m => m.id === configModelId)) {
                        modelOptions.unshift({ id: configModelId, name: `Cấu hình mặc định (${cfg.provider}/${cfg.model})` })
                      }
                      return (
                        <select
                          value={selectedModel}
                          onChange={(e) => {
                            setSelectedModel(e.target.value)
                            localStorage.setItem('wp_audit_selected_model', e.target.value)
                          }}
                          className="px-2 py-1.5 bg-app-base border border-border text-app-primary rounded-lg text-xs"
                        >
                          {modelOptions.map(m => (
                            <option key={m.id} value={m.id}>🤖 {m.name}</option>
                          ))}
                        </select>
                      )
                    })()}

                    <select
                      value={selectedCategory}
                      onChange={(e) => setSelectedCategory(e.target.value)}
                      className="px-2 py-1.5 bg-app-base border border-border text-app-primary rounded-lg text-xs"
                    >
                      <option value="">📂 Tất cả danh mục</option>
                      {categories.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.count})</option>
                      ))}
                    </select>

                    <div className="flex">
                      <input
                        type="text"
                        value={postsSearch}
                        onChange={(e) => setPostsSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadPosts(true)}
                        placeholder="Tìm bài viết..."
                        className="px-3 py-1.5 bg-app-base border border-border text-app-primary rounded-l-lg text-xs border-r-0"
                      />
                      <button onClick={() => loadPosts(true)} className="btn-hermes px-3 py-1.5 rounded-r-lg text-xs font-semibold">Tìm</button>
                    </div>
                  </div>
                </div>

                {/* Table */}
                <div className="border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-app-elevated border-b border-border text-app-dim text-[10px] uppercase font-bold">
                        <th className="py-2.5 px-4 text-center w-16">ID</th>
                        <th className="py-2.5 px-3">Tiêu đề bài viết</th>
                        <th className="py-2.5 px-3 w-48">Slug</th>
                        <th className="py-2.5 px-3 w-32">Ngày Đăng</th>
                        <th className="py-2.5 px-4 text-center w-28">Hành động</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingPosts && posts.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-12 text-center text-app-muted">Đang tải bài viết từ WordPress...</td>
                        </tr>
                      ) : posts.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-12 text-center text-app-muted">Không tìm thấy bài viết nào.</td>
                        </tr>
                      ) : (
                        posts.map((post) => {
                          const audited = auditResults[post.id]
                          return (
                            <tr key={post.id} className="border-b border-border/40 hover:bg-app-hover">
                              <td className="py-3 px-4 text-center text-app-muted font-bold font-mono">{post.id}</td>
                              <td className="py-3 px-3">
                                <a href={post.link} target="_blank" rel="noreferrer" className="text-app-primary font-bold hover:text-hermes truncate block max-w-md" dangerouslySetInnerHTML={{ __html: post.title?.rendered }} />
                              </td>
                              <td className="py-3 px-3 text-app-dim truncate max-w-[150px] font-mono">{post.slug}</td>
                              <td className="py-3 px-3 text-app-muted">{new Date(post.date).toLocaleDateString('vi-VN')}</td>
                              <td className="py-3 px-4 text-center">
                                <button
                                  onClick={() => {
                                    if (audited) {
                                      nav(`/hermes/wp-audit/${post.id}`, { state: audited })
                                    } else {
                                      runAudit(post.id)
                                    }
                                  }}
                                  disabled={isAnyAuditing}
                                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg w-full ${
                                    audited
                                      ? 'border border-hermes text-hermes hover:bg-hermes/15'
                                      : 'btn-hermes text-white'
                                  }`}
                                >
                                  {auditingId === post.id ? (
                                    <Loader className="w-3.5 h-3.5 animate-spin mx-auto" />
                                  ) : audited ? (
                                    'Xem Audit'
                                  ) : (
                                    'Audit AI'
                                  )}
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Load more */}
                {postsHasMore && (
                  <div className="text-center pt-2">
                    <button onClick={() => loadPosts()} disabled={loadingPosts} className="btn-ghost border border-border px-6 py-2 rounded-lg text-xs text-app-primary font-bold">
                      {loadingPosts ? <Loader className="w-4 h-4 animate-spin mx-auto" /> : 'Tải thêm bài viết ⬇️'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ----------------------------------------------------
          TAB 3: CONFIGURATION SETTINGS
          ---------------------------------------------------- */}
      {activeTab === 'config' && (
        <div className="space-y-6 animate-fadeIn max-w-4xl">
          {/* WordPress configuration section */}
          <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-4">
            <h4 className="font-bold text-app-primary text-xs uppercase tracking-wider flex items-center justify-between border-b border-border pb-2.5">
              <span>🌐 Danh sách WordPress Sites</span>
              <button onClick={addSite} className="btn-hermes px-3 py-1 text-xs font-bold rounded-lg flex items-center gap-1">
                <Plus className="w-3 h-3" /> Thêm Site mới
              </button>
            </h4>

            <div className="space-y-3.5">
              {sites.map((site, idx) => (
                <div key={idx} className="p-4 bg-app-base border border-border rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase text-app-dim font-bold">WordPress Site #{idx + 1}</span>
                    <div className="flex items-center gap-3">
                      <button onClick={() => testConnection(idx)} disabled={testingConnection || !site.url} className="text-[10px] text-hermes hover:underline font-bold">Test kết nối</button>
                      {sites.length > 1 && (
                        <button onClick={() => removeSite(idx)} className="text-[10px] text-danger hover:underline font-bold flex items-center gap-0.5"><Trash2 className="w-3 h-3" /> Xoá</button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">Tên gợi nhớ</label>
                      <input type="text" value={site.name || ''} onChange={(e) => updateSite(idx, 'name', e.target.value)} placeholder="Tino Blog" className="w-full px-3 py-1.5 bg-app-elevated border border-border text-app-primary rounded-lg text-xs" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">Địa chỉ Site URL</label>
                      <input type="text" value={site.url || ''} onChange={(e) => updateSite(idx, 'url', e.target.value)} placeholder="https://tino.vn/blog" className="w-full px-3 py-1.5 bg-app-elevated border border-border text-app-primary rounded-lg text-xs font-mono" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">Application Password</label>
                      <input type="password" value={site.token || ''} onChange={(e) => updateSite(idx, 'token', e.target.value)} placeholder="admin:xxxx xxxx xxxx" className="w-full px-3 py-1.5 bg-app-elevated border border-border text-app-primary rounded-lg text-xs" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Google Analytics & Search Console Configuration Section */}
          <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-4">
            <h4 className="font-bold text-app-primary text-xs uppercase border-b border-border pb-2.5 tracking-wider">
              📊 Kết nối Google Search Console & GA4
            </h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GSC Site URL (phải khớp trên Search Console)</label>
                <input
                  type="text"
                  value={gscSiteUrl}
                  onChange={(e) => setGscSiteUrl(e.target.value)}
                  placeholder="https://tino.vn/"
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded-lg font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GA4 Property ID (Mã tài sản GA4)</label>
                <input
                  type="text"
                  value={ga4PropertyId}
                  onChange={(e) => setGa4PropertyId(e.target.value)}
                  placeholder="123456789"
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded-lg font-mono text-xs"
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
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded-lg font-mono text-xs leading-normal"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-app-dim mb-1 font-bold">GA4 Credentials JSON (Service Account)</label>
                <textarea
                  value={ga4CredsJson}
                  onChange={(e) => setGa4CredsJson(e.target.value)}
                  placeholder='{"type": "service_account", ...}'
                  rows={4}
                  className="w-full px-3 py-1.5 bg-app-base border border-border text-app-primary rounded-lg font-mono text-xs leading-normal"
                />
              </div>
            </div>
          </div>

          {/* Action Footer */}
          <div className="flex items-center justify-between bg-app-elevated border border-border p-3.5 rounded-xl">
            <button
              onClick={() => saveConfig.mutate()}
              disabled={saveConfig.isPending}
              className="btn-hermes px-5 py-2.5 text-xs font-bold rounded-lg"
            >
              {saveConfig.isPending ? 'Đang lưu cấu hình...' : 'Lưu tất cả Cấu hình 💾'}
            </button>
            <span className="text-[10px] text-app-dim">
              ℹ️ Hãy cấp quyền email của Service Account làm Viewer trên Google Search Console & GA4.
            </span>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------
          POPUP LOADER FOR AUDIT PROGRESS (COMMON)
          ---------------------------------------------------- */}
      {isAnyAuditing && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm font-mono">
          <div className="bg-app-elevated border border-border p-6 rounded-2xl max-w-sm w-full space-y-4 text-center">
            <Loader className="w-8 h-8 text-hermes animate-spin mx-auto" />
            <div>
              <div className="text-app-primary font-bold text-xs uppercase tracking-wider">Đang tiến hành AI Audit</div>
              <div className="text-app-muted text-[10px] truncate max-w-xs mt-1 italic font-bold">"{auditLoadingTitle}"</div>
            </div>
            {/* Steps */}
            <div className="space-y-1 text-left text-[11px] border-t border-border pt-3">
              <div className={auditLoadingProgress >= 1 ? 'text-green font-bold' : 'text-app-dim'}>✓ [Bước 1/4] Tải nội dung bài viết từ WordPress REST API</div>
              <div className={auditLoadingProgress >= 2 ? 'text-green font-bold' : 'text-app-dim'}>
                {auditLoadingProgress === 1 ? '⚙️ [Bước 2/4] LLM phân tích GEO & cấu trúc SEO On-page...' : '✓ [Bước 2/4] LLM phân tích GEO & cấu trúc SEO On-page'}
              </div>
              <div className={auditLoadingProgress >= 3 ? 'text-green font-bold' : 'text-app-dim'}>
                {auditLoadingProgress === 2 ? '⚙️ [Bước 3/4] LLM phân tích LSI keywords & entities...' : auditLoadingProgress > 2 ? '✓ [Bước 3/4] LLM phân tích LSI keywords & entities' : '⌛ [Bước 3/4] Chờ phân tích LSI keywords & entities'}
              </div>
              <div className={auditLoadingProgress >= 4 ? 'text-green font-bold' : 'text-app-dim'}>
                {auditLoadingProgress === 3 ? '⚙️ [Bước 4/4] LLM tổng hợp các liên kết & điểm số cuối...' : auditLoadingProgress > 3 ? '✓ [Bước 4/4] Hoàn thành!' : '⌛ [Bước 4/4] Chờ tổng hợp liên kết & điểm số'}
              </div>
            </div>
            <p className="text-[9px] text-app-dim">Quá trình phân tích chuyên sâu có thể mất từ 15-30 giây tùy theo độ dài bài viết.</p>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------
          PAGE DETAILS SLIDE-OVER PANEL (COMMON)
          ---------------------------------------------------- */}
      {showDetailPanel && (
        <div className="fixed inset-0 z-50 overflow-hidden font-mono-ui">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowDetailPanel(false)} />
          <div className="absolute inset-y-0 right-0 w-full max-w-[480px] bg-black border-l border-border shadow-2xl flex flex-col h-full z-50">
            <div className="p-4 border-b border-border flex items-center justify-between bg-app-elevated">
              <div className="min-w-0 flex-1 pr-4">
                <div className="text-[9px] uppercase tracking-wider text-app-muted font-bold flex items-center gap-1.5">
                  📄 Chi tiết trang tối ưu
                  {pageDetails?.audit_score !== null && pageDetails?.audit_score !== undefined && (
                    <span className="px-1.5 py-0.5 bg-hermes-dim text-hermes rounded text-[8px]">
                      {pageDetails?.audit_score}/100
                    </span>
                  )}
                </div>
                <h3 className="text-app-primary text-sm font-bold truncate mt-1">{pageDetails?.page?.page_title}</h3>
              </div>
              <button onClick={() => setShowDetailPanel(false)} className="p-1.5 border border-border rounded-lg text-app-muted hover:text-app-primary hover:bg-app-hover">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {isLoadingDetails ? (
                <div className="text-center py-20 text-app-muted text-xs">Đang tải phân tích chi tiết trang...</div>
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">Impressions</div>
                      <div className="text-sm font-bold text-app-primary mt-1">{(pageDetails?.page?.gsc_impressions ?? 0).toLocaleString()}</div>
                    </div>
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">Clicks</div>
                      <div className="text-sm font-bold text-app-primary mt-1">{(pageDetails?.page?.gsc_clicks ?? 0).toLocaleString()}</div>
                    </div>
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">CTR</div>
                      <div className="text-sm font-bold text-app-primary mt-1">{formatPercent(pageDetails?.page?.gsc_ctr ?? 0)}</div>
                    </div>
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">Vị trí</div>
                      <div className="text-sm font-bold text-hermes mt-1">{(pageDetails?.page?.gsc_position ?? 0).toFixed(1)}</div>
                    </div>
                  </div>

                  {/* LINE CHART SCORE HISTORY */}
                  <div className="p-3.5 bg-app-elevated border border-border rounded-xl space-y-2.5">
                    <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider flex items-center gap-1.5">📈 Lịch sử điểm số Audit</h5>
                    {pageDetails?.history?.length > 1 ? (
                      <div className="h-20 w-full pt-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={pageDetails.history}>
                            <Line type="monotone" dataKey="score" stroke="var(--hermes)" strokeWidth={2} dot={{ r: 4, stroke: 'black', strokeWidth: 1 }} />
                          </LineChart>
                        </ResponsiveContainer>
                        <div className="flex justify-between text-[8px] text-app-dim mt-1.5 font-bold">
                          <span>{pageDetails.history[0].date} ({pageDetails.history[0].score})</span>
                          <span>{pageDetails.history[pageDetails.history.length - 1].date} ({pageDetails.history[pageDetails.history.length - 1].score})</span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[10px] text-app-dim">Chưa có đủ lịch sử dữ liệu (cần ít nhất 2 phiên audit để vẽ biểu đồ).</p>
                    )}
                  </div>

                  {/* TOP QUERIES TABLE */}
                  <div className="space-y-2.5">
                    <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider flex items-center gap-1.5 font-mono">🔎 Từ khóa thực tế (GSC Queries)</h5>
                    <div className="bg-app-elevated border border-border rounded-xl overflow-hidden">
                      <table className="w-full text-left text-[11px]">
                        <thead>
                          <tr className="bg-app-hover border-b border-border text-app-dim text-[8px] uppercase">
                            <th className="py-2 px-3">Từ khóa (Query)</th>
                            <th className="py-2 px-2 text-right w-16">Clicks</th>
                            <th className="py-2 px-2 text-right w-16">Impr</th>
                            <th className="py-2 px-2 text-right w-16">Vị trí</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageDetails?.page?.gsc_top_queries?.map((q, idx) => (
                            <tr key={idx} className="border-b border-border/40 hover:bg-app-hover">
                              <td className="py-2.5 px-3 text-app-primary truncate font-bold">{q.keys?.[0] || q.query}</td>
                              <td className="py-2.5 px-2 text-right">{(q.clicks || 0).toLocaleString()}</td>
                              <td className="py-2.5 px-2 text-right">{(q.impressions || 0).toLocaleString()}</td>
                              <td className="py-2.5 px-2 text-right text-hermes font-bold">{(q.position || 0).toFixed(1)}</td>
                            </tr>
                          ))}
                          {(!pageDetails?.page?.gsc_top_queries || pageDetails.page.gsc_top_queries.length === 0) && (
                            <tr>
                              <td colSpan={4} className="py-4 text-center text-app-muted text-[10px]">Chưa có dữ liệu từ khóa cho trang này.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* GA4 USER BEHAVIOR */}
                  <div className="p-3.5 bg-app-elevated border border-border rounded-xl space-y-2.5">
                    <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider flex items-center gap-1.5">⏱️ Hành vi người dùng (GA4)</h5>
                    <div className="grid grid-cols-2 gap-4 text-center">
                      <div>
                        <div className="text-[9px] text-app-dim uppercase">Thời gian đọc trung bình</div>
                        <div className="text-lg font-bold text-app-primary mt-1">
                          {formatDuration(pageDetails?.page?.ga4_avg_time_sec ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] text-app-dim uppercase">Tỷ lệ thoát (Bounce Rate)</div>
                        <div className="text-lg font-bold text-app-primary mt-1">
                          {formatPercent(pageDetails?.page?.ga4_bounce_rate ?? 0)}
                        </div>
                      </div>
                    </div>
                    {pageDetails?.page?.ga4_bounce_rate > 0.60 && (
                      <div className="p-2.5 bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 rounded-lg flex items-start gap-1.5 leading-normal">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span><strong>Tỷ lệ thoát 60% khá cao:</strong> Có thể đoạn mở bài chưa thu hút hoặc không cung cấp đúng câu trả lời trực tiếp. Hãy bổ sung GEO direct answer.</span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="p-4 border-t border-border flex gap-3 bg-app-elevated">
              {pageDetails?.page?.post_id ? (
                <>
                  <button
                    onClick={() => triggerReaudit(pageDetails.page.post_id)}
                    disabled={auditingDetails}
                    className="flex-1 btn-ghost border border-border text-app-primary font-bold text-xs py-2.5 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    {auditingDetails ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Quét Lại (Re-audit)
                  </button>
                  <button
                    onClick={() => nav(`/hermes/wp-audit/${pageDetails.page.post_id}`)}
                    className="flex-1 btn-hermes text-white font-bold text-xs py-2.5 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    Đến Trang Audit Chi Tiết <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <div className="w-full text-center py-2 text-[10px] text-app-dim">
                  Trang này chưa được liên kết với bài viết nào trên hệ thống WordPress. Hãy tạo bài viết mới hoặc audit link này trong cài đặt.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------
          COMPARISON MODAL (COMMON)
          ---------------------------------------------------- */}
      {showCompareModal && (
        <div className="fixed inset-0 z-50 overflow-auto flex items-center justify-center p-4 font-mono-ui">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowCompareModal(false)} />
          <div className="bg-black border border-border rounded-xl shadow-2xl w-full max-w-4xl z-50 overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-4 border-b border-border flex justify-between items-center bg-app-elevated">
              <div>
                <h3 className="text-app-primary font-bold text-sm">Comparison View</h3>
                <p className="text-[10px] text-app-muted mt-0.5">So sánh chi tiết đối chiếu hiệu suất tối ưu side-by-side.</p>
              </div>
              <button onClick={() => setShowCompareModal(false)} className="p-1 border border-border rounded text-app-muted hover:text-app-primary">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {isLoadingCompare ? (
                <div className="text-center py-16 text-app-muted text-xs">Đang tải đối chiếu so sánh...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono-ui border-collapse min-w-[600px]">
                    <thead>
                      <tr className="border-b border-border text-app-dim text-[10px] uppercase bg-app-hover">
                        <th className="py-2.5 px-3">Thông số</th>
                        {compareData?.map((item, idx) => (
                          <th key={idx} className="py-2.5 px-3 truncate max-w-[150px] font-bold text-app-primary text-center">
                            {item.cache?.page_title}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Điểm Audit</td>
                        {compareData?.map((item, idx) => {
                          const score = item.audit?.audit_score
                          let color = 'text-danger'
                          if (score >= 70) color = 'text-green'
                          else if (score >= 50) color = 'text-warn'
                          return (
                            <td key={idx} className={`py-3 px-3 text-center font-extrabold ${color}`}>
                              {score !== undefined ? `${score}/100` : '—'}
                            </td>
                          )
                        })}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Impressions (GSC)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {(item.cache?.gsc_impressions ?? 0).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Clicks (GSC)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {(item.cache?.gsc_clicks ?? 0).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">CTR trung bình</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {formatPercent(item.cache?.gsc_ctr ?? 0)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Vị trí Rank (GSC)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-hermes font-bold">
                            {(item.cache?.gsc_position ?? 0).toFixed(1)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Sessions (GA4)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {(item.cache?.ga4_sessions ?? 0).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Bounce Rate (GA4)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {formatPercent(item.cache?.ga4_bounce_rate ?? 0)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Time on Page (GA4)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {formatDuration(item.cache?.ga4_avg_time_sec ?? 0)}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-border flex justify-end bg-app-elevated">
              <button
                onClick={() => {
                  setSelectedUrls([])
                  setShowCompareModal(false)
                }}
                className="btn-ghost border border-border px-5 py-2 text-xs font-semibold rounded-lg text-app-primary mr-3"
              >
                Clear Lựa Chọn
              </button>
              <button onClick={() => setShowCompareModal(false)} className="btn-hermes px-5 py-2 text-xs font-semibold rounded-lg">
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
      
    </div>
  )
}
