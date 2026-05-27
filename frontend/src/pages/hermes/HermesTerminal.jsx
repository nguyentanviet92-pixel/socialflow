/**
 * HermesTerminal.jsx — Live WebSocket terminal to Hermes CLI on VPS
 *
 * Premium glassmorphic dark terminal with shortcut buttons.
 * Connects via WebSocket to hermes-bridge.js on the API server.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { API_BASE } from '../../lib/api'

// ── Shortcut definitions ──
const SHORTCUTS = [
  { label: '📋 Trạng thái',    args: ['status'],       color: '#06b6d4' },
  { label: '⚙️ Cấu hình',      args: ['config'],       color: '#8b5cf6' },
  { label: '🩺 Chẩn đoán',     args: ['doctor'],       color: '#f59e0b' },
  { label: '🔑 Lệnh OAuth',    args: ['oauth-config'], color: '#f43f5e' },
  { label: '📝 Logs',           args: ['logs'],         color: '#10b981' },
  { label: '🔄 Cập nhật',      args: ['update'],       color: '#3b82f6' },
  { label: '📦 Version',        args: ['version'],      color: '#ec4899' },
  { label: '🧠 Sessions',       args: ['sessions', 'list'], color: '#14b8a6' },
  { label: '🔌 MCP Servers',    args: ['mcp', 'list'],  color: '#a855f7' },
]

// Derive WS URL from API_BASE
function getWsUrl() {
  let base = API_BASE || window.location.origin
  // Convert https://host → wss://host, http://host → ws://host
  base = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  // Remove trailing slash
  base = base.replace(/\/$/, '')

  try {
    const url = new URL(base)
    if (url.hostname.includes('sslip.io')) {
      url.pathname = '/hermes-ws'
      url.port = '' // standard secure port
      return url.toString()
    } else {
      url.port = '8765'
      url.pathname = '/'
      return url.toString()
    }
  } catch {
    return `ws://localhost:8765`
  }
}

export default function HermesTerminal() {
  const [logs, setLogs] = useState([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [runningProc, setRunningProc] = useState(false)
  const wsRef = useRef(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const reconnectTimer = useRef(null)

  const addLog = useCallback((text, type = 'stdout') => {
    setLogs(prev => {
      const next = [...prev, { text, type, ts: Date.now() }]
      return next.length > 2000 ? next.slice(-1500) : next
    })
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) return

    setConnecting(true)
    const url = getWsUrl()
    addLog(`Connecting to ${url}...\n`, 'system')

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setConnecting(false)
      addLog('✅ Connected to Hermes Bridge\n', 'system')
    }

    ws.onclose = () => {
      setConnected(false)
      setConnecting(false)
      setRunningProc(false)
      addLog('❌ Disconnected from Hermes Bridge\n', 'system')
      reconnectTimer.current = setTimeout(() => connect(), 3000)
    }

    ws.onerror = () => {
      setConnecting(false)
      setRunningProc(false)
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'stdout') {
          addLog(msg.data, 'stdout')
        } else if (msg.type === 'stderr') {
          addLog(msg.data, 'stderr')
        } else if (msg.type === 'exit') {
          addLog(`\n[Process exited with code ${msg.code}]\n`, 'system')
          setRunningProc(false)
        } else if (msg.type === 'error') {
          addLog(msg.data, 'error')
          setRunningProc(false)
        }
      } catch {
        addLog(e.data, 'stdout')
      }
    }
  }, [addLog])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const execCommand = useCallback((args) => {
    if (args[0] === 'oauth-config' || args[0] === 'oauth') {
      const base = API_BASE || window.location.origin
      const apiDomain = base.replace(/\/$/, '')
      addLog(`\n$ show oauth-config\n`, 'input')
      addLog(`🔑 THÔNG TIN CẤU HÌNH OAUTH 2.0 & GPT ACTIONS:
----------------------------------------------------------------------
- Client ID:         socialflow
- Client Secret:     socialflow-secret
- Authorization URL: ${apiDomain}/oauth/authorize
- Token URL:         ${apiDomain}/oauth/token
- OpenAPI Schema:    ${apiDomain}/oauth/openapi.json
----------------------------------------------------------------------
👉 Hướng dẫn: Copy các thông số trên dán vào ChatGPT Actions để kích hoạt AI Hermes!
\n`, 'stdout')
      return
    }
    if (!wsRef.current || wsRef.current.readyState !== 1) return
    setRunningProc(true)
    addLog(`\n$ hermes ${args.join(' ')}\n`, 'input')
    wsRef.current.send(JSON.stringify({ type: 'spawn', args }))
  }, [addLog])

  const handleSend = () => {
    if (!input.trim() || !wsRef.current || wsRef.current.readyState !== 1) return
    if (runningProc) {
      addLog(`${input}\n`, 'input')
      wsRef.current.send(JSON.stringify({ type: 'stdin', data: input + '\n' }))
    } else {
      const parts = input.trim().split(/\s+/)
      const args = parts[0] === 'hermes' ? parts.slice(1) : parts
      execCommand(args)
    }
    setInput('')
  }

  const handleClear = () => {
    setLogs([])
  }

  const getLineColor = (type) => {
    switch (type) {
      case 'input': return '#facc15'   // yellow
      case 'stderr':
      case 'error': return '#f87171'   // red
      case 'system': return '#94a3b8'  // slate
      default: return '#a5f3fc'        // cyan-200
    }
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: connected ? '#34d399' : connecting ? '#fbbf24' : '#ef4444',
                boxShadow: connected ? '0 0 8px rgba(52,211,153,0.6)' : 'none',
              }}
            />
            <span className="text-xs font-mono-ui text-app-muted">
              {connected ? (runningProc ? 'Hermes CLI active (interactive)' : 'Hermes CLI connected') : connecting ? 'Connecting...' : 'Disconnected'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {runningProc && (
            <button
              onClick={() => {
                if (wsRef.current && wsRef.current.readyState === 1) {
                  wsRef.current.send(JSON.stringify({ type: 'kill' }))
                  addLog('\n[SIGINT sent to stop running process]\n', 'system')
                }
              }}
              className="text-[10px] px-2 py-1 text-danger hover:opacity-80 transition-colors"
              style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4 }}
            >
              Stop Process
            </button>
          )}
          <button
            onClick={handleClear}
            className="text-[10px] px-2 py-1 text-app-muted hover:text-app-primary transition-colors"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4 }}
          >
            Clear
          </button>
          {!connected && !connecting && (
            <button
              onClick={connect}
              className="text-[10px] px-2 py-1 text-hermes hover:opacity-80 transition-colors"
              style={{ background: 'var(--hermes-dim)', border: '1px solid var(--hermes-fade)', borderRadius: 4 }}
            >
              Reconnect
            </button>
          )}
        </div>
      </div>

      {/* ── Shortcut buttons ── */}
      <div className="flex flex-wrap gap-2">
        {SHORTCUTS.map((s) => (
          <button
            key={s.args.join('-')}
            onClick={() => execCommand(s.args)}
            disabled={!connected || runningProc}
            className="text-xs px-3 py-1.5 font-mono-ui transition-all hover:opacity-80 disabled:opacity-30"
            style={{
              background: `${s.color}15`,
              border: `1px solid ${s.color}40`,
              color: s.color,
              borderRadius: 6,
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ── Terminal output ── */}
      <div
        className="flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed p-4 rounded-lg"
        style={{
          background: '#0a0a0f',
          border: '1px solid var(--border)',
          minHeight: 300,
          maxHeight: 'calc(100vh - 380px)',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {logs.length === 0 && (
          <div className="text-gray-600 italic">
            Bấm 1 nút shortcut ở trên hoặc gõ lệnh bên dưới để bắt đầu...
          </div>
        )}
        {logs.map((l, i) => (
          <span key={i} style={{ color: getLineColor(l.type), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {l.text}
          </span>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* ── Input ── */}
      <div className="flex gap-2">
        <div
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: '#0a0a0f', border: '1px solid var(--border-bright)' }}
        >
          <span className="text-hermes text-xs font-mono-ui select-none">$</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend()
            }}
            placeholder={connected ? (runningProc ? 'Nhập dữ liệu phản hồi (stdin)...' : 'hermes status, hermes config, ...') : 'Đang chờ kết nối...'}
            disabled={!connected}
            className="flex-1 bg-transparent text-white text-sm font-mono outline-none placeholder:text-gray-600 disabled:opacity-40"
          />
        </div>
        <button
          onClick={handleSend}
          disabled={!connected || !input.trim()}
          className="px-4 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-30"
          style={{
            background: connected ? 'var(--hermes)' : 'var(--bg-elevated)',
            color: connected ? '#000' : 'var(--text-muted)',
            border: '1px solid var(--hermes-fade)',
          }}
        >
          {runningProc ? 'Send' : 'Run'}
        </button>
      </div>
    </div>
  )
}
