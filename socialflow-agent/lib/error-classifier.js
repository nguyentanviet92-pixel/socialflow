/**
 * Error classifier — maps handler errors onto known categories the poller
 * (and the failures log) uses to decide retry behavior + account status.
 *
 * This file was MISSING from the tree despite poller.js requiring it; every
 * thrown error was returning default UNKNOWN, so CHECKPOINT detection,
 * disable-on-confirmed-strike logic, and retry scheduling were all broken.
 *
 * Consumer shape (see poller.js):
 *   classifyError(msg)   → { type, alertLevel?, isBrowserCrash?, newStatus? }
 *   shouldDisableAccount(c) → boolean
 *   isRetryable(c)          → boolean
 *   getRetryDelayMs(c, n)   → number (ms)
 */

const PATTERNS = [
  // ── Checkpoint / account block (FB locked the account) ──
  {
    re: /checkpoint|unusual\s+activity|blocked\b|tài\s+khoản.*bị\s+(khoá|khóa)|we\s+just\s+need|xác\s+minh.*danh\s+tính/i,
    type: 'CHECKPOINT',
    newStatus: 'checkpoint',
    alertLevel: 'urgent',
    retryable: false,
  },

  // ── Session / cookie expired (needs fresh cookie) ──
  {
    re: /session\s+expired|please\s+log\s+in|cookie\s+expired|login\s+popup|hết\s+phiên|đăng\s+nhập\s+lại|Account\s+blocked.*Login\s+popup/i,
    type: 'SESSION_EXPIRED',
    newStatus: 'expired',
    alertLevel: 'urgent',
    retryable: false,
  },

  // ── Browser crash (infrastructure, not account fault) ──
  {
    re: /Target\s+(page|context|browser)\s+(has\s+been\s+)?closed|browser\s+has\s+been\s+closed|Protocol\s+error|Execution\s+context\s+was\s+destroyed|Session\s+closed\b|Page\.\w+:\s+Target/i,
    type: 'BROWSER_CRASH',
    isBrowserCrash: true,
    retryable: true,
  },

  // ── Network (transient, retry) ──
  {
    re: /net::ERR_|Navigation\s+timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket\s+hang\s+up|ERR_ABORTED|ERR_TIMED_OUT/i,
    type: 'NETWORK_ERROR',
    retryable: true,
  },

  // ── Session pool busy (our own throttling) ──
  {
    re: /SESSION_POOL_BUSY/,
    type: 'BUSY',
    retryable: true,
  },

  // ── Explicit skip from handler body ──
  {
    re: /^SKIP_/,
    type: 'SKIP',
    retryable: false,
  },
]

function classifyError(message, stack) {
  const text = (message || '') + (stack ? ' ' + stack : '')
  // Auth loss often arrives as "Account blocked: Session expired/Login form".
  // Catch it before the broad CHECKPOINT pattern sees the word "blocked".
  if (/session\s+expired|please\s+log\s+in|cookie\s+expired|login\s+(popup|form\s+detected)|saved-login\s+chooser|page\s+shows\s+not\s+found|need\s+re-login|hết\s+phiên|đăng\s+nhập\s+lại|Account\s+blocked:\s*(Session expired|Login form|Saved-login|Page shows Not Found)/i.test(text)) {
    return {
      type: 'SESSION_EXPIRED',
      newStatus: 'expired',
      alertLevel: 'urgent',
      isBrowserCrash: false,
    }
  }
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      return {
        type: p.type,
        newStatus: p.newStatus || null,
        alertLevel: p.alertLevel || null,
        isBrowserCrash: !!p.isBrowserCrash,
      }
    }
  }
  return { type: 'UNKNOWN', newStatus: null, alertLevel: null, isBrowserCrash: false }
}

// Only CHECKPOINT and SESSION_EXPIRED flip the account to inactive.
// Poller.js has its own 2-strikes-in-1-hour guard for CHECKPOINT before it
// actually calls this, so we can return true for the base types and let the
// caller apply its own confirm-window logic.
function shouldDisableAccount(classified) {
  return classified?.type === 'CHECKPOINT' || classified?.type === 'SESSION_EXPIRED'
}

// SKIP is the handler's explicit "don't retry me" signal (e.g., SKIP_no_groups_joined).
// CHECKPOINT / SESSION_EXPIRED are account-level dead until the user fixes them.
// BUSY / NETWORK / BROWSER_CRASH / UNKNOWN all retry.
function isRetryable(classified) {
  if (!classified) return false
  if (classified.type === 'CHECKPOINT') return false
  if (classified.type === 'SESSION_EXPIRED') return false
  if (classified.type === 'SKIP') return false
  return true
}

// Exponential-ish backoff with per-category base. attempt is 0-indexed.
function getRetryDelayMs(classified, attempt = 0) {
  const n = Math.max(0, Math.min(attempt, 4))
  const type = classified?.type || 'UNKNOWN'
  const schedules = {
    BUSY:          [30, 60, 90, 120, 180],     // seconds
    NETWORK_ERROR: [60, 180, 300, 600, 900],
    BROWSER_CRASH: [60, 120, 240, 480, 900],
    UNKNOWN:       [120, 300, 600, 900, 1800],
  }
  const table = schedules[type] || schedules.UNKNOWN
  return table[n] * 1000
}

module.exports = {
  classifyError,
  shouldDisableAccount,
  isRetryable,
  getRetryDelayMs,
}
