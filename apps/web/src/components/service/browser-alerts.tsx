"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/dash";
import { Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { browserAlertsState, disableBrowserAlerts, enableBrowserAlerts, type BrowserAlertsState } from "@/lib/web-push";

/**
 * v44: browser notifications for this browser. Alerts then show in another tab, with the window minimised, on another
 * website or with the CRM tab closed. The same alerts as the bell, following the in-app choices and quiet hours.
 */
export function BrowserAlertsPanel() {
  const config = useLoad(() => api.devices.webPushConfig());
  const [state, setState] = useState<BrowserAlertsState>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    void browserAlertsState().then(setState, () => setState("unsupported"));
  }, []);

  async function run(work: () => Promise<string | undefined>) {
    setBusy(true);
    setMsg(undefined);
    try {
      const text = await work();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message || "That didn't work. Try again." });
    } finally {
      setBusy(false);
      config.reload();
    }
  }

  const turnOn = () =>
    run(async () => {
      const next = await enableBrowserAlerts(config.data!.publicKey!);
      setState(next);
      return next === "on" ? "Browser notifications are on. Send a test to see one." : undefined;
    });
  const turnOff = () =>
    run(async () => {
      await disableBrowserAlerts();
      setState("off");
      return "Browser notifications are off for this browser.";
    });
  const test = () =>
    run(async () => {
      const r = await api.devices.webPushTest();
      return r.sent ? "Sent. It should appear in a few seconds, even if you switch to another tab." : "Nothing could be delivered. Turn notifications off and on again.";
    });

  const c = config.data;
  const others = c && state === "on" ? c.devices - 1 : (c?.devices ?? 0);
  return (
    <Panel title="Browser notifications" subtitle="Get BMU Hub alerts as pop-ups on this computer, even when the CRM tab is in the background, minimised or closed." flush>
      <div className="grid gap-3 px-5 py-4 text-sm" data-testid="browser-alerts">
        {!c || !state ? (
          <LoadState loading={config.loading} error={config.error} />
        ) : !c.available ? (
          <p className="text-ink-muted">Browser notifications aren&apos;t switched on for BMU Hub yet. The admin needs to add the server&apos;s notification keys.</p>
        ) : state === "unsupported" ? (
          <p className="text-ink-muted">This browser can&apos;t show BMU Hub notifications. Use Chrome, Edge, Firefox or Safari on a computer. On an iPhone or iPad, use the BMU Hub phone app.</p>
        ) : state === "blocked" ? (
          <p>
            Notifications are <strong>blocked</strong> for this site in your browser. Click the icon to the left of the web address, set <strong>Notifications</strong> to <strong>Allow</strong>, then reload this page and turn them on here.
          </p>
        ) : state === "off" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button className="px-3 py-1.5 text-xs" disabled={busy} onClick={turnOn}>
              {busy ? "Turning on…" : "Turn on for this browser"}
            </Button>
            <span className="text-xs text-ink-muted">Your browser will ask for permission. Choose Allow.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium text-[#5f8a12]">On for this browser</span>
            <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={busy} onClick={test}>
              Send a test
            </Button>
            <Button variant="ghost" className="px-0 py-1.5 text-xs underline" disabled={busy} onClick={turnOff}>
              Turn off
            </Button>
          </div>
        )}
        {c?.available && others > 0 && (
          <p className="text-xs text-ink-muted">
            Also on in {others} other browser{others === 1 ? "" : "s"} you use.
          </p>
        )}
        {c?.available && state !== "unsupported" && (
          <p className="text-xs text-ink-muted">
            You get the same alerts as the bell, and your notification choices and quiet hours apply. With the browser fully closed, alerts arrive the next time it opens, or straight away if it keeps running in the background (Chrome and Edge: Settings → System → Continue running background apps). Windows Focus assist or Do not disturb can hide them.
          </p>
        )}
        {msg && <p className={`text-sm ${msg.ok ? "text-[#5f8a12]" : "text-red"}`}>{msg.text}</p>}
      </div>
    </Panel>
  );
}
