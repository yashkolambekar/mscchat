self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || "Class update", { body: d.body || "", data: { url: d.url || "/announcements", nid: d.nid } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { url, nid } = e.notification.data;
  e.waitUntil(Promise.all([
    nid ? fetch("/api/push/opened", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nid }) }).catch(() => {}) : null,
    clients.openWindow(url),
  ]));
});
