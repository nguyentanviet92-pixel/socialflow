require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  const r = await p.query(`
    SELECT type, status, COUNT(*)::int n
    FROM jobs
    WHERE status IN ('pending', 'claimed', 'running')
    GROUP BY type, status
    ORDER BY type, status
  `)
  console.log("=== Pending/Running jobs ===")
  for (const row of r.rows) console.log(`  ${row.type} | ${row.status} | x${row.n}`)

  // Recent campaign_nurture history (any status)
  const c = await p.query(`
    SELECT status, COUNT(*)::int n
    FROM jobs
    WHERE type = 'campaign_nurture' AND created_at >= $1
    GROUP BY status
    ORDER BY status
  `, [new Date(Date.now() - 6 * 3600 * 1000).toISOString()])
  console.log("\n=== campaign_nurture last 6h ===")
  for (const row of c.rows) console.log(`  ${row.status} | x${row.n}`)
  await p.end()
})().catch((e) => { console.error(e.message); process.exit(1) })
