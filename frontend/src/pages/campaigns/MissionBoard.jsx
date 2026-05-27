import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { Edit, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import DenseStat from '../../components/hermes/DenseStat'
import HermesCaller from '../../components/hermes/HermesCaller'
import AgentsRoster from '../agents/AgentsRoster'
import NickNurture from '../nick-nurture/NickNurture'

const STATUS_COLOR = {
  active:  'text-hermes',
  running: 'text-hermes',
  paused:  'text-warn',
  draft:   'text-app-muted',
  done:    'text-info',
  archived: 'text-app-dim',
}

function CampaignCard({ campaign, onClick, onEdit, onDelete }) {
  const plan = campaign.plan_summary || campaign.description || campaign.mission || ''
  const status = campaign.status || 'draft'
  const rolesCount = campaign.roles_count ?? campaign.campaign_roles?.length ?? 0
  const nicksCount = campaign.nicks_count ?? (() => {
    const roleNicks = (campaign.campaign_roles || []).flatMap(r => r.account_ids || [])
    return new Set([...roleNicks, ...(campaign.account_ids || [])]).size
  })()
  const todayDone = campaign.today_done ?? 0
  const todayTarget = campaign.today_target ?? 0

  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer p-4 bg-app-surface hover:bg-app-hover transition-colors"
      style={{
        border: '1px solid var(--border)',
        borderLeft: status === 'active' || status === 'running' ? '2px solid var(--hermes)' : '1px solid var(--border)',
      }}
    >
      {/* Hover quick actions — absolute top-right */}
      <div
        className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => onEdit(campaign)}
          className="p-1.5 rounded bg-app-elevated hover:bg-app-hover"
          style={{ border: '1px solid var(--border)' }}
          title="Sửa"
        >
          <Edit size={12} />
        </button>
        <button
          onClick={() => onDelete(campaign)}
          className="p-1.5 rounded bg-app-elevated hover:bg-app-hover"
          style={{ border: '1px solid var(--border)', color: 'var(--danger)' }}
          title="Xóa"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="flex items-start justify-between mb-3 pr-20">
        <div className="min-w-0 flex-1">
          <div className="text-app-primary truncate font-ui">{campaign.name}</div>
          <div className="text-[10px] font-mono-ui text-app-muted uppercase tracking-wider mt-0.5">
            {campaign.topic || campaign.mission?.substring(0, 60) || '—'}
          </div>
        </div>
        <span className={`font-mono-ui text-[10px] uppercase tracking-wider ${STATUS_COLOR[status] || 'text-app-muted'}`}>
          ● {status}
        </span>
      </div>

      {plan && (
        <div className="mb-3">
          <HermesCaller taskType="ai_pilot" />
          <div className="text-[11px] text-app-muted mt-1 line-clamp-2">{plan.substring(0, 200)}</div>
        </div>
      )}

      <div className="flex items-center gap-4 mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="font-mono-ui text-xs">
          <span className="text-app-muted">agents </span>
          <span className="text-app-primary">{nicksCount}</span>
        </div>
        <div className="font-mono-ui text-xs">
          <span className="text-app-muted">roles </span>
          <span className="text-app-primary">{rolesCount}</span>
        </div>
        <div className="flex-1" />
        <div className="font-mono-ui text-xs">
          <span className="text-app-muted">today </span>
          <span className={todayDone >= todayTarget && todayTarget > 0 ? 'text-hermes' : 'text-app-primary'}>
            {todayDone}{todayTarget > 0 ? `/${todayTarget}` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function MissionBoard() {
  const nav = useNavigate()
  const { pathname } = useLocation()

  const asArray = (d) => Array.isArray(d) ? d
    : Array.isArray(d?.items) ? d.items
    : Array.isArray(d?.data) ? d.data
    : Array.isArray(d?.campaigns) ? d.campaigns
    : Array.isArray(d?.results) ? d.results
    : []

  const qc = useQueryClient()

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => asArray((await api.get('/campaigns')).data),
    refetchInterval: 30000,
  })

  const deleteMut = useMutation({
    mutationFn: async (id) => { await api.delete(`/campaigns/${id}`) },
    onSuccess: () => {
      toast.success('Đã xóa campaign')
      qc.invalidateQueries({ queryKey: ['campaigns'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  })

  const handleEdit = (c) => nav(`/campaigns/${c.id}/edit`)
  const handleDelete = (c) => {
    if (window.confirm(`Xóa campaign "${c.name}"?\nViệc này không hoàn tác được.`)) {
      deleteMut.mutate(c.id)
    }
  }

  const active = campaigns.filter(c => c.status === 'active' || c.status === 'running').length
  const paused = campaigns.filter(c => c.status === 'paused').length
  const drafts = campaigns.filter(c => c.status === 'draft').length

  // Determine active tab
  const getActiveTab = () => {
    if (pathname === '/agents') return 'agents'
    if (pathname === '/nick-nurture') return 'nurture'
    return 'campaigns'
  }
  const activeTab = getActiveTab()

  return (
    <div className="flex flex-col h-full">
      {/* Consolidated Top Tabs Bar */}
      <div
        className="flex items-center px-6 font-mono-ui text-[11px] uppercase tracking-wider shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      >
        <button
          onClick={() => nav('/campaigns')}
          className={`px-4 py-3 ${activeTab === 'campaigns' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'campaigns' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🎯 Chiến dịch
        </button>
        <button
          onClick={() => nav('/agents')}
          className={`px-4 py-3 ${activeTab === 'agents' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'agents' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          👥 Agents Roster
        </button>
        <button
          onClick={() => nav('/nick-nurture')}
          className={`px-4 py-3 ${activeTab === 'nurture' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'nurture' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          🌱 Nuôi Nick (Nurture)
        </button>
      </div>

      {/* Render Consolidated Views */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'agents' && <AgentsRoster />}
        {activeTab === 'nurture' && <NickNurture />}
        {activeTab === 'campaigns' && (
          <div className="flex flex-col h-full">
            {/* Header info for campaigns specifically */}
            <div
              className="flex items-center gap-8 px-6 py-4"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div>
                <div className="font-mono-ui text-[10px] uppercase text-app-muted">Missions</div>
                <div className="text-app-primary text-lg mt-1">Campaign board ({campaigns.length})</div>
              </div>
              <div className="flex-1" />
              <DenseStat value={active} label="Active" color="hermes" />
              <DenseStat value={paused} label="Paused" color="warn" />
              <DenseStat value={drafts} label="Drafts" />
              <button
                onClick={() => nav('/campaigns/new')}
                className="btn-hermes"
              >
                + New mission
              </button>
            </div>

            <div className="flex-1 p-6">
              {campaigns.length === 0 ? (
                <div className="text-center text-app-muted py-12">
                  <div className="text-sm mb-2">No campaigns yet</div>
                  <button onClick={() => nav('/campaigns/new')} className="btn-hermes">
                    Create first mission
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {campaigns.map(c => (
                    <CampaignCard
                      key={c.id}
                      campaign={c}
                      onClick={() => nav(`/campaigns/${c.id}`)}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
