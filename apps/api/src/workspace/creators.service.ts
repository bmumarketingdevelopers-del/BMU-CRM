import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  fileKindFromMime,
  rupeesToPaise,
  type BriefDetail,
  type BriefOptions,
  type BriefRow,
  type BriefStatus,
  type CreateBrief,
  type CreatorPayouts,
  type CreatorProfile,
  type CreatorRate,
  type CreatorRow,
  type Me,
  type PayoutView,
  type UpdateCreatorProfile,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hasRole } from './util.js';

export type Upload = { path: string; originalname: string; mimetype: string; size: number };

const TDS_RATE = 0.1;
const briefInclude = { submissions: { orderBy: { number: 'asc' } } } satisfies Prisma.CreatorBriefInclude;
type BriefWithSubs = Prisma.CreatorBriefGetPayload<{ include: typeof briefInclude }>;

const parseRates = (raw: unknown): CreatorRate[] =>
  Array.isArray(raw) ? raw.filter((r): r is CreatorRate => typeof r?.label === 'string' && typeof r?.pricePaise === 'number') : [];

const toPayout = (p: Prisma.CreatorPayoutGetPayload<object>, title: string | null): PayoutView => ({
  id: p.id,
  briefId: p.briefId,
  briefTitle: title,
  amountPaise: p.amountPaise,
  tdsPaise: p.tdsPaise,
  netPaise: p.netPaise,
  status: p.status,
  paidAt: p.paidAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
});

/** Creator briefs, submissions and payouts: managed by the team, worked on in the creator portal. */
@Injectable()
export class CreatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Access

  isManager(me: Me) {
    return me.type === 'staff' && hasRole(me, 'founder', 'admin', 'am_lead', 'account_manager');
  }

  assertManager(me: Me) {
    if (!this.isManager(me)) throw new ForbiddenException('Only Founders, Branch Managers and Account Managers manage creators');
  }

  async creatorFor(me: Me) {
    if (me.type !== 'creator') throw new ForbiddenException('Creator accounts only');
    const c = await this.prisma.creator.findFirst({ where: { userId: me.id, orgId: me.orgId } });
    if (!c) throw new ForbiddenException('Your creator profile is not set up yet. Ask BMU to finish it.');
    return c;
  }

  private async managedBrief(me: Me, id: string) {
    this.assertManager(me);
    const b = await this.prisma.creatorBrief.findFirst({ where: { id, orgId: me.orgId }, include: briefInclude });
    if (!b) throw new NotFoundException('Brief not found');
    return b;
  }

  private async ownBrief(me: Me, id: string) {
    const c = await this.creatorFor(me);
    const b = await this.prisma.creatorBrief.findFirst({ where: { id, creatorId: c.id }, include: briefInclude });
    if (!b) throw new NotFoundException('Brief not found');
    return b;
  }

  // -------------------------------------------------------------------------
  // Views

  private async rows(briefs: (Prisma.CreatorBriefGetPayload<object> & { _count?: { submissions: number } })[]): Promise<BriefRow[]> {
    const creators = await this.prisma.creator.findMany({ where: { id: { in: [...new Set(briefs.map((b) => b.creatorId))] } }, include: { user: { select: { name: true } } } });
    const clients = await this.prisma.clientOrg.findMany({ where: { id: { in: briefs.map((b) => b.clientOrgId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return briefs.map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status as BriefStatus,
      feePaise: b.feePaise,
      dueAt: b.dueAt?.toISOString() ?? null,
      creator: { id: b.creatorId, name: creators.find((c) => c.id === b.creatorId)?.user.name ?? 'Creator' },
      client: clients.find((c) => c.id === b.clientOrgId) ?? null,
      submissions: b._count?.submissions ?? 0,
      updatedAt: b.updatedAt.toISOString(),
    }));
  }

  private async detail(b: BriefWithSubs, fileBase: string): Promise<BriefDetail> {
    const [row] = await this.rows([{ ...b, _count: { submissions: b.submissions.length } }]);
    const [engagement, createdBy, payout, files] = await Promise.all([
      b.engagementId ? this.prisma.engagement.findUnique({ where: { id: b.engagementId }, include: { service: { select: { name: true } } } }) : null,
      this.prisma.user.findUnique({ where: { id: b.createdById }, select: { name: true } }),
      this.prisma.creatorPayout.findUnique({ where: { briefId: b.id } }),
      this.prisma.file.findMany({ where: { id: { in: b.submissions.map((s) => s.fileId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    return {
      ...row,
      brief: b.brief,
      deliverables: b.deliverables,
      engagement: engagement ? { id: engagement.id, serviceName: engagement.service.name } : null,
      createdBy: createdBy?.name ?? null,
      createdAt: b.createdAt.toISOString(),
      submissionList: b.submissions.map((s) => ({
        id: s.id,
        number: s.number,
        url: s.url,
        fileUrl: s.fileId ? `${fileBase}/${s.id}/file` : null,
        fileName: files.find((f) => f.id === s.fileId)?.name ?? null,
        note: s.note,
        feedback: s.feedback,
        approved: s.approved,
        reviewedAt: s.reviewedAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
      payout: payout ? toPayout(payout, b.title) : null,
    };
  }

  private staffDetail = async (id: string) =>
    this.detail(await this.prisma.creatorBrief.findUniqueOrThrow({ where: { id }, include: briefInclude }), '/api/workspace/submissions');

  // -------------------------------------------------------------------------
  // Team side

  async creators(me: Me): Promise<CreatorRow[]> {
    this.assertManager(me);
    const rows = await this.prisma.creator.findMany({ where: { orgId: me.orgId, user: { deletedAt: null } }, include: { user: true }, orderBy: { user: { name: 'asc' } } });
    const [briefs, payouts] = await Promise.all([
      this.prisma.creatorBrief.findMany({ where: { orgId: me.orgId }, select: { creatorId: true, status: true } }),
      this.prisma.creatorPayout.findMany({ where: { orgId: me.orgId, status: { in: ['pending', 'on_hold'] } }, select: { creatorId: true, netPaise: true } }),
    ]);
    return rows.map((c) => ({
      id: c.id,
      userId: c.userId,
      name: c.user.name,
      email: c.user.email,
      phone: c.user.phone,
      niche: c.niche,
      rates: parseRates(c.rates),
      rating: c.rating,
      activeBriefs: briefs.filter((b) => b.creatorId === c.id && ['offered', 'accepted', 'submitted', 'revision'].includes(b.status)).length,
      approvedBriefs: briefs.filter((b) => b.creatorId === c.id && ['approved', 'paid'].includes(b.status)).length,
      pendingPayoutPaise: payouts.filter((p) => p.creatorId === c.id).reduce((s, p) => s + p.netPaise, 0),
    }));
  }

  async options(me: Me): Promise<BriefOptions> {
    this.assertManager(me);
    const seeAll = hasRole(me, 'founder', 'admin', 'am_lead');
    const [creators, clients] = await Promise.all([
      this.prisma.creator.findMany({ where: { orgId: me.orgId, user: { deletedAt: null, status: { not: 'suspended' } } }, include: { user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } } }),
      this.prisma.clientOrg.findMany({
        where: { orgId: me.orgId, deletedAt: null, ...(seeAll ? {} : { amUserId: me.id }) },
        include: { engagements: { where: { deletedAt: null }, include: { service: { select: { name: true } } } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      creators: creators.map((c) => ({ id: c.id, name: c.user.name, niche: c.niche })),
      clients: clients.map((c) => ({ id: c.id, name: c.name, engagements: c.engagements.map((e) => ({ id: e.id, serviceName: e.service.name })) })),
    };
  }

  async briefs(me: Me): Promise<BriefRow[]> {
    this.assertManager(me);
    const rows = await this.prisma.creatorBrief.findMany({ where: { orgId: me.orgId }, include: { _count: { select: { submissions: true } } }, orderBy: { updatedAt: 'desc' } });
    return this.rows(rows);
  }

  async brief(me: Me, id: string) {
    await this.managedBrief(me, id);
    return this.staffDetail(id);
  }

  async createBrief(me: Me, input: CreateBrief, ip?: string) {
    this.assertManager(me);
    const creator = await this.prisma.creator.findFirst({ where: { id: input.creatorId, orgId: me.orgId }, include: { user: true } });
    if (!creator || creator.user.status === 'suspended') throw new BadRequestException('Choose an active creator');
    if (input.clientOrgId) {
      const client = await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId, deletedAt: null } });
      if (!client) throw new BadRequestException('Unknown client');
      if (!hasRole(me, 'founder', 'admin', 'am_lead') && client.amUserId !== me.id) throw new ForbiddenException('You can only brief creators for your own clients');
    }
    if (input.engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, orgId: me.orgId, ...(input.clientOrgId ? { clientOrgId: input.clientOrgId } : {}) } });
      if (!e) throw new BadRequestException('That service does not belong to the chosen client');
    }
    const b = await this.prisma.creatorBrief.create({
      data: {
        orgId: me.orgId,
        creatorId: creator.id,
        clientOrgId: input.clientOrgId || null,
        engagementId: input.engagementId || null,
        title: input.title,
        brief: input.brief,
        deliverables: input.deliverables,
        dueAt: input.dueAt ? new Date(`${input.dueAt}T18:30:00+05:30`) : null,
        feePaise: rupeesToPaise(input.feeRupees),
        createdById: me.id,
      },
    });
    await this.audit.log(me, 'creator_brief.created', 'CreatorBrief', b.id, undefined, { creatorId: creator.id, title: b.title, feePaise: b.feePaise }, ip);
    await this.notify(me.orgId, creator.userId, 'creator_brief', `New brief from BMU: ${b.title}`, `/creator/briefs/${b.id}`);
    return this.staffDetail(b.id);
  }

  async feedback(me: Me, id: string, feedback: string, ip?: string) {
    const b = await this.managedBrief(me, id);
    const last = b.submissions.at(-1);
    if (b.status !== 'submitted' || !last) throw new BadRequestException('There is no submission waiting for review');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.creatorSubmission.update({ where: { id: last.id }, data: { feedback, approved: false, reviewedAt: now } }),
      this.prisma.creatorBrief.update({ where: { id }, data: { status: 'revision' } }),
    ]);
    await this.audit.log(me, 'creator_brief.revision_requested', 'CreatorBrief', id, { status: b.status }, { status: 'revision', submission: last.number, feedback }, ip);
    await this.notifyCreator(b.creatorId, me.orgId, `Changes requested on ${b.title}`, `/creator/briefs/${id}`, feedback);
    return this.staffDetail(id);
  }

  /** Approving the latest submission books the creator's payout once (fee less 10% TDS). */
  async approve(me: Me, id: string, ip?: string) {
    const b = await this.managedBrief(me, id);
    const last = b.submissions.at(-1);
    if (b.status !== 'submitted' || !last) throw new BadRequestException('There is no submission waiting for approval');
    const now = new Date();
    const tds = Math.round(b.feePaise * TDS_RATE);
    await this.prisma.$transaction(async (tx) => {
      await tx.creatorSubmission.update({ where: { id: last.id }, data: { approved: true, reviewedAt: now } });
      await tx.creatorBrief.update({ where: { id }, data: { status: 'approved' } });
      if (!(await tx.creatorPayout.findUnique({ where: { briefId: id } }))) {
        await tx.creatorPayout.create({ data: { orgId: b.orgId, creatorId: b.creatorId, briefId: id, amountPaise: b.feePaise, tdsPaise: tds, netPaise: b.feePaise - tds } });
      }
    });
    await this.audit.log(me, 'creator_brief.approved', 'CreatorBrief', id, { status: b.status }, { status: 'approved', submission: last.number, payoutPaise: b.feePaise - tds }, ip);
    await this.notifyCreator(b.creatorId, me.orgId, `${b.title} is approved. Your payout is booked.`, '/creator/payouts');
    return this.staffDetail(id);
  }

  async cancel(me: Me, id: string, ip?: string) {
    const b = await this.managedBrief(me, id);
    if (!['offered', 'accepted', 'submitted', 'revision'].includes(b.status)) throw new BadRequestException('This brief can no longer be cancelled');
    await this.prisma.creatorBrief.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log(me, 'creator_brief.cancelled', 'CreatorBrief', id, { status: b.status }, { status: 'cancelled' }, ip);
    await this.notifyCreator(b.creatorId, me.orgId, `BMU cancelled the brief ${b.title}`, `/creator/briefs/${id}`);
    return this.staffDetail(id);
  }

  async staffSubmit(me: Me, id: string, src: { file?: Upload; url?: string; note?: string }, storageRoot: string, ip?: string) {
    const b = await this.managedBrief(me, id);
    await this.addSubmission(me, b, src, storageRoot, ip);
    return this.staffDetail(id);
  }

  // -------------------------------------------------------------------------
  // Creator portal

  async myBriefs(me: Me): Promise<BriefRow[]> {
    const c = await this.creatorFor(me);
    const rows = await this.prisma.creatorBrief.findMany({ where: { creatorId: c.id }, include: { _count: { select: { submissions: true } } }, orderBy: { updatedAt: 'desc' } });
    return this.rows(rows);
  }

  async myBrief(me: Me, id: string) {
    return this.detail(await this.ownBrief(me, id), '/api/workspace/submissions');
  }

  async respond(me: Me, id: string, accept: boolean, ip?: string) {
    const b = await this.ownBrief(me, id);
    if (b.status !== 'offered') throw new BadRequestException('You have already responded to this brief');
    const status = accept ? 'accepted' : 'declined';
    await this.prisma.creatorBrief.update({ where: { id }, data: { status } });
    await this.audit.log(me, `creator_brief.${status}`, 'CreatorBrief', id, { status: 'offered' }, { status }, ip);
    await this.notify(me.orgId, b.createdById, 'creator_brief', `${me.name} ${status} the brief ${b.title}`, `/team/creators/briefs/${id}`);
    return this.myBrief(me, id);
  }

  async creatorSubmit(me: Me, id: string, src: { file?: Upload; url?: string; note?: string }, storageRoot: string, ip?: string) {
    const b = await this.ownBrief(me, id);
    await this.addSubmission(me, b, src, storageRoot, ip);
    return this.myBrief(me, id);
  }

  private async addSubmission(me: Me, b: BriefWithSubs, src: { file?: Upload; url?: string; note?: string }, storageRoot: string, ip?: string) {
    if (!['accepted', 'revision'].includes(b.status)) {
      throw new BadRequestException(b.status === 'offered' ? 'Accept the brief before sending work' : b.status === 'submitted' ? 'Your last submission is waiting for review' : 'This brief is closed');
    }
    let fileId: string | null = null;
    if (src.file) {
      const file = src.file;
      const checksum = await new Promise<string>((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(file.path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      const f = await this.prisma.file.create({
        data: { orgId: b.orgId, path: file.path.slice(storageRoot.length + 1), kind: fileKindFromMime(file.mimetype), name: file.originalname, mimeType: file.mimetype, sizeBytes: file.size, checksum },
      });
      fileId = f.id;
    } else if (!src.url) throw new BadRequestException('Attach a file or paste a link');
    const number = (b.submissions.at(-1)?.number ?? 0) + 1;
    await this.prisma.$transaction([
      this.prisma.creatorSubmission.create({ data: { orgId: b.orgId, briefId: b.id, number, fileId, url: src.file ? null : src.url, note: src.note || null } }),
      this.prisma.creatorBrief.update({ where: { id: b.id }, data: { status: 'submitted' } }),
    ]);
    await this.audit.log(me, 'creator_brief.submitted', 'CreatorBrief', b.id, { status: b.status }, { status: 'submitted', number, kind: src.file ? 'file' : 'link' }, ip);
    if (me.type === 'creator') await this.notify(b.orgId, b.createdById, 'creator_submission', `${me.name} sent version ${number} of ${b.title}`, `/team/creators/briefs/${b.id}`);
  }

  async payouts(me: Me): Promise<CreatorPayouts> {
    const c = await this.creatorFor(me);
    const rows = await this.prisma.creatorPayout.findMany({ where: { creatorId: c.id }, orderBy: { createdAt: 'desc' } });
    const titles = await this.prisma.creatorBrief.findMany({ where: { id: { in: rows.map((p) => p.briefId).filter((x): x is string => !!x) } }, select: { id: true, title: true } });
    return {
      totals: {
        pendingPaise: rows.filter((p) => p.status !== 'paid').reduce((s, p) => s + p.netPaise, 0),
        paidPaise: rows.filter((p) => p.status === 'paid').reduce((s, p) => s + p.netPaise, 0),
        tdsPaise: rows.reduce((s, p) => s + p.tdsPaise, 0),
      },
      items: rows.map((p) => toPayout(p, titles.find((t) => t.id === p.briefId)?.title ?? null)),
    };
  }

  async profile(me: Me): Promise<CreatorProfile> {
    const c = await this.creatorFor(me);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    return { name: user.name, email: user.email, phone: user.phone, niche: c.niche, rates: parseRates(c.rates), rating: c.rating };
  }

  async saveProfile(me: Me, input: UpdateCreatorProfile, ip?: string) {
    const c = await this.creatorFor(me);
    await this.prisma.creator.update({ where: { id: c.id }, data: { niche: input.niche, rates: input.rates } });
    await this.audit.log(me, 'creator.profile_updated', 'Creator', c.id, { niche: c.niche, rates: c.rates }, input, ip);
    return this.profile(me);
  }

  /** The stored file of a submission, for the creator who sent it or a creator manager. */
  async submissionFile(me: Me, submissionId: string) {
    const s = await this.prisma.creatorSubmission.findFirst({ where: { id: submissionId, orgId: me.orgId }, include: { brief: true } });
    if (!s || !s.fileId) throw new NotFoundException('File not found');
    if (me.type === 'creator') {
      const c = await this.creatorFor(me);
      if (s.brief.creatorId !== c.id) throw new NotFoundException('File not found');
    } else this.assertManager(me);
    return this.prisma.file.findUniqueOrThrow({ where: { id: s.fileId } });
  }

  // -------------------------------------------------------------------------

  private async notify(orgId: string, userId: string | null | undefined, kind: string, title: string, link: string, body?: string) {
    if (!userId) return;
    await this.prisma.notification.create({ data: { orgId, userId, kind, title, body, link } });
  }

  private async notifyCreator(creatorId: string, orgId: string, title: string, link: string, body?: string) {
    const c = await this.prisma.creator.findUnique({ where: { id: creatorId }, select: { userId: true } });
    await this.notify(orgId, c?.userId, 'creator_brief', title, link, body);
  }
}
