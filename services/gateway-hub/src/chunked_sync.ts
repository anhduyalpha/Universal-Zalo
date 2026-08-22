import { cdpClient } from "./cdp_client.js";
import { singleWriterQueue, IngestionMessageTask } from "./queue_writer.js";
import { serverStorage } from "./storage.js";
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const CURSOR_FILE = path.join(DATA_DIR, "sync_cursors.json");

export interface SyncCursorState {
  lastSyncTimestamp: number;
  lastMsgId?: string;
  totalSynced: number;
  status: "IDLE" | "SYNCING" | "COMPLETED" | "ERROR";
}

/**
 * 3NF UNIVERSAL IDBCURSOR BATCH SYNC ENGINE (Phases 1 & 2)
 * - Quét toàn bộ ObjectStores trong mọi IndexedDB databases
 * - IDBCursor Bounded Pagination (500 records/chunk)
 * - Tự động nhận diện và trích xuất Conversation, Contact, Message
 */
export class ChunkedSyncEngine {
  private cursors: Record<string, SyncCursorState> = {};

  constructor() {
    this.loadCursors();
  }

  private loadCursors() {
    try {
      if (fs.existsSync(CURSOR_FILE)) {
        this.cursors = JSON.parse(fs.readFileSync(CURSOR_FILE, "utf-8"));
      }
    } catch (e) {
      this.cursors = {};
    }
  }

  public saveCursors() {
    try {
      fs.writeFileSync(CURSOR_FILE, JSON.stringify(this.cursors, null, 2), "utf-8");
    } catch (e) {}
  }

  public getCursor(convId: string): SyncCursorState {
    return this.cursors[String(convId)] || {
      lastSyncTimestamp: 0,
      totalSynced: 0,
      status: "IDLE",
    };
  }

  public updateCursor(convId: string, patch: Partial<SyncCursorState>) {
    const strId = String(convId);
    this.cursors[strId] = {
      ...this.getCursor(strId),
      ...patch,
      lastSyncTimestamp: Date.now(),
    };
    this.saveCursors();
  }

  public async executeChunkedSync(
    onProgress?: (percent: number, log: string) => void
  ): Promise<{ totalMessages: number; totalConversations: number }> {
    console.log("⚡ [Chunked Sync] Starting Universal 3NF IDBCursor sync...");

    const script = `
      (async () => {
        try {
          const summary = { totalMessages: 0, totalConversations: 0 };
          if (!window.indexedDB || typeof window.indexedDB.databases !== 'function') {
            return summary;
          }

          const sanitizeId = (id) => {
            if (id === null || id === undefined) return "";
            return String(id).trim();
          };

          const dbs = await window.indexedDB.databases();
          for (const dbInfo of dbs) {
            if (!dbInfo.name) continue;
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbInfo.name);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });

              const storeNames = Array.from(db.objectStoreNames);
              for (const storeName of storeNames) {
                try {
                  await new Promise((resolve) => {
                    const tx = db.transaction(storeName, "readonly");
                    const store = tx.objectStore(storeName);
                    const req = store.openCursor();

                    let batch = [];
                    const BATCH_LIMIT = 500;

                    req.onsuccess = async (e) => {
                      const cursor = e.target.result;
                      if (cursor) {
                        const val = cursor.value;
                        if (val && typeof val === 'object') {
                          let rawMsg = val.message || val.content || val.text || val.msgBody || val.data;
                          const msgId = val.msgId || val.globalMsgId || val.id || val.cliMsgId;

                          const isCipher = (text) => {
                            if (!text || typeof text !== 'string') return false;
                            const trimmed = text.trim();
                            if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(trimmed)) return true;
                            if (trimmed.startsWith('{') && (trimmed.includes('"params"') || trimmed.includes('"cipher"'))) return true;
                            return false;
                          };

                          if (typeof rawMsg === 'string' && isCipher(rawMsg)) {
                            if (val.msgBody && typeof val.msgBody.text === 'string' && !isCipher(val.msgBody.text)) {
                              rawMsg = val.msgBody.text;
                            } else if (val.desc && typeof val.desc === 'string' && !isCipher(val.desc)) {
                              rawMsg = val.desc;
                            } else if (val.title && typeof val.title === 'string' && !isCipher(val.title)) {
                              rawMsg = val.title;
                            } else {
                              rawMsg = "[Tin nhắn mã hóa E2EE]";
                            }
                          }

                          if (msgId && (rawMsg || val.mediaUrl || val.url || val.thumbUrl || val.msgType)) {
                            const isMe = Boolean(val.isMe || val.fromMe || val.senderType === 1);
                            const isGroup = Boolean(val.grid || (val.threadId && String(val.threadId).startsWith('g_')));
                            const convId = isGroup 
                              ? sanitizeId(val.grid || val.threadId)
                              : sanitizeId(val.uid || val.threadId || val.toId || "general");
                            const senderId = isMe ? "ME" : sanitizeId(val.fromUid || val.fromId || val.uid || convId);

                            batch.push({
                              msgId: sanitizeId(msgId),
                              conversationId: convId,
                              senderId: senderId,
                              senderName: val.senderName || val.displayName || val.name,
                              senderAvatar: val.avatar || val.senderAvatar,
                              textContent: typeof rawMsg === 'string' ? rawMsg : (rawMsg ? JSON.stringify(rawMsg) : ""),
                              sender: isMe ? "ME" : "OTHER",
                              timestamp: Number(val.timestamp || val.ts || val.sendTime) || Date.now(),
                              type: val.msgType || val.type || (val.mediaUrl ? "IMAGE" : "TEXT"),
                              mediaUrl: val.mediaUrl || val.url || null,
                            });
                          }
                        }

                        if (batch.length >= BATCH_LIMIT) {
                          summary.totalMessages += batch.length;
                          if (typeof window.emitZaloChunk === 'function') {
                            window.emitZaloChunk(JSON.stringify({ store: storeName, chunk: batch }));
                          }
                          batch = [];
                        }

                        cursor.continue();
                      } else {
                        if (batch.length > 0) {
                          summary.totalMessages += batch.length;
                          if (typeof window.emitZaloChunk === 'function') {
                            window.emitZaloChunk(JSON.stringify({ store: storeName, chunk: batch }));
                          }
                        }
                        resolve(true);
                      }
                    };

                    req.onerror = () => resolve(false);
                  });
                } catch (sErr) {}
              }
              db.close();
            } catch (dbErr) {}
          }
          return summary;
        } catch (e) {
          return { totalMessages: 0, totalConversations: 0, error: e.message };
        }
      })()
    `;

    const chunkHandler = (payload: { name: string; payload: string }) => {
      if (payload.name === "emitZaloChunk") {
        try {
          const data = JSON.parse(payload.payload);
          if (data && Array.isArray(data.chunk)) {
            const tasks: IngestionMessageTask[] = data.chunk.map((item: any) => ({
              msgId: String(item.msgId),
              conversationId: String(item.conversationId),
              senderId: String(item.senderId),
              senderName: item.senderName,
              senderAvatar: item.senderAvatar,
              textContent: item.textContent,
              sender: item.sender,
              status: "DELIVERED",
              timestamp: Number(item.timestamp) || Date.now(),
              type: item.type,
              mediaUrl: item.mediaUrl,
            }));
            singleWriterQueue.enqueueBulkBatch(tasks);
          }
        } catch (err) {}
      }
    };

    cdpClient.on("binding_called", chunkHandler);

    try {
      const evalRes = await cdpClient.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });

      const result = evalRes?.result?.value || { totalMessages: 0, totalConversations: 0 };
      onProgress?.(100, `✅ Đã trích xuất ${result.totalMessages} tin nhắn chuẩn 3NF.`);
      return result;
    } finally {
      cdpClient.removeListener("binding_called", chunkHandler);
    }
  }
}

export const chunkedSync = new ChunkedSyncEngine();
