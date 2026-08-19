"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";

export default function SessionManagerPage() {
  const [timestamp, setTimestamp] = useState(Date.now());
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [interactiveMode, setInteractiveMode] = useState(true);
  const [inputText, setInputText] = useState("");
  const [lastClickPos, setLastClickPos] = useState<{ x: number; y: number } | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);

  const refreshScreen = () => {
    setTimestamp(Date.now());
  };

  // Tự động làm mới màn hình mỗi 3 giây khi đang xem
  useEffect(() => {
    const timer = setInterval(() => {
      setTimestamp(Date.now());
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Xử lý Click Chuột trực tiếp vào màn hình Zalo
  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;

    const rect = imgRef.current.getBoundingClientRect();
    // Tỉ lệ scale thực tế so với viewport Chromium chuẩn (1280 x 800)
    const scaleX = 1280 / rect.width;
    const scaleY = 800 / rect.height;

    const clickX = Math.round((e.clientX - rect.left) * scaleX);
    const clickY = Math.round((e.clientY - rect.top) * scaleY);

    setLastClickPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setSyncStatus(`Đã click chuột vào tọa độ (${clickX}, ${clickY}) trên Zalo Web...`);

    try {
      await fetch("/api/action/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: clickX, y: clickY }),
      });
      // Làm mới màn hình ngay sau khi click
      setTimeout(refreshScreen, 350);
      setTimeout(refreshScreen, 1000);
    } catch (err: any) {
      setSyncStatus(`Lỗi click: ${err.message}`);
    }
  };

  // Xử lý gõ văn bản và bấm Enter vào Chromium
  const handleTypeText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    setSyncStatus(`Đang nhập văn bản: "${inputText}"...`);
    try {
      await fetch("/api/action/type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText, pressEnter: true }),
      });
      setInputText("");
      setTimeout(refreshScreen, 400);
      setTimeout(refreshScreen, 1200);
    } catch (err: any) {
      setSyncStatus(`Lỗi gõ phím: ${err.message}`);
    }
  };

  const handleTriggerSync = async () => {
    setLoading(true);
    setSyncStatus("Đang kích hoạt nút đồng bộ tin nhắn trên Zalo Web...");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setSyncStatus(data.message || "Đã gửi lệnh đồng bộ.");
      setTimeout(refreshScreen, 800);
    } catch (e: any) {
      setSyncStatus(`Lỗi: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", padding: "20px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: "0 0 4px 0", fontSize: 22, color: "#0f172a" }}>🖥️ Màn hình Tương tác Trực tiếp Zalo Master (Remote Control)</h1>
            <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
              Bạn có thể <b>click chuột trực tiếp vào bất kỳ vị trí nào trên màn hình bên dưới</b> để mở tin nhắn hoặc bấm <i>"Nhấn để đồng bộ ngay"</i>.
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
        <div style={{ background: "#fff", padding: "14px 20px", borderRadius: 14, marginBottom: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.05)", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: "#10b981" }}></span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>Phiên Master: 🟢 Đang hoạt động</span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleTriggerSync}
              disabled={loading}
              style={{
                padding: "8px 16px",
                background: "#0284c7",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              ⚡ Tự động Click "Đồng bộ ngay"
            </button>
            <button
              onClick={refreshScreen}
              style={{
                padding: "8px 16px",
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

        {/* Input Bar để gõ phím trực tiếp vào Zalo Web */}
        <form onSubmit={handleTypeText} style={{ background: "#fff", padding: "12px 18px", borderRadius: 12, marginBottom: 16, display: "flex", gap: 10, boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="⌨️ Gõ tin nhắn hoặc nội dung muốn gửi trực tiếp vào Zalo Web rồi nhấn Enter..."
            style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid #cbd5e1", outline: "none", fontSize: 13 }}
          />
          <button
            type="submit"
            style={{ padding: "0 20px", background: "#0068ff", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}
          >
            Gõ & Gửi (Enter)
          </button>
        </form>

        {syncStatus && (
          <div style={{ padding: "10px 16px", background: "#e0f2fe", border: "1px solid #bae6fd", color: "#0369a1", borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
            💡 {syncStatus}
          </div>
        )}

        {/* Interactive Remote Screen View */}
        <div style={{ background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", border: "1px solid #e2e8f0" }}>
          <div style={{ padding: "10px 16px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 12, color: "#64748b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>🖱️ <b>Chế độ Tương tác Trực tiếp:</b> Hãy click chuột vào bất kỳ nút nào trên màn hình bên dưới.</span>
            <span>Live Sync</span>
          </div>

          <div style={{ minHeight: 520, display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a", padding: 10, position: "relative", userSelect: "none" }}>
            <img
              ref={imgRef}
              src={`/api/qr?t=${timestamp}`}
              alt="Zalo Web Live View"
              onClick={handleImageClick}
              style={{
                width: "100%",
                maxHeight: "75vh",
                objectFit: "contain",
                borderRadius: 8,
                cursor: "crosshair",
                display: "block",
              }}
            />

            {/* Click Ripple Indicator */}
            {lastClickPos && (
              <div
                style={{
                  position: "absolute",
                  left: lastClickPos.x + 10,
                  top: lastClickPos.y + 10,
                  width: 24,
                  height: 24,
                  marginLeft: -12,
                  marginTop: -12,
                  borderRadius: "50%",
                  border: "2px solid #0068ff",
                  background: "rgba(0, 104, 255, 0.4)",
                  pointerEvents: "none",
                  animation: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite",
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
