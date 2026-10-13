// v11 ops: creator actions. Add creator (duplicate check on phone / handle), edit, CSV import, archive, the
// `creator_brief` reassign target (move a brief to another creator) and rating a creator after delivery.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  opsCanManageCreators,
  opsCreatorCreateSchema,
  opsCreatorEditSchema,
  opsCreatorRatingSchema,
  type Me,
  type OpsCreatorDetail,
  type OpsCreatorRow,
  type OpsDuplicateMatch,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { lc, phoneDigits } from './ops-util.js';

type Rate = { label: string; pricePaise: number };
const parseRates = (raw: unknown): Rate[] => (Array.isArray(raw) ? raw.filter((r): r is Rate => typeof r?.label === 'string' && typeof r?.pricePaise === 'number') : []);
const ACTIVE = ['offered', 'accepted', 'submitted', 'revision'];
const DONE = ['approved', 'paid'];
const creatorInclude = { user: { select: { id: true, name: true, email: true, phone: true, status: true, deletedAt: true } } } as const;
type CreatorFull = Prisma.CreatorGetPayload<{ include: typeof creatorInclude }>;

@Injectable()
export class OpsCreatorsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
  ) {}

  onModuleInit() {
    this.registry.registerArchiveEntity({
      entity: 'creator',
      model: 'creator',
      auditEntity: 'Creator',
      assertCan: async (me, id) => {
        this.assertManager(me);
        await this.load(me, id);
      },
      beforeArchive: async (me, id) => {
        const open = await this.prisma.creatorBrief.count({ where: { orgId: me.orgId, creatorId: id, status: { in: ACTIVE as never } } });
        if (open) throw new BadRequestException(`This creator has ${open} open brief${open === 1 ? '' : 's'}. Move or cancel them first.`);
      },
    });

    this.registry.registerImportEntity({
      entity: 'creators',
      label: 'Creators',
      fields: [
        { key: 'name', label: 'Name', required: true },
        { key: 'phone', label: 'Mobile', required: true, hint: '10-digit Indian mobile' },
        { key: 'handle', label: 'Handle', required: true, hint: 'Instagram or YouTube handle' },
        { key: 'city', label: 'City', required: true },
        { key: 'niche', label: 'Niche', required: true, hint: 'Separate with ;' },
        { key: 'rate', label: 'Rate per reel (₹)', required: true },
        { key: 'email', label: 'Email', required: false },
      ],
      sampleCsv: 'Name,Mobile,Handle,City,Niche,Rate per reel (₹),Email\nAisha Khan,9876500011,@aisha.eats,Bengaluru,food;lifestyle,4000,aisha@example.com\n',
      canImport: (me) => opsCanManageCreators(me),
      validate: (me, rows) => this.validateImport(me, rows),
      commit: async (me, rows, ip) => {
        const ids: string[] = [];
        for (const r of rows) {
          const res = await this.create(me, this.importInput(r), ip);
          ids.push(res.id);
        }
        return ids;
      },
    });

    this.registry.registerReassignTarget({
      type: 'creator_brief',
      label: 'Creator brief',
      auditEntity: 'CreatorBrief',
      href: (i) => `/team/creators/briefs/${i.id}`,
      load: async (me, ids) => {
        this.assertManager(me);
        const rows = await this.prisma.creatorBrief.findMany({ where: { orgId: me.orgId, id: { in: ids } } });
        if (rows.length !== new Set(ids).size) throw new NotFoundException('Brief not found');
        const creators = await this.prisma.creator.findMany({ where: { id: { in: rows.map((b) => b.creatorId) } }, select: { id: true, userId: true } });
        return rows.map((b) => {
          if (!['offered', 'accepted', 'revision'].includes(b.status)) throw new BadRequestException(`"${b.title}" is ${b.status} and can't move to another creator`);
          return {
            id: b.id,
            title: b.title,
            ownerId: creators.find((c) => c.id === b.creatorId)?.userId ?? null,
            deadline: b.dueAt,
            status: b.status,
            inProgress: b.status !== 'offered',
            clientDueAt: b.dueAt,
            clientOrgId: b.clientOrgId,
            hours: 4,
            href: `/team/creators/briefs/${b.id}`,
          };
        });
      },
      assertCanReassign: async (me) => this.assertManager(me),
      eligibility: async () => ({ userTypes: ['creator'], where: { creator: { is: { archivedAt: null } } } }),
      snapshot: async (items) => {
        const rows = await this.prisma.creatorBrief.findMany({ where: { id: { in: items.map((i) => i.id) } }, select: { id: true, creatorId: true, status: true, dueAt: true } });
        return rows.map((b) => ({ model: 'creatorBrief', id: b.id, data: { creatorId: b.creatorId, status: b.status, dueAt: b.dueAt?.toISOString() ?? null } }));
      },
      apply: async (me, items, { to, deadlines }) => {
        const creator = await this.prisma.creator.findFirst({ where: { orgId: me.orgId, userId: to.id } });
        if (!creator) throw new BadRequestException(`${to.name} is not a creator`);
        if (creator.archivedAt) throw new BadRequestException(`${to.name} is archived`);
        for (const i of items) {
          const d = deadlines.get(i.id);
          // The new creator has to accept the brief again.
          await this.prisma.creatorBrief.update({ where: { id: i.id }, data: { creatorId: creator.id, status: 'offered', ...(d !== undefined ? { dueAt: d } : {}) } });
          await this.notifications.notify(me.orgId, [to.id], { kind: 'creator_brief', title: `New brief from BMU: ${i.title}`, body: 'Open it to accept or decline.', link: `/creator/briefs/${i.id}` });
        }
      },
      openWorkOf: async (orgId, userId) => {
        const c = await this.prisma.creator.findFirst({ where: { orgId, userId } });
        if (!c) return [];
        const rows = await this.prisma.creatorBrief.findMany({ where: { orgId, creatorId: c.id, status: { in: ['offered', 'accepted', 'revision'] } } });
        return rows.map((b) => ({ id: b.id, title: b.title, deadline: b.dueAt, status: b.status, client: null }));
      },
    });
    this.registry.registerUndoModel('creatorBrief');
  }

  private assertManager(me: Me) {
    if (!opsCanManageCreators(me)) throw new ForbiddenException('Only the UGC coordinator (Founder, Branch Manager, Account Managers, Department Heads) manages creators');
  }

  private async load(me: Me, id: string) {
    const c = await this.prisma.creator.findFirst({ where: { id, orgId: me.orgId, user: { deletedAt: null } }, include: creatorInclude });
    if (!c) throw new NotFoundException('Creator not found');
    return c;
  }

  // -------------------------------------------------------------------------
  // Views

  private async toRows(rows: CreatorFull[]): Promise<OpsCreatorRow[]> {
    const ids = rows.map((c) => c.id);
    const [briefs, payouts] = await Promise.all([
      this.prisma.creatorBrief.findMany({ where: { creatorId: { in: ids } }, select: { creatorId: true, status: true } }),
      this.prisma.creatorPayout.findMany({ where: { creatorId: { in: ids }, status: { in: ['pending', 'on_hold'] } }, select: { creatorId: true, netPaise: true } }),
    ]);
    return rows.map((c) => ({
      id: c.id,
      userId: c.userId,
      name: c.user.name,
      email: c.user.email,
      phone: c.user.phone,
      handle: c.handle,
      city: c.city,
      niche: c.niche,
      rates: parseRates(c.rates),
      rating: c.rating === null ? null : Math.round(c.rating * 10) / 10,
      ratingCount: c.ratingCount,
      activeBriefs: briefs.filter((b) => b.creatorId === c.id && ACTIVE.includes(b.status)).length,
      approvedBriefs: briefs.filter((b) => b.creatorId === c.id && DONE.includes(b.status)).length,
      pendingPayoutPaise: payouts.filter((p) => p.creatorId === c.id).reduce((s, p) => s + p.netPaise, 0),
      archivedAt: c.archivedAt?.toISOString() ?? null,
      archivedReason: c.archivedReason,
    }));
  }

  async list(me: Me, archived = false): Promise<OpsCreatorRow[]> {
    this.assertManager(me);
    const rows = await this.prisma.creator.findMany({
      where: { orgId: me.orgId, user: { deletedAt: null }, archivedAt: archived ? { not: null } : null },
      include: creatorInclude,
      orderBy: { user: { name: 'asc' } },
    });
    return this.toRows(rows);
  }

  async detail(me: Me, id: string): Promise<OpsCreatorDetail> {
    this.assertManager(me);
    const c = await this.load(me, id);
    const [row] = await this.toRows([c]);
    const [briefs, ratings] = await Promise.all([
      this.prisma.creatorBrief.findMany({ where: { creatorId: c.id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.opsCreatorRating.findMany({ where: { creatorId: c.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const [clients, users] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: briefs.map((b) => b.clientOrgId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: ratings.map((r) => r.byId) } }, select: { id: true, name: true } }),
    ]);
    return {
      ...row,
      briefs: briefs.map((b) => ({ id: b.id, title: b.title, status: b.status, feePaise: b.feePaise, client: clients.find((x) => x.id === b.clientOrgId)?.name ?? null, rated: ratings.some((r) => r.briefId === b.id) })),
      ratings: ratings.map((r) => ({ id: r.id, score: r.score, note: r.note, brief: briefs.find((b) => b.id === r.briefId)?.title ?? 'Brief', by: users.find((u) => u.id === r.byId)?.name ?? 'Team', at: r.createdAt.toISOString() })),
    };
  }

  // -------------------------------------------------------------------------
  // Duplicates

  async duplicates(me: Me, q: { phone?: string; handle?: string; email?: string; excludeId?: string }): Promise<OpsDuplicateMatch[]> {
    this.assertManager(me);
    const phone = phoneDigits(q.phone);
    const handle = lc(q.handle).replace(/^@+/, '');
    const email = lc(q.email);
    if (!phone && !handle && !email) return [];
    const or: Prisma.CreatorWhereInput[] = [];
    if (phone) or.push({ user: { phone: { endsWith: phone } } });
    if (handle) or.push({ handle: { equals: handle, mode: 'insensitive' } });
    if (email) or.push({ user: { email: { equals: email, mode: 'insensitive' } } });
    const rows = await this.prisma.creator.findMany({ where: { orgId: me.orgId, OR: or, ...(q.excludeId ? { id: { not: q.excludeId } } : {}) }, include: creatorInclude, take: 5 });
    const out: OpsDuplicateMatch[] = rows.map((c) => ({
      id: c.id,
      name: `${c.user.name}${c.handle ? ` (@${c.handle})` : ''}`,
      stage: c.archivedAt ? 'archived' : 'active',
      owner: null,
      matchedOn: [...(phone && phoneDigits(c.user.phone) === phone ? (['phone'] as const) : []), ...(email && lc(c.user.email) === email ? (['email'] as const) : []), ...(handle && lc(c.handle) === handle ? (['name'] as const) : [])],
      href: `/team/creators/${c.id}`,
    }));
    // A staff or client login with the same mobile can't become a creator (one login per mobile).
    if (phone) {
      const other = await this.prisma.user.findFirst({ where: { orgId: me.orgId, phone: { endsWith: phone }, type: { not: 'creator' } }, select: { id: true, name: true, type: true } });
      if (other) out.push({ id: other.id, name: `${other.name} (${other.type} account)`, stage: 'other_account', owner: null, matchedOn: ['phone'], href: null });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Create / edit

  async create(me: Me, body: unknown, ip?: string) {
    this.assertManager(me);
    const input = parse(opsCreatorCreateSchema, body);
    const phone = phoneDigits(input.phone);
    const dups = await this.duplicates(me, { phone, handle: input.handle, email: input.email || undefined });
    // Same mobile or email can never be reused (it is the login); same handle is a warning the person can override.
    const hard = dups.filter((d) => d.matchedOn.includes('phone') || d.matchedOn.includes('email'));
    if (hard.length) throw new ConflictException({ message: `${hard[0].name} already uses this ${hard[0].matchedOn.includes('phone') ? 'mobile number' : 'email'}. Open that profile instead.`, duplicates: hard });
    if (dups.length && !input.confirmDuplicate) throw new ConflictException({ message: 'A creator with this handle already exists. Check before adding another.', duplicates: dups });
    const c = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { orgId: me.orgId, type: 'creator', name: input.name, phone: `+91${phone}`, email: input.email ? lc(input.email) : null, status: 'active' } });
      return tx.creator.create({ data: { orgId: me.orgId, userId: user.id, niche: input.niche, rates: input.rates, handle: input.handle, city: input.city } });
    });
    await this.audit.log(me, 'creator.created', 'Creator', c.id, undefined, { name: input.name, handle: input.handle, city: input.city, niche: input.niche }, ip);
    await this.notifications.notify(me.orgId, [c.userId], { kind: 'creator_welcome', title: 'Welcome to BMU creators', body: 'Sign in with your mobile number to see briefs and payouts.', link: '/creator/briefs' });
    return { id: c.id, message: `${input.name} added. They can sign in with their mobile number.` };
  }

  async edit(me: Me, id: string, body: unknown, ip?: string) {
    this.assertManager(me);
    const input = parse(opsCreatorEditSchema, body);
    const c = await this.load(me, id);
    const phone = input.phone ? phoneDigits(input.phone) : undefined;
    if (phone || input.handle || input.email) {
      const dups = (await this.duplicates(me, { phone, handle: input.handle, email: input.email || undefined, excludeId: id })).filter((d) => d.id !== c.userId);
      if (dups.length) throw new ConflictException({ message: `${dups[0].name} already uses that ${dups[0].matchedOn.join(' / ').replace('name', 'handle')}`, duplicates: dups });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: c.userId }, data: { ...(input.name ? { name: input.name } : {}), ...(phone ? { phone: `+91${phone}` } : {}), ...(input.email !== undefined ? { email: input.email ? lc(input.email) : null } : {}) } }),
      this.prisma.creator.update({ where: { id }, data: { ...(input.niche ? { niche: input.niche } : {}), ...(input.rates ? { rates: input.rates } : {}), ...(input.handle ? { handle: input.handle } : {}), ...(input.city ? { city: input.city } : {}) } }),
    ]);
    await this.audit.log(me, 'creator.updated', 'Creator', id, { name: c.user.name, handle: c.handle, city: c.city, niche: c.niche, rates: c.rates }, input, ip);
    return { id, message: 'Creator updated' };
  }

  // -------------------------------------------------------------------------
  // Rating after delivery

  async rate(me: Me, briefId: string, body: unknown, ip?: string) {
    this.assertManager(me);
    const input = parse(opsCreatorRatingSchema, body);
    const b = await this.prisma.creatorBrief.findFirst({ where: { id: briefId, orgId: me.orgId } });
    if (!b) throw new NotFoundException('Brief not found');
    if (!DONE.includes(b.status)) throw new BadRequestException('Rate the creator once their work is approved');
    if (await this.prisma.opsCreatorRating.findUnique({ where: { briefId } })) throw new BadRequestException('This brief is already rated');
    const c = await this.prisma.creator.findUniqueOrThrow({ where: { id: b.creatorId } });
    const count = c.ratingCount + 1;
    const avg = ((c.rating ?? 0) * c.ratingCount + input.score) / count;
    await this.prisma.$transaction([
      this.prisma.opsCreatorRating.create({ data: { orgId: me.orgId, creatorId: c.id, briefId, score: input.score, note: input.note, byId: me.id } }),
      this.prisma.creator.update({ where: { id: c.id }, data: { rating: avg, ratingCount: count } }),
    ]);
    await this.audit.log(me, 'creator.rated', 'Creator', c.id, { rating: c.rating, ratingCount: c.ratingCount }, { briefId, score: input.score, note: input.note, rating: avg, ratingCount: count }, ip);
    return { id: c.id, rating: Math.round(avg * 10) / 10, ratingCount: count, message: `Rated ${input.score} of 5. Thanks.` };
  }

  // -------------------------------------------------------------------------
  // CSV import

  private importInput(r: Record<string, string>) {
    const rate = Number((r.rate ?? '').replace(/[₹,\s]/g, ''));
    return {
      name: (r.name ?? '').trim(),
      phone: (r.phone ?? '').trim(),
      email: (r.email ?? '').trim(),
      handle: (r.handle ?? '').trim(),
      city: (r.city ?? '').trim(),
      niche: (r.niche ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
      rates: Number.isFinite(rate) && rate > 0 ? [{ label: 'Per reel', pricePaise: Math.round(rate * 100) }] : [],
      confirmDuplicate: false,
    };
  }

  private async validateImport(me: Me, rows: Record<string, string>[]) {
    const seenPhone = new Set<string>();
    const seenHandle = new Set<string>();
    const out: { errors: string[]; duplicate: string | null }[] = [];
    for (const r of rows) {
      const errors: string[] = [];
      const res = opsCreatorCreateSchema.safeParse(this.importInput(r));
      if (!res.success) for (const i of res.error.issues) errors.push(i.message);
      const phone = phoneDigits(r.phone);
      const handle = lc(r.handle).replace(/^@+/, '');
      if (phone && seenPhone.has(phone)) errors.push('The same mobile appears twice in this file');
      if (handle && seenHandle.has(handle)) errors.push('The same handle appears twice in this file');
      if (phone) seenPhone.add(phone);
      if (handle) seenHandle.add(handle);
      const dups = await this.duplicates(me, { phone, handle, email: r.email });
      const hard = dups.find((d) => d.matchedOn.includes('phone') || d.matchedOn.includes('email'));
      if (hard) errors.push(`${hard.name} already uses this ${hard.matchedOn.includes('phone') ? 'mobile' : 'email'}`);
      else if (dups.length) errors.push(`Handle already used by ${dups[0].name}`);
      out.push({ errors, duplicate: dups[0]?.name ?? null });
    }
    return out;
  }
}
