import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Shield, AlertTriangle, Clock, Wifi, ChevronDown, ChevronUp, Radio } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { vi } from 'date-fns/locale'
import api from '../../lib/api'

const STATUS_CONFIG = {
  healthy:         { label: 'Khỏe', color: 'bg-green-100 text-hermes' },
  checkpoint:      { label: 'Checkpoint', color: 'bg-red-100 text-red-700' },
  expired:         { label: 'Hết hạn', color: 'bg-orange-100 text-orange-700' },
  session_expired: { label: 'Hết hạn', color: 'bg-orange-100 text-orange-700' },
  disabled:        { label: 'Tắt', color: 'bg-app-elevated text-app-muted' },
  at_risk:         { label: 'Nguy cơ', color: 'bg-red-100 text-red-700' },
  unknown:         { label: 'Chưa kiểm', color: 'bg-app-elevated text-app-dim' },
}

const RISK_CONFIG = {
  normal:   { label: 'Bình thường', color: 'bg-green-100 text-hermes', dot: 'bg-hermes' },
  watch:    { label: 'Theo dõi', color: 'bg-blue-100 text-info', dot: 'bg-info' },
  warning:  { label: 'Cảnh báo', color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
  critical: { label: 'Nghiêm trọng', color: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
}

const SIGNAL_LABELS = {
  slow_load: 'Tải chậm',
  hidden_action: 'Action ẩn',
  instant_decline: 'Từ chối ngay',
  pending_loop: 'Chờ duyệt vòng lặp',
  captcha_hint: 'Captcha',
  redirect_warn: 'Redirect đáng ngờ',
}

const SIGNAL_COLORS = {
  slow_load: 'bg-yellow-100 text-yellow-700',
  hidden_action: 'bg-orange-100 text-orange-700',
  instant_decline: 'bg-red-100 text-red-700',
  pending_loop: 'bg-orange-100 text-orange-700',
  captcha_hint: 'bg-red-100 text-red-700',
  redirect_warn: 'bg-red-100 text-red-700',
}

function BudgetBar({ label, used, max }) {
  if (!max) return null
  const pct = Math.min((used / max) * 100, 100)
  const color = pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-yellow-500' : 'bg-hermes'
  return (
    <div className="flex items-center gap-2" title={`${label}: ${used}/${max}`}>
      <span className="text-[10px] text-app-dim w-8">{label}</span>
      <div className="flex-1 h-1.5 bg-app-elevated rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-app-muted w-10 text-right">{used}/{max}</span>
    </div>
  )
}

export default function AccountHealth() {
  const [expandedAccount, setExpandedAccount] = useState(null)

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['account-health'],
    queryFn: () => api.get('/accounts/health-summary').then(r => r.data),
    refetchInterval: 30000,
  })

  // Warning scores for all accounts
  const { data: warningScores = [] } = useQuery({
    queryKey: ['warning-scores'],
    queryFn: () => api.get('/accounts/warning-scores').then(r => r.data),
    refetchInterval: 30000,
  })
  const riskMap = Object.fromEntries(warningScores.map(w => [w.account_id, w]))

  // Health signals for expanded account
  const { data: signals = [], isLoading: signalsLoading } = useQuery({
    queryKey: ['health-signals', expandedAccount],
    queryFn: () => api.get(`/accounts/${expandedAccount}/health-signals`).then(r => r.data),
    enabled: !!expandedAccount,
  })

  if (isLoading) return <div className="text-center py-8 text-app-muted">Đang tải...</div>

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Activity size={24} className="text-info" />
        <h1 className="text-2xl font-bold text-app-primary">Sức khỏe Nick</h1>
      </div>

      {accounts.length === 0 ? (
        <div className="text-center py-12 text-app-dim">Không có nick nào</div>
      ) : (
        <div className="grid gap-4">
          {accounts.map(a => {
            const status = STATUS_CONFIG[a.status] || STATUS_CONFIG.unknown
            const budget = a.daily_budget || {}
            const risk = riskMap[a.id]
            const riskCfg = risk ? (RISK_CONFIG[risk.risk_level] || RISK_CONFIG.normal) : null
            const hasIssue = a.failure_count_24h > 0 || ['checkpoint', 'expired', 'session_expired', 'at_risk'].includes(a.status)
            const isCritical = risk?.risk_level === 'critical'
            const isExpanded = expandedAccount === a.id

            return (
              <div key={a.id} className={`bg-app-surface rounded border p-4 ${isCritical ? 'border-red-300 bg-red-50/30' : hasIssue ? 'border-red-200' : 'border-app-border'}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${status.color}`}>
                      {(a.username || '?')[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-app-primary">{a.username || a.fb_user_id}</span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${status.color}`}>
                          {status.label}
                        </span>
                        {/* Risk level badge */}
                        {riskCfg && risk.risk_level !== 'normal' && (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${riskCfg.color}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${riskCfg.dot} ${risk.risk_level === 'critical' ? 'animate-pulse' : ''}`} />
                            {riskCfg.label}
                            {risk.signals_6h > 0 && <span>({risk.signals_6h}/6h)</span>}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-app-dim mt-0.5">
                        <span>{a.nick_age_days || 0} ngày tuổi</span>
                        {a.proxy_label && (
                          <span className="flex items-center gap-0.5"><Wifi size={8} /> {a.proxy_label}</span>
                        )}
                        {a.proxy_country && <span>{a.proxy_country}</span>}
                        {risk?.signals_24h > 0 && (
                          <span className="text-yellow-500">{risk.signals_24h} cảnh báo/24h</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs">
                    {a.failure_count_24h > 0 && (
                      <div className="flex items-center gap-1 text-red-500">
                        <AlertTriangle size={12} />
                        <span>{a.failure_count_24h} lỗi/24h</span>
                      </div>
                    )}
                    {a.last_error_type && (
                      <span className="text-[10px] text-red-400">{a.last_error_type}</span>
                    )}
                    <div className="text-app-dim">
                      <span>{a.posts_today || 0}/{a.max_daily_posts || 10} bài</span>
                    </div>
                    {/* Expand signals button */}
                    {(risk?.total_signals > 0 || a.failure_count_24h > 0) && (
                      <button
                        onClick={() => setExpandedAccount(isExpanded ? null : a.id)}
                        className="p-1 text-app-dim hover:text-app-muted"
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* Budget bars */}
                {Object.keys(budget).length > 1 && (
                  <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1.5">
                    {budget.like && <BudgetBar label="Like" used={budget.like.used || 0} max={budget.like.max || 80} />}
                    {budget.comment && <BudgetBar label="Cmt" used={budget.comment.used || 0} max={budget.comment.max || 25} />}
                    {budget.friend_request && <BudgetBar label="FR" used={budget.friend_request.used || 0} max={budget.friend_request.max || 15} />}
                    {budget.join_group && <BudgetBar label="Join" used={budget.join_group.used || 0} max={budget.join_group.max || 3} />}
                    {budget.post && <BudgetBar label="Post" used={budget.post.used || 0} max={budget.post.max || 5} />}
                    {budget.scan && <BudgetBar label="Scan" used={budget.scan.used || 0} max={budget.scan.max || 10} />}
                  </div>
                )}

                {/* Expanded: Health signals list */}
                {isExpanded && (
                  <div className="mt-3 border-t border-app-border pt-3">
                    <p className="text-xs font-medium text-app-muted mb-2 flex items-center gap-1">
                      <Radio size={12} /> Tín hiệu cảnh báo gần đây
                    </p>
                    {signalsLoading ? (
                      <div className="text-xs text-app-dim py-2">Đang tải...</div>
                    ) : signals.length === 0 ? (
                      <div className="text-xs text-app-dim py-2">Không có tín hiệu cảnh báo</div>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {signals.slice(0, 20).map(s => {
                          const signalColor = SIGNAL_COLORS[s.signal_type] || 'bg-app-elevated text-app-muted'
                          return (
                            <div key={s.id} className="flex items-center gap-2 text-xs">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${signalColor}`}>
                                {SIGNAL_LABELS[s.signal_type] || s.signal_type}
                              </span>
                              <span className="text-app-muted flex-1 truncate">
                                {s.signal_detail?.url?.substring(0, 50) || s.signal_detail?.duration_ms ? `${s.signal_detail.duration_ms}ms` : JSON.stringify(s.signal_detail || {}).substring(0, 60)}
                              </span>
                              <span className="text-[10px] text-app-dim shrink-0">
                                {s.detected_at ? formatDistanceToNow(new Date(s.detected_at), { locale: vi, addSuffix: true }) : ''}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
