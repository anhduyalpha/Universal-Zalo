import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { TokenBucketLimiter } from "./token_bucket.js";
import { HybridLogicalClock } from "./hlc.js";
import { nanoid } from "nanoid";
import { serverStorage, StoredMessage, StoredConversation } from "./storage.js";
import { cleanMessageContent, ParsedReaction } from "./normalizer.js";
import { executeFullMasterResync, scrapeConversationWithHistory, extractSidebarConversations } from "./crawler.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

interface ClientMessage {
  type: "SEND_MESSAGE" | "PING" | "CLICK" | "TYPE" | "WHEEL" | "START_STREAM" | "SELECT_CONVERSATION";
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

function getCdpJson(host: string, port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port: port,
        path: path,
        method: "GET",
        headers: {
          Host: `localhost:${port}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON from CDP: ${data}`));
            }
          } else {
            reject(new Error(`CDP HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(4000, () => {
      req.destroy(new Error("CDP request timed out"));
    });
    req.end();
  });
}

export async function sendCdpCommand(method: string, params: any = {}): Promise<any> {
  const cdpHostStr = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
  const [cdpHost, cdpPortStr] = cdpHostStr.split(":");
  const cdpPort = parseInt(cdpPortStr || "9222", 10);

  const targets = await getCdpJson(cdpHost, cdpPort, "/json");
  const pageTarget = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];

  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    throw new Error("Không tìm thấy active page target trong Chromium");
  }

  let wsUrl = pageTarget.webSocketDebuggerUrl as string;
  wsUrl = wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}:${cdpPort}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Host: `localhost:${cdpPort}` },
    });

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP ${method} timed out`));
    }, 10000);

    const cmdId = Math.floor(Math.random() * 100000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Emulation.setDeviceMetricsOverride",
          params: {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          },
        })
      );

      ws.send(
        JSON.stringify({
          id: cmdId,
          method: method,
          params: params,
        })
      );
    });

    ws.on("message", (raw) => {
      try {
        const resp = JSON.parse(raw.toString());
        if (resp.id === cmdId) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve(resp.result);
        }
      } catch (e) {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        reject(e);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

let screencastWs: WebSocket | null = null;

async function ensureScreencastStream() {
  if (screencastWs && screencastWs.readyState === WebSocket.OPEN) return;

  try {
    const cdpHostStr = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
    const [cdpHost, cdpPortStr] = cdpHostStr.split(":");
    const cdpPort = parseInt(cdpPortStr || "9222", 10);

    const targets = await getCdpJson(cdpHost, cdpPort, "/json");
    const pageTarget = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];

    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) return;

    let wsUrl = pageTarget.webSocketDebuggerUrl as string;
    wsUrl = wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}:${cdpPort}`);

    screencastWs = new WebSocket(wsUrl, {
      headers: { Host: `localhost:${cdpPort}` },
    });

    screencastWs.on("open", () => {
      screencastWs?.send(
        JSON.stringify({
          id: 10,
          method: "Emulation.setDeviceMetricsOverride",
          params: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
        })
      );

      screencastWs?.send(
        JSON.stringify({
          id: 11,
          method: "Page.startScreencast",
          params: {
            format: "jpeg",
            quality: 85,
            maxWidth: 1440,
            maxHeight: 900,
            everyNthFrame: 1,
          },
        })
      );
    });

    screencastWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.method === "Page.screencastFrame" && msg.params?.data) {
          const sessionId = msg.params.sessionId;

          screencastWs?.send(
            JSON.stringify({
              id: 12,
              method: "Page.screencastFrameAck",
              params: { sessionId },
            })
          );

          const framePayload = JSON.stringify({
            event: "SCREENCAST_FRAME",
            data: msg.params.data,
            timestamp: Date.now(),
          });

          for (const client of streamingClients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(framePayload);
            }
          }
        }
      } catch (e) {}
    });

    screencastWs.on("close", () => {
      screencastWs = null;
      if (streamingClients.size > 0) {
        setTimeout(ensureScreencastStream, 1000);
      }
    });

    screencastWs.on("error", () => {
      screencastWs = null;
    });
  } catch (e) {
    screencastWs = null;
  }
}

// Background Ingestion Loop tự động cập nhật tin nhắn định kỳ
async function runBackgroundMessageIngestion() {
  try {
    const convs = serverStorage.getConversations();
    if (convs.length > 0) {
      const activeConv = convs[0];
      await scrapeConversationWithHistory(sendCdpCommand, activeConv.id, activeConv.name, 1);
    }
  } catch (e) {}
}

setInterval(runBackgroundMessageIngestion, 8000);

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Screenshot Endpoint (`/qr` hoặc `/api/qr`)
  if (req.url?.startsWith("/qr") || req.url?.startsWith("/api/qr")) {
    try {
      const result = await sendCdpCommand("Page.captureScreenshot", {
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

  // 2. Phục vụ File Media đã lưu vĩnh viễn trên Server Volume (`/api/media/*` hoặc `/media/*`)
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
        const upstream = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://chat.zalo.me/",
          },
        });

        if (upstream.ok) {
          const contentType = upstream.headers.get("Content-Type") || "image/jpeg";
          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": buffer.length,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(buffer);
          return;
        }
      } catch (e) {}

      // Fallback SVG avatar nếu ảnh không tải được
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
      const dumpResult = await executeFullMasterResync(sendCdpCommand);
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
        msgs = await scrapeConversationWithHistory(sendCdpCommand, convId, convName, 2);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(msgs));
    return;
  }

  // 6. Trích xuất danh sách hội thoại từ Zalo Web (`/api/conversations`)
  if (req.url === "/api/conversations" || req.url === "/conversations") {
    try {
      const convs = await extractSidebarConversations(sendCdpCommand);
      if (convs.length > 0) {
        serverStorage.saveConversations(convs);
      }

      const allConvs = serverStorage.getConversations();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(allConvs.length > 0 ? allConvs : convs));
    } catch (e: any) {
      const allConvs = serverStorage.getConversations();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(allConvs));
    }
    return;
  }

  // 7. Endpoint Click Chuột (`/api/action/click`)
  if (req.url === "/api/action/click" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const x = Math.round(Number(body.x) || 0);
      const y = Math.round(Number(body.y) || 0);

      await sendCdpCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: x,
        y: y,
      });

      await sendCdpCommand("Input.dispatchMouseEvent", {
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

  // 8. Endpoint Cuộn Chuột (`/api/action/wheel`)
  if (req.url === "/api/action/wheel" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const x = Math.round(Number(body.x) || 0);
      const y = Math.round(Number(body.y) || 0);
      const deltaX = Number(body.deltaX) || 0;
      const deltaY = Number(body.deltaY) || 0;

      await sendCdpCommand("Input.dispatchMouseEvent", {
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

  // 9. Endpoint Gõ văn bản (`/api/action/type`)
  if (req.url === "/api/action/type" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const text = String(body.text || "");
      const pressEnter = Boolean(body.pressEnter !== false);

      if (text) {
        await sendCdpCommand("Input.insertText", { text: text });

        if (pressEnter) {
          await sendCdpCommand("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            unmodifiedText: "\r",
            text: "\r",
          });
          await sendCdpCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
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

  // 10. Endpoint kích hoạt Đồng bộ tin nhắn (`/api/sync`)
  if (req.url === "/api/sync" || req.url === "/sync") {
    try {
      const script = `
        (() => {
          const syncBtn = Array.from(document.querySelectorAll('a, button, span, div')).find(
            el => el.textContent && (el.textContent.includes('Nhấn để đồng bộ ngay') || el.textContent.includes('đồng bộ ngay') || el.textContent.includes('Đồng bộ tin nhắn') || el.textContent.includes('Thử lại'))
          );
          if (syncBtn) {
            syncBtn.click();
            return { success: true, message: "Đã click nút Đồng bộ / Thử lại trên Zalo Web." };
          }
          return { success: false, message: "Không tìm thấy nút đồng bộ." };
        })()
      `;
      const result = await sendCdpCommand("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result?.result?.value || { success: false }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }

  // 11. Endpoint Bấm Hủy / Đóng Modal lỗi đồng bộ (`/api/dismiss-modal`)
  if (req.url === "/api/dismiss-modal" || req.url === "/dismiss-modal") {
    try {
      const script = `
        (() => {
          const cancelBtn = Array.from(document.querySelectorAll('a, button, span, div')).find(
            el => el.textContent && (el.textContent.trim() === 'Hủy' || el.textContent.trim() === 'Đóng' || el.textContent.includes('Bỏ qua'))
          );
          if (cancelBtn) {
            cancelBtn.click();
            return { success: true, message: "Đã bấm Hủy popup đồng bộ." };
          }
          return { success: false, message: "Không tìm thấy nút Hủy." };
        })()
      `;
      const result = await sendCdpCommand("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result?.result?.value || { success: false }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }

  // 12. Health check
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
        ensureScreencastStream();
        return;
      }

      if (msg.type === "SELECT_CONVERSATION" && msg.conversationName) {
        await scrapeConversationWithHistory(sendCdpCommand, msg.conversationId || "general", msg.conversationName, 1);
        return;
      }

      if (msg.type === "CLICK" && msg.x !== undefined && msg.y !== undefined) {
        const clickX = Math.round(msg.x);
        const clickY = Math.round(msg.y);
        try {
          if (screencastWs && screencastWs.readyState === WebSocket.OPEN) {
            screencastWs.send(
              JSON.stringify({
                id: 101,
                method: "Input.dispatchMouseEvent",
                params: { type: "mousePressed", button: "left", clickCount: 1, x: clickX, y: clickY },
              })
            );
            screencastWs.send(
              JSON.stringify({
                id: 102,
                method: "Input.dispatchMouseEvent",
                params: { type: "mouseReleased", button: "left", clickCount: 1, x: clickX, y: clickY },
              })
            );
          } else {
            await sendCdpCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              button: "left",
              clickCount: 1,
              x: clickX,
              y: clickY,
            });
            await sendCdpCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              button: "left",
              clickCount: 1,
              x: clickX,
              y: clickY,
            });
          }
        } catch (err) {}
        return;
      }

      if (msg.type === "WHEEL" && msg.x !== undefined && msg.y !== undefined) {
        const wheelX = Math.round(msg.x);
        const wheelY = Math.round(msg.y);
        const deltaX = Number(msg.deltaX) || 0;
        const deltaY = Number(msg.deltaY) || 0;

        try {
          if (screencastWs && screencastWs.readyState === WebSocket.OPEN) {
            screencastWs.send(
              JSON.stringify({
                id: 106,
                method: "Input.dispatchMouseEvent",
                params: { type: "mouseWheel", x: wheelX, y: wheelY, deltaX, deltaY },
              })
            );
          }
        } catch (err) {}
        return;
      }

      if (msg.type === "TYPE" && msg.text) {
        try {
          if (screencastWs && screencastWs.readyState === WebSocket.OPEN) {
            screencastWs.send(
              JSON.stringify({
                id: 103,
                method: "Input.insertText",
                params: { text: msg.text },
              })
            );
            screencastWs.send(
              JSON.stringify({
                id: 104,
                method: "Input.dispatchKeyEvent",
                params: { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
              })
            );
            screencastWs.send(
              JSON.stringify({
                id: 105,
                method: "Input.dispatchKeyEvent",
                params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
              })
            );
          }
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
            await sendCdpCommand("Input.insertText", { text: cleaned.cleanText });
            await sendCdpCommand("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
              unmodifiedText: "\r",
              text: "\r",
            });
            await sendCdpCommand("Input.dispatchKeyEvent", {
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
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Universal Zalo Gateway Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`🖼️ Media Proxy & Fallback Avatar Engine active`);
});
