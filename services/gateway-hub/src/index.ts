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

// Khởi tạo HTTP Server phục vụ endpoint /qr và WebSocket Upgrade
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Endpoint lấy trực tiếp ảnh chụp màn hình mã QR Zalo
  if (req.url?.startsWith("/qr") || req.url?.startsWith("/api/qr")) {
    try {
      const cdpHostStr = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
      const [cdpHost, cdpPortStr] = cdpHostStr.split(":");
      const cdpPort = parseInt(cdpPortStr || "9222", 10);

      // Gọi /json với Host: localhost để tránh lỗi Chrome DevTools 500
      let targets = await getCdpJson(cdpHost, cdpPort, "/json").catch(async () => {
        // Fallback thử tạo tab mới nếu chưa có
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

      // THAY THẾ hostname trong webSocketDebuggerUrl bằng cdpHost:cdpPort
      let wsUrl = pageTarget.webSocketDebuggerUrl as string;
      wsUrl = wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}:${cdpPort}`);

      // Kết nối CDP WebSocket với Host header chuẩn
      const cdpWs = new WebSocket(wsUrl, {
        headers: {
          Host: `localhost:${cdpPort}`,
        },
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

  // 2. Health check
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
});
