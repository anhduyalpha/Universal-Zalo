// @ts-ignore
import zcaModule from "zca-js";
import { cdpClient } from "./cdp_client.js";
import { serverStorage } from "./storage.js";
import { singleWriterQueue, IngestionMessageTask } from "./queue_writer.js";
import { isBase64Ciphertext } from "./normalizer.js";
import crypto from "crypto";
import EventEmitter from "events";

const Zalo = (zcaModule as any).Zalo || (zcaModule as any).default?.Zalo || zcaModule;
const ThreadType = (zcaModule as any).ThreadType || (zcaModule as any).default?.ThreadType || { User: 0, Group: 1 };

export type ZaloAPI = any;

/**
 * PURE NODE.JS NETWORK-LEVEL ZALO CLIENT (Strategic Pivot)
 * - Khai thác thông tin xác thực từ Chromium (Cookies, zpw_sek, IMEI, User-Agent)
 * - Tương tác 100% bằng REST API & WebSocket trực tiếp qua Node.js (zca-js)
 * - Hoàn toàn không phụ thuộc vào DOM scraping hay Javascript ngữ cảnh của Zalo Web
 */
export class ZaloNetworkClient extends EventEmitter {
  private static instance: ZaloNetworkClient | null = null;
  private api: ZaloAPI | null = null;
  private isConnecting = false;
  private myUid: string = "";
  private myProfile: any = null;
  private syncInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super();
  }

  public static getInstance(): ZaloNetworkClient {
    if (!ZaloNetworkClient.instance) {
      ZaloNetworkClient.instance = new ZaloNetworkClient();
    }
    return ZaloNetworkClient.instance;
  }

  public getApi(): ZaloAPI | null {
    return this.api;
  }

  public isReady(): boolean {
    return this.api !== null;
  }

  public getMyUid(): string {
    return this.myUid;
  }

  /**
   * Trích xuất Session từ Chromium và khởi tạo Zalo Network API
   */
  public async initFromBrowserSession(): Promise<boolean> {
    if (this.isConnecting) return false;
    this.isConnecting = true;

    try {
      console.log("🔑 [Network Client] Extracting authentication tokens & cookies via CDP...");

      // 1. Lấy Cookies từ Chromium
      const cookieRes = await cdpClient.send("Network.getCookies", {
        urls: ["https://chat.zalo.me", "https://zalo.me", "https://id.zalo.me"],
      });

      const rawCookies = cookieRes?.cookies || [];
      if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
        console.warn("⚠️ [Network Client] No cookies found in Chromium session. Waiting for QR login...");
        this.isConnecting = false;
        return false;
      }

      // Kiểm tra có zpw_sek hoặc zlogin không
      const hasSessionCookie = rawCookies.some(
        (c: any) => c.name === "zpw_sek" || c.name === "zlogin" || c.name === "zalo_id"
      );

      if (!hasSessionCookie) {
        console.warn("⚠️ [Network Client] Session cookies (zpw_sek) not present yet. Zalo is on login page.");
        this.isConnecting = false;
        return false;
      }

      // 2. Lấy IMEI & UserAgent từ LocalStorage / Navigator
      let imei = "";
      let userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

      try {
        const evalRes = await cdpClient.send("Runtime.evaluate", {
          expression: `(() => {
            const imei = localStorage.getItem('z_imei') || localStorage.getItem('imei') || localStorage.getItem('user_id') || '';
            const ua = navigator.userAgent;
            return { imei, ua };
          })()`,
          returnByValue: true,
        });
        if (evalRes?.result?.value) {
          imei = evalRes.result.value.imei || "";
          if (evalRes.result.value.ua) userAgent = evalRes.result.value.ua;
        }
      } catch (e) {}

      if (!imei) {
        imei = crypto.randomUUID();
      }

      // 3. Định dạng danh sách Cookie chuẩn cho zca-js
      const formattedCookies = rawCookies.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expirationDate: c.expires || Date.now() / 1000 + 86400 * 30,
        hostOnly: !c.domain?.startsWith("."),
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        session: Boolean(c.session),
        sameSite: c.sameSite || "None",
        storeId: "0",
      }));

      // 4. Khởi tạo đối tượng Zalo zca-js
      const zalo = new Zalo({
        selfListen: true,
        checkUpdate: false,
      });

      console.log("🌐 [Network Client] Authenticating pure Node.js Network API session with Zalo servers...");
      this.api = await zalo.login({
        cookie: formattedCookies,
        imei: imei,
        userAgent: userAgent,
      });

      console.log("🎉 [Network Client] Pure Network API Authenticated successfully!");

      // 5. Lấy Profile tài khoản của mình
      try {
        const accountInfo = await this.api.fetchAccountInfo();
        if (accountInfo?.data) {
          this.myProfile = accountInfo.data;
          this.myUid = String((accountInfo.data as any).userId || (accountInfo.data as any).uid || "");
          console.log(`👤 [Network Client] Logged in as: ${this.myProfile.displayName || this.myProfile.zaloName} (UID: ${this.myUid})`);

          // Lưu thông tin cá nhân vào contacts
          if (this.myUid) {
            serverStorage.upsertContact({
              id: this.myUid,
              displayName: this.myProfile.displayName || this.myProfile.zaloName || "Bạn",
              avatarUrl: this.myProfile.avatar || "",
              isStub: false,
              updatedAt: Date.now(),
            });
          }
        }
      } catch (aErr: any) {
        console.warn("[Network Client] Error fetching account info:", aErr.message);
      }

      // 6. Kích hoạt Real-Time Network Listener
      this.setupNetworkListener();

      // 7. Kích hoạt đồng bộ danh bạ và nhóm định kỳ
      this.syncNetworkData();
      if (this.syncInterval) clearInterval(this.syncInterval);
      this.syncInterval = setInterval(() => this.syncNetworkData(), 30000);

      this.isConnecting = false;
      this.emit("authenticated");
      return true;
    } catch (err: any) {
      console.error("❌ [Network Client] Failed to authenticate network session:", err.message);
      this.api = null;
      this.isConnecting = false;
      return false;
    }
  }

  /**
   * Thiết lập bộ lắng nghe thời gian thực cấp độ mạng (WebSocket)
   */
  private setupNetworkListener() {
    if (!this.api || !this.api.listener) return;

    try {
      this.api.listener.on("message", (msg: any) => {
        try {
          if (!msg || !msg.data) return;
          const data = msg.data;
          const isMe = Boolean(data.isMe || (this.myUid && String(data.uidFrom) === this.myUid));
          const isGroup = msg.type === ThreadType.Group;
          const convId = isGroup 
            ? String(msg.threadId || data.idTo) 
            : String(isMe ? data.idTo : data.uidFrom || msg.threadId);
          const senderId = isMe ? "ME" : String(data.uidFrom || convId);

          const rawContent = data.content;
          let textContent = typeof rawContent === "string" ? rawContent : (rawContent?.title || rawContent?.msg || rawContent?.text || "");
          if (isBase64Ciphertext(textContent)) {
            textContent = "[Tin nhắn mã hóa E2EE]";
          }

          const task: IngestionMessageTask = {
            msgId: String(data.msgId || data.cliMsgId || Date.now()),
            conversationId: convId,
            senderId: senderId,
            senderName: data.displayName || data.dName || "",
            senderAvatar: data.avatar || "",
            textContent: textContent,
            sender: isMe ? "ME" : "OTHER",
            status: "DELIVERED",
            timestamp: Number(data.ts || data.timestamp) || Date.now(),
            type: data.msgType || (data.url ? "IMAGE" : "TEXT"),
            mediaUrl: data.url || data.hdUrl || data.thumbUrl || undefined,
          };

          singleWriterQueue.enqueueRealtime(task);
        } catch (mErr: any) {
          console.warn("[Network Listener] Error processing message frame:", mErr.message);
        }
      });

      this.api.listener.on("connected", () => {
        console.log("⚡ [Network Listener] Real-time WebSocket connection connected & active.");
      });

      this.api.listener.on("error", (err: any) => {
        console.warn("[Network Listener] WebSocket warning:", err);
      });

      this.api.listener.start({ retryOnClose: true });
    } catch (e: any) {
      console.warn("[Network Listener] Failed to start listener:", e.message);
    }
  }

  /**
   * Đồng bộ toàn diện danh bạ và nhóm trực tiếp từ máy chủ Zalo (HTTP REST API)
   */
  public async syncNetworkData(): Promise<{ totalContacts: number; totalConversations: number }> {
    if (!this.api) {
      return { totalContacts: 0, totalConversations: 0 };
    }

    try {
      let contactCount = 0;
      let convCount = 0;

      // 1. Lấy toàn bộ danh bạ bạn bè (getAllFriends)
      try {
        const friends = await this.api.getAllFriends();
        if (Array.isArray(friends)) {
          for (const fr of friends) {
            const uid = String(fr.userId || (fr as any).uid || "");
            const name = fr.displayName || fr.zaloName || "Bạn bè Zalo";
            if (uid) {
              const avatarUrl = fr.avatar || "";
              serverStorage.upsertContact({
                id: uid,
                displayName: name,
                avatarUrl: avatarUrl,
                isStub: false,
                updatedAt: Date.now(),
              });
              contactCount++;

              // Cập nhật conversation tương ứng
              serverStorage.upsertConversation({
                id: uid,
                name: name,
                avatar: avatarUrl,
                type: "DIRECT",
                lastMessage: fr.status || "Đã đồng bộ từ Zalo API",
                lastTimestamp: Number(fr.lastActionTime) || Date.now(),
                unreadCount: 0,
              });
              convCount++;
            }
          }
        }
      } catch (fErr: any) {
        console.warn("[Network Sync] Error fetching friends:", fErr.message);
      }

      // 2. Lấy toàn bộ danh sách nhóm (getAllGroups)
      try {
        const groupsRes = await this.api.getAllGroups();
        if (groupsRes && groupsRes.gridVerMap) {
          const groupIds = Object.keys(groupsRes.gridVerMap);
          for (const grid of groupIds) {
            try {
              const groupInfo = await (this.api as any).getGroupInfo(grid);
              if (groupInfo && groupInfo.data) {
                const gData = groupInfo.data;
                const gName = gData.name || gData.groupName || `Nhóm ${grid.slice(-4)}`;
                const gAvatar = gData.avatar || gData.avt || "";

                serverStorage.upsertConversation({
                  id: String(grid),
                  name: gName,
                  avatar: gAvatar,
                  type: "GROUP",
                  lastMessage: "Đã đồng bộ từ Zalo API",
                  lastTimestamp: Number(gData.lastActionTime || gData.updatedAt) || Date.now(),
                  unreadCount: 0,
                });
                convCount++;

                // Thêm các thành viên nhóm vào contacts
                if (Array.isArray(gData.members)) {
                  for (const m of gData.members) {
                    const mId = String(m.id || m.uid || "");
                    if (mId) {
                      serverStorage.upsertContact({
                        id: mId,
                        displayName: m.displayName || m.dName || m.name || `Thành viên ${mId.slice(-4)}`,
                        avatarUrl: m.avatar || m.avt || "",
                        isStub: false,
                        updatedAt: Date.now(),
                      });
                      contactCount++;
                    }
                  }
                }
              }
            } catch (gInfoErr) {}
          }
        }
      } catch (gErr: any) {
        console.warn("[Network Sync] Error fetching groups:", gErr.message);
      }

      console.log(`✅ [Network Sync] Synchronized ${contactCount} contacts and ${convCount} conversations.`);
      return { totalContacts: contactCount, totalConversations: convCount };
    } catch (e: any) {
      console.warn("[Network Sync] General sync error:", e.message);
      return { totalContacts: 0, totalConversations: 0 };
    }
  }

  /**
   * Gửi tin nhắn văn bản thuần túy qua Network HTTP API
   */
  public async sendMessage(
    targetId: string,
    content: string,
    isGroup?: boolean
  ): Promise<{ success: boolean; msgId?: string; error?: string }> {
    if (!this.api) {
      return { success: false, error: "Network API client is not initialized" };
    }

    try {
      const threadType = isGroup ? ThreadType.Group : ThreadType.User;
      console.log(`📤 [Network Client] Sending message to ${targetId} (type: ${threadType}): ${content}`);

      const res = await this.api.sendMessage(
        { msg: content },
        String(targetId),
        threadType
      );

      const serverMsgId = res?.message?.msgId ? String(res.message.msgId) : undefined;
      return {
        success: true,
        msgId: serverMsgId,
      };
    } catch (err: any) {
      console.error("❌ [Network Client] Failed to send message:", err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }
}

export const zaloNetworkClient = ZaloNetworkClient.getInstance();
