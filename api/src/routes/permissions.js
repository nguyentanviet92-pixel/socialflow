module.exports = async (fastify) => {
  const { supabase } = fastify

  // GET /permissions/:userId - Get all permissions for a user
  fastify.get('/:userId', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { data, error } = await supabase
      .from('user_resource_access')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('resource_type')

    if (error) return reply.code(500).send({ error: error.message })
    return data
  })

  // PUT /permissions/:userId - Set permissions for a user (replace all)
  fastify.put('/:userId', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { permissions } = req.body // [{ resource_type, resource_id }]
    if (!Array.isArray(permissions)) return reply.code(400).send({ error: 'permissions array required' })

    // Delete existing permissions
    await supabase.from('user_resource_access').delete().eq('user_id', req.params.userId)

    if (permissions.length === 0) return { success: true, count: 0 }

    // Insert new permissions
    const rows = permissions.map(p => ({
      user_id: req.params.userId,
      resource_type: p.resource_type,
      resource_id: p.resource_id,
      granted_by: req.user.id,
    }))

    const { data, error } = await supabase.from('user_resource_access').insert(rows).select()
    if (error) return reply.code(500).send({ error: error.message })
    return { success: true, count: data.length }
  })

  // POST /permissions/:userId/grant - Grant specific permissions
  fastify.post('/:userId/grant', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { resource_type, resource_ids } = req.body
    if (!resource_type || !resource_ids?.length) {
      return reply.code(400).send({ error: 'resource_type and resource_ids required' })
    }

    const rows = resource_ids.map(rid => ({
      user_id: req.params.userId,
      resource_type,
      resource_id: rid,
      granted_by: req.user.id,
    }))

    const { data, error } = await supabase
      .from('user_resource_access')
      .upsert(rows, { onConflict: 'user_id,resource_type,resource_id' })
      .select()

    if (error) return reply.code(500).send({ error: error.message })
    return { success: true, granted: data.length }
  })

  // POST /permissions/:userId/revoke - Revoke specific permissions
  fastify.post('/:userId/revoke', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const { resource_type, resource_ids } = req.body
    if (!resource_type || !resource_ids?.length) {
      return reply.code(400).send({ error: 'resource_type and resource_ids required' })
    }

    const { error } = await supabase
      .from('user_resource_access')
      .delete()
      .eq('user_id', req.params.userId)
      .eq('resource_type', resource_type)
      .in('resource_id', resource_ids)

    if (error) return reply.code(500).send({ error: error.message })
    return { success: true }
  })

  // GET /permissions/resources/all - Get all available resources for assignment (admin only)
  fastify.get('/resources/all', { preHandler: fastify.requireAdmin }, async (req, reply) => {
    const [accounts, fanpages, groups, websites] = await Promise.all([
      supabase.from('accounts').select('id, username, fb_user_id, owner_id').order('username'),
      supabase.from('fanpages').select('id, name, fb_page_id, account_id').order('name'),
      supabase.from('fb_groups').select('id, name, fb_group_id, account_id').order('name'),
      supabase.from('websites').select('id, name, url, owner_id').neq('url', 'pending').order('name'),
    ])

    return {
      accounts: accounts.data || [],
      fanpages: fanpages.data || [],
      groups: groups.data || [],
      websites: websites.data || [],
    }
  })
}
