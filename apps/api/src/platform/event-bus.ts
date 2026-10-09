// v13 foundation: the in-process event bus. Every database write publishes a `change` event (see prisma-events.ts)
// and every audited action publishes a `domain` event (see AuditService). Subscribers (live updates, search index,
// and later workflows and AI agents) listen here instead of being called directly by each feature.
//
// Delivery is asynchronous and never slows down or fails the request that caused it. A subscriber that throws is
// recorded (EventFailure) and retried with backoff by EventsService; after 5 attempts it is kept as "dead" on the
// System health page for a person to retry or dismiss.
import type { LiveChangeOp } from '@bmu/shared';
import { clearReadCache } from './read-cache.js';

export type ChangeRefs = { clientOrgId?: string | null; engagementId?: string | null; threadId?: string | null; userId?: string | null };

export type ChangeEvent = {
  kind: 'change';
  /** Organisation, when it could be worked out from the write. */
  orgId: string | null;
  /** Prisma model name, e.g. "Task", "ClientOrg". */
  entity: string;
  op: LiveChangeOp;
  /** Changed record ids (empty for bulk writes without an id filter). */
  ids: string[];
  at: Date;
  actorId: string | null;
  /** Written while serving a GET (lazy generation, "last seen" stamps): not pushed to screens, so a reload never triggers another. */
  quiet: boolean;
  refs: ChangeRefs;
};

export type DomainEvent = {
  kind: 'domain';
  orgId: string;
  /** Audit action, e.g. "lead.stage_changed", "task.reassigned". */
  type: string;
  entity: string;
  entityId: string;
  actorId: string | null;
  at: Date;
};

export type BusEvent = ChangeEvent | DomainEvent;
export type BusHandler = (e: BusEvent) => void | Promise<void>;

type Sub = { name: string; handler: BusHandler; kinds: BusEvent['kind'][] };
type SubStat = { delivered: number; failed: number; lastError: string | null; lastErrorAt: Date | null };

const RECENT_MAX = 50_000;
const DAY_MS = 24 * 3600_000;

export class EventBus {
  private readonly subs = new Map<string, Sub>();
  readonly stats = new Map<string, SubStat>();
  /** Recent events (time + entity) for the System health counts. */
  private recent: { at: number; entity: string }[] = [];
  /** Set by EventsService to persist failures for retry. */
  onFailure: ((subscriber: string, event: BusEvent, error: Error) => void) | null = null;
  /** v21: cheap synchronous listeners for cache clearing (not shown as subscribers, never retried). */
  private readonly watchers = new Set<(e: ChangeEvent) => void>();
  /** v21: set by EventBridgeService to pass this process's events on to the other backend processes. */
  outbound: ((e: BusEvent) => void) | null = null;
  /** v22: deliveries not finished yet (a serverless function waits for these before it may be frozen). */
  private readonly pending = new Set<Promise<void>>();

  subscribe(name: string, handler: BusHandler, kinds: BusEvent['kind'][] = ['change', 'domain']) {
    this.subs.set(name, { name, handler, kinds });
    if (!this.stats.has(name)) this.stats.set(name, { delivered: 0, failed: 0, lastError: null, lastErrorAt: null });
    return () => {
      if (this.subs.get(name)?.handler === handler) this.subs.delete(name);
    };
  }

  /**
   * v21: calls `fn` for every change to one of `entities`, made in this process or another one. Services use it to
   * drop their small in-memory caches (sessions, field access, flags, pipelines, webhook targets) at once.
   */
  watch(entities: string[], fn: (e: ChangeEvent) => void) {
    const set = new Set(entities);
    const w = (e: ChangeEvent) => {
      if (set.has(e.entity)) fn(e);
    };
    this.watchers.add(w);
    return () => this.watchers.delete(w);
  }

  subscribers() {
    return [...this.subs.keys()];
  }

  /** `remote` marks an event that arrived from another process (it is not sent back out). */
  publish(e: BusEvent, opts: { remote?: boolean } = {}) {
    if (!opts.remote) this.outbound?.(e);
    // Synchronously, so the very next read after a write never sees a cached copy from before it.
    if (e.kind === 'change' && !e.quiet) clearReadCache(e.orgId);
    if (e.kind === 'change') for (const w of this.watchers) w(e);
    const now = Date.now();
    this.recent.push({ at: now, entity: e.entity });
    if (this.recent.length > RECENT_MAX) this.recent = this.recent.filter((r) => r.at > now - DAY_MS).slice(-RECENT_MAX / 2);
    for (const sub of this.subs.values()) {
      if (!sub.kinds.includes(e.kind)) continue;
      const p = new Promise<void>((done) =>
        setImmediate(() => {
          void this.run(sub, e)
            .catch((err: Error) => this.onFailure?.(sub.name, e, err))
            .finally(done);
        }),
      );
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
  }

  /** Resolves once every delivery started so far (and any they start in turn) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending);
  }

  /** Delivers to one subscriber now; throws if it fails (used by retries). */
  async deliver(name: string, e: BusEvent) {
    const sub = this.subs.get(name);
    if (!sub) throw new Error(`No subscriber called ${name} is running`);
    await this.run(sub, e);
  }

  private async run(sub: Sub, e: BusEvent) {
    const stat = this.stats.get(sub.name)!;
    try {
      await sub.handler(e);
      stat.delivered++;
    } catch (err) {
      stat.failed++;
      stat.lastError = (err as Error).message ?? String(err);
      stat.lastErrorAt = new Date();
      throw err;
    }
  }

  counts(now = Date.now()) {
    const hour = now - 3600_000;
    const day = now - DAY_MS;
    let lastHour = 0;
    let lastDay = 0;
    const byEntity = new Map<string, number>();
    for (const r of this.recent) {
      if (r.at > day) lastDay++;
      if (r.at > hour) {
        lastHour++;
        byEntity.set(r.entity, (byEntity.get(r.entity) ?? 0) + 1);
      }
    }
    return { lastHour, lastDay, byEntity: [...byEntity].map(([entity, count]) => ({ entity, count })).sort((a, b) => b.count - a.count).slice(0, 12) };
  }
}

/** One bus per backend process (events cross between processes through runtime/event-bridge.ts). A module-level instance so PrismaService (created before Nest DI finishes) can publish. */
export const eventBus = new EventBus();

/** Turns a stored (JSON) event back into a BusEvent. */
export function reviveEvent(raw: unknown): BusEvent {
  const e = raw as BusEvent & { at: string | Date };
  return { ...e, at: new Date(e.at) } as BusEvent;
}
