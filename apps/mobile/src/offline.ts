// v20 offline-first: a small SQLite store on the phone holds the last copy of each screen and an outbox of task
// edits. Edits made without signal show straight away, wait in the outbox, and sync when the phone is back online
// (the server merges field by field against what the phone last saw, so a teammate's change is not overwritten).
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import * as SQLite from 'expo-sqlite';
import { SyncQueue, taskSnapshot, type QueuedOp, type SyncOpInput, type SyncOpResult, type TaskView } from '@bmu/shared';
import { api } from './api';

let db: SQLite.SQLiteDatabase | null = null;
function store() {
  if (!db) {
    db = SQLite.openDatabaseSync('bmu-offline.db');
    db.execSync('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL)');
  }
  return db;
}

/** The last copy of each screen's data, read when the phone is offline. */
export const cache = {
  async get<T>(key: string): Promise<{ data: T; at: number } | null> {
    try {
      const row = await store().getFirstAsync<{ json: string; at: number }>('SELECT json, at FROM kv WHERE key = ?', key);
      return row ? { data: JSON.parse(row.json) as T, at: row.at } : null;
    } catch {
      return null;
    }
  },
  async set(key: string, data: unknown) {
    try {
      await store().runAsync('INSERT OR REPLACE INTO kv (key, json, at) VALUES (?, ?, ?)', key, JSON.stringify(data), Date.now());
    } catch {
      // A full disk only costs the offline copy.
    }
  },
  /** Wipes every cached screen and the outbox (sign-out). */
  async clear() {
    try {
      await store().runAsync('DELETE FROM kv');
    } catch {
      // nothing cached
    }
  },
};

export const outbox = new SyncQueue(
  {
    load: async () => (await cache.get<QueuedOp[]>('outbox'))?.data ?? [],
    save: (ops) => cache.set('outbox', ops),
  },
  async (ops) => (await api.sync.push(ops)).results,
);

let online = true;
const onlineListeners = new Set<(on: boolean) => void>();
const resultListeners = new Set<(r: SyncOpResult[]) => void>();
outbox.subscribe((_n, results) => {
  if (results?.length) resultListeners.forEach((fn) => fn(results));
});

/** Sends the outbox; quietly does nothing when there is no connection. */
export async function syncNow() {
  try {
    return await outbox.flush();
  } catch {
    return [];
  }
}

let started = false;
/** Watches the connection and the app coming back to the front; both flush the outbox. */
export function startOffline() {
  if (started) return;
  started = true;
  void outbox.init().then(syncNow);
  const set = (on: boolean) => {
    const was = online;
    online = on;
    onlineListeners.forEach((fn) => fn(on));
    if (on && !was) void syncNow();
  };
  void Network.getNetworkStateAsync().then((s) => set(s.isConnected !== false && s.isInternetReachable !== false), () => undefined);
  Network.addNetworkStateListener((s) => set(s.isConnected !== false && s.isInternetReachable !== false));
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void syncNow();
  });
}

export const isOnline = () => online;

/** Queues a task change (shown at once) and tries to send it. */
export async function editTask(t: TaskView, changes: SyncOpInput['changes']): Promise<SyncOpResult[]> {
  await outbox.enqueueTask(t.id, taskSnapshot(t), changes);
  return online ? syncNow() : [];
}

/** Connection state, what is waiting to sync and the last sync results, for banners. */
export function useSync() {
  const [on, setOn] = useState(online);
  const [ops, setOps] = useState<SyncOpInput[]>(outbox.list());
  const [last, setLast] = useState<SyncOpResult[]>();
  useEffect(() => {
    void outbox.init().then(() => setOps(outbox.list()));
    const a = outbox.subscribe(() => setOps(outbox.list()));
    const b = (v: boolean) => setOn(v);
    const c = (r: SyncOpResult[]) => setLast(r);
    onlineListeners.add(b);
    resultListeners.add(c);
    return () => {
      a();
      onlineListeners.delete(b);
      resultListeners.delete(c);
    };
  }, []);
  const problems = (last ?? []).filter((r) => r.status === 'conflict' || r.status === 'rejected');
  return { online: on, ops, pending: ops.length, last, problems, syncNow };
}
