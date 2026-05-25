#!/usr/bin/env bash
# ============================================================
# deploy-frontend.sh
# One-click deploy: Build React frontend + Cấu hình Caddy serve static
#
# Usage (trên VPS):
#   cd /root/socialflow
#   bash deploy-frontend.sh
# ============================================================
set -euo pipefail

SOCIALFLOW_DIR="${SOCIALFLOW_DIR:-/root/socialflow}"
FRONTEND_DIR="$SOCIALFLOW_DIR/frontend"
DIST_DIR="$FRONTEND_DIR/dist"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
VPS_IP="103.142.24.60"
FRONTEND_DOMAIN="app-${VPS_IP//./-}.sslip.io"

echo "======================================================"
echo "  SocialFlow Frontend Deploy"
echo "  Domain  : https://$FRONTEND_DOMAIN"
echo "  Dist dir: $DIST_DIR"
echo "======================================================"
echo

# ── 1. Pull code mới nhất ────────────────────────────────
echo "[1/4] Kéo code mới nhất từ GitHub..."
cd "$SOCIALFLOW_DIR"
git pull origin main
echo "  ✓ Git pull OK"

# ── 2. Build Frontend ────────────────────────────────────
echo
echo "[2/4] Cài đặt dependencies và Build frontend..."
cd "$FRONTEND_DIR"
npm install --silent
npm run build
echo "  ✓ Build OK → $DIST_DIR"

# ── 3. Cập nhật Caddyfile ────────────────────────────────
echo
echo "[3/4] Cập nhật Caddyfile..."

# Kiểm tra xem Caddyfile đã có cấu hình frontend chưa
if grep -q "$FRONTEND_DOMAIN" "$CADDYFILE" 2>/dev/null; then
  echo "  ✓ Caddyfile đã có cấu hình '$FRONTEND_DOMAIN', bỏ qua."
else
  echo "  → Thêm block mới vào $CADDYFILE..."
  cat >> "$CADDYFILE" << EOF

# ── SocialFlow Frontend ──────────────────────────────────
$FRONTEND_DOMAIN {
    root * $DIST_DIR
    file_server
    # React Router: mọi path đều trỏ về index.html
    try_files {path} /index.html
    encode gzip
}
EOF
  echo "  ✓ Đã thêm block Caddy cho $FRONTEND_DOMAIN"
fi

# ── 4. Reload Caddy ──────────────────────────────────────
echo
echo "[4/4] Reload Caddy..."
if systemctl is-active --quiet caddy; then
  caddy fmt --overwrite "$CADDYFILE" 2>/dev/null || true
  systemctl reload caddy
  sleep 2
  if systemctl is-active --quiet caddy; then
    echo "  ✓ Caddy reload thành công"
  else
    echo "  [ERROR] Caddy không online sau reload!"
    systemctl status caddy --no-pager
    exit 1
  fi
else
  echo "  [WARN] Caddy chưa chạy, đang start..."
  systemctl start caddy
  echo "  ✓ Caddy đã được khởi động"
fi

# ── Kiểm tra cuối ────────────────────────────────────────
echo
echo "======================================================"
echo "  ✅ Deploy hoàn tất!"
echo "  🌐 Truy cập Frontend: https://$FRONTEND_DOMAIN"
echo "  📝 API vẫn chạy tại: https://${VPS_IP//./-}.sslip.io"
echo
echo "  Nếu lần đầu deploy, hãy đợi ~30 giây để Caddy"
echo "  tự động lấy chứng chỉ SSL từ Let's Encrypt."
echo "======================================================"
