import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuditChainView, Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { eventBus } from '../platform/event-bus.js';

type Entry = { orgId: string; actorId: string | null; action: string; entity: string; entityId: string; before: unknown; after: unknown; ip: string | null; at: Date };

/** Stable JSON: keys sorted at every level, so the hash survives Postgres jsonb re-ordering keys. */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * v20: each entry's hash covers the previous entry's hash, so editing or deleting any past entry breaks the chain.
 * The IP address is left out so the DPDP retention rule can clear old IPs without breaking it.
 */
export function auditHash(prevHash: string, seq: number, e: Entry) {
  const body = canonical({ seq, orgId: e.orgId, actorId: e.actorId, action: e.action, entity: e.entity, entityId: e.entityId, before: e.before ?? null, after: e.after ?? null, at: e.at.toISOString() });
  return createHash('sha256').update(`${prevHash}\n${body}`).digest('hex');
}

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v ?? null)) as unknown));

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Appends one chained entry. A per-organisation lock keeps the sequence gap-free under load. */
  private async append(e: Entry) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit:${e.orgId}`}))`;
      const last = await tx.auditEvent.findFirst({ where: { orgId: e.orgId, seq: { not: null } }, orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? 'genesis';
      await tx.auditEvent.create({
        data: { orgId: e.orgId, actorId: e.actorId, action: e.action, entity: e.entity, entityId: e.entityId, before: e.before as never, after: e.after as never, ip: e.ip, at: e.at, seq, prevHash, hash: auditHash(prevHash, seq, e) },
      });
    });
  }

  /** Audit entry for automated actions (payments, automations) with no signed-in actor. */
  async logSystem(orgId: string, action: string, entity: string, entityId: string, after: unknown, ip?: string) {
    await this.append({ orgId, actorId: null, action, entity, entityId, before: undefined, after: json(after ?? null), ip: ip ?? null, at: new Date() });
    // v13: every audited action is also a domain event (workflows and agents will listen for these).
    eventBus.publish({ kind: 'domain', orgId, type: action, entity, entityId, actorId: null, at: new Date() });
  }

  /** Appends to the audit log. Called for every change to people, roles, pricing and pipeline. */
  async log(actor: Me, action: string, entity: string, entityId: string, before: unknown, after: unknown, ip?: string) {
    await this.append({ orgId: actor.orgId, actorId: actor.id, action, entity, entityId, before: json(before), after: json(after), ip: ip ?? null, at: new Date() });
    eventBus.publish({ kind: 'domain', orgId: actor.orgId, type: action, entity, entityId, actorId: actor.id, at: new Date() });
  }

  /** Re-computes the chain (from `fromSeq`, default the start) and reports the first entry that doesn't match. */
  async verify(orgId: string, fromSeq?: number): Promise<AuditChainView> {
    const start = Math.max(1, fromSeq ?? 1);
    let prev: string | null = start === 1 ? 'genesis' : ((await this.prisma.auditEvent.findFirst({ where: { orgId, seq: start - 1 }, select: { hash: true } }))?.hash ?? null);
    let expectSeq = start;
    let checked = 0;
    let lastSeq: number | null = null;
    const unchained = await this.prisma.auditEvent.count({ where: { orgId, seq: null } });
    if (prev === null) return { ok: false, checked: 0, fromSeq: start, lastSeq: null, brokenAt: { seq: start - 1, id: '', reason: 'The entry before the starting point is missing' }, unchained };
    for (;;) {
      const rows = await this.prisma.auditEvent.findMany({ where: { orgId, seq: { gte: expectSeq } }, orderBy: { seq: 'asc' }, take: 2000 });
      if (!rows.length) break;
      for (const r of rows) {
        if (r.seq !== expectSeq) return { ok: false, checked, fromSeq: start, lastSeq, brokenAt: { seq: expectSeq, id: r.id, reason: `Entry ${expectSeq} is missing (deleted?)` }, unchained };
        if (r.prevHash !== prev) return { ok: false, checked, fromSeq: start, lastSeq, brokenAt: { seq: r.seq, id: r.id, reason: 'It does not link to the entry before it' }, unchained };
        const h = auditHash(prev, r.seq, { orgId: r.orgId, actorId: r.actorId, action: r.action, entity: r.entity, entityId: r.entityId, before: r.before, after: r.after, ip: r.ip, at: r.at });
        if (h !== r.hash) return { ok: false, checked, fromSeq: start, lastSeq, brokenAt: { seq: r.seq, id: r.id, reason: 'Its contents were changed after it was written' }, unchained };
        prev = r.hash!;
        lastSeq = r.seq;
        expectSeq++;
        checked++;
      }
    }
    return { ok: true, checked, fromSeq: start, lastSeq, brokenAt: null, unchained };
  }
}
