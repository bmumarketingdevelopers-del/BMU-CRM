// v20 performance: a short-lived cache for heavy read screens (Weekly Review, Forecast & risks, task lists, search).
// Entries are per person (so permissions and hidden fields stay exactly as computed) and per organisation, and the
// whole organisation's entries are dropped on any real write (EventBus.publish calls clearReadCache), so a change
// shows on the next load. The short time limit covers things that change with the clock (overdue, "due today").
import { bridgeEnabled, isServerless } from '../runtime/process-role.js';

type Entry = { at: number; value: Promise<unknown> };
const store = new Map<string, Map<string, Entry>>();
const MAX_PER_ORG = 2000;
// Serverless (Vercel): off by default. A write in one function instance cannot clear another instance's copy
// unless events are shared (EVENT_BRIDGE=1), so a saved change could look lost for up to a minute.
const off = () => process.env.READ_CACHE === '0' || (process.env.READ_CACHE === undefined && isServerless() && !bridgeEnabled());

export function cached<T>(orgId: string, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (off()) return fn();
  let org = store.get(orgId);
  if (!org) store.set(orgId, (org = new Map()));
  const hit = org.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn();
  const entry = { at: Date.now(), value };
  if (org.size >= MAX_PER_ORG) org.clear();
  org.set(key, entry);
  value.catch(() => {
    if (org.get(key) === entry) org.delete(key);
  });
  return value;
}

/** Drops cached reads for one organisation (or all when the write's organisation is unknown). */
export function clearReadCache(orgId: string | null) {
  if (orgId) store.delete(orgId);
  else store.clear();
}
