const { google } = require('googleapis')
const { cached, invalidate } = require('../lib/redis')

const SCOPES = [
  'email',
  'profile',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/websites/google/callback'
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET chưa cấu hình trong .env')
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

function buildOAuthClient(site) {
  const client = getOAuthClient()
  client.setCredentials({
    access_token: site.google_access_token,
    refresh_token: site.google_refresh_token,
    expiry_date: site.google_token_expiry ? new Date(site.google_token_expiry).getTime() : null,
  })
  return client
}

module.exports = async (fastify) => {
  const { getAccessibleIds, canAccess } = require('../lib/access-check')

  // Helper: check access to a website resource
  async function verifyWebsiteAccess(req, reply, websiteId) {
    if (req.user.role === 'admin') return true
    const ok = await canAccess(supabase, req.user.id, 'website', websiteId)
    if (!ok) {
      reply.code(403).send({ error: 'Forbidden: Bạn không có quyền truy cập website này' })
      return false
    }
    return true
  }

  // ─── List & Delete ────────────────────────────────────────────────────────────

  // GET /websites — list connected websites (only finalized ones)
  fastify.get('/', { preHandler: fastify.authenticate }, async (req, reply) => {
    let query = supabase
      .from('websites')
      .select('id, name, url, google_email, ga_property_id, ga_property_name, gsc_site_url, created_at')
      .neq('url', 'pending')           // hide temp records
      .order('created_at', { ascending: false })

    if (req.user.role !== 'admin') {
      const accessibleIds = await getAccessibleIds(supabase, req.user.id, 'website')
      if (accessibleIds.length === 0) return []
      query = query.in('id', accessibleIds)
    }

    const { data, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // DELETE /websites/:id
  fastify.delete('/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const hasAccess = await verifyWebsiteAccess(req, reply, req.params.id)
    if (!hasAccess) return

    const { error } = await supabase
      .from('websites')
      .delete()
      .eq('id', req.params.id)
    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // ─── Google OAuth ─────────────────────────────────────────────────────────────

  // GET /websites/google/debug-uri — xem redirect_uri đang dùng
  fastify.get('/google/debug-uri', async (req, reply) => {
    return {
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || '(not set, default: http://localhost:3000/websites/google/callback)',
      FRONTEND_URL: process.env.FRONTEND_URL || '(not set, default: http://localhost:5173)',
    }
  })

  // GET /websites/google/auth?token=JWT
  // Step 1: validate token, create temp record, redirect to Google
  fastify.get('/google/auth', async (req, reply) => {
    const { token } = req.query

    // Helper: close popup with error message — MUST be defined first
    const errorPopup = (msg) => reply.type('text/html').send(`
      <html><body style="font-family:sans-serif;padding:2rem;text-align:center">
        <p style="color:red;font-size:14px;margin-bottom:8px">${msg}</p>
        <p style="color:#888;font-size:12px">Cửa sổ này sẽ tự đóng...</p>
        <script>
          try { window.opener && window.opener.postMessage({ type: 'google_oauth', ok: false, msg: ${JSON.stringify(String(msg || ''))} }, '*') } catch(e){}
          setTimeout(() => { try { window.close() } catch(e){} }, 2000)
        </script>
      </body></html>
    `)

    if (!token) return errorPopup('Thiếu token xác thực')

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return errorPopup('Token không hợp lệ hoặc đã hết hạn. Hãy thử lại.')

    let oauth2Client
    try { oauth2Client = getOAuthClient() } catch (e) {
      return errorPopup(e.message)
    }

    // Create a temporary website record to hold tokens after callback
    const { data: tmpSite, error: dbErr } = await supabase
      .from('websites')
      .insert({ owner_id: user.id, name: 'Đang kết nối...', url: 'pending' })
      .select()
      .single()
    if (dbErr) return errorPopup('Lỗi tạo record: ' + dbErr.message)

    const state = Buffer.from(JSON.stringify({ website_id: tmpSite.id, user_id: user.id })).toString('base64')
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state,
    })
    return reply.redirect(authUrl)
  })

  // GET /websites/google/callback — Google redirects here
  fastify.get('/google/callback', async (req, reply) => {
    const { code, state, error: oauthError } = req.query
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'

    // Redirect popup to frontend /oauth-callback page (same origin as parent)
    // so BroadcastChannel works. COOP from Google breaks window.opener.postMessage.
    const redirectOk = (website_id, email) =>
      reply.redirect(`${frontendUrl}/oauth-callback?website_id=${encodeURIComponent(website_id)}&email=${encodeURIComponent(email || '')}`)
    const redirectErr = (msg) =>
      reply.redirect(`${frontendUrl}/oauth-callback?error=${encodeURIComponent(msg)}`)

    if (oauthError) return redirectErr('Đăng nhập Google bị huỷ.')

    let parsed
    try { parsed = JSON.parse(Buffer.from(state, 'base64').toString()) } catch {
      return redirectErr('State không hợp lệ.')
    }
    const { website_id, user_id } = parsed

    let oauth2Client
    try { oauth2Client = getOAuthClient() } catch (e) {
      return redirectErr(e.message)
    }

    // Exchange code → tokens
    let tokens
    try {
      const { tokens: t } = await oauth2Client.getToken(code)
      tokens = t
    } catch (e) {
      await supabase.from('websites').delete().eq('id', website_id)
      return redirectErr('Lỗi xác thực Google: ' + e.message)
    }

    oauth2Client.setCredentials(tokens)

    // Get Google email
    let googleEmail = null
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
      const { data: userInfo } = await oauth2.userinfo.get()
      googleEmail = userInfo.email
    } catch {}

    // Save tokens to the temp website record
    const { error: dbErr } = await supabase
      .from('websites')
      .update({
        google_email: googleEmail,
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token || undefined,
        google_token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', website_id)
      .eq('owner_id', user_id)

    if (dbErr) return redirectErr('Lỗi lưu token: ' + dbErr.message)

    return redirectOk(website_id, googleEmail)
  })

  // ─── GSC / GA data ────────────────────────────────────────────────────────────

  // GET /websites/:id/gsc-sites — list Search Console sites for connected account
  fastify.get('/:id/gsc-sites', { preHandler: fastify.authenticate }, async (req, reply) => {
    const hasAccess = await verifyWebsiteAccess(req, reply, req.params.id)
    if (!hasAccess) return

    const { data: site, error } = await supabase
      .from('websites')
      .select('google_access_token, google_refresh_token, google_token_expiry')
      .eq('id', req.params.id)
      .single()
    if (error || !site) return reply.code(404).send({ error: 'Không tìm thấy' })
    if (!site.google_access_token) return reply.code(400).send({ error: 'Chưa kết nối Google' })

    let oauth2Client
    try { oauth2Client = buildOAuthClient(site) } catch (e) {
      return reply.code(503).send({ error: e.message })
    }

    try {
      const searchconsole = google.searchconsole({ version: 'v1', auth: oauth2Client })
      const { data } = await searchconsole.sites.list()
      return { sites: (data.siteEntry || []).map(s => ({ url: s.siteUrl, level: s.permissionLevel })) }
    } catch (e) {
      return reply.code(502).send({ error: 'Lỗi Search Console: ' + e.message })
    }
  })

  // GET /websites/:id/ga-properties — list GA4 properties
  fastify.get('/:id/ga-properties', { preHandler: fastify.authenticate }, async (req, reply) => {
    const hasAccess = await verifyWebsiteAccess(req, reply, req.params.id)
    if (!hasAccess) return

    const { data: site, error } = await supabase
      .from('websites')
      .select('google_access_token, google_refresh_token, google_token_expiry')
      .eq('id', req.params.id)
      .single()
    if (error || !site) return reply.code(404).send({ error: 'Không tìm thấy' })
    if (!site.google_access_token) return reply.code(400).send({ error: 'Chưa kết nối Google' })

    let oauth2Client
    try { oauth2Client = buildOAuthClient(site) } catch (e) {
      return reply.code(503).send({ error: e.message })
    }

    try {
      const analyticsAdmin = google.analyticsadmin({ version: 'v1beta', auth: oauth2Client })
      // Must list accounts first, then properties per account
      const { data: acctData } = await analyticsAdmin.accounts.list()
      const accounts = acctData.accounts || []
      const allProperties = []
      for (const acct of accounts) {
        const { data } = await analyticsAdmin.properties.list({
          filter: `parent:${acct.name}`,
          pageSize: 200,
        })
        for (const p of (data.properties || [])) {
          allProperties.push({ id: p.name, name: p.displayName, timezone: p.timeZone })
        }
      }
      return { properties: allProperties }
    } catch (e) {
      return reply.code(502).send({ error: 'Lỗi Analytics Admin: ' + e.message })
    }
  })

  // POST /websites/:id/finalize — user picked GSC sites (supports multiple)
  // Body: { sites: [{ gsc_site_url, ga_property_id?, ga_property_name? }] }
  // First site updates the temp record; additional sites clone the tokens into new records.
  fastify.post('/:id/finalize', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { sites } = req.body
    if (!sites?.length) return reply.code(400).send({ error: 'sites array required' })

    const hasAccess = await verifyWebsiteAccess(req, reply, req.params.id)
    if (!hasAccess) return

    // Fetch temp record for token cloning
    const { data: tmpSite, error: fetchErr } = await supabase
      .from('websites')
      .select('google_email, google_access_token, google_refresh_token, google_token_expiry')
      .eq('id', req.params.id)
      .single()
    if (fetchErr || !tmpSite) return reply.code(404).send({ error: 'Temp record not found' })

    const results = []

    for (let i = 0; i < sites.length; i++) {
      const { gsc_site_url, ga_property_id, ga_property_name } = sites[i]
      if (!gsc_site_url) continue
      const name = gsc_site_url.replace(/^https?:\/\//, '').replace(/\/$/, '')
      const fields = {
        name, url: gsc_site_url, gsc_site_url,
        ...(ga_property_id && { ga_property_id, ga_property_name }),
        updated_at: new Date().toISOString(),
      }

      if (i === 0) {
        // Update the existing temp record
        const { data, error } = await supabase
          .from('websites').update(fields)
          .eq('id', req.params.id)
          .select().single()
        if (error) return reply.code(500).send({ error: error.message })
        results.push(data)
      } else {
        // Clone tokens into a new record
        const { data, error } = await supabase
          .from('websites').insert({
            owner_id: req.user.id,
            google_email: tmpSite.google_email,
            google_access_token: tmpSite.google_access_token,
            google_refresh_token: tmpSite.google_refresh_token,
            google_token_expiry: tmpSite.google_token_expiry,
            ...fields,
          }).select().single()
        if (error) return reply.code(500).send({ error: error.message })
        results.push(data)
      }
    }

    return results
  })

  // ─── GSC Query Data ───────────────────────────────────────────────────────────

  // Helper: get site + oauth client
  async function getSiteWithAuth(req, reply) {
    const hasAccess = await verifyWebsiteAccess(req, reply, req.params.id)
    if (!hasAccess) return null

    const { data: site, error } = await supabase
      .from('websites')
      .select('gsc_site_url, ga_property_id, google_access_token, google_refresh_token, google_token_expiry')
      .eq('id', req.params.id)
      .single()
    if (error || !site) { reply.code(404).send({ error: 'Không tìm thấy' }); return null }
    if (!site.google_access_token) { reply.code(400).send({ error: 'Chưa kết nối Google' }); return null }
    try {
      site._oauth = buildOAuthClient(site)
      return site
    } catch (e) { reply.code(503).send({ error: e.message }); return null }
  }

  // POST /websites/:id/gsc-query — query GSC data (keywords, pages, etc.)
  // Body: { startDate, endDate, dimensions: ['query'|'page'|'date'|'device'|'country'], rowLimit?, startRow?, filters? }
  fastify.post('/:id/gsc-query', { preHandler: fastify.authenticate }, async (req, reply) => {
    const site = await getSiteWithAuth(req, reply)
    if (!site) return

    const { startDate, endDate, dimensions = ['query'], rowLimit = 100, startRow = 0, dimensionFilterGroups, orderBy } = req.body
    if (!startDate || !endDate) return reply.code(400).send({ error: 'startDate & endDate required (YYYY-MM-DD)' })

    try {
      const searchconsole = google.searchconsole({ version: 'v1', auth: site._oauth })
      const body = {
        startDate,
        endDate,
        dimensions,
        rowLimit: Math.min(rowLimit, 1000),
        startRow,
      }
      if (dimensionFilterGroups) body.dimensionFilterGroups = dimensionFilterGroups
      if (orderBy) body.orderBy = orderBy

      const { data } = await searchconsole.searchanalytics.query({
        siteUrl: site.gsc_site_url,
        requestBody: body,
      })

      return {
        rows: (data.rows || []).map(r => ({
          keys: r.keys,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        })),
        totalRows: data.rows?.length || 0,
      }
    } catch (e) {
      return reply.code(502).send({ error: 'Lỗi GSC: ' + e.message })
    }
  })

  // ─── Cache (Redis nếu có, fallback in-memory) ──────────────────────────────

  // POST /websites/:id/gsc-overview — quick overview for dashboard
  // Optimized: all GSC queries run in parallel via Promise.all
  fastify.post('/:id/gsc-overview', { preHandler: fastify.authenticate }, async (req, reply) => {
    const site = await getSiteWithAuth(req, reply)
    if (!site) return

    const { startDate, endDate, compareStartDate, compareEndDate } = req.body
    if (!startDate || !endDate) return reply.code(400).send({ error: 'startDate & endDate required' })

    const cacheKey = `overview:${req.params.id}:${startDate}:${endDate}:${compareStartDate || ''}:${compareEndDate || ''}`

    try {
      const result = await cached(cacheKey, 5 * 60, async () => {
        const searchconsole = google.searchconsole({ version: 'v1', auth: site._oauth })
        const siteUrl = site.gsc_site_url

        // Run ALL queries in parallel — 3x faster than sequential
        const queries = [
          searchconsole.searchanalytics.query({ siteUrl, requestBody: { startDate, endDate, dimensions: ['date'], rowLimit: 500 } }),
          searchconsole.searchanalytics.query({ siteUrl, requestBody: { startDate, endDate, dimensions: ['query'], rowLimit: 20 } }),
          searchconsole.searchanalytics.query({ siteUrl, requestBody: { startDate, endDate, dimensions: ['page'], rowLimit: 20 } }),
        ]
        if (compareStartDate && compareEndDate) {
          queries.push(searchconsole.searchanalytics.query({
            siteUrl, requestBody: { startDate: compareStartDate, endDate: compareEndDate, dimensions: ['date'], rowLimit: 500 },
          }))
        }

        const responses = await Promise.all(queries)
        const [byDateResp, queriesResp, pagesResp] = responses
        const dateRows = byDateResp.data.rows || []

        // Totals
        const totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 }
        for (const r of dateRows) { totals.clicks += r.clicks; totals.impressions += r.impressions }
        totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0
        totals.position = dateRows.length > 0 ? dateRows.reduce((s, r) => s + r.position, 0) / dateRows.length : 0

        const res = {
          totals,
          byDate: dateRows.map(r => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
          topQueries: (queriesResp.data.rows || []).map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
          topPages: (pagesResp.data.rows || []).map(r => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
        }

        // Compare period
        if (responses[3]) {
          const cRows = responses[3].data.rows || []
          const cTotals = { clicks: 0, impressions: 0, ctr: 0, position: 0 }
          for (const r of cRows) { cTotals.clicks += r.clicks; cTotals.impressions += r.impressions }
          cTotals.ctr = cTotals.impressions > 0 ? cTotals.clicks / cTotals.impressions : 0
          cTotals.position = cRows.length > 0 ? cRows.reduce((s, r) => s + r.position, 0) / cRows.length : 0
          res.compareTotals = cTotals
        }

        return res
      })

      return result
    } catch (e) {
      console.error('[GSC-OVERVIEW ERROR]', e.message)
      return reply.code(502).send({ error: 'Lỗi GSC: ' + e.message })
    }
  })

  // POST /websites/:id/ai-analysis — AI-powered SEO analysis
  fastify.post('/:id/ai-analysis', { preHandler: fastify.authenticate }, async (req, reply) => {
    const site = await getSiteWithAuth(req, reply)
    if (!site) return

    const { startDate, endDate } = req.body
    if (!startDate || !endDate) return reply.code(400).send({ error: 'startDate & endDate required' })

    try {
      const searchconsole = google.searchconsole({ version: 'v1', auth: site._oauth })

      // Fetch data for AI analysis
      const [queriesResp, pagesResp] = await Promise.all([
        searchconsole.searchanalytics.query({
          siteUrl: site.gsc_site_url,
          requestBody: { startDate, endDate, dimensions: ['query'], rowLimit: 50 },
        }),
        searchconsole.searchanalytics.query({
          siteUrl: site.gsc_site_url,
          requestBody: { startDate, endDate, dimensions: ['page'], rowLimit: 30 },
        }),
      ])

      const queries = (queriesResp.data.rows || []).map(r => ({
        query: r.keys[0], clicks: r.clicks, impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1) + '%', position: r.position.toFixed(1),
      }))
      const pages = (pagesResp.data.rows || []).map(r => ({
        page: r.keys[0], clicks: r.clicks, impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1) + '%', position: r.position.toFixed(1),
      }))

      // Get AI orchestrator
      const { getOrchestratorForUser } = require('../services/ai/orchestrator')
      const orchestrator = await getOrchestratorForUser(req.user.id, supabase)

      const prompt = `Bạn là chuyên gia SEO. Phân tích dữ liệu Google Search Console sau và viết báo cáo bằng tiếng Việt.

Website: ${site.gsc_site_url}
Thời gian: ${startDate} → ${endDate}

TOP KEYWORDS:
${queries.map((q, i) => `${i + 1}. "${q.query}" — ${q.clicks} clicks, ${q.impressions} imp, CTR ${q.ctr}, Pos ${q.position}`).join('\n')}

TOP PAGES:
${pages.map((p, i) => `${i + 1}. ${p.page} — ${p.clicks} clicks, ${p.impressions} imp, CTR ${p.ctr}, Pos ${p.position}`).join('\n')}

Viết báo cáo theo format sau (dùng markdown):

## Tổng quan
Tóm tắt 2-3 câu về tình hình SEO.

## Điểm mạnh
- Liệt kê điểm mạnh

## Vấn đề cần xử lý
- 🚨 Vấn đề nghiêm trọng (nếu có)
- ⚠️ Cảnh báo
- ℹ️ Gợi ý

## Cơ hội tăng trưởng
- Từ khoá nào có tiềm năng lên top? Hành động cụ thể?

## Việc cần làm ngay
- Liệt kê 3-5 hành động cụ thể, ưu tiên theo tác động

Viết ngắn gọn, thực tế, dễ hiểu. Không dùng JSON.`

      const result = await orchestrator.call('caption_gen', [{ role: 'user', content: prompt }])

      return { analysis: result.text || 'Không có kết quả', rawData: { queries: queries.slice(0, 10), pages: pages.slice(0, 10) } }
    } catch (e) {
      console.error('[AI-ANALYSIS ERROR]', e.message, e.stack?.split('\n').slice(0, 3).join('\n'))
      return reply.code(502).send({ error: 'Lỗi phân tích: ' + e.message })
    }
  })

  // POST /websites/:id/gsc-compare — compare pages/keywords between two periods
  fastify.post('/:id/gsc-compare', { preHandler: fastify.authenticate }, async (req, reply) => {
    const site = await getSiteWithAuth(req, reply)
    if (!site) return

    const { startDate, endDate, compareStartDate, compareEndDate, dimension = 'page' } = req.body
    if (!startDate || !endDate || !compareStartDate || !compareEndDate)
      return reply.code(400).send({ error: 'Both current and compare date ranges required' })

    try {
      const searchconsole = google.searchconsole({ version: 'v1', auth: site._oauth })
      const siteUrl = site.gsc_site_url

      const [currentResp, compareResp] = await Promise.all([
        searchconsole.searchanalytics.query({
          siteUrl, requestBody: { startDate, endDate, dimensions: [dimension], rowLimit: 200 },
        }),
        searchconsole.searchanalytics.query({
          siteUrl, requestBody: { startDate: compareStartDate, endDate: compareEndDate, dimensions: [dimension], rowLimit: 200 },
        }),
      ])

      const currentMap = new Map()
      for (const r of (currentResp.data.rows || [])) {
        const key = r.keys[0].replace(/\/$/, '').toLowerCase()
        if (currentMap.has(key)) {
          const e = currentMap.get(key)
          e.clicks += r.clicks; e.impressions += r.impressions; e._c++
          e.position = (e.position * (e._c - 1) + r.position) / e._c
          e.ctr = e.impressions > 0 ? e.clicks / e.impressions : 0
        } else { currentMap.set(key, { key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, _c: 1 }) }
      }

      const compareMap = new Map()
      for (const r of (compareResp.data.rows || [])) {
        const key = r.keys[0].replace(/\/$/, '').toLowerCase()
        if (compareMap.has(key)) {
          const e = compareMap.get(key)
          e.clicks += r.clicks; e.impressions += r.impressions; e._c++
          e.position = (e.position * (e._c - 1) + r.position) / e._c
          e.ctr = e.impressions > 0 ? e.clicks / e.impressions : 0
        } else { compareMap.set(key, { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, _c: 1 }) }
      }

      // Merge and compute deltas
      const allKeys = new Set([...currentMap.keys(), ...compareMap.keys()])
      const rows = []
      for (const k of allKeys) {
        const cur = currentMap.get(k) || { clicks: 0, impressions: 0, ctr: 0, position: 0 }
        const prev = compareMap.get(k) || { clicks: 0, impressions: 0, ctr: 0, position: 0 }
        rows.push({
          key: cur.key || k,
          clicks: cur.clicks, impressions: cur.impressions, ctr: cur.ctr, position: cur.position,
          prevClicks: prev.clicks, prevImpressions: prev.impressions, prevCtr: prev.ctr, prevPosition: prev.position,
          clicksDelta: cur.clicks - prev.clicks,
          impressionsDelta: cur.impressions - prev.impressions,
          positionDelta: prev.position - cur.position, // positive = improved
        })
      }

      // Sort by clicks delta (biggest gains first)
      rows.sort((a, b) => b.clicksDelta - a.clicksDelta)

      return { rows }
    } catch (e) {
      return reply.code(502).send({ error: 'Lỗi GSC: ' + e.message })
    }
  })

  // POST /websites/:id/disconnect-google
  fastify.post('/:id/disconnect-google', { preHandler: fastify.authenticate }, async (req, reply) => {
    const hasAccess = await verifyWebsiteAccess(req, reply, req.params.id)
    if (!hasAccess) return

    const { error } = await supabase
      .from('websites')
      .update({
        google_email: null, google_access_token: null,
        google_refresh_token: null, google_token_expiry: null,
        ga_property_id: null, ga_property_name: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
    if (error) return reply.code(500).send({ error: error.message })
    invalidate(`overview:${req.params.id}:`)
    return { ok: true }
  })
}
