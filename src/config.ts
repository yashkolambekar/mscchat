const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  dbPath: env.DB_PATH ?? "./data/app.db",
  // Hard coded on purpose (per project decision). Env var overrides it.
  adminPassword: env.ADMIN_PASSWORD ?? "msc-admin-2026",
  sessionSecret: env.SESSION_SECRET ?? "dev-secret-change-me",
  cognee: {
    url: (env.COGNEE_URL ?? "").replace(/\/$/, ""),
    apiKey: env.COGNEE_API_KEY ?? "",
    tenantId: env.COGNEE_TENANT_ID ?? "",
    dataset: env.COGNEE_DATASET ?? "msc-class",
  },
  cf: {
    accountId: env.CF_ACCOUNT_ID ?? "",
    apiToken: env.CF_API_TOKEN ?? "",
    model: env.CF_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
};
