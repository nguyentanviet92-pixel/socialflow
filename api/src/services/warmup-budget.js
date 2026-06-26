/**
 * Warmup Budget Service
 *
 * FB flags new accounts that burst to full-limit activity. Limits must ramp up
 * over the first month. This module centralizes the curve so POST /accounts,
 * POST /accounts/bulk-import, and the daily rebalance cron all agree.
 *
 * Curve (audit 2026-04-12 — Thúy Thùy & Chau Hien Phuc were getting max=80 at
 * age 3-4 days, same as 100-day accounts):
 *
 *   age < 7   : like 10, comment 2,  join_group 1, friend_request 3
 *   age < 14  : like 20, comment 4,  join_group 2, friend_request 5
 *   age < 30  : like 40, comment 8,  join_group 2, friend_request 8
 *   age < 60  : like 60, comment 12, join_group 3, friend_request 10
 *   age >= 60 : like 80, comment 15, join_group 3, friend_request 10 (mature)
 *
 * `post`, `opportunity_comment`, `scan` are not on the curve — keep their
 * existing defaults (low numbers already, not an abuse vector).
 */

// Mature nick ceiling — matches HARD_LIMITS in the agent
const MATURE_BUDGET = {
  like:                { max: 150 },
  comment:             { max: 40 },
  post:                { max: 5 },
  join_group:          { max: 8 },
  friend_request:      { max: 30 },
  opportunity_comment: { max: 5 },
  scan:                { max: 30 },
}

/**
 * Returns the MAX-only shape (no `used` counter) for the given nick age.
 * Callers are responsible for merging this with existing `used` counters.
 */
function getWarmupMax(ageDays) {
  const a = Number.isFinite(ageDays) ? ageDays : 0
  if (a < 7)  return { like: 20, comment: 4,  join_group: 2, friend_request: 6  }
  if (a < 14) return { like: 40, comment: 8,  join_group: 4, friend_request: 10 }
  if (a < 30) return { like: 80, comment: 15, join_group: 4, friend_request: 16 }
  if (a < 60) return { like: 120, comment: 25, join_group: 6, friend_request: 20 }
  return { like: 150, comment: 40, join_group: 8, friend_request: 30 }
}

/**
 * Compute nick age in days from fb_created_at (preferred — real FB age) or
 * created_at (when added to the system). Returns 0 for missing/invalid dates.
 */
function getNickAgeDays({ fb_created_at, created_at } = {}) {
  const ref = fb_created_at || created_at
  if (!ref) return 0
  const ms = Date.now() - new Date(ref).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.floor(ms / 86400000)
}

/**
 * Build a full daily_budget object for a brand-new account (no prior used counters).
 * Used by POST /accounts and POST /accounts/bulk-import.
 *
 * @param {object} account - { fb_created_at?, created_at? }
 * @param {object} [override] - user-provided overrides (merged last)
 */
function buildInitialBudget(account, override = {}) {
  const age = getNickAgeDays(account)
  const curve = getWarmupMax(age)

  const budget = {}
  for (const [action, def] of Object.entries(MATURE_BUDGET)) {
    const max = (action in curve) ? curve[action] : def.max
    budget[action] = { used: 0, max }
  }
  budget.reset_at = new Date().toISOString()

  // User override takes precedence (preserves existing merge semantics in accounts.js).
  for (const [action, val] of Object.entries(override || {})) {
    if (action === 'reset_at') { budget.reset_at = val; continue }
    const existing = budget[action] || { used: 0 }
    budget[action] = { ...existing, ...(val || {}) }
  }
  return budget
}

/**
 * Daily rebalance — runs at 00:30 VN.
 * For every active account: recompute the warmup curve for the current age and
 * bump each action's `max` if it's below the curve. Does NOT lower a max that
 * has been raised manually by the user. Resets `used` counters to 0 and sets
 * `reset_at` to now.
 */
async function rebalanceWarmupBudgets(supabase) {
  const { data: accounts, error } = await supabase
    .from('accounts')
    .select('id, username, fb_created_at, created_at, daily_budget, is_active')
    .eq('is_active', true)
  if (error) {
    console.error('[WARMUP-REBALANCE] query failed:', error.message)
    return { updated: 0, error: error.message }
  }
  if (!accounts?.length) return { updated: 0 }

  const nowIso = new Date().toISOString()
  let updated = 0
  let raised = 0

  for (const acc of accounts) {
    const age = getNickAgeDays(acc)
    const curve = getWarmupMax(age)
    const current = acc.daily_budget || {}
    const next = { ...current }

    // For each curved action: reset `used` to 0, bump max up to curve value if needed.
    for (const [action, curveMax] of Object.entries(curve)) {
      const cur = current[action] || { used: 0, max: 0 }
      const curMax = Number.isFinite(cur.max) ? cur.max : 0
      // Bump up only — never lower a manual override
      const nextMax = Math.max(curMax, curveMax)
      if (nextMax !== curMax) raised++
      next[action] = { used: 0, max: nextMax }
    }
    // Also reset `used` on non-curve actions (post, scan, etc.) without touching max
    for (const [action, def] of Object.entries(MATURE_BUDGET)) {
      if (action in curve) continue
      const cur = current[action] || { used: 0, max: def.max }
      next[action] = { used: 0, max: Number.isFinite(cur.max) ? cur.max : def.max }
    }
    next.reset_at = nowIso

    const { error: upErr } = await supabase
      .from('accounts')
      .update({ daily_budget: next })
      .eq('id', acc.id)
    if (upErr) {
      console.warn(`[WARMUP-REBALANCE] ${acc.username}: update failed — ${upErr.message}`)
      continue
    }
    updated++
  }

  console.log(`[WARMUP-REBALANCE] reset+bumped ${updated} accounts (${raised} max bumps from curve)`)
  return { updated, raised }
}

module.exports = {
  MATURE_BUDGET,
  getWarmupMax,
  getNickAgeDays,
  buildInitialBudget,
  rebalanceWarmupBudgets,
}
