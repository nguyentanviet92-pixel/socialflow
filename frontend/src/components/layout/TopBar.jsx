import { LogOut, User, Menu } from 'lucide-react'
import useAuthStore from '../../store/auth.store'
import AgentStatus from './AgentStatus'
import NotificationBell from './NotificationBell'
import ProactiveAlerts from './ProactiveAlerts'

const roleBadgeColors = {
  admin: 'bg-red-100 text-red-700',
  manager: 'bg-blue-100 text-blue-700',
  user: 'bg-app-elevated text-app-primary',
}

export default function TopBar({ onMenuToggle }) {
  const { profile, logout } = useAuthStore()

  const handleLogout = async () => {
    await logout()
  }

  return (
    <header className="h-14 sm:h-16 bg-app-surface border-b border-app-border flex items-center justify-between px-3 sm:px-6 shrink-0">
      <div className="flex items-center gap-2">
        <button onClick={onMenuToggle} className="md:hidden p-2 -ml-1 text-app-muted hover:text-app-primary rounded-lg hover:bg-app-elevated">
          <Menu size={20} />
        </button>
        <AgentStatus />
      </div>

      <ProactiveAlerts />
      <div className="flex items-center gap-4">
        <NotificationBell />
        {/* User info */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
            <User className="w-4 h-4 text-slate-600" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-app-primary leading-tight">
                {profile?.username || profile?.email?.split('@')[0] || 'User'}
              </span>
              {profile?.role && (
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                    roleBadgeColors[profile.role] || roleBadgeColors.user
                  }`}
                >
                  {profile.role}
                </span>
              )}
            </div>
            {profile?.email && (
              <span className="text-[10px] text-app-muted leading-tight mt-0.5">
                {profile.email}
              </span>
            )}
          </div>
        </div>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 text-sm text-app-muted hover:text-app-primary transition-colors px-3 py-2 rounded-lg hover:bg-app-elevated"
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>
    </header>
  )
}
