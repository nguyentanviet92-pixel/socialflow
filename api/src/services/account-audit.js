const { supabase } = require('../lib/supabase');

async function runAccountAudit() {
  const pool = supabase._pool;
  if (!pool) {
    console.error('[AUDIT] Database pool not ready');
    return [];
  }

  console.log('[AUDIT] Running account idle classification...');

  // Fetch all accounts
  const accountsRes = await pool.query(`
    SELECT id, username, is_active, status, agent_enabled, owner_id 
    FROM accounts
  `);
  const accounts = accountsRes.rows;
  const reports = [];

  for (const acc of accounts) {
    // 1. If status is checkpoint or expired or is_active=false -> Cookie dead / Expired
    if (acc.status === 'checkpoint' || acc.status === 'expired' || acc.is_active === false) {
      reports.push({
        accountId: acc.id,
        username: acc.username,
        status: 'Idle - cookie/session chết',
        isWarning: true,
        reason: `Account status is ${acc.status} (active=${acc.is_active})`
      });
      continue;
    }

    // 2. If agent_enabled = false -> Agent disabled
    if (acc.agent_enabled === false) {
      reports.push({
        accountId: acc.id,
        username: acc.username,
        status: 'Idle - agent tắt',
        isWarning: false,
        reason: 'agent_enabled is false'
      });
      continue;
    }

    // 3. Check if reaped by watchdog in last 30 minutes
    const reapedRes = await pool.query(`
      SELECT id FROM campaign_activity_log 
      WHERE action_type IN ('watchdog_cancel', 'watchdog_fail')
        AND (details->>'account_id')::uuid = $1
        AND created_at > now() - interval '30 minutes'
      LIMIT 1
    `, [acc.id]);

    if (reapedRes.rows.length > 0) {
      reports.push({
        accountId: acc.id,
        username: acc.username,
        status: 'Idle - vừa bị reap',
        isWarning: false,
        reason: 'Watchdog reaped a job in the last 30 minutes (self-healing in progress)'
      });
      continue;
    }

    // 4. Check if there are any jobs in the last 4 hours
    const recentJobsRes = await pool.query(`
      SELECT id FROM jobs 
      WHERE (payload->>'account_id')::uuid = $1
        AND created_at > now() - interval '4 hours'
      LIMIT 1
    `, [acc.id]);

    if (recentJobsRes.rows.length === 0) {
      reports.push({
        accountId: acc.id,
        username: acc.username,
        status: 'Idle - không có job nào được tạo dù agent bật',
        isWarning: true,
        reason: 'WARNING: Account is enabled but has zero jobs in the last 4 hours (potential scheduler bug)'
      });
      continue;
    }

    // Otherwise active/idle normally
    reports.push({
      accountId: acc.id,
      username: acc.username,
      status: 'Active / Normal rest',
      isWarning: false,
      reason: 'Has recent activity/jobs within the last 4 hours'
    });
  }

  return reports;
}

module.exports = { runAccountAudit };
