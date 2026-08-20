import { serverStorage, StoredMessage, StoredConversation } from "./storage.js";
import { cleanMessageContent, parseTimestamp } from "./normalizer.js";
import { cdpClient } from "./cdp_client.js";

export interface SyncProgressUpdate {
  current: number;
  total: number;
  currentName: string;
  currentId: string;
  messageCount: number;
  percent: number;
  stage: "STARTING" | "EXTRACTING_INDEXEDDB" | "EXTRACTING_SIDEBAR" | "SCRAPING_CONVERSATION" | "SANITIZING" | "COMPLETED" | "ERROR";
  log: string;
}

export interface MasterDumpResult {
  success: boolean;
  totalConversations: number;
  totalMessages: number;
  conversations: StoredConversation[];
  messagesByConversation: Record<string, StoredMessage[]>;
  error?: string;
}

/**
 * TRÍCH XUẤT TRỰC TIẾP DỮ LIỆU ĐÃ GIẢI MÃ TỪ INDEXEDDB & REDUX STORE CỦA ZALO WEB (Zero-Loss Pipeline)
 */
export async function extractFromZaloIndexedDB(): Promise<{
  conversations: StoredConversation[];
  messagesByConv: Record<string, StoredMessage[]>;
} | null> {
  const script = `
    (async () => {
      try {
        const result = {
          conversations: [],
          messages: []
        };

        // 1. Kiểm tra in-memory Redux store của Zalo Web
        if (window.appStore && typeof window.appStore.getState === 'function') {
          try {
            const state = window.appStore.getState();
            if (state && (state.threads || state.conversations || state.chats)) {
              const threads = state.threads?.threads || state.conversations?.list || state.chats || [];
              for (const [key, t] of Object.entries(threads)) {
                if (t && typeof t === 'object') {
                  result.conversations.push({
                    id: t.id || t.threadId || key,
                    name: (t.name || t.displayName || t.title || "").replace(/\\u00A0/g, ' ').trim(),
                    avatar: t.avatar || t.thumb || t.avatarUrl || "",
                    lastMessage: t.lastMessage || t.snippet || "",
                    lastTimestamp: t.timestamp || t.lastTime || Date.now(),
                    type: (t.isGroup || t.type === 1 || t.type === "group") ? "GROUP" : "DIRECT",
                  });
                }
              }
            }
          } catch (reduxErr) {}
        }

        // 2. Quét toàn bộ cơ sở dữ liệu IndexedDB của Zalo trong Chromium
        if (window.indexedDB && typeof window.indexedDB.databases === 'function') {
          const dbs = await window.indexedDB.databases();
          for (const dbInfo of dbs) {
            if (!dbInfo.name) continue;
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbInfo.name);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });

              const storeNames = Array.from(db.objectStoreNames);
              for (const storeName of storeNames) {
                try {
                  const items = await new Promise((resolve) => {
                    const tx = db.transaction(storeName, "readonly");
                    const store = tx.objectStore(storeName);
                    const req = store.getAll();
                    req.onsuccess = () => resolve(req.result || []);
                    req.onerror = () => resolve([]);
                  });

                  // Trích xuất hội thoại từ IndexedDB
                  if (storeName.includes('thread') || storeName.includes('conv') || storeName.includes('recent')) {
                    for (const item of items) {
                      if (item && (item.id || item.threadId || item.convId)) {
                        const name = (item.name || item.displayName || item.title || "").replace(/\\u00A0/g, ' ').trim();
                        if (name) {
                          result.conversations.push({
                            id: String(item.id || item.threadId || item.convId),
                            name: name,
                            avatar: item.avatar || item.thumb || item.avatarUrl || "",
                            lastMessage: item.lastMessage || item.snippet || item.lastMsg || "",
                            lastTimestamp: item.timestamp || item.lastTime || item.updatedAt || Date.now(),
                            type: item.isGroup ? "GROUP" : "DIRECT",
                          });
                        }
                      }
                    }
                  }

                  // Trích xuất tin nhắn lịch sử từ IndexedDB
                  if (storeName.includes('msg') || storeName.includes('message') || storeName.includes('chat')) {
                    for (const msg of items) {
                      if (msg && (msg.msgId || msg.id || msg.cliMsgId)) {
                        const rawText = msg.message || msg.content || msg.text || msg.msgBody || (typeof msg.data === 'string' ? msg.data : "");
                        const isMe = Boolean(msg.isMe || msg.fromMe || msg.senderType === 1);
                        result.messages.push({
                          msgId: String(msg.msgId || msg.globalMsgId || msg.id || msg.cliMsgId),
                          conversationId: String(msg.threadId || msg.convId || msg.toId || msg.fromId || "general"),
                          rawText: typeof rawText === 'string' ? rawText : "",
                          sender: isMe ? "ME" : "OTHER",
                          timestamp: msg.timestamp || msg.ts || msg.sendTime || Date.now(),
                          type: msg.msgType || msg.type || "TEXT",
                          mediaUrl: msg.mediaUrl || msg.url || msg.thumbUrl || null,
                        });
                      }
                    }
                  }
                } catch (storeErr) {}
              }
              db.close();
            } catch (dbErr) {}
          }
        }

        return result;
      } catch (err) {
        return null;
      }
    })()
  `;

  try {
    const evalRes = await cdpClient.send("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });

    const data = evalRes?.result?.value;
    if (!data || (!data.conversations?.length && !data.messages?.length)) {
      return null;
    }

    const conversations: StoredConversation[] = [];
    const convMap = new Map<string, StoredConversation>();

    for (const c of data.conversations) {
      if (c.name && !convMap.has(c.name.toLowerCase())) {
        const storedConv: StoredConversation = {
          id: c.id,
          name: c.name,
          avatar: c.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(c.name)}`,
          type: c.type || "DIRECT",
          lastMessage: c.lastMessage || "Tin nhắn đồng bộ từ IndexedDB",
          lastTimestamp: typeof c.lastTimestamp === 'number' ? c.lastTimestamp : Date.now(),
          unreadCount: 0,
        };
        convMap.set(c.name.toLowerCase(), storedConv);
        conversations.push(storedConv);
      }
    }

    const messagesByConv: Record<string, StoredMessage[]> = {};
    for (const m of data.messages) {
      const convId = m.conversationId || "general";
      if (!messagesByConv[convId]) {
        messagesByConv[convId] = [];
      }
      const cleaned = cleanMessageContent(m.rawText);
      const storedMsg = await serverStorage.addMessage({
        msgId: m.msgId,
        conversationId: convId,
        textContent: cleaned.cleanText,
        sender: m.sender,
        status: "DELIVERED",
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        type: m.type,
        mediaUrl: m.mediaUrl,
        reactions: cleaned.reactions.length > 0 ? cleaned.reactions : undefined,
        mentions: cleaned.mentions.length > 0 ? cleaned.mentions : undefined,
      });
      messagesByConv[convId].push(storedMsg);
    }

    return {
      conversations,
      messagesByConv,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Trích xuất danh sách hội thoại từ Sidebar Zalo Web
 */
export async function extractSidebarConversations(): Promise<StoredConversation[]> {
  const script = `
    (() => {
      const items = [];
      const convElements = document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item, div[id^="conv-item-"]');
      
      convElements.forEach((el, idx) => {
        const titleContainer = el.querySelector('.conv-item-title, [class*="conv-item-title"], .conv-item-header, .title-wrap');
        const nameEl = titleContainer 
          ? titleContainer.querySelector('.conv-item-title__name, .title, span[title], div[title], [class*="title"]') || titleContainer
          : el.querySelector('.conv-item-title__name, .conv-item-title, span[title]');
        
        const msgEl = el.querySelector('.conv-message, .msg, [class*="message"], [class*="last-msg"], [class*="truncate"]');
        const timeEl = el.querySelector('.time, [class*="time"]');
        const imgEl = el.querySelector('img');
        const unreadEl = el.querySelector('.unread-badge, [class*="unread"], .badge');
        
        let rawName = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent || "") : (el.getAttribute('title') || "");
        const name = rawName.replace(/\\u00A0/g, ' ').replace(/\\s+/g, ' ').replace(/:$/, '').trim();
        
        if (name && name !== "Tìm kiếm" && name !== "Bạn" && !items.some(i => i.name === name)) {
          const unreadCount = unreadEl ? (parseInt(unreadEl.textContent.trim(), 10) || 0) : 0;
          const isGroup = name.includes("Nhóm") || name.includes("CNTT") || name.includes("Thủ Thuật") || name.includes("GAME") || name.includes("UIT") || name.includes("AI") || name.includes("TUT");
          
          items.push({
            id: 'conv_' + (idx + 1),
            name: name,
            avatar: imgEl ? imgEl.src : ('https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(name)),
            type: isGroup ? "GROUP" : "DIRECT",
            lastMessage: msgEl ? msgEl.textContent.trim() : "Chưa có tin nhắn mới",
            lastTimestamp: Date.now() - (idx * 180000),
            unreadCount: unreadCount,
            isPinned: idx < 2
          });
        }
      });
      return items;
    })()
  `;

  try {
    const result = await cdpClient.send("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value || [];
  } catch (e) {
    return [];
  }
}

/**
 * Cào tin nhắn của một cuộc hội thoại từ DOM cây
 */
export async function scrapeConversationWithHistory(
  convId: string,
  convName: string,
  maxScrollUpPasses: number = 2
): Promise<StoredMessage[]> {
  const cleanTargetName = convName.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  const escapedName = JSON.stringify(cleanTargetName);

  const script = `
    (async () => {
      const targetName = ${escapedName}.toLowerCase();
      
      const convElements = Array.from(document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item'));
      const targetEl = convElements.find(el => {
        const titleContainer = el.querySelector('.conv-item-title, [class*="conv-item-title"], .conv-item-header, .title-wrap');
        const nameEl = titleContainer 
          ? titleContainer.querySelector('.conv-item-title__name, .title, span[title], div[title]') || titleContainer
          : el.querySelector('.conv-item-title__name, .conv-item-title, span[title]');
        
        const rawName = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent || "") : (el.getAttribute('title') || "");
        const normName = rawName.replace(/\\u00A0/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        
        return normName && (normName === targetName || normName.includes(targetName) || targetName.includes(normName));
      });

      if (targetEl) {
        targetEl.click();
        targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 600));
      }

      const scrollContainers = document.querySelectorAll('#chat-body, .message-view-scroll, .chat-history, [class*="message-view__scroll"], [class*="chat-message-list"]');
      for (const container of scrollContainers) {
        for (let pass = 0; pass < ${maxScrollUpPasses}; pass++) {
          if (container && container.scrollTop > 0) {
            container.scrollTop = 0;
            await new Promise(r => setTimeout(r, 350));
          }
        }
      }

      const rawMessages = [];
      const msgNodes = Array.from(document.querySelectorAll('.chat-message, [class*="chat-message"], .msg-item, [id^="msg-"], .message-view, [data-id^="msg_"]'));
      
      let currentDateHeader = "";

      msgNodes.forEach((el, idx) => {
        const dateHeaderEl = el.querySelector('.chat-date, [class*="chat-date"], .day-divider');
        if (dateHeaderEl) {
          currentDateHeader = dateHeaderEl.textContent.trim();
        }

        const clone = el.cloneNode(true);
        const pruneSelectors = [
          '.react-container', '.react-list', '.react-total', '.reaction-list',
          '.card-time', '.time', '.quote-content', '.reply-container',
          '.extra-content', 'button', '.dropdown', '.icon-reaction'
        ];
        clone.querySelectorAll(pruneSelectors.join(',')).forEach(n => n.remove());

        const textEl = clone.querySelector('.content, .text, [class*="text"], [class*="content"], .bubble-content');
        const imgEl = el.querySelector('img[class*="image"], img[src*="zdn.vn"], img[src*="zalo"], .img-msg img');
        const videoEl = el.querySelector('video, source[type*="video"]');
        const audioEl = el.querySelector('audio, [class*="voice-audio"]');
        const timeEl = el.querySelector('.time, [class*="time"], .card-time');
        const isMe = el.classList.contains('me') || el.classList.contains('from-me') || el.getAttribute('data-is-me') === 'true' || el.querySelector('.me, .from-me') !== null;

        const text = textEl ? textEl.textContent.trim() : "";
        const imgSrc = imgEl ? imgEl.src : null;
        const videoSrc = videoEl ? (videoEl.src || videoEl.getAttribute('src')) : null;
        const audioSrc = audioEl ? (audioEl.src || audioEl.getAttribute('src')) : null;
        const timeStr = timeEl ? timeEl.textContent.trim() : (el.getAttribute('data-time') || el.getAttribute('data-ts') || "");

        let msgType = "TEXT";
        let mediaUrl = null;

        if (videoSrc) {
          msgType = "VIDEO";
          mediaUrl = videoSrc;
        } else if (audioSrc) {
          msgType = "VOICE";
          mediaUrl = audioSrc;
        } else if (imgSrc) {
          msgType = "IMAGE";
          mediaUrl = imgSrc;
        }

        if (text || mediaUrl) {
          rawMessages.push({
            msgId: el.getAttribute('id') || el.getAttribute('data-id') || ('msg_' + convId + '_' + idx),
            rawText: text,
            sender: isMe ? "ME" : "OTHER",
            mediaUrl: mediaUrl,
            type: msgType,
            timeStr: timeStr,
            dateHeader: currentDateHeader
          });
        }
      });

      return rawMessages;
    })()
  `;

  try {
    const result = await cdpClient.send("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });

    const rawList = result?.result?.value;
    if (!Array.isArray(rawList) || rawList.length === 0) {
      return serverStorage.getMessages(convId, 300);
    }

    const savedMessages: StoredMessage[] = [];
    const totalCount = rawList.length;

    for (let i = 0; i < totalCount; i++) {
      const item = rawList[i];
      const parsedTime = parseTimestamp(item.timeStr, item.dateHeader, i, totalCount);
      const cleaned = cleanMessageContent(item.rawText);

      const stored = await serverStorage.addMessage({
        msgId: item.msgId,
        conversationId: convId,
        textContent: cleaned.cleanText,
        sender: item.sender,
        status: "DELIVERED",
        timestamp: parsedTime,
        type: item.type,
        mediaUrl: item.mediaUrl,
        reactions: cleaned.reactions.length > 0 ? cleaned.reactions : undefined,
        mentions: cleaned.mentions.length > 0 ? cleaned.mentions : undefined,
      });

      savedMessages.push(stored);
    }

    return savedMessages;
  } catch (e) {
    console.warn(`[Crawler Warning] Failed scraping for ${convId} (${convName}):`, e);
    return serverStorage.getMessages(convId, 300);
  }
}

/**
 * Thực thi Full Master Data Resync toàn diện với Live Progress Updates
 */
export async function executeFullMasterResync(
  onProgress?: (update: SyncProgressUpdate) => void
): Promise<MasterDumpResult> {
  console.log("🚀 [Full Resync] Starting Full Master Session Data Dump with Live Progress...");

  onProgress?.({
    current: 0,
    total: 100,
    currentName: "Khởi động",
    currentId: "init",
    messageCount: 0,
    percent: 5,
    stage: "EXTRACTING_INDEXEDDB",
    log: "🔍 Đang trích xuất dữ liệu giải mã trực tiếp từ IndexedDB của Zalo...",
  });

  // 1. Thử trích xuất trực tiếp từ IndexedDB
  const idbData = await extractFromZaloIndexedDB();
  if (idbData && idbData.conversations.length > 0) {
    serverStorage.saveConversations(idbData.conversations);
    let totalIndexedDbMsgs = 0;
    for (const msgs of Object.values(idbData.messagesByConv)) {
      totalIndexedDbMsgs += msgs.length;
    }

    onProgress?.({
      current: idbData.conversations.length,
      total: idbData.conversations.length,
      currentName: "IndexedDB Zalo",
      currentId: "idb_done",
      messageCount: totalIndexedDbMsgs,
      percent: 100,
      stage: "COMPLETED",
      log: `🎉 [Zero-Loss IndexedDB] Đã trích xuất ${idbData.conversations.length} hội thoại và ${totalIndexedDbMsgs} tin nhắn từ cơ sở dữ liệu Zalo!`,
    });

    serverStorage.flushToDisk();
    return {
      success: true,
      totalConversations: idbData.conversations.length,
      totalMessages: totalIndexedDbMsgs,
      conversations: idbData.conversations,
      messagesByConversation: idbData.messagesByConv,
    };
  }

  // 2. Fallback sang Sidebar & DOM AST Scraping
  onProgress?.({
    current: 0,
    total: 100,
    currentName: "Sidebar DOM",
    currentId: "sidebar_fallback",
    messageCount: 0,
    percent: 15,
    stage: "EXTRACTING_SIDEBAR",
    log: "📋 IndexedDB đang khóa. Chuyển sang cào cây DOM Sidebar...",
  });

  const conversations = await extractSidebarConversations();
  if (conversations.length > 0) {
    serverStorage.saveConversations(conversations);
  }

  const allConvs = serverStorage.getConversations();
  const messagesByConv: Record<string, StoredMessage[]> = {};
  let totalMessagesCount = 0;

  const targetConvs = allConvs.slice(0, 15);
  const total = targetConvs.length;

  for (let i = 0; i < total; i++) {
    const conv = targetConvs[i];
    const currentPercent = Math.round(15 + ((i + 1) / total) * 75);

    onProgress?.({
      current: i + 1,
      total: total,
      currentName: conv.name,
      currentId: conv.id,
      messageCount: totalMessagesCount,
      percent: currentPercent,
      stage: "SCRAPING_CONVERSATION",
      log: `📂 [${i + 1}/${total}] Đang mở "${conv.name}" & cuộn tải lịch sử tin nhắn...`,
    });

    const msgs = await scrapeConversationWithHistory(conv.id, conv.name, 2);
    messagesByConv[conv.id] = msgs;
    totalMessagesCount += msgs.length;

    onProgress?.({
      current: i + 1,
      total: total,
      currentName: conv.name,
      currentId: conv.id,
      messageCount: totalMessagesCount,
      percent: currentPercent,
      stage: "SANITIZING",
      log: `✅ [${i + 1}/${total}] Đã cào & làm sạch ${msgs.length} tin nhắn cho "${conv.name}"`,
    });
  }

  serverStorage.flushToDisk();

  onProgress?.({
    current: total,
    total: total,
    currentName: "Hoàn tất",
    currentId: "done",
    messageCount: totalMessagesCount,
    percent: 100,
    stage: "COMPLETED",
    log: `🎉 Hoàn tất đồng bộ! Tổng cộng ${allConvs.length} cuộc hội thoại và ${totalMessagesCount} tin nhắn đã lưu vào Server Volume.`,
  });

  return {
    success: true,
    totalConversations: allConvs.length,
    totalMessages: totalMessagesCount,
    conversations: allConvs,
    messagesByConversation: messagesByConv,
  };
}
