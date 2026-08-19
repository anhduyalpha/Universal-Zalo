"use client";

import React from "react";
import { Conversation } from "../lib/dexie_db";
import { Menu, Phone, Video, Info, Wifi, WifiOff, Users, User } from "lucide-react";

interface ChatHeaderProps {
  conversation?: Conversation;
  wsStatus: "CONNECTED" | "DISCONNECTED" | "CONNECTING";
  onToggleSidebar?: () => void;
  onOpenInfo?: () => void;
  isMobile?: boolean;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  conversation,
  wsStatus,
  onToggleSidebar,
  onOpenInfo,
  isMobile = false,
}) => {
  const statusColors = {
    CONNECTED: "#10b981",
    CONNECTING: "#f59e0b",
    DISCONNECTED: "#ef4444",
  };

  const statusLabels = {
    CONNECTED: "Trực tuyến",
    CONNECTING: "Đang kết nối...",
    DISCONNECTED: "Ngoại tuyến",
  };

  return (
    <div
      style={{
        padding: "10px 16px",
        backgroundColor: "#ffffff",
        borderBottom: "1px solid #e5e7eb",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        {isMobile && onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            style={{
              border: "none",
              background: "none",
              padding: 6,
              color: "#334155",
              cursor: "pointer",
              display: "flex",
            }}
          >
            <Menu size={22} />
          </button>
        )}

        {conversation && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={conversation.avatar}
              alt={conversation.name}
              style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", backgroundColor: "#f1f5f9" }}
            />
            {conversation.isOnline && (
              <span
                style={{
                  position: "absolute",
                  bottom: 0,
                  right: 0,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: "#10b981",
                  border: "2px solid #fff",
                }}
              />
            )}
          </div>
        )}

        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {conversation?.name || "Chọn cuộc trò chuyện"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#64748b" }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: statusColors[wsStatus],
                display: "inline-block",
              }}
            />
            <span>{statusLabels[wsStatus]}</span>
            {conversation?.type === "GROUP" && <span>• Nhóm chat</span>}
          </div>
        </div>
      </div>

      {/* Right Action Icons */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => alert("Tính năng gọi thoại PWA đang kết nối WebRTC...")}
          style={{ background: "none", border: "none", padding: 8, borderRadius: "50%", color: "#64748b", cursor: "pointer" }}
          title="Gọi thoại"
        >
          <Phone size={18} />
        </button>
        <button
          onClick={() => alert("Tính năng gọi video PWA đang kết nối WebRTC...")}
          style={{ background: "none", border: "none", padding: 8, borderRadius: "50%", color: "#64748b", cursor: "pointer" }}
          title="Gọi video"
        >
          <Video size={18} />
        </button>
        {onOpenInfo && (
          <button
            onClick={onOpenInfo}
            style={{ background: "none", border: "none", padding: 8, borderRadius: "50%", color: "#64748b", cursor: "pointer" }}
            title="Thông tin hội thoại"
          >
            <Info size={18} />
          </button>
        )}
      </div>
    </div>
  );
};
