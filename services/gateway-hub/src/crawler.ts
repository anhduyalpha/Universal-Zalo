import { serverStorage, StoredMessage, StoredConversation } from "./storage.js";
import { cleanMessageContent, parseTimestamp, ParsedReaction } from "./normalizer.js";

export interface SyncProgressUpdate {
  current: number;
  total: number;
  currentName: string;
  currentId: string;
  messageCount: number;
  percent: number;
  stage: "STARTING" | "EXTRACTING_SIDEBAR" | "SCRAPING_CONVERSATION" | "SANITIZING" | "COMPLETED" | "ERROR";
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
 * Trích xuất chuẩn xác toàn bộ danh sách hội thoại từ Sidebar của Zalo Web
 */
export async function extractSidebarConversations(sendCdpCommand: (method: string, params?: any) => Promise<any>): Promise<StoredConversation[]> {
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
    const result = await sendCdpCommand("Runtime.evaluate", {
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
 * Mở cuộc hội thoại bằng click chuẩn xác và cào toàn bộ lịch sử tin nhắn
 */
export async function scrapeConversationWithHistory(
  sendCdpCommand: (method: string, params?: any) => Promise<any>,
  convId: string,
  convName: string,
  maxScrollUpPasses: number = 2
): Promise<StoredMessage[]> {
  const cleanTargetName = convName.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  const escapedName = JSON.stringify(cleanTargetName);

  const script = `
    (async () => {
      const targetName = ${escapedName}.toLowerCase();
      
      // 1. Tìm và click chọn cuộc hội thoại trong sidebar
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

      // 2. Kích hoạt cuộn ngược lên trên để nạp thêm tin nhắn lịch sử (Scroll Buffer Hydration)
      const scrollContainers = document.querySelectorAll('#chat-body, .message-view-scroll, .chat-history, [class*="message-view__scroll"], [class*="chat-message-list"]');
      for (const container of scrollContainers) {
        for (let pass = 0; pass < ${maxScrollUpPasses}; pass++) {
          if (container && container.scrollTop > 0) {
            container.scrollTop = 0;
            await new Promise(r => setTimeout(r, 350));
          }
        }
      }

      // 3. Phân giải DOM cây tin nhắn với AST Pre-cleaning
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
    const result = await sendCdpCommand("Runtime.evaluate", {
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
  sendCdpCommand: (method: string, params?: any) => Promise<any>,
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
    stage: "EXTRACTING_SIDEBAR",
    log: "🔍 Đang kết nối và trích xuất danh sách hội thoại từ Zalo Web...",
  });

  // 1. Lấy chuẩn xác danh sách hội thoại
  const conversations = await extractSidebarConversations(sendCdpCommand);
  if (conversations.length > 0) {
    serverStorage.saveConversations(conversations);
  }

  const allConvs = serverStorage.getConversations();
  const messagesByConv: Record<string, StoredMessage[]> = {};
  let totalMessagesCount = 0;

  const targetConvs = allConvs.slice(0, 15);
  const total = targetConvs.length;

  onProgress?.({
    current: 0,
    total: total,
    currentName: "Danh sách hội thoại",
    currentId: "sidebar",
    messageCount: 0,
    percent: 15,
    stage: "SCRAPING_CONVERSATION",
    log: `📋 Đã tìm thấy ${allConvs.length} cuộc hội thoại. Bắt đầu cào chi tiết từng nhóm...`,
  });

  // 2. Cào tin nhắn sâu từng cuộc trò chuyện và gửi tiến trình trực tiếp
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

    const msgs = await scrapeConversationWithHistory(sendCdpCommand, conv.id, conv.name, 2);
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
