"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveChanges } from "./live";

export type Loaded<T> = { data?: T; error?: string; loading: boolean; reload: () => void };

/**
 * Runs an async loader on mount and exposes data, error and reload.
 * v13: also reloads quietly (no loading flash) when records change anywhere, unless `live` is false. Pass record
 * types (e.g. ["Lead"]) to reload only for those. Data is replaced only when it actually changed.
 */
export function useLoad<T>(load: () => Promise<T>, opts?: { live?: boolean | string[] }): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const loader = useRef(load);
  const busy = useRef(false);
  const again = useRef(false);
  const lastJson = useRef<string | null>(null);

  const fetchNow = useCallback(() => {
    busy.current = true;
    loader
      .current()
      .then((data) => {
        lastJson.current = safeJson(data);
        setState({ data, loading: false });
      })
      .catch((e: Error) => setState({ error: e.message, loading: false }))
      .finally(() => {
        busy.current = false;
      });
  }, []);

  useEffect(fetchNow, [fetchNow]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fetchNow();
  }, [fetchNow]);

  const quiet = useCallback(function quietReload() {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    loader
      .current()
      .then((data) => {
        const json = safeJson(data);
        if (json !== null && json === lastJson.current) return;
        lastJson.current = json;
        setState({ data, loading: false });
      })
      .catch(() => undefined) // keep showing what we have; the next change or a manual reload tries again
      .finally(() => {
        busy.current = false;
        if (again.current) {
          again.current = false;
          quietReload();
        }
      });
  }, []);

  const live = opts?.live ?? true;
  const noop = useCallback(() => undefined, []);
  useLiveChanges(live === false ? noop : quiet, Array.isArray(live) ? live : undefined);

  return { ...state, reload };
}

function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
