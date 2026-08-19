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
      const cdpHost = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
      const targetRes = await fetch(`http://${cdpHost}/json`);
      if (!targetRes.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Không thể kết nối đến Chromium CDP trên server." }));
        return;
      }

      const targets = (await targetRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];

      if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Không tìm thấy tab Zalo Web trong Chromium." }));
        return;
      }

      // Kết nối CDP WebSocket để chụp màn hình
      const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl);

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
        try {
          const resp = JSON.parse(raw.toString());
          if (resp.id === 100 && resp.result?.data) {
            const imgBuffer = Buffer.from(resp.result.data, "base64");
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": imgBuffer.length,
              "Cache-Control": "no-store, no-cache, must-revalidate",
            });
            res.end(imgBuffer);
            cdpWs.close();
          }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Lỗi xử lý frame ảnh từ CDP." }));
          cdpWs.close();
        }
      });

      cdpWs.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Lỗi kết nối CDP: ${err.message}` }));
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

server.listen(PORT, () => {
  console.log(`🌐 Universal Zalo Gateway Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`📷 Live QR Screenshot endpoint ready at http://0.0.0.0:${PORT}/qr`);
});
