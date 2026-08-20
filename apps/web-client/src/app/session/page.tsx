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

  // Khởi tạo Real-time WebSocket Screencast Stream qua Multiplexed Connection
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
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "STOP_STREAM" }));
          }
          ws.close();
        } catch {}
      };
    }
  }, []);

  // CHUẨN HÓA MA TRẬN TỌA ĐỘ CLICK CHUỘT / CẢM ỨNG (Exact Mathematical Coordinate Projection)
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const nativeWidth = 1440;
    const nativeHeight = 900;

    // Chuẩn hóa tọa độ tuyệt đối không bị ảnh hưởng bởi CSS scaling hay border
    const scaleX = nativeWidth / rect.width;
    const scaleY = nativeHeight / rect.height;

    const rawX = (e.clientX - rect.left) * scaleX;
    const rawY = (e.clientY - rect.top) * scaleY;

    const clickX = Math.round(Math.max(0, Math.min(nativeWidth, rawX)));
    const clickY = Math.round(Math.max(0, Math.min(nativeHeight, rawY)));

    setLastClickPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setSyncStatus(`⚡ Điểm nhấn chuẩn: (${clickX}, ${clickY}) [Tỉ lệ ${scaleX.toFixed(2)}x]`);

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
    const nativeWidth = 1440;
    const nativeHeight = 900;

    const scaleX = nativeWidth / rect.width;
    const scaleY = nativeHeight / rect.height;

    const wheelX = Math.round(Math.max(0, Math.min(nativeWidth, (e.clientX - rect.left) * scaleX)));
    const wheelY = Math.round(Math.max(0, Math.min(nativeHeight, (e.clientY - rect.top) * scaleY)));

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

  return (
    <div
      style={{
        height: "100dvh",
        background: "#0f172a",
        padding: "12px 20px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#f8fafc",
        overflowY: "auto",
        overscrollBehaviorY: "none",
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1440, margin: "0 auto", paddingBottom: 24 }}>
        {/* Header Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#fff" }}>🖥️ Live Master Session (1440x900 Exact Pointer Mapping)</h1>
            <span
              style={{
                fontSize: 12,
                padding: "3px 10px",
                borderRadius: 12,
                background: streamConnected ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                color: streamConnected ? "#34d399" : "#f87171",
                border: `1px solid ${streamConnected ? "#059669" : "#dc2626"}`,
              }}
            >
              {streamConnected ? `🟢 LIVE STREAM (${fps} FPS)` : "🔴 DISCONNECTED"}
            </span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <Link
              href="/"
              style={{
                padding: "8px 18px",
                background: "#0068ff",
                color: "#fff",
                borderRadius: 8,
                textDecoration: "none",
                fontWeight: 600,
                fontSize: 13,
                boxShadow: "0 2px 6px rgba(0,104,255,0.3)",
              }}
            >
              💬 Trở về Chat PWA
            </Link>
          </div>
        </div>

        {/* Input Bar */}
        <form
          onSubmit={handleTypeText}
          style={{
            background: "#1e293b",
            padding: "8px 14px",
            borderRadius: 10,
            marginBottom: 10,
            display: "flex",
            gap: 10,
            border: "1px solid #334155",
          }}
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="⌨️ Nhập văn bản để gõ trực tiếp vào Chromium rồi nhấn Enter..."
            style={{
              flex: 1,
              padding: "9px 14px",
              borderRadius: 6,
              border: "1px solid #475569",
              background: "#0f172a",
              color: "#fff",
              outline: "none",
              fontSize: 13,
            }}
          />
          <button
            type="submit"
            style={{
              padding: "0 20px",
              background: "#0068ff",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Gõ & Gửi
          </button>
        </form>

        {syncStatus && (
          <div
            style={{
              padding: "6px 12px",
              background: "rgba(2, 132, 199, 0.2)",
              border: "1px solid #0284c7",
              color: "#38bdf8",
              borderRadius: 6,
              marginBottom: 10,
              fontSize: 12,
            }}
          >
            {syncStatus}
          </div>
        )}

        {/* Canvas Display with Exact Coordinate Normalization */}
        <div
          style={{
            background: "#000000",
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid #334155",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            position: "relative",
          }}
        >
          <div
            style={{
              padding: "6px 12px",
              background: "#1e293b",
              fontSize: 12,
              color: "#94a3b8",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>🖱️ <b>Tương tác điểm chuẩn:</b> Chạm hoặc click chuột để điều khiển Zalo Master.</span>
            <span>1440 x 900 Canvas Native</span>
          </div>

          <div
            style={{
              position: "relative",
              width: "100%",
              height: "auto",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              background: "#000",
              touchAction: "none",
            }}
          >
            <canvas
              ref={canvasRef}
              width={1440}
              height={900}
              onPointerDown={handlePointerDown}
              onWheel={handleCanvasWheel}
              style={{
                width: "100%",
                height: "auto",
                aspectRatio: "1440 / 900",
                display: "block",
                cursor: "crosshair",
                userSelect: "none",
              }}
            />

            {/* Click Indicator Marker */}
            {lastClickPos && (
              <div
                style={{
                  position: "absolute",
                  left: lastClickPos.x,
                  top: lastClickPos.y,
                  width: 18,
                  height: 18,
                  marginLeft: -9,
                  marginTop: -9,
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
