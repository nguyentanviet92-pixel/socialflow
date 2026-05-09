/**
 * Browser Session Pool
 * Giữ browser mở giữa các job để tránh checkpoint từ việc đóng/mở liên tục
 */
const { launchBrowser } = require('./launcher')
const path = require('path')
const os = require('os')

const PROFILES_DIR = path.join(os.homedir(), '.socialflow', 'profiles')
const IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 phút (tăng lên vì fetch có thể lâu)

// Map account_id -> { browser, context, storageFile, lastUsed, closing }
const sessions = new Map()

let cleanupInterval = null

/**
 * Lấy session hiện có hoặc tạo mới
 * @param {object} account - account record từ DB
 * @param {object} opts - { headless: boolean } - override headless mode
 */
async function getSession(account, opts = {}) {
  const id = account.id || account.account_id

  const existing = sessions.get(id)
  if (existing && !existing.closing) {
    // Check browser còn sống không
    try {
      const contexts = existing.browser.contexts()
      if (contexts.length > 0) {
        existing.lastUsed = Date.now()
        console.log(`[SESSION-POOL] Reusing session for ${account.username || id}`)
        return existing
      }
    } catch {
      // Browser đã chết, xóa và tạo mới
      sessions.delete(id)
    }
  }

  // Strict 1-browser-at-a-time: trước khi mở nick mới, đóng mọi session
  // của nick KHÁC (giữ lại session cùng id nếu có — đã handle ở block trên).
  // Cookies + IndexedDB persist trong userDataDir + storageFile nên reopen
  // không gián đoạn login. FB cluster detection ghét nhiều session cùng máy.
  await closeOtherSessions(id)

  // Tạo session mới
  const headlessLabel = opts.headless ? ' (headless)' : ''
  console.log(`[SESSION-POOL] Creating new session for ${account.username || id}${headlessLabel}`)
  const session = await launchBrowser({ ...account, proxy: account.proxies ? {
    type: account.proxies.type || 'http',
    host: account.proxies.host,
    port: account.proxies.port,
    username: account.proxies.username,
    password: account.proxies.password
  } : account.proxy || null }, { headless: opts.headless })

  const entry = {
    browser: session.browser,
    context: session.context,
    storageFile: session.storageFile,
    profileDir: session.profileDir,
    lastUsed: Date.now(),
    closing: false,
  }

  // 2026-05-04: kill popup tabs as soon as the context spawns them.
  // Cause: FB click handlers for profile previews / group cards / share
  // dialogs frequently use window.open() or target="_blank", which creates
  // a fresh blank tab. Our handlers never click "Close" on these, so they
  // pile up as `about:blank` tabs (user reported 12+ stuck tabs in one
  // session). getPage()/releaseSession() trim extras only between jobs;
  // this listener catches them mid-job too.
  //
  // CRITICAL: don't touch the initial blank tab Camoufox creates during
  // launchPersistentContext — closing it makes the context emit
  // "Target page, context or browser has been closed" on the very next
  // call, killing the whole session. Only close *additional* about:blank
  // tabs that appear *after* the session has a working main tab.
  session.context.on('page', async (popup) => {
    try { await popup.waitForLoadState('domcontentloaded', { timeout: 3000 }) } catch {}
    try {
      // If this is one of the first 1-2 pages on the context, it's the
      // initial blank tab from launch — keep it.
      const pageCount = session.context.pages().length
      if (pageCount <= 1) return

      const url = popup.url()
      if (!url || url === 'about:blank' || url.startsWith('about:')) {
        await popup.close()
        console.log(`[SESSION-POOL] Auto-closed popup tab for ${account.username || id} (had ${pageCount} pages)`)
      }
    } catch {}
  })

  entry._saveInterval = setInterval(async () => {
    try {
      await entry.context.storageState({ path: entry.storageFile })
      console.log(`[SESSION-POOL] 💾 Periodic save for ${account.username || id}`)
    } catch {}
  }, 5 * 60 * 1000)

  sessions.set(id, entry)
  startCleanup()
  return entry
}

/**
 * Check xem profile dir đã có FB cookies hợp lệ chưa.
 * Hợp lệ = có c_user (uid) VÀ xs (session secret) và đều non-empty.
 */
async function hasValidFbCookies(context) {
  try {
    const cookies = await context.cookies('https://www.facebook.com')
    const cUser = cookies.find(c => c.name === 'c_user' && c.value && c.value.length > 0)
    const xs = cookies.find(c => c.name === 'xs' && c.value && c.value.length > 0)
    return !!(cUser && xs)
  } catch {
    return false
  }
}

/**
 * Inject cookies từ account.cookie_string (DB) vào context.
 * Chỉ gọi khi profile dir KHÔNG có cookies hợp lệ.
 */
async function injectDbCookies(context, account) {
  if (!account.cookie_string) return false
  const cookies = account.cookie_string.split(';').map(c => {
    const [name, ...rest] = c.trim().split('=')
    return name ? {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: '.facebook.com',
      path: '/',
      secure: true,
    } : null
  }).filter(Boolean)
  if (!cookies.length) return false
  await context.addCookies(cookies)
  return true
}

/**
 * Tạo page mới với cookies từ account.
 *
 * Cookie priority (Fix checkpoint spam):
 *   1. Profile dir cookies (persistent storage.json) — fresh, do playwright giữ live
 *   2. DB cookies (account.cookie_string) — fallback khi profile trống/invalid
 *
 * DB cookies thường stale (user paste 1 lần rồi thôi) → nếu inject đè lên profile
 * sẽ ghi đè session đang hoạt động → FB detect inconsistency → checkpoint.
 *
 * Exception: forceDbCookies=true (set by check-health when triggered_by='cookie_update')
 * → user JUST pasted fresh cookies, profile has OLD dead cookies → inject DB cookies.
 *
 * @param {object} account - account record từ DB
 * @param {object} opts - { headless: boolean, forceDbCookies: boolean }
 */
async function getPage(account, opts = {}) {
  const id = account.id || account.account_id
  const username = account.username || id

  let session = await getSession(account, opts)
  let page

  // Reuse an existing tab instead of opening a new one — handlers navigate
  // via page.goto() so a single tab can handle the whole job. None of the
  // campaign-* handlers call page.close() in their finally blocks, so
  // without reuse we leak one tab per job run → browser accumulates 10+
  // tabs for the same nick and memory blows up.
  //
  // Policy:
  //   - ≥1 page exists → keep the FIRST, close all others (extras from
  //     parallel scroll/open handlers or previous runs)
  //   - 0 pages → create one (shouldn't happen with persistent context
  //     since launch creates an initial blank tab, but handle defensively)
  try {
    const existing = session.context.pages()
    if (existing.length > 0) {
      page = existing[0]
      for (let i = 1; i < existing.length; i++) {
        try { await existing[i].close() } catch {}
      }
      if (existing.length > 1) {
        console.log(`[SESSION-POOL] Reused tab for ${username}, closed ${existing.length - 1} extra tab(s)`)
      }
    } else {
      page = await session.context.newPage()
    }
  } catch (err) {
    console.warn(`[SESSION-POOL] getPage failed for ${username}: ${err.message} — recreating session`)
    try { await closeSession(id) } catch {}
    session = await getSession(account, opts)
    page = await session.context.newPage()
  }

  // Decide cookie source: profile > DB (unless forceDbCookies is set)
  if (opts.forceDbCookies) {
    // Cookie just updated via UI — always inject fresh DB cookies.
    // Clear existing FB cookies first so they don't conflict.
    try {
      const oldCookies = await session.context.cookies('https://www.facebook.com')
      if (oldCookies.length > 0) {
        await session.context.clearCookies()
        console.log(`[SESSION-POOL] 🧹 Cleared ${oldCookies.length} stale profile cookies for ${username}`)
      }
    } catch {}
    const injected = await injectDbCookies(session.context, account)
    if (injected) {
      console.log(`[SESSION-POOL] 💉 Force-injected fresh DB cookies for ${username} (cookie_update)`)
    } else {
      console.warn(`[SESSION-POOL] ⚠️  forceDbCookies=true but no DB cookies available for ${username}`)
    }
  } else {
    const profileHasCookies = await hasValidFbCookies(session.context)
    if (profileHasCookies) {
      console.log(`[SESSION-POOL] 🍪 Using profile cookies for ${username} (profile dir has valid c_user+xs)`)
    } else {
      const injected = await injectDbCookies(session.context, account)
      if (injected) {
        console.log(`[SESSION-POOL] 💉 Injecting DB cookies for ${username} (profile dir empty/invalid)`)
      } else {
        console.warn(`[SESSION-POOL] ⚠️  No cookies available for ${username} — neither profile nor DB has FB cookies`)
      }
    }
  }

  return { page, session }
}

/**
 * Đánh dấu session idle (KHÔNG đóng) + trim tabs xuống 1.
 * Đóng mọi tab phụ (popup, FB ads interstitial) còn sót, giữ 1 tab chính.
 * KHÔNG park về about:blank — nhìn như đang đứng, gây khó chịu thị giác.
 * DOM của trang cũ sẽ tự giải phóng khi job sau gọi page.goto().
 */
async function releaseSession(accountId) {
  const session = sessions.get(accountId)
  if (!session) return
  session.lastUsed = Date.now()
  try {
    const pages = session.context.pages()
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close() } catch {}
    }
  } catch {}
}

/**
 * Đóng tất cả session KHÁC accountId hiện tại (giữ lại session cùng id).
 * Gọi trước khi mở nick mới để enforce 1-browser-at-a-time.
 */
async function closeOtherSessions(keepAccountId) {
  const others = []
  for (const [id, entry] of sessions) {
    if (id !== keepAccountId && !entry.closing) others.push(id)
  }
  if (others.length === 0) return
  console.log(`[SESSION-POOL] Closing ${others.length} other session(s) before opening new nick: ${others.map(s => s.slice(0, 8)).join(', ')}`)
  await Promise.allSettled(others.map(id => closeSession(id)))
}

/**
 * Đóng session thật + save cookies
 */
async function closeSession(accountId) {
  const session = sessions.get(accountId)
  if (!session || session.closing) return

  session.closing = true
  if (session._saveInterval) {
    clearInterval(session._saveInterval)
    session._saveInterval = null
  }
  console.log(`[SESSION-POOL] Closing session for ${accountId}`)

  try {
    await session.context.storageState({ path: session.storageFile })
  } catch {}
  try {
    await session.browser.close()
  } catch {}

  sessions.delete(accountId)
}

/**
 * Đóng tất cả sessions (gọi khi agent shutdown)
 */
async function closeAll() {
  console.log(`[SESSION-POOL] Closing all ${sessions.size} sessions...`)
  const promises = []
  for (const [id] of sessions) {
    promises.push(closeSession(id))
  }
  await Promise.allSettled(promises)
  stopCleanup()
}

/**
 * Cleanup idle sessions - KHÔNG đóng nếu còn page đang mở (đang chạy job)
 */
function cleanupIdleSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > IDLE_TIMEOUT_MS && !session.closing) {
      // Check xem còn page nào đang mở không (= đang chạy job)
      try {
        const pages = session.context.pages()
        if (pages.length > 0) {
          // Có page đang mở → job đang chạy, KHÔNG đóng, refresh lastUsed
          session.lastUsed = Date.now()
          console.log(`[SESSION-POOL] Session ${id} has ${pages.length} active pages, keeping alive`)
          continue
        }
      } catch {
        // Context đã chết, đóng luôn
      }
      console.log(`[SESSION-POOL] Session ${id} idle for ${Math.round(IDLE_TIMEOUT_MS / 60000)}min, closing...`)
      closeSession(id)
    }
  }
}

function startCleanup() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupIdleSessions, 30000) // check mỗi 30s
  }
}

function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}

function getActiveSessions() {
  return sessions.size
}

function getSessionCount() {
  return sessions.size
}

module.exports = {
  getSession,
  getPage,
  releaseSession,
  closeSession,
  closeOtherSessions,
  closeAll,
  getActiveSessions,
  getSessionCount,
}
