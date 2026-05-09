const { parseMission } = require('../services/campaign-planner')
const { rebalanceKPI } = require('../services/kpi-calculator')

// 2026-05-05: Apply per-nick budgets from ai_plan.per_nick to accounts.daily_budget.
// Each nick can have a unique daily limit set by Hermes (warm-up phase × voice ×
// personality), or hand-tuned by the user in the campaign UI. The agent's
// hard-limits.js reads accounts.daily_budget[key].max → so this is the wire
// between "campaign plan" and "agent enforcement".
//
// Key naming: planner skill outputs `scout` (semantic "thám dò"), agent's
// hard-limits.js uses `join_group`. Normalize at the wire.
const PLAN_KEY_TO_AGENT_KEY = {
  scout: 'join_group',
  // others passthrough
}
async function applyPerNickBudgets(supabase, aiPlan) {
  if (!aiPlan?.per_nick || typeof aiPlan.per_nick !== 'object') return
  const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0)
  const resetAt = new Date(todayUtc.getTime() + 86400000).toISOString()
  for (const [accountId, plan] of Object.entries(aiPlan.per_nick)) {
    const db = plan?.daily_budget
    if (!db || typeof db !== 'object') continue
    try {
      const { data: existing } = await supabase.from('accounts')
        .select('daily_budget').eq('id', accountId).maybeSingle()
      const merged = { ...(existing?.daily_budget || {}) }
      for (const [planKey, max] of Object.entries(db)) {
        if (!Number.isFinite(max)) continue
        const agentKey = PLAN_KEY_TO_AGENT_KEY[planKey] || planKey
        const cur = merged[agentKey] || { used: 0, max: 0, reset_at: resetAt }
        merged[agentKey] = { used: cur.used || 0, max: Math.floor(max), reset_at: cur.reset_at || resetAt }
      }
      await supabase.from('accounts').update({ daily_budget: merged }).eq('id', accountId)
    } catch (e) {
      console.warn(`[per-nick-budget] apply failed for ${accountId}: ${e.message}`)
    }
  }
}

// Phase 15: shared onboarding helper — fires priority scout jobs for nicks
// that have <3 active campaign_groups, respecting warmup (>=21d) + dedup.
async function onboardNewNicks(supabase, campaignId, nickIds, userId) {
  if (!nickIds?.length || !campaignId) return { scoutJobsCreated: 0, skippedTooYoung: 0, skippedEnoughGroups: 0 }

  const { data: roles } = await supabase.from('campaign_roles')
    .select('id, role_type, mission, parsed_plan, config, feeds_into, read_from')
    .eq('campaign_id', campaignId).eq('is_active', true)
  const scoutRole = (roles || []).find(r => r.role_type === 'scout')

  const { data: fullCampaign } = await supabase.from('campaigns')
    .select('id, name, topic, owner_id, brand_config, ad_mode')
    .eq('id', campaignId).single()

  const brandKeywords = []
  if (fullCampaign?.brand_config) {
    if (fullCampaign.brand_config.brand_name) brandKeywords.push(fullCampaign.brand_config.brand_name)
    if (Array.isArray(fullCampaign.brand_config.brand_keywords)) brandKeywords.push(...fullCampaign.brand_config.brand_keywords)
  }
  const scoutKeywords = brandKeywords.length
    ? [...new Set([...(fullCampaign?.topic ? [fullCampaign.topic] : []), ...brandKeywords])]
    : null

  let scoutJobsCreated = 0, skippedTooYoung = 0, skippedEnoughGroups = 0

  for (const nickId of nickIds) {
    const { count: groupCount } = await supabase.from('campaign_groups')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId).eq('assigned_nick_id', nickId).eq('status', 'active')
    if ((groupCount || 0) >= 3) { skippedEnoughGroups++; continue }

    const { data: nick } = await supabase.from('accounts')
      .select('id, username, is_active, status, fb_created_at, created_at')
      .eq('id', nickId).single()
    if (!nick || !nick.is_active || nick.status === 'expired' || nick.status === 'checkpoint') continue

    const createdAt = nick.fb_created_at || nick.created_at
    const ageDays = createdAt ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000) : 0
    if (ageDays < 21) { skippedTooYoung++; continue }

    const { count: existingScout } = await supabase.from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'campaign_discover_groups')
      .in('status', ['pending', 'claimed', 'running'])
      .filter('payload->>campaign_id', 'eq', campaignId)
      .filter('payload->>account_id', 'eq', nickId)
    if ((existingScout || 0) > 0) continue

    const { error: jobErr } = await supabase.from('jobs').insert({
      type: 'campaign_discover_groups',
      priority: 2,
      payload: {
        campaign_id: campaignId, role_id: scoutRole?.id || null,
        account_id: nickId, owner_id: fullCampaign?.owner_id || userId,
        mission: scoutRole?.mission || null, parsed_plan: scoutRole?.parsed_plan || null,
        config: scoutRole?.config || null, topic: fullCampaign?.topic || null,
        role_type: 'scout', feeds_into: scoutRole?.feeds_into || null,
        read_from: scoutRole?.read_from || null,
        brand_config: fullCampaign?.brand_config || null, brand_keywords: scoutKeywords,
        ad_mode: fullCampaign?.ad_mode || 'normal', reason: 'new_nick_onboarding',
      },
      status: 'pending', scheduled_at: new Date().toISOString(), created_by: userId,
    })
    if (!jobErr) {
      scoutJobsCreated++
      console.log(`[ONBOARD] Priority scout for ${nick.username || nickId.slice(0,8)} (${groupCount || 0}/3 groups)`)
    }
  }

  if (scoutJobsCreated > 0 || skippedTooYoung > 0) {
    const parts = []
    if (scoutJobsCreated > 0) parts.push(`${scoutJobsCreated} nick đang scout nhóm`)
    if (skippedTooYoung > 0) parts.push(`${skippedTooYoung} nick quá trẻ (<21d)`)
    if (skippedEnoughGroups > 0) parts.push(`${skippedEnoughGroups} nick đã đủ nhóm`)
    try {
      await supabase.from('notifications').insert({
        user_id: userId, type: 'nick_onboarding_started',
        title: `Đang onboard ${nickIds.length} nick mới`,
        body: `Chiến dịch "${fullCampaign?.name || ''}" — ${parts.join(' · ')}`,
        level: 'info',
      })
    } catch {}
  }
  return { scoutJobsCreated, skippedTooYoung, skippedEnoughGroups }
}

module.exports = async (fastify) => {
  const { supabase } = fastify

  // GET /campaigns/calendar - Calendar data for jobs + publish_history
  fastify.get('/calendar', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { start, end } = req.query
    if (!start || !end) return reply.code(400).send({ error: 'start and end query params required (ISO format)' })

    try {
      // Fetch scheduled/running jobs
      const { data: jobs } = await supabase
        .from('jobs')
        .select('id, type, payload, status, scheduled_at, started_at, finished_at, error_message')
        .gte('scheduled_at', start)
        .lte('scheduled_at', end)
        .eq('created_by', req.user.id)
        .order('scheduled_at', { ascending: true })

      // Fetch publish history
      const { data: history } = await supabase
        .from('publish_history')
        .select('id, target_type, target_name, target_fb_id, final_caption, status, published_at, error_message')
        .gte('published_at', start)
        .lte('published_at', end)
        .eq('account_id', req.user.id) // owner filter via join would be better
        .order('published_at', { ascending: true })

      // Build calendar events
      const events = []

      for (const job of (jobs || [])) {
        const action = job.payload?.action || job.type
        const targetName = job.payload?.target_name || action
        events.push({
          id: job.id,
          type: 'job',
          title: `${action.replace('post_', 'Post to ').replace('_', ' ')}`,
          target_name: targetName,
          start: job.scheduled_at,
          status: job.status,
          caption_preview: job.payload?.caption?.substring(0, 100) || null,
          error: job.error_message,
        })
      }

      for (const h of (history || [])) {
        events.push({
          id: h.id,
          type: 'history',
          title: `Posted to ${h.target_name || h.target_type}`,
          target_name: h.target_name,
          start: h.published_at,
          status: h.status,
          caption_preview: h.final_caption?.substring(0, 100) || null,
          error: h.error_message,
        })
      }

      return events
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /campaigns
  fastify.get('/', { preHandler: fastify.authenticate }, async (req, reply) => {
    // Include campaign_roles so FE can show role assignments without N+1 queries
    const { data, error } = await supabase
      .from('campaigns')
      .select('*, campaign_roles(*)')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false })

    if (error) return reply.code(500).send({ error: error.message })

    // Enrich with today's consolidated stats so the Mission Board doesn't
    // show hardcoded zeros. Source = nick_kpi_daily (the same table
    // /campaigns/:id/kpi-today reads) — keeps every view in sync.
    try {
      const pool = supabase._pool
      if (pool && data?.length) {
        const ids = data.map(c => c.id)
        const { rows: statRows } = await pool.query(
          `SELECT campaign_id,
                  COALESCE(SUM(done_likes),0)::int +
                  COALESCE(SUM(done_comments),0)::int +
                  COALESCE(SUM(done_friend_requests),0)::int +
                  COALESCE(SUM(done_group_joins),0)::int AS total_done,
                  COALESCE(SUM(target_likes),0)::int +
                  COALESCE(SUM(target_comments),0)::int +
                  COALESCE(SUM(target_friend_requests),0)::int +
                  COALESCE(SUM(target_group_joins),0)::int AS total_target,
                  COUNT(DISTINCT account_id)::int AS nicks_with_kpi
           FROM nick_kpi_daily
           WHERE campaign_id = ANY($1::uuid[]) AND date = CURRENT_DATE
           GROUP BY campaign_id`,
          [ids]
        )
        const statMap = Object.fromEntries(statRows.map(r => [r.campaign_id, r]))
        for (const c of data) {
          const s = statMap[c.id] || {}
          c.today_done = s.total_done || 0
          c.today_target = s.total_target || 0
          const roleNicks = (c.campaign_roles || []).flatMap(r => r.account_ids || [])
          c.nicks_count = new Set([...roleNicks, ...(c.account_ids || [])]).size
          c.roles_count = c.campaign_roles?.length || 0
        }
      }
    } catch (err) {
      req.log.warn({ err: err.message }, '[CAMPAIGNS] stats enrichment failed')
    }

    return data
  })

  // GET /campaigns/:id (includes roles)
  fastify.get('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*, campaign_roles(*)')
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .single()

    if (error || !data) return reply.code(404).send({ error: 'Not found' })
    // Sort roles by sort_order
    if (data.campaign_roles) {
      data.campaign_roles.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    }
    return data
  })

  // POST /campaigns/preview-plan — Builds proper roles from selected_actions OR mission
  fastify.post('/preview-plan', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { requirement, mission, topic, account_ids, runs_per_day, selected_actions, brand_config } = req.body
    if (!account_ids?.length) return reply.code(400).send({ error: 'account_ids required' })

    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, username, fb_user_id, status, daily_budget, created_at')
      .in('id', account_ids)
      .eq('owner_id', req.user.id)

    if (!accounts?.length) return reply.code(400).send({ error: 'No valid accounts found' })

    const runsPerDay = runs_per_day || 2
    const HARD_LIMITS = { like: 50, comment: 15, friend_request: 10, join_group: 3, post: 3, scan: 15 }

    try {
      // Build roles from selected_actions (new flow) or requirement (legacy)
      const actions = selected_actions || []
      const accountNames = accounts.map(a => a.username || a.fb_user_id)
      const allAccountIds = accounts.map(a => a.id)

      let roles = []

      if (actions.length > 0) {
        // === NEW: Build roles by action type mapping ===
        const hasAction = (key) => actions.some(a => a.key === key)
        const getCount = (key) => actions.find(a => a.key === key)?.count || 0

        // Scout role: join_group + scan_members
        if (hasAction('join_group')) {
          const countPerRun = Math.ceil(getCount('join_group') / runsPerDay)
          const capped = Math.min(countPerRun, HARD_LIMITS.join_group || 3)
          roles.push({
            name: 'Thám dò nhóm',
            role_type: 'scout',
            account_ids: allAccountIds,
            account_names: accountNames,
            steps: [
              { action: 'browse', description: 'Warm up trước khi tìm nhóm', params: {}, quota_key: 'scan', count_mode: 'fixed', count_min: 1, count_max: 1, priority: 1 },
              { action: 'join_group', description: `Tìm & tham gia nhóm về ${topic}`, params: { keywords: topic.split(/[,;]+/).map(k => k.trim()).filter(Boolean), min_members: 100 }, quota_key: 'join_group', count_mode: 'range', count_min: Math.max(1, capped - 1), count_max: capped, priority: 2 },
              { action: 'scan_members', description: 'Quét thành viên nhóm để tìm khách tiềm năng', params: {}, quota_key: 'scan', count_mode: 'fixed', count_min: 1, count_max: 1, priority: 3 },
            ],
          })
        }

        // Nurture role: browse + like + comment
        if (hasAction('like') || hasAction('comment')) {
          const steps = [
            { action: 'browse', description: 'Lướt feed warm up', params: {}, quota_key: 'scan', count_mode: 'fixed', count_min: 1, count_max: 1, priority: 1 },
          ]
          if (hasAction('like')) {
            const countPerRun = Math.ceil(getCount('like') / runsPerDay)
            const capped = Math.min(countPerRun, Math.ceil(HARD_LIMITS.like / runsPerDay))
            steps.push({ action: 'like', description: `Like ${getCount('like')} bài/ngày trong nhóm`, params: {}, quota_key: 'like', count_mode: 'range', count_min: Math.max(1, capped - 2), count_max: capped, priority: 2 })
          }
          if (hasAction('comment')) {
            const countPerRun = Math.ceil(getCount('comment') / runsPerDay)
            const capped = Math.min(countPerRun, Math.ceil(HARD_LIMITS.comment / runsPerDay))
            steps.push({ action: 'comment', description: `Comment ${getCount('comment')} bài/ngày về ${topic}`, params: { style: 'casual', topic }, quota_key: 'comment', count_mode: 'range', count_min: Math.max(1, capped - 1), count_max: capped, priority: 3 })
          }
          roles.push({
            name: 'Tương tác nhóm',
            role_type: 'nurture',
            account_ids: allAccountIds,
            account_names: accountNames,
            steps,
          })
        }

        // Connect role: friend_request
        if (hasAction('friend_request')) {
          const countPerRun = Math.ceil(getCount('friend_request') / runsPerDay)
          const capped = Math.min(countPerRun, Math.ceil(HARD_LIMITS.friend_request / runsPerDay))
          roles.push({
            name: 'Kết bạn',
            role_type: 'connect',
            account_ids: allAccountIds,
            account_names: accountNames,
            _depends_on: 'scout', // will be wired at save time
            steps: [
              { action: 'browse', description: 'Xem profile trước khi kết bạn', params: {}, quota_key: 'scan', count_mode: 'fixed', count_min: 1, count_max: 1, priority: 1 },
              { action: 'send_friend_request', description: `Kết bạn ${getCount('friend_request')}/ngày — AI đánh giá trước khi gửi`, params: { source: 'group_members' }, quota_key: 'friend_request', count_mode: 'range', count_min: Math.max(1, capped - 1), count_max: capped, priority: 2 },
            ],
          })
        }

        // Post role
        if (hasAction('post')) {
          const countPerRun = Math.ceil(getCount('post') / runsPerDay)
          roles.push({
            name: 'Đăng bài',
            role_type: 'post',
            account_ids: allAccountIds,
            account_names: accountNames,
            steps: [
              { action: 'post', description: `Đăng ${getCount('post')} bài/ngày`, params: { content_source: 'ai_gen' }, quota_key: 'post', count_mode: 'fixed', count_min: countPerRun, count_max: countPerRun, priority: 1 },
            ],
          })
        }
      } else if (mission || requirement) {
        // === NEW: mission-first flow — AI parses natural language → roles ===
        const nickAges = accounts.map(a => ({
          name: a.username || a.fb_user_id,
          age_days: Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000),
          status: a.status,
        }))

        const missionText = mission || requirement
        const steps = await parseMission(
          missionText,
          { topic: topic || '', roleType: 'auto', accountCount: accounts.length, accountNames, nickAges, runsPerDay, brandConfig: brand_config },
          req.user.id, supabase
        )

        // Group steps by role type derived from action
        const roleByType = {}
        const ROLE_OF_ACTION = {
          join_group: 'scout', scan_members: 'scout',
          like: 'nurture', comment: 'nurture', browse: 'nurture',
          send_friend_request: 'connect',
          post: 'post',
          reply: 'nurture',
        }
        const ROLE_NAME = {
          scout: 'Thám dò nhóm',
          nurture: 'Tương tác nhóm',
          connect: 'Kết bạn',
          post: 'Đăng bài',
        }
        for (const step of steps) {
          const rt = ROLE_OF_ACTION[step.action] || 'nurture'
          if (!roleByType[rt]) {
            roleByType[rt] = {
              name: ROLE_NAME[rt] || rt,
              role_type: rt,
              account_ids: allAccountIds,
              account_names: accountNames,
              steps: [],
            }
          }
          roleByType[rt].steps.push(step)
        }
        roles = Object.values(roleByType)

        // === ADS: inject opportunity_comment into nurture role if brand config enabled ===
        if (brand_config && brand_config.brand_name) {
          const nurture = roleByType.nurture
          if (nurture) {
            nurture.steps.push({
              action: 'comment',
              description: `Quảng cáo tự nhiên ${brand_config.brand_name}: tối đa 2 lần/nick/ngày`,
              params: {
                style: brand_config.brand_voice || 'casual',
                topic,
                ad_mode: true,
                brand_keywords: brand_config.brand_keywords || [],
              },
              quota_key: 'opportunity_comment',
              count_mode: 'range',
              count_min: 1,
              count_max: 2,
              priority: 9,
            })
          }
        }

        // Wire feeds_into for scout → connect
        const scoutR = roleByType.scout
        const connectR = roleByType.connect
        if (scoutR && connectR) {
          connectR._depends_on = 'scout'
        }
      } else {
        return reply.code(400).send({ error: 'selected_actions, mission, or requirement required' })
      }

      // 2026-05-05: cap per-nick daily at HARD_LIMITS (agent enforces these
      // anyway). Pre-cap math `count_max × runsPerDay` for an 8-run/day schedule
      // produces 40 cmt + 64 like + 40 fr per nick which scares users in the UI
      // even though the agent's poller would never let those run. Cap to safe
      // mature-nick limits and emit a note explaining warm-up scaling.
      const perNickDaily = {}
      const perNickRaw = {}  // pre-cap value, kept for warning detail
      for (const role of roles) {
        for (const step of (role.steps || [])) {
          const key = step.quota_key || step.action
          const max = step.count_max || step.count_min || 1
          const raw = max * runsPerDay
          perNickRaw[key] = Math.max(perNickRaw[key] || 0, raw)
          const hardCap = HARD_LIMITS[key]?.maxPerDay
          // Final budget = min(requested by plan, mature-nick safe cap).
          // Safety floor of 1 so we don't accidentally write 0 for tiny limits.
          perNickDaily[key] = Math.max(1, hardCap ? Math.min(raw, hardCap) : raw)
        }
      }

      const warnings = []
      for (const [key, raw] of Object.entries(perNickRaw)) {
        const limit = HARD_LIMITS[key]?.maxPerDay
        if (limit && raw > limit) warnings.push(`${key}: AI plan đề xuất ${raw}/nick/ngày, đã CAP về ${limit} (giới hạn an toàn — vượt sẽ tăng nguy cơ checkpoint)`)
      }
      // Always-present note about warm-up scaling — applies to ALL plans.
      warnings.push('NICK MỚI (<30 ngày): agent tự scale xuống 0-50% các giới hạn trên theo warm-up phase (week1: chỉ browse+like; week2: +comment nhẹ; week3: +join_group; week4: gần đầy đủ).')

      const totalSteps = roles.reduce((sum, r) => sum + (r.steps?.length || 0), 0)

      const plan = {
        summary: `${roles.length} roles, ${accounts.length} nicks, topic: ${topic || 'general'}`,
        roles,
        daily_budget: perNickDaily,
        safety_warnings: warnings,
        estimated_duration_minutes: Math.round(totalSteps * 3 * accounts.length),
        selected_actions: actions,
        brand_config: brand_config || null,
        ad_mode: brand_config?.brand_name ? 'ad_enabled' : 'normal',
        mission: mission || requirement || null,
      }

      return { plan, accounts: accountNames }
    } catch (err) {
      return reply.code(500).send({ error: `AI plan failed: ${err.message}` })
    }
  })

  // POST /campaigns/preview-plan-per-nick — Hermes generates a UNIQUE budget per nick
  // (warm-up phase × voice × personality from schedule_profile). UI shows the mini
  // plan inline under each nick name and lets user override before save.
  fastify.post('/preview-plan-per-nick', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { account_ids, topic, mission, brand_config, runs_per_day } = req.body || {}
    if (!Array.isArray(account_ids) || !account_ids.length) {
      return reply.code(400).send({ error: 'account_ids required' })
    }

    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, username, fb_user_id, fb_created_at, created_at, schedule_profile, daily_budget')
      .in('id', account_ids)
      .eq('owner_id', req.user.id)
    if (!accounts?.length) return reply.code(400).send({ error: 'No valid accounts found' })

    // voice_profile lives in nick_personality — fetch in parallel and zip in
    const { data: voiceRows } = await supabase
      .from('nick_personality')
      .select('account_id, voice_profile')
      .in('account_id', account_ids)
    const voiceByAcc = Object.fromEntries((voiceRows || []).map(r => [r.account_id, r.voice_profile]))

    const { getOrchestratorForUser } = require('../services/ai/orchestrator')
    const orchestrator = await getOrchestratorForUser(req.user.id, supabase)

    // Hard cap floor — even if Hermes says higher, never cross HARD_LIMITS.
    const HARD_CAPS = { browse: 20, like: 80, comment: 15, opportunity_comment: 3, scout: 5, friend_request: 15, post: 3 }
    const FALLBACK_BY_PHASE = {
      week1:  { browse: 1, like: 10, comment: 0, opportunity_comment: 0, scout: 0, friend_request: 0, post: 0 },
      week2:  { browse: 2, like: 22, comment: 2, opportunity_comment: 0, scout: 0, friend_request: 1, post: 0 },
      week3:  { browse: 3, like: 35, comment: 5, opportunity_comment: 0, scout: 1, friend_request: 3, post: 0 },
      week4:  { browse: 4, like: 45, comment: 8, opportunity_comment: 1, scout: 2, friend_request: 7, post: 1 },
      mature: { browse: 5, like: 60, comment: 12, opportunity_comment: 2, scout: 4, friend_request: 12, post: 2 },
    }
    const phaseFor = (ageDays) => {
      if (ageDays <= 7) return 'week1'
      if (ageDays <= 14) return 'week2'
      if (ageDays <= 21) return 'week3'
      if (ageDays <= 30) return 'week4'
      return 'mature'
    }
    const sanitize = (b, phase) => {
      const fb = FALLBACK_BY_PHASE[phase]
      const out = {}
      for (const k of Object.keys(HARD_CAPS)) {
        const raw = Number.isFinite(b?.[k]) ? Math.floor(b[k]) : fb[k]
        out[k] = Math.max(0, Math.min(HARD_CAPS[k], raw))
      }
      return out
    }

    // Run all nicks in parallel — Hermes is local so fan-out is fine
    const perNick = {}
    await Promise.all(accounts.map(async (acc) => {
      const ageDays = Math.floor((Date.now() - new Date(acc.fb_created_at || acc.created_at).getTime()) / 86400000)
      const phase = phaseFor(ageDays)
      const ctx = {
        nick: {
          username: acc.username || acc.fb_user_id || 'unknown',
          age_days: ageDays,
          brand_voice: voiceByAcc[acc.id]?.brand_voice || brand_config?.brand_voice || 'casual',
        },
        schedule_profile: acc.schedule_profile || null,
        runs_per_day: runs_per_day || 5,
        brand: brand_config?.brand_name ? { brand_name: brand_config.brand_name } : {},
        topic: topic || mission || '',
      }
      const userPrompt = `Tạo daily budget JSON cho nick này:\n${JSON.stringify(ctx, null, 2)}\n\nTrả về JSON theo schema, KHÔNG reasoning, KHÔNG markdown.`
      try {
        const result = await orchestrator.call('nick_budget_planner', [
          { role: 'user', content: userPrompt }
        ], { max_tokens: 300, temperature: 0.3 })
        const text = (result?.text || '').trim()
        const m = text.match(/\{[\s\S]*\}/)
        let parsed = null
        if (m) {
          try { parsed = JSON.parse(m[0]) } catch {}
        }
        const daily_budget = sanitize(parsed?.daily_budget, phase)
        perNick[acc.id] = {
          daily_budget,
          phase: parsed?.phase || phase,
          note: parsed?.note || `Phase ${phase}`,
          age_days: ageDays,
          username: acc.username || acc.fb_user_id,
          ai_generated: !!parsed?.daily_budget,
        }
      } catch (err) {
        // Fallback: phase-based table
        perNick[acc.id] = {
          daily_budget: { ...FALLBACK_BY_PHASE[phase] },
          phase,
          note: `Fallback ${phase} (Hermes lỗi: ${err.message?.slice(0, 60)})`,
          age_days: ageDays,
          username: acc.username || acc.fb_user_id,
          ai_generated: false,
        }
      }
    }))

    return { per_nick: perNick }
  })

  // POST /campaigns
  fastify.post('/', { preHandler: fastify.authenticate }, async (req, reply) => {
    const {
      name, topic, requirement, mission, language, min_member_count, brand_config, ad_mode,
      account_ids, ai_plan, ai_plan_confirmed,
      target_pages, target_groups, target_profiles,
      content_ids, rotation_mode, spin_mode,
      schedule_type, cron_expression, interval_minutes,
      start_at, end_at, delay_between_targets_minutes,
      nick_stagger_seconds, role_stagger_minutes, campaign_active_days
    } = req.body

    if (!name) return reply.code(400).send({ error: 'name required' })

    const { data, error } = await supabase.from('campaigns').insert({
      owner_id: req.user.id,
      name,
      topic: topic || null,
      requirement: requirement || null,
      mission: mission || null,
      language: language || 'vi',
      min_member_count: Number.isFinite(min_member_count) ? min_member_count : null,
      brand_config: brand_config || null,
      ad_mode: ad_mode || 'normal',
      account_ids: account_ids || [],
      ai_plan: ai_plan || null,
      ai_plan_confirmed: ai_plan_confirmed || false,
      target_pages: target_pages || [],
      target_groups: target_groups || [],
      target_profiles: target_profiles || [],
      content_ids: content_ids || [],
      rotation_mode: rotation_mode || 'sequential',
      spin_mode: spin_mode || 'basic',
      schedule_type, cron_expression, interval_minutes,
      start_at, end_at,
      delay_between_targets_minutes: delay_between_targets_minutes || 15,
      nick_stagger_seconds: nick_stagger_seconds || 60,
      role_stagger_minutes: role_stagger_minutes || 30,
      campaign_active_days: campaign_active_days || [1,2,3,4,5,6,0],
    }).select().single()

    if (error) return reply.code(500).send({ error: error.message })

    // Auto-create roles from ai_plan if confirmed
    if (ai_plan?.roles && ai_plan_confirmed) {
      const createdRoles = [] // track role IDs for wiring feeds_into

      for (let i = 0; i < ai_plan.roles.length; i++) {
        const role = ai_plan.roles[i]
        const { data: created } = await supabase.from('campaign_roles').insert({
          campaign_id: data.id,
          name: role.name || `Role ${String.fromCharCode(65 + i)}`,
          role_type: role.role_type || 'custom',
          account_ids: role.account_ids || [],
          mission: role.mission || '',
          parsed_plan: role.steps || null,
          sort_order: i,
          is_active: true,
        }).select('id, role_type').single()

        if (created) createdRoles.push({ ...created, _depends_on: role._depends_on })
      }

      // Wire feeds_into: scout feeds into connect (so connect gets targets from scout's scan)
      const scoutRole = createdRoles.find(r => r.role_type === 'scout')
      const connectRole = createdRoles.find(r => r.role_type === 'connect')
      if (scoutRole && connectRole) {
        await supabase.from('campaign_roles')
          .update({ feeds_into: connectRole.id })
          .eq('id', scoutRole.id)
        await supabase.from('campaign_roles')
          .update({ read_from: scoutRole.id })
          .eq('id', connectRole.id)
      }
    }

    // 2026-05-05: Apply per-nick budgets from ai_plan.per_nick to accounts.daily_budget.
    // This is the wire that makes the per-nick plan actually take effect — agent's
    // hard-limits.js reads daily_budget.{key}.max for each nick to gate actions.
    await applyPerNickBudgets(supabase, ai_plan)

    // Phase 15: onboard all nicks in the new campaign — auto-assign existing
    // groups + fire priority scout jobs for nicks with <3 groups.
    const allNickIds = [...new Set((ai_plan?.roles || []).flatMap(r => r.account_ids || []))]
    if (allNickIds.length) {
      // Auto-assign fb_groups rows where nick is_member=true
      try {
        const { data: theirGroups } = await supabase.from('fb_groups')
          .select('id, account_id, global_score, score_tier, ai_join_score')
          .in('account_id', allNickIds)
          .eq('is_member', true).eq('pending_approval', false)
          .or('is_blocked.is.null,is_blocked.eq.false')
        const junctionRows = (theirGroups || []).map(g => ({
          campaign_id: data.id, group_id: g.id, assigned_nick_id: g.account_id,
          score: g.global_score || g.ai_join_score || 5, tier: g.score_tier || 'C', status: 'active',
        }))
        if (junctionRows.length) {
          await supabase.from('campaign_groups').upsert(junctionRows, { onConflict: 'campaign_id,group_id' })
        }
      } catch {}

      // Fire scout jobs for nicks with <3 groups (background)
      onboardNewNicks(supabase, data.id, allNickIds, req.user.id).catch(err =>
        console.warn(`[ONBOARD] POST /campaigns error: ${err.message}`))

      // Rebalance KPI for the new campaign
      rebalanceKPI(supabase, data.id).catch(() => {})
    }

    return reply.code(201).send(data)
  })

  // PUT /campaigns/:id
  fastify.put('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const allowed = [
      'name', 'topic', 'requirement', 'mission', 'language', 'brand_config', 'ad_mode',
      'min_member_count',                   // 2026-05-02: scout member-count gate
      'account_ids', 'ai_plan', 'ai_plan_confirmed',
      'target_pages', 'target_groups', 'target_profiles',
      'content_ids', 'rotation_mode', 'spin_mode',
      'schedule_type', 'cron_expression', 'interval_minutes',
      'start_at', 'end_at', 'delay_between_targets_minutes',
      'nick_stagger_seconds', 'role_stagger_minutes', 'campaign_active_days',
      'kpi_config', // Phase 11
      'wave_config', // Phase 16
      'goal', 'hermes_context', 'status', // Hermes upgrade
      'hermes_central',                    // Hermes-central coordinator toggle
    ]
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    // Special handling: campaign_roles is a separate table — caller passes
    // updated array of {id?, role_type, account_ids, is_active}.
    // Strategy: replace all roles for this campaign (delete + insert).
    const incomingRoles = req.body.campaign_roles
    if (Array.isArray(incomingRoles)) {
      try {
        await supabase.from('campaign_roles').delete().eq('campaign_id', req.params.id)
        if (incomingRoles.length > 0) {
          const rows = incomingRoles.map(r => ({
            campaign_id: req.params.id,
            role_type: r.role_type,
            account_ids: r.account_ids || [],
            is_active: r.is_active !== undefined ? r.is_active : true,
            sort_order: r.sort_order || 0,
            name: r.name || null,
            mission: r.mission || null,
            config: r.config || {},
            parsed_plan: r.parsed_plan || null,
            quota_override: r.quota_override || null,
            read_from: r.read_from || null,
            feeds_into: r.feeds_into || null,
          }))
          await supabase.from('campaign_roles').insert(rows)
        }
      } catch (rolesErr) {
        fastify.log.error({ rolesErr }, 'Failed to update campaign_roles')
      }
    }

    const { data, error } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .select()
      .single()

    if (error) return reply.code(500).send({ error: error.message })

    // Phase 15: hoisted so the return payload can see it regardless of branch
    let newNickIdsForOnboard = []

    // Cascade account_ids to all campaign_roles so running campaigns pick up the
    // new nick roster on their next poll. Only do this when account_ids was provided.
    if (Array.isArray(req.body.account_ids)) {
      try {
        await supabase.from('campaign_roles')
          .update({ account_ids: req.body.account_ids })
          .eq('campaign_id', req.params.id)
      } catch (cascadeErr) {
        req.log?.warn?.(`cascade account_ids failed: ${cascadeErr.message}`)
      }

      // Phase 14: auto-assign existing groups to newly added nicks.
      // Compare old vs new account_ids to detect additions, then for each new
      // nick, pull their is_member=true fb_groups and upsert campaign_groups rows.
      try {
        const oldNickIds = new Set()
        // Pull previous roster from campaign_roles (pre-cascade snapshot).
        // Since we just cascaded above, we need the pre-update value — fetch from
        // the campaign object BEFORE the update. Easier: compute set diff using
        // the new roster and the existing junction assigned_nick_ids.
        const { data: existingJunction } = await supabase
          .from('campaign_groups')
          .select('assigned_nick_id')
          .eq('campaign_id', req.params.id)
          .eq('status', 'active')
        for (const row of existingJunction || []) {
          if (row.assigned_nick_id) oldNickIds.add(row.assigned_nick_id)
        }
        newNickIdsForOnboard = (req.body.account_ids || []).filter(id => !oldNickIds.has(id))
        if (newNickIdsForOnboard.length) {
          const { data: theirGroups } = await supabase
            .from('fb_groups')
            .select('id, account_id, global_score, score_tier, ai_join_score')
            .in('account_id', newNickIdsForOnboard)
            .eq('is_member', true)
            .eq('pending_approval', false)
            .or('is_blocked.is.null,is_blocked.eq.false')
          const rows = (theirGroups || []).map(g => ({
            campaign_id: req.params.id,
            group_id: g.id,
            assigned_nick_id: g.account_id,
            score: g.global_score || g.ai_join_score || 5,
            tier: g.score_tier || 'C',
            status: 'active',
          }))
          if (rows.length) {
            await supabase.from('campaign_groups')
              .upsert(rows, { onConflict: 'campaign_id,group_id' })
            console.log(`[PUT campaigns/${req.params.id.slice(0,8)}] auto-assigned ${rows.length} groups to ${newNickIdsForOnboard.length} new nicks`)
          }
        }
      } catch (assignErr) {
        req.log?.warn?.(`[PUT campaigns] auto-assign groups failed: ${assignErr.message}`)
      }

      // Phase 15: fire scout jobs for new nicks with <3 groups (uses shared helper)
      if (newNickIdsForOnboard.length) {
        onboardNewNicks(supabase, req.params.id, newNickIdsForOnboard, req.user.id).catch(err =>
          req.log?.warn?.(`[ONBOARD] PUT failed: ${err.message}`))
      }
    }

    // Phase 11: rebalance KPI when nicks roster or kpi_config changes
    if (req.body.account_ids !== undefined || req.body.kpi_config !== undefined) {
      rebalanceKPI(supabase, req.params.id).catch(err =>
        req.log?.warn?.(`KPI rebalance after PUT failed: ${err.message}`))
    }

    // 2026-05-05: re-apply per-nick budgets when ai_plan changes via general PUT
    if (req.body.ai_plan !== undefined) {
      await applyPerNickBudgets(supabase, req.body.ai_plan)
    }

    // Phase 15: surface new-nick count so the UI can toast about onboarding
    return {
      ...data,
      _onboarding: { new_nicks_count: newNickIdsForOnboard.length },
    }
  })

  // PUT /campaigns/:id/plan — Update parsed_plan for live campaigns
  // Used by the "Sửa kế hoạch" tab in campaign detail to apply changes mid-run
  fastify.put('/:id/plan', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { ai_plan } = req.body
    if (!ai_plan?.roles) return reply.code(400).send({ error: 'ai_plan.roles required' })

    // Verify ownership
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    // Update campaign.ai_plan (so future runs use new plan)
    const { error: campErr } = await supabase.from('campaigns')
      .update({ ai_plan, ai_plan_confirmed: true })
      .eq('id', req.params.id)
    if (campErr) return reply.code(500).send({ error: campErr.message })

    // Update parsed_plan in each campaign_role to match
    // Match by role_type — roles in ai_plan and DB share role_type
    const { data: dbRoles } = await supabase.from('campaign_roles')
      .select('id, role_type')
      .eq('campaign_id', req.params.id)

    if (dbRoles) {
      for (const planRole of ai_plan.roles) {
        const dbRole = dbRoles.find(r => r.role_type === planRole.role_type)
        if (dbRole) {
          await supabase.from('campaign_roles')
            .update({ parsed_plan: planRole.steps || [] })
            .eq('id', dbRole.id)
        }
      }
    }

    // 2026-05-05: re-apply per-nick budgets when plan edited mid-flight
    await applyPerNickBudgets(supabase, ai_plan)

    return { ok: true, applied_at: new Date().toISOString() }
  })

  // DELETE /campaigns/:id
  fastify.delete('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { error } = await supabase.from('campaigns').delete().eq('id', req.params.id).eq('owner_id', req.user.id)
    if (error) return reply.code(500).send({ error: error.message })
    return { success: true }
  })

  // POST /campaigns/:id/start
  fastify.post('/:id/start', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data, error } = await supabase
      .from('campaigns')
      .update({
        is_active: true,
        status: 'running',
        next_run_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .select('*, campaign_roles(*)')
      .single()

    if (error) return reply.code(500).send({ error: error.message })

    // Phase 12: dispatch jobs immediately on Start instead of waiting for
    // the next scheduler tick (which can be an hour away). Runs in the
    // background so the HTTP response returns instantly.
    try {
      const { executeRoleCampaign } = require('../services/campaign-scheduler')
      // Also rebalance KPI for the active nick roster
      const { rebalanceKPI } = require('../services/kpi-calculator')
      rebalanceKPI(supabase, req.params.id).catch(() => {})
      executeRoleCampaign(data).catch(err =>
        req.log?.warn?.(`[START] executeRoleCampaign failed: ${err.message}`))
    } catch (dispatchErr) {
      req.log?.warn?.(`[START] dispatch error: ${dispatchErr.message}`)
    }

    return data
  })

  // POST /campaigns/:id/stop
  fastify.post('/:id/stop', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data, error } = await supabase
      .from('campaigns')
      .update({
        is_active: false,
        status: 'paused',
        next_run_at: null
      })
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .select()
      .single()

    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // ═══════════════════════════════════════════════════════
  // ROLE ENDPOINTS
  // ═══════════════════════════════════════════════════════

  // POST /campaigns/:id/roles — add role
  fastify.post('/:id/roles', { preHandler: fastify.authenticate }, async (req, reply) => {
    // Verify campaign ownership
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { name, role_type, account_ids, mission, config, quota_override, feeds_into, read_from, sort_order } = req.body
    if (!name) return reply.code(400).send({ error: 'name required' })

    const { data, error } = await supabase.from('campaign_roles').insert({
      campaign_id: req.params.id,
      name,
      role_type: role_type || 'custom',
      account_ids: account_ids || [],
      mission: mission || null,
      config: config || {},
      quota_override: quota_override || null,
      feeds_into: feeds_into || null,
      read_from: read_from || null,
      sort_order: sort_order || 0,
    }).select().single()

    if (error) return reply.code(500).send({ error: error.message })
    return reply.code(201).send(data)
  })

  // PUT /campaigns/:id/roles/:roleId — update role
  fastify.put('/:id/roles/:roleId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const allowed = ['name', 'role_type', 'account_ids', 'mission', 'parsed_plan', 'config', 'quota_override', 'feeds_into', 'read_from', 'sort_order', 'is_active']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    const { data, error } = await supabase.from('campaign_roles')
      .update(updates)
      .eq('id', req.params.roleId)
      .eq('campaign_id', req.params.id)
      .select().single()

    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // DELETE /campaigns/:id/roles/:roleId
  fastify.delete('/:id/roles/:roleId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { error } = await supabase.from('campaign_roles')
      .delete()
      .eq('id', req.params.roleId)
      .eq('campaign_id', req.params.id)

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // POST /campaigns/:id/roles/:roleId/parse — AI parse mission preview
  fastify.post('/:id/roles/:roleId/parse', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id, topic').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { data: role } = await supabase.from('campaign_roles')
      .select('*').eq('id', req.params.roleId).eq('campaign_id', req.params.id).single()
    if (!role) return reply.code(404).send({ error: 'Role not found' })

    if (!role.mission) return reply.code(400).send({ error: 'Role has no mission text' })

    try {
      const plan = await parseMission(role.mission, {
        topic: campaign.topic,
        roleType: role.role_type,
        accountCount: (role.account_ids || []).length,
      }, req.user.id, supabase)

      return { plan, role_id: role.id }
    } catch (err) {
      return reply.code(500).send({ error: `AI parse failed: ${err.message}` })
    }
  })

  // GET /campaigns/:id/stats — realtime stats
  fastify.get('/:id/stats', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const cid = req.params.id

    const [queuePending, queueDone, queueFailed, friendSent, friendAccepted, jobsDone, jobsFailed] = await Promise.all([
      supabase.from('target_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'pending'),
      supabase.from('target_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'done'),
      supabase.from('target_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'failed'),
      supabase.from('friend_request_log').select('id', { count: 'exact', head: true }).eq('campaign_id', cid),
      supabase.from('friend_request_log').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'accepted'),
      supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('payload->>campaign_id', cid).eq('status', 'done'),
      supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('payload->>campaign_id', cid).eq('status', 'failed'),
    ])

    return {
      queue: { pending: queuePending.count || 0, done: queueDone.count || 0, failed: queueFailed.count || 0 },
      friends: { sent: friendSent.count || 0, accepted: friendAccepted.count || 0 },
      jobs: { done: jobsDone.count || 0, failed: jobsFailed.count || 0 },
    }
  })

  // GET /campaigns/:id/post-strategy — AI-powered post scheduling insights
  fastify.get('/:id/post-strategy', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id, name, topic, campaign_roles(account_ids)')
      .eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { collectPerformanceData } = require('../services/post-strategy')

    // Collect data from all campaign accounts
    const allAccountIds = [...new Set((campaign.campaign_roles || []).flatMap(r => r.account_ids || []))]
    let bestStrategy = null

    for (const accId of allAccountIds.slice(0, 3)) {
      const perfData = await collectPerformanceData(supabase, accId)
      if (perfData && (!bestStrategy || perfData.total_posts > bestStrategy.total_posts)) {
        bestStrategy = { ...perfData, account_id: accId }
      }
    }

    if (!bestStrategy) {
      return { has_data: false, min_posts: 5, message: 'Cần ít nhất 5 bài đã đăng để AI phân tích chiến lược' }
    }

    // Check if any recent job has ai_strategy in payload
    const { data: recentJob } = await supabase
      .from('jobs')
      .select('payload, created_at')
      .filter('payload->>campaign_id', 'eq', req.params.id)
      .not('payload->ai_strategy', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const aiStrategy = recentJob?.payload?.ai_strategy || null

    return {
      has_data: true,
      total_posts: bestStrategy.total_posts,
      best_hours: bestStrategy.best_hours,
      best_days: bestStrategy.best_days,
      hour_stats: bestStrategy.hour_stats?.slice(0, 8),
      group_stats: bestStrategy.group_stats?.slice(0, 5),
      ai_strategy: aiStrategy,
      strategy_updated_at: recentJob?.created_at || null,
    }
  })

  // GET /campaigns/:id/report — aggregated campaign analytics
  fastify.get('/:id/report', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id, name, total_runs, created_at, last_run_at, campaign_roles(id, name, role_type, account_ids)')
      .eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const cid = req.params.id
    try {
      // 1. Fetch all campaign jobs (up to 2000)
      const { data: allJobs } = await supabase.from('jobs')
        .select('id, type, status, payload, started_at, finished_at, error_message, created_at')
        .eq('payload->>campaign_id', cid)
        .order('created_at', { ascending: false })
        .limit(2000)

      // 2. Target queue counts
      const [tqDone, tqFailed, tqPending] = await Promise.all([
        supabase.from('target_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'done'),
        supabase.from('target_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'failed'),
        supabase.from('target_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', cid).eq('status', 'pending'),
      ])

      // 3. Friend request stats
      const { data: friendRows } = await supabase.from('friend_request_log')
        .select('status, sent_at')
        .eq('campaign_id', cid)
        .order('sent_at', { ascending: false })
        .limit(2000)

      const jobs = allJobs || []
      const friends = friendRows || []

      // === SUMMARY ===
      const jobsDone = jobs.filter(j => j.status === 'done').length
      const jobsFailed = jobs.filter(j => j.status === 'failed').length
      const totalJobs = jobs.length
      const successRate = totalJobs > 0 ? Math.round((jobsDone / totalJobs) * 100) : 0

      const friendsSent = friends.length
      const friendsAccepted = friends.filter(f => f.status === 'accepted').length
      const acceptRate = friendsSent > 0 ? Math.round((friendsAccepted / friendsSent) * 100) : 0

      // Average duration (only completed jobs with both timestamps)
      const durations = jobs
        .filter(j => j.started_at && j.finished_at)
        .map(j => (new Date(j.finished_at) - new Date(j.started_at)) / 1000)
      const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0

      const firstJob = jobs.length > 0 ? jobs[jobs.length - 1].created_at : null

      // === DAILY BREAKDOWN (last 14 days) ===
      const dailyMap = {}
      const now = new Date()
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        const key = d.toISOString().slice(0, 10)
        dailyMap[key] = { date: key, jobs_done: 0, jobs_failed: 0, friends_sent: 0, friends_accepted: 0 }
      }

      for (const job of jobs) {
        const day = (job.created_at || '').slice(0, 10)
        if (dailyMap[day]) {
          if (job.status === 'done') dailyMap[day].jobs_done++
          if (job.status === 'failed') dailyMap[day].jobs_failed++
        }
      }
      for (const f of friends) {
        const day = (f.sent_at || '').slice(0, 10)
        if (dailyMap[day]) {
          dailyMap[day].friends_sent++
          if (f.status === 'accepted') dailyMap[day].friends_accepted++
        }
      }

      // === BY ROLE ===
      const roleMap = {}
      for (const role of (campaign.campaign_roles || [])) {
        roleMap[role.id] = { role_id: role.id, role_name: role.name, role_type: role.role_type, jobs_done: 0, jobs_failed: 0, total: 0 }
      }
      for (const job of jobs) {
        const rid = job.payload?.role_id
        if (rid && roleMap[rid]) {
          roleMap[rid].total++
          if (job.status === 'done') roleMap[rid].jobs_done++
          if (job.status === 'failed') roleMap[rid].jobs_failed++
        }
      }

      // === BY ACCOUNT ===
      const accountMap = {}
      for (const job of jobs) {
        const aid = job.payload?.account_id
        if (!aid) continue
        if (!accountMap[aid]) accountMap[aid] = { account_id: aid, jobs_done: 0, jobs_failed: 0, total: 0 }
        accountMap[aid].total++
        if (job.status === 'done') accountMap[aid].jobs_done++
        if (job.status === 'failed') accountMap[aid].jobs_failed++
      }

      // Get account names
      const accountIds = Object.keys(accountMap)
      if (accountIds.length > 0) {
        const { data: accounts } = await supabase.from('accounts').select('id, username').in('id', accountIds)
        for (const acc of (accounts || [])) {
          if (accountMap[acc.id]) accountMap[acc.id].account_name = acc.username || acc.id
        }
      }

      // Count friends sent per account from job payload
      for (const f of friends) {
        // friend_request_log may not have account_id directly, skip if not
      }

      // === RECENT ERRORS ===
      const recentErrors = jobs
        .filter(j => j.status === 'failed' && j.error_message)
        .slice(0, 10)
        .map(j => ({ job_id: j.id, type: j.type, error_message: j.error_message, created_at: j.created_at }))

      // === ACTIVITY-BASED DAILY (14 days) — replaces jobs-only chart ===
      // Build from campaign_activity_log for real action counts (likes, comments, etc)
      const activityDailyMap = {}
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        const key = d.toISOString().slice(0, 10)
        activityDailyMap[key] = { date: key, likes: 0, comments: 0, joins: 0, visits: 0, friend_requests: 0 }
      }

      // === PER-ACTION STATS from activity_log ===
      const { data: activityRows } = await supabase
        .from('campaign_activity_log')
        .select('action_type, result_status, account_id, target_name, target_url, details, created_at')
        .eq('campaign_id', cid)
        .order('created_at', { ascending: false })
        .limit(5000)

      const activities = activityRows || []

      // Action summary — skipped NOT counted in total (total = success + failed only)
      const actionSummary = {}
      for (const a of activities) {
        if (!actionSummary[a.action_type]) actionSummary[a.action_type] = { total: 0, success: 0, failed: 0, skipped: 0 }
        if (a.result_status === 'success') { actionSummary[a.action_type].success++; actionSummary[a.action_type].total++ }
        else if (a.result_status === 'failed') { actionSummary[a.action_type].failed++; actionSummary[a.action_type].total++ }
        else if (a.result_status === 'skipped') { actionSummary[a.action_type].skipped++ }

        // Populate activity daily chart (only success actions)
        if (a.result_status === 'success' && a.created_at) {
          const day = a.created_at.slice(0, 10)
          if (activityDailyMap[day]) {
            if (a.action_type === 'like' || a.action_type === 'react') activityDailyMap[day].likes++
            else if (a.action_type === 'comment' || a.action_type === 'opportunity_comment') activityDailyMap[day].comments++
            else if (a.action_type === 'join_group') activityDailyMap[day].joins++
            else if (a.action_type === 'visit_group') activityDailyMap[day].visits++
            else if (a.action_type === 'friend_request' || a.action_type === 'send_friend_request') activityDailyMap[day].friend_requests++
          }
        }
      }

      // Per-nick action breakdown
      const nickActions = {}
      for (const a of activities) {
        const aid = a.account_id
        if (!aid) continue
        if (!nickActions[aid]) nickActions[aid] = { account_id: aid, actions: {} }
        if (!nickActions[aid].actions[a.action_type]) nickActions[aid].actions[a.action_type] = { total: 0, success: 0, failed: 0, skipped: 0 }
        nickActions[aid].actions[a.action_type].total++
        if (a.result_status === 'success') nickActions[aid].actions[a.action_type].success++
        if (a.result_status === 'failed') nickActions[aid].actions[a.action_type].failed++
      }
      // Enrich with account names
      for (const aid of Object.keys(nickActions)) {
        nickActions[aid].account_name = accountMap[aid]?.account_name || aid.slice(0, 8)
      }

      // Recent comments with links (for report detail)
      const recentComments = activities
        .filter(a => a.action_type === 'comment' && a.result_status === 'success')
        .slice(0, 50)
        .map(a => ({
          group_name: a.target_name,
          group_url: a.target_url,
          post_url: a.details?.post_url || null,
          comment_text: a.details?.comment_text || '',
          account_id: a.account_id,
          account_name: accountMap[a.account_id]?.account_name || a.account_id?.slice(0, 8),
          created_at: a.created_at,
        }))

      // Recent likes with links
      const recentLikes = activities
        .filter(a => a.action_type === 'like' && a.result_status === 'success')
        .slice(0, 50)
        .map(a => ({
          group_name: a.target_name,
          group_url: a.target_url,
          post_url: a.details?.post_url || null,
          account_name: accountMap[a.account_id]?.account_name || a.account_id?.slice(0, 8),
          created_at: a.created_at,
        }))

      // Groups joined
      const groupsJoined = activities
        .filter(a => a.action_type === 'join_group' && a.result_status === 'success')
        .map(a => ({
          group_name: a.target_name,
          group_url: a.target_url,
          member_count: a.details?.member_count || null,
          account_name: accountMap[a.account_id]?.account_name || a.account_id?.slice(0, 8),
          created_at: a.created_at,
        }))

      // Checkpoint/error events
      const checkpointEvents = [
        ...recentErrors.map(e => ({ ...e, event_type: 'job_error' })),
        ...activities
          .filter(a => a.result_status === 'failed')
          .slice(0, 20)
          .map(a => ({
            event_type: 'action_error',
            action: a.action_type,
            error: a.details?.error || 'Unknown',
            target: a.target_name,
            account_name: accountMap[a.account_id]?.account_name || a.account_id?.slice(0, 8),
            created_at: a.created_at,
          })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20)

      return {
        summary: {
          total_jobs: totalJobs,
          jobs_done: jobsDone,
          jobs_failed: jobsFailed,
          success_rate: successRate,
          total_targets: (tqDone.count || 0) + (tqFailed.count || 0) + (tqPending.count || 0),
          targets_done: tqDone.count || 0,
          targets_failed: tqFailed.count || 0,
          friends_sent: friendsSent,
          friends_accepted: friendsAccepted,
          accept_rate: acceptRate,
          avg_job_duration_sec: avgDuration,
          total_runs: campaign.total_runs || 0,
          first_run_at: firstJob,
          last_run_at: campaign.last_run_at,
          total_activities: activities.filter(a => a.result_status !== 'skipped').length,
          total_skipped: activities.filter(a => a.result_status === 'skipped').length,
        },
        daily: Object.values(dailyMap),
        activity_daily: Object.values(activityDailyMap),
        by_role: Object.values(roleMap),
        by_account: Object.values(accountMap),
        action_summary: actionSummary,
        nick_actions: Object.values(nickActions),
        recent_comments: recentComments,
        recent_likes: recentLikes,
        groups_joined: groupsJoined,
        checkpoint_events: checkpointEvents,
        recent_errors: recentErrors,
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // GET /campaigns/:id/targets — target queue (paginated)
  fastify.get('/:id/targets', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { status, limit = 50, offset = 0 } = req.query
    let query = supabase.from('target_queue')
      .select('*', { count: 'exact' })
      .eq('campaign_id', req.params.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (status) query = query.eq('status', status)

    const { data, count, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    return { data, total: count }
  })

  // GET /campaigns/:id/friend-log — friend request history
  fastify.get('/:id/friend-log', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { limit = 50, offset = 0 } = req.query
    const { data, count, error } = await supabase.from('friend_request_log')
      .select('*', { count: 'exact' })
      .eq('campaign_id', req.params.id)
      .order('sent_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (error) return reply.code(500).send({ error: error.message })
    return { data, total: count }
  })

  // GET /campaigns/:id/groups — Phase 9: read from campaign_groups junction
  // Returns groups with junction-level tier/score/assigned nick, plus the
  // underlying fb_groups row enriched with account username.
  fastify.get('/:id/groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { data, error } = await supabase
      .from('campaign_groups')
      .select('id, score, tier, status, added_at, last_nurtured_at, assigned_nick_id, fb_groups(id, fb_group_id, name, url, member_count, group_type, topic, ai_relevance, is_blocked, account_id, joined_via_campaign_id, global_score, score_tier, language, is_member, pending_approval, ai_note, ai_join_score, ai_risk_level, skip_until, tags, user_approved, priority_visit, membership_check_attempts, membership_last_checked_at, consecutive_skips)')
      .eq('campaign_id', req.params.id)
      .neq('status', 'removed')
      .order('tier', { ascending: true })
      .order('score', { ascending: false })

    if (error) return reply.code(500).send({ error: error.message })

    // Enrich nicks
    const nickIds = [...new Set((data || []).map(r => r.assigned_nick_id).filter(Boolean))]
    let accountMap = {}
    if (nickIds.length) {
      const { data: accounts } = await supabase.from('accounts').select('id, username').in('id', nickIds)
      accountMap = Object.fromEntries((accounts || []).map(a => [a.id, a.username]))
    }

    // Fix 2: dedup by fb_group_id — same FB group assigned to multiple nicks
    // should appear as 1 row with a nicks[] array, not N duplicate rows.
    const flat = (data || [])
      .filter(r => r.fb_groups)
      .map(r => ({
        ...r.fb_groups,
        junction_id: r.id,
        junction_score: r.score,
        junction_tier: r.tier,
        junction_status: r.status,
        added_at: r.added_at,
        last_nurtured_at: r.last_nurtured_at,
        assigned_nick_id: r.assigned_nick_id,
        account_username: accountMap[r.assigned_nick_id] || null,
      }))

    const byFbGid = new Map()
    for (const row of flat) {
      const key = row.fb_group_id
      if (!byFbGid.has(key)) {
        byFbGid.set(key, {
          ...row,
          assigned_nicks: [{ id: row.assigned_nick_id, username: row.account_username }],
        })
      } else {
        const existing = byFbGid.get(key)
        existing.assigned_nicks.push({ id: row.assigned_nick_id, username: row.account_username })
        // Keep the best junction score/tier
        if ((row.junction_score || 0) > (existing.junction_score || 0)) {
          existing.junction_score = row.junction_score
          existing.junction_tier = row.junction_tier
        }
        // Keep most recent last_nurtured_at
        if (row.last_nurtured_at && (!existing.last_nurtured_at || row.last_nurtured_at > existing.last_nurtured_at)) {
          existing.last_nurtured_at = row.last_nurtured_at
        }
      }
    }
    return [...byFbGid.values()]
  })

  // NOTE: POST /campaigns/:id/priority-groups exists further below (legacy impl).
  // Phase 9 junction row is written by that handler via the `campaign_groups`
  // upsert wired in — see line ~1195.

  // GET /campaigns/:id/leads — Campaign-scoped leads
  fastify.get('/:id/leads', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { status, search, page = 1, limit = 50 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let query = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('campaign_id', req.params.id)
      .order('discovered_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (status) query = query.eq('status', status)
    if (search) query = query.or(`name.ilike.%${search}%,fb_uid.ilike.%${search}%`)

    const { data, error, count } = await query
    if (error) return reply.code(500).send({ error: error.message })

    // Stats
    const { data: allLeads } = await supabase
      .from('leads')
      .select('status, ai_type')
      .eq('campaign_id', req.params.id)

    const byStatus = {}, byType = {}
    for (const l of (allLeads || [])) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1
      if (l.ai_type) byType[l.ai_type] = (byType[l.ai_type] || 0) + 1
    }

    return {
      data: data || [],
      total: count || 0,
      page: parseInt(page),
      pages: Math.ceil((count || 0) / parseInt(limit)),
      stats: { total: (allLeads || []).length, by_status: byStatus, by_type: byType },
    }
  })

  // PUT /campaigns/:id/groups/:groupId — Assign/remove group from campaign
  fastify.put('/:id/groups/:groupId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { action } = req.body // 'add' or 'remove'
    const groupId = req.params.groupId

    if (action === 'add') {
      // Get group's fb_group_id and account_id
      const { data: group } = await supabase.from('fb_groups')
        .select('fb_group_id, account_id').eq('id', groupId).single()
      if (!group) return reply.code(404).send({ error: 'Group not found' })

      await supabase.rpc('append_campaign_to_group', {
        p_account_id: group.account_id,
        p_fb_group_id: group.fb_group_id,
        p_campaign_id: req.params.id,
      })
      return { ok: true, action: 'added' }
    } else if (action === 'remove') {
      const { data: group } = await supabase.from('fb_groups')
        .select('campaign_ids').eq('id', groupId).single()
      if (!group) return reply.code(404).send({ error: 'Group not found' })

      const newIds = (group.campaign_ids || []).filter(id => id !== req.params.id)
      await supabase.from('fb_groups').update({ campaign_ids: newIds }).eq('id', groupId)
      return { ok: true, action: 'removed' }
    }

    return reply.code(400).send({ error: 'action must be add or remove' })
  })

  // PUT /campaigns/:id/groups/:groupId/review — User approve/reject AI evaluation
  fastify.put('/:id/groups/:groupId/review', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { approved } = req.body // true = approve, false = reject
    if (typeof approved !== 'boolean') return reply.code(400).send({ error: 'approved must be true or false' })

    const { error } = await supabase.from('fb_groups')
      .update({ user_approved: approved })
      .eq('id', req.params.groupId)

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true, approved }
  })

  // ── POST /campaigns/:id/priority-groups ──
  // Mark a Facebook group as priority (tier A) for a campaign. Resolves the
  // group from a URL or raw fb_group_id, then upserts fb_groups with
  // score_tier='A', user_approved=true, joined_via_campaign_id=campaign.id.
  // Body: { group_url: "https://facebook.com/groups/xxx" } OR { fb_group_id: "12345" }
  fastify.post('/:id/priority-groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    // Verify ownership
    const { data: campaign } = await supabase.from('campaigns')
      .select('id, account_ids, topic').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { group_url, fb_group_id: rawId, name } = req.body || {}
    let fbGroupId = rawId || null
    let groupUrl = group_url || null

    if (group_url && !fbGroupId) {
      // Parse fb_group_id from URL — supports facebook.com/groups/<id> and m.facebook.com variants
      const m = String(group_url).match(/(?:facebook\.com|fb\.com)\/groups\/([^/?#]+)/i)
      if (m) fbGroupId = m[1]
    }
    if (!fbGroupId) {
      return reply.code(400).send({ error: 'group_url hoặc fb_group_id required (URL phải là facebook.com/groups/...)' })
    }
    if (!groupUrl) groupUrl = `https://www.facebook.com/groups/${fbGroupId}`

    // Need at least one account on the campaign for the FK
    const acctIds = campaign.account_ids || []
    if (acctIds.length === 0) {
      return reply.code(400).send({ error: 'Campaign chưa có nick — gán nick trước rồi thêm group ưu tiên' })
    }
    const accountId = acctIds[0]

    // Upsert each account row (one fb_groups row per (account_id, fb_group_id))
    const rows = acctIds.map(aid => ({
      account_id: aid,
      fb_group_id: fbGroupId,
      url: groupUrl,
      name: name || null,
      score_tier: 'A',
      user_approved: true,
      joined_via_campaign_id: req.params.id,
      topic: campaign.topic || null,
      last_scored_at: new Date().toISOString(),
    }))

    const { data, error } = await supabase.from('fb_groups')
      .upsert(rows, { onConflict: 'account_id,fb_group_id' })
      .select()

    if (error) return reply.code(500).send({ error: error.message })

    // Try to append campaign id via existing rpc (multi-campaign support)
    try {
      await supabase.rpc('append_campaign_to_group', {
        p_account_id: accountId, p_fb_group_id: fbGroupId, p_campaign_id: req.params.id,
      })
    } catch {}

    // Phase 9: also write campaign_groups junction rows so the new nurture
    // path (which reads via campaign_groups) can see this priority group.
    try {
      const junctionRows = (data || []).map(g => ({
        campaign_id: req.params.id,
        group_id: g.id,
        assigned_nick_id: g.account_id,
        score: 10,
        tier: 'A',
        status: 'active',
      }))
      if (junctionRows.length) {
        await supabase.from('campaign_groups')
          .upsert(junctionRows, { onConflict: 'campaign_id,group_id' })
      }
    } catch (jErr) {
      console.warn(`[priority-groups] junction upsert failed: ${jErr.message}`)
    }

    // Phase 11: bump KPI for the new tier-A group (+10 likes / +3 comments)
    // then rebalance shares across nicks.
    try {
      const { data: c } = await supabase.from('campaigns').select('kpi_config').eq('id', req.params.id).single()
      const cur = c?.kpi_config || {}
      const bumped = {
        ...cur,
        daily_likes: (cur.daily_likes || 60) + 10,
        daily_comments: (cur.daily_comments || 15) + 3,
      }
      await supabase.from('campaigns').update({ kpi_config: bumped }).eq('id', req.params.id)
      rebalanceKPI(supabase, req.params.id).catch(() => {})
    } catch (kErr) {
      console.warn(`[priority-groups] KPI bump failed: ${kErr.message}`)
    }

    // Fix 1+3: if group name is null/placeholder, queue a resolve_group job
    // to scrape real name + member_count from Facebook. Handler already exists.
    const needsResolve = (data || []).some(g => !g.name || g.name === `Group ${fbGroupId}` || g.name.startsWith('Group '))
    if (needsResolve && acctIds.length) {
      try {
        await supabase.from('jobs').insert({
          type: 'resolve_group',
          priority: 5,
          payload: {
            account_id: acctIds[0],
            fb_group_id: fbGroupId,
            group_url: groupUrl,
            owner_id: req.user.id,
          },
          status: 'pending',
          scheduled_at: new Date().toISOString(),
          created_by: req.user.id,
        })
        console.log(`[priority-groups] Queued resolve_group for ${fbGroupId}`)
      } catch {}
    }

    // Fix 4: auto-scout for nicks that aren't yet members of the priority group.
    // Check each upserted fb_groups row — if is_member=false, queue a
    // campaign_discover_groups job that will navigate to the group and join.
    try {
      const nonMembers = (data || []).filter(g => !g.is_member)
      for (const g of nonMembers.slice(0, 3)) { // max 3 scout jobs
        await supabase.from('jobs').insert({
          type: 'campaign_discover_groups',
          priority: 2,
          payload: {
            campaign_id: req.params.id,
            account_id: g.account_id,
            owner_id: req.user.id,
            topic: campaign.topic || '',
            role_type: 'scout',
            target_group_url: groupUrl,
            target_fb_group_id: fbGroupId,
            reason: 'priority_group_auto_join',
          },
          status: 'pending',
          scheduled_at: new Date().toISOString(),
          created_by: req.user.id,
        })
      }
      if (nonMembers.length) console.log(`[priority-groups] Queued ${Math.min(nonMembers.length, 3)} scout jobs to join ${fbGroupId}`)
    } catch {}

    return { ok: true, fb_group_id: fbGroupId, count: data?.length || 0, groups: data }
  })

  // ── Phase 11: KPI endpoints ──────────────────────────────
  fastify.post('/:id/rebalance-kpi', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    const result = await rebalanceKPI(supabase, req.params.id)
    if (!result.ok) return reply.code(500).send(result)
    return result
  })

  // GET /campaigns/:id/daily-reports?days=7
  // Returns recent daily_reports rows. Dashboard + campaign hub use this.
  fastify.get('/:id/daily-reports', { preHandler: fastify.authenticate }, async (req, reply) => {
    const days = Math.min(parseInt(req.query.days) || 7, 30)
    const pool = supabase._pool
    if (!pool) return reply.code(500).send({ error: 'pg pool unavailable' })
    try {
      const { rows } = await pool.query(
        `SELECT date, stats, narrative_text, narrative_provider, created_at
         FROM daily_reports
         WHERE campaign_id = $1 AND date >= CURRENT_DATE - $2::int
         ORDER BY date DESC`,
        [req.params.id, days]
      )
      return { reports: rows }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  // POST /campaigns/:id/daily-reports/generate
  // Manual trigger — regenerates today's report. Useful for testing and
  // for user-clicked "Refresh" without waiting for 22:00 cron.
  fastify.post('/:id/daily-reports/generate', { preHandler: fastify.authenticate }, async (req, reply) => {
    try {
      const { generateForCampaign, vnToday } = require('../services/daily-report')
      const date = req.body?.date || vnToday()
      const result = await generateForCampaign(supabase, req.params.id, date)
      if (!result) return reply.code(404).send({ error: 'Campaign not found' })
      return result
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.get('/:id/kpi-today', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id, kpi_config').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const today = new Date().toISOString().split('T')[0]
    const { data: rows, error } = await supabase
      .from('nick_kpi_daily')
      .select('*')
      .eq('campaign_id', req.params.id)
      .eq('date', today)
    if (error) return reply.code(500).send({ error: error.message })

    const accIds = (rows || []).map(r => r.account_id)
    let nameMap = {}
    if (accIds.length) {
      const { data: accs } = await supabase.from('accounts').select('id, username').in('id', accIds)
      nameMap = Object.fromEntries((accs || []).map(a => [a.id, a.username]))
    }

    const enriched = (rows || []).map(r => {
      const tot = (r.target_likes || 0) + (r.target_comments || 0) + (r.target_opportunity_comments || 0)
                + (r.target_friend_requests || 0) + (r.target_group_joins || 0)
      const done = (r.done_likes || 0) + (r.done_comments || 0) + (r.done_opportunity_comments || 0)
                 + (r.done_friend_requests || 0) + (r.done_group_joins || 0)
      return {
        ...r,
        username: nameMap[r.account_id] || r.account_id?.slice(0, 8),
        total_target: tot,
        total_done: done,
        progress_pct: tot > 0 ? Math.round((done / tot) * 100) : 0,
      }
    })
    return { date: today, kpi_config: campaign.kpi_config, rows: enriched }
  })

  // PATCH /campaigns/:id/kpi-today/:account_id — manual override per-nick targets
  // for today only. Used by the campaign UI's "Click row → modal" KPI editor.
  // Owner-only. Whitelisted to target_* fields (don't let users mutate done_*
  // counters or kpi_met flag — those are computed). Clamped 0..500 per field.
  fastify.patch('/:id/kpi-today/:account_id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const allowedFields = [
      'target_likes', 'target_comments', 'target_friend_requests',
      'target_group_joins', 'target_opportunity_comments',
    ]
    const updates = {}
    for (const f of allowedFields) {
      const v = req.body?.[f]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 500) {
        updates[f] = Math.floor(v)
      }
    }
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No valid target fields supplied (must be 0-500 ints)' })
    }
    updates.last_updated_at = new Date().toISOString()

    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('nick_kpi_daily')
      .update(updates)
      .eq('campaign_id', req.params.id)
      .eq('account_id', req.params.account_id)
      .eq('date', today)
      .select()
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    if (!data) return reply.code(404).send({ error: 'No KPI row for today — nick may not be active in this campaign yet' })
    return data
  })

  // PATCH /campaigns/:id/groups/:fbGroupRowId/priority — pin/unpin a group so
  // the agent visits + comments here BEFORE tier-ranked groups. Per-nick
  // per-group flag (fb_groups row is keyed by (account_id, fb_group_id)).
  // Body: { priority_visit: boolean }
  fastify.patch('/:id/groups/:fbGroupRowId/priority', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const pin = req.body?.priority_visit === true
    // Verify the fb_groups row belongs to a nick the user owns (via account_id)
    const { data: row, error: rerr } = await supabase
      .from('fb_groups')
      .select('id, account_id, accounts!inner(owner_id)')
      .eq('id', req.params.fbGroupRowId)
      .single()
    if (rerr || !row) return reply.code(404).send({ error: 'Group row not found' })
    if (row.accounts?.owner_id !== req.user.id) {
      return reply.code(403).send({ error: 'Not your nick' })
    }

    const { data, error } = await supabase
      .from('fb_groups')
      .update({ priority_visit: pin })
      .eq('id', req.params.fbGroupRowId)
      .select('id, priority_visit')
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // GET /campaigns/:id/priority-groups — list current tier-A groups for this campaign
  fastify.get('/:id/priority-groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { data, error } = await supabase
      .from('fb_groups')
      .select('id, fb_group_id, name, url, score_tier, member_count, last_scored_at, total_interactions')
      .eq('joined_via_campaign_id', req.params.id)
      .eq('score_tier', 'A')
      .order('last_scored_at', { ascending: false })
      .limit(100)

    if (error) return reply.code(500).send({ error: error.message })
    // Dedupe by fb_group_id (multiple accounts may share the same group)
    const seen = new Set()
    const unique = []
    for (const g of data || []) {
      if (seen.has(g.fb_group_id)) continue
      seen.add(g.fb_group_id)
      unique.push(g)
    }
    return unique
  })

  // DELETE /campaigns/:id/priority-groups/:fbGroupId — demote a priority group back to tier C
  fastify.delete('/:id/priority-groups/:fbGroupId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { error } = await supabase.from('fb_groups')
      .update({ score_tier: 'C' })
      .eq('joined_via_campaign_id', req.params.id)
      .eq('fb_group_id', req.params.fbGroupId)

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // ── Phase 14: Reference campaigns + import groups ──────────────────────
  // GET /campaigns/:id/reference-campaigns
  // List other active campaigns owned by the same user (same topic/language
  // preferred) with a count of how many groups each one has. Used to
  // populate the "Import from another campaign" modal.
  fastify.get('/:id/reference-campaigns', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: current } = await supabase.from('campaigns')
      .select('id, topic, language')
      .eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!current) return reply.code(404).send({ error: 'Campaign not found' })

    const { data: campaigns } = await supabase.from('campaigns')
      .select('id, name, topic, language, is_active, status, created_at')
      .eq('owner_id', req.user.id)
      .neq('id', req.params.id)
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50)

    if (!campaigns?.length) return []

    // Count active campaign_groups per campaign
    const ids = campaigns.map(c => c.id)
    const { data: counts } = await supabase.from('campaign_groups')
      .select('campaign_id')
      .in('campaign_id', ids)
      .eq('status', 'active')
    const countMap = {}
    for (const r of counts || []) {
      countMap[r.campaign_id] = (countMap[r.campaign_id] || 0) + 1
    }

    // Sort: same topic/language first, then by group count desc
    const scored = campaigns.map(c => {
      let rank = 0
      if (c.topic && current.topic && c.topic.toLowerCase() === current.topic.toLowerCase()) rank += 10
      if (c.language === current.language) rank += 5
      if (c.is_active) rank += 2
      return { ...c, groups_count: countMap[c.id] || 0, _rank: rank }
    }).filter(c => c.groups_count > 0)
    scored.sort((a, b) => (b._rank - a._rank) || (b.groups_count - a.groups_count))

    return scored.map(({ _rank, ...c }) => c)
  })

  // POST /campaigns/:id/import-groups
  // Body: { source_campaign_ids: ["uuid1", "uuid2"] }
  // Copies campaign_groups rows from source campaigns into the target.
  // Dedup by group_id (skip groups already in target). For each imported
  // group, prefer a nick that's already is_member=true on that group (from
  // the current campaign's roster); if none, skip and report in the response.
  fastify.post('/:id/import-groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: target } = await supabase.from('campaigns')
      .select('id, owner_id, campaign_roles(account_ids)')
      .eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!target) return reply.code(404).send({ error: 'Campaign not found' })

    const sourceIds = Array.isArray(req.body?.source_campaign_ids) ? req.body.source_campaign_ids : []
    if (!sourceIds.length) return reply.code(400).send({ error: 'source_campaign_ids required' })

    // Verify source campaigns belong to the same owner
    const { data: sourceCamps } = await supabase.from('campaigns')
      .select('id').in('id', sourceIds).eq('owner_id', req.user.id)
    const validSourceIds = (sourceCamps || []).map(c => c.id)
    if (!validSourceIds.length) return reply.code(400).send({ error: 'No valid source campaigns' })

    // Target campaign's nicks (eligible for assignment)
    const targetNicks = [...new Set((target.campaign_roles || []).flatMap(r => r.account_ids || []))]

    // Pull source campaign_groups joined with fb_groups for tier/score
    const { data: sourceRows } = await supabase.from('campaign_groups')
      .select('group_id, score, tier, fb_groups(id, fb_group_id, account_id, is_member, pending_approval, is_blocked)')
      .in('campaign_id', validSourceIds)
      .eq('status', 'active')

    // Group by fb_group_id for dedup (one source row per unique group)
    const byGroupId = new Map()
    for (const r of sourceRows || []) {
      if (!r.fb_groups) continue
      const fgid = r.fb_groups.fb_group_id
      if (!byGroupId.has(fgid)) byGroupId.set(fgid, r)
    }

    // Pull existing target junction to skip dupes
    const { data: existingTarget } = await supabase.from('campaign_groups')
      .select('group_id, fb_groups(fb_group_id)')
      .eq('campaign_id', req.params.id)
    const existingFbGids = new Set((existingTarget || []).map(r => r.fb_groups?.fb_group_id).filter(Boolean))

    // For each candidate group, find a target-campaign nick that already
    // has membership on that group (query fb_groups for the same fb_group_id
    // scoped to target nicks).
    let imported = 0
    let skippedDupe = 0
    let skippedNoMember = 0
    const rowsToInsert = []

    for (const [fbGid, src] of byGroupId.entries()) {
      if (existingFbGids.has(fbGid)) { skippedDupe++; continue }

      // Find a target nick that is_member of this fb_group_id
      let assignedNick = null
      let assignedGroupId = null
      if (targetNicks.length) {
        const { data: memberRows } = await supabase.from('fb_groups')
          .select('id, account_id, global_score, score_tier')
          .eq('fb_group_id', fbGid)
          .in('account_id', targetNicks)
          .eq('is_member', true)
          .eq('pending_approval', false)
          .limit(1)
        if (memberRows?.length) {
          assignedNick = memberRows[0].account_id
          assignedGroupId = memberRows[0].id
        }
      }

      if (!assignedNick) {
        // No target nick is a member yet. Skip — scout will need to join first.
        skippedNoMember++
        continue
      }

      rowsToInsert.push({
        campaign_id: req.params.id,
        group_id: assignedGroupId,
        assigned_nick_id: assignedNick,
        score: src.score || 5,
        tier: src.tier || 'C',
        status: 'active',
      })
    }

    if (rowsToInsert.length) {
      const { error } = await supabase.from('campaign_groups')
        .upsert(rowsToInsert, { onConflict: 'campaign_id,group_id' })
      if (error) return reply.code(500).send({ error: error.message })
      imported = rowsToInsert.length
    }

    return {
      imported,
      skipped_duplicate: skippedDupe,
      skipped_no_member: skippedNoMember,
      total_candidates: byGroupId.size,
    }
  })

  // ── Phase 13: AI Pilot report + memory panel ───────────────────────────
  // GET /campaigns/:id/ai-pilot-report
  // Comprehensive dashboard data: summary, recent decisions (with
  // effectiveness heuristic), memories grouped by type, health signals.
  fastify.get('/:id/ai-pilot-report', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id, name, total_runs, cron_expression')
      .eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    // 1) Pull last 30 ai_control decisions
    const { data: decisions } = await supabase
      .from('campaign_activity_log')
      .select('id, created_at, result_status, details')
      .eq('campaign_id', req.params.id)
      .eq('action_type', 'ai_control')
      .order('created_at', { ascending: false })
      .limit(30)

    // 2) Pull aggregate activity per day (last 14 days) for effectiveness comparison
    const since = new Date(Date.now() - 14 * 86400000).toISOString()
    const { data: recentActs } = await supabase
      .from('campaign_activity_log')
      .select('created_at, action_type, result_status')
      .eq('campaign_id', req.params.id)
      .neq('action_type', 'ai_control')
      .gte('created_at', since)
      .limit(5000)

    // Bucket activities by day for the 24h-before/24h-after effectiveness check
    const bucket = (iso) => new Date(iso).toISOString().slice(0, 13) // hourly buckets
    const hourlyStats = {}
    for (const a of recentActs || []) {
      const h = bucket(a.created_at)
      if (!hourlyStats[h]) hourlyStats[h] = { total: 0, success: 0 }
      hourlyStats[h].total++
      if (a.result_status === 'success') hourlyStats[h].success++
    }
    const windowStats = (fromTs, toTs) => {
      let total = 0, success = 0
      for (const [h, s] of Object.entries(hourlyStats)) {
        const t = new Date(h + ':00:00.000Z').getTime()
        if (t >= fromTs && t < toTs) { total += s.total; success += s.success }
      }
      return { total, success, rate: total > 0 ? success / total : null }
    }

    // 3) Compute effectiveness per decision
    const enrichedDecisions = (decisions || []).map((d, i) => {
      const firedAt = new Date(d.created_at).getTime()
      const before = windowStats(firedAt - 24 * 3600000, firedAt)
      const after = windowStats(firedAt, firedAt + 24 * 3600000)
      const isSettled = Date.now() - firedAt >= 24 * 3600000
      let wasEffective = null
      if (isSettled && before.total >= 5 && after.total >= 5) {
        // "Effective" = success rate improved OR activity volume increased meaningfully
        const rateImproved = after.rate !== null && before.rate !== null && (after.rate - before.rate) >= 0.05
        const volumeImproved = after.total >= before.total * 1.15
        wasEffective = rateImproved || volumeImproved
      }
      return {
        id: d.id,
        fired_at: d.created_at,
        assessment: d.details?.assessment || d.result_status || 'unknown',
        recommendation: d.details?.recommendation || null,
        adjustments: d.details?.adjustments || [],
        applied_count: d.details?.applied_count || 0,
        run_number: d.details?.run_number || null,
        activity_count: d.details?.activity_count || 0,
        was_effective: wasEffective, // true | false | null (pending)
        before_window: { total: before.total, success_rate: before.rate },
        after_window: { total: after.total, success_rate: after.rate },
      }
    })

    // 4) Effectiveness rollup
    const settled = enrichedDecisions.filter(d => d.was_effective !== null)
    const helpful = settled.filter(d => d.was_effective === true).length
    const hurt = settled.filter(d => d.was_effective === false).length
    const accuracy = settled.length > 0 ? Math.round((helpful / settled.length) * 100) : null

    // 5) Overall trend — compare last 3 days vs previous 3 days
    const now = Date.now()
    const last3 = windowStats(now - 3 * 86400000, now)
    const prev3 = windowStats(now - 6 * 86400000, now - 3 * 86400000)
    let overall_trend = 'stable'
    if (last3.rate !== null && prev3.rate !== null) {
      if (last3.rate - prev3.rate >= 0.05 || last3.total >= prev3.total * 1.2) overall_trend = 'improving'
      else if (prev3.rate - last3.rate >= 0.05 || last3.total <= prev3.total * 0.8) overall_trend = 'declining'
    }

    // 6) Pull memories, grouped by memory_type
    const { data: memories } = await supabase
      .from('ai_pilot_memory')
      .select('id, memory_type, key, value, confidence, evidence_count, last_updated_at, account_id, group_fb_id')
      .eq('campaign_id', req.params.id)
      .gte('confidence', 0.15)
      .order('confidence', { ascending: false })
      .limit(100)

    const memoriesByType = {}
    for (const m of memories || []) {
      const t = m.memory_type || 'other'
      if (!memoriesByType[t]) memoriesByType[t] = []
      memoriesByType[t].push(m)
    }

    // 7) Last fired, next fire estimate
    const last_fired_at = decisions?.[0]?.created_at || null
    const hoursSinceLastFire = last_fired_at ? (Date.now() - new Date(last_fired_at).getTime()) / 3600000 : null

    // AI Pilot fires every 3rd campaign run. Parse cron to estimate next fire.
    let next_fire_at = null
    try {
      if (campaign.cron_expression) {
        const { CronExpressionParser } = require('cron-parser')
        const iter = CronExpressionParser.parse(campaign.cron_expression, { currentDate: new Date() })
        // Not precise (we'd need to know current run_number % 3) — just return next 3 scheduled runs
        const next3 = [iter.next().toISOString(), iter.next().toISOString(), iter.next().toISOString()]
        next_fire_at = next3[2] // worst-case: 3 runs from now
      }
    } catch {}

    // 8) Health signals for warning panel
    const warnings = []
    if (hoursSinceLastFire !== null && hoursSinceLastFire > 24) {
      warnings.push({ level: 'warning', code: 'stale_last_fire', message: `AI Pilot chưa fire trong ${Math.round(hoursSinceLastFire)}h qua` })
    }
    if (decisions && decisions.length >= 3) {
      const last3dec = decisions.slice(0, 3)
      if (last3dec.every(d => d.details?.assessment === 'critical')) {
        warnings.push({ level: 'critical', code: 'consecutive_critical', message: '3 quyết định gần nhất đều critical — campaign đang gặp vấn đề nghiêm trọng' })
      }
      if (last3dec.every(d => (d.details?.applied_count || 0) === 0)) {
        warnings.push({ level: 'warning', code: 'zero_applied', message: '3 quyết định gần nhất không apply được gì — cần debug' })
      }
    }
    if ((campaign.total_runs || 0) < 3) {
      warnings.push({ level: 'info', code: 'not_enough_runs', message: `Campaign mới chạy ${campaign.total_runs || 0}/3 lần — AI Pilot sẽ bắt đầu đánh giá sau` })
    }

    return {
      summary: {
        total_decisions: (decisions || []).length,
        total_runs: campaign.total_runs || 0,
        last_fired_at,
        hours_since_last_fire: hoursSinceLastFire !== null ? Math.round(hoursSinceLastFire * 10) / 10 : null,
        next_fire_at,
        overall_trend,
        last_3d_activity: last3,
        prev_3d_activity: prev3,
      },
      recent_decisions: enrichedDecisions,
      effectiveness: {
        total_settled: settled.length,
        decisions_that_helped: helpful,
        decisions_that_hurt: hurt,
        accuracy_pct: accuracy,
      },
      current_strategy: {
        memories_count: (memories || []).length,
        memories_by_type: memoriesByType,
      },
      warnings,
    }
  })

  // DELETE /campaigns/:id/ai-pilot-memory/:memoryId — user can purge a bad memory
  fastify.delete('/:id/ai-pilot-memory/:memoryId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    const { error } = await supabase.from('ai_pilot_memory')
      .delete()
      .eq('id', req.params.memoryId)
      .eq('campaign_id', req.params.id)
    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // GET /campaigns/:id/activity-log — granular per-action log (cursor-based)
  fastify.get('/:id/activity-log', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { limit = 30, after, page = 1, action_type, account_id, result_status, date_from, date_to } = req.query
    const lim = Math.min(parseInt(limit) || 30, 200)
    const pageNum = Math.max(1, parseInt(page) || 1)

    // Build base filter
    let baseFilter = supabase
      .from('campaign_activity_log')
      .select('*', { count: 'exact' })
      .eq('campaign_id', req.params.id)

    if (action_type) baseFilter = baseFilter.eq('action_type', action_type)
    if (account_id) baseFilter = baseFilter.eq('account_id', account_id)
    if (result_status) baseFilter = baseFilter.eq('result_status', result_status)
    if (date_from) baseFilter = baseFilter.gte('created_at', date_from)
    if (date_to) baseFilter = baseFilter.lte('created_at', date_to)

    let query, isPolling = false

    if (after) {
      // Poll mode: fetch entries NEWER than this timestamp (no pagination)
      query = baseFilter.gt('created_at', after).order('created_at', { ascending: true }).limit(lim)
      isPolling = true
    } else {
      // Page mode: offset-based pagination
      const offset = (pageNum - 1) * lim
      query = baseFilter.order('created_at', { ascending: false }).range(offset, offset + lim - 1)
    }

    const { data, error, count } = await query
    if (error) return reply.code(500).send({ error: error.message })

    // When polling (after), reverse so newest is first for frontend prepend
    const entries = isPolling ? (data || []).reverse() : (data || [])

    // Enrich with account names
    const accountIds = [...new Set(entries.map(d => d.account_id).filter(Boolean))]
    let accountMap = {}
    if (accountIds.length) {
      const { data: accounts } = await supabase.from('accounts').select('id, username').in('id', accountIds)
      accountMap = Object.fromEntries((accounts || []).map(a => [a.id, a.username]))
    }

    const enriched = entries.map(d => ({
      ...d,
      account_name: accountMap[d.account_id] || d.account_id?.slice(0, 8),
    }))

    // Summary: aggregate over ENTIRE campaign (not just this page)
    let sumRows = null
    try {
      const { data } = await supabase.rpc('campaign_activity_summary', { p_campaign_id: req.params.id })
      sumRows = data
    } catch {}
    const summary = {}
    if (sumRows) {
      for (const r of sumRows) {
        summary[r.action_type] = { total: r.total, success: r.success, failed: r.failed }
      }
    } else {
      // Fallback: count from this page only
      for (const d of enriched) {
        const key = d.action_type
        if (!summary[key]) summary[key] = { total: 0, success: 0, failed: 0 }
        summary[key].total++
        if (d.result_status === 'success') summary[key].success++
        else if (d.result_status === 'failed') summary[key].failed++
      }
    }

    // Total count (from query with filters applied, or from count param)
    let total = count
    if (total == null) {
      const { count: c } = await supabase
        .from('campaign_activity_log')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', req.params.id)
      total = c || 0
    }

    const totalPages = Math.ceil(total / lim)

    // Get distinct accounts in this campaign (for filter dropdown)
    const { data: accountRows } = await supabase
      .from('campaign_activity_log')
      .select('account_id')
      .eq('campaign_id', req.params.id)
    const uniqueAccountIds = [...new Set((accountRows || []).map(r => r.account_id).filter(Boolean))]
    let accounts = []
    if (uniqueAccountIds.length) {
      const { data: accs } = await supabase.from('accounts').select('id, username').in('id', uniqueAccountIds)
      accounts = (accs || []).map(a => ({ id: a.id, name: a.username || a.id.slice(0, 8) }))
    }

    return { data: enriched, total, summary, page: pageNum, per_page: lim, total_pages: totalPages, accounts }
  })

  // GET /campaigns/:id/activity — real-time activity log (recent jobs)
  fastify.get('/:id/activity', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase.from('campaigns')
      .select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { limit = 30, status: filterStatus } = req.query

    let query = supabase.from('jobs')
      .select('id, type, status, payload, result, error_message, started_at, finished_at, created_at, attempt')
      .eq('payload->>campaign_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit))

    if (filterStatus) query = query.eq('status', filterStatus)

    const { data: jobs, error } = await query
    if (error) return reply.code(500).send({ error: error.message })

    // Enrich with account name and role name
    const accountIds = [...new Set((jobs || []).map(j => j.payload?.account_id).filter(Boolean))]
    const roleIds = [...new Set((jobs || []).map(j => j.payload?.role_id).filter(Boolean))]

    const [accountsRes, rolesRes] = await Promise.all([
      accountIds.length ? supabase.from('accounts').select('id, username').in('id', accountIds) : { data: [] },
      roleIds.length ? supabase.from('campaign_roles').select('id, name, role_type').in('id', roleIds) : { data: [] },
    ])

    const accountMap = Object.fromEntries((accountsRes.data || []).map(a => [a.id, a.username]))
    const roleMap = Object.fromEntries((rolesRes.data || []).map(r => [r.id, { name: r.name, type: r.role_type }]))

    const enriched = (jobs || []).map(j => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempt: j.attempt,
      account_name: accountMap[j.payload?.account_id] || j.payload?.account_id?.slice(0, 8),
      role_name: roleMap[j.payload?.role_id]?.name || '-',
      role_type: roleMap[j.payload?.role_id]?.type || '-',
      topic: j.payload?.topic,
      // Extract useful summary from result
      summary: extractJobSummary(j),
      error_message: j.error_message,
      started_at: j.started_at,
      finished_at: j.finished_at,
      created_at: j.created_at,
    }))

    // Count by status for filter pills
    let statusCounts = null
    try {
      const { data } = await supabase.rpc('count_by_status_jsonb', { cid: req.params.id })
      statusCounts = data
    } catch {}

    // Fallback count
    let counts = statusCounts
    if (!counts) {
      const allStatuses = (jobs || []).map(j => j.status)
      counts = {
        pending: allStatuses.filter(s => s === 'pending').length,
        running: allStatuses.filter(s => s === 'running').length,
        done: allStatuses.filter(s => s === 'done').length,
        failed: allStatuses.filter(s => s === 'failed').length,
      }
    }

    return { data: enriched, counts }
  })

  // ── Phase 4: GET /campaigns/:id/ad-report — Ads tab data ──
  fastify.get('/:id/ad-report', { preHandler: fastify.authenticate }, async (req, reply) => {
    const campaignId = req.params.id
    // Verify ownership
    const { data: c } = await supabase.from('campaigns')
      .select('id').eq('id', campaignId).eq('owner_id', req.user.id).single()
    if (!c) return reply.code(404).send({ error: 'Campaign not found' })

    const { data: posts, error } = await supabase
      .from('shared_posts')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('is_ad_opportunity', true)
      .order('detected_at', { ascending: false })
      .limit(200)
    if (error) return reply.code(500).send({ error: error.message })

    const all = posts || []
    const total_opportunities = all.length
    const total_acted = all.filter(p => (p.swarm_count || 0) > 0).length

    // Group by group_fb_id → enrich with group name
    const groupIds = [...new Set(all.map(p => p.group_fb_id).filter(Boolean))]
    let groupNameMap = {}
    if (groupIds.length) {
      const { data: gs } = await supabase.from('fb_groups')
        .select('fb_group_id, name').in('fb_group_id', groupIds)
      groupNameMap = Object.fromEntries((gs || []).map(g => [g.fb_group_id, g.name]))
    }

    const byGroupMap = {}
    for (const p of all) {
      const k = p.group_fb_id || 'unknown'
      if (!byGroupMap[k]) byGroupMap[k] = { group_fb_id: k, group_name: groupNameMap[k] || k, opportunities: 0, acted: 0 }
      byGroupMap[k].opportunities++
      if ((p.swarm_count || 0) > 0) byGroupMap[k].acted++
    }
    const by_group = Object.values(byGroupMap).sort((a, b) => b.opportunities - a.opportunities)

    // Recent: only those acted upon
    const acted = all.filter(p => (p.swarm_count || 0) > 0).slice(0, 30)
    // Resolve account_name for first swarm account
    const accIds = [...new Set(acted.flatMap(p => p.swarm_account_ids || []))]
    let accMap = {}
    if (accIds.length) {
      const { data: accs } = await supabase.from('accounts')
        .select('id, username').in('id', accIds)
      accMap = Object.fromEntries((accs || []).map(a => [a.id, a.username]))
    }
    const recent = acted.map(p => ({
      id: p.id,
      post_preview: (p.post_content || '').slice(0, 200),
      post_url: p.post_url,
      ad_reason: p.ad_reason,
      ai_score: p.ai_score,
      comment_posted: (p.swarm_comments && p.swarm_comments[0]) || null,
      nick_name: accMap[(p.swarm_account_ids || [])[0]] || null,
      acted_at: p.detected_at,
      group_name: groupNameMap[p.group_fb_id] || p.group_fb_id,
    }))

    return {
      total_opportunities,
      total_acted,
      success_rate: total_opportunities > 0 ? Math.round((total_acted / total_opportunities) * 100) : 0,
      by_group,
      recent,
    }
  })

  // ─── POST /campaigns/:id/apply-recommendation ──────────
  // Uses shared service; supports manual single-rec apply.
  const { applyRecommendationCore, recordAppliedRec, autoApplyRecommendations } = require('../services/auto-apply')

  // Expose auto-apply for ai-hermes.js to call after review (via fastify.supabase)
  fastify.decorate('runAutoApply', async ({ campaignId, recommendations, ownerId }) => {
    return autoApplyRecommendations(supabase, { campaignId, recommendations, ownerId })
  })

  fastify.post('/:id/apply-recommendation', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { account_id, action, task_type, priority, rec_index } = req.body || {}
    if (!action) return reply.code(400).send({ error: 'action required' })
    const campaignId = req.params.id
    const { data: campaign } = await supabase
      .from('campaigns').select('id, owner_id')
      .eq('id', campaignId).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })
    try {
      const result = await applyRecommendationCore(supabase, {
        campaignId, accountId: account_id, action, taskType: task_type, priority, createdBy: req.user.id,
      })
      if (!result.ok) return reply.code(400).send({ error: result.error })
      await recordAppliedRec(supabase, {
        campaignId, accountId: account_id, action, taskType: task_type, priority,
        recIndex: rec_index, change: result.change, appliedBy: req.user.id, autoApplied: false,
      })
      return { ok: true, action, account_id, change: result.change }
    } catch (err) {
      fastify.log.error({ err }, '[APPLY-REC] Failed')
      return reply.code(500).send({ error: err.message || 'Apply failed' })
    }
  })

  // ─── GET /campaigns/:id/auto-apply-settings ─────────────
  fastify.get('/:id/auto-apply-settings', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data, error } = await supabase.from('campaigns')
      .select('auto_apply_enabled, auto_apply_percent, auto_apply_min_priority, auto_apply_last_run_at')
      .eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (error || !data) return reply.code(404).send({ error: 'Not found' })
    return data
  })

  // ─── PUT /campaigns/:id/auto-apply-settings ─────────────
  fastify.put('/:id/auto-apply-settings', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { enabled, percent, min_priority } = req.body || {}
    const updates = {}
    if (enabled !== undefined) updates.auto_apply_enabled = !!enabled
    if (percent !== undefined) {
      const p = parseInt(percent)
      if (isNaN(p) || p < 0 || p > 100) return reply.code(400).send({ error: 'percent 0-100' })
      updates.auto_apply_percent = p
    }
    if (min_priority !== undefined) {
      if (!['low', 'medium', 'high'].includes(min_priority)) {
        return reply.code(400).send({ error: 'min_priority: low|medium|high' })
      }
      updates.auto_apply_min_priority = min_priority
    }
    if (Object.keys(updates).length === 0) return reply.code(400).send({ error: 'No fields' })

    const { data, error } = await supabase.from('campaigns')
      .update(updates).eq('id', req.params.id).eq('owner_id', req.user.id).select().single()
    if (error || !data) return reply.code(404).send({ error: 'Not found' })
    return { ok: true, ...data }
  })

  // ─── GET /campaigns/:id/content ─────────────────────────
  // List all posts published for this campaign (from publish_history joined with jobs)
  fastify.get('/:id/content', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase
      .from('campaigns').select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    // Get job IDs for this campaign
    const { data: campaignJobs } = await supabase.from('jobs')
      .select('id').filter('payload->>campaign_id', 'eq', req.params.id).limit(500)
    const jobIds = (campaignJobs || []).map(j => j.id)
    if (jobIds.length === 0) return []

    const { data: posts } = await supabase.from('publish_history')
      .select('*').in('job_id', jobIds)
      .order('published_at', { ascending: false }).limit(100)
    if (!posts || posts.length === 0) return []

    // Enrich with account names
    const accountIds = [...new Set(posts.map(p => p.account_id).filter(Boolean))]
    const { data: accounts } = accountIds.length > 0
      ? await supabase.from('accounts').select('id, username, avatar_url, fb_user_id').in('id', accountIds)
      : { data: [] }
    const accMap = {}
    for (const a of (accounts || [])) accMap[a.id] = a

    return posts.map(p => ({
      ...p,
      account: accMap[p.account_id] || null,
    }))
  })

  // ─── GET /campaigns/:id/fb-groups ───────────────────────
  // List all FB groups for this campaign with join_status filter
  // (Different from /:id/groups which returns campaign_groups junction)
  fastify.get('/:id/fb-groups', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase
      .from('campaigns').select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const status = req.query.status || 'all'
    let query = supabase.from('fb_groups')
      .select('*')
      .or(`joined_via_campaign_id.eq.${req.params.id},campaign_ids.cs.{${req.params.id}}`)
      .order('last_posted_at', { ascending: false, nullsFirst: false })
      .limit(500)

    if (status !== 'all') query = query.eq('join_status', status)
    const { data, error } = await query
    if (error) return reply.code(500).send({ error: error.message })

    // Compute stats
    const now = Date.now()
    const items = (data || []).map(g => {
      const pendingDays = g.pending_since
        ? Math.floor((now - new Date(g.pending_since).getTime()) / 86400000)
        : null
      return {
        ...g,
        pending_days: pendingDays,
        overdue: pendingDays !== null && pendingDays > 7,
      }
    })

    return items
  })

  // ─── GET /campaigns/:id/hermes-reviews ──────────────────
  // List past reviews with applied recommendations for this campaign
  fastify.get('/:id/hermes-reviews', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { data: campaign } = await supabase
      .from('campaigns').select('id').eq('id', req.params.id).eq('owner_id', req.user.id).single()
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' })

    const { data: reviews, error } = await supabase
      .from('campaign_hermes_reviews')
      .select('*')
      .eq('campaign_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return reply.code(500).send({ error: error.message })
    return reviews || []
  })
}

function extractJobSummary(job) {
  const r = job.result
  if (!r) return null
  if (r.skipped) return `⏭️ ${r.reason?.replace('SKIP_', '') || 'skipped'}`

  const parts = []

  // Group names from details
  const groupNames = (r.details || []).map(d => d.group_name).filter(Boolean)
  if (groupNames.length > 0) parts.push(groupNames.slice(0, 2).join(', '))

  // Counts — handle both key formats (likes/liked, comments/commented)
  const likes = r.likes ?? r.liked ?? 0
  const comments = r.comments ?? r.commented ?? 0
  const friendsSent = r.friends_sent ?? r.requests_sent ?? 0
  const groupsJoined = r.groups_joined ?? 0
  const groupsVisited = r.groups_visited ?? 0

  const counts = []
  if (groupsJoined > 0) counts.push(`+${groupsJoined} nhóm`)
  if (groupsVisited > 0 && !groupsJoined) counts.push(`${groupsVisited} nhóm`)
  if (likes > 0) counts.push(`${likes} like`)
  if (comments > 0) counts.push(`${comments} cmt`)
  if (friendsSent > 0) counts.push(`${friendsSent} kết bạn`)
  if (r.posts_scanned) counts.push(`${r.posts_scanned} bài scan`)

  if (counts.length > 0) parts.push(counts.join(', '))

  // Duration
  const dur = r.duration_seconds
  if (dur) parts.push(dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}m`)

  if (r.message) parts.push(r.message)
  return parts.length > 0 ? parts.join(' · ') : null
}
