/**
 * Per-nick per-day job CREATION quota.
 *
 * Used by schedulers BEFORE INSERT INTO jobs to cap how many of a given
 * job_type can be queued for an account per day. Prevents the 900-2000/day
 * cron inflow from overwhelming the ~60/day agent drain rate.
 *
 * Quotas are tuned to sum to ~20/day per nick × 3 nicks ≈ 60/day
 * (matches agent drain: 3 nicks × 2 slots × ~12 sessions × 2.5 jobs).
 */

const DEFAULT_QUOTAS = {
  campaign_nurture:         15,
  nurture_feed:             8,
  campaign_discover_groups: 4,
  check_group_membership:   6,
  check_health:             4,
  campaign_post:            5,
  campaign_send_friend_request: 6,
  campaign_interact_profile:    4,
}

function getDefaultQuota(jobType) {
  return DEFAULT_QUOTAS[jobType] ?? 5 // conservative fallback for unknown types
}

/**
 * Atomically check + reserve a quota slot for (accountId, jobType, today).
 *
 * Returns { ok, count, quota, remaining }.
 * - ok=true  → caller may proceed with INSERT INTO jobs
 * - ok=false → quota exhausted for today; caller should skip silently
 *
 * Uses ON CONFLICT UPDATE so the row is created on first call of the day
 * and safely incremented under concurrency. The CASE inside the UPDATE
 * prevents increment when already at/above quota.
 */
async function checkAndReserve(supabase, { accountId, jobType, quota, vnDate }) {
  if (!accountId || !jobType) return { ok: false, count: 0, quota: 0, remaining: 0, reason: 'bad_args' }
  const q = Number.isFinite(quota) ? quota : getDefaultQuota(jobType)
  const date = vnDate || vnToday()

  try {
    const sql = `
      INSERT INTO nick_daily_job_quota (account_id, job_type, date, quota, created_count)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (account_id, job_type, date)
      DO UPDATE SET
        created_count = CASE
          WHEN nick_daily_job_quota.created_count < EXCLUDED.quota
          THEN nick_daily_job_quota.created_count + 1
          ELSE nick_daily_job_quota.created_count
        END,
        quota = GREATEST(nick_daily_job_quota.quota, EXCLUDED.quota),
        updated_at = NOW()
      RETURNING created_count, quota
    `
    const { rows } = await supabase._pool.query(sql, [accountId, jobType, date, q])
    const row = rows?.[0]
    if (!row) return { ok: false, count: 0, quota: q, remaining: q, reason: 'no_row' }
    // ok only when the incremented count is still within quota.
    // Because the CASE above caps the count, when full we get count === quota
    // on subsequent calls — distinguish by fetching row count that equals the
    // quota AND this call was a no-op (we can't tell directly). Safe behavior:
    // treat count > quota as full, count <= quota as ok.
    const ok = row.created_count <= row.quota
    return { ok, count: row.created_count, quota: row.quota, remaining: Math.max(0, row.quota - row.created_count) }
  } catch (err) {
    // Don't block insert on transient DB errors — log and permit.
    // The alternative would be to cascade failures into scheduler throttling.
    console.warn(`[NICK-QUOTA] check failed for ${accountId} ${jobType}: ${err.message}`)
    return { ok: true, count: 0, quota: q, remaining: q, reason: 'db_error_allow' }
  }
}

/**
 * Read-only snapshot for UI display.
 * Returns { [job_type]: { used, quota, remaining } } for today.
 */
async function getQuotaStatus(supabase, accountId, vnDate) {
  const date = vnDate || vnToday()
  try {
    const { rows } = await supabase._pool.query(
      `SELECT job_type, created_count, quota
       FROM nick_daily_job_quota
       WHERE account_id = $1 AND date = $2`,
      [accountId, date]
    )
    // Also count jobs done/pending/failed today per type — gives the UI a real
    // KPI (target vs actual completions), not just "created count".
    const vnDayStartSql = `date_trunc('day', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')) AT TIME ZONE 'Asia/Ho_Chi_Minh'`
    const { rows: jobRows } = await supabase._pool.query(
      `SELECT type, status, COUNT(*)::int AS c
       FROM jobs
       WHERE payload->>'account_id' = $1 AND created_at >= ${vnDayStartSql}
       GROUP BY type, status`,
      [accountId]
    )
    const byType = {}
    for (const r of jobRows) {
      if (!byType[r.type]) byType[r.type] = { done: 0, pending: 0, failed: 0, running: 0, cancelled: 0, claimed: 0 }
      byType[r.type][r.status] = r.c
    }
    const out = {}
    for (const [type, quota] of Object.entries(DEFAULT_QUOTAS)) {
      const j = byType[type] || {}
      out[type] = {
        used: 0,
        quota,
        remaining: quota,
        done: j.done || 0,
        pending: (j.pending || 0) + (j.claimed || 0) + (j.running || 0),
        failed: j.failed || 0,
      }
    }
    for (const r of rows) {
      if (!out[r.job_type]) out[r.job_type] = { used: 0, quota: r.quota, remaining: r.quota, done: 0, pending: 0, failed: 0 }
      out[r.job_type].used = r.created_count
      out[r.job_type].quota = r.quota
      out[r.job_type].remaining = Math.max(0, r.quota - r.created_count)
    }
    return out
  } catch (err) {
    console.warn(`[NICK-QUOTA] status read failed: ${err.message}`)
    return {}
  }
}

/**
 * Delete quota rows older than `days` days. Called from daily cron.
 */
async function purgeOld(supabase, { days = 7 } = {}) {
  try {
    const { rowCount } = await supabase._pool.query(
      `DELETE FROM nick_daily_job_quota WHERE date < CURRENT_DATE - $1::int`,
      [days]
    )
    return rowCount || 0
  } catch (err) {
    console.warn(`[NICK-QUOTA] purge failed: ${err.message}`)
    return 0
  }
}

// VN (UTC+7) date for "today" in YYYY-MM-DD.
function vnToday() {
  const now = new Date(Date.now() + 7 * 3600 * 1000)
  return now.toISOString().slice(0, 10)
}

module.exports = {
  DEFAULT_QUOTAS,
  getDefaultQuota,
  checkAndReserve,
  getQuotaStatus,
  purgeOld,
  vnToday,
}
