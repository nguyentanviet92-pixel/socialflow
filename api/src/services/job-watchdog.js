const { supabase } = require('../lib/supabase');
const { executeRoleCampaign } = require('./campaign-scheduler');

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    console.log(`[WATCHDOG-TELEGRAM-LOCAL-LOG]: ${message}`);
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.resolve(__dirname, '../../watchdog_alerts_local.log');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    } catch {}
    return;
  }
  
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    if (!res.ok) {
      console.warn(`[WATCHDOG-TELEGRAM] Telegram response failed: ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[WATCHDOG-TELEGRAM] Telegram request failed: ${err.message}`);
  }
}

async function runWatchdog() {
  console.log('[WATCHDOG] Checking for stale jobs...');
  const pool = supabase._pool;
  if (!pool) {
    console.error('[WATCHDOG] Database pool not ready');
    return;
  }

  // 1. Fetch pending jobs older than 2 hours
  const stalePendingRes = await pool.query(`
    SELECT j.id, j.type, j.payload, j.created_by, a.username as nick_name
    FROM jobs j
    LEFT JOIN accounts a ON (j.payload->>'account_id')::uuid = a.id
    WHERE j.status = 'pending'
      AND j.created_at < now() - interval '2 hours'
  `);
  const stalePendingJobs = stalePendingRes.rows;

  // 2. Fetch claimed/running jobs older than 15 minutes since last heartbeat/started/created
  const staleRunningRes = await pool.query(`
    SELECT j.id, j.type, j.payload, j.created_by, a.username as nick_name
    FROM jobs j
    LEFT JOIN accounts a ON (j.payload->>'account_id')::uuid = a.id
    WHERE j.status IN ('claimed', 'running')
      AND COALESCE(j.last_heartbeat_at, j.started_at, j.scheduled_at, j.created_at) < now() - interval '15 minutes'
  `);
  const staleRunningJobs = staleRunningRes.rows;

  if (stalePendingJobs.length === 0 && staleRunningJobs.length === 0) {
    return;
  }

  console.log(`[WATCHDOG] Found ${stalePendingJobs.length} stale pending, ${staleRunningJobs.length} stale running/claimed jobs.`);

  // 3. Reap stale pending jobs
  for (const job of stalePendingJobs) {
    await pool.query(`
      UPDATE jobs 
      SET status = 'cancelled', 
          error_message = 'stale_pending_timeout',
          finished_at = now()
      WHERE id = $1
    `, [job.id]);

    const campaignId = job.payload?.campaign_id;
    const ownerId = job.payload?.owner_id || job.created_by;
    const nickId = job.payload?.account_id;

    // Log to campaign_activity_log
    if (campaignId) {
      try {
        await supabase.from('campaign_activity_log').insert({
          campaign_id: campaignId,
          owner_id: ownerId || null,
          action_type: 'watchdog_cancel',
          result_status: 'cancelled',
          source: 'watchdog',
          details: {
            job_id: job.id,
            job_type: job.type,
            account_id: nickId,
            reason: 'stale_pending_timeout'
          }
        });
      } catch {}
    }
  }

  // 4. Reap stale claimed/running jobs
  for (const job of staleRunningJobs) {
    await pool.query(`
      UPDATE jobs 
      SET status = 'failed', 
          error_message = 'stale_heartbeat_timeout',
          finished_at = now()
      WHERE id = $1
    `, [job.id]);

    const campaignId = job.payload?.campaign_id;
    const ownerId = job.payload?.owner_id || job.created_by;
    const nickId = job.payload?.account_id;

    // Log to campaign_activity_log
    if (campaignId) {
      try {
        await supabase.from('campaign_activity_log').insert({
          campaign_id: campaignId,
          owner_id: ownerId || null,
          action_type: 'watchdog_fail',
          result_status: 'failed',
          source: 'watchdog',
          details: {
            job_id: job.id,
            job_type: job.type,
            account_id: nickId,
            reason: 'stale_heartbeat_timeout'
          }
        });
      } catch {}
    }
  }

  // 5. Send Telegram summary
  let msg = `⚠️ SocialFlow Watchdog Reap Summary\n\n`;
  if (stalePendingJobs.length > 0) {
    msg += `Cancelled Pending Jobs (${stalePendingJobs.length}):\n`;
    stalePendingJobs.forEach(j => {
      msg += `- [${j.nick_name || 'unknown'}] Job: ${j.type} (${j.id.slice(0, 8)})\n`;
    });
  }
  if (staleRunningJobs.length > 0) {
    msg += `\nFailed Running Jobs (${staleRunningJobs.length}):\n`;
    staleRunningJobs.forEach(j => {
      msg += `- [${j.nick_name || 'unknown'}] Job: ${j.type} (${j.id.slice(0, 8)})\n`;
    });
  }
  await sendTelegramAlert(msg);

  // 6. Reschedule campaign wave immediately for freed nicks
  const uniqueCampaignIds = [...new Set([
    ...stalePendingJobs.map(j => j.payload?.campaign_id).filter(Boolean),
    ...staleRunningJobs.map(j => j.payload?.campaign_id).filter(Boolean)
  ])];

  for (const campaignId of uniqueCampaignIds) {
    try {
      console.log(`[WATCHDOG] Triggering campaign scheduler immediate execution for campaign: ${campaignId}`);
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('*, campaign_roles(*)')
        .eq('id', campaignId)
        .single();
      if (campaign && ['active', 'running'].includes(campaign.status)) {
        await executeRoleCampaign(campaign);
      }
    } catch (schedErr) {
      console.error(`[WATCHDOG] Failed to reschedule campaign ${campaignId}:`, schedErr.message);
    }
  }
}

module.exports = { runWatchdog };
