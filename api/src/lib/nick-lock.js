/**
 * Nick Lock — Prevents AI Pilot and Nurture from running on the same nick simultaneously
 *
 * Both schedulers call isNickBusy() before creating jobs.
 * A nick is "busy" if it has ANY pending/claimed/running job (regardless of system).
 */

const JANITORIAL_TYPES = new Set([
  'check_group_membership', 'check_health', 'check_engagement',
  'fetch_source_cookie', 'nurture_feed', 'warmup_browse',
  'check_comment_engagement',
])

function getClient() {
  return require('./supabase').supabase
}

/**
 * Check if a nick has any active job (pending/claimed/running)
 * Works across ALL job types — so nurture won't conflict with campaign and vice versa
 *
 * Uses DB-level JSONB filter (payload->>account_id) to avoid fetching all jobs.
 *
 * @param {string} accountId - The account UUID
 * @returns {Promise<{busy: boolean, activeJob?: {id, type, status}}>}
 */
async function isNickBusy(accountId) {
  const sb = getClient()

  const { data: jobs } = await sb
    .from('jobs')
    .select('id, type, status')
    .in('status', ['pending', 'claimed', 'running'])
    .filter('payload->>account_id', 'eq', accountId)
    .limit(1)

  if (jobs?.length) {
    return {
      busy: true,
      activeJob: { id: jobs[0].id, type: jobs[0].type, status: jobs[0].status }
    }
  }

  return { busy: false }
}

/**
 * Batch check: which account IDs are currently busy
 * More efficient than calling isNickBusy() N times
 *
 * Filters by account_id at DB level — no .limit() needed since query is scoped.
 * Handles Supabase JSONB filter via .or() with payload->>account_id conditions.
 *
 * @param {string[]} accountIds
 * @returns {Promise<Set<string>>} Set of busy account IDs
 */
async function getBusyNicks(accountIds) {
  if (!accountIds.length) return new Set()

  const sb = getClient()

  // Build OR filter for all account IDs at DB level
  // payload->>account_id filters within JSONB — no need to fetch all jobs
  const orConditions = accountIds
    .map(id => `payload->>account_id.eq.${id}`)
    .join(',')

  const { data: jobs, error } = await sb
    .from('jobs')
    .select('id, type, payload')
    .in('status', ['pending', 'claimed', 'running'])
    .or(orConditions)

  if (error) {
    // Fallback: chunked individual queries if .or() fails (too many IDs)
    console.warn(`[NICK-LOCK] OR filter failed (${accountIds.length} IDs): ${error.message}, falling back to chunked`)
    return getBusyNicksFallback(accountIds)
  }

  const busySet = new Set()
  for (const j of (jobs || [])) {
    if (JANITORIAL_TYPES.has(j.type)) continue
    const accId = j.payload?.account_id
    if (accId) busySet.add(accId)
  }

  return busySet
}

/**
 * Fallback for getBusyNicks when .or() filter has too many conditions.
 * Queries in chunks of 10 account IDs.
 */
async function getBusyNicksFallback(accountIds) {
  const sb = getClient()
  const busySet = new Set()
  const CHUNK = 10

  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const chunk = accountIds.slice(i, i + CHUNK)
    const orConditions = chunk.map(id => `payload->>account_id.eq.${id}`).join(',')

    const { data: jobs } = await sb
      .from('jobs')
      .select('id, type, payload')
      .in('status', ['pending', 'claimed', 'running'])
      .or(orConditions)

    for (const j of (jobs || [])) {
      if (JANITORIAL_TYPES.has(j.type)) continue
      const accId = j.payload?.account_id
      if (accId) busySet.add(accId)
    }
  }

  return busySet
}

// Janitorial/diagnostic jobs don't block user-facing work. Without this
// filter, a nick with 100+ pending `check_group_membership` jobs hits
// MAX_PENDING_PER_NICK=3 → scheduler silently refuses to create any
// new campaign_nurture / friend_request → nick stalls for hours.
// Observed 2026-04-21: Diệu 159 membership pending, 0 nurture created
// in 9h despite cron firing 8×/day.

/**
 * Return a Map<accountId, count> of USER-FACING pending/claimed/running
 * jobs per nick. Janitorial/diagnostic types are excluded — they queue
 * in large volumes independently and would starve the real work queue.
 */
async function getNickPendingCounts(accountIds) {
  if (!accountIds?.length) return new Map()
  const sb = getClient()
  const counts = new Map()
  const CHUNK = 10
  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const chunk = accountIds.slice(i, i + CHUNK)
    const orConditions = chunk.map(id => `payload->>account_id.eq.${id}`).join(',')
    const { data: rows } = await sb
      .from('jobs')
      .select('type, payload')
      .in('status', ['pending', 'claimed', 'running'])
      .or(orConditions)
    for (const j of rows || []) {
      const accId = j.payload?.account_id
      if (!accId) continue
      if (JANITORIAL_TYPES.has(j.type)) continue
      counts.set(accId, (counts.get(accId) || 0) + 1)
    }
  }
  return counts
}

/**
 * Cap a nick's total pending jobs across all types / campaigns.
 * Raised slightly above the 2-slot agent concurrency to leave a little
 * buffer for checks (check_health / check_group_membership) to sneak
 * through without blocking user-facing nurture work.
 */
const MAX_PENDING_PER_NICK = 3

module.exports = { isNickBusy, getBusyNicks, getNickPendingCounts, MAX_PENDING_PER_NICK }
