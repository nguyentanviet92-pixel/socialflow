/**
 * Phase 11 — KPI Calculator
 *
 * Computes per-nick daily targets for a campaign by weighting nicks
 * according to their warmup phase + health status, then upserts the
 * targets into nick_kpi_daily for today.
 *
 * Triggered:
 *   - PUT /campaigns/:id when account_ids change
 *   - POST /campaigns/:id/priority-groups (after KPI bump)
 *   - POST /campaigns/:id/rebalance-kpi (manual)
 *   - Daily cron 00:01 VN (nurture-scheduler.js)
 *   - Agent: when a nick is force-disabled (poller calls API endpoint)
 */

function getNickAgeDays(nick) {
  const created = nick.fb_created_at || nick.created_at
  if (!created) return 0
  return Math.floor((Date.now() - new Date(created).getTime()) / 86400000)
}

function nickWeight(nick) {
  const age = getNickAgeDays(nick)
  let w = 1.0
  if (age < 14) w = 0.2
  else if (age < 30) w = 0.35
  else if (age < 90) w = 0.6
  else if (age < 180) w = 0.85
  if (nick.status === 'at_risk') w *= 0.5
  return w
}

// daily_opportunity_comments defaults to 0 — only set when campaign has brand_config.
// When > 0, each nick gets a proportional target (min 1) and that target
// participates in kpi_met. Prevents opp comments from masking missing
// normal comments and vice versa.
const DEFAULT_KPI = { daily_likes: 120, daily_comments: 30, daily_friend_requests: 20, daily_group_joins: 18, daily_opportunity_comments: 0 }

// VN date (UTC+7) — both cron AND agent must use the same timezone for dates.
// The daily cron fires at 00:01 VN = 17:01 UTC, so UTC date is YESTERDAY.
// Without this, rebalance writes targets for the wrong date.
function vnToday() {
  return new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0]
}

async function rebalanceKPI(supabase, campaignId) {
  if (!campaignId) return { ok: false, reason: 'no campaign_id' }

  const { data: campaign, error: cErr } = await supabase
    .from('campaigns')
    .select('id, kpi_config, brand_config, campaign_roles(account_ids), account_ids')
    .eq('id', campaignId)
    .single()
  if (cErr || !campaign) return { ok: false, reason: cErr?.message || 'campaign not found' }

  const allNickIds = [
    ...new Set([
      ...((campaign.campaign_roles || []).flatMap(r => r.account_ids || [])),
      ...(campaign.account_ids || []),
    ])
  ]
  if (allNickIds.length === 0) {
    console.log(`[KPI] Campaign ${campaignId.slice(0,8)} has no nicks — nothing to rebalance`)
    return { ok: true, nicks: 0 }
  }

  // Fix: only filter by is_active, not status. Expired/unknown nicks still
  // get KPI rows so they don't bypass the gate when they come back online.
  const { data: nicks } = await supabase
    .from('accounts')
    .select('id, status, fb_created_at, created_at')
    .in('id', allNickIds)
    .eq('is_active', true)

  if (!nicks?.length) {
    console.log(`[KPI] Campaign ${campaignId.slice(0,8)} has no eligible nicks`)
    return { ok: true, nicks: 0 }
  }

  let weighted = nicks.map(n => ({ id: n.id, weight: nickWeight(n) }))
  let totalWeight = weighted.reduce((s, n) => s + n.weight, 0)
  // Guard: if all weights = 0 (all nicks very young), distribute equally
  if (totalWeight === 0) {
    weighted = weighted.map(n => ({ ...n, weight: 1 }))
    totalWeight = weighted.length
  }

  const kpi = { ...DEFAULT_KPI, ...(campaign.kpi_config || {}) }

  // Auto-derive opportunity target when campaign has brand_config but user
  // hasn't set kpi_config.daily_opportunity_comments explicitly. 2/nick/day
  // is the hard cap from warmup-budget.js — matches what the nurture handler
  // actually allows. User can override via kpi_config to scale ad campaigns.
  const hasBrand = !!(campaign.brand_config?.brand_name)
  if (hasBrand && !(Number(campaign.kpi_config?.daily_opportunity_comments) > 0)) {
    kpi.daily_opportunity_comments = nicks.length * 2
  }

  const today = vnToday()

  const oppTarget = Number(kpi.daily_opportunity_comments) || 0
  const rows = weighted.map(n => {
    const share = n.weight / totalWeight
    return {
      campaign_id: campaignId,
      account_id: n.id,
      date: today,
      // Minimum targets so target is never 0 (prevents kpi_met=true bypass).
      // Opportunity: no floor when daily=0 (campaign has no brand) — stays 0
      // so kpi_met ignores it. When daily>0, floor at 1 so each nick owes
      // at least one QC comment.
      target_likes: Math.max(5, Math.round(kpi.daily_likes * share)),
      target_comments: Math.max(2, Math.round(kpi.daily_comments * share)),
      target_friend_requests: Math.max(1, Math.round(kpi.daily_friend_requests * share)),
      target_group_joins: Math.max(1, Math.round(kpi.daily_group_joins * share)),
      target_opportunity_comments: oppTarget > 0 ? Math.max(1, Math.round(oppTarget * share)) : 0,
      kpi_met: false,
    }
  })

  const { error: upErr } = await supabase
    .from('nick_kpi_daily')
    .upsert(rows, { onConflict: 'campaign_id,account_id,date' })
  if (upErr) {
    console.warn(`[KPI] upsert failed: ${upErr.message}`)
    return { ok: false, reason: upErr.message }
  }

  console.log(`[KPI] Rebalanced ${nicks.length} nicks for campaign ${campaignId.slice(0,8)} date=${today} (total weight ${totalWeight.toFixed(2)}, targets: L${rows[0]?.target_likes}/C${rows[0]?.target_comments})`)
  return { ok: true, nicks: nicks.length, totalWeight, targets: rows }
}

async function rebalanceAllActive(supabase) {
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name')
    .eq('is_active', true)
  let n = 0
  for (const c of campaigns || []) {
    try {
      const r = await rebalanceKPI(supabase, c.id)
      if (r.ok) n++
    } catch (err) {
      console.warn(`[KPI] daily rebalance ${c.id} failed: ${err.message}`)
    }
  }
  console.log(`[KPI] Daily rebalance: ${n}/${(campaigns || []).length} campaigns`)
  return n
}

module.exports = { rebalanceKPI, rebalanceAllActive, nickWeight, getNickAgeDays, DEFAULT_KPI, vnToday }
