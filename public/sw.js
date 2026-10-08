self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const d = event.data ? event.data.json() : {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Don't notify if the app is already open and in front
    if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;
    const isCall = d.kind === "call";
    await self.registration.showNotification(d.title || "Talkie", {
      body: d.body || "",
      tag: d.tag || "talkie",
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [300, 150, 300, 150, 300, 150, 300] : [120],
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: d.url || "/chat", callId: d.callId, kind: d.kind },
      actions: isCall ? [{ action: "accept", title: "Answer" }, { action: "decline", title: "Decline" }] : [],
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const action = event.action || "open";
    if (wins.length) {
      const w = wins[0];
      if (action !== "mute" && action !== "decline") await w.focus();
      w.postMessage({ type: "notif-action", action, callId: data.callId });
    } else if (action !== "decline" && action !== "mute" && action !== "end") {
      await self.clients.openWindow((data.url || "/chat") + (action === "accept" ? "?answer=1" : ""));
    }
  })());
});
