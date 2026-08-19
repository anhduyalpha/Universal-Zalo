import Dexie, { type Table } from "dexie";

export interface LocalMessage {
  id?: number;
  msgId: string;
  conversationId: string;
  textContent: string;
  sender: "ME" | "OTHER";
  status: "SENDING" | "DELIVERED" | "FAILED";
  timestamp: number;
}

export class ZaloLocalDatabase extends Dexie {
  messages!: Table<LocalMessage, number>;

  constructor() {
    super("UniversalZaloDB");
    this.version(1).stores({
      messages: "++id, msgId, conversationId, sender, status, timestamp",
    });
  }
}

export const db = new ZaloLocalDatabase();
