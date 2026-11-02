import { config } from "./config.js";
import { log } from "./log.js";

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { "X-Api-Key": config.cognee.apiKey };
  if (config.cognee.tenantId) h["X-Tenant-Id"] = config.cognee.tenantId;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function check(res: Response, what: string) {
  if (!res.ok) throw new Error(`Cognee ${what} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

const CHUNK_CHARS = 900;

/**
 * Split the FULL body into small chunks so every part of the post is searchable.
 * Every chunk carries "[doc:ID] title" so a hit on any chunk maps back to its post.
 * Chunks stay under Cognee's own chunk size, so each one is stored as-is.
 */
export function chunkDoc(id: number, title: string, body: string): string[] {
  const pieces: string[] = [];
  for (const para of body.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    let p = para.trim();
    while (p.length > CHUNK_CHARS) {
      // Prefer a sentence/line break, else a space, else a hard cut.
      let cut = Math.max(p.lastIndexOf(". ", CHUNK_CHARS), p.lastIndexOf("\n", CHUNK_CHARS));
      if (cut < CHUNK_CHARS / 2) cut = p.lastIndexOf(" ", CHUNK_CHARS);
      if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS;
      pieces.push(p.slice(0, cut + 1).trim());
      p = p.slice(cut + 1).trim();
    }
    if (p) pieces.push(p);
  }
  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + piece.length + 2 > CHUNK_CHARS) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + piece;
  }
  if (cur) chunks.push(cur);
  return chunks.map((t, i) => `[doc:${id}] ${title} (part ${i + 1}/${chunks.length})\n\n${t}`);
}

export async function addAndCognify(id: number, title: string, text: string) {
  if (!config.cognee.url || !config.cognee.apiKey) throw new Error("COGNEE_URL / COGNEE_API_KEY not set");
  log("cognee", `add doc ${id} -> dataset "${config.cognee.dataset}" at ${config.cognee.url}`);
  const form = new FormData();
  form.append("datasetName", config.cognee.dataset);
  // Upload as real text files: the "raw_data" string field returned data_ingestion_info:[] (nothing stored).
  const chunks = chunkDoc(id, title, text);
  log("cognee", `doc ${id}: ${chunks.length} chunk(s)`);
  chunks.forEach((t, i) => form.append("data", new Blob([t], { type: "text/plain" }), `doc-${id}-part-${i + 1}.txt`));
  const addRes = await fetch(`${config.cognee.url}/api/v1/add`, { method: "POST", headers: headers(false), body: form });
  const addBody = await addRes.clone().text();
  log("cognee", `add response ${addRes.status}`, addBody.slice(0, 500));
  await check(addRes, "add");
  try {
    const ingest = JSON.parse(addBody);
    if (!ingest.data_ingestion_info?.length)
      log("cognee", `WARNING add doc ${id}: data_ingestion_info is empty, Cognee may not have stored anything`);
    if (ingest.dataset_id) {
      const lr = await fetch(`${config.cognee.url}/api/v1/datasets/${ingest.dataset_id}/data`, { headers: headers(false) });
      const lt = await lr.text();
      log("cognee", `dataset now holds (${lr.status})`, lt.slice(0, 600));
    }
  } catch (e) {
    log("cognee", "post-add check failed", e instanceof Error ? e.message : String(e));
  }
  log("cognee", `cognify start doc ${id} (may take a while)`);
  const res = await check(
    await fetch(`${config.cognee.url}/api/v1/cognify`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ datasets: [config.cognee.dataset] }),
    }),
    "cognify",
  );
  // Response shape is undocumented: log it, and fail if it reports an errored pipeline.
  const body = await res.text();
  log("cognee", `cognify response ${res.status} doc ${id}`, body.slice(0, 500));
  if (/errored|failed/i.test(body)) throw new Error(`Cognee cognify reported failure: ${body.slice(0, 300)}`);

  // Cloud cognify is async ("PipelineRunStarted"): wait until the pipeline really finishes.
  let datasetId = "";
  try {
    datasetId = Object.keys(JSON.parse(body))[0] ?? "";
  } catch {}
  if (!datasetId) {
    log("cognee", "no dataset id in cognify response; cannot poll status");
    return;
  }
  await waitForPipeline(datasetId, id);
}

async function waitForPipeline(datasetId: string, docId: number, timeoutMs = 5 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${config.cognee.url}/api/v1/datasets/status?dataset=${datasetId}`, {
      headers: headers(false),
    });
    const txt = await res.text();
    log("cognee", `pipeline status doc ${docId} (${res.status}, ${Math.round((Date.now() - t0) / 1000)}s)`, txt.slice(0, 300));
    if (!res.ok) {
      log("cognee", "status endpoint unavailable; assuming done");
      return;
    }
    if (/error/i.test(txt)) throw new Error(`Cognee pipeline errored: ${txt.slice(0, 300)}`);
    if (/complet/i.test(txt)) return;
  }
  throw new Error("Cognee cognify timed out after 5 minutes");
}

/**
 * Returns doc ids found in search hits, best first.
 * The CHUNKS response shape is not documented, so parse defensively:
 * stringify the whole response and pull every "[doc:N]" tag in order.
 */
export async function searchDocIds(query: string, topK = 10): Promise<number[]> {
  if (!config.cognee.url || !config.cognee.apiKey) throw new Error("COGNEE_URL / COGNEE_API_KEY not set");
  log("cognee", `search "${query}" dataset="${config.cognee.dataset}" top_k=${topK}`);
  const raw = await fetch(`${config.cognee.url}/api/v1/search`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        query,
        search_type: "CHUNKS",
        datasets: [config.cognee.dataset],
        top_k: topK,
      }),
    });
  log("cognee", `search status ${raw.status}`);
  // Nothing indexed yet (or cognify still running) is not an error: no hits.
  if (raw.status === 404) {
    const t = await raw.text();
    log("cognee", "search 404 body", t.slice(0, 500));
    if (t.includes("NoDataError")) return [];
    throw new Error(`Cognee search 404: ${t.slice(0, 300)}`);
  }
  const res = await check(raw, "search");
  const text = JSON.stringify(await res.json());
  log("cognee", `search raw response (${text.length} chars)`, text.slice(0, 1500));
  const ids: number[] = [];
  for (const m of text.matchAll(/\[doc:(\d+)\]/g)) {
    const id = Number(m[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  log("cognee", "doc ids parsed from hits", ids);
  return ids;
}
