const cron = require('node-cron')
const { supabase } = require('../lib/supabase')
const { getBusyNicks, getNickPendingCounts, MAX_PENDING_PER_NICK } = require('../lib/nick-lock')

// Age-based max sessions per day
function getMaxSessions(ageDays, profileTarget) {
  if (ageDays <= 7) return 1
  if (ageDays <= 14) return 2
  if (ageDays <= 21) return 3
  return profileTarget
}

// Random jitter ±minutes
function jitter(minutes) {
  return Math.floor(Math.random() * minutes * 2) - minutes
}

/**
 * Auto-create nurture profiles for active accounts that don't have one yet.
 * This ensures nurture is the BASELINE — every nick gets nurtured by default.
 * Runs once per scheduler cycle (every 2 min).
 */
async function autoCreateProfiles() {
  try {
    // Get all active accounts
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, owner_id, status, is_active')
      .eq('is_active', true)
      .not('status', 'in', '("checkpoint","expired","disabled")')

    if (!accounts?.length) return

    // Get existing nurture profiles
    const { data: existing } = await supabase
      .from('nurture_profiles')
      .select('account_id')

    const hasProfile = new Set((existing || []).map(p => p.account_id))

    // Create profiles for accounts that don't have one
    const toCreate = accounts.filter(a => !hasProfile.has(a.id))
    if (!toCreate.length) return

    const inserts = toCreate.map(a => ({
      owner_id: a.owner_id,
      account_id: a.id,
      enabled: true,
      persona: 'friendly',
      daily_feed_scrolls: 2,        // 2 sessions/ngày — nhẹ nhàng
      daily_reacts: 5,              // 5 likes/ngày — rất an toàn
      daily_comments: 1,            // 1 comment/ngày — rất chọn lọc
      daily_story_views: 2,         // 2 stories/ngày
      min_session_gap_minutes: 180, // 3 giờ giữa mỗi session
    }))

    const { error } = await supabase.from('nurture_profiles').insert(inserts)
    if (!error) {
      console.log(`[NURTURE] Auto-created ${inserts.length} nurture profiles for new accounts`)
    }
  } catch (err) {
    console.error('[NURTURE] Auto-create error:', err.message)
  }
}

async function processNurtureProfiles() {
  const now = new Date()
  const currentHour = now.getHours()
  const currentDay = now.getDay()
  const todayStr = now.toISOString().split('T')[0]

  try {
    // Auto-create profiles for accounts without one
    await autoCreateProfiles()

    // Fetch all enabled profiles with account info
    const { data: profiles, error } = await supabase
      .from('nurture_profiles')
      .select(`
        *,
        accounts!inner(id, status, is_active, created_at)
      `)
      .eq('enabled', true)

    if (error || !profiles?.length) return

    // Batch check which nicks are already busy (campaign or nurture jobs)
    const allAccountIds = profiles.map(p => p.accounts.id)
    const busyNicks = await getBusyNicks(allAccountIds)
    const pendingCounts = await getNickPendingCounts(allAccountIds)

    // If any running campaign has hermes_central=true and this nick is in it,
    // the orchestrator owns nurture pacing — don't let the blind 5-min cron
    // race the Hermes tick. Build a Set of nicks under orchestrator control.
    const { data: centralCampaigns } = await supabase
      .from('campaigns')
      .select('account_ids')
      .eq('hermes_central', true)
      .eq('status', 'running')
    const centralNicks = new Set()
    for (const c of centralCampaigns || []) {
      for (const id of c.account_ids || []) centralNicks.add(id)
    }

    for (const profile of profiles) {
      try {
        const acc = profile.accounts

        // 0. Nick lock: skip if nick has ANY active job (campaign or nurture)
        if (busyNicks.has(acc.id)) {
          continue
        }

        // If this nick is under Hermes-central pacing, let the orchestrator
        // decide. Skip silently — the 15-min orchestrator tick will queue
        // nurture via assign_job when it deems the nick ready.
        if (centralNicks.has(acc.id)) {
          continue
        }

        // Global cap: stop queueing once the nick already has the max
        // across all campaigns + types. Agent only pulls 1 at a time, no
        // point stacking more.
        const pending = pendingCounts.get(acc.id) || 0
        if (pending >= MAX_PENDING_PER_NICK) {
          continue
        }

        // 1. Account must be active and healthy
        if (!acc.is_active) continue
        if (['checkpoint', 'expired', 'disabled'].includes(acc.status)) continue

        // 2. Health score check
        if (profile.health_score <= 0) continue

        // 3. Active days check
        if (!profile.active_days?.includes(currentDay)) continue

        // 4. Active hours check
        const hours = profile.active_hours || { start: 7, end: 23 }
        if (currentHour < hours.start || currentHour >= hours.end) continue

        // 5. Reset daily counters if needed
        if (profile.budget_reset_date !== todayStr) {
          // Check streak: was last session yesterday?
          const yesterday = new Date(now - 86400000).toISOString().split('T')[0]
          const lastSessionDate = profile.last_session_at
            ? new Date(profile.last_session_at).toISOString().split('T')[0]
            : null
          const newStreak = lastSessionDate === yesterday ? (profile.streak_days || 0) + 1 : 0

          await supabase.from('nurture_profiles').update({
            today_reacts: 0,
            today_comments: 0,
            today_stories: 0,
            today_sessions: 0,
            budget_reset_date: todayStr,
            streak_days: newStreak,
            updated_at: now.toISOString(),
          }).eq('id', profile.id)

          // Use reset values for this cycle
          profile.today_reacts = 0
          profile.today_comments = 0
          profile.today_stories = 0
          profile.today_sessions = 0
        }

        // 6. Check daily targets — skip if all met
        const ageDays = Math.floor((Date.now() - new Date(acc.created_at).getTime()) / 86400000)
        const maxSessions = getMaxSessions(ageDays, profile.daily_feed_scrolls)

        if (
          profile.today_sessions >= maxSessions &&
          profile.today_reacts >= profile.daily_reacts &&
          profile.today_comments >= profile.daily_comments
        ) continue

        // 7. Session gap check with jitter — MINIMUM 90 phút giữa sessions
        if (profile.last_session_at) {
          const elapsed = (now - new Date(profile.last_session_at)) / 60000 // minutes
          const baseGap = Math.max(profile.min_session_gap_minutes, 90) // enforce minimum 90 phút
          const effectiveGap = baseGap + jitter(20) // ±20min jitter
          if (elapsed < Math.max(effectiveGap, 90)) continue // hard minimum 90 phút
        }

        // 8. Create nurture_feed job — spread scheduled_at evenly across active hours
        //    (avoids dumping all day's quota as "do it NOW" which then starves
        //    other nicks because agent picks oldest-first).
        //    Gap = (active_window_hours * 60) / daily_quota, then stagger
        //    behind any already-pending nurture_feed for the same nick.
        const { checkAndReserve, getDefaultQuota } = require('./nick-quota')
        const nfQuota = await checkAndReserve(supabase, { accountId: acc.id, jobType: 'nurture_feed' })
        if (!nfQuota.ok) {
          console.log(`[NURTURE-SCHED] nick ${acc.id.slice(0,8)} nurture_feed quota full (${nfQuota.count}/${nfQuota.quota}) — skip`)
          continue
        }

        const dailyQuota = getDefaultQuota('nurture_feed') || 4
        const gapMinutes = Math.floor((12 * 60) / dailyQuota) // 12h window / quota
        let pendingAhead = 0
        try {
          const pool = supabase._pool
          if (pool) {
            const { rows: cRows } = await pool.query(
              `SELECT COUNT(*)::int AS c FROM jobs WHERE status='pending' AND type='nurture_feed' AND payload->>'account_id'=$1`,
              [acc.id]
            )
            pendingAhead = cRows?.[0]?.c || 0
          }
        } catch { /* count is best-effort */ }

        const jitterSec = Math.floor(Math.random() * 240) + 60 // 1-5 min
        const spacedSec = pendingAhead * gapMinutes * 60
        const scheduledAt = new Date(now.getTime() + (spacedSec + jitterSec) * 1000).toISOString()

        const remainReacts = Math.max(0, profile.daily_reacts - (profile.today_reacts || 0))
        const remainComments = Math.max(0, profile.daily_comments - (profile.today_comments || 0))
        const remainStories = Math.max(0, profile.daily_story_views - (profile.today_stories || 0))

        await supabase.from('jobs').insert({
          type: 'nurture_feed',
          priority: 3, // HIGH — main work
          payload: {
            account_id: acc.id,
            nurture_profile_id: profile.id,
            owner_id: profile.owner_id,
            persona: profile.persona,
            daily_reacts: profile.daily_reacts,
            daily_comments: profile.daily_comments,
            daily_story_views: profile.daily_story_views,
            today_reacts: profile.today_reacts || 0,
            today_comments: profile.today_comments || 0,
            today_stories: profile.today_stories || 0,
            remain_reacts: remainReacts,
            remain_comments: remainComments,
            remain_stories: remainStories,
            age_days: ageDays,
          },
          status: 'pending',
          scheduled_at: scheduledAt,
          created_by: profile.owner_id,
        })
        pendingCounts.set(acc.id, (pendingCounts.get(acc.id) || 0) + 1)

        // Update last_session_at immediately to prevent double-scheduling
        await supabase.from('nurture_profiles').update({
          last_session_at: now.toISOString(),
        }).eq('id', profile.id)

        console.log(`[NURTURE] Scheduled nurture_feed for ${acc.id} (age: ${ageDays}d, sessions: ${profile.today_sessions}/${maxSessions})`)

      } catch (err) {
        console.error(`[NURTURE] Error processing profile ${profile.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[NURTURE] Scheduler error:', err.message)
  }
}

// ============================================
// GROUP MONITOR SCHEDULING
// ============================================

async function scheduleGroupMonitors() {
  try {
    const now = new Date()

    // Fetch monitored groups that need scanning
    const { data: groups, error } = await supabase
      .from('monitored_groups')
      .select('*, accounts!inner(id, status, is_active)')
      .eq('is_active', true)

    if (error || !groups?.length) return

    // Filter: needs scan (null or past due)
    const needsScan = groups.filter(g => {
      if (!g.last_scanned_at) return true
      const elapsed = (now - new Date(g.last_scanned_at)) / 60000
      return elapsed >= (g.scan_interval_minutes || 120)
    })

    if (!needsScan.length) return

    // Check agent online
    const { data: agents } = await supabase.from('agent_heartbeats').select('agent_id')
      .gte('last_seen', new Date(Date.now() - 120000).toISOString()).limit(1)
    if (!agents?.length) return

    // Batch check busy nicks
    const accountIds = [...new Set(needsScan.map(g => g.account_id).filter(Boolean))]
    const busyNicks = await getBusyNicks(accountIds)

    for (const group of needsScan) {
      try {
        const acc = group.accounts
        if (!acc.is_active || ['checkpoint', 'expired', 'disabled'].includes(acc.status)) continue
        if (busyNicks.has(acc.id)) continue

        // Check no duplicate job pending
        const { count } = await supabase
          .from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'campaign_group_monitor')
          .in('status', ['pending', 'claimed', 'running'])
          .filter('payload->>monitored_group_id', 'eq', group.id)

        if (count > 0) continue

        // Create monitor job with jitter
        const scheduleDelay = Math.floor(Math.random() * 180) + 30 // 30s-3.5min
        const scheduledAt = new Date(now.getTime() + scheduleDelay * 1000).toISOString()

        const { checkAndReserve: reserveMon } = require('./nick-quota')
        const monQuota = await reserveMon(supabase, { accountId: acc.id, jobType: 'campaign_group_monitor' })
        if (!monQuota.ok) continue

        await supabase.from('jobs').insert({
          type: 'campaign_group_monitor',
          priority: 5, // NORMAL
          payload: {
            monitored_group_id: group.id,
            account_id: acc.id,
            campaign_id: group.campaign_id,
            owner_id: group.owner_id,
            group_fb_id: group.group_fb_id,
            group_name: group.group_name,
            group_url: group.group_url,
            brand_keywords: group.brand_keywords,
            brand_name: group.brand_name,
            brand_voice: group.brand_voice,
            opportunity_threshold: group.opportunity_threshold || 7,
            scan_lookback_minutes: group.scan_lookback_minutes || 180,
          },
          status: 'pending',
          scheduled_at: scheduledAt,
          created_by: group.owner_id,
        })

        // Update last_scanned_at immediately to prevent double-scheduling
        await supabase.from('monitored_groups').update({
          last_scanned_at: now.toISOString(),
        }).eq('id', group.id)

        console.log(`[GROUP-MONITOR] Scheduled scan for "${group.group_name}" (campaign: ${group.campaign_id})`)
      } catch (err) {
        console.error(`[GROUP-MONITOR] Error scheduling group ${group.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[GROUP-MONITOR] Scheduler error:', err.message)
  }
}

function initNurtureScheduler() {
  // Run every 5 minutes — nurture is slow/relaxed, no need to check frequently
  cron.schedule('*/5 * * * *', () => {
    processNurtureProfiles().catch(err => console.error('[NURTURE] cron error:', err.message))
    scheduleGroupMonitors().catch(err => console.error('[GROUP-MONITOR] cron error:', err.message))
  })

  // Weekly: decay old AI memories (every Sunday 3am)
  cron.schedule('0 3 * * 0', async () => {
    try {
      const { decayOldMemories } = require('./ai-memory')
      const count = await decayOldMemories(supabase)
      if (count > 0) console.log(`[AI-MEMORY] Weekly decay: ${count} memories adjusted`)
    } catch (err) {
      console.error('[AI-MEMORY] Weekly decay error:', err.message)
    }
  })

  // Phase 5: Weekly DeepSeek strategy update (every Sunday 4am)
  cron.schedule('0 4 * * 0', async () => {
    try {
      const { runWeeklyStrategy } = require('./ai-strategy')
      await runWeeklyStrategy(supabase)
    } catch (err) {
      console.error('[AI-STRATEGY] Weekly strategy error:', err.message)
    }
  })

  // Phase 11: Daily KPI rebalance (every day 00:01 VN time = 17:01 UTC)
  cron.schedule('1 0 * * *', async () => {
    try {
      const { rebalanceAllActive } = require('./kpi-calculator')
      await rebalanceAllActive(supabase)
    } catch (err) {
      console.error('[KPI] Daily rebalance error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Daily Self-Review at 23:00 VN. Hermes inspects its own performance for the
  // day (calls, feedback scores, job success rate, comment rejection rate),
  // rewrites skills with avg score < 3.5, purges low-score feedback samples,
  // and adjusts the quality gate threshold if rejection rate is high.
  cron.schedule('0 23 * * *', async () => {
    try {
      const { runDailyReview } = require('./hermes-orchestrator')
      await runDailyReview(supabase)
    } catch (err) {
      console.error('[SELF-REVIEW] Daily cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Auto-resume nicks whose orchestrator pause has expired.
  // pause_nick with duration_hours writes accounts.notes = "orchestrator_pause_until:<iso>".
  // Without this cron, the is_active=false sticks forever and the nick never
  // comes back online automatically.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { data: paused } = await supabase
        .from('accounts')
        .select('id, username, notes, status')
        .eq('is_active', false)
        .like('notes', 'orchestrator_pause_until:%')
      const now = Date.now()
      let resumed = 0
      for (const a of paused || []) {
        const m = (a.notes || '').match(/orchestrator_pause_until:([^\s—-]+)/)
        if (!m) continue
        const pauseUntil = new Date(m[1]).getTime()
        if (!Number.isFinite(pauseUntil)) continue
        if (pauseUntil > now) continue // still pausing
        // Don't resume if the nick actually died since being paused (checkpoint/expired)
        if (['checkpoint', 'expired', 'disabled', 'banned'].includes(a.status)) continue
        await supabase.from('accounts').update({ is_active: true, notes: null }).eq('id', a.id)
        console.log(`[ORCHESTRATOR] auto-resumed ${a.username} (pause expired)`)
        resumed++
      }
      if (resumed > 0) console.log(`[ORCHESTRATOR] auto-resume: ${resumed} nicks back online`)
    } catch (err) {
      console.error('[ORCHESTRATOR] auto-resume error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // HERMES_ORCHESTRATOR.md — every 15 minutes, run Hermes Orchestrator on each
  // is_active campaign. Hermes decides: assign idle nicks to jobs, skip stale
  // pending groups, recheck recent pending groups, alert user on checkpoints,
  // etc. Auto-apply flagged actions fire immediately; others are queued in
  // hermes_decisions with outcome='pending' for user approval.
  // Hermes LLM orchestrator — was */15min (288 calls/day/campaign).
  // Now runs hourly at :17 for strategic decisions only. The
  // algorithmic nick-autopilot (below, every 5 min) handles the 80% of
  // rule-matching decisions (idle → assign, pending → skip, etc.) that
  // don't need an LLM. Cuts Hermes cost ~75%.
  cron.schedule('17 * * * *', async () => {
    try {
      const { runAllRunningCampaigns } = require('./hermes-orchestrator')
      await runAllRunningCampaigns(supabase)
    } catch (err) {
      console.error('[ORCHESTRATOR] hourly cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // 2026-04-25: nick-autopilot was refactored into a signal-feeder. For
  // hermes_central campaigns (default since migration 020), the same 6 rules
  // now run INLINE inside hermes-orchestrator's pre-orchestration pipeline
  // (Phase 0, before LLM skills) — single source of truth, no double-emission.
  // This cron remains as a fallback path for:
  //   • non-Hermes campaigns (hermes_central=false) — rare/legacy
  //   • HERMES_DOWN=1 fallback — autopilot runs on every campaign
  // runAutopilot itself filters by hermes_central, so this cron is a cheap
  // no-op when all campaigns are Hermes-central (the common case).
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runAutopilot } = require('./nick-autopilot')
      await runAutopilot(supabase)
    } catch (err) {
      console.error('[AUTOPILOT] cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Daily report — 22:00 VN. Aggregates today's KPI stats from SQL
  // (always works) and optionally calls Hermes reporter skill for a
  // VN narrative (best-effort — row still saved if LLM fails).
  cron.schedule('0 22 * * *', async () => {
    try {
      const { generateAllRunning } = require('./daily-report')
      await generateAllRunning(supabase)
    } catch (err) {
      console.error('[DAILY-REPORT] cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // 2026-04-25: nick-kpi-watcher refactored to signal-feeder (PR3). For
  // hermes_central campaigns (default), KPI signals (shortfall + capability
  // bump/nerf) are computed INLINE in hermes-orchestrator's pre-orchestration
  // pipeline (Phase 0b) — single source of truth. This cron is now a no-op
  // for hermes_central, kept only for:
  //   • non-Hermes campaigns (legacy)
  //   • HERMES_DOWN=1 fallback — KPI watcher runs everywhere
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { runWatcher } = require('./nick-kpi-watcher')
      await runWatcher(supabase)
    } catch (err) {
      console.error('[NICK-KPI] watcher error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // RE-ENABLED 2026-05-02 (after wiring fallback chain): Moonshot 429 no
  // longer bricks this cron — Hermes Python auto-falls-back through DeepSeek
  // → NVIDIA → Gemini Flash on 429/billing/5xx. Without this cron the
  // hermes_central nicks idle 60 min between assign_job → throughput
  // collapses to <2 sessions/day vs target 24-28.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { data: centrals } = await supabase
        .from('campaigns').select('id, name')
        .eq('hermes_central', true).eq('status', 'running').eq('is_active', true)
      if (!centrals?.length) return
      const { runOrchestration } = require('./hermes-orchestrator')
      for (const c of centrals) {
        try { await runOrchestration(c.id, supabase) }
        catch (err) { console.error(`[ORCHESTRATOR-CENTRAL] ${c.name || c.id}: ${err.message}`) }
      }
    } catch (err) {
      console.error('[ORCHESTRATOR-CENTRAL] 5-min cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Audit 2026-04-12: Daily warmup budget rebalance at 00:30 VN.
  // Fixes the issue where nick age 3-4 days still had like.max=80 (same as
  // 100-day nicks). Each active account's daily_budget is recomputed from its
  // real age via the warmup curve — max is bumped up only (never lowered), and
  // `used` counters are reset to 0 so the new day starts clean.
  cron.schedule('30 0 * * *', async () => {
    try {
      const { rebalanceWarmupBudgets } = require('./warmup-budget')
      await rebalanceWarmupBudgets(supabase)
    } catch (err) {
      console.error('[WARMUP-REBALANCE] Daily error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Phase 17: AI Operations Manager — 3 levels
  // Level 1: Hourly monitor (every hour at :05 VN)
  cron.schedule('5 * * * *', async () => {
    try {
      const { runHourlyMonitor } = require('./ai-ops-manager')
      await runHourlyMonitor(supabase)
    } catch (err) { console.error('[AI-OPS] hourly error:', err.message) }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Level 2: Daily plan (6:00 AM VN every day)
  cron.schedule('0 6 * * *', async () => {
    try {
      const { runDailyPlan } = require('./ai-ops-manager')
      await runDailyPlan(supabase)
    } catch (err) { console.error('[AI-OPS] daily plan error:', err.message) }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Level 3: Weekly strategy (Sunday 5:30 AM VN)
  cron.schedule('30 5 * * 0', async () => {
    try {
      const { runWeeklyStrategy } = require('./ai-ops-manager')
      await runWeeklyStrategy(supabase)
    } catch (err) { console.error('[AI-OPS] weekly strategy error:', err.message) }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Phase 13: Hourly AI Pilot health check (every hour at :17 VN time)
  // - Flag campaigns where AI Pilot hasn't fired in 24h+
  // - Flag consecutive 'critical' assessments
  // - Insert user notification rows (dedup: max 1 per campaign per code per day)
  cron.schedule('17 * * * *', async () => {
    try {
      await checkAIPilotHealth(supabase)
    } catch (err) {
      console.error('[AI-PILOT-HEALTH] error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Daily: cleanup stale jobs (every day 0:15 VN time)
  cron.schedule('15 0 * * *', async () => {
    try {
      // Delete pending jobs older than 24h (budget-skipped, never ran)
      const { count: pendingDeleted } = await supabase
        .from('jobs')
        .delete({ count: 'exact' })
        .eq('status', 'pending')
        .lt('scheduled_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())

      // Delete cancelled jobs older than 3 days
      const { count: cancelledDeleted } = await supabase
        .from('jobs')
        .delete({ count: 'exact' })
        .eq('status', 'cancelled')
        .lt('created_at', new Date(Date.now() - 3 * 86400000).toISOString())

      // Delete done jobs older than 7 days (keep recent for audit)
      const { count: doneDeleted } = await supabase
        .from('jobs')
        .delete({ count: 'exact' })
        .eq('status', 'done')
        .lt('finished_at', new Date(Date.now() - 7 * 86400000).toISOString())

      const total = (pendingDeleted || 0) + (cancelledDeleted || 0) + (doneDeleted || 0)
      if (total > 0) {
        console.log(`[CLEANUP] Daily jobs cleanup: ${pendingDeleted || 0} stale pending, ${cancelledDeleted || 0} cancelled, ${doneDeleted || 0} old done — total ${total} deleted`)
      }

      // Also cleanup old health signals (>30 days)
      await supabase.from('account_health_signals')
        .delete()
        .lt('detected_at', new Date(Date.now() - 30 * 86400000).toISOString())

      // Daily quota rows: purge >7 days (bounded storage for nick_daily_job_quota)
      try {
        const { purgeOld } = require('./nick-quota')
        const purged = await purgeOld(supabase, { days: 7 })
        if (purged > 0) console.log(`[CLEANUP] nick_daily_job_quota purged ${purged} old rows`)
      } catch (qErr) {
        console.warn(`[CLEANUP] quota purge failed: ${qErr.message}`)
      }
    } catch (err) {
      console.error('[CLEANUP] Daily cleanup error:', err.message)
    }
  })

  // Daily group-membership check at 09:00 VN. Replaces previous per-pending
  // exponential backoff inside check-group-membership handler. Behavior:
  //   - Query all pending groups not yet >= 7 days (handler caps at 7d by
  //     setting score_tier='D' which excludes from this query).
  //   - Insert ONE check_group_membership job per pending group with random
  //     0-30 min jitter (don't burst the agent).
  //   - Skip if a check job is already pending/running for that group.
  cron.schedule('0 9 * * *', async () => {
    try {
      const since7d = new Date(Date.now() - 7 * 86400000).toISOString()
      const { data: pending } = await supabase
        .from('fb_groups')
        .select('id, fb_group_id, name, account_id, pending_since')
        .eq('pending_approval', true)
        .eq('is_member', false)
        .neq('score_tier', 'D')
        .gte('pending_since', since7d)
      if (!pending?.length) {
        console.log('[MEMBER-CHECK] Daily cron: 0 pending groups under 7d')
        return
      }
      const groupIds = pending.map(p => p.id)
      const { data: junctions } = await supabase
        .from('campaign_groups')
        .select('group_id, campaign_id')
        .in('group_id', groupIds)
      const campaignByGroup = new Map((junctions || []).map(j => [j.group_id, j.campaign_id]))

      let queued = 0
      for (const g of pending) {
        // Dedup: skip if a check job is already in-flight for this group
        const { count: existing } = await supabase.from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'check_group_membership')
          .in('status', ['pending', 'claimed', 'running'])
          .filter('payload->>fb_group_id', 'eq', g.fb_group_id)
        if ((existing || 0) > 0) continue

        await supabase.from('jobs').insert({
          type: 'check_group_membership',
          priority: 5,
          payload: {
            fb_group_id: g.fb_group_id,
            group_row_id: g.id,
            account_id: g.account_id,
            group_name: g.name,
            campaign_id: campaignByGroup.get(g.id) || null,
            source: 'daily_cron',
          },
          status: 'pending',
          scheduled_at: new Date(Date.now() + Math.random() * 30 * 60000).toISOString(),
        })
        queued++
      }
      console.log(`[MEMBER-CHECK] Daily cron: queued ${queued}/${pending.length} pending check jobs`)
    } catch (err) {
      console.error('[MEMBER-CHECK] daily cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // KPI Coordinator — every 90 min during VN active hours (07:00-22:00).
  // Lets Hermes reason about KPI gap + nick quality flexibly without rigid rules.
  // Output is persisted to hermes_decisions for the main orchestrator to read
  // on its next cycle (signal-feeder pattern, no double-emission).
  cron.schedule('23 7,9,11,13,14,16,18,20,22 * * *', async () => {
    try {
      const { runKpiCoordinatorAllRunning } = require('./hermes-orchestrator')
      await runKpiCoordinatorAllRunning(supabase)
    } catch (err) {
      console.error('[KPI-COORD] cron error:', err.message)
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' })

  // Comment engagement check — every 6h. Picks comments posted 18-30h ago,
  // queues check_comment_engagement jobs (1 per nick, batched up to 15
  // comments). Closes the post-publish learning loop: Hermes finally sees
  // which comments got reactions/replies vs. were ignored or removed.
  cron.schedule('37 */6 * * *', async () => {
    try {
      const since = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
      const until = new Date(Date.now() - 18 * 3600 * 1000).toISOString()
      const { data: rows } = await supabase
        .from('campaign_activity_log')
        .select('account_id, campaign_id, target_url, target_name, details, created_at')
        .eq('action_type', 'comment')
        .eq('result_status', 'success')
        .gte('created_at', since)
        .lte('created_at', until)
        .limit(500)
      if (!rows?.length) return

      // Skip rows already checked (look at engagement_check log for same target_url)
      const urls = rows.map(r => r.target_url).filter(Boolean)
      const { data: alreadyChecked } = await supabase
        .from('campaign_activity_log')
        .select('target_url')
        .eq('action_type', 'comment_engagement_check')
        .in('target_url', urls.slice(0, 500))
      const checkedSet = new Set((alreadyChecked || []).map(r => r.target_url))

      // Group comments by nick
      const byNick = new Map()
      for (const r of rows) {
        if (!r.target_url || checkedSet.has(r.target_url)) continue
        const text = r.details?.comment_text
        if (!text || text.length < 10) continue
        const arr = byNick.get(r.account_id) || []
        if (arr.length < 15) arr.push({
          target_url: r.target_url,
          target_name: r.target_name,
          comment_text: text,
          campaign_id: r.campaign_id,
        })
        byNick.set(r.account_id, arr)
      }

      let queued = 0
      for (const [accountId, comments] of byNick) {
        if (!comments.length) continue
        // Skip if a check_comment_engagement job already pending for this nick
        const { count: existing } = await supabase.from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'check_comment_engagement')
          .in('status', ['pending', 'claimed', 'running'])
          .filter('payload->>account_id', 'eq', accountId)
        if ((existing || 0) > 0) continue

        await supabase.from('jobs').insert({
          type: 'check_comment_engagement',
          priority: 7,
          payload: { account_id: accountId, comments },
          status: 'pending',
          scheduled_at: new Date(Date.now() + Math.random() * 30 * 60000).toISOString(),
        })
        queued++
      }
      if (queued > 0) console.log(`[ENGAGEMENT-CHECK] Queued ${queued} engagement check jobs`)
    } catch (err) {
      console.error('[ENGAGEMENT-CHECK] cron error:', err.message)
    }
  })

  console.log('[NURTURE] Scheduler initialized (every 5 min) — includes group monitor + weekly memory decay + daily cleanup + KPI coord + engagement check')
}

// Phase 13: Hourly AI Pilot health check.
// Inserts user-facing notifications when a campaign's AI Pilot looks unhealthy.
// Dedup: for each (campaign, code) pair, insert at most one notification per day.
async function checkAIPilotHealth(supabase) {
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, owner_id, total_runs, is_active')
    .eq('is_active', true)
    .limit(200)
  if (!campaigns?.length) return

  let notifsCreated = 0
  for (const campaign of campaigns) {
    // Skip campaigns that haven't run enough to trigger AI Pilot yet (needs >= 3 runs)
    if ((campaign.total_runs || 0) < 3) continue

    const { data: decisions } = await supabase
      .from('campaign_activity_log')
      .select('id, created_at, result_status, details')
      .eq('campaign_id', campaign.id)
      .eq('action_type', 'ai_control')
      .order('created_at', { ascending: false })
      .limit(5)

    const warnings = []
    const lastFireMs = decisions?.[0]?.created_at ? new Date(decisions[0].created_at).getTime() : null
    const hoursSince = lastFireMs ? (Date.now() - lastFireMs) / 3600000 : null

    if (hoursSince === null || hoursSince > 24) {
      warnings.push({
        code: 'ai_pilot_stale',
        level: 'warning',
        title: `AI Pilot im lặng — ${campaign.name || campaign.id.slice(0, 8)}`,
        body: hoursSince === null
          ? 'AI Pilot chưa từng fire cho campaign này. Cần ít nhất 3 campaign runs để trigger.'
          : `AI Pilot chưa fire trong ${Math.round(hoursSince)}h qua. Kiểm tra scheduler + total_runs.`,
      })
    }

    if (decisions && decisions.length >= 3) {
      const last3 = decisions.slice(0, 3)
      if (last3.every(d => d.details?.assessment === 'critical')) {
        warnings.push({
          code: 'ai_pilot_critical_streak',
          level: 'urgent',
          title: `AI Pilot báo CRITICAL 3 lần liên tiếp — ${campaign.name || campaign.id.slice(0, 8)}`,
          body: 'Campaign đang gặp vấn đề nghiêm trọng. Xem tab AI Pilot → recent decisions để biết chi tiết.',
        })
      }
      if (last3.every(d => (d.details?.applied_count || 0) === 0)) {
        warnings.push({
          code: 'ai_pilot_zero_applied',
          level: 'warning',
          title: `AI Pilot không apply được quyết định — ${campaign.name || campaign.id.slice(0, 8)}`,
          body: '3 quyết định gần nhất đều applied_count=0. Có thể adjustments format sai hoặc target_role không tồn tại.',
        })
      }
    }

    // Dedup: for each warning code, check if we already inserted one in the last 24h
    for (const w of warnings) {
      try {
        const since = new Date(Date.now() - 24 * 3600000).toISOString()
        const { count } = await supabase.from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', campaign.owner_id)
          .eq('type', w.code)
          .gte('created_at', since)
        if ((count || 0) > 0) continue // already notified in last 24h

        await supabase.from('notifications').insert({
          user_id: campaign.owner_id,
          type: w.code,
          title: w.title,
          body: w.body,
          level: w.level,
        })
        notifsCreated++
      } catch (err) {
        console.warn(`[AI-PILOT-HEALTH] insert notification failed: ${err.message}`)
      }
    }
  }
  if (notifsCreated > 0) {
    console.log(`[AI-PILOT-HEALTH] Created ${notifsCreated} notifications across ${campaigns.length} campaigns`)
  }
}

module.exports = { initNurtureScheduler }
