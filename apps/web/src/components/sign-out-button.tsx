"use client";

import { api, setSigningOut } from "@/lib/api";
import { clearSignedIn } from "@/lib/signed-in";
import { forgetBrowserAlerts } from "@/lib/web-push";

/** className: v54 redesign preview passes its own look; the sign-out itself is the same. */
export function SignOutButton({ className = "py-2 text-xs md:mt-2 md:py-0 text-ink-muted underline hover:text-ink", children = "Sign out", title }: { className?: string; children?: React.ReactNode; title?: string }) {
  return (
    <button
      className={className}
      title={title}
      aria-label={title}
      onClick={async () => {
        // This browser stops getting this person's pop-up alerts once they sign out.
        await forgetBrowserAlerts();
        // From here a background check being refused is expected, not an ended session.
        setSigningOut(true);
        try {
          await api.auth.logout();
        } catch (e) {
          setSigningOut(false);
          throw e;
        }
        clearSignedIn();
        // A full page load, replacing this page: nothing of theirs stays in memory, and Back does not bring it back.
        window.location.replace(new URL("/sign-in", window.location.origin).href);
      }}
    >
      {children}
    </button>
  );
}
