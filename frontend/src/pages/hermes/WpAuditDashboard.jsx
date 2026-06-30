import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { 
  Search, RefreshCw, AlertTriangle, ArrowRight, X, ExternalLink,
  ChevronLeft, ChevronRight, BarChart2, CheckCircle2, TrendingUp, Info, ArrowUpRight, Copy, Loader, Sliders
} from 'lucide-react'
import { 
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip as ChartTooltip, ResponsiveContainer,
  LineChart, Line, Cell
} from 'recharts'

export default function WpAuditDashboard() {
  const qc = useQueryClient()
  const nav = useNavigate()

  // State filters & pagination
  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState('priority')
  const [filterGroup, setFilterGroup] = useState('all') // all | fix_gap | improve_content | promote | ok
  const [page, setPage] = useState(1)
  const limit = 15

  // Selection for comparison
  const [selectedUrls, setSelectedUrls] = useState([])
  const [showCompareModal, setShowCompareModal] = useState(false)

  // Active page detail view
  const [activeUrl, setActiveUrl] = useState(null)
  const [showDetailPanel, setShowDetailPanel] = useState(false)

  // Fetch GSC config & verify if set up
  const { data: cfgData, isLoading: isCfgLoading } = useQuery({
    queryKey: ['hermes', 'config'],
    queryFn: async () => (await api.get('/ai-hermes/config')).data,
  })
  const cfg = cfgData?.config || {}
  const isGoogleConfigured = !!(cfg.gsc_site_url && cfg.gsc_credentials_json)

  // Fetch overview data
  const { data: overview, isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['hermes', 'dashboard', 'overview', sortBy, page],
    queryFn: async () => {
      const res = await api.get(`/ai-hermes/hermes/dashboard/overview?sort_by=${sortBy}&limit=1000&page=1`)
      return res.data
    },
    enabled: isGoogleConfigured,
  })

  // Fetch opportunities (top 20)
  const { data: opps } = useQuery({
    queryKey: ['hermes', 'dashboard', 'opportunities'],
    queryFn: async () => (await api.get('/ai-hermes/hermes/dashboard/opportunities')).data,
    enabled: isGoogleConfigured,
  })

  // Sync mutation
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState(null)
  
  const handleSync = async () => {
    setSyncing(true)
    setSyncProgress('Bắt đầu đồng bộ...')
    try {
      const res = await api.post('/ai-hermes/hermes/dashboard/sync')
      const jId = res.data.job_id
      
      const timer = setInterval(async () => {
        try {
          const statusRes = await api.get(`/ai-hermes/hermes/dashboard/sync/status/${jId}`)
          const status = statusRes.data
          if (status.status === 'completed') {
            clearInterval(timer)
            setSyncing(false)
            setSyncProgress(null)
            toast.success('Đồng bộ dữ liệu thành công! 🔄')
            refetch()
          } else if (status.status === 'failed') {
            clearInterval(timer)
            setSyncing(false)
            setSyncProgress(null)
            toast.error(`Đồng bộ thất bại: ${status.error}`)
          } else {
            setSyncProgress(`Đang đồng bộ (${status.progress}%)`)
          }
        } catch {
          clearInterval(timer)
          setSyncing(false)
          setSyncProgress(null)
        }
      }, 2000)
    } catch (err) {
      setSyncing(false)
      setSyncProgress(null)
      toast.error('Lỗi khởi chạy đồng bộ: ' + err.message)
    }
  }

  // Filter & paginate list on client
  const rawPages = overview?.pages || []
  const filteredPages = rawPages.filter(p => {
    const matchesSearch = p.page_title?.toLowerCase().includes(searchTerm.toLowerCase()) || p.url?.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesGroup = filterGroup === 'all' || p.opportunity_group === filterGroup
    return matchesSearch && matchesGroup
  })

  // Sort local filtered pages if needed
  const paginatedPages = filteredPages.slice((page - 1) * limit, page * limit)
  const totalPages = Math.ceil(filteredPages.length / limit)

  // Handle checkboxes
  const toggleSelectUrl = (url) => {
    setSelectedUrls(prev => 
      prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]
    )
  }

  // Active page details query
  const { data: pageDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['hermes', 'dashboard', 'page', activeUrl],
    queryFn: async () => {
      const res = await api.get(`/ai-hermes/hermes/dashboard/page?url=${encodeURIComponent(activeUrl)}`)
      return res.data
    },
    enabled: !!activeUrl && showDetailPanel,
  })

  // Comparison query
  const { data: compareData, isLoading: isLoadingCompare } = useQuery({
    queryKey: ['hermes', 'dashboard', 'compare', selectedUrls],
    queryFn: async () => {
      const res = await api.post('/ai-hermes/hermes/dashboard/compare', { urls: selectedUrls })
      return res.data
    },
    enabled: selectedUrls.length > 0 && showCompareModal,
  })

  // Re-audit trigger
  const [auditing, setAuditing] = useState(false)
  const triggerReaudit = async (postId) => {
    if (!postId) return
    setAuditing(true)
    toast.loading('Đang chạy lại audit cho bài viết...', { id: 'reaudit' })
    try {
      const res = await api.post(`/ai-hermes/wp/audit/${postId}?force=true`)
      toast.success('Audit lại hoàn tất!', { id: 'reaudit' })
      setAuditing(false)
      // refresh detail view
      qc.invalidateQueries({ queryKey: ['hermes', 'dashboard', 'page', activeUrl] })
      refetch()
    } catch (err) {
      toast.error('Audit lại thất bại: ' + err.message, { id: 'reaudit' })
      setAuditing(false)
    }
  }

  // Format Helper
  const formatPercent = (v) => `${(v * 100).toFixed(1)}%`
  const formatDuration = (s) => {
    const min = Math.floor(s / 60)
    const sec = s % 60
    return `${min}:${sec < 10 ? '0' : ''}${sec}`
  }

  // Render notice if not configured
  if (!isGoogleConfigured && !isCfgLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center space-y-6 max-w-lg mx-auto h-[60vh]">
        <div className="w-16 h-16 rounded-full bg-warn/10 flex items-center justify-center text-warn animate-pulse">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <div>
          <h3 className="text-app-primary font-bold text-lg">Chưa cấu hình Google Search Console & GA4</h3>
          <p className="text-app-muted text-sm mt-2 leading-relaxed">
            Hệ thống cần tài khoản Service Account và thông số kết nối Google để đồng bộ dữ liệu Search Console & Analytics nhằm phân tích cơ hội cải thiện toàn trang.
          </p>
        </div>
        <button
          onClick={() => nav('/hermes/settings')}
          className="btn-hermes px-6 py-2.5 text-xs font-semibold rounded-lg"
        >
          Đi tới Cài đặt Cấu hình ⚙️
        </button>
      </div>
    )
  }

  // Matrix Data Mapping for recharts
  const matrixData = rawPages
    .filter(p => p.audit_score !== null)
    .map(p => ({
      name: p.page_title,
      url: p.url,
      x: p.audit_score,
      y: p.gsc_impressions || 0,
      z: p.gsc_clicks || 0,
      group: p.opportunity_group
    }))

  const getOpportunityLabel = (group) => {
    switch (group) {
      case 'fix_gap': return '🔴 Fix gấp'
      case 'improve_content': return '🟠 Sửa Content'
      case 'promote': return '🟡 Tăng Quảng Bản'
      default: return '✅ Đang tốt'
    }
  }

  return (
    <div className="p-6 space-y-6 font-mono-ui min-h-full pb-20">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-app-primary text-xl font-bold flex items-center gap-2">
            🧠 Hermes SEO & Performance Dashboard
          </h2>
          <p className="text-app-muted text-xs mt-1">Phân tích chéo chất lượng Content, GSC Rank và GA4 Behavior để ưu tiên SEO ROI.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn-hermes px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-2"
          >
            {syncing ? (
              <>
                <Loader className="w-3.5 h-3.5 animate-spin" /> {syncProgress}
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" /> Đồng bộ GSC + GA4
              </>
            )}
          </button>
          <button
            onClick={() => refetch()}
            className="btn-ghost p-2 border border-border rounded-lg text-app-muted hover:text-app-primary"
            title="Tải lại trang"
          >
            <RefreshCw className={`w-4 h-4 ${isRefetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* SUMMARY BANNER */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { id: 'fix_gap', title: '🔴 Cần Fix gấp', count: overview?.group_totals?.fix_gap ?? 0, desc: 'Traffic cao + CTR thấp + Content yếu', border: 'border-l-4 border-l-red-500' },
          { id: 'improve_content', title: '🟠 Sửa Content', count: overview?.group_totals?.improve_content ?? 0, desc: 'Traffic cao + CTR tốt + Content yếu', border: 'border-l-4 border-l-orange-500' },
          { id: 'promote', title: '🟡 Tăng Quảng bá', count: overview?.group_totals?.promote ?? 0, desc: 'Nội dung tốt + Ít lượt hiển thị', border: 'border-l-4 border-l-yellow-500' },
          { id: 'ok', title: '✅ Đang tốt', count: overview?.group_totals?.ok ?? 0, desc: 'Giữ vững hiệu suất tối ưu', border: 'border-l-4 border-l-green' }
        ].map(card => (
          <div
            key={card.id}
            onClick={() => setFilterGroup(filterGroup === card.id ? 'all' : card.id)}
            className={`p-4 bg-app-elevated border border-border rounded-xl cursor-pointer hover:border-hermes/40 transition-all ${card.border} ${filterGroup === card.id ? 'ring-1 ring-hermes' : ''}`}
          >
            <div className="text-[10px] text-app-dim uppercase font-bold tracking-wider">{card.title}</div>
            <div className="text-3xl font-extrabold text-app-primary mt-1.5">{card.count}</div>
            <div className="text-[10px] text-app-muted mt-1 leading-normal">{card.desc}</div>
          </div>
        ))}
      </div>

      {/* SCATTER PLOT OPPORTUNITY MATRIX */}
      <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-3">
        <h4 className="text-xs uppercase tracking-wider text-app-primary font-bold">🎯 Ma trận Cơ hội Cải thiện (Opportunity Matrix)</h4>
        <p className="text-[10px] text-app-muted">Trục X đại diện cho Điểm Audit. Trục Y đại diện cho số lượt hiển thị (Impressions). Bong bóng càng to đại diện cho clicks càng nhiều.</p>
        
        <div className="h-72 w-full pt-4">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <XAxis 
                type="number" 
                dataKey="x" 
                name="Audit Score" 
                domain={[0, 100]}
                stroke="var(--text-muted)"
                fontSize={10}
              >
                <Label value="Điểm Audit →" offset={-10} position="insideBottom" fill="var(--text-muted)" fontSize={10} />
              </XAxis>
              <YAxis 
                type="number" 
                dataKey="y" 
                name="Impressions"
                stroke="var(--text-muted)"
                fontSize={10}
              >
                <Label value="Impressions ↑" angle={-90} position="insideLeft" fill="var(--text-muted)" fontSize={10} />
              </YAxis>
              <ZAxis type="number" dataKey="z" range={[40, 400]} name="Clicks" />
              <ChartTooltip 
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload
                    return (
                      <div className="p-3 bg-black border border-border rounded-lg font-mono-ui text-xs space-y-1">
                        <div className="font-bold text-app-primary">{data.name}</div>
                        <div className="text-app-muted text-[10px] truncate max-w-xs">{data.url}</div>
                        <div className="grid grid-cols-2 gap-x-4 pt-1 border-t border-border mt-1">
                          <span className="text-app-muted">Audit Score:</span>
                          <span className="text-app-primary text-right font-bold">{data.x}/100</span>
                          <span className="text-app-muted">Impressions:</span>
                          <span className="text-app-primary text-right">{data.y.toLocaleString()}</span>
                          <span className="text-app-muted">Clicks:</span>
                          <span className="text-app-primary text-right">{data.z.toLocaleString()}</span>
                        </div>
                      </div>
                    )
                  }
                  return null
                }}
              />
              <Scatter name="Pages" data={matrixData} onClick={(node) => {
                setActiveUrl(node.url)
                setShowDetailPanel(true)
              }}>
                {matrixData.map((entry, index) => {
                  let color = '#22c55e'
                  if (entry.group === 'fix_gap') color = '#ef4444'
                  else if (entry.group === 'improve_content') color = '#f97316'
                  else if (entry.group === 'promote') color = '#eab308'
                  return <Cell key={`cell-${index}`} fill={color} className="cursor-pointer" />
                })}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ALL PAGES TABLE SECTION */}
      <div className="p-4 bg-app-elevated border border-border rounded-xl space-y-4">
        
        {/* Table Filters Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 max-w-md">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-app-muted" />
              <input
                type="text"
                placeholder="Tìm kiếm tiêu đề hoặc URL..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value)
                  setPage(1)
                }}
                className="w-full pl-9 pr-4 py-2 bg-app-base border border-border text-app-primary rounded-lg text-xs"
              />
            </div>
            {filterGroup !== 'all' && (
              <button 
                onClick={() => setFilterGroup('all')}
                className="px-2.5 py-1.5 bg-hermes-dim text-hermes border border-hermes/30 hover:bg-hermes/20 rounded-lg text-[10px] flex items-center gap-1 uppercase font-bold"
              >
                Clear Lọc <X className="w-3 h-3" />
              </button>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            {selectedUrls.length > 0 && (
              <button
                onClick={() => setShowCompareModal(true)}
                className="btn-hermes px-4.5 py-2 text-xs font-semibold rounded-lg flex items-center gap-1.5"
              >
                <Sliders className="w-3.5 h-3.5" /> So sánh ({selectedUrls.length})
              </button>
            )}
            
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-app-muted uppercase">Sắp xếp:</span>
              <select
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value)
                  setPage(1)
                }}
                className="px-2.5 py-1.5 bg-app-base border border-border text-app-primary rounded-lg text-xs font-mono-ui"
              >
                <option value="priority">🔥 Điểm Ưu Tiên</option>
                <option value="impressions">👁️ Lượt Hiển Thị</option>
                <option value="clicks">🖱️ Clicks</option>
                <option value="audit_score">🧠 Điểm Audit</option>
                <option value="position">📍 Thứ Hạng GSC</option>
              </select>
            </div>
          </div>
        </div>

        {/* Real Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono-ui border-collapse">
            <thead>
              <tr className="border-b border-border text-app-dim text-[10px] uppercase">
                <th className="py-2.5 px-3 w-8"></th>
                <th className="py-2.5 px-2">Page URL / Tiêu Đề</th>
                <th className="py-2.5 px-2 text-center w-24">Điểm Audit</th>
                <th className="py-2.5 px-2 text-right w-20">Impr</th>
                <th className="py-2.5 px-2 text-right w-20">Clicks</th>
                <th className="py-2.5 px-2 text-right w-20">CTR</th>
                <th className="py-2.5 px-2 text-right w-16">Pos</th>
                <th className="py-2.5 px-2 text-center w-28">Cơ Hội</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-app-muted">Đang tải dữ liệu SEO Dashboard...</td>
                </tr>
              ) : paginatedPages.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-app-muted">Không tìm thấy trang nào khớp bộ lọc.</td>
                </tr>
              ) : (
                paginatedPages.map((p) => {
                  const isChecked = selectedUrls.includes(p.url)
                  let scoreColor = 'text-danger'
                  if (p.audit_score >= 70) scoreColor = 'text-green'
                  else if (p.audit_score >= 50) scoreColor = 'text-warn'
                  
                  return (
                    <tr
                      key={p.url}
                      className="border-b border-border/40 hover:bg-app-hover cursor-pointer"
                    >
                      <td className="py-3 px-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectUrl(p.url)}
                          disabled={selectedUrls.length >= 4 && !isChecked}
                          className="rounded border-border text-hermes focus:ring-hermes"
                        />
                      </td>
                      <td className="py-3 px-2 min-w-0" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>
                        <div className="font-bold text-app-primary truncate max-w-sm md:max-w-md">{p.page_title}</div>
                        <div className="text-app-muted text-[10px] truncate max-w-sm md:max-w-md mt-0.5">{p.url}</div>
                      </td>
                      <td className="py-3 px-2 text-center font-bold" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>
                        <span className={p.audit_score !== null ? scoreColor : 'text-app-dim'}>
                          {p.audit_score !== null ? `${p.audit_score}/100` : 'Chưa audit'}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-right" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>{(p.gsc_impressions || 0).toLocaleString()}</td>
                      <td className="py-3 px-2 text-right" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>{(p.gsc_clicks || 0).toLocaleString()}</td>
                      <td className="py-3 px-2 text-right" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>{formatPercent(p.gsc_ctr || 0)}</td>
                      <td className="py-3 px-2 text-right font-bold text-app-primary" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>{(p.gsc_position || 0).toFixed(1)}</td>
                      <td className="py-3 px-2 text-center" onClick={() => {
                        setActiveUrl(p.url)
                        setShowDetailPanel(true)
                      }}>
                        <span className={`px-2 py-0.5 text-[9px] font-bold rounded uppercase ${
                          p.opportunity_group === 'fix_gap' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                          p.opportunity_group === 'improve_content' ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' :
                          p.opportunity_group === 'promote' ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' :
                          'bg-green-500/10 text-green-400 border border-green-500/20'
                        }`}>
                          {getOpportunityLabel(p.opportunity_group)}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-border/40">
            <span className="text-[10px] text-app-dim">Hiển thị {paginatedPages.length} trên tổng số {filteredPages.length} trang</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-ghost p-1.5 border border-border rounded text-app-muted hover:text-app-primary disabled:opacity-30"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs px-3 py-1 font-bold bg-app-elevated border border-border text-app-primary rounded">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="btn-ghost p-1.5 border border-border rounded text-app-muted hover:text-app-primary disabled:opacity-30"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* PAGE DETAILS SLIDE-OVER PANEL */}
      {showDetailPanel && (
        <div className="fixed inset-0 z-50 overflow-hidden font-mono-ui">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowDetailPanel(false)} />
          <div className="absolute inset-y-0 right-0 w-full max-w-[480px] bg-black border-l border-border shadow-2xl flex flex-col h-full z-50">
            
            {/* Panel Header */}
            <div className="p-4 border-b border-border flex items-center justify-between bg-app-elevated">
              <div className="min-w-0 flex-1 pr-4">
                <div className="text-[9px] uppercase tracking-wider text-app-muted font-bold flex items-center gap-1.5">
                  📄 Chi tiết trang tối ưu
                  {pageDetails?.audit_score !== null && (
                    <span className="px-1.5 py-0.5 bg-hermes-dim text-hermes rounded text-[8px]">
                      {pageDetails?.audit_score}/100
                    </span>
                  )}
                </div>
                <h3 className="text-app-primary text-sm font-bold truncate mt-1">{pageDetails?.page?.page_title}</h3>
              </div>
              <button
                onClick={() => setShowDetailPanel(false)}
                className="p-1 border border-border rounded text-app-muted hover:text-app-primary hover:bg-app-hover"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Panel Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {isLoadingDetails ? (
                <div className="text-center py-20 text-app-muted text-xs">Đang tải phân tích chi tiết trang...</div>
              ) : (
                <>
                  {/* METRICS SUMMARY ROW */}
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">Impressions</div>
                      <div className="text-sm font-bold text-app-primary mt-1">{(pageDetails?.page?.gsc_impressions ?? 0).toLocaleString()}</div>
                    </div>
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">Clicks</div>
                      <div className="text-sm font-bold text-app-primary mt-1">{(pageDetails?.page?.gsc_clicks ?? 0).toLocaleString()}</div>
                    </div>
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">CTR</div>
                      <div className="text-sm font-bold text-app-primary mt-1">{formatPercent(pageDetails?.page?.gsc_ctr ?? 0)}</div>
                    </div>
                    <div className="p-2.5 bg-app-elevated border border-border rounded-lg">
                      <div className="text-[8px] text-app-dim uppercase font-bold">Vị trí trung bình</div>
                      <div className="text-sm font-bold text-hermes mt-1">{(pageDetails?.page?.gsc_position ?? 0).toFixed(1)}</div>
                    </div>
                  </div>

                  {/* SCORE HISTORY (SPARKLINE) */}
                  <div className="p-3 bg-app-elevated border border-border rounded-xl space-y-2">
                    <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider flex items-center gap-1.5">
                      📈 Lịch sử điểm số Audit
                    </h5>
                    {pageDetails?.history?.length > 1 ? (
                      <div className="h-20 w-full pt-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={pageDetails.history}>
                            <Line type="monotone" dataKey="score" stroke="var(--hermes)" strokeWidth={2} dot={{ r: 4, stroke: 'black', strokeWidth: 1 }} />
                          </LineChart>
                        </ResponsiveContainer>
                        <div className="flex justify-between text-[8px] text-app-dim mt-1.5 font-bold">
                          <span>{pageDetails.history[0].date} ({pageDetails.history[0].score})</span>
                          <span>{pageDetails.history[pageDetails.history.length - 1].date} ({pageDetails.history[pageDetails.history.length - 1].score})</span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[10px] text-app-dim">Chưa có đủ lịch sử dữ liệu (cần ít nhất 2 phiên audit điểm để vẽ biểu đồ trend).</p>
                    )}
                  </div>

                  {/* GSC TOP QUERIES */}
                  <div className="space-y-2.5">
                    <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider flex items-center gap-1.5">
                      🔎 Từ khóa thực tế kéo traffic (GSC Queries)
                    </h5>
                    <div className="bg-app-elevated border border-border rounded-xl overflow-hidden">
                      <table className="w-full text-left text-[11px]">
                        <thead>
                          <tr className="bg-app-hover border-b border-border text-app-dim text-[8px] uppercase">
                            <th className="py-2 px-3">Từ khóa (Query)</th>
                            <th className="py-2 px-2 text-right w-16">Clicks</th>
                            <th className="py-2 px-2 text-right w-16">Impressions</th>
                            <th className="py-2 px-2 text-right w-16">Vị trí</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageDetails?.page?.gsc_top_queries?.map((q, idx) => (
                            <tr key={idx} className="border-b border-border/40 hover:bg-app-hover">
                              <td className="py-2.5 px-3 text-app-primary truncate font-bold">{q.keys?.[0] || q.query}</td>
                              <td className="py-2.5 px-2 text-right font-bold">{(q.clicks || 0).toLocaleString()}</td>
                              <td className="py-2.5 px-2 text-right">{(q.impressions || 0).toLocaleString()}</td>
                              <td className="py-2.5 px-2 text-right text-hermes font-bold">{(q.position || 0).toFixed(1)}</td>
                            </tr>
                          ))}
                          {(!pageDetails?.page?.gsc_top_queries || pageDetails.page.gsc_top_queries.length === 0) && (
                            <tr>
                              <td colSpan={4} className="py-4 text-center text-app-muted text-[10px]">Chưa có dữ liệu từ khóa cho trang này.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* GA4 USER BEHAVIOR */}
                  <div className="p-3.5 bg-app-elevated border border-border rounded-xl space-y-2.5">
                    <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider flex items-center gap-1.5">
                      ⏱️ Hành vi người dùng (GA4)
                    </h5>
                    <div className="grid grid-cols-2 gap-4 text-center">
                      <div>
                        <div className="text-[9px] text-app-dim uppercase">Thời gian đọc trung bình</div>
                        <div className="text-lg font-bold text-app-primary mt-1">
                          {formatDuration(pageDetails?.page?.ga4_avg_time_sec ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] text-app-dim uppercase">Tỷ lệ thoát (Bounce Rate)</div>
                        <div className="text-lg font-bold text-app-primary mt-1">
                          {formatPercent(pageDetails?.page?.ga4_bounce_rate ?? 0)}
                        </div>
                      </div>
                    </div>
                    {pageDetails?.page?.ga4_bounce_rate > 0.60 && (
                      <div className="p-2.5 bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 rounded-lg flex items-start gap-1.5 leading-normal">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span><strong>Tỷ lệ thoát 60% khá cao:</strong> Có thể đoạn mở bài chưa thu hút hoặc không cung cấp đúng câu trả lời trực tiếp. Hãy bổ sung GEO direct answer.</span>
                      </div>
                    )}
                  </div>

                  {/* AUDIT SCORE BREAKDOWN */}
                  {pageDetails?.audit_score !== null && (
                    <div className="p-3.5 bg-app-elevated border border-border rounded-xl space-y-3">
                      <h5 className="text-[10px] text-app-primary font-bold uppercase tracking-wider">
                        🧱 Breakdown Điểm Số Chất Lượng Content
                      </h5>
                      <div className="grid grid-cols-2 gap-3">
                        {Object.entries(pageDetails?.suggestions || {}).length > 0 && (
                          <>
                            <div className="text-[11px] flex justify-between items-center">
                              <span className="text-app-muted">SEO On-page</span>
                              <span className="text-app-primary font-bold">Có dữ liệu</span>
                            </div>
                            <div className="text-[11px] flex justify-between items-center">
                              <span className="text-app-muted">GEO Optimized</span>
                              <span className="text-app-primary font-bold">Đã phân tích</span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Panel Footer */}
            <div className="p-4 border-t border-border flex gap-3 bg-app-elevated">
              {pageDetails?.page?.post_id ? (
                <>
                  <button
                    onClick={() => triggerReaudit(pageDetails.page.post_id)}
                    disabled={auditing}
                    className="flex-1 btn-ghost border border-border text-app-primary font-bold text-xs py-2.5 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    {auditing ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Quét Lại (Re-audit)
                  </button>
                  <button
                    onClick={() => nav(`/hermes/wp-audit/${pageDetails.page.post_id}`)}
                    className="flex-1 btn-hermes text-white font-bold text-xs py-2.5 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    Đến Trang Audit Chi Tiết <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <div className="w-full text-center py-2 text-[10px] text-app-dim">
                  Trang này chưa được liên kết với bài viết nào trên hệ thống WordPress. Hãy tạo bài viết mới hoặc audit link này trong cài đặt.
                </div>
              )}
            </div>
            
          </div>
        </div>
      )}

      {/* COMPARISON MODAL */}
      {showCompareModal && (
        <div className="fixed inset-0 z-50 overflow-auto flex items-center justify-center p-4 font-mono-ui">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowCompareModal(false)} />
          <div className="bg-black border border-border rounded-xl shadow-2xl w-full max-w-4xl z-50 overflow-hidden flex flex-col max-h-[85vh]">
            
            {/* Modal Header */}
            <div className="p-4 border-b border-border flex justify-between items-center bg-app-elevated">
              <div>
                <h3 className="text-app-primary font-bold text-sm">Comparison View</h3>
                <p className="text-[10px] text-app-muted mt-0.5">So sánh chi tiết đối chiếu hiệu suất tối ưu side-by-side.</p>
              </div>
              <button
                onClick={() => setShowCompareModal(false)}
                className="p-1 border border-border rounded text-app-muted hover:text-app-primary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-auto p-4">
              {isLoadingCompare ? (
                <div className="text-center py-16 text-app-muted text-xs">Đang tải đối chiếu so sánh...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono-ui border-collapse min-w-[600px]">
                    <thead>
                      <tr className="border-b border-border text-app-dim text-[10px] uppercase bg-app-hover">
                        <th className="py-2.5 px-3">Thông số</th>
                        {compareData?.map((item, idx) => (
                          <th key={idx} className="py-2.5 px-3 truncate max-w-[150px] font-bold text-app-primary text-center">
                            {item.cache?.page_title}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Điểm Audit</td>
                        {compareData?.map((item, idx) => {
                          const score = item.audit?.audit_score
                          let color = 'text-danger'
                          if (score >= 70) color = 'text-green'
                          else if (score >= 50) color = 'text-warn'
                          return (
                            <td key={idx} className={`py-3 px-3 text-center font-extrabold ${color}`}>
                              {score !== undefined ? `${score}/100` : '—'}
                            </td>
                          )
                        })}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Impressions (GSC)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {(item.cache?.gsc_impressions ?? 0).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Clicks (GSC)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {(item.cache?.gsc_clicks ?? 0).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">CTR trung bình</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {formatPercent(item.cache?.gsc_ctr ?? 0)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Vị trí Rank (GSC)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-hermes font-bold">
                            {(item.cache?.gsc_position ?? 0).toFixed(1)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Sessions (GA4)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {(item.cache?.ga4_sessions ?? 0).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Bounce Rate (GA4)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {formatPercent(item.cache?.ga4_bounce_rate ?? 0)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Time on Page (GA4)</td>
                        {compareData?.map((item, idx) => (
                          <td key={idx} className="py-3 px-3 text-center text-app-primary">
                            {formatDuration(item.cache?.ga4_avg_time_sec ?? 0)}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b border-border/40">
                        <td className="py-3 px-3 text-app-muted">Hành động Khuyên dùng</td>
                        {compareData?.map((item, idx) => {
                          const g = item.cache?.opportunity_group
                          return (
                            <td key={idx} className="py-3 px-3 text-center font-bold">
                              <span className={`px-2 py-0.5 text-[9px] rounded uppercase ${
                                g === 'fix_gap' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                                g === 'improve_content' ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' :
                                g === 'promote' ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' :
                                'bg-green-500/10 text-green-400 border border-green-500/20'
                              }`}>
                                {getOpportunityLabel(g)}
                              </span>
                            </td>
                          )
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-border flex justify-end bg-app-elevated">
              <button
                onClick={() => {
                  setSelectedUrls([])
                  setShowCompareModal(false)
                }}
                className="btn-ghost border border-border px-5 py-2 text-xs font-semibold rounded-lg text-app-primary mr-3"
              >
                Clear Lựa Chọn
              </button>
              <button
                onClick={() => setShowCompareModal(false)}
                className="btn-hermes px-5 py-2 text-xs font-semibold rounded-lg"
              >
                Đóng
              </button>
            </div>
            
          </div>
        </div>
      )}
      
    </div>
  )
}
