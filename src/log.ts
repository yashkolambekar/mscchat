export function log(scope: string, msg: string, data?: unknown) {
  const t = new Date().toISOString();
  const extra = data === undefined ? "" : " " + (typeof data === "string" ? data : JSON.stringify(data));
  console.log(`[${t}] [${scope}] ${msg}${extra}`);
}
