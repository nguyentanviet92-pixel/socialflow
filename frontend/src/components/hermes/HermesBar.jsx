/**
 * HermesBar — always-on top bar showing Hermes status + live stats.
 * Polls /ai-hermes/status every 10s.
 */
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import useAuthStore from '../../store/auth.store'

function StatDot({ status }) {
  if (status === 'ONLINE') {
    return <span className="inline-block w-1.5 h-1.5 rounded-full bg-hermes hermes-pulse" />
  }
  if (status === 'DEGRADED') {
    return <span className="inline-block w-1.5 h-1.5 rounded-full bg-warn" />
  }
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 danger-pulse" />
}

export default function HermesBar() {
  const { user } = useAuthStore()
  const { data, error } = useQuery({
    queryKey: ['hermes', 'status'],
    queryFn: async () => {
      try {
        const res = await api.get('/ai-hermes/status')
        return res.data
      } catch (err) {
        const status = err?.response?.status
        // 401/403: user session expired — not an API outage, return degraded placeholder
        if (status === 401 || status === 403) {
          return { status: 'DEGRADED', _authError: true }
        }
        // 503/502/network: API unreachable
        if (status === 503 || status === 502 || !status) {
          return null // treat as offline gracefully
        }
        throw err
      }
    },
    refetchInterval: (query) => {
      // Back off to 30s when offline to reduce VPS + console spam
      return query.state.data || !query.state.error ? 10000 : 30000
    },
    staleTime: 8000,
    retry: 0,
  })

  const status = error || !data ? 'OFFLINE' : (data.status || 'DEGRADED')
  const online = status === 'ONLINE'
  const authError = data?._authError

  return (
    <div
      className="flex items-center gap-6 px-4 font-mono-ui text-[11px] uppercase tracking-wider"
      style={{
        height: 36,
        background: '#000',
        borderBottom: '1px solid var(--border-bright)',
        color: 'var(--text-muted)',
      }}
    >
      <div className="flex items-center gap-2">
        <StatDot status={status} />
        <span className={online ? 'text-hermes' : status === 'DEGRADED' ? 'text-warn' : 'text-danger'}>HERMES</span>
        {!online && <span className={status === 'DEGRADED' ? 'text-warn' : 'text-danger'}>· {status}</span>}
      </div>

      {online && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-app-muted">model</span>
            <span className="text-app-primary">{data.model || '—'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-app-muted">agents</span>
            <span className="text-app-primary">{data.active_agents ?? 0}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-app-muted">avg</span>
            <span className={data.avg_score >= 4 ? 'text-hermes' : data.avg_score >= 3 ? 'text-warn' : 'text-app-primary'}>
              {(data.avg_score || 0).toFixed(1)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-app-muted">calls/hr</span>
            <span className="text-app-primary">{data.calls_last_hour ?? 0}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-app-muted">skills</span>
            <span className="text-app-primary">{data.task_types_active ?? 0}</span>
          </div>
        </>
      )}

      {!online && authError && (
        <span className="text-warn">SESSION EXPIRED — please refresh page</span>
      )}

      {!online && !authError && (
        <span className="text-danger">FALLBACK MODE — check Hermes API on VPS</span>
      )}

      <div className="flex-1" />

      {/* User Info */}
      {user && (
        <div className="flex items-center gap-2 text-app-dim border-r border-border-bright pr-4 mr-2" style={{ borderRight: '1px solid var(--border-bright)' }}>
          <span className="text-[10px] text-app-muted">user:</span>
          <span className="text-app-primary font-semibold lowercase">
            {user.username || user.email || 'unknown'}
          </span>
          {user.role && (
            <span className="bg-app-elevated text-app-dim px-1.5 py-0.5 rounded text-[9px] font-bold border border-border-bright font-mono uppercase">
              {user.role}
            </span>
          )}
        </div>
      )}

      <span className="text-app-dim">{new Date().toTimeString().slice(0, 8)}</span>
    </div>
  )
}
