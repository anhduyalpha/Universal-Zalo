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
const wss = new WebSocketServer({ port: PORT });
const limiter = new TokenBucketLimiter(10, 4);
const hlc = new HybridLogicalClock();
const connectedClients = new Set<WebSocket>();

console.log(`🌐 Universal Zalo Sub-Client Gateway Hub listening on ws://127.0.0.1:${PORT}`);

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
