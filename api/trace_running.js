require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  const r = await p.query(`
    SELECT id, type, status, started_at, payload
    FROM jobs
    WHERE type = 'campaign_nurture' AND status = 'running'
    LIMIT 5
  `)
  console.log("=== Running campaign_nurture ===")
  for (const j of r.rows) {
    const dur = j.started_at ? Math.round((Date.now() - new Date(j.started_at).getTime()) / 1000) : 0
    console.log(`  ${j.id} | nick=${(j.payload?.account_id || "?").substring(0, 8)} | dur=${dur}s | force_now=${j.payload?.force_now}`)

    // Activity for this job
    const a = await p.query(
      `SELECT action_type, target_name, result_status, details FROM campaign_activity_log WHERE job_id = $1 ORDER BY created_at`,
      [j.id]
    )
    console.log(`  events: ${a.rows.length}`)
    for (const act of a.rows) {
      console.log(`    ${act.action_type} | ${act.result_status || "?"} | ${(act.target_name || "-").substring(0, 30)} | ${JSON.stringify(act.details || {}).substring(0, 200)}`)
    }
  }
  await p.end()
})().catch((e) => { console.error(e.message); process.exit(1) })
