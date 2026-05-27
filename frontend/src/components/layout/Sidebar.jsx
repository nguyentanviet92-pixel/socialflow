import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  FileText,
  Film,
  Send,
  Inbox,
  Bot,
  TrendingUp,
  BarChart3,
  Globe,
  Activity,
  Database,
  Sprout,
  Radar,
  Target,
  Brain,
  Sliders,
  Radio,
  Settings,
} from 'lucide-react'
import useAuthStore from '../../store/auth.store'

// Dark-hermes nav — consolidated into 7 key functional hubs.
const mainLinks = [
  { to: '/dashboard',      label: 'Tổng quan',     icon: LayoutDashboard },
  { to: '/campaigns',      label: 'Chiến dịch & Agents', icon: Target },
  { to: '/accounts',       label: 'Tài khoản & Fanpage', icon: Users },
  { to: '/monitor',        label: 'Giám sát & Tín hiệu', icon: Radio },
  { to: '/analytics',      label: 'Xu hướng & Phân tích', icon: BarChart3 },
  { to: '/publish',        label: 'Thư viện & Xuất bản', icon: Send },
  { to: '/hermes',         label: 'Trí tuệ Hermes',  icon: Brain },
]

const settingsLinks = []

export default function Sidebar({ onClose }) {
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'

  // Filter links - only admins can access Hermes Hub
  const filteredLinks = mainLinks.filter(link => {
    if (link.to === '/hermes') return isAdmin
    return true
  })

  // Active item: left border + hermes tint. Inactive: muted text, hover surface.
  const linkClasses = ({ isActive }) =>
    `flex items-center gap-3 px-4 py-2 text-sm font-medium transition-colors ${
      isActive
        ? 'text-hermes'
        : 'text-app-muted hover:text-app-primary hover:bg-app-hover'
    }`

  return (
    <aside
      className="w-60 flex flex-col h-full shrink-0"
      style={{
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        backdropFilter: 'blur(16px)',
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div
          className="w-7 h-7 flex items-center justify-center font-mono-ui font-bold text-xs"
          style={{ background: 'var(--hermes-dim)', color: 'var(--hermes)', borderRadius: 4 }}
        >
          SF
        </div>
        <span className="text-app-primary text-sm font-semibold tracking-tight">
          SocialFlow
        </span>
      </div>

      {/* Main navigation */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5">
        {filteredLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/hermes'}
            className={linkClasses}
            onClick={onClose}
            style={({ isActive }) => isActive ? { borderLeft: '2px solid var(--hermes)', background: 'var(--hermes-dim)' } : { borderLeft: '2px solid transparent' }}
          >
            <link.icon className="w-4 h-4 shrink-0" />
            <span>{link.label}</span>
          </NavLink>
        ))}

        {/* Separator */}
        <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0' }} />

        {isAdmin ? (
          <NavLink
            to="/settings/admin"
            className={linkClasses}
            onClick={onClose}
            style={({ isActive }) => isActive ? { borderLeft: '2px solid var(--hermes)', background: 'var(--hermes-dim)' } : { borderLeft: '2px solid transparent' }}
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span>Cài đặt hệ thống</span>
          </NavLink>
        ) : (
          <NavLink
            to="/settings"
            className={linkClasses}
            onClick={onClose}
            style={({ isActive }) => isActive ? { borderLeft: '2px solid var(--hermes)', background: 'var(--hermes-dim)' } : { borderLeft: '2px solid transparent' }}
          >
            <Settings className="w-4 h-4 shrink-0" />
            <span>Cài đặt</span>
          </NavLink>
        )}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 font-mono-ui" style={{ borderTop: '1px solid var(--border)' }}>
        <p className="text-[10px] text-app-dim uppercase tracking-wider">SocialFlow v1.0</p>
      </div>
    </aside>
  )
}
