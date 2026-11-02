// v44 browser notifications: shows BMU Hub alerts the server sends (Web Push), even when the CRM tab is in the
// background or closed, and opens the right screen when one is clicked. Registered by src/lib/web-push.ts.
// Plain JavaScript: browsers load this file as it is, from the site root, so it can cover every page.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let n = {};
  try {
    n = event.data ? event.data.json() : {};
  } catch {
    n = { title: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(n.title || "BMU Hub", {
      body: n.body || undefined,
      icon: "/bmu-marketing-logo.jpg",
      // One notification per alert: the same alert arriving twice replaces itself instead of stacking.
      tag: n.id || undefined,
      // Critical alerts stay on screen until they are dealt with.
      requireInteraction: !!n.critical,
      data: { id: n.id || null, link: n.link || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { id, link } = event.notification.data || {};
  const url = new URL(link || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      // Opening it from the notification counts as reading it (test alerts have no record).
      if (id && !String(id).startsWith("test-")) {
        fetch("/api/notifications/read", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) }).catch(() => {});
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find((w) => w.url === url);
      if (exact) return exact.focus();
      // Reuse an open BMU Hub tab rather than opening another one.
      const tab = windows.find((w) => new URL(w.url).origin === self.location.origin && "navigate" in w);
      if (tab) {
        try {
          await tab.focus();
          return await tab.navigate(url);
        } catch {
          // A tab this worker doesn't control can't be steered: open a new one instead.
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// The browser renewed the subscription (e.g. it expired): sign up again so alerts keep coming.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const config = await fetch("/api/devices/web-push", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!config || !config.publicKey) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
      await fetch("/api/devices/web-push", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
    })(),
  );
});

/** The server's public key (base64url) as the bytes pushManager.subscribe expects. */
function keyBytes(base64url) {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
