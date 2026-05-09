/**
 * /agents — Agent Roster redesigned as accordion by campaign
 *
 * Each campaign = collapsible section showing nicks grouped by role.
 * Each nick row: avatar, status dot, role (editable), current job (5s poll),
 * today's job stats, Hermes score, actions.
 *
 * Click nick → SlidePanel with 7-day activity chart, last 10 jobs,
 * pilot memories, pause/health actions.
 */
import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Play, Pause, Plus, X, ArrowRightLeft } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import DenseStat from '../../components/hermes/DenseStat'
import AgentStatusDot from '../../components/hermes/AgentStatusDot'
import HermesScoreBadge from '../../components/hermes/HermesScoreBadge'
import SlidePanel from '../../components/hermes/SlidePanel'
import JobRow from '../../components/hermes/JobRow'
import CookieRepairModal from '../../components/hermes/CookieRepairModal'
import { AddAccountModal } from '../accounts/AccountList'

const asArray = (d) => Array.isArray(d) ? d
  : Array.isArray(d?.items) ? d.items
  : Array.isArray(d?.data) ? d.data
  : Array.isArray(d?.results) ? d.results
  : []

const ROLE_COLORS = {
  scout:     'text-info',
  nurture:   'text-hermes',
  connect:   'text-warn',
  post:      'text-app-primary',
  interact:  'text-hermes',
  monitor:   'text-info',
  default:   'text-app-muted',
}

const ROLE_LABELS = {
  scout:    'Scout',
  nurture:  'Nurture',
  connect:  'Connect',
  post:     'Post',
  interact: 'Interact',
  monitor:  'Monitor',
}

const ROLE_OPTIONS = ['scout', 'nurture', 'connect', 'post', 'interact', 'monitor']

function formatAgo(ts) {
  if (!ts) return '—'
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

// ─── Inline role select (click to edit) ────────────────────
function RoleSelect({ currentRole, onChange, disabled }) {
  const [editing, setEditing] = useState(false)
  if (editing && !disabled) {
    return (
      <select
        autoFocus
        value={currentRole || ''}
        onChange={(e) => {
          onChange(e.target.value)
          setEditing(false)
        }}
        onBlur={() => setEditing(false)}
        className="bg-app-elevated text-app-primary text-xs font-mono-ui px-1 py-0.5"
        style={{ border: '1px solid var(--border-bright)' }}
      >
        {ROLE_OPTIONS.map((r) => (
          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
        ))}
      </select>
    )
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) setEditing(true)
      }}
      className={`font-mono-ui text-xs ${ROLE_COLORS[currentRole] || ROLE_COLORS.default} ${disabled ? 'cursor-default' : 'hover:underline'}`}
    >
      {ROLE_LABELS[currentRole] || '—'}
    </button>
  )
}

// ─── Single nick row inside campaign accordion ────────────
function NickRow({ nick, role, campaignId, runningJob, todayStats, todayJobs, onSelect, onRemove, onRoleChange, onRepair, onTogglePause, campaigns }) {
  const [transferOpen, setTransferOpen] = useState(false)

  const status = runningJob ? 'busy'
    : !nick.is_active ? 'offline'
    : nick.status === 'healthy' ? 'online'
    : nick.status === 'at_risk' ? 'idle'
    : 'error'
  const isPaused = !nick.is_active && !['checkpoint', 'expired', 'session_expired'].includes(nick.status)

  // Daily budget & breakdown
  const dailyBudgetTotal = (() => {
    const b = nick.daily_budget || {}
    let max = 0
    for (const k of Object.keys(b)) {
      if (k === 'reset_at') continue
      max += b[k]?.max || 0
    }
    return max || 100
  })()
  const progressPct = Math.min(100, Math.round(((todayStats?.total || 0) / dailyBudgetTotal) * 100))

  // Task breakdown
  const taskBreakdown = useMemo(() => {
    const counts = {}
    for (const j of (todayJobs || [])) {
      const t = j.payload?.action || j.type
      if (!t) continue
      counts[t] = (counts[t] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
  }, [todayJobs])

  // Last action
  const lastAction = useMemo(() => {
    const sorted = [...(todayJobs || [])].sort((a, b) =>
      new Date(b.finished_at || b.started_at || b.created_at) - new Date(a.finished_at || a.started_at || a.created_at)
    )
    return sorted[0]
  }, [todayJobs])

  const lastActionLabel = (() => {
    if (!lastAction) return null
    const ts = lastAction.finished_at || lastAction.started_at || lastAction.created_at
    const time = ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : ''
    const action = lastAction.payload?.action || lastAction.type || ''
    const result = lastAction.result?.comment_text
      || lastAction.result?.post_url
      || lastAction.result?.summary
      || lastAction.error_message
      || lastAction.status
    return `${time} — ${action}${result ? ' "' + String(result).substring(0, 60) + (String(result).length > 60 ? '...' : '') + '"' : ''}`
  })()

  return (
    <div
      className="px-4 py-3 hover-row cursor-pointer"
      style={{ borderBottom: '1px solid var(--border)' }}
      onClick={() => onSelect(nick)}
    >
      {/* TOP ROW: status, name, role, current job, stats, score, actions */}
      <div className="flex items-center gap-4">
        <AgentStatusDot status={status} pulse={!!runningJob} size="lg" />

        <div className="min-w-0 flex-1">
          <div className="text-app-primary text-sm truncate">{nick.username || nick.id.slice(0, 8)}</div>
          <div className="text-app-muted text-[10px] font-mono-ui">
            {nick.id.slice(0, 8)} · {formatAgo(nick.updated_at)}
          </div>
        </div>

        <div className="w-20" onClick={(e) => e.stopPropagation()}>
          {role ? (
            <RoleSelect currentRole={role} onChange={(newRole) => onRoleChange(nick.id, newRole)} />
          ) : (
            <span className="text-app-dim font-mono-ui text-xs">—</span>
          )}
        </div>

        <div className="w-48 font-mono-ui text-xs">
          {runningJob ? (
            <>
              <div className="text-info truncate">→ {runningJob.payload?.action || runningJob.type}</div>
              <div className="text-app-dim text-[10px]">started {formatAgo(runningJob.started_at)}</div>
            </>
          ) : ['checkpoint', 'expired', 'session_expired'].includes(nick.status) ? (
            <div className="flex items-center gap-2">
              <span className="text-danger">⚠ {nick.status === 'session_expired' ? 'session expired' : nick.status}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRepair?.(nick)
                }}
                className="text-[10px] uppercase px-2 py-0.5"
                style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.4)' }}
              >
                Xử lý
              </button>
            </div>
          ) : nick.status === 'at_risk' ? (
            <span className="text-warn">at risk</span>
          ) : nick.status === 'expired' ? (
            <span className="text-danger">⚠ session expired</span>
          ) : !nick.is_active ? (
            <span className="text-danger">disabled · check status</span>
          ) : (
            <span className="text-app-dim">idle</span>
          )}
        </div>

        <div className="w-24 text-right font-mono-ui text-xs">
          <div className="text-app-primary">{todayStats?.total || 0} jobs</div>
          {(todayStats?.failed || 0) > 0 ? (
            <div className="text-danger text-[10px]">{todayStats.failed} fail</div>
          ) : (
            <div className="text-app-dim text-[10px]">0 fail</div>
          )}
        </div>

        <div onClick={(e) => e.stopPropagation()}>
          <HermesScoreBadge score={todayStats?.avg_score} />
        </div>

        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onTogglePause?.(nick, !isPaused)}
            title={isPaused ? 'Chạy lại nick' : 'Tạm dừng nick'}
            className={`p-1 ${isPaused ? 'text-hermes hover:text-hermes' : 'text-app-muted hover:text-warn'}`}
          >
            {isPaused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            onClick={() => setTransferOpen(!transferOpen)}
            title="Chuyển campaign"
            className="text-app-muted hover:text-info p-1"
          >
            <ArrowRightLeft size={14} />
          </button>
          <button
            onClick={() => onRemove(nick.id)}
            title="Remove khỏi campaign"
            className="text-app-muted hover:text-danger p-1"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Paused badge — shown when user manually paused (not checkpoint/expired which already have their own styling) */}
      {isPaused && (
        <div className="absolute top-2 right-24 px-2 py-0.5 text-[10px] font-mono-ui rounded-sm"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--warn)', color: 'var(--warn)' }}>
          ⏸ Tạm dừng
        </div>
      )}

      {/* INLINE DETAIL — always visible (no click required) */}
      <div className="mt-2 pl-9 grid grid-cols-12 gap-3 font-mono-ui text-[11px]">
        {/* Progress bar */}
        <div className="col-span-3 flex items-center gap-2">
          <span className="text-app-muted text-[10px] uppercase">Hôm nay</span>
          <div className="flex-1 h-1.5" style={{ background: 'var(--bg-elevated)' }}>
            <div
              className={progressPct >= 90 ? 'bg-warn h-full' : 'bg-hermes h-full'}
              style={{ width: progressPct + '%' }}
            />
          </div>
          <span className="text-app-primary tabular-nums text-[10px]">
            {todayStats?.total || 0}/{dailyBudgetTotal}
          </span>
        </div>

        {/* Task breakdown (all job types, not only Hermes) */}
        <div className="col-span-3 truncate">
          <span className="text-app-muted text-[10px] uppercase">Tasks: </span>
          {taskBreakdown.length === 0 ? (
            <span className="text-app-dim">—</span>
          ) : (
            taskBreakdown.map(([t, c], i) => (
              <span key={t} className="text-app-primary">
                {i > 0 && <span className="text-app-dim"> · </span>}
                {t}<span className="text-app-muted"> ×{c}</span>
              </span>
            ))
          )}
        </div>

        {/* Last action */}
        <div className="col-span-4 truncate">
          <span className="text-app-muted text-[10px] uppercase">Gần nhất: </span>
          {lastActionLabel ? (
            <span className="text-app-primary">{lastActionLabel}</span>
          ) : (
            <span className="text-app-dim">chưa có</span>
          )}
        </div>

        {/* Memory/fewshot indicator */}
        <div className="col-span-2 text-right text-app-muted">
          {todayStats?.total > 0 && (
            <span>
              <span className="text-hermes">mem={todayStats.memory_count || 0}</span>
              <span className="mx-1">·</span>
              <span className="text-info">fs={todayStats.fewshot_count || 0}</span>
            </span>
          )}
        </div>
      </div>

      {/* Transfer dropdown */}
      {transferOpen && (
        <div
          className="absolute right-4 z-20 bg-app-elevated font-mono-ui text-xs"
          style={{ border: '1px solid var(--border-bright)', minWidth: 200, marginTop: 4 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 text-[10px] uppercase text-app-muted" style={{ borderBottom: '1px solid var(--border)' }}>
            Chuyển sang
          </div>
          {campaigns.filter(c => c.id !== campaignId).map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setTransferOpen(false)
                toast(`Transfer logic TBD: ${nick.username} → ${c.name}`)
              }}
              className="w-full text-left px-3 py-2 hover-row text-app-primary"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Single campaign accordion section ─────────────────────
function CampaignSection({ campaign, accounts, runningJobs, todayStatsByAcc, todayJobsByAcc, campaigns, onRoleChange, onRemoveFromRole, onSelect, onRepair, onTogglePause }) {
  const [expanded, setExpanded] = useState(true)
  const nav = useNavigate()

  const roles = campaign.campaign_roles || []
  // Map account_id → role_type for this campaign
  const accountRoles = {}
  roles.forEach(r => {
    (r.account_ids || []).forEach(accId => {
      accountRoles[accId] = r.role_type
    })
  })
  const assignedAccountIds = Object.keys(accountRoles)
  const assignedAccounts = accounts.filter(a => assignedAccountIds.includes(a.id))

  const totalJobs = assignedAccountIds.reduce((sum, id) => sum + (todayStatsByAcc[id]?.total || 0), 0)
  const avgScore = (() => {
    const scores = assignedAccountIds.map(id => todayStatsByAcc[id]?.avg_score).filter(s => s > 0)
    if (scores.length === 0) return null
    return scores.reduce((a, b) => a + b, 0) / scores.length
  })()

  const isRunning = ['active', 'running'].includes(campaign.status)
  const statusColor = isRunning ? 'text-hermes'
    : campaign.status === 'paused' ? 'text-warn'
    : 'text-app-muted'

  return (
    <div className="mb-4" style={{ border: '1px solid var(--border)' }}>
      {/* Header (always visible) */}
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer bg-app-elevated"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={16} className="text-app-muted" /> : <ChevronRight size={16} className="text-app-muted" />}
        <span className="text-lg">🎯</span>
        <div className="flex-1 min-w-0">
          <div className="text-app-primary truncate" onClick={(e) => {
            e.stopPropagation()
            nav(`/campaigns/${campaign.id}`)
          }}>
            {campaign.name || '(unnamed)'}
          </div>
        </div>
        <span className={`font-mono-ui text-[11px] uppercase tracking-wider ${statusColor}`}>
          ● {campaign.status || 'draft'}
        </span>
        <span className="font-mono-ui text-xs text-app-muted">
          {assignedAccounts.length} nicks
        </span>
        <span className="font-mono-ui text-xs text-app-muted">
          · {totalJobs} jobs hôm nay
        </span>
        {avgScore !== null && (
          <span className="font-mono-ui text-xs">
            · <span className="text-app-muted">score </span>
            <span className={avgScore >= 4 ? 'text-hermes' : avgScore >= 3 ? 'text-warn' : 'text-danger'}>
              {avgScore.toFixed(1)}
            </span>
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            nav(`/campaigns/${campaign.id}`)
          }}
          className="btn-ghost"
          style={{ fontSize: 11 }}
        >
          {isRunning ? 'MANAGE' : 'OPEN'}
        </button>
      </div>

      {/* Body */}
      {expanded && (
        <div className="relative">
          {assignedAccounts.length === 0 ? (
            <div className="px-4 py-6 text-center text-app-muted font-mono-ui text-xs">
              No nicks assigned. <button
                onClick={() => nav(`/campaigns/${campaign.id}/edit`)}
                className="text-hermes underline"
              >
                Edit campaign
              </button>
            </div>
          ) : (
            assignedAccounts.map((nick) => (
              <NickRow
                key={`${campaign.id}-${nick.id}`}
                nick={nick}
                role={accountRoles[nick.id]}
                campaignId={campaign.id}
                campaigns={campaigns}
                runningJob={runningJobs.find(j => j.payload?.account_id === nick.id && j.payload?.campaign_id === campaign.id)}
                todayStats={todayStatsByAcc[nick.id]}
                todayJobs={todayJobsByAcc[nick.id]}
                onSelect={onSelect}
                onRemove={(accId) => onRemoveFromRole(campaign.id, accId)}
                onRoleChange={(accId, newRole) => onRoleChange(campaign.id, accId, newRole)}
                onRepair={onRepair}
                onTogglePause={onTogglePause}
              />
            ))
          )}

          {/* Add nick button */}
          <div
            className="px-4 py-2 text-right"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <button
              onClick={() => nav(`/campaigns/${campaign.id}/edit`)}
              className="btn-ghost inline-flex items-center gap-1"
              style={{ fontSize: 11 }}
            >
              <Plus size={12} /> THÊM NICK
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Unassigned nicks section ──────────────────────────────
function UnassignedSection({ nicks, runningJobs, todayStatsByAcc, todayJobsByAcc, onSelect, onRepair, onTogglePause, onCheckHealth, onGenSchedule }) {
  // 2026-05-05: default expanded so newly-added nicks are visible immediately
  // (user just added them — no point hiding behind a click).
  const [expanded, setExpanded] = useState(true)

  if (nicks.length === 0) return null

  return (
    <div className="mb-4" style={{ border: '1px solid var(--border)' }}>
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer bg-app-elevated"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={16} className="text-app-muted" /> : <ChevronRight size={16} className="text-app-muted" />}
        <span className="text-lg">📦</span>
        <div className="flex-1 text-app-primary">
          Chưa gán campaign
        </div>
        <span className="font-mono-ui text-xs text-app-muted">
          {nicks.length} nicks
        </span>
      </div>

      {expanded && nicks.map((nick) => (
        <div key={`unassigned-${nick.id}`} className="flex items-stretch" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex-1">
            <NickRow
              nick={nick}
              role={null}
              campaignId={null}
              campaigns={[]}
              runningJob={runningJobs.find(j => j.payload?.account_id === nick.id)}
              todayStats={todayStatsByAcc[nick.id]}
              todayJobs={todayJobsByAcc[nick.id]}
              onSelect={onSelect}
              onRemove={() => {}}
              onRoleChange={() => {}}
              onRepair={onRepair}
              onTogglePause={onTogglePause}
            />
          </div>
          <div className="self-center mr-3 flex flex-col gap-1">
            {onCheckHealth && (
              <button
                onClick={(e) => { e.stopPropagation(); onCheckHealth(nick) }}
                className="px-2.5 py-1 text-[10px] font-mono-ui uppercase rounded border border-app-border text-app-primary hover:bg-app-elevated whitespace-nowrap"
                title="Queue check_health job — verify cookie còn sống"
              >
                Check live
              </button>
            )}
            {onGenSchedule && (
              <button
                onClick={(e) => { e.stopPropagation(); onGenSchedule(nick) }}
                className="px-2.5 py-1 text-[10px] font-mono-ui uppercase rounded border border-info/40 text-info hover:bg-info/10 whitespace-nowrap"
                title={nick.schedule_profile ? `AI lại lịch trình (hiện: ${nick.schedule_profile.personality} · ${nick.schedule_profile.peak_offset_minutes}min)` : 'AI tạo lịch trình personality cho nick này'}
              >
                {nick.schedule_profile ? '✓ AI lịch' : 'AI tạo lịch'}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Nick detail slide-out panel ───────────────────────────
// Hermes/autopilot diagnosis row. Shows cause + plan; for bumps and
// actionable alerts, exposes Áp dụng / Bỏ qua buttons that hit the
// existing /ai-hermes/decisions/:id/approve|reject endpoints.
function DiagnosisRow({ decision, nickId }) {
  const qc = useQueryClient()
  const payload = typeof decision.decision === 'string'
    ? (() => { try { return JSON.parse(decision.decision) } catch { return {} } })()
    : (decision.decision || {})
  const isBump = decision.decision_type === 'capability_bump'
  const isShortfall = decision.decision_type === 'kpi_shortfall'
  const canApply = isBump  // shortfall is informational only

  const approve = useMutation({
    mutationFn: async () => (await api.patch(`/ai-hermes/decisions/${decision.id}/approve`)).data,
    onSuccess: (data) => {
      toast.success(data?.detail || 'Áp dụng xong')
      qc.invalidateQueries({ queryKey: ['nick-kpi-status', nickId] })
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })
  const reject = useMutation({
    mutationFn: async () => (await api.patch(`/ai-hermes/decisions/${decision.id}/reject`)).data,
    onSuccess: () => {
      toast.success('Đã đóng')
      qc.invalidateQueries({ queryKey: ['nick-kpi-status', nickId] })
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message),
  })

  return (
    <div
      className="px-3 py-2"
      style={{
        background: isBump ? 'color-mix(in srgb, var(--hermes) 10%, var(--bg-base))' : 'color-mix(in srgb, var(--warn) 10%, var(--bg-base))',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="flex items-start gap-2">
        <span className={isBump ? 'text-hermes' : 'text-warn'}>{isBump ? '⬆' : '⚠'}</span>
        <div className="flex-1">
          <div className="text-app-primary text-[12px]">{decision.reason}</div>
          {payload.plan && isShortfall && (
            <div className="text-[10px] text-app-muted mt-1">
              <span className="text-app-primary">Plan: </span>{payload.plan}
            </div>
          )}
          {Array.isArray(payload.per_action_plan) && payload.per_action_plan.length > 0 && (
            <div className="text-[10px] text-app-muted mt-1 space-y-0.5">
              {payload.per_action_plan.map((p, i) => (
                <div key={i}>
                  <span className="text-warn">• {p.label}</span>
                  <span className="text-app-dim"> {p.done}/{p.target}</span>
                  <span className="text-app-muted"> → {p.plan}</span>
                </div>
              ))}
            </div>
          )}
          {isBump && payload.streak_days && (
            <div className="text-[10px] text-app-muted mt-1">
              {payload.streak_days} ngày liên tiếp đạt KPI · đề xuất +{payload.bump_pct || 20}% target
            </div>
          )}
          {(canApply || isShortfall) && decision.outcome !== 'user_approved' && decision.outcome !== 'user_rejected' && (
            <div className="flex items-center gap-2 mt-2">
              {canApply && (
                <button
                  className="px-2 py-0.5 text-[10px] font-mono-ui uppercase tracking-wider text-hermes hover:opacity-80"
                  style={{ border: '1px solid var(--hermes)' }}
                  disabled={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  {approve.isPending ? 'Đang áp dụng…' : 'Áp dụng'}
                </button>
              )}
              <button
                className="px-2 py-0.5 text-[10px] font-mono-ui uppercase tracking-wider text-app-muted hover:text-app-primary"
                style={{ border: '1px solid var(--border)' }}
                disabled={reject.isPending}
                onClick={() => reject.mutate()}
              >
                {reject.isPending ? '…' : 'Đóng'}
              </button>
            </div>
          )}
          {(decision.outcome === 'user_approved' || decision.outcome === 'user_rejected') && (
            <div className="text-[10px] text-app-dim mt-1">
              {decision.outcome === 'user_approved' ? '✓ Đã áp dụng' : '× Đã đóng'}
            </div>
          )}
        </div>
        <span className="text-[9px] text-app-dim shrink-0">{formatAgo(decision.created_at)}</span>
      </div>
    </div>
  )
}

function NickDetailPanel({ nick, onClose, onRepair }) {
  const { data: memories = [] } = useQuery({
    queryKey: ['ai-memory', nick?.id],
    enabled: !!nick,
    queryFn: async () => {
      // Direct DB query via API would need a new endpoint. For now use /ai-hermes/feedback/recent
      // and filter by account_id client-side, or create /agent-jobs/memory/:account_id.
      // Fall back gracefully.
      try {
        const res = await api.get(`/ai-hermes/feedback/recent?limit=50`)
        return asArray(res.data?.feedback).filter(f => f.account_id === nick.id)
      } catch {
        return []
      }
    },
  })

  const { data: recentJobs = [] } = useQuery({
    queryKey: ['nick-jobs', nick?.id],
    enabled: !!nick,
    queryFn: async () => {
      try {
        const res = await api.get(`/jobs?limit=10&account_id=${nick.id}`)
        return asArray(res.data)
      } catch {
        return []
      }
    },
    refetchInterval: 10000,
  })

  const { data: quotaToday = {} } = useQuery({
    queryKey: ['nick-quota', nick?.id],
    enabled: !!nick,
    queryFn: async () => {
      try {
        const res = await api.get(`/accounts/${nick.id}/quota-today`)
        return res.data || {}
      } catch {
        return {}
      }
    },
    refetchInterval: 15000,
  })

  const { data: kpiStatus } = useQuery({
    queryKey: ['nick-kpi-status', nick?.id],
    enabled: !!nick,
    queryFn: async () => {
      try {
        const res = await api.get(`/accounts/${nick.id}/kpi-status`)
        return res.data
      } catch {
        return null
      }
    },
    refetchInterval: 30000,
  })

  // 7-day bar chart data
  const last7Days = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      const nextD = new Date(d)
      nextD.setDate(nextD.getDate() + 1)
      const count = recentJobs.filter(j => {
        const jt = new Date(j.created_at)
        return jt >= d && jt < nextD
      }).length
      days.push({
        label: d.toLocaleDateString('vi-VN', { weekday: 'short' }).slice(0, 2),
        count,
      })
    }
    return days
  }, [recentJobs])

  const maxCount = Math.max(1, ...last7Days.map(d => d.count))

  if (!nick) return null

  return (
    <SlidePanel
      open={!!nick}
      onClose={onClose}
      title={nick.username || nick.id.slice(0, 8)}
      width={560}
    >
      <div className="p-4 font-mono-ui text-xs">
        {/* Status card */}
        <div className="flex items-center gap-3 mb-4 p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
          <AgentStatusDot
            status={nick.is_active ? (nick.status === 'healthy' ? 'online' : 'error') : 'offline'}
            size="lg"
          />
          <div className="flex-1">
            <div className="text-app-primary text-sm">{nick.username}</div>
            <div className="text-app-muted text-[10px]">{nick.id}</div>
          </div>
          <div className="text-right">
            <div className={
              nick.status === 'healthy' ? 'text-hermes' :
              nick.status === 'at_risk' ? 'text-warn' :
              ['checkpoint', 'session_expired', 'expired'].includes(nick.status) ? 'text-danger' : 'text-app-muted'
            }>
              {nick.status || '—'}
            </div>
            <div className="text-app-dim text-[10px]">last seen {formatAgo(nick.updated_at)}</div>
          </div>
        </div>

        {/* 7-day activity */}
        <div className="mb-4">
          <div className="text-[10px] uppercase text-app-muted mb-2">7 ngày gần nhất</div>
          <div
            className="flex items-end gap-1 h-20 p-2"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
          >
            {last7Days.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1">
                <div
                  className="w-full bg-hermes"
                  style={{ height: `${(d.count / maxCount) * 100}%`, minHeight: d.count > 0 ? 2 : 0 }}
                />
                <div className="text-[9px] text-app-muted">{d.label}</div>
                <div className="text-[9px] text-app-primary">{d.count}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Hermes KPI card — per-action done/target + shortfall diagnosis
            from nick-kpi-watcher. Surfaces cause + plan for each missing
            action type (likes/comments/FR/joins) instead of a flat
            aggregate. Refreshes every 30s. */}
        {kpiStatus && (kpiStatus.kpi?.length > 0 || kpiStatus.diagnoses?.length > 0) && (
          <div className="mb-4">
            <div className="text-[10px] uppercase text-app-muted mb-2">Hermes KPI hôm nay</div>
            <div style={{ border: '1px solid var(--border)' }}>
              {(kpiStatus.kpi || []).map((k) => {
                const rows = [
                  { label: 'Like',     done: k.done_likes,    target: k.target_likes },
                  { label: 'Comment',  done: k.done_comments, target: k.target_comments },
                  { label: 'Kết bạn',  done: k.done_fr,       target: k.target_fr },
                  { label: 'Join nhóm',done: k.done_joins,    target: k.target_joins },
                ].filter(r => r.target > 0)
                return (
                  <div key={k.campaign_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="px-3 py-1.5 text-[10px] text-app-muted" style={{ background: 'var(--bg-elevated)' }}>
                      {k.campaign_name || 'campaign'}
                    </div>
                    {rows.map((r) => {
                      const pct = r.target > 0 ? Math.min(100, Math.round((r.done / r.target) * 100)) : 0
                      const hit = r.done >= r.target
                      const behind = pct < 40
                      return (
                        <div key={r.label} className="flex items-center gap-3 px-3 py-2">
                          <div className="w-20 text-app-primary">{r.label}</div>
                          <div className="flex-1 h-2" style={{ background: 'var(--bg-base)' }}>
                            <div className="h-full" style={{
                              width: `${pct}%`,
                              background: hit ? 'var(--hermes)' : (behind ? 'var(--danger)' : 'var(--warn)'),
                            }} />
                          </div>
                          <div className={`w-16 text-right ${hit ? 'text-hermes' : (behind ? 'text-danger' : 'text-app-primary')}`}>
                            {r.done}/{r.target}
                          </div>
                          <div className="w-10 text-right text-app-muted">{pct}%</div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
              {(kpiStatus.diagnoses || []).map((d) => (
                <DiagnosisRow key={d.id} decision={d} nickId={nick.id} />
              ))}
            </div>
          </div>
        )}

        {/* Daily KPI (quota) — job creation cap, not action KPI */}
        <div className="mb-4">
          <div className="text-[10px] uppercase text-app-muted mb-2">Quota tạo job hôm nay</div>
          <div style={{ border: '1px solid var(--border)' }}>
            {Object.keys(quotaToday).length === 0 ? (
              <div className="p-3 text-app-muted text-center">No quota data</div>
            ) : (
              Object.entries(quotaToday)
                .filter(([, v]) => v.quota > 0)
                .map(([type, v]) => {
                  const done = v.done || 0
                  const pending = v.pending || 0
                  const target = v.quota || 0
                  const pctDone = target > 0 ? Math.min(100, (done / target) * 100) : 0
                  const ok = done >= target
                  return (
                    <div key={type} className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="text-app-primary flex-1 min-w-0 truncate">{type}</div>
                      <div className="w-24 h-2" style={{ background: 'var(--bg-base)' }}>
                        <div className="h-full" style={{ width: `${pctDone}%`, background: ok ? 'var(--hermes)' : 'var(--warn)' }} />
                      </div>
                      <div className={`w-16 text-right ${ok ? 'text-hermes' : 'text-app-primary'}`}>
                        {done}/{target}
                      </div>
                      <div className="w-10 text-right text-app-muted">
                        {pending > 0 ? `+${pending}` : ''}
                      </div>
                    </div>
                  )
                })
            )}
          </div>
        </div>

        {/* Last 10 jobs */}
        <div className="mb-4">
          <div className="text-[10px] uppercase text-app-muted mb-2">
            10 jobs gần nhất ({recentJobs.length})
          </div>
          <div style={{ border: '1px solid var(--border)' }}>
            {recentJobs.length === 0 ? (
              <div className="p-3 text-app-muted text-center">No jobs yet</div>
            ) : (
              recentJobs.map(j => <JobRow key={j.id} job={j} />)
            )}
          </div>
        </div>

        {/* Hermes memory about this nick */}
        <div className="mb-4">
          <div className="text-[10px] uppercase text-app-muted mb-2">
            Hermes đã học ({memories.length})
          </div>
          <div style={{ border: '1px solid var(--border)' }}>
            {memories.length === 0 ? (
              <div className="p-3 text-app-muted text-center">
                Chưa có memory — Hermes sẽ học sau 5-10 successful actions
              </div>
            ) : (
              memories.slice(0, 10).map((m, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 px-3 py-2"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <HermesScoreBadge score={m.score} />
                  <div className="flex-1 min-w-0">
                    <div className="text-app-muted text-[10px]">
                      {m.task_type} · {m.reason || '—'}
                    </div>
                    <div className="text-app-primary text-xs truncate">
                      {m.output_preview}
                    </div>
                  </div>
                  <span className="text-app-dim text-[10px]">{formatAgo(m.ts * 1000)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <button
            className="btn-ghost"
            onClick={() => {
              toast('Pause nick: TBD')
            }}
          >
            {nick.is_active ? 'PAUSE NICK' : 'RESUME NICK'}
          </button>
          <button
            className="btn-ghost"
            onClick={async () => {
              try {
                await api.post(`/accounts/${nick.id}/check-health`)
                toast.success('Health check queued')
              } catch (e) {
                toast.error(e.response?.data?.error || e.message)
              }
            }}
          >
            HEALTH CHECK
          </button>
          <button
            className="text-[10px] uppercase px-3 py-1.5 font-mono-ui"
            style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.4)' }}
            onClick={() => onRepair?.(nick)}
          >
            SỬA COOKIE
          </button>
          <a
            href={`/accounts/${nick.id}`}
            className="btn-ghost"
          >
            FULL DETAIL
          </a>
        </div>
      </div>
    </SlidePanel>
  )
}

// ─── Main page ─────────────────────────────────────────────
export default function AgentsRoster() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState(null)
  const [repairNick, setRepairNick] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()
  // 2026-05-05: add-nick modal — user reported /agents had no way to add a
  // new agent and had to go to /accounts. Reuse the same AddAccountModal so
  // there's only one source of truth for the add flow.
  const [showAddModal, setShowAddModal] = useState(false)

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => asArray((await api.get('/accounts')).data),
    refetchInterval: 30000,
  })

  // Deep-link: ?repair={account_id} from ProactiveAlerts toast click.
  // Wait for accounts to load, then open the modal for that nick + clear the param.
  useEffect(() => {
    const repairId = searchParams.get('repair')
    if (!repairId || !accounts.length) return
    const nick = accounts.find(a => a.id === repairId)
    if (nick) {
      setRepairNick(nick)
      const next = new URLSearchParams(searchParams)
      next.delete('repair')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, accounts, setSearchParams])

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => asArray((await api.get('/campaigns')).data),
    refetchInterval: 30000,
  })

  // Poll running jobs every 5s
  const { data: jobs = [] } = useQuery({
    queryKey: ['jobs', 'live'],
    queryFn: async () => asArray((await api.get('/jobs?limit=100')).data),
    refetchInterval: 5000,
  })

  // Memory counts per account (real from ai_pilot_memory, not from job.result)
  const { data: memCounts = {} } = useQuery({
    queryKey: ['hermes', 'memory-stats'],
    queryFn: async () => {
      try { return (await api.get('/ai-hermes/memory-stats')).data || {} }
      catch { return {} }
    },
    refetchInterval: 60000,
  })

  // Per-account fewshot counts from hermes_feedback aggregated by account
  const { data: fewshotCounts = {} } = useQuery({
    queryKey: ['hermes', 'feedback-counts'],
    queryFn: async () => {
      try {
        const fb = (await api.get('/ai-hermes/feedback/recent?limit=500')).data?.feedback || []
        const counts = {}
        for (const f of fb) {
          if (f.account_id && (f.score || 0) >= 4) {
            counts[f.account_id] = (counts[f.account_id] || 0) + 1
          }
        }
        return counts
      } catch { return {} }
    },
    refetchInterval: 60000,
  })

  // 7-day Hermes feedback avg score per nick — authoritative health signal
  // per-nick (unlike job.result.hermes_score which was only sometimes populated).
  const { data: hermesScoresByAcc = {} } = useQuery({
    queryKey: ['hermes', 'scores-7d'],
    queryFn: async () => {
      try {
        const rows = (await api.get('/accounts/hermes-scores')).data || []
        const map = {}
        for (const r of rows) {
          map[r.account_id] = { avg_score: Number(r.avg_score) || 0, total_calls: r.total_calls || 0 }
        }
        return map
      } catch { return {} }
    },
    refetchInterval: 120000,
  })

  const runningJobs = jobs.filter(j => ['claimed', 'running'].includes(j.status))

  // Compute today stats per account (client-side aggregation)
  const todayJobsByAcc = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const map = {}
    for (const j of jobs) {
      const accId = j.payload?.account_id
      if (!accId) continue
      if (new Date(j.created_at) < today) continue
      if (!map[accId]) map[accId] = []
      map[accId].push(j)
    }
    return map
  }, [jobs])

  const todayStatsByAcc = useMemo(() => {
    const stats = {}
    // Base: every account with jobs today
    for (const [accId, accJobs] of Object.entries(todayJobsByAcc)) {
      let done = 0, failed = 0
      for (const j of accJobs) {
        if (j.status === 'done') done++
        if (j.status === 'failed') failed++
      }
      stats[accId] = {
        total: accJobs.length,
        done, failed,
        // 7-day Hermes feedback avg is authoritative; fall back to 0 if no calls yet
        avg_score: hermesScoresByAcc[accId]?.avg_score || 0,
        score_calls_7d: hermesScoresByAcc[accId]?.total_calls || 0,
        memory_count: memCounts[accId] || 0,
        fewshot_count: fewshotCounts[accId] || 0,
      }
    }
    // Also include accounts with NO jobs today but with a 7-day Hermes score
    // so the badge renders on idle nicks too.
    for (const [accId, s] of Object.entries(hermesScoresByAcc)) {
      if (!stats[accId]) {
        stats[accId] = {
          total: 0, done: 0, failed: 0,
          avg_score: s.avg_score,
          score_calls_7d: s.total_calls,
          memory_count: memCounts[accId] || 0,
          fewshot_count: fewshotCounts[accId] || 0,
        }
      }
    }
    return stats
  }, [todayJobsByAcc, memCounts, fewshotCounts, hermesScoresByAcc])

  // Assigned account ids across all campaigns
  const assignedIds = useMemo(() => {
    const ids = new Set()
    for (const c of campaigns) {
      for (const r of (c.campaign_roles || [])) {
        for (const accId of (r.account_ids || [])) {
          ids.add(accId)
        }
      }
    }
    return ids
  }, [campaigns])

  const unassignedNicks = accounts.filter(a => !assignedIds.has(a.id))

  // Mutations
  const changeRole = useMutation({
    mutationFn: async ({ campaignId, accountId, newRole }) => {
      // Find current role, remove from old, add to new.
      // This needs an API endpoint ideally. For now call PUT /campaigns/:id with updated roles.
      const campaign = campaigns.find(c => c.id === campaignId)
      if (!campaign) throw new Error('Campaign not found')

      const updatedRoles = (campaign.campaign_roles || []).map(r => {
        let ids = r.account_ids || []
        if (r.role_type !== newRole) {
          ids = ids.filter(id => id !== accountId)
        } else if (!ids.includes(accountId)) {
          ids = [...ids, accountId]
        }
        return { ...r, account_ids: ids }
      })

      await api.put(`/campaigns/${campaignId}`, { campaign_roles: updatedRoles })
    },
    onSuccess: () => {
      toast.success('Role updated')
      qc.invalidateQueries({ queryKey: ['campaigns'] })
    },
    onError: (err) => {
      toast.error(`Role change failed: ${err.response?.data?.error || err.message}`)
    },
  })

  const removeFromCampaign = useMutation({
    mutationFn: async ({ campaignId, accountId }) => {
      const campaign = campaigns.find(c => c.id === campaignId)
      if (!campaign) throw new Error('Campaign not found')
      const updatedRoles = (campaign.campaign_roles || []).map(r => ({
        ...r,
        account_ids: (r.account_ids || []).filter(id => id !== accountId),
      }))
      await api.put(`/campaigns/${campaignId}`, { campaign_roles: updatedRoles })
    },
    onSuccess: () => {
      toast.success('Nick removed from campaign')
      qc.invalidateQueries({ queryKey: ['campaigns'] })
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || err.message)
    },
  })

  // Pause/resume a single nick via is_active toggle. Optimistic update so the
  // row dims immediately; poller respects is_active=false on next cycle.
  const togglePauseNick = useMutation({
    mutationFn: async ({ nick, pause }) => {
      await api.put(`/accounts/${nick.id}`, { is_active: !pause })
    },
    onMutate: async ({ nick, pause }) => {
      await qc.cancelQueries({ queryKey: ['accounts'] })
      const prev = qc.getQueryData(['accounts'])
      qc.setQueryData(['accounts'], (old) => {
        if (!Array.isArray(old)) return old
        return old.map(a => a.id === nick.id ? { ...a, is_active: !pause } : a)
      })
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['accounts'], ctx.prev)
      toast.error(err.response?.data?.error || err.message)
    },
    onSuccess: (_d, { nick, pause }) => {
      toast.success(pause ? `Đã tạm dừng ${nick.username}` : `${nick.username} hoạt động lại`)
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  // 2026-05-05: explicit "Check live" button for newly-added nicks. Posts a
  // check_health job — agent picks it up, opens the profile, verifies cookie,
  // updates accounts.status (healthy/checkpoint/expired). User can immediately
  // see if a freshly pasted cookie is still alive.
  const checkHealthMut = useMutation({
    mutationFn: async (nick) => {
      await api.post(`/accounts/${nick.id}/check-health`)
    },
    onSuccess: (_d, nick) => {
      toast.success(`Đã queue health check cho ${nick.username || nick.id.slice(0, 8)} — kết quả ~30s`)
      qc.invalidateQueries({ queryKey: ['jobs', 'live'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  // 2026-05-05: AI-driven per-nick schedule planner. Calls Hermes
  // nick_schedule_planner skill — returns a personality profile (morning_dev,
  // night_owl, etc.) with peak_offset_minutes the campaign scheduler reads.
  const genScheduleMut = useMutation({
    mutationFn: async (nick) => {
      const { data } = await api.post(`/accounts/${nick.id}/generate-schedule`)
      return { nick, profile: data?.profile }
    },
    onSuccess: ({ nick, profile }) => {
      toast.success(`${nick.username || nick.id.slice(0, 8)} → ${profile?.personality} · peak ${profile?.peak_offset_minutes}min ±${profile?.jitter_minutes}`)
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  // Top stats
  const activeNicks = accounts.filter(a => a.is_active).length
  const busyNow = runningJobs.length
  const todayTotal = Object.values(todayStatsByAcc).reduce((s, st) => s + st.total, 0)
  const todayFailed = Object.values(todayStatsByAcc).reduce((s, st) => s + st.failed, 0)

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Top stats */}
        <div
          className="flex items-center gap-8 px-6 py-4"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div>
            <div className="font-mono-ui text-[10px] uppercase text-app-muted">Agents</div>
            <div className="text-app-primary text-lg mt-1">Roster by campaign</div>
          </div>
          <div className="flex-1" />
          <DenseStat value={accounts.length} label="Total nicks" />
          <DenseStat value={activeNicks} label="Active" color="hermes" />
          <DenseStat value={busyNow} label="Busy now" color="hermes" />
          <DenseStat value={todayTotal} label="Jobs today" />
          <DenseStat value={todayFailed} label="Failed today" color={todayFailed > 0 ? 'danger' : 'primary'} />
          <button
            onClick={() => setShowAddModal(true)}
            className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-info text-white hover:opacity-90 transition-colors"
            title="Thêm nick mới"
          >
            <Plus className="w-3.5 h-3.5" />
            Thêm nick
          </button>
        </div>

        {/* Accordion body */}
        <div className="flex-1 overflow-auto p-6">
          {/* 2026-05-05: Unassigned nicks moved to TOP per user request — these
              are the nicks the user just added or moved out of campaigns and
              needs to triage first. Keep visible above campaign sections so the
              triage flow lives at eye-level, not buried at the bottom. */}
          <UnassignedSection
            nicks={unassignedNicks}
            runningJobs={runningJobs}
            todayStatsByAcc={todayStatsByAcc}
            todayJobsByAcc={todayJobsByAcc}
            onSelect={setSelected}
            onRepair={setRepairNick}
            onTogglePause={(nick, pause) => togglePauseNick.mutate({ nick, pause })}
            onCheckHealth={(nick) => checkHealthMut.mutate(nick)}
            onGenSchedule={(nick) => genScheduleMut.mutate(nick)}
          />

          {campaigns.map((c) => (
            <CampaignSection
              key={c.id}
              campaign={c}
              accounts={accounts}
              runningJobs={runningJobs}
              todayStatsByAcc={todayStatsByAcc}
              todayJobsByAcc={todayJobsByAcc}
              campaigns={campaigns}
              onSelect={setSelected}
              onRoleChange={(campaignId, accountId, newRole) => changeRole.mutate({ campaignId, accountId, newRole })}
              onRemoveFromRole={(campaignId, accountId) => removeFromCampaign.mutate({ campaignId, accountId })}
              onRepair={setRepairNick}
              onTogglePause={(nick, pause) => togglePauseNick.mutate({ nick, pause })}
            />
          ))}

          {campaigns.length === 0 && accounts.length > 0 && (
            <div className="text-center p-8 text-app-muted font-mono-ui">
              No campaigns yet. <a href="/campaigns/new" className="text-hermes underline">Create one</a>
            </div>
          )}
        </div>
      </div>

      <NickDetailPanel nick={selected} onClose={() => setSelected(null)} onRepair={setRepairNick} />

      {repairNick && (
        <CookieRepairModal
          account={repairNick}
          onClose={() => setRepairNick(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['accounts'] })
            qc.invalidateQueries({ queryKey: ['jobs', 'live'] })
          }}
        />
      )}
      {showAddModal && (
        <AddAccountModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            qc.invalidateQueries({ queryKey: ['accounts'] })
            toast.success('Nick mới đã được thêm')
          }}
        />
      )}
    </>
  )
}
