"use client";

import React, { useState, useEffect } from "react";
import { X, Volume2, VolumeX, Bell, BellOff, Trash2, Shield, Radio, Check } from "lucide-react";
import { soundFX } from "../lib/sound_effects";
import { subscribeToWebPush, showLocalNotification } from "../lib/push_manager";
import { db } from "../lib/dexie_db";

interface SettingsModalProps {
  onClose: () => void;
  wsStatus: "CONNECTED" | "DISCONNECTED" | "CONNECTING";
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, wsStatus }) => {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [clearedNotice, setClearedNotice] = useState(false);

  useEffect(() => {
    setSoundEnabled(soundFX.enabled);
    if (typeof window !== "undefined" && "Notification" in window) {
      setPushEnabled(Notification.permission === "granted");
    }
  }, []);

  const handleToggleSound = () => {
    soundFX.enabled = !soundEnabled;
    setSoundEnabled(!soundEnabled);
    if (!soundEnabled) {
      soundFX.playReceive();
    }
  };

  const handleTogglePush = async () => {
    const success = await subscribeToWebPush();
    setPushEnabled(success);
    if (success) {
      showLocalNotification("Universal Zalo", "Thông báo đẩy PWA đã kích hoạt thành công!");
    }
  };

  const handleClearCache = async () => {
    if (confirm("Bạn có chắc chắn muốn xóa toàn bộ tin nhắn đã lưu trên thiết bị này?")) {
      await db.messages.clear();
      setClearedNotice(true);
      setTimeout(() => setClearedNotice(false), 3000);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 16,
          padding: 24,
          width: "100%",
          maxWidth: 420,
          boxShadow: "0 20px 25px -5px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 18, color: "#1e293b", display: "flex", alignItems: "center", gap: 8 }}>
            <Shield size={20} color="#0068ff" /> Cài đặt Universal Zalo
          </h3>
          <button onClick={onClose} style={{ border: "none", background: "none", color: "#64748b", cursor: "pointer" }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Gateway Status Box */}
          <div style={{ padding: "12px 14px", borderRadius: 12, backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>Gateway Hub Status</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>Kết nối WebSocket thời gian thực</div>
            </div>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 12,
                backgroundColor: wsStatus === "CONNECTED" ? "#d1fae5" : "#fee2e2",
                color: wsStatus === "CONNECTED" ? "#065f46" : "#991b1b",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Radio size={12} /> {wsStatus}
            </span>
          </div>

          {/* Sound Effects Toggle */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {soundEnabled ? <Volume2 size={20} color="#0068ff" /> : <VolumeX size={20} color="#94a3b8" />}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>Âm thanh tin nhắn</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>Phát chuông nhẹ khi gửi/nhận tin</div>
              </div>
            </div>
            <button
              onClick={handleToggleSound}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: "none",
                backgroundColor: soundEnabled ? "#0068ff" : "#e2e8f0",
                color: soundEnabled ? "#fff" : "#64748b",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {soundEnabled ? "Bật" : "Tắt"}
            </button>
          </div>

          {/* Web Push Notifications Toggle */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {pushEnabled ? <Bell size={20} color="#0068ff" /> : <BellOff size={20} color="#94a3b8" />}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>Thông báo Web Push</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>Nhận tin nhắn khi tắt màn hình</div>
              </div>
            </div>
            <button
              onClick={handleTogglePush}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: "none",
                backgroundColor: pushEnabled ? "#10b981" : "#e2e8f0",
                color: pushEnabled ? "#fff" : "#64748b",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {pushEnabled ? "Đã bật" : "Bật"}
            </button>
          </div>

          {/* Clear Cache */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px solid #f1f5f9" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Trash2 size={20} color="#ef4444" />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#ef4444" }}>Dọn dẹp bộ nhớ đệm</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>Xóa tin nhắn lưu tạm trên máy này</div>
              </div>
            </div>
            <button
              onClick={handleClearCache}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                border: "1px solid #fca5a5",
                backgroundColor: "#fff",
                color: "#ef4444",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {clearedNotice ? "Đã xóa ✓" : "Xóa"}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 24, textAlign: "right" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 20px",
              backgroundColor: "#0068ff",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Hoàn tất
          </button>
        </div>
      </div>
    </div>
  );
};
