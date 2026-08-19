"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

export default function SessionManagerPage() {
  const [timestamp, setTimestamp] = useState(Date.now());
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshScreen = () => {
    setTimestamp(Date.now());
  };

  const handleTriggerSync = async () => {
    setLoading(true);
    setSyncStatus("Đang gửi lệnh kích hoạt đồng bộ tin nhắn tới Zalo Web...");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setSyncStatus(data.message || (data.success ? "Đã kích hoạt đồng bộ thành công!" : "Không tìm thấy nút đồng bộ."));
      setTimeout(refreshScreen, 1500);
    } catch (e: any) {
      setSyncStatus(`Lỗi: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", padding: "24px 20px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <h1 style={{ margin: "0 0 4px 0", fontSize: 22, color: "#0f172a" }}>🖥️ Trình quản lý Phiên Zalo Master (Session Hub)</h1>
            <p style={{ margin: 0, fontSize: 14, color: "#64748b" }}>
              Màn hình giám sát trực tiếp tiến trình Chromium đang chạy ngầm trên Server Linux.
            </p>
          </div>
          <Link
            href="/"
            style={{
              padding: "10px 20px",
              background: "#0068ff",
              color: "#fff",
              borderRadius: 10,
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 14,
              boxShadow: "0 2px 6px rgba(0,104,255,0.2)",
            }}
          >
            💬 Quay lại Giao diện Chat
          </Link>
        </div>

        {/* Action Controls Card */}
        <div style={{ background: "#fff", padding: "18px 24px", borderRadius: 14, marginBottom: 20, boxShadow: "0 2px 8px rgba(0,0,0,0.05)", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: "#10b981" }}></span>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#1e293b" }}>Trạng thái phiên: 🟢 Đang hoạt động (Active)</span>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={handleTriggerSync}
              disabled={loading}
              style={{
                padding: "10px 18px",
                background: "#0284c7",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.7 : 1,
              }}
            >
              ⚡ Nhấn để Đồng bộ tin nhắn gần đây
            </button>
            <button
              onClick={refreshScreen}
              style={{
                padding: "10px 18px",
                background: "#f8fafc",
                color: "#334155",
                border: "1px solid #cbd5e1",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              🔄 Làm mới màn hình
            </button>
          </div>
        </div>

        {syncStatus && (
          <div style={{ padding: "12px 18px", background: "#e0f2fe", border: "1px solid #bae6fd", color: "#0369a1", borderRadius: 10, marginBottom: 20, fontSize: 14 }}>
            💡 {syncStatus}
          </div>
        )}

        {/* Live Master Screen View */}
        <div style={{ background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", border: "1px solid #e2e8f0" }}>
          <div style={{ padding: "12px 18px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#64748b", display: "flex", justifyContent: "space-between" }}>
            <span>🌐 Live Headless Chromium View (`chat.zalo.me`)</span>
            <span>Cập nhật lúc: {new Date(timestamp).toLocaleTimeString()}</span>
          </div>
          <div style={{ minHeight: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "#1e293b", padding: 10 }}>
            <img
              src={`/api/qr?t=${timestamp}`}
              alt="Zalo Web Live View"
              style={{ width: "100%", maxHeight: "75vh", objectFit: "contain", borderRadius: 8 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
