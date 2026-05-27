import { useState, useRef, useCallback, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Upload,
  Loader,
  X,
  Search,
  Activity,
  Eye,
  Pencil,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ScanSearch,
  Mic,
  Key,
  AlertTriangle,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import useAgentGuard from '../../hooks/useAgentGuard'
import HealthBadge from '../../components/accounts/HealthBadge'
import ProxyBadge from '../../components/shared/ProxyBadge'
import CookieRepairModal from '../../components/hermes/CookieRepairModal'
import PageList from '../pages-manager/PageList'
import WebsiteSettings from '../settings/WebsiteSettings'

export default function AccountList() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [showBulkModal, setShowBulkModal] = useState(false)
  const [search, setSearch] = useState('')
  const [editAccount, setEditAccount] = useState(null)
  const [cookieRepairAccount, setCookieRepairAccount] = useState(null)

  // Fetch All state: { accountId: { jobId, status, error } }
  const [fetchJobs, setFetchJobs] = useState({})
  const [fetchingAll, setFetchingAll] = useState(false)
  const pollRef = useRef(null)

  const queryClient = useQueryClient()
  const { requireAgent } = useAgentGuard()
  const { pathname } = useLocation()
  const nav = useNavigate()

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get('/accounts').then((r) => r.data),
    refetchInterval: 5000,
  })

  const filtered = accounts.filter(
    (a) =>
      a.username?.toLowerCase().includes(search.toLowerCase()) ||
      a.fb_user_id?.toLowerCase().includes(search.toLowerCase())
  )

  const healthCheckMutation = useMutation({
    mutationFn: (id) => api.post(`/accounts/${id}/check-health`),
    onSuccess: () => {
      toast.success('Check queued - agent is processing...')
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: (err) => {
      if (err.response?.status === 503) {
        toast.error('Agent offline! Start the SocialFlow Agent first.')
      } else {
        toast.error(err.response?.data?.error || 'Health check failed')
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/accounts/${id}`),
    onSuccess: () => {
      toast.success('Account deleted')
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
    onError: () => toast.error('Delete failed'),
  })

  const autoVoiceMutation = useMutation({
    mutationFn: (force) => api.post('/accounts/voice-profiles/auto-assign', { force: !!force }).then(r => r.data),
    onSuccess: (res) => {
      toast.success(`Đã gán ${res.assigned}/${res.total} nick — ${res.skipped} đã có sẵn`)
    },
    onError: (err) => toast.error(`Auto-assign lỗi: ${err.response?.data?.error || err.message}`),
  })

  const handleDelete = (account) => {
    if (window.confirm(`Delete account "${account.username}"?`)) {
      deleteMutation.mutate(account.id)
    }
  }

  // --- Fetch All Accounts ---
  const activeFetchCount = Object.values(fetchJobs).filter(j => ['pending', 'claimed', 'running'].includes(j.status)).length
  const doneFetchCount = Object.values(fetchJobs).filter(j => j.status === 'done').length
  const failedFetchCount = Object.values(fetchJobs).filter(j => j.status === 'failed').length
  const totalFetchCount = Object.keys(fetchJobs).length

  const pollFetchJobs = useCallback(async () => {
    setFetchJobs(prev => {
      const activeJobs = Object.entries(prev).filter(([, j]) => ['pending', 'claimed', 'running'].includes(j.status))
      if (activeJobs.length === 0) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setFetchingAll(false)
        return prev
      }
      // Poll each active job
      Promise.all(activeJobs.map(([accId, j]) =>
        api.get(`/jobs/${j.jobId}`).then(r => ({ accId, data: r.data })).catch(() => null)
      )).then(results => {
        setFetchJobs(current => {
          const next = { ...current }
          let anyDone = false
          for (const r of results) {
            if (!r) continue
            next[r.accId] = { ...next[r.accId], status: r.data.status, error: r.data.error_message }
            if (r.data.status === 'done' || r.data.status === 'failed') anyDone = true
          }
          // Check if all done
          const stillActive = Object.values(next).some(j => ['pending', 'claimed', 'running'].includes(j.status))
          if (!stillActive) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
            setFetchingAll(false)
            queryClient.invalidateQueries({ queryKey: ['accounts'] })
            queryClient.invalidateQueries({ queryKey: ['fanpages'] })
            queryClient.invalidateQueries({ queryKey: ['groups'] })
          }
          return next
        })
      })
      return prev
    })
  }, [queryClient])

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current) } }, [])

  const handleFetchAll = () => requireAgent(async () => {
    const activeAccounts = accounts.filter(a => a.is_active !== false)
    if (activeAccounts.length === 0) return toast.error('No active accounts')

    setFetchingAll(true)
    const jobs = {}

    for (const account of activeAccounts) {
      try {
        const res = await api.post(`/accounts/${account.id}/fetch-all`)
        jobs[account.id] = { jobId: res.data.job_id, status: 'pending', error: null }
      } catch (err) {
        jobs[account.id] = { jobId: null, status: 'failed', error: err.response?.data?.error || err.message }
      }
    }

    setFetchJobs(jobs)
    toast.success(`Queued fetch for ${Object.values(jobs).filter(j => j.jobId).length}/${activeAccounts.length} accounts`)

    // Start polling
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(pollFetchJobs, 3000)
  })

  const getFetchStatus = (accountId) => fetchJobs[accountId] || null

  const dismissFetchAll = () => {
    setFetchJobs({})
    setFetchingAll(false)
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  // Nicks cần update cookie ngay
  const expiredNicks = accounts.filter(a =>
    ['session_expired', 'expired', 'checkpoint'].includes(a.status)
  )

  // Tab state mapping
  const getActiveTab = () => {
    if (pathname === '/pages') return 'pages'
    if (pathname === '/settings/websites') return 'websites'
    return 'accounts'
  }
  const activeTab = getActiveTab()

  return (
    <div className="flex flex-col h-full">
      {/* Top tab navigation for Hub 3 */}
      <div
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider shrink-0 mb-6"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <button
          onClick={() => nav('/accounts')}
          className={`px-4 py-3 ${activeTab === 'accounts' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'accounts' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          👤 Tài khoản (Profiles)
        </button>
        <button
          onClick={() => nav('/pages')}
          className={`px-4 py-3 ${activeTab === 'pages' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'pages' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          📄 Trang doanh nghiệp (Fanpages)
        </button>
        <button
          onClick={() => nav('/settings/websites')}
          className={`px-4 py-3 ${activeTab === 'websites' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'websites' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🌐 Website & GA Settings
        </button>
      </div>

      {/* Render Consolidated View */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'pages' && <PageList />}
        {activeTab === 'websites' && <WebsiteSettings />}
        {activeTab === 'accounts' && (
          <div className="space-y-6 px-6 pb-6">
            {/* ⚠️ Banner cảnh báo cookie hết hạn/checkpoint */}
            {expiredNicks.length > 0 && (
              <div
                className="flex items-start gap-3 px-4 py-3 rounded"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)' }}
              >
                <AlertTriangle size={16} className="text-danger mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-danger mb-1">
                    {expiredNicks.length} nick cần cập nhật cookie
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {expiredNicks.map(a => (
                      <button
                        key={a.id}
                        onClick={() => setCookieRepairAccount(a)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded"
                        style={{
                          background: 'rgba(239,68,68,0.12)',
                          border: '1px solid rgba(239,68,68,0.4)',
                          color: 'var(--danger)',
                        }}
                      >
                        <Key size={11} />
                        {a.username || a.id.slice(0, 8)}
                        <span className="text-[10px] opacity-70">
                          {a.status === 'checkpoint' ? '· checkpoint' : '· hết hạn'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold text-app-primary">Accounts</h1>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleFetchAll}
                  disabled={fetchingAll || accounts.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 transition-colors"
                >
                  {fetchingAll ? <Loader className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
                  {fetchingAll ? 'Fetching...' : 'Fetch All'}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Tự gán phong cách viết cho các nick chưa có voice profile? (mỗi nick 1 preset cố định, không trùng nhau)')) {
                      autoVoiceMutation.mutate(false)
                    }
                  }}
                  disabled={autoVoiceMutation.isPending || accounts.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-purple-300 text-purple-700 hover:bg-purple-50 disabled:opacity-50 transition-colors"
                  title="Auto-assign voice profile (preset) cho mọi nick chưa cấu hình"
                >
                  {autoVoiceMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
                  Auto Voice
                </button>
                <button
                  onClick={() => setShowBulkModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-app-border text-app-primary hover:bg-app-base transition-colors"
                >
                  <Upload className="w-4 h-4" />
                  Bulk Import
                </button>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add Account
                </button>
              </div>
            </div>

            {/* Fetch All Progress Banner */}
            {totalFetchCount > 0 && (
              <div className={`rounded border p-4 ${
                activeFetchCount > 0 ? 'bg-blue-50 border-blue-200' :
                failedFetchCount > 0 && doneFetchCount === 0 ? 'bg-red-50 border-red-200' :
                'bg-emerald-50 border-emerald-200'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {activeFetchCount > 0 ? (
                      <Loader className="w-5 h-5 text-info animate-spin" />
                    ) : failedFetchCount > 0 && doneFetchCount === 0 ? (
                      <XCircle className="w-5 h-5 text-red-500" />
                    ) : (
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-app-primary">
                        {activeFetchCount > 0
                          ? `Fetching pages & groups... (${doneFetchCount + failedFetchCount}/${totalFetchCount} done)`
                          : `Fetch complete — ${doneFetchCount} success, ${failedFetchCount} failed`
                        }
                      </p>
                      {activeFetchCount > 0 && (
                        <div className="w-48 h-1.5 bg-blue-100 rounded-full mt-1.5 overflow-hidden">
                          <div
                            className="h-full bg-info rounded-full transition-all duration-500"
                            style={{ width: `${Math.round(((doneFetchCount + failedFetchCount) / totalFetchCount) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {activeFetchCount === 0 && (
                    <button onClick={dismissFetchAll} className="p-1 rounded-lg hover:bg-app-surface/50 text-app-muted">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-app-dim" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search accounts..."
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-app-border text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center h-64">
                <Loader className="w-6 h-6 animate-spin text-info" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-12 bg-app-surface rounded border border-app-border">
                <p className="text-app-muted text-sm">No accounts found</p>
              </div>
            ) : (
              <div className="bg-app-surface rounded border border-app-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-app-border bg-app-base">
                        <th className="text-left px-4 py-3 font-medium text-app-muted">Username</th>
                        <th className="text-left px-4 py-3 font-medium text-app-muted">FB User ID</th>
                        <th className="text-left px-4 py-3 font-medium text-app-muted">Browser</th>
                        <th className="text-left px-4 py-3 font-medium text-app-muted">Proxy</th>
                        <th className="text-left px-4 py-3 font-medium text-app-muted">Status</th>
                        <th className="text-left px-4 py-3 font-medium text-app-muted">Posts Today</th>
                        <th className="text-right px-4 py-3 font-medium text-app-muted">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map((account) => (
                        <tr key={account.id} className="hover:bg-app-base">
                          <td className="px-4 py-3 font-medium text-app-primary">
                            <div className="flex items-center gap-2">
                              {account.avatar_url ? (
                                <img src={account.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover" />
                              ) : (
                                <div className="w-7 h-7 rounded-full bg-app-hover flex items-center justify-center text-xs text-app-muted">
                                  {(account.username || '?')[0].toUpperCase()}
                                </div>
                              )}
                              {account.username}
                              {(() => {
                                const fs = getFetchStatus(account.id)
                                if (!fs) return null
                                if (['pending', 'claimed', 'running'].includes(fs.status))
                                  return <RefreshCw className="w-3.5 h-3.5 text-info animate-spin" />
                                if (fs.status === 'done')
                                  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                if (fs.status === 'failed')
                                  return <XCircle className="w-3.5 h-3.5 text-red-500" title={fs.error || 'Failed'} />
                                return null
                              })()}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-app-muted">{account.fb_user_id}</td>
                          <td className="px-4 py-3 text-app-muted">{account.browser_type || 'chromium'}</td>
                          <td className="px-4 py-3">
                            <ProxyBadge proxy={account.proxies} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <HealthBadge status={account.status} />
                              {(['checkpoint', 'session_expired', 'expired', 'dead'].includes(account.status)) && (
                                <button
                                  onClick={() => setCookieRepairAccount(account)}
                                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(239,68,68,0.1)',
                                    border: '1px solid rgba(239,68,68,0.35)',
                                    color: 'var(--danger)',
                                  }}
                                >
                                  <Key size={9} />
                                  Cập nhật cookie
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-app-muted">
                            {account.posts_today ?? 0}/{account.max_daily_posts ?? 10}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => requireAgent(() => healthCheckMutation.mutate(account.id))}
                                disabled={healthCheckMutation.isPending || account.status === 'checking'}
                                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-app-border text-app-muted hover:bg-app-base disabled:opacity-50 transition-colors"
                              >
                                {account.status === 'checking' ? (
                                  <Loader className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Activity className="w-3.5 h-3.5" />
                                )}
                                {account.status === 'checking' ? 'Checking...' : 'Check'}
                              </button>
                              <button
                                onClick={() => setEditAccount(account)}
                                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-app-border text-app-muted hover:bg-app-base transition-colors"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(account)}
                                disabled={deleteMutation.isPending}
                                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                              <Link
                                  to={`/accounts/${account.id}`}
                                  className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-app-border text-app-muted hover:bg-app-base transition-colors"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                View
                              </Link>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {editAccount && (
        <EditAccountModal
          account={editAccount}
          onClose={() => setEditAccount(null)}
          onSuccess={() => {
            setEditAccount(null)
            queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}

      {cookieRepairAccount && (
        <CookieRepairModal
          account={cookieRepairAccount}
          onClose={() => setCookieRepairAccount(null)}
          onSuccess={() => {
            setCookieRepairAccount(null)
            queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}

      {showAddModal && (
        <AddAccountModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}

      {showBulkModal && (
        <BulkImportModal
          onClose={() => setShowBulkModal(false)}
          onSuccess={() => {
            setShowBulkModal(false)
            queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}
    </div>
  )
}

/* ---- Helpers ---- */

function parseCookieInput(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr) && arr.length > 0 && arr[0].name && arr[0].value) {
        return arr.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch {}
  }
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj.name && obj.value) return `${obj.name}=${obj.value}`
    } catch {}
  }
  return trimmed
}

function parseProxyString(str) {
  if (!str.trim()) return null
  const parts = str.trim().split(':')
  if (parts.length < 2) return null
  return {
    host: parts[0],
    port: parseInt(parts[1]),
    username: parts[2] || null,
    password: parts[3] || null,
    type: 'http',
  }
}

/* ---- Proxy Input Component ---- */

function ProxyInput({ proxyId, setProxyId, newProxy, setNewProxy, proxies = [] }) {
  const [mode, setMode] = useState(proxyId ? 'select' : 'none')

  return (
    <div>
      <label className="block text-sm font-medium text-app-primary mb-1.5">Proxy</label>
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => { setMode('none'); setProxyId(''); setNewProxy('') }}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${mode === 'none' ? 'bg-app-base text-white border-gray-900' : 'border-app-border text-app-muted hover:bg-app-base'}`}
        >
          No Proxy
        </button>
        {proxies.length > 0 && (
          <button
            type="button"
            onClick={() => { setMode('select'); setNewProxy('') }}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${mode === 'select' ? 'bg-app-base text-white border-gray-900' : 'border-app-border text-app-muted hover:bg-app-base'}`}
          >
            Select Existing
          </button>
        )}
        <button
          type="button"
          onClick={() => { setMode('new'); setProxyId('') }}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${mode === 'new' ? 'bg-info text-white border-blue-600' : 'border-app-border text-app-muted hover:bg-app-base'}`}
        >
          + Add New
        </button>
      </div>

      {mode === 'select' && (
        <select
          value={proxyId}
          onChange={(e) => setProxyId(e.target.value)}
          className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">Choose proxy...</option>
          {proxies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label || `${p.host}:${p.port}`}
              {p.country ? ` (${p.country})` : ''}
            </option>
          ))}
        </select>
      )}

      {mode === 'new' && (
        <input
          type="text"
          value={newProxy}
          onChange={(e) => setNewProxy(e.target.value)}
          placeholder="host:port:username:password"
          className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
        />
      )}
    </div>
  )
}

/* ---- Add Account Modal ---- */

function AddAccountModal({ onClose, onSuccess }) {
  const [cookieString, setCookieString] = useState('')
  const [browserType, setBrowserType] = useState('chromium')
  const [proxyId, setProxyId] = useState('')
  const [newProxy, setNewProxy] = useState('')
  const [fbCreatedAt, setFbCreatedAt] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: proxies = [] } = useQuery({
    queryKey: ['proxies'],
    queryFn: () => api.get('/proxies').then((r) => r.data),
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!cookieString.trim()) return toast.error('Cookie string is required')

    const parsed = parseCookieInput(cookieString)
    if (!parsed) return toast.error('Invalid cookie format')

    setLoading(true)
    try {
      let finalProxyId = proxyId || null

      if (newProxy.trim()) {
        const proxyData = parseProxyString(newProxy)
        if (!proxyData) {
          toast.error('Invalid proxy format. Use host:port or host:port:user:pass')
          setLoading(false)
          return
        }
        const res = await api.post('/proxies', proxyData)
        finalProxyId = res.data.id
      }

      await api.post('/accounts', {
        cookie_string: parsed,
        browser_type: browserType,
        proxy_id: finalProxyId,
        fb_created_at: fbCreatedAt || null,
      })
      toast.success('Account added')
      onSuccess()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add account')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-app-surface rounded  w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-app-primary">Add Account</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-app-elevated text-app-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Cookie String</label>
            <textarea
              value={cookieString}
              onChange={(e) => setCookieString(e.target.value)}
              rows={5}
              placeholder={'Paste cookie here...\nSupports: JSON array (Cookie Editor), plain string (c_user=xxx; xs=xxx; ...)'}
              className="w-full rounded-lg border border-app-border px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Browser Type</label>
            <select
              value={browserType}
              onChange={(e) => setBrowserType(e.target.value)}
              className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="chromium">Chromium</option>
              <option value="camoufox">Camoufox</option>
            </select>
          </div>

          <ProxyInput
            proxyId={proxyId}
            setProxyId={setProxyId}
            newProxy={newProxy}
            setNewProxy={setNewProxy}
            proxies={proxies}
          />

          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Ngày tạo tài khoản FB (optional)</label>
            <input
              type="date"
              value={fbCreatedAt}
              onChange={(e) => setFbCreatedAt(e.target.value)}
              className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-app-dim mt-1">Tuổi thật của nick FB, dùng để tính warm-up chính xác hơn</p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-app-border text-app-primary hover:bg-app-base transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400 transition-colors"
            >
              {loading && <Loader className="w-4 h-4 animate-spin" />}
              {loading ? 'Adding...' : 'Add Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ---- Edit Account Modal ---- */

function EditAccountModal({ account, onClose, onSuccess }) {
  const [username, setUsername] = useState(account.username || '')
  const [browserType, setBrowserType] = useState(account.browser_type || 'chromium')
  const [proxyId, setProxyId] = useState(account.proxy_id || '')
  const [newProxy, setNewProxy] = useState('')
  const [notes, setNotes] = useState(account.notes || '')
  const [fbCreatedAt, setFbCreatedAt] = useState(account.fb_created_at || '')
  const [isActive, setIsActive] = useState(account.is_active !== false)
  const [cookieString, setCookieString] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: proxies = [] } = useQuery({
    queryKey: ['proxies'],
    queryFn: () => api.get('/proxies').then((r) => r.data),
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      let finalProxyId = proxyId || null

      if (newProxy.trim()) {
        const proxyData = parseProxyString(newProxy)
        if (!proxyData) {
          toast.error('Invalid proxy format. Use host:port or host:port:user:pass')
          setLoading(false)
          return
        }
        const res = await api.post('/proxies', proxyData)
        finalProxyId = res.data.id
      }

      await api.put(`/accounts/${account.id}`, {
        username,
        browser_type: browserType,
        proxy_id: finalProxyId,
        notes,
        is_active: isActive,
        fb_created_at: fbCreatedAt || null,
      })

      if (cookieString.trim()) {
        const parsed = parseCookieInput(cookieString)
        await api.post(`/accounts/${account.id}/update-cookie`, {
          cookie_string: parsed,
        })
      }

      toast.success('Account updated')
      onSuccess()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Update failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-app-surface rounded  w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-app-primary">Edit Account</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-app-elevated text-app-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Browser Type</label>
            <select
              value={browserType}
              onChange={(e) => setBrowserType(e.target.value)}
              className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="chromium">Chromium</option>
              <option value="camoufox">Camoufox</option>
            </select>
          </div>

          <ProxyInput
            proxyId={proxyId}
            setProxyId={setProxyId}
            newProxy={newProxy}
            setNewProxy={setNewProxy}
            proxies={proxies}
          />

          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Update Cookie (optional)</label>
            <textarea
              value={cookieString}
              onChange={(e) => setCookieString(e.target.value)}
              rows={3}
              placeholder="Leave empty to keep current cookie"
              className="w-full rounded-lg border border-app-border px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-app-border px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">Ngày tạo tài khoản FB</label>
            <input
              type="date"
              value={fbCreatedAt}
              onChange={(e) => setFbCreatedAt(e.target.value)}
              className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-app-dim mt-1">Tuổi thật của nick FB, dùng để tính warm-up chính xác hơn</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-app-border"
            />
            <label htmlFor="isActive" className="text-sm text-app-primary">Active</label>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-app-border text-app-primary hover:bg-app-base transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400 transition-colors"
            >
              {loading && <Loader className="w-4 h-4 animate-spin" />}
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ---- Bulk Import Modal ---- */

function BulkImportModal({ onClose, onSuccess }) {
  const [cookies, setCookies] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    const raw = cookies.trim()
    let lines

    if (raw.startsWith('[')) {
      try {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.length > 0 && arr[0].name) {
          lines = [arr.map((c) => `${c.name}=${c.value}`).join('; ')]
        }
      } catch {}
    }

    if (!lines) {
      lines = raw.split('\n').map((l) => parseCookieInput(l)).filter(Boolean)
    }

    if (lines.length === 0) return toast.error('Please enter at least one cookie string')

    setLoading(true)
    try {
      const res = await api.post('/accounts/bulk-import', { cookies: lines })
      const success = Array.isArray(res.data) ? res.data.filter((r) => r.success).length : lines.length
      toast.success(`Imported ${success} account(s)`)
      onSuccess()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk import failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-app-surface rounded  w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-app-primary">Bulk Import</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-app-elevated text-app-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-app-primary mb-1.5">
              Cookie Strings (one per line)
            </label>
            <textarea
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              rows={8}
              placeholder={'Paste cookie strings here, one per line...\ncookie_string_1\ncookie_string_2'}
              className="w-full rounded-lg border border-app-border px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y font-mono"
            />
            <p className="text-xs text-app-muted mt-1">
              {cookies.split('\n').filter((l) => l.trim()).length} cookie(s) entered
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-app-border text-app-primary hover:bg-app-base transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400 transition-colors"
            >
              {loading && <Loader className="w-4 h-4 animate-spin" />}
              {loading ? 'Importing...' : 'Import All'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// 2026-05-05: export so /agents page can reuse the Add UI.
export { AddAccountModal }
