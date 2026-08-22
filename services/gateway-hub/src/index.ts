import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { TokenBucketLimiter } from "./token_bucket.js";
import { HybridLogicalClock } from "./hlc.js";
import { nanoid } from "nanoid";
import { serverStorage, StoredMessage, StoredConversation, StoredContact } from "./storage.js";
import { cleanMessageContent } from "./normalizer.js";
import { executeFullMasterResync, scrapeConversationWithHistory, extractSidebarConversations } from "./crawler.js";
import { cdpClient } from "./cdp_client.js";
import { singleWriterQueue, CdcEvent } from "./queue_writer.js";
import { inContextHook } from "./in_context_hook.js";
import { chunkedSync } from "./chunked_sync.js";
import { zaloNetworkClient } from "./zalo_network_client.js";
import { sessionAuthManager } from "./session_auth.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

interface ClientMessage {
  type: "SEND_MESSAGE" | "PING" | "CLICK" | "TYPE" | "WHEEL" | "START_STREAM" | "STOP_STREAM" | "SELECT_CONVERSATION" | "START_LIVE_SYNC" | "OUTBOUND_SEND";
  conversationId?: string;
  targetId?: string;
  conversationName?: string;
  textContent?: string;
  idempotencyKey?: string;
  clientMsgId?: string;
  mediaUrl?: string;
  mediaType?: "TEXT" | "IMAGE" | "VIDEO" | "FILE" | "VOICE" | "STICKER";
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
}

const PORT = 8080;
const limiter = new TokenBucketLimiter(10, 4);
const hlc = new HybridLogicalClock();
const connectedClients = new Set<WebSocket>();
const streamingClients = new Set<WebSocket>();
const sseClients = new Set<http.ServerResponse>();

// Khởi tạo kết nối CDP Singleton Pool & Network Client Auto-Login
cdpClient.connect().then(() => {
  inContextHook.initialize().catch((err) => {
    console.warn("In-context hook initialization notice:", err.message);
  });

  // Tự động kiểm tra session cookies từ Chromium và khởi tạo Zalo Network API
  const sessionCheckTimer = setInterval(async () => {
    if (!zaloNetworkClient.isReady()) {
      const ok = await zaloNetworkClient.initFromBrowserSession();
      if (ok) {
        console.log("⚡ [Gateway Hub] Pure Network Engine active & ready for bi-directional messaging.");
      }
    }
  }, 4000);
}).catch((err) => {
  console.warn("Initial CDP connect attempt:", err.message);
});

// Hook Screencast frames trực tiếp từ Singleton CDP Client
cdpClient.on("screencast_frame", (base64Data: string) => {
  if (streamingClients.size === 0) return;
  const framePayload = JSON.stringify({
    event: "SCREENCAST_FRAME",
    data: base64Data,
    timestamp: Date.now(),
  });

  for (const client of streamingClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(framePayload);
    }
  }
});

// Lắng nghe thay đổi trạng thái Hydration FSM để phát tới SSE Clients
serverStorage.on("state_changed", (stateInfo) => {
  const sseData = `data: ${JSON.stringify(stateInfo)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(sseData);
    } catch (e) {}
  }
});

// Hook Real-time Change Data Capture (CDC) events từ Single-Writer Engine
singleWriterQueue.on("cdc_event", (cdcEvent: CdcEvent) => {
  const cdcPayload = JSON.stringify({
    event: "CDC_EVENT",
    ...cdcEvent,
    hlc: hlc.now(),
  });

  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(cdcPayload);
    }
  }

  // Phát thêm fanout tương thích cho client cũ
  if (cdcEvent.table === "messages") {
    const msg = cdcEvent.data as StoredMessage;
    const fanout = JSON.stringify({
      event: "MESSAGE_FANOUT",
      msgId: msg.msgId,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      textContent: msg.textContent,
      sender: msg.sender,
      mediaUrl: msg.mediaUrl,
      type: msg.type,
      hlc: hlc.now(),
    });
    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(fanout);
      }
    }
  }
});

// Lắng nghe cập nhật trạng thái Outbound từ Single-Writer Queue
singleWriterQueue.on("outbound_status", (statusUpdate) => {
  const payload = JSON.stringify({
    event: "OUTBOUND_STATUS_UPDATE",
    ...statusUpdate,
    timestamp: Date.now(),
  });
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
});

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function generateSvgAvatar(name: string): string {
  const cleanName = (name || "Zalo").trim();
  const initial = cleanName.charAt(0).toUpperCase() || "Z";
  const colors = ["#0068ff", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#3b82f6", "#06b6d4"];
  let hash = 0;
  for (let i = 0; i < cleanName.length; i++) {
    hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = colors[Math.abs(hash) % colors.length];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="50" fill="${color}" />
    <text x="50" y="58" font-size="44" font-family="system-ui, sans-serif" font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${initial}</text>
  </svg>`;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. HYDRATION GATEKEEPER SSE STATUS ENDPOINT (`/api/sync/status`)
  if (req.url === "/api/sync/status" || req.url === "/sync/status") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    sseClients.add(res);

    // Gửi trạng thái hiện tại ngay khi kết nối
    res.write(`data: ${JSON.stringify(serverStorage.getHydrationState())}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. AVATAR PROXY ENDPOINT (`/api/media/avatar`)
  if (req.url?.startsWith("/api/media/avatar") || req.url?.startsWith("/media/avatar")) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const contactId = urlObj.searchParams.get("id") || "";
    const name = urlObj.searchParams.get("name") || "Z";

    const contact = contactId ? serverStorage.getContact(contactId) : undefined;
    const targetUrl = contact?.avatarUrl || urlObj.searchParams.get("url");

    if (!targetUrl || targetUrl.includes("dicebear")) {
      const svg = generateSvgAvatar(contact?.displayName || name);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(svg);
      return;
    }

    try {
      const mediaData = await sessionAuthManager.fetchZaloMedia(targetUrl);
      if (mediaData && mediaData.buffer.length > 0) {
        res.writeHead(200, {
          "Content-Type": mediaData.contentType,
          "Content-Length": mediaData.buffer.length,
          "Cache-Control": "public, max-age=86400",
        });
        res.end(mediaData.buffer);
        return;
      }
    } catch (e) {}

    const svg = generateSvgAvatar(contact?.displayName || name);
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    res.end(svg);
    return;
  }

  // 3. OUTBOUND MESSAGE API (`/api/outbound/send`) - NETWORK LEVEL FIRST
  if ((req.url === "/api/outbound/send" || req.url === "/api/send") && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const targetId = String(body.targetId || body.conversationId || "");
      const content = String(body.content || body.textContent || "");
      const clientMsgId = String(body.clientMsgId || nanoid());

      if (!targetId || !content) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing targetId or content" }));
        return;
      }

      // Đăng ký Outbound Lifecycle FSM
      singleWriterQueue.registerOutboundPending(clientMsgId, targetId, content);

      // Lưu tin nhắn cục bộ ở trạng thái SENDING
      await serverStorage.addMessage({
        msgId: clientMsgId,
        conversationId: targetId,
        senderId: "ME",
        textContent: content,
        sender: "ME",
        status: "SENDING",
        timestamp: Date.now(),
        type: "TEXT",
      });

      const isGroup = targetId.startsWith("g_") || Boolean(serverStorage.getConversation(targetId)?.type === "GROUP");

      // Cách A: Gửi qua Pure Node.js Network API (zca-js)
      if (zaloNetworkClient.isReady()) {
        const netRes = await zaloNetworkClient.sendMessage(targetId, content, isGroup);
        if (netRes.success) {
          singleWriterQueue.emit("outbound_status", {
            clientMsgId,
            status: "SENT",
            serverMsgId: netRes.msgId,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, clientMsgId, method: "PURE_NETWORK_API", msgId: netRes.msgId }));
          return;
        }
      }

      // Cách B: Fallback qua In-Memory Headless Dispatcher
      const dispatchRes = await inContextHook.sendHeadlessMessage(targetId, content);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, clientMsgId, dispatchResult: dispatchRes }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 4. NATIVE MEDIA UPLOAD PROXY (`/api/outbound/media`)
  if (req.url === "/api/outbound/media" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const targetId = String(body.targetId || body.conversationId || "general");
      const base64Data = body.data || body.fileBase64;
      const filename = body.filename || `upload_${Date.now()}.png`;

      if (!base64Data) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No file data provided" }));
        return;
      }

      const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");
      const hash = crypto.createHash("md5").update(buffer).digest("hex");
      const ext = path.extname(filename) || ".png";
      const localRelPath = `images/${hash}${ext}`;
      const fullPath = path.join("/app/data/media", localRelPath);

      try {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, buffer);
      } catch (fErr) {}

      const localUrl = `/api/media/${localRelPath}`;
      const clientMsgId = nanoid();

      singleWriterQueue.enqueueRealtime({
        msgId: clientMsgId,
        conversationId: targetId,
        senderId: "ME",
        textContent: body.caption || "",
        sender: "ME",
        status: "DELIVERED",
        timestamp: Date.now(),
        type: "IMAGE",
        mediaUrl: localUrl,
        mediaName: filename,
        mediaSize: buffer.length,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, url: localUrl, msgId: clientMsgId }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 5. CONTACTS API (3NF Endpoint)
  if (req.url === "/api/contacts" || req.url === "/contacts") {
    const contacts = serverStorage.getContacts();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(contacts));
    return;
  }

  // 6. MEDIA PROXY VỚI CACHE
  if (req.url?.startsWith("/api/media/proxy") || req.url?.startsWith("/media/proxy")) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const targetUrl = urlObj.searchParams.get("url");

    if (!targetUrl) {
      res.writeHead(400);
      res.end("Missing target url");
      return;
    }

    try {
      const mediaData = await sessionAuthManager.fetchZaloMedia(targetUrl);
      if (mediaData && mediaData.buffer.length > 0) {
        res.writeHead(200, {
          "Content-Type": mediaData.contentType,
          "Content-Length": mediaData.buffer.length,
          "Cache-Control": "public, max-age=86400",
        });
        res.end(mediaData.buffer);
        return;
      }
    } catch (e) {}

    const name = urlObj.searchParams.get("name") || "Z";
    const svg = generateSvgAvatar(name);
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    res.end(svg);
    return;
  }

  // 7. MEDIA FILE SERVING
  if (req.url?.startsWith("/api/media/") || req.url?.startsWith("/media/")) {
    const reqPath = req.url.replace(/^\/(api\/)?media\//, "");
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "");
    const fullPath = path.join("/app/data/media", safePath);

    if (fs.existsSync(fullPath)) {
      const ext = path.extname(fullPath).toLowerCase();
      let contentType = "application/octet-stream";
      if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
      else if (ext === ".png") contentType = "image/png";
      else if (ext === ".gif") contentType = "image/gif";
      else if (ext === ".webp") contentType = "image/webp";
      else if (ext === ".mp4") contentType = "video/mp4";
      else if (ext === ".mp3") contentType = "audio/mpeg";
      else if (ext === ".aac") contentType = "audio/aac";

      const stat = fs.statSync(fullPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=31536000",
      });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("Media Not Found");
    return;
  }

  // 8. FULL RESYNC API
  if ((req.url === "/api/sync/full-resync" || req.url === "/sync/full-resync") && req.method === "POST") {
    try {
      // 1. Đồng bộ danh bạ qua Network API
      if (zaloNetworkClient.isReady()) {
        await zaloNetworkClient.syncNetworkData();
      }

      // 2. Chạy Full Master Resync
      const dumpResult = await executeFullMasterResync();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(dumpResult));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 9. MESSAGES API VỚI 503 HYDRATION GUARD
  if (req.url?.startsWith("/api/messages") || req.url?.startsWith("/messages")) {
    if (!serverStorage.isHydrated() && serverStorage.getConversations().length === 0) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
      res.end(JSON.stringify({ error: "Storage is syncing in staging", state: serverStorage.getHydrationState() }));
      return;
    }

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const convId = urlObj.searchParams.get("conversationId") || "general";
    const convName = urlObj.searchParams.get("convName") || undefined;
    const shouldRefresh = urlObj.searchParams.get("refresh") === "true";

    let msgs = serverStorage.getMessages(convId);
    if ((msgs.length === 0 || shouldRefresh) && convName) {
      const scrapedMsgs = await scrapeConversationWithHistory(convId, convName, 1);
      if (scrapedMsgs.length > 0) {
        serverStorage.saveMessages(convId, scrapedMsgs);
        msgs = serverStorage.getMessages(convId);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(msgs || []));
    return;
  }

  // 10. CONVERSATIONS API VỚI 503 HYDRATION GUARD
  if (req.url === "/api/conversations" || req.url === "/conversations") {
    if (!serverStorage.isHydrated() && serverStorage.getConversations().length === 0) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
      res.end(JSON.stringify({ error: "Storage is syncing in staging", state: serverStorage.getHydrationState() }));
      return;
    }

    let convs = serverStorage.getConversations();
    if (convs.length === 0) {
      if (zaloNetworkClient.isReady()) {
        await zaloNetworkClient.syncNetworkData();
        convs = serverStorage.getConversations();
      }
    }

    if (convs.length === 0) {
      const liveConvs = await extractSidebarConversations();
      if (liveConvs.length > 0) {
        serverStorage.saveConversations(liveConvs);
        convs = serverStorage.getConversations();
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(convs));
    return;
  }

  // 11. Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "OK",
      networkClientReady: zaloNetworkClient.isReady(),
      myUid: zaloNetworkClient.getMyUid(),
      hydration: serverStorage.getHydrationState(),
      activeClients: connectedClients.size,
      totalConversations: serverStorage.getConversations().length,
      totalContacts: serverStorage.getContacts().length,
      totalMessages: serverStorage.getMessages().length,
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  connectedClients.add(ws);

  ws.on("message", async (raw: Buffer) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString("utf-8"));

      if (msg.type === "START_STREAM") {
        streamingClients.add(ws);
        cdpClient.startScreencast().catch(() => {});
        return;
      }

      if (msg.type === "STOP_STREAM") {
        streamingClients.delete(ws);
        if (streamingClients.size === 0) {
          cdpClient.stopScreencast().catch(() => {});
        }
        return;
      }

      if (msg.type === "START_LIVE_SYNC") {
        console.log("⚡ Starting Live Sync via WebSocket...");
        try {
          if (zaloNetworkClient.isReady()) {
            await zaloNetworkClient.syncNetworkData();
          }
          chunkedSync.executeChunkedSync().catch(() => {});
          
          const dumpResult = await executeFullMasterResync((update) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  event: "LIVE_SYNC_PROGRESS",
                  ...update,
                })
              );
            }
          });

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event: "LIVE_SYNC_COMPLETED",
                dumpResult,
              })
            );
          }
        } catch (syncErr: any) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event: "LIVE_SYNC_PROGRESS",
                current: 0,
                total: 0,
                currentName: "Lỗi",
                currentId: "error",
                messageCount: 0,
                percent: 100,
                stage: "ERROR",
                log: `❌ Lỗi: ${syncErr.message}`,
              })
            );
          }
        }
        return;
      }

      if (msg.type === "SELECT_CONVERSATION" && msg.conversationName) {
        await scrapeConversationWithHistory(msg.conversationId || "general", msg.conversationName, 1);
        return;
      }

      // OUTBOUND MESSAGE DISPATCHER (Pure Network + Headless Fallback)
      if (msg.type === "SEND_MESSAGE" || msg.type === "OUTBOUND_SEND") {
        if (!limiter.tryConsume(1)) {
          ws.send(
            JSON.stringify({
              status: "ERROR_RATE_LIMITED",
              message: "Rate limit exceeded. Please wait.",
              retryAfterMs: 250,
            })
          );
          return;
        }

        const clientMsgId = String(msg.clientMsgId || msg.idempotencyKey || nanoid());
        const targetId = String(msg.targetId || msg.conversationId || "general");
        const cleaned = cleanMessageContent(msg.textContent || "");

        // 1. Ghi nhận Outbound Lifecycle FSM
        singleWriterQueue.registerOutboundPending(clientMsgId, targetId, cleaned.cleanText);

        // 2. Lưu tin nhắn tạm thời với trạng thái SENDING
        await serverStorage.addMessage({
          msgId: clientMsgId,
          conversationId: targetId,
          senderId: "ME",
          textContent: cleaned.cleanText,
          sender: "ME",
          status: "SENDING",
          timestamp: Date.now(),
          type: msg.mediaType || (msg.mediaUrl ? "IMAGE" : "TEXT"),
          mediaUrl: msg.mediaUrl,
        });

        // 3. Phản hồi Optimistic Pending tới Client
        ws.send(
          JSON.stringify({
            status: "OPTIMISTIC_PENDING",
            msgId: clientMsgId,
            clientMsgId,
            idempotencyKey: msg.idempotencyKey,
            hlc: hlc.now(),
          })
        );

        const isGroup = targetId.startsWith("g_") || Boolean(serverStorage.getConversation(targetId)?.type === "GROUP");

        // 4. Gửi qua Pure Node.js Network Client
        if (zaloNetworkClient.isReady() && cleaned.cleanText) {
          zaloNetworkClient.sendMessage(targetId, cleaned.cleanText, isGroup).then((netRes) => {
            if (netRes.success) {
              singleWriterQueue.emit("outbound_status", {
                clientMsgId,
                status: "SENT",
                serverMsgId: netRes.msgId,
              });
            } else {
              // Fallback qua Headless Script
              inContextHook.sendHeadlessMessage(targetId, cleaned.cleanText).then((res) => {
                if (!res.success) {
                  singleWriterQueue.emit("outbound_status", {
                    clientMsgId,
                    status: "FAILED",
                    error: res.error,
                  });
                }
              });
            }
          }).catch(() => {
            inContextHook.sendHeadlessMessage(targetId, cleaned.cleanText).catch((err) => {
              singleWriterQueue.emit("outbound_status", {
                clientMsgId,
                status: "FAILED",
                error: err.message,
              });
            });
          });
        } else if (cleaned.cleanText) {
          inContextHook.sendHeadlessMessage(targetId, cleaned.cleanText).then((res) => {
            if (!res.success) {
              singleWriterQueue.emit("outbound_status", {
                clientMsgId,
                status: "FAILED",
                error: res.error,
              });
            }
          }).catch((err) => {
            singleWriterQueue.emit("outbound_status", {
              clientMsgId,
              status: "FAILED",
              error: err.message,
            });
          });
        }
      } else if (msg.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG", timestamp: Date.now() }));
      }
    } catch (err) {}
  });

  ws.on("close", () => {
    connectedClients.delete(ws);
    streamingClients.delete(ws);
    if (streamingClients.size === 0) {
      cdpClient.stopScreencast().catch(() => {});
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Universal Zalo Enterprise Gateway listening on http://0.0.0.0:${PORT}`);
  console.log(`⚡ Strategic Pivot: Pure Node.js Network API + Bi-Directional Messaging Active.`);
});
