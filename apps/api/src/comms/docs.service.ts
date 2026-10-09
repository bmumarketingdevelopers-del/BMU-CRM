// v17 collaborative documents (briefs, proposal drafts, notes). The text lives in a Yjs document so two people can
// type at the same time without losing each other's words: each browser sends small Yjs updates, the server merges
// them into the stored state (one doc at a time, in order) and hands back whatever that browser has not seen yet.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';
import { docCreateSchema, docEditSchema, docUpdateSchema, type DocDetail, type DocKind, type DocRow, type Me } from '@bmu/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientScope, inScope, isLeadership } from '../creative/scope.js';
import { initialDocState } from './doc-state.js';

type DocRec = Prisma.CollabDocGetPayload<object>;
const svSchema = z.object({ sv: z.string().max(100_000).optional() });
const editWithSv = docEditSchema.extend({ sv: z.string().max(100_000).optional() });

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const leadName = (contact: unknown) => {
  const c = (contact ?? {}) as { name?: string; company?: string };
  return c.company || c.name || 'Lead';
};

@Injectable()
export class DocsService {
  /** Edits to one document run one after another so no update is lost between read and write. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }

  // ------------------------------------------------------------------------------------------------ access

  private async access(me: Me, d: DocRec): Promise<{ edit: boolean; share: boolean; archive: boolean }> {
    if (me.type === 'client') {
      if (!me.clientOrg || d.clientOrgId !== me.clientOrg.id || !d.clientVisible || d.archivedAt) throw new NotFoundException('Document not found');
      return { edit: me.clientOrg.role !== 'client_viewer' && me.clientOrg.role !== 'client_finance', share: false, archive: false };
    }
    if (me.type !== 'staff') throw new ForbiddenException('Not available');
    const scope = await clientScope(this.prisma, me);
    if (d.leadId && !d.clientOrgId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: d.leadId }, select: { ownerId: true } });
      const ok = isLeadership(me) || me.roles.includes('sales_manager') || lead?.ownerId === me.id || d.createdById === me.id;
      if (!ok) throw new NotFoundException('Document not found');
    } else if (!inScope(scope, d.clientOrgId) && d.createdById !== me.id) throw new NotFoundException('Document not found');
    const owner = d.createdById === me.id || isLeadership(me);
    return { edit: !d.archivedAt, share: !!d.clientOrgId && (owner || inScope(scope, d.clientOrgId)), archive: owner };
  }

  private async load(me: Me, id: string) {
    const d = await this.prisma.collabDoc.findFirst({ where: { id, orgId: me.orgId } });
    if (!d) throw new NotFoundException('Document not found');
    const can = await this.access(me, d);
    return { d, can };
  }

  // ------------------------------------------------------------------------------------------------ views

  private async rows(list: DocRec[]): Promise<DocRow[]> {
    const ids = (k: 'clientOrgId' | 'engagementId' | 'leadId' | 'updatedById') => [...new Set(list.map((d) => d[k]).filter((x): x is string => !!x))];
    const [clients, engs, leads, users] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: ids('clientOrgId') } }, select: { id: true, name: true } }),
      this.prisma.engagement.findMany({ where: { id: { in: ids('engagementId') } }, select: { id: true, service: { select: { name: true } }, clientOrg: { select: { name: true } } } }),
      this.prisma.lead.findMany({ where: { id: { in: ids('leadId') } }, select: { id: true, contact: true } }),
      this.prisma.user.findMany({ where: { id: { in: ids('updatedById') } }, select: { id: true, name: true } }),
    ]);
    return list.map((d) => {
      const e = engs.find((x) => x.id === d.engagementId);
      const l = leads.find((x) => x.id === d.leadId);
      return {
        id: d.id,
        title: d.title,
        kind: d.kind as DocKind,
        client: clients.find((c) => c.id === d.clientOrgId) ?? null,
        engagement: e ? { id: e.id, name: e.service.name } : null,
        lead: l ? { id: l.id, name: leadName(l.contact) } : null,
        clientVisible: d.clientVisible,
        words: words(d.text),
        updatedBy: users.find((u) => u.id === d.updatedById)?.name ?? null,
        updatedAt: d.updatedAt.toISOString(),
      };
    });
  }

  private async detail(d: DocRec, can: DocDetail['can']): Promise<DocDetail> {
    const [row] = await this.rows([d]);
    return { ...row, state: Buffer.from(d.state).toString('base64'), text: d.text, version: d.version, can };
  }

  async list(me: Me, q: { engagementId?: string; leadId?: string; clientOrgId?: string }): Promise<DocRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const scope = await clientScope(this.prisma, me);
    const where: Prisma.CollabDocWhereInput = { orgId: me.orgId, archivedAt: null };
    if (q.engagementId) where.engagementId = q.engagementId;
    if (q.leadId) where.leadId = q.leadId;
    if (q.clientOrgId) where.clientOrgId = q.clientOrgId;
    if (scope !== 'all') {
      const leads = await this.prisma.lead.findMany({ where: { orgId: me.orgId, ownerId: me.id }, select: { id: true }, take: 5000 });
      where.OR = [{ createdById: me.id }, { clientOrgId: { in: scope } }, { clientOrgId: null, leadId: { in: leads.map((l) => l.id) } }, { clientOrgId: null, leadId: null, createdById: me.id }];
    }
    const list = await this.prisma.collabDoc.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 });
    return this.rows(list);
  }

  async clientList(me: Me): Promise<DocRow[]> {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    const list = await this.prisma.collabDoc.findMany({ where: { orgId: me.orgId, clientOrgId: me.clientOrg.id, clientVisible: true, archivedAt: null }, orderBy: { updatedAt: 'desc' }, take: 100 });
    return this.rows(list);
  }

  async get(me: Me, id: string): Promise<DocDetail> {
    const { d, can } = await this.load(me, id);
    return this.detail(d, can);
  }

  async create(me: Me, body: unknown, ip?: string): Promise<DocDetail> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const input = parse(docCreateSchema, body);
    let clientOrgId = input.clientOrgId ?? null;
    if (input.engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, orgId: me.orgId }, select: { clientOrgId: true } });
      if (!e) throw new BadRequestException('Project not found');
      clientOrgId = e.clientOrgId;
    }
    if (input.leadId && !(await this.prisma.lead.findFirst({ where: { id: input.leadId, orgId: me.orgId }, select: { id: true } }))) throw new BadRequestException('Lead not found');
    if (clientOrgId) {
      if (!(await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId }, select: { id: true } }))) throw new BadRequestException('Client not found');
      if (!inScope(await clientScope(this.prisma, me), clientOrgId)) throw new ForbiddenException('You do not work on this client');
    }
    const text = input.text ?? '';
    const d = await this.prisma.collabDoc.create({
      data: { orgId: me.orgId, title: input.title, kind: input.kind, clientOrgId, engagementId: input.engagementId ?? null, leadId: input.leadId ?? null, state: initialDocState(text), text, createdById: me.id, updatedById: me.id },
    });
    await this.audit.log(me, 'doc.created', 'CollabDoc', d.id, null, { title: d.title, kind: d.kind }, ip);
    return this.get(me, d.id);
  }

  async update(me: Me, id: string, body: unknown, ip?: string): Promise<DocDetail> {
    const { d, can } = await this.load(me, id);
    const input = parse(docUpdateSchema, body);
    if (input.clientVisible !== undefined && !can.share) throw new ForbiddenException('You cannot share this document');
    if (input.archived !== undefined && !can.archive) throw new ForbiddenException('Only the author or leadership can archive');
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const after = await this.prisma.collabDoc.update({
      where: { id },
      data: {
        title: input.title ?? undefined,
        clientVisible: input.clientVisible ?? undefined,
        archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
        updatedById: me.id,
      },
    });
    if (after.clientVisible && !d.clientVisible && after.clientOrgId) {
      const people = await this.prisma.clientUser.findMany({ where: { clientOrgId: after.clientOrgId }, select: { userId: true } });
      await this.notifications.notify(me.orgId, people.map((p) => p.userId), { kind: 'doc_shared', title: `${me.name} shared "${after.title}" with you`, body: 'You can read it and edit it together with the team.', link: `/client/docs/${id}` });
    }
    await this.audit.log(me, 'doc.updated', 'CollabDoc', id, { title: d.title, clientVisible: d.clientVisible, archived: !!d.archivedAt }, { title: after.title, clientVisible: after.clientVisible, archived: !!after.archivedAt }, ip);
    return this.get(me, id);
  }

  /** Merges one editing step and returns what the sender is missing. */
  async edit(me: Me, id: string, body: unknown) {
    const { can } = await this.load(me, id);
    if (!can.edit) throw new ForbiddenException('You can read this document but not edit it');
    const input = parse(editWithSv, body);
    return this.withLock(id, async () => {
      // v21: several API processes can take edits for the same document. The save only succeeds if nobody saved
      // in between (version check); otherwise it merges again on the newer state. Yjs merges are safe to repeat.
      for (let attempt = 0; ; attempt++) {
        const d = await this.prisma.collabDoc.findUniqueOrThrow({ where: { id } });
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(d.state));
        const before = doc.getText('body').toString();
        try {
          Y.applyUpdate(doc, fromB64(input.update));
        } catch {
          throw new BadRequestException('That edit could not be read. Reload the page.');
        }
        const text = doc.getText('body').toString();
        if (text.length > 200_000) throw new BadRequestException('The document is too long (200,000 characters max)');
        const state = Buffer.from(Y.encodeStateAsUpdate(doc));
        const changed = text !== before || !Buffer.from(d.state).equals(state);
        let version = d.version;
        if (changed) {
          const saved = await this.prisma.collabDoc.updateMany({ where: { id, version: d.version }, data: { state, text, version: { increment: 1 }, updatedById: me.id } });
          if (saved.count === 0) {
            if (attempt < 5) continue;
            throw new BadRequestException('This document is very busy right now. Try again.');
          }
          version = d.version + 1;
        }
        return { update: b64(Y.encodeStateAsUpdate(doc, input.sv ? fromB64(input.sv) : undefined)), version };
      }
    });
  }

  /** What a browser with this state vector is missing. */
  async pull(me: Me, id: string, body: unknown) {
    const { d } = await this.load(me, id);
    const input = parse(svSchema, body);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(d.state));
    return { update: b64(Y.encodeStateAsUpdate(doc, input.sv ? fromB64(input.sv) : undefined)), version: d.version };
  }
}
