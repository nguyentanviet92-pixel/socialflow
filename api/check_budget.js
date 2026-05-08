require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  const r = await p.query(`SELECT username, daily_budget FROM accounts WHERE id IN ('2cdd5c69-6ba1-461a-8709-60644c64d4a0', 'aeb73391-53ed-409b-9dbe-181a8b2679fd', '349b0998-e193-4be6-8c7b-584d33c4d1d8')`)
  for (const row of r.rows) {
    console.log("=== " + row.username + " ===")
    const b = row.daily_budget || {}
    for (const k of ['like','comment','friend_request','join_group','post','opportunity_comment']) {
      if (b[k]) console.log("  " + k + ": used=" + b[k].used + "/" + b[k].max)
    }
    console.log("  reset_at:", b.reset_at)
  }
  await p.end()
})().catch(e => { console.error(e.message); process.exit(1) })
