/**
 * Campaign Handler: Nurture Group (Role: nurture)
 * Visit joined groups, like posts, leave natural comments
 * Uses desktop Facebook with JS-based interaction (bypasses overlay interception)
 * Comments use mobile Facebook URL per-post (proven in comment-post.js)
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove } = require('../../browser/human')
const { checkAccountStatus, saveDebugScreenshot } = require('./post-utils')
const { checkHardLimit, SessionTracker, applyAgeFactor, getNickAgeDays } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const { getActionParams } = require('../../lib/plan-executor')
const { generateComment, generateOpportunityComment } = require('../../lib/ai-comment')
const { evaluatePosts, qualityGateComment, generateSmartComment, evaluateLeadQuality, scanGroupPosts, getBestPosts, detectGroupLanguage } = require('../../lib/ai-brain')
const { getSelectors, toMobileUrl, COMMENT_INPUT_SELECTORS, COMMENT_SUBMIT_SELECTORS, COMMENT_LINK_SELECTORS } = require('../../lib/mobile-selectors')
const { ActivityLogger } = require('../../lib/activity-logger')

// Group visit rate limit — max 2 nicks per group per 30 min (module-level cache)
const groupVisitCache = new Map() // groupFbId → [{accountId, timestamp}]
const GROUP_VISIT_WINDOW = 30 * 60 * 1000 // 30 min

// Inverse of toMobileUrl. comment-post.js uses desktop URLs for permalinks
// (despite an old comment claiming mobile is "proven") and the desktop layout
// has the richer set of comment-input selectors. Used by S5 newtab fallback.
function toDesktopUrl(url) {
  if (!url) return ''
  return url.replace(/:\/\/(m|mbasic|mtouch)\.facebook\.com/, '://www.facebook.com')
}

// === Group performance tracking helpers ===
// 2026-05-05: parse FB-relative timestamps to days. Returns null if can't
// determine (no timestamp visible). Used to filter out old posts so the
// agent doesn't comment on stale content (looks like a bot scraping
// archives). Examples seen on FB:
//   "Vừa xong" / "Just now"            → 0
//   "30 phút" / "30 mins"              → 0
//   "3 giờ" / "3h" / "3 hours ago"     → 0
//   "2 ngày" / "2d" / "2 days ago"     → 2
//   "5 tuần" / "5 weeks ago"           → 35
//   "3 tháng" / "3 months ago"         → 90
//   "1 năm"                            → 365
function parsePostAgeDays(text) {
  if (!text) return null
  const t = String(text).toLowerCase()
  // Vietnamese + English
  const m = t.match(/(\d+)\s*(năm|year|tháng|month|tuần|week|ngày|day|giờ|hour|h\b|d\b|w\b|mo\b|y\b|phút|min)/i)
  if (!m) {
    if (/vừa xong|just now|moments? ago/i.test(t)) return 0
    return null
  }
  const n = parseInt(m[1])
  const unit = m[2].toLowerCase()
  // Order: longest/specific first; English single-letter aliases last with
  // `^…$` anchors so they don't accidentally match Vietnamese substrings
  // (e.g. `y\b` would match end of "ngày").
  if (/năm|tháng|tuần|ngày|giờ|phút/.test(unit)) {
    if (/năm/.test(unit)) return n * 365
    if (/tháng/.test(unit)) return n * 30
    if (/tuần/.test(unit)) return n * 7
    if (/ngày/.test(unit)) return n
    return 0 // giờ / phút
  }
  if (/year/.test(unit)) return n * 365
  if (/month/.test(unit)) return n * 30
  if (/week/.test(unit)) return n * 7
  if (/day/.test(unit)) return n
  if (/hour|min/.test(unit)) return 0
  // Single-letter aliases — anchored
  if (/^y$/.test(unit)) return n * 365
  if (/^mo$/.test(unit)) return n * 30
  if (/^w$/.test(unit)) return n * 7
  if (/^d$/.test(unit)) return n
  if (/^h$/.test(unit)) return 0
  return null
}

async function recordGroupSkip(supabase, accountId, fbGroupId) {
  if (!supabase || !fbGroupId) return
  try {
    // Increment consecutive_skips, fetch new value
    const { data: cur } = await supabase.from('fb_groups')
      .select('consecutive_skips')
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId).single()
    const next = (cur?.consecutive_skips || 0) + 1
    await supabase.from('fb_groups')
      .update({ consecutive_skips: next })
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId)
  } catch {}
}

async function recordGroupYield(supabase, accountId, fbGroupId, eligibleCount) {
  if (!supabase || !fbGroupId) return
  try {
    const { data: cur } = await supabase.from('fb_groups')
      .select('total_yields')
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId).single()
    await supabase.from('fb_groups')
      .update({
        consecutive_skips: 0, // reset
        last_yield_at: new Date().toISOString(),
        total_yields: (cur?.total_yields || 0) + eligibleCount,
      })
      .eq('account_id', accountId).eq('fb_group_id', fbGroupId)
  } catch {}
}
const GROUP_VISIT_MAX = 2

function canVisitGroup(groupFbId, accountId) {
  const now = Date.now()
  const visits = (groupVisitCache.get(groupFbId) || []).filter(v => now - v.timestamp < GROUP_VISIT_WINDOW)
  groupVisitCache.set(groupFbId, visits)
  // Own visit doesn't count against limit
  const otherVisits = visits.filter(v => v.accountId !== accountId)
  return otherVisits.length < GROUP_VISIT_MAX
}

function recordGroupVisit(groupFbId, accountId) {
  const visits = groupVisitCache.get(groupFbId) || []
  visits.push({ accountId, timestamp: Date.now() })
  groupVisitCache.set(groupFbId, visits)
}

async function campaignNurture(payload, supabase) {
  const { account_id, campaign_id, role_id, config, read_from, parsed_plan } = payload
  let { topic: rawTopic } = payload
  const startTime = Date.now()

  // 2026-05-04: scheduler-emitted jobs often have empty payload.topic, which
  // crashed downstream at `topic.toLowerCase()` (line ~553). Backfill from
  // campaigns row when missing — same fix as scout handler.
  if (!rawTopic && campaign_id) {
    try {
      const { data: c } = await supabase.from('campaigns').select('topic').eq('id', campaign_id).single()
      if (c?.topic) rawTopic = c.topic
    } catch {}
  }

  // Build full topic from: plan keywords + topic field + requirement
  // This ensures AI filter + keyword fallback use ALL relevant terms
  const planKeywords = (Array.isArray(parsed_plan) ? parsed_plan : [])
    .flatMap(s => s.params?.keywords || [])
    .filter(Boolean)
  const topicParts = [rawTopic, ...planKeywords].filter(Boolean)
  const topic = [...new Set(topicParts.map(t => t.trim().toLowerCase()))].join(', ') || rawTopic || ''

  // Activity logger — logs every action for AI analysis
  const logger = new ActivityLogger(supabase, {
    campaign_id, role_id, account_id,
    job_id: payload.job_id,
    owner_id: payload.owner_id || payload.created_by,
  })

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  const likeBudget = account.daily_budget?.like || { used: 0, max: 80 }
  const commentBudget = account.daily_budget?.comment || { used: 0, max: 25 }

  const tracker = new SessionTracker()
  const nickAge = getNickAgeDays(account)

  const likeCheck = checkHardLimit('like', likeBudget.used, 0)
  const commentCheck = checkHardLimit('comment', commentBudget.used, 0)

  // Phase 1+2: load campaign.language for filtering + scoring
  let campaignLanguage = 'vi'
  if (campaign_id) {
    try {
      const { data: _cl } = await supabase.from('campaigns').select('language').eq('id', campaign_id).single()
      if (_cl?.language) campaignLanguage = _cl.language
    } catch {}
  }

  // ── Ad config: load brand settings for opportunity comments ──
  // Brand config: prefer top-level brand_config (from new SaaS form),
  // fall back to legacy config.advertising shape
  const brandConfig = payload.brand_config || config?.brand_config || config?.advertising || null
  const adEnabled = brandConfig && (payload.ad_mode === 'ad_enabled' || config?.ad_mode === 'ad_enabled' || brandConfig.brand_name)

  const vnToday = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)

  // Fetch KPI target for today (set via Campaign KPI Modal)
  let kpiAdLimit = null
  let kpiAdDone = 0
  if (campaign_id) {
    try {
      const { data: kpiRow } = await supabase.from('nick_kpi_daily')
        .select('target_opportunity_comments, done_opportunity_comments')
        .eq('campaign_id', campaign_id)
        .eq('account_id', account_id)
        .eq('date', vnToday)
        .maybeSingle()
      if (kpiRow) {
        kpiAdLimit = kpiRow.target_opportunity_comments ?? 0
        kpiAdDone = kpiRow.done_opportunity_comments ?? 0
      }
    } catch {}
  }

  // Fallback to global account budget if KPI row doesn't exist
  const nickAdBudget = account.daily_budget?.opportunity_comment || { max: 0, used: 0 }
  const nickAdAutoDetect = nickAdBudget.auto_detect !== false

  // Determine actual daily limit (KPI takes precedence, even if 0. Fallback if null)
  const AD_COMMENT_DAILY_LIMIT = kpiAdLimit !== null ? kpiAdLimit : (nickAdBudget.max ?? 0)

  // Nick must be >= 7 days old (was 30, relaxed for faster activation)
  const canDoAdComment = adEnabled && nickAge >= 7 && AD_COMMENT_DAILY_LIMIT > 0 && nickAdAutoDetect

  // Count today's ad comments for this nick (using KPI done count or querying log)
  let adCommentsToday = kpiAdDone
  if (canDoAdComment && kpiAdDone === 0) {
    try {
      const { count } = await supabase
        .from('campaign_activity_log')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', account_id)
        .eq('action_type', 'opportunity_comment')
        .gte('created_at', vnToday + 'T00:00:00+07:00')
      adCommentsToday = count || 0
    } catch {}
  }

  if (canDoAdComment) {
    console.log(`[NURTURE] 📢 Ad comment enabled for ${account.username}: ${adCommentsToday}/${AD_COMMENT_DAILY_LIMIT} today (auto_detect=${nickAdAutoDetect}, source=${kpiAdLimit !== null ? 'KPI' : 'Budget'})`)
  }

  // Apply age factor for newer accounts
  const maxLikesSession = applyAgeFactor(likeCheck.remaining, nickAge)
  const maxCommentsSession = applyAgeFactor(commentCheck.remaining, nickAge)

  if (!likeCheck.allowed && !commentCheck.allowed) {
    throw new Error('SKIP_nurture_budget_exceeded')
  }

  // Get groups — from target_queue (workflow chaining) or account's joined groups
  let groups = []
  if (read_from) {
    const { data: queueEntries } = await supabase
      .from('target_queue')
      .select('*')
      .eq('campaign_id', campaign_id)
      .eq('target_role_id', role_id)
      .eq('status', 'pending')
      .order('active_score', { ascending: false })
      .limit(5)

    if (queueEntries?.length) {
      const seen = new Set()
      for (const entry of queueEntries) {
        if (entry.source_group_name && !seen.has(entry.source_group_name)) {
          seen.add(entry.source_group_name)
          const { data: grp } = await supabase
            .from('fb_groups')
            .select('fb_group_id, name, url')
            .eq('account_id', account_id)
            .ilike('name', `%${entry.source_group_name}%`)
            .limit(1)
            .single()
          if (grp) groups.push(grp)
        }
      }
      if (groups.length > 0) {
        const ids = queueEntries.map(e => e.id)
        await supabase.from('target_queue').update({ status: 'done', processed_at: new Date() }).in('id', ids)
      }
      console.log(`[NURTURE] Got ${groups.length} groups from workflow queue`)
    }
  }

  if (!groups.length && campaign_id) {
    // Phase 9: read groups via campaign_groups junction (campaign-scoped, per-nick assigned)
    const { data: junctionRows } = await supabase
      .from('campaign_groups')
      .select('id, score, tier, status, last_nurtured_at, fb_groups!inner(id, fb_group_id, name, url, member_count, topic, tags, joined_via_campaign_id, ai_relevance, user_approved, consecutive_skips, last_yield_at, total_yields, language, score_tier, engagement_rate, ai_join_score, is_member, pending_approval, priority_visit, is_blocked, global_score)')
      .eq('campaign_id', campaign_id)
      .eq('assigned_nick_id', account_id)
      .eq('status', 'active')
    // Flatten: keep one row per group with junction fields merged
    const junctionGroups = (junctionRows || [])
      .map(r => r.fb_groups && ({
        ...r.fb_groups,
        // Junction tier/score take precedence over global fb_groups values
        score_tier: r.tier || r.fb_groups.score_tier,
        _junction_id: r.id,
        _junction_score: r.score,
        _junction_tier: r.tier,
        _junction_last_nurtured: r.last_nurtured_at,
      }))
      .filter(Boolean)
      // Still enforce membership gates (junction status can lag)
      .filter(g => g.is_member === true && g.pending_approval === false)
      .filter(g => !g.is_blocked)
      .filter(g => g.user_approved !== false)
    if (junctionGroups.length > 0) {
      groups = junctionGroups
      console.log(`[NURTURE] Phase 9: ${groups.length} groups from campaign_groups junction (nick ${account_id.slice(0,8)})`)
    }
  }

  if (!groups.length) {
    // Legacy fallback: fb_groups direct query (old campaigns without junction backfill)
    const { data: labeledGroups } = await supabase.from('fb_groups')
      .select('id, fb_group_id, name, url, member_count, topic, tags, joined_via_campaign_id, ai_relevance, user_approved, consecutive_skips, last_yield_at, total_yields, language, score_tier, engagement_rate, ai_join_score, is_member, pending_approval, priority_visit')
      .eq('account_id', account_id)
      .eq('is_member', true)
      .eq('pending_approval', false)
      .or('is_blocked.is.null,is_blocked.eq.false')
      .or('user_approved.is.null,user_approved.eq.true')

    const allLabeled = (labeledGroups || []).filter(g => {
      // Phase 2: skip tier D entirely (low-quality groups)
      if (g.score_tier === 'D') return false
      // Group phải có ÍT NHẤT 1 trong: tags, topic, campaign_id
      const hasTags = g.tags?.length > 0
      const hasTopic = g.topic && g.topic.trim().length > 0
      const hasCampaign = g.joined_via_campaign_id
      return hasTags || hasTopic || hasCampaign
    })

    if (!allLabeled.length) {
      console.log(`[NURTURE] Không có group nào được gán nhãn — cần scout trước`)
    } else if (!topic) {
      groups = allLabeled
      console.log(`[NURTURE] Dùng ${groups.length} groups đã gán nhãn (không có topic filter)`)
    } else {
      const topicLower = topic.toLowerCase()
      const topicKeywords = topicLower.split(/[\s,]+/).filter(k => k.length > 2)

      // Filter: chỉ group match topic qua tags/topic field/campaign
      groups = allLabeled.filter(g => {
        // Match qua tags
        if (g.tags?.some(tag => topicKeywords.some(kw => tag.toLowerCase().includes(kw) || kw.includes(tag.toLowerCase())))) return true
        // Match qua topic field
        if (g.topic) {
          const gt = g.topic.toLowerCase()
          if (gt.includes(topicLower) || topicLower.includes(gt) || topicKeywords.some(kw => gt.includes(kw))) return true
        }
        // Match qua campaign
        if (g.joined_via_campaign_id === campaign_id) return true
        // AI cache approved
        const topicKey = topicLower.trim().replace(/\s+/g, '_').slice(0, 50)
        const cached = g.ai_relevance?.[topicKey]
        if (cached?.relevant && cached.score >= 5) return true
        return false
      })

      console.log(`[NURTURE] ${groups.length}/${allLabeled.length} groups gán nhãn match topic "${topic}"`)
    }

    // 2026-05-05: language hard filter — campaign.language=vi → ONLY visit
    // groups marked vi (or unknown — give benefit of doubt). EN groups joined
    // by the nick are skipped entirely, not counted toward any KPI for this
    // campaign. User rule: "EN nhóm bỏ qua không cho vào kpi vì camp chỉ
    // dành cho tiếng việt". Mixed campaigns visit everything.
    if (campaignLanguage && campaignLanguage !== 'mixed') {
      const before = groups.length
      groups = groups.filter(g => {
        const gl = (g.language || '').toLowerCase()
        if (!gl || gl === 'unknown') return true
        return gl === campaignLanguage
      })
      const filtered = before - groups.length
      if (filtered > 0) {
        console.log(`[NURTURE] Lang filter: dropped ${filtered} non-${campaignLanguage} groups (campaign=${campaignLanguage}-only)`)
      }
    }

    // ── SMART ROTATION: ưu tiên group có score cao + recent yield ──
    // Score-based sort: tier1 (>=8) → tier2 (5-7) → tier3 (<5)
    // Penalty: groups with consecutive_skips >= 2 đẩy xuống cuối
    if (groups.length > 1) {
      const topicKey = (topic || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)

      const scoreOf = (g) => {
        const cached = g.ai_relevance?.[topicKey]
        return cached?.score || 5
      }

      // Get recent visits to deprioritize same-group repeats within session
      const { data: recentVisits } = await supabase
        .from('campaign_activity_log')
        .select('target_name')
        .eq('campaign_id', campaign_id)
        .eq('action_type', 'visit_group')
        .eq('account_id', account_id)
        .order('created_at', { ascending: false })
        .limit(groups.length)
      const recentNames = (recentVisits || []).map(v => v.target_name)

      // Use AI relevance score (already cached) for brand priority.
      const tierRank = { A: 0, B: 1, C: 2, D: 3 }
      groups.sort((a, b) => {
        // 0. priority_visit (user-pinned) ALWAYS wins over tier ranking.
        // 2026-05-07: per-nick pin from CampaignHub UI — when user marks a
        // group with the priority checkbox, agent must visit + comment here
        // BEFORE tier-A groups. Multiple pinned groups stay in their relative
        // order (fall through to lower tiers below).
        const pa = a.priority_visit === true ? 0 : 1
        const pb = b.priority_visit === true ? 0 : 1
        if (pa !== pb) return pa - pb

        // 1. score_tier (A → B → C)
        const ta = tierRank[a.score_tier || 'C']
        const tb = tierRank[b.score_tier || 'C']
        if (ta !== tb) return ta - tb

        // 1. Penalize consecutive skips heavily — push to bottom
        const skipsA = a.consecutive_skips || 0
        const skipsB = b.consecutive_skips || 0
        if (skipsA >= 3 && skipsB < 3) return 1
        if (skipsB >= 3 && skipsA < 3) return -1

        // 2. Sort by AI relevance score (higher first)
        const sa = scoreOf(a)
        const sb = scoreOf(b)
        if (sa !== sb) return sb - sa

        // 3. Member count — prefer larger groups (more reach per comment).
        //    2026-05-04: user explicitly asked for member-count priority.
        //    Comparing log-scaled buckets so 1k-vs-2k stays a tie but
        //    1k-vs-100k strongly prefers the 100k group.
        const ma = Math.log10(Math.max(1, a.member_count || 1))
        const mb = Math.log10(Math.max(1, b.member_count || 1))
        if (Math.abs(ma - mb) >= 0.5) return mb - ma // ≥3x size difference

        // 4. Tiebreaker: prefer groups not visited recently
        const aRecent = recentNames.indexOf(a.name)
        const bRecent = recentNames.indexOf(b.name)
        if (aRecent === -1 && bRecent !== -1) return -1
        if (bRecent === -1 && aRecent !== -1) return 1

        // 5. Final tiebreaker: random
        return Math.random() - 0.5
      })

      console.log(`[NURTURE] Smart rotation: ${groups.slice(0, 5).map(g => `${g.name?.substring(0, 20)}(s:${scoreOf(g)},sk:${g.consecutive_skips || 0})`).join(' → ')}`)
    }
  }

  // Phase 12: no groups → run scout inline (unconditionally).
  // Previously gated on parsed_plan having a join_group step, but the nurture
  // role's parsed_plan rarely has join_group (that lives on the scout role).
  // Scout handler still gates join_group by the nick's daily budget, so
  // triggering inline is safe — worst case it no-ops.
  if (!groups?.length) {
    console.log(`[NURTURE] No groups joined — running inline scout for topic: ${topic}`)
    try {
      const discoverHandler = require('./campaign-discover-groups')
      const scoutResult = await discoverHandler(payload, supabase)
      console.log(`[NURTURE] Scout done: joined ${scoutResult.groups_joined} groups`)

      // Re-fetch + re-filter after scout
      const { data: newGroups } = await supabase
        .from('fb_groups')
        .select('id, fb_group_id, name, url, member_count, ai_relevance')
        .eq('account_id', account_id)

      if (topic && newGroups?.length) {
        try {
          const { filterRelevantGroups } = require('../../lib/ai-filter')
          groups = await filterRelevantGroups(newGroups, topic, payload.owner_id, account_id, supabase)
          console.log(`[NURTURE] Post-scout AI filtered: ${groups.length}/${newGroups.length}`)
        } catch {
          groups = newGroups || []
        }
      } else {
        groups = newGroups || []
      }
    } catch (err) {
      console.warn(`[NURTURE] Inline scout failed: ${err.message}`)
    }
  }

  if (!groups?.length) throw new Error('SKIP_no_groups_joined')

  // Phase 2: keep tier order (A → B → C); only randomize among the top tier slice.
  // 2026-05-06: bumped 1-3 → 3-5 per user request (more coverage per session).
  // Also reserve 1 slot for a group with no Hermes ai_relevance for the current
  // topic — guarantees evaluation coverage spreads across all joined groups
  // even when low-tier groups would otherwise never bubble up.
  // 2026-05-07: ALL priority_visit groups are appended unconditionally, even
  // when they exceed the random visit count. User pinned them — the agent
  // must visit them every session.
  const visitCount = Math.max(1, R.randInt(3, Math.min(5, groups.length)))
  const groupsToVisit = groups.slice(0, visitCount)
  // Add any pinned groups not already in the top slice
  const pinnedGroups = groups.filter(g => g.priority_visit === true && !groupsToVisit.includes(g))
  for (const pg of pinnedGroups) groupsToVisit.unshift(pg)
  if (pinnedGroups.length > 0) {
    console.log(`[NURTURE] 📌 Pinned groups override: visiting ${pinnedGroups.length} pinned + ${visitCount} top-tier = ${groupsToVisit.length} total`)
  }

  if (groups.length > visitCount) {
    const _topicKey = (topic || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
    const evalSlotPresent = groupsToVisit.some(g => !g.ai_relevance?.[_topicKey])
    if (!evalSlotPresent) {
      const needsEval = groups.find(g => !g.ai_relevance?.[_topicKey] && !groupsToVisit.includes(g))
      if (needsEval) {
        const replaceIdx = groupsToVisit.length - 1
        const dropped = groupsToVisit[replaceIdx]
        groupsToVisit[replaceIdx] = needsEval
        console.log(`[NURTURE] Reserved last slot for needs-eval: "${needsEval.name}" (replaced "${dropped?.name}")`)
      }
    }
  }
  console.log(`[NURTURE] Visit plan: ${groupsToVisit.length} group(s) — ${groupsToVisit.map(g => g.name?.substring(0, 24)).join(' → ')}`)

  let page
  try {
    const session = await getPage(account)
    page = session.page

    // ──── DIAGNOSTIC: page + context lifecycle listeners ────
    // Log the moment FB / Playwright closes the page or context. Without this
    // we only see the downstream "Target page... has been closed" cascade with
    // no clue WHEN the death happened. These fire exactly once per close
    // event, in the same process, so they're cheap and authoritative.
    try {
      page.on('close', () => {
        const t = new Date().toISOString().slice(11, 23)
        console.error(`[NURTURE-DBG ${t}] ⚠️ page.close fired (account=${account_id?.slice(0, 8)})`)
      })
      page.on('crash', () => {
        const t = new Date().toISOString().slice(11, 23)
        console.error(`[NURTURE-DBG ${t}] 💥 page.crash fired (account=${account_id?.slice(0, 8)})`)
      })
      page.context().on('close', () => {
        const t = new Date().toISOString().slice(11, 23)
        console.error(`[NURTURE-DBG ${t}] ⚠️ context.close fired (account=${account_id?.slice(0, 8)})`)
      })
    } catch (lifeErr) {
      console.warn(`[NURTURE-DBG] Failed to attach lifecycle listeners: ${lifeErr.message}`)
    }

    // ─── Warm-up: browse feed naturally before doing actions ───
    const currentUrl = page.url()
    const needsWarmup = !currentUrl.includes('facebook.com') || currentUrl.includes('about:blank')
    if (needsWarmup) {
      console.log(`[NURTURE] Warming up nick: browsing feed...`)
      logger.log('visit_group', { target_type: 'feed', target_name: 'Warm-up browse', details: { phase: 'warmup' } })
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(3000, 6000)
        // Scroll feed naturally
        for (let s = 0; s < R.randInt(2, 4); s++) {
          await humanScroll(page)
          await R.sleepRange(2000, 4000)
        }
        await humanMouseMove(page)
        console.log(`[NURTURE] Warm-up done, starting campaign work`)
      } catch (err) {
        console.warn(`[NURTURE] Warm-up failed: ${err.message}`)
      }
    }

    let totalLikes = 0
    let totalComments = 0
    const groupResults = []
    let aiGroupEvalsThisRun = 0
    // 2026-05-04: bumped 2→5. With 8 visited groups per session and most
    // junction members having NO ai_relevance cache (or stale 4+ days),
    // 2 fresh evals/run left 6 groups bypassing eval with undefined
    // aiDecision — pipeline would silently fall through and produce 0 cmt.
    // 2026-05-05: bumped 5→10. Fall-through is now safe (group-eval failure
    // no longer skips the group), so giving more groups a real eval costs
    // us nothing and prevents pure-fall-through nicks from missing a
    // group decision when caches are cold.
    const MAX_AI_GROUP_EVALS = 10

    // === RANDOMIZE TASK ORDER per nick (avoid pattern detection) ===
    // 50% chance: scan first then comment | 50% comment from existing scans then scan new
    const scanFirst = Math.random() < 0.5
    if (scanFirst) {
      console.log(`[NURTURE] Strategy: SCAN first → then COMMENT from scored posts`)
    } else {
      console.log(`[NURTURE] Strategy: COMMENT from scored posts → then SCAN new group`)
    }

    // Phase A: Try to comment on BEST pre-scanned posts first (from previous scans)
    if (!scanFirst && commentCheck.allowed && tracker.get('comment') < maxCommentsSession) {
      try {
        const bestPosts = await getBestPosts({ campaignId: campaign_id, limit: 3, supabase })
        if (bestPosts.length > 0) {
          const bestGroup = bestPosts[0]
          console.log(`[NURTURE] Found ${bestPosts.length} pre-scored posts, best in "${bestGroup.group_name}" (score: ${bestGroup.ai_score})`)
          // Navigate to best group and comment on scored posts
          // (this reuses existing comment logic below by prioritizing this group)
          const scoredGroup = groupsToVisit.find(g => g.fb_group_id === bestGroup.fb_group_id)
          if (scoredGroup) {
            // Move this group to front of visit list
            const idx = groupsToVisit.indexOf(scoredGroup)
            if (idx > 0) { groupsToVisit.splice(idx, 1); groupsToVisit.unshift(scoredGroup) }
          }
        }
      } catch {}
    }

    for (const group of groupsToVisit) {
      // Group visit rate limit: max 2 nicks in same group within 30 min
      if (!canVisitGroup(group.fb_group_id, account_id)) {
        console.log(`[NURTURE] ⏭️ Skip "${group.name}" — group visit rate limit (${GROUP_VISIT_MAX} nicks/30min)`)
        continue
      }
      recordGroupVisit(group.fb_group_id, account_id)

      const result = { group_name: group.name, posts_found: 0, likes_done: 0, comments_done: 0, errors: [] }

      try {
        // 2026-05-05: append sort=CHRONOLOGICAL to force FB to show newest
        // posts first. Default sort can show 3-week-old posts at top → age
        // filter rejects everything.
        let groupUrl = (group.url || `https://www.facebook.com/groups/${group.fb_group_id}`)
          .replace('://m.facebook.com', '://www.facebook.com')
        if (!groupUrl.includes('sort=')) {
          groupUrl += (groupUrl.includes('?') ? '&' : '?') + 'sorting_setting=CHRONOLOGICAL'
        }
        console.log(`[NURTURE] Visiting: ${group.name || group.fb_group_id}`)
        logger.log('visit_group', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: groupUrl })

        // DIAGNOSTIC: check page is alive before group navigation
        if (page.isClosed()) {
          const t = new Date().toISOString().slice(11, 23)
          console.error(`[NURTURE-DBG ${t}] PAGE ALREADY CLOSED before group goto "${group.name}" — aborting job to recover`)
          throw new Error(`page closed before group goto: ${group.name}`)
        }
        const _navStart = Date.now()
        try {
          await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        } catch (gotoErr) {
          const t = new Date().toISOString().slice(11, 23)
          console.error(`[NURTURE-DBG ${t}] page.goto FAILED for "${group.name}" url=${groupUrl}: ${gotoErr.message} | page.isClosed()=${page.isClosed()}`)
          throw gotoErr
        }
        const _navMs = Date.now() - _navStart
        await R.sleepRange(2000, 4000)

        // 2026-05-05: explicit click on "Bài viết mới" sort option as fallback.
        try {
          const sortClicked = await page.evaluate(() => {
            const toggleLabels = ['Phù hợp nhất', 'Hoạt động mới đây', 'Đáng chú ý', 'Bài viết mới', 'New posts', 'Most relevant', 'Recent activity']
            let toggle = null
            for (const span of document.querySelectorAll('div[role="button"], span')) {
              const t = (span.innerText || '').trim()
              if (toggleLabels.some(l => t === l) && (span.getAttribute('role') === 'button' || span.closest('[role="button"]'))) {
                toggle = span.closest('[role="button"]') || span
                break
              }
            }
            if (!toggle) return false
            if ((toggle.innerText || '').includes('Bài viết mới') || (toggle.innerText || '').includes('New posts')) return 'already'
            toggle.click()
            return true
          })
          if (sortClicked === true) {
            await R.sleepRange(800, 1500)
            await page.evaluate(() => {
              for (const el of document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], div[role="button"]')) {
                const t = (el.innerText || '').trim()
                if (t === 'Bài viết mới' || t === 'New posts') { el.click(); return true }
              }
              return false
            })
            await R.sleepRange(1500, 2500)
            console.log('[NURTURE] Clicked sort=Bài viết mới')
          }
        } catch {}

        // Signal detection: slow load + redirect
        try {
          const signals = require('../../lib/signal-collector')
          signals.checkSlowLoad(account_id, payload.job_id, groupUrl, _navMs)
          signals.checkRedirectWarn(account_id, payload.job_id, groupUrl, page.url())
        } catch {}

        // Check for checkpoint/block
        const status = await checkAccountStatus(page, supabase, account_id)
        if (status.blocked) throw new Error(`Account blocked: ${status.detail}`)

        // 2026-05-05: detect FB privacy lock page (group not viewable for this
        // nick despite is_member=true) and skip + mark unavailable so future
        // runs don't waste cycles on it.
        // 2026-05-06: also detect "Tham gia"/"Join" button — if present the
        // nick is no longer a member (admin removed, FB cleanup). Skip the
        // group + queue check_group_membership to confirm + correct DB.
        // Per user: do NOT set is_member=false directly (avoid false positives,
        // let the dedicated handler verify), do NOT increment consecutive_skips.
        try {
          const lockState = await page.evaluate(() => {
            const txt = (document.body?.innerText || '').slice(0, 1500)
            const isPrivacyLock = /Bạn hiện không xem được nội dung này|can't see this content|You can not see/i.test(txt)
              || (document.querySelectorAll('[role="article"]').length === 0
                  && /Đi đến Bảng feed|Go to News Feed/i.test(txt))
            // "Tham gia"/"Join" button visible → nick not actually a member
            const hasJoinBtn = !!document.querySelector(
              'div[aria-label*="Join group" i][role="button"], ' +
              'div[aria-label*="Tham gia nhóm" i][role="button"], ' +
              'div[aria-label="Join" i][role="button"], ' +
              'div[aria-label="Tham gia" i][role="button"]'
            )
            return { isPrivacyLock, hasJoinBtn }
          })
          if (lockState.isPrivacyLock) {
            console.log(`[NURTURE] 🔒 Privacy lock for "${group.name}" (nick ${account_id.slice(0,8)}) — marking unavailable + skipping`)
            try {
              await supabase.from('fb_groups')
                .update({ is_member: false, user_approved: false })
                .eq('account_id', account_id).eq('fb_group_id', group.fb_group_id)
              await supabase.from('campaign_groups')
                .update({ status: 'inactive' })
                .eq('group_id', group.id).eq('assigned_nick_id', account_id)
            } catch {}
            logger.log('visit_group', {
              target_type: 'group', target_name: group.name, target_url: groupUrl,
              result_status: 'skipped',
              details: { reason: 'privacy_lock', nick_id: account_id },
            })
            result.errors.push('skipped: privacy_lock')
            groupResults.push(result)
            continue
          }
          if (lockState.hasJoinBtn) {
            console.log(`[NURTURE] ⚠️ "Tham gia" button visible on "${group.name}" — nick likely not a member, queuing re-verify + skipping (no consecutive_skip recorded)`)
            // Queue check_group_membership; existing handler updates DB.
            try {
              const { data: existing } = await supabase.from('jobs')
                .select('id')
                .eq('type', 'check_group_membership')
                .in('status', ['pending', 'claimed', 'running'])
                .filter('payload->>group_row_id', 'eq', group.id)
                .limit(1)
              if (!existing?.length) {
                await supabase.from('jobs').insert({
                  type: 'check_group_membership',
                  priority: 7,
                  payload: {
                    fb_group_id: group.fb_group_id,
                    group_row_id: group.id,
                    group_url: groupUrl,
                    group_name: group.name,
                    account_id,
                    campaign_id,
                    owner_id: payload.owner_id,
                    reason: 'inline_join_btn_detected',
                  },
                  status: 'pending',
                  scheduled_at: new Date(Date.now() + 30000).toISOString(),
                  created_by: payload.owner_id || payload.created_by,
                })
              }
            } catch (qErr) {
              console.warn(`[NURTURE] Failed to queue verify job: ${qErr.message}`)
            }
            logger.log('visit_group', {
              target_type: 'group', target_name: group.name, target_url: groupUrl,
              result_status: 'skipped',
              details: { reason: 'join_btn_detected', nick_id: account_id, action: 'queued_verify' },
            })
            result.errors.push('skipped: join_btn_detected (verify queued)')
            groupResults.push(result)
            continue
          }
        } catch {}

        // 2026-05-04: backfill member_count from the live group header if the
        // DB row is missing it. Scout's regex on search-result snippets often
        // missed VN formats ("1,2K thành viên", "5,1 N thành viên",
        // "1,2 triệu thành viên") so most joined groups landed with 0 — which
        // killed the member-count signal in the tier scoring formula.
        // Run only when current value looks unset/garbage.
        if (!group.member_count || group.member_count < 10) {
          try {
            const liveCount = await page.evaluate(() => {
              const txt = (document.body.innerText || '').slice(0, 8000)
              // Try several formats. Capture order: number + optional suffix.
              const patterns = [
                /([\d.,]+)\s*(triệu|million|tr)\s*(thành viên|members?|người)/i,
                /([\d.,]+)\s*(nghìn|N|K|k)\s*(thành viên|members?|người)/i,
                /([\d.,]+)\s*(thành viên|members?|người)/i,
              ]
              for (const re of patterns) {
                const m = txt.match(re)
                if (!m) continue
                const raw = m[1].replace(/[,]/g, '.')
                const num = parseFloat(raw) || 0
                if (!num) continue
                const suf = (m[2] || '').toLowerCase()
                if (/triệu|million|tr/.test(suf)) return Math.round(num * 1_000_000)
                if (/nghìn|n|k/.test(suf)) return Math.round(num * 1000)
                // No suffix → strip dot thousand-sep, parse as int
                return parseInt(m[1].replace(/[.,]/g, '')) || 0
              }
              return 0
            }).catch(() => 0)
            if (liveCount && liveCount >= 10) {
              console.log(`[NURTURE] member_count backfill: ${group.name} → ${liveCount}`)
              group.member_count = liveCount
              try {
                await supabase.from('fb_groups').update({ member_count: liveCount })
                  .eq('fb_group_id', group.fb_group_id)
              } catch {}
            }
          } catch {}
        }

        // Language check — analyze first 8 posts + group description
        const groupAnalysis = await page.evaluate(() => {
          const articles = document.querySelectorAll('[role="article"]')
          let viPosts = 0, enPosts = 0, otherPosts = 0, totalPosts = 0
          const VI_DIACRITICS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/gi
          const VI_WORDS = /\b(của|này|trong|không|được|những|cái|một|các|có|cho|với|đang|và|là|tôi|bạn|mình|anh|chị|em|ơi|nhé|nhỉ|vậy|sao|thế|gì|nào|ạ|ừ|rồi|cũng|nhưng|nên|vì|hỏi|bác|mấy|xin|giúp)\b/gi
          const CJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

          // Also check group description
          const descEl = document.querySelector('[data-testid="group-about-card"], [aria-label="Group description"]')
          const descText = descEl ? (descEl.innerText || '').substring(0, 200) : ''
          const descVi = (descText.match(VI_DIACRITICS) || []).length + (descText.match(VI_WORDS) || []).length
          const descIsVi = descVi > 3

          let translatedCount = 0
          for (const a of [...articles].slice(0, 8)) {
            const text = (a.innerText || '').substring(0, 500)
            if (text.length < 20) continue
            totalPosts++

            // CRITICAL: detect auto-translated posts (FB translates EN→VN for VN users)
            const isTranslated = /ẩn bản gốc|xem bản gốc|see original|translated from|đã dịch|bản dịch/i.test(text)
            if (isTranslated) {
              translatedCount++
              enPosts++ // translated = originally foreign language
              continue
            }

            const viDiacritics = (text.match(VI_DIACRITICS) || []).length
            const viWords = (text.match(VI_WORDS) || []).length
            const cjkChars = (text.match(CJK) || []).length

            if (cjkChars > 5) { otherPosts++; continue }
            if (viDiacritics > 3 || viWords > 3) { viPosts++; continue }
            enPosts++
          }

          // Strict: need MAJORITY of posts to be Vietnamese (>50%)
          const viRatio = totalPosts > 0 ? viPosts / totalPosts : 0
          let lang = 'unknown'
          if (viRatio > 0.5) lang = 'vi'          // >50% VN posts → Vietnamese
          else if (enPosts > viPosts) lang = 'en'  // more EN than VN → English
          else if (otherPosts > 0) lang = 'other'
          // Override: if description is clearly Vietnamese, give benefit of doubt
          if (lang !== 'vi' && descIsVi && viRatio >= 0.3) lang = 'vi'

          return { totalPosts, viPosts, enPosts, otherPosts, translatedCount, viRatio, lang, descIsVi }
        }).catch(() => ({ totalPosts: 0, viPosts: 0, enPosts: 0, otherPosts: 0, viRatio: 0, lang: 'unknown', descIsVi: false }))

        // ═══ AI GROUP EVALUATION ═══
        // AI decides if group is relevant — replaces hardcoded keyword/language checks
        // If AI fails → skip this group THIS RUN (not failure, will retry next time)
        // Cache result in ai_relevance for 7 days
        const topicKey = (topic || '').toLowerCase().trim().replace(/\s+/g, '_').slice(0, 50)
        const cachedEval = group.ai_relevance?.[topicKey]
        const CACHE_TTL = 2 * 24 * 3600 * 1000 // 2 days (was 7 — too long for volatile group content)
        const cacheValid = cachedEval?.evaluated_at && (Date.now() - new Date(cachedEval.evaluated_at).getTime()) < CACHE_TTL

        if (cacheValid) {
          const cachedDecision = cachedEval.decision || (cachedEval.score >= 3 || cachedEval.relevant ? 'engage' : 'reject')
          result.aiDecision = { action: cachedDecision, score: cachedEval.score, tier: cachedEval.tier, reason: cachedEval.reason || 'cached' }

          // 2026-05-04: log group decision to DB so we can debug from outside
          try {
            logger.log('nurture_group_decision', {
              target_type: 'group', target_name: group.name, target_id: group.fb_group_id,
              details: {
                decision: cachedDecision, score: cachedEval.score, tier: cachedEval.tier,
                reason: cachedEval.reason || 'cached', source: 'cache',
                lang: groupAnalysis?.lang, viRatio: groupAnalysis?.viRatio,
              },
            })
          } catch {}

          if (cachedDecision === 'reject') {
            console.log(`[NURTURE] Skip "${group.name}" — cached REJECT (score: ${cachedEval.score}, reason: ${cachedEval.reason || 'cached'})`)
            result.errors.push('skipped: cached reject')
            groupResults.push(result)
            continue
          }
          console.log(`[NURTURE] "${group.name}" — cached ${cachedDecision.toUpperCase()} (score: ${cachedEval.score})`)
        }

        if (!cacheValid && topic) {
          // Rate limit AI evals: max 2 per run, rest will be evaluated in future runs
          if (aiGroupEvalsThisRun >= MAX_AI_GROUP_EVALS) {
            console.log(`[NURTURE] ⚠️ "${group.name}" — skipping AI eval (${aiGroupEvalsThisRun}/${MAX_AI_GROUP_EVALS} evals this run), will evaluate next run`)
            // 2026-05-04: log rate-limit-bypass to DB so we can see it from outside
            try {
              logger.log('nurture_group_decision', {
                target_type: 'group', target_name: group.name, target_id: group.fb_group_id,
                details: {
                  decision: 'engage', source: 'rate_limit_bypass',
                  evals_used: aiGroupEvalsThisRun, evals_max: MAX_AI_GROUP_EVALS,
                  lang: groupAnalysis?.lang, viRatio: groupAnalysis?.viRatio,
                  reason: 'AI eval limit hit, proceeding without group decision',
                },
              })
            } catch {}
            // Don't skip the group — let it proceed without eval (give benefit of doubt)
          } else {
          // Need AI evaluation — extract group info from page
          try {
            const { evaluateGroup } = require('../../lib/ai-filter')

            // Scroll down to trigger FB lazy-loading more articles
            await humanScroll(page)
            await R.sleepRange(1500, 3000)
            await humanScroll(page)
            await R.sleepRange(1000, 2000)

            const groupInfo = await page.evaluate(() => {
              const nameEl = document.querySelector('h1') || document.querySelector('[role="main"] span[dir="auto"]')
              const name = nameEl?.textContent?.trim() || ''
              let description = ''
              const aboutEls = document.querySelectorAll('[role="main"] span[dir="auto"]')
              for (const el of aboutEls) {
                const t = el.textContent?.trim() || ''
                if (t.length > 30 && t.length < 500 && t !== name) { description = t; break }
              }
              // 2026-05-05: simplified — modern FB nests articles for EVERY
              // post (layout wrappers + comment threads), so the parentArticle
              // skip dropped EVERY post → "could not extract posts for AI eval"
              // even when 7+ articles + posts are visible. Now: just take
              // innerText of each top-N article + light noise filter, let AI
              // eval handle relevance scoring downstream.
              const posts = []
              const articles = document.querySelectorAll('[role="article"]')
              for (const article of [...articles].slice(0, 12)) {
                const raw = (article.innerText || '').trim()
                if (raw.length < 30) continue
                const text = raw.replace(/^\s*[\w\s]{2,40}\n/, '').trim()
                if (text.length < 20) continue
                const seen = posts.find(p => p.text.substring(0, 100) === text.substring(0, 100))
                if (seen) continue
                posts.push({ text: text.substring(0, 500) })
                if (posts.length >= 8) break
              }
              return { name: name || '', description, posts, member_count: 0 }
            }).catch(() => null)

            if (groupInfo && groupInfo.posts.length > 0) {
              aiGroupEvalsThisRun++
              const aiResult = await evaluateGroup(groupInfo, topic, payload.owner_id)
              // ── Structured AI Decision ──
              const aiDecision = {
                action: 'reject', // default
                score: aiResult.score || 0,
                tier: aiResult.tier || 'tier3_irrelevant',
                relevant: aiResult.relevant === true,
                reason: aiResult.reason || '',
                language: aiResult.language || 'unknown',
              }

              // Decision rules: lowered thresholds for more engagement
              if (aiResult.score >= 3 || aiResult.relevant) {
                aiDecision.action = 'engage'     // like + comment (was: score >= 5)
              } else {
                aiDecision.action = 'reject'     // skip entirely
              }

              console.log(`[NURTURE] AI eval "${group.name}" → ${aiDecision.action.toUpperCase()} (score:${aiDecision.score}, tier:${aiDecision.tier}) — ${aiDecision.reason} [${aiGroupEvalsThisRun}/${MAX_AI_GROUP_EVALS}]`)

              // Cache result with decision for future runs
              try {
                const prev = group.ai_relevance || {}
                prev[topicKey] = { ...aiResult, decision: aiDecision.action, evaluated_at: new Date().toISOString() }
                await supabase.from('fb_groups').update({
                  ai_relevance: prev,
                  ai_note: (aiResult.note || aiResult.reason || '').slice(0, 300),
                }).eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
              } catch {}

              // Log AI decision to activity log — detailed enough to debug
              logger.log('ai_evaluate_group', {
                target_type: 'group', target_name: group.name,
                result_status: aiDecision.action === 'reject' ? 'skipped' : 'success',
                details: {
                  decision: aiDecision.action,
                  score: aiDecision.score,
                  tier: aiDecision.tier,
                  relevant: aiDecision.relevant,
                  reason: aiDecision.reason,
                  language: aiDecision.language,
                  group_tags: group.tags || [],
                  topic,
                },
              })

              // Store decision on the group result for later use (comment gating)
              result.aiDecision = aiDecision

              if (aiDecision.action === 'reject') {
                result.errors.push(`skipped: AI decision=reject (score:${aiDecision.score}, reason:${aiDecision.reason})`)
                groupResults.push(result)
                continue
              }
            } else {
              // 2026-05-05: was `continue` — agent skipped the group entirely
              // when the lightweight group-eval extractor returned 0 posts,
              // even though the downstream commentable extractor (much more
              // robust, walks 40 articles + multiple text strategies) hadn't
              // run yet. Result: groups with rendered posts produced 0 cmt.
              // Now: fall through without group-level decision; let the
              // post-extractor + Hermes post_eval do the work per-post.
              console.log(`[NURTURE] ⚠️ "${group.name}" — group-eval extractor empty, falling through to post-level eval`)
              result.errors.push('group_eval_skipped: empty extractor (fell through)')
            }
          } catch (aiErr) {
            // AI failed — NOT a failure, just skip this group this run
            console.log(`[NURTURE] ⚠️ AI eval failed for "${group.name}": ${aiErr.message} — will retry next run`)
            // Continue to next group, don't block, don't cache
            result.errors.push('skipped: AI eval failed (will retry)')
            groupResults.push(result)
            continue
          }
          } // end rate limit else
        }

        // Browse feed naturally — scroll to load posts
        await humanMouseMove(page)
        for (let s = 0; s < 4; s++) {
          await humanScroll(page)
          await R.sleepRange(1000, 2000)
        }

        // Debug: check page state and dump DOM info
        try {
          const debugInfo = await page.evaluate(() => {
            const articles = document.querySelectorAll('[role="article"]')
            const buttons = document.querySelectorAll('[role="button"]')
            const likeButtons = [...buttons].filter(b => {
              const l = (b.getAttribute('aria-label') || '').toLowerCase()
              const t = (b.innerText || '').trim().toLowerCase()
              return l.includes('like') || l.includes('thích') || t === 'like' || t === 'thích'
            })
            return {
              url: location.href,
              isLoggedIn: !!document.querySelector('[aria-label="Your profile"], [aria-label="Account"], [data-pagelet="ProfileActions"], [aria-label="Trang cá nhân của bạn"], [aria-label="Tài khoản"], [aria-label="Thông báo"]'),
              articlesCount: articles.length,
              buttonsCount: buttons.length,
              likeButtonsCount: likeButtons.length,
              likeLabels: likeButtons.slice(0, 5).map(b => ({
                label: b.getAttribute('aria-label'),
                text: (b.innerText || '').trim().substring(0, 30),
                pressed: b.getAttribute('aria-pressed'),
              })),
              bodyText: (document.body?.innerText || '').substring(0, 200),
            }
          })
          const fs = require('fs')
          const debugPath = require('path').join(__dirname, '..', '..', 'debug', `nurture-dom-${Date.now()}.json`)
          fs.writeFileSync(debugPath, JSON.stringify(debugInfo, null, 2))
          console.log(`[NURTURE] DOM: ${debugInfo.articlesCount} articles, ${debugInfo.likeButtonsCount} like btns, logged=${debugInfo.isLoggedIn}, url=${debugInfo.url}`)
        } catch (e) { console.warn('[NURTURE] DOM debug failed:', e.message) }

        // ===== LIKE POSTS (desktop, JS-based) =====
        // 2026-05-04: cap likes at 1/group. User wants COMMENT to be the
        // primary KPI signal, not likes. Likes still happen as natural
        // engagement before commenting (1 like per group ≈ "noticed a post,
        // about to engage") but most session time goes to comment phase.
        if (likeCheck.allowed && tracker.get('like') < maxLikesSession) {
          const planMax = getActionParams(parsed_plan, 'like', { countMin: 3, countMax: 5 }).count
          const maxLikes = Math.min(planMax, 1) // hard-cap 1/group
          let likesInGroup = 0

          // Find MAIN POST like buttons only (NOT comment like buttons)
          // Key: only look in article toolbar area, skip nested comment articles
          const likeableInfo = await page.evaluate(() => {
            const results = []
            const articles = document.querySelectorAll('[role="article"]')
            for (const article of [...articles].slice(0, 15)) {
              // Skip nested articles (comments inside posts)
              const parentArticle = article.parentElement?.closest('[role="article"]')
              if (parentArticle && parentArticle !== article) continue

              // Skip spam/ads: check post content
              const postBody = (article.querySelector('div[dir="auto"]')?.innerText || '').toLowerCase()
              const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'đặt hàng', 'chuyên cung cấp', 'dịch vụ giá rẻ']
              const spamScore = spamWords.filter(w => postBody.includes(w)).length
              if (spamScore >= 2) continue // skip spam posts

              // Find like button in toolbar area (not in comment sections)
              const toolbar = article.querySelector('[role="group"]')
              const searchArea = toolbar || article
              const allBtns = searchArea.querySelectorAll('[role="button"]')
              for (const btn of allBtns) {
                const label = btn.getAttribute('aria-label') || ''
                const text = (btn.innerText || '').trim()
                const pressed = btn.getAttribute('aria-pressed')
                if (
                  (/^(Like|Thích|Thich)$/i.test(label) || /^(Like|Thích|Thich)$/i.test(text)) &&
                  pressed !== 'true'
                ) {
                  // Extract post permalink — same multi-pass strategy as the
                  // comment scraper so like activity logs also carry post_url
                  // (was null on every modern-FB feed entry).
                  let postUrl = null
                  const tryUrl = (href) => {
                    if (!href) return null
                    if (href.match(/\/(posts|permalink|multi_permalinks)\/(pfbid[\w]+|\d+)/) ||
                        href.includes('story_fbid=') ||
                        href.match(/\/(videos|photos|reel)\/\d+/) ||
                        href.match(/\/groups\/[^/]+\/(posts|permalink)\/(pfbid[\w]+|\d+)/)) {
                      return href.split('?')[0]
                    }
                    return null
                  }
                  // Pass 1: classic anchors with explicit /posts/ etc.
                  for (const link of article.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/videos/"], a[href*="/photos/"], a[href*="/reel/"], a[href*="/multi_permalinks/"]')) {
                    postUrl = tryUrl(link.href || '')
                    if (postUrl) break
                  }
                  // Pass 2: any anchor whose href passes the regex (covers __cft__ token URLs).
                  if (!postUrl) {
                    for (const link of article.querySelectorAll('a[href]')) {
                      postUrl = tryUrl(link.href || link.getAttribute('href') || '')
                      if (postUrl) break
                    }
                  }
                  // Pass 3: <a><time> permalink — FB's canonical post link.
                  if (!postUrl) {
                    const timeAnchor = article.querySelector('a[role="link"] time, a[role="link"] abbr')?.closest('a')
                    if (timeAnchor) postUrl = tryUrl(timeAnchor.href || '')
                  }
                  // Extract engagement counts from article
                  let reactions = 0, commentCount = 0
                  const engText = article.innerText || ''
                  const reactMatch = engText.match(/(\d+[\d,.]*[KkMm]?)\s*(reactions?|lượt thích|người đã bày tỏ)/i)
                  if (reactMatch) {
                    let raw = reactMatch[1].replace(/[,.]/g, '')
                    if (/[Kk]/.test(raw)) reactions = Math.round(parseFloat(raw) * 1000)
                    else if (/[Mm]/.test(raw)) reactions = Math.round(parseFloat(raw) * 1000000)
                    else reactions = parseInt(raw) || 0
                  }
                  const cmtMatch = engText.match(/(\d+[\d,.]*)\s*(comments?|bình luận)/i)
                  if (cmtMatch) commentCount = parseInt(cmtMatch[1].replace(/[,.]/g, '')) || 0

                  results.push({ label, text, pressed, index: results.length, postUrl, reactions, commentCount })
                  btn.setAttribute('data-nurture-like', results.length - 1)
                }
              }
            }
            return results
          })

          result.posts_found = likeableInfo.length
          console.log(`[NURTURE] Found ${likeableInfo.length} likeable posts in DOM`)

          const likesToDo = Math.min(maxLikes, likeableInfo.length, maxLikesSession - tracker.get('like'))

          for (let i = 0; i < likesToDo; i++) {
            try {
              // Re-find the button using the data attribute we set
              const btn = await page.$(`[data-nurture-like="${i}"]`)
              if (!btn) continue

              // 2026-05-04: human-like reading pause before each like.
              // User reported 4 likes in 60s on a single group — that's a
              // bot-pattern (real users scroll/read, don't tap rapid-fire).
              // Pre-click: scroll to post + look at it like a human.
              await btn.scrollIntoViewIfNeeded()
              await R.sleepRange(2500, 5500)
              // Half the time, do a small scroll away+back to simulate
              // reading neighbouring posts before deciding to like.
              if (Math.random() < 0.5) {
                try {
                  await page.mouse.wheel(0, R.randInt(150, 400))
                  await R.sleepRange(800, 1800)
                  await page.mouse.wheel(0, -R.randInt(150, 400))
                  await R.sleepRange(600, 1400)
                  await btn.scrollIntoViewIfNeeded()
                  await R.sleepRange(400, 900)
                } catch {}
              }

              // Click using dispatchEvent for React compatibility
              await page.evaluate((idx) => {
                const el = document.querySelector(`[data-nurture-like="${idx}"]`)
                if (!el) return
                const rect = el.getBoundingClientRect()
                const x = rect.left + rect.width / 2
                const y = rect.top + rect.height / 2
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
                el.dispatchEvent(new MouseEvent('mousedown', opts))
                el.dispatchEvent(new MouseEvent('mouseup', opts))
                el.dispatchEvent(new MouseEvent('click', opts))
              }, i)

              await R.sleepRange(2500, 4500)

              likesInGroup++
              totalLikes++
              tracker.increment('like')
              await supabase.rpc('increment_budget', {
                p_account_id: account_id,
                p_action_type: 'like',
              })
              console.log(`[NURTURE] Liked #${totalLikes} (session: ${tracker.get('like')}/${maxLikesSession})`)
              logger.log('like', { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url, details: { post_url: likeableInfo[i]?.postUrl || null, reactions: likeableInfo[i]?.reactions || 0, comments: likeableInfo[i]?.commentCount || 0 } })

              // 2026-05-04: between-likes gap bumped 2-5s → 15-45s, with a
              // 1-in-4 chance of a "got distracted" pause of 60-120s. Real
              // users don't like 4 posts in 60s; they scroll, read full
              // content, sometimes click a link, then come back. Total
              // session length grows but FB engagement signal looks human.
              if (i < likesToDo - 1) {
                try {
                  await page.mouse.wheel(0, R.randInt(300, 800))
                  await R.sleepRange(1500, 3000)
                } catch {}
                if (Math.random() < 0.25) {
                  await R.sleepRange(60000, 120000) // long pause
                } else {
                  await R.sleepRange(15000, 45000)  // normal between-likes gap
                }
              }
            } catch (err) {
              result.errors.push(`like: ${err.message}`)
            }
          }
          result.likes_done = likesInGroup
        }

        // ===== COMMENT ON POSTS (desktop — click comment button in feed) =====
        // Gate: only comment if AI decision is 'engage' (not 'observe')
        const canComment = result.aiDecision?.action !== 'observe' // observe = like only
        // Diagnostic: track where comment pipeline stops
        const commentDebug = { commentable: 0, eligible: 0, ai_selected: 0, attempted: 0, quality_rejected: 0, no_box: 0, gen_failed: 0 }
        result.comment_debug = commentDebug
        if (canComment && commentCheck.allowed && tracker.get('comment') < maxCommentsSession) {
          const maxComments = getActionParams(parsed_plan, 'comment', { countMin: 1, countMax: 2 }).count

          // Get ALL previously commented posts for this USER (never comment same post twice, ANY campaign)
          // 2026-05-05: also load post_url tokens (pfbid) + a body-hash equivalent
          // by extracting the activity log (campaign_activity_log has the post body
          // we wrote). Prevents duplicate comments when FB rotates pfbid in URL —
          // user reported same nick commented 2x on same post (2 weeks apart) because
          // the URL token differed and `/posts/\d+` regex missed pfbid.
          const { data: prevComments } = await supabase
            .from('comment_logs')
            .select('post_url, fb_post_id')
            .eq('owner_id', payload.owner_id || payload.created_by)
            .not('post_url', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1500)
          const commentedUrls = new Set()
          const commentedPostIds = new Set()
          const commentedTokens = new Set() // pfbid tokens
          for (const c of (prevComments || [])) {
            if (c.post_url) {
              commentedUrls.add(c.post_url)
              // Strip query, normalize trailing /, drop fbclid/__cft__
              const clean = c.post_url.split('?')[0].replace(/\/$/, '')
              commentedUrls.add(clean)
              // Extract any pfbid token in the URL
              const pfm = c.post_url.match(/\/(pfbid[\w]+)/)
              if (pfm) commentedTokens.add(pfm[1])
            }
            if (c.fb_post_id) commentedPostIds.add(c.fb_post_id)
          }
          // Also load activity log post bodies as a SECOND dedup signal — pfbid
          // rotates over weeks but post body text doesn't.
          const commentedBodyHashes = new Set()
          try {
            const { data: prevActs } = await supabase
              .from('campaign_activity_log')
              .select('details')
              .eq('account_id', account_id)
              .eq('action_type', 'comment')
              .not('details', 'is', null)
              .order('created_at', { ascending: false })
              .limit(500)
            for (const a of (prevActs || [])) {
              // logger writes post_text on success; older builds wrote target_*
              const body = a?.details?.post_text || a?.details?.post_body || a?.details?.target_post_body || ''
              if (body && body.length >= 30) {
                commentedBodyHashes.add(body.substring(0, 100).toLowerCase().replace(/\s+/g, ' ').trim())
              }
            }
          } catch {}

          // === EXPAND "See more" / "Xem thêm" links to get full post content ===
          // FB truncates long posts behind these links — click them so AI sees full context
          try {
            const expanded = await page.evaluate(() => {
              const articles = document.querySelectorAll('[role="article"]')
              let clicked = 0
              for (const article of [...articles].slice(0, 10)) {
                // Skip nested
                const parent = article.parentElement?.closest('[role="article"]')
                if (parent && parent !== article) continue
                // Find "See more" / "Xem thêm" within article (NOT in toolbar)
                for (const el of article.querySelectorAll('div[role="button"], span[role="button"]')) {
                  const text = (el.innerText || '').trim().toLowerCase()
                  if (text === 'xem thêm' || text === 'see more' || text === 'xem them') {
                    try { el.click(); clicked++ } catch {}
                    break
                  }
                }
              }
              return clicked
            })
            if (expanded > 0) {
              console.log(`[NURTURE] Expanded ${expanded} 'See more' links`)
              await R.sleepRange(800, 1500) // wait for content to render
            }
          } catch {}

          // 2026-05-04: wait for FB to actually render at least one post in
          // the feed before scrolling. Without this, sessions where the AI
          // eval came from cache (fast path, no scroll needed for eval) hit
          // the post-extraction loop too early — DOM only has the group
          // header article, the 3 scroll attempts run on a still-loading
          // feed, and we end up with 0 posts. Symptom: 35s sessions visiting
          // 3 groups with 0 likes / 0 comments and skip_reasons=[]. Wait up
          // to 12s for at least 2 articles to appear (group header + 1 real
          // post); fall through if FB really has no posts (small/dead group).
          try {
            await page.waitForFunction(() => {
              return document.querySelectorAll('[role="article"]').length >= 2
            }, { timeout: 12000 })
          } catch { /* feed may legitimately be empty — let scroll retry handle it */ }

          // Scroll to trigger FB lazy-loading of feed posts. Without this,
          // DOM at `domcontentloaded` may only contain the group header/about
          // article and zero actual posts. Retry up to 2 times if post count
          // is too low after the first pass.
          let commentableInfo = []
          for (let _scrollAttempt = 0; _scrollAttempt < 3; _scrollAttempt++) {
            if (_scrollAttempt > 0) {
              console.log(`[NURTURE] Scroll attempt ${_scrollAttempt + 1}/3 for "${group.name}" — previous had ${commentableInfo.length} posts`)
            }
            await humanScroll(page)
            await R.sleepRange(1500, 2500)
            if (_scrollAttempt < 2) {
              await humanScroll(page)
              await R.sleepRange(1000, 2000)
            }

            // Extract ALL posts with content + tag comment buttons
            commentableInfo = await page.evaluate(() => {
              // 2026-05-05: FB ships multiple DOM layouts in parallel (gradual
              // rollout / A-B / device-class). The old "single-selector +
              // fallback if zero" approach missed posts that one strategy saw
              // but another didn't. Strategy: collect candidates from FOUR
              // sources concurrently, merge, validate, dedupe by depth.
              const norm = (s) => (s || '').toLowerCase().trim()
              const isLikeBtnLabel = (l) => {
                const x = norm(l)
                return x === 'like' || x === 'thích' || x.startsWith('like:') ||
                       x.startsWith('thích:') || x === 'react' || x === 'bày tỏ cảm xúc' ||
                       x.startsWith('react ') || x.startsWith('cảm xúc ')
              }
              const isCommentBtnLabel = (l) => {
                const x = norm(l)
                return x === 'comment' || x === 'bình luận' || x === 'leave a comment' ||
                       x === 'viết bình luận' || x.includes('write a comment') ||
                       x.includes('viết bình luận')
              }
              const isCommentTextOrLabel = (b) => {
                if (isCommentBtnLabel(b.getAttribute('aria-label'))) return true
                const t = norm(b.innerText)
                return t === 'comment' || t === 'bình luận'
              }

              // === Comment-section articles to EXCLUDE (any strategy) ===
              const legacyArticles = [...document.querySelectorAll('[role="article"]')]
              const commentArticles = new Set()
              for (const a of legacyArticles) {
                const label = (a.getAttribute('aria-label') || '').toLowerCase()
                if (label.includes('comment by') || label.includes('bình luận của') ||
                    label.includes('reply') || label.includes('trả lời của')) {
                  commentArticles.add(a)
                  for (const sub of a.querySelectorAll('[role="article"]')) commentArticles.add(sub)
                }
              }

              // ===== Strategy 1: legacy [role="article"] =====
              const s1 = legacyArticles.filter(a => !commentArticles.has(a))

              // ===== Strategy 2: like-button anchor walkup =====
              // Anchor on like btns whose toolbar also has a comment btn (=
              // post toolbar, not random like btn). Walk up until smallest
              // ancestor with text >= 40 chars and exactly 1 like btn.
              const postLikeBtns = []
              for (const btn of document.querySelectorAll('[role="button"]')) {
                if (!isLikeBtnLabel(btn.getAttribute('aria-label'))) continue
                const toolbar = btn.closest('[role="group"]') || btn.parentElement?.parentElement
                if (!toolbar) continue
                let hasCmt = false
                for (const b of toolbar.querySelectorAll('[role="button"], a[role="link"]')) {
                  if (isCommentTextOrLabel(b)) { hasCmt = true; break }
                }
                if (hasCmt) postLikeBtns.push(btn)
              }
              const s2 = []
              const s2Used = new Set()
              for (const btn of postLikeBtns) {
                let cur = btn.parentElement
                while (cur && cur !== document.body) {
                  if (s2Used.has(cur)) break
                  if ((cur.innerText || '').length >= 40) {
                    let likeCount = 0
                    for (const b of cur.querySelectorAll('[role="button"]')) {
                      if (isLikeBtnLabel(b.getAttribute('aria-label'))) likeCount++
                      if (likeCount > 1) break
                    }
                    if (likeCount === 1) {
                      s2.push(cur)
                      s2Used.add(cur)
                      for (const d of cur.querySelectorAll('*')) s2Used.add(d)
                      break
                    }
                  }
                  cur = cur.parentElement
                }
              }

              // ===== Strategy 3: [role="feed"] direct children =====
              const s3 = []
              for (const feed of document.querySelectorAll('[role="feed"]')) {
                for (const child of feed.children) s3.push(child)
              }

              // ===== Strategy 4: modern FB data-attribute selectors =====
              const s4 = []
              const modernSels = [
                '[data-pagelet*="FeedUnit"]',
                '[data-pagelet*="GroupFeed"] [data-virtualized="false"]',
                'div[id^="mall_post_"]',
              ]
              for (const sel of modernSels) {
                try { for (const el of document.querySelectorAll(sel)) s4.push(el) } catch {}
              }

              // ===== Merge + validate =====
              // Each candidate must: not be a comment-section article, have
              // a like btn AND a comment btn AND body text >= 30 chars.
              const merged = new Set([...s1, ...s2, ...s3, ...s4])
              const validated = []
              for (const c of merged) {
                if (commentArticles.has(c)) continue
                if ((c.innerText || '').length < 30) continue
                let likeCount = 0, hasComment = false
                for (const btn of c.querySelectorAll('[role="button"], a[role="link"]')) {
                  if (isLikeBtnLabel(btn.getAttribute('aria-label'))) likeCount++
                  if (!hasComment && isCommentTextOrLabel(btn)) hasComment = true
                }
                // Skip when no like btn (= not a post), no comment btn (= can't
                // engage), or like btn count > 5 (= too broad, contains many posts).
                if (likeCount < 1 || likeCount > 5 || !hasComment) continue
                validated.push(c)
              }

              // ===== Dedupe by depth =====
              // When two validated candidates overlap (one contains the other),
              // keep the deeper (smaller, tighter) one. Sort deepest-first,
              // then for each candidate drop it if any ancestor is already kept.
              const depthOf = (el) => {
                let d = 0, e = el
                while (e.parentElement) { d++; e = e.parentElement }
                return d
              }
              const ranked = validated.map(el => ({ el, depth: depthOf(el) }))
                .sort((a, b) => b.depth - a.depth)
              const kept = []
              const claimedAncestor = new Set()
              for (const { el } of ranked) {
                if (claimedAncestor.has(el)) continue
                // Skip if any of el's ancestors is already kept (= would dup)
                let anc = el.parentElement, conflict = false
                while (anc && anc !== document.body) {
                  if (claimedAncestor.has(anc)) { conflict = true; break }
                  anc = anc.parentElement
                }
                if (conflict) continue
                kept.push(el)
                claimedAncestor.add(el)
                for (const d of el.querySelectorAll('*')) claimedAncestor.add(d)
              }

              // Strategy diagnostics — see which sources contributed
              const sourceOf = (el) => {
                const sources = []
                if (s1.includes(el)) sources.push('article')
                if (s2.includes(el)) sources.push('like_anchor')
                if (s3.includes(el)) sources.push('feed_child')
                if (s4.includes(el)) sources.push('data_pagelet')
                return sources.join('+') || 'merged'
              }
              const sourceCounts = { article: 0, like_anchor: 0, feed_child: 0, data_pagelet: 0, merged: 0 }
              for (const k of kept) {
                const src = sourceOf(k)
                if (src === 'merged') sourceCounts.merged++
                else for (const s of src.split('+')) if (sourceCounts[s] !== undefined) sourceCounts[s]++
              }

              const articles = kept
              const results = []
              const diag = {
                total: articles.length,
                strategy: 'multi',
                source_counts: sourceCounts,
                raw_counts: { s1_article: s1.length, s2_like_anchor: s2.length, s3_feed_child: s3.length, s4_data_pagelet: s4.length },
                like_btns_seen: postLikeBtns.length,
                legacy_article_count: legacyArticles.length,
                merged_count: merged.size,
                validated_count: validated.length,
                skipped: { nested: 0, no_content: 0, comment: 0 },
              }

              // 2026-05-05: bypass parentArticle nested-skip + bump slice
              // 20→40 so older posts in 1st screen don't crowd out fresh ones.
              const seenBodies = new Set()
              for (const article of [...articles].slice(0, 40)) {
                if (commentArticles.has(article)) { diag.skipped.comment++; continue }

                // 2026-05-04: extraction broken — DB nurture_extract showed 4
                // posts with bodyLen=0. FB rolled out new DOM where the legacy
                // data-ad-* attributes are gone and text lives in deeper spans.
                // New strategy: aggressively walk the article subtree and pick
                // the LONGEST visible text block, skipping toolbar / heading /
                // engagement-count / nested-comment chrome.
                let body = ''
                const SKIP_CLOSEST = '[role="button"], [role="group"], h1, h2, h3, h4'
                // First try old attribute selectors (rare modern FB but still seen)
                const legacySelectors = [
                  '[data-ad-preview="message"]',
                  '[data-ad-comet-preview="message"]',
                  'div[data-ad-preview]',
                  '[data-testid="post_message"]',
                  'div[data-testid*="post"]',
                ]
                for (const sel of legacySelectors) {
                  const el = article.querySelector(sel)
                  if (el?.innerText?.trim()?.length > body.length) body = el.innerText.trim()
                }
                // Walk every div + span; pick the longest visible-text block
                // that isn't inside the skip-zone. Modern FB nests post text
                // ~6 levels deep without the legacy data-ad-* anchor.
                if (body.length < 20) {
                  // 2026-05-05: replaced el.closest('[role="article"]') !== article
                  // check (which dropped every text on modern FB nested DOM)
                  // with commentArticles set lookup. Plus innerText fallback.
                  const candidates = article.querySelectorAll('div, span')
                  for (const el of candidates) {
                    if (el.closest(SKIP_CLOSEST)) continue
                    let inComment = false
                    let p = el.parentElement
                    while (p && p !== article) {
                      if (commentArticles.has(p)) { inComment = true; break }
                      p = p.parentElement
                    }
                    if (inComment) continue
                    const text = (el.innerText || '').trim()
                    if (text.length < 10 || text.length > 5000) continue
                    if (/^\d+\s*(lượt|reactions?|comments?|bình luận|share|chia sẻ)/i.test(text)) continue
                    if (/^(\d+\s*(giờ|phút|ngày|tuần|tháng|năm|h|m|d|w|mo|y)|\d+\s*(hour|min|day|week|month|year)s?\s*(ago|trước)?)/i.test(text)) continue
                    if (text.length > body.length) body = text
                  }
                }
                if (body.length < 20) {
                  body = (article.innerText || '').trim().substring(0, 800)
                }

                // Extract author — try many heading patterns
                let author = ''
                const authorSelectors = [
                  'h2 a[role="link"] strong',
                  'h3 a[role="link"] strong',
                  'h2 a strong',
                  'h3 a strong',
                  'h2 a[role="link"]',
                  'h3 a[role="link"]',
                  'h2 a',
                  'h3 a',
                  'a[role="link"] strong',
                  'strong a',
                  '[data-ad-comet-preview="message"] + * a',
                ]
                for (const sel of authorSelectors) {
                  const el = article.querySelector(sel)
                  const t = el?.textContent?.trim()
                  if (t && t.length > 0 && t.length < 80) { author = t; break }
                }

                // Extract post URL — expanded patterns + modern FB fallbacks.
                // Activity log was logging post_url=null because current FB
                // group feeds wrap the timestamp permalink in a __cft__ token
                // URL and use /multi_permalinks/ for re-shared posts.
                let postUrl = null
                const tryUrl = (href) => {
                  if (!href) return null
                  if (href.match(/\/(posts|permalink|multi_permalinks)\/(pfbid[\w]+|\d+)/) ||
                      href.includes('story_fbid=') ||
                      href.match(/\/(videos|photos|reel)\/\d+/) ||
                      href.match(/\/groups\/[^/]+\/(posts|permalink)\/(pfbid[\w]+|\d+)/)) {
                    return href.split('?')[0]
                  }
                  return null
                }

                // Pass 1: classic anchors with explicit /posts/ etc.
                const urlCandidates = article.querySelectorAll(
                  'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/videos/"], a[href*="/photos/"], a[href*="/reel/"], a[href*="/multi_permalinks/"]'
                )
                for (const link of urlCandidates) {
                  postUrl = tryUrl(link.href || '')
                  if (postUrl) break
                }

                // Pass 2: modern FB wraps the post timestamp in a token URL
                // like https://www.facebook.com/groups/foo/posts/123?__cft__[0]=...
                // The href contains /posts/<id> after the ?, so the regex still
                // matches — but the anchor doesn't have /posts/ in its raw
                // selector. Search every anchor whose href has a fbid pattern.
                if (!postUrl) {
                  for (const link of article.querySelectorAll('a[href]')) {
                    postUrl = tryUrl(link.href || link.getAttribute('href') || '')
                    if (postUrl) break
                  }
                }

                // Pass 3: <a><time> permalink — FB's own canonical post link
                if (!postUrl) {
                  const timeAnchor = article.querySelector('a[role="link"] time, a[role="link"] abbr')?.closest('a')
                  if (timeAnchor) postUrl = tryUrl(timeAnchor.href || '')
                }

                // Skip only if NO content at all (no body, no url, no author)
                if (body.length < 3 && !postUrl && !author) {
                  diag.skipped.no_content++
                  continue
                }

                // Check translated
                const isTranslated = /ẩn bản gốc|xem bản gốc|see original|đã dịch|bản dịch/i.test(article.innerText || '')

                // Tag comment button — expanded search
                const toolbar = article.querySelector('[role="group"]') || article
                for (const btn of toolbar.querySelectorAll('[role="button"], a')) {
                  const l = (btn.getAttribute('aria-label') || '').toLowerCase()
                  const t = (btn.innerText || '').trim().toLowerCase()
                  if (l.includes('comment') || l.includes('bình luận') || l === 'leave a comment' ||
                      /^(comment|bình luận|viết bình luận|write a comment)$/i.test(t)) {
                    btn.setAttribute('data-nurture-comment', results.length)
                    break
                  }
                }

              // Fix 2 (Phase 6): grab up to 5 already-visible thread comments so the AI
              // can answer the actual discussion instead of restating the post body.
              // We DO NOT click "View more" — only what FB rendered inline. If the post has
              // no comments visible yet, threadComments stays empty and AI falls back to
              // post body only (current behavior).
              const threadComments = []
              try {
                // Comment containers on desktop are <li> items inside the comment list
                // (role="article" with depth, or aria-label containing "Comment by/Bình luận của")
                const commentNodes = article.querySelectorAll('[role="article"][aria-label*="omment" i], [role="article"][aria-label*="ình luận" i]')
                for (const c of commentNodes) {
                  if (threadComments.length >= 5) break
                  const label = c.getAttribute('aria-label') || ''
                  // aria-label is usually "Comment by John Doe" / "Bình luận của John"
                  const cAuthorMatch = label.match(/(?:by|của)\s+(.+?)(?:\s+\d|$)/i)
                  const cAuthor = cAuthorMatch ? cAuthorMatch[1].trim() : ''
                  // Body is the longest dir="auto" inside the comment node
                  let cBody = ''
                  for (const d of c.querySelectorAll('div[dir="auto"]')) {
                    const t = (d.innerText || '').trim()
                    if (t.length > cBody.length && t.length < 1000) cBody = t
                  }
                  if (cBody && cBody.length >= 4 && cBody !== body) {
                    threadComments.push({ author: cAuthor, text: cBody.substring(0, 300) })
                  }
                }
              } catch {}

                // 2026-05-05: extract post age (timestamp) so eligible filter
                // can skip stale posts. FB renders the timestamp as text near
                // the author header — typical patterns: "5 tuần", "3 ngày",
                // "12 giờ", "5 weeks ago". Also live in the timestamp <abbr>
                // tooltip / time element which we walk first.
                let postAge = ''
                try {
                  const timeEl = article.querySelector('a[role="link"] abbr, a[role="link"] time, abbr[data-utime], time')
                  if (timeEl) {
                    const t = (timeEl.getAttribute('aria-label') || timeEl.getAttribute('title') || timeEl.innerText || '').trim()
                    if (t) postAge = t
                  }
                  if (!postAge) {
                    // Fallback: scan small spans near header for VN/EN timestamp
                    for (const sp of article.querySelectorAll('span, a')) {
                      if (sp.closest('[role="article"][aria-label*="omment" i]')) continue
                      const t = (sp.innerText || '').trim()
                      if (t.length > 0 && t.length < 30 &&
                          /(\d+)\s*(năm|tháng|tuần|ngày|giờ|phút|year|month|week|day|hour|min|h\b|d\b|w\b)/i.test(t)) {
                        postAge = t
                        break
                      }
                    }
                  }
                } catch {}

                // Dedup body (outer wrapper + inner article match same content)
                if (body.length >= 20) {
                  const bodyKey = body.substring(0, 100).toLowerCase().replace(/\s+/g, ' ').trim()
                  if (seenBodies.has(bodyKey)) { diag.skipped.no_content++; continue }
                  seenBodies.add(bodyKey)
                }
                // Keep up to 1500 chars per post (was 400) — AI needs context
                results.push({ index: results.length, postUrl, body: body.substring(0, 1500), author, isTranslated, threadComments, postAge })
              }
              // Return both posts + diagnostics so the agent can log why extraction failed
              return { posts: results, diag }
            })

            // Unwrap — support both old shape (array) and new shape ({posts, diag})
            const _extractResult = commentableInfo
            if (_extractResult && !Array.isArray(_extractResult) && _extractResult.posts) {
              commentableInfo = _extractResult.posts
              if (_scrollAttempt === 0 || commentableInfo.length === 0) {
                const d = _extractResult.diag
                const rc = d.raw_counts || {}
                const sc = d.source_counts || {}
                console.log(`[NURTURE] DOM scan: kept=${commentableInfo.length} (sources article=${sc.article || 0} like_anchor=${sc.like_anchor || 0} feed_child=${sc.feed_child || 0} data_pagelet=${sc.data_pagelet || 0}), raw s1=${rc.s1_article || 0} s2=${rc.s2_like_anchor || 0} s3=${rc.s3_feed_child || 0} s4=${rc.s4_data_pagelet || 0}, merged=${d.merged_count}, validated=${d.validated_count}, skipped: nested=${d.skipped.nested} no_content=${d.skipped.no_content} comment=${d.skipped.comment}`)
              }
            }

            // 2026-05-04: bumped from >=2 to >=5 so the comment evaluator has
            // a real pool to pick the most substantive post from.
            // 2026-05-05: lowered 5→3. Hermes post_eval is the real selector;
            // it can pick well from 3 posts. Holding out for 5 wasted scroll
            // budget on dead groups and gave the eval less time / shorter
            // sessions for groups that actually had viable bài.
            if (commentableInfo.length >= 3) break
          } // end scroll retry loop

          // Debug: save screenshot + DOM JSON if 0 posts extracted (even if likes worked)
          if (commentableInfo.length === 0) {
            try {
              const { saveDebugScreenshot } = require('./post-utils')
              await saveDebugScreenshot(page, `nurture-zero-${account_id}`)

              // Dump DOM info for diagnosis — what DOES exist on the page?
              // 2026-05-05: extended to capture modern FB selectors so we can
              // diagnose future DOM changes without screenshots.
              const domDump = await page.evaluate(() => {
                const articles = [...document.querySelectorAll('[role="article"]')].slice(0, 10)
                const feeds = [...document.querySelectorAll('[role="feed"]')]
                const feed = feeds[0] || null
                const feedChildren = feed ? [...feed.children].slice(0, 8) : []

                // Count buttons by aria-label class
                let likeBtns = 0, commentBtns = 0, shareBtns = 0
                for (const btn of document.querySelectorAll('[role="button"]')) {
                  const l = (btn.getAttribute('aria-label') || '').toLowerCase().trim()
                  if (l === 'like' || l === 'thích' || l.startsWith('like:') || l.startsWith('thích:')) likeBtns++
                  if (l === 'comment' || l === 'bình luận' || l === 'leave a comment' || l === 'viết bình luận') commentBtns++
                  if (l === 'share' || l === 'chia sẻ') shareBtns++
                }

                // Common modern FB post containers — take a peek
                const modernSelectors = [
                  '[data-pagelet*="FeedUnit"]',
                  '[data-pagelet*="GroupFeed"]',
                  '[data-virtualized="false"]',
                  'div[id^="mall_post_"]',
                  '[data-tracking-duration-id]',
                ]
                const modernCounts = {}
                for (const sel of modernSelectors) {
                  try { modernCounts[sel] = document.querySelectorAll(sel).length } catch { modernCounts[sel] = -1 }
                }

                return {
                  url: location.href,
                  articlesCount: articles.length,
                  articleSamples: articles.map((a, i) => ({
                    idx: i,
                    ariaLabel: (a.getAttribute('aria-label') || '').substring(0, 120),
                    hasH2: !!a.querySelector('h2'),
                    hasH3: !!a.querySelector('h3'),
                    hasRoleGroup: !!a.querySelector('[role="group"]'),
                    bodyTextLen: (a.innerText || '').length,
                    bodyTextPreview: (a.innerText || '').substring(0, 200).replace(/\s+/g, ' '),
                    hasPostLink: !!a.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]'),
                  })),
                  feedCount: feeds.length,
                  feedChildrenCount: feedChildren.length,
                  feedChildSamples: feedChildren.map((el, i) => ({
                    idx: i,
                    tag: el.tagName,
                    textLen: (el.innerText || '').length,
                    textPreview: (el.innerText || '').substring(0, 150).replace(/\s+/g, ' '),
                    childArticles: el.querySelectorAll('[role="article"]').length,
                  })),
                  buttonCounts: { like: likeBtns, comment: commentBtns, share: shareBtns },
                  modernSelectorCounts: modernCounts,
                }
              })
              const fs = require('fs')
              const path = require('path')
              const debugDir = path.join(__dirname, '..', '..', 'debug')
              try { fs.mkdirSync(debugDir, { recursive: true }) } catch {}
              fs.writeFileSync(
                path.join(debugDir, `nurture-zero-dom-${account_id}-${Date.now()}.json`),
                JSON.stringify(domDump, null, 2)
              )
              console.log(`[NURTURE] ⚠️ 0 commentable posts extracted — debug saved (screenshot + DOM dump)`)
            } catch (e) {
              console.log(`[NURTURE] ⚠️ 0 commentable posts extracted — debug save failed: ${e.message}`)
            }
          }

          // 2026-05-05: tightened dedup + age filter per user request.
          //   1. URL match (full + cleaned)
          //   2. Numeric fb_post_id from /posts/\d+ or story_fbid=
          //   3. pfbid token (FB rotates these but identical post → same token cycle)
          //   4. Body-hash match (most reliable across URL changes)
          //   5. Age filter: skip posts older than MAX_POST_AGE_DAYS.
          //      Bumped 7→30 — fresh-only was killing too many viable posts.
          //      A 3-week post in a slow group is still relevant, and Hermes
          //      post_eval already de-prioritizes stale threads via score.
          //      30d is the practical "this is archive" line on FB groups.
          const MAX_POST_AGE_DAYS = 30
          const eligible = commentableInfo.filter(p => {
            if (p.isTranslated) return false

            // 1. Full URL match
            if (p.postUrl && commentedUrls.has(p.postUrl)) return false
            if (p.postUrl) {
              const clean = p.postUrl.split('?')[0].replace(/\/$/, '')
              if (commentedUrls.has(clean)) return false
            }

            // 2. Numeric fb_post_id
            if (p.postUrl) {
              const m = p.postUrl.match(/(?:posts|permalink|multi_permalinks)\/(\d+)/)
                || p.postUrl.match(/story_fbid=(\d+)/)
              if (m && commentedPostIds.has(m[1])) return false
            }

            // 3. pfbid token
            if (p.postUrl) {
              const pf = p.postUrl.match(/\/(pfbid[\w]+)/)
              if (pf && commentedTokens.has(pf[1])) return false
            }

            // 4. Body-hash match — most reliable when FB rotates URL tokens
            if (p.body && p.body.length >= 30) {
              const bodyKey = p.body.substring(0, 100).toLowerCase().replace(/\s+/g, ' ').trim()
              if (commentedBodyHashes.has(bodyKey)) return false
            }

            // 5. Post age filter
            const ageDays = parsePostAgeDays(p.postAge || '')
            if (ageDays !== null && ageDays > MAX_POST_AGE_DAYS) return false

            // Spam filter (unchanged)
            // Ad/promo detection delegated to Hermes post_eval skill.
            return true
          })

          commentDebug.commentable = commentableInfo.length
          commentDebug.eligible = eligible.length
          console.log(`[NURTURE] Extracted ${commentableInfo.length} posts, ${eligible.length} eligible for comment`)

          // 2026-05-04: log extraction outcome to DB so we can debug from
          // outside the agent (UI logs are in-memory only). Include a sample
          // of why posts were filtered out so we can see if the issue is
          // already-commented dedupe, translation, spam, or empty extraction.
          try {
            const filterReasons = { translated: 0, dup_url: 0, dup_id: 0, spam: 0 }
            const samplePosts = []
            for (const p of commentableInfo.slice(0, 5)) {
              if (p.isTranslated) filterReasons.translated++
              else if (p.postUrl && commentedUrls.has(p.postUrl)) filterReasons.dup_url++
              else if (p.postUrl) {
                const m = p.postUrl.match(/(?:posts|permalink)\/(\d+)/) || p.postUrl.match(/story_fbid=(\d+)/)
                if (m && commentedPostIds.has(m[1])) filterReasons.dup_id++
              }
              const lower = (p.body || '').toLowerCase()
              const spamWords = ['inbox', 'liên hệ ngay', 'giảm giá', 'mua ngay', 'chuyên cung cấp']
              if (spamWords.filter(w => lower.includes(w)).length >= 2) filterReasons.spam++
              samplePosts.push({
                bodyLen: (p.body || '').length,
                bodyPreview: (p.body || '').substring(0, 80),
                hasUrl: !!p.postUrl,
                isTranslated: !!p.isTranslated,
              })
            }
            logger.log('nurture_extract', {
              target_type: 'group', target_name: group.name, target_id: group.fb_group_id,
              details: {
                commentable: commentableInfo.length,
                eligible: eligible.length,
                filter_reasons: filterReasons,
                sample_posts: samplePosts,
                already_commented_count: commentedUrls.size + commentedPostIds.size,
              },
            })
          } catch (e) {
            console.warn(`[NURTURE] log nurture_extract failed: ${e.message}`)
          }

          // === SMART SKIP: 0 eligible posts ===
          // 2026-05-04: only blame the group if extraction succeeded (commentable>0)
          // but the eligible filter removed everything (translated/dup/spam).
          // If commentable===0 the page didn't render any posts for us — that's
          // an agent-side pipeline issue (waitForFunction timeout, FB DOM
          // change, etc.) and punishing the group with consecutive_skips++ has
          // been auto-blocking innocent groups all day.
          if (eligible.length === 0) {
            if (commentableInfo.length > 0) {
              await recordGroupSkip(supabase, account_id, group.fb_group_id)
              console.log(`[NURTURE] Skip "${group.name}" — ${commentableInfo.length} commentable but 0 eligible (recorded as skip)`)
            } else {
              console.log(`[NURTURE] Skip "${group.name}" — 0 commentable extracted (agent issue, NOT recording as skip)`)
            }
          } else {
            // Has eligible posts → record yield (resets consecutive_skips)
            await recordGroupYield(supabase, account_id, group.fb_group_id, eligible.length)
          }

          // === DETECT GROUP LANGUAGE from sample of eligible posts ===
          // 2026-05-05: also fall back to live groupAnalysis.lang (DOM heuristic
          // computed at the top of the handler) so the language gate below can
          // fire even when eligible=0 (i.e. all posts were translated/dedup'd).
          // Without this, EN groups with translated posts kept slipping through
          // because the post-eligibility detector needed >=3 eligible posts.
          let groupLanguage = group.language || groupAnalysis?.lang || null
          if (groupLanguage === 'unknown') groupLanguage = null
          if (!groupLanguage && eligible.length >= 3) {
            try {
              groupLanguage = detectGroupLanguage(eligible)
              if (groupLanguage && groupLanguage !== 'unknown') {
                // Cache to DB for future runs
                supabase.from('fb_groups')
                  .update({ language: groupLanguage })
                  .eq('account_id', account_id).eq('fb_group_id', group.fb_group_id)
                  .then(() => {}, () => {})
                console.log(`[NURTURE] Detected group language: ${groupLanguage} for "${group.name}"`)
              }
            } catch {}
          }

          // === LANGUAGE GATE (softened) ===
          // 2026-05-05: original gate (skip ENTIRE group if groupLanguage==='en'
          // && nickLang==='vi') was killing groups that had a healthy minority
          // of VN posts (e.g. 5 EN + 4 VN → groupLanguage='en' → hard skip).
          // Now: only hard-skip when the group is essentially monolingual EN
          // with <2 visible VN posts. Otherwise fall through and let Hermes
          // post_eval pick the VN posts. AI returns comment_language per post,
          // so the agent will write VN on VN posts and stay silent on EN posts.
          const nickLang = account.profile_language || 'vi'
          const viPostsCount = groupAnalysis?.viPosts || 0
          if (groupLanguage === 'en' && nickLang === 'vi' && viPostsCount < 2) {
            console.log(`[NURTURE] ⏭️ Skip "${group.name}" — monolingual EN group (viPosts=${viPostsCount}), VN nick`)
            await recordGroupSkip(supabase, account_id, group.fb_group_id)
            try {
              await supabase.from('fb_groups')
                .update({ language: 'en', user_approved: false })
                .eq('account_id', account_id).eq('fb_group_id', group.fb_group_id)
            } catch {}
            logger.log('visit_group', {
              target_type: 'group', target_name: group.name, target_url: group.url,
              result_status: 'skipped',
              details: { reason: 'english_group_vn_nick', group_language: groupLanguage, vi_posts: viPostsCount },
            })
            groupResults.push(result)
            continue
          }
          if (groupLanguage === 'en' && nickLang === 'vi') {
            console.log(`[NURTURE] ℹ️ "${group.name}" is EN-leaning but has ${viPostsCount} VN posts — letting AI pick per-post`)
          }
          const allowCommentInGroup = true

          // === AI BRAIN: Deep evaluation of which posts are worth engaging ===
          let aiSelected = []
          const postEvaluations = new Map() // store AI's reasoning per post
          if (eligible.length > 0) {
            try {
              // Fetch campaign details for context
              let campaignData = null
              if (campaign_id) {
                const { data: cData } = await supabase.from('campaigns')
                  .select('name, topic, requirement').eq('id', campaign_id).single()
                campaignData = cData
              }

              const evaluated = await evaluatePosts({
                posts: eligible,
                campaign: campaignData,
                nick: { username: account.username, created_at: account.created_at, mission: config?.nick_mission },
                group: { name: group.name, member_count: group.member_count, description: group.description },
                topic,
                maxPicks: Math.min(maxComments, eligible.length),
                ownerId: payload.owner_id,
                brandConfig, // AI now decides ad_opportunity contextually — no keyword matching
                groupLanguage, // language hint for AI
                // Fix 2: posts now carry threadComments (top 5 visible comments per article).
                // evaluatePosts uses them to understand the actual discussion thread.
              })

              if (evaluated.length > 0) {
                aiSelected = evaluated.map(e => {
                  const post = eligible[e.index - 1]
                  if (post) postEvaluations.set(post.index, e) // save AI reasoning
                  return post
                }).filter(Boolean)

                console.log(`[NURTURE] AI Brain evaluated ${eligible.length} posts, selected ${aiSelected.length}:`)
                for (const e of evaluated) {
                  const p = eligible[e.index - 1]
                  console.log(`  → score:${e.score} [${p?.author}] "${(p?.body || '').substring(0, 60)}..." — ${e.reason}`)
                }

                logger.log('ai_evaluate_posts', {
                  target_type: 'group', target_name: group.name,
                  details: { total_eligible: eligible.length, selected: evaluated.length, evaluations: evaluated },
                })

                // SAVE scored posts to DB for future comment sessions
                try {
                  await scanGroupPosts({
                    posts: eligible, group: { ...group, fb_group_id: group.fb_group_id },
                    campaign: campaignData, nick: { username: account.username },
                    topic, ownerId: payload.owner_id, brandConfig,
                    supabase, campaignId: campaign_id,
                  })
                } catch {}

                // Phase 3: upsert high-score posts into shared_posts pool for swarm
                try {
                  const rows = []
                  for (const e of evaluated) {
                    if ((e.score || 0) < 7) continue
                    const post = eligible[e.index - 1]
                    if (!post) continue
                    // Extract fb_post_id from URL
                    let postFbId = null
                    if (post.postUrl) {
                      const m = post.postUrl.match(/(?:posts|permalink)\/(\d+)/) || post.postUrl.match(/story_fbid=(\d+)/) || post.postUrl.match(/\/(\d{10,})/)
                      if (m) postFbId = m[1]
                    }
                    if (!postFbId) continue
                    const swarmTarget = e.score >= 9 ? 3 : (e.score >= 7 ? 2 : 1)
                    const isAdPost = e.is_ad_post === true || /sponsored|được tài trợ|promoted/i.test((post.body || '') + ' ' + (post.author || ''))
                    rows.push({
                      campaign_id,
                      group_fb_id: group.fb_group_id,
                      post_fb_id: postFbId,
                      post_content: (post.body || '').slice(0, 2000),
                      post_url: post.postUrl || null,
                      post_author: post.author || null,
                      ai_score: e.score,
                      ai_reason: (e.reason || '').slice(0, 500),
                      is_ad_opportunity: e.ad_opportunity === true,
                      ad_reason: (e.ad_reason || '').slice(0, 500) || null,
                      comment_angle: (e.comment_angle || '').slice(0, 500) || null,
                      language: e.comment_language || groupLanguage || 'vi',
                      is_ad_post: isAdPost,
                      swarm_target: swarmTarget,
                    })
                  }
                  if (rows.length) {
                    await supabase.from('shared_posts')
                      .upsert(rows, { onConflict: 'post_fb_id', ignoreDuplicates: true })
                    console.log(`[NURTURE] 🐝 Pooled ${rows.length} shared_posts (swarm targets: ${rows.map(r => r.swarm_target).join(',')})`)
                  }
                } catch (poolErr) {
                  console.warn(`[NURTURE] shared_posts upsert failed: ${poolErr.message}`)
                }
              } else {
                console.log(`[NURTURE] AI Brain says NO posts worth engaging in "${group.name}" (topic: ${topic})`)
                result.errors.push(`ai_eval: 0/${eligible.length} posts scored >= 5`)
                logger.log('ai_evaluate_posts', {
                  target_type: 'group', target_name: group.name, result_status: 'skipped',
                  details: { total_eligible: eligible.length, selected: 0, reason: 'no_relevant_posts' },
                })
              }
            } catch (err) {
              console.warn(`[NURTURE] AI Brain evaluation failed: ${err.message}, falling back to simple selection`)
              result.errors.push(`ai_eval_error: ${err.message}`)
              // Fallback: take first N eligible posts
              aiSelected = eligible.slice(0, maxComments)
            }
          }

          commentDebug.ai_selected = aiSelected.length

          // Language gate: 0 comments if nick can't speak group's language
          const commentsToDo = allowCommentInGroup
            ? Math.min(maxComments, aiSelected.length, maxCommentsSession - tracker.get('comment'))
            : 0
          console.log(`[NURTURE] Will comment on ${commentsToDo} posts${allowCommentInGroup ? '' : ' (skipped — language gate)'}`)

          let commented = 0
          for (const post of aiSelected) {
            if (commented >= commentsToDo) break

            // S5 fallback may open an extra tab; track here so the per-post
            // try/finally below can guarantee cleanup on every exit path.
            let s5Page = null

            try {
              const thisPostUrl = post.postUrl
              if (thisPostUrl && commentedUrls.has(thisPostUrl)) continue
              // Cross-nick dedup by fb_post_id
              if (thisPostUrl) {
                const m = thisPostUrl.match(/(?:posts|permalink)\/(\d+)/) || thisPostUrl.match(/story_fbid=(\d+)/)
                if (m && commentedPostIds.has(m[1])) { console.log(`[NURTURE] Skip post ${m[1]} — already commented by another nick`); continue }
              }

              commentDebug.attempted++

              // Post text already extracted during AI selection
              const postText = post.body || ''
              const postAuthor = post.author || ''

              // Final safety: skip only if essentially empty.
              if (postText.length < 8) { continue }

              // ════════════════════════════════════════════════════════
              // MULTI-STRATEGY: open the comment box for this post
              // ════════════════════════════════════════════════════════
              // Each strategy tries to either (a) tag a comment button so we
              // can click it, or (b) navigate to a permalink page where the
              // textbox is auto-visible. Strategies are tried in order; first
              // one that yields a visible textbox wins.
              //
              // S1 — data-nurture-comment (set during extraction)
              // S2 — re-find via post URL match in [role="article"] (legacy DOM)
              // S3 — re-find via like-button anchor walkup (modern DOM)
              // S4 — re-find via body-text match (any container with our post text)
              // S5 — navigate to post permalink (mobile) — always-visible inline input
              //
              // After commentBtn click attempts (S1-S4), look for textbox with
              // 6 selector variants. If still missing, fall through to S5.
              const findCommentBox = async (p = page) => {
                const sels = [
                  // Desktop
                  'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
                  'div[contenteditable="true"][role="textbox"][aria-label*="bình luận" i]',
                  'div[contenteditable="true"][role="textbox"][aria-label*="viết" i]',
                  'div[contenteditable="true"][role="textbox"][aria-label*="write" i]',
                  // Mobile
                  'textarea[name="comment_text"]',
                  'textarea[placeholder*="bình luận" i]',
                  'textarea[placeholder*="comment" i]',
                  // Generic last resort
                  'div[contenteditable="true"][role="textbox"]',
                ]
                for (const sel of sels) {
                  try {
                    const els = await p.$$(sel)
                    for (const el of els) {
                      if (await el.isVisible().catch(() => false)) return el
                    }
                  } catch {}
                }
                return null
              }

              const tagViaUrl = async (postUrl) => {
                if (!postUrl) return false
                return await page.evaluate((u) => {
                  const tail = u.split('?')[0].split('/').pop()
                  if (!tail) return false
                  for (const article of document.querySelectorAll('[role="article"]')) {
                    const parent = article.parentElement?.closest('[role="article"]')
                    if (parent && parent !== article) continue
                    if (!article.querySelector(`a[href*="${tail}"]`)) continue
                    const toolbar = article.querySelector('[role="group"]') || article
                    for (const btn of toolbar.querySelectorAll('[role="button"], a')) {
                      const l = (btn.getAttribute('aria-label') || '').toLowerCase()
                      const t = (btn.innerText || '').trim().toLowerCase()
                      if (l.includes('comment') || l.includes('bình luận') || /^(comment|bình luận)$/i.test(t)) {
                        btn.setAttribute('data-nurture-refound', '1')
                        return true
                      }
                    }
                  }
                  return false
                }, postUrl)
              }

              const tagViaLikeAnchor = async (snippet) => {
                if (!snippet || snippet.length < 20) return false
                return await page.evaluate((needle) => {
                  const norm = (s) => (s || '').toLowerCase().trim()
                  const isLike = (l) => {
                    const x = norm(l)
                    return x === 'like' || x === 'thích' || x.startsWith('like:') || x.startsWith('thích:')
                  }
                  const isCmt = (l) => {
                    const x = norm(l)
                    return l && (x === 'comment' || x === 'bình luận' || x === 'leave a comment' || x === 'viết bình luận')
                  }
                  // For each like button whose toolbar has comment, walk up
                  // until ancestor's text contains our needle
                  for (const lb of document.querySelectorAll('[role="button"]')) {
                    if (!isLike(lb.getAttribute('aria-label'))) continue
                    const toolbar = lb.closest('[role="group"]') || lb.parentElement?.parentElement
                    if (!toolbar) continue
                    let cmtBtn = null
                    for (const b of toolbar.querySelectorAll('[role="button"], a[role="link"]')) {
                      if (isCmt(b.getAttribute('aria-label'))) { cmtBtn = b; break }
                      const t = norm(b.innerText)
                      if (t === 'comment' || t === 'bình luận') { cmtBtn = b; break }
                    }
                    if (!cmtBtn) continue
                    // Walk up to find container with our post body snippet
                    let cur = lb.parentElement, hit = false
                    while (cur && cur !== document.body) {
                      const txt = (cur.innerText || '').toLowerCase()
                      if (txt.includes(needle.toLowerCase())) { hit = true; break }
                      cur = cur.parentElement
                    }
                    if (hit) {
                      cmtBtn.setAttribute('data-nurture-refound', '1')
                      return true
                    }
                  }
                  return false
                }, snippet)
              }

              const tagViaBodyMatch = async (snippet) => {
                if (!snippet || snippet.length < 20) return false
                return await page.evaluate((needle) => {
                  const norm = (s) => (s || '').toLowerCase().trim()
                  const target = needle.toLowerCase()
                  // Find any element whose text includes our needle, then look
                  // for a nearby comment button (descendant or sibling toolbar)
                  for (const el of document.querySelectorAll('div, span, article')) {
                    const txt = (el.innerText || '').toLowerCase()
                    if (txt.length < needle.length || !txt.includes(target)) continue
                    // Don't pick the entire body
                    if (el === document.body || el === document.documentElement) continue
                    if (el.innerText.length > needle.length * 30) continue // too broad
                    // Search descendants + parent for comment btn
                    const candidates = [
                      ...el.querySelectorAll('[role="button"], a'),
                      ...(el.parentElement?.querySelectorAll('[role="button"], a') || []),
                    ]
                    for (const b of candidates) {
                      const l = (b.getAttribute('aria-label') || '').toLowerCase()
                      const t = norm(b.innerText)
                      if (l === 'comment' || l === 'bình luận' || l === 'leave a comment' ||
                          l === 'viết bình luận' || t === 'comment' || t === 'bình luận') {
                        b.setAttribute('data-nurture-refound', '1')
                        return true
                      }
                    }
                  }
                  return false
                }, snippet)
              }

              let commentBox = null
              let openMethod = null

              // S5 (Direct Visit) is now the PRIMARY method as requested:
              // "khi ai chấm điểm kèm uid chúng ta sẽ chỉ cần vào trực tiếp bài đó cmt"
              // Only fallback to S1-S4 if postUrl is missing (rare).
              if (!post.postUrl) {
                // Legacy S1-S4 fallbacks for posts missing URLs
                let commentBtn = await page.$(`[data-nurture-comment="${post.index}"]`)
                if (commentBtn) openMethod = 's1_dataattr'

                if (!commentBtn) {
                  await page.evaluate(() => document.querySelectorAll('[data-nurture-refound]').forEach(e => e.removeAttribute('data-nurture-refound'))).catch(() => {})
                  if (await tagViaLikeAnchor(postText.substring(0, 60))) {
                    commentBtn = await page.$('[data-nurture-refound="1"]')
                    if (commentBtn) openMethod = 's3_likeanchor'
                  }
                }

                if (!commentBtn) {
                  await page.evaluate(() => document.querySelectorAll('[data-nurture-refound]').forEach(e => e.removeAttribute('data-nurture-refound'))).catch(() => {})
                  if (await tagViaBodyMatch(postText.substring(0, 60))) {
                    commentBtn = await page.$('[data-nurture-refound="1"]')
                    if (commentBtn) openMethod = 's4_bodymatch'
                  }
                }

                // Try clicking the comment btn (legacy)
                const urlBeforeClick = page.url()
                if (commentBtn) {
                  try {
                    await commentBtn.scrollIntoViewIfNeeded()
                    await R.sleepRange(500, 1000)
                    await commentBtn.click({ force: true, timeout: 5000 })
                    await R.sleepRange(1500, 2800)
                    if (page.isClosed()) console.error(`[NURTURE] page CLOSED after commentBtn.click (${openMethod})`)
                    commentBox = await findCommentBox()
                    if (!commentBox && !page.isClosed() && page.url() !== urlBeforeClick) {
                      await R.sleepRange(1500, 2500)
                      commentBox = await findCommentBox()
                    }
                  } catch (e) {
                    console.warn(`[NURTURE] click failed: ${e.message}`)
                  }
                }
              }

              // S5 — open post permalink in a SEPARATE tab in the same context.
              // Prior version called `page.goto(toMobileUrl(...))` on the main
              // feed page; if FB redirected to a checkpoint or login the tab
              // died and the entire nick session was lost. New tab keeps the
              // feed page intact — failed S5 only loses the fallback attempt.
              if (!commentBox && post.postUrl) {
                const tS5 = new Date().toISOString().slice(11, 23)
                console.log(`[NURTURE-DBG ${tS5}] S5 attempt for post #${post.index} url=${post.postUrl} | main page.isClosed()=${page.isClosed()}`)
                try {
                  if (page.isClosed()) {
                    console.error(`[NURTURE-DBG ${tS5}] S5 ABORT — main page already closed, can't spawn newPage`)
                  } else {
                    s5Page = await page.context().newPage()
                    const desktopUrl = toDesktopUrl(post.postUrl)
                    console.log(`[NURTURE-DBG ${tS5}] S5 newPage created, navigating to ${desktopUrl}`)
                    await s5Page.goto(desktopUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                    await R.sleepRange(2500, 4000)
                    // Sanity: did the goto kill main page somehow?
                    if (page.isClosed()) {
                      const tDie = new Date().toISOString().slice(11, 23)
                      console.error(`[NURTURE-DBG ${tDie}] ⚠️⚠️ MAIN PAGE CLOSED during S5 navigation — this should NOT happen with newPage isolation`)
                    }

                    // Checkpoint / login redirect on permalink → bail without touching main page
                    const u = s5Page.url()
                    if (/\/checkpoint\/|\/login|\/recover/.test(u)) {
                      console.warn(`[NURTURE] S5 redirected to ${u} — skipping (main page intact)`)
                    } else {
                      commentBox = await findCommentBox(s5Page)
                      if (commentBox) openMethod = 's5_newtab_desktop'
                    }
                  }
                } catch (s5Err) {
                  const tErr = new Date().toISOString().slice(11, 23)
                  console.warn(`[NURTURE-DBG ${tErr}] S5 newtab flow failed: ${s5Err.message} | main page.isClosed()=${page.isClosed()} | s5Page.isClosed()=${s5Page?.isClosed?.() ?? 'n/a'}`)
                }
                // Finally cleanup happens in the per-post outer try/finally
                // (around the whole post iteration) so we close on every exit.
              }

              if (!commentBox) {
                commentDebug.no_box++
                result.errors.push(`comment: no_box (last_method=${openMethod || 'none'})`)
                console.log(`[NURTURE] ❌ All comment-box strategies failed for post #${post.index} (last tried: ${openMethod || 'none'})`)
                continue
              }
              console.log(`[NURTURE] ✓ Comment box opened via ${openMethod}`)

              // S5 success → all subsequent type/submit operates on the new tab.
              // S1-S4 success → operate on main feed page as before.
              const targetPage = s5Page || page

              // Get AI Brain's evaluation for this specific post
              const evaluation = postEvaluations.get(post.index)
              const commentAngle = evaluation?.comment_angle || null
              const hasAdOpportunity = evaluation?.ad_opportunity === true
              const isLeadPotential = evaluation?.lead_potential === true
              // Per-post language: from AI eval, fall back to group language, default vi
              const postLanguage = evaluation?.comment_language || groupLanguage || 'vi'

              if (hasAdOpportunity) console.log(`[NURTURE] 📢 Ad opportunity on post #${post.index} by [${post.author}]`)
              if (isLeadPotential) console.log(`[NURTURE] 🎯 Lead potential: [${post.author}]`)

              // ── Ad opportunity check: use brand-aware comment if triggered ──
              let commentResult = null
              let adTriggered = false
              let campaignCtx = null
              const adConfig = config?.advertising || null

              if (campaign_id) {
                try {
                  const { data: cd } = await supabase.from('campaigns')
                    .select('name, topic, requirement').eq('id', campaign_id).single()
                  campaignCtx = cd
                } catch {}
              }

              // === AD TRIGGER: trust AI's contextual decision (no keyword matching) ===
              // hasAdOpportunity comes from evaluatePosts() which already considered brandConfig.
              // 2026-05-05: dropped `score >= 6` gate. Hermes already weighed
              // brand fit + post quality when it set ad_opportunity=true; an
              // extra numeric threshold here meant we kept skipping legit ad
              // chances on score-5 posts. Trust the AI's binary signal.
              if (canDoAdComment && adCommentsToday < AD_COMMENT_DAILY_LIMIT && hasAdOpportunity && brandConfig?.brand_name) {
                try {
                  // Extract any existing comments from the post to avoid duplicating brand mentions
                  const existingComments = Array.isArray(post.comments)
                    ? post.comments.map(c => c?.text || c?.body || '').filter(Boolean).slice(0, 5)
                    : []

                  // 2026-05-05: resolve "random" voice → pick a fresh tone
                  // every comment so all nicks don't speak the same way.
                  const RANDOM_VOICES = ['casual', 'lazy', 'curious', 'experienced', 'skeptical', 'helpful', 'newbie', 'sarcastic', 'gen_z', 'professional', 'humor']
                  let resolvedVoice = brandConfig.brand_voice || brandConfig.tone || 'casual'
                  if (resolvedVoice === 'random') {
                    resolvedVoice = RANDOM_VOICES[Math.floor(Math.random() * RANDOM_VOICES.length)]
                  }
                  const oppResult = await generateOpportunityComment({
                    postContent: postText,
                    brandName: brandConfig.brand_name,
                    brandDescription: brandConfig.brand_description || '',
                    brandVoice: resolvedVoice,
                    commentAngle: evaluation?.comment_angle || '',
                    existingComments,
                    language: postLanguage,
                    userId: payload.owner_id,
                    accountId: account_id,
                    campaignId: campaign_id,
                    groupFbId: group?.fb_group_id || group?.id,
                  })
                  if (oppResult?.text && oppResult.text.length > 5) {
                    commentResult = oppResult
                    adTriggered = true
                    adCommentsToday++
                    console.log(`[NURTURE] 📢 Ad comment triggered by AI eval (score:${evaluation.score}, reason:"${(evaluation.ad_reason || '').substring(0, 60)}") — ad #${adCommentsToday}/${AD_COMMENT_DAILY_LIMIT}`)
                  }
                } catch (adErr) {
                  console.warn(`[NURTURE] Ad comment generation failed: ${adErr.message}, falling back to normal`)
                }
              }

              // Fix 2: pull thread comments captured during the post extraction step
              const postThreadComments = Array.isArray(post.threadComments) ? post.threadComments : []

              // Normal comment flow (if ad not triggered)
              if (!commentResult) {
                commentResult = await generateSmartComment({
                  postText, postAuthor,
                  group: { name: group.name, member_count: group.member_count },
                  campaign: campaignCtx,
                  nick: { username: account.username, created_at: account.created_at, mission: config?.nick_mission },
                  topic, commentAngle,
                  ownerId: payload.owner_id,
                  threadComments: postThreadComments, // Fix 2
                  adConfig, hasAdOpportunity,
                  language: postLanguage,
                })
              }

              // Fallback to old generateComment if Brain fails
              if (!commentResult) {
                commentResult = await generateComment({
                  postText, groupName: group.name, topic,
                  style: config?.comment_style || 'casual',
                  language: postLanguage,
                  userId: payload.owner_id,
                  templates: config?.comment_templates,
                  accountId: account_id,
                  campaignId: campaign_id,
                  groupFbId: group?.fb_group_id || group?.id,
                })
              }

              let commentText = typeof commentResult === 'object' ? commentResult.text : commentResult
              const isAI = typeof commentResult === 'object' ? (commentResult.ai || commentResult.smart) : false

              // 2026-05-05: strip ALL emoji/icon characters per user request.
              // Skill prompt says no emoji but models occasionally add ❤️/👍.
              // Strips Unicode emoji ranges + variation selectors + ZWJ. Plain
              // ASCII punctuation is preserved.
              if (commentText) {
                commentText = commentText
                  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20D0}-\u{20FF}\u{1F1E6}-\u{1F1FF}]/gu, '')
                  .replace(/\s{2,}/g, ' ')
                  .trim()
              }

              if (!commentText || commentText.length <= 6) { commentDebug.gen_failed++; continue }

              // === QUALITY GATE: Check comment quality before posting ===
              // Phase 6 Fix 4: gate now considers thread comments — comment must address
              // the actual ongoing discussion, not just the post body.
              if (commentText && commentText.length > 6) {
                const gate = await qualityGateComment({
                  comment: commentText, postText,
                  threadComments: postThreadComments,
                  group: { name: group.name },
                  topic, nick: { username: account.username },
                  ownerId: payload.owner_id,
                })
                if (!gate.approved) {
                  commentDebug.quality_rejected++
                  console.log(`[NURTURE] ❌ Quality gate REJECTED: "${commentText.substring(0, 50)}..." (score: ${gate.score}, reason: ${gate.reason})`)
                  logger.log('comment_rejected', {
                    target_type: 'group', target_name: group.name,
                    details: { comment: commentText, score: gate.score, reason: gate.reason, post_author: postAuthor },
                  })
                  continue // Skip this post, don't waste comment budget
                }
                console.log(`[NURTURE] ✅ Quality gate PASSED (score: ${gate.score})`)
              }

              // Extract post URL + ID for logging.
              // 2026-05-06: extended regex to also match `pfbid` tokens and
              // `multi_permalinks` paths used by modern FB. Old version only
              // matched /posts/\d+ and story_fbid=\d+ → on modern URLs
              // fbPostId stayed null → comment_logs INSERT violated NOT NULL
              // constraint silently → no row created → counter
              // tracker.increment ran anyway via activity_logs side effect →
              // KPI counter said 8/8 while comment_logs had 1. Ghost cmts.
              // Fallback to post URL itself (last 80 chars) as final resort
              // so the row always inserts and dedup still works.
              const thisUrl = post.postUrl || null
              let fbPostId = null
              if (thisUrl) {
                const m = thisUrl.match(/(?:posts|permalink|multi_permalinks)\/(pfbid[\w]+|\d+)/)
                  || thisUrl.match(/story_fbid=(pfbid[\w]+|\d+)/)
                  || thisUrl.match(/\/(pfbid[\w]+)/)
                if (m) fbPostId = m[1]
              }
              // Last-resort fallback: hash-like suffix from URL so INSERT never
              // violates NOT NULL. Keeps unique-by-URL dedup semantics intact.
              if (!fbPostId && thisUrl) {
                fbPostId = thisUrl.split('?')[0].replace(/\/$/, '').slice(-80)
              }
              // 2026-05-07: if EVEN URL is missing (post.postUrl null when
              // extractor couldn't capture link), use a synthetic ID built
              // from account+group+post-index+timestamp so comment_logs
              // INSERT still succeeds. Without this, ghost cmts persist via
              // the NOT-NULL constraint failure path.
              if (!fbPostId) {
                fbPostId = `synthetic_${(account_id || '').slice(0, 8)}_${group?.fb_group_id || 'unknown'}_${post.index ?? 'x'}_${Date.now()}`
              }

              // PRE-LOG: Create comment_logs entry BEFORE posting (status='posting')
              // This ensures we have a record even if typing/submit crashes
              let commentLogId = null
              try {
                const { data: logEntry } = await supabase.from('comment_logs').insert({
                  owner_id: payload.owner_id || payload.created_by, account_id,
                  fb_post_id: fbPostId,
                  comment_text: commentText, source_name: group.name,
                  status: 'pending', campaign_id,
                  ai_generated: isAI,
                  post_url: thisUrl,
                }).select('id').single()
                commentLogId = logEntry?.id
              } catch (logErr) {
                console.warn(`[NURTURE] Pre-log failed: ${logErr.message} — posting anyway`)
              }

              // Add to dedup BEFORE posting (prevent double-comment even if crash)
              if (thisUrl) commentedUrls.add(thisUrl)
              if (fbPostId) commentedPostIds.add(fbPostId)

              // ════════════════════════════════════════════════════════
              // TYPE + MULTI-METHOD SUBMIT
              // ════════════════════════════════════════════════════════
              // Some FB layouts submit on Enter, some need a Send button click,
              // some require Ctrl+Enter. Detect success by checking the textbox
              // contents got cleared (or comment count visibly bumped).
              await commentBox.click({ force: true, timeout: 5000 })
              await R.sleepRange(500, 1000)
              for (const char of commentText) {
                await targetPage.keyboard.type(char, { delay: Math.random() * 80 + 30 })
              }
              await R.sleepRange(800, 1500)

              // 2026-05-06: SUBMIT VERIFICATION OVERHAUL.
              // Old logic relied on `isCleared()` which returned TRUE on
              // textbox-detach exception → if FB navigated / popup'd / closed
              // tab the agent claimed success without the cmt actually
              // landing on FB. Production saw 27 ghost cmts (Thúy Thùy: 9/9
              // claims, 0 real). New logic: REQUIRE positive evidence that
              // our cmt text appears in the visible DOM. Textbox-cleared is
              // only used as fallback — and on detach we now return FALSE
              // (assume not submitted).
              const txtBefore = await commentBox.evaluate(el => (el.innerText || el.value || '').trim()).catch(() => '')
              const isCleared = async () => {
                try {
                  const txt = await commentBox.evaluate(el => (el.innerText || el.value || '').trim())
                  return !txt || txt.length < 3 || txt !== txtBefore
                } catch {
                  // Textbox detached = could be navigation, popup, force-close,
                  // ANY reason. Don't assume submit. (was: return true)
                  return false
                }
              }
              // Look for our cmt body text in the visible DOM. FB takes a
              // moment to render the new cmt — retry up to 4× over ~5s.
              //
              // 2026-05-07 (V10): removed body.innerText fallback — that was
              // a false-positive source. After typing but before submit, the
              // cmt text exists IN THE TEXTBOX → body.innerText includes it
              // → ghost cmt logged.
              //
              // 2026-05-07 (V11): V10 was too strict — production confirmed
              // cmts WERE landing on FB but not in the explicit selectors
              // ([role="article"][aria-label*="omment"]). Modern FB renders
              // cmt-by-user as plain divs without consistent aria-labels.
              // New approach: TreeWalker over ALL text nodes — skip those
              // inside any textbox/contenteditable — return true if our
              // cmt text appears in any non-textbox text node. This is
              // selector-agnostic and survives FB DOM changes.
              const verifyCmtInDom = async () => {
                const needle = (commentText || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)
                if (needle.length < 12) return null // too short to disambiguate
                // Use a 30-char prefix for matching — long enough to be unique,
                // short enough to survive minor whitespace/punctuation variation
                // between the typed text and FB's rendered display.
                const matchKey = needle.slice(0, Math.min(needle.length, 30))
                for (let attempt = 0; attempt < 4; attempt++) {
                  try {
                    const found = await targetPage.evaluate((key) => {
                      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
                      // Ancestors-of-textboxes are EXCLUDED. The user's typed
                      // cmt sits in a contenteditable until submit clears it,
                      // so any text-node match inside a textbox is a false
                      // positive.
                      const tbDescendants = new Set()
                      for (const tb of document.querySelectorAll(
                        'div[contenteditable="true"][role="textbox"], ' +
                        'div[contenteditable="true"], ' +
                        'textarea, input[type="text"]'
                      )) {
                        tbDescendants.add(tb)
                        for (const d of tb.querySelectorAll('*')) tbDescendants.add(d)
                      }
                      const inTextbox = (el) => {
                        let p = el
                        while (p && p !== document.body) {
                          if (tbDescendants.has(p)) return true
                          p = p.parentElement
                        }
                        return false
                      }
                      // Walk all text nodes; bail on first non-textbox match.
                      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
                      let node
                      while ((node = tw.nextNode())) {
                        const t = norm(node.textContent || '')
                        if (!t || t.length < key.length) continue
                        if (!t.includes(key)) continue
                        // We have a substring match — verify it's not inside a textbox
                        const parent = node.parentElement
                        if (parent && inTextbox(parent)) continue
                        return true
                      }
                      return false
                    }, matchKey)
                    if (found) return true
                  } catch {}
                  if (attempt < 3) await R.sleepRange(1000, 1700)
                }
                return false
              }

              let submitted = false
              let submitMethod = null

              // Run a submit method then verify with DOM match (primary signal)
              // Falls back to textbox-cleared if cmt is too short to verify reliably.
              const runSubmitWith = async (action, methodLabel) => {
                try {
                  await action()
                } catch (e) {
                  return false
                }
                await R.sleepRange(1800, 2800)
                // Primary: DOM contains our cmt
                const inDom = await verifyCmtInDom()
                if (inDom === true) { submitted = true; submitMethod = methodLabel; return true }
                if (inDom === null) {
                  // Cmt too short to verify — fall back to cleared check
                  if (await isCleared()) { submitted = true; submitMethod = methodLabel + '_cleared_fallback'; return true }
                }
                return false
              }

              // M1 — Enter key (works on most desktop FB layouts)
              await runSubmitWith(
                () => targetPage.keyboard.press('Enter'),
                'enter'
              )

              // M2 — Click an explicit Send/Post/Đăng button if Enter didn't take
              if (!submitted) {
                await runSubmitWith(async () => {
                  const clicked = await targetPage.evaluate(() => {
                    const norm = (s) => (s || '').toLowerCase().trim()
                    for (const btn of document.querySelectorAll('[role="button"], button, [aria-label]')) {
                      const l = norm(btn.getAttribute('aria-label'))
                      if (l === 'post' || l === 'đăng' || l === 'gửi' ||
                          l === 'comment' || l === 'bình luận' ||
                          l === 'send' || l === 'submit' ||
                          l === 'press enter to post' || l === 'nhấn enter để đăng' ||
                          l.startsWith('send ') || l.startsWith('post ')) {
                        if (btn.offsetParent !== null) { btn.click(); return l || 'aria' }
                      }
                    }
                    for (const btn of document.querySelectorAll('[role="button"], button')) {
                      const t = norm(btn.innerText)
                      if (t === 'post' || t === 'đăng' || t === 'gửi' || t === 'send' || t === 'submit') {
                        if (btn.offsetParent !== null) { btn.click(); return 't:' + t }
                      }
                    }
                    return null
                  })
                  if (!clicked) throw new Error('no submit btn')
                }, 'click_btn')
              }

              // M3 — Ctrl+Enter (mobile + some new FB layouts)
              if (!submitted) {
                await runSubmitWith(async () => {
                  await commentBox.click({ force: true, timeout: 3000 }).catch(() => {})
                  await targetPage.keyboard.press('Control+Enter')
                }, 'ctrl_enter')
              }

              // M4 — Click any visible svg/icon submit (paper plane, send arrow)
              // CRITICAL: must use targetPage.evaluate, otherwise document.* runs
              // on the stale main feed when S5 succeeded.
              if (!submitted) {
                await runSubmitWith(async () => {
                  const clicked = await targetPage.evaluate(() => {
                    const tb = document.querySelector('div[contenteditable="true"][role="textbox"]')
                    if (!tb) return false
                    const container = tb.closest('[role="region"], [role="dialog"], form') || tb.parentElement?.parentElement
                    if (!container) return false
                    for (const btn of container.querySelectorAll('[role="button"], button')) {
                      if (btn.offsetParent === null) continue
                      const hasIcon = !!btn.querySelector('svg, i, [role="img"]')
                      const hasText = (btn.innerText || '').trim().length > 0
                      if (hasIcon && !hasText) { btn.click(); return true }
                    }
                    return false
                  })
                  if (!clicked) throw new Error('no icon btn')
                }, 'icon_btn')
              }

              if (!submitted) {
                commentDebug.gen_failed++ // reuse counter — submit-stage failure
                result.errors.push('comment: submit failed (all 4 methods)')
                console.log(`[NURTURE] ❌ All submit methods failed for post #${post.index}`)
                // Still count time-wise — wait a bit before next post so we don't hammer
                await R.sleepRange(3000, 5000)
                continue
              }
              console.log(`[NURTURE] ✓ Submitted via ${submitMethod}`)
              await R.sleepRange(1500, 3000)

              // POST-SUCCESS: Update log status + increment counters
              totalComments++
              tracker.increment('comment')
              result.comments_done++
              commented++

              // Update comment_logs status to 'done'
              if (commentLogId) {
                try { await supabase.from('comment_logs').update({ status: 'done' }).eq('id', commentLogId) } catch {}
              }

              // Increment budget (separate try/catch — don't crash if this fails)
              try { await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'comment' }) } catch {}

              // Mark post as commented in group_post_scores (for scan-based flow)
              if (fbPostId) {
                try { await supabase.from('group_post_scores').update({ commented: true, commented_at: new Date().toISOString() })
                  .eq('fb_post_id', fbPostId).eq('owner_id', payload.owner_id || payload.created_by) } catch {}
              }

              const isSoftAd = adTriggered || (hasAdOpportunity && brandConfig?.brand_name && commentText.toLowerCase().includes(brandConfig.brand_name.toLowerCase()))
              console.log(`[NURTURE] ✅ Commented #${totalComments} (${isAI ? 'AI' : 'template'}${adTriggered ? ' +AD-TRIGGERED' : isSoftAd ? ' +AD' : ''}): "${commentText.substring(0, 50)}..."`)

              // Flag lead_potential authors for friend request pipeline
              if (isLeadPotential && post.author && campaign_id) {
                try {
                  // Extract author FB ID from post if available
                  const authorUid = post.authorFbId || null
                  if (authorUid) {
                    await supabase.from('target_queue').upsert({
                      campaign_id,
                      source_role_id: role_id,
                      target_role_id: role_id, // will be reassigned by connect role
                      fb_user_id: authorUid,
                      fb_user_name: post.author,
                      source_group_name: group.name,
                      active_score: 80, // high score = lead potential from AI
                      status: 'pending',
                      ai_score: evaluation?.score || 7,
                      ai_type: 'potential_buyer',
                      ai_reason: `Lead flagged from comment: ${evaluation?.reason || 'AI detected'}`,
                    }, { onConflict: 'campaign_id,fb_user_id' })
                    console.log(`[NURTURE] 🎯 Added lead [${post.author}] to target_queue for FR`)
                  }
                } catch {}
              }
              const logActionType = adTriggered ? 'opportunity_comment' : 'comment'
              try { await logger.log(logActionType, { target_type: 'group', target_id: group.fb_group_id, target_name: group.name, target_url: group.url, details: { comment_text: commentText.substring(0, 200), post_text: postText.substring(0, 200), post_url: thisUrl, ai_generated: isAI, post_author: postAuthor, soft_ad: isSoftAd, ad_triggered: adTriggered, ad_opportunity: hasAdOpportunity, lead_potential: isLeadPotential, comment_angle: commentAngle } }) } catch {}

              // Close S5 tab before the long inter-post sleep — no point holding
              // it open for 90-180s. Outer finally is then a no-op for this post.
              if (s5Page) { try { await s5Page.close() } catch {}; s5Page = null }

              await R.sleepRange(90000, 180000) // 90-180 seconds gap
            } catch (err) {
              result.errors.push(`comment: ${err.message}`)
              logger.log('comment', { target_type: 'group', target_name: group.name, result_status: 'failed', details: { error: err.message } })
            } finally {
              // Guarantee s5Page closure on every exit path: continue, throw,
              // success that didn't reach the early-close above, etc. Closing
              // an already-closed page is a no-op (catch swallows it).
              if (s5Page) { try { await s5Page.close() } catch {} }
            }
          }
        }
      } catch (err) {
        // 2026-05-04: capture stack trace + DB log so we can pinpoint the
        // exact `.toLowerCase()` call that's throwing on undefined.
        const stack = err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : 'no stack'
        console.warn(`[NURTURE] Group "${group?.name || group?.fb_group_id}" failed: ${err.message} | ${stack}`)
        result.errors.push(`group: ${err.message}`)
        try {
          logger.log('nurture_group_error', {
            target_type: 'group', target_name: group?.name, target_id: group?.fb_group_id,
            details: {
              error: err.message,
              stack: stack.substring(0, 500),
              group_has_name: !!group?.name,
              group_has_fb_id: !!group?.fb_group_id,
              group_has_url: !!group?.url,
              group_topic: group?.topic,
              group_tags: group?.tags,
            },
          })
        } catch {}
        if (err.message.includes('blocked') || err.message.includes('checkpoint')) {
          if (page) await saveDebugScreenshot(page, `nurture-blocked-${account_id}`)
          throw err
        }
      }

      // Opportunistic friend request — if plan has send_friend_request, scan active members in this group
      const hasFriendTask = (parsed_plan || []).some(s => s.action === 'send_friend_request')
      const friendCheck = hasFriendTask ? tracker.check('friend_request', account.daily_budget?.friend_request?.used || 0) : { allowed: false }
      if (hasFriendTask && friendCheck.allowed && result.comments_done > 0) {
        try {
          // Extract commenters/likers from current page (people who interacted = active members)
          const activeMembers = await page.evaluate(() => {
            const members = []
            const seen = new Set()
            // Find profile links in comment sections and reaction lists
            const profileLinks = document.querySelectorAll('a[href*="facebook.com/"][role="link"]')
            for (const link of profileLinks) {
              const href = link.href || ''
              const match = href.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([a-zA-Z0-9._]+))/)
              if (!match) continue
              const uid = match[1] || match[2]
              if (!uid || seen.has(uid) || uid === 'groups' || uid === 'pages' || uid.length < 3) continue
              seen.add(uid)
              const name = (link.textContent || '').trim()
              if (name && name.length > 1 && name.length < 50) {
                members.push({ fb_user_id: uid, name, profile_url: href.split('?')[0] })
              }
            }
            return members.slice(0, 10) // max 10 candidates
          }).catch(() => [])

          if (activeMembers.length > 0) {
            const maxFR = Math.min(2, friendCheck.remaining) // max 2 opportunistic FR per group
            let frSent = 0
            for (const member of activeMembers.slice(0, maxFR + 2)) { // check a few extra in case some fail
              if (frSent >= maxFR) break
              try {
                // Check if already friends or already sent request
                const { data: existing } = await supabase.from('friend_request_log')
                  .select('id').eq('account_id', account_id).eq('target_fb_id', member.fb_user_id).limit(1)
                if (existing?.length) continue

                // AI Brain: Evaluate if this person is worth connecting
                try {
                  const leadEval = await evaluateLeadQuality({
                    person: { name: member.name, fb_user_id: member.fb_user_id },
                    postContext: `Tương tác trong nhóm "${group.name}" về ${topic}`,
                    campaign: { name: rawTopic },
                    topic,
                    ownerId: payload.owner_id,
                  })
                  if (!leadEval.worth || leadEval.score < 4) {
                    console.log(`[NURTURE] Skip FR to ${member.name} — AI Brain: ${leadEval.reason} (score: ${leadEval.score}, type: ${leadEval.type})`)
                    continue
                  }
                  console.log(`[NURTURE] AI Brain approved FR to ${member.name} (score: ${leadEval.score}, type: ${leadEval.type})`)
                } catch {}

                // Navigate to profile, find Add Friend button
                await page.goto(member.profile_url, { waitUntil: 'domcontentloaded', timeout: 15000 })
                await R.sleepRange(1500, 3000)

                let addBtn = await page.$('div[aria-label="Add friend"], div[aria-label="Thêm bạn bè"], div[aria-label="Add Friend"]')
                if (!addBtn) {
                  const loc = page.locator('div[role="button"]:has-text("Add friend"), div[role="button"]:has-text("Thêm bạn")').first()
                  if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) addBtn = await loc.elementHandle()
                }

                if (addBtn) {
                  await humanClick(page, addBtn)
                  await R.sleepRange(1000, 2500)
                  frSent++
                  tracker.increment('friend_request')
                  await supabase.rpc('increment_budget', { p_account_id: account_id, p_action_type: 'friend_request' })
                  await supabase.from('friend_request_log').insert({
                    account_id, campaign_id,
                    target_fb_id: member.fb_user_id, target_name: member.name,
                    target_profile_url: member.profile_url,
                    status: 'sent', sent_at: new Date(),
                  }).catch(() => {})
                  logger.log('friend_request', { target_type: 'profile', target_id: member.fb_user_id, target_name: member.name, target_url: member.profile_url })
                  console.log(`[NURTURE] 🤝 Friend request sent to ${member.name} (active in ${group.name})`)
                  await R.sleepRange(3000, 8000) // random gap between friend requests
                }
              } catch {}
            }
            if (frSent > 0) result.friends_sent = frSent
          }

          // Navigate back to group feed for next group
          if (activeMembers.length > 0) {
            await page.goto(`https://www.facebook.com/groups/${group.fb_group_id}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await R.sleepRange(1000, 2000)
          }
        } catch (frErr) {
          console.warn(`[NURTURE] Opportunistic FR failed: ${frErr.message}`)
        }
      }

      groupResults.push(result)

      // Phase 2: re-score group after visit and persist tier
      try {
        const { scoreGroup } = require('../../lib/ai-brain')
        const liked = result.likes_done || 0
        const commented = result.comments_done || 0
        const memberCount = group.member_count || 1
        const engagementRate = (liked + commented) / Math.max(1, memberCount)
        const postsPerDay = (result.posts_seen || result.eligible_posts || 0)
        const topicRelevance = group.ai_join_score || group.ai_relevance?.score || 5
        const langMatch = !group.language || campaignLanguage === 'mixed' || group.language === campaignLanguage
        const { score, tier } = scoreGroup({
          engagementRate, postsPerDay, topicRelevance, languageMatch: langMatch,
          memberCount: group.member_count || 0,
          commentsThisSession: commented,
          likesThisSession: liked,
        })
        const yieldedAnything = (liked + commented) > 0
        const update = {
          score_tier: tier,
          engagement_rate: engagementRate,
          last_scored_at: new Date().toISOString(),
          total_interactions: (group.total_interactions || 0) + liked + commented,
          consecutive_skips: yieldedAnything ? 0 : ((group.consecutive_skips || 0) + 1),
        }
        if (yieldedAnything) update.last_yield_at = new Date().toISOString()
        await supabase.from('fb_groups').update(update)
          .eq('fb_group_id', group.fb_group_id).eq('account_id', account_id)
        // Phase 9: mirror score/tier + last_nurtured_at into campaign_groups junction
        if (group._junction_id) {
          try {
            await supabase.from('campaign_groups').update({
              score, tier, last_nurtured_at: new Date().toISOString(),
            }).eq('id', group._junction_id)
          } catch {}
        } else if (campaign_id && group.id) {
          try {
            await supabase.from('campaign_groups').update({
              score, tier, last_nurtured_at: new Date().toISOString(),
            }).eq('campaign_id', campaign_id).eq('group_id', group.id)
          } catch {}
        }
        console.log(`[NURTURE] 📊 ${group.name}: score=${score} tier=${tier} (eng=${engagementRate.toFixed(4)}, skips=${update.consecutive_skips})`)
      } catch (scErr) {
        console.warn(`[NURTURE] scoreGroup failed: ${scErr.message}`)
      }

      if (groupsToVisit.indexOf(group) < groupsToVisit.length - 1) {
        await R.sleepRange(20000, 45000)
      }
    }

    // Screenshot if 0 results for debugging
    if (totalLikes === 0 && totalComments === 0 && page) {
      await saveDebugScreenshot(page, `nurture-zero-${account_id}`)
    }

    const duration = Math.round((Date.now() - startTime) / 1000)
    console.log(`[NURTURE] Done: ${totalLikes} likes, ${totalComments} comments in ${groupResults.length} groups (${duration}s)`)

    // ══════════════════════════════════════════════════════════
    // Phase 19: AI-driven continuous operation — post-session decision
    // AI decides: when to run next, what to do, based on actual performance.
    // ══════════════════════════════════════════════════════════
    try {
      // Gather context for AI
      const { data: kpiRow } = await supabase.from('nick_kpi_daily')
        .select('target_likes, done_likes, target_comments, done_comments, kpi_met')
        .eq('campaign_id', campaign_id).eq('account_id', account_id)
        .eq('date', new Date().toISOString().split('T')[0]).maybeSingle()

      const { count: groupsAvailable } = await supabase.from('campaign_groups')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign_id).eq('assigned_nick_id', account_id)
        .eq('status', 'active')
      const { count: groupsPending } = await supabase.from('fb_groups')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', account_id).eq('pending_approval', true).eq('is_member', false)

      const vnHour = new Date(Date.now() + 7 * 3600000).getUTCHours()
      const skipReasons = groupResults.map(g => g.skip_reason).filter(Boolean)

      const sessionCtx = {
        groups_visited: groupResults.length,
        likes: totalLikes,
        comments: totalComments,
        duration_seconds: duration,
        skip_reasons: [...new Set(skipReasons)],
        groups_available: groupsAvailable || 0,
        groups_pending: groupsPending || 0,
        kpi: {
          likes_done: kpiRow?.done_likes || 0, likes_target: kpiRow?.target_likes || 0,
          comments_done: kpiRow?.done_comments || 0, comments_target: kpiRow?.target_comments || 0,
          met: kpiRow?.kpi_met || false,
        },
      }

      const axios = require('axios')
      const API_URL = process.env.API_URL || 'http://localhost:3000'
      const AUTH_TOKEN = process.env.AGENT_SECRET_KEY || process.env.AGENT_USER_TOKEN || ''

      let decision = null
      try {
        const res = await axios.post(`${API_URL}/ai/generate`, {
          function_name: 'ai_pilot',
          messages: [{ role: 'user', content: `Nick "${account.username}" vừa xong nurture session:
Groups: ${sessionCtx.groups_visited} | Likes: ${sessionCtx.likes} | Comments: ${sessionCtx.comments} | Duration: ${duration}s
Skip reasons: ${sessionCtx.skip_reasons.join(', ') || 'none'}
KPI: likes ${sessionCtx.kpi.likes_done}/${sessionCtx.kpi.likes_target}, comments ${sessionCtx.kpi.comments_done}/${sessionCtx.kpi.comments_target}${sessionCtx.kpi.met ? ' (MET)' : ''}
Groups available: ${sessionCtx.groups_available} | Pending: ${sessionCtx.groups_pending}
Giờ VN: ${vnHour}h | Nick age: ${getNickAgeDays(account)}d | Status: ${account.status}

Quyết định next actions (JSON):
{"next_nurture_minutes":45,"do_feed_browse":true,"feed_browse_minutes":20,"check_pending_groups":false,"scout_new_groups":false,"rest_reason":null,"reasoning":"giải thích ngắn"}

Hướng dẫn: KPI gần đạt→tăng interval. Nhiều skip→ưu tiên scout. 0 comments→check groups. Ngoài 6-23h→rest. Nick<21d→rest.
Chỉ trả JSON.` }],
          max_tokens: 200, temperature: 0.1,
        }, {
          timeout: 90000,
          headers: { 'Content-Type': 'application/json',
            ...(AUTH_TOKEN && { Authorization: `Bearer ${AUTH_TOKEN}` }),
            ...(payload.owner_id && { 'x-user-id': payload.owner_id }),
          },
        })
        const text = res.data?.text || res.data?.result || ''
        const m = String(text).match(/\{[\s\S]*\}/)
        if (m) decision = JSON.parse(m[0])
      } catch (aiErr) {
        console.warn(`[AI-OPS] post-session AI failed: ${aiErr.message}`)
      }

      // Fallback defaults
      if (!decision) {
        decision = {
          next_nurture_minutes: 45,
          do_feed_browse: true,
          feed_browse_minutes: 20,
          check_pending_groups: (groupsPending || 0) > 0,
          scout_new_groups: (groupsAvailable || 0) < 3,
          rest_reason: null,
          reasoning: 'AI unavailable — defaults',
        }
      }

      // Apply decisions
      const now = Date.now()
      const jobsToCreate = []

      // Next nurture (if not resting and within active hours)
      if (!decision.rest_reason && vnHour >= 6 && vnHour < 23) {
        const nextAt = new Date(now + (decision.next_nurture_minutes || 45) * 60000)
        const { count: dupCount } = await supabase.from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'campaign_nurture')
          .in('status', ['pending', 'claimed', 'running'])
          .filter('payload->>campaign_id', 'eq', campaign_id)
          .filter('payload->>account_id', 'eq', account_id)
        if ((dupCount || 0) === 0) {
          jobsToCreate.push({
            type: 'campaign_nurture', priority: 3,
            payload: { ...payload, ai_scheduled: true, reason: decision.reasoning },
            status: 'pending', scheduled_at: nextAt.toISOString(),
            created_by: payload.owner_id,
          })
        }
      }

      // Feed browse
      if (decision.do_feed_browse) {
        jobsToCreate.push({
          type: 'nurture_feed', priority: 5,
          payload: { account_id, campaign_id, owner_id: payload.owner_id },
          status: 'pending',
          scheduled_at: new Date(now + (decision.feed_browse_minutes || 20) * 60000).toISOString(),
          created_by: payload.owner_id,
        })
      }

      // Check pending groups
      if (decision.check_pending_groups && (groupsPending || 0) > 0) {
        const { data: pGroups } = await supabase.from('fb_groups')
          .select('id, fb_group_id, name').eq('account_id', account_id)
          .eq('pending_approval', true).eq('is_member', false).limit(3)
        for (const g of pGroups || []) {
          jobsToCreate.push({
            type: 'check_group_membership', priority: 3,
            payload: { fb_group_id: g.fb_group_id, group_row_id: g.id, account_id, group_name: g.name, campaign_id },
            status: 'pending',
            scheduled_at: new Date(now + 5 * 60000).toISOString(),
          })
        }
      }

      // Scout new groups
      if (decision.scout_new_groups) {
        const { count: scoutDup } = await supabase.from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'campaign_discover_groups')
          .in('status', ['pending', 'claimed', 'running'])
          .filter('payload->>campaign_id', 'eq', campaign_id)
        if ((scoutDup || 0) === 0) {
          jobsToCreate.push({
            type: 'campaign_discover_groups', priority: 3,
            payload: { ...payload, reason: 'ai_continuous_ops' },
            status: 'pending',
            scheduled_at: new Date(now + 10 * 60000).toISOString(),
            created_by: payload.owner_id,
          })
        }
      }

      if (jobsToCreate.length) {
        await supabase.from('jobs').insert(jobsToCreate)
        console.log(`[AI-OPS] Scheduled ${jobsToCreate.length} follow-ups: ${decision.reasoning}`)
      }

      // Log decision for ops learning
      await supabase.from('campaign_activity_log').insert({
        campaign_id, account_id, owner_id: payload.owner_id,
        action_type: 'ai_next_action',
        result_status: decision.rest_reason ? 'skipped' : 'success',
        details: { decision, session: sessionCtx, jobs_scheduled: jobsToCreate.length },
      }).then(() => {}, () => {})

    } catch (opsErr) {
      console.warn(`[AI-OPS] post-session decision failed: ${opsErr.message}`)
    }

    return {
      success: true,
      groups_visited: groupResults.length,
      likes: totalLikes,
      comments: totalComments,
      details: groupResults,
      duration_seconds: duration,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `nurture-error-${account_id}`)
    throw err
  } finally {
    await logger.flush().catch(() => {})

    // Level B: Remember nick behavior patterns
    try {
      const { remember } = require('../../lib/ai-memory')
      if (campaign_id && account_id) {
        // Track comment success rate per nick
        const commentLogs = logger.buffer?.filter(l => l.action_type === 'comment') || []
        const commentSuccess = commentLogs.filter(l => l.result_status === 'success').length
        const commentTotal = commentLogs.length
        if (commentTotal > 0) {
          await remember(supabase, {
            campaignId: campaign_id, accountId: account_id,
            memoryType: 'nick_behavior', key: 'comment_success_rate',
            value: { rate: Math.round(commentSuccess / commentTotal * 100), sample: commentTotal },
          })
        }

        // Track which hour this nick is active
        const hour = new Date().getHours()
        await remember(supabase, {
          campaignId: campaign_id, accountId: account_id,
          memoryType: 'nick_behavior', key: 'active_hour_' + hour,
          value: { hour, actions: logger.flushed || 0 },
        })
      }
    } catch {}

    if (page) // Keep page on FB for session reuse
    await releaseSession(account_id, supabase)
  }
}

module.exports = campaignNurture
