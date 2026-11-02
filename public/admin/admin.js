const $ = (id) => document.getElementById(id);
let editingId = null;
let pollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch("/api/admin" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401 && path !== "/login") { showLogin(); throw new Error("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showLogin() {
  clearTimeout(pollTimer);
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
}
function showApp() {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  loadDocs();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginErr").textContent = "";
  try {
    await api("/login", { method: "POST", body: JSON.stringify({ password: $("pw").value }) });
    $("pw").value = "";
    showApp();
  } catch (err) { $("loginErr").textContent = err.message; }
});
$("logout").addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" });
  showLogin();
});

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

const isExpired = (d) => !!d.expires_at && d.expires_at < new Date().toISOString().slice(0, 10);

const postUrl = (id) => `${location.origin}/post.html?id=${id}`;
async function copyLink(id, btn) {
  try { await navigator.clipboard.writeText(postUrl(id)); }
  catch { prompt("Copy this link:", postUrl(id)); return; }
  const old = btn.textContent;
  btn.textContent = "Copied ✓";
  setTimeout(() => (btn.textContent = old), 1500);
}

async function loadDocs() {
  clearTimeout(pollTimer);
  const list = await api("/documents");
  const box = $("docList");
  box.replaceChildren();
  if (!list.length) box.append(el("p", { className: "muted", textContent: "No documents yet." }));
  for (const d of list) {
    const actions = el("div", { className: "row" },
      el("a", { className: "btn", textContent: "Open", href: postUrl(d.id), target: "_blank", rel: "noopener", style: "text-decoration:none" }),
      el("button", { className: "btn", textContent: "Copy link", onclick: (e) => copyLink(d.id, e.target) }),
      el("button", { className: "btn", textContent: "Edit", onclick: () => startEdit(d) }),
      d.index_status === "failed"
        ? el("button", { className: "btn", textContent: "Retry index", onclick: () => act(`/documents/${d.id}/reindex`, "POST") })
        : "",
      el("button", { className: "btn danger", textContent: "Delete", onclick: () => {
        if (confirm(`Delete "${d.title}"?`)) act(`/documents/${d.id}`, "DELETE");
      } }),
    );
    box.append(el("div", { className: "doc" },
      el("div", { className: "row" },
        el("h3", { textContent: d.title }),
        el("span", { className: "badge " + d.index_status, textContent: d.index_status }),
        isExpired(d) ? el("span", { className: "badge expired", textContent: "expired" }) : "",
        el("span", { className: "muted", style: "font-size:.8rem", textContent:
          "posted " + d.created_at.slice(0, 10) + (d.expires_at ? " · expires " + d.expires_at : "") }),
      ),
      el("p", { textContent: d.summary || "(summary pending…)" }),
      d.index_error ? el("p", { className: "err", textContent: d.index_error }) : "",
      actions,
    ));
  }
  if (list.some((d) => d.index_status === "pending")) pollTimer = setTimeout(loadDocs, 3000);
}

async function act(path, method) {
  try { await api(path, { method }); } catch (e) { alert(e.message); }
  loadDocs();
}

function startEdit(d) {
  editingId = d.id;
  $("formTitle").textContent = "Edit document";
  $("title").value = d.title;
  $("body").value = d.body;
  $("expires").value = d.expires_at || "";
  $("cancelEdit").classList.remove("hidden");
  $("saveBtn").textContent = "Rewrite & review";
  scrollTo({ top: 0, behavior: "smooth" });
}
function resetForm() {
  editingId = null;
  $("docForm").reset();
  $("formTitle").textContent = "Add announcement";
  $("cancelEdit").classList.add("hidden");
  $("saveBtn").textContent = "Rewrite & review";
  $("saveOrigFallback")?.remove();
}
$("cancelEdit").addEventListener("click", resetForm);

async function save(title, body) {
  const payload = JSON.stringify({ title, body, expires_at: $("expires").value || null });
  if (editingId) await api(`/documents/${editingId}`, { method: "PUT", body: payload });
  else await api("/documents", { method: "POST", body: payload });
  hideReview();
  resetForm();
  loadDocs();
}
function hideReview() {
  $("reviewCard").classList.add("hidden");
  $("docForm").closest(".card").classList.remove("hidden");
}

// Submit = rewrite first, then let the admin review before anything is saved.
$("docForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("docErr").textContent = "";
  $("saveBtn").disabled = true;
  $("saveBtn").textContent = "Rewriting…";
  const title = $("title").value, body = $("body").value;
  try {
    const rw = await api("/rewrite", { method: "POST", body: JSON.stringify({ title, body }) });
    $("origView").textContent = `${title}\n\n${body}`;
    $("rwTitle").value = rw.title;
    $("rwBody").value = rw.body;
    $("rwErr").textContent = "";
    $("docForm").closest(".card").classList.add("hidden");
    $("reviewCard").classList.remove("hidden");
  } catch (err) {
    // Rewrite failed: don't block the admin, offer to save as-is.
    $("docErr").textContent = err.message + " You can save your original with the button below.";
    $("saveOrigFallback")?.remove();
    $("saveBtn").after(el("button", { id: "saveOrigFallback", type: "button", className: "btn", textContent: "Save original",
      onclick: async () => { try { await save(title, body); } catch (x) { $("docErr").textContent = x.message; } } }));
  } finally {
    $("saveBtn").disabled = false;
    $("saveBtn").textContent = "Rewrite & review";
  }
});
$("useRewrite").addEventListener("click", async () => {
  try { await save($("rwTitle").value, $("rwBody").value); } catch (x) { $("rwErr").textContent = x.message; }
});
$("keepOrig").addEventListener("click", async () => {
  try { await save($("title").value, $("body").value); } catch (x) { $("rwErr").textContent = x.message; }
});
$("cancelReview").addEventListener("click", hideReview);

$("reindexAll").addEventListener("click", async () => {
  if (!confirm("Re-index every post in Cognee? This can take a few minutes.")) return;
  try { await api("/reindex-all", { method: "POST" }); } catch (e) { alert(e.message); }
  loadDocs();
});

function tab(which) {
  const docs = which === "docs";
  $("docsPane").classList.toggle("hidden", !docs);
  $("logPane").classList.toggle("hidden", docs);
  $("tabDocs").setAttribute("aria-selected", docs);
  $("tabLog").setAttribute("aria-selected", !docs);
  if (!docs) loadLog();
}
$("tabDocs").addEventListener("click", () => tab("docs"));
$("tabLog").addEventListener("click", () => tab("log"));

async function loadLog() {
  const rows = await api("/chat-log");
  const box = $("logList");
  box.replaceChildren();
  if (!rows.length) box.append(el("p", { className: "muted", textContent: "No questions yet." }));
  for (const r of rows) {
    box.append(el("div", { className: "log-item" },
      el("b", { textContent: r.question }),
      el("span", { className: "muted", textContent: r.answer }),
      el("div", { className: "muted", style: "font-size:.75rem", textContent: r.created_at }),
    ));
  }
}

api("/me").then(showApp).catch(showLogin);
