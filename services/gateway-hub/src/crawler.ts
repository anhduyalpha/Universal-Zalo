import { serverStorage, StoredMessage, StoredConversation } from "./storage.js";
import { cleanMessageContent, parseTimestamp, ParsedReaction } from "./normalizer.js";

export interface MasterDumpResult {
  success: boolean;
  totalConversations: number;
  totalMessages: number;
  conversations: StoredConversation[];
  messagesByConversation: Record<string, StoredMessage[]>;
  error?: string;
}

/**
 * Trích xuất toàn bộ danh sách hội thoại từ Sidebar của Zalo Web
 */
export async function extractSidebarConversations(sendCdpCommand: (method: string, params?: any) => Promise<any>): Promise<StoredConversation[]> {
  const script = `
    (() => {
      const items = [];
      const convElements = document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item, div[id^="conv-item-"]');
      convElements.forEach((el, idx) => {
        const nameEl = el.querySelector('.conv-item-title__name, .name, [class*="name"], [class*="title"], span[title]');
        const msgEl = el.querySelector('.conv-message, .msg, [class*="message"], [class*="last-msg"], [class*="truncate"]');
        const timeEl = el.querySelector('.time, [class*="time"]');
        const imgEl = el.querySelector('img');
        const unreadEl = el.querySelector('.unread-badge, [class*="unread"], .badge');
        
        const name = nameEl ? nameEl.textContent.trim() : (el.getAttribute('title') || "");
        if (name && name !== "Tìm kiếm" && !items.some(i => i.name === name)) {
          const unreadCount = unreadEl ? (parseInt(unreadEl.textContent.trim(), 10) || 0) : 0;
          items.push({
            id: 'conv_' + (idx + 1),
            name: name,
            avatar: imgEl ? imgEl.src : ('https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(name)),
            type: (name.includes("Nhóm") || name.includes("CNTT") || name.includes("Thủ Thuật") || name.includes("GAME") || name.includes("UIT")) ? "GROUP" : "DIRECT",
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
 * Mở một cuộc hội thoại, kích hoạt cuộn ngược lên trên để nạp bộ đệm lịch sử và cào toàn bộ tin nhắn sạch
 */
export async function scrapeConversationWithHistory(
  sendCdpCommand: (method: string, params?: any) => Promise<any>,
  convId: string,
  convName: string,
  maxScrollUpPasses: number = 2
): Promise<StoredMessage[]> {
  const escapedName = JSON.stringify(convName);

  const script = `
    (async () => {
      const targetName = ${escapedName};
      
      // 1. Tìm và click chọn cuộc hội thoại trong sidebar
      const convElements = Array.from(document.querySelectorAll('.conv-item, [class*="conv-item"], .msg-item'));
      const targetEl = convElements.find(el => {
        const nameEl = el.querySelector('.conv-item-title__name, .name, [class*="name"], [class*="title"], span[title]');
        const name = nameEl ? nameEl.textContent.trim() : (el.getAttribute('title') || "");
        return name && name.toLowerCase().includes(targetName.toLowerCase());
      });

      if (targetEl) {
        targetEl.click();
        await new Promise(r => setTimeout(r, 450));
      }

      // 2. Kích hoạt cuộn ngược lên trên để nạp thêm tin nhắn lịch sử (Scroll Buffer Hydration)
      const scrollContainers = document.querySelectorAll('#chat-body, .message-view-scroll, .chat-history, [class*="message-view__scroll"]');
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
      const msgNodes = Array.from(document.querySelectorAll('.chat-message, [class*="chat-message"], .msg-item, [id^="msg-"], .message-view'));
      
      let currentDateHeader = "";

      msgNodes.forEach((el, idx) => {
        // Kiểm tra tiêu đề ngày phân cách (ví dụ: "18/08/2026", "Hôm nay", "Hôm qua")
        const dateHeaderEl = el.querySelector('.chat-date, [class*="chat-date"], .day-divider');
        if (dateHeaderEl) {
          currentDateHeader = dateHeaderEl.textContent.trim();
        }

        const clone = el.cloneNode(true);

        // Bóc tách và loại bỏ các phần tử con không thuộc nội dung tin nhắn (Reactions, Thẻ thời gian, Quotes)
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
            msgId: el.getAttribute('id') || ('msg_' + convId + '_' + idx),
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
 * Thực thi Full Master Data Resync toàn diện
 */
export async function executeFullMasterResync(sendCdpCommand: (method: string, params?: any) => Promise<any>): Promise<MasterDumpResult> {
  console.log("🚀 [Full Resync] Starting Full Master Session Data Dump...");
  
  // 1. Lấy toàn bộ danh sách hội thoại
  const conversations = await extractSidebarConversations(sendCdpCommand);
  if (conversations.length > 0) {
    serverStorage.saveConversations(conversations);
  }

  const allConvs = serverStorage.getConversations();
  const messagesByConv: Record<string, StoredMessage[]> = {};
  let totalMessagesCount = 0;

  // 2. Cào tin nhắn sâu cho tối đa 12 cuộc hội thoại hàng đầu
  const targetConvs = allConvs.slice(0, 12);
  for (const conv of targetConvs) {
    const msgs = await scrapeConversationWithHistory(sendCdpCommand, conv.id, conv.name, 2);
    messagesByConv[conv.id] = msgs;
    totalMessagesCount += msgs.length;
    console.log(`✅ [Full Resync] Dumped ${msgs.length} messages for "${conv.name}"`);
  }

  serverStorage.flushToDisk();

  return {
    success: true,
    totalConversations: allConvs.length,
    totalMessages: totalMessagesCount,
    conversations: allConvs,
    messagesByConversation: messagesByConv,
  };
}
