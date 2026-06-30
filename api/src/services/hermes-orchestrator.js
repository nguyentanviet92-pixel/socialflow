/**
 * Hermes Campaign Orchestrator
 *
 * Reads the current state of a running campaign, asks Hermes for concrete
 * next-step actions, executes auto-applyable actions, and logs everything
 * to `hermes_decisions` for the UI audit tab.
 *
 * Entry points:
 *   runOrchestration(campaignId, supabase) — one-shot, returns result + decisions
 *   runAllRunningCampaigns(supabase)       — cron hook, iterates is_active=true
 *
 * See HERMES_ORCHESTRATOR.md for the design spec.
 */

const { randomUUID } = require('crypto')
const { checkAndReserve } = require('./nick-quota')

const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8100'
const AGENT_SECRET = process.env.AGENT_SECRET

// ─── Hermes call helper ────────────────────────────────────
async function callHermes(taskType, userContent, maxTokens = 1500) {
  if (!AGENT_SECRET) throw new Error('AGENT_SECRET not configured')
  const controller = new AbortController()
  // 240s timeout (was 120s): when Moonshot 429s/401s, fallback chain (DeepSeek →
  // NVIDIA → Gemini) adds 20-40s. Big skills (orchestrator 2000 tokens,
  // self_reviewer 2500) on DeepSeek-chat regularly take 35-50s. 120s caused
  // false aborts mid-fallback that blocked assign_job emission entirely.
  const timer = setTimeout(() => controller.abort(), 240000)
  try {
    const res = await fetch(`${HERMES_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_SECRET },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userContent }],
        max_tokens: maxTokens,
        temperature: 0.3,
        task_type: taskType,
        function_name: taskType,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Hermes ${taskType} HTTP ${res.status}`)
    const json = await res.json()
    return json.text
  } finally {
    clearTimeout(timer)
  }
}

function extractJson(text) {
  if (!text) return null
  // Strip ```json ... ``` fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  // Find first { ... } block
  const start = body.indexOf('{')
  if (start === -1) return null
  // Walk forward matching braces (avoids trailing garbage after the json)
  let depth = 0
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

// ─── Context builder ───────────────────────────────────────
async function buildOrchestrationContext(campaignId, supabase) {
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single()
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

  // Roles + nicks assigned. AI_PILOT campaigns can have account_ids at the
  // campaign level WITHOUT any campaign_roles rows (Hermes orchestrates
  // roles implicitly). Fall back to campaign.account_ids so the context
  // isn't empty — otherwise every assign_job/recheck_group fails with
  // "nick not found in context" and only skip_group ever succeeds.
  const { data: roles } = await supabase
    .from('campaign_roles')
    .select('id, name, role_type, account_ids, is_active')
    .eq('campaign_id', campaignId)
  const allAccountIds = new Set()
  for (const r of roles || []) (r.account_ids || []).forEach(id => allAccountIds.add(id))
  if (allAccountIds.size === 0) {
    for (const id of campaign.account_ids || []) allAccountIds.add(id)
  }

  let nicks = []
  if (allAccountIds.size > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, username, status, is_active, last_used_at, daily_budget, created_at')
      .in('id', [...allAccountIds])

    // Per-nick: jobs_today, active_job, failed_jobs
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const { data: todayJobs } = await supabase
      .from('jobs')
      .select('id, payload, status, started_at')
      .gte('created_at', since)
      .in('status', ['pending', 'claimed', 'running', 'done', 'failed'])

    const jobsByNick = new Map()
    for (const j of todayJobs || []) {
      const accId = j.payload?.account_id
      if (!accId) continue
      const entry = jobsByNick.get(accId) || { done: 0, failed: 0, active: null }
      if (j.status === 'done') entry.done++
      else if (j.status === 'failed') entry.failed++
      else if (['claimed', 'running'].includes(j.status)) entry.active = j.id
      jobsByNick.set(accId, entry)
    }

    // Pending-cap signal: how many user-facing pending/claimed/running jobs
    // each nick has across ALL campaigns. Hermes uses this to skip emitting
    // assign_job when a nick is already at MAX_PENDING_PER_NICK (3) — without
    // this signal, the orchestrator emits assign_job repeatedly and every
    // run is rejected by the executeAction guard ("nick at pending cap"),
    // generating 6+ "Lỗi" rows per nick per hour.
    let pendingByNick = new Map()
    let pendingCap = 3
    try {
      const { getNickPendingCounts, MAX_PENDING_PER_NICK } = require('../lib/nick-lock')
      pendingByNick = await getNickPendingCounts([...allAccountIds])
      pendingCap = MAX_PENDING_PER_NICK
    } catch (err) {
      console.warn(`[ORCHESTRATOR] pending count compute failed: ${err.message}`)
    }

    const roleByAcc = new Map()
    for (const r of roles || []) {
      for (const accId of r.account_ids || []) {
        if (!roleByAcc.has(accId)) roleByAcc.set(accId, r.role_type)
      }
    }

    // ── Checkpoint-risk signal (per nick) ──────────────────
    // Hermes uses this to PROACTIVELY throttle before the nick actually dies.
    // Three inputs:
    //   1. recent_checkpoints_7d — how many times this nick failed with
    //      CHECKPOINT/SESSION_EXPIRED in the last 7 days (from job_failures)
    //   2. avg_gap_seconds — average time between the nick's last 10 actions
    //      (too fast = bot-like → higher risk)
    //   3. patterns — any ai_pilot_memory.checkpoint_pattern rows Hermes has
    //      previously deduced for this nick
    const since7d = new Date(Date.now() - 7 * 86400000).toISOString()
    const riskByNick = new Map()
    try {
      // 1. Checkpoint failures per nick (last 7d)
      const { data: failRows } = await supabase
        .from('job_failures')
        .select('account_id, error_type')
        .gte('created_at', since7d)
        .in('error_type', ['CHECKPOINT', 'SESSION_EXPIRED'])
      for (const r of failRows || []) {
        const e = riskByNick.get(r.account_id) || { recent_checkpoints_7d: 0 }
        e.recent_checkpoints_7d = (e.recent_checkpoints_7d || 0) + 1
        riskByNick.set(r.account_id, e)
      }

      // 2. Avg gap between last 10 COMMENTS (per nick). We used to average
      // across all action types, but likes naturally come in quick bursts
      // (2-5s apart when human scrolls and hearts) — that pulled the gap
      // below 120s for legitimate healthy behavior and triggered pause_nick
      // false positives. Comments are the signal that matters for spam
      // detection anyway, and the agent already enforces 90s minGap between
      // them, so normal baseline should be 90-180s.
      const { data: recentActions } = await supabase
        .from('campaign_activity_log')
        .select('account_id, action_type, created_at')
        .in('account_id', [...allAccountIds])
        .in('action_type', ['comment', 'opportunity_comment'])
        .gte('created_at', new Date(Date.now() - 6 * 3600 * 1000).toISOString())
        .order('created_at', { ascending: false })
      const actionsByNick = new Map()
      for (const row of recentActions || []) {
        if (!row.account_id) continue
        const arr = actionsByNick.get(row.account_id) || []
        if (arr.length < 10) arr.push(new Date(row.created_at).getTime())
        actionsByNick.set(row.account_id, arr)
      }
      for (const [accId, times] of actionsByNick.entries()) {
        if (times.length < 2) continue
        const gaps = []
        for (let i = 0; i < times.length - 1; i++) gaps.push((times[i] - times[i + 1]) / 1000)
        const avgGap = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
        const e = riskByNick.get(accId) || {}
        e.avg_comment_gap_seconds = avgGap
        e.comment_sample_size = gaps.length
        riskByNick.set(accId, e)
      }

      // 3. Hermes-learned patterns for each nick
      const { data: memRows } = await supabase
        .from('ai_pilot_memory')
        .select('account_id, key, value, confidence, evidence_count')
        .in('account_id', [...allAccountIds])
        .eq('memory_type', 'checkpoint_pattern')
        .order('evidence_count', { ascending: false })
      for (const m of memRows || []) {
        const e = riskByNick.get(m.account_id) || {}
        if (!e.patterns) e.patterns = []
        if (e.patterns.length < 3) {
          e.patterns.push({
            key: m.key,
            cause: m.value?.primary_cause,
            confidence: m.confidence,
            evidence_count: m.evidence_count,
          })
        }
        riskByNick.set(m.account_id, e)
      }
    } catch (err) {
      console.warn(`[ORCHESTRATOR] checkpoint_risk compute failed: ${err.message}`)
    }

    nicks = (accounts || []).map(a => {
      const jobStats = jobsByNick.get(a.id) || { done: 0, failed: 0, active: null }
      const idleMs = a.last_used_at ? Date.now() - new Date(a.last_used_at).getTime() : Infinity
      const idleMinutes = isFinite(idleMs) ? Math.floor(idleMs / 60000) : 999
      const risk = riskByNick.get(a.id) || {}
      const pendingCount = pendingByNick.get(a.id) || 0
      return {
        id: a.id,
        username: a.username,
        status: a.status || 'unknown',
        is_active: a.is_active !== false,
        role: roleByAcc.get(a.id) || 'unknown',
        jobs_today: jobStats.done,
        jobs_failed: jobStats.failed,
        active_job: jobStats.active,
        // Pending cap (cross-campaign). Hermes MUST NOT emit assign_job when
        // pending_jobs_count >= pending_cap — guard at executeAction would
        // reject and the decision row gets logged as a fake error.
        pending_jobs_count: pendingCount,
        pending_cap: pendingCap,
        at_pending_cap: pendingCount >= pendingCap,
        idle_minutes: idleMinutes,
        hermes_score: null, // filled by score service if present
        checkpoint_risk: {
          recent_checkpoints_7d: risk.recent_checkpoints_7d || 0,
          avg_comment_gap_seconds: risk.avg_comment_gap_seconds ?? null,
          comment_sample_size: risk.comment_sample_size || 0,
          patterns: risk.patterns || [],
        },
        // Expose current budget caps so Hermes doesn't emit decrease_budget
        // when the budget is already at floor (e.g., comment.max=1 → 1 no-op).
        budget_caps: (() => {
          const b = a.daily_budget || {}
          const out = {}
          for (const k of ['comment', 'like', 'post', 'friend_request', 'join_group']) {
            if (b[k]?.max != null) out[k] = { used: b[k].used || 0, max: b[k].max }
          }
          return out
        })(),
      }
    })
  }

  // Campaign groups via junction. total_yields + engagement_rate are agent-
  // populated signals (recordGroupYield) — Hermes uses them to prioritize
  // groups that have actually produced engageable content vs dud groups.
  const { data: junction } = await supabase
    .from('campaign_groups')
    .select('group_id, status, fb_groups!inner(id, fb_group_id, name, url, member_count, join_status, pending_since, last_posted_at, consecutive_skips, total_yields, last_yield_at, engagement_rate)')
    .eq('campaign_id', campaignId)

  const groupIds = (junction || []).map(r => r.group_id).filter(Boolean)

  // Check-history per group: pending/running jobs + past finished checks.
  // Lets the skill distinguish "pending because FB hasn't approved yet" from
  // "pending because no nick has checked it yet".
  const checkHistory = new Map() // group_id → { has_check_job, last_check_at, check_count }
  if (groupIds.length) {
    try {
      const { data: checkJobs } = await supabase
        .from('jobs')
        .select('payload, status, finished_at, created_at')
        .eq('type', 'check_group_membership')
        .in('status', ['pending', 'claimed', 'running', 'done', 'failed'])
        .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
      for (const j of checkJobs || []) {
        const gid = j.payload?.group_row_id
        if (!gid || !groupIds.includes(gid)) continue
        const entry = checkHistory.get(gid) || { has_check_job: false, last_check_at: null, check_count: 0 }
        const inflight = ['pending', 'claimed', 'running'].includes(j.status)
        if (inflight) entry.has_check_job = true
        const ts = j.finished_at || j.created_at
        if (ts && (!entry.last_check_at || new Date(ts) > new Date(entry.last_check_at))) {
          entry.last_check_at = ts
        }
        if (j.status === 'done' || j.status === 'failed') entry.check_count++
        checkHistory.set(gid, entry)
      }
    } catch {}
  }

  const groups = (junction || []).map(r => {
    const g = r.fb_groups || {}
    const pendingDays = g.pending_since
      ? Math.floor((Date.now() - new Date(g.pending_since).getTime()) / 86400000)
      : null
    const hist = checkHistory.get(g.id) || { has_check_job: false, last_check_at: null, check_count: 0 }
    return {
      id: g.id,
      fb_group_id: g.fb_group_id,
      name: g.name,
      join_status: g.join_status || 'unknown',
      member_count: g.member_count || 0,
      pending_days: pendingDays,
      posts_this_week: null, // expensive to compute; skip for now
      last_posted_at: g.last_posted_at,
      consecutive_skips: g.consecutive_skips || 0,
      // New (2026-04-17): so Hermes can decide "recheck vs skip" smartly
      has_check_job: hist.has_check_job,
      last_check_at: hist.last_check_at,
      check_count: hist.check_count,
      // Engagement signal (2026-04-26) — agent updates these via
      // recordGroupYield in campaign-nurture. spreader/orchestrator use them
      // to prioritize groups that actually produce engageable content.
      total_yields: g.total_yields || 0,
      last_yield_at: g.last_yield_at,
      engagement_rate: g.engagement_rate ?? null,
    }
  })

  // Stats today
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { data: statsLog } = await supabase
    .from('campaign_activity_log')
    .select('action_type')
    .eq('campaign_id', campaignId)
    .gte('created_at', todayStart.toISOString())
  const stats = { comments: 0, posts: 0, interactions: 0, likes: 0, failed_jobs: 0, checkpoints: 0 }
  for (const row of statsLog || []) {
    const t = row.action_type
    if (t === 'comment') stats.comments++
    else if (t === 'post') stats.posts++
    else if (t === 'like') stats.likes++
    else stats.interactions++
  }
  const { count: failedTodayCount } = await supabase
    .from('job_failures')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .gte('created_at', todayStart.toISOString())
  stats.failed_jobs = failedTodayCount || 0
  stats.checkpoints = (nicks || []).filter(n => n.status === 'checkpoint').length

  const runningDays = campaign.created_at
    ? Math.floor((Date.now() - new Date(campaign.created_at).getTime()) / 86400000)
    : 0

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      owner_id: campaign.owner_id || campaign.created_by || null,
      goal: campaign.goal || campaign.mission || null,
      topic: campaign.topic || null,
      mission: campaign.mission || null,
      hermes_context: campaign.hermes_context || null,
      brand_config: campaign.brand_config || null,
      ad_mode: campaign.ad_mode || 'normal',
      status: campaign.is_active ? 'running' : 'paused',
      running_days: runningDays,
    },
    nicks,
    groups,
    stats_today: stats,
    target: {
      comments_per_day: campaign.target_comments_per_day || 20,
      posts_per_day: campaign.target_posts_per_day || 3,
    },
  }
}

// 30-minute dedup window — don't let the orchestrator pile up jobs of the
// same type for the same nick when a previous recommendation is still pending.
// Prevents the "check already queued" noise seen in production + saves
// capacity on the 2-slot agent.
async function recentJobExists(supabase, { accountId, jobType, windowMinutes = 30 }) {
  if (!accountId) return false
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString()
  const { data } = await supabase
    .from('jobs')
    .select('id, payload, status, created_at')
    .eq('type', jobType)
    .in('status', ['pending', 'claimed', 'running'])
    .gte('created_at', since)
  return (data || []).some(j => j.payload?.account_id === accountId)
}

// Build consistent payload for orchestrator-created jobs. Every job MUST carry
// owner_id + topic + mission etc. so the agent handler has the context it
// needs. Observed bug: orchestrator jobs missed `topic` and campaign-nurture
// crashed on `topic.toLowerCase()` at line 504 → 0 KPI across every session.
function orchestratorPayload(context, extras = {}) {
  const c = context.campaign || {}
  return {
    campaign_id: c.id,
    owner_id: c.owner_id || null,
    topic: c.topic || null,
    mission: c.mission || null,
    brand_config: c.brand_config || null,
    ad_mode: c.ad_mode || 'normal',
    orchestrator: true,
    ...extras,
  }
}

// ─── Outcome classification ────────────────────────────────
// executeAction returns { ok: false, detail: '...' } in two scenarios:
//   1. Real failure — DB error, API timeout, unexpected exception
//   2. Defensive guard rejection — nick at pending cap, already running,
//      already queued, paused, resting. Not a real "error", just a no-op.
// We map (2) to outcome='skipped' so the UI doesn't render it as red "X Lỗi"
// (orchestrator runs every 5min → without this, healthy nicks at cap accrue
// 6+ "Lỗi" rows per hour, drowning real failures in noise).
const GUARD_REJECT_PATTERNS = [
  /pending cap/i,
  /already has active job/i,
  /is paused/i,
  /resting/i,
  /already queued/i,
  /nick not found in context/i,
  /nick is checkpoint/i,
  /budget exhausted/i,
]
function classifyOutcome(r) {
  if (r?.ok) return 'success'
  const detail = r?.detail || ''
  if (GUARD_REJECT_PATTERNS.some(p => p.test(detail))) return 'skipped'
  return 'failed'
}

// ─── Action executors ──────────────────────────────────────
async function executeAction(action, campaignId, context, supabase) {
  switch (action.type) {
    case 'assign_job': {
      const accId = action.target_id
      const jobType = action.action_detail?.job_type || 'campaign_nurture'
      const groupId = action.action_detail?.group_id || null
      const nick = (context.nicks || []).find(n => n.id === accId)
      if (!nick) return { ok: false, detail: 'nick not found in context' }
      if (nick.is_active === false) return { ok: false, detail: 'nick is paused (is_active=false)' }
      if (nick.active_job) return { ok: false, detail: 'nick already has active job' }

      // Global pending cap — if schedulers have already queued MAX for this
      // nick across ALL campaigns, don't add more. Orchestrator runs per
      // campaign so without this it would happily stack jobs the agent
      // can't drain in time.
      try {
        const { getNickPendingCounts, MAX_PENDING_PER_NICK } = require('../lib/nick-lock')
        const counts = await getNickPendingCounts([accId])
        const pending = counts.get(accId) || 0
        if (pending >= MAX_PENDING_PER_NICK) {
          return { ok: false, detail: `nick at pending cap (${pending}/${MAX_PENDING_PER_NICK})` }
        }
      } catch { /* non-fatal — fall through */ }

      // Dedup: if a same-type job for this nick is already in-flight within
      // the last 30 minutes, skip silently. The in-flight one covers the need.
      if (await recentJobExists(supabase, { accountId: accId, jobType })) {
        return { ok: false, detail: `${jobType} for nick already queued <30min` }
      }

      // Rest-state gate: the poller enforces a 45-120min rest after each
      // 25-45min session. If we assign during rest, the job just sits pending
      // until rest ends — wasteful + clogs the queue. Use the DB as ground
      // truth (we don't have a nick_session_state table): if the most recent
      // done/failed job finished < 45 minutes ago, skip.
      try {
        const { data: lastDone } = await supabase
          .from('jobs')
          .select('finished_at, status')
          .eq('payload->>account_id', accId)
          .in('status', ['done', 'failed'])
          .order('finished_at', { ascending: false })
          .limit(1)
        const last = lastDone?.[0]
        if (last?.finished_at) {
          const restedMs = Date.now() - new Date(last.finished_at).getTime()
          const restedMin = Math.floor(restedMs / 60000)
          if (restedMin < 45) {
            return { ok: false, detail: `nick resting (${restedMin}/45 min since last job)` }
          }
        }
      } catch (err) {
        // Non-fatal — fall through to insert
        console.warn(`[ORCHESTRATOR] rest-check failed: ${err.message}`)
      }

      // Daily quota: cap creation per (nick, job_type, day) to match agent
      // drain rate. Without this, orchestrator + other crons would keep
      // queuing beyond what the 2-slot agent can process.
      const quotaRes = await checkAndReserve(supabase, { accountId: accId, jobType })
      if (!quotaRes.ok) {
        return { ok: false, detail: `${jobType} daily quota exhausted (${quotaRes.count}/${quotaRes.quota})` }
      }

      // Find the role for this nick in this campaign.
      // pg-supabase wrapper doesn't implement .contains() for arrays, so pull
      // all roles for the campaign and filter in JS.
      const { data: roles } = await supabase
        .from('campaign_roles')
        .select('id, account_ids')
        .eq('campaign_id', campaignId)
      const roleRow = (roles || []).find(r => (r.account_ids || []).includes(accId))

      // Honor scheduled_offset_minutes from social_graph_spreader allocations:
      // staggers job creation so 4 nicks assigned in the same orchestration cycle
      // don't all hit FB at the same instant.
      const offsetMin = Number(action.action_detail?.scheduled_offset_minutes) || 0
      const scheduledAt = offsetMin > 0
        ? new Date(Date.now() + offsetMin * 60000).toISOString()
        : new Date().toISOString()
      const { data: inserted, error } = await supabase
        .from('jobs')
        .insert({
          type: jobType,
          priority: 2,
          status: 'pending',
          scheduled_at: scheduledAt,
          payload: orchestratorPayload(context, {
            account_id: accId,
            role_id: roleRow?.id || null,
            group_id: groupId,
          }),
          created_by: context.campaign?.owner_id || null,
        })
        .select('id')
        .single()
      if (error) return { ok: false, detail: error.message }
      return { ok: true, detail: offsetMin > 0 ? `job ${inserted.id} scheduled +${offsetMin}min` : `job ${inserted.id} created` }
    }

    case 'skip_group': {
      const { error } = await supabase
        .from('fb_groups')
        .update({
          join_status: 'rejected',
          blocked_reason: action.action_detail?.reason || 'orchestrator_skip',
          is_blocked: true,
        })
        .eq('id', action.target_id)
      if (error) return { ok: false, detail: error.message }
      // Also deactivate junction row so schedulers stop seeing it
      await supabase
        .from('campaign_groups')
        .update({ status: 'skipped' })
        .eq('campaign_id', campaignId)
        .eq('group_id', action.target_id)
      return { ok: true, detail: 'group marked skipped' }
    }

    case 'recheck_group': {
      // Validate accountId against context.nicks so LLM can't accidentally
      // hand us a user_id (owner_id) instead of an account UUID — we've seen
      // the LLM do this, and it caused the handler to error with
      // 'account_id and fb_group_id required' and FK violations on
      // job_failures (account_id not in accounts table).
      const nickIds = new Set((context.nicks || []).map(n => n.id))
      const candidate = action.action_detail?.account_id
      let accountId = (candidate && nickIds.has(candidate)) ? candidate : null
      if (!accountId) {
        accountId = (context.nicks || []).find(n => n.status === 'healthy')?.id
          || (context.nicks || [])[0]?.id
      }
      if (!accountId) return { ok: false, detail: 'no healthy nick available to recheck from' }

      // Handler needs fb_group_id (the FB-side id) AND group_row_id (our uuid).
      // Resolve fb_group_id from fb_groups using the target_id (a group_row_id).
      const { data: grp } = await supabase
        .from('fb_groups')
        .select('id, fb_group_id, url, name')
        .eq('id', action.target_id)
        .single()
      if (!grp?.fb_group_id) {
        return { ok: false, detail: `fb_group_id not found for group ${action.target_id}` }
      }

      // Dedup: skip if a pending membership check already exists for this group.
      // Keep the per-group dedup (not just per-nick) because membership checks
      // are keyed by group_row_id.
      const { data: existingJobs } = await supabase
        .from('jobs')
        .select('id, payload')
        .eq('type', 'check_group_membership')
        .in('status', ['pending', 'running', 'claimed'])
      const dup = (existingJobs || []).some(j => j.payload?.group_row_id === action.target_id)
      if (dup) return { ok: false, detail: 'check already queued' }

      // Daily quota on the nick that will run the check
      const qr = await checkAndReserve(supabase, { accountId, jobType: 'check_group_membership' })
      if (!qr.ok) return { ok: false, detail: `check_group_membership daily quota exhausted (${qr.count}/${qr.quota})` }

      const { error } = await supabase.from('jobs').insert({
        type: 'check_group_membership',
        priority: 7,
        status: 'pending',
        scheduled_at: new Date(Date.now() + 60000).toISOString(),
        payload: orchestratorPayload(context, {
          account_id: accountId,
          group_row_id: action.target_id,
          fb_group_id: grp.fb_group_id,
          group_url: grp.url || null,
          group_name: grp.name || null,
        }),
        created_by: context.campaign?.owner_id || null,
      })
      if (error) return { ok: false, detail: error.message }
      return { ok: true, detail: 'recheck queued' }
    }

    case 'reassign_nick': {
      const newRole = action.action_detail?.new_role
      if (!newRole) return { ok: false, detail: 'new_role required' }
      // Nothing to do structurally — roles are lists of account_ids.
      // Log only; user needs to move nick between roles in UI.
      return { ok: false, detail: 'reassign is user-facing; logged for review' }
    }

    case 'pause_nick': {
      // Supports temporary pause via action_detail.duration_hours — writes a
      // resume_at timestamp so a future cron (or the orchestrator itself) can
      // re-enable. If no duration, pauses indefinitely (user must manually resume).
      const hours = Number(action.action_detail?.duration_hours) || null
      const resumeAt = hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null
      const updates = { is_active: false }
      if (resumeAt) updates.notes = `orchestrator_pause_until:${resumeAt} — ${action.reason || ''}`.slice(0, 500)
      const { error } = await supabase
        .from('accounts')
        .update(updates)
        .eq('id', action.target_id)
      if (error) return { ok: false, detail: error.message }
      return { ok: true, detail: resumeAt ? `paused until ${resumeAt}` : 'paused indefinitely' }
    }

    case 'decrease_budget': {
      // Proactive throttle: multiply a specific budget field by a fraction.
      // action_detail: { task_type: 'comment'|'like'|..., multiplier: 0.5 }
      // Persists to accounts.daily_budget[task_type].max; new max is max(1, floor(current*multiplier)).
      // Does NOT reset .used — just caps future creation.
      const taskType = action.action_detail?.task_type
      const mult = Number(action.action_detail?.multiplier)
      if (!taskType || !(mult > 0 && mult <= 1)) {
        return { ok: false, detail: 'task_type + multiplier (0-1) required' }
      }
      const { data: acc, error: readErr } = await supabase
        .from('accounts')
        .select('id, daily_budget, username')
        .eq('id', action.target_id)
        .single()
      if (readErr || !acc) return { ok: false, detail: readErr?.message || 'nick not found' }
      const budget = acc.daily_budget || {}
      const slot = budget[taskType] || { used: 0, max: 10 }
      const oldMax = slot.max || 10
      // Guard: don't bother executing when already at or below the minimum floor.
      // Caller's Hermes should skip this but belt-and-suspenders.
      if (oldMax <= 1) {
        return { ok: false, detail: `${acc.username} ${taskType}.max already at ${oldMax}, no-op` }
      }
      const newMax = Math.max(1, Math.floor(oldMax * mult))
      if (newMax >= oldMax) {
        return { ok: false, detail: `${acc.username} ${taskType}.max ${oldMax} → ${newMax} (no reduction, skip)` }
      }
      const newBudget = { ...budget, [taskType]: { ...slot, max: newMax } }
      const { error: upErr } = await supabase
        .from('accounts')
        .update({ daily_budget: newBudget })
        .eq('id', action.target_id)
      if (upErr) return { ok: false, detail: upErr.message }
      return { ok: true, detail: `${acc.username} ${taskType}.max ${oldMax} → ${newMax}` }
    }

    case 'alert_user': {
      // Write a notification row so the user sees it in the UI
      const { error } = await supabase.from('notifications').insert({
        user_id: context.campaign?.owner_id || null,
        type: 'orchestrator_alert',
        title: `Hermes: ${action.target_name || action.target_id}`,
        body: action.reason + (action.action_detail?.message ? ` — ${action.action_detail.message}` : ''),
        level: action.action_detail?.severity === 'urgent' ? 'urgent' : 'warning',
        data: { campaign_id: campaignId, target_id: action.target_id },
      })
      if (error) return { ok: false, detail: error.message }
      return { ok: true, detail: 'notification created' }
    }

    case 'raise_kpi_target': {
      // Applies the capability bump recommended by nick-kpi-watcher.
      // Bumps target_* columns on today's + future nick_kpi_daily rows.
      const accountId = action.target_id
      const detail = action.action_detail || (typeof action.decision === 'object' ? action.decision : {})
      const bumpPct = detail.bump_pct || 20
      const factor = 1 + bumpPct / 100
      try {
        await supabase._pool.query(
          `UPDATE nick_kpi_daily
           SET target_likes   = ROUND(target_likes   * $2)::int,
               target_comments= ROUND(target_comments* $2)::int,
               target_opportunity_comments = ROUND(COALESCE(target_opportunity_comments,0) * $2)::int,
               target_friend_requests = ROUND(target_friend_requests * $2)::int,
               target_group_joins     = ROUND(target_group_joins     * $2)::int
           WHERE account_id = $1 AND date >= CURRENT_DATE`,
          [accountId, factor]
        )
        await supabase.from('ai_pilot_memory').upsert({
          memory_type: 'nick_capability',
          key: `capability_bump:${accountId}`,
          value: { bump_pct: bumpPct, applied_at: new Date().toISOString() },
          owner_id: context.campaign?.owner_id || null,
        })
        return { ok: true, detail: `KPI target +${bumpPct}% applied` }
      } catch (err) {
        return { ok: false, detail: err.message }
      }
    }

    case 'lower_kpi_target': {
      // Applies the capability nerf — protects a stressed nick by reducing
      // its KPI target. Applied to today + next 7 days so the nick has
      // breathing room to recover. Floored at safe minimums so a nerfed
      // nick still has SOMETHING to do (else kpi_met trivially=true).
      const accountId = action.target_id
      const detail = action.action_detail || (typeof action.decision === 'object' ? action.decision : {})
      const nerfPct = detail.nerf_pct || 30
      const factor = 1 - nerfPct / 100
      try {
        await supabase._pool.query(
          `UPDATE nick_kpi_daily
           SET target_likes    = GREATEST(5, ROUND(target_likes    * $2)::int),
               target_comments = GREATEST(2, ROUND(target_comments * $2)::int),
               target_opportunity_comments = CASE
                 WHEN COALESCE(target_opportunity_comments,0) > 0
                 THEN GREATEST(1, ROUND(target_opportunity_comments * $2)::int)
                 ELSE 0 END,
               target_friend_requests = GREATEST(1, ROUND(target_friend_requests * $2)::int),
               target_group_joins     = GREATEST(1, ROUND(target_group_joins     * $2)::int)
           WHERE account_id = $1 AND date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`,
          [accountId, factor]
        )
        await supabase.from('ai_pilot_memory').upsert({
          memory_type: 'nick_capability',
          key: `capability_nerf:${accountId}`,
          value: { nerf_pct: nerfPct, reason: detail.reason, applied_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7*86400000).toISOString() },
          owner_id: context.campaign?.owner_id || null,
        })
        return { ok: true, detail: `KPI target -${nerfPct}% applied for 7 days (${detail.reason || 'nick stressed'})` }
      } catch (err) {
        return { ok: false, detail: err.message }
      }
    }

    case 'investigate_nick_shortfall': {
      // Informational — nothing to execute. The decision itself IS the
      // information (cause + plan shown in the drawer).
      return { ok: true, detail: 'shortfall diagnosis logged' }
    }

    case 'create_content':
    default:
      return { ok: false, detail: `action type '${action.type}' not implemented` }
  }
}

// ─── Anti-detection signal builder ─────────────────────────
// Augments orchestration context with the 3 extra signals the pre-orchestration
// pipeline needs: per-nick action density, per-nick recent group activity,
// and machine-wide concurrent active count. Kept best-effort — failures
// short-circuit the pipeline but don't block the main orchestrator.
async function buildAntiDetectSignals(accountIds, supabase) {
  const signals = {
    actionCounts: new Map(),       // accId → { last_1h, last_24h, last_7d }
    nickGroupRecency: new Map(),   // accId → [{ fb_group_id, minutes_ago, action_type }]
    groupActivity: new Map(),      // fb_group_id → { last_actor_acc, last_minutes_ago, active_nicks_last_hour }
    concurrentActiveCount: 0,
    personas: new Map(),           // accId → persona object | null
  }
  if (!accountIds.length) return signals

  const since1h = new Date(Date.now() - 3600000).toISOString()
  const since6h = new Date(Date.now() - 6 * 3600000).toISOString()
  const since24h = new Date(Date.now() - 24 * 3600000).toISOString()
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString()

  try {
    // Action counts (last 7d covers all windows; aggregate in JS)
    const { data: rows } = await supabase
      .from('campaign_activity_log')
      .select('account_id, action_type, target_type, target_id, created_at')
      .in('account_id', accountIds)
      .gte('created_at', since7d)
    const now = Date.now()
    for (const r of rows || []) {
      const ts = new Date(r.created_at).getTime()
      const ageMs = now - ts
      const a = signals.actionCounts.get(r.account_id) || { last_1h: 0, last_24h: 0, last_7d: 0 }
      a.last_7d++
      if (ageMs <= 24 * 3600000) a.last_24h++
      if (ageMs <= 3600000) a.last_1h++
      signals.actionCounts.set(r.account_id, a)

      // Group recency: only last 6h, only target_type=group
      if (r.target_type === 'group' && r.target_id && ts >= new Date(since6h).getTime()) {
        const list = signals.nickGroupRecency.get(r.account_id) || []
        const minutesAgo = Math.floor(ageMs / 60000)
        // Keep only most recent per group
        const existing = list.find(g => g.fb_group_id === r.target_id)
        if (!existing) {
          list.push({ fb_group_id: r.target_id, minutes_ago: minutesAgo, action_type: r.action_type })
        } else if (minutesAgo < existing.minutes_ago) {
          existing.minutes_ago = minutesAgo
          existing.action_type = r.action_type
        }
        signals.nickGroupRecency.set(r.account_id, list)

        // Group-side aggregation
        const ga = signals.groupActivity.get(r.target_id) || {
          last_actor_acc: null, last_minutes_ago: Infinity, active_nicks_last_hour: new Set(),
        }
        if (minutesAgo < ga.last_minutes_ago) {
          ga.last_minutes_ago = minutesAgo
          ga.last_actor_acc = r.account_id
        }
        if (ts >= new Date(since1h).getTime()) ga.active_nicks_last_hour.add(r.account_id)
        signals.groupActivity.set(r.target_id, ga)
      }
    }
  } catch (err) {
    console.warn(`[ANTI-DETECT] activity query failed: ${err.message}`)
  }

  try {
    // Machine concurrency: jobs claimed/running across ALL campaigns. The agent
    // is a per-machine process so this approximates "how many nicks are
    // currently driving a browser session right now". The 10-nicks-on-1-machine
    // safety threshold is configured in the conductor skill (default max_concurrent=3).
    const { data: live } = await supabase
      .from('jobs')
      .select('id, status')
      .in('status', ['claimed', 'running'])
    signals.concurrentActiveCount = (live || []).length
  } catch (err) {
    console.warn(`[ANTI-DETECT] concurrency query failed: ${err.message}`)
  }

  try {
    // Personas: opt-in via ai_pilot_memory.memory_type='persona'. If a nick has
    // none, the conductor skill falls back to a default archetype based on
    // session age — so absence is fine, not an error.
    const { data: personaRows } = await supabase
      .from('ai_pilot_memory')
      .select('account_id, value')
      .in('account_id', accountIds)
      .eq('memory_type', 'persona')
    for (const p of personaRows || []) {
      if (p.account_id) signals.personas.set(p.account_id, p.value || null)
    }
  } catch {}

  return signals
}

// Mutates `context` in place with anti-detect fields the new skills consume.
function enrichContextWithAntiDetect(context, signals) {
  // Per-nick fields
  for (const n of context.nicks || []) {
    const ac = signals.actionCounts.get(n.id) || { last_1h: 0, last_24h: 0, last_7d: 0 }
    n.actions_last_1h = ac.last_1h
    n.actions_last_24h = ac.last_24h
    n.actions_last_7d = ac.last_7d
    n.recent_group_actions = signals.nickGroupRecency.get(n.id) || []
    n.persona = signals.personas.get(n.id) || null
    // Session age: use account.created_at if exposed; orchestrator currently
    // doesn't include it on the nick row, so skill falls back to "unknown".
  }

  // Per-group fields (map by our fb_group_id)
  for (const g of context.groups || []) {
    const ga = signals.groupActivity.get(g.fb_group_id)
    if (ga) {
      g.last_actor_nick_id = ga.last_actor_acc
      g.last_acted_minutes_ago = ga.last_minutes_ago === Infinity ? null : ga.last_minutes_ago
      g.active_nicks_last_hour = ga.active_nicks_last_hour.size
    } else {
      g.last_actor_nick_id = null
      g.last_acted_minutes_ago = null
      g.active_nicks_last_hour = 0
    }
  }

  // Machine block
  // 2026-04-26: default max=1 — strict serialization (1 nick / 1 phiên).
  // Tránh FB cluster detection: 2+ session cùng IP/device cùng lúc = signal mạnh.
  // Override qua env HERMES_MAX_CONCURRENT_NICKS khi có infra 1 proxy/nick.
  context.machine = {
    concurrent_active_now: signals.concurrentActiveCount,
    max_concurrent_safe: Number(process.env.HERMES_MAX_CONCURRENT_NICKS) || 1,
  }
}

// ─── KPI watcher phase: shortfall diagnosis + capability bump/nerf ─
// Runs as part of pre-pipeline AFTER autopilot — capability_nerf needs
// the latest checkpoint state which autopilot may have just acted on.
// Auto-applies bumps + nerfs (deterministic rules, hours of dedup) and
// logs shortfalls as informational rows for the orchestrator skill to
// consume via context.kpi_signals.
async function runKpiWatcherPhase(context, campaignId, orchestrationId, supabase) {
  const { computeKpiSignalsForCampaign } = require('./nick-kpi-watcher')
  const out = { shortfalls: 0, bumps_applied: 0, nerfs_applied: 0, deduped: 0 }

  let signals
  try {
    signals = await computeKpiSignalsForCampaign(supabase, campaignId)
  } catch (err) {
    console.warn(`[KPI-PHASE] compute failed: ${err.message}`)
    context.kpi_signals = { shortfalls: [], bumps: [], nerfs: [] }
    return out
  }

  // Helper: dedup against hermes_decisions for capability_bump (7d) and
  // capability_nerf (3d) to match the cron path's behavior. Without dedup
  // a 5-min cycle would re-emit the same bump every tick.
  const isDedup = async (decisionType, targetId, hours) => {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
    const { data: recent } = await supabase
      .from('hermes_decisions')
      .select('id')
      .eq('decision_type', decisionType)
      .eq('target_id', targetId)
      .gte('created_at', since)
      .limit(1)
    return (recent || []).length > 0
  }

  // 1. Capability bumps — 7d dedup
  for (const b of signals.bumps || []) {
    if (await isDedup('capability_bump', b.nick_id, 7 * 24)) { out.deduped++; continue }
    let outcome = 'pending', detail = null, appliedAt = null
    try {
      const r = await executeAction(b.action, campaignId, context, supabase)
      outcome = classifyOutcome(r)
      detail = r.detail
      appliedAt = new Date().toISOString()
      if (r.ok) out.bumps_applied++
    } catch (err) { outcome = 'failed'; detail = err.message }
    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'capability_bump',
      action_type: 'raise_kpi_target',
      target_id: b.nick_id,
      target_name: b.username,
      priority: b.action.priority,
      reason: b.action.reason,
      decision: { ...b.action, source: 'kpi_watcher' },
      auto_apply: true,
      auto_applied: outcome === 'success',
      applied_at: appliedAt,
      outcome,
      outcome_detail: detail,
    })
  }

  // 2. Capability nerfs — 3d dedup
  for (const n of signals.nerfs || []) {
    if (await isDedup('capability_nerf', n.nick_id, 3 * 24)) { out.deduped++; continue }
    let outcome = 'pending', detail = null, appliedAt = null
    try {
      const r = await executeAction(n.action, campaignId, context, supabase)
      outcome = classifyOutcome(r)
      detail = r.detail
      appliedAt = new Date().toISOString()
      if (r.ok) out.nerfs_applied++
    } catch (err) { outcome = 'failed'; detail = err.message }
    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'capability_nerf',
      action_type: 'lower_kpi_target',
      target_id: n.nick_id,
      target_name: n.username,
      priority: n.action.priority,
      reason: n.action.reason,
      decision: { ...n.action, source: 'kpi_watcher' },
      auto_apply: true,
      auto_applied: outcome === 'success',
      applied_at: appliedAt,
      outcome,
      outcome_detail: detail,
    })
  }

  // 3. Shortfalls — 2h dedup, log only (no execute, orchestrator skill decides)
  for (const s of signals.shortfalls || []) {
    if (await isDedup('kpi_shortfall', s.nick_id, 2)) { out.deduped++; continue }
    out.shortfalls++
    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'kpi_shortfall',
      action_type: 'investigate_nick_shortfall',
      target_id: s.nick_id,
      target_name: s.username,
      priority: s.action.priority,
      reason: s.action.reason,
      decision: s.action.action_detail,
      auto_apply: false,
      auto_applied: false,
      outcome: 'success',
      outcome_detail: `cause=${s.cause} | total=${s.total.done}/${s.total.target}`,
    })
  }

  // Inject signals for orchestrator skill to consider (especially shortfalls
  // — orchestrator may emit additional assign_job for behind-action nicks).
  context.kpi_signals = {
    shortfalls: signals.shortfalls.map(s => ({
      nick_id: s.nick_id,
      username: s.username,
      total: s.total,
      behind: s.by_action.filter(a => a.status === 'behind').map(a => ({
        action: a.action, label: a.label, done: a.done, target: a.target,
        gap: a.gap, shortfall_pct: a.shortfall_pct,
      })),
      cause: s.cause,
      severity: s.severity,
    })),
    capability_bumps_applied: out.bumps_applied,
    capability_nerfs_applied: out.nerfs_applied,
  }

  return out
}

// ─── Autopilot phase: deterministic rules (no LLM) ─────────
// Runs BEFORE the LLM sub-skills. The 6 autopilot rules cover safety actions
// that don't need judgment (nick checkpoint → alert, comment burst → pause,
// group pending timeout → skip). Reusing the same `evaluateNickRules` /
// `evaluateGroupRules` evaluators that the cron path uses → single source of
// rule logic. Results land in hermes_decisions with decision_type='autopilot'
// and are also exposed in context.autopilot_signals so the orchestrator skill
// can take them into account.
async function runAutopilotPhase(context, campaignId, orchestrationId, supabase) {
  const { evaluateNickRulesFromContext, evaluateGroupRules } = require('./nick-autopilot')
  const out = { actions: [], applied: 0, skipped: 0 }

  // 1. Evaluate
  const nickActions = evaluateNickRulesFromContext(context.nicks || [])
  const pendingGroups = (context.groups || []).filter(g => g.join_status === 'pending')
  const groupActions = evaluateGroupRules(pendingGroups)
  const allActions = [...nickActions, ...groupActions]

  // 2. 2-hour dedup against hermes_decisions (matches the cron path's behavior
  // — without this, every 5-min pre-pipeline tick would re-emit the same
  // pause_nick/skip_group decisions).
  const targetIds = allActions.map(a => a.target_id).filter(Boolean)
  const dedupSet = new Set()
  if (targetIds.length) {
    try {
      const since2h = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
      const { data: recent } = await supabase
        .from('hermes_decisions')
        .select('target_id, action_type')
        .in('target_id', targetIds)
        .gte('created_at', since2h)
      for (const r of recent || []) {
        dedupSet.add(`${r.target_id}|${r.action_type}`)
      }
    } catch (err) {
      console.warn(`[AUTOPILOT] dedup query failed: ${err.message}`)
    }
  }

  // 3. Apply (auto_apply=true via executeAction; auto_apply=false → log only)
  for (const action of allActions) {
    const dedupKey = `${action.target_id}|${action.type}`
    if (dedupSet.has(dedupKey)) {
      out.skipped++
      out.actions.push({ ...action, outcome: 'deduped' })
      continue
    }

    let outcome = 'pending', detail = null, appliedAt = null
    if (action.auto_apply) {
      try {
        const r = await executeAction(action, campaignId, context, supabase)
        outcome = classifyOutcome(r)
        detail = r.detail
        appliedAt = new Date().toISOString()
        if (r.ok) out.applied++
      } catch (err) {
        outcome = 'failed'; detail = err.message
      }
    }

    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'autopilot',
      action_type: action.type,
      target_id: action.target_id || null,
      target_name: action.target_name || null,
      priority: action.priority || null,
      reason: action.reason || null,
      decision: { ...action, source: 'autopilot' },
      auto_apply: !!action.auto_apply,
      auto_applied: action.auto_apply && outcome === 'success',
      applied_at: appliedAt,
      outcome,
      outcome_detail: detail,
    })

    out.actions.push({ ...action, outcome, outcome_detail: detail })
  }

  return out
}

// ─── Pre-orchestration anti-detection pipeline ─────────────
// Calls the 3 sub-skills in parallel. Each is best-effort:
//   - predictor failure → no proactive throttle, proceed
//   - conductor failure → orchestrator schedules without timing guidance
//   - spreader failure → orchestrator picks groups without graph guidance
// Predictor's actions are auto-applied IMMEDIATELY (before orchestrator runs)
// because they're risk-protective and shouldn't wait.
async function runPreOrchestrationPipeline(context, campaignId, orchestrationId, supabase) {
  const started = Date.now()
  const out = { predictions: null, schedule: null, allocations: null, predictor_actions_applied: 0, autopilot_applied: 0 }

  // ── PHASE 0: Autopilot deterministic rules (cheap, sync) ──
  // Runs first so the LLM skills below see post-autopilot state. e.g., if
  // autopilot already paused a nick for comment-burst, predictor won't waste
  // tokens proposing the same pause.
  let autopilotResult = { actions: [], applied: 0, skipped: 0 }
  try {
    autopilotResult = await runAutopilotPhase(context, campaignId, orchestrationId, supabase)
    out.autopilot_applied = autopilotResult.applied
    context.autopilot_signals = {
      actions_taken: autopilotResult.actions.filter(a => a.outcome === 'success'),
      actions_proposed: autopilotResult.actions.filter(a => !a.auto_apply),
      total_evaluated: autopilotResult.actions.length,
    }
  } catch (err) {
    console.warn(`[AUTOPILOT-PHASE] failed (proceeding without): ${err.message}`)
    context.autopilot_signals = { actions_taken: [], actions_proposed: [], total_evaluated: 0 }
  }

  // ── PHASE 0b: KPI watcher (deterministic, after autopilot) ──
  // Runs AFTER autopilot so capability_nerf can use post-autopilot pause
  // state (a nick paused by autopilot won't get a nerf — already protected).
  // Auto-applies bumps/nerfs (raise/lower_kpi_target) with 7d/3d dedup, logs
  // shortfalls as informational rows. Orchestrator skill reads context.kpi_signals.
  let kpiResult = { shortfalls: 0, bumps_applied: 0, nerfs_applied: 0, deduped: 0 }
  try {
    kpiResult = await runKpiWatcherPhase(context, campaignId, orchestrationId, supabase)
    out.kpi_bumps_applied = kpiResult.bumps_applied
    out.kpi_nerfs_applied = kpiResult.nerfs_applied
    out.kpi_shortfalls = kpiResult.shortfalls
  } catch (err) {
    console.warn(`[KPI-PHASE] failed (proceeding without): ${err.message}`)
    context.kpi_signals = { shortfalls: [], capability_bumps_applied: 0, capability_nerfs_applied: 0 }
  }

  // Build sub-context for each skill — pass only what they need to keep token cost low
  const predictorInput = {
    machine: context.machine,
    nicks: (context.nicks || []).map(n => ({
      id: n.id,
      username: n.username,
      status: n.status,
      session_age_days: n.session_age_days || null,
      recent_checkpoints_7d: n.checkpoint_risk?.recent_checkpoints_7d || 0,
      avg_comment_gap_seconds: n.checkpoint_risk?.avg_comment_gap_seconds ?? null,
      comment_sample_size: n.checkpoint_risk?.comment_sample_size || 0,
      actions_last_1h: n.actions_last_1h || 0,
      actions_last_24h: n.actions_last_24h || 0,
      actions_last_7d: n.actions_last_7d || 0,
      failed_jobs_24h: n.jobs_failed || 0,
      patterns: n.checkpoint_risk?.patterns || [],
      budget_caps: n.budget_caps || {},
    })),
  }

  const nowDate = new Date()
  // Build a kpi-shortfall lookup so conductor can tighten rest for behind nicks
  const kpiShortfallByNick = new Map()
  for (const s of context.kpi_signals?.shortfalls || []) {
    kpiShortfallByNick.set(s.nick_id, {
      total_pct: s.total?.pct ?? null,
      severity: s.severity,
      cause: s.cause,
    })
  }
  const conductorInput = {
    now_iso: nowDate.toISOString(),
    now_hour_local: nowDate.getUTCHours() + 7, // VN time approx
    max_concurrent: context.machine?.max_concurrent_safe || 1,
    currently_active_count: context.machine?.concurrent_active_now || 0,
    nicks: (context.nicks || []).map(n => ({
      id: n.id,
      username: n.username,
      is_active: n.is_active,
      status: n.status,
      active_job: n.active_job,
      is_resting: false, // computed by orchestrator's rest gate; conductor can re-derive from idle_minutes
      minutes_since_last_action: n.idle_minutes,
      actions_today: n.actions_last_24h || 0,
      daily_budget_remaining: Object.fromEntries(
        Object.entries(n.budget_caps || {}).map(([k, v]) => [k, Math.max(0, (v.max || 0) - (v.used || 0))])
      ),
      risk_score: null, // filled by predictor result later if available
      persona: n.persona,
      session_history_today: [],
      // KPI shortfall hint — conductor uses this to tighten rest_after_minutes
      // (90 phút thay vì 180-300) cho nick đang behind, để có thêm session/ngày.
      kpi_shortfall: kpiShortfallByNick.get(n.id) || null,
    })),
  }

  const spreaderInput = {
    now_iso: nowDate.toISOString(),
    min_gap_minutes_per_group: 45,
    min_gap_minutes_same_nick_same_group: 360,
    campaign_groups: (context.groups || [])
      .filter(g => g.join_status === 'member')
      .map(g => ({
        id: g.id,
        name: g.name,
        fb_group_id: g.fb_group_id,
        join_status: g.join_status,
        member_count: g.member_count,
        last_actor_nick_id: g.last_actor_nick_id,
        last_acted_minutes_ago: g.last_acted_minutes_ago,
        active_nicks_last_hour: g.active_nicks_last_hour,
        // Engagement performance — spreader uses to prioritize groups that
        // produce engageable content (high yields = many actionable posts).
        total_yields: g.total_yields,
        last_yield_at: g.last_yield_at,
        engagement_rate: g.engagement_rate,
        consecutive_skips: g.consecutive_skips,
      })),
    nicks_to_assign: (context.nicks || [])
      .filter(n => n.is_active && !n.active_job && n.status === 'healthy')
      .map(n => ({
        id: n.id,
        username: n.username,
        recent_group_actions: n.recent_group_actions || [],
      })),
  }

  // Fire all three in parallel
  const callSafe = async (task, input) => {
    try {
      const raw = await callHermes(task, JSON.stringify(input), 1500)
      return extractJson(raw)
    } catch (err) {
      console.warn(`[ANTI-DETECT] ${task} failed: ${err.message}`)
      return null
    }
  }

  const [predictorResult, conductorResult, spreaderResult] = await Promise.all([
    callSafe('checkpoint_predictor', predictorInput),
    callSafe('traffic_conductor', conductorInput),
    callSafe('social_graph_spreader', spreaderInput),
  ])

  // Auto-apply predictor's protective actions BEFORE orchestrator runs.
  // This way pause_nick / decrease_budget take effect first, and the orchestrator
  // sees the throttled state when it decides assign_job.
  if (predictorResult) {
    out.predictions = predictorResult.predictions || []
    const actions = predictorResult.actions || []
    for (const action of actions) {
      if (!action.auto_apply) continue
      let outcome = 'pending', detail = null, appliedAt = null
      try {
        const r = await executeAction(action, campaignId, context, supabase)
        outcome = classifyOutcome(r)
        detail = r.detail
        appliedAt = new Date().toISOString()
        if (r.ok) out.predictor_actions_applied++
      } catch (err) {
        outcome = 'failed'; detail = err.message
      }
      await supabase.from('hermes_decisions').insert({
        campaign_id: campaignId,
        orchestration_id: orchestrationId,
        decision_type: 'checkpoint_predictor',
        action_type: action.type,
        target_id: action.target_id || null,
        target_name: action.target_name || null,
        priority: action.priority || null,
        reason: action.reason || null,
        context_summary: predictorResult.summary || null,
        decision: action,
        auto_apply: true,
        auto_applied: outcome === 'success',
        applied_at: appliedAt,
        outcome,
        outcome_detail: detail,
      })
    }
    // Backfill risk_score onto context.nicks for downstream consumers
    for (const p of out.predictions || []) {
      const nick = (context.nicks || []).find(n => n.id === p.nick_id)
      if (nick) nick.risk_score = p.risk_score
    }
  }

  if (conductorResult) {
    out.schedule = conductorResult.schedule || []
    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'traffic_conductor',
      decision: conductorResult,
      auto_apply: false,
      auto_applied: false,
      outcome: 'success',
      context_summary: conductorResult.summary || null,
    })
  }

  if (spreaderResult) {
    out.allocations = spreaderResult.allocations || []
    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'social_graph_spreader',
      decision: spreaderResult,
      auto_apply: false,
      auto_applied: false,
      outcome: 'success',
      context_summary: spreaderResult.summary || null,
    })
  }

  console.log(`[ANTI-DETECT] campaign=${campaignId} autopilot=${out.autopilot_applied} kpi(b/n/s)=${out.kpi_bumps_applied || 0}/${out.kpi_nerfs_applied || 0}/${out.kpi_shortfalls || 0} predictor_actions=${out.predictor_actions_applied} schedule=${out.schedule?.length || 0} alloc=${out.allocations?.length || 0} (${Date.now() - started}ms)`)
  return out
}

// ─── Main orchestration run ────────────────────────────────
async function runOrchestration(campaignId, supabase) {
  const started = Date.now()
  const orchestrationId = randomUUID()
  const context = await buildOrchestrationContext(campaignId, supabase)

  // Anti-detect pipeline: enrich context, run 3 sub-skills, auto-apply predictor.
  // Toggleable via env var so we can disable quickly if a sub-skill misbehaves.
  if (process.env.HERMES_ANTIDETECT_DISABLED !== '1') {
    try {
      const accIds = (context.nicks || []).map(n => n.id)
      const signals = await buildAntiDetectSignals(accIds, supabase)
      enrichContextWithAntiDetect(context, signals)
      const preIntel = await runPreOrchestrationPipeline(context, campaignId, orchestrationId, supabase)
      // Inject pre-intel results so the orchestrator skill prompt can read
      // schedule + allocations when deciding assign_job timing/group.
      context.checkpoint_predictions = preIntel.predictions
      context.traffic_schedule = preIntel.schedule
      context.graph_allocations = preIntel.allocations
    } catch (err) {
      console.warn(`[ORCHESTRATOR] anti-detect pipeline failed (proceeding without): ${err.message}`)
    }
  }

  let result
  try {
    // 3000 tokens for orchestrator: deepseek-reasoner (R1) burns ~1500 tokens
    // on chain-of-thought before emitting JSON. With cap=1500 the JSON gets
    // truncated mid-output → extractJson fails. Bump to 3000 to leave room.
    const raw = await callHermes('orchestrator', JSON.stringify(context), 3000)
    result = extractJson(raw)
    if (!result) throw new Error('Hermes returned unparseable JSON')
  } catch (err) {
    console.error(`[ORCHESTRATOR] ${campaignId}: Hermes call failed — ${err.message}`)
    throw err
  }

  const actions = Array.isArray(result.actions) ? result.actions : []
  const executed = []
  for (const action of actions) {
    let outcome = 'pending'
    let detail = null
    let appliedAt = null
    if (action.auto_apply) {
      try {
        const r = await executeAction(action, campaignId, context, supabase)
        outcome = classifyOutcome(r)
        detail = r.detail
        appliedAt = new Date().toISOString()
      } catch (err) {
        outcome = 'failed'
        detail = err.message
      }
    }

    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'orchestration',
      action_type: action.type,
      target_id: action.target_id || null,
      target_name: action.target_name || null,
      priority: action.priority || null,
      reason: action.reason || null,
      context_summary: result.summary || null,
      decision: action,
      auto_apply: !!action.auto_apply,
      auto_applied: action.auto_apply && outcome === 'success',
      applied_at: appliedAt,
      outcome,
      outcome_detail: detail,
    })

    executed.push({ ...action, outcome, outcome_detail: detail })
  }

  // Also log the top-level summary row (decision_type=orchestration, action_type=null)
  await supabase.from('hermes_decisions').insert({
    campaign_id: campaignId,
    orchestration_id: orchestrationId,
    decision_type: 'orchestration_summary',
    decision: {
      summary: result.summary,
      health_score: result.health_score,
      issues: result.issues,
      next_review_minutes: result.next_review_minutes,
      total_actions: actions.length,
      elapsed_ms: Date.now() - started,
    },
    auto_apply: false,
    auto_applied: false,
    outcome: 'success',
  })

  console.log(`[ORCHESTRATOR] campaign=${campaignId} health=${result.health_score} actions=${actions.length} auto=${executed.filter(a => a.auto_apply && a.outcome === 'success').length} (${Date.now() - started}ms)`)

  return {
    orchestration_id: orchestrationId,
    summary: result.summary,
    health_score: result.health_score,
    issues: result.issues || [],
    actions: executed,
    next_review_minutes: result.next_review_minutes,
    context_nicks: context.nicks.length,
    context_groups: context.groups.length,
  }
}

async function runAllRunningCampaigns(supabase) {
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name')
    .eq('is_active', true)
  if (!campaigns?.length) return { ran: 0 }

  let ran = 0
  for (const c of campaigns) {
    try {
      await runOrchestration(c.id, supabase)
      ran++
    } catch (err) {
      console.error(`[ORCHESTRATOR] Failed for ${c.name || c.id}: ${err.message}`)
    }
  }
  return { ran, total: campaigns.length }
}

// ─── Reporter ──────────────────────────────────────────────
async function generateReport(campaignId, supabase) {
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, name')
    .eq('id', campaignId)
    .single()
  if (!campaign) throw new Error('Campaign not found')

  const since = new Date(Date.now() - 7 * 86400000).toISOString()
  const { data: logs } = await supabase
    .from('campaign_activity_log')
    .select('action_type, account_id')
    .eq('campaign_id', campaignId)
    .gte('created_at', since)

  const stats = { comments: 0, posts: 0, friend_requests: 0, interactions: 0 }
  const perNick = new Map()
  for (const row of logs || []) {
    const t = row.action_type
    if (t === 'comment') stats.comments++
    else if (t === 'post') stats.posts++
    else if (t === 'friend_request') stats.friend_requests++
    stats.interactions++
    if (row.account_id) {
      perNick.set(row.account_id, (perNick.get(row.account_id) || 0) + 1)
    }
  }

  const topNickIds = [...perNick.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
  const { data: topNickRows } = await supabase
    .from('accounts').select('id, username').in('id', topNickIds.length ? topNickIds : ['00000000-0000-0000-0000-000000000000'])

  const top_nicks = topNickIds.map(id => {
    const a = (topNickRows || []).find(r => r.id === id)
    return { username: a?.username || '?', jobs: perNick.get(id) || 0 }
  })

  const { count: checkpoints } = await supabase
    .from('job_failures')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('error_type', 'CHECKPOINT')
    .gte('created_at', since)

  const input = {
    campaign_name: campaign.name,
    stats_7d: { ...stats, checkpoints: checkpoints || 0 },
    top_nicks,
    top_groups: [],      // would need per-group engagement aggregation
    failed_reasons: [],
    memory_insights: [],
  }

  const raw = await callHermes('reporter', JSON.stringify(input), 1200)
  const report = extractJson(raw)
  if (!report) throw new Error('Reporter returned unparseable JSON')

  await supabase.from('hermes_decisions').insert({
    campaign_id: campaignId,
    decision_type: 'reporter',
    decision: report,
    context_summary: JSON.stringify(input),
    auto_apply: false,
    auto_applied: false,
    outcome: 'success',
  })
  return report
}

// ─── Daily Self-Review ─────────────────────────────────────
const HERMES_URL2 = process.env.HERMES_URL || 'http://127.0.0.1:8100'

async function hermesPut(path, body) {
  const res = await fetch(`${HERMES_URL2}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) }
}

async function fetchCurrentSkill(taskType) {
  try {
    const res = await fetch(`${HERMES_URL2}/skills/${encodeURIComponent(taskType)}`, {
      headers: { 'X-Agent-Key': AGENT_SECRET },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const j = await res.json()
    // Returns { task_type, content, file } or similar — the full md text
    return j.content || j.prompt || j.text || null
  } catch { return null }
}

async function buildReviewContext(supabase) {
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const dayStartIso = dayStart.toISOString()
  const dateStr = dayStart.toISOString().slice(0, 10)

  // Calls summary per task_type
  const { data: calls } = await supabase
    .from('hermes_calls')
    .select('task_type, latency_ms, ok')
    .gte('created_at', dayStartIso)

  const callsMap = new Map()
  for (const c of calls || []) {
    const e = callsMap.get(c.task_type) || { count: 0, latency_sum: 0, errors: 0 }
    e.count++
    e.latency_sum += c.latency_ms || 0
    if (!c.ok) e.errors++
    callsMap.set(c.task_type, e)
  }
  const calls_summary = [...callsMap.entries()].map(([task_type, e]) => ({
    task_type,
    count: e.count,
    avg_latency_ms: Math.round(e.latency_sum / e.count),
    error_rate: +(e.errors / e.count).toFixed(3),
  }))

  // Feedback per task_type (stats)
  const { data: feedback } = await supabase
    .from('hermes_feedback')
    .select('id, task_type, score, reason, output_text, prompt')
    .gte('created_at', dayStartIso)

  const fbMap = new Map()
  for (const f of feedback || []) {
    const e = fbMap.get(f.task_type) || { count: 0, sum: 0, dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }
    e.count++
    e.sum += f.score
    if (e.dist[f.score] !== undefined) e.dist[f.score]++
    fbMap.set(f.task_type, e)
  }
  const feedback_by_skill = [...fbMap.entries()].map(([task_type, e]) => ({
    task_type,
    count: e.count,
    avg_score: +(e.sum / e.count).toFixed(2),
    score_dist: e.dist,
  }))

  // Low-score samples (<=2) for rewrite context + purge candidates
  const low_score_samples = (feedback || [])
    .filter(f => f.score <= 2)
    .slice(0, 30)
    .map(f => ({
      id: f.id,
      task_type: f.task_type,
      score: f.score,
      reason: f.reason,
      output: (f.output_text || '').slice(0, 300),
      prompt_preview: (f.prompt || '').slice(0, 200),
    }))

  // Jobs today
  const { data: todayJobs } = await supabase
    .from('jobs')
    .select('status, error_message')
    .gte('created_at', dayStartIso)
    .in('status', ['done', 'failed'])
  const jobs_stats = { done: 0, failed: 0, errors: {} }
  for (const j of todayJobs || []) {
    if (j.status === 'done') jobs_stats.done++
    else if (j.status === 'failed') {
      jobs_stats.failed++
      const tag = (j.error_message || 'UNKNOWN').split(':')[0].trim().slice(0, 40)
      jobs_stats.errors[tag] = (jobs_stats.errors[tag] || 0) + 1
    }
  }
  const total = jobs_stats.done + jobs_stats.failed
  const success_rate = total > 0 ? +(jobs_stats.done / total).toFixed(3) : null
  const top_error = Object.entries(jobs_stats.errors).sort((a, b) => b[1] - a[1])[0]?.[0] || null

  // Comment rejection — proxy via campaign_activity_log action_type='comment' vs log of rejections
  const { count: commentsPosted } = await supabase
    .from('campaign_activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('action_type', 'comment')
    .gte('created_at', dayStartIso)
  const { count: commentsRejected } = await supabase
    .from('campaign_activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('action_type', 'comment_rejected')
    .gte('created_at', dayStartIso)
  const postedN = commentsPosted || 0
  const rejectedN = commentsRejected || 0
  const comment_rejection = {
    posted: postedN,
    rejected_by_fb: rejectedN,
    rejection_rate: postedN + rejectedN > 0 ? +(rejectedN / (postedN + rejectedN)).toFixed(3) : 0,
  }

  // Fetch current skill prompts for any skill with avg_score < 3.5 (so Hermes can rewrite them)
  const low_skills = feedback_by_skill.filter(s => s.avg_score < 3.5).map(s => s.task_type)
  const current_skill_prompts = {}
  for (const t of low_skills.slice(0, 5)) {
    const content = await fetchCurrentSkill(t)
    if (content) current_skill_prompts[t] = content
  }

  // Recent checkpoint patterns — so self_reviewer can correlate skill/budget
  // recommendations with what actually killed nicks lately.
  let checkpoint_patterns = []
  try {
    const since7d = new Date(Date.now() - 7 * 86400000).toISOString()
    const { data: patterns } = await supabase
      .from('ai_pilot_memory')
      .select('key, value, evidence_count, last_updated_at, account_id')
      .eq('memory_type', 'checkpoint_pattern')
      .gte('last_updated_at', since7d)
      .order('evidence_count', { ascending: false })
      .limit(20)
    checkpoint_patterns = (patterns || []).map(p => ({
      pattern: p.key,
      occurrences: p.evidence_count || 1,
      primary_cause: p.value?.primary_cause,
      summary: p.value?.summary,
      recommendations: p.value?.recommendations,
    }))
  } catch {}

  return {
    date: dateStr,
    calls_summary,
    feedback_by_skill,
    low_score_samples,
    jobs_stats: { ...jobs_stats, success_rate, top_error },
    comment_rejection,
    current_skill_prompts,
    checkpoint_patterns,
  }
}

async function applyReviewRecommendations(review, supabase) {
  const applied = {
    skills_rewritten: [],
    skills_rewrite_failed: [],
    feedback_purged: 0,
    quality_gate_updated: null,
  }

  // 1. Rewrite skills with provided new_prompt
  for (const s of review.skills_to_rewrite || []) {
    if (!s.task_type || !s.new_prompt) continue
    try {
      const r = await hermesPut(`/skills/${encodeURIComponent(s.task_type)}`, { content: s.new_prompt })
      if (r.ok) applied.skills_rewritten.push({ task_type: s.task_type, reason: s.reason })
      else applied.skills_rewrite_failed.push({ task_type: s.task_type, status: r.status })
    } catch (err) {
      applied.skills_rewrite_failed.push({ task_type: s.task_type, error: err.message })
    }
  }

  // 2. Purge low-score feedback rows (direct SQL — Hermes DELETE /feedback is all-or-nothing)
  const ids = (review.feedback_to_purge || []).map(f => f.id).filter(n => Number.isInteger(n))
  if (ids.length > 0) {
    const { error, count } = await supabase
      .from('hermes_feedback')
      .delete({ count: 'exact' })
      .in('id', ids)
    if (!error) applied.feedback_purged = count || 0
  }

  // 3. Quality gate threshold — persist to hermes_config table if present, else record only
  if (review.adjust_quality_gate?.new_threshold != null) {
    applied.quality_gate_updated = {
      new_threshold: review.adjust_quality_gate.new_threshold,
      reason: review.adjust_quality_gate.reason,
    }
    // Best-effort: upsert into hermes_config
    try {
      await supabase.from('hermes_config').upsert(
        { key: 'quality_gate_threshold', value: String(review.adjust_quality_gate.new_threshold) },
        { onConflict: 'key' }
      )
    } catch {}
  }

  // 4. Ask Hermes to hot-reload so rewritten skills take effect immediately
  if (applied.skills_rewritten.length > 0) {
    try {
      await fetch(`${HERMES_URL2}/skills/reload`, {
        method: 'POST',
        headers: { 'X-Agent-Key': AGENT_SECRET },
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
  }

  return applied
}

async function runDailyReview(supabase) {
  const started = Date.now()
  const orchestrationId = randomUUID()
  const context = await buildReviewContext(supabase)

  const raw = await callHermes('self_reviewer', JSON.stringify(context), 2500)
  const review = extractJson(raw)
  if (!review) throw new Error('self_reviewer returned unparseable JSON')

  const applied = await applyReviewRecommendations(review, supabase)

  // Log to hermes_decisions (campaign_id NULL since this is system-wide)
  await supabase.from('hermes_decisions').insert({
    campaign_id: null,
    orchestration_id: orchestrationId,
    decision_type: 'self_improvement',
    action_type: 'daily_review',
    context_summary: review.summary || null,
    decision: {
      date: context.date,
      review,
      applied,
      elapsed_ms: Date.now() - started,
    },
    auto_apply: true,
    auto_applied: applied.skills_rewritten.length > 0 || applied.feedback_purged > 0 || applied.quality_gate_updated !== null,
    applied_at: new Date().toISOString(),
    outcome: 'success',
    outcome_detail: review.learning_log_entry || null,
  })

  console.log(`[SELF-REVIEW] date=${context.date} rewrote=${applied.skills_rewritten.length} purged=${applied.feedback_purged} qgate=${applied.quality_gate_updated ? 'adj' : 'keep'} (${Date.now() - started}ms)`)

  return {
    orchestration_id: orchestrationId,
    date: context.date,
    summary: review.summary,
    skills_rewritten: applied.skills_rewritten,
    skills_rewrite_failed: applied.skills_rewrite_failed,
    feedback_purged: applied.feedback_purged,
    quality_gate_updated: applied.quality_gate_updated,
    learning_log_entry: review.learning_log_entry,
    insights: review.insights || [],
    checkpoint_patterns_applied: review.checkpoint_patterns_applied || [],
  }
}

// ─── KPI Coordinator ──────────────────────────────────────────
// Gọi skill `kpi_coordinator` để Hermes tự nghĩ cách phân bổ KPI gap cho nicks
// chất lượng khác nhau. Output lưu vào hermes_decisions; runOrchestration đọc
// recommendation gần nhất và inject vào context như signal — không tự apply
// trực tiếp để tránh chồng chéo với traffic_conductor / spreader.

async function buildKpiCoordinatorContext(campaignId, supabase) {
  const { data: campaign } = await supabase.from('campaigns')
    .select('id, name, topic, start_at, kpi_config')
    .eq('id', campaignId).single()
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

  const startedDays = campaign.start_at
    ? Math.floor((Date.now() - new Date(campaign.start_at).getTime()) / 86400000) : 0

  const nowVn = new Date(Date.now() + 7 * 3600000)
  const hourVn = nowVn.getUTCHours()
  const todayVn = nowVn.toISOString().split('T')[0]
  const minutesUntilCutoff = Math.max(0, (23 - hourVn) * 60 - nowVn.getUTCMinutes())

  // KPI today + 3-day trend — aggregated from nick_kpi_daily (per-nick rows)
  // Targets come from campaigns.kpi_config (daily_X) which kpi-calculator splits
  // across nicks during nightly rebalance. We sum done_X back up to campaign level.
  const kpiConfig = campaign.kpi_config || {}
  const kpi = {}
  const metrics = ['comment', 'like', 'friend_request', 'group_join']
  const DONE_FIELD = { comment: 'done_comments', like: 'done_likes', friend_request: 'done_friend_requests', group_join: 'done_group_joins' }
  const TARGET_FIELD = { comment: 'target_comments', like: 'target_likes', friend_request: 'target_friend_requests', group_join: 'target_group_joins' }
  const CONFIG_FIELD = { comment: 'daily_comments', like: 'daily_likes', friend_request: 'daily_friend_requests', group_join: 'daily_group_joins' }

  const since4d = new Date(Date.now() - 4 * 86400000).toISOString().split('T')[0]
  const { data: progress } = await supabase.from('nick_kpi_daily')
    .select('date, target_likes, target_comments, target_friend_requests, target_group_joins, done_likes, done_comments, done_friend_requests, done_group_joins')
    .eq('campaign_id', campaignId).gte('date', since4d).order('date', { ascending: true })

  for (const m of metrics) {
    // Prefer summed targets from nick_kpi_daily (post-rebalance, accurate per nick).
    // Fall back to raw kpi_config if nick rows haven't been seeded yet today.
    const todayRows = (progress || []).filter(p => p.date === todayVn)
    const summedTarget = todayRows.reduce((s, p) => s + (p[TARGET_FIELD[m]] || 0), 0)
    const target = summedTarget > 0 ? summedTarget : (kpiConfig[CONFIG_FIELD[m]] || 0)
    const actualToday = todayRows.reduce((s, p) => s + (p[DONE_FIELD[m]] || 0), 0)
    const byDay = {}
    for (const row of (progress || [])) {
      byDay[row.date] = (byDay[row.date] || 0) + (row[DONE_FIELD[m]] || 0)
    }
    const trend = Object.keys(byDay).sort().slice(-3).map(d => byDay[d])
    kpi[m] = { target, actual: actualToday, trend_3day_actual: trend }
  }

  // Comment rejection (comment_rejected events today)
  const dayStart = todayVn + 'T00:00:00+07:00'
  const { count: rejected } = await supabase.from('campaign_activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId).eq('action_type', 'comment_rejected').gte('created_at', dayStart)
  kpi.comment.rejected_by_fb = rejected || 0

  // Nicks
  const { data: roles } = await supabase.from('campaign_roles')
    .select('account_ids').eq('campaign_id', campaignId)
  const accountIds = new Set()
  for (const r of roles || []) (r.account_ids || []).forEach(id => accountIds.add(id))
  if (accountIds.size === 0) {
    const { data: c } = await supabase.from('campaigns').select('account_ids').eq('id', campaignId).single()
    for (const id of c?.account_ids || []) accountIds.add(id)
  }
  if (!accountIds.size) return { campaign: { id: campaignId, name: campaign.name, started_days_ago: startedDays }, kpi, nicks: [], now_iso: new Date().toISOString(), now_hour_vn: hourVn, minutes_until_cutoff: minutesUntilCutoff }

  const { data: accounts } = await supabase.from('accounts')
    .select('id, username, status, is_active, last_used_at, daily_budget, created_at, notes')
    .in('id', [...accountIds])

  // Per-nick history 30d aggregates
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString()
  const { data: hist } = await supabase.from('campaign_activity_log')
    .select('account_id, action_type, result_status, details, created_at')
    .in('account_id', [...accountIds]).gte('created_at', since30)

  // Normalize created_at to ISO string once (pg client returns Date objects,
  // supabase-js returns strings — handle both).
  const histByNick = new Map()
  const dayStartMs = new Date(dayStart).getTime()
  for (const r of hist || []) {
    const ts = r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime()
    r._ts = ts
    r._dateKey = new Date(ts).toISOString().slice(0, 10)
    const arr = histByNick.get(r.account_id) || []
    arr.push(r); histByNick.set(r.account_id, arr)
  }

  const nicks = (accounts || []).map(a => {
    const ageDays = a.created_at ? Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000) : 0
    const minSinceLast = a.last_used_at ? Math.floor((Date.now() - new Date(a.last_used_at).getTime()) / 60000) : null
    const todayActions = (histByNick.get(a.id) || []).filter(r => r._ts >= dayStartMs)
    const byType = {}
    for (const r of todayActions) byType[r.action_type] = (byType[r.action_type] || 0) + 1
    const budget = a.daily_budget || {}
    const remaining = {}
    for (const k of ['comment', 'like', 'friend_request', 'join_group']) {
      const b = budget[k] || { used: 0, max: 0 }
      remaining[k] = Math.max(0, (b.max || 0) - (b.used || 0))
    }
    // 30d aggregates
    const all = histByNick.get(a.id) || []
    const days = new Set(all.map(r => r._dateKey))
    const avgPerDay = days.size > 0 ? Math.round(all.length / days.size) : 0
    const checkpointCount = all.filter(r => (r.details?.error || '').toLowerCase().includes('checkpoint')).length
    const commentRejected = all.filter(r => r.action_type === 'comment_rejected').length
    const commentTotal = all.filter(r => r.action_type === 'comment').length
    const rejectionRate = commentTotal + commentRejected > 0 ? +(commentRejected / (commentTotal + commentRejected)).toFixed(2) : 0
    const engChecks = all.filter(r => r.action_type === 'comment_engagement_check')
    const engScores = engChecks.map(r => r.details?.score).filter(s => typeof s === 'number')
    const avgEngagement = engScores.length > 0 ? +(engScores.reduce((a, b) => a + b, 0) / engScores.length).toFixed(2) : null

    return {
      id: a.id, username: a.username,
      age_days: ageDays,
      status: a.status, is_active: a.is_active,
      minutes_since_last_action: minSinceLast,
      today: { actions_done: todayActions.length, by_type: byType, budget_remaining: remaining },
      history_30d: {
        avg_actions_per_day: avgPerDay,
        checkpoint_count: checkpointCount,
        comment_avg_engagement_score: avgEngagement,
        comment_rejection_rate: rejectionRate,
        kpi_contribution_pct: null, // optional — orchestrator can compute
      },
    }
  })

  return {
    now_iso: new Date().toISOString(),
    now_hour_vn: hourVn,
    minutes_until_cutoff: minutesUntilCutoff,
    campaign: { id: campaign.id, name: campaign.name, topic: campaign.topic, started_days_ago: startedDays, kpi_window: 'daily' },
    kpi, nicks,
  }
}

async function runKpiCoordinator(campaignId, supabase) {
  const started = Date.now()
  const orchestrationId = randomUUID()
  const context = await buildKpiCoordinatorContext(campaignId, supabase)
  if (!context.nicks.length) {
    console.log(`[KPI-COORD] ${campaignId}: no nicks, skip`)
    return { orchestration_id: orchestrationId, skipped: true }
  }

  let decision
  try {
    const raw = await callHermes('kpi_coordinator', JSON.stringify(context), 2000)
    decision = extractJson(raw)
  } catch (err) {
    console.error(`[KPI-COORD] ${campaignId}: skill call failed: ${err.message}`)
    return { orchestration_id: orchestrationId, error: err.message }
  }
  if (!decision) {
    console.warn(`[KPI-COORD] ${campaignId}: unparseable JSON`)
    return { orchestration_id: orchestrationId, error: 'unparseable_json' }
  }

  // Persist for orchestrator to pick up next cycle
  try {
    await supabase.from('hermes_decisions').insert({
      campaign_id: campaignId,
      orchestration_id: orchestrationId,
      decision_type: 'kpi_coordination',
      action_type: 'kpi_allocate',
      context_summary: decision.summary || null,
      decision: { ...decision, _context_kpi: context.kpi, elapsed_ms: Date.now() - started },
      auto_apply: false,
      auto_applied: false,
      outcome: 'pending',
    })
  } catch (insErr) {
    console.warn(`[KPI-COORD] persist hermes_decisions failed: ${insErr.message}`)
  }

  const alerts = (decision.alerts || []).length
  const allocs = (decision.allocations || []).length
  console.log(`[KPI-COORD] ${campaignId}: ${allocs} allocations, ${alerts} alerts (${Date.now() - started}ms)`)

  return { orchestration_id: orchestrationId, decision, elapsed_ms: Date.now() - started }
}

async function runKpiCoordinatorAllRunning(supabase) {
  const { data: campaigns } = await supabase.from('campaigns')
    .select('id, name').eq('status', 'running').eq('is_active', true)
  let ok = 0, fail = 0
  for (const c of campaigns || []) {
    try { await runKpiCoordinator(c.id, supabase); ok++ }
    catch (err) { fail++; console.error(`[KPI-COORD] ${c.name || c.id}: ${err.message}`) }
  }
  console.log(`[KPI-COORD] cycle done: ${ok} ok, ${fail} failed`)
}

module.exports = {
  buildOrchestrationContext,
  runOrchestration,
  runAllRunningCampaigns,
  generateReport,
  executeAction,  // exported for tests
  buildReviewContext,
  runDailyReview,
  applyReviewRecommendations,
  // Anti-detect pipeline (exported for tests + ad-hoc invocation)
  buildAntiDetectSignals,
  enrichContextWithAntiDetect,
  runPreOrchestrationPipeline,
  runAutopilotPhase,
  runKpiWatcherPhase,
  // KPI coordinator
  buildKpiCoordinatorContext,
  runKpiCoordinator,
  runKpiCoordinatorAllRunning,
}
