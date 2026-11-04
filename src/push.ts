import webpush from "web-push";
import { config } from "./config.js";
import { pushSubs } from "./db.js";
import { log } from "./log.js";

export const pushEnabled = !!(config.vapid.publicKey && config.vapid.privateKey);
if (pushEnabled) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
else log("push", "VAPID keys missing: notifications disabled");

export type Notice = { title: string; body: string; url: string; nid?: number };

/** Send to every subscriber; drop subscriptions the push service reports gone (404/410). */
export async function notifyAll(n: Notice): Promise<{ subscribers: number; delivered: number }> {
  if (!pushEnabled) return { subscribers: 0, delivered: 0 };
  const subs = pushSubs.all();
  log("push", `sending "${n.title}" to ${subs.length} subscriber(s)`);
  const payload = JSON.stringify(n);
  let ok = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86_400 });
        ok++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) pushSubs.remove(s.endpoint);
        else log("push", "send failed", e instanceof Error ? e.message : String(e));
      }
    }),
  );
  log("push", `delivered ${ok}/${subs.length}`);
  return { subscribers: subs.length, delivered: ok };
}
