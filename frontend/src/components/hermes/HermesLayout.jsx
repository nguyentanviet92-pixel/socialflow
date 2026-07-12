/**
 * HermesLayout — shell with HermesBar top + collapsible SideNav left.
 *
 * Sidebar defaults to compact (icon-only, 64px) but user can expand to
 * 220px via the chevron at the top-left to see Vietnamese labels
 * without hovering. Preference persists in localStorage so the choice
 * survives reloads.
 */
import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Users, Target, Radio, Mail, FileText,
  Brain, Settings, LogOut, Database, Activity, SlidersHorizontal,
  ChevronsRight, ChevronsLeft, Globe, Search,
} from 'lucide-react'
import HermesBar from './HermesBar'
import useAuthStore from '../../store/auth.store'

// Vietnamese labels prioritized — English kept short for the compact
// tooltip. Grouped by use frequency (top = most used).
const NAV_ITEMS = [
  { to: '/dashboard',     Icon: LayoutDashboard,   label: 'Tổng quan',      short: 'Command' },
  { to: '/campaigns',     Icon: Target,            label: 'Chiến dịch',     short: 'Missions' },
  { to: '/agents',        Icon: Users,             label: 'Nick / Agents',  short: 'Agents' },
  { to: '/monitor',       Icon: Radio,             label: 'Signal Wall',    short: 'Signals' },
  { to: '/scout',         Icon: Search,            label: 'Do Thám',        short: 'Scout' },
  { to: '/inbox',         Icon: Mail,              label: 'Hộp thư',        short: 'Inbox' },
  { to: '/content',       Icon: FileText,          label: 'Nội dung',       short: 'Content' },
  { to: '/data-center',   Icon: Database,          label: 'Data',           short: 'Data' },
  { to: '/hermes',        Icon: Brain,             label: 'Hermes Brain',   short: 'Hermes' },
  { to: '/hermes/wp-audit', Icon: Globe,            label: 'WP Audit',       short: 'WPAudit' },
  { to: '/hermes/settings', Icon: SlidersHorizontal, label: 'Hermes Config', short: 'Config' },
  { to: '/analytics',     Icon: Activity,          label: 'Thống kê',       short: 'Analytics' },
]

const LS_KEY = 'sf.nav.expanded'

function NavItem({ to, Icon, label, short, expanded }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative flex items-center h-12 group transition-colors ${
          expanded ? 'justify-start px-5 gap-3' : 'justify-center'
        } ${isActive ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`
      }
      title={expanded ? undefined : label}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-hermes" />
          )}
          <Icon size={18} strokeWidth={1.6} className="shrink-0" />
          {expanded && (
            <span className="text-[13px] truncate">{label}</span>
          )}
          {/* Tooltip — only rendered in compact mode */}
          {!expanded && (
            <span
              className="absolute left-full ml-2 px-2 py-1 bg-app-elevated text-[11px] font-mono-ui uppercase tracking-wider opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10"
              style={{ border: '1px solid var(--border-bright)' }}
            >
              {short}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

export default function HermesLayout({ children }) {
  const logout = useAuthStore((s) => s.logout)
  const user = useAuthStore((s) => s.user)

  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, expanded ? '1' : '0') } catch {}
  }, [expanded])

  const asideWidth = expanded ? 220 : 64

  return (
    <div className="min-h-screen flex flex-col bg-app-base">
      <HermesBar />
      <div className="flex-1 flex">
        <aside
          className="flex flex-col bg-app-surface transition-[width] duration-150"
          style={{
            width: asideWidth,
            borderRight: '1px solid var(--border)',
          }}
        >
          {/* Logo + expand toggle */}
          <div
            className="flex items-center h-14 px-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <div
              className={`flex items-center text-hermes ${expanded ? 'flex-1 px-5 gap-3' : 'w-16 justify-center'}`}
            >
              <span className="font-mono-ui text-lg font-bold">⬡</span>
              {expanded && (
                <span className="font-mono-ui text-xs uppercase tracking-widest text-app-muted">SocialFlow</span>
              )}
            </div>
            <button
              onClick={() => setExpanded(!expanded)}
              className={`flex items-center justify-center h-14 text-app-muted hover:text-app-primary ${expanded ? 'w-10 mr-1' : 'w-16'}`}
              title={expanded ? 'Thu gọn menu' : 'Mở rộng menu'}
              style={expanded ? {} : { display: 'none' }}
            >
              <ChevronsLeft size={16} strokeWidth={1.6} />
            </button>
          </div>

          {/* Quick expand button when collapsed — sits between logo and nav */}
          {!expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center justify-center w-16 h-8 text-app-dim hover:text-app-primary"
              title="Mở rộng menu"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <ChevronsRight size={14} strokeWidth={1.6} />
            </button>
          )}

          <nav className="flex-1 flex flex-col w-full py-1">
            {NAV_ITEMS.map((item) => (
              <NavItem key={item.to} {...item} expanded={expanded} />
            ))}
          </nav>

          <div className="w-full" style={{ borderTop: '1px solid var(--border)' }}>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `flex items-center h-12 ${expanded ? 'justify-start px-5 gap-3' : 'justify-center'} ${
                  isActive ? 'text-hermes' : 'text-app-muted hover:text-app-primary'
                }`
              }
              title={expanded ? undefined : 'Cài đặt'}
            >
              <Settings size={18} strokeWidth={1.6} className="shrink-0" />
              {expanded && <span className="text-[13px]">Cài đặt</span>}
            </NavLink>
            <button
              onClick={logout}
              className={`flex items-center h-12 w-full ${expanded ? 'justify-start px-5 gap-3' : 'justify-center'} text-app-muted hover:text-danger`}
              title={expanded ? undefined : `Đăng xuất ${user?.email || ''}`}
            >
              <LogOut size={18} strokeWidth={1.6} className="shrink-0" />
              {expanded && (
                <span className="text-[13px] truncate">
                  Đăng xuất
                </span>
              )}
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-auto" style={{ minWidth: 0 }}>
          {children}
        </main>
      </div>
    </div>
  )
}
