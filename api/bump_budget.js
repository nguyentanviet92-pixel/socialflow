require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

;(async () => {
  // Nicks 60d+ healthy: real warmup-passed values
  const targets = [
    { id: '2cdd5c69-6ba1-461a-8709-60644c64d4a0', name: 'Việt Nguyễn', like: 60, comment: 8, friend_request: 15, join_group: 3, opportunity_comment: 4 },
    { id: 'aeb73391-53ed-409b-9dbe-181a8b2679fd', name: 'Diệu Hiền',   like: 50, comment: 6, friend_request: 12, join_group: 3, opportunity_comment: 3 },
    { id: '349b0998-e193-4be6-8c7b-584d33c4d1d8', name: 'Thúy Thùy',  like: 30, comment: 4, friend_request: 8,  join_group: 2, opportunity_comment: 2 },
  ]
  for (const t of targets) {
    const sql = `
      UPDATE accounts
      SET daily_budget = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
        COALESCE(daily_budget, '{}'::jsonb),
        '{like,max}', to_jsonb($1::int)),
        '{comment,max}', to_jsonb($2::int)),
        '{friend_request,max}', to_jsonb($3::int)),
        '{join_group,max}', to_jsonb($4::int)),
        '{opportunity_comment,max}', to_jsonb($5::int))
      WHERE id = $6
      RETURNING username, daily_budget->'like' as like_b, daily_budget->'comment' as cmt_b
    `
    const r = await p.query(sql, [t.like, t.comment, t.friend_request, t.join_group, t.opportunity_comment, t.id])
    console.log(`${t.name}: like=${JSON.stringify(r.rows[0]?.like_b)} comment=${JSON.stringify(r.rows[0]?.cmt_b)}`)
  }
  await p.end()
})().catch(e => { console.error(e.message); process.exit(1) })
