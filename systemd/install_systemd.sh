#!/usr/bin/env bash
# ==============================================================================
# Script cài đặt và kích hoạt Systemd Services trên Linux Server
# ==============================================================================
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "⚠️ Vui lòng chạy script với quyền sudo/root: sudo bash $0"
  exit 1
fi

SYSTEMD_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📦 Đang copy systemd service units vào $SYSTEMD_DIR..."

cp "$SCRIPT_DIR/zalo-proxy.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/zalo-gateway.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/zalo-headless.service" "$SYSTEMD_DIR/"

systemctl daemon-reload

echo "🚀 Kích hoạt và khởi chạy các dịch vụ..."
systemctl enable --now zalo-proxy.service
systemctl enable --now zalo-gateway.service
systemctl enable --now zalo-headless.service

echo "✅ Toàn bộ dịch vụ Universal Zalo đã được cài đặt và đang chạy dưới nền systemd!"
systemctl status zalo-proxy.service --no-pager
