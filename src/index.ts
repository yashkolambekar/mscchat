import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config } from "./config.js";
import { log } from "./log.js";
import { chatLog, docs, events, type CalEvent, isExpired, notifications, pushSubs } from "./db.js";
import { notifyAll, pushEnabled } from "./push.js";
import { answer } from "./chat.js";
import { addAndCognify } from "./cognee.js";
import { buildIcs } from "./ics.js";
import { nextOccurrence } from "./time.js";
import { notificationText, rewriteDoc, suggestEvents, summarize } from "./llm.js";
import { COOKIE_MAX_AGE, COOKIE_NAME, makeToken, passwordOk, rateLimit, requireAdmin } from "./auth.js";

const app = new Hono();
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  log("http", `${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - t0}ms)`);
});

/** Summarize + push to Cognee in background; record status in SQLite. */
async function indexDoc(id: number) {
  const d = docs.get(id);
  if (!d) return;
  try {
    log("index", `doc ${id} "${d.title}": start`);
    docs.setStatus(id, "pending");
    // Summary is only for the admin list and keyword fallback; failing here must not block indexing.
    try {
      const summary = await summarize(d.title, d.body);
      log("index", `doc ${id}: summary`, summary);
      docs.setSummary(id, summary);
    } catch (e) {
      log("index", `doc ${id}: summary failed (continuing)`, e instanceof Error ? e.message : String(e));
    }
    // Index the FULL text (chunked), not the summary.
    await addAndCognify([{ id, title: d.title, text: d.body }]);
    docs.setStatus(id, "indexed");
    log("index", `doc ${id}: INDEXED`);
  } catch (e) {
    log("index", `doc ${id}: FAILED`, e instanceof Error ? e.message : String(e));
    docs.setStatus(id, "failed", e instanceof Error ? e.message : String(e));
  }
}

/** List the post on /announcements now; generate the notification text with the LLM and push in background. */
function announce(id: number, title: string, body: string, hint: string | null) {
  docs.markAnnounced(id);
  void (async () => {
    try {
      const n = await notificationText(title, body, hint);
      log("push", `notification for doc ${id}`, n);
      // Archive first so the push can carry the row id and clicks can be counted against it.
      const nid = notifications.add({ docId: id, docTitle: title, hint, ...n });
      const r = await notifyAll({ ...n, url: "/announcements", nid });
      notifications.setDelivery(nid, r.subscribers, r.delivered);
    } catch (e) {
      log("push", `announce doc ${id} FAILED`, e instanceof Error ? e.message : String(e));
    }
  })();
}

// ---------- student ----------
const chatBody = z.object({
  question: z.string().trim().min(1).max(500),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(3000) }))
    .max(10)
    .default([]),
  prevDocIds: z.array(z.number().int()).max(5).default([]),
});
app.post("/api/chat", rateLimit(15, 60_000), async (c) => {
  const parsed = chatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Question must be 1-500 characters." }, 400);
  try {
    return c.json(await answer(parsed.data.question, parsed.data.history, parsed.data.prevDocIds));
  } catch (e) {
    log("chat", "FAILED", e instanceof Error ? (e.stack ?? e.message) : String(e));
    return c.json({ error: "The assistant is unavailable right now. Please try again later." }, 502);
  }
});

/** Public read of an admin post, so students can open the sources cited in answers. */
app.get("/api/docs/:id", rateLimit(60, 60_000), (c) => {
  const d = docs.get(Number(c.req.param("id")));
  if (!d || isExpired(d)) return c.json({ error: "Not found" }, 404);
  return c.json({ id: d.id, title: d.title, body: d.body, created_at: d.created_at, updated_at: d.updated_at, expires_at: d.expires_at });
});

/** Public list of posts the admin flagged as important (not expired). */
app.get("/api/announcements", rateLimit(60, 60_000), (c) =>
  c.json(
    docs
      .announcements()
      .filter((d) => !isExpired(d))
      .map((d) => ({ id: d.id, title: d.title, body: d.body, announced_at: d.announced_at, expires_at: d.expires_at })),
  ),
);

// ---------- events / calendar ----------
const publicEvent = (e: CalEvent) => {
  const d = e.doc_id ? docs.get(e.doc_id) : undefined; // linked post may be gone: event still stands
  return { id: e.id, title: e.title, ...nextOccurrence(e), repeat: e.repeat, all_day: !!e.all_day, location: e.location, notes: e.notes, post_id: d && !isExpired(d) ? d.id : null };
};
app.get("/api/events", rateLimit(60, 60_000), (c) => c.json(events.upcoming().map(publicEvent).sort((a, b) => a.starts_at.localeCompare(b.starts_at))));
app.get("/calendar.ics", rateLimit(60, 60_000), (c) => {
  const origin = new URL(c.req.url).origin;
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(buildIcs(events.feed(), (id) => `${origin}/post.html?id=${id}`));
});

// ---------- push (anonymous students) ----------
const subBody = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
app.get("/api/push/key", (c) => (pushEnabled ? c.json({ key: config.vapid.publicKey }) : c.json({ error: "Push disabled" }, 503)));
app.post("/api/push/subscribe", rateLimit(10, 60_000), async (c) => {
  const p = subBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Bad subscription" }, 400);
  pushSubs.upsert({ endpoint: p.data.endpoint, p256dh: p.data.keys.p256dh, auth: p.data.keys.auth });
  return c.json({ ok: true }, 201);
});
app.post("/api/push/opened", rateLimit(30, 60_000), async (c) => {
  const p = z.object({ nid: z.number().int().positive() }).safeParse(await c.req.json().catch(() => null));
  if (p.success) notifications.opened(p.data.nid);
  return c.json({ ok: true });
});
app.post("/api/push/unsubscribe", rateLimit(10, 60_000), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.endpoint === "string") pushSubs.remove(body.endpoint);
  return c.json({ ok: true });
});

// ---------- admin ----------
app.post("/api/admin/login", rateLimit(8, 60_000), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!passwordOk(String(body?.password ?? ""))) return c.json({ error: "Wrong password" }, 401);
  setCookie(c, COOKIE_NAME, makeToken(), {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return c.json({ ok: true });
});
app.post("/api/admin/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

const admin = new Hono();
admin.use("*", requireAdmin);
admin.get("/me", (c) => c.json({ ok: true }));

const docBody = z.object({
  notify: z.boolean().default(false),
  notify_hint: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(100).nullish().transform((v) => v ?? null)),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(50_000),
  expires_at: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().transform((v) => v ?? null)),
});
admin.post("/rewrite", async (c) => {
  const p = docBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Title and text required." }, 400);
  try {
    return c.json(await rewriteDoc(p.data.title, p.data.body));
  } catch (e) {
    log("rewrite", "FAILED", e instanceof Error ? e.message : String(e));
    return c.json({ error: e instanceof Error ? e.message : "Rewrite failed." }, 502);
  }
});
admin.get("/documents", (c) => c.json(docs.list()));
admin.post("/documents", async (c) => {
  const p = docBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Title and text required." }, 400);
  const id = docs.create(p.data.title, p.data.body, p.data.expires_at);
  void indexDoc(id);
  if (p.data.notify) announce(id, p.data.title, p.data.body, p.data.notify_hint);
  return c.json({ id }, 201);
});
admin.put("/documents/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const p = docBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success || !docs.get(id)) return c.json({ error: "Bad request" }, 400);
  docs.update(id, p.data.title, p.data.body, p.data.expires_at);
  void indexDoc(id);
  if (p.data.notify) announce(id, p.data.title, p.data.body, p.data.notify_hint);
  return c.json({ ok: true });
});
admin.post("/documents/:id/reindex", (c) => {
  const id = Number(c.req.param("id"));
  if (!docs.get(id)) return c.json({ error: "Not found" }, 404);
  void indexDoc(id);
  return c.json({ ok: true });
});
/** Re-index every post in ONE add + cognify (needed once after changing how posts are indexed). */
let reindexing = false;
admin.post("/reindex-all", (c) => {
  if (reindexing) return c.json({ error: "Re-index is already running. Wait for it to finish." }, 409);
  const all = docs.list();
  if (!all.length) return c.json({ error: "No documents to index." }, 400);
  reindexing = true;
  for (const d of all) docs.setStatus(d.id, "pending");
  void (async () => {
    try {
      log("index", `re-index all: ${all.length} post(s)`);
      await addAndCognify(all.map((d) => ({ id: d.id, title: d.title, text: d.body })));
      for (const d of all) docs.setStatus(d.id, "indexed");
      log("index", "re-index all: DONE");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("index", "re-index all: FAILED", msg);
      for (const d of all) docs.setStatus(d.id, "failed", msg);
    } finally {
      reindexing = false;
    }
  })();
  return c.json({ ok: true, count: all.length });
});
admin.delete("/documents/:id", (c) => {
  docs.remove(Number(c.req.param("id")));
  return c.json({ ok: true });
});
const D = /^\d{4}-\d{2}-\d{2}$/;
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const nz = (max: number) => z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(max).nullish().transform((v) => v ?? null));
const eventBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    all_day: z.boolean(),
    starts_at: z.string(),
    ends_at: z.preprocess((v) => (v === "" ? null : v), z.string().nullish().transform((v) => v ?? null)),
    location: nz(200),
    notes: nz(2000),
    doc_id: z.number().int().nullish().transform((v) => v ?? null),
    repeat: z.enum(["weekly"]).nullish().transform((v) => v ?? null),
  })
  .refine((e) => (e.all_day ? D : DT).test(e.starts_at) && (e.ends_at === null || (e.all_day ? D : DT).test(e.ends_at)), "Bad date/time format.")
  .refine((e) => e.ends_at === null || e.ends_at >= e.starts_at, "End must not be before start.");
admin.get("/events", (c) => c.json(events.list()));
admin.post("/events/suggest", async (c) => {
  const p = z.object({ title: z.string().max(200), body: z.string().max(50_000) }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Bad request" }, 400);
  try {
    return c.json(await suggestEvents(p.data.title, p.data.body));
  } catch (e) {
    log("events", "suggest FAILED", e instanceof Error ? e.message : String(e));
    return c.json({ error: e instanceof Error ? e.message : "Suggestion failed." }, 502);
  }
});
admin.post("/events", async (c) => {
  const p = eventBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "Bad request" }, 400);
  return c.json({ id: events.create(p.data) }, 201);
});
admin.put("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const p = eventBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success || !events.get(id)) return c.json({ error: p.success ? "Not found" : (p.error.issues[0]?.message ?? "Bad request") }, 400);
  events.update(id, p.data);
  return c.json({ ok: true });
});
admin.delete("/events/:id", (c) => {
  events.cancel(Number(c.req.param("id")));
  return c.json({ ok: true });
});
admin.get("/notifications", (c) => c.json(notifications.recent()));
admin.get("/chat-log", (c) => c.json(chatLog.recent(100)));
app.route("/api/admin", admin);

// ---------- static ----------
app.get("/admin", (c) => c.redirect("/admin/"));
app.get("/announcements", (c) => c.redirect("/announcements.html"));
app.get("/events", (c) => c.redirect("/events.html"));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port }, (i) => {
  log("boot", `mscbot on :${i.port}`);
  log("boot", "config", {
    db: config.dbPath,
    cogneeUrl: config.cognee.url || "(MISSING)",
    cogneeKey: config.cognee.apiKey ? "set" : "(MISSING)",
    cogneeTenant: config.cognee.tenantId || "(none)",
    cogneeDataset: config.cognee.dataset,
    cfAccount: config.cf.accountId ? "set" : "(MISSING)",
    cfToken: config.cf.apiToken ? "set" : "(MISSING)",
    cfModel: config.cf.model,
  });
});
