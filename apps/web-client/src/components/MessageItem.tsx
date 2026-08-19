"use client";

import React from "react";
import { LocalMessage } from "../lib/dexie_db";
import { VoicePlayer } from "./VoicePlayer";
import { FileText, Download, Check, CheckCheck, Clock, AlertCircle, Reply } from "lucide-react";

interface MessageItemProps {
  message: LocalMessage;
  onOpenMedia: (type: "IMAGE" | "VIDEO", src: string, name?: string) => void;
  onReply?: (message: LocalMessage) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message, onOpenMedia, onReply }) => {
  const isMe = message.sender === "ME";

  const renderStatus = () => {
    if (!isMe) return null;
    if (message.status === "SENDING") return <Clock size={11} color="#94a3b8" />;
    if (message.status === "FAILED") return <AlertCircle size={11} color="#ef4444" />;
    return <CheckCheck size={12} color="#0068ff" />;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return "0 KB";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderContent = () => {
    switch (message.type) {
      case "IMAGE":
        return (
          <div style={{ maxWidth: 280, borderRadius: 12, overflow: "hidden", cursor: "pointer" }} onClick={() => message.mediaUrl && onOpenMedia("IMAGE", message.mediaUrl, message.mediaName)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.mediaUrl}
              alt={message.mediaName || "Image"}
              style={{ width: "100%", maxHeight: 300, objectFit: "cover", display: "block" }}
              loading="lazy"
            />
            {message.textContent && <div style={{ padding: "8px 10px", fontSize: 14 }}>{message.textContent}</div>}
          </div>
        );

      case "VIDEO":
        return (
          <div style={{ maxWidth: 300, borderRadius: 12, overflow: "hidden" }}>
            <video
              src={message.mediaUrl}
              controls
              style={{ width: "100%", maxHeight: 260, borderRadius: 12, display: "block" }}
            />
            {message.textContent && <div style={{ padding: "8px 10px", fontSize: 14 }}>{message.textContent}</div>}
          </div>
        );

      case "FILE":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 4px", minWidth: 200 }}>
            <div style={{ padding: 10, borderRadius: 10, backgroundColor: isMe ? "rgba(0,104,255,0.15)" : "#e2e8f0", color: "#0068ff" }}>
              <FileText size={24} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {message.mediaName || "Tài liệu đính kèm"}
              </div>
              <div style={{ fontSize: 11, color: "#64748b" }}>{formatFileSize(message.mediaSize)}</div>
            </div>
            {message.mediaUrl && (
              <a href={message.mediaUrl} download={message.mediaName || "file"} style={{ color: isMe ? "#0068ff" : "#475569", padding: 6 }}>
                <Download size={18} />
              </a>
            )}
          </div>
        );

      case "VOICE":
        return <VoicePlayer src={message.mediaUrl} duration={message.mediaDuration || 15} isMe={isMe} />;

      case "STICKER":
        return (
          <div style={{ padding: 4 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.stickerUrl}
              alt={message.textContent || "Sticker"}
              style={{ width: 130, height: 130, objectFit: "contain", display: "block" }}
              loading="lazy"
            />
          </div>
        );

      case "TEXT":
      default:
        return <div style={{ fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>{message.textContent}</div>;
    }
  };

  const isSticker = message.type === "STICKER";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isMe ? "flex-end" : "flex-start",
        marginBottom: 10,
        position: "relative",
      }}
    >
      {/* Reply Reference Preview */}
      {message.replyToText && (
        <div
          style={{
            fontSize: 11,
            color: "#64748b",
            background: "#f1f5f9",
            padding: "4px 8px",
            borderRadius: 6,
            borderLeft: "3px solid #0068ff",
            marginBottom: 2,
            maxWidth: "70%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <Reply size={10} style={{ display: "inline", marginRight: 4 }} />
          {message.replyToText}
        </div>
      )}

      {/* Main Bubble */}
      <div
        style={{
          maxWidth: isSticker ? "auto" : "75%",
          backgroundColor: isSticker ? "transparent" : isMe ? "#e0f2fe" : "#ffffff",
          color: "#1e293b",
          padding: isSticker ? 0 : message.type === "IMAGE" || message.type === "VIDEO" ? 4 : "10px 14px",
          borderRadius: 16,
          borderBottomRightRadius: isMe ? 2 : 16,
          borderBottomLeftRadius: isMe ? 16 : 2,
          boxShadow: isSticker ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
          border: isSticker ? "none" : "1px solid rgba(0,0,0,0.04)",
          position: "relative",
        }}
      >
        {renderContent()}

        {/* Footer Timestamp & Status */}
        {!isSticker && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 4,
              marginTop: 4,
              fontSize: 10,
              color: "#94a3b8",
            }}
          >
            <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            {renderStatus()}
          </div>
        )}
      </div>

      {/* Timestamp for Sticker */}
      {isSticker && (
        <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
};
