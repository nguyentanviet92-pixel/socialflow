require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
s.from('profiles').select('id,email,role,is_active').then(r => {
  console.log(JSON.stringify(r.data, null, 2));
  process.exit(0);
});
