const CACHE_NAME = "universal-zalo-cache-v1";
const OFFLINE_URL = "/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle Web Push event from Server / Gateway
self.addEventListener("push", (event) => {
  let data = {
    title: "Universal Zalo",
    body: "Bạn có tin nhắn mới",
    icon: "/icon-192.png",
    data: { conversationId: "general", url: "/" },
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || "/icon-192.png",
    badge: "/badge-72.png",
    vibrate: [200, 100, 200],
    data: data.data || { url: "/" },
    actions: [
      { action: "open", title: "Mở xem" },
      { action: "close", title: "Đóng" },
    ],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Handle notification click
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "close") return;

  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

// Listen for local message notification triggers from UI
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "LOCAL_NOTIFICATION") {
    const payload = event.data.payload;
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon || "/icon-192.png",
      vibrate: [100, 50, 100],
      data: payload.data || { url: "/" },
    });
  }
});
