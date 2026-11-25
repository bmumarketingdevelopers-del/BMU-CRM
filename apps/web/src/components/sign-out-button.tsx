"use client";

import { api, setSigningOut } from "@/lib/api";
import { clearSignedIn } from "@/lib/signed-in";
import { forgetBrowserAlerts } from "@/lib/web-push";

export function SignOutButton() {
  return (
    <button
      className="py-2 text-xs md:mt-2 md:py-0 text-ink-muted underline hover:text-ink"
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
      Sign out
    </button>
  );
}
