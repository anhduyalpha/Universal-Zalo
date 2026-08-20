import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { TokenBucketLimiter } from "./token_bucket.js";
import { HybridLogicalClock } from "./hlc.js";
import { nanoid } from "nanoid";
import { serverStorage, StoredMessage, StoredConversation } from "./storage.js";
import { cleanMessageContent, ParsedReaction } from "./normalizer.js";
import { executeFullMasterResync, scrapeConversationWithHistory, extractSidebarConversations, extractFromZaloIndexedDB, SyncProgressUpdate } from "./crawler.js";
import { cdpClient } from "./cdp_client.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

interface ClientMessage {
  type: "SEND_MESSAGE" | "PING" | "CLICK" | "TYPE" | "WHEEL" | "START_STREAM" | "STOP_STREAM" | "SELECT_CONVERSATION" | "START_LIVE_SYNC";
  conversationId?: string;
  conversationName?: string;
  textContent?: string;
  idempotencyKey?: string;
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

// Khởi tạo kết nối CDP Singleton Pool
cdpClient.connect().catch((err) => {
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

// Hook Real-time Inbound WebSocket frames từ Zalo Web (Decoupled Real-time Stream)
cdpClient.on("zalo_ws_frame", async (wsResponse: any) => {
  try {
    const payloadData = wsResponse.payloadData;
    if (!payloadData || typeof payloadData !== "string") return;

    if (payloadData.startsWith("{") && payloadData.endsWith("}")) {
      const parsed = JSON.parse(payloadData);
      if (parsed.data && (parsed.data.msgId || parsed.data.content || parsed.data.msgBody)) {
        const msg = parsed.data;
        const rawText = msg.content || msg.message || msg.text || msg.msgBody || "";
        const cleaned = cleanMessageContent(rawText);
        const convId = String(msg.threadId || msg.convId || msg.toId || "general");
        const isMe = Boolean(msg.isMe || msg.fromMe || msg.senderType === 1);

        const saved = await serverStorage.addMessage({
          msgId: String(msg.msgId || nanoid()),
          conversationId: convId,
          textContent: cleaned.cleanText,
          sender: isMe ? "ME" : "OTHER",
          status: "DELIVERED",
          timestamp: msg.timestamp || Date.now(),
          type: msg.msgType || "TEXT",
          mediaUrl: msg.mediaUrl,
          reactions: cleaned.reactions.length > 0 ? cleaned.reactions : undefined,
          mentions: cleaned.mentions.length > 0 ? cleaned.mentions : undefined,
        });

        const fanout = JSON.stringify({
          event: "MESSAGE_FANOUT",
          msgId: saved.msgId,
          conversationId: saved.conversationId,
          textContent: saved.textContent,
          sender: saved.sender,
          mediaUrl: saved.mediaUrl,
          type: saved.type,
          status: "DELIVERED",
          reactions: saved.reactions,
          mentions: saved.mentions,
          hlc: hlc.now(),
        });

        for (const client of connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(fanout);
          }
        }
      }
    }
  } catch (err) {}
});

// Background Sync Loop
async function runBackgroundMessageIngestion() {
  try {
    const convs = serverStorage.getConversations();
    if (convs.length > 0) {
      const activeConv = convs[0];
      await scrapeConversationWithHistory(activeConv.id, activeConv.name, 1);
    }
  } catch (e) {}
}

setInterval(runBackgroundMessageIngestion, 15000);

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Screenshot Endpoint (`/qr` hoặc `/api/qr`)
  if (req.url?.startsWith("/qr") || req.url?.startsWith("/api/qr")) {
    try {
      const result = await cdpClient.send("Page.captureScreenshot", {
        format: "png",
        quality: 90,
        captureBeyondViewport: false,
      });

      if (result?.data) {
        const imgBuffer = Buffer.from(result.data, "base64");
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": imgBuffer.length,
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(imgBuffer);
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Không nhận được frame ảnh từ Chromium" }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || e }));
    }
    return;
  }

  // 2. AUTHENTICATED STREAMING MEDIA PROXY (`/api/media/proxy` & `/api/media/*`)
  if (req.url?.startsWith("/api/media/") || req.url?.startsWith("/media/")) {
    if (req.url.startsWith("/api/media/proxy") || req.url.startsWith("/media/proxy")) {
      const urlObj = new URL(req.url, `http://localhost:${PORT}`);
      const targetUrl = urlObj.searchParams.get("url");
      const name = urlObj.searchParams.get("name") || "Z";

      if (!targetUrl) {
        const svg = generateSvgAvatar(name);
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
        res.end(svg);
        return;
      }

      try {
        // Lấy session cookies từ Chromium qua CDP
        let cookieHeader = "";
        try {
          const cookieRes = await cdpClient.send("Network.getCookies", {
            urls: ["https://chat.zalo.me", "https://zalo.me"],
          });
          if (cookieRes?.cookies && Array.isArray(cookieRes.cookies)) {
            cookieHeader = cookieRes.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
          }
        } catch (cErr) {}

        const headers: Record<string, string> = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: "https://chat.zalo.me/",
          Origin: "https://chat.zalo.me",
        };
        if (cookieHeader) {
          headers["Cookie"] = cookieHeader;
        }

        const clientRange = req.headers["range"];
        if (clientRange) {
          headers["Range"] = clientRange;
        }

        const upstream = await fetch(targetUrl, { headers });

        if (upstream.ok || upstream.status === 206) {
          const contentType = upstream.headers.get("Content-Type") || "application/octet-stream";
          const contentLength = upstream.headers.get("Content-Length");
          const contentRange = upstream.headers.get("Content-Range");
          const acceptRanges = upstream.headers.get("Accept-Ranges") || "bytes";

          const responseHeaders: Record<string, string> = {
            "Content-Type": contentType,
            "Accept-Ranges": acceptRanges,
            "Cache-Control": "public, max-age=31536000, immutable",
          };
          if (contentLength) responseHeaders["Content-Length"] = contentLength;
          if (contentRange) responseHeaders["Content-Range"] = contentRange;

          res.writeHead(upstream.status, responseHeaders);
          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.end(buffer);
          return;
        }
      } catch (e) {}

      // Fallback SVG avatar nếu media lỗi
      const svg = generateSvgAvatar(name);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(svg);
      return;
    }

    const filename = req.url.replace(/^\/(api\/)?media\//, "").split("?")[0];
    const fileInfo = serverStorage.getMediaFile(filename);
    if (!fileInfo) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Media file not found on server volume" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": fileInfo.mimeType,
      "Content-Length": fileInfo.size,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    fileInfo.stream.pipe(res);
    return;
  }

  // 3. TOÀN DIỆN: FULL MASTER SESSION DATA DUMP & RESYNC (`/api/sync/full-resync` hoặc `/api/sync/full`)
  if ((req.url === "/api/sync/full-resync" || req.url === "/api/sync/full") && req.method === "POST") {
    try {
      console.log("⚡ Triggering Full Master Data Resync via API...");
      const dumpResult = await executeFullMasterResync((update) => {
        const payload = JSON.stringify({ event: "LIVE_SYNC_PROGRESS", ...update });
        for (const client of connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        }
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(dumpResult));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 4. Upload File / Media từ PWA lên Server Volume (`/api/upload`)
  if (req.url === "/api/upload" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const base64Data = body.data || body.fileBase64;
      const originalName = body.filename || `upload_${Date.now()}.png`;
      const convId = body.conversationId || "general";

      if (!base64Data) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No file data provided" }));
        return;
      }

      const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");
      const hash = crypto.createHash("md5").update(buffer).digest("hex");
      const ext = path.extname(originalName) || ".png";
      const filename = `images/${hash}${ext}`;
      const fullPath = path.join("/app/data/media", filename);

      fs.writeFileSync(fullPath, buffer);

      const localUrl = `/api/media/${filename}`;
      const msgId = nanoid();

      const savedMsg = await serverStorage.addMessage({
        msgId,
        conversationId: convId,
        textContent: body.caption || "",
        sender: "ME",
        status: "DELIVERED",
        timestamp: Date.now(),
        type: "IMAGE",
        mediaUrl: localUrl,
        mediaName: originalName,
        mediaSize: buffer.length,
      });

      const broadcastPayload = JSON.stringify({
        event: "MESSAGE_FANOUT",
        msgId: savedMsg.msgId,
        conversationId: savedMsg.conversationId,
        textContent: savedMsg.textContent,
        sender: "ME",
        mediaUrl: savedMsg.mediaUrl,
        type: "IMAGE",
        status: "DELIVERED",
        reactions: savedMsg.reactions,
        mentions: savedMsg.mentions,
        hlc: hlc.now(),
      });

      for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(broadcastPayload);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, url: localUrl, message: savedMsg }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 5. Lấy danh sách tin nhắn từ Server Volume & Tự động cào từ Zalo Web (`/api/messages`)
  if (req.url?.startsWith("/api/messages") && req.method === "GET") {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const convId = urlObj.searchParams.get("conversationId") || undefined;
    const convName = urlObj.searchParams.get("convName") || undefined;
    const limit = parseInt(urlObj.searchParams.get("limit") || "500", 10);

    let msgs = serverStorage.getMessages(convId, limit);

    if (convId && (msgs.length === 0 || urlObj.searchParams.get("refresh") === "true")) {
      if (convName) {
        msgs = await scrapeConversationWithHistory(convId, convName, 2);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(msgs || []));
    return;
  }

  // 6. Trích xuất danh sách hội thoại (`/api/conversations`)
  if (req.url === "/api/conversations" || req.url === "/conversations") {
    try {
      let convs = serverStorage.getConversations();
      if (convs.length === 0) {
        const liveConvs = await extractSidebarConversations();
        if (liveConvs.length > 0) {
          serverStorage.saveConversations(liveConvs);
          convs = serverStorage.getConversations();
        }
      }

      // Đảm bảo không bao giờ trả về mảng rỗng làm treo loading UI
      if (convs.length === 0) {
        convs = [
          {
            id: "general",
            name: "Nhóm Chung (Universal Zalo)",
            avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=UniversalZalo",
            type: "GROUP",
            lastMessage: "Chào mừng bạn đến với Universal Zalo PWA!",
            lastTimestamp: Date.now(),
            unreadCount: 0,
            isPinned: true,
          },
          {
            id: "cloud_support",
            name: "Cloud Gateway Hub",
            avatar: "https://api.dicebear.com/7.x/identicon/svg?seed=GatewayHub",
            type: "DIRECT",
            lastMessage: "Hệ thống kết nối trực tiếp với Linux Server.",
            lastTimestamp: Date.now() - 60000,
            unreadCount: 0,
            isPinned: false,
          },
        ];
        serverStorage.saveConversations(convs);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(convs));
    } catch (e: any) {
      const allConvs = serverStorage.getConversations();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(allConvs.length > 0 ? allConvs : [
        {
          id: "general",
          name: "Nhóm Chung (Universal Zalo)",
          avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=UniversalZalo",
          type: "GROUP",
          lastMessage: "Chào mừng đến với Universal Zalo!",
          lastTimestamp: Date.now(),
          unreadCount: 0,
          isPinned: true,
        }
      ]));
    }
    return;
  }

  // 7. Action Endpoints (Click, Wheel, Type)
  if (req.url === "/api/action/click" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const x = Math.round(Number(body.x) || 0);
      const y = Math.round(Number(body.y) || 0);

      await cdpClient.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: x,
        y: y,
      });

      await cdpClient.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        x: x,
        y: y,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: `Clicked at (${x}, ${y})` }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.url === "/api/action/wheel" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const x = Math.round(Number(body.x) || 0);
      const y = Math.round(Number(body.y) || 0);
      const deltaX = Number(body.deltaX) || 0;
      const deltaY = Number(body.deltaY) || 0;

      await cdpClient.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: x,
        y: y,
        deltaX: deltaX,
        deltaY: deltaY,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: `Scrolled delta (${deltaX}, ${deltaY})` }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.url === "/api/action/type" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const text = String(body.text || "");
      const pressEnter = Boolean(body.pressEnter !== false);

      if (text) {
        await cdpClient.send("Input.insertText", { text: text });

        if (pressEnter) {
          await cdpClient.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            text: "\r",
          });
          await cdpClient.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
          });
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: `Inserted text: ${text}` }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 8. Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK", activeClients: connectedClients.size, totalSavedMessages: serverStorage.getMessages().length }));
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

      if (msg.type === "CLICK" && msg.x !== undefined && msg.y !== undefined) {
        const clickX = Math.round(msg.x);
        const clickY = Math.round(msg.y);
        try {
          await cdpClient.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            x: clickX,
            y: clickY,
          });
          await cdpClient.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            x: clickX,
            y: clickY,
          });
        } catch (err) {}
        return;
      }

      if (msg.type === "WHEEL" && msg.x !== undefined && msg.y !== undefined) {
        const wheelX = Math.round(msg.x);
        const wheelY = Math.round(msg.y);
        const deltaX = Number(msg.deltaX) || 0;
        const deltaY = Number(msg.deltaY) || 0;

        try {
          await cdpClient.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: wheelX,
            y: wheelY,
            deltaX,
            deltaY,
          });
        } catch (err) {}
        return;
      }

      if (msg.type === "TYPE" && msg.text) {
        try {
          await cdpClient.send("Input.insertText", { text: msg.text });
          await cdpClient.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            text: "\r",
          });
          await cdpClient.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
          });
        } catch (err) {}
        return;
      }

      if (msg.type === "SEND_MESSAGE") {
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

        const msgId = nanoid();
        const ts = hlc.now();
        const convId = msg.conversationId || "general";
        const cleaned = cleanMessageContent(msg.textContent || "");

        const savedMsg = await serverStorage.addMessage({
          msgId,
          conversationId: convId,
          textContent: cleaned.cleanText,
          sender: "ME",
          status: "DELIVERED",
          timestamp: ts.physicalTime || Date.now(),
          type: msg.mediaType || (msg.mediaUrl ? "IMAGE" : "TEXT"),
          mediaUrl: msg.mediaUrl,
          reactions: cleaned.reactions.length > 0 ? cleaned.reactions : undefined,
          mentions: cleaned.mentions.length > 0 ? cleaned.mentions : undefined,
        });

        ws.send(
          JSON.stringify({
            status: "OPTIMISTIC_PENDING",
            msgId,
            idempotencyKey: msg.idempotencyKey,
            hlc: ts,
          })
        );

        const broadcastPayload = JSON.stringify({
          event: "MESSAGE_FANOUT",
          msgId: savedMsg.msgId,
          conversationId: savedMsg.conversationId,
          textContent: savedMsg.textContent,
          sender: "ME",
          mediaUrl: savedMsg.mediaUrl,
          type: savedMsg.type,
          status: "DELIVERED",
          reactions: savedMsg.reactions,
          mentions: savedMsg.mentions,
          hlc: ts,
        });

        for (const client of connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(broadcastPayload);
          }
        }

        if (cleaned.cleanText) {
          try {
            await cdpClient.send("Input.insertText", { text: cleaned.cleanText });
            await cdpClient.send("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
              unmodifiedText: "\r",
              text: "\r",
            });
            await cdpClient.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            });
          } catch (cdpErr) {}
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
  console.log(`🌐 Universal Zalo Gateway Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`⚡ Authenticated Streaming Media Proxy & Deep Extractor active`);
});
