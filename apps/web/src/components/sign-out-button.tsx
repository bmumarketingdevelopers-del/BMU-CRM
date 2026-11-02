"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { forgetBrowserAlerts } from "@/lib/web-push";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="mt-2 text-xs text-ink-muted underline hover:text-ink"
      onClick={async () => {
        // This browser stops getting this person's pop-up alerts once they sign out.
        await forgetBrowserAlerts();
        await api.auth.logout();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
