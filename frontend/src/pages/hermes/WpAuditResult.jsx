/**
 * /hermes/wp-audit/:postId — Dedicated full-page view for WordPress audit results.
 * Optimized with a clean 4-tab layout (Overview, Checklist, Suggestions, Semantic).
 */
import { useState, useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft, Copy, CheckCircle2, AlertTriangle, ExternalLink,
  ChevronDown, ChevronUp, Star, CheckSquare, XCircle, Info, PenTool,
  RefreshCw, Loader, Search, Globe, Link2, Layers, Tag
} from 'lucide-react'
import api from '../../lib/api'

/* ═══════════════════════════════════════════════════════════════
   HELPERS & CONFIG
   ═══════════════════════════════════════════════════════════════ */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']

const SEVERITY_CONFIG = {
  critical: { label: 'CRITICAL', bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.4)', color: '#f87171', icon: XCircle },
  high:     { label: 'HIGH',     bg: 'rgba(251,146,60,0.15)', border: 'rgba(251,146,60,0.4)', color: '#fb923c', icon: AlertTriangle },
  medium:   { label: 'MEDIUM',   bg: 'rgba(250,204,21,0.12)', border: 'rgba(250,204,21,0.35)', color: '#facc15', icon: AlertTriangle },
  low:      { label: 'LOW',      bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.35)', color: '#60a5fa', icon: Info },
}

const CATEGORY_COLORS = {
  GEO:                 { bg: 'rgba(6,182,212,0.15)',  color: '#06b6d4' },
  SEO:                 { bg: 'rgba(139,92,246,0.15)', color: '#8b5cf6' },
  'Pillar/Cluster':    { bg: 'rgba(251,146,60,0.15)', color: '#fb923c' },
  Semantic:            { bg: 'rgba(34,197,94,0.15)',   color: '#22c55e' },
}

const scoreColor = (val, max = 25) => {
  const pct = val / max;
  if (pct >= 0.75) return "#22c55e";   // xanh
  if (pct >= 0.5)  return "#facc15";   // vàng
  return "#ef4444";                     // đỏ
};

function getCopywriterNote(issue) {
  const cat = (issue.category || '').toLowerCase()
  const loc = (issue.location || '').toLowerCase()
  const fix = issue.fix || ''

  if (cat === 'geo') {
    if (loc.includes('content') || loc.includes('intro') || loc.includes('body')) {
      return `Copywriter cần viết lại đoạn mở bài (200 từ đầu) sao cho trả lời trực tiếp câu hỏi chính của bài viết. Đặt định nghĩa rõ ràng ngay đầu đoạn.\n\nCụ thể: ${fix}`
    }
    if (loc.includes('faq') || loc.includes('schema')) {
      return `Copywriter cần tạo khối FAQ (Câu hỏi thường gặp) với 3–5 câu hỏi phổ biến nhất liên quan đến chủ đề bài viết. Mỗi câu trả lời cần ngắn gọn, trực tiếp (2–3 câu).\n\nCụ thể: ${fix}`
    }
    return `Copywriter cần tối ưu nội dung cho GEO (Generative Engine Optimization) — đảm bảo bài viết có câu trả lời trực tiếp, rõ ràng cho câu hỏi chính.\n\nCụ thể: ${fix}`
  }

  if (cat === 'seo') {
    if (loc.includes('meta_title') || loc.includes('title')) {
      return `Copywriter cần viết lại meta title sao cho chứa main keyword, đặt gần đầu, và không quá 60 ký tự. Title phải hấp dẫn, kích thích click.\n\nCụ thể: ${fix}`
    }
    if (loc.includes('meta_desc') || loc.includes('description')) {
      return `Copywriter cần viết lại meta description chứa main keyword, call-to-action rõ ràng, trong khoảng 150–160 ký tự.\n\nCụ thể: ${fix}`
    }
    if (loc.includes('heading') || loc.includes('h2') || loc.includes('h3')) {
      return `Copywriter cần cấu trúc lại các heading (H2, H3) sao cho chứa keyword phụ, tạo flow logic cho bài viết, và giúp Google hiểu outline bài.\n\nCụ thể: ${fix}`
    }
    return `Copywriter cần tối ưu SEO on-page cho phần "${issue.location}". Đảm bảo keyword chính xuất hiện tự nhiên, đủ density nhưng không nhồi nhét.\n\nCụ thể: ${fix}`
  }

  if (cat.includes('pillar') || cat.includes('cluster')) {
    return `Copywriter cần thêm internal link dẫn về bài pillar chính và các bài cluster liên quan trong cùng topic. Anchor text nên chứa keyword liên quan, đặt tự nhiên trong nội dung.\n\nCụ thể: ${fix}`
  }

  if (cat === 'semantic') {
    return `Copywriter cần bổ sung thêm từ đồng nghĩa, LSI keywords và entities liên quan vào nội dung bài viết một cách tự nhiên. Không nhồi nhét, mà hãy dùng trong ngữ cảnh phù hợp.\n\nCụ thể: ${fix}`
  }

  return `Copywriter cần xử lý vấn đề sau: ${fix}`
}

const STEPS = [
  { label: 'Lấy dữ liệu bài viết mới nhất từ WordPress', icon: '📥' },
  { label: 'Phân tích cấu trúc bài viết (headings, ảnh, links)', icon: '📊' },
  { label: 'Trích xuất thực thể & LSI kỳ vọng của chủ đề', icon: '🔍' },
  { label: 'Tiến hành chấm điểm SEO, GEO & Semantic bằng AI', icon: '🤖' },
  { label: 'Đồng bộ và lưu kết quả vào Database', icon: '💾' }
]

const AUDIT_MODELS = [
  { id: 'kimi:kimi-k2-thinking', name: 'Kimi K2 Thinking (Suy luận sâu - Khuyên dùng)', badge: 'Kimi' },
  { id: 'kimi:kimi-k2.6', name: 'Kimi K2.6 (Mạnh tiếng Việt)', badge: 'Kimi' },
  { id: 'kimi:kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo (Nhanh)', badge: 'Kimi' },
  { id: 'nvidia:meta/llama-3.3-70b-instruct', name: 'NVIDIA Llama 3.3 70B', badge: 'NVIDIA' },
  { id: 'nvidia:nvidia/llama-3.1-nemotron-70b-instruct', name: 'NVIDIA Nemotron 70B', badge: 'NVIDIA' },
  { id: 'groq:llama-3.3-70b-versatile', name: 'Groq Llama 3.3 70B', badge: 'Groq' },
  { id: 'deepseek:deepseek-reasoner', name: 'DeepSeek R1 Direct', badge: 'Reasoning' },
  { id: 'deepseek:deepseek-chat', name: 'DeepSeek V3', badge: 'DeepSeek' },
  { id: 'openrouter:anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', badge: 'Claude' },
  { id: 'openai:gpt-4o', name: 'GPT-4o (Đa dụng)', badge: 'OpenAI' }
]

function convertToSlug(text) {
  if (!text) return ''
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/([^0-9a-z-\s])/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function WpAuditResult() {
  const { postId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [checklistTab, setChecklistTab] = useState('seo')
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('wp_audit_selected_model') || 'kimi:kimi-k2-thinking'
  })

  const [reAuditing, setReAuditing] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [stepsStatus, setStepsStatus] = useState(['pending', 'pending', 'pending', 'pending', 'pending'])
  
  // Real-time copy success feedback
  const [copiedKey, setCopiedKey] = useState(null)
  
  // State for GEO Quick Wins checked items
  const [checkedWins, setCheckedWins] = useState({})

  // State for editable GEO Opening
  const [draftIntro, setDraftIntro] = useState('')

  // State for collapsed copywriter notes
  const [openNotes, setOpenNotes] = useState({})

  // Copy helper
  const copy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
    toast.success('Đã sao chép!');
  };

  const handleReAudit = async () => {
    setReAuditing(true)
    setShowModal(true)
    setCurrentStep(0)
    setStepsStatus(['active', 'pending', 'pending', 'pending', 'pending'])

    const siteIdx = data?.site_idx ?? 0
    let apiResolved = false
    let apiError = null
    let apiData = null

    // Start API request in parallel
    const modelParam = selectedModel ? `&model=${encodeURIComponent(selectedModel)}` : ''
    api.post(`/ai-hermes/wp/audit/${postId}?force=true&site_idx=${siteIdx}${modelParam}`)
      .then(res => {
        apiData = res.data
        apiResolved = true
      })
      .catch(err => {
        apiError = err
        apiResolved = true
      })

    // Simulate progress steps
    try {
      // Step 0: WP Fetch
      await new Promise(r => setTimeout(r, 1200))
      setStepsStatus(['done', 'active', 'pending', 'pending', 'pending'])
      setCurrentStep(1)

      // Step 1: Heading/Alts
      await new Promise(r => setTimeout(r, 1200))
      setStepsStatus(['done', 'done', 'active', 'pending', 'pending'])
      setCurrentStep(2)

      // Step 2: LSI/Entities
      await new Promise(r => setTimeout(r, 1500))
      setStepsStatus(['done', 'done', 'done', 'active', 'pending'])
      setCurrentStep(3)

      // Step 3: LLM Audit (waits until API resolves)
      while (!apiResolved) {
        await new Promise(r => setTimeout(r, 200))
      }

      if (apiError) {
        throw apiError
      }

      setStepsStatus(['done', 'done', 'done', 'done', 'active'])
      setCurrentStep(4)

      // Step 4: Save/Sync
      await new Promise(r => setTimeout(r, 800))
      setStepsStatus(['done', 'done', 'done', 'done', 'done'])

      if (apiData && apiData.audit) {
        const newData = { ...apiData, post: data.post }
        setData(newData)
        try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(newData)) } catch {}
        toast.success('Đã đánh giá lại bài viết thành công! 📊')
      } else {
        toast.error('Đánh giá lại thất bại')
      }
    } catch (err) {
      toast.error(`Lỗi: ${err.response?.data?.error || err.message}`)
    } finally {
      await new Promise(r => setTimeout(r, 500))
      setShowModal(false)
      setReAuditing(false)
    }
  }

  /* ─── Load data ─── */
  useEffect(() => {
    if (location.state?.audit && location.state?.post) {
      setData(location.state)
      try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(location.state)) } catch {}
      return
    }
    try {
      const raw = sessionStorage.getItem(`wp_audit_${postId}`)
      if (raw) {
        setData(JSON.parse(raw))
        return
      }
    } catch {}
    setData(null)
  }, [postId, location.state])

  // Sync draft GEO opening paragraph on load
  useEffect(() => {
    if (data?.audit?.suggestions?.opening_paragraph) {
      setDraftIntro(data.audit.suggestions.opening_paragraph)
    } else if (data?.audit?.suggestions?.intro_paragraph) {
      setDraftIntro(data.audit.suggestions.intro_paragraph)
    } else {
      setDraftIntro('')
    }
  }, [data])

  /* ─── Guard: no data ─── */
  if (!data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: 'var(--bg-base)' }}>
        <AlertTriangle size={48} className="text-warn" />
        <p className="text-app-muted text-sm">Không tìm thấy dữ liệu audit cho bài viết #{postId}.</p>
        <button className="btn-hermes" onClick={() => navigate('/hermes/wp-audit')}>
          <ArrowLeft size={14} className="inline mr-2" />
          Quay lại danh sách
        </button>
      </div>
    )
  }

  const { audit, post } = data
  const sb = audit.score_breakdown || {}
  const suggestions = audit.suggestions || {}
  const issues = Array.isArray(audit.critical_issues) ? audit.critical_issues : []
  const strengths = Array.isArray(audit.strengths) ? audit.strengths : null
  const geoWins = Array.isArray(audit.geo_quick_wins) ? audit.geo_quick_wins : []
  const clusterPosts = Array.isArray(suggestions.new_cluster_posts_needed) || Array.isArray(suggestions.cluster_gaps)
    ? (suggestions.new_cluster_posts_needed || suggestions.cluster_gaps)
    : []
  const missingEntities = Array.isArray(suggestions.missing_entities) ? suggestions.missing_entities : []
  const missingLsi = Array.isArray(suggestions.missing_lsi_keywords) || Array.isArray(suggestions.missing_lsi)
    ? (suggestions.missing_lsi_keywords || suggestions.missing_lsi)
    : []
  const internalLinks = Array.isArray(suggestions.internal_links_to_add) ? suggestions.internal_links_to_add : []
  const faqs = Array.isArray(suggestions.faq_block) ? suggestions.faq_block : []
  const h2s = Array.isArray(suggestions.h2_structure) ? suggestions.h2_structure : []
  const checklist = audit.checklist_results || audit.checklist || {}

  // Parse scores safely (support fallback score fields)
  const seoScore = sb.seo ?? sb.seo_score ?? 0
  const geoScore = sb.geo ?? sb.geo_score ?? 0
  const pillarClusterScore = sb.pillar_cluster ?? sb.pillar_cluster_score ?? 0
  const semanticScore = sb.semantic ?? sb.semantic_score ?? 0

  // Group issues by severity
  const issuesBySeverity = {}
  SEVERITY_ORDER.forEach(s => { issuesBySeverity[s] = [] })
  issues.forEach(iss => {
    const sev = (iss.severity || 'medium').toLowerCase()
    if (!issuesBySeverity[sev]) issuesBySeverity[sev] = []
    issuesBySeverity[sev].push(iss)
  })

  // Priority issues (top 3 highest severity)
  const severityValue = { critical: 4, high: 3, medium: 2, low: 1 }
  const priorityIssues = [...issues].sort((a, b) => {
    const aVal = severityValue[a.severity?.toLowerCase()] || 0
    const bVal = severityValue[b.severity?.toLowerCase()] || 0
    return bVal - aVal
  }).slice(0, 3)

  const postTitle = post?.title?.rendered || post?.title || `Post #${postId}`
  const postLink = post?.link || ''
  const postDate = post?.date ? new Date(post.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''

  // Function to calculate checklist tab total score
  const getChecklistTabTotalScore = (tabKey) => {
    const list = checklist[tabKey] || []
    return list.reduce((acc, item) => {
      const isPassed = item.pass ?? item.passed ?? false
      return acc + (isPassed ? (item.points || 0) : 0)
    }, 0)
  }

  const visibleChecklistTabs = [
    { id: 'seo', label: 'SEO Fundamentals', score: seoScore },
    { id: 'geo', label: 'GEO (Generative Engine)', score: geoScore },
    { id: 'pillar_cluster', label: 'Pillar / Topic Cluster', score: pillarClusterScore },
    { id: 'semantic', label: 'Semantic Content', score: semanticScore }
  ]

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* ═══ STICKY HEADER ═══ */}
      <header
        className="sticky top-0 z-50 px-6 py-3 shrink-0"
        style={{
          background: 'rgba(9,11,16,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center gap-4 justify-between">
          {/* Back & Re-Audit Actions */}
          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate('/hermes/wp-audit')}
                className="inline-flex items-center gap-2 text-sm text-app-muted hover:text-hermes transition-colors shrink-0"
              >
                <ArrowLeft size={16} />
                <span>Quay lại</span>
              </button>

              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    setSelectedModel(e.target.value)
                    localStorage.setItem('wp_audit_selected_model', e.target.value)
                  }}
                  className="px-2 py-1 bg-app-elevated border border-border text-app-primary rounded font-mono-ui text-xs outline-none"
                  style={{ background: 'rgba(9,11,16,0.6)', border: '1px solid var(--border)' }}
                >
                  {AUDIT_MODELS.map(m => (
                    <option key={m.id} value={m.id}>🤖 {m.name}</option>
                  ))}
                </select>

                <button
                  onClick={handleReAudit}
                  disabled={reAuditing}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-hermes/10 hover:bg-hermes/20 border border-hermes/30 hover:border-hermes/60 text-hermes transition-all text-xs font-semibold"
                >
                  {reAuditing ? (
                    <>
                      <Loader className="w-3.5 h-3.5 animate-spin" />
                      <span>Đang quét...</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Quét lại</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3 mt-1 flex-wrap min-w-0">
              <h1
                className="text-base font-semibold text-app-primary truncate max-w-lg"
                title={postTitle}
                dangerouslySetInnerHTML={{ __html: postTitle }}
              />
              <span
                className="px-2 py-0.5 rounded text-[9px] font-mono-ui font-bold uppercase tracking-wider"
                style={{
                  background: audit.post_type === 'pillar' ? 'rgba(139,92,246,0.2)' : 'var(--hermes-dim)',
                  color: audit.post_type === 'pillar' ? '#8b5cf6' : 'var(--hermes)',
                  border: `1px solid ${audit.post_type === 'pillar' ? 'rgba(139,92,246,0.4)' : 'var(--hermes-fade)'}`,
                }}
              >
                {audit.post_type === 'pillar' ? '🏛 PILLAR' : '🔗 CLUSTER'}
              </span>
              {audit.pillar_topic && (
                <span className="text-[10px] text-app-muted">
                  Topic: <strong>{audit.pillar_topic}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Links & metadata */}
          <div className="text-right shrink-0 flex flex-col items-end gap-1">
            {postLink && (
              <a
                href={postLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-hermes hover:underline max-w-xs truncate"
              >
                <ExternalLink size={11} />
                <span>Xem bài viết thực tế</span>
              </a>
            )}
            <div className="text-[10px] text-app-dim font-mono-ui">
              ID: {post?.id || postId} {postDate && `· Ngày đăng: ${postDate}`}
            </div>
          </div>
        </div>
      </header>

      {/* ═══ TAB BAR ═══ */}
      <div className="bg-app-surface border-b border-border sticky top-[61px] z-40 shrink-0">
        <div className="max-w-7xl mx-auto px-6 flex gap-4 overflow-x-auto">
          {[
            { id: 'overview', label: 'Overview', icon: Star },
            { id: 'checklist', label: 'Checklist chi tiết', icon: Info },
            { id: 'suggestions', label: 'Đề xuất sửa', icon: PenTool },
            { id: 'semantic', label: 'Semantic SEO', icon: Search }
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 py-3 px-2 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                activeTab === t.id
                  ? 'border-hermes text-hermes'
                  : 'border-transparent text-app-muted hover:text-app-primary'
              }`}
            >
              <t.icon size={15} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 min-h-0">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Score block */}
            <div
              className="rounded-2xl p-6"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', backdropFilter: 'blur(16px)' }}
            >
              <div className="flex flex-col md:flex-row items-center gap-8">
                {/* Circular Gauge */}
                <div className="flex flex-col items-center gap-2 shrink-0">
                  <div style={{ position: 'relative', width: 140, height: 140 }}>
                    <svg width={140} height={140} style={{ transform: 'rotate(-90deg)' }}>
                      <circle
                        cx={70} cy={70} r={62}
                        fill="none" stroke="var(--border)" strokeWidth={10}
                      />
                      <circle
                        cx={70} cy={70} r={62}
                        fill="none" stroke={scoreColor(audit.audit_score ?? 0, 100)} strokeWidth={10}
                        strokeDasharray={2 * Math.PI * 62}
                        strokeDashoffset={2 * Math.PI * 62 * (1 - Math.min((audit.audit_score ?? 0) / 100, 1))}
                        strokeLinecap="round"
                        style={{ transition: 'stroke-dashoffset 1s cubic-bezier(.4,0,.2,1), stroke .3s' }}
                      />
                    </svg>
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center"
                      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <span className="font-mono-ui text-3xl font-bold font-mono" style={{ color: scoreColor(audit.audit_score ?? 0, 100) }}>
                        {audit.audit_score ?? 0}
                      </span>
                      <span className="text-[10px] text-app-dim font-mono-ui">/100</span>
                    </div>
                  </div>
                  <span className="text-xs text-app-muted uppercase tracking-wider font-semibold">Điểm tổng</span>
                </div>

                {/* 4 horizontal bars */}
                <div className="flex-1 w-full space-y-4">
                  {[
                    { key: 'seo', label: 'SEO Fundamentals', score: seoScore },
                    { key: 'geo', label: 'GEO (Generative Engine)', score: geoScore },
                    { key: 'pillar_cluster', label: 'Pillar / Cluster', score: pillarClusterScore },
                    { key: 'semantic', label: 'Semantic SEO', score: semanticScore }
                  ].map(bar => {
                    const color = scoreColor(bar.score, 25)
                    const pct = Math.round((bar.score / 25) * 100)
                    return (
                      <div key={bar.key} className="space-y-1">
                        <div className="flex justify-between text-xs font-semibold">
                          <span className="text-app-muted">{bar.label}</span>
                          <span className="font-mono" style={{ color }}>{bar.score}/25 · {pct}%</span>
                        </div>
                        <div className="w-full h-3 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                          <div
                            className="h-full rounded-full transition-all duration-1000"
                            style={{
                              width: `${pct}%`,
                              background: `linear-gradient(90deg, ${color}88, ${color})`
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Priority Banner */}
            {priorityIssues.length > 0 && (
              <div className="p-5 rounded-2xl bg-red-950/20 border border-red-900/30">
                <div className="flex items-center gap-2 mb-3 text-red-400 font-bold text-xs uppercase tracking-wider">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                  🚨 Làm ngay để tăng điểm nhanh nhất:
                </div>
                <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs font-mono-ui">
                  {priorityIssues.map((issue, idx) => {
                    const isCritical = issue.severity?.toLowerCase() === 'critical'
                    const isHigh = issue.severity?.toLowerCase() === 'high'
                    const color = isCritical ? '#f87171' : isHigh ? '#fb923c' : '#facc15'
                    const dot = isCritical ? '🔴' : isHigh ? '🟠' : '🟡'
                    return (
                      <div key={idx} className="flex items-center gap-2">
                        <span>{dot}</span>
                        <span style={{ color }}>{issue.issue}</span>
                        {idx < priorityIssues.length - 1 && <span className="text-app-dim font-bold ml-2 select-none">·</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Strengths */}
            {strengths && strengths.length > 0 && (
              <div className="p-5 rounded-2xl bg-green-950/10 border border-green-900/20">
                <div className="flex items-center gap-2 mb-3 text-green-400 font-bold text-xs uppercase tracking-wider">
                  <Star size={14} className="fill-green-400" />
                  ✅ Điểm mạnh hiện tại
                </div>
                <ul className="space-y-2 text-sm text-app-primary">
                  {strengths.map((str, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-green-500 font-bold">•</span>
                      <span>{str}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Issues */}
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-app-primary uppercase tracking-wider flex items-center gap-2">
                <AlertTriangle size={16} className="text-warn" />
                ⚠️ Chi tiết vấn đề cần sửa đổi ({issues.length})
              </h3>
              {issues.length === 0 ? (
                <div className="p-4 rounded-xl bg-app-elevated border border-border text-sm text-app-muted">
                  🎉 Không phát hiện vấn đề nào. Bài viết đạt điểm tối ưu!
                </div>
              ) : (
                <div className="space-y-4">
                  {SEVERITY_ORDER.map(sev => {
                    const group = issuesBySeverity[sev] || []
                    if (group.length === 0) return null
                    const sevCfg = SEVERITY_CONFIG[sev]
                    return (
                      <div key={sev} className="space-y-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider pl-1" style={{ color: sevCfg.color }}>
                          {sevCfg.label} ({group.length})
                        </div>
                        {group.map((issue, idx) => {
                          const noteKey = `${sev}-${idx}`
                          const isNoteOpen = !!openNotes[noteKey]
                          const catCfg = CATEGORY_COLORS[issue.category] || { bg: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }
                          return (
                            <div
                              key={idx}
                              className="rounded-xl p-4 space-y-3 transition-all duration-200"
                              style={{ background: 'var(--bg-elevated)', border: `1px solid ${sevCfg.border}` }}
                            >
                              {/* Badges */}
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className="px-2 py-0.5 rounded text-[9px] font-bold font-mono-ui border"
                                  style={{ background: sevCfg.bg, color: sevCfg.color, borderColor: sevCfg.border }}
                                >
                                  {sevCfg.label}
                                </span>
                                <span
                                  className="px-2 py-0.5 rounded text-[9px] font-bold font-mono-ui"
                                  style={{ background: catCfg.bg, color: catCfg.color }}
                                >
                                  {issue.category}
                                </span>
                                {issue.location && (
                                  <span className="px-2 py-0.5 rounded text-[9px] font-mono-ui bg-app-base border border-border text-app-muted">
                                    📍 {issue.location}
                                  </span>
                                )}
                              </div>

                              {/* Description */}
                              <p className="text-sm font-bold text-app-primary leading-relaxed">{issue.issue}</p>

                              {/* Fix */}
                              {issue.fix && (
                                <p className="text-xs text-app-muted leading-relaxed">
                                  <span className="text-hermes font-bold">👉 Hướng dẫn sửa:</span> {issue.fix}
                                </p>
                              )}

                              {/* Collapsed copywriter notes */}
                              <div className="border-t border-border/50 pt-2.5">
                                <button
                                  onClick={() => setOpenNotes(prev => ({ ...prev, [noteKey]: !prev[noteKey] }))}
                                  className="flex items-center gap-1 text-[11px] font-semibold text-hermes uppercase tracking-wider hover:underline"
                                >
                                  <PenTool size={11} />
                                  <span>Ghi chú cho Copywriter</span>
                                  {isNoteOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                </button>
                                {isNoteOpen && (
                                  <div
                                    className="mt-2 rounded-lg p-3 text-xs text-app-muted leading-relaxed whitespace-pre-line"
                                    style={{ background: 'rgba(6,182,212,0.04)', border: '1px solid rgba(6,182,212,0.1)' }}
                                  >
                                    {getCopywriterNote(issue)}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* GEO Quick Wins */}
            {geoWins.length > 0 && (
              <div className="p-6 rounded-2xl bg-app-surface border border-border space-y-4">
                <h3 className="text-sm font-bold text-app-primary uppercase tracking-wider flex items-center gap-2">
                  <RefreshCw size={16} className="text-hermes" />
                  ⚡ GEO Quick Wins (Tick khi hoàn thành)
                </h3>
                <div className="space-y-2">
                  {geoWins.map((win, idx) => {
                    const isChecked = !!checkedWins[idx]
                    return (
                      <div
                        key={idx}
                        onClick={() => setCheckedWins(prev => ({ ...prev, [idx]: !prev[idx] }))}
                        className="flex items-start gap-3 p-3 rounded-lg border transition-all duration-150 cursor-pointer hover:bg-app-hover"
                        style={{
                          background: isChecked ? 'rgba(34,197,94,0.04)' : 'var(--bg-elevated)',
                          borderColor: isChecked ? 'rgba(34,197,94,0.2)' : 'var(--border)'
                        }}
                      >
                        <button className="mt-0.5 flex-shrink-0">
                          {isChecked ? (
                            <CheckCircle2 size={16} className="text-green-500 fill-green-500/10" />
                          ) : (
                            <div className="w-4 h-4 rounded border border-app-dim hover:border-hermes transition-colors" />
                          )}
                        </button>
                        <span className={`text-xs leading-relaxed ${isChecked ? 'text-app-muted line-through' : 'text-app-primary'}`}>
                          {win}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'checklist' && (
          <div className="space-y-6">
            {/* Checklist sub-tabs */}
            <div className="flex flex-wrap gap-2 border-b border-border pb-3">
              {visibleChecklistTabs.map(t => {
                const active = checklistTab === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setChecklistTab(t.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all border ${
                      active
                        ? 'bg-hermes/15 border-hermes text-hermes'
                        : 'bg-app-elevated border-border text-app-muted hover:text-app-primary'
                    }`}
                  >
                    {t.label} ({getChecklistTabTotalScore(t.id)}/25)
                  </button>
                )
              })}
            </div>

            {/* Checklist list */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(checklist[checklistTab] || []).map((item, idx) => {
                const isPassed = item.pass ?? item.passed ?? false
                return (
                  <div
                    key={idx}
                    className="flex items-center gap-3 p-3 rounded-lg border transition-all duration-200"
                    style={{
                      background: 'var(--bg-elevated)',
                      borderColor: isPassed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      opacity: isPassed ? 1 : 0.6
                    }}
                  >
                    <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-app-base border border-border">
                      {isPassed ? (
                        <CheckCircle2 size={14} className="text-green-500" />
                      ) : (
                        <XCircle size={14} className="text-red-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs ${isPassed ? 'text-app-primary font-medium' : 'text-app-dim'}`}>
                        {item.label}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                        isPassed
                          ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                          : 'bg-app-base text-app-dim border border-border'
                      }`}
                    >
                      {item.points >= 0 ? `+${item.points}` : item.points}đ
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {activeTab === 'suggestions' && (
          <div className="space-y-6">
            {/* Meta Title */}
            <div className="p-4 rounded-xl bg-app-surface border border-border space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs uppercase tracking-wider text-app-muted font-bold">Meta Title đề xuất</span>
                <button
                  onClick={() => copy(suggestions.meta_title || '', 'meta_title')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-all duration-150 ${
                    copiedKey === 'meta_title'
                      ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                      : 'bg-hermes/10 hover:bg-hermes/20 border border-hermes/30 hover:border-hermes/60 text-hermes'
                  }`}
                >
                  {copiedKey === 'meta_title' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                  <span>{copiedKey === 'meta_title' ? 'Copied!' : 'Copy'}</span>
                </button>
              </div>
              <input
                type="text"
                readOnly
                value={suggestions.meta_title || ''}
                className="w-full bg-app-elevated border border-border rounded-lg px-3 py-2 text-xs font-mono-ui text-app-primary"
              />
              <div className="flex justify-end">
                <span className={`text-[10px] font-mono-ui font-semibold ${ (suggestions.meta_title || '').length > 60 ? 'text-red-400 font-bold' : 'text-app-dim' }`}>
                  {(suggestions.meta_title || '').length}/60 ký tự
                </span>
              </div>
            </div>

            {/* Meta Description */}
            <div className="p-4 rounded-xl bg-app-surface border border-border space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs uppercase tracking-wider text-app-muted font-bold">Meta Description đề xuất</span>
                <button
                  onClick={() => copy(suggestions.meta_description || '', 'meta_description')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-all duration-150 ${
                    copiedKey === 'meta_description'
                      ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                      : 'bg-hermes/10 hover:bg-hermes/20 border border-hermes/30 hover:border-hermes/60 text-hermes'
                  }`}
                >
                  {copiedKey === 'meta_description' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                  <span>{copiedKey === 'meta_description' ? 'Copied!' : 'Copy'}</span>
                </button>
              </div>
              <textarea
                readOnly
                rows={3}
                value={suggestions.meta_description || ''}
                className="w-full bg-app-elevated border border-border rounded-lg px-3 py-2 text-xs font-mono-ui text-app-primary resize-none"
              />
              <div className="flex justify-end">
                <span className={`text-[10px] font-mono-ui font-semibold ${ (suggestions.meta_description || '').length > 160 ? 'text-red-400 font-bold' : 'text-app-dim' }`}>
                  {(suggestions.meta_description || '').length}/160 ký tự
                </span>
              </div>
            </div>

            {/* GEO Opening paragraph */}
            <div className="p-4 rounded-xl bg-app-surface border border-border space-y-2">
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-xs uppercase tracking-wider text-app-muted font-bold block">Đoạn mở bài (GEO-optimized)</span>
                  <span className="text-[10px] text-app-dim font-medium">Thay thế toàn bộ đoạn mở bài hiện tại</span>
                </div>
                <button
                  onClick={() => copy(draftIntro, 'intro_paragraph')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-all duration-150 ${
                    copiedKey === 'intro_paragraph'
                      ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                      : 'bg-hermes/10 hover:bg-hermes/20 border border-hermes/30 hover:border-hermes/60 text-hermes'
                  }`}
                >
                  {copiedKey === 'intro_paragraph' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                  <span>{copiedKey === 'intro_paragraph' ? 'Copied!' : 'Copy'}</span>
                </button>
              </div>
              <textarea
                rows={4}
                value={draftIntro}
                onChange={(e) => setDraftIntro(e.target.value)}
                className="w-full bg-app-elevated border border-border rounded-lg px-3 py-2 text-xs text-app-primary resize-y"
                placeholder="Chưa có nội dung đề xuất mở bài..."
              />
            </div>

            {/* H2 Structure */}
            {h2s.length > 0 && (
              <div className="p-4 rounded-xl bg-app-surface border border-border space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs uppercase tracking-wider text-app-muted font-bold">Cấu trúc H2 đề xuất</span>
                  <button
                    onClick={() => copy(h2s.map((h, i) => `${i + 1}. ${h}`).join('\n'), 'h2_structure')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-all duration-150 ${
                      copiedKey === 'h2_structure'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : 'bg-hermes/10 hover:bg-hermes/20 border border-hermes/30 hover:border-hermes/60 text-hermes'
                    }`}
                  >
                    {copiedKey === 'h2_structure' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                    <span>{copiedKey === 'h2_structure' ? 'Copied!' : 'Copy all H2'}</span>
                  </button>
                </div>
                <ol className="space-y-2">
                  {h2s.map((h, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-xs text-app-primary leading-relaxed font-mono-ui">
                      <span className="w-5 h-5 rounded flex items-center justify-center bg-app-base border border-border font-bold text-hermes">
                        {i + 1}
                      </span>
                      <span className="pt-0.5">{h}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* FAQ Block */}
            {faqs.length > 0 && (
              <div className="p-4 rounded-xl bg-app-surface border border-border space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-xs uppercase tracking-wider text-app-muted font-bold">FAQ Block đề xuất</span>
                  <button
                    onClick={() => copy(faqs.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n'), 'faq_all')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-all duration-150 ${
                      copiedKey === 'faq_all'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : 'bg-hermes/10 hover:bg-hermes/20 border border-hermes/30 hover:border-hermes/60 text-hermes'
                    }`}
                  >
                    {copiedKey === 'faq_all' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                    <span>{copiedKey === 'faq_all' ? 'Copied!' : 'Copy all FAQ'}</span>
                  </button>
                </div>
                <div className="space-y-3">
                  {faqs.map((f, i) => {
                    const faqKey = `faq-${i}`
                    return (
                      <div key={i} className="p-3 rounded-lg bg-app-elevated border border-border space-y-2">
                        <div className="flex items-start gap-2 text-xs font-medium text-app-primary">
                          <span className="text-hermes font-bold">Q:</span>
                          <span>{f.q}</span>
                        </div>
                        <div className="flex items-start gap-2 text-xs text-app-muted">
                          <span className="text-app-dim font-bold">A:</span>
                          <span>{f.a}</span>
                        </div>
                        <div className="flex justify-end pt-1">
                          <button
                            onClick={() => copy(`Q: ${f.q}\nA: ${f.a}`, faqKey)}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded transition-all duration-150 ${
                              copiedKey === faqKey
                                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                : 'bg-app-base hover:bg-app-hover border border-border text-app-muted'
                            }`}
                          >
                            {copiedKey === faqKey ? <CheckCircle2 size={10} /> : <Copy size={10} />}
                            <span>{copiedKey === faqKey ? 'Copied!' : 'Copy'}</span>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Internal Links */}
            {internalLinks.length > 0 && (
              <div className="p-4 rounded-xl bg-app-surface border border-border space-y-3">
                <span className="text-xs uppercase tracking-wider text-app-muted font-bold block">Internal Links cần thêm</span>
                <div className="space-y-2">
                  {internalLinks.map((link, i) => {
                    const linkKey = `link-${i}`
                    return (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-4 p-3 rounded-lg bg-app-elevated border border-border"
                      >
                        <div className="flex items-start gap-2.5 min-w-0">
                          <Link2 size={14} className="text-hermes mt-0.5 flex-shrink-0" />
                          <div className="text-xs leading-relaxed min-w-0">
                            <span className="font-semibold font-mono text-hermes block truncate">"{link.anchor}"</span>
                            {link.note && <span className="text-app-muted text-[11px]">{link.note}</span>}
                          </div>
                        </div>
                        <button
                          onClick={() => copy(link.anchor, linkKey)}
                          className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded transition-all duration-150 flex-shrink-0 ${
                            copiedKey === linkKey
                              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                              : 'bg-app-base hover:bg-app-hover border border-border text-app-muted'
                          }`}
                        >
                          {copiedKey === linkKey ? <CheckCircle2 size={10} /> : <Copy size={10} />}
                          <span>{copiedKey === linkKey ? 'Copied!' : 'Copy Anchor'}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'semantic' && (
          <div className="space-y-6">
            {/* Missing Entities */}
            {missingEntities.length > 0 && (
              <div className="p-4 rounded-xl bg-app-surface border border-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider text-app-muted font-bold">Missing Entities</span>
                  <button
                    onClick={() => copy(missingEntities.join(', '), 'all_entities')}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-all duration-150 ${
                      copiedKey === 'all_entities'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : 'bg-app-base hover:bg-app-hover border border-border text-app-muted'
                    }`}
                  >
                    {copiedKey === 'all_entities' ? 'Copied!' : 'Copy All'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {missingEntities.map((e, idx) => {
                    const entityKey = `entity-${idx}`
                    return (
                      <button
                        key={idx}
                        onClick={() => copy(e, entityKey)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-150 cursor-pointer ${
                          copiedKey === entityKey
                            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                            : 'bg-hermes-dim hover:bg-hermes/20 border border-hermes-fade text-hermes'
                        }`}
                      >
                        <Tag size={10} />
                        <span>{copiedKey === entityKey ? 'Copied!' : e}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Missing LSI */}
            {missingLsi.length > 0 && (
              <div className="p-4 rounded-xl bg-app-surface border border-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider text-app-muted font-bold">Missing LSI Keywords</span>
                  <button
                    onClick={() => copy(missingLsi.join(', '), 'all_lsi')}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-all duration-150 ${
                      copiedKey === 'all_lsi'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : 'bg-app-base hover:bg-app-hover border border-border text-app-muted'
                    }`}
                  >
                    {copiedKey === 'all_lsi' ? 'Copied!' : 'Copy All'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {missingLsi.map((lsi, idx) => {
                    const lsiKey = `lsi-${idx}`
                    return (
                      <button
                        key={idx}
                        onClick={() => copy(lsi, lsiKey)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-150 cursor-pointer ${
                          copiedKey === lsiKey
                            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                            : 'bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-400'
                        }`}
                      >
                        <Tag size={10} />
                        <span>{copiedKey === lsiKey ? 'Copied!' : lsi}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Cluster Gaps */}
            {clusterPosts.length > 0 && (
              <div className="p-4 rounded-xl bg-app-surface border border-border space-y-3">
                <span className="text-xs uppercase tracking-wider text-app-muted font-bold block">Cluster bài viết cần tạo thêm</span>
                <div className="space-y-2">
                  {clusterPosts.map((postName, idx) => {
                    const slug = convertToSlug(postName)
                    const titleKey = `title-${idx}`
                    const slugKey = `slug-${idx}`
                    return (
                      <div
                        key={idx}
                        className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-lg bg-app-elevated border border-border gap-2"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-semibold text-app-primary block">{postName}</span>
                          <span className="text-[10px] font-mono text-app-dim mt-0.5 block truncate" title={slug}>
                            Slug: <span className="text-hermes font-semibold">{slug}</span>
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                          <button
                            onClick={() => copy(postName, titleKey)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold rounded transition-all duration-150 ${
                              copiedKey === titleKey
                                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                : 'bg-app-base hover:bg-app-hover border border-border text-app-muted'
                            }`}
                          >
                            {copiedKey === titleKey ? 'Copied!' : 'Copy Tiêu đề'}
                          </button>
                          <button
                            onClick={() => copy(slug, slugKey)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold rounded transition-all duration-150 ${
                              copiedKey === slugKey
                                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                : 'bg-app-base hover:bg-app-hover border border-border text-app-muted'
                            }`}
                          >
                            {copiedKey === slugKey ? 'Copied!' : 'Copy Slug'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ PROGRESS MODAL ═══ */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md p-6 bg-app-elevated border border-border rounded-xl space-y-5 shadow-2xl animate-in fade-in zoom-in duration-200" style={{ background: 'var(--bg-surface)' }}>
            <div className="flex items-center gap-2.5">
              <RefreshCw className="w-5 h-5 text-hermes animate-spin" />
              <h3 className="text-sm font-bold text-app-primary uppercase tracking-wider">🔄 Đang quét lại bài viết...</h3>
            </div>

            <div className="space-y-3.5 pt-2">
              {STEPS.map((step, idx) => {
                const status = stepsStatus[idx]
                return (
                  <div key={idx} className="flex items-start gap-3 text-xs transition-opacity duration-200">
                    <span className="text-base select-none mt-0.5">{step.icon}</span>
                    <div className="flex-1">
                      <p className={`font-semibold ${status === 'active' ? 'text-hermes font-bold' : status === 'done' ? 'text-app-primary' : 'text-app-dim'}`}>
                        {step.label}
                      </p>
                    </div>
                    <div className="w-5 h-5 flex items-center justify-center">
                      {status === 'active' && <Loader className="w-3.5 h-3.5 text-hermes animate-spin" />}
                      {status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                      {status === 'pending' && <div className="w-1.5 h-1.5 rounded-full bg-app-dim" />}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Simple progress bar */}
            <div className="w-full bg-app-base h-1.5 rounded-full overflow-hidden border border-border">
              <div 
                className="bg-hermes h-full transition-all duration-300 rounded-full"
                style={{ width: `${((stepsStatus.filter(s => s === 'done').length) / STEPS.length) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
