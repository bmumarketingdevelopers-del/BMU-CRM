"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { signedInHint } from "@/lib/signed-in";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  window.addEventListener("pageshow", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("pageshow", onChange);
  };
};

/** Public header: "Sign in", or "Open BMU Hub" for someone still signed in (they came here with Back, for example). */
export function SignInLink({ className }: { className?: string }) {
  const signedIn = useSyncExternalStore(subscribe, signedInHint, () => false);
  return (
    <Link href={signedIn ? "/start" : "/sign-in"} prefetch={false} className={className}>
      {signedIn ? "Open BMU Hub" : "Sign in"}
    </Link>
  );
}
