const axios = require('axios')
const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0'

module.exports = async (fastify) => {
  const { supabase } = fastify

  // GET /system-settings/:key
  fastify.get('/:key', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { data, error } = await supabase
      .from('system_settings')
      .select('*')
      .eq('key', req.params.key)
      .single()

    if (error && error.code === 'PGRST116') {
      return reply.code(404).send({ error: 'Setting not found' })
    }
    if (error) return reply.code(500).send({ error: error.message })

    // Mask sensitive fields
    if (req.params.key === 'hermes' && data.value?.agent_secret) {
      data.value = {
        ...data.value,
        agent_secret: data.value.agent_secret.substring(0, 8) + '...'
      }
    }
    if (req.params.key === 'r2_storage' && data.value?.secret_access_key) {
      data.value = {
        ...data.value,
        secret_access_key: data.value.secret_access_key.substring(0, 8) + '...'
      }
    }
    if (req.params.key === 'facebook_api') {
      if (data.value?.access_token) {
        data.value.access_token = data.value.access_token.substring(0, 12) + '...'
      }
      if (data.value?.app_secret) {
        data.value.app_secret = data.value.app_secret.substring(0, 6) + '...'
      }
    }
    if (req.params.key === 'apify' && data.value?.keys?.length) {
      data.value = {
        ...data.value,
        keys: data.value.keys.map(k => ({
          ...k,
          key: k.key ? k.key.substring(0, 8) + '...' : '',
        }))
      }
    }

    return data
  })

  // PUT /system-settings/:key
  fastify.put('/:key', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const allowedKeys = ['r2_storage', 'facebook_api', 'apify', 'hermes']
    if (!allowedKeys.includes(req.params.key)) {
      return reply.code(400).send({ error: 'Invalid setting key' })
    }

    // For hermes, merge with existing to preserve masked fields
    let finalValue = req.body.value
    if (req.params.key === 'hermes' && finalValue?.agent_secret?.endsWith('...')) {
      const { data: existing } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'hermes')
        .single()

      if (existing?.value?.agent_secret) {
        finalValue = { ...finalValue, agent_secret: existing.value.agent_secret }
      }
    }

    // For r2_storage, merge with existing to preserve masked fields
    if (req.params.key === 'r2_storage' && finalValue?.secret_access_key?.endsWith('...')) {
      const { data: existing } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'r2_storage')
        .single()

      if (existing?.value?.secret_access_key) {
        finalValue = { ...finalValue, secret_access_key: existing.value.secret_access_key }
      }
    }

    // For apify, merge masked keys with existing real keys
    if (req.params.key === 'apify' && finalValue?.keys?.length) {
      const hasMasked = finalValue.keys.some(k => k.key?.endsWith('...'))
      if (hasMasked) {
        const { data: existing } = await supabase
          .from('system_settings')
          .select('value')
          .eq('key', 'apify')
          .single()
        const existingKeys = existing?.value?.keys || []
        finalValue = {
          ...finalValue,
          keys: finalValue.keys.map(k => {
            if (k.key?.endsWith('...')) {
              const orig = existingKeys.find(ek => ek.key?.substring(0, 8) + '...' === k.key)
              return orig ? { ...k, key: orig.key } : k
            }
            return k
          })
        }
      }
    }

    // For facebook_api, merge with existing to preserve masked fields
    if (req.params.key === 'facebook_api') {
      const needsMerge = finalValue?.access_token?.endsWith('...') || finalValue?.app_secret?.endsWith('...')
      if (needsMerge) {
        const { data: existing } = await supabase
          .from('system_settings')
          .select('value')
          .eq('key', 'facebook_api')
          .single()

        if (finalValue?.access_token?.endsWith('...') && existing?.value?.access_token) {
          finalValue = { ...finalValue, access_token: existing.value.access_token }
        }
        if (finalValue?.app_secret?.endsWith('...') && existing?.value?.app_secret) {
          finalValue = { ...finalValue, app_secret: existing.value.app_secret }
        }
      }
    }

    const { data, error } = await supabase
      .from('system_settings')
      .upsert({
        key: req.params.key,
        value: finalValue,
        updated_at: new Date().toISOString(),
        updated_by: req.user.id
      })
      .select()
      .single()

    if (error) return reply.code(500).send({ error: error.message })

    // Reload R2 config at runtime
    if (req.params.key === 'r2_storage' && fastify.reloadR2Config) {
      fastify.reloadR2Config(finalValue)
    }

    // Auto-sync page tokens when user saves a new access_token
    if (req.params.key === 'facebook_api' && finalValue?.access_token && !finalValue.access_token.endsWith('...')) {
      syncPageTokens(fastify, finalValue.access_token).catch(err => {
        fastify.log.error({ err: err.message }, '[AUTO-SYNC] Failed to sync page tokens')
      })
      // Don't await — respond immediately, sync in background
      data.page_sync = 'started'
    }

    return data
  })

  // POST /system-settings/test-r2 - Test R2 credentials
  fastify.post('/test-r2', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
    
    let config = req.body.value
    if (!config || !config.account_id) {
      return reply.code(400).send({ error: 'Missing configuration payload' })
    }

    // Unmask secret if needed by grabbing from DB
    if (config.secret_access_key?.endsWith('...')) {
      const { data: existing } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'r2_storage')
        .single()
      if (existing?.value?.secret_access_key) {
        config.secret_access_key = existing.value.secret_access_key
      }
    }

    try {
      const testClient = new S3Client({
        region: 'auto',
        endpoint: `https://${config.account_id}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.access_key_id,
          secretAccessKey: config.secret_access_key
        }
      })

      const testKey = 'test-connection/test.txt'
      // Try Upload
      await testClient.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: testKey,
        Body: Buffer.from('connection successful', 'utf-8'),
        ContentType: 'text/plain'
      }))

      // Clean up
      await testClient.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: testKey
      }))

      return { success: true, message: 'Kết nối thành công!' }
    } catch (err) {
      req.log.error({ err }, 'test-r2 error')
      return reply.code(400).send({ error: `Lỗi kết nối: ${err.message}` })
    }
  })
}

/**
 * Auto-sync all fanpage tokens from the User Token.
 * Called in background when user saves a new facebook_api access_token.
 */
async function syncPageTokens(fastify, userToken) {
  const { supabase } = fastify
  fastify.log.info('[AUTO-SYNC] Syncing page tokens from new User Token...')

  // Fetch all pages + page tokens from Facebook
  const pages = []
  let url = `${GRAPH_API_BASE}/me/accounts`
  let params = { access_token: userToken, fields: 'id,name,access_token', limit: 100 }
  let pageNum = 1

  while (url && pageNum <= 50) {
    const { data: resp } = await axios.get(url, { params, timeout: 30000 })
    if (resp.data) pages.push(...resp.data)
    url = resp.paging?.next || null
    params = {}
    pageNum++
  }

  if (!pages.length) {
    fastify.log.warn('[AUTO-SYNC] No pages found from User Token')
    return
  }

  // Get all existing fanpages from DB
  const { data: fanpages } = await supabase.from('fanpages').select('id, fb_page_id')
  if (!fanpages?.length) {
    fastify.log.info('[AUTO-SYNC] No fanpages in DB to update')
    return
  }

  // Update each fanpage's access_token
  let updated = 0
  for (const fp of fanpages) {
    const fbPage = pages.find(p => p.id === fp.fb_page_id)
    if (fbPage?.access_token) {
      const { error } = await supabase
        .from('fanpages')
        .update({ access_token: fbPage.access_token, token_status: 'active' })
        .eq('id', fp.id)
      if (!error) updated++
    }
  }

  fastify.log.info(`[AUTO-SYNC] Done! Updated ${updated}/${fanpages.length} page tokens`)
}
