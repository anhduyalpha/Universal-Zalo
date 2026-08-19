export interface StickerItem {
  id: string;
  name: string;
  url: string;
  animated?: boolean;
}

export interface StickerCategory {
  id: string;
  name: string;
  icon: string;
  stickers: StickerItem[];
}

export const STICKER_COLLECTIONS: StickerCategory[] = [
  {
    id: "zalo_cute",
    name: "Mèo Bựa & Bạn Bè",
    icon: "🐱",
    stickers: [
      { id: "cat_hi", name: "Xin chào", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOHp1bHFyMG1qZXEwOTk3dnQ3eHJ2ZXE3eWhzcm1wYnY5YjVpM2s3MCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/C9x8gX02SnMIoAClXA/giphy.gif", animated: true },
      { id: "cat_love", name: "Bắn tim", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExN3k3ZXRtczE1aGZ2Z21wN283M3J1azg5OHQzMGZ2a3E5eHFkOHFqOCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/ICOgUNjpvO0PC/giphy.gif", animated: true },
      { id: "cat_cry", name: "Khóc ròng", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbDVqN2QxcDJ2M3JzOWZtNm5qbmR3MGV4enBnbWdwOHFqbWd2cWRtcyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/v6aOjy0Qo1fIA/giphy.gif", animated: true },
      { id: "cat_dance", name: "Nhảy múa", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNnE4bnkza3ZzNDQwa2pxcm1tOXA3ZnY2Y3prNmtiaHQ4N2NtcGZkYyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/JIX9t2j0ZTN9S/giphy.gif", animated: true },
      { id: "cat_ok", name: "Được luôn", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExZnd1bjRkYjJvZzRsbjBrcWRicWp3amlyeXJodnR5bWgyNG1qbDdzMyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/3oz8xAFtqoOUUrsh7W/giphy.gif", animated: true },
      { id: "cat_sleep", name: "Ngủ ngon", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHU3MHdxOXM2YWZ2cXJ1Z3hjb3V2bXIzNHFudmdkNHNsaDJvbWtsMyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/WXB88TeARFVvi/giphy.gif", animated: true },
    ],
  },
  {
    id: "bear_rabbit",
    name: "Gấu & Thỏ",
    icon: "🐻",
    stickers: [
      { id: "bear_hug", name: "Ôm cái", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeWZ5a3N5YnQ4dWRva2tmb3VpdmZwbjA4aXlkaXJjZGFkNDFrczB6eiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/l0HlJDaeqNUDhhaMg/giphy.gif", animated: true },
      { id: "rabbit_jump", name: "Vui vẻ", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2R4bmdycHFtYWR4NWY4am4xeTV5MmhhNGdtc3MxeW9rMWx6MnQxeiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/13CoXDiaCcCoyk/giphy.gif", animated: true },
      { id: "bear_clap", name: "Vỗ tay", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdGpnYXJ4bmExZjN4a2F1czh3cmV4ZmNrd3M1N2xjcnh2cG1zZjR2MSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/artj92V8o75VPL7AeQ/giphy.gif", animated: true },
      { id: "bear_angry", name: "Giận hờn", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExc29wMW4ycWp0aGJod2VtbzI1NmVnOGFucWp2bmVnbmN2MWVkbW50bSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/3o7TKSjRrfIPjeiVyM/giphy.gif", animated: true },
    ],
  },
  {
    id: "work_life",
    name: "Công Việc & Deadline",
    icon: "💼",
    stickers: [
      { id: "work_typing", name: "Đang cày", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExMjRmcGptOWJtNXRtdWNvZG1kY3pvMjlld2VqMnR0aTJ1aXF3bnFrayZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/LmNwrBhejkK9EFP504/giphy.gif", animated: true },
      { id: "work_deadline", name: "Chạy deadline", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd2NmbXNwaGRmbzFycjZ4Ymp1bjNmaW1sYm5rcjF5N2dpNHBwbnNvaiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/9M5jK4GXmD5o1irGrF/giphy.gif", animated: true },
      { id: "work_done", name: "Xong việc", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExM3hveThqZ3dxcTB0YTFodnV3eDVscGZtbGJscGZ5cGZzZjFkbXpobiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/26u4cqiYI30juCOGY/giphy.gif", animated: true },
      { id: "work_coffee", name: "Làm ly cafe", url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExN3JpazhtajN4cGl1a2kwaWc3ZW1ndGpkOG1pYWh5d21tMTRndzdrOSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/h8y34LU72478geePx0/giphy.gif", animated: true },
    ],
  },
];
