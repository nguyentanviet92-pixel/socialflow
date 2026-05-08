/**
 * Campaign Handler: Send Friend Request (Role: connect)
 * Claim targets from target_queue → visit profile → send friend request
 */

const { getPage, releaseSession } = require('../../browser/session-pool')
const { delay, humanScroll, humanMouseMove, humanClick } = require('../../browser/human')
const { saveDebugScreenshot, friendlyError } = require('./post-utils')
const { checkHardLimit, applyAgeFactor } = require('../../lib/hard-limits')
const R = require('../../lib/randomizer')
const { getActionParams } = require('../../lib/plan-executor')
const { ActivityLogger } = require('../../lib/activity-logger')

async function campaignSendFriendRequest(payload, supabase) {
  const { account_id, campaign_id, role_id, parsed_plan } = payload

  const logger = new ActivityLogger(supabase, {
    campaign_id, role_id, account_id,
    job_id: payload.job_id,
    owner_id: payload.owner_id || payload.created_by,
  })

  const { data: account } = await supabase
    .from('accounts')
    .select('*, proxies(*)')
    .eq('id', account_id)
    .single()
  if (!account) throw new Error('Account not found')

  // Check budget
  const budget = account.daily_budget?.friend_request || { used: 0, max: 15 }
  const { allowed, remaining } = checkHardLimit('friend_request', budget.used, 0)
  if (!allowed || remaining <= 0) {
    throw new Error('SKIP_friend_request_budget_exceeded')
  }

  const nickAge = Math.floor((Date.now() - new Date(account.created_at).getTime()) / 86400000)
  const planFR = getActionParams(parsed_plan, 'friend_request', { countMin: 3, countMax: 5 }).count
  const maxFR = Math.min(applyAgeFactor(remaining, nickAge), planFR) // capped by plan + age factor

  // Claim targets atomically
  const { data: targets } = await supabase.rpc('claim_targets', {
    p_campaign_id: campaign_id,
    p_target_role_id: role_id,
    p_account_id: account_id,
    p_limit: maxFR,
  })

  if (!targets?.length) {
    throw new Error('SKIP_no_targets_available')
  }

  let page
  try {
    const session = await getPage(account)
    page = session.page

    const results = []
    let sent = 0

    for (const target of targets) {
      try {
        // Check if already sent
        const { data: existing } = await supabase
          .from('friend_request_log')
          .select('id, status')
          .eq('account_id', account_id)
          .eq('target_fb_id', target.fb_user_id)
          .single()

        if (existing) {
          await supabase.from('target_queue').update({ status: 'skip' }).eq('id', target.id)
          results.push({ fb_user_id: target.fb_user_id, status: 'already_logged' })
          continue
        }

        // Navigate to profile
        const profileUrl = target.fb_profile_url || `https://www.facebook.com/profile.php?id=${target.fb_user_id}`
        console.log(`[CAMPAIGN-FR] Visiting profile: ${target.fb_user_name || target.fb_user_id}`)
        logger.log('visit_profile', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl })
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await R.sleepRange(2000, 4000)
        await humanMouseMove(page)

        // Check if already friends
        const alreadyFriend = await page.$([
          'div[aria-label="Friends"]',
          'div[aria-label="Bạn bè"]',
          'a[aria-label="Friends"]',
        ].join(', '))

        if (alreadyFriend) {
          await supabase.from('friend_request_log').upsert({
            account_id,
            campaign_id,
            target_fb_id: target.fb_user_id,
            target_name: target.fb_user_name,
            target_profile_url: profileUrl,
            status: 'already_friend',
          }, { onConflict: 'account_id,target_fb_id' })

          await supabase.from('target_queue').update({ status: 'skip', processed_at: new Date() }).eq('id', target.id)
          results.push({ fb_user_id: target.fb_user_id, status: 'already_friend' })
          logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, result_status: 'skipped', details: { reason: 'already_friend' } })
          continue
        }

        // Check if request already sent
        const pendingRequest = await page.$([
          'div[aria-label="Cancel request"]',
          'div[aria-label="Hủy yêu cầu"]',
          'div[aria-label="Request sent"]',
        ].join(', '))

        if (pendingRequest) {
          await supabase.from('friend_request_log').upsert({
            account_id, campaign_id,
            target_fb_id: target.fb_user_id,
            target_name: target.fb_user_name,
            target_profile_url: profileUrl,
            status: 'sent',
          }, { onConflict: 'account_id,target_fb_id' })

          await supabase.from('target_queue').update({ status: 'done', processed_at: new Date() }).eq('id', target.id)
          results.push({ fb_user_id: target.fb_user_id, status: 'already_sent' })
          logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, result_status: 'skipped', details: { reason: 'already_sent' } })
          continue
        }

        // Find Add Friend button
        const addBtn = await page.$([
          'div[aria-label="Add friend"]',
          'div[aria-label="Thêm bạn bè"]',
          'div[aria-label="Add Friend"]',
          'div[role="button"]:has-text("Add friend")',
          'div[role="button"]:has-text("Thêm bạn bè")',
          'div[role="button"]:has-text("Add Friend")',
        ].join(', '))

        if (addBtn) {
          // Browse profile a bit first (look natural)
          await humanScroll(page)
          await R.sleepRange(1000, 3000)

          await addBtn.scrollIntoViewIfNeeded()
          await R.sleepRange(500, 1500)
          await humanClick(page, addBtn)
          await R.sleepRange(1500, 3000)

          // Log to friend_request_log
          await supabase.from('friend_request_log').upsert({
            account_id,
            campaign_id,
            target_fb_id: target.fb_user_id,
            target_name: target.fb_user_name,
            target_profile_url: profileUrl,
            status: 'sent',
          }, { onConflict: 'account_id,target_fb_id' })

          // Increment budget
          await supabase.rpc('increment_budget', {
            p_account_id: account_id,
            p_action_type: 'friend_request',
          })

          // Update target_queue
          await supabase.from('target_queue').update({
            status: 'done',
            processed_at: new Date(),
          }).eq('id', target.id)

          sent++
          results.push({ fb_user_id: target.fb_user_id, status: 'sent' })
          console.log(`[CAMPAIGN-FR] Sent request to: ${target.fb_user_name || target.fb_user_id}`)
          logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, details: { status: 'sent' } })
        } else {
          // No add button found (might be restricted)
          await supabase.from('target_queue').update({
            status: 'skip',
            error_message: 'Add friend button not found',
          }).eq('id', target.id)
          results.push({ fb_user_id: target.fb_user_id, status: 'no_button' })
          logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, target_url: profileUrl, result_status: 'failed', details: { reason: 'no_add_button' } })
        }
      } catch (err) {
        console.warn(`[CAMPAIGN-FR] Failed for ${target.fb_user_id}: ${err.message}`)
        await supabase.from('target_queue').update({
          status: 'failed',
          error_message: err.message.substring(0, 200),
        }).eq('id', target.id)
        results.push({ fb_user_id: target.fb_user_id, status: 'failed', error: err.message })
        logger.log('friend_request', { target_type: 'profile', target_id: target.fb_user_id, target_name: target.fb_user_name, result_status: 'failed', details: { error: friendlyError(err) } })
      }

      // Gap between friend requests (45-90s)
      if (targets.indexOf(target) < targets.length - 1) {
        const gap = R.friendRequestGap()
        console.log(`[CAMPAIGN-FR] Waiting ${Math.round(gap / 1000)}s`)
        await R.sleep(gap)
      }
    }

    console.log(`[CAMPAIGN-FR] Done: ${sent} requests sent out of ${targets.length} targets`)
    return {
      success: true,
      targets_claimed: targets.length,
      requests_sent: sent,
      results,
    }
  } catch (err) {
    if (page) await saveDebugScreenshot(page, `campaign-fr-${account_id}`)
    throw err
  } finally {
    await logger.flush().catch(() => {})
    if (page) // Keep page on FB for session reuse
    releaseSession(account_id)
  }
}

module.exports = campaignSendFriendRequest
