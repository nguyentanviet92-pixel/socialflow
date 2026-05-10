require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  `UPDATE profiles SET password_hash = $1 WHERE email = $2`,
  ['$2b$12$6lSIQIAEeGYHNxdDXbJvM.YVcu3ae1qZ9s0Ql2Wm9NMgf6J.Ug/By', '1phut30giayvi@gmail.com']
).then(r => {
  console.log('Updated rows:', r.rowCount);
  process.exit();
}).catch(e => { console.error(e); process.exit(1); });
