// v10 deliver: handover pack at Gate 5. The final delivery page lists every approved final file and link plus the
// logins/notes handed over, with a one-click zip of the released files, and a feedback (NPS 0-10) step that
// feeds Client Health.
import { resolve } from 'node:path';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { deliverNpsBand, type DeliverHandoverItemInput, type DeliverHandoverView, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLeadership, visibleEngagementWhere } from '../engagements/engagement-access.js';
import { storageRoot } from '../production/production.controller.js';
import { ZipStream } from './zip-stream.js';
import { localFile } from '../storage/file-store.js';

const DONE_D = ['approved', 'scheduled', 'published'];
const safe = (s: string) => s.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';

@Injectable()
export class DeliverHandoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(me: Me, engagementId: string) {
    const where =
      me.type === 'client'
        ? { id: engagementId, orgId: me.orgId, clientOrgId: me.clientOrg?.id ?? '__none__', deletedAt: null }
        : me.type === 'staff'
          ? { AND: [await visibleEngagementWhere(this.prisma, me), { id: engagementId }] }
          : null;
    if (!where) throw new ForbiddenException('Not available for your account');
    const e = await this.prisma.engagement.findFirst({
      where,
      include: {
        clientOrg: { select: { id: true, name: true } },
        service: { select: { name: true } },
        cycles: { include: { deliverables: { include: { versions: { include: { file: true } } }, orderBy: { title: 'asc' } } } },
      },
    });
    if (!e) throw new NotFoundException('Engagement not found');
    return e;
  }

  private finals(e: Awaited<ReturnType<DeliverHandoverService['load']>>) {
    return e.cycles
      .flatMap((c) => c.deliverables)
      .filter((d) => DONE_D.includes(d.status) && d.approvedVersionId)
      .map((d) => ({ d, v: d.versions.find((v) => v.id === d.approvedVersionId)! }))
      .filter((x) => x.v);
  }

  private isDecider(me: Me) {
    return me.clientOrg?.role === 'client_owner' || me.clientOrg?.role === 'client_approver';
  }

  async view(me: Me, engagementId: string): Promise<DeliverHandoverView> {
    const e = await this.load(me, engagementId);
    const finals = this.finals(e);
    const fileFinals = finals.filter((x) => x.v.file.kind !== 'link');
    const released = e.status === 'delivered' || (fileFinals.length > 0 && fileFinals.every((x) => x.v.file.released));
    const isClient = me.type === 'client';
    const items = await this.prisma.deliverHandoverItem.findMany({ where: { engagementId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    const feedback = await this.prisma.deliverFeedback.findMany({ where: { engagementId }, orderBy: { createdAt: 'desc' } });
    const people = await this.prisma.user.findMany({ where: { id: { in: [...items.map((i) => i.createdById), ...feedback.map((f) => f.userId)] } }, select: { id: true, name: true } });
    const name = (id: string) => people.find((p) => p.id === id)?.name ?? '';
    const showItems = !isClient || released;
    const mine = isClient ? feedback.find((f) => f.userId === me.id) : undefined;
    const canDownload = !isClient || released;
    return {
      engagementId: e.id,
      client: e.clientOrg,
      serviceName: e.service.name,
      status: e.status,
      released,
      signedOffAt: e.finalSignedOffAt?.toISOString() ?? null,
      files: fileFinals.map(({ d, v }) => ({
        deliverableId: d.id,
        deliverable: d.title,
        type: d.type,
        version: v.number,
        fileId: v.file.id,
        name: v.file.name ?? d.title,
        kind: v.file.kind,
        url: `/api/files/${v.file.id}`,
        downloadUrl: canDownload ? `/api/files/${v.file.id}?download=1` : null,
        sizeBytes: v.file.sizeBytes,
      })),
      links: [
        ...finals.filter((x) => x.v.file.kind === 'link').map(({ d, v }) => ({ label: d.title, url: v.file.path, source: 'deliverable' as const })),
        ...(showItems ? items.filter((i) => i.kind === 'link').map((i) => ({ label: i.label, url: i.value, source: 'handover' as const })) : []),
      ],
      items: showItems ? items.filter((i) => i.kind !== 'link').map((i) => ({ id: i.id, kind: i.kind as 'credential' | 'note', label: i.label, value: i.value, addedBy: name(i.createdById), at: i.createdAt.toISOString() })) : [],
      zipUrl: canDownload && fileFinals.length ? `/api/deliver/engagements/${e.id}/handover.zip` : null,
      feedback: {
        mine: mine ? { score: mine.score, comment: mine.comment, at: mine.createdAt.toISOString() } : null,
        all: isClient ? [] : feedback.map((f) => ({ name: name(f.userId), score: f.score, comment: f.comment, at: f.createdAt.toISOString() })),
        average: feedback.length ? Math.round((feedback.reduce((s, f) => s + f.score, 0) / feedback.length) * 10) / 10 : null,
      },
      can: {
        addItems: me.type === 'staff' && (e.amId === me.id || isLeadership(me)),
        giveFeedback: isClient && this.isDecider(me) && (released || !!e.finalSignedOffAt),
        download: canDownload && fileFinals.length > 0,
      },
    };
  }

  async addItem(me: Me, engagementId: string, input: DeliverHandoverItemInput, ip?: string) {
    const v = await this.view(me, engagementId);
    if (!v.can.addItems) throw new ForbiddenException("Only the client's Account Manager or leadership can add to the handover pack");
    if (input.kind === 'link' && !/^https?:\/\//.test(input.value)) throw new BadRequestException('Links start with https://');
    const item = await this.prisma.deliverHandoverItem.create({ data: { orgId: me.orgId, engagementId, kind: input.kind, label: input.label, value: input.value, createdById: me.id } });
    // Never write the secret itself to the audit log.
    await this.audit.log(me, 'handover.item_added', 'Engagement', engagementId, undefined, { kind: input.kind, label: input.label }, ip);
    if (v.released) {
      const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId }, select: { clientOrgId: true } });
      await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(e.clientOrgId), {
        kind: 'handover_updated',
        title: `${v.serviceName}: "${item.label}" added to your handover pack`,
        link: `/client/handover/${engagementId}`,
      });
    }
    return this.view(me, engagementId);
  }

  async removeItem(me: Me, itemId: string, ip?: string) {
    const item = await this.prisma.deliverHandoverItem.findFirst({ where: { id: itemId, orgId: me.orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Item not found');
    const v = await this.view(me, item.engagementId);
    if (!v.can.addItems) throw new ForbiddenException("Only the client's Account Manager or leadership can change the handover pack");
    await this.prisma.deliverHandoverItem.update({ where: { id: itemId }, data: { deletedAt: new Date() } });
    await this.audit.log(me, 'handover.item_removed', 'Engagement', item.engagementId, { kind: item.kind, label: item.label }, undefined, ip);
    return this.view(me, item.engagementId);
  }

  /** Client feedback (0-10). One per person per engagement; a second answer replaces the first. */
  async feedback(me: Me, engagementId: string, input: { score: number; comment?: string }, ip?: string) {
    const v = await this.view(me, engagementId);
    if (!v.can.giveFeedback) throw new ForbiddenException(me.type !== 'client' ? 'Only the client can give feedback' : 'Feedback opens after the final sign-off');
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId }, include: { clientOrg: true } });
    await this.prisma.deliverFeedback.upsert({
      where: { engagementId_userId: { engagementId, userId: me.id } },
      update: { score: input.score, comment: input.comment ?? null, createdAt: new Date() },
      create: { orgId: me.orgId, engagementId, clientOrgId: e.clientOrgId, userId: me.id, score: input.score, comment: input.comment ?? null },
    });
    const band = deliverNpsBand(input.score);
    await this.audit.log(me, 'client.feedback', 'Engagement', engagementId, undefined, { score: input.score, band }, ip);
    // Client Health: a detractor turns the client red, a passive amber (never improves a red set elsewhere).
    if (band === 'detractor' && e.clientOrg.health !== 'red') await this.prisma.clientOrg.update({ where: { id: e.clientOrgId }, data: { health: 'red' } });
    if (band === 'passive' && e.clientOrg.health === 'green') await this.prisma.clientOrg.update({ where: { id: e.clientOrgId }, data: { health: 'amber' } });
    const leads = band === 'detractor' ? (await this.prisma.user.findMany({ where: { orgId: me.orgId, status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'am_lead' } } } }, select: { id: true } })).map((u) => u.id) : [];
    await this.notifications.notify(me.orgId, [e.amId, ...leads], {
      kind: 'client_feedback',
      title: `${e.clientOrg.name} rated ${v.serviceName} ${input.score}/10`,
      body: input.comment || (band === 'promoter' ? 'A promoter. Ask for a review or referral.' : band === 'detractor' ? 'A detractor. Call them this week.' : undefined),
      link: `/team/projects/${engagementId}`,
      critical: band === 'detractor',
    });
    return this.view(me, engagementId);
  }

  /** Streams a zip of the approved final files (+ a text file with links, logins and notes). */
  async zip(me: Me, engagementId: string, res: Response) {
    const v = await this.view(me, engagementId);
    if (!v.can.download) {
      throw new ForbiddenException(me.type === 'client' ? 'Final files unlock after sign-off and the final payment' : 'No final files yet');
    }
    const files = await this.prisma.file.findMany({ where: { id: { in: v.files.map((f) => f.fileId) } } });
    const root = storageRoot();
    await this.audit.log(me, 'handover.downloaded', 'Engagement', engagementId, undefined, { files: files.length });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safe(`${v.client.name} - ${v.serviceName}`)} - final files.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const zip = new ZipStream(res);
    const used = new Set<string>();
    for (const f of v.files) {
      const file = files.find((x) => x.id === f.fileId);
      if (!file) continue;
      const abs = await localFile(file.path).catch(() => resolve(root, file.path));
      if (!abs.startsWith(root)) continue;
      const ext = (file.name ?? '').match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? '';
      let name = `${safe(f.deliverable)} v${f.version}${ext}`;
      for (let i = 2; used.has(name); i++) name = `${safe(f.deliverable)} v${f.version} (${i})${ext}`;
      used.add(name);
      try {
        await zip.addFile(name, abs);
      } catch {
        await zip.addBuffer(`${name}.missing.txt`, Buffer.from('This file could not be read from storage. Ask your account manager for it.'));
      }
    }
    const lines = [
      `${v.client.name} · ${v.serviceName}`,
      `Handover pack generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      '',
      ...(v.links.length ? ['LINKS', ...v.links.map((l) => `- ${l.label}: ${l.url}`), ''] : []),
      ...(v.items.length ? ['LOGINS AND NOTES', ...v.items.map((i) => `- ${i.label}: ${i.value}`), ''] : []),
    ];
    await zip.addBuffer('Links, logins and notes.txt', Buffer.from(lines.join('\r\n'), 'utf8'));
    await zip.finish();
  }
}
