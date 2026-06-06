/**
 * /dashboard — Command Center (redesigned).
 *
 * 1-glance daily operations dashboard. Pulls from existing endpoints only
 * (no new backend) and layers them into 5 panels:
 *
 *   [ Top row ]      Done/target today · Active nicks · Running jobs · Checkpoint alerts
 *   [ Campaigns  ]   horizontal cards with KPI progress bars
 *   [ Nicks      ]   per-nick: status, role, today done, rest timer, checkpoint risk
 *   [ Hermes     ]   decisions today + pending approvals
 *   [ Activity   ]   last 20 meaningful events (comment/like/join/friend_request)
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import DenseStat from '../../components/hermes/DenseStat'
import AgentStatusDot from '../../components/hermes/AgentStatusDot'

const asArray = (d) => Array.isArray(d) ? d
  : Array.isArray(d?.items) ? d.items
  : Array.isArray(d?.data) ? d.data
  : Array.isArray(d?.rows) ? d.rows
  : []

const ACTION_ICON = {
  like: '❤', react: '❤', comment: '💬', opportunity_comment: '📣',
  join_group: '＋', friend_request: '🤝', post: '📝', visit_group: '👀',
  ai_evaluate_posts: '🧠', check_group_membership: '🔍',
  membership_approved: '✅', membership_rejected: '🚫',
}
const ACTION_LABEL = {
  like: 'like', react: 'react', comment: 'comment', opportunity_comment: 'comment-ad',
  join_group: 'join', friend_request: 'kết bạn', post: 'post', visit_group: 'vào nhóm',
  ai_evaluate_posts: 'đánh giá', check_group_membership: 'check pending',
  membership_approved: 'được duyệt', membership_rejected: 'bị từ chối',
}

function fmtAgo(ts) {
  if (!ts) return '—'
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function ProgressBar({ done, target, height = 4 }) {
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0
  const ok = pct >= 80
  return (
    <div className="w-full" style={{ background: 'var(--bg-base)', height }}>
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: ok ? 'var(--hermes)' : pct >= 40 ? 'var(--warn)' : 'var(--text-dim)',
          transition: 'width 0.3s',
        }}
      />
    </div>
  )
}

function Panel({ title, count, action, children }) {
  return (
    <div className="flex flex-col min-h-0" style={{ border: '1px solid var(--border)' }}>
      <div
        className="px-3 py-2 flex items-center justify-between font-mono-ui text-[10px] uppercase tracking-wider"
        style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-app-muted">
          {title}{typeof count === 'number' && <span className="text-app-primary ml-2">{count}</span>}
        </span>
        {action}
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

export default function CommandCenter() {
  const nav = useNavigate()

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => asArray((await api.get('/accounts')).data),
    refetchInterval: 30000,
  })

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => asArray((await api.get('/campaigns')).data),
    refetchInterval: 30000,
  })

  const { data: jobs = [] } = useQuery({
    queryKey: ['jobs', 'recent-100'],
    queryFn: async () => asArray((await api.get('/jobs?limit=100')).data),
    refetchInterval: 5000,
  })

  const { data: jobStats } = useQuery({
    queryKey: ['jobs', 'stats'],
    queryFn: async () => (await api.get('/jobs/stats')).data,
    refetchInterval: 15000,
  })

  const { data: decisions = [] } = useQuery({
    queryKey: ['hermes-decisions'],
    queryFn: async () => asArray((await api.get('/ai-hermes/decisions?limit=20')).data),
    refetchInterval: 15000,
  })

  const { data: health } = useQuery({
    queryKey: ['hermes-health'],
    queryFn: async () => (await api.get('/ai-hermes/health-summary')).data,
    refetchInterval: 15000,
  })

  const { data: systemHealth } = useQuery({
    queryKey: ['system-health'],
    queryFn: async () => (await api.get('/health')).data,
    refetchInterval: 15000,
  })

  // Per-campaign KPI today — /campaigns list now includes today_done/target.
  const runningCampaigns = campaigns.filter(c => c.status === 'running' || c.status === 'active')
  const pausedCampaigns = campaigns.filter(c => c.status === 'paused')

  const totalDoneToday = runningCampaigns.reduce((s, c) => s + (c.today_done || 0), 0)
  const totalTargetToday = runningCampaigns.reduce((s, c) => s + (c.today_target || 0), 0)

  const activeNicks = accounts.filter(a => a.is_active)
  const checkpointNicks = accounts.filter(a => ['checkpoint', 'expired', 'session_expired'].includes(a.status))

  const runningJobs = jobs.filter(j => ['claimed', 'running'].includes(j.status))
  const pendingJobs = jobs.filter(j => j.status === 'pending')
  const failedTodayJobs = jobs.filter(j => {
    if (j.status !== 'failed') return false
    if (!j.finished_at) return false
    return new Date(j.finished_at) > new Date(Date.now() - 24 * 3600 * 1000)
  })

  // Per-nick today activity roll-up from recent jobs — cheap heuristic
  const todayByNick = useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const m = new Map()
    for (const j of jobs) {
      if (!j.finished_at && !j.started_at) continue
      const ts = new Date(j.finished_at || j.started_at)
      if (ts < todayStart) continue
      const accId = j.payload?.account_id
      if (!accId) continue
      const row = m.get(accId) || { done: 0, failed: 0, lastAt: null }
      if (j.status === 'done') row.done++
      if (j.status === 'failed') row.failed++
      const refTs = ts.getTime()
      if (!row.lastAt || refTs > row.lastAt) row.lastAt = refTs
      m.set(accId, row)
    }
    return m
  }, [jobs])

  // Pending decisions waiting for user approval
  const pendingDecisions = decisions.filter(d => d.outcome === 'pending')

  // Recent meaningful activity — pull from jobs.result where present
  // Cheap approach: show recent 'done' jobs with their types
  const recentActivity = useMemo(() => {
    return jobs
      .filter(j => j.status === 'done' && (j.finished_at || j.started_at))
      .slice(0, 20)
      .map(j => ({
        id: j.id,
        ts: j.finished_at || j.started_at,
        type: j.type,
        accountId: j.payload?.account_id,
        campaignId: j.payload?.campaign_id,
      }))
  }, [jobs])

  const accountById = useMemo(() => {
    const m = {}
    for (const a of accounts) m[a.id] = a
    return m
  }, [accounts])

  const campaignById = useMemo(() => {
    const m = {}
    for (const c of campaigns) m[c.id] = c
    return m
  }, [campaigns])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Mock warning banner */}
      {systemHealth?.mocks?.enabled && (
        <div
          className="px-6 py-2 font-mono-ui text-xs text-center font-bold"
          style={{
            background: '#ef4444',
            color: '#ffffff',
            borderBottom: '1px solid #dc2626',
          }}
        >
          🚨 WARNING: Mocks are active on this system. Campaign interactions may be simulated! Disable ALLOW_MOCKS in production.
        </div>
      )}

      {/* Top stat row */}
      <div
        className="flex items-center gap-8 px-6 py-4"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div>
          <div className="font-mono-ui text-[10px] uppercase text-app-muted">Command Center</div>
          <div className="text-app-primary text-lg mt-1">Hôm nay</div>
        </div>
        <div className="flex-1" />
        <DenseStat
          value={`${totalDoneToday}${totalTargetToday > 0 ? `/${totalTargetToday}` : ''}`}
          label="Done / Target"
          color={totalDoneToday >= totalTargetToday && totalTargetToday > 0 ? 'hermes' : 'primary'}
        />
        <DenseStat value={activeNicks.length} label="Nicks live" color="hermes" />
        <DenseStat value={runningJobs.length} label="Running" color="hermes" />
        <DenseStat value={pendingJobs.length} label="Queued" />
        <DenseStat value={runningCampaigns.length} label="Campaigns" />
        <DenseStat
          value={checkpointNicks.length}
          label="Checkpoint"
          color={checkpointNicks.length > 0 ? 'danger' : 'primary'}
        />
        <DenseStat
          value={pendingDecisions.length}
          label="Chờ duyệt"
          color={pendingDecisions.length > 0 ? 'warn' : 'primary'}
        />
        <DenseStat
          value={failedTodayJobs.length}
          label="Failed"
          color={failedTodayJobs.length > 0 ? 'danger' : 'primary'}
        />
      </div>

      {/* Hermes health banner — shown only when unhealthy so it reads as an
          alert, not as chrome. Surfaces the exact billing / quota error text
          so user knows what to fix instead of guessing. */}
      {health && !health.hermes_online && (
        <div
          className="px-6 py-2 font-mono-ui text-xs"
          style={{
            background: 'color-mix(in srgb, var(--danger) 15%, var(--bg-base))',
            borderBottom: '1px solid var(--border)',
            color: 'var(--danger)',
          }}
        >
          ⚠ HERMES OFFLINE — LLM backend không phản hồi.{' '}
          {health.recent_error_samples?.[0]?.error && (
            <span className="text-app-primary ml-2">
              "{health.recent_error_samples[0].error.substring(0, 120)}"
            </span>
          )}
        </div>
      )}
      {health?.hermes_online && health?.llm_billing_blocked && (
        <div
          className="px-6 py-2 font-mono-ui text-xs flex items-center gap-3"
          style={{
            background: 'color-mix(in srgb, var(--warn) 15%, var(--bg-base))',
            borderBottom: '1px solid var(--border)',
            color: 'var(--warn)',
          }}
        >
          <span>⚠ LLM PROVIDER BỊ CHẶN BILLING — Hermes live nhưng LLM upstream trả lỗi thanh toán/quota.</span>
          {health.fallback_chain && (
            <span className="text-app-muted">
              fallback: {health.fallback_chain.filter(p => health.configured_providers?.includes(p)).join(' → ') || '(không có provider thay thế)'}
            </span>
          )}
          <button
            onClick={() => nav('/hermes/settings')}
            className="ml-auto text-app-primary underline"
          >
            Cấu hình provider →
          </button>
        </div>
      )}

      {/* Campaign strip */}
      <div
        className="flex items-stretch gap-2 px-4 py-3 overflow-x-auto"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        {runningCampaigns.length === 0 && pausedCampaigns.length === 0 && (
          <div className="text-app-muted text-xs font-mono-ui px-2 py-2">Chưa có campaign nào.</div>
        )}
        {[...runningCampaigns, ...pausedCampaigns].slice(0, 8).map((c) => {
          const pct = c.today_target > 0 ? Math.round((c.today_done / c.today_target) * 100) : 0
          const running = c.status === 'running' || c.status === 'active'
          return (
            <button
              key={c.id}
              onClick={() => nav(`/campaigns/${c.id}`)}
              className="flex flex-col items-start p-3 min-w-[220px] text-left hover:opacity-90"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center justify-between w-full mb-1">
                <span className="font-mono-ui text-[10px] uppercase text-app-muted truncate">
                  {running ? '● running' : '○ paused'}
                </span>
                {c.hermes_central && (
                  <span className="font-mono-ui text-[9px] text-hermes">🧠 HERMES</span>
                )}
              </div>
              <div className="text-app-primary text-sm truncate w-full">{c.name}</div>
              <div className="font-mono-ui text-[11px] text-app-muted mt-1">
                {c.today_done || 0}/{c.today_target || 0} hôm nay · {pct}%
              </div>
              <div className="w-full mt-2">
                <ProgressBar done={c.today_done || 0} target={c.today_target || 0} height={3} />
              </div>
              <div className="font-mono-ui text-[10px] text-app-dim mt-2">
                {c.nicks_count || 0} nicks · {c.roles_count || 0} roles
              </div>
            </button>
          )
        })}
      </div>

      {/* 3-column panels */}
      <div className="flex-1 grid grid-cols-3 gap-2 p-2 min-h-0">
        {/* Nicks */}
        <Panel
          title="Nicks"
          count={activeNicks.length}
          action={
            <button
              onClick={() => nav('/agents')}
              className="text-[10px] text-hermes hover:underline"
            >
              xem tất cả →
            </button>
          }
        >
          {activeNicks.length === 0 ? (
            <div className="p-4 text-app-muted text-xs font-mono-ui">Chưa có nick active.</div>
          ) : activeNicks.map((acc) => {
            const t = todayByNick.get(acc.id) || { done: 0, failed: 0, lastAt: null }
            const running = runningJobs.find(j => j.payload?.account_id === acc.id)
            const risk = acc.checkpoint_risk || {}
            const recentCheckpoints = risk.recent_checkpoints_7d || 0
            return (
              <button
                key={acc.id}
                onClick={() => nav(`/agents?nick=${acc.id}`)}
                className="w-full flex items-center gap-2 px-3 py-2 font-mono-ui text-xs hover-row text-left"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <AgentStatusDot
                  status={running ? 'busy' : acc.status === 'healthy' ? 'online' : 'error'}
                  pulse={!!running}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-app-primary truncate">{acc.username || acc.id.slice(0, 8)}</div>
                  <div className="text-[10px] text-app-dim truncate">
                    {running
                      ? `▶ ${running.type}`
                      : t.lastAt
                      ? `${fmtAgo(t.lastAt)} trước`
                      : acc.status === 'healthy'
                      ? 'idle'
                      : acc.status || 'unknown'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-app-primary">{t.done}</div>
                  <div className="text-[10px] text-app-dim">hôm nay</div>
                </div>
                {recentCheckpoints >= 2 && (
                  <span className="text-danger text-[10px]" title="2+ checkpoint trong 7 ngày">⚠</span>
                )}
                {t.failed > 0 && (
                  <span className="text-warn text-[10px]" title={`${t.failed} failed today`}>{t.failed}✗</span>
                )}
              </button>
            )
          })}
        </Panel>

        {/* Hermes decisions */}
        <Panel
          title="Hermes decisions"
          count={decisions.length}
          action={
            <button
              onClick={() => nav('/hermes')}
              className="text-[10px] text-hermes hover:underline"
            >
              xem tất cả →
            </button>
          }
        >
          {decisions.length === 0 ? (
            <div className="p-4 text-app-muted text-xs font-mono-ui">Chưa có decision nào.</div>
          ) : decisions.slice(0, 25).map((d) => {
            const outcomeColor = d.outcome === 'success' ? 'text-hermes'
              : d.outcome === 'failed' ? 'text-danger'
              : d.outcome === 'pending' ? 'text-warn'
              : 'text-app-muted'
            const camp = campaignById[d.campaign_id]
            // Tag source: autopilot (script-based) vs hermes (LLM) vs
            // kpi_shortfall/capability_bump (watcher). Lets the user see
            // at a glance which decisions cost LLM calls and which are free.
            const sourceTag = d.decision_type === 'autopilot' ? { label: 'SCRIPT', color: 'text-app-muted' }
              : d.decision_type === 'kpi_shortfall' ? { label: 'KPI', color: 'text-warn' }
              : d.decision_type === 'capability_bump' ? { label: 'KPI+', color: 'text-hermes' }
              : { label: 'AI', color: 'text-info' }
            return (
              <button
                key={d.id}
                onClick={() => d.campaign_id && nav(`/campaigns/${d.campaign_id}?tab=hermes`)}
                className="w-full flex items-start gap-2 px-3 py-2 font-mono-ui text-xs hover-row text-left"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="text-app-dim text-[10px] w-14 shrink-0">
                  {fmtAgo(d.created_at)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`${outcomeColor} text-[10px]`}>
                      {d.outcome === 'success' ? '✓' : d.outcome === 'failed' ? '✗' : d.outcome === 'pending' ? '⏳' : '·'}
                    </span>
                    <span className={`${sourceTag.color} text-[9px] font-bold tracking-wider`}>
                      {sourceTag.label}
                    </span>
                    <span className="text-app-primary truncate">
                      {d.action_type || d.decision_type || 'decision'}
                    </span>
                  </div>
                  <div className="text-[10px] text-app-dim truncate">
                    {camp ? camp.name : (d.campaign_id ? d.campaign_id.slice(0, 8) : '—')}
                    {d.outcome_detail && ` · ${d.outcome_detail.substring(0, 60)}`}
                  </div>
                </div>
              </button>
            )
          })}
        </Panel>

        {/* Recent activity */}
        <Panel
          title="Hoạt động gần"
          count={recentActivity.length}
          action={
            <button
              onClick={() => nav('/campaigns')}
              className="text-[10px] text-hermes hover:underline"
            >
              theo campaign →
            </button>
          }
        >
          {recentActivity.length === 0 ? (
            <div className="p-4 text-app-muted text-xs font-mono-ui">Chưa có hoạt động nào.</div>
          ) : recentActivity.map((row) => {
            const acc = accountById[row.accountId]
            const camp = campaignById[row.campaignId]
            const icon = ACTION_ICON[row.type] || ACTION_ICON[row.type?.replace(/^campaign_/, '')] || '·'
            return (
              <div
                key={row.id}
                className="flex items-start gap-2 px-3 py-2 font-mono-ui text-xs"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="text-app-dim text-[10px] w-14 shrink-0">
                  {fmtAgo(row.ts)}
                </span>
                <span className="text-app-primary text-sm w-5 shrink-0 text-center">{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-app-primary truncate">
                    {acc?.username || row.accountId?.slice(0, 8) || '—'}
                    <span className="text-app-muted"> · {row.type}</span>
                  </div>
                  {camp && (
                    <div className="text-[10px] text-app-dim truncate">{camp.name}</div>
                  )}
                </div>
              </div>
            )
          })}
        </Panel>
      </div>
    </div>
  )
}
