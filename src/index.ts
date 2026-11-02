import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config } from "./config.js";
import { log } from "./log.js";
import { chatLog, docs, isExpired } from "./db.js";
import { answer } from "./chat.js";
import { addAndCognify } from "./cognee.js";
import { rewriteDoc, summarize } from "./llm.js";
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
  return c.json({ id }, 201);
});
admin.put("/documents/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const p = docBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success || !docs.get(id)) return c.json({ error: "Bad request" }, 400);
  docs.update(id, p.data.title, p.data.body, p.data.expires_at);
  void indexDoc(id);
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
admin.get("/chat-log", (c) => c.json(chatLog.recent(100)));
app.route("/api/admin", admin);

// ---------- static ----------
app.get("/admin", (c) => c.redirect("/admin/"));
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
