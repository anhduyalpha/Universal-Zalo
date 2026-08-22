import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { ParsedReaction, MentionToken, cleanMessageContent, isBase64Ciphertext } from "./normalizer.js";
import { sessionAuthManager } from "./session_auth.js";
import EventEmitter from "events";

export type HydrationState = "COLD_START" | "STAGING_INGESTION" | "INTEGRITY_CHECK" | "HYDRATED";

export interface StoredContact {
  id: string; // Contact UID (always String)
  displayName: string;
  avatarUrl: string;
  isStub: boolean;
  updatedAt: number;
}

export interface StoredConversation {
  id: string; // Thread ID / UID / Group ID (always String)
  name: string;
  avatar: string;
  type: "DIRECT" | "GROUP";
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
  isPinned?: boolean;
  isOnline?: boolean;
}

export interface StoredMessage {
  msgId: string; // Message ID (always String)
  conversationId: string; // Thread ID (FK)
  senderId: string; // Author UID (FK)
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

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MEDIA_DIR = path.join(DATA_DIR, "media");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const METADATA_FILE = path.join(DATA_DIR, "sync_metadata.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "images"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "videos"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "audio"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "files"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "avatars"), { recursive: true });

/**
 * 3NF ENTERPRISE STORAGE & BLUE/GREEN STAGING ENGINE (Phases 1 & 2 Core)
 */
export class ServerStorageEngine extends EventEmitter {
  // Production Active Tables (Served to Frontend)
  private messages: StoredMessage[] = [];
  private conversations: Map<string, StoredConversation> = new Map();
  private contacts: Map<string, StoredContact> = new Map();

  // Blue/Green Staging Buffers (Offline Ingestion Partition)
  private stagingMessages: StoredMessage[] = [];
  private stagingConversations: Map<string, StoredConversation> = new Map();
  private stagingContacts: Map<string, StoredContact> = new Map();

  // High-Water Mark Metadata (conversationId -> maxTimestamp)
  private highWaterMarks: Record<string, number> = {};

  // Hydration Gatekeeper FSM
  private hydrationState: HydrationState = "COLD_START";
  private syncProgress = 0;
  private syncStatusMessage = "Khởi tạo hệ thống...";

  private isSaving = false;

  constructor() {
    super();
    this.loadFromDisk();
  }

  public getHydrationState(): { state: HydrationState; progress: number; message: string } {
    return {
      state: this.hydrationState,
      progress: this.syncProgress,
      message: this.syncStatusMessage,
    };
  }

  public setHydrationState(state: HydrationState, progress: number = 0, message: string = "") {
    this.hydrationState = state;
    this.syncProgress = progress;
    this.syncStatusMessage = message;
    this.emit("state_changed", this.getHydrationState());
  }

  public isHydrated(): boolean {
    return this.hydrationState === "HYDRATED";
  }

  // ==========================================
  // BLUE / GREEN STAGING LIFECYCLE (Phase 2)
  // ==========================================

  public startStagingSession() {
    this.setHydrationState("STAGING_INGESTION", 0, "Bắt đầu cào dữ liệu Offline vào Staging...");
    this.stagingMessages = [];
    this.stagingConversations.clear();
    this.stagingContacts.clear();
  }

  public addStagingConversations(convs: StoredConversation[]) {
    for (const c of convs) {
      if (!c.id) continue;
      const strId = String(c.id);
      this.stagingConversations.set(strId, {
        ...c,
        id: strId,
      });
    }
  }

  public addStagingContacts(contacts: StoredContact[]) {
    for (const ct of contacts) {
      if (!ct.id) continue;
      const strId = String(ct.id);
      this.stagingContacts.set(strId, {
        ...ct,
        id: strId,
      });
    }
  }

  public addStagingMessages(msgs: StoredMessage[]) {
    for (const m of msgs) {
      if (!m.msgId) continue;
      this.stagingMessages.push({
        ...m,
        msgId: String(m.msgId),
        conversationId: String(m.conversationId),
        senderId: String(m.senderId || (m.sender === "ME" ? "ME" : m.conversationId)),
      });
    }
  }

  /**
   * Pre-Hydration Stub Synthesis: Quét các sender_id mồ côi và tạo liên hệ giả lập để chống lỗi 3NF
   */
  public synthesizeMissingContacts() {
    this.setHydrationState("INTEGRITY_CHECK", 95, "Kiểm tra toàn vẹn quan hệ & Tổng hợp Stub Contacts...");
    const existingContactIds = new Set(this.stagingContacts.keys());

    for (const msg of this.stagingMessages) {
      const senderId = msg.senderId;
      if (senderId && !existingContactIds.has(senderId)) {
        const stubName = msg.senderName || (senderId === "ME" ? "Tôi" : `Thành viên ${senderId.slice(-4)}`);
        const stubContact: StoredContact = {
          id: senderId,
          displayName: stubName,
          avatarUrl: msg.senderAvatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(senderId)}`,
          isStub: true,
          updatedAt: Date.now(),
        };
        this.stagingContacts.set(senderId, stubContact);
        existingContactIds.add(senderId);
      }
    }
  }

  /**
   * 2ms Atomic Blue/Green Staging Swap: Tráo đổi shadow tables vào production nguyên tử
   */
  public commitStagingSwap() {
    this.synthesizeMissingContacts();

    // 1. Tráo đổi Map nguyên tử
    this.conversations = new Map(this.stagingConversations);
    this.contacts = new Map(this.stagingContacts);
    this.messages = this.deduplicateMessagesById(this.stagingMessages);

    // 2. Cập nhật High-Water Marks
    for (const m of this.messages) {
      const currentHwm = this.highWaterMarks[m.conversationId] || 0;
      if (m.timestamp > currentHwm) {
        this.highWaterMarks[m.conversationId] = m.timestamp;
      }
    }

    // 3. Xả đĩa an toàn
    this.flushToDisk();

    // 4. Mở khóa Gatekeeper cho Web UI
    this.setHydrationState("HYDRATED", 100, "Hoàn tất đồng bộ Offline-First. Sẵn sàng phục vụ.");
    console.log(`🎉 [Staging Swap] Successfully swapped ${this.conversations.size} convs, ${this.contacts.size} contacts, ${this.messages.length} messages.`);
  }

  // ==========================================
  // 3NF DATA ACCESS & MUTATION METHODS
  // ==========================================

  private deduplicateMessagesById(list: StoredMessage[]): StoredMessage[] {
    const mapById = new Map<string, StoredMessage>();
    for (const m of list) {
      if (!m.msgId) continue;
      const strId = String(m.msgId);
      if (mapById.has(strId)) {
        const old = mapById.get(strId)!;
        mapById.set(strId, { ...old, ...m, msgId: strId });
      } else {
        mapById.set(strId, { ...m, msgId: strId });
      }
    }
    return Array.from(mapById.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(MESSAGES_FILE)) {
        const raw = fs.readFileSync(MESSAGES_FILE, "utf-8");
        const loaded: StoredMessage[] = JSON.parse(raw);
        const sanitized = loaded.map((m) => {
          if (isBase64Ciphertext(m.textContent)) {
            return { ...m, textContent: "[Tin nhắn mã hóa E2EE]" };
          }
          return m;
        });
        this.messages = this.deduplicateMessagesById(sanitized);
      }
    } catch (e) {
      this.messages = [];
    }

    try {
      if (fs.existsSync(CONVERSATIONS_FILE)) {
        const raw = fs.readFileSync(CONVERSATIONS_FILE, "utf-8");
        const list: StoredConversation[] = JSON.parse(raw);
        for (const c of list) {
          if (c.id) {
            if (isBase64Ciphertext(c.lastMessage)) {
              c.lastMessage = "Đã đồng bộ từ Zalo";
            }
            if (isBase64Ciphertext(c.name)) {
              c.name = `Hội thoại ${String(c.id).slice(-4)}`;
            }
            this.conversations.set(String(c.id), { ...c, id: String(c.id) });
          }
        }
      }
    } catch (e) {}

    try {
      if (fs.existsSync(CONTACTS_FILE)) {
        const raw = fs.readFileSync(CONTACTS_FILE, "utf-8");
        const list: StoredContact[] = JSON.parse(raw);
        for (const ct of list) {
          if (ct.id) {
            if (isBase64Ciphertext(ct.displayName)) {
              ct.displayName = `Người dùng ${String(ct.id).slice(-4)}`;
            }
            this.contacts.set(String(ct.id), { ...ct, id: String(ct.id) });
          }
        }
      }
    } catch (e) {}

    try {
      if (fs.existsSync(METADATA_FILE)) {
        this.highWaterMarks = JSON.parse(fs.readFileSync(METADATA_FILE, "utf-8"));
      }
    } catch (e) {}

    if (this.conversations.size > 0 || this.messages.length > 0) {
      this.setHydrationState("HYDRATED", 100, "Đã khôi phục dữ liệu từ Local Storage.");
    }
  }

  public flushToDisk() {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const tmpMsg = `${MESSAGES_FILE}.tmp`;
      fs.writeFileSync(tmpMsg, JSON.stringify(this.messages, null, 2), "utf-8");
      fs.renameSync(tmpMsg, MESSAGES_FILE);

      const convList = Array.from(this.conversations.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
      const tmpConv = `${CONVERSATIONS_FILE}.tmp`;
      fs.writeFileSync(tmpConv, JSON.stringify(convList, null, 2), "utf-8");
      fs.renameSync(tmpConv, CONVERSATIONS_FILE);

      const contactList = Array.from(this.contacts.values());
      const tmpContact = `${CONTACTS_FILE}.tmp`;
      fs.writeFileSync(tmpContact, JSON.stringify(contactList, null, 2), "utf-8");
      fs.renameSync(tmpContact, CONTACTS_FILE);

      fs.writeFileSync(METADATA_FILE, JSON.stringify(this.highWaterMarks, null, 2), "utf-8");
    } catch (e) {
      console.error("[Storage Error] Flush failed:", e);
    } finally {
      this.isSaving = false;
    }
  }

  public async addMessage(msg: StoredMessage): Promise<StoredMessage> {
    const strMsgId = String(msg.msgId);
    const strConvId = String(msg.conversationId);
    const strSenderId = String(msg.senderId || (msg.sender === "ME" ? "ME" : strConvId));

    if (msg.textContent) {
      const cleaned = cleanMessageContent(msg.textContent);
      msg.textContent = cleaned.cleanText;
      if (cleaned.reactions.length > 0) msg.reactions = cleaned.reactions;
      if (cleaned.mentions.length > 0) msg.mentions = cleaned.mentions;
    }

    if (msg.mediaUrl && !msg.mediaUrl.startsWith("/api/media/")) {
      msg.mediaUrl = await this.downloadAndPersistMedia(msg.mediaUrl, msg.type);
    }

    const normalizedMsg: StoredMessage = {
      ...msg,
      msgId: strMsgId,
      conversationId: strConvId,
      senderId: strSenderId,
    };

    const existingIdx = this.messages.findIndex((m) => m.msgId === strMsgId);
    if (existingIdx >= 0) {
      // Monotonic check: chỉ cập nhật nếu timestamp mới hơn hoặc bằng
      if (normalizedMsg.timestamp >= this.messages[existingIdx].timestamp) {
        this.messages[existingIdx] = { ...this.messages[existingIdx], ...normalizedMsg };
      }
    } else {
      this.messages.push(normalizedMsg);
    }

    // Cập nhật High-Water Mark
    const currentHwm = this.highWaterMarks[strConvId] || 0;
    if (normalizedMsg.timestamp > currentHwm) {
      this.highWaterMarks[strConvId] = normalizedMsg.timestamp;
    }

    // Cập nhật conversation container
    const conv = this.conversations.get(strConvId);
    if (conv) {
      conv.lastMessage = normalizedMsg.textContent || `[${normalizedMsg.type}]`;
      if (normalizedMsg.timestamp > conv.lastTimestamp) {
        conv.lastTimestamp = normalizedMsg.timestamp;
      }
      this.conversations.set(strConvId, conv);
    }

    // Cập nhật contact nếu có thông tin người gửi
    if (strSenderId && !this.contacts.has(strSenderId)) {
      this.contacts.set(strSenderId, {
        id: strSenderId,
        displayName: normalizedMsg.senderName || `Thành viên ${strSenderId.slice(-4)}`,
        avatarUrl: normalizedMsg.senderAvatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(strSenderId)}`,
        isStub: true,
        updatedAt: Date.now(),
      });
    }

    this.flushToDisk();
    return normalizedMsg;
  }

  public getMessages(conversationId?: string, limit: number = 500): StoredMessage[] {
    if (conversationId) {
      const strConvId = String(conversationId);
      return this.messages
        .filter((m) => m.conversationId === strConvId)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-limit);
    }
    return this.messages.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }

  public getConversations(): StoredConversation[] {
    return Array.from(this.conversations.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  public getConversation(id: string): StoredConversation | undefined {
    return this.conversations.get(String(id));
  }

  public saveConversations(convs: StoredConversation[]) {
    for (const c of convs) {
      if (!c.id) continue;
      const strId = String(c.id);
      this.conversations.set(strId, {
        ...c,
        id: strId,
      });
    }
    this.flushToDisk();
  }

  public upsertConversation(c: StoredConversation) {
    if (!c.id) return;
    const strId = String(c.id);
    const existing = this.conversations.get(strId);
    this.conversations.set(strId, {
      ...existing,
      ...c,
      id: strId,
    });
    this.flushToDisk();
  }

  public getContacts(): StoredContact[] {
    return Array.from(this.contacts.values());
  }

  public getContact(id: string): StoredContact | undefined {
    return this.contacts.get(String(id));
  }

  public saveContacts(contacts: StoredContact[]) {
    for (const ct of contacts) {
      if (!ct.id) continue;
      const strId = String(ct.id);
      this.contacts.set(strId, {
        ...ct,
        id: strId,
      });
    }
    this.flushToDisk();
  }

  public upsertContact(ct: StoredContact) {
    if (!ct.id) return;
    const strId = String(ct.id);
    const existing = this.contacts.get(strId);
    this.contacts.set(strId, {
      ...existing,
      ...ct,
      id: strId,
    });
    this.flushToDisk();
  }

  public saveMessages(conversationId: string, msgs: StoredMessage[]) {
    for (const m of msgs) {
      this.addMessage(m);
    }
  }

  public getHighWaterMark(conversationId: string): number {
    return this.highWaterMarks[String(conversationId)] || 0;
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

      const mediaData = await sessionAuthManager.fetchZaloMedia(remoteUrl);
      if (mediaData && mediaData.buffer.length > 0) {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, mediaData.buffer);
        return `/api/media/${filename}`;
      }

      return `/api/media/proxy?url=${encodeURIComponent(remoteUrl)}`;
    } catch (e) {
      return `/api/media/proxy?url=${encodeURIComponent(remoteUrl)}`;
    }
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
