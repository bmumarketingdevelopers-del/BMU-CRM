// v20 offline-first sync engine, shared by the phone app (client side) and the API (server side).
// The phone keeps a local copy of what was recently viewed and queues changes made offline; when it is back online
// it sends the queue. Each change carries the values it was based on, so the server can merge field by field:
// a field nobody else touched is simply applied; a field changed on both sides follows the conflict rules below.
import { z } from "zod";
import { CORE_TASK_PRIORITIES } from "../core-actions.js";
import { TASK_STATUSES, type TaskView } from "../production.js";

export type ChecklistItem = { id: string; label: string; done: boolean };
export type TaskSnapshot = {
  status: (typeof TASK_STATUSES)[number];
  blockedReason: string | null;
  title: string;
  description: string | null;
  checklist: ChecklistItem[];
  priority: (typeof CORE_TASK_PRIORITIES)[number];
};
export const SYNC_TASK_FIELDS = ["status", "blockedReason", "title", "description", "checklist", "priority"] as const;
export type SyncTaskField = (typeof SYNC_TASK_FIELDS)[number];

const checklist = z.array(z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1).max(200), done: z.boolean() })).max(50);
const taskFields = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  blockedReason: z.string().trim().max(500).nullable().optional(),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  checklist: checklist.optional(),
  priority: z.enum(CORE_TASK_PRIORITIES).optional(),
});

export const syncOpSchema = z.object({
  clientOpId: z.string().min(8).max(64),
  entity: z.literal("task"),
  entityId: z.string().min(1).max(40),
  op: z.literal("update"),
  /** The values this change was based on (what the phone last saw). */
  base: taskFields,
  changes: taskFields.extend({ logMinutes: z.number().int().min(1).max(24 * 60).optional() }),
  /** When the change was made on the phone (ISO). */
  at: z.string().max(40),
});
export type SyncOpInput = z.infer<typeof syncOpSchema>;
export const syncPushSchema = z.object({ ops: z.array(syncOpSchema).min(1).max(100) });

export type SyncConflict = { field: SyncTaskField; yours: unknown; theirs: unknown; kept: "yours" | "theirs" | "both" };
export type SyncOpStatus = "applied" | "merged" | "conflict" | "rejected";
export type SyncOpResult = { clientOpId: string; status: SyncOpStatus; message: string | null; conflicts: SyncConflict[]; task: TaskView | null };
export type SyncPullView = { now: string; tasks: TaskView[]; unread: number };

export const syncStatusLabels: Record<SyncOpStatus, string> = {
  applied: "Saved",
  merged: "Saved and combined with changes made elsewhere",
  conflict: "Someone changed this at the same time; their version was kept for some fields",
  rejected: "Could not be saved",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const FINISHED = ["done", "cancelled"];

/** Checklists merge item by item: new items from both sides are kept, an item ticked on either side stays ticked. */
export function mergeChecklist(server: ChecklistItem[], base: ChecklistItem[], local: ChecklistItem[]): ChecklistItem[] {
  const baseById = new Map(base.map((i) => [i.id, i]));
  const localById = new Map(local.map((i) => [i.id, i]));
  const out: ChecklistItem[] = [];
  for (const s of server) {
    const l = localById.get(s.id);
    const b = baseById.get(s.id);
    if (!l) {
      // Removed on the phone (it was there before) → remove, unless the server changed it meanwhile.
      if (b && same(b, s)) continue;
      out.push(s);
      continue;
    }
    const labelChangedHere = !b || l.label !== b.label;
    const labelChangedThere = !b || s.label !== b.label;
    out.push({ id: s.id, label: labelChangedHere && !labelChangedThere ? l.label : s.label, done: (b ? l.done !== b.done : l.done) ? l.done : s.done });
  }
  for (const l of local) if (!server.some((s) => s.id === l.id) && !baseById.has(l.id)) out.push(l);
  return out;
}

/**
 * Three-way merge of a task change made offline.
 * - A field the server did not change since `base` takes the phone's value.
 * - Both changed: status keeps the phone's value unless the task was finished elsewhere (done/cancelled wins);
 *   checklists merge item by item; title, description and priority keep the server's value (reported back).
 */
export function mergeTask(server: TaskSnapshot, base: Partial<TaskSnapshot>, changes: Partial<TaskSnapshot>): { patch: Partial<TaskSnapshot>; conflicts: SyncConflict[] } {
  const patch: Partial<TaskSnapshot> = {};
  const conflicts: SyncConflict[] = [];
  const set = (k: SyncTaskField, v: unknown) => {
    if (!same(server[k], v)) (patch as Record<string, unknown>)[k] = v;
  };
  for (const k of SYNC_TASK_FIELDS) {
    if (!(k in changes)) continue;
    const mine = changes[k] as unknown;
    const untouchedThere = !(k in base) || same(server[k], base[k]);
    if (untouchedThere || same(server[k], mine)) {
      set(k, mine);
      continue;
    }
    if (k === "status") {
      if (FINISHED.includes(server.status) && !FINISHED.includes(mine as string)) {
        conflicts.push({ field: k, yours: mine, theirs: server.status, kept: "theirs" });
      } else {
        conflicts.push({ field: k, yours: mine, theirs: server.status, kept: "yours" });
        set(k, mine);
      }
    } else if (k === "blockedReason") {
      // Follows whichever status was kept.
      const statusKept = "status" in patch ? patch.status : server.status;
      if (statusKept === "blocked" && changes.status === "blocked") set(k, mine);
    } else if (k === "checklist") {
      const merged = mergeChecklist(server.checklist, base.checklist ?? [], mine as ChecklistItem[]);
      conflicts.push({ field: k, yours: mine, theirs: server.checklist, kept: "both" });
      set(k, merged);
    } else {
      conflicts.push({ field: k, yours: mine, theirs: server[k], kept: "theirs" });
    }
  }
  return { patch, conflicts };
}

export function syncOutcome(conflicts: SyncConflict[]): SyncOpStatus {
  if (!conflicts.length) return "applied";
  return conflicts.some((c) => c.kept === "theirs") ? "conflict" : "merged";
}

// ------------------------------------------------------------------------------------------------ the phone's queue

export type QueuedOp = SyncOpInput & { tries: number; lastError?: string };
export interface SyncStorage {
  load(): Promise<QueuedOp[]>;
  save(ops: QueuedOp[]): Promise<void>;
}
/** Thrown by a transport when the device is offline or the server can't be reached (the op stays queued). */
export class OfflineError extends Error {
  constructor(message = "Offline") {
    super(message);
  }
}

/** True for errors that mean "no connection" rather than "the server said no". */
export const isNetworkError = (e: unknown) => e instanceof OfflineError || e instanceof TypeError || /network|fetch failed|timed? ?out|ECONNREFUSED|Failed to fetch/i.test(String((e as Error)?.message ?? e));

export class SyncQueue {
  private ops: QueuedOp[] = [];
  private loaded = false;
  private flushing: Promise<SyncOpResult[]> | null = null;
  private readonly listeners = new Set<(pending: number, results?: SyncOpResult[]) => void>();

  constructor(
    private readonly storage: SyncStorage,
    private readonly send: (ops: SyncOpInput[]) => Promise<SyncOpResult[]>,
    private readonly newId: () => string = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  ) {}

  async init() {
    if (!this.loaded) {
      this.ops = await this.storage.load();
      this.loaded = true;
    }
    return this;
  }

  pending() {
    return this.ops.length;
  }

  list() {
    return [...this.ops];
  }

  subscribe(fn: (pending: number, results?: SyncOpResult[]) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(results?: SyncOpResult[]) {
    for (const fn of this.listeners) fn(this.ops.length, results);
  }

  /**
   * Queues a task change. Changes to the same task waiting in the queue are combined (later values win,
   * the earliest base is kept, logged minutes add up), so many offline edits sync as one.
   */
  async enqueueTask(taskId: string, base: Partial<TaskSnapshot>, changes: SyncOpInput["changes"], at = new Date()) {
    await this.init();
    const waiting = this.ops.find((o) => o.entityId === taskId && o.entity === "task" && o.tries === 0);
    if (waiting) {
      const logMinutes = (waiting.changes.logMinutes ?? 0) + (changes.logMinutes ?? 0) || undefined;
      waiting.base = { ...base, ...waiting.base };
      waiting.changes = { ...waiting.changes, ...changes, ...(logMinutes ? { logMinutes } : {}) };
      waiting.at = at.toISOString();
    } else {
      this.ops.push({ clientOpId: this.newId(), entity: "task", entityId: taskId, op: "update", base, changes, at: at.toISOString(), tries: 0 });
    }
    await this.storage.save(this.ops);
    this.emit();
  }

  /** Sends everything queued. Network failures leave the queue as it is; answered ops are removed. */
  flush(): Promise<SyncOpResult[]> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      await this.init();
      if (!this.ops.length) return [];
      const batch = this.ops.slice(0, 100);
      for (const o of batch) o.tries++;
      try {
        const results = await this.send(batch.map(({ tries: _t, lastError: _e, ...op }) => op));
        const done = new Set(results.map((r) => r.clientOpId));
        this.ops = this.ops.filter((o) => !done.has(o.clientOpId));
        await this.storage.save(this.ops);
        this.emit(results);
        return results;
      } catch (e) {
        for (const o of batch) o.lastError = (e as Error).message;
        await this.storage.save(this.ops);
        this.emit();
        if (isNetworkError(e)) return [];
        throw e;
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
}

/** The current values of a task's syncable fields, from what the app shows. */
export function taskSnapshot(t: Pick<TaskView, "status" | "blockedReason" | "title"> & Partial<Pick<TaskSnapshot, "description" | "checklist" | "priority">>): Partial<TaskSnapshot> {
  const s: Partial<TaskSnapshot> = { status: t.status, blockedReason: t.blockedReason, title: t.title };
  if (t.description !== undefined) s.description = t.description;
  if (t.checklist !== undefined) s.checklist = t.checklist;
  if (t.priority !== undefined) s.priority = t.priority;
  return s;
}

/** Applies queued changes on top of a task for display while they wait to sync. */
export function withPending(t: TaskView, ops: SyncOpInput[]): TaskView & { pendingSync: boolean } {
  const mine = ops.filter((o) => o.entityId === t.id);
  if (!mine.length) return { ...t, pendingSync: false };
  const c = Object.assign({}, ...mine.map((o) => o.changes)) as SyncOpInput["changes"];
  return { ...t, ...(c.status ? { status: c.status } : {}), ...(c.blockedReason !== undefined ? { blockedReason: c.blockedReason } : {}), ...(c.title ? { title: c.title } : {}), timeLoggedMin: t.timeLoggedMin + mine.reduce((s, o) => s + (o.changes.logMinutes ?? 0), 0), pendingSync: true };
}

// ------------------------------------------------------------------------------------------------ push quick actions

export const PUSH_CATEGORIES = { approval: ["approve", "reject", "snooze"], message: ["reply", "snooze"], task: ["done", "snooze"], general: ["snooze"] } as const;
export type PushCategory = keyof typeof PUSH_CATEGORIES;
export const quickActionSchema = z.object({
  notificationId: z.string().min(1).max(40),
  action: z.enum(["approve", "reject", "reply", "done", "snooze"]),
  text: z.string().trim().max(2000).optional(),
});
export type QuickActionInput = z.infer<typeof quickActionSchema>;
export const pushTokenSchema = z.object({ token: z.string().trim().min(10).max(300), platform: z.enum(["ios", "android", "web"]) });

/** Which quick actions a notification gets on the phone. */
export function pushCategory(n: { kind: string; link: string | null; ref?: string | null }): { category: PushCategory; ref: string | null } {
  if (n.kind === "approval_needed" && n.ref) return { category: "approval", ref: n.ref };
  const thread = n.link?.match(/^\/team\/messages\/([\w-]+)/);
  if (thread) return { category: "message", ref: thread[1] };
  if (n.link === "/client/messages") return { category: "message", ref: null };
  const task = n.link?.match(/^\/team\/tasks\/([\w-]+)/);
  if (task) return { category: "task", ref: task[1] };
  return { category: "general", ref: null };
}
