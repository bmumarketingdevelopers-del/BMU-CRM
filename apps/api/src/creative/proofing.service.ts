// v16 proofing: each version's round (internal check, then the client), open comments carried to the next version,
// sealed approval certificates, and one-tap approval links for email and WhatsApp.
import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { deliverApprovalModeLabels, proofDecisionSchema, type ApprovalCertificateView, type FileKind, type Me, type ProofLinkView, type ProofRoundView } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { MeService } from '../auth/me.service.js';
import { parse } from '../common/zod.js';
import { asApprovalMode, clientDecidersOf } from '../deliver/approval-policy.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { appUrl } from '../service/email.service.js';
import { ProductionService } from '../production/production.service.js';
import { WhatsAppSender } from '../comms/whatsapp.sender.js';

const DAY = 86_400_000;
const LINK_DAYS = 14;
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
/** Stable JSON (sorted keys) so the certificate hash only changes when the content does. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);
const sealOf = (data: unknown) => createHash('sha256').update(canonical(data)).digest('hex');

type Db = Pick<PrismaService, 'comment' | 'qCResult' | 'approval' | 'user' | 'auditEvent'>;
type VersionLite = { id: string; number: number; uploadedById: string; createdAt: Date; sentToClientAt: Date | null };

/**
 * Open comments on the previous version are copied to the new one (marked "carried over from vN"), so nothing the
 * client or QC asked for gets lost between rounds. Runs inside the version upload transaction.
 */
export async function carryOpenComments(tx: Pick<Prisma.TransactionClient, 'comment'>, fromVersionId: string, toVersionId: string) {
  const open = await tx.comment.findMany({ where: { targetType: 'version', targetId: fromVersionId, resolvedAt: null }, orderBy: { createdAt: 'asc' } });
  if (!open.length) return 0;
  await tx.comment.createMany({
    data: open.map((c) => ({ orgId: c.orgId, targetType: 'version', targetId: toVersionId, timestampOrPin: c.timestampOrPin, body: c.body, isInternal: c.isInternal, authorId: c.authorId, carriedFromId: c.carriedFromId ?? c.id })),
  });
  return open.length;
}

/** One row per version: who made it, the internal check, when it went to the client and what they decided. */
export async function proofRounds(db: Db, d: { id: string; status: string; approvedVersionId: string | null; versions: VersionLite[] }, client: boolean): Promise<ProofRoundView[]> {
  const versions = client ? d.versions.filter((v) => v.sentToClientAt) : d.versions;
  if (!versions.length) return [];
  const ids = versions.map((v) => v.id);
  const [comments, qcs, votes, changes] = await Promise.all([
    db.comment.findMany({ where: { targetType: 'version', targetId: { in: ids }, ...(client ? { isInternal: false } : {}) }, select: { targetId: true, resolvedAt: true, carriedFromId: true } }),
    db.qCResult.findMany({ where: { versionId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { versionId: true, result: true, reviewerId: true, createdAt: true } }),
    db.approval.findMany({ where: { targetType: { in: ['deliverable', 'deliverable_vote'] }, targetId: d.id, versionId: { in: ids } }, orderBy: { at: 'asc' } }),
    db.auditEvent.findMany({ where: { entity: 'Deliverable', entityId: d.id, action: 'deliverable.changes_requested' }, orderBy: { at: 'asc' }, select: { actorId: true, at: true } }),
  ]);
  const users = await db.user.findMany({ where: { id: { in: [...new Set([...versions.map((v) => v.uploadedById), ...qcs.map((q) => q.reviewerId), ...votes.map((v) => v.userId), ...changes.map((c) => c.actorId).filter((x): x is string => !!x)])] } }, select: { id: true, name: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? 'Someone';
  const all = d.versions;
  return versions.map((v) => {
    const qc = qcs.filter((q) => q.versionId === v.id).at(-1);
    const next = all.find((x) => x.number > v.number);
    const final = votes.find((x) => x.versionId === v.id && x.targetType === 'deliverable');
    const lastVote = votes.filter((x) => x.versionId === v.id).at(-1);
    const change = v.sentToClientAt ? changes.find((c) => c.at >= v.sentToClientAt! && (!next || c.at <= next.createdAt)) : undefined;
    const mine = comments.filter((c) => c.targetId === v.id);
    return {
      versionId: v.id,
      number: v.number,
      uploadedBy: client ? 'BMU team' : name(v.uploadedById),
      uploadedAt: v.createdAt.toISOString(),
      internal: qc ? { result: qc.result as 'pass' | 'fail', by: client ? null : name(qc.reviewerId), at: qc.createdAt.toISOString() } : null,
      sentAt: v.sentToClientAt?.toISOString() ?? null,
      client: final
        ? { decision: 'approved', by: name(final.userId), at: final.at.toISOString(), via: final.via ?? lastVote?.via ?? null }
        : change
          ? { decision: 'changes_requested', by: name(change.actorId), at: change.at.toISOString(), via: null }
          : null,
      comments: mine.length,
      openComments: mine.filter((c) => !c.resolvedAt).length,
      carriedOver: mine.filter((c) => c.carriedFromId).length,
    };
  });
}

@Injectable()
export class ProofingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly meService: MeService,
    private readonly ref: ModuleRef,
  ) {}

  private production() {
    return this.ref.get(ProductionService, { strict: false });
  }

  // ------------------------------------------------------------------------------------------------ certificates

  /** Seals the final approval of a version. Idempotent (one certificate per version). */
  async issueCertificate(deliverableId: string, versionId: string) {
    const existing = await this.prisma.approvalCertificate.findUnique({ where: { versionId } });
    if (existing) return existing;
    const d = await this.prisma.deliverable.findUnique({
      where: { id: deliverableId },
      include: { cycle: { select: { engagement: { select: { clientOrgId: true, clientOrg: { select: { name: true, approvalMode: true } }, service: { select: { name: true } } } } } }, versions: { include: { file: true, qcResults: true } } },
    });
    const v = d?.versions.find((x) => x.id === versionId);
    if (!d || !v) return null;
    const votes = await this.prisma.approval.findMany({ where: { targetType: { in: ['deliverable_vote', 'deliverable'] }, targetId: d.id, versionId }, orderBy: { at: 'asc' } });
    const qc = [...v.qcResults].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).filter((q) => q.result === 'pass').at(-1);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...votes.map((x) => x.userId), ...(qc ? [qc.reviewerId] : [])] } }, select: { id: true, name: true, email: true } });
    const byUser = new Map<string, (typeof votes)[number]>();
    for (const x of votes) if (!byUser.has(x.userId) || x.targetType === 'deliverable_vote') byUser.set(x.userId, x);
    const comments = await this.prisma.comment.count({ where: { targetType: 'version', targetId: { in: d.versions.map((x) => x.id) }, isInternal: false, carriedFromId: null } });
    const data = {
      deliverable: { id: d.id, title: d.title, type: d.type },
      client: d.cycle.engagement.clientOrg.name,
      service: d.cycle.engagement.service.name,
      version: { number: v.number, name: v.file.name, checksum: v.file.checksum, sizeBytes: v.file.sizeBytes, uploadedAt: v.createdAt.toISOString() },
      internal: qc ? { by: users.find((u) => u.id === qc.reviewerId)?.name ?? 'QC', at: qc.createdAt.toISOString() } : null,
      approvals: [...byUser.values()].map((x) => {
        const u = users.find((y) => y.id === x.userId);
        return { name: u?.name ?? 'Client', email: u?.email ?? null, at: x.at.toISOString(), via: x.via ?? (x.migrated ? 'migrated' : 'portal'), ip: x.ip ?? null };
      }),
      rule: deliverApprovalModeLabels[asApprovalMode(d.cycle.engagement.clientOrg.approvalMode)].label,
      rounds: d.revisionRoundsUsed + 1,
      comments,
    };
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const code = `BMU-${stamp}-${randomBytes(4).toString('hex').toUpperCase()}`;
    return this.prisma.approvalCertificate.create({ data: { orgId: d.orgId, code, deliverableId: d.id, versionId, data: data as Prisma.InputJsonValue, hash: sealOf(data) } });
  }

  private async certificateView(deliverableId: string): Promise<ApprovalCertificateView> {
    const c = await this.prisma.approvalCertificate.findFirst({ where: { deliverableId }, orderBy: { createdAt: 'desc' } });
    if (!c) throw new NotFoundException('No approval certificate yet. It is created when the client approves.');
    const data = c.data as Omit<ApprovalCertificateView, 'id' | 'code' | 'hash' | 'valid' | 'issuedAt'>;
    // Valid while the stored content still matches its seal and the approved file is unchanged.
    const v = await this.prisma.version.findUnique({ where: { id: c.versionId }, include: { file: { select: { checksum: true } } } });
    const valid = sealOf(data) === c.hash && (v?.file.checksum ?? null) === (data.version.checksum ?? null);
    return { ...data, id: c.id, code: c.code, hash: c.hash, valid, issuedAt: c.createdAt.toISOString() };
  }

  async certificate(me: Me, deliverableId: string) {
    await this.production().deliverable(me, deliverableId); // access check
    return this.certificateView(deliverableId);
  }

  async clientCertificate(me: Me, deliverableId: string) {
    await this.production().clientDeliverable(me, deliverableId); // access check
    return this.certificateView(deliverableId);
  }

  // ------------------------------------------------------------------------------------------------ one-tap links

  /** A link for one approver and one version. Only its hash is stored. Returns the page path. */
  async createLink(orgId: string, versionId: string, userId: string, channel: 'email' | 'whatsapp' = 'email') {
    const token = randomBytes(24).toString('base64url');
    await this.prisma.proofLink.create({ data: { orgId, tokenHash: tokenHash(token), versionId, userId, channel, expiresAt: new Date(Date.now() + LINK_DAYS * DAY) } });
    return `/proof/${token}`;
  }

  private async link(token: string) {
    const l = await this.prisma.proofLink.findUnique({ where: { tokenHash: tokenHash(token) } });
    if (!l) throw new NotFoundException('This link does not exist. Open the review from your BMU Hub account instead.');
    if (l.expiresAt < new Date()) throw new GoneException('This link has expired. Open the review from your BMU Hub account instead.');
    const v = await this.prisma.version.findUnique({ where: { id: l.versionId }, include: { file: true, deliverable: { include: { versions: { select: { id: true, number: true } }, cycle: { select: { engagement: { select: { clientOrgId: true, billingType: true, status: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } } } } } } } });
    if (!v) throw new GoneException('This version is no longer available');
    const user = await this.prisma.user.findFirst({ where: { id: l.userId, deletedAt: null, status: { not: 'suspended' } }, select: { id: true, name: true } });
    if (!user) throw new ForbiddenException('Your account can no longer approve work. Ask your BMU Client Manager.');
    return { l, v, d: v.deliverable, user };
  }

  private async viewOf(token: string, message: string | null = null): Promise<ProofLinkView> {
    const { v, d, user } = await this.link(token);
    const latest = d.versions.reduce((m, x) => (x.number > m.number ? x : m), d.versions[0]);
    const voted = await this.prisma.approval.findFirst({ where: { targetType: 'deliverable_vote', targetId: d.id, versionId: v.id, userId: user.id } });
    const status: ProofLinkView['status'] =
      d.approvedVersionId === v.id || voted ? 'approved' : latest.id !== v.id || d.status !== 'ready_for_client' ? (d.status === 'changes_requested' && latest.id === v.id ? 'changes_requested' : 'closed') : 'waiting';
    const open = await this.prisma.comment.count({ where: { targetType: 'version', targetId: v.id, isInternal: false, resolvedAt: null } });
    return {
      title: d.title,
      client: d.cycle.engagement.clientOrg.name,
      service: d.cycle.engagement.service.name,
      forName: user.name,
      version: { number: v.number, kind: v.file.kind as FileKind, name: v.file.name, url: v.file.kind === 'link' ? v.file.path : `/api/public/proof/${token}/file`, note: v.note },
      openComments: open,
      // v37: a one-time project before the final payment: watermarked preview; videos with an on-screen mark.
      preview: !v.file.released && d.cycle.engagement.billingType === 'one_time' && d.cycle.engagement.status !== 'delivered',
      status,
      message: message ?? (status === 'approved' ? (d.approvedVersionId === v.id ? 'Approved. Thank you!' : 'You approved this version. Waiting for the other approvers.') : status === 'closed' ? 'A newer version replaced this one. Open the review from your BMU Hub account.' : status === 'changes_requested' ? 'Changes were requested. The team is working on the next version.' : null),
    };
  }

  async publicView(token: string) {
    return this.viewOf(token);
  }

  async publicFile(token: string) {
    const { v } = await this.link(token);
    return v.file;
  }

  /** v37: same preview rule as the client app (one-time project, not yet released). */
  async needsPreview(file: { id: string }) {
    const full = await this.prisma.file.findUniqueOrThrow({ where: { id: file.id }, include: { versions: { include: { deliverable: { include: { cycle: { select: { engagementId: true } } } } } } } });
    return this.production().needsPreview(full);
  }

  async decide(token: string, body: unknown, ip?: string) {
    const input = parse(proofDecisionSchema, body);
    const { l, v, d, user } = await this.link(token);
    if (d.status !== 'ready_for_client' || d.versions.some((x) => x.number > v.number)) throw new BadRequestException('This version is no longer waiting for a decision');
    const me = await this.meService.load(user.id);
    if (!me || me.type !== 'client') throw new ForbiddenException('Only client approvers can use this link');
    const via = l.channel === 'whatsapp' ? 'whatsapp' : 'email';
    if (input.decision === 'approve') await this.production().clientApprove(me, d.id, v.id, ip, via);
    else {
      if (!input.comment) throw new BadRequestException('Tell the team what to change');
      await this.production().clientRequestChanges(me, d.id, input.comment, ip, via);
    }
    await this.prisma.proofLink.update({ where: { id: l.id }, data: { usedAt: new Date() } });
    return this.viewOf(token, input.decision === 'approve' ? null : 'Thanks. Your changes went to the team.');
  }

  /** Sends each approver their own review email with one-tap buttons (and a WhatsApp message when they have a phone). */
  async sendReviewLinks(d: { id: string; orgId: string; title: string; clientOrgId: string }, v: { id: string; number: number }) {
    const deciders = await clientDecidersOf(this.prisma, d.clientOrgId);
    const users = await this.prisma.user.findMany({ where: { id: { in: deciders.map((p) => p.userId) } }, select: { id: true, name: true, phone: true } });
    for (const u of users) {
      const path = await this.createLink(d.orgId, v.id, u.id);
      await this.notifications.notify(d.orgId, [u.id], {
        kind: 'draft_ready',
        title: `${d.title} v${v.number} is ready for your review`,
        body: 'Approve it in one tap, or leave comments on the exact spot that should change.',
        link: `/client/reviews/${d.id}`,
        critical: true,
        forceEmail: true,
        email: {
          subject: `Please review: ${d.title} (v${v.number})`,
          paragraphs: [`Hi ${u.name.split(' ')[0]},`, `${d.title} (version ${v.number}) is ready for you.`, 'Open it to look, then approve in one tap or tell us what to change. The link works for 14 days.'],
          button: { label: 'Review and approve', url: path },
          entity: 'Deliverable',
          entityId: d.id,
        },
      });
      if (u.phone) {
        const waPath = await this.createLink(d.orgId, v.id, u.id, 'whatsapp');
        // v17: sent for real when WhatsApp is connected; otherwise it waits in the WhatsApp queue.
        await new WhatsAppSender(this.prisma).send({ orgId: d.orgId, toPhone: u.phone, toName: u.name, body: `BMU: ${d.title} v${v.number} is ready for your review. Approve or ask for changes here: ${appUrl(waPath)}`, entity: 'Deliverable', entityId: d.id, source: 'proofing' });
      }
    }
  }
}
