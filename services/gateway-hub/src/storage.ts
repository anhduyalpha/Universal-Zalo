import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { ParsedReaction, cleanMessageContent } from "./normalizer.js";

export interface StoredMessage {
  msgId: string;
  conversationId: string;
  textContent: string;
  sender: "ME" | "OTHER";
  senderName?: string;
  senderAvatar?: string;
  status: "SENDING" | "DELIVERED" | "FAILED";
  timestamp: number;
  type: "TEXT" | "IMAGE" | "VIDEO" | "FILE" | "VOICE" | "STICKER";
  mediaUrl?: string;
  mediaName?: string;
  mediaSize?: number;
  localMediaPath?: string;
  reactions?: ParsedReaction[];
}

export interface StoredConversation {
  id: string;
  name: string;
  avatar: string;
  type: "DIRECT" | "GROUP";
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
  isPinned?: boolean;
}

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MEDIA_DIR = path.join(DATA_DIR, "media");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "images"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "videos"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "audio"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "files"), { recursive: true });

export class ServerStorageEngine {
  private messages: StoredMessage[] = [];
  private conversations: Map<string, StoredConversation> = new Map();
  private isSaving = false;

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(MESSAGES_FILE)) {
        const raw = fs.readFileSync(MESSAGES_FILE, "utf-8");
        this.messages = JSON.parse(raw);
        // Tự động làm sạch các tin nhắn rác đã lưu trong quá khứ
        for (const m of this.messages) {
          if (m.textContent) {
            const cleaned = cleanMessageContent(m.textContent);
            m.textContent = cleaned.cleanText;
            if (cleaned.reactions.length > 0 && (!m.reactions || m.reactions.length === 0)) {
              m.reactions = cleaned.reactions;
            }
          }
        }
        console.log(`[Storage] Loaded & Sanitized ${this.messages.length} messages from server volume.`);
      }
    } catch (e) {
      console.warn("[Storage Warning] Could not parse messages.json:", e);
      this.messages = [];
    }

    try {
      if (fs.existsSync(CONVERSATIONS_FILE)) {
        const raw = fs.readFileSync(CONVERSATIONS_FILE, "utf-8");
        const list: StoredConversation[] = JSON.parse(raw);
        for (const c of list) {
          this.conversations.set(c.id, c);
        }
        console.log(`[Storage] Loaded ${this.conversations.size} conversations from server volume.`);
      }
    } catch (e) {
      console.warn("[Storage Warning] Could not parse conversations.json:", e);
    }
  }

  public flushToDisk() {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const tmpMsg = `${MESSAGES_FILE}.tmp`;
      fs.writeFileSync(tmpMsg, JSON.stringify(this.messages, null, 2), "utf-8");
      fs.renameSync(tmpMsg, MESSAGES_FILE);

      const tmpConv = `${CONVERSATIONS_FILE}.tmp`;
      const convList = Array.from(this.conversations.values());
      fs.writeFileSync(tmpConv, JSON.stringify(convList, null, 2), "utf-8");
      fs.renameSync(tmpConv, CONVERSATIONS_FILE);
    } catch (e) {
      console.error("[Storage Error] Failed to persist data to server volume:", e);
    } finally {
      this.isSaving = false;
    }
  }

  public async downloadAndPersistMedia(remoteUrl: string, mediaType: string = "IMAGE"): Promise<string> {
    if (!remoteUrl || remoteUrl.startsWith("/api/media/") || remoteUrl.startsWith("/media/")) {
      return remoteUrl;
    }

    try {
      const hash = crypto.createHash("md5").update(remoteUrl).digest("hex");
      let ext = ".jpg";
      if (mediaType === "VIDEO" || remoteUrl.includes(".mp4")) ext = ".mp4";
      else if (mediaType === "VOICE" || remoteUrl.includes(".ogg") || remoteUrl.includes(".aac")) ext = ".ogg";
      else if (remoteUrl.includes(".png")) ext = ".png";
      else if (remoteUrl.includes(".webp")) ext = ".webp";
      else if (remoteUrl.includes(".gif")) ext = ".gif";

      const subFolder = mediaType === "VIDEO" ? "videos" : mediaType === "VOICE" ? "audio" : "images";
      const filename = `${subFolder}/${hash}${ext}`;
      const fullPath = path.join(MEDIA_DIR, filename);

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0) {
        return `/api/media/${filename}`;
      }

      const res = await fetch(remoteUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://chat.zalo.me/",
        },
      });

      if (!res.ok) {
        return remoteUrl;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(fullPath, buffer);
      return `/api/media/${filename}`;
    } catch (e) {
      return remoteUrl;
    }
  }

  public async addMessage(msg: StoredMessage): Promise<StoredMessage> {
    // Làm sạch nội dung văn bản và bóc tách reaction
    if (msg.textContent) {
      const cleaned = cleanMessageContent(msg.textContent);
      msg.textContent = cleaned.cleanText;
      if (cleaned.reactions.length > 0) {
        msg.reactions = cleaned.reactions;
      }
    }

    if (msg.mediaUrl && !msg.mediaUrl.startsWith("/api/media/")) {
      msg.mediaUrl = await this.downloadAndPersistMedia(msg.mediaUrl, msg.type);
    }

    const existingIdx = this.messages.findIndex((m) => m.msgId === msg.msgId);
    if (existingIdx >= 0) {
      this.messages[existingIdx] = { ...this.messages[existingIdx], ...msg };
    } else {
      this.messages.push(msg);
    }

    // Cập nhật cuộc hội thoại
    const conv = this.conversations.get(msg.conversationId);
    if (conv) {
      conv.lastMessage = msg.textContent || `[${msg.type}]`;
      if (msg.timestamp > conv.lastTimestamp) {
        conv.lastTimestamp = msg.timestamp;
      }
      this.conversations.set(msg.conversationId, conv);
    }

    this.flushToDisk();
    return msg;
  }

  public getMessages(conversationId?: string, limit: number = 500): StoredMessage[] {
    if (conversationId) {
      return this.messages
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-limit);
    }
    return this.messages.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }

  public saveConversations(convs: StoredConversation[]) {
    for (const c of convs) {
      const existing = this.conversations.get(c.id);
      if (existing) {
        this.conversations.set(c.id, { ...existing, ...c });
      } else {
        this.conversations.set(c.id, c);
      }
    }
    this.flushToDisk();
  }

  public getConversations(): StoredConversation[] {
    return Array.from(this.conversations.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  public getMediaFile(relativeFilename: string): { stream: Readable; mimeType: string; size: number } | null {
    const fullPath = path.join(MEDIA_DIR, relativeFilename);
    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const ext = path.extname(fullPath).toLowerCase();
    let mimeType = "application/octet-stream";
    if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
    else if (ext === ".png") mimeType = "image/png";
    else if (ext === ".webp") mimeType = "image/webp";
    else if (ext === ".gif") mimeType = "image/gif";
    else if (ext === ".mp4") mimeType = "video/mp4";
    else if (ext === ".ogg") mimeType = "audio/ogg";
    else if (ext === ".mp3") mimeType = "audio/mpeg";

    const stat = fs.statSync(fullPath);
    const stream = fs.createReadStream(fullPath);

    return { stream, mimeType, size: stat.size };
  }
}

export const serverStorage = new ServerStorageEngine();
