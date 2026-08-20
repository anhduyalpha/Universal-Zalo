import { cdpClient } from "./cdp_client.js";
import { singleWriterQueue, IngestionMessageTask } from "./queue_writer.js";
import EventEmitter from "events";

/**
 * IN-CONTEXT HOOKING & IN-BROWSER EDGE FILTERING ENGINE (Phase 2 Core Architecture)
 * - Tự động thiết lập CDP Runtime Binding: `emitRealtimeEvent` & `emitZaloChunk`
 * - Tiêm script hook trực tiếp vào Execution Context của Chromium
 * - Lọc bỏ nhiễu (Heartbeat, Typing indicators, Presence ticks) trực tiếp tại Browser Engine
 * - Hút dữ liệu sạch sau khi Zalo Web đã giải mã (Decrypted JSON DTOs)
 * - Eager Blob Materialization: Chuyển đổi Blob URLs sang binary payload ngay trong browser
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
      console.log("⚡ [In-Context Hook] Initialized decrypted real-time listener & edge filter.");
    } catch (err: any) {
      console.warn("[In-Context Hook Warning] Initialization retry scheduled:", err.message);
      setTimeout(() => this.initialize(), 3000);
    }
  }

  private async injectBrowserHook() {
    const hookScript = `
      (() => {
        if (window.__ZALO_HOOK_INITIALIZED__) return;
        window.__ZALO_HOOK_INITIALIZED__ = true;

        console.log("🚀 [Zalo In-Context Hook] Initializing In-Browser Edge Filter & Event Bridge...");

        // 1. Hàng đợi đệm Micro-Batching 100ms
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
          eventBuffer.push(eventData);
          if (!flushTimer) {
            flushTimer = setTimeout(flushBuffer, 100);
          }
        };

        // 2. Eager Blob Materializer: Đọc Blob thành Base64 tức thì
        const materializeBlob = async (blobUrl) => {
          try {
            const res = await fetch(blobUrl);
            const blob = await res.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
          } catch (e) {
            return null;
          }
        };

        // 3. Hook Redux Dispatcher / Global App State
        const checkAndHookRedux = () => {
          if (window.appStore && typeof window.appStore.subscribe === 'function') {
            let lastState = null;
            window.appStore.subscribe(() => {
              try {
                const state = window.appStore.getState();
                // Bắt các action tin nhắn mới
                if (state && state.chat && state.chat.activeMessage) {
                  const msg = state.chat.activeMessage;
                  if (msg && msg.msgId && (!lastState || lastState.msgId !== msg.msgId)) {
                    lastState = msg;
                    enqueueEvent({
                      msgId: String(msg.msgId || msg.id || msg.cliMsgId),
                      conversationId: String(msg.threadId || msg.convId || "general"),
                      textContent: msg.message || msg.content || msg.text || "",
                      sender: (msg.isMe || msg.fromMe) ? "ME" : "OTHER",
                      senderName: msg.senderName || msg.displayName,
                      timestamp: Number(msg.timestamp || msg.ts || Date.now()),
                      type: msg.msgType || msg.type || "TEXT",
                      mediaUrl: msg.mediaUrl || msg.url || null,
                    });
                  }
                }
              } catch (err) {}
            });
            console.log("✅ [Zalo In-Context Hook] Redux State listener attached.");
          }
        };

        // 4. Hook WebSocket.prototype để bắt tin nhắn đã giải mã
        const originalAddEventListener = WebSocket.prototype.addEventListener;
        WebSocket.prototype.addEventListener = function(type, listener, options) {
          if (type === 'message') {
            const wrappedListener = function(event) {
              try {
                if (typeof event.data === 'string' && event.data.startsWith('{')) {
                  const data = JSON.parse(event.data);
                  // Lọc bỏ Heartbeat / Typing / Presence noise
                  if (data && data.data && (data.data.msgId || data.data.content || data.data.msgBody)) {
                    const msg = data.data;
                    enqueueEvent({
                      msgId: String(msg.msgId || msg.globalMsgId || msg.id || Date.now()),
                      conversationId: String(msg.threadId || msg.convId || msg.toId || "general"),
                      textContent: msg.content || msg.message || msg.text || msg.msgBody || "",
                      sender: (msg.isMe || msg.fromMe || msg.senderType === 1) ? "ME" : "OTHER",
                      timestamp: Number(msg.timestamp || msg.ts || Date.now()),
                      type: msg.msgType || msg.type || "TEXT",
                      mediaUrl: msg.mediaUrl || msg.url || null,
                    });
                  }
                }
              } catch (e) {}
              return listener.apply(this, arguments);
            };
            return originalAddEventListener.call(this, type, wrappedListener, options);
          }
          return originalAddEventListener.call(this, type, listener, options);
        };

        setInterval(checkAndHookRedux, 2000);
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
            const task: IngestionMessageTask = {
              msgId: ev.msgId,
              conversationId: ev.conversationId,
              textContent: ev.textContent || "",
              sender: ev.sender || "OTHER",
              senderName: ev.senderName,
              status: "DELIVERED",
              timestamp: ev.timestamp || Date.now(),
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
