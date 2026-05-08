const axios = require('axios')

const FB_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://www.facebook.com',
  'Referer': 'https://www.facebook.com/',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors'
}

async function getFbDtsg(account, proxyConfig = null) {
  const res = await axios.get('https://www.facebook.com/', {
    headers: { Cookie: account.cookie_string, 'User-Agent': account.user_agent, ...FB_HEADERS },
    ...(proxyConfig && { proxy: buildAxiosProxy(proxyConfig) }),
    timeout: 15000
  })

  const patterns = [
    /"DTSGInitData".*?"token":"([^"]+)"/,
    /"fb_dtsg","value":"([^"]+)"/
  ]

  for (const p of patterns) {
    const m = res.data.match(p)
    if (m) return m[1]
  }
  return null
}

async function validateCookie(account, proxyConfig = null) {
  try {
    const res = await axios.get('https://www.facebook.com/', {
      headers: { Cookie: account.cookie_string, 'User-Agent': account.user_agent || getDefaultUA(), ...FB_HEADERS },
      ...(proxyConfig && { proxy: buildAxiosProxy(proxyConfig) }),
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
    })

    const html = String(res.data || '')
    const finalUrl = (res.request?.res?.responseUrl || res.config?.url || '').toLowerCase()

    // Hard checkpoint markers
    if (finalUrl.includes('/checkpoint') || /checkpoint|security check|verify your identity|xác nhận danh tính/i.test(html)) {
      return { valid: false, reason: 'CHECKPOINT' }
    }
    if (/account disabled|tài khoản.{0,20}bị vô hiệu hóa/i.test(html)) {
      return { valid: false, reason: 'DISABLED' }
    }
    if (/try again later|too many requests/i.test(html)) {
      return { valid: false, reason: 'RATE_LIMIT' }
    }

    // Strong logged-in markers (positive signals only — don't trust absence)
    const hasUserIdJson = /"USER_ID"\s*:\s*"\d+"/.test(html) || /"actorID"\s*:\s*"\d+"/.test(html)
    const hasLoggedInTrue = /"is_logged_in"\s*:\s*true/.test(html)
    const hasDtsg = /"DTSGInitialData"|name="fb_dtsg"/.test(html)
    if (hasUserIdJson || hasLoggedInTrue || hasDtsg) return { valid: true }

    // Saved-login chooser ("Tiếp tục as X" / "Create new account") = logged out
    const hasCreateAccount = /tạo tài khoản mới|create new account/i.test(html)
    const hasContinue = /tiếp tục|continue|dùng trang cá nhân khác|use another profile/i.test(html)
    if (hasCreateAccount && hasContinue) return { valid: false, reason: 'SESSION_EXPIRED' }

    // Login URL or login form
    if (finalUrl.includes('/login') || /form[^>]+id="?login_form"?|name="email"[^>]*type="email"/i.test(html)) {
      return { valid: false, reason: 'SESSION_EXPIRED' }
    }
    if (/"is_logged_in"\s*:\s*false/.test(html) || /please log in|session expired/i.test(html)) {
      return { valid: false, reason: 'SESSION_EXPIRED' }
    }

    // Ambiguous — don't lie. Caller should fall back to agent verify.
    return { valid: null, reason: 'AMBIGUOUS' }
  } catch {
    return { valid: false, reason: 'NETWORK_ERROR' }
  }
}

async function getDtsgWithRefresh(account, supabase, proxyConfig) {
  const now = new Date()
  const expiresAt = account.dtsg_expires_at ? new Date(account.dtsg_expires_at) : null

  if (!account.fb_dtsg || !expiresAt || now > new Date(expiresAt - 5 * 60 * 1000)) {
    const dtsg = await getFbDtsg(account, proxyConfig)
    if (!dtsg) throw new Error('Cannot get fb_dtsg - cookie may be expired')

    await supabase.from('accounts').update({
      fb_dtsg: dtsg,
      dtsg_expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    }).eq('id', account.id)

    return dtsg
  }

  return account.fb_dtsg
}

function buildAxiosProxy(proxy) {
  return {
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username && { auth: { username: proxy.username, password: proxy.password } })
  }
}

function getDefaultUA() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

function extractCUserId(cookieString) {
  const match = cookieString.match(/c_user=(\d+)/)
  return match ? match[1] : null
}

/**
 * Normalize cookie input into a clean "name=value; name=value" string.
 *
 * Accepts three shapes users tend to paste:
 *   1. Plain cookie header  — "c_user=123; xs=abc; datr=..."
 *   2. EditThisCookie JSON  — '[{"name":"c_user","value":"123",...},...]'
 *   3. A messy concat of (1) + (2) — what kills parsing in session-pool.js
 *
 * Returns { ok, cookieString, reason, fbUserId } where ok=false signals the
 * input has no usable auth cookies (caller should reject).
 */
function normalizeCookieInput(input) {
  if (!input || typeof input !== 'string') return { ok: false, reason: 'empty' }
  const parsed = {}

  // Extract any JSON array portion first — user may have pasted a mix.
  const jsonMatch = input.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0])
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c.name === 'string' && c.value !== undefined) {
            parsed[c.name] = String(c.value)
          }
        }
      }
    } catch { /* ignore — fall back to regex on plain section */ }
  }

  // Plain cookie-header portion = everything except the JSON chunk.
  const plain = jsonMatch ? input.replace(jsonMatch[0], ' ') : input
  for (const pair of plain.split(/[;\n]/)) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name || !value) continue
    // Only keep name tokens that look like a real cookie name (no spaces,
    // no JSON punctuation sneaking through).
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) continue
    // Don't overwrite a JSON-parsed value with a corrupted plain fragment.
    if (parsed[name]) continue
    parsed[name] = value
  }

  if (!parsed.c_user || !/^\d+$/.test(parsed.c_user)) {
    return { ok: false, reason: 'missing_c_user' }
  }
  if (!parsed.xs || parsed.xs.length < 10) {
    return { ok: false, reason: 'missing_xs' }
  }

  // Preserve the common FB cookie ordering so downstream looks familiar.
  const priorityOrder = ['sb', 'datr', 'ps_l', 'ps_n', 'c_user', 'xs', 'fr', 'presence', 'wd', 'locale']
  const ordered = []
  for (const k of priorityOrder) if (parsed[k] !== undefined) ordered.push(`${k}=${parsed[k]}`)
  for (const [k, v] of Object.entries(parsed)) if (!priorityOrder.includes(k)) ordered.push(`${k}=${v}`)

  return {
    ok: true,
    cookieString: ordered.join('; '),
    fbUserId: parsed.c_user,
  }
}

function generateFingerprint(seed) {
  const hash = require('crypto').createHash('md5').update(seed || '').digest('hex')
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 }
  ]
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ]

  const idx = parseInt(hash.substring(0, 8), 16)
  return {
    userAgent: userAgents[idx % userAgents.length],
    viewport: viewports[idx % viewports.length],
    timezone: 'Asia/Ho_Chi_Minh'
  }
}

module.exports = { getFbDtsg, validateCookie, getDtsgWithRefresh, FB_HEADERS, buildAxiosProxy, getDefaultUA, extractCUserId, generateFingerprint, normalizeCookieInput }
