const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES = '7d'

module.exports = async (fastify) => {
  const { supabase } = fastify

  // POST /auth/login — email + password → JWT token
  fastify.post('/login', async (req, reply) => {
    const { email, password } = req.body
    if (!email || !password) return reply.code(400).send({ error: 'Email và mật khẩu là bắt buộc' })

    const { data: user, error } = await supabase
      .from('profiles')
      .select('id, email, password_hash, role, is_active, username, username')
      .eq('email', email)
      .single()

    if (error || !user) return reply.code(401).send({ error: 'Email hoặc mật khẩu sai' })
    if (!user.password_hash) return reply.code(401).send({ error: 'Tài khoản chưa thiết lập mật khẩu' })
    if (!user.is_active) return reply.code(403).send({ error: 'Tài khoản chưa được phê duyệt' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return reply.code(401).send({ error: 'Email hoặc mật khẩu sai' })

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    )

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        username: user.username,
        username: user.username,
      },
    }
  })

  // POST /auth/logout — stateless JWT, just ack
  fastify.post('/logout', async () => ({ success: true }))

  // GET /auth/me — verify token, return user + profile
  fastify.get('/me', { preHandler: fastify.authenticate }, async (req) => {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, role, is_active, username, username')
      .eq('id', req.user.id)
      .single()

    return { user: { ...req.user, ...profile } }
  })

  // GET /auth/apikey — generate long-lived API key (JWT token) for ChatGPT
  fastify.get('/apikey', { preHandler: fastify.authenticate }, async (req) => {
    const token = jwt.sign(
      { sub: req.user.id, email: req.user.email, role: req.user.role },
      JWT_SECRET,
      { expiresIn: '3650d' } // 10 years
    )
    return { apikey: token }
  })

  // POST /auth/register — public registration (pending admin approval)
  fastify.post('/register', async (req, reply) => {
    const { email, password, username } = req.body
    if (!email || !password) return reply.code(400).send({ error: 'Email và mật khẩu là bắt buộc' })
    if (password.length < 6) return reply.code(400).send({ error: 'Mật khẩu tối thiểu 6 ký tự' })

    // Check existing
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .single()

    if (existing) return reply.code(400).send({ error: 'Email đã được sử dụng' })

    const password_hash = await bcrypt.hash(password, 12)
    const id = require('crypto').randomUUID()

    const { error } = await supabase.from('profiles').insert({
      id,
      email,
      password_hash,
      username: email.split('@')[0],
      username: username || email.split('@')[0],
      role: 'user',
      is_active: false,
    })

    if (error) return reply.code(500).send({ error: error.message })

    return reply.code(201).send({
      message: 'Đăng ký thành công! Vui lòng chờ admin duyệt tài khoản.',
    })
  })
}
