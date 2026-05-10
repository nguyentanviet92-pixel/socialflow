const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient('http://103.142.24.60:8000', process.env.SUPABASE_ANON_KEY);
supabase.from('jobs').select('id, type, status, created_at').eq('type', 'campaign_nurture').order('created_at', { ascending: false }).limit(5).then(console.log);
