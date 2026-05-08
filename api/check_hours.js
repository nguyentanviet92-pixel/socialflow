require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  const r = await p.query(`SELECT username, active_hours_start, active_hours_end FROM accounts WHERE is_active = true ORDER BY username`)
  console.log("=== Active hours per nick ===")
  for (const row of r.rows) {
    const start = row.active_hours_start ?? 7
    const end = row.active_hours_end ?? 23
    const is247 = start === 0 && end === 24
    console.log(`  ${row.username}: ${start}h-${end}h ${is247 ? '⚡ 24/7' : '(daytime)'}`)
  }
  await p.end()
})().catch(e => { console.error(e.message); process.exit(1) })
