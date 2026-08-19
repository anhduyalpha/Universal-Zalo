import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { TokenBucketLimiter } from "./token_bucket.js";
import { HybridLogicalClock } from "./hlc.js";
import { nanoid } from "nanoid";

interface ClientMessage {
  type: "SEND_MESSAGE" | "PING" | "CLICK" | "TYPE" | "WHEEL" | "START_STREAM";
  conversationId?: string;
  textContent?: string;
  idempotencyKey?: string;
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

// Khởi tạo Screencast Stream kết nối liên tục với Chromium CDP
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Endpoint lấy ảnh màn hình Zalo chuẩn 1440x900 (`/qr` hoặc `/api/qr`)
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

  // 2. Endpoint Click Chuột trực tiếp (`/api/action/click`)
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

  // 3. Endpoint Cuộn chuột trực tiếp (`/api/action/wheel`)
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

  // 4. Endpoint Gõ văn bản (`/api/action/type`)
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

  // 5. Endpoint trích xuất danh sách hội thoại từ Zalo Web (`/api/conversations`)
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

  // 6. Endpoint kích hoạt Đồng bộ tin nhắn (`/api/sync`)
  if (req.url === "/api/sync" || req.url === "/sync") {
    try {
      const script = `
        (() => {
          const syncBtn = Array.from(document.querySelectorAll('a, button, span, div')).find(
            el => el.textContent && (el.textContent.includes('Nhấn để đồng bộ ngay') || el.textContent.includes('đồng bộ ngay') || el.textContent.includes('Đồng bộ tin nhắn') || el.textContent.includes('Đồng bộ ngay'))
          );
          if (syncBtn) {
            syncBtn.click();
            return { success: true, message: "Đã click nút 'Đồng bộ ngay' trên Zalo Web. Vui lòng mở điện thoại để xác nhận đồng bộ!" };
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

  // 7. Health check
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

  ws.on("message", async (raw: Buffer) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString("utf-8"));

      // 1. Client yêu cầu xem Stream Screencast realtime 30 FPS
      if (msg.type === "START_STREAM") {
        streamingClients.add(ws);
        ensureScreencastStream();
        return;
      }

      // 2. Client Click Chuột trực tiếp qua WebSocket (Zero Delay)
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

      // 3. Client Cuộn Chuột (Mouse Wheel) trực tiếp qua WebSocket (Zero Delay)
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

      // 4. Client Gõ phím trực tiếp qua WebSocket (Zero Delay)
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

      // 5. Client Gửi tin nhắn qua giao diện Chat (PWA Fan-out & Realtime injection)
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

        if (msg.textContent) {
          try {
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
  console.log(`🎥 30 FPS Zero-Delay Screencast Engine with Mouse Wheel support active`);
});
