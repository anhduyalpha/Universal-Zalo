# Universal Zalo - Task Progress & Implementation Log

## Milestone Status: COMPLETE & VERIFIED

### 1. Strict Data Deduplication & Idempotent Sync
- [x] **Database & Ingestion Layer (`storage.ts` & `dexie_db.ts`):**
  - Atomic deduplication of conversations by canonical name/id across server volume and client Dexie IndexedDB.
  - Message stream deduplication using `msgId` and content signature windowing.
  - Compound primary key indexing (`&msgId`, `id`) in Dexie schema v4.
- [x] **Frontend State Management (`page.tsx`):**
  - Deduplicated incoming state mutations via `deduplicateById` and `deduplicateConversationsByName`.
  - Immutable unique `key={m.msgId}` and `key={conv.id}` for all React mapping loops.

### 2. Message Sanitization & Reaction/Emoji Parser
- [x] **Legacy Code Stripper & Reaction Lexer (`normalizer.ts`):**
  - Global and trailing removal of legacy Zalo tokens (`/-strong`, `/-heart`, `/-fade`, `:>:o:-((`, `:-bd`, `:-*`, etc.).
  - Transformation of inline emoticons (`:)`, `:(`, `:-D`, `:-P`, `:-*`, etc.) into modern Unicode emojis.
  - Structured extraction into `reactions: Array<{ code, type, emoji, count }>`.
  - Detection and extraction of `@mentions` into structured `mentions: Array<{ name, startIndex, endIndex }>`.
  - Complete protection of URLs (TikTok, YouTube, Zalo, Web links).

### 3. Media Attachments, Avatars & Asset Resiliency
- [x] **Avatar Fallback Pipeline (`AvatarWithFallback` & `/api/media/proxy`):**
  - Automatic letter-avatar SVG generation based on name hash for missing/expired avatar URLs.
  - Backend image proxy route `/api/media/proxy?url=...` resolving CORS and hotlinking restrictions.
- [x] **Rich Attachment Components:**
  - `<FileAttachmentCard />` with formatted file sizes (KB/MB) and download links.
  - `<AudioWaveformPlayer />` for voice notes.
  - `<ImageGallery />` with click-to-zoom modal.
  - `<MessageContentRenderer />` rendering styled `@mentions` and clickable links.
