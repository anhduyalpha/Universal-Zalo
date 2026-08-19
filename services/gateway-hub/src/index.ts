import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { TokenBucketLimiter } from "./token_bucket.js";
import { HybridLogicalClock } from "./hlc.js";
import { nanoid } from "nanoid";

interface ClientMessage {
  type: "SEND_MESSAGE" | "PING";
  conversationId?: string;
  textContent?: string;
  idempotencyKey?: string;
}

const PORT = 8080;
const limiter = new TokenBucketLimiter(10, 4);
const hlc = new HybridLogicalClock();
const connectedClients = new Set<WebSocket>();

// Helper gửi HTTP request với custom Host header để bypass Chrome DevTools Host verification
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

// Helper thực thi script trên Zalo Web qua CDP Runtime.evaluate
async function evalCdp(script: string): Promise<any> {
  const cdpHostStr = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
  const [cdpHost, cdpPortStr] = cdpHostStr.split(":");
  const cdpPort = parseInt(cdpPortStr || "9222", 10);

  const targets = await getCdpJson(cdpHost, cdpPort, "/json");
  const pageTarget = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];

  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    throw new Error("Không tìm thấy page target");
  }

  let wsUrl = pageTarget.webSocketDebuggerUrl as string;
  wsUrl = wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}:${cdpPort}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Host: `localhost:${cdpPort}` },
    });

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("CDP Evaluate timeout"));
    }, 5000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: 200,
          method: "Runtime.evaluate",
          params: {
            expression: script,
            returnByValue: true,
            awaitPromise: true,
          },
        })
      );
    });

    ws.on("message", (raw) => {
      try {
        const resp = JSON.parse(raw.toString());
        if (resp.id === 200) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve(resp.result?.result?.value);
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

// Khởi tạo HTTP Server phục vụ endpoint /qr, /api/conversations, /api/sync và WebSocket Upgrade
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Endpoint lấy trực tiếp ảnh chụp màn hình mã QR / Giao diện Zalo
  if (req.url?.startsWith("/qr") || req.url?.startsWith("/api/qr")) {
    try {
      const cdpHostStr = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
      const [cdpHost, cdpPortStr] = cdpHostStr.split(":");
      const cdpPort = parseInt(cdpPortStr || "9222", 10);

      let targets = await getCdpJson(cdpHost, cdpPort, "/json").catch(async () => {
        return getCdpJson(cdpHost, cdpPort, "/json/new?https://chat.zalo.me");
      });

      if (!Array.isArray(targets)) {
        targets = [targets];
      }

      const pageTarget = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];

      if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Chromium đang khởi động, vui lòng thử lại sau vài giây." }));
        return;
      }

      let wsUrl = pageTarget.webSocketDebuggerUrl as string;
      wsUrl = wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}:${cdpPort}`);

      const cdpWs = new WebSocket(wsUrl, {
        headers: { Host: `localhost:${cdpPort}` },
      });

      let responded = false;
      const timeoutId = setTimeout(() => {
        if (!responded) {
          responded = true;
          try { cdpWs.close(); } catch {}
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Quá thời gian chụp màn hình từ Chromium (Timeout)." }));
        }
      }, 7000);

      cdpWs.on("open", () => {
        cdpWs.send(
          JSON.stringify({
            id: 100,
            method: "Page.captureScreenshot",
            params: { format: "png", quality: 90 },
          })
        );
      });

      cdpWs.on("message", (raw) => {
        if (responded) return;
        try {
          const resp = JSON.parse(raw.toString());
          if (resp.id === 100 && resp.result?.data) {
            responded = true;
            clearTimeout(timeoutId);
            const imgBuffer = Buffer.from(resp.result.data, "base64");
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": imgBuffer.length,
              "Cache-Control": "no-store, no-cache, must-revalidate",
            });
            res.end(imgBuffer);
            try { cdpWs.close(); } catch {}
          }
        } catch (e) {
          if (!responded) {
            responded = true;
            clearTimeout(timeoutId);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Lỗi giải mã ảnh từ Chromium." }));
            try { cdpWs.close(); } catch {}
          }
        }
      });

      cdpWs.on("error", (err) => {
        if (!responded) {
          responded = true;
          clearTimeout(timeoutId);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Lỗi kết nối CDP (${wsUrl}): ${err.message}` }));
        }
      });
    } catch (error: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Lỗi hệ thống: ${error?.message || error}` }));
    }
    return;
  }

  // 2. Endpoint trích xuất danh sách hội thoại từ Zalo Web (`/api/conversations`)
  if (req.url === "/api/conversations" || req.url === "/conversations") {
    try {
      const script = `
        (() => {
          const items = [];
          // Trích xuất các conversation item trong sidebar
          const convElements = document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item, div[id^="conv-item-"]');
          convElements.forEach((el, idx) => {
            const nameEl = el.querySelector('.conv-item-title__name, .name, [class*="name"], [class*="title"], span[title]');
            const msgEl = el.querySelector('.conv-message, .msg, [class*="message"], [class*="last-msg"], [class*="truncate"]');
            const timeEl = el.querySelector('.time, [class*="time"]');
            const imgEl = el.querySelector('img');
            
            const name = nameEl ? nameEl.textContent.trim() : (el.getAttribute('title') || "");
            if (name && name !== "Tìm kiếm" && !items.some(i => i.name === name)) {
              items.push({
                id: 'conv_' + (idx + 1),
                name: name,
                avatar: imgEl ? imgEl.src : ('https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(name)),
                type: (name.includes("Nhóm") || name.includes("CNTT") || name.includes("Thủ Thuật")) ? "GROUP" : "DIRECT",
                lastMessage: msgEl ? msgEl.textContent.trim() : "Chưa có tin nhắn mới",
                lastTimestamp: Date.now() - (idx * 120000),
                unreadCount: 0,
                isPinned: idx < 2
              });
            }
          });
          return items;
        })()
      `;

      const conversations = await evalCdp(script).catch(() => []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(conversations || []));
    } catch (e: any) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // 3. Endpoint nhấn nút "Đồng bộ tin nhắn gần đây" trên Zalo Web (`/api/sync`)
  if (req.url === "/api/sync" || req.url === "/sync") {
    try {
      const script = `
        (() => {
          const syncBtn = Array.from(document.querySelectorAll('a, button, span, div')).find(
            el => el.textContent && (el.textContent.includes('Nhấn để đồng bộ ngay') || el.textContent.includes('đồng bộ ngay') || el.textContent.includes('Đồng bộ tin nhắn'))
          );
          if (syncBtn) {
            syncBtn.click();
            return { success: true, message: "Đã gửi lệnh kích hoạt đồng bộ tin nhắn trên Zalo Web." };
          }
          return { success: false, message: "Không tìm thấy nút đồng bộ (có thể đã đồng bộ xong)." };
        })()
      `;
      const result = await evalCdp(script).catch((e) => ({ success: false, message: e.message }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }

  // 4. Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK", activeClients: connectedClients.size }));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Khởi tạo WebSocket Server tích hợp trên HTTP Server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  connectedClients.add(ws);
  console.log(`Client connected. Total active sub-clients: ${connectedClients.size}`);

  ws.on("message", (raw: Buffer) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString("utf-8"));

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

        // 1. Optimistic ACK tức thì cho client gửi
        ws.send(
          JSON.stringify({
            status: "OPTIMISTIC_PENDING",
            msgId,
            idempotencyKey: msg.idempotencyKey,
            hlc: ts,
          })
        );

        // 2. Broadcast ngay lập tức (Fan-out) xuống các Sub-Clients khác
        const broadcastPayload = JSON.stringify({
          event: "MESSAGE_FANOUT",
          msgId,
          conversationId: msg.conversationId,
          textContent: msg.textContent,
          status: "SENDING",
          hlc: ts,
        });

        for (const client of connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(broadcastPayload);
          }
        }
      } else if (msg.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG", timestamp: Date.now() }));
      }
    } catch (err) {
      console.error("Invalid frame received from client:", err);
    }
  });

  ws.on("close", () => {
    connectedClients.delete(ws);
    console.log(`Client disconnected. Total active sub-clients: ${connectedClients.size}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Universal Zalo Gateway Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`📷 Live QR Screenshot endpoint ready at http://0.0.0.0:${PORT}/qr`);
  console.log(`💬 Live Conversations API ready at http://0.0.0.0:${PORT}/api/conversations`);
});
