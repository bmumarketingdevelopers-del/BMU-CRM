"use client";

import { useEffect, useRef } from "react";
import { useLiveChanges } from "./live";

/**
 * v34: keeps a screen fresh while it is open. Reloads when related records change (live updates), and also every
 * `everyMs` while the tab is visible, in case a live message was missed (e.g. it was sent from another server).
 */
export function useAutoRefresh(fn: () => void, entities: string[], everyMs = 60_000) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useLiveChanges(() => ref.current(), entities);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") ref.current();
    };
    const t = setInterval(tick, everyMs);
    const onShow = () => document.visibilityState === "visible" && ref.current();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [everyMs]);
}
