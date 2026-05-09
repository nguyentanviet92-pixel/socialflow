/**
 * HermesBar — always-on top bar showing Hermes status + live stats.
 * Polls /ai-hermes/status every 10s.
 */
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'

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
  const { data, error } = useQuery({
    queryKey: ['hermes', 'status'],
    queryFn: async () => {
      try {
        const res = await api.get('/ai-hermes/status')
        return res.data
      } catch (err) {
        // Suppress 503/network errors from flooding console
        const status = err?.response?.status
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
        <span className={online ? 'text-hermes' : 'text-danger'}>HERMES</span>
        {!online && <span className="text-danger">· {status}</span>}
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

      {!online && (
        <span className="text-danger">FALLBACK MODE — check Hermes API on VPS</span>
      )}

      <div className="flex-1" />

      <span className="text-app-dim">{new Date().toTimeString().slice(0, 8)}</span>
    </div>
  )
}
