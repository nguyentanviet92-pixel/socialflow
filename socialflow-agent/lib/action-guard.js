/**
 * Action Guard — unified pre/post action anti-checkpoint logic
 *
 * Every interaction handler goes through guardAction() before opening a browser
 * and recordAction() after success. This enforces:
 *   - Account status check (DB-level, before browser)
 *   - Warmup phase (young nicks blocked from advanced actions)
 *   - Daily hard limit + session limit
 *   - Minimum gap between same action type (the most commonly missed check)
 *
 * feedDetour() gives the browser a plausible news-feed visit before navigating
 * to the target URL, breaking the direct-URL-jump bot pattern.
 */

const { checkHardLimit, checkWarmup, getMinGapMs, getNickAgeDays, HARD_LIMITS } = require('./hard-limits')
const R = require('./randomizer')

/**
 * Check (and enforce gap wait) before an action.
 * Pass session count for maxPerSession enforcement.
 *
 * @returns {{ allowed: boolean, reason?: string, nickAge: number }}
 */
async function guardAction(supabase, account, actionType, sessionCount = 0) {
  // 1. DB-level account status — fast path before browser
  const dbStatus = account.status
  if (['checkpoint', 'disabled', 'dead'].includes(dbStatus)) {
    return { allowed: false, reason: `account_${dbStatus}`, nickAge: 0 }
  }

  const nickAge = getNickAgeDays(account)

  // 2. Warmup phase
  const warmup = checkWarmup(actionType, nickAge)
  if (!warmup.allowed) {
    return { allowed: false, reason: warmup.reason, nickAge }
  }

  // 3. Daily budget + hard limit
  const budget = account.daily_budget?.[actionType]
  const usedToday = budget?.used || 0
  const limitCheck = checkHardLimit(actionType, usedToday, sessionCount)
  if (!limitCheck.allowed) {
    return { allowed: false, reason: limitCheck.reason, nickAge }
  }

  // 4. Gap enforcement — wait if last action was too recent
  const lastActedKey = `${actionType}_last_at`
  const lastActed = account.daily_budget?.[lastActedKey]
  if (lastActed) {
    const minGapMs = getMinGapMs(actionType)
    const elapsed = Date.now() - new Date(lastActed).getTime()
    if (elapsed < minGapMs) {
      const baseWait = minGapMs - elapsed
      // Add lognormal jitter so wait looks organic, not clock-exact
      const jittered = baseWait + R.humanDelay(800, 4000)
      console.log(`[ACTION-GUARD] ${actionType} gap: ${Math.round(baseWait / 1000)}s remaining → waiting ${Math.round(jittered / 1000)}s`)
      await R.sleep(jittered)
    }
  }

  return { allowed: true, nickAge }
}

/**
 * Record a completed action: increment used count + stamp last_at.
 * Call only after the action succeeds.
 * Also keeps account.daily_budget in-memory consistent for callers
 * that reference the account object later in the same run.
 */
async function recordAction(supabase, account, actionType) {
  const budget = { ...(account.daily_budget || {}) }
  const current = budget[actionType] || { used: 0, max: HARD_LIMITS[actionType]?.maxPerDay || 99 }
  const now = new Date().toISOString()

  const updated = {
    ...budget,
    [actionType]: { ...current, used: current.used + 1 },
    [`${actionType}_last_at`]: now,
    last_action_type: actionType,
    last_action_at: now,
  }

  await supabase.from('accounts')
    .update({ daily_budget: updated, last_used_at: now })
    .eq('id', account.id)
    .catch(err => console.warn(`[ACTION-GUARD] recordAction DB write failed: ${err.message}`))

  // Keep local copy consistent
  account.daily_budget = updated
}

/**
 * Navigate to a news feed or own profile briefly before going to the real target.
 * Breaks the direct-URL-jump bot pattern. Non-fatal — swallows errors.
 *
 * Called with the Playwright page object BEFORE page.goto(targetUrl).
 * Probability 30% — doesn't trigger every time.
 */
async function feedDetour(page) {
  if (Math.random() > 0.30) return

  const detourUrls = [
    'https://www.facebook.com/',
    'https://m.facebook.com/',
    'https://www.facebook.com/me',
  ]

  try {
    const url = detourUrls[Math.floor(Math.random() * detourUrls.length)]
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })

    // Browse briefly — 1-4 scrolls, random mouse, lognormal pause
    const { humanScroll, humanMouseMove } = require('../browser/human')
    const scrolls = Math.floor(Math.random() * 3) + 1
    for (let i = 0; i < scrolls; i++) {
      await humanScroll(page)
      if (Math.random() < 0.4) await humanMouseMove(page)
      await R.sleep(R.humanDelay(600, 2500))
    }

    await R.sleep(R.humanDelay(1500, 4000))
    console.log(`[ACTION-GUARD] Feed detour done (${url})`)
  } catch {
    // Non-fatal
  }
}

/**
 * Check if the current page is still logged in to Facebook.
 * Call this AFTER navigation to the target URL.
 * Returns true if the session looks valid, false if checkpointed/expired.
 *
 * When false:
 *   - Marks account inactive (status reflects the reason)
 *   - Inserts a user-facing notification asking to refresh cookie
 *   - Closes the open browser session so it does not get reopened
 */
async function checkSessionOnPage(page, supabase, accountId) {
  try {
    const result = await page.evaluate(() => {
      const url = window.location.href
      const text = (document.body?.innerText || '').substring(0, 2000)

      if (url.includes('/checkpoint/') || url.includes('/checkpoint?'))
        return { ok: false, reason: 'checkpoint' }
      if (url.includes('/login/') || url.includes('/login?') || url.includes('login.php'))
        return { ok: false, reason: 'session_expired' }
      if (/your account has been disabled|tài khoản.{0,20}bị vô hiệu hóa/i.test(text))
        return { ok: false, reason: 'disabled' }
      if (/your account has been locked|tài khoản.{0,20}bị khóa/i.test(text))
        return { ok: false, reason: 'locked' }
      if (/confirm your identity|xác nhận danh tính/i.test(text))
        return { ok: false, reason: 'identity_check' }
      if (/temporarily restricted|tạm thời hạn chế/i.test(text))
        return { ok: false, reason: 'restricted' }

      // "Continue as <name>" landing page — FB shows this when session cookie
      // is invalid but the device still remembers the profile. URL sometimes stays at
      // facebook.com root, but can happen on other URLs too.
      // Detect via the profile-picker buttons or the hero text.
      try {
        const btns = Array.from(document.querySelectorAll('a, [role="button"], button'))
          .map(b => (b.innerText || '').trim().toLowerCase())
        const hasContinueAs = btns.some(t => t === 'tiếp tục' || t === 'continue')
        const hasOtherProfile = btns.some(t =>
          t.includes('dùng trang cá nhân khác') || t.includes('use a different profile')
        )
        const hasCreate = btns.some(t =>
          t.includes('tạo tài khoản') || t.includes('create new account')
        )
        // Need at least 2 of the 3 profile-picker signals to avoid false positives
        const score = (hasContinueAs ? 1 : 0) + (hasOtherProfile ? 1 : 0) + (hasCreate ? 1 : 0)
        
        const hasDiscoverText = text.toLowerCase().includes('khám phá những điều bạn yêu thích') || 
                                text.toLowerCase().includes('discover what you love') ||
                                text.toLowerCase().includes('discover things you love')

        if (score >= 2 || hasDiscoverText) return { ok: false, reason: 'session_expired' }
      } catch {}

      return { ok: true }
    })

    if (!result.ok) {
      // Map detection reason → DB status. 'session_expired' is recoverable
      // (user re-uploads cookie); 'disabled'/'dead' are terminal.
      const STATUS_MAP = {
        session_expired: 'session_expired',
        checkpoint: 'checkpoint',
        disabled: 'disabled',
        locked: 'checkpoint',
        identity_check: 'checkpoint',
        restricted: 'checkpoint',
      }
      const newStatus = STATUS_MAP[result.reason] || 'checkpoint'
      console.log(`[ACTION-GUARD] Session invalid for ${accountId}: ${result.reason} → status=${newStatus}`)

      // Fetch nick info for notification + finding owner
      let nick = accountId
      let ownerId = null
      try {
        const { data } = await supabase
          .from('accounts')
          .select('username, owner_id, user_id')
          .eq('id', accountId)
          .single()
        if (data) {
          nick = data.username || nick
          ownerId = data.owner_id || data.user_id || null
        }
      } catch {}

      await supabase.from('accounts')
        .update({ status: newStatus, is_active: false })
        .eq('id', accountId)
        .catch(() => {})

      if (ownerId) {
        const titleVi = result.reason === 'checkpoint'
          ? `Nick ${nick} bị checkpoint — cần xử lý`
          : `Nick ${nick} cần lấy lại cookie`
        const bodyVi = result.reason === 'checkpoint'
          ? `Facebook yêu cầu xác minh. Hãy mở Chrome thật, đăng nhập + xử lý checkpoint, rồi paste cookie mới vào hệ thống.`
          : `Phiên đăng nhập đã hết hạn (Facebook hiển thị màn hình "Tiếp tục"). Vào Chrome thật, đăng nhập lại và cập nhật cookie cho nick này. Agent đã tạm dừng nick để tránh khoá thêm.`
        await supabase.from('notifications').insert({
          user_id: ownerId,
          type: result.reason === 'checkpoint' ? 'checkpoint' : 'session_expired',
          title: titleVi,
          body: bodyVi,
          level: 'urgent',
          data: { account_id: accountId, reason: result.reason },
        }).catch(() => {})
      }

      // Close the broken browser so the next poll cycle can't keep reusing it.
      // Lazy-require to avoid a require-cycle with browser/session-pool.
      try {
        const { closeSession } = require('../browser/session-pool')
        await closeSession(accountId)
      } catch {}

      return false
    }

    return true
  } catch {
    return true // assume ok if evaluate fails (page crash handled upstream)
  }
}

module.exports = { guardAction, recordAction, feedDetour, checkSessionOnPage }
