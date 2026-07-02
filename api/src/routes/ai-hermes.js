// Hermes AI routes — proxy to the Hermes FastAPI service on localhost:8100
// Exposes /ai-hermes/comment, /ai-hermes/evaluate, /ai-hermes/quality-gate, /ai-hermes/generate
module.exports = async (fastify) => {
  const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8100'
  const AGENT_SECRET = process.env.AGENT_SECRET || process.env.AGENT_SECRET_KEY
  const SHORT_TIMEOUT_MS = 5000
  const NORMAL_TIMEOUT_MS = 30000
  const COMMENT_TIMEOUT_MS = 60000
  const EVALUATE_TIMEOUT_MS = 90000
  const LONG_TIMEOUT_MS = 360000
  console.log('[HERMES] Using URL:', HERMES_URL, 'secret configured:', !!AGENT_SECRET)

  async function proxyToHermes(path, body, timeout = COMMENT_TIMEOUT_MS, userId = null) {
    try {
      const axios = require('axios')
      const headers = {
        'Content-Type': 'application/json',
        'X-Agent-Key': AGENT_SECRET,
        'Connection': 'close',
      }
      if (userId) {
        headers['X-User-Id'] = userId
      }
      const res = await axios.post(`${HERMES_URL}${path}`, body, {
        headers: headers,
        timeout: timeout,
        validateStatus: () => true
      })
      return { status: res.status, json: res.data }
    } catch (err) {
      return { status: 503, json: { error: 'Hermes API unreachable', detail: err.message } }
    }
  }

  // ─── Health check (passthrough) ────────────────────────
  fastify.get('/health', async (req, reply) => {
    try {
      const axios = require('axios')
      const res = await axios.get(`${HERMES_URL}/health`, { timeout: SHORT_TIMEOUT_MS, headers: { 'Connection': 'close' } })
      return { ...res.data, proxy: 'ok' }
    } catch (err) {
      return reply.code(503).send({ error: 'Hermes API unreachable', detail: err.message })
    }
  })

  // ─── Comment generation ────────────────────────────────
  // Auth: user must be logged in (JWT)
  fastify.post('/comment', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/comment', req.body, COMMENT_TIMEOUT_MS, req.user?.id)
    return reply.code(status).send(json)
  })

  // ─── Post evaluation ───────────────────────────────────
  fastify.post('/evaluate', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/evaluate', req.body, EVALUATE_TIMEOUT_MS, req.user?.id)
    return reply.code(status).send(json)
  })

  // ─── Quality gate ──────────────────────────────────────
  fastify.post('/quality-gate', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/quality-gate', req.body, NORMAL_TIMEOUT_MS, req.user?.id)
    return reply.code(status).send(json)
  })

  // ─── Generic generate (drop-in for orchestrator) ───────
  fastify.post('/generate', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/generate', req.body, LONG_TIMEOUT_MS, req.user?.id)
    return reply.code(status).send(json)
  })

  // ─── Agent authentication variants (X-Agent-Key) ───────
  // Allows the desktop agent to call these directly without a user JWT
  const agentAuth = async (request, reply) => {
    const key = request.headers['x-agent-key']
    if (!AGENT_SECRET || key !== AGENT_SECRET) {
      return reply.code(401).send({ error: 'Invalid agent key' })
    }
  }

  fastify.post('/agent/comment', { preHandler: agentAuth }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/comment', req.body, COMMENT_TIMEOUT_MS)
    return reply.code(status).send(json)
  })

  fastify.post('/agent/evaluate', { preHandler: agentAuth }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/evaluate', req.body, EVALUATE_TIMEOUT_MS)
    return reply.code(status).send(json)
  })

  fastify.post('/agent/quality-gate', { preHandler: agentAuth }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/quality-gate', req.body, NORMAL_TIMEOUT_MS)
    return reply.code(status).send(json)
  })

  fastify.post('/agent/generate', { preHandler: agentAuth }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/generate', req.body, LONG_TIMEOUT_MS)
    return reply.code(status).send(json)
  })

  // ─── Feedback endpoint (agent-auth) ────────────────────
  fastify.post('/agent/feedback', { preHandler: agentAuth }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/feedback', req.body, SHORT_TIMEOUT_MS)
    return reply.code(status).send(json)
  })

  // ─── Status / performance / skills (both auth paths) ────
  async function getStatus() {
    try {
      const axios = require('axios')
      const res = await axios.get(`${HERMES_URL}/status`, {
        headers: { 'X-Agent-Key': AGENT_SECRET, 'Connection': 'close' },
        timeout: SHORT_TIMEOUT_MS,
        validateStatus: () => true // Resolve on any status code
      })
      return { status: res.status, json: res.data }
    } catch (err) {
      throw new Error(err.message || 'Axios timeout or network error')
    }
  }

  fastify.get('/status', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { status, json } = await getStatus()
      return reply.code(status).send(json)
    } catch (err) {
      req.log.error({ err: err.message, stack: err.stack }, '[HERMES] status fetch failed')
      return reply.code(503).send({ status: 'OFFLINE', error: err.message })
    }
  })

  // GET /ai-hermes/health-summary — consolidated health for the dashboard
  // Surfaces LLM-provider billing/quota failures (402, 429, 401) so the user
  // knows WHY Hermes is silent. Without this widget 'Hermes đéo làm gì'
  // looks like a mystery; in reality it's almost always an upstream billing
  // issue we can show directly.
  fastify.get('/health-summary', { preHandler: fastify.authenticate }, async (req, reply) => {
    const pool = fastify.supabase._pool
    const result = {
      hermes_online: false,
      hermes_model: null,
      total_calls_recent: 0,
      total_errors_recent: 0,
      recent_error_samples: [],
      llm_billing_blocked: false,
      configured_providers: [],
      last_successful_call_at: null,
      last_failed_call_at: null,
    }

    // (1) Ping Hermes /status
    try {
      const { status, json } = await getStatus()
      if (status === 200) {
        result.hermes_online = json.status === 'ONLINE'
        result.hermes_model = json.model
        result.total_calls_recent = json.total_calls || 0
        result.total_errors_recent = json.total_errors || 0
      }
    } catch { /* offline */ }

    // (2) Recent hermes_calls for error diagnostics
    try {
      if (pool) {
        const since = new Date(Date.now() - 3600 * 1000).toISOString()
        const { rows } = await pool.query(
          `SELECT ok, error, task_type, created_at
           FROM hermes_calls
           WHERE created_at > $1
           ORDER BY created_at DESC
           LIMIT 200`,
          [since]
        )
        const errors = rows.filter(r => !r.ok)
        const samples = errors.slice(0, 5).map(r => ({
          at: r.created_at,
          task: r.task_type,
          error: (r.error || '').substring(0, 200),
        }))
        result.recent_error_samples = samples

        // Detect billing-blocked: any error mentioning 402 / Insufficient /
        // Payment / Balance. If we see this pattern, surface it prominently.
        const billingPatterns = /402|Insufficient Balance|Payment Required|insufficient_quota|quota exceeded|billing/i
        result.llm_billing_blocked = samples.some(s => billingPatterns.test(s.error))

        const lastOk = rows.find(r => r.ok)
        const lastFail = rows.find(r => !r.ok)
        result.last_successful_call_at = lastOk?.created_at || null
        result.last_failed_call_at = lastFail?.created_at || null
      }
    } catch (err) {
      req.log.warn({ err: err.message }, '[HERMES-HEALTH] hermes_calls query failed')
    }

    // (3) Provider config from ai_settings (so UI can show which fallbacks
    //     are configured). Mask keys.
    try {
      const { data: settings } = await fastify.supabase
        .from('ai_settings')
        .select('providers, fallback_chain')
        .eq('id', process.env.ADMIN_USER_ID || '274868cf-742d-4d8a-89e8-bf1c37766b77')
        .single()
      if (settings) {
        const providers = settings.providers || {}
        result.configured_providers = Object.entries(providers)
          .filter(([, v]) => v?.enabled && v?.api_key)
          .map(([k]) => k)
        result.fallback_chain = settings.fallback_chain || ['hermes', 'deepseek', 'openai', 'gemini']
      }
    } catch { /* soft */ }

    return result
  })

  fastify.get('/agent/status', { preHandler: agentAuth }, async (req, reply) => {
    try {
      const { status, json } = await getStatus()
      return reply.code(status).send(json)
    } catch (err) {
      return reply.code(503).send({ status: 'OFFLINE', error: err.message })
    }
  })

  fastify.get('/performance', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const axios = require('axios')
      const res = await axios.get(`${HERMES_URL}/performance`, {
        headers: { 'X-Agent-Key': AGENT_SECRET, 'Connection': 'close' },
        timeout: NORMAL_TIMEOUT_MS,
        validateStatus: () => true
      })
      return reply.code(res.status).send(res.data)
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/skills/status', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const axios = require('axios')
      const res = await axios.get(`${HERMES_URL}/skills/status`, {
        headers: { 'X-Agent-Key': AGENT_SECRET, 'Connection': 'close' },
        timeout: NORMAL_TIMEOUT_MS,
        validateStatus: () => true
      })
      return reply.code(res.status).send(res.data)
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/feedback/recent', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const limit = req.query.limit || 50
      const res = await fetch(`${HERMES_URL}/feedback/recent?limit=${limit}`, {
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  // ─── Skills CRUD proxies (admin only) ───────────────────
  fastify.get('/skills', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/skills`, {
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/skills/:task_type', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/skills/${encodeURIComponent(req.params.task_type)}`, {
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.put('/skills/:task_type', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/skills/${encodeURIComponent(req.params.task_type)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': AGENT_SECRET,
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.post('/skills/reload', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/skills/reload`, {
        method: 'POST',
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  // ─── Config CRUD + test ──────────────────────────────────
  fastify.get('/config', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/config`, {
        headers: {
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.put('/config', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.post('/config/test', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/config/test', req.body, NORMAL_TIMEOUT_MS, req.user.id)
    return reply.code(status).send(json)
  })

  // ─── Skill create + delete ───────────────────────────────
  fastify.post('/skills', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/skills', req.body, NORMAL_TIMEOUT_MS)
    return reply.code(status).send(json)
  })

  fastify.delete('/skills/:task_type', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    try {
      const res = await fetch(`${HERMES_URL}/skills/${encodeURIComponent(req.params.task_type)}`, {
        method: 'DELETE',
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  // ─── Memory stats per account (for /agents dashboard) ───
  fastify.get('/memory-stats', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { data, error } = await fastify.supabase
        .from('ai_pilot_memory')
        .select('account_id', { count: 'exact' })
      if (error) return reply.code(500).send({ error: error.message })
      // Group by account_id
      const counts = {}
      for (const row of (data || [])) {
        const a = row.account_id
        if (!a) continue
        counts[a] = (counts[a] || 0) + 1
      }
      return counts
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // ─── Campaign Review ─────────────────────────────────────
  fastify.post('/campaign-review', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { status, json } = await proxyToHermes('/campaign-review', req.body, LONG_TIMEOUT_MS)
    // If review succeeded AND campaign has auto_apply_enabled → run autoApply
    if (status === 200 && json?.ok && req.body?.campaign_id) {
      try {
        // Use shared service directly (don't rely on fastify decorator scoping)
        const { autoApplyRecommendations } = require('../services/auto-apply')
        const auto = await autoApplyRecommendations(fastify.supabase, {
          campaignId: req.body.campaign_id,
          recommendations: json.recommendations || [],
          ownerId: req.user.id,
        })
        json.auto_applied = auto.auto_applied
        json.auto_apply_skipped = auto.skipped
      } catch (err) {
        fastify.log.warn({ err }, '[AUTO-APPLY] Failed (review still saved)')
      }
    }
    return reply.code(status).send(json)
  })

  // ─── SOUL editor (Hermes personality) ────────────────────
  // Reads/writes /root/.hermes/SOUL.md — Hermes's system-prompt-level identity.
  // PUT also triggers a /skills/reload so changes take effect without restart.
  const fsp = require('fs').promises
  const os  = require('os')
  const path = require('path')
  const SOUL_PATH = process.env.HERMES_SOUL_PATH
    || path.join(os.homedir(), '.hermes', 'SOUL.md')

  fastify.get('/soul', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const content = await fsp.readFile(SOUL_PATH, 'utf-8').catch(() => '')
      return { path: SOUL_PATH, content }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.put('/soul', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { content } = req.body || {}
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'content (string) required' })
    }
    try {
      // Backup before overwriting
      try {
        const prev = await fsp.readFile(SOUL_PATH, 'utf-8').catch(() => '')
        if (prev) await fsp.writeFile(SOUL_PATH + '.bak', prev)
      } catch {}
      await fsp.writeFile(SOUL_PATH, content)
      // Hot-reload Hermes so new SOUL takes effect
      try {
        await fetch(`${HERMES_URL}/skills/reload`, {
          method: 'POST',
          headers: { 'X-Agent-Key': AGENT_SECRET },
          signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
        })
      } catch {}
      return { ok: true, bytes: content.length }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // ─── Cookie-death analyzer (agent-auth) ──────────────────
  // Called by the poller right after it confirms a nick is dead
  // (checkpoint or session_expired). We pull the last N hours of
  // campaign_activity_log + budget snapshot and send to Hermes for a
  // postmortem. The analysis goes into ai_pilot_memory (for self-review
  // aggregation) + hermes_decisions (for UI display).
  fastify.post('/cookie-death', { preHandler: agentAuth }, async (req, reply) => {
    const { account_id, death_type, death_message, window_hours = 2 } = req.body || {}
    if (!account_id) return reply.code(400).send({ error: 'account_id required' })
    const sb = fastify.supabase
    try {
      // 1. Account metadata
      const { data: account } = await sb.from('accounts')
        .select('id, username, created_at, fb_created_at, status, daily_budget')
        .eq('id', account_id).single()
      if (!account) return reply.code(404).send({ error: 'account not found' })

      const ageDays = Math.floor((Date.now() - new Date(account.fb_created_at || account.created_at).getTime()) / 86400000)
      const warmupPhase = ageDays < 7 ? 'week1' : ageDays < 30 ? 'young' : ageDays < 90 ? 'warming' : 'mature'

      // 2. Activity log last N hours
      const since = new Date(Date.now() - window_hours * 3600 * 1000).toISOString()
      const { data: activity } = await sb.from('campaign_activity_log')
        .select('action_type, target_name, target_url, result_status, details, created_at')
        .eq('account_id', account_id)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(200)

      const rows = activity || []
      const activity_before_death = rows.map(r => {
        // pg-supabase returns Date objects; supabase cloud returns ISO strings. Normalize.
        const iso = r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || '')
        return {
          t: typeof iso === 'string' ? iso.slice(11, 16) : '',
          action: r.action_type,
          target: r.target_name || '',
          status: r.result_status,
          details: r.details || {},
        }
      })
      const groupsSet = new Set()
      for (const r of rows) if (r.target_name) groupsSet.add(r.target_name)

      const input = {
        nick: { username: account.username, age_days: ageDays, warmup_phase: warmupPhase, status: account.status },
        death_at: new Date().toISOString(),
        death_type: death_type || 'UNKNOWN',
        death_message: (death_message || '').slice(0, 500),
        activity_before_death,
        budget_usage_at_death: account.daily_budget || {},
        groups_visited_in_session: [...groupsSet].slice(0, 20),
      }

      // 3. Call Hermes
      const { status, json } = await proxyToHermes('/generate', {
        messages: [{ role: 'user', content: JSON.stringify(input) }],
        max_tokens: 1500,
        temperature: 0.3,
        task_type: 'cookie_death_analyzer',
      }, LONG_TIMEOUT_MS)
      if (status !== 200) return reply.code(status).send(json)

      // Parse JSON from Hermes output
      let analysis = null
      try {
        const raw = json.text || ''
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
        const body = fenced ? fenced[1] : raw
        const start = body.indexOf('{')
        if (start >= 0) analysis = JSON.parse(body.slice(start, body.lastIndexOf('}') + 1))
      } catch {}
      if (!analysis) return reply.code(502).send({ error: 'hermes returned unparseable JSON', raw: json.text?.slice(0, 300) })

      // 4. Persist to ai_pilot_memory (for self-review aggregation)
      if (analysis.pattern_key) {
        try {
          // Check existing
          const { data: existing } = await sb.from('ai_pilot_memory')
            .select('id, evidence_count, value')
            .eq('account_id', account_id)
            .eq('memory_type', 'checkpoint_pattern')
            .eq('key', analysis.pattern_key)
            .maybeSingle()
          if (existing) {
            await sb.from('ai_pilot_memory').update({
              evidence_count: (existing.evidence_count || 1) + 1,
              value: analysis,
              last_updated_at: new Date().toISOString(),
            }).eq('id', existing.id)
          } else {
            await sb.from('ai_pilot_memory').insert({
              account_id,
              memory_type: 'checkpoint_pattern',
              key: analysis.pattern_key,
              value: analysis,
              confidence: (analysis.confidence || 5) / 10,
              evidence_count: 1,
            })
          }
        } catch (memErr) {
          fastify.log.warn({ err: memErr }, '[COOKIE-DEATH] memory insert failed')
        }
      }

      // 5. Persist to hermes_decisions for UI
      try {
        await sb.from('hermes_decisions').insert({
          campaign_id: null,
          decision_type: 'checkpoint_analysis',
          action_type: death_type || 'UNKNOWN',
          target_id: account_id,
          target_name: account.username,
          priority: 'high',
          reason: analysis.summary || analysis.primary_cause,
          context_summary: JSON.stringify({ activity_count: rows.length, groups: [...groupsSet].slice(0, 10) }),
          decision: analysis,
          auto_apply: false,
          auto_applied: false,
          outcome: 'success',
          outcome_detail: analysis.summary || null,
        })
      } catch (decErr) {
        fastify.log.warn({ err: decErr }, '[COOKIE-DEATH] decision insert failed')
      }

      return { ok: true, analysis, activity_count: rows.length }
    } catch (err) {
      fastify.log.error({ err }, '[COOKIE-DEATH] failed')
      return reply.code(500).send({ error: err.message })
    }
  })

  // ─── Orchestrator routes ─────────────────────────────────
  // POST /ai-hermes/orchestrate/:campaign_id — one-shot run
  const orchestrator = require('../services/hermes-orchestrator')

  fastify.post('/orchestrate/:campaign_id', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const result = await orchestrator.runOrchestration(req.params.campaign_id, fastify.supabase)
      return result
    } catch (err) {
      fastify.log.error({ err }, '[ORCHESTRATOR] Run failed')
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai-hermes/report/:campaign_id — generate AI weekly report
  fastify.post('/report/:campaign_id', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const report = await orchestrator.generateReport(req.params.campaign_id, fastify.supabase)
      return report
    } catch (err) {
      fastify.log.error({ err }, '[ORCHESTRATOR] Report failed')
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /ai-hermes/decisions?campaign_id=&limit=&outcome= — audit log for UI
  fastify.get('/decisions', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { campaign_id, limit = 50, outcome, decision_type } = req.query
    let q = fastify.supabase
      .from('hermes_decisions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 50, 200))
    if (campaign_id) q = q.eq('campaign_id', campaign_id)
    if (outcome) q = q.eq('outcome', outcome)
    if (decision_type) q = q.eq('decision_type', decision_type)
    const { data, error } = await q
    if (error) return reply.code(500).send({ error: error.message })
    return data || []
  })

  // PATCH /ai-hermes/decisions/:id/approve — user approves a pending action
  fastify.patch('/decisions/:id/approve', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: decision, error: fetchErr } = await fastify.supabase
      .from('hermes_decisions')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (fetchErr || !decision) return reply.code(404).send({ error: 'Not found' })
    if (decision.auto_applied || decision.outcome === 'user_approved') {
      return reply.code(400).send({ error: 'Already applied' })
    }
    // Build fresh context + execute
    try {
      const ctx = await orchestrator.buildOrchestrationContext(decision.campaign_id, fastify.supabase)
      const r = await orchestrator.executeAction(decision.decision, decision.campaign_id, ctx, fastify.supabase)
      await fastify.supabase
        .from('hermes_decisions')
        .update({
          auto_applied: r.ok,
          applied_at: new Date().toISOString(),
          outcome: r.ok ? 'user_approved' : 'failed',
          outcome_detail: r.detail,
        })
        .eq('id', req.params.id)
      return { ok: r.ok, detail: r.detail }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /ai-hermes/daily-review — self-review: analyze today's performance,
  // rewrite low-scoring skills, purge bad feedback, adjust quality gate.
  // Triggered daily at 23:00 VN by the scheduler, but admins can hit manually.
  fastify.post('/daily-review', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    try {
      const result = await orchestrator.runDailyReview(fastify.supabase)
      return result
    } catch (err) {
      fastify.log.error({ err }, '[SELF-REVIEW] Failed')
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /ai-hermes/learning-log — "Nhật ký học tập" tab in /hermes page
  fastify.get('/learning-log', { preHandler: fastify.authenticate }, async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100)
    const { data, error } = await fastify.supabase
      .from('hermes_decisions')
      .select('id, decision_type, action_type, decision, context_summary, auto_applied, outcome, outcome_detail, created_at')
      .eq('decision_type', 'self_improvement')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) return reply.code(500).send({ error: error.message })
    return data || []
  })

  // PATCH /ai-hermes/decisions/:id/reject — user dismisses a pending action
  fastify.patch('/decisions/:id/reject', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { error } = await fastify.supabase
      .from('hermes_decisions')
      .update({ outcome: 'user_rejected', applied_at: new Date().toISOString() })
      .eq('id', req.params.id)
    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // ─── Memory + feedback delete ────────────────────────────
  fastify.delete('/memory', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const qs = new URLSearchParams()
    if (req.query.account_id) qs.set('account_id', req.query.account_id)
    if (req.query.all) qs.set('all', 'true')
    try {
      const res = await fetch(`${HERMES_URL}/memory?${qs}`, {
        method: 'DELETE',
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.delete('/feedback', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const qs = new URLSearchParams()
    if (req.query.confirm) qs.set('confirm', req.query.confirm)
    try {
      const res = await fetch(`${HERMES_URL}/feedback?${qs}`, {
        method: 'DELETE',
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })
  // ─── WordPress Integration ──────────────────────────────
  fastify.get('/wp/posts', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { page = 1, per_page = 20, search = '', category_id, site_idx = 0 } = req.query
      const url = new URL(`${HERMES_URL}/hermes/wp/posts`)
      url.searchParams.append('page', page)
      url.searchParams.append('per_page', per_page)
      if (search) url.searchParams.append('search', search)
      if (category_id) url.searchParams.append('category_id', category_id)
      url.searchParams.append('site_idx', site_idx)

      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.post('/wp/audit/:post_id', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const postId = req.params.post_id
      const { site_idx = 0, force = 'false', model } = req.query
      const url = new URL(`${HERMES_URL}/hermes/wp/audit/${postId}`)
      url.searchParams.append('site_idx', site_idx)
      url.searchParams.append('force', force)
      if (model) {
        url.searchParams.append('model', model)
      }

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(LONG_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.put('/wp/apply/:post_id', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const postId = req.params.post_id
      const { site_idx = 0 } = req.query
      const url = new URL(`${HERMES_URL}/hermes/wp/apply/${postId}`)
      url.searchParams.append('site_idx', site_idx)

      const res = await fetch(url.toString(), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(LONG_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/wp/categories', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { site_idx = 0 } = req.query
      const url = new URL(`${HERMES_URL}/hermes/wp/categories`)
      url.searchParams.append('site_idx', site_idx)

      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/wp/resolve', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { url: wpUrl, slug, site_idx = 0 } = req.query
      const url = new URL(`${HERMES_URL}/hermes/wp/resolve`)
      if (wpUrl) url.searchParams.append('url', wpUrl)
      if (slug) url.searchParams.append('slug', slug)
      url.searchParams.append('site_idx', site_idx)

      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  // ─── Dashboard Integration ──────────────────────────────
  fastify.get('/dashboard/overview', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { sort_by = 'priority', limit = 100, page = 1 } = req.query
      const url = new URL(`${HERMES_URL}/hermes/dashboard/overview`)
      url.searchParams.append('sort_by', sort_by)
      url.searchParams.append('limit', limit)
      url.searchParams.append('page', page)

      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/dashboard/page', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { url: pageUrl } = req.query
      const url = new URL(`${HERMES_URL}/hermes/dashboard/page`)
      if (pageUrl) url.searchParams.append('url', pageUrl)

      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.post('/dashboard/compare', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const url = new URL(`${HERMES_URL}/hermes/dashboard/compare`)
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/dashboard/opportunities', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const url = new URL(`${HERMES_URL}/hermes/dashboard/opportunities`)
      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.post('/dashboard/sync', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const url = new URL(`${HERMES_URL}/hermes/dashboard/sync`)
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

  fastify.get('/dashboard/sync/status/:job_id', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const jobId = req.params.job_id
      const url = new URL(`${HERMES_URL}/hermes/dashboard/sync/status/${jobId}`)
      const res = await fetch(url.toString(), {
        headers: { 
          'X-Agent-Key': AGENT_SECRET,
          'X-User-Id': req.user.id
        },
        signal: AbortSignal.timeout(NORMAL_TIMEOUT_MS),
      })
      return reply.code(res.status).send(await res.json())
    } catch (err) {
      return reply.code(503).send({ error: err.message })
    }
  })

}
