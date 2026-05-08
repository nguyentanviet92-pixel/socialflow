/**
 * Notifications route — user alerts (checkpoint, failures, campaign events)
 */

module.exports = async function (app) {
  const auth = { preHandler: app.authenticate }

  // GET /notifications — list notifications
  app.get('/', auth, async (req, reply) => {
    const userId = req.user.id
    const { is_read, type, limit = 50, offset = 0 } = req.query

    let query = app.supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (is_read !== undefined) {
      query = query.eq('is_read', is_read === 'true')
    }
    if (type) {
      query = query.eq('type', type)
    }

    const { data, count, error } = await query
    if (error) return reply.code(500).send({ error: error.message })
    return { data, total: count }
  })

  // GET /notifications/unread-count
  app.get('/unread-count', auth, async (req, reply) => {
    const { count, error } = await app.supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)

    if (error) return reply.code(500).send({ error: error.message })
    return { count: count || 0 }
  })

  // PUT /notifications/:id/read — mark single as read
  app.put('/:id/read', auth, async (req, reply) => {
    const { error } = await app.supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // PUT /notifications/read-all — mark all as read
  app.put('/read-all', auth, async (req, reply) => {
    const { error } = await app.supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // DELETE /notifications/:id — delete single
  app.delete('/:id', auth, async (req, reply) => {
    const { error } = await app.supabase
      .from('notifications')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })

  // ─── System notification (agent-auth) ─────────────────────
  // Used by the agent to push critical alerts (Hermes offline, checkpoint, etc.)
  // Requires X-Agent-Key header (same as /ai-hermes/agent/* routes).
  // Inserts notification for the admin user (ADMIN_USER_ID) since agent
  // doesn't have a user session context.
  const AGENT_SECRET = process.env.AGENT_SECRET
  const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '274868cf-742d-4d8a-89e8-bf1c37766b77'

  app.post('/system', async (req, reply) => {
    // Auth: agent key
    const key = req.headers['x-agent-key']
    if (!AGENT_SECRET || key !== AGENT_SECRET) {
      return reply.code(401).send({ error: 'Invalid agent key' })
    }

    const { type, title, body, level, data } = req.body || {}
    if (!type || !title) {
      return reply.code(400).send({ error: 'type and title required' })
    }

    // Dedup: don't insert if same type was sent in last 30 minutes
    try {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const { data: recent } = await app.supabase
        .from('notifications')
        .select('id')
        .eq('user_id', ADMIN_USER_ID)
        .eq('type', type)
        .gte('created_at', since)
        .limit(1)
      if (recent && recent.length > 0) {
        return { ok: true, deduplicated: true }
      }
    } catch {}

    const { error } = await app.supabase
      .from('notifications')
      .insert({
        user_id: ADMIN_USER_ID,
        type,
        title,
        body: body || '',
        level: level || 'info',
        data: data || {},
        is_read: false,
      })

    if (error) return reply.code(500).send({ error: error.message })
    return { ok: true }
  })
}
