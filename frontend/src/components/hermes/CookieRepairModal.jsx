/**
 * CookieRepairModal — inline cookie fix + auto health check + auto assign.
 *
 * Flow:
 *   1. User pastes new cookie → POST /accounts/:id/update-cookie
 *      (server sets status=unknown + queues check_health job)
 *   2. Modal polls GET /accounts/:id every 3s
 *   3. When status = healthy → POST /accounts/:id/activate → assigns job
 *   4. Toast green + auto-close + invalidate queries
 *   5. If status = checkpoint/expired after check → toast red + keep modal open
 */
import { useState, useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { X, Loader, Check, AlertTriangle } from 'lucide-react'
import api from '../../lib/api'

const STATUS_LABEL = {
  healthy: { text: '🟢 Cookie hợp lệ', color: 'text-hermes' },
  unknown: { text: '🟡 Đang kiểm tra...', color: 'text-warn' },
  checking: { text: '🟡 Đang kiểm tra...', color: 'text-warn' },
  checkpoint: { text: '🔴 Checkpoint — cần sửa cookie', color: 'text-danger' },
  expired: { text: '🔴 Cookie hết hạn', color: 'text-danger' },
  disabled: { text: '⚫ Đã tắt', color: 'text-app-muted' },
  banned: { text: '🚫 Banned', color: 'text-danger' },
  at_risk: { text: '🟠 At risk', color: 'text-warn' },
}

function formatAgo(ts) {
  if (!ts) return ''
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000)
  if (sec < 60) return `${sec}s trước`
  if (sec < 3600) return `${Math.round(sec / 60)}p trước`
  if (sec < 86400) return `${Math.round(sec / 3600)}h trước`
  return `${Math.round(sec / 86400)}d trước`
}

export default function CookieRepairModal({ account, onClose, onSuccess }) {
  const qc = useQueryClient()
  const [cookieInput, setCookieInput] = useState('')
  const [phase, setPhase] = useState('input') // input | checking | success | failed
  const [checkStatus, setCheckStatus] = useState(null)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  // Cleanup polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const saveCookie = useMutation({
    mutationFn: async () => {
      if (!cookieInput.trim()) throw new Error('Paste cookie trước đã')
      const res = await api.post(`/accounts/${account.id}/update-cookie`, {
        cookie_string: cookieInput.trim(),
      })
      return res.data
    },
    onSuccess: async (data) => {
      // Server-side immediate validation already happened — act on result instantly
      if (data?.status === 'healthy') {
        try {
          const actRes = await api.post(`/accounts/${account.id}/activate`)
          const jobInfo = actRes.data?.assigned_job
            ? `— đã giao ${actRes.data.assigned_job.type}`
            : '— nick sẵn sàng'
          toast.success(`✓ Cookie hợp lệ ${jobInfo}`)
        } catch {
          toast.success('✓ Cookie hợp lệ — nick đã active')
        }
        setPhase('success')
        qc.invalidateQueries({ queryKey: ['accounts'] })
        qc.invalidateQueries({ queryKey: ['jobs'] })
        setTimeout(() => { onSuccess?.(); onClose() }, 1500)
        return
      }
      if (data?.status && ['checkpoint', 'expired', 'disabled', 'banned'].includes(data.status)) {
        setPhase('failed')
        setError(`Cookie ${data.status} — thử cookie khác`)
        toast.error(`✗ Cookie ${data.status}`)
        qc.invalidateQueries({ queryKey: ['accounts'] })
        return
      }
      // Ambiguous (status='unknown') → fall back to polling agent verification
      setPhase('checking')
      startPolling()
    },
    onError: (err) => {
      setError(err.response?.data?.error || err.message)
      toast.error(err.response?.data?.error || err.message)
    },
  })

  const startPolling = () => {
    let attempts = 0
    const MAX_ATTEMPTS = 60 // 3min @ 3s
    pollRef.current = setInterval(async () => {
      attempts++
      try {
        const res = await api.get(`/accounts/${account.id}`)
        const data = res.data
        setCheckStatus(data.status)

        if (data.status === 'healthy') {
          clearInterval(pollRef.current)
          pollRef.current = null
          // Auto-activate to assign a job
          try {
            const actRes = await api.post(`/accounts/${account.id}/activate`)
            const jobInfo = actRes.data?.assigned_job
              ? `— đã giao ${actRes.data.assigned_job.type}`
              : '— nick sẵn sàng (chưa gán campaign)'
            toast.success(`✓ Cookie hợp lệ ${jobInfo}`)
          } catch {
            toast.success('✓ Cookie hợp lệ — nick đã active')
          }
          setPhase('success')
          qc.invalidateQueries({ queryKey: ['accounts'] })
          qc.invalidateQueries({ queryKey: ['jobs'] })
          setTimeout(() => { onSuccess?.(); onClose() }, 1500)
          return
        }

        if (['checkpoint', 'expired', 'banned'].includes(data.status)) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setPhase('failed')
          setError(data.last_error || `Cookie vẫn lỗi (${data.status}) — thử cookie khác`)
          toast.error(`✗ ${data.last_error || data.status}`)
          qc.invalidateQueries({ queryKey: ['accounts'] })
          return
        }

        // Timeout — agent might be offline
        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setPhase('failed')
          setError('Quá thời gian (3 phút). Agent có online không? Thử lại sau.')
        }
      } catch (err) {
        // Network error — don't fail immediately, keep polling
        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setPhase('failed')
          setError('Không kết nối được API: ' + err.message)
        }
      }
    }, 3000)
  }

  const currentStatusLabel = STATUS_LABEL[account.status] || { text: account.status, color: 'text-app-muted' }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 font-mono-ui"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="bg-app-surface w-full max-w-lg flex flex-col"
        style={{ border: '1px solid var(--border-bright)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-danger" />
            <span className="text-app-primary text-sm uppercase tracking-wider">
              Sửa cookie — {account.username || account.id.slice(0, 8)}
            </span>
          </div>
          <button onClick={onClose} className="text-app-muted hover:text-app-primary p-1">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Current status */}
          <div className="p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <div className="text-[10px] uppercase text-app-muted mb-1">Trạng thái hiện tại</div>
            <div className={`text-sm ${currentStatusLabel.color}`}>{currentStatusLabel.text}</div>
            {account.last_error && (
              <div className="text-[11px] text-app-muted mt-1">
                Lý do: {account.last_error.substring(0, 200)}
              </div>
            )}
            {account.updated_at && (
              <div className="text-[10px] text-app-dim mt-1">
                Phát hiện {formatAgo(account.updated_at)}
              </div>
            )}
          </div>

          {/* Input phase */}
          {phase === 'input' && (
            <>
              <div>
                <label className="block text-[10px] uppercase text-app-muted mb-2">
                  Paste cookie mới vào đây:
                </label>
                <textarea
                  rows={6}
                  value={cookieInput}
                  onChange={(e) => setCookieInput(e.target.value)}
                  placeholder="c_user=xxx; xs=xxx; datr=xxx; ..."
                  className="w-full px-3 py-2 bg-app-elevated text-app-primary text-xs resize-y"
                  style={{ border: '1px solid var(--border-bright)', fontFamily: 'var(--font-mono)' }}
                />
                <div className="text-[10px] text-app-muted mt-1">
                  Cookie phải có ít nhất: <span className="text-app-primary">c_user</span>, <span className="text-app-primary">xs</span>
                </div>
              </div>
              {error && <div className="text-xs text-danger">⚠ {error}</div>}
              <div className="flex gap-2 justify-end">
                <button onClick={onClose} className="btn-ghost">Hủy</button>
                <button
                  onClick={() => saveCookie.mutate()}
                  disabled={saveCookie.isPending || cookieInput.length < 20}
                  className="btn-hermes"
                >
                  {saveCookie.isPending ? 'Đang lưu...' : 'Lưu & Kiểm tra ngay'}
                </button>
              </div>
            </>
          )}

          {/* Checking phase */}
          {phase === 'checking' && (
            <div className="flex flex-col items-center py-6 gap-3">
              <Loader size={24} className="animate-spin text-hermes" />
              <div className="text-app-primary text-sm">
                Đang kiểm tra cookie...
              </div>
              <div className="text-xs text-app-muted text-center">
                Agent sẽ mở browser + verify session.<br/>
                {checkStatus && `Status hiện tại: ${checkStatus}`}
              </div>
              <div className="text-[10px] text-app-dim">(chờ tối đa 3 phút)</div>
            </div>
          )}

          {/* Success phase */}
          {phase === 'success' && (
            <div className="flex flex-col items-center py-6 gap-3">
              <div
                className="w-12 h-12 flex items-center justify-center rounded-full"
                style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)' }}
              >
                <Check size={24} className="text-hermes" />
              </div>
              <div className="text-hermes text-sm">Cookie hợp lệ</div>
              <div className="text-xs text-app-muted text-center">
                Đã giao task cho nick. Modal sẽ tự đóng.
              </div>
            </div>
          )}

          {/* Failed phase */}
          {phase === 'failed' && (
            <div className="space-y-3">
              <div
                className="p-3 text-sm text-danger"
                style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.4)' }}
              >
                ✗ {error || 'Cookie vẫn lỗi'}
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={onClose} className="btn-ghost">Đóng</button>
                <button
                  onClick={() => { setPhase('input'); setError(null); setCookieInput('') }}
                  className="btn-hermes"
                >
                  Thử cookie khác
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
