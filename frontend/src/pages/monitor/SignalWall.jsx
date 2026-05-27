/**
 * /monitor — Signal Wall (Consolidated Giám sát & Tín hiệu Hub).
 * Feed of posts/opportunities Hermes has scanned, with relevance score + assigned agent.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../../lib/api'
import DenseStat from '../../components/hermes/DenseStat'
import HermesScoreBadge from '../../components/hermes/HermesScoreBadge'
import AgentStatusDot from '../../components/hermes/AgentStatusDot'
import GroupMonitor from '../groups/GroupMonitor'
import AccountHealth from '../accounts/AccountHealth'

function formatAgo(ts) {
  if (!ts) return '—'
  const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

export default function SignalWall() {
  const [minScore, setMinScore] = useState(5)
  const { pathname } = useLocation()
  const nav = useNavigate()

  // Defensive: API endpoints may return array OR object {items: [...]} OR {posts: [...]}
  const asArray = (d) => {
    if (Array.isArray(d)) return d
    if (Array.isArray(d?.items)) return d.items
    if (Array.isArray(d?.posts)) return d.posts
    if (Array.isArray(d?.data)) return d.data
    if (Array.isArray(d?.opportunities)) return d.opportunities
    if (Array.isArray(d?.results)) return d.results
    return []
  }

  // Try monitor/posts first (keyword watchers) then fallback to opportunities
  const { data: posts = [] } = useQuery({
    queryKey: ['monitor', 'posts'],
    queryFn: async () => {
      try {
        const res = await api.get('/monitor/posts?limit=50')
        return asArray(res.data)
      } catch {
        return []
      }
    },
    refetchInterval: 10000,
    enabled: pathname === '/monitor',
  })

  const { data: opportunities = [] } = useQuery({
    queryKey: ['monitor', 'opportunities'],
    queryFn: async () => {
      try {
        const res = await api.get('/monitor/engagement?limit=30')
        return asArray(res.data)
      } catch {
        return []
      }
    },
    refetchInterval: 10000,
    enabled: pathname === '/monitor',
  })

  // Extra safety even though useQuery default handles it
  const postsArr = Array.isArray(posts) ? posts : []
  const oppsArr = Array.isArray(opportunities) ? opportunities : []

  // Merge & normalize
  const items = [
    ...postsArr.map(p => ({
      id: p.id || p.post_fb_id,
      type: 'post',
      platform: 'facebook',
      content: p.title || p.message || p.content_preview || '',
      author: p.author_name || p.author || '—',
      source: p.source_name || p.group_name || p.keyword || '',
      score: p.ai_score ?? p.relevance_score ?? null,
      ts: p.created_at || p.posted_at,
      url: p.post_url,
      action: p.action_taken || p.status || 'detected',
    })),
    ...oppsArr.map(o => ({
      id: o.id,
      type: 'opportunity',
      platform: 'facebook',
      content: o.post_text || o.content_preview || '',
      author: o.author_name || '—',
      source: o.group_name || o.fb_group_name || '',
      score: o.opportunity_score ?? o.ai_score ?? null,
      ts: o.created_at,
      url: o.post_url,
      action: o.status || 'pending',
      agent: o.acted_by_account_id,
    })),
  ]
    .filter(i => {
      if (minScore > 0 && i.score !== null && i.score < minScore) return false
      return true
    })
    .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0))

  const highRelevance = items.filter(i => i.score >= 7).length
  const actedCount = items.filter(i => ['acted', 'commented', 'done'].includes(i.action)).length

  // Tab mapping
  const getActiveTab = () => {
    if (pathname === '/group-monitor') return 'group'
    if (pathname === '/health') return 'health'
    return 'signal'
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
          onClick={() => nav('/monitor')}
          className={`px-4 py-3 ${activeTab === 'signal' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'signal' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          📡 Dòng tín hiệu (Signal Wall)
        </button>
        <button
          onClick={() => nav('/group-monitor')}
          className={`px-4 py-3 ${activeTab === 'group' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'group' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          👥 Theo dõi nhóm (Group Monitor)
        </button>
        <button
          onClick={() => nav('/health')}
          className={`px-4 py-3 ${activeTab === 'health' ? 'text-hermes' : 'text-app-muted hover:text-app-primary'}`}
          style={{
            borderBottom: activeTab === 'health' ? '2px solid var(--hermes)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          ❤️ Sức khỏe (Health Status)
        </button>
      </div>

      {/* Tab Render View */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'group' && <GroupMonitor />}
        {activeTab === 'health' && <AccountHealth />}
        {activeTab === 'signal' && (
          <div className="flex flex-col h-full">
            {/* Header info for Signal Wall specifically */}
            <div
              className="flex items-center gap-8 px-6 py-4"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <div>
                <div className="font-mono-ui text-[10px] uppercase text-app-muted">Signal Wall</div>
                <div className="text-app-primary text-lg mt-1">Hermes-scanned opportunities ({items.length})</div>
              </div>
              <div className="flex-1" />
              <DenseStat value={items.length} label="Total signals" />
              <DenseStat value={highRelevance} label="High relevance" color="hermes" />
              <DenseStat value={actedCount} label="Acted on" />
              <div className="flex items-center gap-2">
                <label className="font-mono-ui text-[10px] uppercase text-app-muted">Min score</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={minScore}
                  onChange={(e) => setMinScore(parseInt(e.target.value) || 0)}
                  className="w-14 px-2 py-1 bg-app-elevated text-app-primary font-mono-ui text-xs"
                  style={{ border: '1px solid var(--border-bright)' }}
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {items.length === 0 && (
                <div className="p-8 text-center text-app-muted font-mono-ui text-xs">
                  No signals yet. Run group monitoring or keyword scanning.
                </div>
              )}
              {items.map((item) => (
                <div
                  key={`${item.type}-${item.id}`}
                  className="flex items-start gap-4 px-6 py-3 hover-row"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <div className="flex items-center gap-2 w-20">
                    <AgentStatusDot status={item.action === 'pending' ? 'idle' : 'online'} />
                    <span className="font-mono-ui text-[10px] uppercase text-app-muted">{item.type}</span>
                  </div>
                  <HermesScoreBadge score={item.score} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 text-[10px] font-mono-ui text-app-muted uppercase">
                      <span>{item.source}</span>
                      <span>·</span>
                      <span>{item.author}</span>
                      <span>·</span>
                      <span className="text-app-dim">{formatAgo(item.ts)}</span>
                    </div>
                    <div className="text-xs text-app-primary mt-1 line-clamp-2">
                      {item.content}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono-ui text-[10px] uppercase ${
                      item.action === 'acted' || item.action === 'commented' || item.action === 'done' ? 'text-hermes' :
                      item.action === 'skipped' ? 'text-app-muted' :
                      'text-info'
                    }`}>
                      {item.action}
                    </span>
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-app-muted hover:text-hermes text-xs font-mono-ui"
                      >
                        [open]
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
