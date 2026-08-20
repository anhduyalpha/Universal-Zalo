import http from "http";
import { WebSocket } from "ws";
import { EventEmitter } from "events";
import { StoredConversation, StoredMessage, serverStorage } from "./storage.js";
import { cleanMessageContent, parseTimestamp } from "./normalizer.js";

export interface CdpResponse<T = any> {
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  method?: string;
  params?: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CdpSessionClient extends EventEmitter {
  private static instance: CdpSessionClient | null = null;
  private ws: WebSocket | null = null;
  private cdpHost: string;
  private cdpPort: number;
  private seqId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDestroyed = false;
  private screencastActive = false;

  private constructor() {
    super();
    this.setMaxListeners(50);
    const hostStr = process.env.CHROMIUM_CDP_HOST || "zalo-chromium:9222";
    const [h, p] = hostStr.split(":");
    this.cdpHost = h || "zalo-chromium";
    this.cdpPort = parseInt(p || "9222", 10);
  }

  public static getInstance(): CdpSessionClient {
    if (!CdpSessionClient.instance) {
      CdpSessionClient.instance = new CdpSessionClient();
    }
    return CdpSessionClient.instance;
  }

  private async fetchActivePageWsUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.cdpHost,
          port: this.cdpPort,
          path: "/json",
          method: "GET",
          headers: { Host: `localhost:${this.cdpPort}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const targets = JSON.parse(data);
                const pageTarget = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];
                if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
                  return reject(new Error("No active page target found in Chromium CDP"));
                }
                let wsUrl = pageTarget.webSocketDebuggerUrl as string;
                wsUrl = wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${this.cdpHost}:${this.cdpPort}`);
                resolve(wsUrl);
              } catch (e) {
                reject(new Error(`Failed to parse CDP JSON: ${data}`));
              }
            } else {
              reject(new Error(`CDP /json returned HTTP ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error("CDP /json request timed out"));
      });
      req.end();
    });
  }

  public async connect(): Promise<void> {
    if (this.isDestroyed || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    if (this.isConnecting) return;

    this.isConnecting = true;

    try {
      const wsUrl = await this.fetchActivePageWsUrl();
      this.ws = new WebSocket(wsUrl, {
        headers: { Host: `localhost:${this.cdpPort}` },
        maxPayload: 100 * 1024 * 1024, // 100MB max payload for large screencast frames & IndexedDB dumps
      });

      this.ws.on("open", async () => {
        this.isConnecting = false;
        console.log(`🔌 [CDP Client] Connected to persistent multiplexed CDP Session (${wsUrl})`);

        // Configure standard desktop viewport 1440x900
        await this.send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        }).catch(() => {});

        // Enable essential CDP domains
        await this.send("Page.enable").catch(() => {});
        await this.send("Runtime.enable").catch(() => {});
        await this.send("Network.enable", {
          maxPostDataSize: 10 * 1024 * 1024,
        }).catch(() => {});

        this.emit("connected");
      });

      this.ws.on("message", (raw: Buffer) => {
        try {
          const resp: CdpResponse = JSON.parse(raw.toString("utf-8"));

          // 1. Check if response matches pending request ID
          if (resp.id !== undefined && this.pendingRequests.has(resp.id)) {
            const req = this.pendingRequests.get(resp.id)!;
            this.pendingRequests.delete(resp.id);
            clearTimeout(req.timer);

            if (resp.error) {
              req.reject(new Error(`CDP ${req.method} error [${resp.error.code}]: ${resp.error.message}`));
            } else {
              req.resolve(resp.result);
            }
            return;
          }

          // 2. Handle CDP Protocol Event Notifications
          if (resp.method) {
            this.emit(resp.method, resp.params);
            this.emit("cdp_event", { method: resp.method, params: resp.params });

            // Handle Screencast Frame Acknowledgment
            if (resp.method === "Page.screencastFrame" && resp.params?.sessionId) {
              this.send("Page.screencastFrameAck", { sessionId: resp.params.sessionId }).catch(() => {});
              this.emit("screencast_frame", resp.params.data);
            }

            // Handle Real-time WebSocket Inbound Message Frame
            if (resp.method === "Network.webSocketFrameReceived" && resp.params?.response) {
              this.emit("zalo_ws_frame", resp.params.response);
            }

            // Handle Runtime Native Binding Call
            if (resp.method === "Runtime.bindingCalled" && resp.params) {
              this.emit("binding_called", resp.params);
            }
          }
        } catch (err) {
          console.warn("[CDP Client] Error parsing incoming frame:", err);
        }
      });

      this.ws.on("close", (code, reason) => {
        this.isConnecting = false;
        this.ws = null;
        console.warn(`⚠️ [CDP Client] Connection closed (${code}: ${reason}). Triggering auto-reconnect...`);
        this.rejectAllPending(new Error("CDP Connection closed"));
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        this.isConnecting = false;
        console.warn("[CDP Client] WebSocket error:", err.message);
        this.emit("error", err);
      });
    } catch (err: any) {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2500);
  }

  private rejectAllPending(err: Error) {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  /**
   * Multiplexed Command Dispatch with sequence ID tracking and timeout protection
   */
  public async send<T = any>(method: string, params: any = {}, timeoutMs = 12000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP client is disconnected, failed to execute ${method}`);
    }

    const id = this.seqId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`CDP Command '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer, method });
      this.ws?.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Bật Screencast Frame Streaming trên kết nối multiplexed
   */
  public async startScreencast(): Promise<void> {
    if (this.screencastActive) return;
    try {
      await this.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 1440,
        maxHeight: 900,
        everyNthFrame: 1,
      });
      this.screencastActive = true;
    } catch (e) {
      this.screencastActive = false;
    }
  }

  public async stopScreencast(): Promise<void> {
    if (!this.screencastActive) return;
    try {
      await this.send("Page.stopScreencast");
      this.screencastActive = false;
    } catch (e) {}
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAllPending(new Error("CDP Client destroyed"));
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.removeAllListeners();
  }
}

export const cdpClient = CdpSessionClient.getInstance();

/**
 * Universal backwards-compatible sendCdpCommand wrapper
 */
export async function sendCdpCommand(method: string, params: any = {}): Promise<any> {
  return cdpClient.send(method, params);
}
