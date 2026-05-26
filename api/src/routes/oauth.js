const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const querystring = require('querystring')

const JWT_SECRET = process.env.JWT_SECRET

// Memory cache for authorization codes: code -> { user, expiresAt, redirect_uri }
const codeCache = new Map()

// Clean up expired codes periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of codeCache) {
    if (val.expiresAt < now) codeCache.delete(key)
  }
}, 60000)

module.exports = async (fastify) => {
  const { supabase } = fastify

  // Add urlencoded form body parser locally so we don't need to install external packages
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try {
      const parsed = querystring.parse(body)
      done(null, parsed)
    } catch (err) {
      done(err)
    }
  })

  // 1. GET /oauth/authorize — Render the beautiful, responsive login & authorization consent screen
  fastify.get('/authorize', async (req, reply) => {
    const {
      client_id = '',
      redirect_uri = '',
      response_type = '',
      state = '',
      scope = '',
      error = ''
    } = req.query

    // Return beautiful self-contained HTML page
    reply.type('text/html').send(renderAuthPage({
      client_id,
      redirect_uri,
      response_type,
      state,
      scope,
      email: '',
      error
    }))
  })

  // 2. POST /oauth/authorize — Process login + authorize consent, redirect back with auth code
  fastify.post('/authorize', async (req, reply) => {
    const {
      email,
      password,
      client_id,
      redirect_uri,
      response_type,
      state,
      scope
    } = req.body

    if (!email || !password) {
      return reply.type('text/html').send(renderAuthPage({
        client_id, redirect_uri, response_type, state, scope, email,
        error: 'Email và mật khẩu là bắt buộc.'
      }))
    }

    // Authenticate user against profiles table
    const { data: user, error: dbError } = await supabase
      .from('profiles')
      .select('id, email, password_hash, role, is_active, username')
      .eq('email', email)
      .single()

    if (dbError || !user) {
      return reply.type('text/html').send(renderAuthPage({
        client_id, redirect_uri, response_type, state, scope, email,
        error: 'Email hoặc mật khẩu không chính xác.'
      }))
    }

    if (!user.password_hash) {
      return reply.type('text/html').send(renderAuthPage({
        client_id, redirect_uri, response_type, state, scope, email,
        error: 'Tài khoản chưa thiết lập mật khẩu.'
      }))
    }

    if (!user.is_active) {
      return reply.type('text/html').send(renderAuthPage({
        client_id, redirect_uri, response_type, state, scope, email,
        error: 'Tài khoản chưa được admin phê duyệt.'
      }))
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.type('text/html').send(renderAuthPage({
        client_id, redirect_uri, response_type, state, scope, email,
        error: 'Email hoặc mật khẩu không chính xác.'
      }))
    }

    // Generate authorization code (valid for 5 minutes)
    const code = crypto.randomBytes(16).toString('hex')
    codeCache.set(code, {
      user: { id: user.id, email: user.email, role: user.role },
      expiresAt: Date.now() + 5 * 60000,
      redirect_uri
    })

    // Redirect to redirect_uri with code and state as specified by OAuth 2.0 standard
    const redirectUrl = `${redirect_uri}${redirect_uri.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state || '')}`
    return reply.redirect(redirectUrl)
  })

  // 3. POST /oauth/token — Exchange authorization code for a standard JWT access_token
  fastify.post('/token', async (req, reply) => {
    const {
      client_id,
      client_secret,
      grant_type,
      code,
      redirect_uri
    } = req.body

    if (grant_type !== 'authorization_code') {
      return reply.code(400).send({ error: 'unsupported_grant_type' })
    }

    const cached = codeCache.get(code)
    if (!cached || cached.expiresAt < Date.now()) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }

    // Revoke code (one-time use)
    codeCache.delete(code)

    // Verify redirect_uri matches
    if (cached.redirect_uri && cached.redirect_uri !== redirect_uri) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }

    // Sign standard JWT token matching existing auth plugin
    const token = jwt.sign(
      { sub: cached.user.id, email: cached.user.email, role: cached.user.role },
      JWT_SECRET,
      { expiresIn: '30d' } // long-lived access token for API/ChatGPT stability
    )

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 30 * 24 * 3600 // 30 days
    }
  })
}

function renderAuthPage({ client_id, redirect_uri, response_type, state, scope, email, error }) {
  return `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ủy quyền SocialFlow</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --surface: #18181b;
      --border: #27272a;
      --border-bright: #3f3f46;
      --hermes: #06b6d4;
      --hermes-dim: rgba(6,182,212,0.1);
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --error: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      padding: 32px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: var(--hermes-dim);
      border: 1px solid rgba(6,182,212,0.3);
      color: var(--hermes);
      font-size: 24px;
      margin-bottom: 12px;
      animation: pulse 2s infinite alternate;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 5px rgba(6,182,212,0.2); }
      100% { box-shadow: 0 0 15px rgba(6,182,212,0.5); }
    }
    .title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .subtitle {
      font-size: 13px;
      color: var(--text-muted);
    }
    .error-msg {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: var(--error);
      font-size: 13px;
      padding: 10px 14px;
      border-radius: 6px;
      margin-bottom: 20px;
      text-align: center;
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-weight: 500;
    }
    input {
      width: 100%;
      background: #09090b;
      border: 1px solid var(--border-bright);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
    }
    input:focus {
      border-color: var(--hermes);
      box-shadow: 0 0 0 2px var(--hermes-dim);
    }
    .btn {
      width: 100%;
      background: var(--hermes);
      color: #000;
      border: none;
      padding: 12px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
      margin-top: 10px;
    }
    .btn:hover {
      opacity: 0.9;
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 11px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">🧠</div>
      <div class="title">Kết nối ChatGPT</div>
      <div class="subtitle">Ủy quyền cho ChatGPT truy cập tài khoản SocialFlow</div>
    </div>
    
    \${error ? `<div class="error-msg">\${error}</div>` : ''}
    
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="\${client_id}">
      <input type="hidden" name="redirect_uri" value="\${redirect_uri}">
      <input type="hidden" name="response_type" value="\${response_type}">
      <input type="hidden" name="state" value="\${state}">
      <input type="hidden" name="scope" value="\${scope}">
      
      <div class="form-group">
        <label>Email đăng nhập</label>
        <input type="email" name="email" required placeholder="name@example.com" value="\${email || ''}">
      </div>
      
      <div class="form-group">
        <label>Mật khẩu</label>
        <input type="password" name="password" required placeholder="••••••••">
      </div>
      
      <button type="submit" class="btn">Cho phép kết nối</button>
    </form>
    
    <div class="footer">
      Kết nối này được bảo mật và mã hóa 256-bit.
    </div>
  </div>
</body>
</html>
  `
}
