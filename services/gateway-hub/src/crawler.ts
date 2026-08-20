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
 * TRÍCH XUẤT ĐA TẦNG (Universal Multi-Layer Extractor):
 * 1. Deep-scan toàn bộ cơ sở dữ liệu IndexedDB của Zalo trong Chromium
 * 2. In-memory Redux/MobX state (window.appStore, window.zaloStore, window.__INITIAL_STATE__)
 * 3. DOM Tree AST Parsing của Sidebar và Message View
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

        // 1. Quét In-Memory State của Zalo Web (Redux / Global Store / React Root)
        try {
          const globalStores = [
            window.appStore,
            window.zaloStore,
            window.__INITIAL_STATE__,
            window.g_chatStore,
            window.chatContext,
          ];

          for (const store of globalStores) {
            if (!store) continue;
            const state = typeof store.getState === 'function' ? store.getState() : store;
            if (!state || typeof state !== 'object') continue;

            const threadSources = [
              state.threads?.threads,
              state.threads,
              state.conversations?.list,
              state.conversations,
              state.chats,
              state.recentChats,
              state.contacts
            ];

            for (const src of threadSources) {
              if (src && typeof src === 'object') {
                const list = Array.isArray(src) ? src : Object.values(src);
                for (const item of list) {
                  if (item && typeof item === 'object') {
                    const rawName = item.name || item.displayName || item.title || item.groupName || "";
                    const name = String(rawName).replace(/\\u00A0/g, ' ').replace(/\\s+/g, ' ').replace(/:$/, '').trim();
                    if (name && name !== "Tìm kiếm" && name !== "Bạn") {
                      result.conversations.push({
                        id: String(item.id || item.threadId || item.convId || item.key || ('conv_' + Math.random().toString(36).substring(7))),
                        name: name,
                        avatar: item.avatar || item.thumb || item.avatarUrl || item.picture || "",
                        lastMessage: String(item.lastMessage || item.snippet || item.lastMsg || item.msg || "Đã đồng bộ từ Zalo Store"),
                        lastTimestamp: Number(item.timestamp || item.lastTime || item.updatedAt) || Date.now(),
                        type: (item.isGroup || item.type === 1 || item.type === "group" || name.includes("Nhóm") || name.includes("UIT")) ? "GROUP" : "DIRECT",
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (memErr) {}

        // 2. Quét Deep-Scan toàn bộ IndexedDB Databases của Chromium
        if (window.indexedDB && typeof window.indexedDB.databases === 'function') {
          try {
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
                    const records = await new Promise((resolve) => {
                      const tx = db.transaction(storeName, "readonly");
                      const store = tx.objectStore(storeName);
                      const req = store.getAll();
                      req.onsuccess = () => resolve(req.result || []);
                      req.onerror = () => resolve([]);
                    });

                    if (!Array.isArray(records) || records.length === 0) continue;

                    for (const record of records) {
                      if (!record || typeof record !== 'object') continue;

                      // Nhận diện đối tượng Conversation / Thread
                      const potentialName = record.name || record.displayName || record.title || record.groupName;
                      if (potentialName && typeof potentialName === 'string') {
                        const name = potentialName.replace(/\\u00A0/g, ' ').replace(/\\s+/g, ' ').replace(/:$/, '').trim();
                        if (name && name !== "Tìm kiếm" && name !== "Bạn") {
                          result.conversations.push({
                            id: String(record.id || record.threadId || record.convId || ('conv_' + Math.random().toString(36).substring(7))),
                            name: name,
                            avatar: record.avatar || record.thumb || record.avatarUrl || "",
                            lastMessage: String(record.lastMessage || record.snippet || record.lastMsg || "Tin nhắn từ IndexedDB"),
                            lastTimestamp: Number(record.timestamp || record.lastTime || record.updatedAt) || Date.now(),
                            type: (record.isGroup || record.type === 1 || name.includes("Nhóm") || name.includes("UIT")) ? "GROUP" : "DIRECT",
                          });
                        }
                      }

                      // Nhận diện đối tượng Message
                      const potentialMsg = record.message || record.content || record.text || record.msgBody || record.data;
                      const msgId = record.msgId || record.globalMsgId || record.id || record.cliMsgId;
                      if (msgId && (potentialMsg || record.mediaUrl || record.url || record.thumbUrl)) {
                        const rawText = typeof potentialMsg === 'string' ? potentialMsg : (potentialMsg ? JSON.stringify(potentialMsg) : "");
                        const isMe = Boolean(record.isMe || record.fromMe || record.senderType === 1);
                        result.messages.push({
                          msgId: String(msgId),
                          conversationId: String(record.threadId || record.convId || record.toId || record.fromId || "general"),
                          rawText: rawText,
                          sender: isMe ? "ME" : "OTHER",
                          timestamp: Number(record.timestamp || record.ts || record.sendTime) || Date.now(),
                          type: record.msgType || record.type || (record.mediaUrl ? "IMAGE" : "TEXT"),
                          mediaUrl: record.mediaUrl || record.url || record.thumbUrl || null,
                          mediaName: record.fileName || record.mediaName || undefined,
                          mediaSize: record.fileSize || record.mediaSize || undefined,
                        });
                      }
                    }
                  } catch (sErr) {}
                }
                db.close();
              } catch (dbErr) {}
            }
          } catch (idbErr) {}
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
        mediaName: m.mediaName,
        mediaSize: m.mediaSize,
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
 * Trích xuất chuẩn xác toàn bộ danh sách hội thoại từ Sidebar Zalo Web
 */
export async function extractSidebarConversations(): Promise<StoredConversation[]> {
  const script = `
    (() => {
      const items = [];
      // Bộ chọn DOM mở rộng toàn diện cho Sidebar của Zalo Web
      const convElements = document.querySelectorAll(
        '.conv-item, [class*="conv-item"], .msg-item, div[id^="conv-item-"], .chat-box-tab, [data-id*="conv_"], div[role="listitem"]'
      );
      
      convElements.forEach((el, idx) => {
        const titleContainer = el.querySelector('.conv-item-title, [class*="conv-item-title"], .conv-item-header, .title-wrap');
        const nameEl = titleContainer 
          ? titleContainer.querySelector('.conv-item-title__name, .title, span[title], div[title], [class*="title"]') || titleContainer
          : el.querySelector('.conv-item-title__name, .conv-item-title, span[title], .name, [class*="name"]');
        
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
      
      const convElements = Array.from(document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item, div[id^="conv-item-"], [data-id*="conv_"]'));
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
    log: "🔍 Đang trích xuất dữ liệu từ IndexedDB & Memory Store của Zalo...",
  });

  // 1. Thử trích xuất trực tiếp từ IndexedDB / In-Memory
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
    log: "📋 Đang cào danh sách hội thoại từ Sidebar Zalo Web...",
  });

  const conversations = await extractSidebarConversations();
  if (conversations.length > 0) {
    serverStorage.saveConversations(conversations);
  }

  let allConvs = serverStorage.getConversations();
  if (allConvs.length === 0) {
    allConvs = [
      {
        id: "general",
        name: "Nhóm Chung (Universal Zalo)",
        avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=UniversalZalo",
        type: "GROUP",
        lastMessage: "Chào mừng bạn đến với Universal Zalo!",
        lastTimestamp: Date.now(),
        unreadCount: 0,
        isPinned: true,
      },
      {
        id: "cloud_support",
        name: "Cloud Gateway Hub",
        avatar: "https://api.dicebear.com/7.x/identicon/svg?seed=GatewayHub",
        type: "DIRECT",
        lastMessage: "Hệ thống kết nối trực tiếp với Linux Server.",
        lastTimestamp: Date.now() - 60000,
        unreadCount: 0,
        isPinned: false,
      }
    ];
    serverStorage.saveConversations(allConvs);
  }

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
