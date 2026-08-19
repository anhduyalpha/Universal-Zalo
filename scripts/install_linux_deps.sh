#!/usr/bin/env bash
# ==============================================================================
# Script cài đặt toàn bộ dependencies cho Linux Server (Ubuntu / Debian / RHEL)
# ==============================================================================
set -euo pipefail

echo "======================================================================"
echo "🚀 Đang cài đặt Dependencies cho Universal Zalo trên Linux Server..."
echo "======================================================================"

# Kiểm tra quyền root
if [ "$EUID" -ne 0 ]; then
  echo "⚠️ Vui lòng chạy script với quyền sudo/root: sudo bash $0"
  exit 1
fi

# Phát hiện hệ điều hành
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  OS=$(uname -s)
fi

echo "📦 Hệ điều hành phát hiện: $OS"

case "$OS" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends \
      curl \
      wget \
      gnupg \
      ca-certificates \
      libnss3-tools \
      socat \
      xvfb \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      fonts-liberation \
      build-essential \
      pkg-config \
      libssl-dev

    # Cài đặt Chromium hoặc Google Chrome
    if ! command -v google-chrome &>/dev/null && ! command -v chromium &>/dev/null && ! command -v chromium-browser &>/dev/null; then
      echo "🌐 Đang cài đặt Google Chrome..."
      wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
      apt-get install -y /tmp/google-chrome.deb || apt-get install -f -y
      rm -f /tmp/google-chrome.deb
    fi
    ;;

  rhel|centos|fedora|rocky|almalinux)
    dnf update -y
    dnf install -y \
      curl \
      wget \
      nss-tools \
      socat \
      xorg-x11-server-Xvfb \
      nss \
      atk \
      cups-libs \
      libdrm \
      libxkbcommon \
      libXcomposite \
      libXdamage \
      libXfixes \
      libXrandr \
      mesa-libgbm \
      pango \
      cairo \
      alsa-lib \
      openssl-devel \
      gcc \
      gcc-c++ \
      make

    if ! command -v google-chrome &>/dev/null; then
      echo "🌐 Đang cài đặt Google Chrome..."
      wget -q -O /tmp/google-chrome.rpm https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
      dnf localinstall -y /tmp/google-chrome.rpm
      rm -f /tmp/google-chrome.rpm
    fi
    ;;

  *)
    echo "⚠️ Hệ điều hành $OS chưa có bộ cài tự động. Vui lòng cài đặt thủ công: libnss3-tools, chromium, xvfb, build-essential, openssl."
    ;;
esac

echo "✅ Cài đặt Linux Server Dependencies hoàn tất thành công!"
