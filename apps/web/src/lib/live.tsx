"use client";

/**
 * v13 live updates. One server-sent-events stream per tab (GET /api/realtime/stream) tells the app when records
 * change; every useLoad() list then reloads quietly, and server-rendered pages refresh. If the stream drops, the
 * browser reconnects on its own and the app checks for changes every 20 seconds until it is back.
 *
 * Also carries presence ("who else is looking at this lead") and the feature flags for this person.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LIVE_PRESENCE_EVERY_MS, type LiveMessage, type LivePresenceUser } from "@bmu/shared";
import { api } from "./api";

/** Entities changed since the last tick. `null` = unknown (after a reconnect), so everything reloads. */
export type LiveTick = { n: number; entities: Set<string> | null };
type Listener = (tick: LiveTick) => void;
type Status = "connecting" | "live" | "reconnecting" | "off";

type LiveCtx = {
  status: Status;
  flags: Record<string, boolean>;
  meId: string;
  subscribe: (fn: Listener) => () => void;
  /** Rooms this tab is showing; used for presence heartbeats. */
  join: (room: string) => () => void;
  viewers: (room: string) => LivePresenceUser[];
  presenceVersion: number;
};

const Ctx = createContext<LiveCtx | null>(null);

/** Quiet period after the last change before screens reload, and the longest a busy stream can delay a reload. */
const SETTLE_MS = 600;
const MAX_WAIT_MS = 2_500;
const FALLBACK_POLL_MS = 20_000;

export function LiveProvider({ meId, children }: { meId: string; children: React.ReactNode }) {
  // Both "off" and "connecting" render nothing, so server and browser agree on first paint.
  const [status, setStatus] = useState<Status>(() => (typeof EventSource === "undefined" ? "off" : "connecting"));
  const [flags, setFlags] = useState<Record<string, boolean>>({ live_updates: true, presence: true, smart_search: true });
  const listeners = useRef(new Set<Listener>());
  const pending = useRef<{ entities: Set<string> | null; first: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickN = useRef(0);
  const connId = useRef<string | null>(null);
  const rooms = useRef(new Map<string, number>());
  const presence = useRef(new Map<string, LivePresenceUser[]>());
  const [presenceVersion, setPresenceVersion] = useState(0);

  const fire = useCallback(() => {
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    if (typeof document !== "undefined" && document.hidden) {
      // Reload when the person comes back to the tab.
      const onVisible = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", onVisible);
        const tick = { n: ++tickN.current, entities: p.entities };
        for (const l of listeners.current) l(tick);
      };
      document.addEventListener("visibilitychange", onVisible);
      return;
    }
    const tick = { n: ++tickN.current, entities: p.entities };
    for (const l of listeners.current) l(tick);
  }, []);

  const queue = useCallback(
    (entity: string | null) => {
      const now = Date.now();
      if (!pending.current) pending.current = { entities: new Set(), first: now };
      if (entity === null) pending.current.entities = null;
      else pending.current.entities?.add(entity);
      if (timer.current) clearTimeout(timer.current);
      const wait = Math.max(0, Math.min(SETTLE_MS, pending.current.first + MAX_WAIT_MS - now));
      timer.current = setTimeout(fire, wait);
    },
    [fire],
  );

  // Joins and leaves come in bursts (a page swap, React re-running effects): send only the latest state, one
  // request at a time, so an older "left the page" can never arrive after a newer "is here".
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceChain = useRef<Promise<unknown>>(Promise.resolve());
  const sendPresence = useCallback(() => {
    if (presenceTimer.current) clearTimeout(presenceTimer.current);
    presenceTimer.current = setTimeout(() => {
      presenceTimer.current = null;
      presenceChain.current = presenceChain.current.then(() => {
        if (!connId.current) return;
        return api.realtime.presence({ connId: connId.current, rooms: [...rooms.current.keys()].slice(0, 10) }).catch(() => undefined);
      });
    }, 150);
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let wasLive = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (!poll) poll = setInterval(() => queue(null), FALLBACK_POLL_MS);
    };
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    es = new EventSource("/api/realtime/stream");
    es.onopen = () => {
      stopPoll();
      setStatus("live");
      // Anything could have changed while the stream was down.
      if (wasLive) queue(null);
      wasLive = true;
    };
    es.onerror = () => {
      setStatus((s) => (s === "off" ? s : "reconnecting"));
      startPoll();
    };
    es.onmessage = (ev) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(ev.data) as LiveMessage;
      } catch {
        return;
      }
      if (msg.kind === "hello") {
        connId.current = msg.connId;
        setFlags(msg.flags);
        if (!msg.flags.live_updates) setStatus("off");
        else setStatus("live");
        if (rooms.current.size) sendPresence();
      } else if (msg.kind === "change") {
        queue(msg.entity);
      } else if (msg.kind === "presence") {
        presence.current.set(msg.room, msg.users);
        setPresenceVersion((v) => v + 1);
      }
    };
    const beat = setInterval(() => rooms.current.size && sendPresence(), LIVE_PRESENCE_EVERY_MS);
    return () => {
      clearInterval(beat);
      stopPoll();
      es?.close();
    };
  }, [queue, sendPresence]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const join = useCallback(
    (room: string) => {
      rooms.current.set(room, (rooms.current.get(room) ?? 0) + 1);
      sendPresence();
      return () => {
        const n = (rooms.current.get(room) ?? 1) - 1;
        if (n <= 0) {
          rooms.current.delete(room);
          presence.current.delete(room);
        } else rooms.current.set(room, n);
        sendPresence();
      };
    },
    [sendPresence],
  );

  const viewers = useCallback((room: string) => presence.current.get(room) ?? [], []);

  const value = useMemo<LiveCtx>(() => ({ status, flags, meId, subscribe, join, viewers, presenceVersion }), [status, flags, meId, subscribe, join, viewers, presenceVersion]);
  return (
    <Ctx.Provider value={value}>
      <ServerRefresh />
      {children}
    </Ctx.Provider>
  );
}

export function useLive() {
  return useContext(Ctx);
}

/** This person's feature flags (defaults while loading or outside the signed-in app). */
export function useFlag(key: string, fallback = true): boolean {
  const live = useContext(Ctx);
  return live ? (live.flags[key] ?? fallback) : fallback;
}

/**
 * Runs `fn` after records change. `entities` limits it to some record types (e.g. ["Lead", "LeadActivity"]);
 * leave it out to react to any change. Does nothing when live updates are off.
 */
export function useLiveChanges(fn: () => void, entities?: string[]) {
  const live = useContext(Ctx);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  const key = entities?.join(",") ?? "";
  const on = !!live && live.flags.live_updates !== false;
  const subscribe = live?.subscribe;
  useEffect(() => {
    if (!on || !subscribe) return;
    const wanted = key ? new Set(key.split(",")) : null;
    return subscribe((tick) => {
      if (wanted && tick.entities && ![...tick.entities].some((e) => wanted.has(e))) return;
      ref.current();
    });
  }, [on, subscribe, key]);
}

/** Server-rendered pages (no useLoad) refresh their data after changes. */
function ServerRefresh() {
  const router = useRouter();
  const path = usePathname()!;
  const last = useRef(0);
  useLiveChanges(() => {
    // Don't refresh while someone is typing in a form on the page.
    const el = typeof document !== "undefined" ? document.activeElement : null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable)) return;
    if (Date.now() - last.current < 1_500) return;
    last.current = Date.now();
    router.refresh();
  });
  useEffect(() => {
    last.current = Date.now();
  }, [path]);
  return null;
}

/** Shows teammates looking at the same record. `room` is "Entity:id", e.g. liveRoom("Lead", id). */
export function usePresence(room: string | null | undefined): LivePresenceUser[] {
  const live = useContext(Ctx);
  const on = !!live && live.flags.presence !== false;
  const join = live?.join;
  useEffect(() => {
    if (!on || !room || !join) return;
    return join(room);
  }, [on, room, join]);
  if (!live || !on || !room) return [];
  void live.presenceVersion;
  return live.viewers(room).filter((u) => u.id !== live.meId);
}
