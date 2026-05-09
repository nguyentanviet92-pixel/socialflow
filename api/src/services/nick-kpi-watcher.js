// Nick KPI Watcher — enforces daily KPI per nick per campaign.
//
// 6 outputs per nick:
//   • shortfall (>20% behind expected): kpi_shortfall decision (auto_apply
//     conditional on cause — idle=true, dead/paused=false)
//   • capability_bump: 5+ consecutive days hitting target + 0 checkpoints
//     → raise_kpi_target +20%
//   • capability_nerf: ≥1 checkpoint OR young+missed3d OR fail_rate>30%
//     → lower_kpi_target -30% for 7d
//
// 2026-04-25 refactor (PR3): split into compute + apply, mirroring autopilot.
//   - computeKpiSignals(supabase, campaignId)  → pure data, no writes
//   - runWatcher(supabase)                     → cron path, skips hermes_central
//   - hermes-orchestrator's runKpiWatcherPhase consumes signals INLINE
//     for hermes_central campaigns (single source of truth)
//
// Pure Node + SQL — no LLM call, works even when LLM orchestrator is down.

// supabase injected by caller (server.js / cron) to share the pool

const SHORTFALL_THRESHOLD_PCT = 20      // shortfall % that triggers a decision
const CAPABILITY_STREAK_DAYS = 5        // consecutive days hitting target to auto-bump
const CAPABILITY_BUMP_PCT = 20          // % to bump target when capable
const CAPABILITY_NERF_PCT = 30          // % to reduce target when nick is stressed
const ACTIVE_WINDOW_HOURS = 14          // 8am-22pm VN, matches typical account hours
const ACTIVE_WINDOW_START = 8           // hour-of-day (VN) activity window starts

function vnHour() {
  const d = new Date(Date.now() + 7 * 3600 * 1000)
  return d.getUTCHours() + d.getUTCMinutes() / 60
}

function vnToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
}

async function diagnose(pool, accountId, campaignId) {
  // Look back 24h for error signals
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  const { rows: failureRows } = await pool.query(
    `SELECT error_type, COUNT(*)::int AS c
     FROM job_failures
     WHERE account_id = $1 AND created_at > $2
     GROUP BY error_type ORDER BY c DESC`,
    [accountId, since]
  )
  const failures = Object.fromEntries(failureRows.map(r => [r.error_type, r.c]))
  const totalFailures = failureRows.reduce((s, r) => s + r.c, 0)

  // Last activity timestamp
  const { rows: lastRows } = await pool.query(
    `SELECT MAX(finished_at) AS last FROM jobs WHERE payload->>'account_id' = $1 AND status IN ('done','failed')`,
    [accountId]
  )
  const lastAt = lastRows[0]?.last ? new Date(lastRows[0].last) : null
  const idleMinutes = lastAt ? Math.floor((Date.now() - lastAt.getTime()) / 60000) : 999

  // Account state
  const { rows: accRows } = await pool.query(
    `SELECT status, is_active, daily_budget, fb_created_at, created_at FROM accounts WHERE id = $1`,
    [accountId]
  )
  const acc = accRows[0]
  if (!acc) return null

  const ageDays = acc.fb_created_at || acc.created_at
    ? Math.floor((Date.now() - new Date(acc.fb_created_at || acc.created_at).getTime()) / 86400000)
    : 0

  const budget = acc.daily_budget || {}
  const budgetExhausted = Object.entries(budget).some(([k, v]) =>
    v && typeof v === 'object' && v.used >= (v.max || 0) && (v.max || 0) > 0
  )

  // Classify
  let cause = 'unknown'
  let plan = 'orchestrator tick assign_job priority=critical'
  let autoApply = true
  let severity = 'medium'

  if (!acc.is_active) {
    cause = 'nick paused (is_active=false)'
    plan = 'resume nick manually if ok, or investigate pause reason'
    autoApply = false
    severity = 'high'
  } else if (acc.status === 'checkpoint' || acc.status === 'expired' || acc.status === 'session_expired') {
    cause = `nick in ${acc.status} state — cookies dead`
    plan = 'user must refresh cookies via UI'
    autoApply = false
    severity = 'high'
  } else if (totalFailures >= 5) {
    cause = `${totalFailures} failures in last 24h (${Object.keys(failures).join(', ')})`
    plan = 'reduce rate + review checkpoint_risk patterns'
    autoApply = false
    severity = 'high'
  } else if (ageDays < 14) {
    cause = `nick young (${ageDays}d) — warmup gate blocks join_group/FR`
    plan = 'focus on likes + browse during warmup; join_group unlocks day 14'
    autoApply = false
    severity = 'low'
  } else if (budgetExhausted) {
    cause = 'daily_budget cap hit for one or more actions'
    plan = 'cap is working as intended; raise max if nick health allows'
    autoApply = false
    severity = 'low'
  } else if (idleMinutes > 180) {
    cause = `nick idle ${idleMinutes} min — no jobs picked up`
    plan = 'assign_job priority=critical to kick off work'
    autoApply = true
    severity = 'medium'
  } else {
    cause = 'throughput slower than expected — no clear blocker'
    plan = 'assign additional work + monitor'
    autoApply = true
    severity = 'low'
  }

  return {
    cause,
    plan,
    auto_apply: autoApply,
    severity,
    evidence: {
      idle_minutes: idleMinutes,
      age_days: ageDays,
      status: acc.status,
      is_active: acc.is_active,
      failures_24h: failures,
      budget_exhausted: budgetExhausted,
    },
  }
}

async function expectedProgress(target) {
  // Linear ramp across the active window (8am-10pm VN).
  // Returns fraction [0, 1] of the target expected to be done by `now`.
  const h = vnHour()
  if (h < ACTIVE_WINDOW_START) return 0
  const windowEnd = ACTIVE_WINDOW_START + ACTIVE_WINDOW_HOURS
  if (h >= windowEnd) return 1
  return (h - ACTIVE_WINDOW_START) / ACTIVE_WINDOW_HOURS
}

async function checkCapability(pool, accountId, campaignId) {
  // Look at last 7 days of nick_kpi_daily — is this nick consistently
  // hitting target with healthy signals? If yes, recommend bumping.
  const { rows } = await pool.query(
    `SELECT date, done_likes + done_comments + done_friend_requests + done_group_joins AS done,
            target_likes + target_comments + target_friend_requests + target_group_joins AS target
     FROM nick_kpi_daily
     WHERE account_id = $1 AND campaign_id = $2 AND date >= CURRENT_DATE - 7
     ORDER BY date DESC`,
    [accountId, campaignId]
  )
  let streak = 0
  for (const r of rows) {
    if (r.target > 0 && r.done >= r.target) streak++
    else break
  }
  if (streak >= CAPABILITY_STREAK_DAYS) {
    // Check checkpoint risk — don't bump if nick stressed
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const { rows: cpRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM job_failures
       WHERE account_id = $1 AND error_type = 'CHECKPOINT' AND created_at > $2`,
      [accountId, since]
    )
    if ((cpRows[0]?.c || 0) === 0) {
      return { eligible_for_bump: true, streak_days: streak, bump_pct: CAPABILITY_BUMP_PCT }
    }
  }
  return { eligible_for_bump: false, streak_days: streak }
}

// Checks if a nick should have its target LOWERED to protect it.
// Triggers (any one is enough):
//   - ≥1 CHECKPOINT failure in last 7d (most important — nick stressed)
//   - New nick (<14d old) + missed target 3 consecutive days
//   - Failure rate ≥30% in last 48h (nick unstable)
// Returns { eligible_for_nerf, reason, nerf_pct }. Dedup handled by caller
// checking ai_pilot_memory so we don't nerf twice within 3d.
async function checkCapabilityNerf(pool, accountId, campaignId) {
  // Signal 1: recent checkpoint
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString()
  const { rows: cpRows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM job_failures
     WHERE account_id = $1 AND error_type IN ('CHECKPOINT','SESSION_EXPIRED') AND created_at > $2`,
    [accountId, since7d]
  )
  if ((cpRows[0]?.c || 0) > 0) {
    return { eligible_for_nerf: true, reason: `${cpRows[0].c} checkpoint/session-expired trong 7d`, nerf_pct: CAPABILITY_NERF_PCT }
  }

  // Signal 2: young nick missing target 3d
  const { rows: accRows } = await pool.query(
    `SELECT fb_created_at, created_at FROM accounts WHERE id = $1`,
    [accountId]
  )
  const acc = accRows[0]
  const ageDays = acc?.fb_created_at || acc?.created_at
    ? Math.floor((Date.now() - new Date(acc.fb_created_at || acc.created_at).getTime()) / 86400000)
    : 999
  if (ageDays < 14) {
    // Check missed target streak excluding today (today is in-progress)
    const { rows: histRows } = await pool.query(
      `SELECT date, done_likes + done_comments + done_friend_requests + done_group_joins AS done,
              target_likes + target_comments + target_friend_requests + target_group_joins AS target
       FROM nick_kpi_daily
       WHERE account_id = $1 AND campaign_id = $2 AND date >= CURRENT_DATE - 3 AND date < CURRENT_DATE
       ORDER BY date DESC`,
      [accountId, campaignId]
    )
    let missStreak = 0
    for (const r of histRows) {
      if (r.target > 0 && r.done < r.target) missStreak++
      else break
    }
    if (missStreak >= 3) {
      return { eligible_for_nerf: true, reason: `nick mới ${ageDays}d, miss KPI ${missStreak}d liên tiếp`, nerf_pct: CAPABILITY_NERF_PCT }
    }
  }

  // Signal 3: high failure rate 48h
  const since48h = new Date(Date.now() - 48 * 3600000).toISOString()
  const { rows: failRateRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='failed')::int AS failed,
       COUNT(*) FILTER (WHERE status IN ('done','failed'))::int AS finished
     FROM jobs
     WHERE payload->>'account_id' = $1 AND finished_at > $2`,
    [accountId, since48h]
  )
  const failed = failRateRows[0]?.failed || 0
  const finished = failRateRows[0]?.finished || 0
  if (finished >= 10 && failed / finished >= 0.30) {
    return {
      eligible_for_nerf: true,
      reason: `fail rate ${Math.round((failed/finished)*100)}% trong 48h (${failed}/${finished} jobs)`,
      nerf_pct: CAPABILITY_NERF_PCT,
    }
  }

  return { eligible_for_nerf: false }
}

// ─── Pure compute (no writes) ──────────────────────────────
// Returns structured signals for ONE campaign — used by both cron path
// (which then writes hermes_decisions) and hermes-orchestrator pre-pipeline
// (which auto-applies via executeAction). Shape:
//   {
//     shortfalls: [
//       { nick_id, username, action: {type:'investigate_nick_shortfall', ...},
//         total: {done, target, pct}, by_action: [...], cause, plan, severity, evidence }
//     ],
//     bumps: [{ nick_id, username, action: {type:'raise_kpi_target', ...}, streak_days, bump_pct }],
//     nerfs: [{ nick_id, username, action: {type:'lower_kpi_target', ...}, reason, nerf_pct }],
//   }
async function computeKpiSignalsForCampaign(supabaseInst, campaignId) {
  const pool = supabaseInst?._pool
  if (!pool) return { shortfalls: [], bumps: [], nerfs: [] }

  const today = vnToday()
  const expectedFrac = await expectedProgress()

  const { rows: kpis } = await pool.query(
    `SELECT k.account_id, k.campaign_id,
            COALESCE(k.done_likes,0) AS done_likes, COALESCE(k.target_likes,0) AS target_likes,
            COALESCE(k.done_comments,0) AS done_comments, COALESCE(k.target_comments,0) AS target_comments,
            COALESCE(k.done_friend_requests,0) AS done_fr, COALESCE(k.target_friend_requests,0) AS target_fr,
            COALESCE(k.done_group_joins,0) AS done_joins, COALESCE(k.target_group_joins,0) AS target_joins,
            a.is_active, a.status, a.username
     FROM nick_kpi_daily k
     JOIN accounts a ON a.id = k.account_id
     WHERE k.date = $1 AND k.campaign_id = $2 AND a.is_active = true`,
    [today, campaignId]
  )

  const ACTIONS = [
    { key: 'likes',    doneCol: 'done_likes',    targetCol: 'target_likes',    label: 'Like',       handlerHint: 'campaign_nurture likes posts in joined groups' },
    { key: 'comments', doneCol: 'done_comments', targetCol: 'target_comments', label: 'Comment',    handlerHint: 'campaign_nurture comments via AI after quality gate' },
    { key: 'fr',       doneCol: 'done_fr',       targetCol: 'target_fr',       label: 'Kết bạn',    handlerHint: 'campaign_send_friend_request (needs connect role + age >=14d)' },
    { key: 'joins',    doneCol: 'done_joins',    targetCol: 'target_joins',    label: 'Join group', handlerHint: 'campaign_discover_groups (scout role, age >=14d unlocks)' },
  ]

  const out = { shortfalls: [], bumps: [], nerfs: [] }

  for (const row of kpis) {
    const totalTarget = row.target_likes + row.target_comments + row.target_fr + row.target_joins
    if (totalTarget <= 0) continue
    const totalDone = row.done_likes + row.done_comments + row.done_fr + row.done_joins

    const actionStatus = ACTIONS.map(a => {
      const target = row[a.targetCol]
      const done = row[a.doneCol]
      if (target <= 0) return null
      const expected = target * expectedFrac
      const gap = expected - done
      const pct = expected > 0 ? Math.round((gap / expected) * 100) : 0
      return {
        action: a.key, label: a.label, done, target,
        expected: Math.round(expected),
        gap: Math.max(0, Math.round(gap)),
        shortfall_pct: Math.max(0, pct),
        handler_hint: a.handlerHint,
        status: pct >= SHORTFALL_THRESHOLD_PCT ? 'behind' : (done >= target ? 'done' : 'on_track'),
      }
    }).filter(Boolean)

    const behindActions = actionStatus.filter(a => a.status === 'behind')

    // Shortfall signal
    if (behindActions.length > 0) {
      const diag = await diagnose(pool, row.account_id, campaignId)
      if (diag) {
        const perActionPlans = behindActions.map(a => {
          let specific = a.handler_hint
          if (a.action === 'comments' && diag.evidence.failures_24h && Object.keys(diag.evidence.failures_24h).length) {
            specific += ` · kiểm tra quality_gate rejection trong log`
          }
          if (a.action === 'fr' && diag.evidence.age_days < 14) {
            specific += ` · nick mới ${diag.evidence.age_days}d, chờ đến 14d`
          }
          if (a.action === 'joins' && diag.evidence.age_days < 14) {
            specific += ` · warmup đang chặn join_group`
          }
          return { ...a, plan: specific }
        })
        const behindSummary = behindActions.map(a => `${a.label} ${a.done}/${a.target}`).join(', ')
        const totalPct = Math.round((totalDone / totalTarget) * 100)
        out.shortfalls.push({
          nick_id: row.account_id,
          username: row.username,
          total: { done: totalDone, target: totalTarget, pct: totalPct },
          by_action: actionStatus,
          cause: diag.cause,
          plan: diag.plan,
          severity: diag.severity,
          evidence: diag.evidence,
          action: {
            type: 'investigate_nick_shortfall',
            target_id: row.account_id,
            target_name: row.username,
            priority: diag.severity === 'high' ? 'high' : 'medium',
            auto_apply: false, // shortfall is informational — user reviews
            reason: `${diag.cause}. Hôm nay: ${totalDone}/${totalTarget} (${totalPct}%) · Thiếu: ${behindSummary}`,
            action_detail: {
              total: { done: totalDone, target: totalTarget, pct: totalPct },
              by_action: actionStatus,
              cause: diag.cause,
              plan: diag.plan,
              per_action_plan: perActionPlans,
              evidence: diag.evidence,
            },
          },
        })
      }
    }

    // Capability bump
    const cap = await checkCapability(pool, row.account_id, campaignId)
    if (cap.eligible_for_bump) {
      out.bumps.push({
        nick_id: row.account_id,
        username: row.username,
        streak_days: cap.streak_days,
        bump_pct: cap.bump_pct,
        action: {
          type: 'raise_kpi_target',
          target_id: row.account_id,
          target_name: row.username,
          priority: 'low',
          auto_apply: true,
          reason: `${cap.streak_days} ngày liên tiếp đạt KPI, không checkpoint — auto nâng target +${cap.bump_pct}%`,
          action_detail: { bump_pct: cap.bump_pct, streak_days: cap.streak_days },
        },
      })
    }

    // Capability nerf
    const nerf = await checkCapabilityNerf(pool, row.account_id, campaignId)
    if (nerf.eligible_for_nerf) {
      out.nerfs.push({
        nick_id: row.account_id,
        username: row.username,
        reason: nerf.reason,
        nerf_pct: nerf.nerf_pct,
        action: {
          type: 'lower_kpi_target',
          target_id: row.account_id,
          target_name: row.username,
          priority: 'high',
          auto_apply: true,
          reason: `Bảo vệ nick: ${nerf.reason} — auto giảm target -${nerf.nerf_pct}% trong 7 ngày`,
          action_detail: { nerf_pct: nerf.nerf_pct, reason: nerf.reason },
        },
      })
    }
  }

  return out
}

async function runWatcher(supabaseInst) {
  const pool = supabaseInst?._pool
  if (!pool) return

  const today = vnToday()

  // 2026-04-25: skip hermes_central campaigns — they consume KPI signals
  // INLINE in hermes-orchestrator's pre-orchestration pipeline (single
  // source of truth). HERMES_DOWN=1 disables the skip so cron processes
  // every campaign (fallback when LLM down).
  const hermesDownFallback = process.env.HERMES_DOWN === '1'
  const filter = hermesDownFallback ? '' : 'AND COALESCE(c.hermes_central, false) = false'

  // Pull today's KPI rows — keep per-action breakdown so we can
  // diagnose SPECIFIC shortfalls (e.g. likes OK but comments 0).
  const { rows: kpis } = await pool.query(
    `SELECT k.account_id, k.campaign_id,
            COALESCE(k.done_likes,0) AS done_likes, COALESCE(k.target_likes,0) AS target_likes,
            COALESCE(k.done_comments,0) AS done_comments, COALESCE(k.target_comments,0) AS target_comments,
            COALESCE(k.done_friend_requests,0) AS done_fr, COALESCE(k.target_friend_requests,0) AS target_fr,
            COALESCE(k.done_group_joins,0) AS done_joins, COALESCE(k.target_group_joins,0) AS target_joins,
            a.is_active, a.status, a.username
     FROM nick_kpi_daily k
     JOIN accounts a ON a.id = k.account_id
     JOIN campaigns c ON c.id = k.campaign_id
     WHERE k.date = $1 AND a.is_active = true ${filter}`,
    [today]
  )

  const expectedFrac = await expectedProgress()
  let checked = 0, shortfalls = 0, capabilities = 0, nerfs = 0

  const ACTIONS = [
    { key: 'likes',    doneCol: 'done_likes',    targetCol: 'target_likes',    label: 'Like',        handlerHint: 'campaign_nurture likes posts in joined groups' },
    { key: 'comments', doneCol: 'done_comments', targetCol: 'target_comments', label: 'Comment',     handlerHint: 'campaign_nurture comments via AI after quality gate' },
    { key: 'fr',       doneCol: 'done_fr',       targetCol: 'target_fr',       label: 'Kết bạn',     handlerHint: 'campaign_send_friend_request (needs connect role + age >=14d)' },
    { key: 'joins',    doneCol: 'done_joins',    targetCol: 'target_joins',    label: 'Join group',  handlerHint: 'campaign_discover_groups (scout role, age >=14d unlocks)' },
  ]

  for (const row of kpis) {
    checked++
    const totalTarget = row.target_likes + row.target_comments + row.target_fr + row.target_joins
    if (totalTarget <= 0) continue
    const totalDone = row.done_likes + row.done_comments + row.done_fr + row.done_joins

    // Per-action shortfall analysis — find which action(s) are behind.
    const actionStatus = ACTIONS.map(a => {
      const target = row[a.targetCol]
      const done = row[a.doneCol]
      if (target <= 0) return null
      const expected = target * expectedFrac
      const gap = expected - done
      const pct = expected > 0 ? Math.round((gap / expected) * 100) : 0
      return {
        action: a.key, label: a.label, done, target,
        expected: Math.round(expected),
        gap: Math.max(0, Math.round(gap)),
        shortfall_pct: Math.max(0, pct),
        handler_hint: a.handlerHint,
        status: pct >= SHORTFALL_THRESHOLD_PCT ? 'behind' : (done >= target ? 'done' : 'on_track'),
      }
    }).filter(Boolean)

    const behindActions = actionStatus.filter(a => a.status === 'behind')
    if (behindActions.length === 0) continue

    shortfalls++

    // Dedup: only log one shortfall decision per nick per 2h
    const { rows: recent } = await pool.query(
      `SELECT id FROM hermes_decisions
       WHERE campaign_id = $1 AND decision_type = 'kpi_shortfall'
         AND target_id = $2 AND created_at > now() - INTERVAL '2 hours'
       LIMIT 1`,
      [row.campaign_id, row.account_id]
    )
    if (recent.length > 0) continue

    const diag = await diagnose(pool, row.account_id, row.campaign_id)
    if (!diag) continue

    // Build per-action plan. A nick can be "idle" globally but the
    // PER-ACTION fix varies: comments need campaign_nurture to actually
    // comment (quality gate may be rejecting), FR needs connect role etc.
    const perActionPlans = behindActions.map(a => {
      let specific = a.handler_hint
      if (a.action === 'comments' && diag.evidence.failures_24h && Object.keys(diag.evidence.failures_24h).length) {
        specific += ` · kiểm tra quality_gate rejection trong log`
      }
      if (a.action === 'fr' && diag.evidence.age_days < 14) {
        specific += ` · nick mới ${diag.evidence.age_days}d, chờ đến 14d`
      }
      if (a.action === 'joins' && diag.evidence.age_days < 14) {
        specific += ` · warmup đang chặn join_group`
      }
      return { ...a, plan: specific }
    })

    const behindSummary = behindActions.map(a => `${a.label} ${a.done}/${a.target}`).join(', ')
    await pool.query(
      `INSERT INTO hermes_decisions (campaign_id, decision_type, action_type, target_id, target_name, priority, reason, decision, auto_apply, auto_applied, outcome, outcome_detail)
       VALUES ($1, 'kpi_shortfall', 'investigate_nick_shortfall', $2, $3, $4, $5, $6, $7, false, 'success', $8)`,
      [
        row.campaign_id,
        row.account_id,
        row.username,
        diag.severity === 'high' ? 'high' : 'medium',
        `${diag.cause}. Hôm nay: ${totalDone}/${totalTarget} (${Math.round((totalDone / totalTarget) * 100)}%) · Thiếu: ${behindSummary}`,
        JSON.stringify({
          total: { done: totalDone, target: totalTarget, pct: Math.round((totalDone / totalTarget) * 100) },
          by_action: actionStatus,
          cause: diag.cause,
          plan: diag.plan,
          per_action_plan: perActionPlans,
          evidence: diag.evidence,
        }),
        diag.auto_apply,
        `cause=${diag.cause} | behind=${behindSummary}`,
      ]
    )

    // Capability bump (auto-raise +20% after 5d streak + 0 checkpoint)
    // auto_apply=true — signal is conservative enough. Next orchestrator
    // tick will pick it up and UPDATE nick_kpi_daily.
    const cap = await checkCapability(pool, row.account_id, row.campaign_id)
    if (cap.eligible_for_bump) {
      const { rows: recent } = await pool.query(
        `SELECT id FROM hermes_decisions
         WHERE campaign_id = $1 AND decision_type = 'capability_bump'
           AND target_id = $2 AND created_at > now() - INTERVAL '7 days'
         LIMIT 1`,
        [row.campaign_id, row.account_id]
      )
      if (recent.length === 0) {
        capabilities++
        await pool.query(
          `INSERT INTO hermes_decisions (campaign_id, decision_type, action_type, target_id, target_name, priority, reason, decision, auto_apply, auto_applied, outcome, outcome_detail)
           VALUES ($1, 'capability_bump', 'raise_kpi_target', $2, $3, 'low', $4, $5, true, false, 'pending', $6)`,
          [
            row.campaign_id,
            row.account_id,
            row.username,
            `${cap.streak_days} ngày liên tiếp đạt KPI, không checkpoint — auto nâng target +${cap.bump_pct}%`,
            JSON.stringify({ streak_days: cap.streak_days, bump_pct: cap.bump_pct, current_target: row.target }),
            `streak=${cap.streak_days}d bump=+${cap.bump_pct}%`,
          ]
        )
      }
    }

    // Capability nerf (auto-lower -30% when nick stressed). Checked after
    // bump so a nick can't be both — but the triggers are disjoint in
    // practice (bump requires 5d streak, nerf requires recent failure).
    // auto_apply=true for nick safety — we'd rather protect than wait for
    // user to review when checkpoint already happened.
    const nerf = await checkCapabilityNerf(pool, row.account_id, row.campaign_id)
    if (nerf.eligible_for_nerf) {
      const { rows: recentNerf } = await pool.query(
        `SELECT id FROM hermes_decisions
         WHERE campaign_id = $1 AND decision_type = 'capability_nerf'
           AND target_id = $2 AND created_at > now() - INTERVAL '3 days'
         LIMIT 1`,
        [row.campaign_id, row.account_id]
      )
      if (recentNerf.length === 0) {
        nerfs++
        await pool.query(
          `INSERT INTO hermes_decisions (campaign_id, decision_type, action_type, target_id, target_name, priority, reason, decision, auto_apply, auto_applied, outcome, outcome_detail)
           VALUES ($1, 'capability_nerf', 'lower_kpi_target', $2, $3, 'high', $4, $5, true, false, 'pending', $6)`,
          [
            row.campaign_id,
            row.account_id,
            row.username,
            `Bảo vệ nick: ${nerf.reason} — auto giảm target -${nerf.nerf_pct}% trong 7 ngày`,
            JSON.stringify({ nerf_pct: nerf.nerf_pct, reason: nerf.reason, current_target: row.target }),
            `nerf=-${nerf.nerf_pct}% reason=${nerf.reason}`,
          ]
        )
      }
    }
  }

  if (shortfalls > 0 || capabilities > 0 || nerfs > 0) {
    console.log(`[NICK-KPI] Checked ${checked} nicks · shortfalls=${shortfalls} · capability_bumps=${capabilities} · capability_nerfs=${nerfs}`)
  }

  // Auto-execute pending auto_apply=true capability decisions. Without
  // this, decisions sit forever — the regular orchestrator loop only
  // runs actions from LLM output, not from direct DB inserts.
  // Limited to raise_kpi_target / lower_kpi_target so we don't accidentally
  // auto-apply anything else the watcher might create later.
  try {
    const orchestrator = require('./hermes-orchestrator')
    const { rows: pending } = await pool.query(
      `SELECT id, campaign_id, action_type, decision, target_id, target_name, decision_type
       FROM hermes_decisions
       WHERE auto_apply = true AND auto_applied = false
         AND outcome = 'pending'
         AND action_type IN ('raise_kpi_target', 'lower_kpi_target')
       ORDER BY created_at ASC
       LIMIT 50`
    )
    let appliedCount = 0, failedCount = 0
    for (const dec of pending) {
      const actionDetail = typeof dec.decision === 'string' ? (() => { try { return JSON.parse(dec.decision) } catch { return {} } })() : (dec.decision || {})
      const action = {
        type: dec.action_type,
        target_id: dec.target_id,
        target_name: dec.target_name,
        action_detail: actionDetail,
        decision: actionDetail,
      }
      try {
        const ctx = await orchestrator.buildOrchestrationContext(dec.campaign_id, supabaseInst)
        const r = await orchestrator.executeAction(action, dec.campaign_id, ctx, supabaseInst)
        await pool.query(
          `UPDATE hermes_decisions
           SET auto_applied = $2, applied_at = now(),
               outcome = $3, outcome_detail = $4
           WHERE id = $1`,
          [dec.id, r.ok, r.ok ? 'success' : 'failed', r.detail]
        )
        if (r.ok) { appliedCount++ } else { failedCount++ }
      } catch (err) {
        failedCount++
        await pool.query(
          `UPDATE hermes_decisions SET outcome='failed', outcome_detail=$2 WHERE id=$1`,
          [dec.id, err.message]
        )
      }
    }
    if (appliedCount > 0 || failedCount > 0) {
      console.log(`[NICK-KPI] Auto-applied ${appliedCount}/${pending.length} capability decisions (${failedCount} failed)`)
    }
  } catch (err) {
    console.warn(`[NICK-KPI] Auto-apply pass failed: ${err.message}`)
  }
}

module.exports = {
  runWatcher,
  diagnose,
  checkCapability,
  checkCapabilityNerf,
  computeKpiSignalsForCampaign,
}
