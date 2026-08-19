# TASK PROGRESS TRACKER - UNIVERSAL ZALO GATEWAY

## [Milestone 1: Core Transport & SOCKS5 Binary Sniffer]
- [x] Khởi tạo Monorepo Cargo.toml và cấu trúc thư mục
- [x] Task 1.1: Tạo Local Root CA & Script Tích hợp vào Chromium NSS DB / Windows Cert Store (`crates/zalo-proxy/src/cert.rs`)
- [x] Task 1.2: Triển khai Rust SOCKS5 Handshake Server & TCP Relay (`crates/zalo-proxy/src/socks5.rs`)
- [x] Task 1.3: Sniff và Tách luồng WebSocket Frames Nhị phân (`crates/zalo-proxy/src/ws_arbiter.rs`)
- [x] Task 1.4: MPSC Lock-Free Frame Arbiter & IPC Pipe (`crates/zalo-proxy/src/ipc_bridge.rs`)
- [x] Task 1.5: Scripts khởi chạy Headless Chromium với Anti-Throttling Profile (`scripts/launch_headless.ps1`, `scripts/setup_cert.ps1`)

## [Milestone 2: Protocol Virtualization & Sequence Rewriter]
- [x] Task 2.1: Reverse Engineering & Xây dựng Protobuf Schema chuẩn Zalo Web (`crates/zalo-proto/proto/zalo_packet.proto`)
- [x] Task 2.2: Stateful Sequence Virtualizer (Δ-offset Engine) (`crates/zalo-proto/src/sequence_nat.rs`)
- [x] Task 2.3: ACK Router & Synthetic Server Push Virtualization (`crates/zalo-proto/src/ack_router.rs`)
- [x] Task 2.4: Canary Shadow Worker & Circuit-Breaker (`crates/zalo-proto/src/canary.rs`)

## [Milestone 3: E2EE Double Ratchet & Storage]
- [x] Task 3.1: Immutable Identity Vault (Curve25519) & `mlock()` Protection (`crates/zalo-crypto/src/identity_vault.rs`)
- [x] Task 3.2: X3DH Engine với 3-Way DH Fallback khi OTPK cạn kiệt (`crates/zalo-crypto/src/x3dh.rs`)
- [x] Task 3.3: Double Ratchet State Machine & Skipped Keys Buffer (`crates/zalo-crypto/src/ratchet.rs`)
- [x] Task 3.4: SQLite WAL Storage Engine cho Ratchet State (`crates/zalo-storage/src/sqlite_wal.rs`)
- [x] Task 3.5: Virtual Range Multi-Raft Partitioning (`crates/zalo-storage/src/multi_raft.rs`)

## [Milestone 4: Multi-Client Hub & PWA Client]
- [x] Task 4.1: Socket Handoff to Rust epoll Multiplexer Daemon (`crates/zalo-daemon/src/epoll_hub.rs`)
- [x] Task 4.2: Gateway Hub WebSocket Orchestrator (`services/gateway-hub/src/index.ts`)
- [x] Task 4.3: Multi-Tier Token Bucket Limiter & Thread Sharded Queue (`services/gateway-hub/src/token_bucket.ts`)
- [x] Task 4.4: Hybrid Logical Clock (HLC) Timeline Ordering (`services/gateway-hub/src/hlc.ts`)
- [x] Task 4.5: Next.js PWA Client với Dexie.js Offline Cache (`apps/web-client/src/app/page.tsx`, `dexie_db.ts`)
- [x] Task 4.6: Conversation Sidebar & Multi-Room State Management (`apps/web-client/src/components/ConversationSidebar.tsx`)
- [x] Task 4.7: Media, File, Voice Waveform & Zalo Animated Sticker Engine (`apps/web-client/src/components/MediaViewer.tsx`, `VoicePlayer.tsx`, `StickerPicker.tsx`)
- [x] Task 4.8: PWA Service Worker & Web Push Notifications System (`apps/web-client/public/sw.js`, `apps/web-client/src/lib/push_manager.ts`, `/api/push/subscribe`, `/api/push/send`)
- [x] Task 4.9: Audio Feedback Synthesizer & Mobile-First Native PWA Experience (`apps/web-client/src/lib/sound_effects.ts`, `apps/web-client/src/components/SettingsModal.tsx`, `manifest.json`)

