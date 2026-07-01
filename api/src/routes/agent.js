const path = require('path')
const fs = require('fs')

// Runtime knobs the desktop agent reads on boot + every 5 minutes.
// Tuning these from the Hermes settings UI changes Playwright behavior
// without rebuilding the agent. Admin-scoped override lives in
// ai_settings.hermes_agent_config (migration 021).
const RUNTIME_DEFAULTS = {
  rest_min_minutes: 20,
  rest_max_minutes: 60,
  session_min_minutes: 25,
  session_max_minutes: 45,
  navigation_timeout_ms: 30000,
  action_timeout_ms: 15000,
  viewport_width: 1366,
  viewport_height: 768,
  user_agent: null,
  default_language: 'vi-VN',
  enable_warmup_gate: true,
  warmup_join_block_days: 14,
  max_concurrent: 2,
  poll_interval_ms: 5000,
  heartbeat_interval_ms: 30000,
}
const RUNTIME_KEYS = Object.keys(RUNTIME_DEFAULTS)
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '274868cf-742d-4d8a-89e8-bf1c37766b77'

async function loadRuntimeConfig(supabase) {
  const { data } = await supabase
    .from('ai_settings')
    .select('hermes_agent_config')
    .eq('id', ADMIN_USER_ID)
    .single()
  const override = (data && data.hermes_agent_config) || {}
  const safe = {}
  for (const k of RUNTIME_KEYS) {
    if (override[k] !== undefined && override[k] !== null) safe[k] = override[k]
  }
  return { ...RUNTIME_DEFAULTS, ...safe }
}

module.exports = async (fastify) => {
  const { supabase } = fastify

  // GET /agent/config - Agent fetches config after login (SaaS model, no .env needed)
  fastify.get('/config', { preHandler: fastify.authenticate }, async (req, reply) => {
    const runtime = await loadRuntimeConfig(supabase)
    return {
      supabase_url: process.env.SUPABASE_URL,
      supabase_anon_key: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
      database_url: process.env.DATABASE_URL_EXTERNAL || process.env.DATABASE_URL?.replace('localhost', process.env.VPS_HOST || '103.142.24.60') || null,
      api_url: process.env.API_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `https://103-142-24-60.sslip.io`),
      agent_secret_key: process.env.AGENT_SECRET_KEY || '',
      user_id: req.user.id,
      // Old shape kept for agent versions that read agent_settings; new
      // runtime block is the authoritative one going forward.
      agent_settings: {
        max_concurrent: runtime.max_concurrent,
        poll_interval: runtime.poll_interval_ms,
        heartbeat_interval: runtime.heartbeat_interval_ms,
      },
      runtime,
    }
  })

  // GET /agent/runtime - dual auth: X-Agent-Key (for desktop agent polling)
  // OR JWT (for the Hermes Settings UI). The desktop agent passes
  // X-Agent-Key and gets just the effective config; the admin UI passes a
  // JWT and gets defaults + effective for the diff display.
  fastify.get('/runtime', async (req, reply) => {
    const AGENT_SECRET = process.env.AGENT_SECRET
    const agentKey = req.headers['x-agent-key']
    if (AGENT_SECRET && agentKey === AGENT_SECRET) {
      const runtime = await loadRuntimeConfig(supabase)
      return { effective: runtime }
    }
    try { await fastify.authenticate(req, reply) } catch { return }
    if (reply.sent) return
    const runtime = await loadRuntimeConfig(supabase)
    return { defaults: RUNTIME_DEFAULTS, effective: runtime }
  })

  // PUT /agent/runtime - Admin edits the override
  fastify.put('/runtime', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const body = req.body || {}
    const safe = {}
    for (const k of RUNTIME_KEYS) {
      if (body[k] !== undefined && body[k] !== null) safe[k] = body[k]
    }
    const { error } = await supabase
      .from('ai_settings')
      .upsert({
        id: req.user.id,
        hermes_agent_config: safe,
        updated_at: new Date().toISOString(),
      })
    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true, effective: { ...RUNTIME_DEFAULTS, ...safe } }
  })

  // GET /agent/status - Check if any agent is online
  fastify.get('/status', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id

    const [{ data: agents }, { data: profile }] = await Promise.all([
      supabase
        .from('agent_heartbeats')
        .select('agent_id, last_seen, hostname, platform, user_id')
        .gte('last_seen', new Date(Date.now() - 60000).toISOString())
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .order('last_seen', { ascending: false }),
      supabase
        .from('profiles')
        .select('preferred_executor_id')
        .eq('id', userId)
        .single(),
    ])

    return {
      online: (agents?.length || 0) > 0,
      agents: agents || [],
      preferredExecutorId: profile?.preferred_executor_id || null,
    }
  })

  // PUT /agent/executor - Set preferred executor for current user
  fastify.put('/executor', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id
    const { executorId } = req.body // null = auto (any)

    await supabase
      .from('profiles')
      .update({ preferred_executor_id: executorId || null })
      .eq('id', userId)

    return { ok: true, preferredExecutorId: executorId || null }
  })

  // GET /agent/download - Return download URL for latest Electron exe
  fastify.get('/download', { preHandler: fastify.authenticate }, async (req, reply) => {
    const url = process.env.AGENT_DOWNLOAD_URL || '/SocialFlow Agent Setup 1.1.0.exe'
    return { url, filename: 'SocialFlow Agent Setup 1.1.0.exe' }
  })
}
