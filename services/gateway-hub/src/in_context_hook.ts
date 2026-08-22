import { cdpClient } from "./cdp_client.js";
import { singleWriterQueue, IngestionMessageTask } from "./queue_writer.js";
import { isBase64Ciphertext, cleanMessageContent } from "./normalizer.js";
import EventEmitter from "events";

/**
 * IN-CONTEXT HOOKING & UNIVERSAL HEADLESS OUTBOUND DISPATCHER (Phases 1, 2, 3)
 * - IDBObjectStore.prototype Hooking: Bắt trực tiếp tin nhắn đã giải mã khi Zalo ghi vào IndexedDB
 * - Ciphertext Shield: Nhận diện và ngăn chặn lưu chuỗi Base64 chưa giải mã vào Database
 * - Webpack Chunk Tapper: Khai thác store nội bộ của Zalo qua webpackChunkzalo_chat_web
 * - Universal Outbound Dispatcher: Tự động chuyển hội thoại và gửi tin nhắn an toàn
 */
export class InContextHookEngine extends EventEmitter {
  private isInitialized = false;

  public async initialize() {
    if (this.isInitialized) return;

    try {
      // 1. Đăng ký CDP Native Runtime Bindings
      await cdpClient.send("Runtime.addBinding", { name: "emitRealtimeEvent" });
      await cdpClient.send("Runtime.addBinding", { name: "emitZaloChunk" });

      // 2. Lắng nghe sự kiện binding từ Chromium
      cdpClient.on("binding_called", (payload: { name: string; payload: string }) => {
        this.handleBindingEvent(payload.name, payload.payload);
      });

      // 3. Tiêm Script Hook vào Chromium Context
      await this.injectBrowserHook();

      this.isInitialized = true;
      console.log("⚡ [In-Context Hook] Initialized Universal IDB Hook & Ciphertext Shield.");
    } catch (err: any) {
      console.warn("[In-Context Hook Warning] Initialization retry scheduled:", err.message);
      setTimeout(() => this.initialize(), 3000);
    }
  }

  public async sendHeadlessMessage(
    targetId: string,
    content: string,
    meta?: Record<string, any>
  ): Promise<{ success: boolean; error?: string; serverMsgId?: string }> {
    const script = `
      (async () => {
        try {
          if (typeof window.__INJECTED_SEND__ === 'function') {
            return await window.__INJECTED_SEND__(${JSON.stringify(targetId)}, ${JSON.stringify(content)}, ${JSON.stringify(meta || {})});
          }
          return { success: false, error: "window.__INJECTED_SEND__ not initialized yet" };
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()
    `;

    try {
      const evalRes = await cdpClient.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });
      return evalRes?.result?.value || { success: false, error: "No response from Chromium" };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async injectBrowserHook() {
    const hookScript = `
      (() => {
        if (window.__ZALO_ENTERPRISE_HOOK_INITIALIZED__) return;
        window.__ZALO_ENTERPRISE_HOOK_INITIALIZED__ = true;

        console.log("🚀 [Universal Zalo] Injected Universal IDB Hook & Ciphertext Shield...");

        // 1. Recursive String ID Sanitizer
        const sanitizeIdsToString = (obj) => {
          if (!obj || typeof obj !== 'object') return obj;
          for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (val !== null && typeof val === 'object') {
              sanitizeIdsToString(val);
            } else if (
              (key.toLowerCase().includes('id') || key.toLowerCase().includes('uid') || key === 'grid' || key === 'fromuid' || key === 'touid') &&
              (typeof val === 'number' || typeof val === 'bigint')
            ) {
              obj[key] = val.toString();
            }
          }
          return obj;
        };

        // Helper nhận diện chuỗi mã hóa Ciphertext Base64
        const isCipher = (text) => {
          if (!text || typeof text !== 'string') return false;
          const trimmed = text.trim();
          if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(trimmed)) return true;
          if (trimmed.startsWith('{') && (trimmed.includes('"params"') || trimmed.includes('"cipher"'))) return true;
          return false;
        };

        // 2. Micro-Batching Buffer 100ms
        const eventBuffer = [];
        let flushTimer = null;

        const flushBuffer = () => {
          if (eventBuffer.length > 0 && typeof window.emitRealtimeEvent === 'function') {
            const batch = eventBuffer.splice(0, eventBuffer.length);
            window.emitRealtimeEvent(JSON.stringify({ type: "BATCH_EVENTS", events: batch }));
          }
          flushTimer = null;
        };

        const enqueueEvent = (eventData) => {
          sanitizeIdsToString(eventData);
          eventBuffer.push(eventData);
          if (!flushTimer) {
            flushTimer = setTimeout(flushBuffer, 100);
          }
        };

        // 3. WEBPACK CHUNK TAPPER: Khai thác Redux Store nội bộ của Zalo Web
        try {
          if (window.webpackChunkzalo_chat_web && Array.isArray(window.webpackChunkzalo_chat_web)) {
            window.webpackChunkzalo_chat_web.push([
              [Symbol()],
              {},
              (req) => {
                try {
                  for (const key of Object.keys(req.c)) {
                    const mod = req.c[key]?.exports;
                    if (!mod) continue;
                    if (mod.default?.dispatch && mod.default?.getState) {
                      window.__ZALO_REDUX_STORE__ = mod.default;
                    } else if (mod.dispatch && mod.getState) {
                      window.__ZALO_REDUX_STORE__ = mod;
                    }
                  }
                } catch (e) {}
              }
            ]);
          }
        } catch (e) {}

        // 4. UNIVERSAL HEADLESS OUTBOUND DISPATCHER
        window.__INJECTED_SEND__ = async (targetId, content, meta = {}) => {
          const strTargetId = String(targetId);
          console.log("[Headless Dispatcher] Sending message to target:", strTargetId, content);

          // Cách 1: Thử dispatch qua Redux Store nếu bắt được
          const store = window.__ZALO_REDUX_STORE__ || window.appStore || window.zaloStore;
          if (store && typeof store.dispatch === 'function') {
            try {
              store.dispatch({
                type: "CHAT_SEND_MESSAGE",
                payload: {
                  threadId: strTargetId,
                  toId: strTargetId,
                  message: content,
                  ...meta,
                }
              });
              return { success: true, method: "REDUX_DISPATCH" };
            } catch (rErr) {}
          }

          // Cách 2: Tự động chuyển hội thoại và gõ phím mô phỏng
          try {
            const convItems = document.querySelectorAll('.conv-item, [data-id], .chat-item, .nav-tabs-item');
            for (const item of convItems) {
              const text = item.textContent || "";
              const idAttr = item.getAttribute('data-id') || item.getAttribute('id') || "";
              if (idAttr.includes(strTargetId) || text.includes(strTargetId)) {
                item.click();
                await new Promise(r => setTimeout(r, 200));
                break;
              }
            }

            const editor = document.querySelector('[contenteditable="true"]') || 
                           document.querySelector('#chat-input-editor') ||
                           document.querySelector('.rich-input__box') ||
                           document.querySelector('textarea');

            if (editor) {
              editor.focus();
              
              if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
                document.execCommand('insertText', false, content);
              } else {
                editor.innerText = content;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
              }

              await new Promise(r => setTimeout(r, 100));

              const enterDown = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              });
              editor.dispatchEvent(enterDown);

              const enterUp = new KeyboardEvent('keyup', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              });
              editor.dispatchEvent(enterUp);

              const sendBtn = document.querySelector('.btn-send, [title*="Gửi"], [aria-label*="Gửi"], .send-icon');
              if (sendBtn) {
                sendBtn.click();
              }

              return { success: true, method: "SYNTHETIC_DOM_DISPATCH" };
            }
          } catch (domErr) {
            return { success: false, error: domErr.message };
          }

          return { success: false, error: "Unable to find message input or dispatcher" };
        };

        // 5. IDBObjectStore.prototype HOOKING VỚI CIPHERTEXT SHIELD
        if (window.IDBObjectStore && window.IDBObjectStore.prototype) {
          const originalPut = IDBObjectStore.prototype.put;
          const originalAdd = IDBObjectStore.prototype.add;

          const inspectAndEnqueue = (value, storeName) => {
            try {
              if (value && typeof value === 'object') {
                let rawMsg = value.message || value.content || value.text || value.msgBody || value.data;
                const msgId = value.msgId || value.globalMsgId || value.id || value.cliMsgId;

                // Nếu rawMsg là ciphertext, thử lấy từ các trường text đã giải mã khác
                if (typeof rawMsg === 'string' && isCipher(rawMsg)) {
                  if (value.msgBody && typeof value.msgBody.text === 'string' && !isCipher(value.msgBody.text)) {
                    rawMsg = value.msgBody.text;
                  } else if (value.desc && typeof value.desc === 'string' && !isCipher(value.desc)) {
                    rawMsg = value.desc;
                  } else if (value.title && typeof value.title === 'string' && !isCipher(value.title)) {
                    rawMsg = value.title;
                  } else {
                    rawMsg = "[Tin nhắn mã hóa E2EE]";
                  }
                }

                if (msgId && (rawMsg || value.mediaUrl || value.url || value.thumbUrl || value.msgType)) {
                  const isMe = Boolean(value.isMe || value.fromMe || value.senderType === 1);
                  const isGroup = Boolean(value.grid || (value.threadId && String(value.threadId).startsWith('g_')));
                  const convId = isGroup 
                    ? String(value.grid || value.threadId)
                    : String(value.uid || value.threadId || value.toId || "general");
                  const senderId = isMe ? "ME" : String(value.fromUid || value.fromId || value.uid || convId);

                  enqueueEvent({
                    msgId: String(msgId),
                    conversationId: convId,
                    senderId: senderId,
                    senderName: value.senderName || value.displayName || value.name,
                    senderAvatar: value.avatar || value.senderAvatar,
                    textContent: typeof rawMsg === 'string' ? rawMsg : (rawMsg ? JSON.stringify(rawMsg) : ""),
                    sender: isMe ? "ME" : "OTHER",
                    timestamp: Number(value.timestamp || value.ts || value.sendTime) || Date.now(),
                    type: value.msgType || value.type || (value.mediaUrl ? "IMAGE" : "TEXT"),
                    mediaUrl: value.mediaUrl || value.url || null,
                  });
                }
              }
            } catch (err) {}
          };

          IDBObjectStore.prototype.put = function(value, key) {
            inspectAndEnqueue(value, this.name);
            return originalPut.apply(this, arguments);
          };

          IDBObjectStore.prototype.add = function(value, key) {
            inspectAndEnqueue(value, this.name);
            return originalAdd.apply(this, arguments);
          };
        }
      })();
    `;

    await cdpClient.send("Page.addScriptToEvaluateOnNewDocument", { source: hookScript });
    await cdpClient.send("Runtime.evaluate", { expression: hookScript });
  }

  private handleBindingEvent(name: string, payloadStr: string) {
    if (name === "emitRealtimeEvent") {
      try {
        const payload = JSON.parse(payloadStr);
        if (payload.type === "BATCH_EVENTS" && Array.isArray(payload.events)) {
          for (const ev of payload.events) {
            let text = ev.textContent || "";
            if (isBase64Ciphertext(text)) {
              text = "[Tin nhắn mã hóa E2EE]";
            }

            const task: IngestionMessageTask = {
              msgId: String(ev.msgId),
              conversationId: String(ev.conversationId),
              senderId: String(ev.senderId),
              senderName: ev.senderName,
              senderAvatar: ev.senderAvatar,
              textContent: text,
              sender: ev.sender || "OTHER",
              status: "DELIVERED",
              timestamp: Number(ev.timestamp) || Date.now(),
              type: ev.type || "TEXT",
              mediaUrl: ev.mediaUrl,
            };
            singleWriterQueue.enqueueRealtime(task);
          }
        }
      } catch (err) {}
    }
  }
}

export const inContextHook = new InContextHookEngine();
