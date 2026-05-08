require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  // Last 30 min
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()

  // Comments + likes counts
  const sql = `
    SELECT action_type, result_status, COUNT(*)::int n
    FROM campaign_activity_log
    WHERE created_at >= $1
    GROUP BY action_type, result_status
    ORDER BY action_type
  `
  const r = await p.query(sql, [since])
  console.log("=== Activity last 30 min ===")
  for (const row of r.rows) console.log(`  ${row.action_type} | ${row.result_status} | x${row.n}`)

  // Recent comments with text
  const c = await p.query(
    `SELECT account_id, target_name, details, created_at FROM campaign_activity_log WHERE action_type IN ('comment', 'opportunity_comment') AND result_status = 'success' AND created_at >= $1 ORDER BY created_at DESC LIMIT 5`,
    [since]
  )
  console.log("\n=== Recent successful comments ===")
  if (c.rows.length === 0) console.log("  none")
  for (const row of c.rows) {
    const ago = Math.round((Date.now() - new Date(row.created_at).getTime()) / 60000)
    const text = (row.details?.comment_text || row.details?.text || "?").substring(0, 100)
    console.log(`  ${ago}m ago | ${(row.target_name || "-").substring(0, 30)} | "${text}"`)
  }

  // Recent jobs
  const j = await p.query(
    `SELECT type, status, error_message, finished_at FROM jobs WHERE finished_at >= $1 ORDER BY finished_at DESC LIMIT 8`,
    [since]
  )
  console.log("\n=== Recent finished jobs ===")
  for (const row of j.rows) {
    const ago = Math.round((Date.now() - new Date(row.finished_at).getTime()) / 60000)
    console.log(`  ${ago}m ago | ${row.type} | ${row.status} | ${row.error_message || "-"}`)
  }
  await p.end()
})().catch((e) => { console.error(e.message); process.exit(1) })
