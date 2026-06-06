require('dotenv').config({ override: true })

const allowMocks = process.env.ALLOW_MOCKS === 'true'
const nodeEnv = process.env.NODE_ENV || 'development'

if (nodeEnv === 'production' && allowMocks) {
  throw new Error('Mocks are strictly forbidden in production environments')
}

const Fastify = require('fastify')
const { supabase } = require('./lib/supabase')
const { initScheduler, getSchedulerTracker } = require('./services/campaign-scheduler')
const { initNurtureScheduler } = require('./services/nurture-scheduler')
const { initSlotScheduler } = require('./services/slot-scheduler')

const app = Fastify({ logger: true })

// Decorate supabase on fastify instance
app.decorate('supabase', supabase)

// Plugins
app.register(require('./plugins/cors'))
// gzip/brotli on every JSON response. Agent + frontend save 60-80% of
// bandwidth + transfer time over internet. threshold=1024 avoids gzip
// overhead on tiny payloads.
app.register(require('@fastify/compress'), { global: true, threshold: 1024 })
app.register(require('./plugins/auth'))
app.register(require('./plugins/r2'))
app.register(require('./plugins/cache'))
app.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB max
  }
})

// Routes
app.register(require('./routes/auth'), { prefix: '/auth' })
app.register(require('./routes/accounts'), { prefix: '/accounts' })
app.register(require('./routes/proxies'), { prefix: '/proxies' })
app.register(require('./routes/fanpages'), { prefix: '/fanpages' })
app.register(require('./routes/groups'), { prefix: '/groups' })
app.register(require('./routes/media'), { prefix: '/media' })
app.register(require('./routes/content'), { prefix: '/content' })
app.register(require('./routes/jobs'), { prefix: '/jobs' })
app.register(require('./routes/campaigns'), { prefix: '/campaigns' })
app.register(require('./routes/notifications'), { prefix: '/notifications' })
app.register(require('./routes/ai'), { prefix: '/ai' })
app.register(require('./routes/trends'), { prefix: '/trends' })
app.register(require('./routes/inbox'), { prefix: '/inbox' })
app.register(require('./routes/analytics'), { prefix: '/analytics' })
app.register(require('./routes/users'), { prefix: '/users' })
app.register(require('./routes/agent'), { prefix: '/agent' })
app.register(require('./routes/agent-jobs'), { prefix: '/agent-jobs' })
app.register(require('./routes/agent-db'), { prefix: '/agent-db' })
app.register(require('./routes/ai-hermes'), { prefix: '/ai-hermes' })
app.register(require('./routes/monitor'), { prefix: '/monitor' })
app.register(require('./routes/system-settings'), { prefix: '/system-settings' })
app.register(require('./routes/facebook'), { prefix: '/facebook' })
app.register(require('./routes/research'), { prefix: '/research' })
app.register(require('./routes/websites'), { prefix: '/websites' })
app.register(require('./routes/monitoring'), { prefix: '/monitoring' })
app.register(require('./routes/user-settings'), { prefix: '/user-settings' })
app.register(require('./routes/permissions'), { prefix: '/permissions' })
app.register(require('./routes/leads'), { prefix: '/leads' })
app.register(require('./routes/nurture'), { prefix: '/nurture' })
app.register(require('./routes/oauth'), { prefix: '/oauth' })

// Health check endpoints
app.get('/health/db', async (request, reply) => {
  try {
    const pool = supabase._pool
    if (pool) {
      await pool.query('SELECT 1')
    } else {
      const { error } = await supabase.from('jobs').select('id').limit(1)
      if (error) throw error
    }
    return { status: 'ok' }
  } catch (err) {
    reply.code(500)
    return { status: 'error', error: err.message }
  }
})

app.get('/health/scheduler', async (request, reply) => {
  try {
    const tracker = getSchedulerTracker()
    return {
      enabled: tracker.enabled,
      lastTickAt: tracker.lastTickAt,
      lastCreatedJobs: tracker.lastCreatedJobsCount
    }
  } catch (err) {
    reply.code(500)
    return { status: 'error', error: err.message }
  }
})

app.get('/health/hermes', async (request, reply) => {
  const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8100'
  const AGENT_SECRET = process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY
  const start = Date.now()
  try {
    const headers = {}
    if (AGENT_SECRET) {
      headers['X-Agent-Key'] = AGENT_SECRET
    }
    const res = await fetch(`${HERMES_URL}/status`, {
      headers,
      signal: AbortSignal.timeout(5000)
    })
    const latencyMs = Date.now() - start
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      return { ok: true, latencyMs, status: data.status || 'ONLINE', provider: data.provider, model: data.model }
    }
    throw new Error(`Hermes returned status ${res.status}`)
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message }
  }
})

app.get('/health/agents', async (request, reply) => {
  try {
    const { data, error } = await supabase
      .from('agent_heartbeats')
      .select('agent_id, status, last_seen')

    if (error) throw error

    const onlineAgents = (data || []).filter(h => {
      const lastSeen = h.last_seen || h.last_seen_at
      return lastSeen && new Date(lastSeen).getTime() > Date.now() - 120000
    })

    return {
      online: onlineAgents.length,
      offline: Math.max(0, (data || []).length - onlineAgents.length),
      agents: data || []
    }
  } catch (err) {
    reply.code(500)
    return { status: 'error', error: err.message }
  }
})

app.get('/health', async (request, reply) => {
  const allowMocks = process.env.ALLOW_MOCKS === 'true'
  const nodeEnv = process.env.NODE_ENV || 'development'
  if (nodeEnv === 'production' && allowMocks) {
    reply.code(500)
    return { error: 'Mocks are forbidden in production' }
  }

  // Aggregate health checks
  const dbPromise = (async () => {
    try {
      const pool = supabase._pool
      if (pool) await pool.query('SELECT 1')
      else await supabase.from('jobs').select('id').limit(1)
      return 'ok'
    } catch { return 'error' }
  })()

  const hermesPromise = (async () => {
    const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8100'
    const AGENT_SECRET = process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY
    try {
      const headers = {}
      if (AGENT_SECRET) headers['X-Agent-Key'] = AGENT_SECRET
      const res = await fetch(`${HERMES_URL}/status`, { headers, signal: AbortSignal.timeout(3000) })
      return res.ok ? 'ok' : 'error'
    } catch { return 'error' }
  })()

  const agentsPromise = (async () => {
    try {
      const { data } = await supabase.from('agent_heartbeats').select('agent_id, last_seen')
      const online = (data || []).filter(h => {
        const lastSeen = h.last_seen || h.last_seen_at
        return lastSeen && new Date(lastSeen).getTime() > Date.now() - 120000
      }).length
      return { online, total: (data || []).length }
    } catch { return { online: 0, total: 0 } }
  })()

  const [dbStatus, hermesStatus, agentsStatus] = await Promise.all([dbPromise, hermesPromise, agentsPromise])
  const tracker = getSchedulerTracker()

  return {
    api: 'ok',
    db: dbStatus,
    scheduler: {
      enabled: tracker.enabled,
      lastTickAt: tracker.lastTickAt,
      lastCreatedJobs: tracker.lastCreatedJobsCount
    },
    hermes: {
      ok: hermesStatus === 'ok'
    },
    agents: {
      online: agentsStatus.online,
      offline: Math.max(0, agentsStatus.total - agentsStatus.online)
    },
    mocks: {
      enabled: allowMocks
    },
    timestamp: new Date().toISOString()
  }
})

// Extension config (public — returns client-safe Supabase credentials for Chrome Extension login)
app.get('/extension/config', async () => ({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
}))

// Start server
const start = async () => {
  try {
    console.log('[BOOT] Checking env...')

    if (process.env.DATABASE_URL) {
      console.log('[BOOT] Using self-hosted PostgreSQL:', process.env.DATABASE_URL.replace(/:([^@]+)@/, ':***@'))
    } else {
      if (!process.env.SUPABASE_URL) console.error('[BOOT] MISSING: SUPABASE_URL')
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) console.error('[BOOT] MISSING: SUPABASE_SERVICE_ROLE_KEY')
    }

    console.log('[BOOT] Registering routes...')
    await app.ready()
    console.log('[BOOT] Routes ready. Starting listener...')

    const port = parseInt(process.env.PORT) || 3005
    await app.listen({ port, host: '0.0.0.0' })

    // Start schedulers
    initScheduler()
    initNurtureScheduler()
    initSlotScheduler()

    console.log(`SocialFlow API running on port ${port}`)
  } catch (err) {
    console.error('[BOOT] FATAL:', err.message, err.stack)
    process.exit(1)
  }
}

start()
