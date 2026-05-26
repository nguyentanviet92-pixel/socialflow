/**
 * /campaigns/:id/hermes — edit campaign goal + hermes_context (product info)
 *
 * Two sections:
 *   1. Mục tiêu & Hướng dẫn cho Hermes — goal text
 *   2. Thông tin sản phẩm cho Hermes — structured fields
 */
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, X, Loader } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'

const TONE_OPTIONS = [
  { value: 'thân thiện, tư vấn', label: 'Thân thiện, tư vấn' },
  { value: 'chuyên nghiệp', label: 'Chuyên nghiệp' },
  { value: 'hài hước, gần gũi', label: 'Hài hước, gần gũi' },
  { value: 'kỹ thuật, chính xác', label: 'Kỹ thuật, chính xác' },
  { value: 'casual, thoải mái', label: 'Casual, thoải mái' },
]

// Tag input — array of strings
function TagsInput({ value, onChange, placeholder }) {
  const [input, setInput] = useState('')
  const tags = Array.isArray(value) ? value : []

  const add = () => {
    const v = input.trim()
    if (v && !tags.includes(v)) onChange([...tags, v])
    setInput('')
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map((t, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs"
            style={{ background: 'var(--hermes-dim)', color: 'var(--hermes)', border: '1px solid var(--hermes-fade)' }}
          >
            {t}
            <button
              onClick={() => onChange(tags.filter((_, idx) => idx !== i))}
              className="hover:text-danger"
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={placeholder || 'Enter để thêm...'}
          className="flex-1 px-3 py-1.5 bg-app-elevated text-app-primary text-sm font-mono-ui"
          style={{ border: '1px solid var(--border-bright)' }}
        />
        <button onClick={add} className="btn-ghost"><Plus size={12} /></button>
      </div>
    </div>
  )
}

export default function CampaignHermesEditor() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['campaigns', id],
    queryFn: async () => (await api.get(`/campaigns/${id}`)).data,
  })

  const [goal, setGoal] = useState('')
  const [ctx, setCtx] = useState({
    product_name: '',
    price: '',
    key_features: [],
    target_audience: '',
    tone: 'thân thiện, tư vấn',
    avoid: [],
    cta: '',
    brand_voice_examples: [],
  })
  const [exampleInput, setExampleInput] = useState('')
  const [generatingGoal, setGeneratingGoal] = useState(false)

  const handleGenerateGoal = async () => {
    if (!ctx.product_name) {
      toast.error('Nhập tên sản phẩm ở phần 2 trước để AI có thông tin viết!')
      return
    }
    setGeneratingGoal(true)
    const t = toast.loading('AI đang phân tích sản phẩm và viết hướng dẫn...')
    try {
      const res = await api.post(`/campaigns/${id}/generate-goal`, { ctx })
      if (res.data?.text) {
        setGoal(res.data.text)
        toast.success('Đã tự động tạo hướng dẫn thành công!', { id: t })
      } else {
        toast.error('Không nhận được phản hồi từ AI', { id: t })
      }
    } catch (err) {
      toast.error(`Lỗi sinh hướng dẫn: ${err.response?.data?.error || err.message}`, { id: t })
    } finally {
      setGeneratingGoal(false)
    }
  }

  useEffect(() => {
    if (!campaign) return
    setGoal(campaign.goal || '')

    const hCtx = campaign.hermes_context || {}
    const bConf = campaign.brand_config || {}

    // Key features fallback: use product names if products are listed in brand_config
    let fallbackFeatures = []
    if (Array.isArray(bConf.products) && bConf.products.length > 0) {
      fallbackFeatures = bConf.products.map(p => p.name).filter(Boolean)
    }

    setCtx({
      product_name: hCtx.product_name || bConf.brand_name || '',
      price: hCtx.price || '',
      key_features: (Array.isArray(hCtx.key_features) && hCtx.key_features.length > 0)
        ? hCtx.key_features
        : fallbackFeatures,
      target_audience: hCtx.target_audience || '',
      tone: hCtx.tone || bConf.brand_voice || 'thân thiện, tư vấn',
      avoid: hCtx.avoid || [],
      cta: hCtx.cta || bConf.example_comment || '',
      brand_voice_examples: hCtx.brand_voice_examples || [],
    })
  }, [campaign])

  const save = useMutation({
    mutationFn: async () => {
      await api.put(`/campaigns/${id}`, {
        goal,
        hermes_context: ctx,
      })
    },
    onSuccess: () => {
      toast.success('Đã lưu — Hermes sẽ dùng thông tin này cho campaign này')
      qc.invalidateQueries({ queryKey: ['campaigns', id] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  const addExample = () => {
    const v = exampleInput.trim()
    if (!v) return
    setCtx(c => ({ ...c, brand_voice_examples: [...(c.brand_voice_examples || []), v] }))
    setExampleInput('')
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader className="animate-spin text-hermes" size={20} />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full font-mono-ui">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <button onClick={() => nav(`/campaigns/${id}`)} className="text-app-muted hover:text-app-primary">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-app-muted">Hermes config</div>
          <div className="text-app-primary text-lg truncate mt-0.5">{campaign?.name}</div>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-hermes">
          {save.isPending ? 'Đang lưu...' : 'Lưu'}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-3xl">
        {/* SECTION 1 — Goal */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-app-primary text-base">1. Mục tiêu & Hướng dẫn cho Hermes</h3>
            <button
              onClick={handleGenerateGoal}
              disabled={generatingGoal}
              className="text-xs px-3 py-1 bg-app-elevated text-hermes flex items-center gap-1.5 rounded-lg font-medium cursor-pointer transition-all duration-200 hover:scale-102 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'linear-gradient(135deg, var(--hermes-dim), rgba(139, 92, 246, 0.15))',
                border: '1px solid var(--hermes-fade)',
                boxShadow: '0 2px 8px rgba(6, 182, 212, 0.1)',
              }}
            >
              {generatingGoal ? (
                <>
                  <Loader className="animate-spin" size={12} /> Đang viết...
                </>
              ) : (
                '✨ AI Tự viết'
              )}
            </button>
          </div>
          <p className="text-app-muted text-xs mb-3">
            Hermes đọc đoạn này khi review chiến dịch + khi sinh comment.
            Viết rõ mục đích, đối tượng, ràng buộc.
          </p>
          <textarea
            rows={8}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={`Ví dụ:
Quảng bá VPS OpenClaw cho dev và hosting reseller.
Tone thân thiện, không spam, ưu tiên group >1000 members.
Max 3 comments/group/ngày.
Avoid: post link trực tiếp, so sánh đối thủ.
Thành công = lead DM về sản phẩm.`}
            className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm resize-y"
            style={{ border: '1px solid var(--border-bright)', fontFamily: 'var(--font-mono)' }}
          />
          <div className="text-app-dim text-[10px] mt-1">{goal.length} ký tự</div>
        </section>

        {/* SECTION 2 — Product info */}
        <section className="mb-8">
          <h3 className="text-app-primary text-base mb-1">2. Thông tin sản phẩm cho Hermes</h3>
          <p className="text-app-muted text-xs mb-3">
            Cấu trúc thông tin sản phẩm để Hermes có context khi gen comment.
            Mỗi field sẽ inject vào system prompt.
          </p>

          <div className="space-y-4">
            {/* Product name + price */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] uppercase text-app-muted mb-1">Tên sản phẩm</label>
                <input
                  type="text"
                  value={ctx.product_name}
                  onChange={(e) => setCtx(c => ({ ...c, product_name: e.target.value }))}
                  placeholder="VPS OpenClaw"
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-app-muted mb-1">Giá</label>
                <input
                  type="text"
                  value={ctx.price}
                  onChange={(e) => setCtx(c => ({ ...c, price: e.target.value }))}
                  placeholder="từ 99k/tháng"
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>
            </div>

            {/* Key features */}
            <div>
              <label className="block text-[10px] uppercase text-app-muted mb-1">Điểm mạnh (tags)</label>
              <TagsInput
                value={ctx.key_features}
                onChange={(v) => setCtx(c => ({ ...c, key_features: v }))}
                placeholder="VD: NVMe SSD, uptime 99.9%"
              />
            </div>

            {/* Target audience */}
            <div>
              <label className="block text-[10px] uppercase text-app-muted mb-1">Đối tượng mục tiêu</label>
              <input
                type="text"
                value={ctx.target_audience}
                onChange={(e) => setCtx(c => ({ ...c, target_audience: e.target.value }))}
                placeholder="dev, hosting reseller, startup"
                className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
                style={{ border: '1px solid var(--border-bright)' }}
              />
            </div>

            {/* Tone */}
            <div>
              <label className="block text-[10px] uppercase text-app-muted mb-1">Tone giao tiếp</label>
              <select
                value={ctx.tone}
                onChange={(e) => setCtx(c => ({ ...c, tone: e.target.value }))}
                className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
                style={{ border: '1px solid var(--border-bright)' }}
              >
                {TONE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            {/* Avoid */}
            <div>
              <label className="block text-[10px] uppercase text-app-muted mb-1">Tránh (tags)</label>
              <TagsInput
                value={ctx.avoid}
                onChange={(v) => setCtx(c => ({ ...c, avoid: v }))}
                placeholder="VD: spam, post link trực tiếp"
              />
            </div>

            {/* CTA */}
            <div>
              <label className="block text-[10px] uppercase text-app-muted mb-1">CTA gợi ý</label>
              <input
                type="text"
                value={ctx.cta}
                onChange={(e) => setCtx(c => ({ ...c, cta: e.target.value }))}
                placeholder="DM để được tư vấn miễn phí"
                className="w-full px-3 py-2 bg-app-elevated text-app-primary text-sm"
                style={{ border: '1px solid var(--border-bright)' }}
              />
            </div>

            {/* Brand voice examples */}
            <div>
              <label className="block text-[10px] uppercase text-app-muted mb-1">
                Ví dụ giọng điệu thương hiệu (2-3 câu mẫu)
              </label>
              <div className="space-y-2 mb-2">
                {(ctx.brand_voice_examples || []).map((ex, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 p-2 text-sm"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                  >
                    <span className="text-app-muted text-xs">{i + 1}.</span>
                    <div className="flex-1 text-app-primary">{ex}</div>
                    <button
                      onClick={() => setCtx(c => ({ ...c, brand_voice_examples: c.brand_voice_examples.filter((_, idx) => idx !== i) }))}
                      className="text-app-muted hover:text-danger"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={exampleInput}
                  onChange={(e) => setExampleInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExample() } }}
                  placeholder='VD: "Mình dùng OpenClaw 6 tháng rồi, uptime ổn lắm"'
                  className="flex-1 px-3 py-2 bg-app-elevated text-app-primary text-sm"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
                <button onClick={addExample} className="btn-ghost"><Plus size={12} /> Thêm</button>
              </div>
            </div>
          </div>
        </section>

        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-hermes">
          {save.isPending ? 'Đang lưu...' : 'Lưu cài đặt Hermes'}
        </button>

        {/* ── SECTION 3: Auto-apply ── */}
        <AutoApplySection campaignId={id} />
      </div>
    </div>
  )
}

function AutoApplySection({ campaignId }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', campaignId, 'auto-apply'],
    queryFn: async () => (await api.get(`/campaigns/${campaignId}/auto-apply-settings`)).data,
  })

  const [form, setForm] = useState({ enabled: false, percent: 0, min_priority: 'high' })

  useEffect(() => {
    if (data) {
      setForm({
        enabled: !!data.auto_apply_enabled,
        percent: data.auto_apply_percent ?? 0,
        min_priority: data.auto_apply_min_priority || 'high',
      })
    }
  }, [data])

  const save = useMutation({
    mutationFn: async () => {
      await api.put(`/campaigns/${campaignId}/auto-apply-settings`, form)
    },
    onSuccess: () => {
      toast.success('Đã lưu auto-apply')
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId, 'auto-apply'] })
    },
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  if (isLoading) return null

  const lastRun = data?.auto_apply_last_run_at
    ? new Date(data.auto_apply_last_run_at).toLocaleString('vi-VN')
    : 'chưa chạy lần nào'

  return (
    <section className="mt-10 pt-8" style={{ borderTop: '1px solid var(--border)' }}>
      <h3 className="text-app-primary text-base mb-1">3. Auto-apply Hermes recommendations</h3>
      <p className="text-app-muted text-xs mb-4">
        Hermes tự apply đề xuất theo tỉ lệ % bạn set. Chạy khi có Review mới
        + cron 6h cho campaigns có toggle bật. Last run: <span className="text-app-primary">{lastRun}</span>.
      </p>

      <div
        className="p-4 space-y-4"
        style={{
          background: 'var(--bg-elevated)',
          border: form.enabled ? '1px solid var(--hermes-fade)' : '1px solid var(--border)',
        }}
      >
        {/* Enable toggle */}
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm(f => ({ ...f, enabled: e.target.checked }))}
            className="w-4 h-4"
          />
          <span className={`text-sm ${form.enabled ? 'text-hermes' : 'text-app-primary'}`}>
            {form.enabled ? '● ON — Hermes tự điều chỉnh' : 'OFF — mọi recommendation phải manual apply'}
          </span>
        </div>

        {/* Percent slider */}
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-2">
            Tỉ lệ tự động: <span className="text-hermes font-mono-ui">{form.percent}%</span>
            <span className="ml-2 text-app-dim">
              {form.percent === 0 && '(không auto-apply)'}
              {form.percent > 0 && form.percent < 30 && '(thận trọng)'}
              {form.percent >= 30 && form.percent < 70 && '(vừa phải)'}
              {form.percent >= 70 && form.percent < 100 && '(chủ động)'}
              {form.percent === 100 && '(full auto — rủi ro cao)'}
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={form.percent}
            onChange={(e) => setForm(f => ({ ...f, percent: parseInt(e.target.value) }))}
            disabled={!form.enabled}
            className="w-full"
            style={{ accentColor: 'var(--hermes)' }}
          />
          <div className="flex justify-between text-[10px] text-app-muted mt-1 font-mono-ui">
            <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
          </div>
        </div>

        {/* Min priority */}
        <div>
          <label className="block text-[10px] uppercase text-app-muted mb-1">
            Chỉ auto-apply priority từ mức
          </label>
          <select
            value={form.min_priority}
            onChange={(e) => setForm(f => ({ ...f, min_priority: e.target.value }))}
            disabled={!form.enabled}
            className="px-3 py-2 bg-app-base text-app-primary text-sm"
            style={{ border: '1px solid var(--border-bright)' }}
          >
            <option value="high">HIGH (chỉ fix_checkpoint + critical)</option>
            <option value="medium">MEDIUM (high + medium — mạnh tay)</option>
            <option value="low">LOW (tất cả — không khuyến nghị)</option>
          </select>
        </div>

        {/* Helper text */}
        <div className="text-[10px] text-app-muted font-mono-ui leading-relaxed">
          Ví dụ với 50% / priority HIGH: mỗi rec priority=high, Hermes roll dice,
          trung bình 50% sẽ auto-apply. 50% còn lại hiện trong modal để bạn quyết định.<br/>
          Medium / low recs luôn manual (trừ khi hạ ngưỡng).
        </div>

        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-hermes">
          {save.isPending ? 'Đang lưu...' : 'Lưu auto-apply'}
        </button>
      </div>
    </section>
  )
}
