// Utility to convert VAPID public key string to Uint8Array / BufferSource
export function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer as BufferSource;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return reg;
  } catch (err) {
    console.error("ServiceWorker registration failed:", err);
    return null;
  }
}

export async function subscribeToWebPush(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    return false;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return false;
    }

    const reg = await registerServiceWorker();
    if (!reg) return false;

    const existingSub = await reg.pushManager.getSubscription();
    if (existingSub) {
      // Send to server
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(existingSub),
      });
      return true;
    }

    // Default public VAPID key
    const vapidKey = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });

    return true;
  } catch (e) {
    console.error("Push subscription error:", e);
    return false;
  }
}

export function showLocalNotification(title: string, body: string, icon?: string, conversationId?: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "LOCAL_NOTIFICATION",
        payload: {
          title,
          body,
          icon: icon || "/icon-192.png",
          data: { conversationId: conversationId || "general" },
        },
      });
    } else {
      new Notification(title, {
        body,
        icon: icon || "/icon-192.png",
      });
    }
  }
}
