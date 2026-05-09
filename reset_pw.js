require('dotenv').config();
const pg = require('pg');
const hash = '$2b$10$et3fevxg5nUV3eeQHWk6uubrbH0Mq37Ma96xRggItRqSoAKRvDMn.';
const email = '1phut30giayvi@gmail.com';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://socialflow:socialflow@localhost/socialflow' });
pool.query('UPDATE profiles SET password_hash = $1 WHERE email = $2', [hash, email])
  .then(r => { console.log('Updated rows:', r.rowCount); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });
