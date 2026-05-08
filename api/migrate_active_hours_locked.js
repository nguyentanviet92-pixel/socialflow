require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  console.log("Adding active_hours_locked column to accounts ...")
  await p.query(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS active_hours_locked boolean NOT NULL DEFAULT false
  `)
  await p.query(`
    COMMENT ON COLUMN accounts.active_hours_locked IS
    'When true, redistributeActiveHours() skips this nick — user has manually pinned the schedule.'
  `)
  const r = await p.query(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name='accounts' AND column_name='active_hours_locked'
  `)
  console.log("✓ Column ready:", r.rows[0])
  await p.end()
})().catch(e => { console.error(e); process.exit(1) })
