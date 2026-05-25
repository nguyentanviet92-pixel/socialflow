// DB client — 100% VPS API. No Supabase cloud.
// Priority: DATABASE_URL (direct PG, dev only) > API_URL (VPS HTTP proxy, production)

let config = {}
try { config = require('./config') } catch {}

const DATABASE_URL = process.env.DATABASE_URL || config.DATABASE_URL
const API_URL      = process.env.API_URL       || config.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET  || process.env.AGENT_SECRET_KEY || config.AGENT_SECRET_KEY

let supabase

if (DATABASE_URL && require('fs').existsSync(require('path').join(__dirname, 'pg-supabase.js'))) {
  const { createClient } = require('./pg-supabase')
  supabase = createClient(DATABASE_URL)
  console.log('[DB] Direct PostgreSQL')
} else if (API_URL && AGENT_SECRET) {
  if (DATABASE_URL) {
    console.warn('[DB] DATABASE_URL set but direct PG wrapper is unavailable; using VPS API proxy')
  }
  const { createClient } = require('./http-supabase')
  supabase = createClient(API_URL, AGENT_SECRET)
  console.log('[DB] VPS API proxy')
} else {
  console.error('[DB] ERROR: Set API_URL + AGENT_SECRET_KEY in config or .env')
  process.exit(1)
}

module.exports = { supabase, config }
