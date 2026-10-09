// v13 foundation: live updates, presence, feature flags, system health and the fuzzy search scorer.
// Shared by the API (event bus, realtime stream, search index), the web app and the phone app.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Live updates (server-sent events on GET /realtime/stream)

export type LiveChangeOp = "create" | "update" | "delete";

/** A record changed. Carries no record data: screens reload what they show, so permissions stay with each endpoint. */
export type LiveChange = { kind: "change"; entity: string; op: LiveChangeOp; ids: string[]; at: string; actorId: string | null };
export type LivePresenceUser = { id: string; name: string };
export type LivePresence = { kind: "presence"; room: string; users: LivePresenceUser[] };
export type LiveHello = { kind: "hello"; connId: string; flags: Record<string, boolean> };
export type LiveMessage = LiveChange | LivePresence | LiveHello;

/** Presence heartbeat: the rooms (records) this browser tab or phone screen is showing right now. */
export const livePresenceSchema = z.object({
  connId: z.string().min(1).max(64),
  rooms: z.array(z.string().regex(/^[A-Za-z]+:[A-Za-z0-9_-]{1,64}$/, "Room must look like Entity:id")).max(10),
});
export type LivePresenceInput = z.infer<typeof livePresenceSchema>;

/** Presence room for a record, e.g. liveRoom("Lead", id) → "Lead:ck…". */
export const liveRoom = (entity: string, id: string) => `${entity}:${id}`;

/** How long a presence heartbeat lasts. Screens send one every 20 seconds. */
export const LIVE_PRESENCE_TTL_MS = 45_000;
export const LIVE_PRESENCE_EVERY_MS = 20_000;

// ---------------------------------------------------------------------------
// Feature flags

export const FEATURE_FLAGS = [
  { key: "live_updates", label: "Live updates", hint: "Screens update by themselves when anyone changes something. Turn off to go back to refreshing by hand.", default: true },
  { key: "presence", label: "Who else is here", hint: "Shows the faces of teammates looking at the same lead, client, project or request.", default: true },
  { key: "smart_search", label: "Smart search", hint: "Ctrl/Cmd+K finds records even with a typo or part of a name.", default: true },
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];
export const FEATURE_FLAG_KEYS = FEATURE_FLAGS.map((f) => f.key) as [FeatureFlagKey, ...FeatureFlagKey[]];

export const featureFlagUpdateSchema = z.object({
  enabled: z.boolean(),
  /** Limit to these roles (empty = everyone). Ignored when off. */
  roles: z.array(z.string().max(40)).max(40).default([]),
});
export type FeatureFlagUpdate = z.infer<typeof featureFlagUpdateSchema>;

export type FeatureFlagRow = { key: FeatureFlagKey; label: string; hint: string; enabled: boolean; roles: string[]; isDefault: boolean; updatedAt: string | null; updatedBy: string | null };

/** Whether a flag is on for someone with these roles. */
export function featureFlagOn(row: { enabled: boolean; roles: string[] }, roles: string[]): boolean {
  if (!row.enabled) return false;
  return !row.roles.length || row.roles.some((r) => roles.includes(r));
}

// ---------------------------------------------------------------------------
// System health (Command Centre → System health)

export type SystemSubscriberStat = { name: string; delivered: number; failed: number; lastError: string | null; lastErrorAt: string | null };
export type SystemEventFailure = { id: string; subscriber: string; eventKind: string; entity: string | null; error: string; attempts: number; status: "retrying" | "dead"; nextAttemptAt: string | null; createdAt: string };
export type SystemHealth = {
  version: string;
  startedAt: string;
  database: { ok: boolean; ms: number };
  events: {
    lastHour: number;
    lastDay: number;
    byEntity: { entity: string; count: number }[];
    subscribers: SystemSubscriberStat[];
    failures: SystemEventFailure[];
    /** v21: "postgres" when events are shared between backend processes. */
    transport: "in_process" | "postgres";
    bridge?: { connected: boolean; sent: number; received: number; dropped: number; lastError: string | null };
  };
  realtime: { connections: number; people: number; rooms: number };
  search: { documents: number; byKind: { kind: string; count: number }[]; builtAt: string | null; building: boolean };
  jobs: { name: string; on: boolean; hint: string }[];
  /** v21: every backend process (API and worker) seen in the last day, newest first. */
  processes?: SystemProcess[];
  flags: FeatureFlagRow[];
};

export type SystemJobStat = {
  name: string;
  hint: string;
  everyMs: number;
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastMs: number | null;
  lastError: string | null;
  running: boolean;
};

export type SystemProcess = {
  id: string;
  role: "all" | "api" | "worker";
  host: string;
  pid: number;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  /** Wrote a heartbeat in the last minute. */
  alive: boolean;
  /** This is the process answering the request. */
  current: boolean;
  jobs: SystemJobStat[];
};

// ---------------------------------------------------------------------------
// Fuzzy search scoring (used by the search index; kept here so it is unit-tested once)

export function searchNormalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@.+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(" ")) {
    if (!word) continue;
    const w = `  ${word} `;
    for (let i = 0; i < w.length - 2; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

/** Edit distance with an early exit once it passes `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** A normalised text ready for scoring. Prepare documents once and reuse them (the search index does). */
export type PreparedSearchText = { norm: string; words: string[]; tri?: Set<string> };
export function prepareSearchText(text: string): PreparedSearchText {
  const norm = searchNormalise(text);
  return { norm, words: norm.split(" ") };
}
const triOf = (p: PreparedSearchText) => (p.tri ??= trigrams(p.norm));

/**
 * How well `query` matches `text`, 0 (no match) to 1 (exact). Exact and prefix matches score highest, then
 * substrings, then words within one or two typos ("arnoma" → "Aroma"), then shared letter groups.
 */
export function searchScore(query: string, text: string): number {
  return searchScorePrepared(prepareSearchText(query), prepareSearchText(text));
}

/**
 * `memo` (optional, one per query) remembers typo distances per word pair, so a search over thousands of
 * records only compares each distinct word once.
 */
export function searchScorePrepared(qp: PreparedSearchText, tp: PreparedSearchText, memo?: Map<string, number>): number {
  const q = qp.norm;
  const t = tp.norm;
  if (!q || !t) return 0;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.95;
  const words = tp.words;
  if (words.some((w) => w.startsWith(q))) return 0.9;
  if (t.includes(q)) return 0.8;
  const qWords = qp.words.filter(Boolean);
  // Each query word must be close to some word in the text.
  let typoScore = 0;
  let allClose = true;
  for (const qw of qWords) {
    const allowed = qw.length <= 3 ? 0 : qw.length <= 6 ? 1 : 2;
    let best = Infinity;
    for (const w of words) {
      const key = memo ? `${qw}\u0001${w}` : "";
      let d = memo?.get(key);
      if (d === undefined) {
        const cand = w.length > qw.length ? w.slice(0, qw.length + 1) : w;
        d = Math.min(editDistance(qw, w, allowed), editDistance(qw, cand, allowed));
        memo?.set(key, d);
      }
      best = Math.min(best, d);
      if (best === 0) break;
    }
    if (best > allowed) allClose = false;
    else typoScore += best === 0 ? 1 : 0.85;
  }
  if (allClose && qWords.length) return 0.55 + 0.2 * (typoScore / qWords.length);
  const a = triOf(qp);
  const b = triOf(tp);
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  const sim = shared / Math.max(1, a.size);
  return sim >= 0.5 ? 0.3 + sim * 0.2 : 0;
}

export const SEARCH_MIN_SCORE = 0.4;
