// v13 smart search: an index of every searchable record (SearchDoc), kept fresh by the event bus and held in memory
// per organisation, so Ctrl/Cmd+K can match typos and partial names ("arnoma" → "Aroma Cafe") in a few milliseconds.
// The index only proposes candidates; the search service still applies each area's own access rules to them.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SEARCH_MIN_SCORE, prepareSearchText, searchScorePrepared, type PreparedSearchText, type TeamSearchKind } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { eventBus, type BusEvent } from './event-bus.js';
import { backgroundJobsOff } from './events.service.js';
import { isServerless, servesHttp } from '../runtime/process-role.js';

type Doc = { kind: IndexedKind; entityId: string; title: string; keywords: string };
/** Each document's normalised text, worked out once (documents are replaced, never changed, so this stays right). */
const prepared = new WeakMap<Doc, { title: PreparedSearchText; keywords: PreparedSearchText | null }>();
export type IndexedKind = Exclude<TeamSearchKind, 'proposal'>;

/** Which change events touch which kind (a client rename also renames its projects, requests and invoices). */
const ENTITY_KINDS: Record<string, IndexedKind[]> = {
  ClientOrg: ['client', 'project', 'invoice', 'request'],
  Lead: ['lead'],
  Invoice: ['invoice'],
  Task: ['task'],
  User: ['person', 'creator'],
  SOP: ['sop'],
  Engagement: ['project', 'request'],
  Request: ['request'],
  Creator: ['creator'],
};
const KINDS: IndexedKind[] = ['client', 'lead', 'invoice', 'task', 'person', 'sop', 'project', 'request', 'creator'];
const join = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(' ');

@Injectable()
export class SearchIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SearchIndex');
  private readonly mem = new Map<string, Map<IndexedKind, Map<string, Doc>>>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, { orgId: string; kind: IndexedKind; ids: Set<string> | null }>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private unsub?: () => void;
  builtAt: Date | null = null;
  building = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.unsub = eventBus.subscribe('search_index', (e) => this.onEvent(e), ['change']);
    // Serverless: each function instance builds an organisation's index on its first search instead.
    if (!backgroundJobsOff() && servesHttp() && !isServerless()) setTimeout(() => void this.warmAll(), 5_000).unref?.();
  }

  onModuleDestroy() {
    this.unsub?.();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  // -------------------------------------------------------------------------
  // Queries

  /** Best matching record ids per kind, highest score first. */
  async find(orgId: string, q: string, kinds: IndexedKind[], take = 20): Promise<Map<IndexedKind, { id: string; score: number }[]>> {
    await this.ensure(orgId);
    const org = this.mem.get(orgId)!;
    const out = new Map<IndexedKind, { id: string; score: number }[]>();
    const qp = prepareSearchText(q);
    // Many records share words and whole titles ("Edit reel"), so remember work done in this search.
    const memo = new Map<string, number>();
    const byText = new Map<string, number>();
    const score = (tp: PreparedSearchText) => {
      let v = byText.get(tp.norm);
      if (v === undefined) byText.set(tp.norm, (v = searchScorePrepared(qp, tp, memo)));
      return v;
    };
    for (const kind of kinds) {
      const hits: { id: string; score: number }[] = [];
      for (const d of org.get(kind)?.values() ?? []) {
        let p = prepared.get(d);
        if (!p) prepared.set(d, (p = { title: prepareSearchText(d.title), keywords: d.keywords ? prepareSearchText(d.keywords) : null }));
        const s = Math.max(score(p.title), p.keywords ? score(p.keywords) * 0.9 : 0);
        if (s >= SEARCH_MIN_SCORE) hits.push({ id: d.entityId, score: s });
      }
      out.set(kind, hits.sort((a, b) => b.score - a.score).slice(0, take));
    }
    return out;
  }

  async stats(orgId: string) {
    const rows = await this.prisma.searchDoc.groupBy({ by: ['kind'], where: { orgId }, _count: { _all: true } });
    return { documents: rows.reduce((s, r) => s + r._count._all, 0), byKind: rows.map((r) => ({ kind: r.kind, count: r._count._all })).sort((a, b) => b.count - a.count), builtAt: this.builtAt?.toISOString() ?? null, building: this.building };
  }

  // -------------------------------------------------------------------------
  // Building

  /** Loads the organisation's index into memory, building it first if it has never been built. */
  private async ensure(orgId: string) {
    if (this.mem.has(orgId)) return;
    let p = this.loading.get(orgId);
    if (!p) {
      p = (async () => {
        const count = await this.prisma.searchDoc.count({ where: { orgId } });
        if (!count) await this.rebuild(orgId);
        else {
          const rows = await this.prisma.searchDoc.findMany({ where: { orgId }, select: { kind: true, entityId: true, title: true, keywords: true } });
          const org = new Map<IndexedKind, Map<string, Doc>>();
          for (const r of rows) {
            const kind = r.kind as IndexedKind;
            if (!org.has(kind)) org.set(kind, new Map());
            org.get(kind)!.set(r.entityId, { kind, entityId: r.entityId, title: r.title, keywords: r.keywords });
          }
          this.mem.set(orgId, org);
        }
      })().finally(() => this.loading.delete(orgId));
      this.loading.set(orgId, p);
    }
    await p;
  }

  private async warmAll() {
    try {
      const orgs = await this.prisma.organisation.findMany({ select: { id: true } });
      for (const o of orgs) await this.ensure(o.id);
      this.builtAt ??= new Date();
    } catch (e) {
      this.log.warn(`Could not warm the search index: ${(e as Error).message}`);
    }
  }

  /** Rebuilds the whole index for an organisation from the source tables. */
  async rebuild(orgId: string) {
    this.building = true;
    try {
      const org = new Map<IndexedKind, Map<string, Doc>>();
      for (const kind of KINDS) {
        const docs = await this.load(orgId, kind, null);
        org.set(kind, new Map(docs.map((d) => [d.entityId, d])));
      }
      const all = [...org.values()].flatMap((m) => [...m.values()]);
      await this.prisma.$transaction([this.prisma.searchDoc.deleteMany({ where: { orgId } }), this.prisma.searchDoc.createMany({ data: all.map((d) => ({ orgId, ...d })) })]);
      this.mem.set(orgId, org);
      this.builtAt = new Date();
      return all.length;
    } finally {
      this.building = false;
    }
  }

  private onEvent(e: BusEvent) {
    if (e.kind !== 'change' || !e.orgId) return;
    const kinds = ENTITY_KINDS[e.entity];
    if (!kinds) return;
    for (const kind of kinds) {
      // A rename of a client or engagement touches related records: refresh that kind for the organisation.
      const direct = (e.entity === 'ClientOrg' && kind === 'client') || (e.entity === 'User' && kind === 'person') || (e.entity === 'Engagement' && kind === 'project') || ENTITY_KINDS[e.entity].length === 1;
      const key = `${e.orgId}:${kind}`;
      const cur = this.pending.get(key) ?? { orgId: e.orgId, kind, ids: new Set<string>() };
      if (!direct || !e.ids.length) cur.ids = null;
      else if (cur.ids) for (const id of e.ids) cur.ids.add(id);
      this.pending.set(key, cur);
    }
    // Serverless: write now, while the request's function is still kept alive for its events (serverless.ts).
    if (isServerless()) return this.flush();
    this.schedule(1_500);
  }

  private schedule(ms: number) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const jobs = [...this.pending.values()];
      this.pending.clear();
      void this.flush(jobs).catch((err: Error) => {
        // Put the work back and try again shortly (e.g. the database restarted).
        this.log.warn(`Search index update failed, retrying: ${err.message}`);
        for (const j of jobs) if (!this.pending.has(`${j.orgId}:${j.kind}`)) this.pending.set(`${j.orgId}:${j.kind}`, { ...j, ids: null });
        this.schedule(30_000);
      });
    }, ms);
  }

  /** Applies queued changes. */
  async flush(jobs?: { orgId: string; kind: IndexedKind; ids: Set<string> | null }[]) {
    if (!jobs) {
      jobs = [...this.pending.values()];
      this.pending.clear();
    }
    for (const job of jobs) {
      if (!this.mem.has(job.orgId) && !(await this.prisma.searchDoc.count({ where: { orgId: job.orgId } }))) continue; // built on first search
      await this.ensure(job.orgId);
      const docs = await this.load(job.orgId, job.kind, job.ids ? [...job.ids] : null);
      const org = this.mem.get(job.orgId)!;
      if (!org.has(job.kind)) org.set(job.kind, new Map());
      const map = org.get(job.kind)!;
      const ids = job.ids ? [...job.ids] : null;
      const found = new Set(docs.map((d) => d.entityId));
      const removed = ids ? ids.filter((id) => !found.has(id)) : [...map.keys()].filter((id) => !found.has(id));
      await this.prisma.$transaction([
        this.prisma.searchDoc.deleteMany({ where: { kind: job.kind, entityId: { in: ids ?? [...map.keys()] } } }),
        this.prisma.searchDoc.createMany({ data: docs.map((d) => ({ orgId: job.orgId, ...d })), skipDuplicates: true }),
      ]);
      if (!ids) map.clear();
      for (const id of removed) map.delete(id);
      for (const d of docs) map.set(d.entityId, d);
    }
  }

  /** Searchable text for one kind (all live records, or only `ids`). Archived or deleted records drop out. */
  private async load(orgId: string, kind: IndexedKind, ids: string[] | null): Promise<Doc[]> {
    const idf = ids ? { id: { in: ids } } : {};
    switch (kind) {
      case 'client': {
        const rows = await this.prisma.clientOrg.findMany({ where: { orgId, deletedAt: null, ...idf }, select: { id: true, name: true, legalName: true, industry: true, gstin: true } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.name, keywords: join(r.legalName, r.industry, r.gstin) }));
      }
      case 'lead': {
        const rows = await this.prisma.lead.findMany({ where: { orgId, deletedAt: null, ...idf }, select: { id: true, contact: true, need: true } });
        return rows.map((r) => {
          const c = (r.contact ?? {}) as Record<string, string | undefined>;
          return { kind, entityId: r.id, title: c.company || c.name || 'Lead', keywords: join(c.name, c.email, c.phone, r.need?.slice(0, 200)) };
        });
      }
      case 'invoice': {
        const rows = await this.prisma.invoice.findMany({ where: { orgId, ...idf }, select: { id: true, number: true, clientOrg: { select: { name: true } } } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.number, keywords: join(r.clientOrg?.name) }));
      }
      case 'task': {
        const rows = await this.prisma.task.findMany({ where: { orgId, status: { not: 'cancelled' }, ...idf }, select: { id: true, title: true } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.title, keywords: '' }));
      }
      case 'person': {
        const rows = await this.prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, ...idf }, select: { id: true, name: true, email: true } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.name, keywords: join(r.email) }));
      }
      case 'sop': {
        const rows = await this.prisma.sOP.findMany({ where: { orgId, status: 'published', ...idf }, select: { id: true, title: true } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.title, keywords: '' }));
      }
      case 'project': {
        const rows = await this.prisma.engagement.findMany({ where: { orgId, deletedAt: null, ...idf }, select: { id: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
        return rows.map((r) => ({ kind, entityId: r.id, title: `${r.clientOrg.name} · ${r.service.name}`, keywords: join(r.clientOrg.name, r.service.name) }));
      }
      case 'request': {
        const rows = await this.prisma.request.findMany({ where: { orgId, ...idf }, select: { id: true, description: true, type: true, engagement: { select: { clientOrg: { select: { name: true } } } } } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.description.slice(0, 120), keywords: join(r.engagement.clientOrg.name, r.type.replace('_', ' ')) }));
      }
      case 'creator': {
        // Creator ids are indexed; a User change (rename) refreshes the whole kind.
        const rows = await this.prisma.creator.findMany({ where: { orgId, user: { deletedAt: null }, ...idf }, select: { id: true, handle: true, city: true, niche: true, user: { select: { name: true } } } });
        return rows.map((r) => ({ kind, entityId: r.id, title: r.user.name, keywords: join(r.handle ? `@${r.handle}` : null, r.handle, r.city, r.niche.join(' ')) }));
      }
    }
  }
}
