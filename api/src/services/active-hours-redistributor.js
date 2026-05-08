// Recompute active_hours_start/end for all "alive" nicks of a given owner.
// Triggered event-driven (not on a cron) when nicks are added, killed, or revived.
//
// Rules (per user feedback 2026-05-03):
// - Only nicks that are currently alive count toward distribution.
//   Alive = is_active=true AND status IN ('healthy','unknown','at_risk').
// - If a nick has active_hours_locked=true, leave it alone (user pinned it).
// - Stagger windows so multiple living nicks don't pile into the same hours
//   (FB anti-pattern), and grow per-nick window when fewer nicks survive
//   (compensate KPI for the shrinking team).

const ALIVE_STATUSES = ['healthy', 'unknown', 'at_risk']

// Returns array of {start, end} integer-hour windows for n nicks, indexed
// in the same deterministic order as the caller's nick list.
function computeWindows(n) {
  if (n <= 0) return []
  if (n === 1) return [{ start: 0, end: 24 }]
  // windowSize shrinks as the team grows, floor 12h (so each nick still has
  // a usable working day even with many alive).
  const windowSize = Math.max(12, 24 - 4 * (n - 1))
  const step = (24 - windowSize) / (n - 1)
  const out = []
  for (let i = 0; i < n; i++) {
    const start = Math.round(i * step)
    let end = start + windowSize
    if (end > 24) end = 24
    out.push({ start, end })
  }
  // Make sure last window ends at 24 to keep coverage of late hours.
  if (out.length) out[out.length - 1].end = 24
  return out
}

async function redistributeActiveHours(supabase, ownerId, { reason = 'manual' } = {}) {
  if (!ownerId) return { ok: false, error: 'ownerId required' }

  const { data: nicks, error } = await supabase
    .from('accounts')
    .select('id, username, is_active, status, active_hours_start, active_hours_end, active_hours_locked')
    .eq('owner_id', ownerId)
  if (error) return { ok: false, error: error.message }

  const alive = (nicks || []).filter(n =>
    n.is_active === true &&
    ALIVE_STATUSES.includes(n.status || 'unknown') &&
    n.active_hours_locked !== true
  )
  // Deterministic order so the same set of nicks always maps to the same windows.
  alive.sort((a, b) => String(a.id).localeCompare(String(b.id)))

  const windows = computeWindows(alive.length)
  const updates = []
  for (let i = 0; i < alive.length; i++) {
    const w = windows[i]
    const n = alive[i]
    if (n.active_hours_start === w.start && n.active_hours_end === w.end) continue
    updates.push({
      id: n.id,
      username: n.username,
      from: { s: n.active_hours_start, e: n.active_hours_end },
      to: { s: w.start, e: w.end },
    })
    await supabase
      .from('accounts')
      .update({ active_hours_start: w.start, active_hours_end: w.end })
      .eq('id', n.id)
  }

  return {
    ok: true,
    reason,
    owner_id: ownerId,
    alive_count: alive.length,
    locked_count: (nicks || []).filter(n => n.active_hours_locked).length,
    dead_count: (nicks || []).length - alive.length - (nicks || []).filter(n => n.active_hours_locked).length,
    updated: updates,
  }
}

module.exports = { redistributeActiveHours, computeWindows }
