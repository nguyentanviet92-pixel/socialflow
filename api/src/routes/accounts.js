const { extractCUserId, generateFingerprint, normalizeCookieInput, validateCookie } = require('../services/facebook/fb-auth')
const { fetchPersonalInbox, replyPersonalMessage } = require('../services/facebook/fb-inbox')
const { getAccessibleIds, canAccess } = require('../lib/access-check')
const { buildInitialBudget } = require('../services/warmup-budget')
const { redistributeActiveHours } = require('../services/active-hours-redistributor')

module.exports = async (fastify) => {
  const { supabase } = fastify

  // Helper: resolve effective owner_id (admin can impersonate via ?as_user=uuid)
  function getOwnerId(req) {
    const asUser = req.query?.as_user
    if (asUser && req.user.role === 'admin' && asUser !== req.user.id) {
      return asUser
    }
    return req.user.id
  }

  // GET /accounts/health-summary — Account health view for dashboard
  fastify.get('/health-summary', { preHandler: fastify.authenticate }, async (req, reply) => {
    const accessibleIds = await getAccessibleIds(supabase, req.user.id, 'account')
    if (accessibleIds.length === 0) return []

    const { data, error } = await supabase
      .from('account_health_summary')
      .select('*')
      .in('id', accessibleIds)
      .order('username')

    if (error) return reply.code(500).send({ error: error.message })
    return data || []
  })

  // GET /accounts/warning-scores — Risk levels for all accounts
  fastify.get('/warning-scores', { preHandler: fastify.authenticate }, async (req, reply) => {
    const accessibleIds = await getAccessibleIds(supabase, req.user.id, 'account')
    if (accessibleIds.length === 0) return []

    const { data, error } = await supabase
      .from('account_warning_scores')
      .select('*')
      .in('account_id', accessibleIds)

    if (error) return reply.code(500).send({ error: error.message })
    return data || []
  })

  // GET /accounts/hermes-scores — 7-day avg Hermes feedback score per nick
  // Used by AgentsRoster + any other UI that wants a per-nick health signal.
  // Returns: [{ account_id, avg_score, total_calls }]
  fastify.get('/hermes-scores', { preHandler: fastify.authenticate }, async (req, reply) => {
    const accessibleIds = await getAccessibleIds(supabase, req.user.id, 'account')
    if (accessibleIds.length === 0) return []

    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    // account_id in hermes_feedback is TEXT (agent-side identifier) — cast both sides
    // to text when comparing. pg-supabase wrapper doesn't implement complex aggregates,
    // so do group-by on the server via raw SQL through the shared pg pool.
    try {
      const sql = `
        SELECT account_id,
               AVG(score)::numeric(3,2) AS avg_score,
               COUNT(*)::int AS total_calls
        FROM hermes_feedback
        WHERE created_at > $1
          AND account_id = ANY($2::text[])
        GROUP BY account_id
      `
      const { rows } = await supabase._pool.query(sql, [since, accessibleIds])
      return rows
    } catch (err) {
      fastify.log.error({ err }, '[HERMES-SCORES] query failed')
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /accounts/:id/kpi-status — per-nick daily KPI summary + most
  // recent Hermes diagnosis (shortfall cause + plan) so the UI can
  // surface "why this nick is under target + what we're doing about it"
  // without digging through raw hermes_decisions.
  fastify.get('/:id/kpi-status', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access' })
    }
    const pool = supabase._pool
    if (!pool) return reply.code(500).send({ error: 'pg pool unavailable' })

    try {
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
      const { rows: kpiRows } = await pool.query(
        `SELECT k.campaign_id, c.name AS campaign_name,
                COALESCE(k.done_likes,0) AS done_likes, COALESCE(k.target_likes,0) AS target_likes,
                COALESCE(k.done_comments,0) AS done_comments, COALESCE(k.target_comments,0) AS target_comments,
                COALESCE(k.done_friend_requests,0) AS done_fr, COALESCE(k.target_friend_requests,0) AS target_fr,
                COALESCE(k.done_group_joins,0) AS done_joins, COALESCE(k.target_group_joins,0) AS target_joins
         FROM nick_kpi_daily k
         LEFT JOIN campaigns c ON c.id = k.campaign_id
         WHERE k.account_id = $1 AND k.date = $2`,
        [req.params.id, today]
      )

      const { rows: diagRows } = await pool.query(
        `SELECT id, created_at, decision_type, action_type, priority, reason, decision, outcome
         FROM hermes_decisions
         WHERE target_id = $1 AND decision_type IN ('kpi_shortfall', 'capability_bump')
           AND created_at > now() - INTERVAL '48 hours'
         ORDER BY created_at DESC
         LIMIT 5`,
        [req.params.id]
      )

      return { kpi: kpiRows, diagnoses: diagRows }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /accounts/:id/quota-today — today's daily job creation quota status
  // Returns { [job_type]: { used, quota, remaining } } for per-nick UI badge.
  fastify.get('/:id/quota-today', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access' })
    }
    try {
      const { getQuotaStatus } = require('../services/nick-quota')
      const status = await getQuotaStatus(supabase, req.params.id)
      return status
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /accounts/:id/health-signals — Recent signals for a specific account
  fastify.get('/:id/health-signals', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access' })
    }

    const { data, error } = await supabase
      .from('account_health_signals')
      .select('*')
      .eq('account_id', req.params.id)
      .order('detected_at', { ascending: false })
      .limit(50)

    if (error) return reply.code(500).send({ error: error.message })
    return data || []
  })

  // GET /accounts/:id/avatar — redirect to R2-stored avatar or fallback
  fastify.get('/:id/avatar', async (req, reply) => {
    try {
      const { data: account } = await supabase
        .from('accounts')
        .select('avatar_url, fb_user_id')
        .eq('id', req.params.id)
        .single()

      if (!account) return reply.code(404).send({ error: 'Not found' })

      // Prefer R2 URL (set by check-health after upload)
      if (account.avatar_url) {
        return reply.redirect(302, account.avatar_url)
      }

      // Fallback: Graph API (may not work without token)
      if (account.fb_user_id) {
        return reply.redirect(302, `https://graph.facebook.com/${account.fb_user_id}/picture?type=large`)
      }

      return reply.code(404).send({ error: 'No avatar' })
    } catch {
      return reply.code(500).send({ error: 'Avatar error' })
    }
  })

  // NOTE: Old warmup-status and warmup endpoints removed.
  // Nurture system (GET /nurture/profiles, POST /nurture/profiles/:id/run) replaces them.

  // GET /accounts - List accounts user owns + accounts granted by admin
  fastify.get('/', { preHandler: fastify.authenticate }, async (req, reply) => {
    const accessibleIds = await getAccessibleIds(supabase, req.user.id, 'account')

    let query = supabase.from('accounts').select('*, proxies(*)').order('created_at', { ascending: false })

    if (accessibleIds.length === 0) {
      return []
    }
    query = query.in('id', accessibleIds)

    const { data, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // GET /accounts/:id - Get single account (owner or granted)
  fastify.get('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access to this account' })
    }

    const { data, error } = await supabase
      .from('accounts')
      .select('*, proxies(*), fanpages(*), fb_groups(*)')
      .eq('id', req.params.id)
      .single()

    if (error) return reply.code(404).send({ error: 'Not found' })
    return data
  })

  // POST /accounts - Add account (save only, no validation)
  fastify.post('/', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { cookie_string: rawCookie, username, browser_type, proxy_id, notes, fb_created_at, daily_budget } = req.body
    if (!rawCookie) return reply.code(400).send({ error: 'cookie_string required' })

    const normalized = normalizeCookieInput(rawCookie)
    if (!normalized.ok) {
      return reply.code(400).send({
        error: `Cookie không hợp lệ (${normalized.reason}). Cần có cả c_user và xs. Paste cookie header "c_user=...; xs=..." hoặc JSON export từ EditThisCookie.`
      })
    }
    const cookie_string = normalized.cookieString
    const fbUserId = normalized.fbUserId || extractCUserId(cookie_string)
    const fingerprint = generateFingerprint(fbUserId)

    // Build warmup-aware budget from the nick's real FB age (fb_created_at).
    // Falls back to age 0 (most conservative curve) if fb_created_at is missing.
    const mergedBudget = buildInitialBudget({ fb_created_at }, daily_budget)

    const { data, error } = await supabase.from('accounts').insert({
      owner_id: req.user.id,
      username: username || (fbUserId ? `User ${fbUserId}` : 'Unknown'),
      fb_user_id: fbUserId,
      cookie_string,
      browser_type: browser_type || 'chromium',
      proxy_id: proxy_id || null,
      user_agent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      timezone: fingerprint.timezone,
      status: 'unknown',
      notes,
      fb_created_at: fb_created_at || null,
      daily_budget: mergedBudget,
    }).select().single()

    if (error) return reply.code(500).send({ error: error.message })

    // Recompute active_hours across this owner's living nicks (event-driven).
    try {
      const r = await redistributeActiveHours(supabase, req.user.id, { reason: 'account_added' })
      fastify.log.info({ r }, '[ACTIVE-HOURS] redistributed after account_added')
    } catch (e) {
      fastify.log.warn({ err: e.message }, '[ACTIVE-HOURS] redistribute failed after account_added')
    }

    return reply.code(201).send(data)
  })

  // PUT /accounts/:id - Update account
  fastify.put('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const allowed = ['username', 'browser_type', 'proxy_id', 'notes', 'is_active',
      'active_hours_start', 'active_hours_end', 'active_hours_locked', 'active_days',
      'min_interval_minutes', 'max_daily_posts', 'random_delay_minutes', 'fb_created_at']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    const { data, error } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .select()
      .single()

    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // DELETE /accounts/:id
  fastify.delete('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { error } = await supabase
      .from('accounts')
      .delete()
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)

    if (error) return reply.code(500).send({ error: error.message })
    return { success: true }
  })

  // GET /accounts/:id/voice-profile — Per-nick content voice (tone, slang, vocab)
  // Used by Hermes to generate comments/captions in this nick's distinctive style.
  fastify.get('/:id/voice-profile', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data, error } = await supabase
      .from('nick_personality')
      .select('account_id, voice_profile, preset_name')
      .eq('account_id', req.params.id)
      .maybeSingle()
    if (error) return reply.code(500).send({ error: error.message })
    return data || { account_id: req.params.id, voice_profile: {}, preset_name: null }
  })

  // 5 voice presets — kept in sync with frontend VoiceProfileEditor.PRESETS.
  // Defined here too so backend can auto-assign without frontend round-trip.
  const VOICE_PRESETS = {
    tech_25_male: {
      persona_label: 'Thanh niên IT 25 tuổi',
      tone: 'casual, hơi sarcasm, thích tranh luận kỹ thuật',
      slang_level: 'high', emoji_freq: 'low',
      vocab_examples: ['mình', 'bro', 'k', 'ko', 'nma', 'chứ', 'ờm'],
      banned_phrases: ['kính gửi', 'em xin', 'ạ', 'dạ vâng'],
      interests: ['lập trình', 'gaming', 'crypto', 'gym', 'F1'],
      writing_quirks: 'Hay viết tắt "k" thay "không", không dấu chấm cuối câu',
    },
    mom_35_female: {
      persona_label: 'Mẹ bỉm 35 tuổi',
      tone: 'thân thiện, ấm áp, hay quan tâm hỏi han',
      slang_level: 'low', emoji_freq: 'medium',
      vocab_examples: ['các mẹ', 'mom', 'baby nhà mình', 'ơi', 'nha', 'ạ'],
      banned_phrases: ['vc', 'vl', 'đm', 'dmm'],
      interests: ['nuôi con', 'bỉm sữa', 'nấu ăn', 'mua sắm online', 'gia đình'],
      writing_quirks: 'Hay gọi "các mẹ ơi", kết câu "nha", "ạ"; emoji ❤️ 🥰',
    },
    student_20: {
      persona_label: 'Sinh viên 20 tuổi',
      tone: 'năng động, vô tư, hay đùa',
      slang_level: 'high', emoji_freq: 'high',
      vocab_examples: ['t', 'mày', 'tau', 'đm chứ', 'vcl', 'cay vl', 'sml', 'oke'],
      banned_phrases: ['kính gửi', 'trân trọng'],
      interests: ['học hành', 'meme', 'idol Kpop', 'phim', 'cafe'],
      writing_quirks: 'Hay dùng "t" thay "tao/tôi", emoji 😂 🥲 nhiều',
    },
    office_30_neutral: {
      persona_label: 'Nhân viên văn phòng 30 tuổi',
      tone: 'lịch sự, trung tính, có phần dè dặt',
      slang_level: 'low', emoji_freq: 'low',
      vocab_examples: ['mình', 'bạn', 'theo mình', 'thực ra'],
      banned_phrases: ['vc', 'vl', 'đm', 'tau', 'mày'],
      interests: ['công việc', 'tài chính cá nhân', 'du lịch', 'ẩm thực'],
      writing_quirks: 'Câu đầy đủ chủ ngữ vị ngữ, có dấu chấm câu',
    },
    business_40_male: {
      persona_label: 'Anh kinh doanh 40 tuổi',
      tone: 'chững chạc, thực dụng, đi thẳng vấn đề',
      slang_level: 'low', emoji_freq: 'none',
      vocab_examples: ['anh', 'em', 'theo kinh nghiệm', 'thực tế là', 'cái này'],
      banned_phrases: ['vc', 'vl', 'mày', 'tau', 'idol', 'oke'],
      interests: ['kinh doanh', 'đầu tư', 'bất động sản', 'xe hơi', 'thể thao'],
      writing_quirks: 'Xưng "anh", gọi "em" hoặc "bạn"; câu ngắn súc tích',
    },
  }
  const PRESET_KEYS = Object.keys(VOICE_PRESETS)

  // Deterministic preset pick from account_id → same nick always maps to same preset
  // (so re-running auto-assign doesn't reshuffle existing voices).
  function pickPresetForId(accountId) {
    let h = 0
    for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) | 0
    const idx = Math.abs(h) % PRESET_KEYS.length
    return PRESET_KEYS[idx]
  }

  // POST /accounts/voice-profiles/auto-assign — bulk-assign presets to all
  // nicks that don't have a voice_profile yet. Deterministic per account_id.
  // Body: { force?: boolean } — if true, overwrite existing profiles too.
  fastify.post('/voice-profiles/auto-assign', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { force = false } = req.body || {}

    // Get all nicks belonging to this user (or all if admin)
    let q = supabase.from('accounts').select('id, username').eq('is_active', true)
    if (req.user.role !== 'admin') q = q.eq('owner_id', req.user.id)
    const { data: nicks, error: nickErr } = await q
    if (nickErr) return reply.code(500).send({ error: nickErr.message })
    if (!nicks?.length) return { assigned: 0, total: 0, details: [] }

    // Find which already have a non-empty voice_profile
    let existing = new Set()
    if (!force) {
      const { data: rows } = await supabase
        .from('nick_personality')
        .select('account_id, voice_profile')
        .in('account_id', nicks.map(n => n.id))
      for (const r of rows || []) {
        if (r.voice_profile && Object.keys(r.voice_profile).length > 0) {
          existing.add(r.account_id)
        }
      }
    }

    const targets = nicks.filter(n => !existing.has(n.id))
    if (!targets.length) return { assigned: 0, total: nicks.length, details: [], skipped: existing.size }

    // Build upsert rows
    const now = new Date().toISOString()
    const rows = targets.map(n => {
      const presetKey = pickPresetForId(n.id)
      return {
        account_id: n.id,
        voice_profile: VOICE_PRESETS[presetKey],
        preset_name: presetKey,
        updated_at: now,
      }
    })

    const { error: upErr } = await supabase
      .from('nick_personality')
      .upsert(rows, { onConflict: 'account_id' })
    if (upErr) return reply.code(500).send({ error: upErr.message })

    return {
      assigned: targets.length,
      total: nicks.length,
      skipped: existing.size,
      details: targets.map((n, i) => ({
        username: n.username,
        preset: rows[i].preset_name,
        persona: VOICE_PRESETS[rows[i].preset_name].persona_label,
      })),
    }
  })

  // POST /accounts/:id/voice-profile/suggest — call Hermes to suggest a voice
  // profile based on nick metadata (username, recent activity, age).
  // Returns the suggested JSON; user reviews + saves via PUT.
  fastify.post('/:id/voice-profile/suggest', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: acc } = await supabase
      .from('accounts')
      .select('id, username, owner_id, fb_user_id, created_at, notes')
      .eq('id', req.params.id).maybeSingle()
    if (!acc) return reply.code(404).send({ error: 'Account not found' })
    if (req.user.role !== 'admin' && acc.owner_id !== req.user.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const { getOrchestratorForUser } = require('../services/ai/orchestrator')
    const orchestrator = await getOrchestratorForUser(req.user.id, supabase)

    const userPrompt = `Tạo voice_profile cho nick Facebook này. Trả về JSON với các field:
persona_label (string), tone (string), slang_level (none|low|medium|high), emoji_freq (none|low|medium|high), vocab_examples (string[]), banned_phrases (string[]), interests (string[]), writing_quirks (string).

Username: "${acc.username || acc.fb_user_id || 'unknown'}"
Notes: ${acc.notes || '(không có)'}
Đoán dựa trên username + ngữ cảnh người Việt dùng FB. Mỗi nick phải có giọng KHÁC NHAU.

Trả về CHỈ JSON, không markdown wrapper.`

    try {
      const result = await orchestrator.call('caption_gen', [
        { role: 'user', content: userPrompt }
      ], { max_tokens: 600 })
      const text = (result?.text || result || '').trim()
      // Extract JSON
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return reply.code(502).send({ error: 'Hermes did not return JSON', raw: text.slice(0, 300) })
      let suggested
      try { suggested = JSON.parse(m[0]) } catch (e) {
        return reply.code(502).send({ error: 'Invalid JSON from Hermes', raw: m[0].slice(0, 300) })
      }
      return { suggested, raw: text.slice(0, 500) }
    } catch (err) {
      return reply.code(502).send({ error: `AI suggest failed: ${err.message}` })
    }
  })

  // 2026-05-05: AI-driven per-nick schedule profile generator.
  // POST /accounts/:id/generate-schedule — call Hermes to design a daily
  // "personality schedule" so the scheduler can stagger nicks at humanly-
  // believable, deterministic-yet-varied times. Stored on accounts.schedule_profile.
  fastify.post('/:id/generate-schedule', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: acc } = await supabase
      .from('accounts')
      .select('id, username, owner_id, fb_user_id, fb_created_at, created_at')
      .eq('id', req.params.id).maybeSingle()
    if (!acc) return reply.code(404).send({ error: 'Account not found' })
    if (req.user.role !== 'admin' && acc.owner_id !== req.user.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Existing offsets in same campaign(s) — feed to AI so it picks a slot
    // that's not too close to other nicks.
    const { data: peers } = await supabase
      .from('accounts')
      .select('schedule_profile')
      .eq('owner_id', acc.owner_id)
      .neq('id', acc.id)
      .not('schedule_profile', 'is', null)
      .limit(50)
    const existingOffsets = (peers || [])
      .map(p => p.schedule_profile?.peak_offset_minutes)
      .filter(n => Number.isFinite(n))

    const ageDays = Math.floor((Date.now() - new Date(acc.fb_created_at || acc.created_at).getTime()) / 86400000)

    const { getOrchestratorForUser } = require('../services/ai/orchestrator')
    const orchestrator = await getOrchestratorForUser(req.user.id, supabase)

    const userPrompt = `Tạo schedule profile cho nick FB này. Mục tiêu: scheduler sẽ pick thời điểm fire jobs trong ngày sao cho nick này nhìn như 1 người THẬT có thói quen riêng, KHÁC các nick khác (anti-bot).

Nick: { username: "${acc.username || acc.fb_user_id || 'unknown'}", age_days: ${ageDays} }
Existing offsets (đã dùng bởi nick khác cùng owner): ${JSON.stringify(existingOffsets)}

Trả về CHỈ JSON object với fields:
- personality: 1 trong [morning_dev, night_owl, nine_to_five, flexible_freelancer, student, shift_worker, retired_active]
- active_hours_start: int 0-23
- active_hours_end: int 0-26 (cross-midnight ok, vd 26 = 2 sáng hôm sau)
- peak_offset_minutes: int 0-179 — phút sau cron trigger nick này thường fire. PHẢI cách existing_offsets ít nhất 20.
- jitter_minutes: int 10-30
- rest_windows: array of [start_min_of_day, end_min_of_day] — vd lunch [[720,780]]. 1-3 windows.
- explanation: 1 câu Vietnamese ngắn

Match personality:
- morning_dev → peak_offset 0-30, active 6-22
- night_owl → peak_offset 90-179, active 11-26
- nine_to_five → peak_offset 30-90, active 8-22
- shift_worker → peak_offset 60-150, active 14-26 hoặc 22-30

Không markdown wrapper. Chỉ JSON.`

    try {
      const result = await orchestrator.call('nick_schedule_planner', [
        { role: 'user', content: userPrompt }
      ], { max_tokens: 400, temperature: 0.7 })
      const text = (result?.text || result || '').trim()
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return reply.code(502).send({ error: 'Hermes did not return JSON', raw: text.slice(0, 300) })
      let profile
      try { profile = JSON.parse(m[0]) } catch (e) {
        return reply.code(502).send({ error: 'Invalid JSON from Hermes', raw: m[0].slice(0, 300) })
      }

      // Sanity defaults — guard against malformed AI output
      profile.personality = profile.personality || 'flexible_freelancer'
      profile.active_hours_start = Number.isFinite(profile.active_hours_start) ? profile.active_hours_start : 8
      profile.active_hours_end = Number.isFinite(profile.active_hours_end) ? profile.active_hours_end : 22
      profile.peak_offset_minutes = Number.isFinite(profile.peak_offset_minutes) ? Math.max(0, Math.min(179, profile.peak_offset_minutes)) : 60
      profile.jitter_minutes = Number.isFinite(profile.jitter_minutes) ? Math.max(5, Math.min(45, profile.jitter_minutes)) : 20
      profile.generated_at = new Date().toISOString()

      // Persist on account row
      await supabase.from('accounts').update({
        schedule_profile: profile,
        active_hours_start: profile.active_hours_start,
        active_hours_end: profile.active_hours_end,
      }).eq('id', acc.id)

      return { profile, raw: text.slice(0, 500) }
    } catch (err) {
      return reply.code(502).send({ error: `AI generate-schedule failed: ${err.message}` })
    }
  })

  // PUT /accounts/:id/voice-profile — Update voice profile.
  // Body: { voice_profile: {...} } — JSONB blob (see Hermes format_voice_profile_block).
  fastify.put('/:id/voice-profile', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { voice_profile, preset_name } = req.body || {}
    if (voice_profile != null && typeof voice_profile !== 'object') {
      return reply.code(400).send({ error: 'voice_profile must be an object' })
    }

    // Verify nick belongs to this user (or admin)
    const { data: acc } = await supabase
      .from('accounts').select('id, owner_id').eq('id', req.params.id).maybeSingle()
    if (!acc) return reply.code(404).send({ error: 'Account not found' })
    if (req.user.role !== 'admin' && acc.owner_id !== req.user.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Upsert (nick_personality might not exist yet)
    const { data, error } = await supabase
      .from('nick_personality')
      .upsert({
        account_id: req.params.id,
        voice_profile: voice_profile || {},
        ...(preset_name !== undefined && { preset_name }),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' })
      .select('account_id, voice_profile, preset_name')
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // GET /accounts/:id/fanpages - List fanpages (paginated when offset param present, array otherwise)
  fastify.get('/:id/fanpages', { preHandler: fastify.authenticate }, async (req, reply) => {
    const paginated = req.query.offset !== undefined
    const limit = Math.min(parseInt(req.query.limit) || 30, 100)
    const offset = parseInt(req.query.offset) || 0
    let query = supabase.from('fanpages').select('*').eq('account_id', req.params.id).order('created_at', { ascending: false })
    if (paginated) query = query.range(offset, offset + limit - 1)

    const { data, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    if (!paginated) return data || []
    return { items: data || [], hasMore: (data || []).length === limit }
  })

  // GET /accounts/:id/history - Publish history (paginated when offset param present)
  fastify.get('/:id/history', { preHandler: fastify.authenticate }, async (req, reply) => {
    const paginated = req.query.offset !== undefined
    const limit = Math.min(parseInt(req.query.limit) || 30, 100)
    const offset = parseInt(req.query.offset) || 0
    let query = supabase
      .from('publish_history')
      .select('id, status, published_at, target_type, target_name, final_caption, error_message, job_id, fb_post_id')
      .eq('account_id', req.params.id)
      .order('published_at', { ascending: false })
    if (paginated) query = query.range(offset, offset + limit - 1)
    else query = query.limit(50)

    const { data, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    const mapped = (data || []).map(h => ({
      id: h.id,
      status: h.status,
      action: h.target_type ? `Post → ${h.target_type}` : 'Published',
      detail: h.target_name || h.final_caption?.substring(0, 80) || null,
      created_at: h.published_at,
      error_message: h.error_message,
      job_id: h.job_id,
      fb_post_id: h.fb_post_id,
    }))
    if (!paginated) return mapped
    return { items: mapped, hasMore: mapped.length === limit }
  })

  // GET /accounts/:id/groups - List groups (paginated when offset param present, array otherwise)
  fastify.get('/:id/groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    const paginated = req.query.offset !== undefined
    const limit = Math.min(parseInt(req.query.limit) || 30, 100)
    const offset = parseInt(req.query.offset) || 0
    let query = supabase.from('fb_groups').select('*').eq('account_id', req.params.id).order('created_at', { ascending: false })
    if (paginated) query = query.range(offset, offset + limit - 1)

    const { data, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    if (!paginated) return data || []
    return { items: data || [], hasMore: (data || []).length === limit }
  })

  // POST /accounts/:id/fetch-pages - Agent job to scrape fanpages from Facebook
  fastify.post('/:id/fetch-pages', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: agents } = await supabase.from('agent_heartbeats').select('agent_id').gte('last_seen', new Date(Date.now() - 30000).toISOString()).limit(1)
    if (!agents?.length) return reply.code(503).send({ error: 'No agent online. Start the SocialFlow Agent first.' })

    const { data: job, error } = await supabase.from('jobs').insert({
      type: 'check_health', payload: { account_id: req.params.id, action: 'fetch_pages' }, status: 'pending', scheduled_at: new Date().toISOString(), created_by: req.user.id
    }).select().single()
    if (error) return reply.code(500).send({ error: error.message })
    return { message: 'Fetch pages queued', job_id: job.id }
  })

  // POST /accounts/:id/fetch-groups - Agent job to scrape groups from Facebook
  fastify.post('/:id/fetch-groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: agents } = await supabase.from('agent_heartbeats').select('agent_id').gte('last_seen', new Date(Date.now() - 30000).toISOString()).limit(1)
    if (!agents?.length) return reply.code(503).send({ error: 'No agent online. Start the SocialFlow Agent first.' })

    const { data: job, error } = await supabase.from('jobs').insert({
      type: 'check_health', payload: { account_id: req.params.id, action: 'fetch_groups' }, status: 'pending', scheduled_at: new Date().toISOString(), created_by: req.user.id
    }).select().single()
    if (error) return reply.code(500).send({ error: error.message })
    return { message: 'Fetch groups queued', job_id: job.id }
  })

  // POST /accounts/:id/fetch-all - Agent job to scrape BOTH pages + groups (1 tab, sequential)
  fastify.post('/:id/fetch-all', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: agents } = await supabase.from('agent_heartbeats').select('agent_id').gte('last_seen', new Date(Date.now() - 30000).toISOString()).limit(1)
    if (!agents?.length) return reply.code(503).send({ error: 'No agent online. Start the SocialFlow Agent first.' })

    const { data: job, error } = await supabase.from('jobs').insert({
      type: 'check_health', payload: { account_id: req.params.id, action: 'fetch_all' }, status: 'pending', scheduled_at: new Date().toISOString(), created_by: req.user.id
    }).select().single()
    if (error) return reply.code(500).send({ error: error.message })
    return { message: 'Fetch all queued', job_id: job.id }
  })

  // POST /accounts/:id/quick-post - Quick post to page/group/profile (supports multi-target)
  // Targets format: [{ type: 'page'|'group'|'profile', id: uuid, rewrite?: bool }]
  // media_mode: 'selected' (use media_id) | 'random' (pick random from library) | 'none'
  fastify.post('/:id/quick-post', { preHandler: fastify.authenticate }, async (req, reply) => {
    const account_id = req.params.id
    const { target_type, target_id, targets, caption, hashtags, media_id, scheduled_at,
      post_type, privacy, spin_mode, media_mode, random_media_ids, random_source } = req.body || {}

    const effectiveMediaMode = media_mode || 'selected'

    if (!caption && !media_id && effectiveMediaMode !== 'random') {
      return reply.code(400).send({ error: 'Caption or media required' })
    }

    // Build targets array: support both old single-target and new multi-target format
    let targetList = []
    if (targets?.length) {
      // New format: targets = [{ type: 'page', id: uuid, rewrite?: bool }, ...]
      targetList = targets
    } else if (target_type) {
      // Old format: single target_type + target_id
      targetList = [{ type: target_type, id: target_id }]
    } else {
      return reply.code(400).send({ error: 'targets[] or target_type required' })
    }

    // Validate target types
    const jobTypeMap = { page: 'post_page', group: 'post_group', profile: 'post_profile' }
    for (const t of targetList) {
      if (!jobTypeMap[t.type]) return reply.code(400).send({ error: `Invalid target type: ${t.type}` })
    }

    // Check agent online (only needed if any browser-based targets exist)
    // Will be checked after target classification below

    // Verify account belongs to user
    const { data: account } = await supabase.from('accounts').select('id').eq('id', account_id).eq('owner_id', req.user.id).single()
    if (!account) return reply.code(404).send({ error: 'Account not found' })

    // If media_mode is 'random', get available media IDs for random selection
    let availableMediaIds = []
    if (effectiveMediaMode === 'random') {
      if (random_media_ids?.length) {
        // User uploaded local files → use those specific IDs
        availableMediaIds = random_media_ids
      } else {
        // Random from library
        const { data: mediaItems } = await supabase
          .from('media')
          .select('id')
          .eq('owner_id', req.user.id)
          .limit(100)
        availableMediaIds = (mediaItems || []).map(m => m.id)
      }
    }

    // Normalize hashtags: string → array (frontend may send comma-separated string)
    const hashtagsArray = Array.isArray(hashtags)
      ? hashtags
      : typeof hashtags === 'string' && hashtags.trim()
        ? hashtags.split(/[,\s]+/).map(h => h.replace(/^#/, '').trim()).filter(Boolean)
        : []

    // Auto-create content record (with original caption)
    const { data: content, error: contentErr } = await supabase.from('contents').insert({
      owner_id: req.user.id,
      caption: caption || '',
      hashtags: hashtagsArray,
      media_id: effectiveMediaMode === 'selected' ? (media_id || null) : null,
      post_type: post_type || 'text',
      privacy: privacy || 'PUBLIC',
      spin_mode: spin_mode || 'none',
    }).select().single()
    if (contentErr) {
      req.log.error({ contentErr }, 'quick-post: content insert failed')
      return reply.code(500).send({ error: contentErr.message })
    }

    // Preload page access tokens to choose Graph job type when available
    console.log('[QUICK-POST] Debug: targetList', targetList.map(t => ({ type: t.type, id: t.id, name: t.name })))
    const pageTargetIds = targetList.filter(t => t.type === 'page' && t.id).map(t => t.id)
    const pageTokenMap = {}
    if (pageTargetIds.length > 0) {
      const { data: fanpages } = await supabase
        .from('fanpages')
        .select('id, access_token, posting_method')
        .in('id', pageTargetIds)
      for (const p of (fanpages || [])) {
        const method = p.posting_method || 'auto'
        if (method === 'access_token' && p.access_token) {
          pageTokenMap[p.id] = true
        } else if (method === 'auto' && p.access_token) {
          pageTokenMap[p.id] = true
        }
        // method === 'cookie' → never use Graph API
        console.log(`[QUICK-POST] Debug: fanpage ${p.id} method=${method} hasToken=${!!p.access_token} useGraph=${!!pageTokenMap[p.id]}`)
      }
    }
    console.log('[QUICK-POST] Debug: pageTokenMap', pageTokenMap)

    // Split targets: Graph API (direct post) vs Browser (job queue)
    const graphTargets = []
    const browserTargets = []
    for (const target of targetList) {
      if (target.type === 'page' && pageTokenMap[target.id] && !scheduled_at && !target.rewrite) {
        graphTargets.push(target)
      } else {
        browserTargets.push(target)
      }
    }

    const results = { direct: [], queued: [] }

    // === GRAPH API: Post directly from API server (instant) ===
    for (const target of graphTargets) {
      try {
        const { data: page } = await supabase
          .from('fanpages')
          .select('id, fb_page_id, name, access_token')
          .eq('id', target.id)
          .single()

        if (!page?.access_token) throw new Error('Missing access_token')

        // Build message
        let message = caption || ''
        if (hashtagsArray.length) {
          message += '\n\n' + hashtagsArray.map(t => t.startsWith('#') ? t : `#${t}`).join(' ')
        }

        // Get media URL if needed
        let mediaUrl = null
        let mediaType = null
        const mediaIdToUse = effectiveMediaMode === 'random' && availableMediaIds.length > 0
          ? availableMediaIds[Math.floor(Math.random() * availableMediaIds.length)]
          : media_id

        if (mediaIdToUse) {
          const { data: media } = await supabase.from('media').select('*').eq('id', mediaIdToUse).single()
          if (media) {
            const path = media.processed_path || media.original_path
            // If path is already a full URL, use it directly; otherwise prefix with R2 public URL
            if (path) {
              mediaUrl = path.startsWith('http') ? path : fastify.getR2PublicUrl(path)
            } else {
              mediaUrl = media.source_url
            }
            mediaType = media.type || 'image'
          }
        }

        // Post to Facebook Graph API
        const pageId = page.fb_page_id
        const token = page.access_token
        let fbPostId = null

        if (mediaUrl && mediaType === 'video') {
          const params = new URLSearchParams({ file_url: mediaUrl, access_token: token })
          if (message) params.append('description', message)
          const { data } = await require('axios').post(`https://graph.facebook.com/v18.0/${pageId}/videos`, params)
          fbPostId = data.id
        } else if (mediaUrl) {
          const params = new URLSearchParams({ url: mediaUrl, access_token: token })
          if (message) params.append('caption', message)
          const { data } = await require('axios').post(`https://graph.facebook.com/v18.0/${pageId}/photos`, params)
          fbPostId = data.id
        } else {
          const params = new URLSearchParams({ access_token: token })
          if (message) params.append('message', message)
          const { data } = await require('axios').post(`https://graph.facebook.com/v18.0/${pageId}/feed`, params)
          fbPostId = data.id
        }

        const postUrl = fbPostId ? `https://www.facebook.com/${fbPostId}` : null

        // Save publish history
        await supabase.from('publish_history').insert({
          content_id: content.id,
          account_id,
          target_type: 'page',
          target_fb_id: pageId,
          target_name: page.name,
          final_caption: message,
          fb_post_id: fbPostId,
          post_url: postUrl,
          status: 'success',
        })

        // Create a completed job record so it shows in ContentList
        await supabase.from('jobs').insert({
          type: 'post_page_graph',
          payload: { content_id: content.id, target_id: target.id, account_id, target_name: page.name },
          result: { page_name: page.name, fb_post_id: fbPostId, post_url: postUrl },
          status: 'done',
          scheduled_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          created_by: req.user.id,
        })

        // Update content status
        await supabase.from('contents').update({ status: 'published' }).eq('id', content.id)

        results.direct.push({ target: target.id, page: page.name, fb_post_id: fbPostId, post_url: postUrl, status: 'success' })
        console.log(`[QUICK-POST] Graph API direct post SUCCESS: ${page.name} -> ${fbPostId}`)
      } catch (err) {
        const fbError = err.response?.data?.error
        const errorMsg = fbError?.message || err.message
        const errorDetail = fbError ? JSON.stringify(fbError) : err.message
        req.log.error({ fbError: errorDetail, target: target.id }, `Graph API direct post FAILED: ${errorMsg}`)
        console.log(`[QUICK-POST] Graph API FAILED for ${target.id}: ${errorDetail}`)

        // Detect expired token and give clear message
        let userError = errorMsg
        if (fbError?.code === 190 || fbError?.error_subcode === 463 || errorMsg.includes('expired')) {
          userError = 'Access token đã hết hạn. Vui lòng cập nhật token mới trong Quản lý Fanpage.'
          // Mark page token as expired
          try { await supabase.from('fanpages').update({ token_status: 'expired' }).eq('id', target.id) } catch {}
        } else if (fbError?.code === 200 || fbError?.code === 10) {
          userError = 'Không có quyền đăng bài. Kiểm tra quyền Page token (pages_manage_posts).'
        }

        results.direct.push({ target: target.id, status: 'error', error: userError })
      }
    }

    // === BROWSER TARGETS: Create jobs for agent (with stagger delay) ===
    if (browserTargets.length > 0) {
      const { data: agents } = await supabase.from('agent_heartbeats').select('agent_id').gte('last_seen', new Date(Date.now() - 30000).toISOString()).limit(1)
      if (!agents?.length && results.direct.length === 0) {
        return reply.code(503).send({ error: 'No agent online. Start the SocialFlow Agent first.' })
      }
    }
    const jobIds = []
    let cumulativeDelayMs = 0
    for (let i = 0; i < browserTargets.length; i++) {
      const target = browserTargets[i]
      if (i > 0) {
        cumulativeDelayMs += (1 + Math.random() * 3) * 60 * 1000
      }
      const jobScheduledAt = scheduled_at
        ? new Date(new Date(scheduled_at).getTime() + cumulativeDelayMs).toISOString()
        : new Date(Date.now() + cumulativeDelayMs).toISOString()

      const jobPayload = {
        content_id: content.id,
        account_id,
        ...(target.id && { target_id: target.id }),
      }
      if (target.rewrite) jobPayload.spin = true
      if (effectiveMediaMode === 'random' && availableMediaIds.length > 0) {
        jobPayload.media_id_override = availableMediaIds[Math.floor(Math.random() * availableMediaIds.length)]
      }

      const jobType = jobTypeMap[target.type]
      const { data: job, error: jobErr } = await supabase.from('jobs').insert({
        type: jobType,
        payload: jobPayload,
        status: 'pending',
        scheduled_at: jobScheduledAt,
        created_by: req.user.id,
      }).select().single()

      if (jobErr) {
        req.log.error({ jobErr, target }, 'quick-post: job insert failed')
        continue
      }
      jobIds.push(job.id)
      results.queued.push({ target: target.id, job_id: job.id })
    }

    if (results.direct.length === 0 && jobIds.length === 0) {
      return reply.code(500).send({ error: 'Failed to publish any posts' })
    }

    const directOk = results.direct.filter(r => r.status === 'success').length
    const totalQueued = jobIds.length
    const msg = [
      directOk > 0 ? `${directOk} posted instantly` : null,
      totalQueued > 0 ? `${totalQueued} queued for agent` : null,
    ].filter(Boolean).join(', ')

    return {
      message: msg,
      direct_results: results.direct,
      job_ids: jobIds,
      content_id: content.id,
    }
  })

  // POST /accounts/:id/check-health - Create job for agent to validate
  fastify.post('/:id/check-health', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: account } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .single()

    if (!account) return reply.code(404).send({ error: 'Not found' })

    // Check if agent is online (heartbeat within last 30s)
    const { data: agents } = await supabase
      .from('agent_heartbeats')
      .select('agent_id')
      .gte('last_seen', new Date(Date.now() - 30000).toISOString())
      .limit(1)

    if (!agents?.length) {
      return reply.code(503).send({ error: 'No agent online. Start the SocialFlow Agent first.' })
    }

    // Create job for agent
    const { data: job, error } = await supabase.from('jobs').insert({
      type: 'check_health',
      payload: { account_id: req.params.id },
      status: 'pending',
      scheduled_at: new Date().toISOString(),
      created_by: req.user.id
    }).select().single()

    if (error) return reply.code(500).send({ error: error.message })

    // Update account status to show checking — defense-in-depth: scope to owner
    await supabase.from('accounts')
      .update({ status: 'checking' })
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)

    return { message: 'Check queued', job_id: job.id }
  })

  // POST /accounts/:id/update-cookie - Update cookie + trigger health check + auto-assign
  fastify.post('/:id/update-cookie', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { cookie_string: rawCookie } = req.body
    if (!rawCookie) return reply.code(400).send({ error: 'cookie_string required' })

    const normalized = normalizeCookieInput(rawCookie)
    if (!normalized.ok) {
      return reply.code(400).send({
        error: `Cookie không hợp lệ (${normalized.reason}). Cần có cả c_user và xs. Paste cookie header "c_user=...; xs=..." hoặc JSON export từ EditThisCookie.`
      })
    }
    const cookie_string = normalized.cookieString
    const fbUserId = normalized.fbUserId

    const { data, error } = await supabase.from('accounts').update({
      cookie_string,
      fb_user_id: fbUserId || undefined,
      status: 'unknown',
      is_active: true, // re-enable on cookie refresh
    }).eq('id', req.params.id).eq('owner_id', req.user.id).select().single()

    if (error) return reply.code(500).send({ error: error.message })

    // Immediate server-side validation — don't make user wait 3 min for agent
    // when a 2s HTTP check can already tell us if the cookie is good.
    let immediateStatus = null
    try {
      const v = await validateCookie(data)
      if (v.valid === true) {
        immediateStatus = 'healthy'
        await supabase.from('accounts').update({
          status: 'healthy',
          last_checked_at: new Date().toISOString(),
          last_error: null,
        }).eq('id', req.params.id)
      } else if (v.valid === false) {
        const reasonMap = { CHECKPOINT: 'checkpoint', SESSION_EXPIRED: 'expired', DISABLED: 'disabled' }
        const mapped = reasonMap[v.reason]
        if (mapped) {
          immediateStatus = mapped
          await supabase.from('accounts').update({
            status: mapped,
            last_checked_at: new Date().toISOString(),
            last_error: v.reason,
            is_active: false,
          }).eq('id', req.params.id)
        }
      }
      // valid: null (AMBIGUOUS) → leave as 'unknown', let agent verify
    } catch (e) {
      fastify.log.warn({ err: e.message }, '[UPDATE-COOKIE] immediate validate failed — falling back to agent')
    }

    // Queue check_health job — agent does deep verify (DOM + dtsg + avatar) even
    // if immediate check passed, so the nick gets a complete profile snapshot.
    const { data: job } = await supabase.from('jobs').insert({
      type: 'check_health',
      priority: 1,
      payload: { account_id: req.params.id, auto_refresh: true, triggered_by: 'cookie_update' },
      status: 'pending',
      scheduled_at: new Date().toISOString(),
      created_by: req.user.id,
    }).select().single()

    // Cookie refresh re-enabled the nick — recompute active_hours so the
    // revived nick gets a slot in the living-nick rotation.
    try {
      const r = await redistributeActiveHours(supabase, req.user.id, { reason: 'cookie_refreshed' })
      fastify.log.info({ r }, '[ACTIVE-HOURS] redistributed after cookie_refreshed')
    } catch (e) {
      fastify.log.warn({ err: e.message }, '[ACTIVE-HOURS] redistribute failed after cookie_refreshed')
    }

    return {
      ...data,
      status: immediateStatus || 'unknown',
      health_check_job_id: job?.id,
      immediate_validation: immediateStatus ? { passed: immediateStatus === 'healthy', status: immediateStatus } : null,
      message: immediateStatus === 'healthy'
        ? 'Cookie verified — nick active'
        : immediateStatus
          ? `Cookie issue: ${immediateStatus}`
          : 'Cookie updated — health check queued',
    }
  })

  // ─── PATCH /accounts/:id/status ──────────────────────────
  // Update account status (agent-side via X-Agent-Key OR user via JWT)
  // When status becomes checkpoint/expired/disabled → auto-cancel pending jobs
  fastify.patch('/:id/status', async (req, reply) => {
    // Dual auth: agent-key OR JWT
    const AGENT_SECRET = process.env.AGENT_SECRET
    const isAgent = AGENT_SECRET && req.headers['x-agent-key'] === AGENT_SECRET
    let ownerId = null
    if (!isAgent) {
      try {
        await fastify.authenticate(req, reply)
        if (reply.sent) return
        ownerId = req.user.id
      } catch {
        return reply.code(401).send({ error: 'Auth required' })
      }
    }

    const { status, reason, detected_at } = req.body || {}
    const allowedStatus = ['healthy', 'checkpoint', 'expired', 'disabled', 'unknown', 'at_risk', 'banned']
    if (!allowedStatus.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${allowedStatus.join('|')}` })
    }

    // Verify account (if JWT, enforce ownership)
    let query = supabase.from('accounts').select('id, owner_id, username').eq('id', req.params.id)
    if (!isAgent) query = query.eq('owner_id', ownerId)
    const { data: account } = await query.single()
    if (!account) return reply.code(404).send({ error: 'Account not found' })

    const updates = { status, last_error: reason || null }
    if (status !== 'healthy') updates.is_active = false
    if (status === 'healthy') {
      updates.is_active = true
      updates.last_checked_at = new Date().toISOString()
    }

    await supabase.from('accounts').update(updates).eq('id', req.params.id)

    // If status is bad → cancel pending/claimed jobs
    let cancelledCount = 0
    if (['checkpoint', 'expired', 'disabled', 'banned'].includes(status)) {
      const { data: cancelled } = await supabase.from('jobs')
        .update({
          status: 'cancelled',
          error_message: `account_${status}: ${(reason || '').substring(0, 200)}`,
          finished_at: new Date().toISOString(),
        })
        .filter('payload->>account_id', 'eq', req.params.id)
        .in('status', ['pending', 'claimed'])
        .select('id')
      cancelledCount = cancelled?.length || 0

      // Create notification
      try {
        await supabase.from('notifications').insert({
          user_id: account.owner_id,
          type: 'account_dead',
          title: `Nick ${account.username} cần sửa cookie`,
          body: `Phát hiện: ${status}. ${reason || ''}. ${cancelledCount} job đã bị cancel.`,
          level: 'urgent',
          data: { account_id: req.params.id, status, reason, detected_at },
        })
      } catch {}
    }

    // Status change crosses the alive/dead boundary in either direction —
    // recompute active_hours for the owner's living set.
    try {
      const r = await redistributeActiveHours(supabase, account.owner_id, { reason: `status_${status}` })
      fastify.log.info({ r }, '[ACTIVE-HOURS] redistributed after status change')
    } catch (e) {
      fastify.log.warn({ err: e.message }, '[ACTIVE-HOURS] redistribute failed after status change')
    }

    return {
      ok: true,
      status,
      cancelled_jobs: cancelledCount,
      detected_at: detected_at || new Date().toISOString(),
    }
  })

  // ─── POST /accounts/:id/cancel-jobs ──────────────────────
  fastify.post('/:id/cancel-jobs', async (req, reply) => {
    const AGENT_SECRET = process.env.AGENT_SECRET
    const isAgent = AGENT_SECRET && req.headers['x-agent-key'] === AGENT_SECRET
    let ownerId = null
    if (!isAgent) {
      try {
        await fastify.authenticate(req, reply)
        if (reply.sent) return
        ownerId = req.user.id
      } catch {
        return reply.code(401).send({ error: 'Auth required' })
      }
    }

    const { reason = 'manual_cancel' } = req.body || {}
    let aq = supabase.from('accounts').select('id, owner_id').eq('id', req.params.id)
    if (!isAgent) aq = aq.eq('owner_id', ownerId)
    const { data: account } = await aq.single()
    if (!account) return reply.code(404).send({ error: 'Account not found' })

    const { data: cancelled } = await supabase.from('jobs')
      .update({
        status: 'cancelled',
        error_message: `cancelled: ${reason}`,
        finished_at: new Date().toISOString(),
      })
      .filter('payload->>account_id', 'eq', req.params.id)
      .in('status', ['pending', 'claimed', 'running'])
      .select('id')

    return { ok: true, cancelled: cancelled?.length || 0 }
  })

  // ─── POST /accounts/:id/activate ─────────────────────────
  // Mark account healthy + auto-assign a job based on campaign_roles
  fastify.post('/:id/activate', async (req, reply) => {
    // Dual auth
    const AGENT_SECRET = process.env.AGENT_SECRET
    const isAgent = AGENT_SECRET && req.headers['x-agent-key'] === AGENT_SECRET
    let ownerId = null
    if (!isAgent) {
      try {
        await fastify.authenticate(req, reply)
        if (reply.sent) return
        ownerId = req.user.id
      } catch {
        return reply.code(401).send({ error: 'Auth required' })
      }
    }

    let aq = supabase.from('accounts').select('id, owner_id, username, status, is_active').eq('id', req.params.id)
    if (!isAgent) aq = aq.eq('owner_id', ownerId)

    const { data: account } = await aq.single()
    if (!account) return reply.code(404).send({ error: 'Account not found' })

    // If agent, we get ownerId from the account
    if (isAgent) ownerId = account.owner_id

    // Mark healthy
    await supabase.from('accounts').update({
      status: 'healthy',
      is_active: true,
      last_checked_at: new Date().toISOString(),
    }).eq('id', req.params.id)

    // Find active campaign_role for this account
    const { data: campaigns } = await supabase.from('campaigns')
      .select('id, name, status, campaign_roles(id, role_type, account_ids, is_active)')
      .eq('owner_id', ownerId)
      .in('status', ['running', 'active'])

    let assignedJob = null
    const ROLE_TO_JOB_TYPE = {
      nurture:  'campaign_nurture',
      scout:    'campaign_discover_groups',
      connect:  'campaign_send_friend_request',
      interact: 'campaign_interact_profile',
      monitor:  'campaign_group_monitor',
      post:     'campaign_post',
    }
    for (const c of (campaigns || [])) {
      for (const role of (c.campaign_roles || [])) {
        if (!role.is_active) continue
        if (!(role.account_ids || []).includes(req.params.id)) continue
        const jobType = ROLE_TO_JOB_TYPE[role.role_type]
        if (!jobType) continue

        // Check if there's already a pending/running job for this nick + campaign
        const { data: existing } = await supabase.from('jobs')
          .select('id')
          .filter('payload->>account_id', 'eq', req.params.id)
          .filter('payload->>campaign_id', 'eq', c.id)
          .in('status', ['pending', 'claimed', 'running'])
          .gte('created_at', new Date(Date.now() - 30 * 60 * 1000).toISOString())
          .limit(1)
        if (existing?.length) continue

        const { data: job } = await supabase.from('jobs').insert({
          type: jobType,
          priority: 3,
          status: 'pending',
          payload: {
            account_id: req.params.id,
            campaign_id: c.id,
            role_id: role.id,
            role_type: role.role_type,
            owner_id: ownerId,
            triggered_by: 'activate',
          },
          scheduled_at: new Date(Date.now() + 30000).toISOString(), // 30s delay
          created_by: ownerId,
        }).select('id, type').single()
        if (job) {
          assignedJob = job
          break
        }
      }
      if (assignedJob) break
    }

    return {
      activated: true,
      account_id: req.params.id,
      status: 'healthy',
      assigned_job: assignedJob,
    }
  })

  // ─── GET /accounts/idle-assignable ───────────────────────
  // Healthy nicks with active campaign_role but no recent jobs
  fastify.get('/idle-assignable', async (req, reply) => {
    // Dual auth
    const AGENT_SECRET = process.env.AGENT_SECRET
    const isAgent = AGENT_SECRET && req.headers['x-agent-key'] === AGENT_SECRET
    let ownerId = null
    if (!isAgent) {
      try {
        await fastify.authenticate(req, reply)
        if (reply.sent) return
        ownerId = req.user.id
      } catch {
        return reply.code(401).send({ error: 'Auth required' })
      }
    }

    // Get all healthy active nicks
    let q = supabase.from('accounts').select('id, username, owner_id').eq('status', 'healthy').eq('is_active', true)
    if (!isAgent) q = q.eq('owner_id', ownerId)
    const { data: accounts } = await q
    if (!accounts?.length) return []

    const accIds = accounts.map(a => a.id)
    const ownerIds = [...new Set(accounts.map(a => a.owner_id))]

    // Find which have active campaign_role in running campaigns
    const { data: campaigns } = await supabase.from('campaigns')
      .select('id, name, owner_id, campaign_roles(id, role_type, account_ids, is_active)')
      .in('owner_id', ownerIds)
      .in('status', ['running', 'active'])

    const idleList = []
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    for (const acc of accounts) {
      for (const c of (campaigns || [])) {
        if (c.owner_id !== acc.owner_id) continue
        for (const role of (c.campaign_roles || [])) {
          if (!role.is_active) continue
          if (!(role.account_ids || []).includes(acc.id)) continue

          // Check recent jobs
          const { data: recent } = await supabase.from('jobs')
            .select('id')
            .filter('payload->>account_id', 'eq', acc.id)
            .in('status', ['pending', 'claimed', 'running'])
            .gte('created_at', thirtyMinAgo)
            .limit(1)
          if (recent?.length) continue

          idleList.push({
            id: acc.id,
            username: acc.username,
            role: role.role_type,
            campaign_id: c.id,
            campaign_name: c.name,
            role_id: role.id,
          })
          break // one entry per account is enough
        }
      }
    }

    return idleList
  })

  // POST /accounts/bulk-import - Import multiple accounts (save only)
  fastify.post('/bulk-import', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { cookies, browser_type } = req.body
    if (!cookies?.length) return reply.code(400).send({ error: 'cookies array required' })

    const results = []
    for (const rawCookie of cookies) {
      try {
        const normalized = normalizeCookieInput(rawCookie)
        if (!normalized.ok) {
          results.push({ ok: false, error: `invalid_cookie:${normalized.reason}` })
          continue
        }
        const cookie_string = normalized.cookieString
        const fbUserId = normalized.fbUserId
        const fingerprint = generateFingerprint(fbUserId)

        const { data, error } = await supabase.from('accounts').insert({
          owner_id: req.user.id,
          username: `User ${fbUserId}`,
          fb_user_id: fbUserId,
          cookie_string,
          browser_type: browser_type || 'chromium',
          user_agent: fingerprint.userAgent,
          viewport: fingerprint.viewport,
          timezone: fingerprint.timezone,
          status: 'unknown',
          // bulk-import has no fb_created_at — age defaults to 0 → week1 curve (most conservative)
          daily_budget: buildInitialBudget({}),
        }).select().single()

        results.push({ fbUserId, success: !error, id: data?.id })
      } catch (err) {
        results.push({ cookie: cookie_string.substring(0, 20) + '...', success: false, error: err.message })
      }
    }

    return results
  })

  // ============================================
  // PERSONAL MESSENGER
  // ============================================

  // GET /accounts/:id/inbox — list personal messages from DB
  fastify.get('/:id/inbox', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access' })
    }

    const limit = parseInt(req.query.limit) || 50
    const { data, error } = await supabase
      .from('inbox_messages')
      .select('*')
      .eq('fanpage_id', req.params.id) // reuse fanpage_id field for account_id
      .eq('message_type', 'personal')
      .order('received_at', { ascending: false })
      .limit(limit)

    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // POST /accounts/:id/fetch-inbox — fetch personal messenger (cookie, 6h rate limit)
  fastify.post('/:id/fetch-inbox', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access' })
    }

    const { data: account } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (!account) return reply.code(404).send({ error: 'Account not found' })

    // Rate limit: 6h
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    if (account.last_inbox_fetched_at && account.last_inbox_fetched_at > sixHoursAgo) {
      return { fetched: 0, skipped: true, message: 'Da tai trong 6h qua' }
    }

    const messages = await fetchPersonalInbox(account, supabase)

    // Upsert — reuse inbox_messages table with message_type='personal'
    if (messages.length > 0) {
      const rows = messages.map(m => ({
        fanpage_id: req.params.id, // reuse for account_id
        fb_thread_id: m.fb_thread_id,
        fb_message_id: m.fb_message_id,
        sender_name: m.sender_name,
        sender_fb_id: m.sender_fb_id,
        message_text: m.message_text,
        message_type: 'personal',
        received_at: m.received_at,
      }))

      await supabase.from('inbox_messages').upsert(rows, { onConflict: 'fb_message_id' })
    }

    return { fetched: messages.length }
  })

  // POST /accounts/:id/reply-message — reply to personal message
  fastify.post('/:id/reply-message', { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!await canAccess(supabase, req.user.id, 'account', req.params.id)) {
      return reply.code(403).send({ error: 'No access' })
    }

    const { thread_id, reply_text } = req.body
    if (!thread_id || !reply_text) return reply.code(400).send({ error: 'thread_id and reply_text required' })

    const { data: account } = await supabase.from('accounts').select('*').eq('id', req.params.id).single()
    if (!account) return reply.code(404).send({ error: 'Account not found' })

    await replyPersonalMessage(account, thread_id, reply_text, supabase)
    return { success: true }
  })
}
