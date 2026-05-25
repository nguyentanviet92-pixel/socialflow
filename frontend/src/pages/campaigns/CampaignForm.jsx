import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { Target, Save, ArrowLeft, Clock, Sparkles, Check, AlertTriangle, Loader2, Megaphone, Info } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import EditablePlanList, { buildPlanRows, applyRowsToPlan } from '../../components/campaigns/EditablePlanList'

const randMin = () => Math.floor(Math.random() * 25) + 5
const DEFAULT_PRESETS = [
  { key: '247', label: '24/7', runs: 8, buildCron: () => `${randMin()} 0,3,6,9,12,15,18,21 * * *`, descFn: () => '24/7 — mỗi 3h (0h, 3h, 6h, ..., 21h)', is247: true },
  { key: 'allday', label: '6h-23h', runs: 5, buildCron: () => `${randMin()} 6,10,14,18,22 * * *`, descFn: () => '6h, 10h, 14h, 18h, 22h (5 lần)' },
  { key: 'twice', label: '2 lần/ngày', runs: 2, defaultHours: [8, 18], buildCron: (h1, h2) => `${randMin()} ${h1},${h2} * * *`, descFn: (h1, h2) => `Lúc ${h1}h và ${h2}h` },
  { key: 'daily', label: '1 lần/ngày', runs: 1, defaultHour: 9, buildCron: (h) => `${randMin()} ${h} * * *`, descFn: (h) => `Mỗi ngày lúc ${h}h` },
  { key: 'weekday', label: 'T2-T6', runs: 1, defaultHour: 8, buildCron: (h) => `${randMin()} ${h} * * 1-5`, descFn: (h) => `T2-T6 lúc ${h}h` },
  { key: 'every3h', label: 'Mỗi 3 tiếng', runs: 6, buildCron: () => `${randMin()} 6,9,12,15,18,21 * * *`, descFn: () => '6h, 9h, 12h, 15h, 18h, 21h (6 lần)' },
]

const DAY_LABELS = [
  { value: 1, label: 'T2' }, { value: 2, label: 'T3' }, { value: 3, label: 'T4' },
  { value: 4, label: 'T5' }, { value: 5, label: 'T6' }, { value: 6, label: 'T7' },
  { value: 0, label: 'CN' },
]

// 2026-05-05: expanded tones + random option per user request. "random"
// tells the comment generator to pick a tone per-comment so traffic looks
// like a real diverse user-base instead of every nick speaking the same way.
const VOICE_OPTIONS = [
  { value: 'random',       label: '🎲 Ngẫu nhiên' },
  { value: 'casual',       label: 'Thân thiện' },
  { value: 'professional', label: 'Chuyên nghiệp' },
  { value: 'humor',        label: 'Hài hước' },
  { value: 'lazy',         label: 'Cộc lốc / lười' },
  { value: 'curious',      label: 'Tò mò / hỏi nhiều' },
  { value: 'experienced',  label: 'Đàn anh / kinh nghiệm' },
  { value: 'skeptical',    label: 'Hoài nghi / khó tính' },
  { value: 'helpful',      label: 'Nhiệt tình giúp đỡ' },
  { value: 'newbie',       label: 'Newbie / mới biết' },
  { value: 'sarcastic',    label: 'Mỉa mai nhẹ' },
  { value: 'gen_z',        label: 'Gen Z / teencode' },
]

export default function CampaignForm() {
  const { id } = useParams()
  const isEdit = !!id
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Section 1: Basic
  const [form, setForm] = useState({
    name: '',
    topic: '',
    mission: '',
    language: 'vi',
    min_member_count: 100,  // tối thiểu để scout join (default 100, user can lower)
    schedule_type: 'recurring',
    cron_expression: `${randMin()} 6,10,14,18,22 * * *`,
  })

  // === NEW STATES ===
  const [targetGroupsText, setTargetGroupsText] = useState('')
  const [brandProducts, setBrandProducts] = useState([{ name: '', description: '' }])

  // Section 3: Ads (AI decides opportunity contextually — no keyword matching)
  const [adsEnabled, setAdsEnabled] = useState(false)
  const [brand, setBrand] = useState({
    brand_name: '',
    brand_description: '',
    example_comment: '',
    brand_voice: 'casual',
    ad_approach: 'soft_sell', // NEW
  })

  // Section 4: Accounts
  const [selectedAccountIds, setSelectedAccountIds] = useState([])

  // Section 5: Schedule
  const [scheduleMode, setScheduleMode] = useState('allday')
  const [presetHour, setPresetHour] = useState(9)
  const [presetHour2, setPresetHour2] = useState(18)
  const [customHour, setCustomHour] = useState(9)
  const [customMinute, setCustomMinute] = useState(0)
  const [customDays, setCustomDays] = useState([1, 2, 3, 4, 5, 6, 0])

  // Section 6: AI plan output (editable rows)
  const [aiPlan, setAiPlan] = useState(null)
  const [planRows, setPlanRows] = useState([])
  const [planConfirmed, setPlanConfirmed] = useState(false)

  // 2026-05-05: per-nick plan — Hermes generates a unique daily budget per nick
  // (warm-up phase × voice × personality from schedule_profile). Shape:
  //   { [account_id]: { daily_budget: {browse, like, comment, opportunity_comment, scout, friend_request, post}, phase, note, age_days, username, ai_generated } }
  const [perNickPlan, setPerNickPlan] = useState({})
  const [perNickLoading, setPerNickLoading] = useState(false)
  const [expandedNick, setExpandedNick] = useState(null)  // account_id of nick whose mini-editor is open

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get('/accounts').then(r => r.data),
  })

  const { data: existing } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get(`/campaigns/${id}`).then(r => r.data),
    enabled: isEdit,
  })

  useEffect(() => {
    if (existing) {
      setForm({
        name: existing.name || '',
        topic: existing.topic || '',
        mission: existing.mission || existing.requirement || '',
        language: existing.language || 'vi',
        min_member_count: existing.min_member_count ?? 100,
        schedule_type: existing.schedule_type || 'recurring',
        cron_expression: existing.cron_expression || '0 9 * * *',
      })
      setSelectedAccountIds(existing.account_ids || [])
      setTargetGroupsText((existing.target_groups || []).join('\n'))

      if (existing.brand_config) {
        setAdsEnabled(true)
        setBrand({
          brand_name: existing.brand_config.brand_name || '',
          brand_description: existing.brand_config.brand_description || '',
          example_comment: existing.brand_config.example_comment || '',
          brand_voice: existing.brand_config.brand_voice || 'casual',
          ad_approach: existing.brand_config.ad_approach || 'soft_sell',
        })
        if (existing.brand_config.products && Array.isArray(existing.brand_config.products)) {
          setBrandProducts(existing.brand_config.products)
        } else {
          setBrandProducts([{ name: '', description: '' }])
        }
      } else {
        setAdsEnabled(false)
        setBrand({
          brand_name: '',
          brand_description: '',
          example_comment: '',
          brand_voice: 'casual',
          ad_approach: 'soft_sell',
        })
        setBrandProducts([{ name: '', description: '' }])
      }
      if (existing.ai_plan) {
        setAiPlan(existing.ai_plan)
        // Use scheduleMode runs to rebuild rows (will be re-derived after cron parse below)
        const cronParts = (existing.cron_expression || '').split(' ')
        const runs = cronParts[1]?.split(',').length || 2
        setPlanRows(buildPlanRows(existing.ai_plan, runs))
        setPlanConfirmed(existing.ai_plan_confirmed || false)
        if (existing.ai_plan.per_nick && typeof existing.ai_plan.per_nick === 'object') {
          setPerNickPlan(existing.ai_plan.per_nick)
        }
      }
      const cron = existing.cron_expression || '0 9 * * *'
      const parts = cron.split(' ')
      if (parts[1]?.split(',').length >= 4) setScheduleMode('allday')
      else if (parts[4] === '1-5') { setScheduleMode('weekday'); setPresetHour(parseInt(parts[1]) || 8) }
      else if (parts[1]?.includes(',')) { setScheduleMode('twice'); const h = parts[1].split(',').map(Number); setPresetHour(h[0]); setPresetHour2(h[1]) }
      else { setScheduleMode('daily'); setPresetHour(parseInt(parts[1]) || 9) }
    }
  }, [existing])

  const resetPlan = () => { setAiPlan(null); setPlanRows([]); setPlanConfirmed(false); setPerNickPlan({}) }
  const runsPerDay = (DEFAULT_PRESETS.find(p => p.key === scheduleMode)?.runs || 2)

  // 2026-05-05: Incremental fetch — when user adds nicks AFTER AI plan exists,
  // fetch budget JUST for the new nicks (don't wipe existing plan). Keeps the
  // mini-editors stable while letting the user grow/shrink the roster.
  const fetchPlansForNewNicks = async (newAccountIds) => {
    if (!newAccountIds.length || !aiPlan) return
    try {
      const r = await api.post('/campaigns/preview-plan-per-nick', {
        mission: form.mission,
        topic: form.topic,
        account_ids: newAccountIds,
        runs_per_day: runsPerDay,
        brand_config: brandPayload,
      })
      const incoming = r.data?.per_nick || {}
      setPerNickPlan(prev => ({ ...prev, ...incoming }))
      setPlanConfirmed(false)
    } catch (err) {
      // silent — UI keeps "đang chờ AI..." stub
    }
  }
  // When selectedAccountIds change WHILE aiPlan exists, only fire for new nicks
  // (don't reset entire plan like resetPlan does on form-input changes)
  const onToggleNick = (a, sel) => {
    const next = sel ? selectedAccountIds.filter(x => x !== a.id) : [...selectedAccountIds, a.id]
    setSelectedAccountIds(next)
    if (!aiPlan) return  // no plan yet → nothing to incrementally fetch
    if (!sel) {
      // Adding: fetch only for this new nick if not already in perNickPlan
      if (!perNickPlan[a.id]) {
        fetchPlansForNewNicks([a.id])
      } else {
        setPlanConfirmed(false)  // re-confirm even if cached
      }
    } else {
      // Removing: just mark unconfirmed; Section 6 totals auto-recompute via filter
      setPlanConfirmed(false)
    }
  }

  // 2026-05-05: When per-nick plans exist, Section 6 must reflect TOTAL across
  // selected nicks (not the old shared-plan numbers) so users see consistent
  // data with Section 4. Section 6 becomes read-only summary; per-nick mini
  // editors in Section 4 are the source of truth.
  const PLAN_KEYS_FOR_SUMMARY = [
    { key: 'browse',              icon: '👀', label: 'Lướt feed',         unit: 'lần/ngày toàn campaign' },
    { key: 'like',                icon: '👍', label: 'Like bài',          unit: 'bài/ngày toàn campaign' },
    { key: 'comment',             icon: '💬', label: 'Comment',           unit: 'bài/ngày toàn campaign' },
    { key: 'opportunity_comment', icon: '📢', label: 'Quảng cáo tự nhiên', unit: 'lần/ngày toàn campaign' },
    { key: 'scout',               icon: '🔍', label: 'Thám dò nhóm',      unit: 'nhóm/ngày toàn campaign' },
    { key: 'friend_request',      icon: '🤝', label: 'Kết bạn',           unit: 'người/ngày toàn campaign' },
    { key: 'post',                icon: '📝', label: 'Đăng bài',          unit: 'bài/ngày toàn campaign' },
  ]
  const hasPerNick = Object.keys(perNickPlan).length > 0
  const summaryRows = hasPerNick
    ? PLAN_KEYS_FOR_SUMMARY.map(({ key, icon, label, unit }) => {
        let total = 0
        for (const aid of selectedAccountIds) {
          const v = perNickPlan[aid]?.daily_budget?.[key]
          if (Number.isFinite(v)) total += v
        }
        return { key, icon, label, unit, count: total }
      }).filter(r => r.count > 0)
    : null

  const updateCron = (mode, h1, h2, cH, cM, cDays) => {
    const preset = DEFAULT_PRESETS.find(p => p.key === mode)
    let cron
    if (preset?.buildCron) {
      cron = preset.defaultHours ? preset.buildCron(h1 || preset.defaultHours[0], h2 || preset.defaultHours[1])
           : preset.defaultHour ? preset.buildCron(h1 || preset.defaultHour)
           : preset.buildCron()
    } else if (mode === 'custom') {
      cron = `${cM} ${cH} * * ${cDays?.length === 7 ? '*' : (cDays || []).join(',')}`
    } else {
      cron = `${randMin()} 6,10,14,18,22 * * *`
    }
    setForm(f => ({ ...f, schedule_type: 'recurring', cron_expression: cron }))
  }

  const selectMode = (mode) => {
    setScheduleMode(mode)
    const preset = DEFAULT_PRESETS.find(p => p.key === mode)
    if (!preset) { updateCron(mode, null, null, customHour, customMinute, customDays); return }
    if (preset.defaultHours) { setPresetHour(preset.defaultHours[0]); setPresetHour2(preset.defaultHours[1]); updateCron(mode, preset.defaultHours[0], preset.defaultHours[1]) }
    else if (preset.defaultHour) { setPresetHour(preset.defaultHour); updateCron(mode, preset.defaultHour) }
    else updateCron(mode)
  }

  const getScheduleDesc = () => {
    const preset = DEFAULT_PRESETS.find(p => p.key === scheduleMode)
    if (preset?.descFn) return preset.descFn(presetHour, presetHour2)
    if (scheduleMode === 'custom') {
      const dayStr = customDays.length === 7 ? 'Mỗi ngày' : customDays.map(d => DAY_LABELS.find(l => l.value === d)?.label).join(', ')
      return `${dayStr} lúc ${String(customHour).padStart(2, '0')}:${String(customMinute).padStart(2, '0')}`
    }
    return ''
  }

  // Build brand_config payload (only if enabled and has name)
  const brandPayload = adsEnabled && brand.brand_name.trim() ? {
    brand_name: brand.brand_name.trim(),
    brand_description: brand.brand_description.trim(),
    example_comment: brand.example_comment.trim(),
    brand_voice: brand.brand_voice,
    ad_approach: brand.ad_approach || 'soft_sell',
    products: brandProducts.filter(p => p.name.trim()).map(p => ({
      name: p.name.trim(),
      description: p.description.trim()
    })),
  } : null

  // === Mutations ===
  // 2026-05-05: previewMut now ALSO fetches per-nick plans in parallel — each
  // selected nick gets its own Hermes-generated daily budget reflecting age,
  // voice, and personality (from schedule_profile). User can override per-nick
  // numbers inline before saving.
  const previewMut = useMutation({
    mutationFn: async () => {
      const [planResp, perNickResp] = await Promise.all([
        api.post('/campaigns/preview-plan', {
          mission: form.mission,
          topic: form.topic,
          account_ids: selectedAccountIds,
          runs_per_day: runsPerDay,
          brand_config: brandPayload,
        }),
        api.post('/campaigns/preview-plan-per-nick', {
          mission: form.mission,
          topic: form.topic,
          account_ids: selectedAccountIds,
          runs_per_day: runsPerDay,
          brand_config: brandPayload,
        }).catch(() => ({ data: { per_nick: {} } })),  // graceful fallback
      ])
      return { plan: planResp.data.plan, per_nick: perNickResp.data?.per_nick || {} }
    },
    onSuccess: (data) => {
      setAiPlan(data.plan)
      setPlanRows(buildPlanRows(data.plan, runsPerDay))
      setPerNickPlan(data.per_nick || {})
      setPlanConfirmed(false)
    },
    onError: (err) => toast.error(err.response?.data?.error || 'AI không thể tạo kế hoạch'),
  })

  // When user edits plan rows after AI generates, plan needs re-confirm
  const handleRowsChange = (newRows) => {
    setPlanRows(newRows)
    setPlanConfirmed(false)
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      // Apply edited rows back to plan steps before saving
      const finalPlan = aiPlan ? applyRowsToPlan(aiPlan, planRows, runsPerDay) : null
      // Attach per-nick budgets so backend can push them to accounts.daily_budget
      // and the agent enforces unique limits per nick (warmup × voice × personality).
      if (finalPlan && perNickPlan && Object.keys(perNickPlan).length) {
        finalPlan.per_nick = perNickPlan
      }
      const payload = {
        ...form,
        account_ids: selectedAccountIds,
        ai_plan: finalPlan,
        ai_plan_confirmed: planConfirmed,
        brand_config: brandPayload,
        ad_mode: brandPayload ? 'ad_enabled' : 'normal',
        target_groups: targetGroupsText.split('\n').map(g => g.trim()).filter(Boolean),
      }
      let cid
      if (isEdit) { await api.put(`/campaigns/${id}`, payload); cid = id }
      else { const res = await api.post('/campaigns', payload); cid = res.data.id }

      // 24/7 mode: push active_hours_start=0, end=24 to all selected nicks.
      // Poller's per-nick active hours check bypasses when (0, 24).
      if (scheduleMode === '247' && selectedAccountIds.length) {
        await Promise.all(selectedAccountIds.map(aid =>
          api.put(`/accounts/${aid}`, { active_hours_start: 0, active_hours_end: 24 }).catch(() => {})
        ))
      }
      return cid
    },
    onSuccess: (cid) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      toast.success(isEdit ? 'Đã cập nhật' : 'Đã tạo AI Pilot')
      navigate(`/campaigns/${cid}`)
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Lỗi'),
  })

  const canPreview = form.topic.trim() && form.mission.trim() && selectedAccountIds.length > 0
  const canSubmit = form.name.trim() && canPreview && aiPlan && planConfirmed

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/campaigns')} className="p-1.5 text-app-dim hover:text-app-muted"><ArrowLeft size={20} /></button>
        <Target size={24} className="text-purple-600" />
        <h1 className="text-2xl font-bold text-app-primary">{isEdit ? 'Sửa AI Pilot' : 'Tạo AI Pilot'}</h1>
      </div>

      <div className="space-y-5">
        {/* === Section 1: Basic === */}
        <div className="bg-app-surface rounded border border-app-border p-5 space-y-4">
          <h2 className="text-sm font-semibold text-app-primary">1. Thông tin cơ bản</h2>
          <div>
            <label className="text-xs font-medium text-app-muted mb-1 block">Tên chiến dịch *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="VD: VPS Growth Campaign"
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-app-muted mb-1 block">Chủ đề / Ngành hàng *</label>
            <input
              type="text"
              value={form.topic}
              onChange={e => { setForm({ ...form, topic: e.target.value }); resetPlan() }}
              placeholder="VD: vps hosting, openclaw"
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-app-muted mb-1 block">Ngôn ngữ group</label>
            <select
              value={form.language}
              onChange={e => { setForm({ ...form, language: e.target.value }); resetPlan() }}
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">Tiếng Anh</option>
              <option value="mixed">Đa ngôn ngữ</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-app-muted mb-1 block">
              Tối thiểu thành viên
              <span className="ml-1 text-app-muted/70">(scout chỉ join nhóm ≥ ngưỡng này)</span>
            </label>
            <input
              type="number"
              min={0}
              step={50}
              value={form.min_member_count}
              onChange={e => setForm({ ...form, min_member_count: parseInt(e.target.value) || 0 })}
              placeholder="100"
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-app-muted mb-1 block flex justify-between items-center">
              <span>Danh sách nhóm chỉ định <span className="text-app-muted/50">(Tùy chọn)</span></span>
              <span className="text-[10px] text-app-dim font-mono-ui">Mỗi dòng một nhóm</span>
            </label>
            <textarea
              value={targetGroupsText}
              onChange={e => { setTargetGroupsText(e.target.value); resetPlan() }}
              rows={3}
              placeholder="Dán link hoặc ID nhóm Facebook, ví dụ:&#10;https://www.facebook.com/groups/vpsvietnam&#10;1234567890"
              className="w-full border border-app-border rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono bg-app-base/10"
            />
            <p className="text-[10px] text-app-dim mt-1">Nếu bỏ trống, hệ thống sẽ tự động quét nhóm theo chủ đề hoặc nhóm đã tham gia.</p>
          </div>
        </div>

        {/* === Section 2: Mission (MAIN INPUT) === */}
        <div className="bg-app-surface rounded border border-app-border p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-app-primary">2. Mô tả mục tiêu *</h2>
            <p className="text-xs text-app-muted mt-1">AI sẽ tự lên kế hoạch dựa trên mô tả này</p>
          </div>
          <textarea
            value={form.mission}
            onChange={e => { setForm({ ...form, mission: e.target.value }); resetPlan() }}
            rows={5}
            placeholder={'VD: Tìm 4-6 nhóm VPS mỗi ngày, tương tác tự nhiên với thành viên,\nkết bạn những người quan tâm VPS, comment hữu ích trong group'}
            className="w-full border border-app-border rounded-lg px-3 py-3 text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* === Section 3: Ads (toggle) === */}
        <div className="bg-app-surface rounded border border-app-border p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Megaphone size={16} className="text-orange-500" />
              <h2 className="text-sm font-semibold text-app-primary">3. Quảng cáo thương hiệu</h2>
            </div>
            <button
              type="button"
              onClick={() => { setAdsEnabled(!adsEnabled); resetPlan() }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                adsEnabled ? 'bg-orange-500' : 'bg-app-hover'
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-app-surface transition-transform ${
                adsEnabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          {!adsEnabled ? (
            <p className="text-xs text-app-muted">Bật để AI có thể đề xuất sản phẩm tự nhiên trong comment khi gặp bài viết liên quan.</p>
          ) : (
            <div className="space-y-3 pt-2">
              <div className="flex items-start gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                <Info size={14} className="text-blue-600 mt-0.5 shrink-0" />
                <p className="text-[11px] text-blue-700 leading-relaxed">
                  AI tự nhận biết cơ hội dựa trên ngữ cảnh bài viết — không cần nhập từ khóa kích hoạt.
                  Khi gặp người đang hỏi/tìm/than phiền về vấn đề thương hiệu giải quyết được, AI sẽ comment tự nhiên.
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-app-muted mb-1 block">Tên thương hiệu *</label>
                <input
                  type="text"
                  value={brand.brand_name}
                  onChange={e => { setBrand({ ...brand, brand_name: e.target.value }); resetPlan() }}
                  placeholder="VD: OpenClaw"
                  className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-app-muted mb-1 block">Mô tả sản phẩm *</label>
                <textarea
                  value={brand.brand_description}
                  onChange={e => { setBrand({ ...brand, brand_description: e.target.value }); resetPlan() }}
                  rows={2}
                  placeholder="VD: AI Agent tự động hóa công việc — phù hợp cho người dùng VPS / cần host nhẹ"
                  className="w-full border border-app-border rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
              </div>

              {/* === NEW: Ad Approach === */}
              <div>
                <label className="text-xs font-medium text-app-muted mb-2 block">Góc tiếp cận quảng cáo *</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => { setBrand({ ...brand, ad_approach: 'soft_sell' }); resetPlan() }}
                    className={`flex flex-col text-left p-3 rounded-xl border transition-all ${
                      brand.ad_approach === 'soft_sell'
                        ? 'bg-orange-500/10 border-orange-500/50 shadow-sm shadow-orange-500/10'
                        : 'bg-app-base border-app-border hover:bg-app-hover text-app-muted'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-xs text-app-primary mb-1">
                      <span className={`${brand.ad_approach === 'soft_sell' ? 'text-orange-500' : 'text-app-muted'}`}>🎭</span>
                      Chia sẻ trải nghiệm (Soft Sell)
                    </div>
                    <span className="text-[10px] text-app-muted leading-relaxed">
                      Nick đóng vai khách hàng hoặc người có kinh nghiệm để chia sẻ một cách khách quan nhất. (Khuyên dùng)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => { setBrand({ ...brand, ad_approach: 'hard_sell' }); resetPlan() }}
                    className={`flex flex-col text-left p-3 rounded-xl border transition-all ${
                      brand.ad_approach === 'hard_sell'
                        ? 'bg-orange-500/10 border-orange-500/50 shadow-sm shadow-orange-500/10'
                        : 'bg-app-base border-app-border hover:bg-app-hover text-app-muted'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-xs text-app-primary mb-1">
                      <span className={`${brand.ad_approach === 'hard_sell' ? 'text-orange-500' : 'text-app-muted'}`}>📢</span>
                      Giới thiệu trực tiếp (Hard Sell)
                    </div>
                    <span className="text-[10px] text-app-muted leading-relaxed">
                      Giới thiệu trực diện thông tin dịch vụ, tính năng nổi bật của sản phẩm, kèm hotline/ưu đãi.
                    </span>
                  </button>
                </div>
              </div>

              {/* === NEW: Sub-products dynamic manager === */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-app-muted block">Danh sách sản phẩm / Phân khúc cụ thể (Tùy chọn)</label>
                  <button
                    type="button"
                    onClick={() => setBrandProducts([...brandProducts, { name: '', description: '' }])}
                    className="text-[10px] text-orange-500 hover:underline flex items-center gap-1"
                  >
                    + Thêm sản phẩm
                  </button>
                </div>
                
                <div className="space-y-2">
                  {brandProducts.map((prod, index) => {
                    const updateProd = (field, val) => {
                      const next = [...brandProducts]
                      next[index] = { ...next[index], [field]: val }
                      setBrandProducts(next)
                      resetPlan()
                    }
                    const removeProd = () => {
                      const next = brandProducts.filter((_, i) => i !== index)
                      setBrandProducts(next.length ? next : [{ name: '', description: '' }])
                      resetPlan()
                    }
                    return (
                      <div key={index} className="flex gap-2 items-start p-2.5 rounded-lg border border-app-border/40 bg-app-base/20 hover:border-app-border/80 transition-colors">
                        <div className="flex-1 space-y-2">
                          <input
                            type="text"
                            value={prod.name}
                            onChange={e => updateProd('name', e.target.value)}
                            placeholder="Tên sản phẩm (VD: Cloud VPS Pro)"
                            className="w-full bg-transparent border-0 border-b border-app-border focus:border-orange-500 focus:ring-0 px-0.5 py-1 text-xs text-app-primary placeholder:text-app-muted/50"
                          />
                          <input
                            type="text"
                            value={prod.description}
                            onChange={e => updateProd('description', e.target.value)}
                            placeholder="Tính năng nổi bật (VD: 4 vCPU, 8GB RAM, SSD NVMe, giảm 20%)"
                            className="w-full bg-transparent border-0 border-b border-app-border/40 focus:border-orange-500 focus:ring-0 px-0.5 py-1 text-[11px] text-app-muted placeholder:text-app-muted/40"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={removeProd}
                          className="p-1 text-app-dim hover:text-danger rounded hover:bg-app-hover transition-colors mt-0.5"
                          title="Xóa sản phẩm"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-app-muted mb-1 block">Comment mẫu (tham khảo tone)</label>
                <textarea
                  value={brand.example_comment}
                  onChange={e => { setBrand({ ...brand, example_comment: e.target.value }); resetPlan() }}
                  rows={2}
                  placeholder='VD: "Mình đang dùng OpenClaw thấy ổn, giá hợp lý lại không lag"'
                  className="w-full border border-app-border rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
                <p className="text-[10px] text-app-dim mt-1">AI sẽ tham khảo tone này khi viết comment có mention thương hiệu</p>
              </div>

              <div>
                <label className="text-xs font-medium text-app-muted mb-2 block">
                  Giọng điệu {brand.brand_voice === 'random' && <span className="text-orange-500">(random — AI chọn tone khác nhau cho mỗi cmt)</span>}
                </label>
                <div className="flex flex-wrap gap-2">
                  {VOICE_OPTIONS.map(v => (
                    <label key={v.value} className={`cursor-pointer px-3 py-2 rounded-lg border text-center text-xs transition-colors ${
                      brand.brand_voice === v.value
                        ? 'bg-orange-50 border-orange-300 text-orange-700 font-medium'
                        : 'bg-app-surface border-app-border text-app-muted hover:bg-app-base'
                    }`}>
                      <input
                        type="radio"
                        name="voice"
                        value={v.value}
                        checked={brand.brand_voice === v.value}
                        onChange={() => { setBrand({ ...brand, brand_voice: v.value }); resetPlan() }}
                        className="hidden"
                      />
                      {v.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* === Section 4: Accounts === */}
        <div className="bg-app-surface rounded border border-app-border p-5">
          <h2 className="text-sm font-semibold text-app-primary mb-2">
            4. Tài khoản thực hiện * <span className="text-xs text-app-muted font-normal">({selectedAccountIds.length} đã chọn)</span>
          </h2>
          {accounts.length === 0 ? (
            <p className="text-xs text-app-muted italic">Chưa có tài khoản nào.</p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {accounts.map(a => {
                  const sel = selectedAccountIds.includes(a.id)
                  return (
                    <button key={a.id} onClick={() => onToggleNick(a, sel)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      sel ? 'bg-info text-white ' : 'bg-app-base text-app-muted hover:bg-app-elevated border border-app-border'
                    }`}>
                      {sel && <Check size={10} />}
                      {a.username || a.fb_user_id}
                    </button>
                  )
                })}
              </div>
              <div className="flex gap-2">
                <button onClick={() => {
                  const allIds = accounts.map(a => a.id)
                  const newOnes = allIds.filter(id => !selectedAccountIds.includes(id))
                  setSelectedAccountIds(allIds)
                  if (aiPlan) {
                    const need = newOnes.filter(id => !perNickPlan[id])
                    if (need.length) fetchPlansForNewNicks(need); else setPlanConfirmed(false)
                  }
                }} className="text-[10px] text-blue-600 hover:underline">Chọn tất cả</button>
                <button onClick={() => { setSelectedAccountIds([]); if (aiPlan) setPlanConfirmed(false) }}
                  className="text-[10px] text-app-muted hover:underline">Bỏ chọn</button>
              </div>

              {/* Per-nick mini plans — only show after AI generation */}
              {selectedAccountIds.length > 0 && Object.keys(perNickPlan).length > 0 && (
                <div className="pt-3 mt-3 border-t border-app-border space-y-1.5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-medium text-purple-700 flex items-center gap-1">
                      <Sparkles size={11} /> Kế hoạch riêng từng nick (AI tự tính)
                    </span>
                    <span className="text-[10px] text-app-muted">click để chỉnh</span>
                  </div>
                  {selectedAccountIds.map(aid => {
                    const acc = accounts.find(a => a.id === aid)
                    if (!acc) return null
                    const plan = perNickPlan[aid]
                    if (!plan) return (
                      <div key={aid} className="flex items-center justify-between px-2 py-1.5 bg-app-base rounded text-[11px] text-app-muted">
                        <span>{acc.username || acc.fb_user_id}</span>
                        <span className="italic">đang chờ AI...</span>
                      </div>
                    )
                    const isExpanded = expandedNick === aid
                    const db = plan.daily_budget || {}
                    const updateBudget = (key, val) => {
                      const num = Math.max(0, parseInt(val) || 0)
                      setPerNickPlan(prev => ({
                        ...prev,
                        [aid]: { ...prev[aid], daily_budget: { ...prev[aid].daily_budget, [key]: num }, ai_generated: false }
                      }))
                      setPlanConfirmed(false)
                    }
                    return (
                      <div key={aid} className="bg-app-base rounded border border-app-border overflow-hidden">
                        <button
                          onClick={() => setExpandedNick(isExpanded ? null : aid)}
                          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-app-elevated transition-colors text-left"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[11px] font-medium text-app-primary truncate">{acc.username || acc.fb_user_id}</span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                              plan.phase === 'mature' ? 'bg-green-100 text-green-700' :
                              plan.phase === 'week4' ? 'bg-blue-100 text-blue-700' :
                              plan.phase === 'week3' ? 'bg-yellow-100 text-yellow-700' :
                              plan.phase === 'week2' ? 'bg-orange-100 text-orange-700' :
                              'bg-red-100 text-red-700'
                            }`}>{plan.phase} · {plan.age_days}d</span>
                            {!plan.ai_generated && <span className="text-[9px] px-1 py-0.5 bg-app-elevated text-app-muted rounded">đã sửa</span>}
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px] text-app-muted ml-2">
                            <span title="Like">👍 {db.like ?? '-'}</span>
                            <span title="Comment">💬 {db.comment ?? '-'}</span>
                            <span title="Quảng cáo">📣 {db.opportunity_comment ?? '-'}</span>
                            <span title="Scout">🔍 {db.scout ?? '-'}</span>
                            <span title="Friend">👥 {db.friend_request ?? '-'}</span>
                          </div>
                        </button>
                        {isExpanded && (
                          <div className="px-3 pb-2.5 pt-1 bg-app-surface border-t border-app-border space-y-2">
                            {plan.note && (
                              <p className="text-[10px] italic text-purple-700">{plan.note}</p>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                              {[
                                { key: 'browse', label: '👀 Lướt feed' },
                                { key: 'like', label: '👍 Like' },
                                { key: 'comment', label: '💬 Comment' },
                                { key: 'opportunity_comment', label: '📣 Quảng cáo' },
                                { key: 'scout', label: '🔍 Thám dò nhóm' },
                                { key: 'friend_request', label: '👥 Kết bạn' },
                                { key: 'post', label: '📝 Đăng bài' },
                              ].map(({ key, label }) => (
                                <label key={key} className="flex items-center justify-between gap-2 text-[10px]">
                                  <span className="text-app-muted">{label}</span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={db[key] ?? 0}
                                    onChange={e => updateBudget(key, e.target.value)}
                                    className="w-14 border border-app-border rounded px-1.5 py-0.5 text-[10px] text-right"
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* === Section 5: Schedule === */}
        <div className="bg-app-surface rounded border border-app-border p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-app-dim" />
              <h2 className="text-sm font-semibold text-app-primary">5. Lịch chạy</h2>
            </div>
            <span className="text-[11px] text-app-muted">{getScheduleDesc()}</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            {DEFAULT_PRESETS.map(p => (
              <button key={p.key} onClick={() => { selectMode(p.key); resetPlan() }}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                  scheduleMode === p.key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-app-surface border-app-border text-app-muted hover:bg-app-base'
                }`}>
                <div>{p.label}</div>
              </button>
            ))}
            <button onClick={() => { selectMode('custom'); resetPlan() }}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                scheduleMode === 'custom' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-app-surface border-app-border text-app-muted hover:bg-app-base'
              }`}>Tùy chỉnh</button>
          </div>
          {scheduleMode === 'custom' && (
            <div className="bg-app-base rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-xs text-app-muted w-8">Giờ:</span>
                <select value={customHour} onChange={e => { const h = parseInt(e.target.value); setCustomHour(h); updateCron('custom', null, null, h, customMinute, customDays); resetPlan() }}
                  className="border border-app-border rounded px-2 py-1 text-sm">
                  {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}</option>)}
                </select>
                <span className="text-app-muted">:</span>
                <select value={customMinute} onChange={e => { const m = parseInt(e.target.value); setCustomMinute(m); updateCron('custom', null, null, customHour, m, customDays); resetPlan() }}
                  className="border border-app-border rounded px-2 py-1 text-sm">
                  {[0, 15, 30, 45].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-app-muted w-8">Ngày:</span>
                {DAY_LABELS.map(d => (
                  <button key={d.value} onClick={() => {
                    const next = customDays.includes(d.value) ? customDays.filter(x => x !== d.value) : [...customDays, d.value].sort()
                    if (!next.length) return
                    setCustomDays(next); updateCron('custom', null, null, customHour, customMinute, next); resetPlan()
                  }} className={`w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                    customDays.includes(d.value) ? 'bg-info text-white' : 'bg-app-hover text-app-muted hover:bg-app-hover'
                  }`}>{d.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* === Section 6: AI Plan output === */}
        {!aiPlan ? (
          <button
            onClick={() => previewMut.mutate()}
            disabled={!canPreview || previewMut.isPending}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded text-sm font-semibold transition-all ${
              canPreview ? 'bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-700 hover:to-blue-700  shadow-purple-200'
                : 'bg-app-elevated text-app-dim cursor-not-allowed'
            }`}
          >
            {previewMut.isPending
              ? <><Loader2 size={16} className="animate-spin" /> AI đang phân tích...</>
              : <><Sparkles size={16} /> AI tạo kế hoạch</>}
          </button>
        ) : (
          <div className="bg-app-surface rounded border-2 border-purple-200 overflow-hidden">
            <div className="px-5 py-3 bg-purple-50 border-b border-purple-100 flex items-center justify-between">
              <span className="text-sm font-semibold text-purple-800 flex items-center gap-2">
                <Sparkles size={14} /> 6. Kế hoạch AI (AI tự quyết định)
              </span>
              {aiPlan.estimated_duration_minutes && (
                <span className="text-xs text-purple-500 flex items-center gap-1">
                  <Clock size={12} /> ~{aiPlan.estimated_duration_minutes} phút/ngày
                </span>
              )}
            </div>

            {hasPerNick ? (
              // Per-nick plans active → Section 6 is a read-only campaign-wide
              // summary derived from Section 4's per-nick edits. Source of truth
              // is per-nick. User edits there to change these totals.
              <div className="px-5 py-4 space-y-2">
                <p className="text-[11px] text-app-muted italic mb-1">
                  Tổng theo {selectedAccountIds.length} nick — sửa từng nick ở mục 4.
                </p>
                {summaryRows.map(row => (
                  <div key={row.key} className="flex items-center gap-3 px-3 py-2 rounded bg-app-base">
                    <span className="text-lg shrink-0">{row.icon}</span>
                    <span className="text-sm font-medium text-app-primary flex-1">{row.label}</span>
                    <span className="text-sm font-bold text-blue-700 w-16 text-right">{row.count}</span>
                    <span className="text-[11px] text-app-muted w-44 shrink-0">{row.unit}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EditablePlanList rows={planRows} onChange={handleRowsChange} />
            )}

            {aiPlan.safety_warnings?.length > 0 && (
              <div className="px-5 py-2 bg-orange-50 border-t border-orange-100">
                {aiPlan.safety_warnings.map((w, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-orange-600">
                    <AlertTriangle size={11} /> {w}
                  </div>
                ))}
              </div>
            )}

            <div className="px-5 py-3 border-t border-app-border flex items-center justify-between">
              <button
                onClick={() => { resetPlan(); previewMut.mutate() }}
                className="flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800"
              >
                <Sparkles size={12} /> Tạo lại
              </button>
              {planConfirmed ? (
                <span className="flex items-center gap-1.5 text-sm text-hermes font-medium">
                  <Check size={14} /> Đã xác nhận
                </span>
              ) : (
                <button
                  onClick={() => setPlanConfirmed(true)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-hermes text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                >
                  <Check size={14} /> Xác nhận & Lưu
                </button>
              )}
            </div>
          </div>
        )}

        {/* === Submit === */}
        <div className="flex justify-end gap-3 pb-8">
          <button onClick={() => navigate('/campaigns')} className="px-4 py-2 text-sm text-app-muted hover:text-app-primary">Hủy</button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!canSubmit || saveMut.isPending}
            className={`flex items-center gap-2 px-6 py-2.5 rounded text-sm font-semibold transition-all ${
              canSubmit ? 'bg-info text-white hover:opacity-90  shadow-blue-200'
                : 'bg-app-hover text-app-dim cursor-not-allowed'
            }`}
          >
            <Save size={16} /> {isEdit ? 'Cập nhật' : 'Tạo AI Pilot'}
          </button>
        </div>
      </div>
    </div>
  )
}
