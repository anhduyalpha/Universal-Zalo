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

// Helper gửi lệnh CDP bất kỳ tới tab active của Chromium
async function sendCdpCommand(method: string, params: any = {}): Promise<any> {
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
    }, 6000);

    const cmdId = Math.floor(Math.random() * 100000);

    ws.on("open", () => {
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

// Helper parse JSON body từ HTTP Request
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

// Khởi tạo HTTP Server
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

  // 1. Endpoint lấy ảnh màn hình Zalo (`/qr` hoặc `/api/qr`)
  if (req.url?.startsWith("/qr") || req.url?.startsWith("/api/qr")) {
    try {
      const result = await sendCdpCommand("Page.captureScreenshot", { format: "png", quality: 90 });
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

  // 2. Endpoint Tương tác Chuột (Mouse Click) trực tiếp vào Chromium (`/api/action/click`)
  if (req.url === "/api/action/click" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const x = Math.round(Number(body.x) || 0);
      const y = Math.round(Number(body.y) || 0);

      // Gửi mousePressed rồi mouseReleased
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

  // 3. Endpoint Gõ văn bản / Gửi tin nhắn thực tế qua Chromium (`/api/action/type`)
  if (req.url === "/api/action/type" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const text = String(body.text || "");
      const pressEnter = Boolean(body.pressEnter !== false);

      if (text) {
        // Nhập văn bản qua Input.insertText
        await sendCdpCommand("Input.insertText", { text: text });

        if (pressEnter) {
          // Nhấn Enter
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

  // 4. Endpoint trích xuất danh sách hội thoại từ Zalo Web (`/api/conversations`)
  if (req.url === "/api/conversations" || req.url === "/conversations") {
    try {
      const script = `
        (() => {
          const items = [];
          const convElements = document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item, div[id^="conv-item-"]');
          convElements.forEach((el, idx) => {
            const nameEl = el.querySelector('.conv-item-title__name, .name, [class*="name"], [class*="title"], span[title]');
            const msgEl = el.querySelector('.conv-message, .msg, [class*="message"], [class*="last-msg"], [class*="truncate"]');
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

      const result = await sendCdpCommand("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result?.result?.value || []));
    } catch (e: any) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // 5. Endpoint tự động kích hoạt nút Đồng bộ tin nhắn trên Zalo Web (`/api/sync`)
  if (req.url === "/api/sync" || req.url === "/sync") {
    try {
      const script = `
        (() => {
          const syncBtn = Array.from(document.querySelectorAll('a, button, span, div')).find(
            el => el.textContent && (el.textContent.includes('Nhấn để đồng bộ ngay') || el.textContent.includes('đồng bộ ngay') || el.textContent.includes('Đồng bộ tin nhắn'))
          );
          if (syncBtn) {
            syncBtn.click();
            return { success: true, message: "Đã click nút 'Nhấn để đồng bộ ngay' trên Zalo Web." };
          }
          return { success: false, message: "Không tìm thấy nút đồng bộ (có thể đã đồng bộ xong)." };
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

  // 6. Health check
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

  ws.on("message", async (raw: Buffer) => {
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

        // 3. TỰ ĐỘNG GỬI TIN NHẮN THẬT VÀO CHROMIUM ZALO WEB QUA CDP
        if (msg.textContent) {
          try {
            // Tự động gõ text và bấm Enter vào khung chat đang mở của Zalo Web
            await sendCdpCommand("Input.insertText", { text: msg.textContent });
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
            console.log(`[CDP Auto-Send] Sent message to real Zalo Web: ${msg.textContent}`);
          } catch (cdpErr) {
            console.warn(`[CDP Auto-Send Warning] Could not inject text into Chromium:`, cdpErr);
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
  console.log(`🖱️ Interactive CDP Mouse & Keyboard API ready at /api/action/click and /api/action/type`);
});
