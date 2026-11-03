// v44 browser notifications: turns Web Push on or off for this browser (public/sw.js shows the alerts) and keeps the
// subscription linked to whoever is signed in. Permission is per browser and site, so it is asked only on a click.
import type { WebPushSubscribeInput } from "@bmu/shared";
import { api } from "@/lib/api";

/** unsupported: this browser can't; blocked: the person said no (only the browser's site settings can undo it). */
export type BrowserAlertsState = "unsupported" | "blocked" | "off" | "on";

export const browserAlertsSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** The server's public key (base64url) as the bytes pushManager.subscribe expects. */
function keyBytes(base64url: string) {
  const raw = atob((base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

async function subscription() {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function browserAlertsState(): Promise<BrowserAlertsState> {
  if (!browserAlertsSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  return (await subscription()) ? "on" : "off";
}

/** Asks for permission (call from a click), subscribes this browser and tells the server. */
export async function enableBrowserAlerts(publicKey: string): Promise<BrowserAlertsState> {
  if (!browserAlertsSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Subscribed with an older server key: start again, or the pushes would be refused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.devices.webPushSubscribe(sub.toJSON() as WebPushSubscribeInput);
  return "on";
}

/** Stops alerts in this browser (the server forgets it, and the browser drops the subscription). */
export async function disableBrowserAlerts() {
  const sub = browserAlertsSupported() ? await subscription() : null;
  if (!sub) return;
  await api.devices.webPushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => false);
}

// Asked once per sign-in: after login the browser's own prompt (or the in-app bar) shows once, "Not now" holds until the
// next sign-in. Cleared on sign-out and on the sign-in page.
const ASKED_KEY = "bmu-browser-alerts-asked";
export function browserAlertsAsked() {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}
export function markBrowserAlertsAsked() {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {}
}
export function resetBrowserAlertsAsk() {
  try {
    localStorage.removeItem(ASKED_KEY);
  } catch {}
}

/**
 * Chrome, Edge, Opera and Brave show the permission prompt without a click; Firefox and Safari only after one (those
 * get the in-app bar instead). Only Chromium browsers have navigator.userAgentData.
 */
export const canAskWithoutClick = () => typeof navigator !== "undefined" && "userAgentData" in navigator;

/** On sign-out: this browser stops getting this person's alerts (it re-links if they, or someone else, turn it on). */
export async function forgetBrowserAlerts() {
  resetBrowserAlertsAsk();
  const sub = browserAlertsSupported() ? await subscription().catch(() => null) : null;
  if (sub) await api.devices.webPushUnsubscribe(sub.endpoint).catch(() => {});
}

/**
 * On each page load (the bell calls it): if this browser already has alerts on, link them to whoever is signed in now
 * and to this sign-in (another person, or a new sign-in after the last one ended, may be using this browser).
 */
export async function syncBrowserAlerts() {
  if (!browserAlertsSupported() || Notification.permission !== "granted") return;
  const sub = await subscription().catch(() => null);
  if (sub) await api.devices.webPushSubscribe(sub.toJSON() as WebPushSubscribeInput).catch(() => {});
}
