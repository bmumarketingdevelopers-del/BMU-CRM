"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="mt-2 text-xs text-ink-muted underline hover:text-ink"
      onClick={async () => {
        await api.auth.logout();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
