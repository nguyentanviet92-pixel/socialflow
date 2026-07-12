import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Search, Plus, Trash2, RefreshCw, Eye, Play, Pencil, Clock,
  ExternalLink, MessageSquare, ThumbsUp, Share2, Shield, CheckCircle,
  XCircle, AlertCircle, Loader, Radio, Filter, ChevronDown, ChevronRight,
  Square, Reply, Bot, Send, Users, CheckSquare, SquareCheck
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'
import { vi } from 'date-fns/locale'
import api from '../../lib/api'
import useAuthStore from '../../store/auth.store'

function parseGroupIdFromUrl(url) {
  if (!url) return null
  const m = url.match(/groups\/(\d+)/) || url.match(/groups\/([^/?]+)/)
  return m ? m[1] : null
}

function relTime(date) {
  if (!date) return '—'
  try { return formatDistanceToNow(new Date(date), { locale: vi, addSuffix: true }) }
  catch { return '—' }
}

function getAuthorDisplayName(item) {
  if (!item) return 'Thành viên Facebook'
  if (item.author_name && item.author_name.trim()) return item.author_name
  return 'Thành viên Facebook'
}

// Helper: Run SQL query via VPS API agent-db proxy
async function dbQuery(body) {
  const res = await api.post('/agent-db/query', body)
  if (res.data.error) throw new Error(res.data.error.message || res.data.error)
  return res.data.data || []
}

export default function ScoutDashboard() {
  const queryClient = useQueryClient()
  const user = useAuthStore(s => s.user)
  const profile = useAuthStore(s => s.profile)
  const userId = user?.id || profile?.id
  
  const [selectedTargetId, setSelectedTargetId] = useState(null)
  const [mainTab, setMainTab] = useState('posts') // 'posts' | 'replies' | 'logs'
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('latest') // 'latest' | 'hot' | 'has_comments'
  const [expandedPostId, setExpandedPostId] = useState(null)

  // Target Add/Edit Modal
  const [showAddModal, setShowAddModal] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [modalForm, setModalForm] = useState({
    name: '',
    fb_group_url: '',
    fb_group_id: '',
    scan_interval_hours: 6,
    assigned_account_ids: []
  })

  // Global Scout Config Modal
  const [showGlobalConfig, setShowGlobalConfig] = useState(false)
  const [globalConfigForm, setGlobalConfigForm] = useState({
    scout_account_ids: [],
    auto_assign: true,
    max_concurrent_scans: 2
  })

  // Reply Modal State
  const [replyTarget, setReplyTarget] = useState(null) // { type: 'post' | 'comment', post, comment, target }
  const [replyForm, setReplyForm] = useState({ account_id: '', text: '' })
  const [generatingAi, setGeneratingAi] = useState(false)

  // ─── Queries ───
  // 1. Scout Targets
  const { data: targets = [], isLoading: loadingTargets } = useQuery({
    queryKey: ['scout-targets', userId],
    queryFn: async () => {
      const filters = []
      if (userId) filters.push({ type: 'eq', column: 'user_id', value: userId })
      return await dbQuery({
        op: 'select',
        table: 'scout_targets',
        cols: '*',
        filters,
        options: { order: { column: 'created_at', ascending: false } }
      })
    },
    enabled: !!userId
  })

  // 2. ALL Facebook Accounts of THIS USER (filter by owner_id)
  const { data: allAccounts = [] } = useQuery({
    queryKey: ['my-accounts', userId],
    queryFn: async () => {
      return await dbQuery({
        op: 'select',
        table: 'accounts',
        cols: 'id, username, is_active, status',
        filters: [{ type: 'eq', column: 'owner_id', value: userId }],
        options: { order: { column: 'username', ascending: true } }
      })
    },
    enabled: !!userId
  })
  // Alias: usable accounts for dispatch (active or healthy)
  const accounts = useMemo(() => allAccounts.filter(a => a.is_active || a.status === 'healthy'), [allAccounts])

  // 2b. User Settings (for global scout_config)
  const { data: userSettings } = useQuery({
    queryKey: ['user-settings', userId],
    queryFn: async () => {
      const rows = await dbQuery({
        op: 'select',
        table: 'user_settings',
        cols: 'scout_config',
        filters: [{ type: 'eq', column: 'user_id', value: userId }]
      })
      return rows?.[0] || null
    },
    enabled: !!userId
  })
  const globalScoutConfig = useMemo(() => {
    const cfg = userSettings?.scout_config || {}
    return {
      scout_account_ids: cfg.scout_account_ids || [],
      auto_assign: cfg.auto_assign !== false,
      max_concurrent_scans: cfg.max_concurrent_scans || 2
    }
  }, [userSettings])

  // Target Map helper for quick lookup
  const targetMap = useMemo(() => {
    const map = new Map()
    targets.forEach(t => map.set(t.id, t))
    return map
  }, [targets])

  // Selected Target Object
  const selectedTarget = useMemo(() => {
    if (!selectedTargetId) return null
    return targets.find(t => t.id === selectedTargetId) || null
  }, [targets, selectedTargetId])

  // 3. Scout Posts
  const { data: posts = [], isLoading: loadingPosts } = useQuery({
    queryKey: ['scout-posts', userId, selectedTargetId],
    queryFn: async () => {
      const filters = []
      if (userId) filters.push({ type: 'eq', column: 'user_id', value: userId })
      if (selectedTargetId) filters.push({ type: 'eq', column: 'scout_target_id', value: selectedTargetId })
      return await dbQuery({
        op: 'select',
        table: 'scout_posts',
        cols: '*',
        filters,
        options: { order: { column: 'scanned_at', ascending: false }, limit: 50 }
      })
    },
    enabled: !!userId && mainTab === 'posts'
  })

  // 4. All Scout Comments grouped by post
  const { data: allComments = [], isLoading: loadingComments } = useQuery({
    queryKey: ['scout-comments', userId, selectedTargetId],
    queryFn: async () => {
      const filters = []
      if (userId) filters.push({ type: 'eq', column: 'user_id', value: userId })
      if (selectedTargetId) filters.push({ type: 'eq', column: 'scout_target_id', value: selectedTargetId })
      return await dbQuery({
        op: 'select',
        table: 'scout_comments',
        cols: '*',
        filters,
        options: { order: { column: 'scanned_at', ascending: true }, limit: 300 }
      })
    },
    enabled: !!userId && mainTab === 'posts'
  })

  // Memoized map of comments by scout_post_id
  const commentsByPostId = useMemo(() => {
    const map = new Map()
    allComments.forEach(c => {
      if (!c.scout_post_id) return
      if (!map.has(c.scout_post_id)) map.set(c.scout_post_id, [])
      map.get(c.scout_post_id).push(c)
    })
    return map
  }, [allComments])

  // 5. Scout Replies Log (Stored in SQL `scout_replies`)
  const { data: replies = [], isLoading: loadingReplies } = useQuery({
    queryKey: ['scout-replies', userId, selectedTargetId],
    queryFn: async () => {
      const filters = []
      if (userId) filters.push({ type: 'eq', column: 'user_id', value: userId })
      if (selectedTargetId) filters.push({ type: 'eq', column: 'scout_target_id', value: selectedTargetId })
      return await dbQuery({
        op: 'select',
        table: 'scout_replies',
        cols: '*',
        filters,
        options: { order: { column: 'created_at', ascending: false }, limit: 50 }
      })
    },
    enabled: !!userId && mainTab === 'replies'
  })

  // 6. Scout Job Logs
  const { data: logs = [], isLoading: loadingLogs } = useQuery({
    queryKey: ['scout-logs', userId, selectedTargetId],
    queryFn: async () => {
      const filters = []
      if (userId) filters.push({ type: 'eq', column: 'user_id', value: userId })
      if (selectedTargetId) filters.push({ type: 'eq', column: 'scout_target_id', value: selectedTargetId })
      return await dbQuery({
        op: 'select',
        table: 'scout_job_logs',
        cols: '*',
        filters,
        options: { order: { column: 'started_at', ascending: false }, limit: 50 }
      })
    },
    enabled: !!userId && mainTab === 'logs'
  })

  // 7. Active Scout Scan Jobs (pending/running/claimed)
  const { data: activeJobs = [] } = useQuery({
    queryKey: ['active-scout-jobs', userId],
    queryFn: async () => {
      return await dbQuery({
        op: 'select',
        table: 'jobs',
        cols: 'id, status, payload',
        filters: [
          { type: 'eq', column: 'type', value: 'scan_group' },
          { type: 'in', column: 'status', value: ['pending', 'running', 'claimed'] }
        ]
      })
    },
    refetchInterval: 3000,
    enabled: !!userId
  })

  // ─── Mutations ───
  const saveTargetMut = useMutation({
    mutationFn: async (formData) => {
      const groupId = formData.fb_group_id || parseGroupIdFromUrl(formData.fb_group_url)
      if (!groupId) throw new Error('Không thể xác định Group ID từ URL')

      const payloadData = {
        name: formData.name || `Nhóm ${groupId}`,
        fb_group_url: formData.fb_group_url || '',
        scan_interval_hours: parseInt(formData.scan_interval_hours) || 6,
        assigned_account_ids: JSON.stringify(formData.assigned_account_ids || [])
      }

      if (editTarget) {
        return await dbQuery({
          op: 'update',
          table: 'scout_targets',
          updates: payloadData,
          filters: [{ type: 'eq', column: 'id', value: editTarget.id }]
        })
      } else {
        return await dbQuery({
          op: 'insert',
          table: 'scout_targets',
          rows: [{
            user_id: userId,
            fb_group_id: groupId,
            is_active: true,
            last_scan_status: 'idle',
            ...payloadData
          }]
        })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scout-targets'] })
      setShowAddModal(false)
      setEditTarget(null)
      toast.success(editTarget ? 'Đã cập nhật cài đặt nhóm do thám' : 'Đã thêm nhóm do thám thành công')
    },
    onError: (err) => {
      if (err.message?.includes('idx_scout_targets_user_group') || err.message?.includes('duplicate key')) {
        toast.error('⚠️ Nhóm Facebook này đã tồn tại trong danh sách do thám của bạn!')
      } else {
        toast.error(`Lỗi: ${err.message}`)
      }
    }
  })

  const toggleActiveMut = useMutation({
    mutationFn: async (target) => {
      return await dbQuery({
        op: 'update',
        table: 'scout_targets',
        updates: { is_active: !target.is_active },
        filters: [{ type: 'eq', column: 'id', value: target.id }]
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scout-targets'] })
      toast.success('Đã cập nhật trạng thái nhóm')
    }
  })

  const deleteTargetMut = useMutation({
    mutationFn: async (id) => {
      return await dbQuery({
        op: 'delete',
        table: 'scout_targets',
        filters: [{ type: 'eq', column: 'id', value: id }]
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scout-targets'] })
      queryClient.invalidateQueries({ queryKey: ['scout-posts'] })
      queryClient.invalidateQueries({ queryKey: ['scout-logs'] })
      setSelectedTargetId(null)
      toast.success('Đã xóa nhóm do thám thành công')
    },
    onError: (err) => toast.error(`Lỗi xóa: ${err.message}`)
  })

  const triggerScanMut = useMutation({
    mutationFn: async (target) => {
      // 1. Build candidate list: per-target → global config → all user accounts
      let perTargetIds = []
      try {
        if (target.assigned_account_ids) {
          perTargetIds = typeof target.assigned_account_ids === 'string'
            ? JSON.parse(target.assigned_account_ids)
            : target.assigned_account_ids
        }
      } catch {}

      const globalIds = globalScoutConfig.scout_account_ids || []

      // Priority order: per-target assigned → global scout config → all user active accounts
      const candidateOrder = [
        ...perTargetIds,
        ...globalIds.filter(id => !perTargetIds.includes(id)),
        ...accounts.map(a => a.id).filter(id => !perTargetIds.includes(id) && !globalIds.includes(id))
      ]

      // 2. Find nicks currently busy (running/claimed jobs)
      const busyNickIds = new Set(
        activeJobs.map(j => j.payload?.account_id).filter(Boolean)
      )

      // 3. Pick first usable + not-busy nick
      let accountId = null
      let accountName = null
      for (const aid of candidateOrder) {
        const acc = allAccounts.find(a => a.id === aid)
        if (acc && (acc.is_active || acc.status === 'healthy') && !busyNickIds.has(aid)) {
          accountId = aid
          accountName = acc.username
          break
        }
      }
      // Fallback: allow busy nick if no idle nick found
      if (!accountId) {
        for (const aid of candidateOrder) {
          const acc = allAccounts.find(a => a.id === aid)
          if (acc && (acc.is_active || acc.status === 'healthy')) {
            accountId = aid
            accountName = acc.username
            break
          }
        }
      }
      if (!accountId) throw new Error('Không có Nick FB nào đang Active / Healthy để thực thi quét. Hãy vào ⚙️ Cài đặt tổng hoặc ✏️ phân công nick cho nhóm này.')

      // Update target status to pending in SQL
      await dbQuery({
        op: 'update',
        table: 'scout_targets',
        updates: {
          last_scan_status: 'pending',
          last_scanned_at: new Date().toISOString()
        },
        filters: [{ type: 'eq', column: 'id', value: target.id }]
      })

      // Insert scan job
      return await dbQuery({
        op: 'insert',
        table: 'jobs',
        rows: [{
          created_by: userId,
          type: 'scan_group',
          status: 'pending',
          payload: {
            user_id: userId,
            account_id: accountId,
            scout_target_id: target.id,
            fb_group_id: target.fb_group_id,
            fb_group_url: target.fb_group_url,
            max_posts: 20,
            max_comments_per_post: 50,
          }
        }]
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scout-targets'] })
      queryClient.invalidateQueries({ queryKey: ['active-scout-jobs'] })
      queryClient.invalidateQueries({ queryKey: ['scout-logs'] })
      toast.success('🚀 Đã giao Job quét cho Agent! Hệ thống tự chọn Nick phù hợp nhất.')
    },
    onError: (err) => toast.error(`Lỗi kích hoạt quét: ${err.message}`)
  })

  const cancelScanMut = useMutation({
    mutationFn: async ({ jobId, targetId }) => {
      if (targetId) {
        await dbQuery({
          op: 'update',
          table: 'scout_targets',
          updates: { last_scan_status: 'cancelled' },
          filters: [{ type: 'eq', column: 'id', value: targetId }]
        })
      }
      if (jobId) {
        await dbQuery({
          op: 'update',
          table: 'jobs',
          updates: { status: 'cancelled' },
          filters: [{ type: 'eq', column: 'id', value: jobId }]
        })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scout-targets'] })
      queryClient.invalidateQueries({ queryKey: ['active-scout-jobs'] })
      queryClient.invalidateQueries({ queryKey: ['scout-logs'] })
      toast.success('🛑 Đã dừng tiến trình quét và lưu trạng thái.')
    },
    onError: (err) => toast.error(`Lỗi dừng quét: ${err.message}`)
  })

  // Submit Reply Mutation (Saves into SQL scout_replies & queues Job)
  const submitReplyMut = useMutation({
    mutationFn: async ({ replyTarget, form }) => {
      if (!form.account_id) throw new Error('Vui lòng chọn Nick Facebook thực thi trả lời')
      if (!form.text.trim()) throw new Error('Vui lòng nhập nội dung câu trả lời')

      const isCommentReply = replyTarget.type === 'comment'
      const post = replyTarget.post
      const comment = replyTarget.comment

      // 1. Create Job for Agent
      const jobInsert = await dbQuery({
        op: 'insert',
        table: 'jobs',
        rows: [{
          created_by: userId,
          type: 'comment_post',
          status: 'pending',
          payload: {
            user_id: userId,
            account_id: form.account_id,
            target_id: post.post_fb_id || post.id,
            post_url: post.post_url,
            comment_fb_id: isCommentReply ? comment.comment_fb_id : null,
            content: form.text,
          }
        }]
      })

      const jobId = jobInsert?.[0]?.id || null

      // 2. Save reply permanently into SQL `scout_replies`
      return await dbQuery({
        op: 'insert',
        table: 'scout_replies',
        rows: [{
          user_id: userId,
          scout_target_id: post.scout_target_id,
          scout_post_id: post.id,
          scout_comment_id: isCommentReply ? comment.id : null,
          account_id: form.account_id,
          reply_type: isCommentReply ? 'comment' : 'post',
          reply_text: form.text,
          status: 'pending',
          job_id: jobId
        }]
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scout-replies'] })
      setReplyTarget(null)
      setReplyForm({ account_id: '', text: '' })
      toast.success('🚀 Đã lưu câu trả lời vào SQL & xếp hàng Job cho Agent!')
    },
    onError: (err) => toast.error(`Lỗi gửi trả lời: ${err.message}`)
  })

  // AI Hermes Generate Response
  const handleAiSuggest = async () => {
    if (!replyTarget) return
    const textContext = replyTarget.type === 'comment'
      ? `Bình luận của người dùng "${getAuthorDisplayName(replyTarget.comment)}": ${replyTarget.comment.content}`
      : `Bài viết Facebook của "${getAuthorDisplayName(replyTarget.post)}": ${replyTarget.post.content}`

    setGeneratingAi(true)
    try {
      const res = await api.post('/ai-hermes/generate', {
        prompt: `Hãy viết 1 câu trả lời ngắn gọn, thân thiện, tự nhiên bằng tiếng Việt để phản hồi lại bài viết/bình luận Facebook sau:\n${textContext}`
      })
      const suggestedText = res.data?.text || res.data?.result || res.data?.choices?.[0]?.message?.content || ''
      if (suggestedText) {
        setReplyForm(f => ({ ...f, text: suggestedText.trim() }))
        toast.success('🤖 AI Hermes đã sinh gợi ý câu trả lời!')
      } else {
        toast.error('Không nhận được văn bản từ AI Hermes')
      }
    } catch (err) {
      toast.error(`Lỗi gợi ý AI: ${err.message}`)
    } finally {
      setGeneratingAi(false)
    }
  }

  // Save Global Scout Config
  const saveGlobalConfigMut = useMutation({
    mutationFn: async (configData) => {
      // Upsert user_settings row
      const existing = await dbQuery({
        op: 'select',
        table: 'user_settings',
        cols: 'user_id',
        filters: [{ type: 'eq', column: 'user_id', value: userId }]
      })
      if (existing.length > 0) {
        return await dbQuery({
          op: 'update',
          table: 'user_settings',
          updates: { scout_config: configData, updated_at: new Date().toISOString() },
          filters: [{ type: 'eq', column: 'user_id', value: userId }]
        })
      } else {
        return await dbQuery({
          op: 'insert',
          table: 'user_settings',
          rows: [{ user_id: userId, scout_config: configData }]
        })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-settings'] })
      setShowGlobalConfig(false)
      toast.success('✅ Đã lưu cài đặt tổng Do Thám!')
    },
    onError: (err) => toast.error(`Lỗi lưu cài đặt: ${err.message}`)
  })

  const openGlobalConfig = () => {
    setGlobalConfigForm({
      scout_account_ids: globalScoutConfig.scout_account_ids.length > 0
        ? globalScoutConfig.scout_account_ids
        : allAccounts.filter(a => a.is_active || a.status === 'healthy').map(a => a.id),
      auto_assign: globalScoutConfig.auto_assign,
      max_concurrent_scans: globalScoutConfig.max_concurrent_scans
    })
    setShowGlobalConfig(true)
  }

  // Filtered & Sorted posts (Newsfeed Logic)
  const filteredPosts = useMemo(() => {
    let list = [...posts]

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(p =>
        (p.content && p.content.toLowerCase().includes(q)) ||
        (p.author_name && p.author_name.toLowerCase().includes(q))
      )
    }

    if (sortBy === 'hot') {
      list.sort((a, b) => (b.comment_count || b.comments_count || 0) - (a.comment_count || a.comments_count || 0))
    } else if (sortBy === 'has_comments') {
      list = list.filter(p => (p.comment_count || p.comments_count || 0) > 0)
    } else {
      // default latest
      list.sort((a, b) => new Date(b.scanned_at || 0) - new Date(a.scanned_at || 0))
    }

    return list
  }, [posts, searchQuery, sortBy])

  const openAddModal = () => {
    setEditTarget(null)
    setModalForm({
      name: '',
      fb_group_url: '',
      fb_group_id: '',
      scan_interval_hours: 6,
      assigned_account_ids: allAccounts.filter(a => a.is_active || a.status === 'healthy').map(a => a.id)
    })
    setShowAddModal(true)
  }

  const openEditModal = (target, e) => {
    e.stopPropagation()
    setEditTarget(target)
    let assigned = []
    try {
      if (target.assigned_account_ids) {
        assigned = typeof target.assigned_account_ids === 'string'
          ? JSON.parse(target.assigned_account_ids)
          : target.assigned_account_ids
      }
    } catch {}

    setModalForm({
      name: target.name || '',
      fb_group_url: target.fb_group_url || '',
      fb_group_id: target.fb_group_id || '',
      scan_interval_hours: target.scan_interval_hours || 6,
      assigned_account_ids: assigned.length > 0 ? assigned : allAccounts.filter(a => a.is_active || a.status === 'healthy').map(a => a.id)
    })
    setShowAddModal(true)
  }

  const openReplyModal = (type, post, comment = null) => {
    let assignedForTarget = []
    if (selectedTarget?.assigned_account_ids) {
      try {
        assignedForTarget = typeof selectedTarget.assigned_account_ids === 'string'
          ? JSON.parse(selectedTarget.assigned_account_ids)
          : selectedTarget.assigned_account_ids
      } catch {}
    }

    const defaultAccId = assignedForTarget?.[0] || accounts?.[0]?.id || ''
    setReplyTarget({ type, post, comment })
    setReplyForm({ account_id: defaultAccId, text: '' })
  }

  return (
    <div className="flex h-[calc(100vh-36px)] overflow-hidden bg-app-base text-app-primary">
      {/* ── LEFT SIDEBAR: Targets list ── */}
      <aside className="w-80 flex flex-col shrink-0 bg-app-surface border-r border-app">
        {/* Header */}
        <div className="p-4 border-b border-app flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Search className="w-5 h-5 text-hermes" />
            <h2 className="font-semibold text-sm tracking-tight">Do Thám Nhóm FB</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={openGlobalConfig}
              title="Cài đặt tổng — Phân công Nick chung cho tất cả nhóm"
              className="flex items-center gap-1 text-xs font-medium px-2 py-1.5 rounded border border-app text-app-muted hover:text-hermes hover:border-hermes transition-colors"
            >
              <Shield size={13} />
            </button>
            <button
              onClick={openAddModal}
              className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded bg-hermes-dim text-hermes border border-hermes-fade hover:bg-hermes hover:text-white transition-colors"
            >
              <Plus size={14} />
              Thêm nhóm
            </button>
          </div>
        </div>

        {/* Global Config Indicator */}
        {globalScoutConfig.scout_account_ids.length > 0 && (
          <div className="px-4 py-1.5 bg-hermes/5 border-b border-hermes-fade text-[10px] text-hermes font-mono-ui flex items-center gap-1.5">
            <Shield size={10} />
            <span>Cài đặt tổng: {globalScoutConfig.scout_account_ids.map(id => allAccounts.find(a => a.id === id)?.username).filter(Boolean).join(', ') || `${globalScoutConfig.scout_account_ids.length} nick`}</span>
          </div>
        )}

        {/* Targets Filter Info */}
        <div className="px-4 py-2 bg-app-elevated border-b border-app flex items-center justify-between text-[11px] text-app-muted font-mono-ui">
          <span>{targets.length} nhóm mục tiêu</span>
          {selectedTargetId && (
            <button
              onClick={() => setSelectedTargetId(null)}
              className="text-hermes hover:underline"
            >
              Xem tất cả
            </button>
          )}
        </div>

        {/* List of Targets */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loadingTargets ? (
            <div className="flex items-center justify-center py-10 text-app-muted">
              <Loader className="w-5 h-5 animate-spin" />
            </div>
          ) : targets.length === 0 ? (
            <div className="text-center py-12 px-4 text-app-muted text-xs">
              Chưa có nhóm nào được thêm vào danh sách do thám.
            </div>
          ) : (
            targets.map(target => {
              const isSelected = selectedTargetId === target.id
              const targetActiveJob = activeJobs.find(j => j.payload?.scout_target_id === target.id)

              return (
                <div
                  key={target.id}
                  onClick={() => setSelectedTargetId(target.id)}
                  className={`p-3 rounded-lg border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-app-hover border-hermes text-app-primary'
                      : 'bg-app-surface border-app hover:border-app-bright text-app-muted hover:text-app-primary'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-xs text-app-primary leading-snug truncate">
                      {target.name}
                    </div>
                    {targetActiveJob ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-ui uppercase shrink-0 bg-blue-500/20 text-blue-400 animate-pulse flex items-center gap-1 font-semibold" title="Nhiệm vụ đang giao cho Agent thực thi">
                        <Loader size={10} className="animate-spin" /> Đang quét
                      </span>
                    ) : target.is_active ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-ui uppercase shrink-0 bg-green-500/15 text-green-400 font-semibold" title="Đã bật do thám — Chờ lịch quét tự động hoặc bấm Kích hoạt ngay">
                        🟢 Đã bật do thám
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-ui uppercase shrink-0 bg-gray-500/20 text-gray-400">
                        Tắt
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 text-[11px] font-mono-ui text-app-dim truncate">
                    ID: {target.fb_group_id}
                  </div>
                  <div className="mt-0.5 text-[10px] text-app-muted flex items-center gap-1.5">
                    <Users size={10} />
                    <span>
                      {(() => {
                        let ids = []
                        try {
                          if (target.assigned_account_ids) {
                            ids = typeof target.assigned_account_ids === 'string'
                              ? JSON.parse(target.assigned_account_ids) : target.assigned_account_ids
                          }
                        } catch {}
                        if (ids.length === 0) return 'Chưa phân công nick'
                        const names = ids.map(aid => allAccounts.find(a => a.id === aid)?.username).filter(Boolean)
                        return names.length > 0 ? names.join(', ') : `${ids.length} nick được phân công`
                      })()}
                    </span>
                  </div>

                  <div className="mt-2 pt-2 border-t border-app-fade flex items-center justify-between text-[10px] text-app-muted">
                    <div className="flex items-center gap-1">
                      <Clock size={11} />
                      <span>{relTime(target.last_scanned_at)}</span>
                    </div>

                    {/* Quick actions */}
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      {targetActiveJob ? (
                        <button
                          onClick={() => cancelScanMut.mutate({ jobId: targetActiveJob.id, targetId: target.id })}
                          title="Dừng tiến trình quét"
                          disabled={cancelScanMut.isPending}
                          className="p-1 text-red-400 hover:text-red-300 transition-colors"
                        >
                          <Square size={12} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          onClick={() => triggerScanMut.mutate(target)}
                          title="Giao Job quét cho Agent chạy ngay"
                          disabled={triggerScanMut.isPending}
                          className="p-1 hover:text-hermes transition-colors"
                        >
                          <Play size={12} />
                        </button>
                      )}
                      <button
                        onClick={e => openEditModal(target, e)}
                        title="Sửa & Phân công Agent"
                        className="p-1 hover:text-app-primary transition-colors"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => toggleActiveMut.mutate(target)}
                        title={target.is_active ? 'Tắt chế độ tự động' : 'Bật chế độ tự động'}
                        className="p-1 hover:text-warn transition-colors"
                      >
                        <Radio size={12} />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Xóa nhóm "${target.name}"?`)) deleteTargetMut.mutate(target.id)
                        }}
                        title="Xóa"
                        className="p-1 hover:text-danger transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* ── MAIN CONTENT AREA ── */}
      <main className="flex-1 flex flex-col min-w-0 bg-app-base">
        {/* Main Header / Tabs */}
        <div className="px-6 py-4 border-b border-app flex items-center justify-between bg-app-surface">
          <div>
            <h1 className="text-base font-semibold text-app-primary">
              {selectedTarget ? selectedTarget.name : 'Tất cả nhóm Do Thám'}
            </h1>
            <p className="text-xs text-app-muted mt-0.5">
              {selectedTarget
                ? `FB Group ID: ${selectedTarget.fb_group_id} · Tần suất: ${selectedTarget.scan_interval_hours}h/lần`
                : 'Giám sát và thu thập thông minh từ các Facebook Groups mục tiêu'}
            </p>
            {selectedTarget && (() => {
              let ids = []
              try {
                if (selectedTarget.assigned_account_ids) {
                  ids = typeof selectedTarget.assigned_account_ids === 'string'
                    ? JSON.parse(selectedTarget.assigned_account_ids) : selectedTarget.assigned_account_ids
                }
              } catch {}
              const names = ids.map(aid => {
                const a = allAccounts.find(x => x.id === aid)
                if (!a) return null
                return `${a.username}${a.status === 'healthy' ? '' : ` (${a.status})`}`
              }).filter(Boolean)
              return names.length > 0 ? (
                <p className="text-[11px] text-app-dim mt-0.5 flex items-center gap-1">
                  <Users size={11} className="text-hermes" />
                  <span>Nick phân công: {names.join(', ')}</span>
                </p>
              ) : (
                <p className="text-[11px] text-warn mt-0.5 flex items-center gap-1">
                  <Users size={11} />
                  <span>⚠️ Chưa phân công Nick nào — Bấm ✏️ để cài đặt</span>
                </p>
              )
            })()}
          </div>

          <div className="flex items-center gap-3">
            {selectedTarget && (() => {
              const activeJob = activeJobs.find(j => j.payload?.scout_target_id === selectedTarget.id)
              if (activeJob) {
                return (
                  <button
                    onClick={() => cancelScanMut.mutate({ jobId: activeJob.id, targetId: selectedTarget.id })}
                    disabled={cancelScanMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-red-600/90 text-white hover:bg-red-700 transition-colors shadow-sm"
                  >
                    <Loader size={13} className="animate-spin text-white" />
                    <span>Dừng quét ({activeJob.status})</span>
                  </button>
                )
              }
              return (
                <button
                  onClick={() => triggerScanMut.mutate(selectedTarget)}
                  disabled={triggerScanMut.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-hermes text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                  title="Giao Job cho Agent thực thi quét ngay tức thì"
                >
                  {triggerScanMut.isPending ? <Loader size={13} className="animate-spin" /> : <Play size={13} />}
                  <span>Kích hoạt quét ngay</span>
                </button>
              )
            })()}

            <div className="flex bg-app-elevated p-1 rounded-lg border border-app text-xs font-medium">
              <button
                onClick={() => setMainTab('posts')}
                className={`px-3 py-1 rounded transition-colors ${
                  mainTab === 'posts' ? 'bg-hermes text-white' : 'text-app-muted hover:text-app-primary'
                }`}
              >
                📰 Bài viết thu thập ({posts.length})
              </button>
              <button
                onClick={() => setMainTab('replies')}
                className={`px-3 py-1 rounded transition-colors ${
                  mainTab === 'replies' ? 'bg-hermes text-white' : 'text-app-muted hover:text-app-primary'
                }`}
              >
                💬 Lịch sử trả lời
              </button>
              <button
                onClick={() => setMainTab('logs')}
                className={`px-3 py-1 rounded transition-colors ${
                  mainTab === 'logs' ? 'bg-hermes text-white' : 'text-app-muted hover:text-app-primary'
                }`}
              >
                📋 Lịch sử quét
              </button>
            </div>
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {mainTab === 'posts' ? (
            <div className="space-y-4">
              {/* Newsfeed Stats & Filter Header */}
              <div className="bg-app-surface border border-app rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquare size={16} className="text-hermes" />
                    <span className="font-semibold text-xs text-app-primary">
                      {selectedTarget ? `Bảng tin: ${selectedTarget.name}` : '🌐 Bảng Tin Do Thám Tổng Hợp (Tất cả Nhóm)'}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono-ui bg-hermes-dim text-hermes font-semibold">
                      {filteredPosts.length} bài viết
                    </span>
                  </div>

                  {/* Sort Controls */}
                  <div className="flex items-center gap-1.5 bg-app-elevated p-1 rounded-lg border border-app text-xs">
                    <button
                      onClick={() => setSortBy('latest')}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1 ${
                        sortBy === 'latest' ? 'bg-hermes text-white font-semibold' : 'text-app-muted hover:text-app-primary'
                      }`}
                    >
                      <Clock size={11} /> Mới nhất
                    </button>
                    <button
                      onClick={() => setSortBy('hot')}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1 ${
                        sortBy === 'hot' ? 'bg-hermes text-white font-semibold' : 'text-app-muted hover:text-app-primary'
                      }`}
                    >
                      🔥 Sôi nổi nhất
                    </button>
                    <button
                      onClick={() => setSortBy('has_comments')}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1 ${
                        sortBy === 'has_comments' ? 'bg-hermes text-white font-semibold' : 'text-app-muted hover:text-app-primary'
                      }`}
                    >
                      💬 Có bình luận
                    </button>
                  </div>
                </div>

                {/* Search Bar */}
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-app-muted" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Tìm kiếm nội dung bài viết, từ khóa hoặc tên tác giả..."
                      className="w-full pl-9 pr-4 py-2 bg-app-elevated border border-app rounded-lg text-xs text-app-primary focus:outline-none focus:border-hermes"
                    />
                  </div>
                  <button
                    onClick={() => queryClient.invalidateQueries({ queryKey: ['scout-posts'] })}
                    className="p-2 bg-app-elevated border border-app rounded-lg text-app-muted hover:text-app-primary transition-colors"
                    title="Tải lại bảng tin"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
              </div>

              {/* Posts Feed */}
              {loadingPosts ? (
                <div className="flex items-center justify-center py-16 text-app-muted">
                  <Loader className="w-6 h-6 animate-spin" />
                </div>
              ) : filteredPosts.length === 0 ? (
                <div className="text-center py-16 bg-app-surface rounded-xl border border-app text-app-muted text-sm space-y-2">
                  <p className="font-medium text-app-primary">Chưa có bài viết nào trong bảng tin.</p>
                  <p className="text-xs text-app-muted">Bấm "Kích hoạt quét ngay" ở sidebar để cào bài mới từ các nhóm Facebook.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredPosts.map(post => {
                    const isExpanded = expandedPostId === post.id
                    const authorName = getAuthorDisplayName(post)
                    const targetGroup = targetMap.get(post.scout_target_id)
                    const commentCount = post.comment_count || post.comments_count || 0
                    const reactionCount = post.reaction_count || post.reactions_count || 0
                    const isHot = commentCount >= 3 || reactionCount >= 5

                    return (
                      <div
                        key={post.id}
                        className="bg-app-surface border border-app rounded-xl p-5 hover:border-app-bright transition-all shadow-sm space-y-3"
                      >
                        {/* Group Badge Header */}
                        <div className="flex items-center justify-between pb-2.5 border-b border-app-fade text-[11px] font-mono-ui">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-blue-500/15 text-blue-400 font-semibold flex items-center gap-1">
                              📍 {targetGroup ? targetGroup.name : `Group ID: ${post.fb_group_id || 'Do Thám'}`}
                            </span>
                            {isHot && (
                              <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 font-semibold flex items-center gap-0.5">
                                🔥 Sôi nổi
                              </span>
                            )}
                          </div>
                          <span className="text-app-muted">
                            Quét: {format(new Date(post.scanned_at), 'HH:mm dd/MM/yyyy')}
                          </span>
                        </div>

                        {/* Author & Action Header */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-hermes-dim text-hermes font-semibold flex items-center justify-center text-sm shadow-inner">
                              {authorName.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-semibold text-sm text-app-primary flex items-center gap-2">
                                {post.author_url ? (
                                  <a href={post.author_url} target="_blank" rel="noreferrer" className="hover:underline hover:text-hermes">
                                    {authorName}
                                  </a>
                                ) : (
                                  <span>{authorName}</span>
                                )}

                                {post.author_badge && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1">
                                    ⭐ {post.author_badge}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-app-muted">
                                {relTime(post.scanned_at)}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => openReplyModal('post', post)}
                              className="px-3 py-1.5 rounded bg-hermes text-white hover:opacity-90 transition-opacity text-xs font-medium flex items-center gap-1.5 shadow-sm"
                            >
                              <Reply size={13} /> Trả lời bài viết
                            </button>
                            {post.post_url && (
                              <a
                                href={post.post_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-app-muted hover:text-hermes flex items-center gap-1 p-1.5 rounded hover:bg-app-elevated transition-colors"
                              >
                                Xem FB <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                        </div>

                        {/* Post Content */}
                        <div className="text-sm text-app-primary whitespace-pre-line leading-relaxed pl-1">
                          {post.content}
                        </div>

                        {/* Nested Comments Block (Facebook Style — Always visible per post) */}
                        {(() => {
                          const postComments = commentsByPostId.get(post.id) || []
                          const isExpanded = expandedPostId === post.id
                          const visibleComments = isExpanded ? postComments : postComments.slice(0, 3)

                          return (
                            <div className="pt-3 border-t border-app space-y-3">
                              {/* Social Bar Metrics */}
                              <div className="flex items-center justify-between text-xs text-app-muted">
                                <div className="flex items-center gap-4">
                                  <span className="flex items-center gap-1 font-mono-ui">
                                    <ThumbsUp size={13} className="text-blue-400" /> {reactionCount}
                                  </span>
                                  <span className="flex items-center gap-1 font-mono-ui font-medium text-app-primary">
                                    <MessageSquare size={13} className="text-green-400" /> {postComments.length || commentCount} bình luận
                                  </span>
                                  <span className="flex items-center gap-1 font-mono-ui">
                                    <Share2 size={13} className="text-purple-400" /> {post.shares_count || 0}
                                  </span>
                                </div>

                                {postComments.length > 3 && (
                                  <button
                                    onClick={() => setExpandedPostId(isExpanded ? null : post.id)}
                                    className="flex items-center gap-1 text-hermes font-medium hover:underline text-xs"
                                  >
                                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    {isExpanded ? 'Thu gọn bình luận' : `Xem tất cả ${postComments.length} bình luận`}
                                  </button>
                                )}
                              </div>

                              {/* Nested Comments List */}
                              {postComments.length > 0 && (
                                <div className="bg-app-elevated rounded-lg p-3 space-y-2.5 border border-app-fade">
                                  <div className="text-[11px] font-semibold text-app-muted uppercase font-mono-ui flex items-center gap-1.5 border-b border-app-fade pb-1.5">
                                    <MessageSquare size={11} className="text-hermes" />
                                    <span>Bình luận thành viên ({postComments.length})</span>
                                  </div>

                                  <div className="space-y-2">
                                    {visibleComments.map(c => {
                                      const cAuthor = getAuthorDisplayName(c)
                                      const rawContent = (c.content || '').trim()
                                      const displayContent = (rawContent && rawContent !== cAuthor) ? rawContent : '(Bình luận dạng Sticker / Tag tên)'
                                      const reactions = c.reaction_count || c.likes_count || 0

                                      return (
                                        <div key={c.id} className="p-2.5 bg-app-surface rounded-md border border-app text-xs space-y-1">
                                          <div className="flex items-center justify-between text-app-muted text-[11px]">
                                            <div className="flex items-center gap-2">
                                              <div className="w-5 h-5 rounded-full bg-hermes-dim text-hermes font-semibold flex items-center justify-center text-[10px]">
                                                {cAuthor.charAt(0).toUpperCase()}
                                              </div>
                                              <span className="font-semibold text-app-primary">{cAuthor}</span>
                                              {c.author_badge && (
                                                <span className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                                                  ⭐ {c.author_badge}
                                                </span>
                                              )}
                                            </div>

                                            <button
                                              onClick={() => openReplyModal('comment', post, c)}
                                              className="text-[11px] text-hermes hover:underline flex items-center gap-1 font-medium px-2 py-0.5 rounded bg-hermes/10 hover:bg-hermes/20 transition-colors"
                                            >
                                              <Reply size={11} /> ↩ Trả lời bình luận này
                                            </button>
                                          </div>

                                          <div className="text-app-primary leading-snug pl-7 whitespace-pre-wrap">{displayContent}</div>

                                          {reactions > 0 && (
                                            <div className="pl-7 text-[10px] text-app-muted flex items-center gap-1 pt-0.5 font-mono-ui">
                                              <ThumbsUp size={10} className="text-blue-400" /> {reactions}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : mainTab === 'replies' ? (
            /* ── TAB 2: REPLIES LOG (Stored in SQL scout_replies) ── */
            <div className="space-y-4">
              <div className="bg-app-surface border border-app rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-app-elevated border-b border-app text-app-muted uppercase font-mono-ui">
                    <tr>
                      <th className="p-3">Loại</th>
                      <th className="p-3">Nội dung trả lời</th>
                      <th className="p-3">Nick FB thực thi</th>
                      <th className="p-3">Thời gian</th>
                      <th className="p-3">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app">
                    {loadingReplies ? (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-app-muted">
                          <Loader size={20} className="animate-spin mx-auto" />
                        </td>
                      </tr>
                    ) : replies.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-app-muted">
                          Chưa có lịch sử câu trả lời nào được gửi.
                        </td>
                      </tr>
                    ) : (
                      replies.map(r => {
                        const acc = accounts.find(a => a.id === r.account_id)
                        return (
                          <tr key={r.id} className="hover:bg-app-hover">
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold font-mono-ui ${
                                r.reply_type === 'comment' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'
                              }`}>
                                {r.reply_type === 'comment' ? 'Bình luận' : 'Bài viết'}
                              </span>
                            </td>
                            <td className="p-3 font-medium text-app-primary max-w-md truncate" title={r.reply_text}>
                              {r.reply_text}
                            </td>
                            <td className="p-3 font-mono-ui text-app-muted">
                              {acc ? acc.username : r.account_id?.slice(0, 8)}
                            </td>
                            <td className="p-3 text-app-muted font-mono-ui">
                              {format(new Date(r.created_at), 'HH:mm dd/MM')}
                            </td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold font-mono-ui ${
                                r.status === 'sent' || r.status === 'done'
                                  ? 'bg-green-500/15 text-green-400'
                                  : r.status === 'failed'
                                    ? 'bg-red-500/15 text-red-400'
                                    : 'bg-yellow-500/15 text-yellow-400'
                              }`}>
                                {r.status}
                              </span>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* ── TAB 3: LOGS ── */
            <div className="space-y-4">
              <div className="bg-app-surface border border-app rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-app-elevated border-b border-app text-app-muted uppercase font-mono-ui">
                    <tr>
                      <th className="p-3">Nhóm Target</th>
                      <th className="p-3">Thời gian</th>
                      <th className="p-3">Bài tìm thấy</th>
                      <th className="p-3">Bài mới</th>
                      <th className="p-3">Bình luận</th>
                      <th className="p-3">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app">
                    {loadingLogs ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-app-muted">
                          <Loader size={20} className="animate-spin mx-auto" />
                        </td>
                      </tr>
                    ) : logs.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-app-muted">
                          Chưa có lịch sử quét nào.
                        </td>
                      </tr>
                    ) : (
                      logs.map(log => (
                        <tr key={log.id} className="hover:bg-app-hover font-mono-ui">
                          <td className="p-3 font-medium text-app-primary">
                            {log.scout_target_id || 'Nhóm do thám'}
                          </td>
                          <td className="p-3 text-app-muted">
                            {format(new Date(log.started_at), 'HH:mm dd/MM')}
                          </td>
                          <td className="p-3">{log.posts_found || 0}</td>
                          <td className="p-3 font-semibold text-green-400">+{log.posts_new || 0}</td>
                          <td className="p-3">{log.comments_collected || 0}</td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold ${
                              log.status === 'done'
                                ? 'bg-green-500/15 text-green-400'
                                : log.status === 'failed'
                                  ? 'bg-red-500/15 text-red-400'
                                  : 'bg-blue-500/15 text-blue-400'
                            }`}>
                              {log.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ── MODAL 1: Add/Edit Target + Assign Agent ── */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-app-surface border border-app rounded-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-semibold text-app-primary">
              {editTarget ? 'Chỉnh sửa & Phân công Agent' : 'Thêm Nhóm Do Thám Mới'}
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-app-muted mb-1 font-medium">Tên nhóm / Ghi chú</label>
                <input
                  type="text"
                  value={modalForm.name}
                  onChange={e => setModalForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Ví dụ: Nhóm Bất Động Sản Hà Nội"
                  className="w-full px-3 py-2 bg-app-elevated border border-app rounded text-app-primary focus:outline-none focus:border-hermes"
                />
              </div>

              <div>
                <label className="block text-app-muted mb-1 font-medium">Link / URL Group Facebook</label>
                <input
                  type="text"
                  value={modalForm.fb_group_url}
                  onChange={e => setModalForm(f => ({ ...f, fb_group_url: e.target.value }))}
                  placeholder="https://facebook.com/groups/123456789"
                  className="w-full px-3 py-2 bg-app-elevated border border-app rounded text-app-primary focus:outline-none focus:border-hermes"
                />
              </div>

              <div>
                <label className="block text-app-muted mb-1 font-medium">Group ID (nếu có)</label>
                <input
                  type="text"
                  value={modalForm.fb_group_id}
                  onChange={e => setModalForm(f => ({ ...f, fb_group_id: e.target.value }))}
                  placeholder="123456789 (tự lấy từ URL nếu trống)"
                  className="w-full px-3 py-2 bg-app-elevated border border-app rounded text-app-primary focus:outline-none focus:border-hermes"
                />
              </div>

              <div>
                <label className="block text-app-muted mb-1 font-medium">Tần suất tự động quét (Giờ)</label>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={modalForm.scan_interval_hours}
                  onChange={e => setModalForm(f => ({ ...f, scan_interval_hours: e.target.value }))}
                  className="w-full px-3 py-2 bg-app-elevated border border-app rounded text-app-primary focus:outline-none focus:border-hermes"
                />
              </div>

              {/* Account / Agent Assignment Selection */}
              <div className="pt-2 border-t border-app">
                <label className="block text-app-muted mb-1.5 font-medium flex items-center justify-between">
                  <span>🤖 Chọn Nick FB / Agent thực thi nhóm này:</span>
                  <span className="text-[10px] text-hermes">{modalForm.assigned_account_ids.length}/{allAccounts.length} nick đã chọn</span>
                </label>

                {allAccounts.length === 0 ? (
                  <div className="text-xs text-warn p-2 bg-warn/10 rounded">
                    Chưa có tài khoản Facebook nào. Vui lòng kết nối tài khoản ở mục Quản Lý Tài Khoản.
                  </div>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto p-2 bg-app-elevated rounded border border-app">
                    {/* Quick select/deselect all */}
                    <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-app-fade text-[10px] text-app-muted">
                      <button
                        type="button"
                        onClick={() => setModalForm(f => ({ ...f, assigned_account_ids: allAccounts.map(a => a.id) }))}
                        className="text-hermes hover:underline"
                      >
                        Chọn tất cả
                      </button>
                      <button
                        type="button"
                        onClick={() => setModalForm(f => ({ ...f, assigned_account_ids: [] }))}
                        className="text-app-muted hover:text-danger hover:underline"
                      >
                        Bỏ chọn tất cả
                      </button>
                    </div>
                    {allAccounts.map(acc => {
                      const isChecked = modalForm.assigned_account_ids.includes(acc.id)
                      const isHealthy = acc.status === 'healthy'
                      const isActive = acc.is_active
                      const statusLabel = isHealthy ? '🟢 healthy' : acc.status === 'expired' ? '🔴 expired' : `⚪ ${acc.status || 'unknown'}`
                      return (
                        <label key={acc.id} className={`flex items-center gap-2 cursor-pointer hover:bg-app-surface p-1.5 rounded transition-colors ${!isHealthy && !isActive ? 'opacity-60' : ''}`}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={e => {
                              if (e.target.checked) {
                                setModalForm(f => ({ ...f, assigned_account_ids: [...f.assigned_account_ids, acc.id] }))
                              } else {
                                setModalForm(f => ({ ...f, assigned_account_ids: f.assigned_account_ids.filter(id => id !== acc.id) }))
                              }
                            }}
                            className="rounded border-app text-hermes focus:ring-0"
                          />
                          <span className="text-xs text-app-primary font-medium flex-1">{acc.username || acc.id}</span>
                          <span className={`text-[10px] font-mono-ui px-1.5 py-0.5 rounded ${
                            isHealthy ? 'bg-green-500/15 text-green-400' : acc.status === 'expired' ? 'bg-red-500/15 text-red-400' : 'bg-gray-500/15 text-gray-400'
                          }`}>
                            {statusLabel}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-app">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded text-xs font-medium text-app-muted hover:text-app-primary"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => saveTargetMut.mutate(modalForm)}
                disabled={saveTargetMut.isPending}
                className="px-4 py-2 rounded text-xs font-medium bg-hermes text-white hover:opacity-90 disabled:opacity-50"
              >
                {saveTargetMut.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL 2: Direct Reply (Post / Comment Reply) ── */}
      {replyTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-app-surface border border-app rounded-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-app pb-3">
              <h3 className="text-base font-semibold text-app-primary flex items-center gap-2">
                <Reply className="text-hermes" size={18} />
                {replyTarget.type === 'comment' ? 'Trả lời bình luận của User' : 'Trả lời Bài viết'}
              </h3>
              <button
                onClick={() => setReplyTarget(null)}
                className="text-app-muted hover:text-app-primary text-sm"
              >
                ✕
              </button>
            </div>

            {/* Preview Box */}
            <div className="p-3 bg-app-elevated border border-app rounded-lg text-xs space-y-1">
              <div className="font-semibold text-hermes">
                {replyTarget.type === 'comment'
                  ? `Bình luận của ${getAuthorDisplayName(replyTarget.comment)}:`
                  : `Bài viết của ${getAuthorDisplayName(replyTarget.post)}:`}
              </div>
              <div className="text-app-primary line-clamp-3 leading-relaxed">
                {replyTarget.type === 'comment' ? replyTarget.comment.content : replyTarget.post.content}
              </div>
            </div>

            {/* Form */}
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-app-muted mb-1 font-medium">Chọn Nick Facebook thực thi:</label>
                <select
                  value={replyForm.account_id}
                  onChange={e => setReplyForm(f => ({ ...f, account_id: e.target.value }))}
                  className="w-full px-3 py-2 bg-app-elevated border border-app rounded text-app-primary focus:outline-none focus:border-hermes"
                >
                  <option value="">-- Chọn Nick Facebook --</option>
                  {allAccounts.map(acc => {
                    const isUsable = acc.is_active || acc.status === 'healthy'
                    return (
                      <option key={acc.id} value={acc.id} disabled={!isUsable}>
                        {acc.username || acc.id} {isUsable ? '🟢' : `🔴 (${acc.status || 'inactive'})`}
                      </option>
                    )
                  })}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-app-muted font-medium">Nội dung câu trả lời:</label>
                  <button
                    type="button"
                    onClick={handleAiSuggest}
                    disabled={generatingAi}
                    className="text-[11px] text-hermes hover:underline flex items-center gap-1 font-medium disabled:opacity-50"
                  >
                    {generatingAi ? <Loader size={12} className="animate-spin" /> : <Bot size={12} />}
                    <span>🤖 AI Hermes gợi ý câu trả lời</span>
                  </button>
                </div>
                <textarea
                  rows={4}
                  value={replyForm.text}
                  onChange={e => setReplyForm(f => ({ ...f, text: e.target.value }))}
                  placeholder="Nhập câu trả lời hoặc sử dụng AI gợi ý..."
                  className="w-full px-3 py-2 bg-app-elevated border border-app rounded text-app-primary focus:outline-none focus:border-hermes"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-app">
              <button
                type="button"
                onClick={() => setReplyTarget(null)}
                className="px-4 py-2 rounded text-xs font-medium text-app-muted hover:text-app-primary"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => submitReplyMut.mutate({ replyTarget, form: replyForm })}
                disabled={submitReplyMut.isPending}
                className="px-4 py-2 rounded text-xs font-medium bg-hermes text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
              >
                {submitReplyMut.isPending ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
                <span>Gửi trả lời & Lưu SQL</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL 3: Global Scout Config (Cài đặt tổng do thám per user) ── */}
      {showGlobalConfig && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-app-surface border border-app rounded-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-app pb-3">
              <h3 className="text-base font-semibold text-app-primary flex items-center gap-2">
                <Shield className="text-hermes" size={18} />
                Cài Đặt Tổng Do Thám
              </h3>
              <button
                onClick={() => setShowGlobalConfig(false)}
                className="text-app-muted hover:text-app-primary text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-app-muted leading-relaxed">
              Cấu hình danh sách Nick Facebook mặc định để hệ thống tự động điều phối & phân công Job cào bài khi quét các Group do thám của bạn.
            </p>

            <div className="space-y-4 text-xs">
              {/* Account / Agent Selection */}
              <div>
                <label className="block text-app-muted mb-1.5 font-medium flex items-center justify-between">
                  <span>🤖 Chọn Pool Nick FB Do Thám Mặc Định:</span>
                  <span className="text-[10px] text-hermes">{globalConfigForm.scout_account_ids.length}/{allAccounts.length} nick</span>
                </label>

                {allAccounts.length === 0 ? (
                  <div className="text-xs text-warn p-2 bg-warn/10 rounded">
                    Chưa có tài khoản Facebook nào thuộc quyền sở hữu của bạn.
                  </div>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto p-2 bg-app-elevated rounded border border-app">
                    <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-app-fade text-[10px] text-app-muted">
                      <button
                        type="button"
                        onClick={() => setGlobalConfigForm(f => ({ ...f, scout_account_ids: allAccounts.map(a => a.id) }))}
                        className="text-hermes hover:underline"
                      >
                        Chọn tất cả nick của tôi
                      </button>
                      <button
                        type="button"
                        onClick={() => setGlobalConfigForm(f => ({ ...f, scout_account_ids: [] }))}
                        className="text-app-muted hover:text-danger hover:underline"
                      >
                        Bỏ chọn tất cả
                      </button>
                    </div>

                    {allAccounts.map(acc => {
                      const isChecked = globalConfigForm.scout_account_ids.includes(acc.id)
                      const isHealthy = acc.status === 'healthy'
                      const isActive = acc.is_active
                      const statusLabel = isHealthy ? '🟢 healthy' : acc.status === 'expired' ? '🔴 expired' : `⚪ ${acc.status || 'unknown'}`
                      return (
                        <label key={acc.id} className={`flex items-center gap-2 cursor-pointer hover:bg-app-surface p-1.5 rounded transition-colors ${!isHealthy && !isActive ? 'opacity-60' : ''}`}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={e => {
                              if (e.target.checked) {
                                setGlobalConfigForm(f => ({ ...f, scout_account_ids: [...f.scout_account_ids, acc.id] }))
                              } else {
                                setGlobalConfigForm(f => ({ ...f, scout_account_ids: f.scout_account_ids.filter(id => id !== acc.id) }))
                              }
                            }}
                            className="rounded border-app text-hermes focus:ring-0"
                          />
                          <span className="text-xs text-app-primary font-medium flex-1">{acc.username || acc.id}</span>
                          <span className={`text-[10px] font-mono-ui px-1.5 py-0.5 rounded ${
                            isHealthy ? 'bg-green-500/15 text-green-400' : acc.status === 'expired' ? 'bg-red-500/15 text-red-400' : 'bg-gray-500/15 text-gray-400'
                          }`}>
                            {statusLabel}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Auto assign toggle */}
              <div className="p-3 bg-app-elevated border border-app rounded-lg flex items-center justify-between">
                <div>
                  <div className="font-medium text-app-primary">Tự động điều phối thông minh</div>
                  <div className="text-[11px] text-app-muted mt-0.5">
                    Hệ thống sẽ tự chọn Nick đang rảnh & khỏe mạnh trong pool của bạn để giao Job.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={globalConfigForm.auto_assign}
                  onChange={e => setGlobalConfigForm(f => ({ ...f, auto_assign: e.target.checked }))}
                  className="rounded border-app text-hermes focus:ring-0 w-4 h-4 cursor-pointer"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-app">
              <button
                type="button"
                onClick={() => setShowGlobalConfig(false)}
                className="px-4 py-2 rounded text-xs font-medium text-app-muted hover:text-app-primary"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => saveGlobalConfigMut.mutate(globalConfigForm)}
                disabled={saveGlobalConfigMut.isPending}
                className="px-4 py-2 rounded text-xs font-medium bg-hermes text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
              >
                {saveGlobalConfigMut.isPending ? <Loader size={14} className="animate-spin" /> : <Shield size={14} />}
                <span>Lưu Cài Đặt Tổng</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
