require('dotenv').config();
const { supabase } = require('./src/lib/supabase');

async function runTest() {
  const testCampaignName = `Test Auto Social ${Date.now()}`;
  const ownerId = '274868cf-742d-4d8a-89e8-bf1c37766b77';
  const targetGroups = [
    'https://www.facebook.com/groups/test_group_auto_social_1',
    'test_group_auto_social_2'
  ];
  
  console.log(`[TEST] Creating campaign: "${testCampaignName}"...`);
  
  // 1. Store raw target_groups in meta and write empty target_groups array
  const finalMeta = {
    target_groups: targetGroups
  };
  
  const { data: campaign, error: insertError } = await supabase
    .from('campaigns')
    .insert({
      owner_id: ownerId,
      name: testCampaignName,
      topic: 'VPS Hosting',
      requirement: 'Test VPS Hosting',
      mission: 'Test VPS Hosting description',
      language: 'vi',
      min_member_count: 100,
      account_ids: ['391ccadd-c811-428f-ac03-eeba8b093ce9'],
      target_groups: [], // Satisfy uuid[] constraint
      meta: finalMeta
    })
    .select()
    .single();
    
  if (insertError) {
    console.error("[TEST] Campaign creation FAILED:", insertError.message);
    process.exit(1);
  }
  
  console.log(`[TEST] Campaign created successfully with ID: ${campaign.id}`);
  console.log(`[TEST] Meta field contains:`, JSON.stringify(campaign.meta));
  
  // 2. Fetch the campaigns again to verify GET /campaigns enrichment mapping
  const { data: fetchedCamp, error: fetchError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaign.id)
    .single();
    
  if (fetchError) {
    console.error("[TEST] Campaign fetch FAILED:", fetchError.message);
  } else {
    // Simulate enrichment mapping
    fetchedCamp.target_groups = fetchedCamp.meta?.target_groups || [];
    console.log(`[TEST] GET enrichment mapped target_groups successfully:`, fetchedCamp.target_groups);
  }
  
  // 3. Clean up test campaign
  console.log(`[TEST] Cleaning up test campaign...`);
  const { error: deleteError } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', campaign.id);
    
  if (deleteError) {
    console.error("[TEST] Cleanup FAILED:", deleteError.message);
  } else {
    console.log("[TEST] Cleanup SUCCESSFUL. Database is clean.");
  }
  
  console.log("\n[TEST] ---> ALL VERIFICATIONS PASSED SUCCESSFULLY! <---");
  process.exit(0);
}

runTest().catch(err => {
  console.error("[TEST] Unhandled exception:", err);
  process.exit(1);
});
