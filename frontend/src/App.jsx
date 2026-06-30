import { useEffect, useState, Component } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import useAuthStore from './store/auth.store'
import Sidebar from './components/layout/Sidebar'
import TopBar from './components/layout/TopBar'
import HermesLayout from './components/hermes/HermesLayout'
import HermesBrain from './pages/hermes/HermesBrain'
import CommandCenter from './pages/dashboard/CommandCenter'
import AgentsRoster from './pages/agents/AgentsRoster'
import MissionBoard from './pages/campaigns/MissionBoard'
import CampaignHub from './pages/campaigns/CampaignHub'
import CampaignHermesEditor from './pages/campaigns/CampaignHermesEditor'
import SignalWall from './pages/monitor/SignalWall'
import HermesSettings from './pages/hermes/HermesSettings'
import Login from './pages/auth/Login'
import Register from './pages/auth/Register'
import AccountList from './pages/accounts/AccountList'
import AccountDetail from './pages/accounts/AccountDetail'
import PageList from './pages/pages-manager/PageList'
import InboxView from './pages/pages-manager/InboxView'
import GroupList from './pages/groups/GroupList'
import MediaLibrary from './pages/media/MediaLibrary'
import VideoEditor from './pages/media/VideoEditor'
import ContentComposer from './pages/content/ContentComposer'
import ContentList from './pages/content/ContentList'
import UnifiedPublish from './pages/publish/UnifiedPublish'
import CampaignCalendar from './pages/publish/CampaignCalendar'
import TrendCenter from './pages/trends/TrendCenter'
import Analytics from './pages/analytics/Analytics'
import InboxPage from './pages/inbox/InboxPage'
import AdminSettings from './pages/settings/AdminSettings'
import Settings from './pages/settings/Settings'
import WebsiteSettings from './pages/settings/WebsiteSettings'
import WebsiteReport from './pages/websites/WebsiteReport'
import OAuthCallback from './pages/OAuthCallback'
import GoogleCallbackRelay from './pages/GoogleCallbackRelay'
import CampaignForm from './pages/campaigns/CampaignForm'
import AccountHealth from './pages/accounts/AccountHealth'
import DataCenter from './pages/data-center/DataCenter'
import NickNurture from './pages/nick-nurture/NickNurture'
import GroupMonitor from './pages/groups/GroupMonitor'
import WpAuditResult from './pages/hermes/WpAuditResult'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return (
      <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center p-8">
          <p className="text-danger font-medium mb-2">Đã xảy ra lỗi không mong muốn</p>
          <p className="text-app-muted text-sm mb-4">{this.state.error?.message}</p>
          <button onClick={() => window.location.reload()} className="btn-hermes">Tải lại trang</button>
        </div>
      </div>
    )
    return this.props.children
  }
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore()
  if (loading) return <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg-base)' }}><div className="animate-spin w-8 h-8 border-4 border-t-transparent rounded-full" style={{ borderColor: 'var(--hermes)', borderTopColor: 'transparent' }} /></div>
  if (!user) return <Navigate to="/login" />
  return children
}

function AppLayout({ children }) {
  // New Hermes-centric layout (dark terminal aesthetic)
  return (
    <HermesLayout>
      <ErrorBoundary>{children}</ErrorBoundary>
    </HermesLayout>
  )
}

export default function App() {
  const init = useAuthStore((s) => s.init)

  useEffect(() => { init() }, [init])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/oauth-callback" element={<OAuthCallback />} />
        <Route path="/websites/google/callback" element={<GoogleCallbackRelay />} />
        <Route path="/*" element={
          <ProtectedRoute>
            <AppLayout>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" />} />
                {/* ── Hub 1: Tổng quan ── */}
                <Route path="/dashboard" element={<CommandCenter />} />

                {/* ── Hub 2: Chiến dịch & Agents (Consolidated) ── */}
                <Route path="/campaigns" element={<MissionBoard />} />
                <Route path="/agents" element={<MissionBoard />} />
                <Route path="/nick-nurture" element={<MissionBoard />} />

                {/* ── Hub 3: Tài khoản & Fanpage (Consolidated) ── */}
                <Route path="/accounts" element={<AccountList />} />
                <Route path="/pages" element={<AccountList />} />
                <Route path="/settings/websites" element={<AccountList />} />

                {/* ── Hub 4: Giám sát & Tín hiệu (Consolidated) ── */}
                <Route path="/monitor" element={<SignalWall />} />
                <Route path="/group-monitor" element={<SignalWall />} />
                <Route path="/health" element={<SignalWall />} />

                {/* ── Hub 5: Phân tích & Xu hướng (Consolidated) ── */}
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/trends" element={<Analytics />} />
                <Route path="/data-center" element={<Analytics />} />

                {/* ── Hub 6: Thư viện & Xuất bản (Consolidated) ── */}
                <Route path="/publish" element={<UnifiedPublish />} />
                <Route path="/content" element={<UnifiedPublish />} />
                <Route path="/content/new" element={<UnifiedPublish />} />
                <Route path="/media" element={<UnifiedPublish />} />
                <Route path="/inbox" element={<UnifiedPublish />} />

                {/* ── Hub 7: Trí tuệ Hermes (Consolidated) ── */}
                <Route path="/hermes" element={<HermesBrain />} />
                <Route path="/hermes/dashboard" element={<HermesBrain />} />
                <Route path="/hermes/skills" element={<HermesBrain />} />
                <Route path="/hermes/learning" element={<HermesBrain />} />
                <Route path="/hermes/settings" element={<HermesBrain />} />
                <Route path="/hermes/terminal" element={<HermesBrain />} />
                <Route path="/hermes/wp-audit" element={<HermesBrain />} />
                <Route path="/hermes/wp-audit/:postId" element={<WpAuditResult />} />

                {/* ── Legacy redirects & auxiliary sub-routes ── */}
                <Route path="/dashboard-legacy" element={<Navigate to="/dashboard" replace />} />
                <Route path="/campaigns-legacy" element={<Navigate to="/campaigns" replace />} />
                <Route path="/monitor-legacy"   element={<Navigate to="/monitor" replace />} />
                <Route path="/campaigns/old"    element={<Navigate to="/campaigns" replace />} />
                <Route path="/campaigns/new" element={<CampaignForm />} />
                <Route path="/campaigns/:id" element={<CampaignHub />} />
                <Route path="/campaigns/:id/legacy" element={<Navigate to="/campaigns/:id" replace />} />
                <Route path="/campaigns/:id/edit" element={<CampaignForm />} />
                <Route path="/campaigns/:id/hermes" element={<CampaignHermesEditor />} />
                <Route path="/accounts/:id" element={<AccountDetail />} />
                <Route path="/pages/:id/inbox" element={<InboxView />} />
                <Route path="/media/:id/edit" element={<VideoEditor />} />
                <Route path="/calendar" element={<CampaignCalendar />} />
                <Route path="/websites/:id/report" element={<WebsiteReport />} />
                
                {/* ── Settings and redirection fallback ── */}
                <Route path="/settings" element={<Settings />} />
                <Route path="/settings/admin" element={<AdminSettings />} />
                <Route path="/settings/ai" element={<Navigate to="/hermes" replace />} />
                <Route path="/settings/proxies" element={<Navigate to="/settings/admin" replace />} />
                <Route path="/settings/users" element={<Navigate to="/settings/admin" replace />} />
              </Routes>
            </AppLayout>
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  )
}
