# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — run with `tsx watch` (reads `.env`; copy from `.env.example`)
- `npm run typecheck` — `tsc --noEmit` (only static check; no tests or linter exist)
- `npm run build` / `npm start` — compile to `dist/`, run `node dist/index.js`
- `docker compose up --build` — production-style run; SQLite lives in the `mscbot-data` volume at `/data/app.db`

Requires Node 24 (uses built-in `node:sqlite`).

## Architecture

Class-assistant chatbot for an MSc course. Admin posts documents; students ask questions in a chat UI and get answers grounded in those posts. Hono server (`src/index.ts`) serves the JSON API plus static frontend from `public/` (plain JS, no build step: `index.html`/`chat.js` for students, `post.html` for cited sources, `admin/` for the admin panel).

External services (all via `fetch`, no SDKs):
- **Cognee Cloud** (`src/cognee.ts`): semantic index. Posts are chunked (~900 chars), each chunk prefixed `[doc:ID] title (part i/n)`, uploaded as text files via `/api/v1/add`, then `/api/v1/cognify` is run and polled until done. Search uses `CHUNKS` search type; the response shape is undocumented, so doc IDs are recovered by regex-matching `[doc:N]` tags in the stringified response. Don't change the tag format without reindexing everything (`POST /api/admin/reindex-all`).
- **Cloudflare Workers AI** (`src/llm.ts`): the LLM for answers, query rewriting, summaries, and admin "rewrite".
- **SQLite** (`src/db.ts`): source of truth for post text, status, and chat log. Cognee is only used to find *which* post IDs are relevant; answer context always comes from SQLite bodies.

Chat flow (`src/chat.ts`): rewrite follow-up into standalone query using history → Cognee search → drop expired posts → rank blending search order with recency (`recency()` in `db.ts`) → top up with keyword search (`docs.keywordSearch`) if <3 → add previous turn's `prevDocIds` → stuff full bodies into the system prompt. Cognee failure is non-fatal (falls back to keywords).

Indexing (`indexDoc` in `src/index.ts`) runs fire-and-forget after create/update/reindex; status goes `pending` → `indexed`/`failed` in the `documents` row. Deletes are soft (`deleted=1`).

Auth (`src/auth.ts`): single admin password (hard-coded default in `config.ts`, override with `ADMIN_PASSWORD`), signed cookie, in-memory rate limiter.

## Migrations

`src/migrate.ts` has an append-only `MIGRATIONS` array; index+1 = `PRAGMA user_version`. Never edit or reorder existing entries; make each step idempotent. It auto-backs up the DB (`VACUUM INTO`) before migrating and refuses to run old code on a newer DB.

## Push, announcements, events

- **Web Push** (`src/push.ts`, `public/sw.js`, `public/push.js`): anonymous subscriptions in `push_subscriptions`; needs `VAPID_*` env vars (`npx web-push generate-vapid-keys`). Don't rotate keys once students subscribed. Saving a post with the admin "notify" checkbox runs `announce()` in `src/index.ts`: sets `documents.announced_at` (lists it on `/announcements`), has the LLM write the push text (`notificationText`, optional admin hint, not stored), pushes, and archives the result in `notifications`.
- **Events** (`events` table, `src/ics.ts`, `/calendar.ics`, `/events`): independent of posts. `doc_id` is a plain reference with no FK, so deleting a post never touches events. Never hard-delete events: cancel sets `cancelled=1` so the feed emits `STATUS:CANCELLED` (dropped after 30 days). `uid` is stable; `sequence` bumps on every edit. All times are IST (`src/time.ts`, `istToday()`); the feed tags them `TZID=Asia/Kolkata` with a fixed-offset VTIMEZONE. LLM `suggestEvents` only proposes; admin must confirm.
