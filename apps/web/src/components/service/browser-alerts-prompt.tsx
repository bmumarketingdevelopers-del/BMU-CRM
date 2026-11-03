"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { browserAlertsAsked, browserAlertsState, browserAlertsSupported, canAskWithoutClick, enableBrowserAlerts, markBrowserAlertsAsked } from "@/lib/web-push";

/**
 * v44: right after login, asks to turn on browser notifications. Chrome and Edge show their own prompt at once; Firefox
 * and Safari only allow it after a click, so they (and anyone who closed the prompt) get this bar. Once per sign-in;
 * never again once Allowed or Blocked. Allowed earlier in the site settings: turned on quietly, no prompt.
 */
export function BrowserAlertsPrompt() {
  const [key, setKey] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      if (!browserAlertsSupported() || Notification.permission === "denied") return;
      const c = await api.devices.webPushConfig().catch(() => null);
      if (!live || !c?.available || !c.publicKey) return;
      if ((await browserAlertsState()) === "on") return;
      if (Notification.permission === "granted") {
        await enableBrowserAlerts(c.publicKey).catch(() => {});
        return;
      }
      if (browserAlertsAsked()) return;
      markBrowserAlertsAsked();
      if (canAskWithoutClick()) {
        const state = await enableBrowserAlerts(c.publicKey).catch(() => "off" as const);
        if (state !== "off") return;
      }
      if (live) setKey(c.publicKey);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!key) return null;
  const allow = async () => {
    setBusy(true);
    await enableBrowserAlerts(key).catch(() => {});
    setKey(undefined);
  };
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 border border-border bg-surface-raised px-4 py-3 text-sm print:hidden" role="region" aria-label="Browser notifications" data-testid="browser-alerts-prompt">
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <p className="min-w-0 flex-1">
        Get BMU Hub alerts on your screen, even when this tab is closed or you&apos;re on another site.
        <span className="block text-xs text-ink-muted">Your browser will ask. Choose Allow.</span>
      </p>
      <div className="flex items-center gap-3">
        <Button className="px-3 py-1.5 text-xs" disabled={busy} onClick={allow}>
          {busy ? "Turning on…" : "Allow notifications"}
        </Button>
        <Button variant="ghost" className="px-0 py-1.5 text-xs underline" disabled={busy} onClick={() => setKey(undefined)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
