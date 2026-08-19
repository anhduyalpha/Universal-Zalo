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

export class ZaloLocalDatabase extends Dexie {
  messages!: Table<LocalMessage, number>;
  conversations!: Table<Conversation, string>;

  constructor() {
    super("UniversalZaloDB");
    this.version(3).stores({
      messages: "++id, msgId, conversationId, sender, status, timestamp, type",
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
      // 1. Cập nhật hoặc thêm mới các cuộc hội thoại
      for (const conv of newConversations) {
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
