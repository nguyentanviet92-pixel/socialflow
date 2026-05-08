require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  // Use pg-supabase like other scripts
  const { createClient } = require("./src/lib/pg-supabase")
  const sb = createClient(process.env.DATABASE_URL)

  const { rebalanceWarmupBudgets } = require("./src/services/warmup-budget")
  const r = await rebalanceWarmupBudgets(sb)
  console.log("rebalance result:", r)

  // Re-check 3 nicks
  const r2 = await p.query(`SELECT username, daily_budget FROM accounts WHERE id IN ('2cdd5c69-6ba1-461a-8709-60644c64d4a0', 'aeb73391-53ed-409b-9dbe-181a8b2679fd', '349b0998-e193-4be6-8c7b-584d33c4d1d8')`)
  for (const row of r2.rows) {
    const b = row.daily_budget || {}
    console.log(`${row.username}: like=${b.like?.used}/${b.like?.max} comment=${b.comment?.used}/${b.comment?.max}`)
  }
  await p.end()
})().catch(e => { console.error(e.message); process.exit(1) })
