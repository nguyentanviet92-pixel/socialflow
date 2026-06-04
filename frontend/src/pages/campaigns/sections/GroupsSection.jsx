import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UsersRound, Plus, Trash2, Search, RefreshCw, Star, Loader, PlusCircle, MinusCircle, CheckCircle, XCircle, X, Download } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../../lib/api'

const TYPE_BADGE = {
  public: 'bg-green-100 text-hermes',
  closed: 'bg-yellow-100 text-yellow-700',
  secret: 'bg-red-100 text-red-700',
}

// Phase 9 UI helpers
const TIER_CONFIG = {
  A: { label: 'A', badge: 'bg-green-100 text-hermes border-green-200', dot: 'bg-hermes', bar: 'bg-hermes' },
  B: { label: 'B', badge: 'bg-blue-100 text-blue-700 border-blue-200', dot: 'bg-info', bar: 'bg-info' },
  C: { label: 'C', badge: 'bg-yellow-100 text-yellow-800 border-yellow-200', dot: 'bg-yellow-500', bar: 'bg-yellow-500' },
  D: { label: 'D', badge: 'bg-red-100 text-red-700 border-red-200', dot: 'bg-red-500', bar: 'bg-red-500' },
}

const LANG_CONFIG = {
  vi: { flag: '🇻🇳', label: 'VI' },
  en: { flag: '🇺🇸', label: 'EN' },
  mixed: { flag: '🌐', label: 'Mixed' },
}

function timeAgo(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return 'vừa xong'
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m} phút trước`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} giờ trước`
  const d = Math.floor(h / 24)
  if (d === 1) return 'hôm qua'
  if (d < 30) return `${d} ngày trước`
  const mo = Math.floor(d / 30)
  return `${mo} tháng trước`
}

export default function GroupsSection({ campaignId, campaign, accountIds }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  // Phase 9: tier filter tabs (all | A | B | C | D | pending | removed)
  const [tierFilter, setTierFilter] = useState('all')

  const topicKey = (campaign?.topic || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
  const targetGroupsList = campaign?.meta?.target_groups || []
  const targetGroupIds = targetGroupsList.map(gStr => {
    const trimmed = (gStr || '').trim()
    const m = trimmed.match(/(?:facebook\.com|fb\.com)\/groups\/([^/?#\s]+)/i)
    return m ? m[1] : trimmed
  }).filter(Boolean)
  const isManualGroup = (fbGroupId) => targetGroupIds.includes(fbGroupId)

  const { data: campaignGroups = [], isLoading } = useQuery({
    queryKey: ['campaign-groups', campaignId],
    queryFn: () => api.get(`/campaigns/${campaignId}/groups`).then(r => r.data || []),
  })

  const { data: allGroups = [], isLoading: allLoading } = useQuery({
    queryKey: ['all-account-groups', accountIds.join(',')],
    queryFn: async () => {
      if (!accountIds.length) return []
      const results = []
      const seen = new Set()
      for (const accId of accountIds) {
        try {
          const { data } = await api.get(`/accounts/${accId}/groups`)
          for (const g of (data || [])) {
            if (!seen.has(g.fb_group_id)) {
              seen.add(g.fb_group_id)
              results.push(g)
            }
          }
        } catch {}
      }
      return results
    },
    enabled: showAll && accountIds.length > 0,
  })

  const assignMut = useMutation({
    mutationFn: ({ groupId, action }) => api.put(`/campaigns/${campaignId}/groups/${groupId}`, { action }),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
      toast.success(action === 'add' ? 'Da them nhom vao campaign' : 'Da go nhom khoi campaign')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Loi'),
  })

  const bulkAddMut = useMutation({
    mutationFn: async (lines) => {
      const urls = lines.split('\n').map(l => l.trim()).filter(Boolean)
      if (!urls.length) throw new Error('Khong co URL')
      return api.post('/groups/bulk-add', { urls, account_id: accountIds[0] })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
      queryClient.invalidateQueries({ queryKey: ['all-account-groups'] })
      toast.success('Da them nhom')
      setShowAdd(false)
      setAddInput('')
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  // ── Priority groups (tier A) ──
  const [priorityInput, setPriorityInput] = useState('')
  const { data: priorityGroups = [], isLoading: priorityLoading } = useQuery({
    queryKey: ['priority-groups', campaignId],
    queryFn: () => api.get(`/campaigns/${campaignId}/priority-groups`).then(r => r.data || []),
  })

  const addPriorityMut = useMutation({
    mutationFn: (input) => {
      const body = input.trim().includes('facebook.com')
        ? { group_url: input.trim() }
        : { fb_group_id: input.trim() }
      return api.post(`/campaigns/${campaignId}/priority-groups`, body).then(r => r.data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['priority-groups', campaignId] })
      queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
      toast.success('Đã thêm nhóm ưu tiên (tier A)')
      setPriorityInput('')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Lỗi'),
  })

  const removePriorityMut = useMutation({
    mutationFn: (fbGroupId) => api.delete(`/campaigns/${campaignId}/priority-groups/${fbGroupId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['priority-groups', campaignId] })
      queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
      toast.success('Đã hạ ưu tiên')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Lỗi'),
  })

  // Phase 14: import groups from reference campaigns
  const [showImport, setShowImport] = useState(false)
  const [selectedSourceIds, setSelectedSourceIds] = useState([])

  const { data: refCampaigns = [], isLoading: refLoading } = useQuery({
    queryKey: ['reference-campaigns', campaignId],
    queryFn: () => api.get(`/campaigns/${campaignId}/reference-campaigns`).then(r => r.data || []),
    enabled: showImport,
  })

  const importGroupsMut = useMutation({
    mutationFn: (sourceIds) => api.post(`/campaigns/${campaignId}/import-groups`, { source_campaign_ids: sourceIds }).then(r => r.data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
      toast.success(`Đã import ${result.imported} nhóm · bỏ qua ${result.skipped_duplicate} trùng · ${result.skipped_no_member} chưa có nick là member`)
      setShowImport(false)
      setSelectedSourceIds([])
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Lỗi import'),
  })

  const reviewMut = useMutation({
    mutationFn: ({ groupId, approved }) => api.put(`/campaigns/${campaignId}/groups/${groupId}/review`, { approved }),
    onSuccess: (_, { approved }) => {
      queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
      queryClient.invalidateQueries({ queryKey: ['all-account-groups'] })
      toast.success(approved ? 'Da duyet group' : 'Da tu choi group')
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Loi'),
  })

  const groups = showAll ? allGroups : campaignGroups
  const campaignGroupIds = new Set(campaignGroups.map(g => g.id))
  const allTags = [...new Set(groups.flatMap(g => g.tags || []).filter(Boolean))]

  // Phase 9: resolve effective tier (junction > fb_groups)
  const effectiveTier = (g) => g.junction_tier || g.score_tier || null

  const filtered = groups.filter(g => {
    if (search && !(g.name || '').toLowerCase().includes(search.toLowerCase()) && !(g.fb_group_id || '').includes(search)) return false
    if (tagFilter && !(g.tags || []).includes(tagFilter)) return false
    if (tierFilter !== 'all') {
      if (tierFilter === 'pending') {
        if (!(g.pending_approval === true)) return false
      } else if (tierFilter === 'removed') {
        if (g.junction_status !== 'removed') return false
      } else {
        // A/B/C/D
        if (effectiveTier(g) !== tierFilter) return false
      }
    }
    return true
  })

  const tierCounts = {
    all: groups.length,
    A: groups.filter(g => effectiveTier(g) === 'A').length,
    B: groups.filter(g => effectiveTier(g) === 'B').length,
    C: groups.filter(g => effectiveTier(g) === 'C').length,
    D: groups.filter(g => effectiveTier(g) === 'D').length,
    pending: groups.filter(g => g.pending_approval === true).length,
    removed: groups.filter(g => g.junction_status === 'removed').length,
  }

  return (
    <div className="space-y-4">
      {campaignGroups.length === 0 && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded text-sm text-red-700">
          <p className="font-semibold">Cảnh báo: Chiến dịch này chưa có nhóm nào được gán!</p>
          <p className="mt-1">Vui lòng không tự tìm kiếm nhóm bên ngoài Facebook để bình luận thủ công. Hãy gán nhóm hợp lệ vào chiến dịch hoặc liên hệ admin để được hỗ trợ.</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-app-primary">
          Nhom Facebook ({showAll ? `${allGroups.length} tat ca` : `${campaignGroups.length} campaign`})
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAll(!showAll)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              showAll ? 'border-purple-200 bg-purple-100 text-purple-700' : 'border-app-border text-app-muted hover:bg-app-elevated'
            }`}
          >
            {showAll ? 'Tat ca nhom' : 'Campaign only'}
          </button>
          <button
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['campaign-groups', campaignId] })
              queryClient.invalidateQueries({ queryKey: ['all-account-groups'] })
            }}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-app-muted border border-app-border rounded-lg hover:bg-app-elevated disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            {isLoading ? 'Dang tai...' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-purple-700 border border-purple-200 bg-purple-50 rounded-lg hover:bg-purple-100 transition-colors"
            title="Import nhóm từ chiến dịch khác"
          >
            <Download size={14} /> Import từ CD khác
          </button>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-info text-white rounded-lg hover:opacity-90 transition-colors"
          >
            <Plus size={14} /> Them nhom
          </button>
        </div>
      </div>

      {/* Phase 14: Import from other campaigns modal */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowImport(false)}>
          <div className="bg-app-surface rounded w-full max-w-lg max-h-[80vh] flex flex-col " onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-app-border flex items-center justify-between">
              <h3 className="text-sm font-semibold text-app-primary flex items-center gap-2">
                <Download size={16} className="text-purple-600" /> Import nhóm từ chiến dịch khác
              </h3>
              <button onClick={() => { setShowImport(false); setSelectedSourceIds([]) }} className="text-app-dim hover:text-app-muted">
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 overflow-y-auto flex-1">
              <p className="text-xs text-app-muted mb-3">
                Chọn các chiến dịch nguồn. Nhóm sẽ được copy sang chiến dịch này, dedup theo fb_group_id.
                Nếu không có nick nào trong CD hiện tại là member của nhóm → sẽ skip (cần scout join trước).
              </p>

              {refLoading ? (
                <div className="flex items-center justify-center py-8"><Loader size={20} className="animate-spin text-purple-500" /></div>
              ) : refCampaigns.length === 0 ? (
                <div className="text-center py-8 text-sm text-app-dim">
                  Không có chiến dịch nào khác có nhóm
                </div>
              ) : (
                <div className="space-y-2">
                  {refCampaigns.map(c => {
                    const isSelected = selectedSourceIds.includes(c.id)
                    return (
                      <label
                        key={c.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          isSelected ? 'border-purple-300 bg-purple-50' : 'border-app-border hover:bg-app-base'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => setSelectedSourceIds(ids =>
                            isSelected ? ids.filter(id => id !== c.id) : [...ids, c.id]
                          )}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-app-primary">{c.name}</span>
                            {c.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-hermes">Đang chạy</span>}
                            {c.language && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-elevated text-app-muted">{c.language}</span>}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-app-muted">
                            {c.topic && <span>Topic: {c.topic}</span>}
                            <span className="font-semibold text-purple-600">{c.groups_count} nhóm</span>
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-app-border flex items-center justify-between">
              <span className="text-[11px] text-app-muted">
                Đã chọn {selectedSourceIds.length} / {refCampaigns.length} chiến dịch
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowImport(false); setSelectedSourceIds([]) }}
                  className="px-4 py-1.5 text-sm text-app-muted hover:text-app-primary"
                >
                  Hủy
                </button>
                <button
                  disabled={!selectedSourceIds.length || importGroupsMut.isPending}
                  onClick={() => importGroupsMut.mutate(selectedSourceIds)}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                >
                  {importGroupsMut.isPending ? <Loader size={14} className="animate-spin" /> : <Download size={14} />}
                  Import
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Priority Groups (tier A) */}
      <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-amber-900 flex items-center gap-2">
            <Star size={14} className="text-amber-500 fill-amber-400" /> Nhóm ưu tiên
            <span className="text-xs font-normal text-amber-700">({priorityGroups.length})</span>
          </h3>
        </div>
        <p className="text-[11px] text-amber-800/70">
          Group ưu tiên sẽ được mark là tier A — nick sẽ tương tác trước những nhóm này. Dán URL group hoặc nhập fb_group_id.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={priorityInput}
            onChange={e => setPriorityInput(e.target.value)}
            placeholder="https://facebook.com/groups/123456 hoặc 123456"
            className="flex-1 px-3 py-2 border border-amber-200 rounded-lg text-sm bg-app-surface focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            onKeyDown={e => { if (e.key === 'Enter' && priorityInput.trim()) addPriorityMut.mutate(priorityInput) }}
          />
          <button
            onClick={() => addPriorityMut.mutate(priorityInput)}
            disabled={!priorityInput.trim() || addPriorityMut.isPending}
            className="flex items-center gap-1 px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
          >
            {addPriorityMut.isPending ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
            Thêm
          </button>
        </div>
        {priorityLoading ? (
          <div className="text-xs text-amber-700/70">Đang tải...</div>
        ) : priorityGroups.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {priorityGroups.map(g => (
              <div key={g.fb_group_id} className="inline-flex items-center gap-1.5 bg-app-surface border border-amber-300 rounded-full pl-3 pr-1.5 py-1 text-xs">
                <Star size={10} className="text-amber-500 fill-amber-400" />
                <a
                  href={g.url || `https://facebook.com/groups/${g.fb_group_id}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-amber-900 hover:underline font-medium max-w-[200px] truncate"
                  title={g.name || g.fb_group_id}
                >
                  {g.name || g.fb_group_id}
                </a>
                <button
                  onClick={() => removePriorityMut.mutate(g.fb_group_id)}
                  className="text-amber-400 hover:text-red-500 ml-1"
                  title="Hạ ưu tiên"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-amber-700/60 italic">Chưa có nhóm ưu tiên</div>
        )}
      </div>

      {/* Add Panel */}
      {showAdd && (
        <div className="bg-app-surface rounded border border-app-border p-4">
          <p className="text-xs text-app-muted mb-2">Moi dong 1 URL hoac ID nhom</p>
          <textarea
            value={addInput} onChange={e => setAddInput(e.target.value)} rows={4}
            className="w-full border border-app-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-3 py-2 text-sm font-mono"
            placeholder="https://facebook.com/groups/123456"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm text-app-muted">Huy</button>
            <button onClick={() => bulkAddMut.mutate(addInput)} disabled={bulkAddMut.isPending}
              className="px-4 py-1.5 bg-info text-white rounded-lg hover:opacity-90 transition-colors text-sm disabled:opacity-50">
              {bulkAddMut.isPending ? 'Dang them...' : 'Them'}
            </button>
          </div>
        </div>
      )}

      {/* Tag Filter Pills */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTagFilter('')}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              !tagFilter ? 'bg-purple-600 text-white' : 'bg-app-elevated text-app-muted hover:bg-app-elevated'
            }`}
          >
            Tat ca ({groups.length})
          </button>
          {allTags.map(tag => {
            const count = groups.filter(g => (g.tags || []).includes(tag)).length
            return (
              <button
                key={tag}
                onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  tagFilter === tag ? 'bg-purple-600 text-white' : 'bg-purple-50 text-purple-300 hover:bg-purple-100'
                }`}
              >
                #{tag} ({count})
              </button>
            )
          })}
        </div>
      )}

      {/* Phase 9: Tier filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {[
          { key: 'all', label: 'Tất cả' },
          { key: 'A', label: 'Tier A', tier: 'A' },
          { key: 'B', label: 'Tier B', tier: 'B' },
          { key: 'C', label: 'Tier C', tier: 'C' },
          { key: 'D', label: 'Tier D', tier: 'D' },
          { key: 'pending', label: 'Pending' },
          { key: 'removed', label: 'Removed' },
        ].map(t => {
          const active = tierFilter === t.key
          const count = tierCounts[t.key] || 0
          const tierCfg = t.tier ? TIER_CONFIG[t.tier] : null
          return (
            <button
              key={t.key}
              onClick={() => setTierFilter(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                active
                  ? 'bg-purple-600 text-white border-purple-600'
                  : 'bg-app-surface text-app-muted border-app-border hover:bg-app-base'
              }`}
            >
              {tierCfg && <span className={`w-2 h-2 rounded-full ${tierCfg.dot}`} />}
              {t.label}
              <span className={`px-1.5 py-0 rounded-full text-[10px] font-semibold ${
                active ? 'bg-app-surface/20 text-white' : 'bg-app-elevated text-app-muted'
              }`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-muted" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Tim theo ten, ID, tag..."
          className="w-full pl-9 pr-3 py-2 border border-app-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm" />
      </div>

      {/* Table — Phase 9 responsive */}
      {/* Grid templates:
            sm  (default):  name | tier | score | review               → 4 cols
            md  (≥768):     + nick                                      → 5 cols
            lg  (≥1024):    + last_nurtured + language                  → 7 cols
      */}
      <div className="bg-app-surface rounded border border-app-border overflow-hidden">
        <div className="grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_60px_70px_120px_60px] lg:grid-cols-[1fr_60px_80px_120px_110px_60px_60px] gap-2 px-4 py-2.5 bg-app-base border-b text-xs font-semibold text-app-muted uppercase tracking-wider">
          <div>Tên nhóm</div>
          <div>Tier</div>
          <div>Score</div>
          <div className="hidden md:block">Nick</div>
          <div className="hidden lg:block">Last nurtured</div>
          <div className="hidden lg:block">Lang</div>
          <div>Review</div>
        </div>

        {isLoading || (showAll && allLoading) ? (
          <div className="flex items-center justify-center py-12">
            <Loader size={20} className="animate-spin text-purple-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-app-muted text-sm space-y-3">
            <div>{showAll ? 'Chua co nhom nao' : 'Chua co nhom nao trong campaign. Bam "Tat ca nhom" de gan.'}</div>
            {!showAll && (
              <div className="text-red-500 font-semibold max-w-md mx-auto text-xs bg-red-50 p-3 rounded border border-red-200">
                Lưu ý: Không tự ý tìm kiếm nhóm trên Facebook để bình luận thủ công!
              </div>
            )}
          </div>
        ) : (
          filtered.slice(0, 100).map(g => {
            const aiEval = g.ai_relevance?.[topicKey]
            const tier = effectiveTier(g)
            const tierCfg = tier ? TIER_CONFIG[tier] : null
            const score = g.junction_score ?? g.global_score ?? g.ai_join_score ?? aiEval?.score ?? null
            const scorePct = score != null ? Math.max(0, Math.min(100, (Number(score) || 0) * 10)) : 0
            const langCfg = g.language ? LANG_CONFIG[g.language] : null

            const isBlacklisted = g.skip_until && new Date(g.skip_until) > new Date()
            const isRemoved = g.junction_status === 'removed'
            const isDimmed = g.user_approved === false || isBlacklisted || tier === 'D' || isRemoved

            return (
              <div
                key={g.id}
                className={`grid grid-cols-[1fr_60px_70px_60px] md:grid-cols-[1fr_60px_70px_120px_60px] lg:grid-cols-[1fr_60px_80px_120px_110px_60px_60px] gap-2 px-4 py-2.5 border-b border-app-border hover:bg-app-base transition-colors items-center text-sm ${
                  isDimmed ? 'opacity-50' : ''
                } ${isBlacklisted ? 'bg-red-50/30' : ''}`}
                title={aiEval?.reason || g.ai_note || ''}
              >
                {/* Tên nhóm */}
                <div className="min-w-0">
                  <p className="font-medium text-app-primary truncate">
                    {g.url ? (
                      <a href={g.url} target="_blank" rel="noopener noreferrer" className="hover:text-purple-700">
                        {g.name || g.fb_group_id}
                      </a>
                    ) : (g.name || g.fb_group_id)}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-[10px] text-app-dim">{g.member_count?.toLocaleString() || '?'} members</span>
                    {g.group_type && (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${TYPE_BADGE[g.group_type] || 'bg-app-elevated text-app-muted'}`}>
                        {g.group_type}
                      </span>
                    )}
                    {isManualGroup(g.fb_group_id) ? (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-50 text-blue-600 border border-blue-200">
                        Nhập tay
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-purple-50 text-purple-600 border border-purple-200">
                        Tự động
                      </span>
                    )}
                    {g.is_member ? (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-green-50 text-green-600 border border-green-200">
                        Đã tham gia
                      </span>
                    ) : g.pending_approval ? (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-50 text-amber-600 border border-amber-200">
                        Chờ duyệt
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-50 text-red-600 border border-red-200">
                        Chưa tham gia
                      </span>
                    )}
                    {isBlacklisted && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] text-red-500 font-medium bg-red-100/50">Blacklist</span>
                    )}
                  </div>
                </div>

                {/* Tier badge */}
                <div>
                  {tierCfg ? (
                    <span className={`inline-flex items-center justify-center w-7 h-6 rounded border text-[11px] font-bold ${tierCfg.badge}`}>
                      {tierCfg.label}
                    </span>
                  ) : (
                    <span className="text-[10px] text-app-dim">--</span>
                  )}
                </div>

                {/* Score + bar */}
                <div>
                  {score != null ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-app-primary font-medium">{Number(score).toFixed(1)}/10</span>
                      <div className="w-full h-1 bg-app-elevated rounded-full overflow-hidden">
                        <div
                          className={`h-full ${tierCfg?.bar || 'bg-app-hover'} transition-all`}
                          style={{ width: `${scorePct}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-[10px] text-app-dim">--</span>
                  )}
                </div>

                {/* Nick phụ trách — md+ (avatar stack for multi-nick) */}
                <div className="hidden md:flex items-center min-w-0">
                  {(g.assigned_nicks?.length || g.account_username) ? (
                    <div className="flex items-center">
                      <div className="flex -space-x-1.5">
                        {(g.assigned_nicks || [{ id: g.assigned_nick_id, username: g.account_username }]).slice(0, 4).map((n, i) => {
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
                              className={`w-6 h-6 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 text-white flex items-center justify-center text-[10px] font-bold border-2 ${borderClass} ${opacityClass} shrink-0`}
                              style={{ zIndex: 10 - i }}>
                              {(n.username || '?').substring(0, 2).toUpperCase()}
                            </div>
                          )
                        })}
                        {(g.assigned_nicks?.length || 0) > 4 && (
                          <div className="w-6 h-6 rounded-full bg-app-hover text-app-muted flex items-center justify-center text-[9px] font-bold border-2 border-white shrink-0">
                            +{g.assigned_nicks.length - 4}
                          </div>
                        )}
                      </div>
                      {(g.assigned_nicks?.length || 0) <= 2 && (
                        <span className="text-[11px] text-app-primary truncate ml-1.5">
                          {(g.assigned_nicks || [{ username: g.account_username }]).map(n => n.username).filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-[10px] text-app-dim">--</span>
                  )}
                </div>

                {/* Last nurtured — lg+ */}
                <div className="hidden lg:block">
                  {g.last_nurtured_at ? (
                    <span className="text-[11px] text-app-muted" title={new Date(g.last_nurtured_at).toLocaleString('vi-VN')}>
                      {timeAgo(g.last_nurtured_at)}
                    </span>
                  ) : (
                    <span className="text-[10px] text-app-dim italic">Chưa tương tác</span>
                  )}
                </div>

                {/* Language — lg+ */}
                <div className="hidden lg:flex items-center gap-1">
                  {langCfg ? (
                    <>
                      <span className="text-sm leading-none">{langCfg.flag}</span>
                      <span className="text-[10px] text-app-muted">{langCfg.label}</span>
                    </>
                  ) : (
                    <span className="text-[10px] text-app-dim">--</span>
                  )}
                </div>

                {/* Review */}
                <div className="flex items-center gap-1">
                  {g.user_approved === true ? (
                    <CheckCircle size={14} className="text-hermes" />
                  ) : g.user_approved === false ? (
                    <XCircle size={14} className="text-red-500" />
                  ) : (
                    <>
                      <button
                        onClick={() => reviewMut.mutate({ groupId: g.id, approved: true })}
                        className="p-0.5 text-app-dim hover:text-hermes transition-colors"
                        title="Duyet group nay"
                      >
                        <CheckCircle size={14} />
                      </button>
                      <button
                        onClick={() => reviewMut.mutate({ groupId: g.id, approved: false })}
                        className="p-0.5 text-app-dim hover:text-red-500 transition-colors"
                        title="Tu choi group nay"
                      >
                        <XCircle size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
