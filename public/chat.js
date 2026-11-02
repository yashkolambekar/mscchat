const log = document.getElementById("log");
const form = document.getElementById("f");
const q = document.getElementById("q");
const send = document.getElementById("send");

function add(cls, text, sources) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  if (cls === "bot" && text) d.append(renderRich(text));
  else d.textContent = text;
  if (sources && sources.length) {
    const s = document.createElement("div");
    s.className = "src";
    s.append("Sources: ");
    for (const x of sources) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "srcbtn";
      t.textContent = x.title;
      t.title = "Open source";
      t.addEventListener("click", () => openDoc(x.id, x.title));
      s.append(t);
    }
    d.append(s);
  }
  log.append(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

const history = [];
let prevDocIds = [];

async function ask(text) {
  document.getElementById("chips")?.remove();
  add("user", text);
  const wait = add("bot typing", "");
  wait.innerHTML = "<i></i><i></i><i></i>";
  send.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text, history: history.slice(-8), prevDocIds }),
    });
    const data = await res.json().catch(() => ({}));
    wait.remove();
    if (!res.ok) add("bot err", data.error || "Something went wrong.");
    else {
      add("bot", data.answer, data.sources);
      history.push({ role: "user", content: text }, { role: "assistant", content: data.answer });
      prevDocIds = (data.sources || []).map((s) => s.id);
    }
  } catch {
    wait.remove();
    add("bot err", "Network error. Please try again.");
  } finally {
    send.disabled = false;
    q.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  q.value = "";
  q.style.height = "";
  ask(text);
});
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
q.addEventListener("input", () => {
  q.style.height = "auto";
  q.style.height = Math.min(q.scrollHeight, 140) + "px";
});
document.getElementById("chips").addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) ask(e.target.textContent);
});

const dlg = document.getElementById("docDlg");
async function openDoc(id, title) {
  document.getElementById("docTitle").textContent = title;
  const body = document.getElementById("docBody");
  const meta = document.getElementById("docMeta");
  body.replaceChildren("Loading…");
  meta.textContent = "";
  document.getElementById("docOpen").href = "/post.html?id=" + id;
  dlg.showModal();
  try {
    const res = await fetch("/api/docs/" + id);
    if (!res.ok) throw new Error();
    const d = await res.json();
    document.getElementById("docTitle").textContent = d.title;
    meta.textContent = "Updated " + d.updated_at;
    body.replaceChildren(renderRich(d.body));
  } catch {
    body.textContent = "Could not load this source. It may have been removed.";
  }
}
document.getElementById("docClose").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
