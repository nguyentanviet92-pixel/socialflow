/**
 * /campaigns/:id — Campaign Hub (Hermes-redesigned)
 *
 * 5 tabs: Overview | Agents | Execution | Content | Data
 * Dense header with Hermes plan summary, campaign status, live stats.
 * Existing section components are reused as tab bodies (no logic rewrite).
 */
import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Play, Pause, Edit, Loader, Brain, X, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import DenseStat from '../../components/hermes/DenseStat'
import HermesCaller from '../../components/hermes/HermesCaller'
import JobRow from '../../components/hermes/JobRow'
import HermesScoreBadge from '../../components/hermes/HermesScoreBadge'

const asArray = (d) => Array.isArray(d) ? d
  : Array.isArray(d?.items) ? d.items
  : Array.isArray(d?.data) ? d.data
  : []

// ─── System Alert Banner ─────────────────────────────────────
function SystemAlertBanner() {
  const { data: alerts } = useQuery({
    queryKey: ['system-alerts-urgent'],
    queryFn: async () => {
      try { return (await api.get('/notifications?limit=5&level=urgent&is_read=false')).data } catch { return null }
    },
    refetchInterval: 15000,
  })

  const unreadAlerts = alerts?.data || []
  if (unreadAlerts.length === 0) return null

  return (
    <div className="m-6 p-4 rounded" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
      <div className="flex items-center gap-2 text-danger font-semibold mb-2 text-sm uppercase tracking-wider">
        <span>⚠</span> System Alerts ({unreadAlerts.length})
      </div>
      <div className="space-y-2">
        {unreadAlerts.map(a => (
          <div key={a.id} className="text-xs text-app-primary">
            <span className="font-medium mr-2">{a.title}</span>
            <span className="text-app-muted">{a.body}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Tab: Overview ─────────────────────────────────────────
// Daily report card — shows latest narrative + today's KPI totals. The
// narrative is optional (LLM might be blocked); fallback is a bullet
// list of the structured stats. User can click 'Tạo lại' to regenerate.
function DailyReportCard({ campaignId }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', campaignId, 'daily-report'],
    queryFn: async () => (await api.get(`/campaigns/${campaignId}/daily-reports?days=1`)).data,
    refetchInterval: 60000,
  })
  const regen = useMutation({
    mutationFn: async () => (await api.post(`/campaigns/${campaignId}/daily-reports/generate`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId, 'daily-report'] })
      toast.success('Đã tạo lại báo cáo')
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })

  const report = data?.reports?.[0]
  if (isLoading) return null
  return (
    <div className="p-6 font-mono-ui text-xs" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-wider text-app-muted">
          Báo cáo hôm nay {report?.date ? `· ${report.date}` : ''}
          {report?.narrative_provider && <span className="ml-2 text-hermes text-[9px]">via {report.narrative_provider}</span>}
        </div>
        <div className="flex-1" />
        <button
          className="btn-ghost text-[10px] uppercase tracking-wider"
          onClick={() => regen.mutate()}
          disabled={regen.isPending}
        >
          {regen.isPending ? 'Đang tạo…' : 'Tạo lại'}
        </button>
      </div>
      {!report ? (
        <div className="text-app-muted">Chưa có báo cáo hôm nay. Cron chạy 22:00 — hoặc bấm "Tạo lại".</div>
      ) : (
        <>
          {report.narrative_text ? (
            <div
              className="p-3 mb-3 text-[13px] leading-relaxed text-app-primary"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              {report.narrative_text}
            </div>
          ) : (
            <div
              className="p-3 mb-3 text-app-muted"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              (LLM narrative chưa tạo được — dưới là số liệu thô)
            </div>
          )}
          {report.stats && (() => {
            const hasOpp = (report.stats.target?.opportunity_comments || 0) > 0
            const cells = [
              { k: 'Like',    got: report.stats.totals?.likes,           tgt: report.stats.target?.likes },
              { k: 'Comment', got: report.stats.totals?.comments,        tgt: report.stats.target?.comments },
              ...(hasOpp ? [{ k: 'QC',    got: report.stats.totals?.opportunity_comments, tgt: report.stats.target?.opportunity_comments }] : []),
              { k: 'Kết bạn', got: report.stats.totals?.friend_requests, tgt: report.stats.target?.friend_requests },
              { k: 'Join',    got: report.stats.totals?.group_joins,     tgt: report.stats.target?.group_joins },
              { k: 'Fails',   got: report.stats.failures?.total,         tgt: null },
            ]
            const cols = cells.length
            return (
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {cells.map(({ k, got, tgt }) => (
                <div key={k} className="p-2" style={{ border: '1px solid var(--border)' }}>
                  <div className="text-[10px] text-app-muted uppercase tracking-wider">{k}</div>
                  <div className={`text-lg ${tgt > 0 && got >= tgt ? 'text-hermes' : (k === 'Fails' && got > 0 ? 'text-danger' : 'text-app-primary')}`}>
                    {got ?? 0}{tgt != null ? <span className="text-app-dim text-xs">/{tgt}</span> : ''}
                  </div>
                </div>
              ))}
              </div>
            )
          })()}
          {report.stats?.highlights && (report.stats.highlights.top?.length > 0 || report.stats.highlights.bottom?.length > 0) && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              {report.stats.highlights.top?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-app-muted mb-1">🏆 Top nicks</div>
                  {report.stats.highlights.top.map((n) => (
                    <div key={n.account_id} className="text-[11px]">
                      <span className="text-hermes">{n.username}</span>
                      <span className="text-app-muted"> · {n.done}/{n.target} ({n.pct}%)</span>
                    </div>
                  ))}
                </div>
              )}
              {report.stats.highlights.bottom?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-app-muted mb-1">⚠ Nicks yếu</div>
                  {report.stats.highlights.bottom.map((n) => (
                    <div key={n.account_id} className="text-[11px]">
                      <span className="text-warn">{n.username}</span>
                      <span className="text-app-muted"> · {n.done}/{n.target} ({n.pct}%)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function OverviewTab({ campaign, campaignId }) {
  const nav = useNavigate()
  const [, setSearchParams] = useSearchParams()
  const [editingKpi, setEditingKpi] = useState(null) // { row } when modal open
  const { data: kpi } = useQuery({
    queryKey: ['campaigns', campaignId, 'kpi'],
    queryFn: async () => {
      try { return (await api.get(`/campaigns/${campaignId}/kpi-today`)).data } catch { return null }
    },
    refetchInterval: 60000,
  })

  // Per-nick daily job quota usage — batched client-side since each account
  // needs its own GET /accounts/:id/quota-today call. Quota matches agent
  // drain rate; once a nick hits quota, schedulers stop creating jobs for it.
  const { data: quotaMap = {} } = useQuery({
    queryKey: ['campaigns', campaignId, 'nick-quotas', kpi?.rows?.map(r => r.account_id).join(',')],
    queryFn: async () => {
      const rows = kpi?.rows || []
      if (!rows.length) return {}
      const entries = await Promise.all(rows.map(async (r) => {
        try {
          const q = (await api.get(`/accounts/${r.account_id}/quota-today`)).data || {}
          const totalUsed = Object.values(q).reduce((s, v) => s + (v.used || 0), 0)
          const totalQuota = Object.values(q).reduce((s, v) => s + (v.quota || 0), 0)
          return [r.account_id, { used: totalUsed, total: totalQuota, detail: q }]
        } catch { return [r.account_id, null] }
      }))
      return Object.fromEntries(entries)
    },
    enabled: !!(kpi?.rows?.length),
    refetchInterval: 60000,
  })

  const roles = campaign?.campaign_roles || []
  const totalNicks = roles.reduce((s, r) => s + (r.account_ids?.length || 0), 0)

  const hctx = campaign?.hermes_context || {}

  return (
    <div className="overflow-auto font-mono-ui">
      <SystemAlertBanner />
      <DailyReportCard campaignId={campaignId} />
      <div className="p-6">
      {/* Empty state — prompt to configure Hermes */}
      {!campaign?.goal && !hctx.product_name && (
        <div
          className="mb-6 p-4 flex items-center gap-4"
          style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}
        >
          <span className="text-2xl">🧠</span>
          <div className="flex-1">
            <div className="text-app-primary text-sm">Hermes chưa có context cho campaign này</div>
            <div className="text-app-muted text-xs mt-0.5">
              Set goal + product info để Hermes hiểu rõ chiến dịch + gen comment chất lượng cao hơn
            </div>
          </div>
          <button
            onClick={() => nav(`/campaigns/${campaignId}/hermes`)}
            className="btn-hermes whitespace-nowrap"
          >
            Cài đặt Hermes
          </button>
        </div>
      )}

      {/* Goal (Hermes-readable) */}
      {campaign?.goal && (
        <div className="mb-6">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-app-muted mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-hermes hermes-pulse" />
            Mục tiêu cho Hermes
          </div>
          <div
            className="p-4 text-sm text-app-primary leading-relaxed"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--hermes-fade)' }}
          >
            {campaign.goal}
          </div>
        </div>
      )}

      {/* Product info (Hermes context) */}
      {(hctx.product_name || hctx.key_features || hctx.tone) && (
        <div className="mb-6">
          <div className="text-[10px] uppercase tracking-wider text-app-muted mb-2">
            Thông tin sản phẩm (Hermes context)
          </div>
          <div className="p-4" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            {hctx.product_name && (
              <div className="mb-2 text-app-primary text-sm">
                <span className="text-app-muted">Sản phẩm: </span>
                <span className="text-hermes">{hctx.product_name}</span>
                {hctx.price && <span className="text-app-muted ml-2">· {hctx.price}</span>}
              </div>
            )}
            {Array.isArray(hctx.key_features) && hctx.key_features.length > 0 && (
              <div className="text-xs text-app-muted mb-1">
                Điểm mạnh: <span className="text-app-primary">{hctx.key_features.join(' · ')}</span>
              </div>
            )}
            {hctx.target_audience && (
              <div className="text-xs text-app-muted mb-1">
                Đối tượng: <span className="text-app-primary">{hctx.target_audience}</span>
              </div>
            )}
            {hctx.tone && (
              <div className="text-xs text-app-muted mb-1">
                Tone: <span className="text-app-primary">{hctx.tone}</span>
              </div>
            )}
            {Array.isArray(hctx.avoid) && hctx.avoid.length > 0 && (
              <div className="text-xs text-app-muted mb-1">
                Tránh: <span className="text-warn">{hctx.avoid.join(', ')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mission */}
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-wider text-app-muted mb-2">Mission</div>
        <div
          className="p-4 text-sm text-app-primary leading-relaxed"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          {campaign?.mission || campaign?.description || 'No mission description.'}
        </div>
      </div>

      {/* Topic + Brand */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-app-muted mb-2">Topic</div>
          <div
            className="p-3 text-sm text-app-primary"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
          >
            {campaign?.topic || '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-app-muted mb-2">Brand / Product</div>
          <div
            className="p-3 text-sm text-app-primary"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
          >
            {campaign?.brand_config?.brand_name || campaign?.product_name || '—'}
          </div>
        </div>
      </div>

      {/* Roles breakdown */}
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-wider text-app-muted mb-2">
          Roles ({roles.length}) · {totalNicks} agents assigned
        </div>
        {roles.length === 0 ? (
          <div
            className="p-4 text-sm text-app-muted"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
          >
            No roles configured yet.
          </div>
        ) : (
          <div style={{ border: '1px solid var(--border)' }}>
            {roles.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-4 px-4 py-2 text-xs"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="flex-1 text-app-primary truncate">
                  {r.role_type || r.name || 'unnamed'}
                </span>
                <span className="text-app-muted">{r.account_ids?.length || 0} nicks</span>
                <span className={r.is_active ? 'text-hermes' : 'text-app-muted'}>
                  ● {r.is_active ? 'active' : 'paused'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KPI today */}
      {kpi?.rows?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-app-muted mb-2">
            KPI today
          </div>
          <div style={{ border: '1px solid var(--border)' }}>
            <div
              className="flex items-center gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-app-muted"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <span className="flex-1">Nick</span>
              <span className="w-20 text-right">Likes</span>
              <span className="w-24 text-right">Comments</span>
              <span className="w-16 text-right" title="Branded/ad opportunity comments — separate from normal comments">QC</span>
              <span className="w-20 text-right">FR</span>
              <span className="w-20 text-right">Groups</span>
              <span className="w-20 text-right" title="Jobs created today (all types) vs daily quota">Quota</span>
              <span className="w-16 text-right">Status</span>
            </div>
            {kpi.rows.slice(0, 10).map((row, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setEditingKpi({ row })}
                title="Click để sửa target KPI hôm nay"
                className="w-full flex items-center gap-3 px-4 py-2 text-xs hover:bg-app-muted/10 text-left"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="flex-1 text-app-primary truncate">
                  {row.username || row.nick_name || row.account_id?.slice(0, 8)}
                </span>
                <span className="w-20 text-right text-app-muted font-mono-ui">
                  {row.done_likes || 0}/{row.target_likes || 0}
                </span>
                <span className="w-24 text-right text-app-muted font-mono-ui">
                  {row.done_comments || 0}/{row.target_comments || 0}
                </span>
                <span
                  className="w-16 text-right font-mono-ui"
                  style={{ color: (row.target_opportunity_comments || 0) === 0 ? 'var(--text-dim)' :
                    ((row.done_opportunity_comments || 0) >= (row.target_opportunity_comments || 0) ? 'var(--hermes)' : 'var(--text-muted)') }}
                  title="Opportunity/ad comments"
                >
                  {(row.target_opportunity_comments || 0) === 0 ? '—' : `${row.done_opportunity_comments || 0}/${row.target_opportunity_comments}`}
                </span>
                <span className="w-20 text-right text-app-muted font-mono-ui">
                  {row.done_friend_requests || 0}/{row.target_friend_requests || 0}
                </span>
                <span className="w-20 text-right text-app-muted font-mono-ui">
                  {row.done_group_joins || 0}/{row.target_group_joins || 0}
                </span>
                <span
                  className="w-20 text-right font-mono-ui"
                  style={{
                    color: quotaMap[row.account_id]
                      ? (quotaMap[row.account_id].used / Math.max(1, quotaMap[row.account_id].total) > 0.8 ? 'var(--warn)' : 'var(--text-muted)')
                      : 'var(--text-dim)'
                  }}
                  title={quotaMap[row.account_id]?.detail ? Object.entries(quotaMap[row.account_id].detail).map(([k, v]) => `${k}: ${v.used}/${v.quota}`).join('\n') : 'chưa có quota'}
                >
                  {quotaMap[row.account_id]
                    ? `${quotaMap[row.account_id].used}/${quotaMap[row.account_id].total}`
                    : '—'}
                </span>
                <span className={`w-16 text-right ${row.kpi_met ? 'text-hermes' : 'text-app-muted'}`}>
                  {row.kpi_met ? '✓ met' : '...'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      </div>

      {editingKpi && createPortal(
        <EditKpiModal
          campaignId={campaignId}
          row={editingKpi.row}
          hasOpp={true}
          onClose={() => setEditingKpi(null)}
        />,
        document.body
      )}
    </div>
  )
}

// Modal: edit per-nick target KPI for today. Backend route is
// PATCH /campaigns/:id/kpi-today/:account_id and only accepts target_*
// fields (done_* + kpi_met are computed and stay read-only).
function EditKpiModal({ campaignId, row, hasOpp, onClose }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    target_likes: row.target_likes || 0,
    target_comments: row.target_comments || 0,
    target_friend_requests: row.target_friend_requests || 0,
    target_group_joins: row.target_group_joins || 0,
    target_opportunity_comments: row.target_opportunity_comments || 0,
    auto_ad_enabled: row.auto_ad_enabled || false,
  })

  const save = useMutation({
    mutationFn: async () => (
      await api.patch(`/campaigns/${campaignId}/kpi-today/${row.account_id}`, form)
    ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId, 'kpi'] })
      toast.success('Đã cập nhật target KPI')
      onClose()
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })

  const setField = (k) => (e) => {
    const v = parseInt(e.target.value, 10)
    setForm(f => ({ ...f, [k]: Number.isFinite(v) && v >= 0 ? Math.min(v, 500) : 0 }))
  }

  // Click backdrop to close, but not when clicking inside the modal panel.
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-app-surface rounded border border-app-border w-full max-w-md p-5 font-mono-ui text-xs"
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-app-muted">Sửa KPI hôm nay</div>
            <div className="text-app-primary mt-0.5">{row.username || row.account_id?.slice(0, 8)}</div>
          </div>
          <button type="button" onClick={onClose} className="text-app-muted hover:text-app-primary">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          {[
            { k: 'target_likes', label: 'Like', done: row.done_likes },
            { k: 'target_comments', label: 'Comment', done: row.done_comments },
            ...(hasOpp ? [{ k: 'target_opportunity_comments', label: 'QC (ad/brand)', done: row.done_opportunity_comments }] : []),
            { k: 'target_friend_requests', label: 'Friend Request', done: row.done_friend_requests },
            { k: 'target_group_joins', label: 'Join Group', done: row.done_group_joins },
          ].map(({ k, label, done }) => (
            <div key={k} className="flex items-center gap-3">
              <label className="flex-1 text-app-muted">{label}</label>
              <span className="text-app-dim w-10 text-right">{done || 0} /</span>
              <input
                type="number"
                min={0}
                max={500}
                value={form[k]}
                onChange={setField(k)}
                disabled={k === 'target_opportunity_comments' && form.auto_ad_enabled}
                className={`w-20 px-2 py-1 bg-app-elevated border border-app-border rounded text-app-primary text-right ${k === 'target_opportunity_comments' && form.auto_ad_enabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-app-border mt-3">
            <div className="flex-1 flex flex-col">
              <label className="text-app-primary">Auto QC (ad/brand)</label>
              <span className="text-[10px] text-app-dim normal-case mt-1">Tự động nhận diện bài tiềm năng và cmt thả thính mà không bị gò bó bởi target ở trên (chỉ giới hạn bởi tổng comment/ngày).</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={form.auto_ad_enabled}
                onChange={e => setForm(f => ({ ...f, auto_ad_enabled: e.target.checked }))}
              />
              <div className="w-9 h-5 bg-app-muted/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-hermes"></div>
            </label>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-app-muted hover:text-app-primary"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="px-4 py-1.5 bg-hermes text-app-bg rounded hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Manual trigger — fires runOrchestration synchronously and surfaces the
// summary so the user gets instant feedback (instead of waiting up to 15
// minutes for the cron). Shows action count + health score in the toast.
function HermesRunNowButton({ campaignId }) {
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: async () => (await api.post(`/ai-hermes/orchestrate/${campaignId}`)).data,
    onSuccess: (data) => {
      const actions = (data?.actions || []).length
      const auto = (data?.actions || []).filter(a => a.outcome === 'success').length
      toast.success(
        `Hermes chạy xong — health ${data?.health_score ?? '?'}, ${actions} actions, ${auto} auto-applied`,
        { duration: 5000 }
      )
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId] })
      qc.invalidateQueries({ queryKey: ['hermes-decisions'] })
    },
    onError: (err) => {
      const msg = err?.response?.data?.error || err.message || 'Unknown'
      // Surface LLM billing errors prominently — user almost certainly wants
      // to know their DeepSeek ran out rather than blame 'Hermes broken'
      if (/402|Insufficient|Payment|billing/i.test(msg)) {
        toast.error('LLM hết tiền — check provider billing ở /hermes/settings', { duration: 8000 })
      } else {
        toast.error(`Hermes lỗi: ${msg.substring(0, 150)}`, { duration: 6000 })
      }
    },
  })
  return (
    <button
      className="btn-ghost font-mono-ui text-[11px] uppercase tracking-wider"
      onClick={() => mut.mutate()}
      disabled={mut.isPending}
      title="Trigger Hermes orchestrator immediately (bypass cron)"
      style={{ borderColor: 'var(--hermes)', color: 'var(--hermes)' }}
    >
      {mut.isPending ? '🧠 đang chạy…' : '🧠 RUN HERMES'}
    </button>
  )
}

// Compact toggle in the campaign header. When ON, the dumb schedulers stop
// touching this campaign — only the Hermes orchestrator decides when to
// queue jobs. Gives the user a one-click 'let Hermes run it' switch.
function HermesCentralToggle({ campaign }) {
  const qc = useQueryClient()
  const active = !!campaign?.hermes_central
  const mut = useMutation({
    mutationFn: async (val) => api.put(`/campaigns/${campaign.id}`, { hermes_central: val }),
    onSuccess: (_, val) => {
      qc.invalidateQueries({ queryKey: ['campaigns', campaign.id] })
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      toast.success(val ? 'Hermes-central: ON' : 'Hermes-central: OFF')
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })
  return (
    <button
      onClick={() => mut.mutate(!active)}
      disabled={mut.isPending}
      title={active
        ? 'Hermes đang điều phối đơn: schedulers không tạo job cho campaign này'
        : 'Bật để Hermes làm trung tâm điều phối (tắt scheduler)'}
      className="btn-ghost font-mono-ui text-[11px] uppercase tracking-wider"
      style={{
        borderColor: active ? 'var(--hermes)' : 'var(--border)',
        color: active ? 'var(--hermes)' : 'var(--text-muted)',
      }}
    >
      🧠 {active ? 'Hermes ON' : 'Hermes OFF'}
    </button>
  )
}

// ─── Tab: Agents — unified view (assignments + today KPI from Hermes) ─────
// Source of truth merges three signals so the list is always accurate:
//   1. campaign_roles[].account_ids  — explicit assignments (manual mode)
//   2. campaign.account_ids          — top-level assignment (AI_PILOT mode)
//   3. nick_kpi_daily rows (today)   — nicks Hermes has actually touched,
//      even if no role row exists yet
// Per-nick today KPI comes from /campaigns/:id/kpi-today (the same endpoint
// the Overview KPI table uses) — do NOT introduce a separate per-nick stats
// query, keep one source so numbers stay consistent across tabs.
function AgentsTab({ campaign }) {
  const qc = useQueryClient()
  const [pickerOpen, setPickerOpen] = useState(false)

  const campaignId = campaign?.id
  const roles = campaign?.campaign_roles || []
  const rolesAccountIds = roles.flatMap(r => r.account_ids || [])
  const topLevelAccountIds = campaign?.account_ids || []

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts', 'all'],
    queryFn: async () => asArray((await api.get('/accounts')).data),
  })

  const { data: kpiToday } = useQuery({
    queryKey: ['campaigns', campaignId, 'kpi-agents'],
    enabled: !!campaignId,
    queryFn: async () => {
      try { return (await api.get(`/campaigns/${campaignId}/kpi-today`)).data } catch { return null }
    },
    refetchInterval: 30000,
  })

  const kpiRows = kpiToday?.rows || []
  const kpiByAccount = useMemo(() => Object.fromEntries(kpiRows.map(r => [r.account_id, r])), [kpiRows])

  const allAccountIds = useMemo(() => {
    const s = new Set([...rolesAccountIds, ...topLevelAccountIds, ...kpiRows.map(r => r.account_id)])
    return [...s].filter(Boolean)
  }, [rolesAccountIds.join(','), topLevelAccountIds.join(','), kpiRows.length])

  const assignedAccounts = accounts.filter(a => allAccountIds.includes(a.id))
  const unassignedAccounts = accounts.filter(a => !allAccountIds.includes(a.id))

  const saveAccounts = useMutation({
    mutationFn: async (newIds) => {
      await api.put(`/campaigns/${campaignId}`, { account_ids: newIds })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId] })
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId, 'kpi-agents'] })
      toast.success('Cập nhật agents')
    },
    onError: (err) => toast.error(`Lỗi: ${err?.response?.data?.error || err.message}`),
  })

  const addAgent = (acc) => {
    const merged = [...new Set([...topLevelAccountIds, ...rolesAccountIds, acc.id])]
    saveAccounts.mutate(merged)
    setPickerOpen(false)
  }

  const removeAgent = (acc) => {
    if (!confirm(`Gỡ ${acc.username} khỏi chiến dịch?`)) return
    const merged = [...new Set([...topLevelAccountIds, ...rolesAccountIds])].filter(id => id !== acc.id)
    saveAccounts.mutate(merged)
  }

  return (
    <div className="overflow-auto p-6 font-mono-ui">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-wider text-app-muted">
          Assigned agents ({assignedAccounts.length}) — KPI hôm nay từ Hermes
        </div>
        <button
          className="btn-hermes text-[11px] px-3 py-1"
          onClick={() => setPickerOpen(true)}
        >
          + THÊM AGENT
        </button>
      </div>

      {assignedAccounts.length === 0 ? (
        <div
          className="p-6 text-sm text-app-muted text-center"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          Chưa có agent. Bấm "Thêm agent" để Hermes bắt đầu phân việc.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3 px-4 py-2 text-[10px] uppercase text-app-muted" style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
            <span className="flex-1">Agent</span>
            <span className="w-28 hidden md:inline">Role</span>
            <span className="w-20">Status</span>
            <span className="w-16 text-right">Done</span>
            <span className="w-16 text-right">Target</span>
            <span className="w-12 text-right">%</span>
            <span className="w-8"></span>
          </div>
          {assignedAccounts.map((acc) => {
            const accRoles = roles.filter(r => r.account_ids?.includes(acc.id))
            const k = kpiByAccount[acc.id]
            const done = k?.total_done || 0
            const target = k?.total_target || 0
            const pct = k?.progress_pct || 0
            return (
              <div
                key={acc.id}
                className="flex items-center gap-3 px-4 py-2 text-xs"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="flex-1 text-app-primary truncate">
                  {acc.username || acc.id.slice(0, 8)}
                </span>
                <span className="w-28 text-app-muted truncate hidden md:inline">
                  {accRoles.map(r => r.role_type || r.name).filter(Boolean).join(', ') || 'hermes'}
                </span>
                <span className={`w-20 truncate ${
                  acc.status === 'healthy' ? 'text-hermes' :
                  acc.status === 'at_risk' ? 'text-warn' :
                  ['checkpoint', 'session_expired', 'expired'].includes(acc.status) ? 'text-danger' : 'text-app-muted'
                }`}>
                  ● {acc.status || '—'}
                </span>
                <span className="w-16 text-right text-app-primary">{done}</span>
                <span className="w-16 text-right text-app-muted">{target}</span>
                <span className={`w-12 text-right ${pct >= 80 ? 'text-hermes' : 'text-app-muted'}`}>
                  {pct}%
                </span>
                <button
                  className="w-8 text-danger hover:opacity-80"
                  onClick={() => removeAgent(acc)}
                  title="Gỡ agent khỏi campaign"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {pickerOpen && createPortal(
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full max-w-md max-h-[80vh] flex flex-col"
            style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="text-app-primary text-sm">Thêm agent vào chiến dịch</div>
              <button onClick={() => setPickerOpen(false)} className="text-app-muted hover:text-app-primary">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {unassignedAccounts.length === 0 ? (
                <div className="p-6 text-center text-app-muted text-xs">
                  Tất cả nick đã được gán cho chiến dịch này.
                </div>
              ) : (
                unassignedAccounts.map((acc) => (
                  <button
                    key={acc.id}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left text-xs hover-row"
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onClick={() => addAgent(acc)}
                    disabled={saveAccounts.isPending}
                  >
                    <span className="flex-1 text-app-primary truncate">{acc.username || acc.id.slice(0, 8)}</span>
                    <span className={
                      acc.status === 'healthy' ? 'text-hermes' :
                      ['checkpoint', 'session_expired', 'expired'].includes(acc.status) ? 'text-danger' : 'text-app-muted'
                    }>
                      ● {acc.status || '—'}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Tab: Content (posts published by this campaign) ───────
function ContentTab({ campaignId }) {
  const { data: posts = [], isLoading } = useQuery({
    queryKey: ['campaigns', campaignId, 'content'],
    queryFn: async () => {
      try {
        const res = await api.get(`/campaigns/${campaignId}/content`)
        return asArray(res.data)
      } catch {
        return []
      }
    },
    refetchInterval: 30000,
  })

  const formatTime = (ts) => {
    if (!ts) return '—'
    const d = new Date(ts)
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
      + ' · ' + d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
  }

  return (
    <div className="overflow-auto p-6 font-mono-ui">
      <div className="text-[10px] uppercase tracking-wider text-app-muted mb-3">
        Content đã đăng ({posts.length})
      </div>
      {isLoading ? (
        <div className="p-4 text-app-muted">Đang tải...</div>
      ) : posts.length === 0 ? (
        <div
          className="p-6 text-sm text-app-muted text-center"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          Chưa có nội dung nào được đăng cho chiến dịch này.
        </div>
      ) : (
        <div className="space-y-2">
          {posts.map((p) => {
            const statusColor = p.status === 'success' ? 'text-hermes'
              : p.status === 'failed' ? 'text-danger' : 'text-app-muted'
            const targetIcon = p.target_type === 'group' ? '👥'
              : p.target_type === 'page' ? '📄' : '👤'
            return (
              <div
                key={p.id}
                className="p-3"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
              >
                {/* Header row */}
                <div className="flex items-center gap-2 mb-2 text-xs">
                  <AgentStatusDot status={p.status === 'success' ? 'online' : 'error'} />
                  <span className="text-app-primary">{p.account?.username || p.account_id?.slice(0, 8) || '?'}</span>
                  <span className="text-app-muted">→</span>
                  <span className="text-app-primary">{targetIcon} {p.target_name || p.target_fb_id || 'unknown'}</span>
                  <div className="flex-1" />
                  <span className="text-app-muted text-[10px]">{formatTime(p.published_at)}</span>
                  <span className={`text-[10px] uppercase ${statusColor}`}>· {p.status}</span>
                  {p.post_url && (
                    <a
                      href={p.post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-info hover:text-hermes"
                    >
                      [Xem bài ↗]
                    </a>
                  )}
                </div>
                {/* Caption */}
                {p.final_caption && (
                  <div
                    className="text-xs text-app-primary pl-4"
                    style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}
                  >
                    {p.final_caption.substring(0, 300)}
                    {p.final_caption.length > 300 && '...'}
                  </div>
                )}
                {/* Metrics if available */}
                {(p.reactions > 0 || p.comments > 0 || p.shares > 0) && (
                  <div className="mt-2 flex gap-3 text-[10px] text-app-muted font-mono-ui">
                    {p.reactions > 0 && <span>❤ {p.reactions}</span>}
                    {p.comments > 0 && <span>💬 {p.comments}</span>}
                    {p.shares > 0 && <span>↪ {p.shares}</span>}
                  </div>
                )}
                {p.error_message && (
                  <div className="mt-2 text-[10px] text-danger">⚠ {p.error_message}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Tab: Nhóm (campaign groups with join_status) ──────────
function GroupsTab({ campaignId }) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState('all')

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['campaigns', campaignId, 'groups', filter],
    queryFn: async () => {
      try {
        const res = await api.get(`/campaigns/${campaignId}/fb-groups?status=${filter}`)
        return asArray(res.data)
      } catch {
        return []
      }
    },
    refetchInterval: 30000,
  })

  const updateStatus = useMutation({
    mutationFn: async ({ id, status, reason }) => {
      await api.patch(`/groups/${id}/status`, { status, reason })
    },
    onSuccess: () => {
      toast.success('Đã cập nhật status')
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId, 'groups'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  // Pin/unpin priority — agent visits + comments here BEFORE tier-ranked groups
  const togglePriority = useMutation({
    mutationFn: async ({ id, priority_visit }) => {
      await api.patch(`/campaigns/${campaignId}/groups/${id}/priority`, { priority_visit })
    },
    onSuccess: (_, vars) => {
      toast.success(vars.priority_visit ? 'Đã pin ưu tiên' : 'Đã bỏ pin')
      qc.invalidateQueries({ queryKey: ['campaigns', campaignId, 'groups'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  // Counts
  const counts = useMemo(() => {
    const c = { all: groups.length, member: 0, pending: 0, rejected: 0, banned: 0, unknown: 0 }
    for (const g of groups) c[g.join_status || 'unknown'] = (c[g.join_status || 'unknown'] || 0) + 1
    return c
  }, [groups])

  const filteredGroups = filter === 'all' ? groups : groups.filter(g => g.join_status === filter)

  const STATUS_BADGE = {
    member: { text: '● Đã tham gia', color: 'text-hermes' },
    pending: { text: '⏳ Chờ duyệt', color: 'text-warn' },
    rejected: { text: '❌ Chưa tham gia', color: 'text-danger' },
    banned: { text: '🚫 Bị chặn', color: 'text-danger' },
    unknown: { text: '? Chưa xác định', color: 'text-app-muted' },
  }

  return (
    <div className="overflow-auto p-6 font-mono-ui">
      {counts.all === 0 && (
        <div className="mb-4 bg-red-50 border-l-4 border-red-500 p-4 rounded text-sm text-red-700 font-sans">
          <p className="font-semibold">Cảnh báo: Chiến dịch này chưa có nhóm nào được gán!</p>
          <p className="mt-1">Vui lòng không tự ý tìm kiếm nhóm bên ngoài Facebook để bình luận thủ công. Hãy gán nhóm hợp lệ vào chiến dịch hoặc liên hệ admin để được hỗ trợ.</p>
        </div>
      )}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[10px] uppercase tracking-wider text-app-muted">
          Nhóm tham gia ({counts.all})
        </span>
        <div className="flex-1" />
        {['all', 'member', 'pending', 'rejected', 'banned', 'unknown'].map(s => {
          const displayLabel = {
            all: 'tất cả',
            member: 'đã tham gia',
            pending: 'chờ duyệt',
            rejected: 'chưa tham gia',
            banned: 'bị chặn',
            unknown: 'chưa xác định'
          }[s] || s
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-[11px] uppercase px-2 py-1 ${
                filter === s ? 'text-hermes' : 'text-app-muted hover:text-app-primary'
              }`}
              style={{
                background: filter === s ? 'var(--hermes-dim)' : 'transparent',
                border: '1px solid ' + (filter === s ? 'var(--hermes-fade)' : 'var(--border)'),
              }}
            >
              {displayLabel} ({counts[s] || 0})
            </button>
          )
        })}
      </div>

      {isLoading ? (
        <div className="text-app-muted">Đang tải...</div>
      ) : filteredGroups.length === 0 ? (
        <div
          className="p-6 text-sm text-app-muted text-center"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          {filter === 'all' ? 'Chưa có nhóm nào cho chiến dịch này.' : `Không có nhóm status "${filter}".`}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map((g) => {
            const badge = STATUS_BADGE[g.join_status || 'unknown']
            const pinned = g.priority_visit === true
            return (
              <div
                key={g.id}
                className="p-3"
                style={{
                  background: 'var(--bg-elevated)',
                  border: pinned
                    ? '1px solid var(--hermes)'
                    : g.overdue
                      ? '1px solid rgba(249,115,22,0.4)'
                      : '1px solid var(--border)',
                }}
              >
                <div className="flex items-center gap-3 text-xs">
                  <input
                    type="checkbox"
                    checked={pinned}
                    onChange={(e) => togglePriority.mutate({ id: g.id, priority_visit: e.target.checked })}
                    disabled={togglePriority.isPending}
                    title="Pin ưu tiên — agent sẽ visit + comment ở đây trước"
                    className="cursor-pointer accent-hermes"
                  />
                  {pinned && (
                    <span className="text-[10px] uppercase text-hermes" title="Pinned to top of visit queue">
                      📌 pin
                    </span>
                  )}
                  <span className="flex-1 text-app-primary truncate">{g.name || g.fb_group_id}</span>
                  
                  {/* Assigned Nick Avatars with Border Statuses */}
                  {g.assigned_nicks && g.assigned_nicks.length > 0 && (
                    <div className="flex items-center -space-x-1.5 mr-2">
                      {g.assigned_nicks.slice(0, 4).map((n, i) => {
                        const isMember = n.is_member === true
                        const isPending = n.pending_approval === true
                        let borderClass = 'border-white'
                        let titleSuffix = ' (Chưa tham gia)'
                        let opacityClass = 'opacity-40 grayscale'
                        if (isMember) {
                          borderClass = 'border-green-500 ring-1 ring-green-500'
                          titleSuffix = ' (Đã tham gia)'
                          opacityClass = ''
                        } else if (isPending) {
                          borderClass = 'border-amber-500 ring-1 ring-amber-500'
                          titleSuffix = ' (Chờ duyệt)'
                          opacityClass = 'opacity-70'
                        }

                        return (
                          <div key={n.id || i} title={`${n.username || '?'}${titleSuffix}`}
                            className={`w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 text-white flex items-center justify-center text-[8px] font-bold border ${borderClass} ${opacityClass} shrink-0`}
                            style={{ zIndex: 10 - i }}>
                            {(n.username || '?').substring(0, 2).toUpperCase()}
                          </div>
                        )
                      })}
                      {g.assigned_nicks.length > 4 && (
                        <div className="w-5 h-5 rounded-full bg-app-hover text-app-muted flex items-center justify-center text-[8px] font-bold border border-white shrink-0">
                          +{g.assigned_nicks.length - 4}
                        </div>
                      )}
                    </div>
                  )}

                  <span className="text-app-muted">👥 {g.member_count ? (g.member_count >= 1000 ? `${Math.round(g.member_count / 1000)}k` : g.member_count) : '?'}</span>
                  <span className={badge.color}>{badge.text}</span>
                  {g.overdue && (
                    <span className="text-[10px] text-warn uppercase px-1.5 py-0.5" style={{ border: '1px solid rgba(249,115,22,0.4)' }}>
                      Quá hạn
                    </span>
                  )}
                  {g.url && (
                    <a href={g.url} target="_blank" rel="noopener noreferrer" className="text-info hover:text-hermes text-[10px]">
                      [Xem ↗]
                    </a>
                  )}
                </div>

                {/* AI Evaluation / Health Monitor */}
                <div className="mt-1.5 flex items-center gap-3 text-[10px] text-app-muted">
                  {g.score_tier && (
                    <span className={
                      g.score_tier === 'tier1_potential' ? 'text-hermes' : 
                      g.score_tier === 'tier2_prospect' ? 'text-info' : 'text-app-muted'
                    }>
                      💎 {g.score_tier.replace('_', ' ')}
                    </span>
                  )}
                  {g.risk_level && (
                    <span className={
                      g.risk_level === 'high' ? 'text-danger' : 
                      g.risk_level === 'medium' ? 'text-warn' : 'text-hermes'
                    }>
                      🛡 risk: {g.risk_level}
                    </span>
                  )}
                  {g.global_score > 0 && <span>⭐ score: {g.global_score}</span>}
                  {g.ai_relevance && Object.values(g.ai_relevance).some(v => v.note || v.reason) && (
                    <span className="truncate flex-1">
                      📝 {Object.values(g.ai_relevance).find(v => v.note || v.reason)?.note || Object.values(g.ai_relevance).find(v => v.note || v.reason)?.reason}
                    </span>
                  )}
                </div>

                {/* Status detail */}
                {g.join_status === 'pending' && g.pending_days !== null && (
                  <div className="mt-1 text-[10px] text-app-muted">
                    Đã xin vào {g.pending_days} ngày trước, chưa được duyệt
                  </div>
                )}
                {g.join_status === 'member' && (g.total_interactions > 0 || g.last_posted_at) && (
                  <div className="mt-1 text-[10px] text-app-muted">
                    {g.total_interactions > 0 && `Đã tương tác ${g.total_interactions} lần · `}
                    {g.last_posted_at && `Post gần nhất ${new Date(g.last_posted_at).toLocaleDateString('vi-VN')}`}
                  </div>
                )}
                {g.join_status === 'banned' && g.blocked_reason && (
                  <div className="mt-1 text-[10px] text-danger">Lý do: {g.blocked_reason}</div>
                )}

                {/* Actions */}
                <div className="mt-2 flex gap-1">
                  {g.join_status === 'pending' && (
                    <>
                      <button
                        onClick={() => updateStatus.mutate({ id: g.id, status: 'member' })}
                        className="text-[10px] uppercase px-2 py-0.5 text-hermes"
                        style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}
                      >
                        Đã vào
                      </button>
                      <button
                        onClick={() => updateStatus.mutate({ id: g.id, status: 'rejected' })}
                        className="text-[10px] uppercase px-2 py-0.5 text-app-muted"
                        style={{ border: '1px solid var(--border)' }}
                      >
                        Bỏ qua
                      </button>
                    </>
                  )}
                  {g.join_status === 'rejected' && (
                    <button
                      onClick={() => updateStatus.mutate({ id: g.id, status: 'pending' })}
                      className="text-[10px] uppercase px-2 py-0.5 text-app-muted"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      Thử lại
                    </button>
                  )}
                  {g.join_status === 'unknown' && (
                    <button
                      onClick={() => updateStatus.mutate({ id: g.id, status: 'member' })}
                      className="text-[10px] uppercase px-2 py-0.5 text-hermes"
                      style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}
                    >
                      Mark member
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Tab: Data (leads + opportunities) ─────────────────────
function DataTab({ campaignId }) {
  const { data: leads = [] } = useQuery({
    queryKey: ['campaigns', campaignId, 'leads'],
    queryFn: async () => {
      try {
        const res = await api.get(`/leads?campaign_id=${campaignId}&limit=50`)
        return asArray(res.data)
      } catch {
        return []
      }
    },
  })

  return (
    <div className="overflow-auto p-6 font-mono-ui">
      <div className="text-[10px] uppercase tracking-wider text-app-muted mb-3">
        Leads collected ({leads.length})
      </div>
      {leads.length === 0 ? (
        <div
          className="p-6 text-sm text-app-muted text-center"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          No leads yet. Run discovery + opportunity react to collect.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)' }}>
          {leads.map((lead) => (
            <div
              key={lead.id}
              className="flex items-center gap-4 px-4 py-2 text-xs"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <span className="flex-1 text-app-primary truncate">
                {lead.name || lead.fb_user_id || '—'}
              </span>
              <span className="text-app-muted truncate max-w-[200px]">
                {lead.source || lead.origin || '—'}
              </span>
              <span className={
                lead.status === 'connected' ? 'text-hermes' :
                lead.status === 'blocked' ? 'text-danger' : 'text-app-muted'
              }>
                {lead.status || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Tab: Execution (live job feed for this campaign) ──────
function ExecutionTab({ campaignId }) {
  const { data: jobs = [] } = useQuery({
    queryKey: ['campaigns', campaignId, 'jobs'],
    queryFn: async () => {
      const res = await api.get(`/jobs?limit=30`)
      const all = asArray(res.data)
      // Filter by campaign_id in payload
      return all.filter(j => j.payload?.campaign_id === campaignId)
    },
    refetchInterval: 3000,
  })

  const [selectedJob, setSelectedJob] = useState(null)

  const running = jobs.filter(j => ['claimed', 'running'].includes(j.status)).length
  const pending = jobs.filter(j => j.status === 'pending').length
  const done = jobs.filter(j => j.status === 'done').length
  const failed = jobs.filter(j => j.status === 'failed').length

  return (
    <div className="flex flex-col">
      <div
        className="flex items-center gap-8 px-6 py-3"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <DenseStat value={running} label="Running" color="hermes" />
        <DenseStat value={pending} label="Queued" />
        <DenseStat value={done} label="Done" color="hermes" />
        <DenseStat value={failed} label="Failed" color={failed > 0 ? 'danger' : 'primary'} />
      </div>

      <div className="flex-1 min-h-[200px] overflow-y-auto max-h-[400px]" style={{ borderBottom: '1px solid var(--border)' }}>
        {jobs.length === 0 ? (
          <div className="p-8 text-center text-xs text-app-muted">Chưa có công việc nào trong chiến dịch này.</div>
        ) : (
          <div className="divide-y divide-app-border">
            {jobs.map(j => (
              <JobRow key={j.id} job={j} onClick={() => setSelectedJob(selectedJob?.id === j.id ? null : j)} />
            ))}
          </div>
        )}
      </div>

      {selectedJob && (
        <div className="p-4 bg-app-elevated font-mono-ui text-[11px] border-b border-app-border">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-app-primary">Chi tiết Job: {selectedJob.type}</span>
            <button onClick={() => setSelectedJob(null)} className="text-app-muted hover:text-app-primary">✕</button>
          </div>
          <div className="space-y-1.5 overflow-x-auto text-app-muted">
            <div><span className="text-app-primary">ID:</span> {selectedJob.id}</div>
            <div><span className="text-app-primary">Trạng thái:</span> <span className={selectedJob.status === 'failed' ? 'text-danger' : 'text-app-primary'}>{selectedJob.status}</span></div>
            {selectedJob.error_message && (
              <div className="text-danger font-semibold whitespace-pre-wrap"><span className="text-app-primary font-normal">Lỗi:</span> {selectedJob.error_message}</div>
            )}
            <div><span className="text-app-primary">Payload:</span> <pre className="mt-1 p-2 bg-app-base rounded text-[10px] text-app-muted">{JSON.stringify(selectedJob.payload, null, 2)}</pre></div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Hoạt động (per-action feed from campaign_activity_log) ──
// Icon map — keep in sync with ACTION_LABELS below.
const ACTION_ICON = {
  like: '❤️',
  react: '❤️',
  comment: '💬',
  opportunity_comment: '💬',
  join_group: '👥',
  friend_request: '🤝',
  post: '📝',
  visit_group: '👀',
  ai_evaluate_posts: '🧠',
  ai_evaluate_group: '🧠',
  cookie_saved: '🍪',
  check_group_membership: '🔍',
  membership_approved: '✅',
  membership_rejected: '🚫',
  membership_pending: '⏳',
  comment_rejected: '🛑',
  ops_monitor: '🔍',
  session_start: '🎬',
  session_end: '🛑',
  feed_browse: '📱',
  ai_next_action: '🤖',
  nurture_extract: '📥',
  nurture_dom_debug: '🛠️',
  nurture_group_decision: '🤔',
  error: '❌',
  nurture_group_error: '⚠️',
  daily_plan: '📅',
  ai_control: '🕹️',
  visit_profile: '👤',
  scan: '🔎',
  ai_filter: '🧹',
  weekly_strategy: '📊',
}
const ACTION_LABEL = {
  like: 'đã like bài',
  react: 'đã thả react',
  comment: 'đã comment bài',
  opportunity_comment: 'đã comment (ad)',
  join_group: 'đã tham gia nhóm',
  friend_request: 'đã gửi kết bạn',
  post: 'đã đăng bài',
  visit_group: 'đã vào nhóm',
  ai_evaluate_posts: 'AI đánh giá bài',
  ai_evaluate_group: 'AI đánh giá nhóm',
  cookie_saved: 'đã lưu cookie',
  check_group_membership: 'check trạng thái join',
  membership_approved: 'được duyệt vào nhóm',
  membership_rejected: 'bị từ chối vào nhóm',
  membership_pending: 'đang chờ duyệt vào nhóm',
  comment_rejected: 'comment bị quality-gate từ chối',
  ops_monitor: 'giám sát chiến dịch',
  session_start: 'bắt đầu phiên làm việc',
  session_end: 'kết thúc phiên làm việc',
  feed_browse: 'lướt bảng tin',
  ai_next_action: 'AI quyết định hành động tiếp theo',
  nurture_extract: 'trích xuất dữ liệu nuôi tài khoản',
  nurture_dom_debug: 'debug DOM nuôi tài khoản',
  nurture_group_decision: 'AI quyết định tương tác nhóm',
  error: 'lỗi hệ thống',
  nurture_group_error: 'lỗi tương tác nhóm',
  daily_plan: 'lập kế hoạch hàng ngày',
  ai_control: 'AI kiểm soát luồng',
  visit_profile: 'vào trang cá nhân',
  scan: 'quét dữ liệu',
  ai_filter: 'AI lọc nội dung',
  weekly_strategy: 'lập chiến lược hàng tuần',
}
const FILTERABLE_TYPES = [
  { value: '',                    label: 'Tất cả' },
  { value: 'like',                label: '❤️ Like' },
  { value: 'comment',             label: '💬 Comment' },
  { value: 'opportunity_comment', label: '💬 Comment (AD)' },
  { value: 'join_group',          label: '👥 Tham gia nhóm' },
  { value: 'friend_request',      label: '🤝 Kết bạn' },
  { value: 'react',               label: '❤️ React' },
  { value: 'visit_group',         label: '👀 Vào nhóm' },
  { value: 'ai_evaluate_posts',   label: '🧠 AI đánh giá bài' },
  { value: 'ai_evaluate_group',   label: '🧠 AI đánh giá nhóm' },
  { value: 'post',                label: '📝 Post' },
  { value: 'check_group_membership', label: '🔍 Check membership' },
  { value: 'comment_rejected',    label: '🛑 Comment bị từ chối' },
  { value: 'membership_approved', label: '✅ Duyệt vào nhóm' },
  { value: 'membership_rejected', label: '🚫 Từ chối vào nhóm' },
  { value: 'ops_monitor',         label: '🔍 Giám sát chiến dịch' },
  { value: 'error',               label: '❌ Lỗi hệ thống' },
  { value: 'ai_next_action',      label: '🤖 AI quyết định' },
]

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const dd = String(d.getDate()).padStart(2, '0')
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mo} ${hh}:${mm}`
}

function ActivityRow({ row }) {
  const d = row.details || {}
  const icon = ACTION_ICON[row.action_type] || '•'
  const label = ACTION_LABEL[row.action_type] || row.action_type
  const targetName = row.target_name || d.group_name || d.profile_name || ''
  const targetUrl = row.target_url || d.group_url || d.profile_url || null
  const postUrl = d.post_url || null
  const commentText = d.comment_text || null
  const captionPreview = d.caption ? d.caption.slice(0, 120) : null
  const dim = { color: 'var(--text-muted)' }
  const statusDot = row.result_status === 'failed' ? '🔴' : row.result_status === 'skipped' ? '⚪' : '🟢'

  return (
    <div className="px-6 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-baseline gap-3">
        <span className="font-mono-ui text-xs" style={dim}>{fmtTime(row.created_at)}</span>
        <span>{statusDot}</span>
        <span className="font-medium">{row.account_name || '—'}</span>
      </div>
      <div className="mt-1 text-sm">
        <span className="mr-2">{icon}</span>
        <span>{label}</span>
        {targetName && (
          <span>
            {' '}
            {row.action_type === 'friend_request' || row.action_type === 'post' ? '' : 'trong'}
            {' '}<span style={{ fontWeight: 500 }}>{targetName}</span>
          </span>
        )}
      </div>
      {commentText && (
        <div className="mt-1 text-sm" style={{ fontStyle: 'italic', ...dim }}>
          "{commentText.length > 200 ? commentText.slice(0, 200) + '…' : commentText}"
          {(d.generator || d.provider) && (
            <span className="ml-2 text-[10px] uppercase tracking-wider" style={{ color: 'var(--hermes)' }}>
              · {d.generator || d.provider}
            </span>
          )}
        </div>
      )}
      {captionPreview && !commentText && (
        <div className="mt-1 text-sm" style={{ fontStyle: 'italic', ...dim }}>
          "{captionPreview}{d.caption?.length > 120 ? '…' : ''}"
        </div>
      )}
      {row.action_type === 'join_group' && typeof d.member_count === 'number' && (
        <div className="mt-1 text-xs" style={dim}>
          {d.member_count.toLocaleString('vi-VN')} thành viên
        </div>
      )}
      {row.error_message || d.error ? (
        <div className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
          Lỗi: {row.error_message || d.error}
        </div>
      ) : null}
      <div className="mt-2 flex gap-3 text-xs">
        {postUrl && (
          <a href={postUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--hermes)' }}>
            Xem bài ↗
          </a>
        )}
        {targetUrl && (
          <a href={targetUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--hermes)' }}>
            {row.action_type === 'friend_request' ? 'Xem profile ↗' : 'Xem nhóm ↗'}
          </a>
        )}
      </div>
    </div>
  )
}

// VN date helpers — UTC+7. "today" on frontend clock means the VN
// calendar day, matching how activity_log timestamps are read elsewhere.
function vnTodayStr() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)
}
function vnYesterdayStr() {
  return new Date(Date.now() + 7 * 3600000 - 86400000).toISOString().slice(0, 10)
}
// Convert YYYY-MM-DD (VN day) → UTC ISO bounds the API can filter on
function vnDayBounds(ymd) {
  if (!ymd) return { from: null, to: null }
  const from = new Date(`${ymd}T00:00:00+07:00`).toISOString()
  const to = new Date(`${ymd}T23:59:59.999+07:00`).toISOString()
  return { from, to }
}

const PAGE_SIZE = 50

// Group flat rows into [{date, label, rows}] by VN calendar day (UTC+7)
function groupByVnDate(rows) {
  const todayVn = vnTodayStr()
  const yesterdayVn = vnYesterdayStr()
  const groups = []
  let currentDate = null
  let currentGroup = null
  for (const row of rows) {
    const vnDay = row.created_at
      ? new Date(new Date(row.created_at).getTime() + 7 * 3600000).toISOString().slice(0, 10)
      : 'unknown'
    if (vnDay !== currentDate) {
      currentDate = vnDay
      let label = vnDay
      if (vnDay === todayVn) label = `Hôm nay · ${vnDay.slice(8, 10)}/${vnDay.slice(5, 7)}`
      else if (vnDay === yesterdayVn) label = `Hôm qua · ${vnDay.slice(8, 10)}/${vnDay.slice(5, 7)}`
      else if (vnDay !== 'unknown') label = `${vnDay.slice(8, 10)}/${vnDay.slice(5, 7)}/${vnDay.slice(0, 4)}`
      currentGroup = { date: vnDay, label, rows: [] }
      groups.push(currentGroup)
    }
    currentGroup.rows.push(row)
  }
  return groups
}

// Compact page-number list: always show first, last, current±2, with … gaps
function pageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const set = new Set(
    [1, total, current - 2, current - 1, current, current + 1, current + 2].filter(n => n >= 1 && n <= total)
  )
  const sorted = [...set].sort((a, b) => a - b)
  const out = []
  let prev = null
  for (const n of sorted) {
    if (prev !== null && n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
}

function ActivityTab({ campaignId, campaign }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [filterType, setFilterType] = useState('')
  const [dateMode, setDateMode] = useState('today')
  const [customDate, setCustomDate] = useState(vnTodayStr())
  const [filterAccountId, setFilterAccountId] = useState(searchParams.get('account_id') || '')
  const [page, setPage] = useState(1)

  // Reset to page 1 whenever any filter changes
  useEffect(() => { setPage(1) }, [filterType, dateMode, customDate, filterAccountId])

  // Sync account_id URL param for KPI click-through
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (filterAccountId) next.set('account_id', filterAccountId)
    else next.delete('account_id')
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
  }, [filterAccountId]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: resp, isLoading } = useQuery({
    queryKey: ['campaign-activity-log', campaignId, filterType, dateMode, customDate, filterAccountId, page],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('page', String(page))
      if (filterType) params.set('action_type', filterType)
      if (filterAccountId) params.set('account_id', filterAccountId)

      let ymd = null
      if (dateMode === 'today') ymd = vnTodayStr()
      else if (dateMode === 'yesterday') ymd = vnYesterdayStr()
      else if (dateMode === 'custom') ymd = customDate
      if (ymd) {
        const { from, to } = vnDayBounds(ymd)
        params.set('date_from', from)
        params.set('date_to', to)
      }

      const r = await api.get(`/campaigns/${campaignId}/activity-log?${params}`)
      return r.data
    },
    refetchInterval: dateMode === 'today' && page === 1 ? 10000 : false,
    keepPreviousData: true,
  })

  const rows = useMemo(() => {
    const list = Array.isArray(resp?.data) ? resp.data : []
    const keep = new Set(Object.keys(ACTION_ICON))
    return list.filter(r => keep.has(r.action_type))
  }, [resp])

  const dateGroups = useMemo(() => groupByVnDate(rows), [rows])
  const totalPages = resp?.total_pages || 1
  const total = resp?.total || 0
  const apiAccounts = resp?.accounts || []

  function exportCsv() {
    if (!rows.length) return
    const esc = v => {
      if (v == null) return ''
      const s = String(v).replace(/"/g, '""')
      return /[",\n]/.test(s) ? `"${s}"` : s
    }
    const header = ['Thời gian', 'Nick', 'Hành động', 'Target', 'Link', 'Nội dung', 'Status']
    const csvLines = [header.join(',')]
    for (const r of rows) {
      const d = r.details || {}
      csvLines.push([
        r.created_at, r.account_name,
        ACTION_LABEL[r.action_type] || r.action_type,
        r.target_name || '',
        d.post_url || r.target_url || d.profile_url || '',
        d.comment_text || d.caption || '',
        r.result_status,
      ].map(esc).join(','))
    }
    const blob = new Blob(['﻿' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safeName = (campaign?.name || 'campaign').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')
    a.href = url
    a.download = `campaign_activity_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const pages = pageNumbers(page, totalPages)

  return (
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        {/* Top row: Other filters & actions */}
        <div className="flex items-center gap-2 px-4 py-2.5 flex-wrap" style={{ borderBottom: '1px solid var(--border)' }}>
          <select
            className="px-2 py-1 rounded text-xs"
            style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
            value={dateMode}
            onChange={e => setDateMode(e.target.value)}
          >
            <option value="today">Hôm nay</option>
            <option value="yesterday">Hôm qua</option>
            <option value="custom">Chọn ngày…</option>
            <option value="all">Tất cả</option>
          </select>
          {dateMode === 'custom' && (
            <input
              type="date"
              className="px-2 py-1 rounded text-xs"
              style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
              value={customDate}
              max={vnTodayStr()}
              onChange={e => setCustomDate(e.target.value)}
            />
          )}

          {apiAccounts.length > 0 && (
            <select
              className="px-2 py-1 rounded text-xs"
              style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
              value={filterAccountId}
              onChange={e => setFilterAccountId(e.target.value)}
            >
              <option value="">Tất cả nick</option>
              {apiAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {total.toLocaleString('vi-VN')} hoạt động
            </span>
            <button
              onClick={exportCsv}
              disabled={!rows.length}
              className="px-2.5 py-1 rounded text-xs"
              style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
            >
              CSV
            </button>
          </div>
        </div>

        {/* Bottom row: Filter Tabs */}
        <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {FILTERABLE_TYPES.map(t => (
            <button
              key={t.value}
              onClick={() => setFilterType(t.value)}
              className="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors"
              style={{
                border: '1px solid var(--border)',
                background: filterType === t.value ? 'var(--hermes)' : 'var(--bg)',
                color: filterType === t.value ? '#fff' : 'var(--text-muted)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Feed grouped by date ── */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>Đang tải…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>Chưa có hoạt động nào.</div>
        ) : (
          dateGroups.map(group => (
            <div key={group.date}>
              <div
                className="sticky top-0 z-10 px-4 py-1.5 flex items-center gap-2"
                style={{
                  background: 'var(--bg-elevated, var(--bg))',
                  borderBottom: '1px solid var(--border)',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
                  {group.label}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--border)', color: 'var(--text-muted)' }}
                >
                  {group.rows.length}
                </span>
              </div>
              {group.rows.map(r => <ActivityRow key={r.id} row={r} />)}
            </div>
          ))
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div
          className="flex items-center justify-between px-4 py-2 flex-wrap gap-2"
          style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}
        >
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Trang {page}/{totalPages} · {total.toLocaleString('vi-VN')} mục
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2.5 py-1 rounded text-xs disabled:opacity-30"
              style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
            >
              ← Trước
            </button>
            {pages.map((p, i) =>
              p === '…' ? (
                <span key={'el' + i} className="px-1 text-xs" style={{ color: 'var(--text-muted)' }}>…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className="w-7 h-7 rounded text-xs font-medium"
                  style={{
                    border: '1px solid var(--border)',
                    background: p === page ? 'var(--hermes)' : 'var(--bg)',
                    color: p === page ? '#fff' : 'inherit',
                  }}
                >
                  {p}
                </button>
              )
            )}
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-2.5 py-1 rounded text-xs disabled:opacity-30"
              style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
            >
              Sau →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Hermes (orchestrator decisions log + approval) ──
const HERMES_ACTION_ICON = {
  assign_job:     '🎯',
  skip_group:     '🚫',
  recheck_group:  '🔄',
  reassign_nick:  '↔️',
  pause_nick:     '⏸',
  alert_user:     '⚠️',
  create_content: '✍️',
}
const OUTCOME_LABEL = {
  success:        { label: '✓ Đã làm', color: 'text-hermes' },
  user_approved:  { label: '✓ Duyệt',  color: 'text-hermes' },
  failed:         { label: '✗ Lỗi',    color: 'text-danger' },
  pending:        { label: '⏳ Chờ',   color: 'text-warn' },
  user_rejected:  { label: '× Bỏ qua', color: 'text-app-muted' },
  skipped:        { label: '⤳ Bỏ qua (cap)', color: 'text-app-muted' },
}

function HermesTab({ campaignId }) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState(null)
  const [typeFilter, setTypeFilter] = useState('')

  const { data: resp, isLoading } = useQuery({
    queryKey: ['hermes-decisions', campaignId, typeFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ campaign_id: campaignId, limit: '100' })
      if (typeFilter) params.set('decision_type', typeFilter)
      return (await api.get(`/ai-hermes/decisions?${params}`)).data
    },
    refetchInterval: 15000,
  })
  const rows = useMemo(() => {
    const list = Array.isArray(resp) ? resp : asArray(resp)
    // Skip the "orchestration_summary" wrapper rows — those are just meta
    return list.filter(r => r.decision_type !== 'orchestration_summary')
  }, [resp])

  const selected = rows.find(r => r.id === selectedId) || rows[0]

  const approveMut = useMutation({
    mutationFn: async (id) => (await api.patch(`/ai-hermes/decisions/${id}/approve`)).data,
    onSuccess: () => {
      toast.success('Đã áp dụng')
      qc.invalidateQueries({ queryKey: ['hermes-decisions', campaignId] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })
  const rejectMut = useMutation({
    mutationFn: async (id) => (await api.patch(`/ai-hermes/decisions/${id}/reject`)).data,
    onSuccess: () => {
      toast.success('Đã bỏ qua')
      qc.invalidateQueries({ queryKey: ['hermes-decisions', campaignId] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  const pendingCount = rows.filter(r => r.outcome === 'pending').length

  return (
    <div className="flex h-full">
      {/* Left panel — list */}
      <div className="w-1/2 flex flex-col" style={{ borderRight: '1px solid var(--border)' }}>
        <div
          className="flex items-center gap-3 px-4 py-3 flex-wrap"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="font-medium text-sm">Quyết định của Hermes</span>
          {pendingCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded"
              style={{ background: 'var(--warn)', color: 'white' }}>
              {pendingCount} chờ duyệt
            </span>
          )}
          <select
            className="ml-auto px-2 py-1 rounded text-xs"
            style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">Tất cả</option>
            <option value="orchestration">Orchestration</option>
            <option value="self_improvement">Self-improvement</option>
            <option value="checkpoint_analysis">Nick chết (phân tích)</option>
            <option value="reporter">Report</option>
          </select>
        </div>
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="p-8 text-center font-mono-ui text-xs" style={{ color: 'var(--text-muted)' }}>
              Đang tải…
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center font-mono-ui text-xs" style={{ color: 'var(--text-muted)' }}>
              Chưa có quyết định nào — cron orchestrator chạy mỗi 15 phút.
            </div>
          ) : (
            rows.map(r => {
              const icon = HERMES_ACTION_ICON[r.action_type] || '🧠'
              const isSelected = selected?.id === r.id
              const outcome = OUTCOME_LABEL[r.outcome] || { label: r.outcome || '—', color: 'text-app-muted' }
              const autoBadge = r.auto_applied ? '🤖' : r.auto_apply ? '🤖' : '👤'
              return (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full text-left px-4 py-3 text-xs flex items-start gap-3 hover:bg-app-muted/10 ${isSelected ? 'bg-app-muted/20' : ''}`}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <span className="font-mono-ui text-app-muted tabular-nums shrink-0">
                    {fmtTime(r.created_at)}
                  </span>
                  <span className="shrink-0">{icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {r.action_type || r.decision_type}
                      </span>
                      <span className="shrink-0" title={r.auto_apply ? 'auto-applied' : 'needs user'}>
                        {autoBadge}
                      </span>
                    </div>
                    {r.target_name && (
                      <div className="text-app-muted truncate mt-0.5">→ {r.target_name}</div>
                    )}
                  </div>
                  <span className={`shrink-0 ${outcome.color}`}>{outcome.label}</span>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* Right panel — detail */}
      <div className="w-1/2 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="p-8 text-center font-mono-ui text-xs" style={{ color: 'var(--text-muted)' }}>
            Chọn một quyết định để xem chi tiết
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-6 space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Thời gian</div>
              <div className="text-sm">{new Date(selected.created_at).toLocaleString('vi-VN')}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Loại</div>
              <div className="text-sm">
                {selected.decision_type}
                {selected.action_type && <> · {selected.action_type}</>}
              </div>
            </div>
            {selected.target_name && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Target</div>
                <div className="text-sm">{selected.target_name}</div>
              </div>
            )}
            {selected.context_summary && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Hermes nhận định</div>
                <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {selected.context_summary}
                </div>
              </div>
            )}
            {selected.reason && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Lý do</div>
                <div className="text-sm">{selected.reason}</div>
              </div>
            )}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Payload</div>
              <pre className="text-[11px] font-mono-ui p-3 overflow-auto"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', maxHeight: 300 }}>
{JSON.stringify(selected.decision, null, 2)}
              </pre>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-app-muted mb-1">Kết quả</div>
              <div className="text-sm flex gap-2 items-center">
                <span className={OUTCOME_LABEL[selected.outcome]?.color || ''}>
                  {OUTCOME_LABEL[selected.outcome]?.label || selected.outcome}
                </span>
                {selected.applied_at && (
                  <span className="text-xs text-app-muted">
                    · {new Date(selected.applied_at).toLocaleString('vi-VN')}
                  </span>
                )}
              </div>
              {selected.outcome_detail && (
                <div className="text-xs text-app-muted mt-1">{selected.outcome_detail}</div>
              )}
            </div>
            {selected.outcome === 'pending' && (
              <div className="flex gap-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => approveMut.mutate(selected.id)}
                  disabled={approveMut.isPending}
                  className="px-4 py-2 rounded text-sm font-medium"
                  style={{ background: 'var(--hermes)', color: 'white' }}
                >
                  {approveMut.isPending ? 'Đang áp dụng…' : 'Áp dụng'}
                </button>
                <button
                  onClick={() => rejectMut.mutate(selected.id)}
                  disabled={rejectMut.isPending}
                  className="px-4 py-2 rounded text-sm"
                  style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
                >
                  Bỏ qua
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tabs config ───────────────────────────────────────────
// Collapsed from 8 → 4 tabs. 8 was overwhelming per user feedback
// ("quá nhiều tab quản lý phát mệt"). Groupings:
//   Tổng quan  = Overview + Agents + Data (everything "read-only state")
//   Hoạt động  = Execution + activity log (everything "live/running")
//   Nội dung   = Content + Groups (everything "assets for this campaign")
//   Hermes     = AI decisions (unchanged)
const TABS = [
  { key: 'overview',  label: 'Tổng quan' },
  { key: 'runtime',   label: 'Hoạt động' },
  { key: 'assets',    label: 'Nội dung' },
  { key: 'hermes',    label: 'Hermes' },
]

// Stacks multiple legacy sub-tabs inside a single merged tab body.
// Each child keeps its own header/table/filters — we just glue them
// vertically so the user scrolls through related content instead of
// hunting across 8 tabs.
function MergedTab({ children }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children]
  return (
    <div className="h-full overflow-y-auto">
      {items.map((child, i) => (
        <div
          key={i}
          style={i > 0 ? { borderTop: '1px solid var(--border)', marginTop: 12 } : undefined}
        >
          {child}
        </div>
      ))}
    </div>
  )
}

// ─── Hermes Review modal ───────────────────────────────────
function HermesReviewModal({ campaign, accounts, jobs, onClose }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  // Track per-recommendation state: 'idle' | 'applying' | 'applied' | 'error'
  const [applyState, setApplyState] = useState({}) // { [recIndex]: { state, error? } }

  // Resolve account_id — Hermes may return username instead of UUID
  const resolveAccountId = (ref) => {
    if (!ref) return null
    // If it's a UUID, use as-is
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref
    // Otherwise match by username
    const acc = accounts.find(a => a.username === ref || a.id.startsWith(ref))
    return acc?.id || null
  }

  const applyRec = async (rec, index) => {
    setApplyState(s => ({ ...s, [index]: { state: 'applying' } }))
    try {
      const accId = resolveAccountId(rec.account_id)
      if (!accId && rec.action !== 'summary') {
        throw new Error(`Không tìm được nick với ID/tên "${rec.account_id}"`)
      }
      const res = await api.post(`/campaigns/${campaign.id}/apply-recommendation`, {
        account_id: accId,
        action: rec.action,
        task_type: rec.task_type,
        priority: rec.priority,
        rec_index: index,
      })
      setApplyState(s => ({ ...s, [index]: { state: 'applied', change: res.data.change } }))
      toast.success(`Đã áp dụng: ${rec.action} ${rec.task_type || ''}`)
    } catch (err) {
      const msg = err.response?.data?.error || err.message
      setApplyState(s => ({ ...s, [index]: { state: 'error', error: msg } }))
      toast.error(`Lỗi: ${msg}`)
    }
  }

  const runReview = async () => {
    setLoading(true)
    setError(null)
    try {
      // Aggregate stats client-side
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const todayJobs = jobs.filter(j => new Date(j.created_at) >= today)
      const stats = {
        total_jobs_today: todayJobs.length,
        failed: todayJobs.filter(j => j.status === 'failed').length,
        done: todayJobs.filter(j => j.status === 'done').length,
        running: todayJobs.filter(j => ['claimed', 'running'].includes(j.status)).length,
      }
      // Per-nick stats
      const roleMap = {}
      for (const r of (campaign.campaign_roles || [])) {
        for (const accId of (r.account_ids || [])) {
          roleMap[accId] = r.role_type
        }
      }
      const nickStats = []
      const seenAccIds = new Set()
      for (const accId of Object.keys(roleMap)) {
        seenAccIds.add(accId)
        const acc = accounts.find(a => a.id === accId)
        if (!acc) continue
        const accJobs = todayJobs.filter(j => j.payload?.account_id === accId)
        const failed = accJobs.filter(j => j.status === 'failed').length
        nickStats.push({
          account_id: accId,
          username: acc.username || accId.slice(0, 8),
          role: roleMap[accId],
          status: acc.status,
          jobs_today: accJobs.length,
          failed,
        })
      }

      const res = await api.post('/ai-hermes/campaign-review', {
        campaign_id: campaign.id,
        current_stats: stats,
        nick_stats: nickStats,
      })
      setResult(res.data)

      // If server auto-applied some recs, mark them in local state
      if (Array.isArray(res.data?.auto_applied) && res.data.auto_applied.length > 0) {
        const autoState = {}
        for (const a of res.data.auto_applied) {
          autoState[a.index] = { state: 'applied', change: a.change, autoApplied: true }
        }
        setApplyState(autoState)
        toast.success(`${res.data.auto_applied.length} đề xuất được auto-apply`)
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.detail || err.message
      setError(msg)
      toast.error(`Review thất bại: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  // Auto-trigger on mount
  useEffect(() => { runReview() }, [])

  const PRIORITY_COLOR = {
    high: 'text-danger',
    medium: 'text-warn',
    low: 'text-app-muted',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="bg-app-surface w-full max-w-3xl max-h-[80vh] flex flex-col font-mono-ui"
        style={{ border: '1px solid var(--border-bright)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-hermes" />
            <span className="text-app-primary text-sm uppercase tracking-wider">Hermes Review</span>
          </div>
          <button onClick={onClose} className="text-app-muted hover:text-app-primary p-1">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex items-center gap-3 text-app-muted">
              <Loader size={16} className="animate-spin text-hermes" />
              <span className="text-sm">Hermes đang phân tích chiến dịch...</span>
            </div>
          )}

          {error && (
            <div className="p-3 text-sm text-danger" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.4)' }}>
              ⚠ {error}
              {error.includes('no goal') && (
                <div className="mt-2 text-xs text-app-muted">
                  Vào Edit campaign → tab "Mục tiêu" để thiết lập trước.
                </div>
              )}
            </div>
          )}

          {result && (
            <>
              <div className="mb-4 p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                <div className="text-[10px] uppercase text-app-muted mb-1">Tóm tắt</div>
                <div className="text-app-primary text-sm">{result.summary}</div>
                <div className="text-app-dim text-[10px] mt-2">latency {result.latency_ms}ms</div>
              </div>

              {Array.isArray(result.auto_applied) && result.auto_applied.length > 0 && (
                <div
                  className="mb-4 p-3 flex items-center gap-3"
                  style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}
                >
                  <span className="text-hermes text-xl">⚡</span>
                  <div className="flex-1 text-sm">
                    <div className="text-hermes uppercase text-[10px] tracking-wider">Auto-apply</div>
                    <div className="text-app-primary">
                      {result.auto_applied.length}/{result.recommendations?.length || 0} đề xuất được Hermes tự áp dụng
                    </div>
                    {result.auto_apply_skipped?.length > 0 && (
                      <div className="text-app-muted text-[10px] mt-1">
                        Skip {result.auto_apply_skipped.length} — xem toggle trong cài đặt campaign
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="text-[10px] uppercase text-app-muted mb-2">
                Đề xuất ({result.recommendations?.length || 0})
              </div>

              {(result.recommendations || []).map((rec, i) => {
                const st = applyState[i] || { state: 'idle' }
                const resolvedAccId = resolveAccountId(rec.account_id)
                const nickLabel = (() => {
                  if (!rec.account_id) return '(no nick)'
                  if (resolvedAccId) {
                    const acc = accounts.find(a => a.id === resolvedAccId)
                    return acc?.username || rec.account_id
                  }
                  return `⚠ ${rec.account_id}` // not resolved
                })()

                return (
                  <div
                    key={i}
                    className="mb-2 p-3"
                    style={{
                      background: 'var(--bg-elevated)',
                      border: st.state === 'applied'
                        ? '1px solid var(--hermes-fade)'
                        : st.state === 'error'
                        ? '1px solid rgba(239,68,68,0.4)'
                        : '1px solid var(--border)',
                    }}
                  >
                    <div className="flex items-center gap-3 mb-1 text-xs">
                      <span className={`uppercase ${PRIORITY_COLOR[rec.priority] || 'text-app-muted'}`}>
                        ● {rec.priority || 'normal'}
                      </span>
                      <span className="text-app-primary">{nickLabel}</span>
                      <span className="text-app-muted">→</span>
                      <span className={
                        rec.action === 'increase' ? 'text-hermes' :
                        rec.action === 'fix_checkpoint' ? 'text-danger' :
                        rec.action === 'pause' ? 'text-warn' :
                        'text-info'
                      }>
                        {rec.action} {rec.task_type}
                      </span>
                    </div>
                    <div className="text-xs text-app-muted">{rec.reason}</div>

                    {/* Applied change detail */}
                    {st.state === 'applied' && st.change && (
                      <div className="mt-2 text-[10px] text-hermes">
                        {st.autoApplied && <span className="text-info mr-1">[AUTO]</span>}
                        ✓ Đã áp dụng:{' '}
                        {st.change.type === 'budget_adjusted' &&
                          `${st.change.key} budget ${st.change.old_max} → ${st.change.new_max} (×${st.change.multiplier})`}
                        {st.change.type === 'status_reset' && `status reset + health check queued`}
                        {st.change.type === 'job_queued' && `queued ${st.change.job_type}`}
                        {st.change.type === 'removed_from_roles' && `removed from ${st.change.role_ids.length} role(s)`}
                      </div>
                    )}

                    {st.state === 'error' && (
                      <div className="mt-2 text-[10px] text-danger">✗ {st.error}</div>
                    )}

                    <div className="mt-2 flex gap-2">
                      {st.state === 'applied' ? (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase"
                          style={{ background: 'var(--hermes-dim)', color: 'var(--hermes)', border: '1px solid var(--hermes-fade)' }}
                        >
                          ✓ {st.autoApplied ? 'Auto-applied' : 'Đã áp dụng'}
                        </span>
                      ) : (
                        <button
                          onClick={() => applyRec(rec, i)}
                          disabled={st.state === 'applying'}
                          className={st.state === 'error' ? 'btn-ghost' : 'btn-hermes'}
                          style={{ fontSize: 10 }}
                        >
                          {st.state === 'applying' ? 'Đang áp dụng...' : st.state === 'error' ? 'Thử lại' : 'Áp dụng'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}

              {result.recommendations?.length === 0 && (
                <div className="text-app-muted text-sm">Không có đề xuất.</div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={runReview} disabled={loading} className="btn-ghost">
            {loading ? 'Đang phân tích...' : 'Phân tích lại'}
          </button>
          <button onClick={onClose} className="btn-ghost">Đóng</button>
        </div>
      </div>
    </div>
  )
}

// ─── Main ──────────────────────────────────────────────────
function HermesModelQuickSelect() {
  const qc = useQueryClient()
  const { data: cfgData, isLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })

  const save = useMutation({
    mutationFn: async (payload) => api.put('/ai-hermes/config', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hermes', 'config'] }),
    onError: (err) => toast.error(`Lỗi: ${err.response?.data?.error || err.message}`),
  })

  if (isLoading || !cfgData?.config) return null

  const providers = cfgData.providers || {}
  const currentProvider = cfgData.config.provider
  const currentModel = cfgData.config.model

  const QUICK_PRESETS = [
    { p: 'nvidia', m: 'meta/llama-3.3-70b-instruct', label: 'NVIDIA Llama 3.3' },
    { p: 'nvidia', m: 'deepseek-ai/deepseek-r1', label: 'NVIDIA DeepSeek R1' },
    { p: 'deepseek', m: 'deepseek-chat', label: 'DeepSeek V3' },
    { p: 'kimi', m: 'kimi-k2-0711-preview', label: 'Kimi K2' },
    { p: 'openai', m: 'gpt-4o-mini', label: 'GPT-4o-mini' },
    { p: 'gemini', m: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { p: 'groq', m: 'llama-3.3-70b-versatile', label: 'Groq Llama 3.3' },
  ]

  const handleChange = (e) => {
    const val = e.target.value
    if (!val) return
    if (val === 'more') {
      window.location.href = '/hermes/settings'
      return
    }
    if (val === 'custom') return
    const [p, m] = val.split('|')
    const providerObj = providers[p]
    if (!providerObj) return
    
    save.mutate({
      provider: p,
      model: m,
      base_url: providerObj.base_url,
    })
    toast.success(`Đã đổi model sang ${m}`)
  }

  const currentValue = `${currentProvider}|${currentModel}`
  const isCustom = !QUICK_PRESETS.some(x => x.p === currentProvider && x.m === currentModel)

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-app-elevated" style={{ border: '1px solid var(--border)' }}>
      <Brain size={14} className="text-hermes shrink-0" />
      <select
        value={isCustom ? 'custom' : currentValue}
        onChange={handleChange}
        disabled={save.isPending}
        className="bg-transparent text-xs text-app-primary font-mono-ui outline-none cursor-pointer border-none p-0 pr-4"
        style={{ scrollbarWidth: 'none', WebkitAppearance: 'none', appearance: 'none', backgroundImage: 'url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23a1a1aa%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right center', backgroundSize: '8px auto' }}
      >
        {isCustom && <option value="custom">{currentModel} (Tùy chỉnh)</option>}
        {QUICK_PRESETS.map(preset => (
          <option key={`${preset.p}|${preset.m}`} value={`${preset.p}|${preset.m}`}>
            {preset.label}
          </option>
        ))}
        <option disabled>──────────</option>
        <option value="more">Cấu hình chi tiết...</option>
      </select>
    </div>
  )
}

export default function CampaignHub() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'overview'
  const [reviewOpen, setReviewOpen] = useState(false)

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['campaigns', id],
    queryFn: async () => (await api.get(`/campaigns/${id}`)).data,
    refetchInterval: 30000,
  })

  const { data: allAccounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => asArray((await api.get('/accounts')).data),
    refetchInterval: 60000,
  })

  const { data: allJobs = [] } = useQuery({
    queryKey: ['jobs', 'campaign-review', id],
    queryFn: async () => {
      const res = await api.get('/jobs?limit=200')
      return asArray(res.data).filter(j => j.payload?.campaign_id === id)
    },
    enabled: !!campaign,
    refetchInterval: 30000,
  })

  // Consolidated KPI source — same data as OverviewTab.
  // Keep it at the parent so the header badges + Overview agree.
  const { data: kpiTodayHeader } = useQuery({
    queryKey: ['campaigns', id, 'kpi-header'],
    enabled: !!campaign,
    queryFn: async () => {
      try { return (await api.get(`/campaigns/${id}/kpi-today`)).data } catch { return null }
    },
    refetchInterval: 30000,
  })
  const kpiTodayTotals = useMemo(() => {
    const rows = kpiTodayHeader?.rows || []
    return {
      done: rows.reduce((s, r) => s + (r.total_done || 0), 0),
      target: rows.reduce((s, r) => s + (r.total_target || 0), 0),
      comments: rows.reduce((s, r) => s + (r.done_comments || 0), 0),
      likes: rows.reduce((s, r) => s + (r.done_likes || 0), 0),
      frs: rows.reduce((s, r) => s + (r.done_friend_requests || 0), 0),
    }
  }, [kpiTodayHeader])

  const toggleStatus = useMutation({
    mutationFn: async (newStatus) => {
      await api.put(`/campaigns/${id}`, { status: newStatus })
    },
    onSuccess: (_, newStatus) => {
      toast.success(`Campaign ${newStatus === 'running' ? 'started' : 'paused'}`)
      qc.invalidateQueries({ queryKey: ['campaigns', id] })
      qc.invalidateQueries({ queryKey: ['campaigns'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  const deleteMut = useMutation({
    mutationFn: async () => { await api.delete(`/campaigns/${id}`) },
    onSuccess: () => {
      toast.success('Đã xóa campaign')
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      nav('/campaigns')
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  // Agents = union of role assignments + top-level account_ids (AI_PILOT mode
  // often sets only account_ids, leaving campaign_roles empty until Hermes
  // creates orchestrated roles — the badge showed 0 for those campaigns).
  // MUST be called before any early return — fixes React #310 (hook count
  // changed between loading→loaded renders).
  const nicksCount = useMemo(() => {
    if (!campaign) return 0
    const s = new Set([
      ...((campaign.campaign_roles || []).flatMap(r => r.account_ids || [])),
      ...(campaign.account_ids || []),
    ])
    return s.size
  }, [campaign?.campaign_roles, campaign?.account_ids])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader className="animate-spin text-hermes" size={20} />
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-app-muted font-mono-ui">
        <span>Campaign not found</span>
        <button onClick={() => nav('/campaigns')} className="btn-ghost mt-4">
          ← Back to missions
        </button>
      </div>
    )
  }

  const status = campaign.status || 'draft'
  const statusColor = {
    active: 'text-hermes',
    running: 'text-hermes',
    paused: 'text-warn',
    draft: 'text-app-muted',
  }[status] || 'text-app-muted'

  const isRunning = status === 'running' || status === 'active'
  const rolesCount = campaign.campaign_roles?.length ?? campaign.roles_count ?? 0

  return (
    <div className="flex flex-col h-full">
      {/* ─── Header ─── */}
      <div
        className="px-6 py-4"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/campaigns')}
            className="text-app-muted hover:text-app-primary"
            title="Back to missions"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="font-mono-ui text-[10px] uppercase tracking-wider text-app-muted">
              Mission
            </div>
            <div className="text-app-primary text-lg truncate mt-0.5">
              {campaign.name || 'Untitled'}
            </div>
          </div>
          <span className={`font-mono-ui text-[11px] uppercase tracking-wider ${statusColor}`}>
            ● {status}
          </span>
          <HermesCentralToggle campaign={campaign} />
          <HermesModelQuickSelect />
          <HermesRunNowButton campaignId={id} />
          {isRunning ? (
            <button
              onClick={() => toggleStatus.mutate('paused')}
              disabled={toggleStatus.isPending}
              className="btn-ghost"
            >
              <Pause size={14} /> PAUSE
            </button>
          ) : (
            <button
              onClick={() => toggleStatus.mutate('running')}
              disabled={toggleStatus.isPending}
              className="btn-hermes"
            >
              <Play size={14} /> START
            </button>
          )}
          <button
            onClick={() => setReviewOpen(true)}
            className="btn-hermes flex items-center gap-1"
            title="Hermes phân tích chiến dịch"
          >
            <Brain size={14} /> HERMES REVIEW
          </button>
          <button
            onClick={() => nav(`/campaigns/${id}/edit`)}
            className="btn-ghost"
            title="Sửa campaign"
          >
            <Edit size={14} />
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Xóa campaign "${campaign.name}"?\nViệc này không hoàn tác được.`)) {
                deleteMut.mutate()
              }
            }}
            disabled={deleteMut.isPending}
            className="btn-ghost"
            title="Xóa campaign"
            style={{ color: 'var(--danger)' }}
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Plan summary (if present) */}
        {(campaign.mission || campaign.description || campaign.plan_summary) && (
          <div className="mt-3">
            <HermesCaller taskType="ai_pilot" />
            <div className="text-[12px] text-app-muted mt-1 line-clamp-2">
              {campaign.mission || campaign.description || campaign.plan_summary}
            </div>
          </div>
        )}

        {/* Stats row — today's KPI consolidated from /campaigns/:id/kpi-today
            (the same endpoint Overview + Agents tabs use). Single source → no
            drift between header, tabs, or reports. */}
        <div className="flex items-center gap-8 mt-4">
          <DenseStat value={rolesCount} label="Roles" />
          <DenseStat value={nicksCount} label="Agents" color="hermes" />
          <DenseStat
            value={`${kpiTodayTotals.done}/${kpiTodayTotals.target}`}
            label="Done hôm nay"
            color="hermes"
          />
          <DenseStat value={kpiTodayTotals.comments} label="Comments" />
          <DenseStat value={kpiTodayTotals.likes} label="Likes" />
          <DenseStat value={kpiTodayTotals.frs} label="Kết bạn" />
        </div>
      </div>

      {/* ─── Tabs ─── */}
      <div
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams({ tab: t.key })}
            className={`px-4 py-2.5 ${tab === t.key ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
            style={{
              borderBottom: tab === t.key ? '2px solid var(--hermes)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Tab body ─── */}
      <div className="flex-1 overflow-hidden min-h-0">
        {tab === 'overview' && (
          <MergedTab>
            <OverviewTab campaign={campaign} campaignId={id} />
            <AgentsTab campaign={campaign} />
            <DataTab campaignId={id} />
          </MergedTab>
        )}
        {tab === 'runtime' && (
          <div className="h-full overflow-y-auto">
            <ExecutionTab campaignId={id} />
            <ActivityTab campaignId={id} campaign={campaign} />
          </div>
        )}
        {tab === 'assets' && (
          <MergedTab>
            <ContentTab campaignId={id} />
            <GroupsTab campaignId={id} />
          </MergedTab>
        )}
        {tab === 'hermes' && <HermesTab campaignId={id} />}
      </div>

      {reviewOpen && (
        <HermesReviewModal
          campaign={campaign}
          accounts={allAccounts}
          jobs={allJobs}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </div>
  )
}
