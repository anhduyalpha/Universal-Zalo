export type ReactionType = "like" | "heart" | "dislike" | "haha" | "cry" | "angry" | "wow" | "other";

export interface ParsedReaction {
  code: string;
  type: ReactionType;
  emoji: string;
  count: number;
}

export interface MentionToken {
  name: string;
  startIndex: number;
  endIndex: number;
}

export interface SanitizedMessageResult {
  cleanText: string;
  reactions: ParsedReaction[];
  mentions: MentionToken[];
}

// Bảng ánh xạ mã reaction/emoticon di sản của Zalo sang emoji & kiểu chuẩn
export const ZALO_LEGACY_TOKEN_MAP: Record<string, { type: ReactionType; emoji: string }> = {
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
  ":>:o:-((": { type: "cry", emoji: "😭" },
  ":>:o:-(": { type: "cry", emoji: "😭" },
  ":-(( ": { type: "cry", emoji: "😭" },
  ":-((": { type: "cry", emoji: "😭" },
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

// Bảng chuyển đổi emoticon nội dòng (Inline Emoticons) thành Unicode
const INLINE_EMOTICON_MAP: Record<string, string> = {
  ":-)": "🙂",
  ":)": "🙂",
  ":-D": "😄",
  ":D": "😄",
  ";-)": "😉",
  ";)": "😉",
  ":-*": "😘",
  ":-P": "😛",
  ":-p": "😛",
  ":P": "😛",
  ":p": "😛",
  "B-)": "😎",
  "b-)": "😎",
  ":-(": "🙁",
  ":(": "🙁",
  ":-O": "😲",
  ":-o": "😲",
  "<3": "❤️",
};

// Tạo Dynamic Regex chuẩn xác 100% từ danh sách tokens (sắp xếp theo độ dài giảm dần)
const SORTED_LEGACY_TOKENS = Object.keys(ZALO_LEGACY_TOKEN_MAP)
  .map((t) => t.trim())
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)
  .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const TOKEN_UNION_PATTERN = SORTED_LEGACY_TOKENS.join("|");
const TRAILING_REACTION_REGEX = new RegExp(`(?:${TOKEN_UNION_PATTERN})+\\s*$`);
const GLOBAL_REACTION_TOKEN_REGEX = new RegExp(TOKEN_UNION_PATTERN, "g");

// Regex bảo vệ URL để không bị băm cắt link web, TikTok, Youtube
const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

// Regex phát hiện @mention
const MENTION_REGEX = /@([\p{L}\p{N}_\-\.\s]{2,30})(?=\s|$|[,\.\?!])/gu;

/**
 * Kiểm tra xem chuỗi có phải là Ciphertext (Base64 mã hóa AES/E2EE) của Zalo không
 */
export function isBase64Ciphertext(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();

  // Kiểm tra chuỗi Base64 dài không chứa khoảng trắng (đặc trưng của AES Ciphertext Zalo)
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(trimmed)) {
    // Nếu không chứa bất kỳ từ tiếng Việt hay khoảng cách nào, đây là ciphertext
    return true;
  }

  // Kiểm tra payload JSON mã hóa chứa trường "params" hoặc "cipher"
  if (trimmed.startsWith("{") && (trimmed.includes('"params"') || trimmed.includes('"cipher"')) && trimmed.includes(":")) {
    return true;
  }

  return false;
}

/**
 * Làm sạch nội dung tin nhắn, bóc tách chuỗi reaction rác, chuyển đổi inline emoji và nhận diện @mentions
 */
export function cleanMessageContent(rawText: string): SanitizedMessageResult {
  if (!rawText || typeof rawText !== "string") {
    return { cleanText: "", reactions: [], mentions: [] };
  }

  // Nếu chuỗi là Base64 ciphertext chưa giải mã, chuyển thành thông báo thân thiện thay vì hiển thị chuỗi rác
  if (isBase64Ciphertext(rawText)) {
    return {
      cleanText: "[Tin nhắn mã hóa E2EE]",
      reactions: [],
      mentions: [],
    };
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

  // 2. Tìm và bóc tách các chuỗi reaction dính vào đuôi tin nhắn (Trailing Reaction Bursts)
  let cleanText = protectedText.trim();
  let trailingMatch = cleanText.match(TRAILING_REACTION_REGEX);

  while (trailingMatch && trailingMatch.index !== undefined && trailingMatch[0]) {
    const matchedSegment = trailingMatch[0];
    const tokens = matchedSegment.match(GLOBAL_REACTION_TOKEN_REGEX) || [];
    for (const token of tokens) {
      const cleanToken = token.trim();
      const info = ZALO_LEGACY_TOKEN_MAP[cleanToken] || ZALO_LEGACY_TOKEN_MAP[token] || { type: "other", emoji: "✨" };
      const key = `${info.type}_${info.emoji}`;
      if (reactionsMap.has(key)) {
        reactionsMap.get(key)!.count += 1;
      } else {
        reactionsMap.set(key, {
          code: cleanToken,
          type: info.type,
          emoji: info.emoji,
          count: 1,
        });
      }
    }

    cleanText = cleanText.substring(0, trailingMatch.index).trim();
    trailingMatch = cleanText.match(TRAILING_REACTION_REGEX);
  }

  // 3. Nếu tin nhắn chứa các token Zalo legacy dạng `/-strong`, `/-heart` ở bất kỳ vị trí nào
  cleanText = cleanText.replace(/\/-(?:strong|heart|fade|break|rose)/g, (token) => {
    const info = ZALO_LEGACY_TOKEN_MAP[token];
    if (info) {
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
      return "";
    }
    return token;
  }).trim();

  // 4. Chuyển đổi các emoticons nội dòng (như :) -> 🙂) khi đứng tách biệt
  for (const [emoticon, unicodeEmoji] of Object.entries(INLINE_EMOTICON_MAP)) {
    const escaped = emoticon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inlineRegex = new RegExp(`(^|\\s)${escaped}(\\s|$)`, "g");
    cleanText = cleanText.replace(inlineRegex, `$1${unicodeEmoji}$2`);
  }

  // 5. Trích xuất danh sách @mentions
  const mentions: MentionToken[] = [];
  let mentionMatch: RegExpExecArray | null;
  while ((mentionMatch = MENTION_REGEX.exec(cleanText)) !== null) {
    mentions.push({
      name: mentionMatch[1].trim(),
      startIndex: mentionMatch.index,
      endIndex: mentionMatch.index + mentionMatch[0].length,
    });
  }

  // 6. Khôi phục lại toàn bộ URL nguyên bản
  for (const [placeholder, originalUrl] of urlMap.entries()) {
    cleanText = cleanText.replace(placeholder, originalUrl);
  }

  return {
    cleanText: cleanText.trim(),
    reactions: Array.from(reactionsMap.values()),
    mentions,
  };
}

/**
 * Phân giải chuỗi thời gian thực tế từ DOM thành Unix Epoch Timestamp (ms)
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
    return now - (totalCount - fallbackIndex) * 30000;
  }

  const str = rawTime.trim();

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

    if (d.getTime() > now + 60000) {
      d.setDate(d.getDate() - 1);
    }

    return d.getTime();
  }

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
