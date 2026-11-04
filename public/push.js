// Opt-in Web Push toggle (button #notifyBtn). Hidden when unsupported or server has no VAPID keys.
(async () => {
  const btn = document.getElementById("notifyBtn");
  if (!btn || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const kres = await fetch("/api/push/key").catch(() => null);
  if (!kres || !kres.ok) return;
  const { key } = await kres.json();
  const reg = await navigator.serviceWorker.register("/sw.js");
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function render() {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    btn.textContent = sub ? "🔔 Notifications on" : "🔕 Notify me of important updates";
    btn.dataset.on = sub ? "1" : "";
    btn.hidden = false;
  }
  btn.addEventListener("click", async () => {
    const pm = (await navigator.serviceWorker.ready).pushManager;
    const sub = await pm.getSubscription();
    if (sub) {
      await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    } else {
      if ((await Notification.requestPermission()) !== "granted") { alert("Notifications are blocked in your browser."); return; }
      const s = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await post("/api/push/subscribe", s.toJSON());
    }
    render();
  });
  render();
})();
