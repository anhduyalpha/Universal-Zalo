import Dexie, { type Table } from "dexie";

export type MessageType = "TEXT" | "IMAGE" | "VIDEO" | "FILE" | "VOICE" | "STICKER";
export type MessageStatus = "SENDING" | "DELIVERED" | "FAILED";
export type SenderType = "ME" | "OTHER";

export interface MessageReaction {
  code: string;
  type: string;
  emoji: string;
  count: number;
}

export interface MentionToken {
  name: string;
  startIndex: number;
  endIndex: number;
}

export interface LocalMessage {
  msgId: string;
  conversationId: string;
  textContent: string;
  sender: SenderType;
  senderName?: string;
  senderAvatar?: string;
  status: MessageStatus;
  timestamp: number;
  type?: MessageType;
  mediaUrl?: string;
  mediaName?: string;
  mediaSize?: number;
  mediaDuration?: number;
  stickerId?: string;
  stickerCategory?: string;
  stickerUrl?: string;
  replyToMsgId?: string;
  replyToText?: string;
  reactions?: MessageReaction[];
  mentions?: MentionToken[];
}

export interface Conversation {
  id: string; // conversationId
  name: string;
  avatar: string;
  type: "DIRECT" | "GROUP";
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
  isPinned?: boolean;
  isOnline?: boolean;
}

export function deduplicateById<T extends { id?: string | number; msgId?: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = String(item.msgId || item.id || "");
    if (key) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

export function deduplicateConversationsByName(convs: Conversation[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const c of convs) {
    const norm = c.name.trim().toLowerCase();
    if (!norm) continue;
    if (map.has(norm)) {
      const existing = map.get(norm)!;
      if (c.lastTimestamp > existing.lastTimestamp) {
        existing.lastTimestamp = c.lastTimestamp;
        existing.lastMessage = c.lastMessage;
      }
      if (c.avatar && !c.avatar.includes("dicebear") && existing.avatar.includes("dicebear")) {
        existing.avatar = c.avatar;
      }
      map.set(norm, existing);
    } else {
      map.set(norm, { ...c });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

export class ZaloLocalDatabase extends Dexie {
  messages!: Table<LocalMessage, string>;
  conversations!: Table<Conversation, string>;

  constructor() {
    // Sử dụng tên cơ sở dữ liệu mới để loại bỏ hoàn toàn xung đột Primary Key từ các phiên bản cũ
    super("UniversalZaloMasterDB_v1");
    this.version(1).stores({
      messages: "msgId, conversationId, sender, status, timestamp, type",
      conversations: "id, name, type, lastTimestamp, unreadCount, isPinned",
    });
  }

  /**
   * Transactional Atomic State Reconcile: Đối soát và nạp sạch toàn bộ tin nhắn & hội thoại
   */
  async reconcileFullState(
    newConversations: Conversation[],
    newMessagesMap: Record<string, LocalMessage[]>
  ) {
    try {
      const dedupedConvs = deduplicateConversationsByName(newConversations);
      if (dedupedConvs.length > 0) {
        await this.conversations.bulkPut(dedupedConvs);
      }

      const allMessages: LocalMessage[] = [];
      for (const [convId, msgs] of Object.entries(newMessagesMap)) {
        if (Array.isArray(msgs)) {
          for (const msg of msgs) {
            if (msg && msg.msgId) {
              allMessages.push({
                ...msg,
                conversationId: msg.conversationId || convId,
              });
            }
          }
        }
      }

      const dedupedMsgs = deduplicateById(allMessages);
      if (dedupedMsgs.length > 0) {
        await this.messages.bulkPut(dedupedMsgs);
      }
    } catch (e) {
      console.warn("Reconcile state warning, falling back to individual put:", e);
      for (const conv of newConversations) {
        try { await this.conversations.put(conv); } catch {}
      }
      for (const [convId, msgs] of Object.entries(newMessagesMap)) {
        if (Array.isArray(msgs)) {
          for (const msg of msgs) {
            if (msg && msg.msgId) {
              try {
                await this.messages.put({ ...msg, conversationId: msg.conversationId || convId });
              } catch {}
            }
          }
        }
      }
    }
  }
}

export const db = new ZaloLocalDatabase();

// Tự động dọn dẹp và phục hồi nếu gặp lỗi UpgradeError từ trình duyệt
if (typeof window !== "undefined") {
  db.open().catch(async (err) => {
    console.warn("[IndexedDB Auto-Recovery] Detected schema upgrade error:", err);
    if (err.name === "UpgradeError" || err.name === "DatabaseClosedError") {
      try {
        await Dexie.delete("UniversalZaloDB");
        await Dexie.delete("UniversalZaloMasterDB_v1");
        window.location.reload();
      } catch (delErr) {}
    }
  });
}

// Seed initial default conversations if DB is empty
export async function seedInitialConversations() {
  try {
    const count = await db.conversations.count();
    if (count === 0) {
      await db.conversations.bulkPut([
        {
          id: "general",
          name: "Cộng Đồng Diablo 2 Resurrected",
          avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Diablo2",
          type: "GROUP",
          lastMessage: "Michael Lee: Bình chọn: Có thêm 2 bác hoàn thà...",
          lastTimestamp: Date.now() - 180000,
          unreadCount: 99,
          isPinned: true,
          isOnline: true,
        },
        {
          id: "conv_alex",
          name: "Nguyễn Hoàng Anh",
          avatar: "https://api.dicebear.com/7.x/identicon/svg?seed=HoangAnh",
          type: "DIRECT",
          lastMessage: "Bạn: ít cần fake ip gì cả",
          lastTimestamp: Date.now() - 360000,
          unreadCount: 34,
          isPinned: false,
          isOnline: true,
        },
        {
          id: "conv_tut",
          name: "Thủ Thuật - Kiến Thức Mở Rộng",
          avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=ThuThuat",
          type: "GROUP",
          lastMessage: "Đức Nam: Tìm ppt go trôi date",
          lastTimestamp: Date.now() - 540000,
          unreadCount: 99,
          isPinned: false,
          isOnline: true,
        },
      ]);
    }
  } catch (e) {}
}
