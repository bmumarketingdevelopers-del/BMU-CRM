"use client";

import { useEffect, useState } from "react";
import { INSTALL_READY, installMode, promptInstall } from "@/lib/install-app";

/**
 * v45: "Install BMU Hub app" in the sidebar. Chrome and Edge: one click opens the browser's install dialog, and BMU Hub
 * then runs in its own window with a desktop and taskbar icon. iPhone / iPad and Safari on Mac: the steps to follow.
 * Hidden once installed, inside the installed app, and in browsers that can't install sites.
 */
export function InstallAppButton() {
  const [mode, setMode] = useState<ReturnType<typeof installMode>>(null);
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const update = () => setMode(installMode());
    update();
    window.addEventListener(INSTALL_READY, update);
    return () => window.removeEventListener(INSTALL_READY, update);
  }, []);

  if (!mode) return null;
  const click = async () => {
    if (mode !== "prompt") return setSteps((s) => !s);
    setBusy(true);
    await promptInstall().catch(() => {});
    setBusy(false);
  };
  return (
    <div className="px-5 pb-3 md:pb-4 print:hidden" data-testid="install-app">
      <button
        type="button"
        onClick={click}
        disabled={busy}
        aria-expanded={mode === "prompt" ? undefined : steps}
        className="flex w-full items-center gap-2 border border-border bg-surface px-3 py-2 text-left text-xs text-ink hover:border-ink-muted disabled:opacity-60"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="13" rx="1.5" />
          <path d="M8 21h8M12 17v4M12 7v6m-2.5-2.5L12 13l2.5-2.5" />
        </svg>
        <span>
          {busy ? "Opening…" : mode === "ios" ? "Add BMU Hub to your Home Screen" : "Install BMU Hub app"}
          <span className="block text-[11px] text-ink-muted">Own window and icon, alerts when it&apos;s closed</span>
        </span>
      </button>
      {steps && (
        <p className="mt-2 text-xs text-ink-muted" role="note">
          {mode === "ios" ? (
            <>
              Tap the <b className="font-medium text-ink">Share</b> button, then <b className="font-medium text-ink">Add to Home Screen</b>. Open BMU Hub from the new icon.
            </>
          ) : (
            <>
              In the menu bar, choose <b className="font-medium text-ink">File → Add to Dock</b>. Open BMU Hub from the Dock.
            </>
          )}
        </p>
      )}
    </div>
  );
}
