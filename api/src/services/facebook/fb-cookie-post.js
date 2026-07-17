const axios = require('axios')
const { getDtsgWithRefresh, FB_HEADERS, buildAxiosProxy } = require('./fb-auth')

async function postToPage(pageId, account, content, supabase) {
  if (!content.caption || content.caption.trim() === '') {
    throw new Error('Content (caption) is empty - blocking empty post')
  }
  const proxy = account.proxy_id ? await getProxy(account.proxy_id, supabase) : null
  const dtsg = await getDtsgWithRefresh(account, supabase, proxy)

  const body = new URLSearchParams({
    fb_dtsg: dtsg,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'ComposerStoryCreateMutation',
    variables: JSON.stringify({
      input: {
        actor_id: pageId,
        message: { text: content.caption },
        composer_entry_point: 'timeline',
        idempotence_token: `${Date.now()}_PAGE`,
        audience: { privacy: { base_state: 'EVERYONE' } }
      }
    }),
    doc_id: '7711610262215707'
  })

  const res = await axios.post('https://www.facebook.com/api/graphql/', body, {
    headers: {
      Cookie: account.cookie_string,
      'User-Agent': account.user_agent,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...FB_HEADERS
    },
    ...(proxy && { proxy: buildAxiosProxy(proxy) })
  })

  return parsePostResult(res.data)
}

async function postToGroup(groupId, account, content, supabase) {
  if (!content.caption || content.caption.trim() === '') {
    throw new Error('Content (caption) is empty - blocking empty post')
  }
  const proxy = account.proxy_id ? await getProxy(account.proxy_id, supabase) : null
  const dtsg = await getDtsgWithRefresh(account, supabase, proxy)

  const body = new URLSearchParams({
    fb_dtsg: dtsg,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'ComposerStoryCreateMutation',
    variables: JSON.stringify({
      input: {
        actor_id: account.fb_user_id,
        message: { text: content.caption },
        composer_entry_point: 'group',
        idempotence_token: `${Date.now()}_GROUP`,
        audience: { privacy: { base_state: 'EVERYONE' } },
        composer_source_surface: 'group',
        composer_type: 'group',
        group_id: groupId
      }
    }),
    doc_id: '7711610262215707'
  })

  const res = await axios.post('https://www.facebook.com/api/graphql/', body, {
    headers: {
      Cookie: account.cookie_string,
      'User-Agent': account.user_agent,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...FB_HEADERS
    },
    ...(proxy && { proxy: buildAxiosProxy(proxy) })
  })

  return parsePostResult(res.data)
}

async function postToProfile(account, content, supabase) {
  if (!content.caption || content.caption.trim() === '') {
    throw new Error('Content (caption) is empty - blocking empty post')
  }
  const proxy = account.proxy_id ? await getProxy(account.proxy_id, supabase) : null
  const dtsg = await getDtsgWithRefresh(account, supabase, proxy)

  const privacyMap = {
    'PUBLIC': 'EVERYONE',
    'FRIENDS': 'ALL_FRIENDS',
    'ONLY_ME': 'SELF'
  }

  const body = new URLSearchParams({
    fb_dtsg: dtsg,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'ComposerStoryCreateMutation',
    variables: JSON.stringify({
      input: {
        actor_id: account.fb_user_id,
        message: { text: content.caption },
        composer_entry_point: 'timeline',
        idempotence_token: `${Date.now()}_PROFILE`,
        audience: { privacy: { base_state: privacyMap[content.privacy] || 'EVERYONE' } }
      }
    }),
    doc_id: '7711610262215707'
  })

  const res = await axios.post('https://www.facebook.com/api/graphql/', body, {
    headers: {
      Cookie: account.cookie_string,
      'User-Agent': account.user_agent,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...FB_HEADERS
    },
    ...(proxy && { proxy: buildAxiosProxy(proxy) })
  })

  return parsePostResult(res.data)
}

function parsePostResult(data) {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    const postIdMatch = str.match(/"story_id":"([^"]+)"/) ||
                        str.match(/"post_id":"([^"]+)"/)
    const postId = postIdMatch?.[1]
    return {
      success: !!postId,
      postId,
      postUrl: postId ? `https://facebook.com/${postId}` : null
    }
  } catch {
    return { success: false }
  }
}

async function getProxy(proxyId, supabase) {
  const { data } = await supabase.from('proxies').select('*').eq('id', proxyId).single()
  return data
}

module.exports = { postToPage, postToGroup, postToProfile }
