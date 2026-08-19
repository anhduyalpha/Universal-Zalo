"use client";

import React, { useState } from "react";
import { Conversation, db } from "../lib/dexie_db";
import { Search, Plus, Users, User, Pin, CheckCircle2, MessageSquare, Bell, Settings, X } from "lucide-react";
import { nanoid } from "nanoid";

interface ConversationSidebarProps {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onToggleSettings?: () => void;
  isMobile?: boolean;
  isOpen?: boolean;
  onCloseMobile?: () => void;
}

export const ConversationSidebar: React.FC<ConversationSidebarProps> = ({
  conversations,
  activeId,
  onSelect,
  onToggleSettings,
  isMobile = false,
  isOpen = true,
  onCloseMobile,
}) => {
  const [search, setSearch] = useState("");
  const [filterTab, setFilterTab] = useState<"ALL" | "UNREAD" | "GROUP">("ALL");
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [newChatName, setNewChatName] = useState("");
  const [newChatType, setNewChatType] = useState<"DIRECT" | "GROUP">("DIRECT");

  const filteredConversations = conversations.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase()) || c.lastMessage.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;
    if (filterTab === "UNREAD") return c.unreadCount > 0;
    if (filterTab === "GROUP") return c.type === "GROUP";
    return true;
  });

  const handleCreateChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChatName.trim()) return;

    const id = `conv_${nanoid(8)}`;
    const avatar = newChatType === "GROUP"
      ? `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(newChatName)}`
      : `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(newChatName)}`;

    await db.conversations.add({
      id,
      name: newChatName.trim(),
      avatar,
      type: newChatType,
      lastMessage: "Cuộc trò chuyện mới đã bắt đầu",
      lastTimestamp: Date.now(),
      unreadCount: 0,
      isPinned: false,
      isOnline: true,
    });

    setNewChatName("");
    setShowNewChatModal(false);
    onSelect(id);
    if (isMobile && onCloseMobile) onCloseMobile();
  };

  const formatTimestamp = (ts: number) => {
    if (!ts) return "";
    const date = new Date(ts);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
  };

  if (isMobile && !isOpen) return null;

  return (
    <div
      style={{
        width: isMobile ? "100%" : 320,
        height: "100%",
        backgroundColor: "#ffffff",
        borderRight: "1px solid #e5e7eb",
        display: "flex",
        flexDirection: "column",
        position: isMobile ? "absolute" : "relative",
        inset: isMobile ? 0 : "auto",
        zIndex: isMobile ? 40 : 1,
      }}
    >
      {/* Top Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #f1f5f9",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "#0068ff",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ position: "relative" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://api.dicebear.com/7.x/bottts/svg?seed=MyAvatar"
              alt="My Avatar"
              style={{ width: 36, height: 36, borderRadius: "50%", background: "#e0f2fe", border: "2px solid #fff" }}
            />
            <span
              style={{
                position: "absolute",
                bottom: 0,
                right: 0,
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#10b981",
                border: "2px solid #fff",
              }}
            />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Universal Zalo</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>PWA Gateway Client</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={() => setShowNewChatModal(true)}
            style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", padding: 6, borderRadius: "50%", cursor: "pointer", display: "flex" }}
            title="Thêm hội thoại mới"
          >
            <Plus size={18} />
          </button>
          {onToggleSettings && (
            <button
              onClick={onToggleSettings}
              style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", padding: 6, borderRadius: "50%", cursor: "pointer", display: "flex" }}
              title="Cài đặt"
            >
              <Settings size={18} />
            </button>
          )}
          {isMobile && onCloseMobile && (
            <button
              onClick={onCloseMobile}
              style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", padding: 6, borderRadius: "50%", cursor: "pointer", display: "flex" }}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Search Input */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9" }}>
        <div style={{ display: "flex", alignItems: "center", background: "#f1f5f9", borderRadius: 20, padding: "6px 12px" }}>
          <Search size={16} color="#94a3b8" />
          <input
            type="text"
            placeholder="Tìm kiếm tin nhắn, bạn bè..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ border: "none", background: "transparent", outline: "none", fontSize: 13, paddingLeft: 8, width: "100%" }}
          />
        </div>
      </div>

      {/* Tabs Filter */}
      <div style={{ display: "flex", borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
        {(["ALL", "UNREAD", "GROUP"] as const).map((tab) => {
          const labels = { ALL: "Tất cả", UNREAD: "Chưa đọc", GROUP: "Nhóm" };
          const isActive = filterTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setFilterTab(tab)}
              style={{
                flex: 1,
                padding: "8px 0",
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "#0068ff" : "#64748b",
                border: "none",
                borderBottom: isActive ? "2px solid #0068ff" : "2px solid transparent",
                background: "transparent",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {labels[tab]}
            </button>
          );
        })}
      </div>

      {/* Conversations List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {filteredConversations.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
            <MessageSquare size={32} style={{ margin: "0 auto 8px", opacity: 0.5 }} />
            Không tìm thấy cuộc trò chuyện nào
          </div>
        ) : (
          filteredConversations.map((conv) => {
            const isActive = activeId === conv.id;
            return (
              <div
                key={conv.id}
                onClick={() => {
                  onSelect(conv.id);
                  if (isMobile && onCloseMobile) onCloseMobile();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "12px 14px",
                  gap: 12,
                  cursor: "pointer",
                  backgroundColor: isActive ? "#e0f2fe" : "transparent",
                  borderBottom: "1px solid #f8fafc",
                  transition: "background-color 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = "#f8fafc";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {/* Avatar with Status */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={conv.avatar}
                    alt={conv.name}
                    style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", backgroundColor: "#e2e8f0" }}
                  />
                  {conv.isOnline && (
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

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                    <span
                      style={{
                        fontWeight: conv.unreadCount > 0 ? 700 : 600,
                        fontSize: 14,
                        color: "#1e293b",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {conv.type === "GROUP" ? <Users size={14} color="#64748b" /> : <User size={14} color="#64748b" />}
                      {conv.name}
                    </span>
                    <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>
                      {formatTimestamp(conv.lastTimestamp)}
                    </span>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: conv.unreadCount > 0 ? "#0f172a" : "#64748b",
                        fontWeight: conv.unreadCount > 0 ? 600 : 400,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {conv.lastMessage}
                    </span>

                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginLeft: 6 }}>
                      {conv.isPinned && <Pin size={12} color="#0068ff" />}
                      {conv.unreadCount > 0 && (
                        <span
                          style={{
                            backgroundColor: "#ef4444",
                            color: "#fff",
                            fontSize: 10,
                            fontWeight: "bold",
                            padding: "2px 6px",
                            borderRadius: 10,
                            minWidth: 16,
                            textAlign: "center",
                          }}
                        >
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* New Chat Modal */}
      {showNewChatModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setShowNewChatModal(false)}
        >
          <div
            style={{
              backgroundColor: "#fff",
              borderRadius: 16,
              padding: 20,
              width: "100%",
              maxWidth: 360,
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "#1e293b" }}>Tạo cuộc trò chuyện mới</h3>

            <form onSubmit={handleCreateChat} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 4, display: "block" }}>
                  Tên người nhận hoặc Tên nhóm
                </label>
                <input
                  type="text"
                  placeholder="Nhập tên..."
                  value={newChatName}
                  onChange={(e) => setNewChatName(e.target.value)}
                  required
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", outline: "none", fontSize: 14, boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#64748b", marginBottom: 4, display: "block" }}>
                  Loại trò chuyện
                </label>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setNewChatType("DIRECT")}
                    style={{
                      flex: 1,
                      padding: 10,
                      borderRadius: 8,
                      border: newChatType === "DIRECT" ? "2px solid #0068ff" : "1px solid #cbd5e1",
                      backgroundColor: newChatType === "DIRECT" ? "#eff6ff" : "#fff",
                      color: newChatType === "DIRECT" ? "#0068ff" : "#64748b",
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    <User size={16} /> Cá nhân
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewChatType("GROUP")}
                    style={{
                      flex: 1,
                      padding: 10,
                      borderRadius: 8,
                      border: newChatType === "GROUP" ? "2px solid #0068ff" : "1px solid #cbd5e1",
                      backgroundColor: newChatType === "GROUP" ? "#eff6ff" : "#fff",
                      color: newChatType === "GROUP" ? "#0068ff" : "#64748b",
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    <Users size={16} /> Nhóm
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowNewChatModal(false)}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#f8fafc", color: "#64748b", cursor: "pointer", fontSize: 13 }}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#0068ff", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 13 }}
                >
                  Tạo ngay
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
