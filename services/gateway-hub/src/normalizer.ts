export type ReactionType = "like" | "heart" | "dislike" | "haha" | "cry" | "angry" | "wow" | "other";

export interface ParsedReaction {
  code: string;
  type: ReactionType;
  emoji: string;
  count: number;
}

export interface SanitizedMessageResult {
  cleanText: string;
  reactions: ParsedReaction[];
}

// Bảng ánh xạ mã reaction/emoticon di sản của Zalo sang emoji & kiểu chuẩn
const ZALO_LEGACY_TOKEN_MAP: Record<string, { type: ReactionType; emoji: string }> = {
  "/-strong": { type: "like", emoji: "👍" },
  "(y)": { type: "like", emoji: "👍" },
  "/-heart": { type: "heart", emoji: "❤️" },
  "<3": { type: "heart", emoji: "❤️" },
  "(L)": { type: "heart", emoji: "❤️" },
  "/-fade": { type: "dislike", emoji: "👎" },
  "/-break": { type: "cry", emoji: "💔" },
  "/-rose": { type: "heart", emoji: "🌹" },
  ":-bd": { type: "haha", emoji: "😆" },
  ":-D": { type: "haha", emoji: "😄" },
  ":D": { type: "haha", emoji: "😄" },
  ":>:o:-(( ": { type: "cry", emoji: "😭" },
  ":>:o:-(": { type: "cry", emoji: "😭" },
  ":-(( ": { type: "cry", emoji: "😭" },
  ":-(": { type: "cry", emoji: "😢" },
  ":(": { type: "cry", emoji: "😢" },
  ":-<": { type: "angry", emoji: "😡" },
  ":@": { type: "angry", emoji: "😡" },
  ":-O": { type: "wow", emoji: "😲" },
  ":-o": { type: "wow", emoji: "😲" },
  ":-h": { type: "other", emoji: "👋" },
  ":-*": { type: "other", emoji: "😘" },
  ":-S": { type: "other", emoji: "😰" },
  ":-s": { type: "other", emoji: "😰" },
  ":-?": { type: "other", emoji: "🤔" },
  ":-P": { type: "other", emoji: "😛" },
  ":-p": { type: "other", emoji: "😛" },
  ":P": { type: "other", emoji: "😛" },
  ":p": { type: "other", emoji: "😛" },
  "B-)": { type: "other", emoji: "😎" },
  "b-)": { type: "other", emoji: "😎" },
  ";-)": { type: "other", emoji: "😉" },
  ";)": { type: "other", emoji: "😉" },
  ":-)": { type: "other", emoji: "🙂" },
  ":)": { type: "other", emoji: "🙂" },
};

// Regex nhận diện các cụm token reaction dính vào đuôi hoặc xuất hiện trong chuỗi rác
const TRAILING_REACTION_REGEX = /(?:\/-(?:strong|heart|fade|break|rose)|:>:o:-\(\(|:[-<()DOPSbdh*?pP]|;[-)]|\([yL]\))+$/;
const GLOBAL_REACTION_TOKEN_REGEX = /(?:\/-(?:strong|heart|fade|break|rose)|:>:o:-\(\(|:[-<()DOPSbdh*?pP]|;[-)]|\([yL]\))/g;

// Regex bảo vệ URL để không bị băm cắt link web, TikTok, Youtube
const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

/**
 * Làm sạch nội dung tin nhắn, bóc tách toàn bộ chuỗi reaction/emoticon rác và trích xuất danh sách reaction có cấu trúc
 */
export function cleanMessageContent(rawText: string): SanitizedMessageResult {
  if (!rawText || typeof rawText !== "string") {
    return { cleanText: "", reactions: [] };
  }

  // 1. Bảo vệ tất cả URLs có trong tin nhắn bằng placeholder tạm thời
  const urlMap = new Map<string, string>();
  let urlCounter = 0;
  const protectedText = rawText.replace(URL_REGEX, (matchedUrl) => {
    const placeholder = `__URL_PLACEHOLDER_${urlCounter++}__`;
    urlMap.set(placeholder, matchedUrl);
    return placeholder;
  });

  const reactionsMap = new Map<string, ParsedReaction>();

  // 2. Tìm các chuỗi reaction dính vào đuôi tin nhắn (Trailing Reaction Bursts)
  let cleanText = protectedText.trim();
  let trailingMatch = cleanText.match(TRAILING_REACTION_REGEX);

  while (trailingMatch && trailingMatch.index !== undefined && trailingMatch[0]) {
    const matchedSegment = trailingMatch[0];
    // Tìm các token đơn lẻ trong đoạn reaction đuôi này
    const tokens = matchedSegment.match(GLOBAL_REACTION_TOKEN_REGEX) || [];
    for (const token of tokens) {
      const info = ZALO_LEGACY_TOKEN_MAP[token] || { type: "other", emoji: "✨" };
      const key = `${info.type}_${info.emoji}`;
      if (reactionsMap.has(key)) {
        reactionsMap.get(key)!.count += 1;
      } else {
        reactionsMap.set(key, {
          code: token,
          type: info.type,
          emoji: info.emoji,
          count: 1,
        });
      }
    }

    // Cắt bỏ đoạn reaction ở đuôi
    cleanText = cleanText.substring(0, trailingMatch.index).trim();
    trailingMatch = cleanText.match(TRAILING_REACTION_REGEX);
  }

  // 3. Nếu toàn bộ tin nhắn chỉ là các token reaction đơn lẻ (không có chữ)
  if (cleanText && cleanText.length <= 15) {
    const onlyTokens = cleanText.match(GLOBAL_REACTION_TOKEN_REGEX);
    if (onlyTokens && onlyTokens.join("") === cleanText.replace(/\s+/g, "")) {
      for (const token of onlyTokens) {
        const info = ZALO_LEGACY_TOKEN_MAP[token] || { type: "other", emoji: "✨" };
        const key = `${info.type}_${info.emoji}`;
        if (reactionsMap.has(key)) {
          reactionsMap.get(key)!.count += 1;
        } else {
          reactionsMap.set(key, {
            code: token,
            type: info.type,
            emoji: info.emoji,
            count: 1,
          });
        }
      }
      cleanText = "";
    }
  }

  // 4. Khôi phục lại toàn bộ URL nguyên bản
  for (const [placeholder, originalUrl] of urlMap.entries()) {
    cleanText = cleanText.replace(placeholder, originalUrl);
  }

  return {
    cleanText: cleanText.trim(),
    reactions: Array.from(reactionsMap.values()),
  };
}

/**
 * Phân giải chuỗi thời gian thực tế từ DOM (ví dụ: "14:30", "Hôm qua 09:15", "18/08 20:00") thành Unix Epoch Timestamp (ms)
 */
export function parseTimestamp(
  rawTime: string | number | undefined,
  dateContext?: string,
  fallbackIndex: number = 0,
  totalCount: number = 1
): number {
  const now = Date.now();

  if (typeof rawTime === "number" && rawTime > 1500000000000) {
    return rawTime;
  }

  if (typeof rawTime === "string" && /^\d{13}$/.test(rawTime.trim())) {
    return parseInt(rawTime.trim(), 10);
  }

  if (!rawTime || typeof rawTime !== "string") {
    // Monotonic relative interpolation: giữ khoảng cách giữa các tin nhắn
    return now - (totalCount - fallbackIndex) * 30000;
  }

  const str = rawTime.trim();

  // Khớp định dạng giờ phút đơn thuần: "14:35", "9:05 SA", "08:12 CH"
  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?:\s*(SA|CH|AM|PM))?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const meridiem = (timeMatch[3] || "").toUpperCase();

    if (meridiem === "CH" || meridiem === "PM") {
      if (hours < 12) hours += 12;
    } else if (meridiem === "SA" || meridiem === "AM") {
      if (hours === 12) hours = 0;
    }

    const d = new Date();
    d.setHours(hours, minutes, 0, 0);

    if (str.toLowerCase().includes("hôm qua") || (dateContext && dateContext.toLowerCase().includes("hôm qua"))) {
      d.setDate(d.getDate() - 1);
    }

    // Nếu thời gian lớn hơn thời gian hiện tại thì có thể là hôm qua
    if (d.getTime() > now + 60000) {
      d.setDate(d.getDate() - 1);
    }

    return d.getTime();
  }

  // Khớp định dạng ngày tháng: "18/08/2026", "18/08 14:30"
  const fullDateMatch = str.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (fullDateMatch) {
    const day = parseInt(fullDateMatch[1], 10);
    const month = parseInt(fullDateMatch[2], 10) - 1;
    const year = fullDateMatch[3] ? parseInt(fullDateMatch[3], 10) : new Date().getFullYear();
    const hours = fullDateMatch[4] ? parseInt(fullDateMatch[4], 10) : 12;
    const minutes = fullDateMatch[5] ? parseInt(fullDateMatch[5], 10) : 0;

    const d = new Date(year, month, day, hours, minutes, 0, 0);
    return d.getTime();
  }

  return now - (totalCount - fallbackIndex) * 30000;
}
