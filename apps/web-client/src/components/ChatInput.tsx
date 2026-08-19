"use client";

import React, { useState, useRef } from "react";
import { Smile, Image, Paperclip, Mic, Send, X, Square } from "lucide-react";
import { StickerPicker } from "./StickerPicker";
import { StickerItem } from "../lib/stickers_data";
import { MessageType } from "../lib/dexie_db";

interface ChatInputProps {
  onSendMessage: (payload: {
    type: MessageType;
    textContent?: string;
    mediaUrl?: string;
    mediaName?: string;
    mediaSize?: number;
    mediaDuration?: number;
    stickerUrl?: string;
  }) => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSendMessage, disabled = false }) => {
  const [text, setText] = useState("");
  const [showStickers, setShowStickers] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [pendingMedia, setPendingMedia] = useState<{
    file: File;
    previewUrl: string;
    type: MessageType;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const handleSend = () => {
    if (pendingMedia) {
      onSendMessage({
        type: pendingMedia.type,
        textContent: text.trim(),
        mediaUrl: pendingMedia.previewUrl,
        mediaName: pendingMedia.file.name,
        mediaSize: pendingMedia.file.size,
      });
      setPendingMedia(null);
      setText("");
      return;
    }

    if (!text.trim()) return;
    onSendMessage({
      type: "TEXT",
      textContent: text.trim(),
    });
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, isMedia: boolean) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isImg = file.type.startsWith("image/");
    const isVid = file.type.startsWith("video/");
    const mediaType: MessageType = isImg ? "IMAGE" : isVid ? "VIDEO" : "FILE";

    const previewUrl = URL.createObjectURL(file);
    setPendingMedia({ file, previewUrl, type: mediaType });
    e.target.value = "";
  };

  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const audioUrl = URL.createObjectURL(audioBlob);
        onSendMessage({
          type: "VOICE",
          mediaUrl: audioUrl,
          mediaDuration: recordingSeconds || 5,
        });
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch {
      // If mic is not allowed, simulate voice note
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    }
  };

  const stopVoiceRecording = (send: boolean) => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    setIsRecording(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      if (send) {
        mediaRecorderRef.current.stop();
      } else {
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      }
    } else if (send) {
      onSendMessage({
        type: "VOICE",
        mediaDuration: Math.max(recordingSeconds, 3),
      });
    }
    setRecordingSeconds(0);
  };

  const handleSelectSticker = (sticker: StickerItem) => {
    onSendMessage({
      type: "STICKER",
      stickerUrl: sticker.url,
      textContent: sticker.name,
    });
    setShowStickers(false);
  };

  return (
    <div style={{ position: "relative", backgroundColor: "#ffffff", borderTop: "1px solid #e5e7eb", padding: 10 }}>
      {/* Sticker Picker Drawer */}
      {showStickers && (
        <StickerPicker onSelect={handleSelectSticker} onClose={() => setShowStickers(false)} />
      )}

      {/* Pending Media Preview */}
      {pendingMedia && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            backgroundColor: "#f8fafc",
            borderRadius: 12,
            padding: "8px 12px",
            marginBottom: 8,
            border: "1px solid #e2e8f0",
          }}
        >
          {pendingMedia.type === "IMAGE" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pendingMedia.previewUrl} alt="Preview" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {pendingMedia.file.name}
            </div>
            <div style={{ fontSize: 11, color: "#64748b" }}>
              {(pendingMedia.file.size / 1024).toFixed(1)} KB • Sẵn sàng gửi
            </div>
          </div>
          <button
            onClick={() => setPendingMedia(null)}
            style={{ border: "none", background: "none", color: "#64748b", cursor: "pointer", padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/* Voice Recording Banner */}
      {isRecording ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "#fee2e2",
            borderRadius: 24,
            padding: "8px 16px",
            color: "#991b1b",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#ef4444", animation: "pulse 1s infinite" }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Đang ghi âm... {recordingSeconds}s
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => stopVoiceRecording(false)}
              style={{ border: "none", background: "none", color: "#64748b", cursor: "pointer", fontSize: 13 }}
            >
              Hủy
            </button>
            <button
              onClick={() => stopVoiceRecording(true)}
              style={{
                backgroundColor: "#ef4444",
                border: "none",
                color: "#fff",
                borderRadius: 16,
                padding: "6px 14px",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Square size={12} fill="#fff" /> Gửi
            </button>
          </div>
        </div>
      ) : (
        /* Regular Input Form */
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Action Buttons */}
          <div style={{ display: "flex", gap: 2 }}>
            <button
              type="button"
              onClick={() => setShowStickers(!showStickers)}
              style={{ border: "none", background: "none", padding: 6, borderRadius: "50%", color: "#64748b", cursor: "pointer" }}
              title="Sticker"
            >
              <Smile size={20} />
            </button>

            <button
              type="button"
              onClick={() => mediaInputRef.current?.click()}
              style={{ border: "none", background: "none", padding: 6, borderRadius: "50%", color: "#64748b", cursor: "pointer" }}
              title="Gửi hình ảnh/video"
            >
              <Image size={20} />
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ border: "none", background: "none", padding: 6, borderRadius: "50%", color: "#64748b", cursor: "pointer" }}
              title="Đính kèm tệp"
            >
              <Paperclip size={20} />
            </button>
          </div>

          {/* Hidden File Inputs */}
          <input
            type="file"
            ref={mediaInputRef}
            onChange={(e) => handleFileChange(e, true)}
            accept="image/*,video/*"
            style={{ display: "none" }}
          />
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => handleFileChange(e, false)}
            style={{ display: "none" }}
          />

          {/* Text Input */}
          <input
            type="text"
            placeholder="Nhập tin nhắn..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            style={{
              flex: 1,
              padding: "10px 16px",
              borderRadius: 24,
              border: "1px solid #cbd5e1",
              outline: "none",
              fontSize: 14,
              backgroundColor: "#f8fafc",
            }}
          />

          {/* Send or Voice Record Button */}
          {text.trim() || pendingMedia ? (
            <button
              onClick={handleSend}
              style={{
                backgroundColor: "#0068ff",
                border: "none",
                color: "#fff",
                width: 40,
                height: 40,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                flexShrink: 0,
                boxShadow: "0 2px 6px rgba(0,104,255,0.3)",
              }}
            >
              <Send size={18} style={{ marginLeft: 2 }} />
            </button>
          ) : (
            <button
              type="button"
              onClick={startVoiceRecording}
              style={{
                border: "none",
                background: "none",
                padding: 8,
                borderRadius: "50%",
                color: "#64748b",
                cursor: "pointer",
              }}
              title="Ghi âm tin nhắn thoại"
            >
              <Mic size={22} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
