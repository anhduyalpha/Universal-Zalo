# Universal Zalo - Task Progress & Implementation Log

## Milestone Status: COMPLETE & VERIFIED

### 1. Parser & Message Content Sanitization
- [x] **Zalo Legacy Code Stripper & Reaction Parser (`normalizer.ts`):**
  - Robust regex/tokenizer isolating legacy tokens (`/-strong`, `/-heart`, `/-fade`, `:>:o:-((`, `:-bd`, `:-*`, etc.).
  - Structured extraction into `reactions: Array<{ code, type, emoji, count }>`.
  - Comprehensive URL preservation mechanism protecting TikTok, YouTube, Web links.
- [x] **Timestamp Normalizer:**
  - 3-tier fallback parser mapping true epoch milliseconds (`data-time`, `data-ts`, `.card-time`, date headers) instead of batch `Date.now()`.

### 2. Overhaul "Đồng bộ" (Full Master Resync Pipeline)
- [x] **Master Session Deep Inspection & State Dump Engine (`crawler.ts`):**
  - Iterates over all sidebar conversations.
  - Hydrates historical scroll buffers (`scrollTop = 0`).
  - AST Pre-cleaning stripping nested `.react-container`, `.card-time`, `.quote-content`.
  - Downloads media attachments into server volume `/app/data/media/`.
- [x] **Full Resync API Endpoints:**
  - `POST /api/sync/full-resync` and `POST /api/sync/full` exposed in Gateway Hub & Next.js proxy.
- [x] **Atomic Client DB Reconciliation (`dexie_db.ts`):**
  - Transactional `reconcileFullState` updating IndexedDB without data corruption.

### 3. UI/UX Feedback & Seamless Transition to Live Chat
- [x] **Sync Button & Progress Modal:**
  - 4-stage visual progress bar with percent indicators ($0\% \rightarrow 100\%$).
- [x] **Reaction Badges & Timestamps:**
  - Structured reaction pills rendered under message bubbles (`[ 👍 1 ]`, `[ ❤️ 2 ]`).
  - Accurate relative / absolute time display.
- [x] **Live WebSocket Re-alignment:**
  - Outgoing and incoming live messages processed through the identical sanitization pipeline.
