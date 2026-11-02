import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { migrate } from "./migrate.js";

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
  created_at: string;
  updated_at: string;
};

const today = () => new Date().toISOString().slice(0, 10);
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
