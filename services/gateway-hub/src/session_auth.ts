import { cdpClient } from "./cdp_client.js";

/**
 * SESSION AUTH & PROXY GATEWAY
 * - Lưu trữ và làm tươi liên tục Cookie và User-Agent từ Chromium Session
 * - Cung cấp cơ chế fetch có đầy đủ Header xác thực chống chặn 403 Forbidden của Zalo CDN
 */
export class SessionAuthManager {
  private static instance: SessionAuthManager | null = null;
  private cookieHeader: string = "";
  private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  private lastRefreshed: number = 0;

  private constructor() {
    this.startAutoRefresh();
  }

  public static getInstance(): SessionAuthManager {
    if (!SessionAuthManager.instance) {
      SessionAuthManager.instance = new SessionAuthManager();
    }
    return SessionAuthManager.instance;
  }

  public getCookieHeader(): string {
    return this.cookieHeader;
  }

  public getUserAgent(): string {
    return this.userAgent;
  }

  public async refreshAuth(): Promise<void> {
    try {
      // 1. Lấy Cookies từ CDP
      const cookieRes = await cdpClient.send("Network.getCookies", {
        urls: ["https://chat.zalo.me", "https://zalo.me", "https://id.zalo.me", "https://zadn.vn"],
      });

      if (cookieRes?.cookies && Array.isArray(cookieRes.cookies) && cookieRes.cookies.length > 0) {
        this.cookieHeader = cookieRes.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
      }

      // 2. Lấy User-Agent từ Runtime
      const evalRes = await cdpClient.send("Runtime.evaluate", {
        expression: "navigator.userAgent",
        returnByValue: true,
      });

      if (evalRes?.result?.value && typeof evalRes.result.value === "string") {
        this.userAgent = evalRes.result.value;
      }

      this.lastRefreshed = Date.now();
    } catch (e) {
      // Fallback giữ nguyên session hiện tại nếu CDP bận
    }
  }

  private startAutoRefresh() {
    setInterval(() => {
      this.refreshAuth().catch(() => {});
    }, 4000);
  }

  /**
   * Fetch tài nguyên từ CDN Zalo với 100% Header chuẩn trình duyệt thật
   */
  public async fetchZaloMedia(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (!url || typeof url !== "string") return null;

    if (Date.now() - this.lastRefreshed > 10000 || !this.cookieHeader) {
      await this.refreshAuth();
    }

    try {
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        "Referer": "https://chat.zalo.me/",
        "Origin": "https://chat.zalo.me",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      };

      if (this.cookieHeader) {
        headers["Cookie"] = this.cookieHeader;
      }

      const res = await fetch(url, { headers });
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const contentType = res.headers.get("Content-Type") || "image/jpeg";
        return { buffer, contentType };
      }
    } catch (err: any) {
      // Fetch lỗi
    }

    return null;
  }
}

export const sessionAuthManager = SessionAuthManager.getInstance();
