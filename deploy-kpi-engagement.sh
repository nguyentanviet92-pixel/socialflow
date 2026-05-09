#!/usr/bin/env bash
#
# Deploy script for KPI Coordinator skill + Comment Engagement Tracking
# (2026-05-01).
#
# Run on the VPS that hosts socialflow-api + hermes-api + agent.
# Usage:   bash deploy-kpi-engagement.sh
#
# Prerequisites on VPS:
#   • git pull already done in socialflow/, hermes-api/, socialflow-agent/
#   • AGENT_SECRET env var exported in shell or available in api/.env
#   • pm2 running: socialflow-api, hermes-api, socialflow-agent
#
# Adds:
#   • hermes-api/skills/kpi-coordinator.md
#   • socialflow-agent/jobs/handlers/check-comment-engagement.js
#   • socialflow/api/src/services/hermes-orchestrator.js (new bridge)
#   • socialflow/api/src/services/nurture-scheduler.js (2 new cron)
#   • socialflow-agent/jobs/handlers/campaign-nurture.js (Fix 1-5)

set -euo pipefail

SOCIALFLOW_DIR="${SOCIALFLOW_DIR:-/root/socialflow}"
HERMES_DIR="${HERMES_DIR:-/root/hermes-api}"
AGENT_DIR="${AGENT_DIR:-/root/socialflow-agent}"
API_DIR="$SOCIALFLOW_DIR/api"
HERMES_URL="${HERMES_URL:-http://127.0.0.1:8100}"
PM2_API_NAME="${PM2_API_NAME:-socialflow-api}"
PM2_HERMES_NAME="${PM2_HERMES_NAME:-hermes-api}"
PM2_AGENT_NAME="${PM2_AGENT_NAME:-socialflow-agent}"

if [[ -z "${AGENT_SECRET:-}" ]]; then
  if [[ -f "$API_DIR/.env" ]]; then
    AGENT_SECRET=$(grep -E '^AGENT_SECRET(_KEY)?=' "$API_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"')
  fi
fi
if [[ -z "${AGENT_SECRET:-}" ]]; then
  echo "[ERROR] AGENT_SECRET not set and not found in $API_DIR/.env" >&2
  exit 1
fi

echo "=== KPI Coordinator + Engagement Tracking Deploy ==="
echo "  socialflow:   $SOCIALFLOW_DIR"
echo "  hermes-api:   $HERMES_DIR"
echo "  agent:        $AGENT_DIR"
echo

# ── 1. Verify new files on disk ──────────────────────────────────
echo "[1/6] Verifying files…"
declare -A REQUIRED_FILES=(
  ["$HERMES_DIR/skills/kpi-coordinator.md"]="kpi-coordinator skill"
  ["$AGENT_DIR/jobs/handlers/check-comment-engagement.js"]="engagement handler"
  ["$API_DIR/src/services/hermes-orchestrator.js"]="orchestrator with bridge"
  ["$API_DIR/src/services/nurture-scheduler.js"]="scheduler with cron"
  ["$AGENT_DIR/jobs/handlers/campaign-nurture.js"]="nurture handler with fixes"
)
for f in "${!REQUIRED_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  [ERROR] Missing $f (${REQUIRED_FILES[$f]})" >&2
    exit 1
  fi
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  echo "  ✓ ${REQUIRED_FILES[$f]} (${size} bytes)"
done

# ── 2. Code-level sanity checks ──────────────────────────────────
echo
echo "[2/6] Sanity-checking code edits…"
if ! grep -q "runKpiCoordinator" "$API_DIR/src/services/hermes-orchestrator.js"; then
  echo "  [ERROR] hermes-orchestrator.js missing runKpiCoordinator export" >&2; exit 1
fi
if ! grep -q "check_comment_engagement" "$AGENT_DIR/jobs/handlers/index.js"; then
  echo "  [ERROR] agent index.js missing check_comment_engagement handler" >&2; exit 1
fi
if ! grep -q "junctionGroupsSaved" "$AGENT_DIR/jobs/handlers/campaign-nurture.js"; then
  echo "  [ERROR] campaign-nurture.js missing Fix 5 (junctionGroupsSaved)" >&2; exit 1
fi
if ! grep -q "kpi_coordinator" "$API_DIR/src/services/nurture-scheduler.js"; then
  echo "  [ERROR] nurture-scheduler.js missing kpi_coordinator cron" >&2; exit 1
fi
echo "  ✓ All required symbols present"

# ── 3. Reload Hermes skills (hot-reload) ─────────────────────────
echo
echo "[3/6] Reloading Hermes skills…"
RELOAD_RESPONSE=$(curl -sS -X POST -H "X-Agent-Key: $AGENT_SECRET" "$HERMES_URL/skills/reload" || true)
if echo "$RELOAD_RESPONSE" | grep -q "skills_loaded"; then
  echo "  ✓ Reload OK: $(echo "$RELOAD_RESPONSE" | head -c 200)"
else
  echo "  [WARN] Reload response unexpected: $RELOAD_RESPONSE"
  echo "  [WARN] Falling back to pm2 restart hermes…"
  pm2 restart "$PM2_HERMES_NAME" || true
  sleep 2
fi

# Verify kpi_coordinator is loaded
status=$(curl -sS -o /dev/null -w "%{http_code}" -H "X-Agent-Key: $AGENT_SECRET" "$HERMES_URL/skills/kpi_coordinator")
if [[ "$status" != "200" ]]; then
  echo "  [ERROR] kpi_coordinator skill not reachable (HTTP $status)" >&2
  exit 1
fi
echo "  ✓ kpi_coordinator skill loaded into Hermes runtime"

# ── 4. Restart socialflow-api (loads cron + bridge) ──────────────
echo
echo "[4/6] Restarting socialflow-api…"
pm2 restart "$PM2_API_NAME" --update-env
sleep 4
if pm2 describe "$PM2_API_NAME" | grep -q "online"; then
  echo "  ✓ socialflow-api online"
else
  echo "  [ERROR] socialflow-api not online — check pm2 logs $PM2_API_NAME" >&2
  exit 1
fi

# ── 5. Restart agent (loads new handler) ─────────────────────────
echo
echo "[5/6] Restarting socialflow-agent…"
pm2 restart "$PM2_AGENT_NAME" --update-env || {
  echo "  [WARN] $PM2_AGENT_NAME not in pm2; agent may run elsewhere"
}
sleep 3
if pm2 describe "$PM2_AGENT_NAME" 2>/dev/null | grep -q "online"; then
  echo "  ✓ agent online"
else
  echo "  [WARN] agent process state unknown"
fi

# ── 6. Smoke verification ────────────────────────────────────────
echo
echo "[6/6] Smoke checks…"

# 6a. Trigger one KPI coordinator cycle (don't wait for cron)
echo "  • Manually invoking KPI coordinator on first running campaign…"
node -e "
  (async () => {
    const path = '$API_DIR';
    process.chdir(path);
    const { createClient } = require(path + '/node_modules/@supabase/supabase-js');
    require('dotenv').config({ path: path + '/.env' });
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data } = await sb.from('campaigns').select('id, name').eq('status', 'running').eq('is_active', true).limit(1).maybeSingle();
    if (!data) { console.log('    no running campaign — skipping'); return; }
    const { runKpiCoordinator } = require(path + '/src/services/hermes-orchestrator');
    const out = await runKpiCoordinator(data.id, sb);
    console.log('    KPI coord →', out.decision?.summary || out.error || 'no decision');
  })().catch(e => { console.error('    error:', e.message); process.exit(1); });
" || echo "  [WARN] Manual KPI coord invocation failed (non-fatal — cron will retry)"

# 6b. Recent log lines
echo
echo "  • Recent api log lines (KPI / engagement):"
pm2 logs "$PM2_API_NAME" --lines 50 --nostream 2>/dev/null | grep -E "KPI-COORD|ENGAGEMENT-CHECK" | tail -10 || echo "    (no log lines yet — wait for cron)"

echo
echo "=== Deploy complete ==="
echo
echo "Cron schedule (VN time):"
echo "  • KPI Coordinator: 9× per day (07:23, 09:23, 11:23, 13:23, 14:23, 16:23, 18:23, 20:23, 22:23)"
echo "  • Engagement Check: every 6h at :37 (00:37, 06:37, 12:37, 18:37 VN)"
echo
echo "Monitor:"
echo "  pm2 logs $PM2_API_NAME --lines 100 | grep -E 'KPI-COORD|ENGAGEMENT'"
echo "  pm2 logs $PM2_AGENT_NAME --lines 100 | grep ENGAGEMENT-CHECK"
echo "  Supabase: SELECT * FROM hermes_decisions WHERE decision_type='kpi_coordination' ORDER BY created_at DESC LIMIT 5;"
echo
echo "Kill switch (if KPI coord misbehaves):"
echo "  Comment out the kpi_coordinator cron in nurture-scheduler.js + restart api"
