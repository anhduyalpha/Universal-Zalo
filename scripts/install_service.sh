#!/usr/bin/env bash
set -e

# ==============================================================================
# Universal Zalo - Systemd Service Installer & Manager for Linux Server
# ==============================================================================

SERVICE_NAME="universal-zalo"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🚀 Cài đặt dịch vụ Universal Zalo tự khởi động cùng hệ thống..."
echo "📂 Thư mục dự án: $PROJECT_DIR"

# Tạo file service systemd
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=Universal Zalo Multi-Device Gateway & Web Client
Requires=docker.service
After=docker.service network.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${PROJECT_DIR}
ExecStart=/usr/bin/docker compose -f docker-compose.linux.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.linux.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

# Reload và kích hoạt service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl start ${SERVICE_NAME}

echo ""
echo "✅ Đã cài đặt và kích hoạt dịch vụ ${SERVICE_NAME} thành công!"
echo "📌 Lệnh quản lý tiện ích:"
echo "   - Xem trạng thái: sudo systemctl status ${SERVICE_NAME}"
echo "   - Xem log trực tiếp: docker compose -f ${PROJECT_DIR}/docker-compose.linux.yml logs -f"
echo "   - Khởi động lại: sudo systemctl restart ${SERVICE_NAME}"
