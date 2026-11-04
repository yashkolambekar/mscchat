import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { config } from "./config.js";
import { migrate } from "./migrate.js";
import { istToday } from "./time.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
migrate(db, config.dbPath);

export type Doc = {
  id: number;
  title: string;
  body: string;
  summary: string;
  index_status: "pending" | "indexed" | "failed";
  index_error: string | null;
  deleted: number;
  expires_at: string | null;
  announced_at: string | null;
  created_at: string;
  updated_at: string;
};

const today = istToday;
/** Expired = expiry date is before today (UTC). */
export const isExpired = (d: Doc) => !!d.expires_at && d.expires_at < today();
/** 1 for brand new, halves roughly every 31 days. Newer posts count for more. */
export const recency = (d: Doc) => {
  const ageDays = Math.max(0, (Date.now() - Date.parse(d.created_at.replace(" ", "T") + "Z")) / 86_400_000);
  return Math.exp(-ageDays / 45);
};

export const docs = {
  list: () =>
    db
      .prepare("SELECT * FROM documents WHERE deleted = 0 ORDER BY updated_at DESC, id DESC")
      .all() as Doc[],
  get: (id: number) =>
    db.prepare("SELECT * FROM documents WHERE id = ? AND deleted = 0").get(id) as Doc | undefined,
  getMany: (ids: number[]) =>
    ids.map((id) => docs.get(id)).filter((d): d is Doc => !!d),
  /** Keyword fallback when Cognee returns nothing: rank docs by how many query words they contain. */
  keywordSearch: (query: string, limit = 3): Doc[] => {
    const stop = new Set(["the", "and", "what", "are", "is", "a", "an", "of", "to", "in", "for", "how", "when", "where", "who", "why", "can", "you", "do", "does", "i", "my", "me", "about", "tell", "this", "that", "with", "wtf"]);
    const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].filter((w) => !stop.has(w));
    if (!words.length) return [];
    return docs
      .list()
      .filter((d) => !isExpired(d))
      .map((d) => {
        const hay = `${d.title} ${d.summary} ${d.body}`.toLowerCase();
        return { d, score: words.filter((w) => hay.includes(w)).length + recency(d) * 0.9 };
      })
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.d);
  },
  create: (title: string, body: string, expiresAt: string | null = null) =>
    Number(
      db.prepare("INSERT INTO documents (title, body, expires_at) VALUES (?, ?, ?)").run(title, body, expiresAt)
        .lastInsertRowid,
    ),
  update: (id: number, title: string, body: string, expiresAt: string | null = null) =>
    db
      .prepare(
        "UPDATE documents SET title=?, body=?, expires_at=?, index_status='pending', index_error=NULL, updated_at=datetime('now') WHERE id=? AND deleted=0",
      )
      .run(title, body, expiresAt, id),
  /** Posts the admin sent a notification for, newest announcement first. */
  announcements: (): Doc[] =>
    db
      .prepare("SELECT * FROM documents WHERE deleted = 0 AND announced_at IS NOT NULL ORDER BY announced_at DESC, id DESC")
      .all() as Doc[],
  markAnnounced: (id: number) =>
    db.prepare("UPDATE documents SET announced_at=datetime('now') WHERE id=? AND deleted=0").run(id),
  setSummary: (id: number, summary: string) =>
    db.prepare("UPDATE documents SET summary=? WHERE id=?").run(summary, id),
  setStatus: (id: number, status: Doc["index_status"], error: string | null = null) =>
    db.prepare("UPDATE documents SET index_status=?, index_error=? WHERE id=?").run(status, error, id),
  remove: (id: number) =>
    db.prepare("UPDATE documents SET deleted=1, updated_at=datetime('now') WHERE id=?").run(id),
};

export const chatLog = {
  add: (q: string, a: string, ids: number[]) =>
    db
      .prepare("INSERT INTO chat_log (question, answer, doc_ids) VALUES (?, ?, ?)")
      .run(q, a, JSON.stringify(ids)),
  recent: (limit = 100) =>
    db.prepare("SELECT * FROM chat_log ORDER BY id DESC LIMIT ?").all(limit),
};

export type PushSub = { endpoint: string; p256dh: string; auth: string };
export const pushSubs = {
  all: () => db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as PushSub[],
  upsert: (s: PushSub) =>
    db
      .prepare(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth",
      )
      .run(s.endpoint, s.p256dh, s.auth),
  remove: (endpoint: string) => db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint),
};

export const notifications = {
  add: (n: { docId: number; docTitle: string; hint: string | null; title: string; body: string }) =>
    Number(
      db
        .prepare("INSERT INTO notifications (doc_id, doc_title, hint, title, body) VALUES (?, ?, ?, ?, ?)")
        .run(n.docId, n.docTitle, n.hint, n.title, n.body).lastInsertRowid,
    ),
  setDelivery: (id: number, subscribers: number, delivered: number) =>
    db.prepare("UPDATE notifications SET subscribers=?, delivered=? WHERE id=?").run(subscribers, delivered, id),
  /** Called when a student taps the push notification. */
  opened: (id: number) => db.prepare("UPDATE notifications SET opens = opens + 1 WHERE id=?").run(id),
  recent: (limit = 200) => db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit),
};

export type CalEvent = {
  id: number;
  uid: string;
  title: string;
  /** "YYYY-MM-DD" when all_day, else floating local "YYYY-MM-DDTHH:MM". */
  starts_at: string;
  ends_at: string | null;
  all_day: number;
  location: string | null;
  notes: string | null;
  doc_id: number | null;
  sequence: number;
  repeat: "weekly" | null;
  cancelled: number;
  created_at: string;
  updated_at: string;
};
export type EventInput = Pick<CalEvent, "title" | "starts_at" | "ends_at" | "location" | "notes" | "doc_id" | "repeat"> & { all_day: boolean };

export const events = {
  /** Admin list: everything, soonest first. */
  list: () => db.prepare("SELECT * FROM events ORDER BY starts_at ASC, id ASC").all() as CalEvent[],
  /** Student list: not cancelled, not already over. */
  upcoming: () =>
    db
      .prepare("SELECT * FROM events WHERE cancelled = 0 AND (repeat IS NOT NULL OR substr(coalesce(ends_at, starts_at), 1, 10) >= ?) ORDER BY starts_at ASC, id ASC")
      .all(today()) as CalEvent[],
  /** Live events linked to any of these posts (for chat context). */
  forDocs: (ids: number[]) =>
    ids.length
      ? (db
          .prepare(
            `SELECT * FROM events WHERE cancelled = 0 AND doc_id IN (${ids.map(() => "?").join(",")}) AND (repeat IS NOT NULL OR substr(coalesce(ends_at, starts_at), 1, 10) >= ?) ORDER BY starts_at ASC`,
          )
          .all(...ids, today()) as CalEvent[])
      : [],
  /** ICS feed: live events plus events cancelled within the last 30 days (so clients drop them). */
  feed: () =>
    db
      .prepare("SELECT * FROM events WHERE cancelled = 0 OR updated_at >= datetime('now', '-30 days') ORDER BY starts_at ASC, id ASC")
      .all() as CalEvent[],
  get: (id: number) => db.prepare("SELECT * FROM events WHERE id = ?").get(id) as CalEvent | undefined,
  create: (e: EventInput) =>
    Number(
      db
        .prepare("INSERT INTO events (uid, title, starts_at, ends_at, all_day, location, notes, doc_id, repeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomBytes(12).toString("hex"), e.title, e.starts_at, e.ends_at, e.all_day ? 1 : 0, e.location, e.notes, e.doc_id, e.repeat).lastInsertRowid,
    ),
  update: (id: number, e: EventInput) =>
    db
      .prepare(
        "UPDATE events SET title=?, starts_at=?, ends_at=?, all_day=?, location=?, notes=?, doc_id=?, repeat=?, cancelled=0, sequence=sequence+1, updated_at=datetime('now') WHERE id=?",
      )
      .run(e.title, e.starts_at, e.ends_at, e.all_day ? 1 : 0, e.location, e.notes, e.doc_id, e.repeat, id),
  /** Soft delete: keeps the row so the feed can emit STATUS:CANCELLED. */
  cancel: (id: number) =>
    db.prepare("UPDATE events SET cancelled=1, sequence=sequence+1, updated_at=datetime('now') WHERE id=? AND cancelled=0").run(id),
};
