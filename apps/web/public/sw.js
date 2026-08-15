/* 不用記帳 notification worker. Keep this file root-scoped for the PWA. */
self.addEventListener("push", (event) => {
  const fallback = {
    title: "不用記帳",
    body: "同步狀態已更新。",
    url: "/#/overview",
    tag: "sync-status",
  };
  let data = fallback;
  try {
    data = event.data ? { ...fallback, ...event.data.json() } : fallback;
  } catch {
    data = fallback;
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192x192.png",
      badge: "/icon-192x192.png",
      tag: data.tag,
      // iOS PWA notifications remain visible, but do not play a sound or vibrate.
      silent: true,
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data?.url || "/#/overview",
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) =>
          client.url.startsWith(self.location.origin),
        );
        if (existing && "focus" in existing) {
          return existing.focus().then(() => {
            if ("navigate" in existing) return existing.navigate(targetUrl);
            return undefined;
          });
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
