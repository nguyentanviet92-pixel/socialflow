require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  // Check if min_member_count column exists
  const r = await p.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'min_member_count'
  `)
  console.log("min_member_count column exists:", r.rows.length > 0)

  if (r.rows.length === 0) {
    console.log("Adding column...")
    await p.query(`ALTER TABLE campaigns ADD COLUMN min_member_count INTEGER DEFAULT NULL`)
    console.log("✓ Column added (default NULL — agent uses 100 fallback)")
  } else {
    console.log("(skipping migration)")
  }

  // Show current value for active campaigns
  const c = await p.query(`SELECT id, name, min_member_count FROM campaigns WHERE status = 'running' LIMIT 5`)
  console.log("\nActive campaigns:")
  for (const row of c.rows) console.log(`  ${row.name} | min_member_count=${row.min_member_count}`)
  await p.end()
})().catch((e) => { console.error(e.message); process.exit(1) })
