# HƯỚNG DẪN TRIỂN KHAI UNIVERSAL ZALO TRÊN LINUX SERVER

Tài liệu này hướng dẫn 2 phương thức triển khai **Universal Zalo Multi-Device Gateway** trên môi trường Linux Server (Ubuntu, Debian, CentOS, RHEL, Alpine).

---

## CÁCH 1: TRIỂN KHAI BẰNG DOCKER COMPOSE (KHUYÊN DÙNG)

Phương thức này tự động hóa $100\%$ việc cấu hình môi trường, cài đặt chứng chỉ CA vào Chromium NSS DB, và cô lập tài nguyên.

### 1. Yêu cầu tiên quyết:
- Đã cài đặt **Docker** và **Docker Compose v2+**.

### 2. Khởi chạy toàn bộ hệ thống:
```bash
# Clone và chuyển vào thư mục dự án
cd universal-zalo

# Khởi chạy toàn bộ cụm dịch vụ (Redis, Postgres, Rust Proxy, Headless Chromium, Gateway Hub, Web Client)
docker compose -f docker-compose.linux.yml up -d --build
```

### 3. Kiểm tra trạng thái các container:
```bash
docker compose -f docker-compose.linux.yml ps
docker compose -f docker-compose.linux.yml logs -f zalo-proxy
```

### 4. Truy cập dịch vụ:
- **Web Client (PWA):** `http://<IP_SERVER>:3000`
- **Gateway WebSocket Hub:** `ws://<IP_SERVER>:8080`
- **Chromium Remote Debugging (nếu cần scan QR):** `http://<IP_SERVER>:9222`

---

## CÁCH 2: TRIỂN KHAI TRỰC TIẾP TRÊN BARE-METAL / VPS (SYSTEMD)

### 1. Cài đặt Dependencies hệ thống:
```bash
sudo bash scripts/install_linux_deps.sh
```

### 2. Build mã nguồn:
```bash
# 1. Build Rust Binaries
cargo build --release --workspace

# 2. Build Gateway Hub
cd services/gateway-hub
pnpm install
pnpm build
cd ../..
```

### 3. Cài đặt Chứng chỉ CA:
```bash
# Khởi chạy proxy một lần để sinh ca.crt
./target/release/zalo-proxy --port 9050 &
PROXY_PID=$!
sleep 2
kill $PROXY_PID

# Cài đặt CA vào Chromium NSS DB
bash scripts/setup_nssdb.sh
```

### 4. Kích hoạt Systemd Services:
```bash
sudo bash systemd/install_systemd.sh
```

### 5. Quản lý dịch vụ qua Systemctl:
```bash
# Xem logs real-time của Proxy Sniffer
journalctl -u zalo-proxy.service -f

# Xem logs của Gateway Hub
journalctl -u zalo-gateway.service -f

# Khởi động lại Chromium Runner
sudo systemctl restart zalo-headless.service
```
