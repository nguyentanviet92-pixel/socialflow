// Quick script to check campaign topics
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, name, topic, is_active, status')
    .eq('is_active', true)
  
  if (error) {
    console.error('Error:', error.message)
    return
  }
  
  console.log('Active campaigns:')
  for (const c of data || []) {
    const topicStr = c.topic === null ? 'NULL' : c.topic === undefined ? 'UNDEFINED' : JSON.stringify(c.topic)
    console.log(`  [${c.id.slice(0,8)}] "${c.name}" → topic: ${topicStr} (status: ${c.status})`)
  }
}

main().catch(console.error)
