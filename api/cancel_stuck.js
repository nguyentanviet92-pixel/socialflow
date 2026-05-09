require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  const sql1 = "UPDATE jobs SET status = 'cancelled', error_message = 'loop_busted' WHERE id::text LIKE '5c3a7154%' AND status = 'pending' RETURNING id"
  const r = await p.query(sql1)
  console.log("cancelled (5c3a7154):", r.rows.length)

  const sql2 = "UPDATE jobs SET status = 'cancelled', error_message = 'stuck_force_now_old' WHERE type = 'campaign_nurture' AND status = 'pending' AND (payload->>'force_now')::text = 'true' AND created_at < now() - interval '10 minutes' RETURNING id"
  const r2 = await p.query(sql2)
  console.log("old force_now cancelled:", r2.rows.length)
  await p.end()
})().catch(e => { console.error(e.message); process.exit(1) })
