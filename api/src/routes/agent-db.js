// Agent DB proxy — lets the desktop agent talk to VPS Postgres through
// the API instead of a direct Supabase cloud client. The old cloud URL
// had drifted to a stale snapshot; every direct supabase.from() call
// from the agent was writing into a dead database. This endpoint accepts
// a supabase-js-shaped query spec, runs it against the VPS pg, and
// returns {data, error} so the agent-side wrapper is a drop-in swap.
//
// Auth: X-Agent-Key (same as /agent-jobs/*).
// Safety: table + RPC whitelist. No arbitrary SQL.

const ALLOWED_TABLES = new Set([
  'accounts', 'campaigns', 'campaign_roles', 'campaign_groups',
  'campaign_activity_log', 'comment_logs', 'contents',
  'discovered_groups', 'discovered_posts', 'engagement_snapshots',
  'fanpages', 'fb_groups', 'friend_request_log', 'group_opportunities',
  'group_post_scores', 'jobs', 'job_failures', 'leads', 'media',
  'monitored_groups', 'monitored_sources', 'monitored_posts', 'nick_kpi_daily',
  'notifications', 'nurture_profiles', 'publish_history',
  'shared_posts', 'target_queue', 'agent_heartbeats',
  'account_health_signals', 'ai_pilot_memory', 'hermes_calls',
  'nick_daily_job_quota', 'nick_slots', 'scout_targets',
])
const ALLOWED_RPCS = new Set([
  'append_campaign_to_group', 'increment_budget',
  'increment_kpi', 'increment_nurture_counter',
  'claim_targets', 'increment_field',
])

// Map supabase-js filter operators to pg SQL.
const OP_MAP = {
  eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'ILIKE', is: 'IS',
}

function buildWhere(filters, startIdx = 1) {
  const clauses = []
  const args = []
  let idx = startIdx
  for (const f of filters || []) {
    if (f.type === 'in') {
      if (!Array.isArray(f.value) || f.value.length === 0) {
        clauses.push('FALSE')
        continue
      }
      const placeholders = f.value.map(() => `$${idx++}`).join(',')
      clauses.push(`${quoteCol(f.column)} IN (${placeholders})`)
      args.push(...f.value)
    } else if (f.type === 'not_in') {
      if (!Array.isArray(f.value) || f.value.length === 0) continue
      const placeholders = f.value.map(() => `$${idx++}`).join(',')
      clauses.push(`${quoteCol(f.column)} NOT IN (${placeholders})`)
      args.push(...f.value)
    } else if (f.type === 'not') {
      // { type:'not', column, op, value }
      const op = OP_MAP[f.op]
      if (!op) continue
      clauses.push(`NOT (${quoteCol(f.column)} ${op} $${idx++})`)
      args.push(f.value)
    } else if (f.type === 'filter') {
      // Generic .filter(column, op, value). Supports JSON ops like
      // "payload->>account_id" which Supabase passes literally.
      // PG requires the JSON key to be a quoted string literal:
      //   payload->>'account_id'  (not payload->>account_id)
      // Supabase JS clients sometimes send the unquoted form, so normalize.
      const op = OP_MAP[f.op]
      if (!op) continue
      const col = f.column.replace(
        /(->>?|->)([a-zA-Z_][a-zA-Z0-9_]*)(?![a-zA-Z0-9_'])/g,
        "$1'$2'"
      )
      clauses.push(`${col} ${op} $${idx++}`)
      args.push(f.value)
    } else if (f.type === 'is_null') {
      clauses.push(`${quoteCol(f.column)} IS NULL`)
    } else if (f.type === 'is_not_null') {
      clauses.push(`${quoteCol(f.column)} IS NOT NULL`)
    } else {
      const op = OP_MAP[f.type]
      if (!op) continue
      if (f.value === null && (f.type === 'eq' || f.type === 'is')) {
        clauses.push(`${quoteCol(f.column)} IS NULL`)
      } else {
        clauses.push(`${quoteCol(f.column)} ${op} $${idx++}`)
        args.push(f.value)
      }
    }
  }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args, nextIdx: idx }
}

// Quote a column name safely — accepts `col`, `table.col`, or raw JSON
// expression `payload->>account_id` which Postgres parses as-is.
function quoteCol(col) {
  if (col.includes('->') || col.includes('->>')) return col
  if (col.includes('.')) {
    return col.split('.').map(p => `"${p}"`).join('.')
  }
  return `"${col}"`
}

module.exports = async (fastify) => {
  const { supabase } = fastify
  const AGENT_SECRET = process.env.AGENT_SECRET

  const agentAuth = async (req, reply) => {
    const key = req.headers['x-agent-key']
    if (!AGENT_SECRET || key !== AGENT_SECRET) {
      return reply.code(401).send({ error: 'Invalid agent key' })
    }
  }

  // POST /agent-db/query — generic query proxy
  fastify.post('/query', { preHandler: agentAuth }, async (req, reply) => {
    const pool = supabase._pool
    if (!pool) return reply.code(500).send({ error: 'pg pool unavailable' })

    const { op, table, rpc, cols, rows, updates, filters, options, returning } = req.body || {}

    if (op === 'rpc') {
      if (!ALLOWED_RPCS.has(rpc)) return reply.code(403).send({ error: `RPC not whitelisted: ${rpc}` })
      const params = options?.params || {}
      // call via supabase.rpc which handles the function signature
      try {
        const { data, error } = await supabase.rpc(rpc, params)
        return { data, error: error ? { message: error.message } : null }
      } catch (err) {
        return { data: null, error: { message: err.message } }
      }
    }

    if (!ALLOWED_TABLES.has(table)) {
      return reply.code(403).send({ error: `Table not whitelisted: ${table}` })
    }

    // If cols contains a supabase-js foreign-table embed (e.g.
    // '*, proxies(*)' or 'id, fb_groups!inner(...)'), delegate to the
    // pg-supabase wrapper on the API — it already has an FK map and
    // knows how to fetch embedded relations. Writing our own embed
    // parser here would duplicate that. Only SELECT ops reach this
    // branch; inserts/updates never embed.
    const hasEmbed = op === 'select' && typeof cols === 'string' &&
      /\b[a-zA-Z_][a-zA-Z0-9_]*(?:!inner|!left)?\s*\(/.test(cols || '')

    if (hasEmbed) {
      try {
        let q = supabase.from(table).select(cols || '*')
        for (const f of filters || []) {
          if (f.type === 'eq') q = q.eq(f.column, f.value)
          else if (f.type === 'neq') q = q.neq(f.column, f.value)
          else if (f.type === 'gt') q = q.gt(f.column, f.value)
          else if (f.type === 'gte') q = q.gte(f.column, f.value)
          else if (f.type === 'lt') q = q.lt(f.column, f.value)
          else if (f.type === 'lte') q = q.lte(f.column, f.value)
          else if (f.type === 'like') q = q.like(f.column, f.value)
          else if (f.type === 'ilike') q = q.ilike(f.column, f.value)
          else if (f.type === 'in') q = q.in(f.column, f.value)
          else if (f.type === 'is_null') q = q.is(f.column, null)
          else if (f.type === 'is') q = q.is(f.column, f.value)
        }
        if (options?.order) q = q.order(options.order.column, { ascending: options.order.ascending })
        if (options?.limit) q = q.limit(options.limit)
        if (options?.single) return await q.single()
        if (options?.maybeSingle) return await q.maybeSingle()
        return await q
      } catch (err) {
        return { data: null, error: { message: err.message } }
      }
    }

    const tbl = `"${table}"`
    try {
      if (op === 'select') {
        const { sql: whereSql, args } = buildWhere(filters)
        const cleanCols = (cols || '*').replace(/[^a-zA-Z0-9_,\s*().:-]/g, '')
        let sql = `SELECT ${cleanCols} FROM ${tbl} ${whereSql}`
        if (options?.order) {
          const { column, ascending } = options.order
          sql += ` ORDER BY ${quoteCol(column)} ${ascending ? 'ASC' : 'DESC'} NULLS LAST`
        }
        if (options?.limit) sql += ` LIMIT ${parseInt(options.limit)}`
        if (options?.offset) sql += ` OFFSET ${parseInt(options.offset)}`
        const { rows: result } = await pool.query(sql, args)
        if (options?.single || options?.maybeSingle) {
          if (result.length === 0) {
            return { data: null, error: options.maybeSingle ? null : { message: 'no rows' } }
          }
          return { data: result[0], error: null }
        }
        return { data: result, error: null, count: options?.count === 'exact' ? result.length : undefined }
      }

      if (op === 'insert') {
        if (!Array.isArray(rows) || rows.length === 0) {
          return { data: null, error: { message: 'rows required' } }
        }
        // Build INSERT with $N placeholders. Column list = union of keys.
        const keys = [...new Set(rows.flatMap(r => Object.keys(r)))]
        const cols = keys.map(k => `"${k}"`).join(',')
        const args = []
        const valueRows = rows.map(r => {
          const placeholders = keys.map((k) => {
            const v = r[k]
            args.push(v === undefined ? null : Array.isArray(v) ? v : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v))
            return `$${args.length}`
          })
          return `(${placeholders.join(',')})`
        })
        let sql = `INSERT INTO ${tbl} (${cols}) VALUES ${valueRows.join(',')}`
        if (options?.onConflict) {
          sql += ` ON CONFLICT (${options.onConflict}) DO ${options.ignoreDuplicates ? 'NOTHING' : `UPDATE SET ${keys.filter(k => k !== options.onConflict).map(k => `"${k}"=EXCLUDED."${k}"`).join(',')}`}`
        }
        if (returning !== false) sql += ' RETURNING *'
        const { rows: result } = await pool.query(sql, args)
        if (options?.single) {
          return { data: result[0] || null, error: null }
        }
        return { data: result, error: null }
      }

      if (op === 'update') {
        if (!updates || typeof updates !== 'object') {
          return { data: null, error: { message: 'updates required' } }
        }
        const keys = Object.keys(updates)
        const args = []
        const setSql = keys.map((k) => {
          const v = updates[k]
          args.push(v === undefined ? null : Array.isArray(v) ? v : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v))
          return `"${k}"=$${args.length}`
        }).join(',')
        const { sql: whereSql, args: whereArgs } = buildWhere(filters, args.length + 1)
        args.push(...whereArgs)
        let sql = `UPDATE ${tbl} SET ${setSql} ${whereSql}`
        if (returning !== false) sql += ' RETURNING *'
        const { rows: result } = await pool.query(sql, args)
        if (options?.single) {
          return { data: result[0] || null, error: null }
        }
        return { data: result, error: null }
      }

      if (op === 'delete') {
        const { sql: whereSql, args } = buildWhere(filters)
        if (!whereSql) return reply.code(400).send({ error: 'DELETE requires at least one filter' })
        let sql = `DELETE FROM ${tbl} ${whereSql}`
        if (returning !== false) sql += ' RETURNING *'
        const { rows: result } = await pool.query(sql, args)
        return { data: result, error: null }
      }

      if (op === 'upsert') {
        if (!Array.isArray(rows) || rows.length === 0) {
          return { data: null, error: { message: 'rows required' } }
        }
        if (!options?.onConflict) {
          return { data: null, error: { message: 'onConflict required for upsert' } }
        }
        const keys = [...new Set(rows.flatMap(r => Object.keys(r)))]
        const cols = keys.map(k => `"${k}"`).join(',')
        const args = []
        const valueRows = rows.map(r => {
          const ps = keys.map((k) => {
            const v = r[k]
            args.push(v === undefined ? null : Array.isArray(v) ? v : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v))
            return `$${args.length}`
          })
          return `(${ps.join(',')})`
        })
        const conflictCols = options.onConflict.split(',').map(s => `"${s.trim()}"`).join(',')
        const updateCols = keys.filter(k => !options.onConflict.includes(k)).map(k => `"${k}"=EXCLUDED."${k}"`).join(',')
        let sql = `INSERT INTO ${tbl} (${cols}) VALUES ${valueRows.join(',')} ON CONFLICT (${conflictCols}) ${options.ignoreDuplicates ? 'DO NOTHING' : (updateCols ? `DO UPDATE SET ${updateCols}` : 'DO NOTHING')}`
        if (returning !== false) sql += ' RETURNING *'
        const { rows: result } = await pool.query(sql, args)
        if (options?.single) return { data: result[0] || null, error: null }
        return { data: result, error: null }
      }

      return reply.code(400).send({ error: `Unknown op: ${op}` })
    } catch (err) {
      req.log.warn({ err: err.message, table, op, filters, cols }, "[AGENT-DB] query failed")
      return { data: null, error: { message: err.message, code: err.code || null } }
    }
  })
}
