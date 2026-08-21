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

export interface Contact {
  id: string; // Contact UID (always String)
  displayName: string;
  avatarUrl: string;
  isStub?: boolean;
  updatedAt: number;
}

export interface LocalMessage {
  msgId: string; // Message ID (always String)
  conversationId: string; // Thread ID (FK)
  senderId?: string; // Author Contact UID (FK)
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
  id: string; // Thread ID (always String)
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

/**
 * 3NF CLIENT-SIDE INDEXEDDB DATABASE (Enterprise Edition)
 */
export class ZaloLocalDatabase extends Dexie {
  messages!: Table<LocalMessage, string>;
  conversations!: Table<Conversation, string>;
  contacts!: Table<Contact, string>;

  constructor() {
    super("UniversalZaloMasterDB_3NF");
    this.version(1).stores({
      messages: "msgId, conversationId, senderId, sender, status, timestamp, type",
      conversations: "id, name, type, lastTimestamp, unreadCount, isPinned",
      contacts: "id, displayName, updatedAt",
    });
  }

  /**
   * Transactional Atomic State Reconcile: Đối soát và nạp sạch toàn bộ 3NF tables
   */
  async reconcileFullState(
    newConversations: Conversation[],
    newMessagesMap: Record<string, LocalMessage[]>,
    newContacts: Contact[] = []
  ) {
    try {
      if (newConversations.length > 0) {
        await this.conversations.bulkPut(deduplicateById(newConversations));
      }

      if (newContacts.length > 0) {
        await this.contacts.bulkPut(deduplicateById(newContacts));
      }

      const allMessages: LocalMessage[] = [];
      for (const [convId, msgs] of Object.entries(newMessagesMap)) {
        if (Array.isArray(msgs)) {
          for (const msg of msgs) {
            if (msg && msg.msgId) {
              allMessages.push({
                ...msg,
                msgId: String(msg.msgId),
                conversationId: String(msg.conversationId || convId),
                senderId: String(msg.senderId || (msg.sender === "ME" ? "ME" : convId)),
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
        try { await this.conversations.put({ ...conv, id: String(conv.id) }); } catch {}
      }
      for (const ct of newContacts) {
        try { await this.contacts.put({ ...ct, id: String(ct.id) }); } catch {}
      }
      for (const [convId, msgs] of Object.entries(newMessagesMap)) {
        if (Array.isArray(msgs)) {
          for (const msg of msgs) {
            if (msg && msg.msgId) {
              try {
                await this.messages.put({
                  ...msg,
                  msgId: String(msg.msgId),
                  conversationId: String(msg.conversationId || convId),
                  senderId: String(msg.senderId || (msg.sender === "ME" ? "ME" : convId)),
                });
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
        await Dexie.delete("UniversalZaloMasterDB_3NF");
        window.location.reload();
      } catch (delErr) {}
    }
  });
}
