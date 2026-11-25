"use client";

import { useEffect } from "react";
import { markSignedIn } from "@/lib/signed-in";

/** In the app shell: remembers in this browser that someone is signed in (see lib/signed-in). */
export function SignedInMark() {
  useEffect(markSignedIn, []);
  return null;
}
