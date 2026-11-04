import { config } from "./config.js";
import { log } from "./log.js";
import { istToday } from "./time.js";

type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function llm(messages: Msg[], maxTokens = 600): Promise<string> {
  const { accountId, apiToken, model } = config.cf;
  if (!accountId || !apiToken) throw new Error("CF_ACCOUNT_ID / CF_API_TOKEN not set");
  log("llm", `call model=${model} messages=${messages.length} chars=${messages.reduce((n, m) => n + m.content.length, 0)}`);
  const t0 = Date.now();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: maxTokens }),
    },
  );
  const json = (await res.json()) as any;
  log("llm", `response ${res.status} in ${Date.now() - t0}ms`, JSON.stringify(json).slice(0, 800));
  if (!res.ok || json.success === false) {
    throw new Error(`Workers AI error ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  let r = json.result?.response ?? json.result?.choices?.[0]?.message?.content;
  // Workers AI returns already-parsed JSON (array/object) when the model output is pure JSON.
  if (r !== null && typeof r === "object") r = JSON.stringify(r);
  if (typeof r !== "string") throw new Error("Workers AI: unexpected response shape");
  return r.trim();
}

export function summarize(title: string, body: string): Promise<string> {
  return llm(
    [
      {
        role: "system",
        content:
          "Summarize class announcements in 50-80 words. Keep every date, time, room, deadline, name, link and number exact. Reuse the exact terms from the text (e.g. if it says Google Sheet, never write Excel). Do not add facts. Output only the summary.",
      },
      { role: "user", content: `Title: ${title}\n\n${body}` },
    ],
    250,
  );
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Clean up an admin draft. Throws if the model changed a link. */
export async function rewriteDoc(title: string, body: string): Promise<{ title: string; body: string }> {
  const out = await llm(
    [
      {
        role: "system",
        content: `You polish an admin's class announcement for students. Fix spelling, grammar and unclear wording. Make it clear, friendly and well organised: short paragraphs, "- " bullets for lists of items or steps, **bold** for key dates/deadlines.
Hard rules:
- Keep every fact exactly: dates, times, rooms, deadlines, names, numbers, URLs. Copy URLs character for character.
- Do not add facts, opinions or new links. Do not remove facts.
- Keep the original language. Do not use markdown headings or tables.
Output format, nothing else:
TITLE: <improved short title>
---
<improved text>`,
      },
      { role: "user", content: `TITLE: ${title}\n---\n${body}` },
    ],
    2500,
  );
  const m = out.match(/^\s*TITLE:\s*(.+?)\s*\n-{3,}\s*\n([\s\S]+)$/);
  if (!m) throw new Error("Rewrite came back in an unexpected format.");
  const newBody = m[2].trim();
  const missing = (body.match(URL_RE) ?? []).filter((u) => !newBody.includes(u));
  if (missing.length) throw new Error(`Rewrite changed a link (${missing[0]}). Keeping your original is safer.`);
  return { title: m[1].trim().slice(0, 200), body: newBody };
}

/** Short push-notification text. Falls back to the post title if the model fails or answers oddly. */
export async function notificationText(title: string, body: string, hint: string | null = null): Promise<{ title: string; body: string }> {
  const fallback = { title: (hint || title).slice(0, 60), body: "Important update for the class. Tap to read." };
  try {
    const out = await llm(
      [
        {
          role: "system",
          content: `You write push notifications that tell MSc students about an important class announcement.
Rules:
- Headline: max 50 characters, states what happened or what is needed. No emoji, no quotes.
- Body: max 120 characters, one or two short sentences with the most important fact (deadline, date, time, room, action). Copy dates, times, rooms and numbers exactly. Do not add facts. No links.
- Keep the original language.
- If the admin gives a heading hint, base the headline on it. It is a hint for wording only: never copy facts from it that the announcement does not support.
Output format, nothing else:
HEADLINE: <headline>
---
<body>`,
        },
        { role: "user", content: `${hint ? `Admin heading hint: ${hint}\n` : ""}Title: ${title}\n\n${body}` },
      ],
      120,
    );
    const m = out.match(/^\s*HEADLINE:\s*(.+?)\s*\n-{3,}\s*\n([\s\S]+)$/);
    if (!m) throw new Error("unexpected format");
    return { title: m[1].replace(/^["']|["']$/g, "").trim().slice(0, 60) || fallback.title, body: m[2].trim().slice(0, 140) || fallback.body };
  } catch (e) {
    log("llm", "notification text failed, using fallback", e instanceof Error ? e.message : String(e));
    return fallback;
  }
}

export type EventSuggestion = { title: string; starts_at: string; ends_at: string | null; all_day: boolean; location: string | null; repeat: "weekly" | null };

/** Propose calendar events found in a post. Never saved automatically; the admin confirms each one. */
export async function suggestEvents(title: string, body: string): Promise<EventSuggestion[]> {
  const out = await llm(
    [
      {
        role: "system",
        content: `You extract calendar events (deadlines, classes, exams, meetings) from a class announcement.
Today is ${istToday()} (India Standard Time).
Two kinds of event:
1. One-off, with an explicit date in the text. starts_at: "YYYY-MM-DD" if no time is given (all_day true), else "YYYY-MM-DDTHH:MM" 24h (all_day false). ends_at likewise or null. Set weekday and time to null, repeat to null.
2. Weekly recurring ("every Sunday at 1pm", "lectures on Mondays 10-11"). Set repeat to "weekly", weekday to the English day name in lowercase, time to "HH:MM" 24h (or null if none given), end_time to "HH:MM" or null. Set starts_at and ends_at to null. Never invent a date for these.
Rules:
- Never guess a date, time or location that the text does not state.
- Deadlines are events at their stated time (or all day).
- title: short and specific, e.g. "Assignment 2 due" or "Digital Gooning lecture (Mr. Shivam Lendiya)".
Output ONLY a JSON array, no prose: [{"title":"","starts_at":null,"ends_at":null,"all_day":true,"location":null,"repeat":null,"weekday":null,"time":null,"end_time":null}]. Output [] if none.`,
      },
      { role: "user", content: `Title: ${title}\n\n${body}` },
    ],
    700,
  );
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("Event suggestion came back in an unexpected format.");
  const arr = JSON.parse(m[0]) as unknown;
  if (!Array.isArray(arr)) throw new Error("Event suggestion came back in an unexpected format.");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const dtRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const res: EventSuggestion[] = [];
  for (const x of arr as Record<string, unknown>[]) {
    if (typeof x.title !== "string" || !x.title.trim()) continue;
    const title = x.title.trim().slice(0, 200);
    const location = typeof x.location === "string" && x.location.trim() ? x.location.trim().slice(0, 200) : null;
    const wd = typeof x.weekday === "string" ? days.indexOf(x.weekday.trim().toLowerCase()) : -1;
    if (x.repeat === "weekly" && wd >= 0) {
      // The model names the weekday; the server works out the date (models are bad at calendar maths).
      const t = typeof x.time === "string" && timeRe.test(x.time) ? x.time : null;
      const et = t && typeof x.end_time === "string" && timeRe.test(x.end_time) && x.end_time > t ? x.end_time : null;
      const d = new Date(`${istToday()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + ((wd - d.getUTCDay() + 7) % 7));
      const day = d.toISOString().slice(0, 10);
      res.push({ title, location, repeat: "weekly", all_day: !t, starts_at: t ? `${day}T${t}` : day, ends_at: et ? `${day}T${et}` : null });
      continue;
    }
    const allDay = x.all_day === true;
    const ok = (v: unknown): v is string => typeof v === "string" && (allDay ? dateRe.test(v) : dtRe.test(v));
    if (!ok(x.starts_at)) continue;
    res.push({ title, location, repeat: null, all_day: allDay, starts_at: x.starts_at, ends_at: ok(x.ends_at) ? x.ends_at : null });
  }
  return res.slice(0, 10);
}
