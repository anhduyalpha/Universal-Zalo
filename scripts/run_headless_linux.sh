#!/usr/bin/env bash
# ==============================================================================
# Script khởi chạy Headless Chromium trên Linux Server với đầy đủ cờ tối ưu
# ==============================================================================
set -euo pipefail

PROXY_SERVER="${1:-socks5://127.0.0.1:9050}"
USER_DATA_DIR="${2:-$HOME/.config/universal-zalo/chrome-profile}"
TARGET_URL="${3:-https://chat.zalo.me}"

# 1. Tự động tìm kiếm Binary của Browser
CHROME_BIN=""
for candidate in google-chrome-stable google-chrome chromium chromium-browser /usr/bin/google-chrome /usr/bin/chromium; do
  if command -v "$candidate" &>/dev/null; then
    CHROME_BIN="$candidate"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "❌ Không tìm thấy Chrome/Chromium! Hãy chạy 'sudo bash scripts/install_linux_deps.sh' trước."
  exit 1
fi

echo "🚀 Khởi chạy Headless Browser: $CHROME_BIN"
echo "🔌 SOCKS5 Proxy: $PROXY_SERVER"
echo "📁 Data Directory: $USER_DATA_DIR"

mkdir -p "$USER_DATA_DIR"

# 2. Thiết lập cờ chạy Server Headless tối ưu
CHROME_FLAGS=(
  --proxy-server="$PROXY_SERVER"
  --user-data-dir="$USER_DATA_DIR"
  --headless=new
  --no-sandbox
  --disable-setuid-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --disable-software-rasterizer
  --disable-background-timer-throttling
  --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding
  --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling
  --disable-ipc-flooding-protection
  --autoplay-policy=no-user-gesture-required
  --no-first-run
  --no-default-browser-check
  --remote-debugging-port=9222
  --remote-debugging-address=127.0.0.1
  --window-size=1280,800
)

# 3. Chạy với Xvfb nếu có hoặc chạy trực tiếp headless
if command -v xvfb-run &>/dev/null; then
  echo "🖥️ Khởi chạy thông qua Xvfb Virtual Display..."
  exec xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" "$CHROME_BIN" "${CHROME_FLAGS[@]}" "$TARGET_URL"
else
  exec "$CHROME_BIN" "${CHROME_FLAGS[@]}" "$TARGET_URL"
fi
