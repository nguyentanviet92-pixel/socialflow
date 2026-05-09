/**
 * Standard Badge — status pills with semantic colors.
 *
 * Tone:
 *   success / active / healthy / running  → hermes green
 *   warning / paused / idle                → warn orange
 *   danger  / error / checkpoint / dead    → red
 *   info                                   → blue/purple
 *   neutral / unknown                      → muted surface
 *
 * Use <Badge tone="success">{text}</Badge>. The component also accepts a
 * string "auto-tone" shortcut: pass one of the known status strings as
 * children and tone is inferred.
 */

const STYLES = {
  success: { background: 'rgba(6, 182, 212, 0.1)',    color: 'var(--hermes)' },
  warning: { background: 'rgba(251, 146, 60, 0.1)',   color: 'var(--warn)' },
  danger:  { background: 'rgba(248, 113, 113, 0.1)',  color: 'var(--danger)' },
  info:    { background: 'rgba(139, 92, 246, 0.1)',   color: 'var(--info)' },
  neutral: { background: 'var(--bg-elevated)',         color: 'var(--text-muted)' },
}

const AUTO_TONE = {
  success: 'success', active: 'success', healthy: 'success', running: 'success', done: 'success', ok: 'success',
  warning: 'warning', paused: 'warning', idle: 'warning', pending: 'warning',
  danger:  'danger',  error:  'danger',  checkpoint: 'danger', dead: 'danger', failed: 'danger', expired: 'danger', session_expired: 'danger',
  info:    'info',
  unknown: 'neutral', neutral: 'neutral', draft: 'neutral',
}

export default function Badge({ tone, children, className = '', style = {} }) {
  const key = typeof children === 'string' ? children.toLowerCase().trim() : ''
  const resolvedTone = tone || AUTO_TONE[key] || 'neutral'
  const s = STYLES[resolvedTone] || STYLES.neutral
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-mono-ui ${className}`}
      style={{ borderRadius: 4, ...s, ...style }}
    >
      {children}
    </span>
  )
}
