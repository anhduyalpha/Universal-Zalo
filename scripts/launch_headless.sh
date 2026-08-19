#!/usr/bin/env bash
set -e

PROXY_SERVER="${1:-socks5://127.0.0.1:9050}"
USER_DATA_DIR="${2:-$HOME/.config/universal-zalo/chrome-profile}"
TARGET_URL="${3:-https://chat.zalo.me}"

CHROME_BIN=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
        CHROME_BIN="$candidate"
        break
    fi
done

if [ -z "$CHROME_BIN" ]; then
    echo "No Chromium binary found in PATH!"
    exit 1
fi

echo "Launching: $CHROME_BIN with proxy $PROXY_SERVER"

exec "$CHROME_BIN" \
    --proxy-server="$PROXY_SERVER" \
    --user-data-dir="$USER_DATA_DIR" \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling \
    --disable-ipc-flooding-protection \
    --autoplay-policy=no-user-gesture-required \
    --no-first-run \
    --no-default-browser-check \
    "$TARGET_URL"
