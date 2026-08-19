#!/usr/bin/env bash
set -euo pipefail

CERT_PATH="/app/certs/ca.crt"
PROXY_SERVER="${PROXY_SERVER:-socks5://zalo-proxy:9050}"
TARGET_URL="${TARGET_URL:-https://chat.zalo.me}"

echo "🔄 Đợi Proxy Server khởi tạo chứng chỉ CA..."
while [ ! -f "$CERT_PATH" ]; do
  sleep 1
done

echo "🔐 Cài đặt Root CA vào Chromium NSS DB..."
mkdir -p "$HOME/.pki/nssdb"
certutil -d sql:$HOME/.pki/nssdb -N --empty-password || true
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Universal Zalo Root CA" -i "$CERT_PATH"

echo "🌐 Khởi chạy Chromium Headless kết nối qua $PROXY_SERVER..."
exec chromium \
  --proxy-server="$PROXY_SERVER" \
  --user-data-dir="/app/profile" \
  --headless=new \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling \
  --disable-ipc-flooding-protection \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --remote-allow-origins=* \
  --ignore-certificate-errors \
  --allow-running-insecure-content \
  "$TARGET_URL"
