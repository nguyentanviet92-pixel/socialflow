import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  X, Send, Sparkles, Loader, MessageCircle, Heart, Share2,
  Globe, Users, ExternalLink, ChevronDown, RefreshCw,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { formatDistanceToNow } from 'date-fns'
import { vi } from 'date-fns/locale'

const TONES = [
  { key: 'auto', label: 'Tu dong' },
  { key: 'professional', label: 'Chuyen nghiep' },
  { key: 'friendly', label: 'Than thien' },
  { key: 'funny', label: 'Hai huoc' },
]

export default function ReplyModal({ post, onClose }) {
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [tone, setTone] = useState('auto')
  const [generating, setGenerating] = useState(false)
  const [sending, setSending] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [showAccountPicker, setShowAccountPicker] = useState(false)

  // Fetch FB accounts
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get('/accounts').then(r => r.data),
  })

  // Auto-select first healthy account
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccountId) {
      const healthy = accounts.find(a => a.status === 'healthy') || accounts[0]
      setSelectedAccountId(healthy.id)
    }
  }, [accounts, selectedAccountId])

  const generateReply = async () => {
    setGenerating(true)
    try {
      const res = await api.post('/monitoring/generate-reply', {
        content_text: post.content_text,
        author_name: post.author_name,
        source_name: post.source_name,
        tone,
      })
      setComment(res.data.comment || '')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Loi tao comment AI')
    } finally {
      setGenerating(false)
    }
  }

  // Check if post has a valid URL for commenting
  const hasValidUrl = post.post_url && !post.post_url.match(/\/groups\/[^/]+\/?$/) && !post.fb_post_id?.startsWith('mobile_')

  const handleSend = async () => {
    if (!comment.trim()) return toast.error('Nhap noi dung comment')
    if (!selectedAccountId) return toast.error('Chon tai khoan Facebook')
    if (!post.post_url && !post.fb_post_id) return toast.error('Khong co URL bai viet')
    if (!hasValidUrl) return toast.error('Bai viet khong co URL chinh xac. Thu fetch lai bang Cookie.')

    setSending(true)
    try {
      // Save post to DB first
      await api.post('/monitoring/save-post', {
        source_id: post.source_id,
        fb_post_id: post.fb_post_id,
        author_name: post.author_name,
        content_text: post.content_text,
        post_url: post.post_url,
        image_url: post.image_url,
        reactions: post.reactions,
        comments: post.comments,
        shares: post.shares,
        posted_at: post.posted_at,
      })

      // Create agent job to comment via browser
      const jobRes = await api.post('/jobs', {
        type: 'comment_post',
        payload: {
          account_id: selectedAccountId,
          post_url: post.post_url,
          fb_post_id: post.fb_post_id,
          comment_text: comment.trim(),
          source_name: post.source_name,
        },
      })

      // Save comment log to DB
      await api.post('/monitoring/comment-log', {
        job_id: jobRes.data?.id,
        account_id: selectedAccountId,
        fb_post_id: post.fb_post_id,
        post_url: post.post_url,
        source_name: post.source_name,
        comment_text: comment.trim(),
      }).catch(() => {}) // best effort

      queryClient.invalidateQueries({ queryKey: ['comment-jobs'] })
      toast.success('Da tao job comment! Agent se thuc hien.')
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Loi tao job')
    } finally {
      setSending(false)
    }
  }

  const selectedAccount = accounts.find(a => a.id === selectedAccountId)
  const fmtNum = (n) => {
    if (!n) return '0'
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
    return String(n)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-app-surface rounded w-full max-w-lg  max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
          <div className="flex items-center gap-2">
            <MessageCircle size={18} className="text-blue-600" />
            <h2 className="text-base font-bold text-app-primary">Tra loi bai viet</h2>
          </div>
          <button onClick={onClose} className="text-app-dim hover:text-app-muted p-1">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {/* Original post preview */}
          <div className="bg-app-base rounded p-3.5">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-app-hover flex items-center justify-center shrink-0">
                {post.source_type === 'group' ? <Users size={13} className="text-app-muted" /> : <Globe size={13} className="text-app-muted" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-app-primary truncate">{post.source_name || '—'}</span>
                  {post.author_name && <span className="text-xs text-app-muted">· {post.author_name}</span>}
                </div>
                {post.posted_at && (
                  <span className="text-xs text-app-dim">
                    {formatDistanceToNow(new Date(post.posted_at), { addSuffix: true, locale: vi })}
                  </span>
                )}
              </div>
              {post.post_url && (
                <a href={post.post_url} target="_blank" rel="noopener noreferrer" className="text-app-dim hover:text-blue-500 shrink-0">
                  <ExternalLink size={13} />
                </a>
              )}
            </div>
            <p className="text-sm text-app-primary whitespace-pre-line leading-relaxed line-clamp-6">
              {post.content_text}
            </p>
            {post.image_url && (
              <img src={post.image_url} className="mt-2 rounded-lg max-h-32 object-cover w-full" loading="lazy" alt="" />
            )}
            <div className="flex items-center gap-4 mt-2 pt-2 border-t border-app-border">
              <span className="flex items-center gap-1 text-xs text-app-muted">
                <Heart size={11} className="text-red-400" /> {fmtNum(post.reactions)}
              </span>
              <span className="flex items-center gap-1 text-xs text-app-muted">
                <MessageCircle size={11} className="text-blue-400" /> {fmtNum(post.comments)}
              </span>
              <span className="flex items-center gap-1 text-xs text-app-muted">
                <Share2 size={11} className="text-green-400" /> {fmtNum(post.shares)}
              </span>
            </div>
          </div>

          {/* URL warning */}
          {!hasValidUrl && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              Bai viet khong co URL chinh xac (ID: {post.fb_post_id?.substring(0, 15)}...). Fetch lai bang Cookie de lay URL.
            </div>
          )}

          {/* Tone selector + regenerate */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-app-muted shrink-0">Giong van:</span>
            <div className="flex gap-1 flex-1">
              {TONES.map(t => (
                <button
                  key={t.key}
                  onClick={() => setTone(t.key)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    tone === t.key ? 'bg-blue-100 text-blue-700' : 'bg-app-elevated text-app-muted hover:bg-app-hover'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              onClick={generateReply}
              disabled={generating}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-50 transition-colors"
            >
              {generating ? <Loader size={12} className="animate-spin" /> : <Sparkles size={12} />}
              AI
            </button>
          </div>

          {/* Comment textarea */}
          <div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={generating ? 'Dang tao comment...' : 'Nhap comment tai day...'}
              rows={3}
              disabled={generating}
              className="w-full rounded border border-app-border px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none disabled:bg-app-base disabled:text-app-dim"
            />
            <p className="text-xs text-app-dim mt-1 text-right">{comment.length} ky tu</p>
          </div>

          {/* Account picker */}
          <div>
            <label className="block text-xs font-medium text-app-muted mb-1.5">Tai khoan comment</label>
            {accounts.length === 0 ? (
              <p className="text-xs text-red-500">Chua co tai khoan Facebook nao. Them tai khoan truoc.</p>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setShowAccountPicker(!showAccountPicker)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-app-border text-sm hover:border-gray-400 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${selectedAccount?.status === 'healthy' ? 'bg-hermes' : 'bg-yellow-500'}`} />
                    <span className="truncate">{selectedAccount?.username || 'Chon tai khoan...'}</span>
                  </div>
                  <ChevronDown size={14} className="text-app-dim shrink-0" />
                </button>

                {showAccountPicker && (
                  <div className="absolute z-10 w-full mt-1 bg-app-surface border border-app-border rounded-lg  max-h-40 overflow-y-auto">
                    {accounts.map(acc => (
                      <button
                        key={acc.id}
                        onClick={() => { setSelectedAccountId(acc.id); setShowAccountPicker(false) }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-app-base text-left ${
                          acc.id === selectedAccountId ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div className={`w-2 h-2 rounded-full shrink-0 ${acc.status === 'healthy' ? 'bg-hermes' : ['expired', 'session_expired', 'checkpoint'].includes(acc.status) ? 'bg-red-500' : 'bg-yellow-500'}`} />
                        <span className="truncate">{acc.username}</span>
                        <span className="text-xs text-app-dim ml-auto shrink-0">{acc.status}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3.5 border-t border-app-border flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-app-muted hover:text-app-primary transition-colors"
          >
            Huy
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !comment.trim() || !selectedAccountId}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium bg-info text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
            Gui comment
          </button>
        </div>
      </div>
    </div>
  )
}
