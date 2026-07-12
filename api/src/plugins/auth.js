// Fastify plugin for JWT authentication — self-hosted (no Supabase dependency)
const fp = require('fastify-plugin')
const jwt = require('jsonwebtoken')

module.exports = fp(async (fastify) => {
  const { supabase } = require('../lib/supabase')
  const JWT_SECRET = process.env.JWT_SECRET

  if (!JWT_SECRET) {
    console.error('[AUTH] FATAL: JWT_SECRET not set in .env!')
  }

  // Cache: token → { user, expiresAt }
  const authCache = new Map()
  const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  fastify.decorate('authenticate', async (request, reply) => {
    const token = request.headers.authorization?.replace('Bearer ', '')
    if (!token) return reply.code(401).send({ error: 'Unauthorized' })

    // Check cache
    const cached = authCache.get(token)
    if (cached && cached.expiresAt > Date.now()) {
      request.user = cached.user
      return
    }

    try {
      // Verify local JWT
      const decoded = jwt.verify(token, JWT_SECRET)
      const userId = decoded.sub || decoded.id

      // Fetch profile from DB
      const { data: profile } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('id', userId)
        .single()

      if (profile && profile.is_active === false) {
        return reply.code(403).send({ error: 'Account disabled' })
      }

      const fullUser = { id: userId, email: decoded.email, role: profile?.role || 'user' }

      // Cache
      authCache.set(token, { user: fullUser, expiresAt: Date.now() + CACHE_TTL })
      request.user = fullUser
    } catch (err) {
      authCache.delete(token)
      return reply.code(401).send({ error: 'Invalid token' })
    }
  })

  fastify.decorate('requireAdmin', async (request, reply) => {
    await fastify.authenticate(request, reply)
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin required' })
    }
  })

  // Clean expired cache
  setInterval(() => {
    const now = Date.now()
    for (const [key, val] of authCache) {
      if (val.expiresAt + CACHE_TTL < now) authCache.delete(key)
    }
  }, 10 * 60 * 1000)
})
