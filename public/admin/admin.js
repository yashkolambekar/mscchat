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
      el("button", { className: "btn", textContent: "Suggest events", onclick: (e) => suggestEvents(d, e.target) }),
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
  $("hintWrap").classList.add("hidden");
  $("saveBtn").textContent = "Rewrite & review";
  $("saveOrigFallback")?.remove();
}
$("cancelEdit").addEventListener("click", resetForm);

async function save(title, body) {
  const payload = JSON.stringify({ title, body, expires_at: $("expires").value || null, notify: $("notify").checked, notify_hint: $("notify").checked ? $("hint").value : "" });
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
  try {
    const r = await api("/reindex-all", { method: "POST" });
    alert(`Re-indexing ${r.count} post(s) started. Status badges update below.`);
  } catch (e) { alert("Re-index failed: " + e.message); }
  loadDocs();
});

function tab(which) {
  for (const [k, pane, btn] of [["docs", "docsPane", "tabDocs"], ["events", "eventsPane", "tabEvents"], ["notif", "notifPane", "tabNotif"], ["log", "logPane", "tabLog"]]) {
    $(pane).classList.toggle("hidden", k !== which);
    $(btn).setAttribute("aria-selected", k === which);
  }
  if (which === "log") loadLog();
  if (which === "notif") loadNotifs();
  if (which === "events") loadEvents();
}
$("tabDocs").addEventListener("click", () => tab("docs"));
$("tabEvents").addEventListener("click", () => tab("events"));
$("tabNotif").addEventListener("click", () => tab("notif"));
$("tabLog").addEventListener("click", () => tab("log"));
$("notify").addEventListener("change", () => $("hintWrap").classList.toggle("hidden", !$("notify").checked));

async function loadNotifs() {
  const rows = await api("/notifications");
  const box = $("notifList");
  box.replaceChildren();
  if (!rows.length) box.append(el("p", { className: "muted", textContent: "No notifications sent yet." }));
  for (const r of rows) {
    box.append(el("div", { className: "log-item" },
      el("b", { textContent: r.title }),
      el("span", { textContent: r.body }),
      el("div", { className: "muted", style: "font-size:.75rem", textContent:
        `${r.created_at} · post: ${r.doc_title}${r.hint ? ` · hint: ${r.hint}` : ""} · delivered ${r.delivered}/${r.subscribers} · opened ${r.opens}` }),
    ));
  }
}

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

// ---------- events ----------
let editingEvId = null;
let evDocs = [];
const evFmt = (e) => (e.repeat ? "every week from " : "") + (e.all_day ? e.starts_at : e.starts_at.replace("T", " ")) + (e.ends_at ? " → " + (e.all_day ? e.ends_at : e.ends_at.replace("T", " ")) : "");

function setAllDay(on) {
  $("evAllDay").checked = on;
  $("evStart").type = $("evEnd").type = on ? "date" : "datetime-local";
}
$("evAllDay").addEventListener("change", () => {
  const [s, e] = [$("evStart").value, $("evEnd").value];
  setAllDay($("evAllDay").checked);
  const conv = (v) => (!v ? "" : $("evAllDay").checked ? v.slice(0, 10) : v.length === 10 ? v + "T09:00" : v);
  $("evStart").value = conv(s);
  $("evEnd").value = conv(e);
});
function fillEvent(e, docId) {
  setAllDay(!!e.all_day);
  $("evTitle").value = e.title;
  $("evStart").value = e.starts_at;
  $("evEnd").value = e.ends_at || "";
  $("evLoc").value = e.location || "";
  $("evNotes").value = e.notes || "";
  $("evRepeat").checked = e.repeat === "weekly";
  $("evDoc").value = docId ? String(docId) : "";
  scrollTo({ top: 0, behavior: "smooth" });
}
function resetEvent() {
  editingEvId = null;
  $("evForm").reset();
  setAllDay(false);
  $("evFormTitle").textContent = "Add event";
  $("evCancelEdit").classList.add("hidden");
  $("evErr").textContent = "";
}
$("evCancelEdit").addEventListener("click", resetEvent);
$("evForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("evErr").textContent = "";
  const payload = JSON.stringify({
    title: $("evTitle").value, all_day: $("evAllDay").checked, starts_at: $("evStart").value, ends_at: $("evEnd").value,
    location: $("evLoc").value, notes: $("evNotes").value, repeat: $("evRepeat").checked ? "weekly" : null, doc_id: $("evDoc").value ? Number($("evDoc").value) : null,
  });
  try {
    if (editingEvId) await api(`/events/${editingEvId}`, { method: "PUT", body: payload });
    else await api("/events", { method: "POST", body: payload });
    resetEvent();
    loadEvents();
  } catch (x) { $("evErr").textContent = x.message; }
});
async function loadEvents() {
  const [list, docsList] = await Promise.all([api("/events"), api("/documents")]);
  evDocs = docsList;
  const sel = $("evDoc"), cur = sel.value;
  sel.replaceChildren(el("option", { value: "", textContent: "None" }), ...docsList.map((d) => el("option", { value: String(d.id), textContent: d.title })));
  sel.value = cur;
  const box = $("evList");
  box.replaceChildren();
  if (!list.length) box.append(el("p", { className: "muted", textContent: "No events yet." }));
  for (const e of list) {
    const post = e.doc_id ? (docsList.find((d) => d.id === e.doc_id)?.title ?? "(post deleted)") : null;
    box.append(el("div", { className: "doc" },
      el("div", { className: "row" },
        el("h3", { textContent: e.title }),
        e.cancelled ? el("span", { className: "badge failed", textContent: "cancelled" }) : "",
      ),
      el("p", { textContent: evFmt(e) + (e.location ? " · " + e.location : "") + (post ? " · post: " + post : "") }),
      el("div", { className: "row" },
        el("button", { className: "btn", textContent: e.cancelled ? "Restore (edit)" : "Edit", onclick: () => {
          editingEvId = e.id;
          $("evFormTitle").textContent = "Edit event";
          $("evCancelEdit").classList.remove("hidden");
          fillEvent(e, e.doc_id && docsList.some((d) => d.id === e.doc_id) ? e.doc_id : null);
        } }),
        e.cancelled ? "" : el("button", { className: "btn danger", textContent: "Cancel event", onclick: async () => {
          if (!confirm(`Cancel "${e.title}"? Calendars will show it as cancelled.`)) return;
          try { await api(`/events/${e.id}`, { method: "DELETE" }); } catch (x) { alert(x.message); }
          loadEvents();
        } }),
      ),
    ));
  }
}
async function suggestEvents(d, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Thinking…";
  try {
    const sug = await api("/events/suggest", { method: "POST", body: JSON.stringify({ title: d.title, body: d.body }) });
    tab("events");
    $("sugCard").classList.remove("hidden");
    $("sugFrom").textContent = `from "${d.title}"`;
    const box = $("sugList");
    box.replaceChildren();
    if (!sug.length) box.append(el("p", { className: "muted", textContent: "No dated events found in this post." }));
    for (const s of sug) {
      box.append(el("div", { className: "log-item row" },
        el("span", { textContent: `${s.title} · ${evFmt(s)}${s.location ? " · " + s.location : ""}` }),
        el("button", { className: "btn", type: "button", textContent: "Use", onclick: () => {
          editingEvId = null;
          $("evFormTitle").textContent = "Add event";
          $("evCancelEdit").classList.add("hidden");
          fillEvent(s, d.id);
        } }),
      ));
    }
  } catch (x) { alert(x.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

api("/me").then(showApp).catch(showLogin);
