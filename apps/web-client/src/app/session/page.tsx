"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";

export default function SessionManagerPage() {
  const [streamConnected, setStreamConnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [lastClickPos, setLastClickPos] = useState<{ x: number; y: number } | null>(null);
  const [fps, setFps] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameCountRef = useRef(0);

  // Khởi tạo Real-time WebSocket Screencast Stream (Zero Delay 30 FPS)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const hostname = window.location.hostname || "127.0.0.1";
      const ws = new WebSocket(`ws://${hostname}:8080`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStreamConnected(true);
        ws.send(JSON.stringify({ type: "START_STREAM" }));
      };

      ws.onclose = () => {
        setStreamConnected(false);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === "SCREENCAST_FRAME" && msg.data) {
            frameCountRef.current += 1;
            const img = new Image();
            img.onload = () => {
              const canvas = canvasRef.current;
              if (canvas) {
                const ctx = canvas.getContext("2d");
                if (ctx) {
                  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                }
              }
            };
            img.src = `data:image/jpeg;base64,${msg.data}`;
          }
        } catch (e) {}
      };

      const fpsTimer = setInterval(() => {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
      }, 1000);

      return () => {
        clearInterval(fpsTimer);
        ws.close();
      };
    }
  }, []);

  // Xử lý Click Chuột Zero-Delay
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = 1440 / rect.width;
    const scaleY = 900 / rect.height;

    const clickX = Math.round((e.clientX - rect.left) * scaleX);
    const clickY = Math.round((e.clientY - rect.top) * scaleY);

    setLastClickPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setSyncStatus(`⚡ Đã click vào (${clickX}, ${clickY})`);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "CLICK",
          x: clickX,
          y: clickY,
        })
      );
    }
  };

  // Xử lý Cuộn Chuột (Mouse Wheel) trực tiếp vào Zalo Web
  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = 1440 / rect.width;
    const scaleY = 900 / rect.height;

    const wheelX = Math.round((e.clientX - rect.left) * scaleX);
    const wheelY = Math.round((e.clientY - rect.top) * scaleY);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "WHEEL",
          x: wheelX,
          y: wheelY,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
        })
      );
    }
  };

  // Xử lý gõ văn bản Zero-Delay
  const handleTypeText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    setSyncStatus(`⌨️ Đã gõ: "${inputText}"`);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "TYPE",
          text: inputText,
        })
      );
    }
    setInputText("");
  };

  const handleTriggerSync = async () => {
    setSyncStatus("Đang gửi lệnh Thử lại đồng bộ tới Zalo Web...");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setSyncStatus(data.message || "Đã gửi lệnh đồng bộ.");
    } catch (e: any) {
      setSyncStatus(`Lỗi: ${e.message}`);
    }
  };

  const handleDismissModal = async () => {
    setSyncStatus("Đang bấm Hủy để bỏ qua popup đồng bộ...");
    try {
      const res = await fetch("/api/dismiss-modal", { method: "POST" });
      const data = await res.json();
      setSyncStatus(data.message || "Đã bấm Hủy.");
    } catch (e: any) {
      setSyncStatus(`Lỗi: ${e.message}`);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", padding: "16px 24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#f8fafc", overflowY: "auto" }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", paddingBottom: 40 }}>
        {/* Header Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#fff" }}>🖥️ Live Master Stream (1440x900 Cuộn & Click Mượt)</h1>
            <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 12, background: streamConnected ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)", color: streamConnected ? "#34d399" : "#f87171", border: `1px solid ${streamConnected ? "#059669" : "#dc2626"}` }}>
              {streamConnected ? `🟢 LIVE STREAM (${fps} FPS)` : "🔴 DISCONNECTED"}
            </span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleTriggerSync}
              style={{ padding: "8px 16px", background: "#0284c7", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}
            >
              🔄 Thử lại đồng bộ
            </button>
            <button
              onClick={handleDismissModal}
              style={{ padding: "8px 16px", background: "#475569", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}
            >
              ❌ Bỏ qua / Click Hủy
            </button>
            <Link
              href="/"
              style={{ padding: "8px 18px", background: "#0068ff", color: "#fff", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: 13 }}
            >
              💬 Mở Chat App
            </Link>
          </div>
        </div>

        {/* Sync Instruction Guide */}
        <div style={{ background: "rgba(30, 41, 59, 0.8)", border: "1px solid #334155", padding: "12px 18px", borderRadius: 10, marginBottom: 12, fontSize: 13, color: "#cbd5e1" }}>
          💡 <b>Gợi ý:</b> Nếu bạn muốn vào thẳng giao diện chat mà không cần đồng bộ lại tin nhắn cũ từ điện thoại, bạn có thể click vào chữ <b>"Hủy"</b> trên màn hình hoặc bấm nút <b>"❌ Bỏ qua / Click Hủy"</b> ở trên. Tin nhắn mới phát sinh từ giờ trở đi vẫn nhận và gửi realtime bình thường!
        </div>

        {/* Input Bar */}
        <form onSubmit={handleTypeText} style={{ background: "#1e293b", padding: "10px 16px", borderRadius: 10, marginBottom: 12, display: "flex", gap: 10, border: "1px solid #334155" }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="⌨️ Nhập nội dung để gõ phím trực tiếp vào Zalo Web rồi nhấn Enter..."
            style={{ flex: 1, padding: "10px 14px", borderRadius: 6, border: "1px solid #475569", background: "#0f172a", color: "#fff", outline: "none", fontSize: 13 }}
          />
          <button
            type="submit"
            style={{ padding: "0 22px", background: "#0068ff", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer" }}
          >
            Gõ & Gửi (Enter)
          </button>
        </form>

        {syncStatus && (
          <div style={{ padding: "8px 14px", background: "rgba(2, 132, 199, 0.2)", border: "1px solid #0284c7", color: "#38bdf8", borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
            {syncStatus}
          </div>
        )}

        {/* Real-time Canvas Display (Desktop Standard 1440x900 với Cuộn Chuột Wheel) */}
        <div style={{ background: "#000000", borderRadius: 12, overflow: "hidden", border: "1px solid #334155", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", position: "relative" }}>
          <div style={{ padding: "8px 14px", background: "#1e293b", fontSize: 12, color: "#94a3b8", display: "flex", justifyContent: "space-between" }}>
            <span>🖱️ <b>Tương tác Đầy đủ:</b> Click chuột vào nút <b>Thử lại</b> hoặc <b>Hủy</b> trên màn hình.</span>
            <span>Tỉ lệ chuẩn 1440 x 900</span>
          </div>

          <div style={{ position: "relative", width: "100%", height: "auto", display: "flex", justifyContent: "center", alignItems: "center", background: "#000" }}>
            <canvas
              ref={canvasRef}
              width={1440}
              height={900}
              onClick={handleCanvasClick}
              onWheel={handleCanvasWheel}
              style={{
                width: "100%",
                height: "auto",
                aspectRatio: "1440 / 900",
                display: "block",
                cursor: "crosshair",
              }}
            />

            {/* Click Indicator */}
            {lastClickPos && (
              <div
                style={{
                  position: "absolute",
                  left: lastClickPos.x,
                  top: lastClickPos.y,
                  width: 20,
                  height: 20,
                  marginLeft: -10,
                  marginTop: -10,
                  borderRadius: "50%",
                  border: "2px solid #38bdf8",
                  background: "rgba(56, 189, 248, 0.5)",
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
