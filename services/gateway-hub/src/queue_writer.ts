import { serverStorage, StoredMessage, StoredConversation, StoredContact } from "./storage.js";
import { cleanMessageContent, ParsedReaction, MentionToken } from "./normalizer.js";
import EventEmitter from "events";

export interface CdcEvent {
  op: "INSERT" | "UPDATE" | "DELETE";
  table: "messages" | "conversations" | "contacts";
  data: StoredMessage | StoredConversation | StoredContact;
  timestamp: number;
}

export interface IngestionMessageTask {
  msgId: string;
  conversationId: string;
  senderId?: string;
  conversationName?: string;
  textContent: string;
  sender: "ME" | "OTHER";
  senderName?: string;
  senderAvatar?: string;
  status: "SENDING" | "DELIVERED" | "FAILED";
  timestamp: number;
  type?: "TEXT" | "IMAGE" | "VIDEO" | "FILE" | "VOICE" | "STICKER";
  mediaUrl?: string;
  mediaName?: string;
  mediaSize?: number;
  reactions?: ParsedReaction[];
  mentions?: MentionToken[];
  isRealtime?: boolean;
}

export interface OutboundMessageState {
  clientMsgId: string;
  targetId: string;
  content: string;
  status: "PENDING" | "DISPATCHED" | "SENT" | "FAILED";
  createdAt: number;
  timeoutTimer: NodeJS.Timeout;
}

/**
 * 3NF DUAL-TIER SINGLE-WRITER & OUTBOUND LIFECYCLE ENGINE (Phases 1, 2, 3)
 */
export class SingleWriterQueueEngine extends EventEmitter {
  private tier1RealtimeQueue: IngestionMessageTask[] = [];
  private tier2BulkQueue: IngestionMessageTask[] = [];
  private isProcessing = false;
  private idResolutionCache = new Map<string, string>(); // cliMsgId -> globalMsgId
  private outboundPendingMap = new Map<string, OutboundMessageState>();

  constructor() {
    super();
    this.startWorkerLoop();
  }

  public enqueueRealtime(task: IngestionMessageTask) {
    task.isRealtime = true;
    this.tier1RealtimeQueue.push(task);
    this.triggerProcessing();
  }

  public enqueueBulkBatch(tasks: IngestionMessageTask[]) {
    for (const t of tasks) {
      t.isRealtime = false;
      this.tier2BulkQueue.push(t);
    }
    this.triggerProcessing();
  }

  public registerIdMapping(cliMsgId: string, globalMsgId: string) {
    if (cliMsgId && globalMsgId) {
      const strCli = String(cliMsgId);
      const strGlobal = String(globalMsgId);
      this.idResolutionCache.set(strCli, strGlobal);

      // Giải phóng Outbound Pending nếu có
      if (this.outboundPendingMap.has(strCli)) {
        const out = this.outboundPendingMap.get(strCli)!;
        clearTimeout(out.timeoutTimer);
        out.status = "SENT";
        this.outboundPendingMap.delete(strCli);
        this.emit("outbound_status", { clientMsgId: strCli, status: "SENT", globalMsgId: strGlobal });
      }
    }
  }

  public registerOutboundPending(clientMsgId: string, targetId: string, content: string) {
    const strId = String(clientMsgId);
    const timeoutTimer = setTimeout(() => {
      if (this.outboundPendingMap.has(strId)) {
        this.outboundPendingMap.delete(strId);
        this.emit("outbound_status", { clientMsgId: strId, status: "FAILED", error: "Timeout waiting for server ACK (10s)" });
      }
    }, 10000);

    this.outboundPendingMap.set(strId, {
      clientMsgId: strId,
      targetId: String(targetId),
      content,
      status: "PENDING",
      createdAt: Date.now(),
      timeoutTimer,
    });
  }

  private triggerProcessing() {
    if (!this.isProcessing) {
      this.isProcessing = true;
      setImmediate(() => this.processNextBatch());
    }
  }

  private async processNextBatch() {
    try {
      while (this.tier1RealtimeQueue.length > 0) {
        const task = this.tier1RealtimeQueue.shift()!;
        await this.writeSingleMessage(task);
      }

      if (this.tier2BulkQueue.length > 0) {
        const microBatchSize = Math.min(500, this.tier2BulkQueue.length);
        const batch = this.tier2BulkQueue.splice(0, microBatchSize);

        for (const task of batch) {
          if (this.tier1RealtimeQueue.length > 0) {
            const urgentTask = this.tier1RealtimeQueue.shift()!;
            await this.writeSingleMessage(urgentTask);
          }
          await this.writeSingleMessage(task);
        }

        serverStorage.flushToDisk();
      }
    } catch (err) {
      console.error("[Queue Writer Error]", err);
    } finally {
      if (this.tier1RealtimeQueue.length > 0 || this.tier2BulkQueue.length > 0) {
        setImmediate(() => this.processNextBatch());
      } else {
        this.isProcessing = false;
        serverStorage.flushToDisk();
      }
    }
  }

  private async writeSingleMessage(task: IngestionMessageTask): Promise<StoredMessage | null> {
    const convId = String(task.conversationId || "general");
    let finalMsgId = String(task.msgId);
    if (this.idResolutionCache.has(finalMsgId)) {
      finalMsgId = this.idResolutionCache.get(finalMsgId)!;
    }

    const senderId = String(task.senderId || (task.sender === "ME" ? "ME" : convId));

    // 1. Đảm bảo Parent Conversation tồn tại (3NF Deterministic Stubbing)
    const existingConv = serverStorage.getConversation(convId);
    if (!existingConv) {
      const isGroup = convId.startsWith("g_") || (task.conversationName && task.conversationName.includes("Nhóm"));
      const stubConv: StoredConversation = {
        id: convId,
        name: task.conversationName || (isGroup ? `Nhóm ${convId.slice(-4)}` : `Hội thoại ${convId.slice(-4)}`),
        avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(task.conversationName || convId)}`,
        type: isGroup ? "GROUP" : "DIRECT",
        lastMessage: task.textContent || `[${task.type || "Tin nhắn"}]`,
        lastTimestamp: task.timestamp || Date.now(),
        unreadCount: 0,
      };
      serverStorage.saveConversations([stubConv]);

      this.emitCdcEvent({
        op: "INSERT",
        table: "conversations",
        data: stubConv,
        timestamp: Date.now(),
      });
    }

    // 2. Đảm bảo Sender Contact tồn tại trong danh bạ (3NF Contact Normalization)
    if (senderId && !serverStorage.getContact(senderId)) {
      const stubContact: StoredContact = {
        id: senderId,
        displayName: task.senderName || (senderId === "ME" ? "Tôi" : `Thành viên ${senderId.slice(-4)}`),
        avatarUrl: task.senderAvatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(senderId)}`,
        isStub: true,
        updatedAt: Date.now(),
      };
      serverStorage.saveContacts([stubContact]);

      this.emitCdcEvent({
        op: "INSERT",
        table: "contacts",
        data: stubContact,
        timestamp: Date.now(),
      });
    }

    // 3. Làm sạch và chuẩn hóa tin nhắn
    const cleaned = cleanMessageContent(task.textContent);
    const messageData: StoredMessage = {
      msgId: finalMsgId,
      conversationId: convId,
      senderId: senderId,
      senderName: task.senderName,
      senderAvatar: task.senderAvatar,
      textContent: cleaned.cleanText,
      sender: task.sender,
      status: task.status || "DELIVERED",
      timestamp: typeof task.timestamp === "number" ? task.timestamp : Date.now(),
      type: task.type || (task.mediaUrl ? "IMAGE" : "TEXT"),
      mediaUrl: task.mediaUrl,
      mediaName: task.mediaName,
      mediaSize: task.mediaSize,
      reactions: (task.reactions && task.reactions.length > 0) ? task.reactions : (cleaned.reactions.length > 0 ? cleaned.reactions : undefined),
      mentions: (task.mentions && task.mentions.length > 0) ? task.mentions : (cleaned.mentions.length > 0 ? cleaned.mentions : undefined),
    };

    const saved = await serverStorage.addMessage(messageData);

    this.emitCdcEvent({
      op: "INSERT",
      table: "messages",
      data: saved,
      timestamp: Date.now(),
    });

    return saved;
  }

  private emitCdcEvent(event: CdcEvent) {
    this.emit("cdc_event", event);
  }

  private startWorkerLoop() {
    setInterval(() => {
      if (this.tier1RealtimeQueue.length > 0 || this.tier2BulkQueue.length > 0) {
        this.triggerProcessing();
      }
    }, 100);
  }
}

export const singleWriterQueue = new SingleWriterQueueEngine();
