import { config } from "./config.js";
import { log } from "./log.js";

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
  const r = json.result?.response ?? json.result?.choices?.[0]?.message?.content;
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
