// Nick Autopilot — script-based deterministic safety rules.
//
// User: "cái nào cần suy nghĩ thì mới dùng LLM, không cần thì dùng script".
//
// 6 rules:
//   • nick expired/checkpoint → alert_user (manual)
//   • nick checkpoint_7d ≥ 2 → decrease_budget comment 50%
//   • nick avg_comment_gap < 45s + sample ≥ 10 → pause_nick 2h
//   • nick failures_24h ≥ 5 → alert_user (warning)
//   • group pending > 7d + checked 3x → skip_group
//   • group pending ≤ 7d + check_count < 3 → recheck_group
//
// 2026-04-25 refactor: split into compute + apply. Hermes-central campaigns
// now consume signals INLINE in runPreOrchestrationPipeline (single source of
// truth). Non-Hermes campaigns + HERMES_DOWN fallback keep the cron path.
//
// Public API:
//   computeAutopilotSignals(supabase, campaignId)  → pure data, no writes
//   applyAutopilotSignals(...)                     → cron path: insertDecision rows
//   runAutopilot(supabase)                         → cron entry, skips hermes_central

const AGE_WARMUP_DAYS = 14
const IDLE_MINUTES_THRESHOLD = 180
const PENDING_DAYS_HARD_CAP = 7
const CHECK_COUNT_HARD_CAP = 3
const FAILURES_24H_THRESHOLD = 5
const COMMENT_GAP_SECONDS_FLOOR = 45
const COMMENT_SAMPLE_MIN = 10
const CHECKPOINT_7D_THRESHOLD = 2

async function insertDecision(pool, campaignId, targetId, targetName, actionType, priority, reason, decision, autoApply) {
  // Dedup — don't repeat the same decision for the same target within 2h
  const { rows: recent } = await pool.query(
    `SELECT id FROM hermes_decisions
     WHERE campaign_id = $1 AND target_id = $2 AND action_type = $3
       AND created_at > now() - INTERVAL '2 hours'
     LIMIT 1`,
    [campaignId, targetId, actionType]
  )
  if (recent.length > 0) return false

  await pool.query(
    `INSERT INTO hermes_decisions (campaign_id, decision_type, action_type, target_id, target_name, priority, reason, decision, auto_apply, auto_applied, outcome)
     VALUES ($1, 'autopilot', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      campaignId,
      actionType,
      targetId,
      targetName,
      priority,
      reason,
      JSON.stringify({ ...decision, source: 'autopilot' }),
      autoApply,
      autoApply,                                // auto_applied boolean
      autoApply ? 'success' : 'pending',        // outcome
    ]
  )
  return true
}

// ─── Pure rule evaluation (no DB writes) ───────────────────
// Takes already-gathered nick stats, returns proposed actions as plain data.
// Keeps the 6 rules in ONE place — both cron path and pre-orchestration
// pipeline consume the same evaluator. Returned objects carry the same
// shape as Hermes orchestrator actions so executeAction() can apply them.
function evaluateNickRules(nicks) {
  const actions = []
  for (const nick of nicks) {
    // Rule 1: nick in checkpoint/expired → alert_user (needs human)
    if (nick.status === 'checkpoint' || nick.status === 'expired' || nick.status === 'session_expired') {
      actions.push({
        type: 'alert_user',
        target_id: nick.id,
        target_name: nick.username,
        priority: 'high',
        auto_apply: false,
        reason: `Nick ${nick.status} — cookies chết, cần user refresh`,
        action_detail: { severity: 'urgent', action: 'refresh_cookies' },
        rule: 'nick_dead',
      })
      continue
    }

    if (!nick.is_active) continue

    // Rule 2: too many checkpoints recent → decrease_budget
    if ((nick.checkpoint_7d || 0) >= CHECKPOINT_7D_THRESHOLD) {
      actions.push({
        type: 'decrease_budget',
        target_id: nick.id,
        target_name: nick.username,
        priority: 'high',
        auto_apply: true,
        reason: `${nick.checkpoint_7d} checkpoint trong 7 ngày — giảm comment quota 50%`,
        action_detail: { task_type: 'comment', multiplier: 0.5 },
        rule: 'checkpoint_7d_cap',
      })
    }

    // Rule 3: comment gap too tight → pause 2h
    if (nick.avg_comment_gap != null && nick.avg_comment_gap < COMMENT_GAP_SECONDS_FLOOR
        && (nick.comment_sample || 0) >= COMMENT_SAMPLE_MIN) {
      actions.push({
        type: 'pause_nick',
        target_id: nick.id,
        target_name: nick.username,
        priority: 'high',
        auto_apply: true,
        reason: `Comment quá nhanh (avg ${nick.avg_comment_gap}s < ${COMMENT_GAP_SECONDS_FLOOR}s) — nghỉ 2h`,
        action_detail: { duration_hours: 2, reason: 'comment_spam_prevention' },
        rule: 'comment_spam',
      })
    }

    // Rule 4: too many failures → alert + throttle
    if ((nick.failures_24h || 0) >= FAILURES_24H_THRESHOLD) {
      actions.push({
        type: 'alert_user',
        target_id: nick.id,
        target_name: nick.username,
        priority: 'medium',
        auto_apply: false,
        reason: `${nick.failures_24h} job fail trong 24h — review error pattern`,
        action_detail: { severity: 'warning', failures: nick.failures_24h },
        rule: 'failure_burst',
      })
    }
  }
  return actions
}

function evaluateGroupRules(groups) {
  const actions = []
  for (const g of groups) {
    if (g.has_check_job) continue

    if (g.pending_days > PENDING_DAYS_HARD_CAP && g.check_count >= CHECK_COUNT_HARD_CAP) {
      actions.push({
        type: 'skip_group',
        target_id: g.id,
        target_name: g.name,
        priority: 'low',
        auto_apply: true,
        reason: `Chờ duyệt ${g.pending_days}d, đã check ${g.check_count} lần — bỏ nhóm`,
        action_detail: { reason: 'admin_approval_unlikely', pending_days: g.pending_days, check_count: g.check_count },
        rule: 'pending_timeout',
      })
    } else if (g.pending_days <= PENDING_DAYS_HARD_CAP && g.check_count < CHECK_COUNT_HARD_CAP) {
      actions.push({
        type: 'recheck_group',
        target_id: g.id,
        target_name: g.name,
        priority: 'medium',
        auto_apply: true,
        reason: `Pending ${g.pending_days}d, check ${g.check_count}/${CHECK_COUNT_HARD_CAP} — queue recheck`,
        action_detail: { action: 'queue_check_group_membership' },
        rule: 'pending_recheck',
      })
    }
  }
  return actions
}

// Pure data — query DB, run rules, return signals. Used by both cron path
// AND hermes pre-orchestration pipeline.
async function computeAutopilotSignals(supabase, campaignId) {
  const pool = supabase?._pool
  if (!pool) return { nick_actions: [], group_actions: [] }

  const nicks = await gatherNickStats(pool, campaignId)
  const groups = await gatherGroupStats(pool, campaignId)
  return {
    nick_actions: evaluateNickRules(nicks),
    group_actions: evaluateGroupRules(groups),
  }
}

// Legacy cron-mode wrapper: writes hermes_decisions rows directly via
// insertDecision (with 2h dedup). Used when the campaign is NOT
// hermes_central (cron still runs autopilot for those campaigns) or in
// HERMES_DOWN fallback.
async function runNickChecks(pool, campaignId, nicks) {
  const actions = evaluateNickRules(nicks)
  let emitted = 0
  for (const a of actions) {
    const wrote = await insertDecision(pool, campaignId, a.target_id, a.target_name,
      a.type, a.priority, a.reason, a.action_detail, a.auto_apply)
    if (wrote) emitted++
  }
  return emitted
}

async function gatherGroupStats(pool, campaignId) {
  const { rows: groups } = await pool.query(
    `SELECT fg.id, fg.name, fg.pending_approval,
            EXTRACT(DAY FROM (now() - fg.created_at))::int AS pending_days,
            COALESCE((SELECT COUNT(*) FROM jobs j
                      WHERE j.type = 'check_group_membership'
                        AND j.status = 'done'
                        AND j.payload->>'group_row_id' = fg.id::text), 0) AS check_count,
            EXISTS (SELECT 1 FROM jobs j
                    WHERE j.type = 'check_group_membership'
                      AND j.status IN ('pending','claimed','running')
                      AND j.payload->>'group_row_id' = fg.id::text) AS has_check_job
     FROM campaign_groups cg
     JOIN fb_groups fg ON fg.id = cg.group_id
     WHERE cg.campaign_id = $1 AND cg.status = 'active'
       AND fg.pending_approval = true AND fg.is_member = false`,
    [campaignId]
  )
  return groups
}

// Cron path — keeps the legacy insertDecision behavior for non-Hermes campaigns
async function runGroupChecks(pool, campaignId) {
  const groups = await gatherGroupStats(pool, campaignId)
  const actions = evaluateGroupRules(groups)
  let emitted = 0
  for (const a of actions) {
    const wrote = await insertDecision(pool, campaignId, a.target_id, a.target_name,
      a.type, a.priority, a.reason, a.action_detail, a.auto_apply)
    if (wrote) emitted++
  }
  return emitted
}

async function gatherNickStats(pool, campaignId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.username, a.status, a.is_active, a.fb_created_at, a.created_at,
            EXTRACT(EPOCH FROM (now() - a.last_used_at))/60 AS idle_min,
            (SELECT COUNT(*)::int FROM job_failures f
             WHERE f.account_id = a.id AND f.created_at > now() - INTERVAL '24 hours') AS failures_24h,
            (SELECT COUNT(*)::int FROM job_failures f
             WHERE f.account_id = a.id AND f.error_type = 'CHECKPOINT'
               AND f.created_at > now() - INTERVAL '7 days') AS checkpoint_7d
     FROM accounts a
     WHERE a.id = ANY($1::uuid[])`,
    [await pickCampaignNickIds(pool, campaignId)]
  )
  return rows.map(r => ({
    id: r.id,
    username: r.username,
    status: r.status,
    is_active: r.is_active,
    idle_minutes: r.idle_min != null ? Math.floor(r.idle_min) : 999,
    age_days: Math.floor((Date.now() - new Date(r.fb_created_at || r.created_at).getTime()) / 86400000),
    failures_24h: r.failures_24h,
    checkpoint_7d: r.checkpoint_7d,
  }))
}

async function pickCampaignNickIds(pool, campaignId) {
  const { rows } = await pool.query(
    `SELECT account_ids FROM campaigns WHERE id = $1`,
    [campaignId]
  )
  const topLevel = rows[0]?.account_ids || []
  const { rows: roleRows } = await pool.query(
    `SELECT account_ids FROM campaign_roles WHERE campaign_id = $1`,
    [campaignId]
  )
  const fromRoles = (roleRows || []).flatMap(r => r.account_ids || [])
  return [...new Set([...topLevel, ...fromRoles])]
}

async function runAutopilot(supabase) {
  const pool = supabase?._pool
  if (!pool) return { ran: 0 }

  // Skip hermes_central campaigns — they consume autopilot signals INLINE in
  // hermes-orchestrator's pre-orchestration pipeline (single source of truth).
  // Override with HERMES_DOWN=1 to run autopilot on every campaign as fallback.
  const hermesDownFallback = process.env.HERMES_DOWN === '1'
  const filter = hermesDownFallback ? '' : 'AND COALESCE(hermes_central, false) = false'
  const { rows: campaigns } = await pool.query(
    `SELECT id, name FROM campaigns WHERE is_active = true AND status IN ('running','active') ${filter}`
  )

  let totalEmitted = 0
  for (const c of campaigns) {
    try {
      const nicks = await gatherNickStats(pool, c.id)
      const nickEmitted = await runNickChecks(pool, c.id, nicks)
      const groupEmitted = await runGroupChecks(pool, c.id)
      if (nickEmitted + groupEmitted > 0) {
        console.log(`[AUTOPILOT] ${c.name}: ${nickEmitted + groupEmitted} actions (${nickEmitted} nick + ${groupEmitted} group)`)
      }
      totalEmitted += nickEmitted + groupEmitted
    } catch (err) {
      console.warn(`[AUTOPILOT] ${c.name} error: ${err.message}`)
    }
  }

  return { ran: campaigns.length, emitted: totalEmitted, mode: hermesDownFallback ? 'fallback' : 'non-hermes' }
}

// Convenience for hermes pre-orchestration: convert orchestrator context.nicks
// shape (which has checkpoint_risk + jobs_failed + ...) into the flat shape
// evaluateNickRules() expects, so we don't need a second DB roundtrip.
function evaluateNickRulesFromContext(contextNicks) {
  return evaluateNickRules((contextNicks || []).map(n => ({
    id: n.id,
    username: n.username,
    status: n.status,
    is_active: n.is_active,
    failures_24h: n.jobs_failed || 0,
    checkpoint_7d: n.checkpoint_risk?.recent_checkpoints_7d || 0,
    avg_comment_gap: n.checkpoint_risk?.avg_comment_gap_seconds,
    comment_sample: n.checkpoint_risk?.comment_sample_size || 0,
  })))
}

module.exports = {
  runAutopilot,
  computeAutopilotSignals,
  evaluateNickRules,
  evaluateNickRulesFromContext,
  evaluateGroupRules,
  gatherGroupStats,
}
