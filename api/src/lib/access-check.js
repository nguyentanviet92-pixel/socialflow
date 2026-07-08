/**
 * Check if user can access a resource.
 * ALL users (including admin) only access own + granted resources.
 */
async function canAccess(supabase, userId, resourceType, resourceId) {
  // Check if owner (for accounts and websites)
  if (resourceType === 'account') {
    const { data } = await supabase.from('accounts').select('id').eq('id', resourceId).eq('owner_id', userId).single()
    if (data) return true
  } else if (resourceType === 'website') {
    const { data } = await supabase.from('websites').select('id').eq('id', resourceId).eq('owner_id', userId).single()
    if (data) return true
  }

  // Check user_resource_access
  const { data } = await supabase
    .from('user_resource_access')
    .select('id')
    .eq('user_id', userId)
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .single()

  return !!data
}

/**
 * Get list of resource IDs user can access for a given type.
 * ALL users (including admin) only see their own + granted resources.
 * Admin cannot see other users' cookies/accounts.
 */
async function getAccessibleIds(supabase, userId, resourceType) {
  // Get owned resources
  let ownedIds = []
  if (resourceType === 'account') {
    const { data } = await supabase.from('accounts').select('id').eq('owner_id', userId)
    ownedIds = (data || []).map(r => r.id)
  } else if (resourceType === 'fanpage') {
    const { data } = await supabase
      .from('fanpages')
      .select('id, accounts!inner(owner_id)')
      .eq('accounts.owner_id', userId)
    ownedIds = (data || []).map(r => r.id)
  } else if (resourceType === 'group') {
    const { data } = await supabase
      .from('fb_groups')
      .select('id, accounts!inner(owner_id)')
      .eq('accounts.owner_id', userId)
    ownedIds = (data || []).map(r => r.id)
  } else if (resourceType === 'website') {
    const { data } = await supabase.from('websites').select('id').eq('owner_id', userId)
    ownedIds = (data || []).map(r => r.id)
  }

  // Get granted resources
  const { data: granted } = await supabase
    .from('user_resource_access')
    .select('resource_id')
    .eq('user_id', userId)
    .eq('resource_type', resourceType)

  const grantedIds = (granted || []).map(r => r.resource_id)

  // Merge and deduplicate
  return [...new Set([...ownedIds, ...grantedIds])]
}

module.exports = { canAccess, getAccessibleIds }
