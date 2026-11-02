import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { config } from "./config.js";

const COOKIE = "admin_session";
const TTL_MS = 1000 * 60 * 60 * 12;

const sign = (v: string) => createHmac("sha256", config.sessionSecret).update(v).digest("hex");

export function makeToken(): string {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function validToken(t: string | undefined): boolean {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function passwordOk(p: string): boolean {
  const a = Buffer.from(p);
  const b = Buffer.from(config.adminPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const COOKIE_NAME = COOKIE;
export const COOKIE_MAX_AGE = TTL_MS / 1000;

export async function requireAdmin(c: Context, next: Next) {
  if (!validToken(getCookie(c, COOKIE))) return c.json({ error: "unauthorized" }, 401);
  await next();
}

/** Simple in-memory fixed-window limiter per key. */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return async (c: Context, next: Next) => {
    const key =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "local";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return c.json({ error: "Too many requests, slow down." }, 429);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    await next();
  };
}
