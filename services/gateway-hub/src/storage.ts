import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { ParsedReaction, MentionToken, cleanMessageContent } from "./normalizer.js";

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
  mentions?: MentionToken[];
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

  // Khử trùng lặp danh sách tin nhắn (Deduplicate Messages by msgId or signature)
  private deduplicateMessages(list: StoredMessage[]): StoredMessage[] {
    const mapById = new Map<string, StoredMessage>();
    const seenSignatures = new Set<string>();
    const deduped: StoredMessage[] = [];

    for (const m of list) {
      if (!m.msgId) continue;
      
      // Tạo chữ ký nhận diện nội dung + thời gian (gần đúng trong 3 giây)
      const approxTime = Math.floor(m.timestamp / 3000) * 3000;
      const signature = `${m.conversationId}_${m.sender}_${m.textContent}_${m.mediaUrl || ""}_${approxTime}`;

      if (mapById.has(m.msgId)) {
        // Cập nhật bản ghi cũ
        const old = mapById.get(m.msgId)!;
        mapById.set(m.msgId, { ...old, ...m });
      } else if (m.textContent && seenSignatures.has(signature)) {
        // Trùng chữ ký nội dung, bỏ qua bản sao
        continue;
      } else {
        seenSignatures.add(signature);
        mapById.set(m.msgId, m);
        deduped.push(m);
      }
    }

    return Array.from(mapById.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  // Khử trùng lặp danh sách cuộc hội thoại theo tên (Deduplicate Conversations by Name)
  private deduplicateConversations(list: StoredConversation[]): StoredConversation[] {
    const nameMap = new Map<string, StoredConversation>();

    for (const c of list) {
      const normalizedName = c.name.trim().toLowerCase();
      if (!normalizedName) continue;

      if (nameMap.has(normalizedName)) {
        const existing = nameMap.get(normalizedName)!;
        // Giữ lại bản ghi có avatar tốt hơn hoặc timestamp mới hơn
        if (c.lastTimestamp > existing.lastTimestamp) {
          existing.lastTimestamp = c.lastTimestamp;
          existing.lastMessage = c.lastMessage;
        }
        if (c.avatar && !c.avatar.includes("dicebear") && existing.avatar.includes("dicebear")) {
          existing.avatar = c.avatar;
        }
        nameMap.set(normalizedName, existing);
      } else {
        nameMap.set(normalizedName, { ...c });
      }
    }

    return Array.from(nameMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(MESSAGES_FILE)) {
        const raw = fs.readFileSync(MESSAGES_FILE, "utf-8");
        const loaded: StoredMessage[] = JSON.parse(raw);
        for (const m of loaded) {
          if (m.textContent) {
            const cleaned = cleanMessageContent(m.textContent);
            m.textContent = cleaned.cleanText;
            if (cleaned.reactions.length > 0 && (!m.reactions || m.reactions.length === 0)) {
              m.reactions = cleaned.reactions;
            }
            if (cleaned.mentions.length > 0 && (!m.mentions || m.mentions.length === 0)) {
              m.mentions = cleaned.mentions;
            }
          }
        }
        this.messages = this.deduplicateMessages(loaded);
        console.log(`[Storage] Loaded & Deduplicated ${this.messages.length} messages from server volume.`);
      }
    } catch (e) {
      console.warn("[Storage Warning] Could not parse messages.json:", e);
      this.messages = [];
    }

    try {
      if (fs.existsSync(CONVERSATIONS_FILE)) {
        const raw = fs.readFileSync(CONVERSATIONS_FILE, "utf-8");
        const list: StoredConversation[] = JSON.parse(raw);
        const dedupedConvs = this.deduplicateConversations(list);
        for (const c of dedupedConvs) {
          this.conversations.set(c.id, c);
        }
        console.log(`[Storage] Loaded & Deduplicated ${this.conversations.size} conversations from server volume.`);
      }
    } catch (e) {
      console.warn("[Storage Warning] Could not parse conversations.json:", e);
    }
  }

  public flushToDisk() {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      this.messages = this.deduplicateMessages(this.messages);
      const tmpMsg = `${MESSAGES_FILE}.tmp`;
      fs.writeFileSync(tmpMsg, JSON.stringify(this.messages, null, 2), "utf-8");
      fs.renameSync(tmpMsg, MESSAGES_FILE);

      const convList = this.deduplicateConversations(Array.from(this.conversations.values()));
      const tmpConv = `${CONVERSATIONS_FILE}.tmp`;
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
        return `/api/media/proxy?url=${encodeURIComponent(remoteUrl)}`;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(fullPath, buffer);
      return `/api/media/${filename}`;
    } catch (e) {
      return `/api/media/proxy?url=${encodeURIComponent(remoteUrl)}`;
    }
  }

  public async addMessage(msg: StoredMessage): Promise<StoredMessage> {
    if (msg.textContent) {
      const cleaned = cleanMessageContent(msg.textContent);
      msg.textContent = cleaned.cleanText;
      if (cleaned.reactions.length > 0) {
        msg.reactions = cleaned.reactions;
      }
      if (cleaned.mentions.length > 0) {
        msg.mentions = cleaned.mentions;
      }
    }

    if (msg.mediaUrl && !msg.mediaUrl.startsWith("/api/media/")) {
      msg.mediaUrl = await this.downloadAndPersistMedia(msg.mediaUrl, msg.type);
    }

    const approxTime = Math.floor(msg.timestamp / 3000) * 3000;
    const existingIdx = this.messages.findIndex(
      (m) =>
        m.msgId === msg.msgId ||
        (m.conversationId === msg.conversationId &&
          m.sender === msg.sender &&
          m.textContent === msg.textContent &&
          Math.abs(m.timestamp - msg.timestamp) < 3000)
    );

    if (existingIdx >= 0) {
      this.messages[existingIdx] = { ...this.messages[existingIdx], ...msg };
    } else {
      this.messages.push(msg);
    }

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
    this.messages = this.deduplicateMessages(this.messages);
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
      const normalizedName = c.name.trim().toLowerCase();
      // Tìm theo id hoặc tên trùng
      let existingKey: string | null = null;
      for (const [id, item] of this.conversations.entries()) {
        if (id === c.id || item.name.trim().toLowerCase() === normalizedName) {
          existingKey = id;
          break;
        }
      }

      if (existingKey) {
        const old = this.conversations.get(existingKey)!;
        this.conversations.set(existingKey, {
          ...old,
          ...c,
          id: existingKey,
          avatar: (c.avatar && !c.avatar.includes("dicebear")) ? c.avatar : old.avatar,
        });
      } else {
        this.conversations.set(c.id, c);
      }
    }
    this.flushToDisk();
  }

  public getConversations(): StoredConversation[] {
    const list = Array.from(this.conversations.values());
    return this.deduplicateConversations(list);
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
