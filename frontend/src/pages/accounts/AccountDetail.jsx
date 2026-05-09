import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Loader,
  Save,
  Settings,
  FileText,
  UsersRound,
  History,
  Monitor,
  Mic,
  Clock,
  Plus,
  Download,
  Trash2,
  X,
  RefreshCw,
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api, { API_BASE } from '../../lib/api'
import useAgentGuard from '../../hooks/useAgentGuard'
import HealthBadge from '../../components/accounts/HealthBadge'
import ProxyBadge from '../../components/shared/ProxyBadge'
import CookieRepairModal from '../../components/hermes/CookieRepairModal'
import QuickPost from '../../components/accounts/QuickPost'
import VoiceProfileEditor from './VoiceProfileEditor'

const TABS = [
  { key: 'config', label: 'Config', icon: Settings },
  { key: 'voice', label: 'Phong cách', icon: Mic },
  { key: 'fanpages', label: 'Fanpages', icon: FileText },
  { key: 'groups', label: 'Groups', icon: UsersRound },
  { key: 'history', label: 'History', icon: History },
]

function formatDate(dateStr) {
  if (!dateStr) return 'Never'
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Fetch job status labels
const FETCH_STATUS = {
  pending: { label: 'Queued...', color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200', icon: Clock },
  claimed: { label: 'Starting...', color: 'text-info', bg: 'bg-blue-50 border-blue-200', icon: Loader },
  running: { label: 'Scanning...', color: 'text-info', bg: 'bg-blue-50 border-blue-200', icon: Loader },
  done: { label: 'Complete!', color: 'text-hermes', bg: 'bg-green-50 border-green-200', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'text-red-600', bg: 'bg-red-50 border-red-200', icon: XCircle },
}

export default function AccountDetail() {
  const { id } = useParams()
  const [activeTab, setActiveTab] = useState('config')
  const [showCookieRepair, setShowCookieRepair] = useState(false)
  const [quickPostTarget, setQuickPostTarget] = useState(null)
  const [fetchJobId, setFetchJobId] = useState(null)
  const [fetchStatus, setFetchStatus] = useState(null) // null | pending | claimed | running | done | failed
  const [fetchResult, setFetchResult] = useState(null) // { pages_found, pages_saved, groups_found, groups_saved }
  const [fetchError, setFetchError] = useState(null)
  const [fetchElapsed, setFetchElapsed] = useState(0)
  const pollRef = useRef(null)
  const queryClient = useQueryClient()
  const { requireAgent } = useAgentGuard()

  const {
    data: account,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['account', id],
    queryFn: () => api.get(`/accounts/${id}`).then((r) => r.data),
  })

  // Poll job status khi có fetchJobId
  const pollStartRef = useRef(null)
  const pollFailCountRef = useRef(0)
  const pollBusyRef = useRef(false) // Chặn concurrent polls
  const pollCountRef = useRef(0)

  const POLL_TIMEOUT_MS = 10 * 60 * 1000
  const MAX_POLL_FAILURES = 10

  const stopPolling = useCallback((reason) => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    pollStartRef.current = null
    pollFailCountRef.current = 0
    pollBusyRef.current = false
    pollCountRef.current = 0
    // polling stopped
  }, [])

  const pollJobStatus = useCallback(async () => {
    if (!fetchJobId) return
    if (pollBusyRef.current) return // Chặn concurrent — poll trước chưa xong thì skip
    pollBusyRef.current = true
    pollCountRef.current++

    try {
      // Timeout safety
      if (pollStartRef.current && Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        setFetchStatus('failed')
        setFetchError('Timeout — job took too long. Check agent logs.')
        stopPolling('timeout')
        toast.error('Fetch timed out. Check if agent is running.')
        return
      }

      // Poll job status — fetch() trực tiếp, không qua axios interceptor
      const res = await fetch(`${API_BASE}/jobs/${fetchJobId}/status`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const job = await res.json()
      pollFailCountRef.current = 0

      const elapsed = pollStartRef.current ? Math.round((Date.now() - pollStartRef.current) / 1000) : 0
      setFetchElapsed(elapsed)
      setFetchStatus(job.status)

      if (job.status === 'done') {
        setFetchResult(job.result)
        setFetchError(null)
        queryClient.invalidateQueries({ queryKey: ['account-fanpages', id] })
        queryClient.invalidateQueries({ queryKey: ['account-groups', id] })
        queryClient.invalidateQueries({ queryKey: ['fanpages'] })
        queryClient.invalidateQueries({ queryKey: ['groups'] })
        stopPolling('done')
        toast.success(`Found ${job.result?.pages_found || 0} pages, ${job.result?.groups_found || 0} groups!`)
      } else if (job.status === 'failed') {
        setFetchError(job.error_message || 'Unknown error')
        setFetchResult(null)
        stopPolling('failed')
        toast.error(`Fetch failed: ${job.error_message || 'Unknown error'}`)
      }
    } catch (err) {
      pollFailCountRef.current++
      if (pollFailCountRef.current >= MAX_POLL_FAILURES) {
        setFetchStatus('failed')
        setFetchError('Lost connection to API — check if API server is running')
        stopPolling('too many API errors')
        toast.error('Lost connection to API. Refresh the page.')
      }
    } finally {
      pollBusyRef.current = false
    }
  }, [fetchJobId, id, queryClient, stopPolling])

  // Start/stop polling
  useEffect(() => {
    if (fetchJobId && fetchStatus !== 'done' && fetchStatus !== 'failed') {
      pollStartRef.current = Date.now()
      pollFailCountRef.current = 0
      pollRef.current = setInterval(pollJobStatus, 3000)
      return () => { if (pollRef.current) clearInterval(pollRef.current) }
    }
  }, [fetchJobId, fetchStatus, pollJobStatus])

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const handleFetchAll = () => requireAgent(async () => {
    // Reset state
    setFetchStatus('pending')
    setFetchResult(null)
    setFetchError(null)
    setFetchJobId(null)
    stopPolling()

    try {
      const res = await api.post(`/accounts/${id}/fetch-all`, {})
      const jobId = res.data?.job_id
      if (jobId) {
        setFetchJobId(jobId)
        toast.success('Fetch started! Running in background...')
      } else {
        setFetchStatus(null)
        toast.error('No job_id returned')
      }
    } catch (err) {
      setFetchStatus(null)
      if (err.response?.status === 503) toast.error('Agent offline! Start the SocialFlow Agent first.')
      else toast.error(err.response?.data?.error || 'Failed to queue fetch job')
    }
  })

  const isFetching = fetchStatus && fetchStatus !== 'done' && fetchStatus !== 'failed'
  const fetchDone = fetchStatus === 'done'
  const fetchFailed = fetchStatus === 'failed'

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader className="w-6 h-6 animate-spin text-info" />
      </div>
    )
  }

  if (error || !account) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500 text-sm">Failed to load account details.</p>
        <Link
          to="/accounts"
          className="text-info text-sm mt-2 inline-block hover:underline"
        >
          Back to accounts
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/accounts"
        className="inline-flex items-center gap-1.5 text-sm text-app-muted hover:text-app-primary transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Accounts
      </Link>

      {/* Header */}
      <div className="bg-app-surface rounded border border-app-border p-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-app-primary">
                {account.username}
              </h1>
              <HealthBadge status={account.status} />
            </div>
            <p className="text-sm text-app-muted">
              FB User ID: {account.fb_user_id}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowCookieRepair(true)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-mono-ui rounded transition-colors"
              style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.35)' }}
            >
              🍪 Cập nhật cookie
            </button>
            <button
              onClick={handleFetchAll}
              disabled={isFetching}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                isFetching
                  ? 'bg-blue-100 text-info cursor-not-allowed'
                  : 'bg-hermes text-white hover:bg-green-700'
              }`}
            >
              {isFetching ? (
                <Loader className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {isFetching ? 'Scanning...' : 'Fetch Pages & Groups'}
            </button>
            <div className="text-right space-y-1">
              <div className="flex items-center gap-2 text-sm text-app-muted">
                <Monitor className="w-4 h-4" />
                {account.browser_type || 'N/A'}
              </div>
              <ProxyBadge proxy={account.proxy} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6 mt-4 pt-4 border-t border-app-border text-sm text-app-muted">
          <span>
            Posts today: {account.posts_today ?? 0}/{account.max_daily_posts ?? '?'}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            Last used: {formatDate(account.last_used_at)}
          </span>
        </div>
      </div>

      {/* Fetch Status Banner */}
      {fetchStatus && (
        <div className={`rounded border p-4 ${FETCH_STATUS[fetchStatus]?.bg || 'bg-app-base border-app-border'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {(() => {
                const StatusIcon = FETCH_STATUS[fetchStatus]?.icon || Loader
                const isAnimated = fetchStatus === 'claimed' || fetchStatus === 'running' || fetchStatus === 'pending'
                return <StatusIcon className={`w-5 h-5 ${FETCH_STATUS[fetchStatus]?.color} ${isAnimated ? 'animate-spin' : ''}`} />
              })()}
              <div>
                <p className={`text-sm font-semibold ${FETCH_STATUS[fetchStatus]?.color}`}>
                  {FETCH_STATUS[fetchStatus]?.label}
                  {fetchStatus === 'running' && ' Agent is scanning pages & groups in browser'}
                  {fetchStatus === 'pending' && ' Waiting for agent to pick up...'}
                  {fetchStatus === 'claimed' && ' Agent picked up, launching browser...'}
                  {fetchElapsed > 0 && isFetching && (
                    <span className="ml-2 font-normal text-app-muted">
                      ({Math.floor(fetchElapsed / 60)}:{String(fetchElapsed % 60).padStart(2, '0')})
                    </span>
                  )}
                </p>
                {fetchResult && (
                  <p className="text-xs text-hermes mt-0.5">
                    Found {fetchResult.pages_found || 0} pages ({fetchResult.pages_saved || 0} saved), {fetchResult.groups_found || 0} groups ({fetchResult.groups_saved || 0} saved)
                    {fetchResult.status && fetchResult.status !== 'ok' && (
                      <span className="ml-2 text-amber-600">Account status: {fetchResult.status}</span>
                    )}
                  </p>
                )}
                {fetchError && (
                  <p className="text-xs text-red-600 mt-0.5">{fetchError}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {(fetchDone || fetchFailed) && (
                <button
                  onClick={() => { setFetchStatus(null); setFetchJobId(null); setFetchResult(null); setFetchError(null) }}
                  className="p-1 rounded-lg hover:bg-app-surface/50 transition-colors"
                >
                  <X className="w-4 h-4 text-app-muted" />
                </button>
              )}
              {fetchFailed && (
                <button
                  onClick={handleFetchAll}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-app-border">
        <nav className="flex gap-0">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-info'
                  : 'border-transparent text-app-muted hover:text-app-primary hover:border-app-border'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'config' && (
          <ConfigTab account={account} queryClient={queryClient} />
        )}
        {activeTab === 'voice' && (
          <div className="bg-app-surface rounded shadow p-6">
            <VoiceProfileEditor accountId={id} accountName={account?.username || 'nick'} />
          </div>
        )}
        {activeTab === 'fanpages' && <FanpagesTab accountId={id} onQuickPost={setQuickPostTarget} />}
        {activeTab === 'groups' && <GroupsTab accountId={id} onQuickPost={setQuickPostTarget} />}
        {activeTab === 'history' && <HistoryTab accountId={id} />}
      </div>

      {/* Quick Post Modal */}
      {quickPostTarget && (
        <QuickPost
          accountId={id}
          target={quickPostTarget}
          onClose={() => setQuickPostTarget(null)}
        />
      )}

      {/* Cookie Repair Modal */}
      {showCookieRepair && account && (
        <CookieRepairModal
          account={account}
          onClose={() => setShowCookieRepair(false)}
          onSuccess={() => setShowCookieRepair(false)}
        />
      )}
    </div>
  )
}

function ConfigTab({ account, queryClient }) {
  // Normalize time values to HH:mm format (DB may store "8", "22", "8:00", etc.)
  const normalizeTime = (val, fallback) => {
    if (!val) return fallback
    const str = String(val).trim()
    // Already in HH:mm format
    if (/^\d{2}:\d{2}$/.test(str)) return str
    // Just a number like "8" or "22" → pad to "08:00" or "22:00"
    if (/^\d{1,2}$/.test(str)) return str.padStart(2, '0') + ':00'
    // Format like "8:00" or "8:30" → pad hours
    const m = str.match(/^(\d{1,2}):(\d{2})$/)
    if (m) return m[1].padStart(2, '0') + ':' + m[2]
    return fallback
  }

  const [form, setForm] = useState({
    active_hours_start: normalizeTime(account.active_hours_start, '08:00'),
    active_hours_end: normalizeTime(account.active_hours_end, '22:00'),
    active_days: account.active_days ?? [1, 2, 3, 4, 5],
    max_daily_posts: account.max_daily_posts ?? 10,
    min_delay_minutes: account.min_delay_minutes ?? 15,
    max_delay_minutes: account.max_delay_minutes ?? 60,
  })

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const updateMutation = useMutation({
    mutationFn: (data) => api.put(`/accounts/${account.id}`, data),
    onSuccess: () => {
      toast.success('Settings saved')
      queryClient.invalidateQueries({ queryKey: ['account', String(account.id)] })
    },
    onError: () => toast.error('Failed to save settings'),
  })

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const toggleDay = (day) => {
    setForm((prev) => ({
      ...prev,
      active_days: prev.active_days.includes(day)
        ? prev.active_days.filter((d) => d !== day)
        : [...prev.active_days, day].sort(),
    }))
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    updateMutation.mutate(form)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-app-surface rounded border border-app-border p-6 space-y-6 max-w-2xl"
    >
      <h2 className="text-lg font-semibold text-app-primary">
        Schedule Settings
      </h2>

      {/* Active hours */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-app-primary mb-1.5">
            Active Hours Start
          </label>
          <input
            type="time"
            value={form.active_hours_start}
            onChange={(e) => handleChange('active_hours_start', e.target.value)}
            className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-app-primary mb-1.5">
            Active Hours End
          </label>
          <input
            type="time"
            value={form.active_hours_end}
            onChange={(e) => handleChange('active_hours_end', e.target.value)}
            className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      {/* Active days */}
      <div>
        <label className="block text-sm font-medium text-app-primary mb-2">
          Active Days
        </label>
        <div className="flex gap-2">
          {dayNames.map((name, i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggleDay(i)}
              className={`w-10 h-10 rounded-lg text-xs font-medium transition-colors ${
                form.active_days.includes(i)
                  ? 'bg-info text-white'
                  : 'bg-app-elevated text-app-muted hover:bg-app-hover'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {/* Max daily posts */}
      <div>
        <label className="block text-sm font-medium text-app-primary mb-1.5">
          Max Daily Posts
        </label>
        <input
          type="number"
          min={1}
          max={100}
          value={form.max_daily_posts}
          onChange={(e) =>
            handleChange('max_daily_posts', parseInt(e.target.value) || 1)
          }
          className="w-full max-w-xs rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Delay range */}
      <div className="grid grid-cols-2 gap-4 max-w-md">
        <div>
          <label className="block text-sm font-medium text-app-primary mb-1.5">
            Min Delay (minutes)
          </label>
          <input
            type="number"
            min={1}
            value={form.min_delay_minutes}
            onChange={(e) =>
              handleChange('min_delay_minutes', parseInt(e.target.value) || 1)
            }
            className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-app-primary mb-1.5">
            Max Delay (minutes)
          </label>
          <input
            type="number"
            min={1}
            value={form.max_delay_minutes}
            onChange={(e) =>
              handleChange('max_delay_minutes', parseInt(e.target.value) || 1)
            }
            className="w-full rounded-lg border border-app-border px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={updateMutation.isPending}
        className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400 transition-colors"
      >
        {updateMutation.isPending ? (
          <Loader className="w-4 h-4 animate-spin" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {updateMutation.isPending ? 'Saving...' : 'Save Settings'}
      </button>
    </form>
  )
}

// ── Infinite scroll hook ──────────────────────────────────────────────────
function useInfiniteList(baseUrl, limit = 30) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [hasMore, setHasMore] = useState(true)
  const sentinelRef = useRef(null)
  const activeRef = useRef(false)
  const offsetRef = useRef(0)
  const hasMoreRef = useRef(true)

  const fetchPage = useCallback(async (off) => {
    if (activeRef.current || !hasMoreRef.current) return
    activeRef.current = true
    setLoading(true)
    try {
      const { data } = await api.get(`${baseUrl}?limit=${limit}&offset=${off}`)
      const batch = data.items || []
      setItems(prev => off === 0 ? batch : [...prev, ...batch])
      hasMoreRef.current = data.hasMore === true
      setHasMore(data.hasMore === true)
      offsetRef.current = off + batch.length
    } catch (e) {
      // silently handle infinite list error
    } finally {
      activeRef.current = false
      setLoading(false)
      if (off === 0) setInitialLoading(false)
    }
  }, [baseUrl, limit])

  useEffect(() => {
    setItems([])
    hasMoreRef.current = true
    setHasMore(true)
    setInitialLoading(true)
    offsetRef.current = 0
    activeRef.current = false
    fetchPage(0)
  }, [baseUrl]) // eslint-disable-line

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && hasMoreRef.current && !activeRef.current) {
        fetchPage(offsetRef.current)
      }
    }, { threshold: 0.1 })
    io.observe(el)
    return () => io.disconnect()
  }, [fetchPage])

  const reset = useCallback(() => {
    setItems([])
    hasMoreRef.current = true
    setHasMore(true)
    setInitialLoading(true)
    offsetRef.current = 0
    activeRef.current = false
    fetchPage(0)
  }, [fetchPage])

  return { items, loading, initialLoading, hasMore, sentinelRef, reset }
}
// ─────────────────────────────────────────────────────────────────────────

function FanpagesTab({ accountId, onQuickPost }) {
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ fb_page_id: '', name: '', url: '', category: '' })
  const [addLoading, setAddLoading] = useState(false)
  const { requireAgent } = useAgentGuard()

  const { items: fanpages, initialLoading, loading, sentinelRef, reset } = useInfiniteList(`/accounts/${accountId}/fanpages`)

  const fetchMutation = useMutation({
    mutationFn: () => api.post(`/accounts/${accountId}/fetch-pages`, {}),
    onSuccess: () => {
      toast.success('Fetching pages from Facebook... Agent is processing.')
      reset()
    },
    onError: (err) => {
      if (err.response?.status === 503) toast.error('Agent offline! Start the SocialFlow Agent first.')
      else toast.error(err.response?.data?.error || 'Fetch failed')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/fanpages/${id}`),
    onSuccess: () => { toast.success('Fanpage removed'); reset() },
    onError: () => toast.error('Delete failed'),
  })

  const handleAdd = async (e) => {
    e.preventDefault()
    if (!addForm.fb_page_id && !addForm.url) return toast.error('Page ID or URL required')
    setAddLoading(true)
    try {
      let pageId = addForm.fb_page_id
      if (!pageId && addForm.url) {
        const m = addForm.url.match(/facebook\.com\/(?:pages\/[^/]+\/|)(\d+)|facebook\.com\/([^/?]+)/)
        pageId = m ? (m[1] || m[2]) : addForm.url
      }
      await api.post('/fanpages', { account_id: accountId, fb_page_id: pageId, name: addForm.name || pageId, url: addForm.url, category: addForm.category })
      toast.success('Fanpage added')
      setShowAdd(false)
      setAddForm({ fb_page_id: '', name: '', url: '', category: '' })
      reset()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Add failed')
    } finally { setAddLoading(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => requireAgent(() => fetchMutation.mutate())} disabled={fetchMutation.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400 transition-colors">
          {fetchMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Fetch from Facebook
        </button>
        <button onClick={() => setShowAdd(!showAdd)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-app-border text-app-primary hover:bg-app-base transition-colors">
          <Plus className="w-4 h-4" /> Add Manually
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="bg-app-surface rounded border border-app-border p-4 space-y-3 max-w-lg">
          <div className="grid grid-cols-2 gap-3">
            <input type="text" placeholder="Page ID" value={addForm.fb_page_id} onChange={(e) => setAddForm(f => ({ ...f, fb_page_id: e.target.value }))}
              className="rounded-lg border border-app-border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
            <input type="text" placeholder="Page Name" value={addForm.name} onChange={(e) => setAddForm(f => ({ ...f, name: e.target.value }))}
              className="rounded-lg border border-app-border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
          </div>
          <input type="text" placeholder="Facebook URL (optional)" value={addForm.url} onChange={(e) => setAddForm(f => ({ ...f, url: e.target.value }))}
            className="w-full rounded-lg border border-app-border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
          <div className="flex gap-2">
            <button type="submit" disabled={addLoading}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400">
              {addLoading ? 'Adding...' : 'Add'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm rounded-lg border border-app-border text-app-muted hover:bg-app-base">Cancel</button>
          </div>
        </form>
      )}

      {initialLoading ? (
        <div className="flex items-center justify-center h-32"><Loader className="w-5 h-5 animate-spin text-info" /></div>
      ) : fanpages.length === 0 ? (
        <div className="bg-app-surface rounded border border-app-border p-8 text-center">
          <FileText className="w-8 h-8 text-app-dim mx-auto mb-2" />
          <p className="text-sm text-app-muted">No fanpages found. Click "Fetch from Facebook" to import your pages.</p>
        </div>
      ) : (
        <div className="bg-app-surface rounded border border-app-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border bg-app-base">
                <th className="text-left px-4 py-3 font-medium text-app-muted">Page Name</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Page ID</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Category</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Followers</th>
                <th className="text-right px-4 py-3 font-medium text-app-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fanpages.map((page) => (
                <tr key={page.id} className="hover:bg-app-base">
                  <td className="px-4 py-3 font-medium text-app-primary">{page.name}</td>
                  <td className="px-4 py-3 text-app-muted">{page.fb_page_id}</td>
                  <td className="px-4 py-3 text-app-muted">{page.category || '-'}</td>
                  <td className="px-4 py-3 text-app-muted">{page.fan_count ? page.fan_count.toLocaleString() : '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => onQuickPost({ type: 'page', id: page.id, name: page.name, postingMethod: page.posting_method || 'auto' })}
                        className="text-info hover:text-info" title="Quick Post"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                      <button onClick={() => { if (window.confirm(`Remove "${page.name}"?`)) deleteMutation.mutate(page.id) }}
                        className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div ref={sentinelRef} className="h-1" />
          {loading && (
            <div className="flex justify-center py-3 border-t border-app-border">
              <Loader className="w-4 h-4 animate-spin text-app-dim" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GroupsTab({ accountId, onQuickPost }) {
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ fb_group_id: '', name: '', url: '' })
  const [addLoading, setAddLoading] = useState(false)
  const { requireAgent } = useAgentGuard()

  const { items: groups, initialLoading, loading, sentinelRef, reset } = useInfiniteList(`/accounts/${accountId}/groups`)

  const fetchMutation = useMutation({
    mutationFn: () => api.post(`/accounts/${accountId}/fetch-groups`, {}),
    onSuccess: () => {
      toast.success('Fetching groups from Facebook... Agent is processing.')
      reset()
    },
    onError: (err) => {
      if (err.response?.status === 503) toast.error('Agent offline! Start the SocialFlow Agent first.')
      else toast.error(err.response?.data?.error || 'Fetch failed')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/groups/${id}`),
    onSuccess: () => { toast.success('Group removed'); reset() },
    onError: () => toast.error('Delete failed'),
  })

  const handleAdd = async (e) => {
    e.preventDefault()
    if (!addForm.fb_group_id && !addForm.url) return toast.error('Group ID or URL required')
    setAddLoading(true)
    try {
      let groupId = addForm.fb_group_id
      if (!groupId && addForm.url) {
        const m = addForm.url.match(/facebook\.com\/groups\/([^/?]+)/)
        groupId = m ? m[1] : addForm.url
      }
      await api.post('/groups', { account_id: accountId, fb_group_id: groupId, name: addForm.name || groupId, url: addForm.url })
      toast.success('Group added')
      setShowAdd(false)
      setAddForm({ fb_group_id: '', name: '', url: '' })
      reset()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Add failed')
    } finally { setAddLoading(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => requireAgent(() => fetchMutation.mutate())} disabled={fetchMutation.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400 transition-colors">
          {fetchMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Fetch from Facebook
        </button>
        <button onClick={() => setShowAdd(!showAdd)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-app-border text-app-primary hover:bg-app-base transition-colors">
          <Plus className="w-4 h-4" /> Add Manually
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="bg-app-surface rounded border border-app-border p-4 space-y-3 max-w-lg">
          <div className="grid grid-cols-2 gap-3">
            <input type="text" placeholder="Group ID" value={addForm.fb_group_id} onChange={(e) => setAddForm(f => ({ ...f, fb_group_id: e.target.value }))}
              className="rounded-lg border border-app-border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
            <input type="text" placeholder="Group Name" value={addForm.name} onChange={(e) => setAddForm(f => ({ ...f, name: e.target.value }))}
              className="rounded-lg border border-app-border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
          </div>
          <input type="text" placeholder="Facebook Group URL (optional)" value={addForm.url} onChange={(e) => setAddForm(f => ({ ...f, url: e.target.value }))}
            className="w-full rounded-lg border border-app-border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
          <div className="flex gap-2">
            <button type="submit" disabled={addLoading}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-info text-white hover:opacity-90 disabled:bg-blue-400">
              {addLoading ? 'Adding...' : 'Add'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm rounded-lg border border-app-border text-app-muted hover:bg-app-base">Cancel</button>
          </div>
        </form>
      )}

      {initialLoading ? (
        <div className="flex items-center justify-center h-32"><Loader className="w-5 h-5 animate-spin text-info" /></div>
      ) : groups.length === 0 ? (
        <div className="bg-app-surface rounded border border-app-border p-8 text-center">
          <UsersRound className="w-8 h-8 text-app-dim mx-auto mb-2" />
          <p className="text-sm text-app-muted">No groups found. Click "Fetch from Facebook" to import your groups.</p>
        </div>
      ) : (
        <div className="bg-app-surface rounded border border-app-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border bg-app-base">
                <th className="text-left px-4 py-3 font-medium text-app-muted">Group Name</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Group ID</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Type</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Members</th>
                <th className="text-left px-4 py-3 font-medium text-app-muted">Role</th>
                <th className="text-right px-4 py-3 font-medium text-app-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {groups.map((group) => (
                <tr key={group.id} className="hover:bg-app-base">
                  <td className="px-4 py-3 font-medium text-app-primary">
                    <a href={group.url || `https://www.facebook.com/groups/${group.fb_group_id}`} target="_blank" rel="noopener noreferrer"
                      className="hover:text-info hover:underline inline-flex items-center gap-1">
                      {group.name} <ExternalLink className="w-3 h-3 text-app-dim" />
                    </a>
                  </td>
                  <td className="px-4 py-3 text-app-muted">{group.fb_group_id}</td>
                  <td className="px-4 py-3">
                    {group.group_type ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        group.group_type === 'public' ? 'bg-green-100 text-hermes' : 'bg-yellow-100 text-yellow-700'
                      }`}>
                        {group.group_type === 'public' ? 'Public' : group.group_type === 'closed' ? 'Private' : group.group_type}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3 text-app-muted">{group.member_count ? group.member_count.toLocaleString() : '-'}</td>
                  <td className="px-4 py-3 text-app-muted">{group.is_admin ? 'Admin' : 'Member'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => onQuickPost({ type: 'group', id: group.id, name: group.name })}
                        className="text-info hover:text-info" title="Quick Post"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                      <button onClick={() => { if (window.confirm(`Remove "${group.name}"?`)) deleteMutation.mutate(group.id) }}
                        className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div ref={sentinelRef} className="h-1" />
          {loading && (
            <div className="flex justify-center py-3 border-t border-app-border">
              <Loader className="w-4 h-4 animate-spin text-app-dim" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryTab({ accountId }) {
  const { items: history, initialLoading, loading, sentinelRef } = useInfiniteList(`/accounts/${accountId}/history`)

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader className="w-5 h-5 animate-spin text-info" />
      </div>
    )
  }

  if (history.length === 0) {
    return (
      <div className="bg-app-surface rounded border border-app-border p-8 text-center">
        <History className="w-8 h-8 text-app-dim mx-auto mb-2" />
        <p className="text-sm text-app-muted">No history available</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {history.map((entry, i) => (
        <div
          key={entry.id || i}
          className="bg-app-surface rounded border border-app-border p-4 flex items-start gap-3"
        >
          <div
            className={`w-2 h-2 rounded-full mt-2 shrink-0 ${
              entry.status === 'done'
                ? 'bg-hermes'
                : entry.status === 'failed'
                ? 'bg-red-500'
                : 'bg-app-hover'
            }`}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-app-primary">
              {entry.action || entry.type || 'Action'}
            </p>
            {entry.detail && (
              <p className="text-xs text-app-muted mt-0.5 truncate">
                {entry.detail}
              </p>
            )}
          </div>
          <span className="text-xs text-app-dim shrink-0">
            {formatDate(entry.created_at)}
          </span>
        </div>
      ))}
      <div ref={sentinelRef} className="h-1" />
      {loading && (
        <div className="flex justify-center py-3">
          <Loader className="w-4 h-4 animate-spin text-app-dim" />
        </div>
      )}
    </div>
  )
}
