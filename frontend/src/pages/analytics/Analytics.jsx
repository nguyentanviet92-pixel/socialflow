import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { BarChart3, Users, Send, TrendingUp, Activity, Clock, CheckCircle, AlertCircle } from 'lucide-react'
import api from '../../lib/api'
import TrendCenter from '../trends/TrendCenter'
import DataCenter from '../data-center/DataCenter'

const tabs = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'accounts', label: 'Accounts', icon: Users },
  { key: 'history', label: 'History', icon: Clock },
  { key: 'activity', label: 'Activity', icon: Activity }
]

function StatCard({ title, value, icon: Icon, trend, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-50 text-info',
    green: 'bg-green-50 text-hermes',
    purple: 'bg-purple-50 text-purple-600',
    orange: 'bg-orange-50 text-orange-600'
  }
  return (
    <div className="bg-app-surface rounded shadow p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-app-muted">{title}</p>
          <p className="text-2xl font-bold text-app-primary mt-1">{value}</p>
          {trend !== undefined && (
            <p className={`text-xs mt-1 ${trend >= 0 ? 'text-hermes' : 'text-red-600'}`}>
              {trend >= 0 ? '+' : ''}{trend}% from last week
            </p>
          )}
        </div>
        <div className={`w-12 h-12 rounded flex items-center justify-center ${colors[color]}`}>
          <Icon size={24} />
        </div>
      </div>
    </div>
  )
}

function OverviewTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-dashboard'],
    queryFn: () => api.get('/analytics/dashboard').then(r => r.data)
  })

  if (isLoading) return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>

  const stats = data || {}

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Posts" value={stats.total_posts?.toLocaleString() || '0'} icon={Send} trend={stats.posts_trend} color="blue" />
        <StatCard title="Active Accounts" value={stats.active_accounts?.toLocaleString() || '0'} icon={Users} trend={stats.accounts_trend} color="green" />
        <StatCard title="Success Rate" value={`${stats.success_rate || 0}%`} icon={CheckCircle} trend={stats.rate_trend} color="purple" />
        <StatCard title="Total Reach" value={stats.total_reach?.toLocaleString() || '0'} icon={TrendingUp} trend={stats.reach_trend} color="orange" />
      </div>

      {/* Chart placeholder */}
      <div className="bg-app-surface rounded shadow p-6">
        <h3 className="font-semibold text-app-primary mb-4">Publishing Activity</h3>
        <div className="h-64 flex items-end gap-2 px-4">
          {(stats.daily_stats || Array.from({ length: 14 }, (_, i) => ({ date: `Day ${i + 1}`, count: Math.floor(Math.random() * 30) }))).map((day, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full bg-info rounded-t-sm min-h-[4px] transition-all hover:bg-info"
                style={{ height: `${Math.max((day.count / (stats.max_daily || 30)) * 200, 4)}px` }}
                title={`${day.date}: ${day.count} posts`}
              />
              <span className="text-[9px] text-app-dim -rotate-45 origin-top-left whitespace-nowrap">
                {typeof day.date === 'string' ? day.date.slice(-5) : day.date}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-app-surface rounded shadow p-4">
          <h4 className="text-sm font-medium text-app-muted mb-3">Jobs by Status</h4>
          <div className="space-y-2">
            {[
              { label: 'Completed', count: stats.jobs_done || 0, cls: 'bg-hermes' },
              { label: 'Pending', count: stats.jobs_pending || 0, cls: 'bg-yellow-500' },
              { label: 'Failed', count: stats.jobs_failed || 0, cls: 'bg-red-500' }
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${item.cls}`} />
                  <span className="text-sm text-app-muted">{item.label}</span>
                </div>
                <span className="text-sm font-medium">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-app-surface rounded shadow p-4">
          <h4 className="text-sm font-medium text-app-muted mb-3">Top Target Types</h4>
          <div className="space-y-2">
            {(stats.target_types || []).map(item => (
              <div key={item.type} className="flex items-center justify-between">
                <span className="text-sm text-app-muted capitalize">{item.type}</span>
                <span className="text-sm font-medium">{item.count}</span>
              </div>
            ))}
            {(!stats.target_types || stats.target_types.length === 0) && <p className="text-sm text-app-dim">No data</p>}
          </div>
        </div>
        <div className="bg-app-surface rounded shadow p-4">
          <h4 className="text-sm font-medium text-app-muted mb-3">Media Usage</h4>
          <div className="space-y-2">
            {(stats.media_usage || []).map(item => (
              <div key={item.type} className="flex items-center justify-between">
                <span className="text-sm text-app-muted capitalize">{item.type}</span>
                <span className="text-sm font-medium">{item.count}</span>
              </div>
            ))}
            {(!stats.media_usage || stats.media_usage.length === 0) && <p className="text-sm text-app-dim">No data</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

function AccountsTab() {
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['analytics-accounts'],
    queryFn: () => api.get('/analytics/accounts').then(r => r.data)
  })

  if (isLoading) return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>

  return (
    <div className="bg-app-surface rounded shadow overflow-hidden">
      <table className="w-full">
        <thead className="bg-app-base">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Account</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Status</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Total Posts</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Success</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Failed</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Success Rate</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Last Active</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {accounts.map(acc => (
            <tr key={acc.id} className="hover:bg-app-base">
              <td className="px-4 py-3 font-medium">{acc.username || acc.name}</td>
              <td className="px-4 py-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${acc.status === 'active' ? 'bg-green-100 text-hermes' : 'bg-app-elevated text-app-muted'}`}>
                  {acc.status || 'unknown'}
                </span>
              </td>
              <td className="px-4 py-3 text-sm">{acc.total_posts?.toLocaleString() || 0}</td>
              <td className="px-4 py-3 text-sm text-hermes">{acc.success_count?.toLocaleString() || 0}</td>
              <td className="px-4 py-3 text-sm text-red-600">{acc.failed_count?.toLocaleString() || 0}</td>
              <td className="px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-16 bg-app-elevated rounded-full h-2">
                    <div className="bg-hermes h-2 rounded-full" style={{ width: `${acc.success_rate || 0}%` }} />
                  </div>
                  <span className="text-xs text-app-muted">{acc.success_rate || 0}%</span>
                </div>
              </td>
              <td className="px-4 py-3 text-sm text-app-muted">{acc.last_active ? new Date(acc.last_active).toLocaleString() : '—'}</td>
            </tr>
          ))}
          {accounts.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-app-dim">No account data</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function HistoryTab() {
  const [filter, setFilter] = useState({ status: '', date_from: '', date_to: '' })

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['analytics-history', filter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (filter.status) params.set('status', filter.status)
      if (filter.date_from) params.set('date_from', filter.date_from)
      if (filter.date_to) params.set('date_to', filter.date_to)
      return api.get(`/analytics/history?${params.toString()}`).then(r => r.data)
    }
  })

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })} className="border rounded-lg px-3 py-2 text-sm bg-app-surface text-app-primary border-app-border">
          <option value="">All statuses</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input type="date" value={filter.date_from} onChange={e => setFilter({ ...filter, date_from: e.target.value })} className="border rounded-lg px-3 py-2 text-sm bg-app-surface text-app-primary border-app-border" />
        <input type="date" value={filter.date_to} onChange={e => setFilter({ ...filter, date_to: e.target.value })} className="border rounded-lg px-3 py-2 text-sm bg-app-surface text-app-primary border-app-border" />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>
      ) : (
        <div className="bg-app-surface rounded shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-app-base">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Date</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Type</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Target</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Account</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Caption</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-app-muted">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.map(item => (
                <tr key={item.id} className="hover:bg-app-base">
                  <td className="px-4 py-3 text-sm text-app-muted">{new Date(item.completed_at || item.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3"><span className="text-xs bg-app-elevated text-app-muted px-2 py-0.5 rounded-full capitalize">{item.job_type || '—'}</span></td>
                  <td className="px-4 py-3 text-sm">{item.target_name || '—'}</td>
                  <td className="px-4 py-3 text-sm">{item.account?.username || '—'}</td>
                  <td className="px-4 py-3 text-sm text-app-muted max-w-xs truncate">{item.caption || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                      item.status === 'done' ? 'bg-green-100 text-hermes' : item.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-app-elevated text-app-muted'
                    }`}>
                      {item.status === 'done' ? <CheckCircle size={10} /> : item.status === 'failed' ? <AlertCircle size={10} /> : null}
                      {item.status}
                    </span>
                  </td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-app-dim">No history</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ActivityTab() {
  const { data: activities = [], isLoading } = useQuery({
    queryKey: ['analytics-activity'],
    queryFn: () => api.get('/analytics/activity').then(r => r.data)
  })

  if (isLoading) return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>

  return (
    <div className="bg-app-surface rounded shadow overflow-hidden">
      <div className="divide-y">
        {activities.map((item, idx) => (
          <div key={item.id || idx} className="flex items-start gap-4 p-4 hover:bg-app-base">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
              item.type === 'success' ? 'bg-green-100 text-hermes' :
              item.type === 'error' ? 'bg-red-100 text-red-600' :
              item.type === 'warning' ? 'bg-yellow-100 text-yellow-600' :
              'bg-blue-100 text-info'
            }`}>
              <Activity size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-app-primary">{item.message || item.description}</p>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-app-dim">{item.created_at ? new Date(item.created_at).toLocaleString() : ''}</span>
                {item.user && <span className="text-xs text-app-dim">{item.user}</span>}
              </div>
            </div>
          </div>
        ))}
        {activities.length === 0 && <div className="p-8 text-center text-app-dim">No activity logged</div>}
      </div>
    </div>
  )
}

export default function Analytics() {
  const nav = useNavigate()
  const { pathname } = useLocation()

  // Determine top-level active hub tab
  const getActiveHubTab = () => {
    if (pathname === '/trends') return 'trends'
    if (pathname === '/data-center') return 'data-center'
    return 'analytics'
  }
  const activeHubTab = getActiveHubTab()

  const [activeSubTab, setActiveSubTab] = useState('overview')

  return (
    <div className="flex flex-col h-full">
      {/* Consolidated Top Tabs Bar */}
      <div
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <button
          onClick={() => nav('/analytics')}
          className={`px-4 py-3 ${activeHubTab === 'analytics' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'analytics' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          📊 Thống kê
        </button>
        <button
          onClick={() => nav('/trends')}
          className={`px-4 py-3 ${activeHubTab === 'trends' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'trends' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🔥 Bắt xu hướng
        </button>
        <button
          onClick={() => nav('/data-center')}
          className={`px-4 py-3 ${activeHubTab === 'data-center' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeHubTab === 'data-center' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🗄️ Kho dữ liệu
        </button>
      </div>

      {/* Render Consolidated Views */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeHubTab === 'trends' && (
          <div className="p-6">
            <TrendCenter />
          </div>
        )}
        {activeHubTab === 'data-center' && (
          <div className="p-6">
            <DataCenter />
          </div>
        )}
        {activeHubTab === 'analytics' && (
          <div className="p-6">
            <div className="flex justify-between items-center mb-6">
              <h1 className="text-2xl font-bold text-app-primary">Analytics</h1>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-6 bg-app-elevated rounded-lg p-1 w-fit">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveSubTab(tab.key)}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeSubTab === tab.key ? 'bg-app-surface shadow text-app-primary' : 'text-app-muted hover:text-app-primary'
                  }`}
                >
                  <tab.icon size={14} />
                  {tab.label}
                </button>
              ))}
            </div>

            {activeSubTab === 'overview' && <OverviewTab />}
            {activeSubTab === 'accounts' && <AccountsTab />}
            {activeSubTab === 'history' && <HistoryTab />}
            {activeSubTab === 'activity' && <ActivityTab />}
          </div>
        )}
      </div>
    </div>
  )
}

