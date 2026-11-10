/**
 * v45 installable app. Chrome and Edge announce "this site can be installed" once per page load with a
 * `beforeinstallprompt` event, often before React has started, so a tiny script in the root layout (INSTALL_CATCHER)
 * keeps it on window.__bmuInstall and tells the page with an INSTALL_READY event. The sidebar's "Install BMU Hub app"
 * button then shows the browser's own install dialog. Safari has no such event: it gets written steps instead.
 */
export type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __bmuInstall?: InstallEvent | null;
  }
}

export const INSTALL_READY = "bmu-install-ready";

/** Runs in the root layout before any other script. Kept tiny and dependency-free. */
export const INSTALL_CATCHER = `addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__bmuInstall=e;dispatchEvent(new Event("${INSTALL_READY}"))});addEventListener("appinstalled",function(){window.__bmuInstall=null;dispatchEvent(new Event("${INSTALL_READY}"))});`;

/** Already running as the installed app (its own window or home-screen icon). */
export function runningInstalled(): boolean {
  return matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * How this browser can install BMU Hub right now:
 * "prompt": Chrome / Edge, one click; "ios": iPhone or iPad, Share → Add to Home Screen; "mac-safari": File → Add to Dock;
 * null: already installed, or the browser can't install sites (e.g. Firefox).
 */
export function installMode(): "prompt" | "ios" | "mac-safari" | null {
  if (runningInstalled()) return null;
  if (window.__bmuInstall) return "prompt";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return "ios";
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Firefox/.test(ua);
  const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  if (safari && /Macintosh/.test(ua) && version >= 17) return "mac-safari";
  return null;
}

/** Shows Chrome's / Edge's install dialog. The event can be used once, so it is cleared afterwards. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = window.__bmuInstall;
  if (!e) return "unavailable";
  window.__bmuInstall = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  window.dispatchEvent(new Event(INSTALL_READY));
  return outcome;
}
