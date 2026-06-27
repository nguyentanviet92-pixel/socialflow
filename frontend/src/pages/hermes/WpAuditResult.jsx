/**
 * /hermes/wp-audit/:postId — Dedicated full-page view for WordPress audit results.
 *
 * Data arrives via React Router location.state or sessionStorage fallback
 * key: `wp_audit_<postId>`.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft, Copy, CheckCircle2, AlertTriangle, ExternalLink,
  ChevronRight, Bookmark, Search, FileText, Globe, Link2, Tag,
  Lightbulb, List, Shield, Zap, Target, Hash, Layers, Star,
  CheckSquare, XCircle, Info, PenTool, RefreshCw, Loader,
} from 'lucide-react'
import api from '../../lib/api'


/* ═══════════════════════════════════════════════════════════════
   HELPERS
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

function scoreColor(score, max) {
  const pct = (score / max) * 100
  if (pct >= 72) return '#22c55e'
  if (pct >= 48) return '#facc15'
  return '#f87171'
}

function scoreColorClass(score, max) {
  const pct = (score / max) * 100
  if (pct >= 72) return 'text-green-400'
  if (pct >= 48) return 'text-yellow-400'
  return 'text-red-400'
}

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

function copyToClipboard(text, label = 'Nội dung') {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`Đã copy ${label}!`),
    () => toast.error('Không thể copy. Hãy copy thủ công.'),
  )
}

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════ */

/** Inline copy button — small, hermes-colored. */
function CopyBtn({ text, label = 'Nội dung', className = '' }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    copyToClipboard(text, label)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-200 ${className}`}
      style={{
        background: copied ? 'rgba(34,197,94,0.2)' : 'var(--hermes-dim)',
        color: copied ? '#22c55e' : 'var(--hermes)',
        border: `1px solid ${copied ? 'rgba(34,197,94,0.4)' : 'var(--hermes-fade)'}`,
      }}
    >
      {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
      {copied ? 'Đã copy' : 'Copy'}
    </button>
  )
}

/** Score ring — large or small. */
function ScoreRing({ score, max, size = 120, strokeWidth = 8, label }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const pct = Math.min(score / max, 1)
  const offset = circumference * (1 - pct)
  const color = scoreColor(score, max)

  return (
    <div className="flex flex-col items-center gap-2">
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke="var(--border)" strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={color} strokeWidth={strokeWidth}
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 1s cubic-bezier(.4,0,.2,1), stroke .3s' }}
          />
        </svg>
        <div
          className="absolute inset-0 flex flex-col items-center justify-center"
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
        >
          <span className="font-mono-ui text-2xl font-bold" style={{ color, lineHeight: 1 }}>
            {score}
          </span>
          <span className="text-[10px] text-app-dim font-mono-ui">/{max}</span>
        </div>
      </div>
      {label && <span className="text-xs text-app-muted uppercase tracking-wider">{label}</span>}
    </div>
  )
}

/** Sub-score card with horizontal progress bar. */
function SubScoreCard({ label, score, max = 25, icon: Icon }) {
  const pct = Math.round((score / max) * 100)
  const color = scoreColor(score, max)

  return (
    <div
      className="flex-1 min-w-[180px] p-4 rounded-xl"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon size={16} style={{ color }} />}
        <span className="text-xs uppercase tracking-wider text-app-muted font-medium">{label}</span>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-mono-ui text-xl font-bold" style={{ color }}>{score}</span>
        <span className="text-app-dim text-xs font-mono-ui">/{max}</span>
        <span className="ml-auto text-xs font-mono-ui" style={{ color }}>{pct}%</span>
      </div>
      <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}88, ${color})`,
            transition: 'width 1s cubic-bezier(.4,0,.2,1)',
          }}
        />
      </div>
    </div>
  )
}

/** Section wrapper with header icon + title. */
function Section({ id, icon: Icon, title, children, border = 'var(--border)' }) {
  return (
    <section id={id} className="scroll-mt-24">
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: `1px solid ${border}`, backdropFilter: 'blur(16px)' }}
      >
        <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: `1px solid ${border}` }}>
          {Icon && <Icon size={18} className="text-hermes" style={{ flexShrink: 0 }} />}
          <h2 className="text-base font-semibold text-app-primary tracking-wide">{title}</h2>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </section>
  )
}

/** Suggestion card with title, content, copy. */
function SuggestionCard({ label, content, mono = true }) {
  if (!content) return null
  const text = Array.isArray(content) ? content.join('\n') : String(content)
  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-app-primary">{label}</span>
        <CopyBtn text={text} label={label} />
      </div>
      <div
        className={`text-sm leading-relaxed p-3 rounded-lg ${mono ? 'font-mono-ui' : ''}`}
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
      >
        {text}
      </div>
    </div>
  )
}

/** Chip / tag for keywords & entities. */
function SemanticChip({ text }) {
  const handleClick = () => copyToClipboard(text, text)
  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-200 hover:scale-105 cursor-pointer"
      style={{
        background: 'var(--hermes-dim)',
        color: 'var(--hermes)',
        border: '1px solid var(--hermes-fade)',
      }}
      title="Click để copy"
    >
      <Tag size={10} />
      {text}
    </button>
  )
}

/* ═══════════════════════════════════════════════════════════════
   TABLE OF CONTENTS (floating sidebar)
   ═══════════════════════════════════════════════════════════════ */
const TOC_ITEMS = [
  { id: 'scores',      label: 'Điểm tổng quan',        icon: Target },
  { id: 'checklist',   label: 'Tiêu chí đánh giá',     icon: List },
  { id: 'strengths',   label: 'Điểm mạnh',             icon: Star },
  { id: 'issues',      label: 'Vấn đề cần sửa',        icon: AlertTriangle },
  { id: 'suggestions', label: 'Đề xuất chỉnh sửa',     icon: PenTool },
  { id: 'semantic',    label: 'Semantic Gap',            icon: Search },
  { id: 'clusters',    label: 'Cluster mới cần tạo',    icon: Layers },
  { id: 'geo-wins',    label: 'GEO Quick Wins',         icon: Zap },
]

function TableOfContents({ activeSection }) {
  return (
    <nav
      className="hidden xl:block sticky top-24 w-56 flex-shrink-0 self-start rounded-2xl p-4 space-y-1"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', backdropFilter: 'blur(16px)' }}
    >
      <div className="text-[10px] uppercase tracking-widest text-app-dim mb-3 px-2">Mục lục</div>
      {TOC_ITEMS.map(item => {
        const active = activeSection === item.id
        return (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all duration-200"
            style={{
              background: active ? 'var(--hermes-dim)' : 'transparent',
              color: active ? 'var(--hermes)' : 'var(--text-muted)',
              fontWeight: active ? 600 : 400,
            }}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            <item.icon size={13} style={{ flexShrink: 0 }} />
            <span className="truncate">{item.label}</span>
          </a>
        )
      })}
    </nav>
  )
}

const STEPS = [
  { label: 'Lấy dữ liệu bài viết mới nhất từ WordPress', icon: '📥' },
  { label: 'Phân tích cấu trúc bài viết (headings, ảnh, links)', icon: '📊' },
  { label: 'Trích xuất thực thể & LSI kỳ vọng của chủ đề', icon: '🔍' },
  { label: 'Tiến hành chấm điểm SEO, GEO & Semantic bằng AI', icon: '🤖' },
  { label: 'Đồng bộ và lưu kết quả vào Database', icon: '💾' }
]

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

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function WpAuditResult() {
  const { postId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [activeSection, setActiveSection] = useState('scores')
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem('wp_audit_selected_model') || 'nvidia:meta/llama-3.3-70b-instruct'
  })
  const [checklistTab, setChecklistTab] = useState('seo')
  const mainRef = useRef(null)

  const [reAuditing, setReAuditing] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [stepsStatus, setStepsStatus] = useState(['pending', 'pending', 'pending', 'pending', 'pending'])

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
    // 1. From navigation state
    if (location.state?.audit && location.state?.post) {
      setData(location.state)
      // Also persist to sessionStorage
      try { sessionStorage.setItem(`wp_audit_${postId}`, JSON.stringify(location.state)) } catch {}
      return
    }
    // 2. Fallback: sessionStorage
    try {
      const raw = sessionStorage.getItem(`wp_audit_${postId}`)
      if (raw) {
        setData(JSON.parse(raw))
        return
      }
    } catch {}
    // 3. Nothing found
    setData(null)
  }, [postId, location.state])

  /* ─── Intersection Observer for TOC active state ─── */
  useEffect(() => {
    const ids = TOC_ITEMS.map(t => t.id)
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
            break
          }
        }
      },
      { rootMargin: '-100px 0px -60% 0px', threshold: 0.1 },
    )
    ids.forEach(id => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
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
  const clusterPosts = Array.isArray(suggestions.new_cluster_posts_needed) ? suggestions.new_cluster_posts_needed : []
  const missingEntities = Array.isArray(suggestions.missing_entities) ? suggestions.missing_entities : []
  const missingLsi = Array.isArray(suggestions.missing_lsi_keywords) ? suggestions.missing_lsi_keywords : []
  const internalLinks = Array.isArray(suggestions.internal_links_to_add) ? suggestions.internal_links_to_add : []
  const faqs = Array.isArray(suggestions.faq_block) ? suggestions.faq_block : []
  const h2s = Array.isArray(suggestions.h2_structure) ? suggestions.h2_structure : []

  // Group issues by severity
  const issuesBySeverity = {}
  SEVERITY_ORDER.forEach(s => { issuesBySeverity[s] = [] })
  issues.forEach(iss => {
    const sev = (iss.severity || 'medium').toLowerCase()
    if (!issuesBySeverity[sev]) issuesBySeverity[sev] = []
    issuesBySeverity[sev].push(iss)
  })

  const postTitle = post?.title?.rendered || post?.title || `Post #${postId}`
  const postLink = post?.link || ''
  const postDate = post?.date ? new Date(post.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      {/* ═══ STICKY HEADER ═══ */}
      <header
        className="sticky top-0 z-50 px-6 py-3"
        style={{
          background: 'rgba(9,11,16,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center gap-2">
          {/* Back & Re-Audit Actions */}
          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={() => navigate('/hermes/wp-audit')}
              className="inline-flex items-center gap-2 text-sm text-app-muted hover:text-hermes transition-colors"
            >
              <ArrowLeft size={16} />
              <span>Quay lại danh sách</span>
            </button>

            <div className="flex items-center gap-2">
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
                title="Đánh giá lại bài viết (quét mới và lưu đè)"
              >
                {reAuditing ? (
                  <>
                    <Loader className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang quét lại...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Đánh giá lại</span>
                  </>
                )}
              </button>
            </div>
          </div>


          <div className="sm:ml-4 flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Post title */}
              <h1
                className="text-lg font-semibold text-app-primary truncate max-w-xl"
                title={postTitle}
                dangerouslySetInnerHTML={{ __html: postTitle }}
              />
              {/* Badges */}
              <span
                className="px-2 py-0.5 rounded text-[10px] font-mono-ui font-bold uppercase tracking-wider"
                style={{
                  background: audit.post_type === 'pillar' ? 'rgba(139,92,246,0.2)' : 'var(--hermes-dim)',
                  color: audit.post_type === 'pillar' ? '#8b5cf6' : 'var(--hermes)',
                  border: `1px solid ${audit.post_type === 'pillar' ? 'rgba(139,92,246,0.4)' : 'var(--hermes-fade)'}`,
                }}
              >
                {audit.post_type === 'pillar' ? '🏛 PILLAR' : '🔗 CLUSTER'}
              </span>
              <span
                className="px-2 py-0.5 rounded text-[10px] font-mono-ui text-app-dim"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
              >
                ID: {post?.id || postId}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {postLink && (
                <a
                  href={postLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-hermes hover:underline truncate max-w-md"
                >
                  <ExternalLink size={11} />
                  {postLink}
                </a>
              )}
              {postDate && <span className="text-[10px] text-app-dim font-mono-ui">{postDate}</span>}
              {audit.pillar_topic && (
                <span className="text-[10px] text-app-muted">
                  <Bookmark size={10} className="inline mr-1" />
                  Pillar: {audit.pillar_topic}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ═══ BODY ═══ */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex gap-6" ref={mainRef}>
        {/* TOC sidebar */}
        <TableOfContents activeSection={activeSection} />

        {/* Main content */}
        <main className="flex-1 min-w-0 space-y-8">
          {/* ─── 1. SCORE OVERVIEW ─── */}
          <section id="scores" className="scroll-mt-24">
            <div
              className="rounded-2xl p-6 sm:p-8"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', backdropFilter: 'blur(16px)' }}
            >
              <div className="flex flex-col md:flex-row items-center gap-8">
                {/* Main score ring */}
                <ScoreRing score={audit.audit_score ?? 0} max={100} size={140} strokeWidth={10} label="Điểm tổng" />

                {/* Sub-score cards */}
                <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <SubScoreCard label="SEO" score={sb.seo_score ?? 0} icon={Search} />
                  <SubScoreCard label="GEO" score={sb.geo_score ?? 0} icon={Globe} />
                  <SubScoreCard label="Pillar / Cluster" score={sb.pillar_cluster ?? 0} icon={Link2} />
                  <SubScoreCard label="Semantic" score={sb.semantic_score ?? 0} icon={Layers} />
                </div>
              </div>

              {/* Quick summary */}
              <div className="mt-6 pt-4 flex flex-wrap gap-6 text-xs text-app-muted font-mono-ui" style={{ borderTop: '1px solid var(--border)' }}>
                <span>
                  <span className="text-app-dim">Vấn đề:</span>{' '}
                  <span className="text-app-primary font-semibold">{issues.length}</span>
                </span>
                <span>
                  <span className="text-app-dim">Critical:</span>{' '}
                  <span style={{ color: '#f87171' }}>{issuesBySeverity.critical?.length || 0}</span>
                </span>
                <span>
                  <span className="text-app-dim">High:</span>{' '}
                  <span style={{ color: '#fb923c' }}>{issuesBySeverity.high?.length || 0}</span>
                </span>
                <span>
                  <span className="text-app-dim">Quick wins:</span>{' '}
                  <span className="text-hermes">{geoWins.length}</span>
                </span>
              </div>
            </div>
          </section>

          {/* ─── 1.5. DETAILED AUDIT CHECKLIST ─── */}
          <section id="checklist" className="scroll-mt-24">
            <Section id="checklist-section" icon={List} title="📋 Chi tiết tiêu chí kiểm tra (Audit Checklist)">
              {audit.checklist_results ? (
                <div className="space-y-4">
                  {/* Category Tabs */}
                  <div className="flex flex-wrap gap-2 border-b border-border pb-3">
                    {Object.entries({
                      seo: { label: 'SEO Fundamentals', score: sb.seo_score ?? sb.seo ?? 0 },
                      geo: { label: 'Generative Engine (GEO)', score: sb.geo_score ?? sb.geo ?? 0 },
                      pillar_cluster: { label: 'Pillar / Topic Cluster', score: sb.pillar_cluster ?? 0 },
                      semantic: { label: 'Semantic Content', score: sb.semantic_score ?? sb.semantic ?? 0 }
                    }).map(([key, cat]) => {
                      const active = checklistTab === key
                      return (
                        <button
                          key={key}
                          onClick={() => setChecklistTab(key)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all border ${
                            active
                              ? 'bg-hermes/15 border-hermes text-hermes'
                              : 'bg-app-elevated border-border text-app-muted hover:text-app-primary'
                          }`}
                        >
                          {cat.label} ({cat.score}/25)
                        </button>
                      )
                    })}
                  </div>

                  {/* Checklist Items list */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                    {(audit.checklist_results[checklistTab] || []).map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 p-3 rounded-lg border transition-all duration-200 hover-row"
                        style={{
                          background: 'var(--bg-elevated)',
                          borderColor: item.passed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                        }}
                      >
                        <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-app-base border border-border">
                          {item.passed ? (
                            <CheckCircle2 size={14} className="text-green-500" />
                          ) : (
                            <XCircle size={14} className="text-red-500" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs ${item.passed ? 'text-app-primary font-medium' : 'text-app-dim'}`}>
                            {item.label}
                          </p>
                        </div>
                        <span
                          className={`text-xs font-mono-ui font-bold px-2 py-0.5 rounded ${
                            item.passed
                              ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                              : 'bg-app-base text-app-dim border border-border'
                          }`}
                        >
                          +{item.points}đ
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-app-elevated border border-border rounded-xl flex flex-col items-center justify-center gap-3 text-center">
                  <Info className="w-8 h-8 text-hermes" />
                  <p className="text-xs text-app-muted max-w-md leading-relaxed">
                    Dữ liệu checklist chi tiết chưa khả dụng cho bản quét cũ này.
                    Vui lòng bấm <strong className="text-hermes">Đánh giá lại</strong> ở góc trên bên phải để quét mới và hiển thị đầy đủ checklist chi tiết.
                  </p>
                </div>
              )}
            </Section>
          </section>

          {/* ─── 2. STRENGTHS ─── */}
          <Section id="strengths" icon={CheckCircle2} title="✅ Điểm mạnh" border="rgba(34,197,94,0.3)">
            {strengths && strengths.length > 0 ? (
              <ul className="space-y-2">
                {strengths.map((s, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" style={{ color: '#22c55e' }} />
                    <span className="text-app-primary">{s}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-3 py-3 text-sm text-app-muted">
                <Info size={16} className="text-hermes flex-shrink-0" />
                <span>Chức năng phân tích điểm mạnh sẽ được cập nhật sớm. Hệ thống đang thu thập dữ liệu.</span>
              </div>
            )}
          </Section>

          {/* ─── 3. ISSUES ─── */}
          <Section id="issues" icon={AlertTriangle} title="⚠️ Vấn đề cần sửa">
            {issues.length === 0 ? (
              <div className="text-sm text-app-muted flex items-center gap-2">
                <CheckCircle2 size={16} style={{ color: '#22c55e' }} />
                Không phát hiện vấn đề nghiêm trọng nào — bài viết đã khá tốt!
              </div>
            ) : (
              <div className="space-y-6">
                {SEVERITY_ORDER.map(sev => {
                  const group = issuesBySeverity[sev]
                  if (!group || group.length === 0) return null
                  const cfg = SEVERITY_CONFIG[sev]
                  const SevIcon = cfg.icon
                  return (
                    <div key={sev} className="space-y-3">
                      {/* Group header */}
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold" style={{ color: cfg.color }}>
                        <SevIcon size={14} />
                        {cfg.label} ({group.length})
                      </div>

                      {/* Issue cards */}
                      {group.map((iss, idx) => {
                        const catCfg = CATEGORY_COLORS[iss.category] || { bg: 'var(--bg-hover)', color: 'var(--text-muted)' }
                        return (
                          <div
                            key={idx}
                            className="rounded-xl p-4 space-y-3 transition-all duration-200 hover:translate-x-0.5"
                            style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
                          >
                            {/* Badge row */}
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-bold uppercase font-mono-ui"
                                style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}
                              >
                                {cfg.label}
                              </span>
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-medium font-mono-ui"
                                style={{ background: catCfg.bg, color: catCfg.color }}
                              >
                                {iss.category}
                              </span>
                              {iss.location && (
                                <span
                                  className="px-2 py-0.5 rounded text-[10px] font-mono-ui text-app-dim"
                                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                                >
                                  📍 {iss.location}
                                </span>
                              )}
                            </div>

                            {/* Issue text */}
                            <p className="text-sm font-semibold text-app-primary leading-relaxed">
                              {iss.issue}
                            </p>

                            {/* Fix recommendation */}
                            {iss.fix && (
                              <div className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                                <span className="flex-shrink-0">👉</span>
                                <span>{iss.fix}</span>
                              </div>
                            )}

                            {/* Copywriter note */}
                            <div
                              className="rounded-lg p-3 space-y-1"
                              style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}
                            >
                              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-hermes uppercase tracking-wider">
                                <PenTool size={12} />
                                Ghi chú cho Copywriter
                              </div>
                              <p className="text-xs text-app-muted leading-relaxed whitespace-pre-line">
                                {getCopywriterNote(iss)}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )}
          </Section>

          {/* ─── 4. SUGGESTIONS ─── */}
          <Section id="suggestions" icon={PenTool} title="✏️ Đề xuất chỉnh sửa">
            <div className="space-y-4">
              <SuggestionCard label="📌 Title mới" content={suggestions.title} />
              <SuggestionCard label="🏷️ Meta Title" content={suggestions.meta_title} />
              <SuggestionCard label="📝 Meta Description" content={suggestions.meta_description} />
              <SuggestionCard label="💡 Đoạn mở bài GEO (Direct Answer)" content={suggestions.intro_paragraph} mono={false} />

              {/* H2 Structure */}
              {h2s.length > 0 && (
                <div
                  className="rounded-xl p-4 space-y-3"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-app-primary">📋 Cấu trúc H2 đề xuất</span>
                    <CopyBtn text={h2s.map((h, i) => `${i + 1}. ${h}`).join('\n')} label="H2 structure" />
                  </div>
                  <ol className="space-y-2 pl-1">
                    {h2s.map((h, i) => (
                      <li key={i} className="flex items-start gap-3 text-sm">
                        <span
                          className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold font-mono-ui"
                          style={{ background: 'var(--hermes-dim)', color: 'var(--hermes)', border: '1px solid var(--hermes-fade)' }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-app-primary font-mono-ui pt-0.5">{h}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* FAQ Block */}
              {faqs.length > 0 && (
                <div
                  className="rounded-xl p-4 space-y-4"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-app-primary">❓ FAQ Block đề xuất</span>
                    <CopyBtn
                      text={faqs.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')}
                      label="FAQ Block"
                    />
                  </div>
                  <div className="space-y-3">
                    {faqs.map((faq, i) => (
                      <div
                        key={i}
                        className="rounded-lg p-3 space-y-2"
                        style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-hermes font-bold text-sm flex-shrink-0">Q:</span>
                          <span className="text-sm text-app-primary font-semibold">{faq.q}</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-app-dim font-bold text-sm flex-shrink-0">A:</span>
                          <span className="text-sm text-app-muted">{faq.a}</span>
                        </div>
                        <div className="flex justify-end">
                          <CopyBtn text={`Q: ${faq.q}\nA: ${faq.a}`} label={`FAQ #${i + 1}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Internal links */}
              {internalLinks.length > 0 && (
                <div
                  className="rounded-xl p-4 space-y-3"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-app-primary">🔗 Internal links cần thêm</span>
                    <CopyBtn
                      text={internalLinks.map(l => `${l.anchor} → ${l.note || ''}`).join('\n')}
                      label="Internal links"
                    />
                  </div>
                  <div className="space-y-2">
                    {internalLinks.map((link, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 p-2.5 rounded-lg transition-colors"
                        style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                      >
                        <Link2 size={14} className="text-hermes flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-mono-ui text-hermes">{link.anchor}</span>
                          {link.note && (
                            <span className="text-xs text-app-dim ml-2">
                              <ChevronRight size={10} className="inline" /> {link.note}
                            </span>
                          )}
                        </div>
                        <CopyBtn text={link.anchor} label="Anchor" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* ─── 5. SEMANTIC GAP ANALYSIS ─── */}
          {(missingEntities.length > 0 || missingLsi.length > 0) && (
            <Section id="semantic" icon={Search} title="🔍 Semantic Gap Analysis">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Missing Entities */}
                {missingEntities.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Hash size={14} className="text-hermes" />
                      <span className="text-sm font-semibold text-app-primary">Missing Entities</span>
                      <span className="text-[10px] text-app-dim font-mono-ui">({missingEntities.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {missingEntities.map((e, i) => <SemanticChip key={i} text={e} />)}
                    </div>
                  </div>
                )}

                {/* Missing LSI */}
                {missingLsi.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Tag size={14} style={{ color: '#8b5cf6' }} />
                      <span className="text-sm font-semibold text-app-primary">Missing LSI Keywords</span>
                      <span className="text-[10px] text-app-dim font-mono-ui">({missingLsi.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {missingLsi.map((k, i) => (
                        <button
                          key={i}
                          onClick={() => copyToClipboard(k, k)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-200 hover:scale-105 cursor-pointer"
                          style={{
                            background: 'rgba(139,92,246,0.12)',
                            color: '#8b5cf6',
                            border: '1px solid rgba(139,92,246,0.3)',
                          }}
                          title="Click để copy"
                        >
                          <Tag size={10} />
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 pt-3 flex gap-3" style={{ borderTop: '1px solid var(--border)' }}>
                <CopyBtn
                  text={[...missingEntities, ...missingLsi].join(', ')}
                  label="Tất cả keywords"
                />
              </div>
            </Section>
          )}

          {/* ─── 6. NEW CLUSTER POSTS NEEDED ─── */}
          {clusterPosts.length > 0 && (
            <Section id="clusters" icon={Layers} title="📝 Bài viết Cluster cần tạo thêm">
              <ul className="space-y-2">
                {clusterPosts.map((topic, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 p-3 rounded-lg transition-colors hover-row"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                  >
                    <span
                      className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold font-mono-ui"
                      style={{ background: 'var(--hermes-dim)', color: 'var(--hermes)' }}
                    >
                      {i + 1}
                    </span>
                    <span className="flex-1 text-sm text-app-primary">{topic}</span>
                    <CopyBtn text={topic} label="Topic" />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* ─── 7. GEO QUICK WINS ─── */}
          {geoWins.length > 0 && (
            <Section id="geo-wins" icon={Zap} title="🌟 GEO Quick Wins" border="var(--hermes-fade)">
              <ul className="space-y-3">
                {geoWins.map((win, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-3 p-3 rounded-lg transition-all duration-200 hover-row"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                  >
                    <span
                      className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold font-mono-ui"
                      style={{
                        background: 'var(--hermes-dim)',
                        color: 'var(--hermes)',
                        border: '1px solid var(--hermes-fade)',
                      }}
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 pt-0.5">
                      <span className="text-sm text-app-primary leading-relaxed">{win}</span>
                    </div>
                    <CheckSquare size={16} className="text-app-dim flex-shrink-0 mt-1 hover:text-hermes transition-colors cursor-pointer" />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Bottom spacer */}
          <div className="h-16" />
        </main>
      </div>

      {/* ═══ PROGRESS MODAL ═══ */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md p-6 bg-app-elevated border border-border rounded-xl space-y-5 shadow-2xl animate-in fade-in zoom-in duration-200" style={{ background: 'var(--bg-surface)' }}>
            <div className="flex items-center gap-2.5">
              <RefreshCw className="w-5 h-5 text-hermes animate-spin" />
              <h3 className="text-sm font-bold text-app-primary uppercase tracking-wider">🔄 Đang đánh giá lại bài viết...</h3>
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
