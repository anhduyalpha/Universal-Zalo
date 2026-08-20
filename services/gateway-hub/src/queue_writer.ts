import { serverStorage, StoredMessage, StoredConversation } from "./storage.js";
import { cleanMessageContent, ParsedReaction, MentionToken } from "./normalizer.js";
import EventEmitter from "events";

export interface CdcEvent {
  op: "INSERT" | "UPDATE" | "DELETE";
  table: "messages" | "conversations";
  data: StoredMessage | StoredConversation;
  timestamp: number;
}

export interface IngestionMessageTask {
  msgId: string;
  conversationId: string;
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

/**
 * DUAL-TIER SINGLE-WRITER TRANSACTIONAL QUEUE & CDC ENGINE (Phase 3 Core Architecture)
 * - Tier 1: Real-Time High-Priority Queue (drained with 0ms latency)
 * - Tier 2: Bulk Historical Low-Priority Queue (processed in 500-item micro-batches)
 * - Deterministic Conversation Stubbing (prevents Foreign Key race conditions)
 * - Monotonic Causal Clock Guard (prevents older historical chunks from overwriting real-time updates)
 * - Change Data Capture (CDC) Event Stream over WebSocket
 */
export class SingleWriterQueueEngine extends EventEmitter {
  private tier1RealtimeQueue: IngestionMessageTask[] = [];
  private tier2BulkQueue: IngestionMessageTask[] = [];
  private isProcessing = false;
  private idResolutionCache = new Map<string, string>(); // cliMsgId -> globalMsgId
  private conversationStubs = new Set<string>();

  constructor() {
    super();
    this.startWorkerLoop();
  }

  /**
   * Đẩy tin nhắn Real-time vào Hàng Đợi Ưu Tiên Cao (Tier 1)
   */
  public enqueueRealtime(task: IngestionMessageTask) {
    task.isRealtime = true;
    this.tier1RealtimeQueue.push(task);
    this.triggerProcessing();
  }

  /**
   * Đẩy lô tin nhắn Bulk Sync vào Hàng Đợi Nền (Tier 2)
   */
  public enqueueBulkBatch(tasks: IngestionMessageTask[]) {
    for (const t of tasks) {
      t.isRealtime = false;
      this.tier2BulkQueue.push(t);
    }
    this.triggerProcessing();
  }

  /**
   * Đăng ký ánh xạ ID lạc quan (Optimistic cliMsgId -> Authoritative globalMsgId)
   */
  public registerIdMapping(cliMsgId: string, globalMsgId: string) {
    if (cliMsgId && globalMsgId) {
      this.idResolutionCache.set(cliMsgId, globalMsgId);
    }
  }

  private triggerProcessing() {
    if (!this.isProcessing) {
      this.isProcessing = true;
      setImmediate(() => this.processNextBatch());
    }
  }

  private async processNextBatch() {
    try {
      // 1. Luôn rút cạn toàn bộ hàng đợi Real-time (Tier 1) trước
      while (this.tier1RealtimeQueue.length > 0) {
        const task = this.tier1RealtimeQueue.shift()!;
        await this.writeSingleMessage(task);
      }

      // 2. Khi Tier 1 trống, xử lý micro-batch tối đa 500 mục từ Tier 2
      if (this.tier2BulkQueue.length > 0) {
        const microBatchSize = Math.min(500, this.tier2BulkQueue.length);
        const batch = this.tier2BulkQueue.splice(0, microBatchSize);

        for (const task of batch) {
          // Nếu có tin nhắn real-time mới xuất hiện giữa chừng, ưu tiên ngắt để xử lý Tier 1 ngay
          if (this.tier1RealtimeQueue.length > 0) {
            const urgentTask = this.tier1RealtimeQueue.shift()!;
            await this.writeSingleMessage(urgentTask);
          }
          await this.writeSingleMessage(task);
        }

        // Lưu trạng thái xuống đĩa sau mỗi micro-batch
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

  /**
   * Ghi 1 tin nhắn nguyên tử với Deterministic Stubbing & Monotonic Causal Consistency
   */
  private async writeSingleMessage(task: IngestionMessageTask): Promise<StoredMessage | null> {
    const convId = task.conversationId || "general";

    // 1. Ánh xạ ID từ bảng phân giải cliMsgId -> globalMsgId
    let finalMsgId = task.msgId;
    if (this.idResolutionCache.has(finalMsgId)) {
      finalMsgId = this.idResolutionCache.get(finalMsgId)!;
    }

    // 2. Deterministic Conversation Stubbing (Chống lỗi Foreign Key Constraint / Orphaned Records)
    const existingConvs = serverStorage.getConversations();
    const convExists = existingConvs.some((c) => c.id === convId);

    if (!convExists && !this.conversationStubs.has(convId)) {
      const stubConv: StoredConversation = {
        id: convId,
        name: task.conversationName || `Hội thoại ${convId.substring(0, 8)}`,
        avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(task.conversationName || convId)}`,
        type: (task.conversationName && task.conversationName.includes("Nhóm")) ? "GROUP" : "DIRECT",
        lastMessage: task.textContent || `[${task.type || "Tin nhắn"}]`,
        lastTimestamp: task.timestamp || Date.now(),
        unreadCount: 0,
      };
      serverStorage.saveConversations([stubConv]);
      this.conversationStubs.add(convId);

      // Phát sự kiện CDC cho Conversation mới
      this.emitCdcEvent({
        op: "INSERT",
        table: "conversations",
        data: stubConv,
        timestamp: Date.now(),
      });
    }

    // 3. Làm sạch dữ liệu và bóc tách reaction/emoticons/mentions
    const cleaned = cleanMessageContent(task.textContent);

    const messageData: StoredMessage = {
      msgId: finalMsgId,
      conversationId: convId,
      textContent: cleaned.cleanText,
      sender: task.sender,
      senderName: task.senderName,
      senderAvatar: task.senderAvatar,
      status: task.status || "DELIVERED",
      timestamp: typeof task.timestamp === "number" ? task.timestamp : Date.now(),
      type: task.type || (task.mediaUrl ? "IMAGE" : "TEXT"),
      mediaUrl: task.mediaUrl,
      mediaName: task.mediaName,
      mediaSize: task.mediaSize,
      reactions: (task.reactions && task.reactions.length > 0) ? task.reactions : (cleaned.reactions.length > 0 ? cleaned.reactions : undefined),
      mentions: (task.mentions && task.mentions.length > 0) ? task.mentions : (cleaned.mentions.length > 0 ? cleaned.mentions : undefined),
    };

    // 4. Ghi nguyên tử vào Server Storage với Monotonic Causal Check
    const saved = await serverStorage.addMessage(messageData);

    // 5. Phát sự kiện Change Data Capture (CDC) đến các Client PWA
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
