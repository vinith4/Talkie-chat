import { sb } from "@/lib/supabase";

function keyBytes(b64: string): ArrayBuffer {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr.buffer as ArrayBuffer;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function registerWorker() {
  return navigator.serviceWorker.register("/sw.js");
}

/** Returns "ok" or a human-readable problem. */
export async function enablePush(askPermission: boolean): Promise<string> {
  if (!pushSupported()) return "This browser can't show background alerts. On iPhone, add Talkie to your Home Screen first.";
  if (Notification.permission === "default" && askPermission) await Notification.requestPermission();
  if (Notification.permission !== "granted") return "Notifications are blocked. Allow them in your browser's site settings.";
  const reg = await registerWorker();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "") });
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys) return "Could not subscribe to alerts.";
  const { error } = await sb().rpc("register_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  return error ? error.message : "ok";
}
