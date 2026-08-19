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
  id?: number;
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
  messages!: Table<LocalMessage, number>;
  conversations!: Table<Conversation, string>;

  constructor() {
    super("UniversalZaloDB");
    this.version(4).stores({
      messages: "++id, &msgId, conversationId, sender, status, timestamp, type",
      conversations: "id, name, type, lastTimestamp, unreadCount, isPinned",
    });
  }

  /**
   * Transactional Atomic State Reconcile: Đối soát và làm sạch toàn bộ cơ sở dữ liệu cục bộ
   */
  async reconcileFullState(
    newConversations: Conversation[],
    newMessagesMap: Record<string, LocalMessage[]>
  ) {
    return this.transaction("rw", [this.conversations, this.messages], async () => {
      const dedupedConvs = deduplicateConversationsByName(newConversations);

      // 1. Cập nhật các cuộc hội thoại không trùng lặp
      for (const conv of dedupedConvs) {
        await this.conversations.put(conv);
      }

      // 2. Cập nhật các tin nhắn với ID chuẩn, loại bỏ các tin nhắn rác trùng lặp
      for (const [convId, msgs] of Object.entries(newMessagesMap)) {
        for (const msg of msgs) {
          const existing = await this.messages.where("msgId").equals(msg.msgId).first();
          if (existing && existing.id) {
            await this.messages.update(existing.id, {
              ...msg,
              conversationId: convId,
            });
          } else {
            await this.messages.add({
              ...msg,
              conversationId: convId,
            });
          }
        }
      }
    });
  }
}

export const db = new ZaloLocalDatabase();

// Seed initial default conversations if DB is empty
export async function seedInitialConversations() {
  const count = await db.conversations.count();
  if (count === 0) {
    await db.conversations.bulkAdd([
      {
        id: "general",
        name: "Nhóm Chung (Universal Zalo)",
        avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=UniversalZalo",
        type: "GROUP",
        lastMessage: "Chào mừng đến với Universal Zalo PWA!",
        lastTimestamp: Date.now(),
        unreadCount: 0,
        isPinned: true,
        isOnline: true,
      },
      {
        id: "cloud_support",
        name: "Cloud Gateway Hub",
        avatar: "https://api.dicebear.com/7.x/identicon/svg?seed=GatewayHub",
        type: "DIRECT",
        lastMessage: "Session synchronized with Linux server.",
        lastTimestamp: Date.now() - 60000,
        unreadCount: 0,
        isPinned: false,
        isOnline: true,
      },
    ]);
  }
}
