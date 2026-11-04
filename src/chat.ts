import { chatLog, docs, events, isExpired, recency, type CalEvent, type Doc } from "./db.js";
import { searchDocIds } from "./cognee.js";
import { llm } from "./llm.js";
import { log } from "./log.js";
import { istToday, nextOccurrence } from "./time.js";

export type Turn = { role: "user" | "assistant"; content: string };

const SYSTEM = `You are a friendly, conversational class assistant for an MSc Computer Science course. Talk like a helpful classmate or TA, not like a search engine.
You may be given the admin's posted documents. They are the source of truth for anything class-specific.
Rules:
- Use the conversation so far. Follow-ups like "what is it for?", "and when?", "that one" refer to earlier messages.
- Answer from the documents first. Copy links, dates, times, rooms and deadlines exactly as written.
- If a student asks what something is or what it is for, explain it from the documents. If the documents do not say, say that clearly ("the admin's post doesn't say what it's for"), then add a short, helpful guess or general explanation clearly labelled as general knowledge, and suggest asking the admin to confirm.
- General, non-class questions (what is a Google Form, how to cite, etc.) you may answer briefly from general knowledge. Never invent class-specific facts: dates, deadlines, rooms, links, rules, names.
- Greetings and "what can you do" questions: answer naturally. You can explain announcements, deadlines, submissions and course info the admin has posted.
- Newer posts matter more. If documents conflict, prefer the most recently posted one and say the older info was replaced.
- Format for easy reading: short paragraphs separated by a blank line; "- " bullets for lists or steps; **bold** for key dates and deadlines. Put links as plain full URLs. No headings or tables.
- Keep replies short and natural. Ask a clarifying question if the question is really ambiguous.`;

/** One line describing an event for the LLM; weekly events show their next date. */
function eventLine(e: CalEvent): string {
  const o = nextOccurrence(e);
  const t = (s: string) => (e.all_day ? s.slice(0, 10) : s.replace("T", " "));
  const when = `${t(o.starts_at)}${o.ends_at ? " to " + (o.ends_at.slice(0, 10) === o.starts_at.slice(0, 10) ? o.ends_at.slice(11) : t(o.ends_at)) : ""}${e.all_day ? " (all day)" : ""}`;
  const day = new Date(`${o.starts_at.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${e.title}: ${e.repeat ? `every ${day}, next on ` : ""}${when}${e.location ? `, at ${e.location}` : ""}${e.notes ? `. ${e.notes}` : ""}`;
}

/** Turn a follow-up into a standalone search query using the chat history. */
async function standaloneQuery(question: string, history: Turn[]): Promise<string> {
  if (history.length === 0) return question;
  try {
    const convo = history.map((t) => `${t.role}: ${t.content}`).join("\n");
    const q = await llm(
      [
        {
          role: "system",
          content:
            "Rewrite the student's last message as one standalone search query that includes the subject from the conversation. Output only the query, no quotes, under 25 words.",
        },
        { role: "user", content: `Conversation:\n${convo}\n\nLast message: ${question}` },
      ],
      60,
    );
    return q.replace(/^["']|["']$/g, "").trim() || question;
  } catch (e) {
    log("chat", "query rewrite failed, using raw question", e instanceof Error ? e.message : String(e));
    return question;
  }
}

export async function answer(question: string, history: Turn[] = [], prevDocIds: number[] = []) {
  log("chat", `question: "${question}" (history=${history.length}, prevDocs=${JSON.stringify(prevDocIds)})`);
  const query = await standaloneQuery(question, history);
  log("chat", `search query: "${query}"`);

  let ids: number[] = [];
  try {
    ids = await searchDocIds(query, 5);
  } catch (e) {
    log("chat", "cognee search failed, continuing with fallbacks", e instanceof Error ? e.message : String(e));
  }
  // Expired posts are never used. Blend search relevance with recency so newer posts rank higher.
  const hits = docs.getMany(ids).filter((d) => !isExpired(d));
  let found: Doc[] = hits
    .map((d, i) => ({ d, score: (hits.length - i) / hits.length + 0.6 * recency(d) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.d);
  log("chat", `cognee ids=${JSON.stringify(ids)} -> found in sqlite=${JSON.stringify(found.map((d) => d.id))}`);

  // Top up with keyword matches so a weak semantic search never leaves the answer ungrounded.
  if (found.length < 3) {
    for (const d of docs.keywordSearch(query, 3)) {
      if (found.length < 3 && !found.some((f) => f.id === d.id)) found.push(d);
    }
    log("chat", `after keyword top-up -> ${JSON.stringify(found.map((d) => d.id))}`);
  }
  // Keep docs from the previous turn so follow-ups stay grounded.
  for (const d of docs.getMany(prevDocIds)) {
    if (!isExpired(d) && found.length < 3 && !found.some((f) => f.id === d.id)) found.push(d);
  }
  log("chat", `final docs=${JSON.stringify(found.map((d) => d.id))}`);

  const context = found.length
    ? found.map((d) => `--- Document "${d.title}" (posted ${d.created_at}${d.updated_at !== d.created_at ? `, edited ${d.updated_at}` : ""}${d.expires_at ? `, valid until ${d.expires_at}` : ""}) ---\n${d.body}`).join("\n\n")
    : "(no admin documents matched this question)";

  // Events linked to the chosen posts (independent rows, so this works even if the post wording is vague).
  const evs = events.forDocs(found.map((d) => d.id));
  const eventsCtx = evs.length
    ? `\n\nCalendar events linked to those documents (times are IST; these are exact):\n${evs.map((e) => `- ${eventLine(e)} (from document "${found.find((d) => d.id === e.doc_id)?.title}")`).join("\n")}`
    : "";
  if (evs.length) log("chat", `events=${JSON.stringify(evs.map((e) => e.id))}`);

  const a = await llm(
    [
      { role: "system", content: `${SYSTEM}\n\nToday is ${istToday()}.\n\nAdmin documents:\n${context}${eventsCtx}` },
      ...history,
      { role: "user", content: question },
    ],
    600,
  );
  log("chat", "answer", a);
  chatLog.add(question, a, found.map((d) => d.id));
  return { answer: a, sources: found.map((d) => ({ id: d.id, title: d.title })) };
}
