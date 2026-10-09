import { ForbiddenException, Injectable } from '@nestjs/common';
import { formatINR, searchNormalise, type Me, type TeamSearchItem, type TeamSearchKind, type TeamSearchResult } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { isLeadership, visibleEngagementWhere } from '../engagements/engagement-access.js';
import { FlagsService } from '../platform/flags.service.js';
import { SearchIndexService, type IndexedKind } from '../platform/search-index.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { capable, hasRole, isStaff } from './access.js';

const LABELS: Record<TeamSearchKind, string> = {
  client: 'Clients',
  lead: 'Leads',
  proposal: 'Proposals',
  invoice: 'Invoices',
  task: 'Tasks',
  person: 'People',
  sop: 'SOPs',
  project: 'Projects',
  request: 'Requests',
  creator: 'Creators',
};
const TAKE = 6;
/** Rows fetched per kind before ranking (plain matches plus smart-search candidates). */
const FETCH = 20;
const ORDER: TeamSearchKind[] = ['client', 'lead', 'project', 'proposal', 'request', 'invoice', 'task', 'person', 'creator', 'sop'];
const INDEXED: IndexedKind[] = ['client', 'lead', 'invoice', 'task', 'person', 'sop', 'project', 'request', 'creator'];

/** Smart-search candidates for one kind: ids to include and their scores. */
type Hits = { ids: string[]; score: Map<string, number> };
const NO_HITS: Hits = { ids: [], score: new Map() };

/**
 * Ctrl/Cmd+K search across clients, leads, projects, proposals, requests, invoices, tasks, people, creators and SOPs,
 * limited to what the person may open. v13 smart search adds candidates from the search index (typos, partial names);
 * every candidate still goes through the same access rules as a plain match.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly index: SearchIndexService,
    private readonly flags: FlagsService,
  ) {}

  async search(me: Me, raw: string | undefined, surface: string | undefined, kindsRaw?: string): Promise<TeamSearchResult> {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const q = (raw ?? '').trim().slice(0, 80);
    if (q.length < 2) return { q, groups: [] };
    const like = { contains: q, mode: 'insensitive' as const };
    const admin = surface === 'admin';
    const only = new Set((kindsRaw ?? '').split(',').filter((k): k is TeamSearchKind => k in LABELS));
    const want = (k: TeamSearchKind) => !only.size || only.has(k);

    const found = (await this.flags.on(me, 'smart_search')) ? await this.index.find(me.orgId, q, INDEXED.filter((k) => want(k) || (k === 'lead' && want('proposal')))) : new Map();
    const hits = (k: IndexedKind): Hits => {
      const h = found.get(k) as { id: string; score: number }[] | undefined;
      return h?.length ? { ids: h.map((x) => x.id), score: new Map(h.map((x) => [x.id, x.score])) } : NO_HITS;
    };
    const skip = Promise.resolve([] as TeamSearchItem[]);

    const groups = await Promise.all([
      want('client') ? this.clients(me, like, hits('client')) : skip,
      want('lead') ? this.leads(me, q, hits('lead')) : skip,
      want('project') ? this.projects(me, like, hits('project')) : skip,
      want('proposal') ? this.proposals(me, q, hits('lead')) : skip,
      want('request') ? this.requests(me, like, hits('request')) : skip,
      want('invoice') ? this.invoices(me, like, hits('invoice')) : skip,
      want('task') ? this.tasks(me, like, hits('task')) : skip,
      want('person') ? this.people(me, like, admin, hits('person')) : skip,
      want('creator') ? this.creators(me, like, hits('creator')) : skip,
      want('sop') ? this.sops(me, like, admin, hits('sop')) : skip,
    ]);
    const scores: Record<string, Hits> = { client: hits('client'), lead: hits('lead'), project: hits('project'), proposal: NO_HITS, request: hits('request'), invoice: hits('invoice'), task: hits('task'), person: hits('person'), creator: hits('creator'), sop: hits('sop') };
    const needle = searchNormalise(q);
    const out = ORDER.map((kind, i) => {
      const ranked = groups[i]
        .map((it) => {
          const plain = searchNormalise(`${it.title} ${it.sub ?? ''}`).includes(needle);
          const score = plain ? 1 + (searchNormalise(it.title).startsWith(needle) ? 0.5 : 0) : (scores[kind].score.get(it.id) ?? 0.5);
          return { it: plain ? it : { ...it, fuzzy: true }, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, TAKE)
        .map((x) => x.it);
      return { kind, items: ranked };
    });
    return { q, groups: out.filter((g) => g.items.length).map((g) => ({ ...g, label: LABELS[g.kind] })) };
  }

  /** Plain text match OR one of the smart-search candidates. */
  private or<W>(text: W[], h: Hits): (W | { id: { in: string[] } })[] {
    return h.ids.length ? [...text, { id: { in: h.ids } }] : text;
  }

  private async sops(me: Me, like: Prisma.StringFilter, admin: boolean, h: Hits): Promise<TeamSearchItem[]> {
    const rows = await this.prisma.sOP.findMany({
      where: { orgId: me.orgId, status: 'published', OR: this.or<Prisma.SOPWhereInput>([{ title: like }, { body: like }], h) },
      include: { department: { select: { name: true } } },
      take: FETCH,
      orderBy: { title: 'asc' },
    });
    return rows.map((s) => ({ kind: 'sop', id: s.id, title: s.title, sub: `${s.department.name} · v${s.version}`, href: admin && hasRole(me, 'founder', 'admin', 'department_head') ? `/admin/sops?sop=${s.id}` : `/team/sops/${s.id}` }));
  }

  private async projects(me: Me, like: Prisma.StringFilter, h: Hits): Promise<TeamSearchItem[]> {
    const rows = await this.prisma.engagement.findMany({
      where: { AND: [await visibleEngagementWhere(this.prisma, me), { deletedAt: null, OR: this.or<Prisma.EngagementWhereInput>([{ clientOrg: { name: like } }, { service: { name: like } }], h) }] },
      include: { clientOrg: { select: { name: true } }, service: { select: { name: true } }, am: { select: { name: true } } },
      take: FETCH,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((e) => ({ kind: 'project', id: e.id, title: `${e.clientOrg.name} · ${e.service.name}`, sub: [e.status.replace(/_/g, ' '), e.currentGate, e.am ? `AM ${e.am.name}` : null].filter(Boolean).join(' · '), href: `/team/projects/${e.id}` }));
  }

  private async requests(me: Me, like: Prisma.StringFilter, h: Hits): Promise<TeamSearchItem[]> {
    let scope: Prisma.RequestWhereInput;
    if (isLeadership(me) || hasRole(me, 'finance')) scope = { orgId: me.orgId };
    else if (hasRole(me, 'account_manager')) scope = { orgId: me.orgId, OR: [{ engagement: { amId: me.id } }, { assigneeId: me.id }] };
    else return [];
    const rows = await this.prisma.request.findMany({
      where: { AND: [scope, { OR: this.or<Prisma.RequestWhereInput>([{ description: like }, { engagement: { clientOrg: { name: like } } }], h) }] },
      include: { engagement: { select: { clientOrg: { select: { name: true } } } } },
      take: FETCH,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ kind: 'request', id: r.id, title: r.description.length > 80 ? `${r.description.slice(0, 79)}…` : r.description, sub: [r.engagement.clientOrg.name, r.type.replace(/_/g, ' '), r.status.replace(/_/g, ' ')].join(' · '), href: `/team/requests/${r.id}` }));
  }

  private async creators(me: Me, like: Prisma.StringFilter, h: Hits): Promise<TeamSearchItem[]> {
    if (!hasRole(me, 'founder', 'admin', 'am_lead', 'account_manager')) return [];
    const rows = await this.prisma.creator.findMany({
      where: { orgId: me.orgId, user: { deletedAt: null }, OR: this.or<Prisma.CreatorWhereInput>([{ user: { name: like } }, { handle: like }, { city: like }], h) },
      include: { user: { select: { name: true } } },
      take: FETCH,
    });
    return rows.map((c) => ({ kind: 'creator', id: c.id, title: c.user.name, sub: [c.handle ? `@${c.handle}` : null, c.city, c.niche.slice(0, 2).join(', ') || null].filter(Boolean).join(' · ') || null, href: `/team/creators/${c.id}` }));
  }

  private async clients(me: Me, like: Prisma.StringFilter, h: Hits): Promise<TeamSearchItem[]> {
    let where: Prisma.ClientOrgWhereInput = { orgId: me.orgId, deletedAt: null, OR: this.or<Prisma.ClientOrgWhereInput>([{ name: like }], h) };
    if (hasRole(me, 'founder', 'admin', 'am_lead', 'finance', 'department_head')) {
      // every client
    } else if (hasRole(me, 'account_manager')) where = { ...where, amUserId: me.id };
    else if (hasRole(me, 'strategist')) {
      const self = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { teamId: true } });
      where = { ...where, am: { teamId: self.teamId ?? '__none__' } };
    } else return [];
    const rows = await this.prisma.clientOrg.findMany({ where, include: { am: { select: { name: true } } }, take: FETCH, orderBy: { name: 'asc' } });
    return rows.map((c) => ({ kind: 'client', id: c.id, title: c.name, sub: [c.industry, c.am ? `AM ${c.am.name}` : null].filter(Boolean).join(' · ') || null, href: `/team/clients/${c.id}` }));
  }

  private leadWhere(me: Me): Prisma.LeadWhereInput | null {
    const scope = me.permissions.leads_pipeline?.scope ?? 'none';
    if (scope === 'none') return null;
    return { orgId: me.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: me.id } : {}) };
  }

  /** Lead contact details live in JSON, so match name / company / email / phone there. */
  private jsonMatch(q: string, h: Hits = NO_HITS): Prisma.LeadWhereInput {
    return { OR: this.or(['name', 'company', 'email', 'phone'].map((k) => ({ contact: { path: [k], string_contains: q, mode: 'insensitive' } }) as Prisma.LeadWhereInput).concat([{ need: { contains: q, mode: 'insensitive' } }]), h) };
  }

  private async leads(me: Me, q: string, h: Hits): Promise<TeamSearchItem[]> {
    const base = this.leadWhere(me);
    if (!base) return [];
    const rows = await this.prisma.lead.findMany({ where: { AND: [base, this.jsonMatch(q, h)] }, take: FETCH, orderBy: { createdAt: 'desc' } });
    return rows.map((l) => {
      const c = (l.contact ?? {}) as { name?: string; company?: string };
      return { kind: 'lead', id: l.id, title: c.company || c.name || 'Lead', sub: `${l.stage.replace('_', ' ')}${c.company && c.name ? ` · ${c.name}` : ''}`, href: `/team/leads/${l.id}` };
    });
  }

  private async proposals(me: Me, q: string, leadHits: Hits): Promise<TeamSearchItem[]> {
    const base = this.leadWhere(me);
    if (!base) return [];
    const rows = await this.prisma.proposal.findMany({ where: { deletedAt: null, lead: { AND: [base, this.jsonMatch(q, leadHits)] } }, include: { lead: true }, take: FETCH, orderBy: { createdAt: 'desc' } });
    return rows.map((p) => {
      const c = (p.lead.contact ?? {}) as { name?: string; company?: string };
      return { kind: 'proposal', id: p.id, title: `Proposal v${p.version} for ${c.company || c.name || 'lead'}`, sub: `${p.status.replace('_', ' ')} · ${formatINR(p.totalPaise)}`, href: `/team/proposals/${p.id}` };
    });
  }

  private async invoices(me: Me, like: Prisma.StringFilter, h: Hits): Promise<TeamSearchItem[]> {
    if (!capable(me, 'invoices_payments')) return [];
    const rows = await this.prisma.invoice.findMany({
      where: { orgId: me.orgId, OR: this.or<Prisma.InvoiceWhereInput>([{ number: like }, { clientOrg: { name: like } }], h) },
      include: { clientOrg: { select: { name: true } } },
      take: FETCH,
      orderBy: { createdAt: 'desc' },
    });
    const finance = hasRole(me, 'founder', 'admin', 'finance');
    return rows.map((i) => ({
      kind: 'invoice',
      id: i.id,
      title: i.number,
      sub: `${i.clientOrg?.name ?? 'No client yet'} · ${formatINR(i.totalPaise)} · ${i.status.replace('_', ' ')}`,
      href: finance ? `/admin/finance/invoices/${i.id}` : i.clientOrgId ? `/team/clients/${i.clientOrgId}` : '/team',
    }));
  }

  private async tasks(me: Me, like: Prisma.StringFilter, h: Hits): Promise<TeamSearchItem[]> {
    let scope: Prisma.TaskWhereInput = { orgId: me.orgId };
    if (!hasRole(me, 'founder', 'admin', 'am_lead')) {
      const or: Prisma.TaskWhereInput[] = [{ ownerId: me.id }];
      if (hasRole(me, 'department_head')) {
        const u = await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
        if (u?.departmentId) or.push({ departmentId: u.departmentId });
      }
      if (hasRole(me, 'account_manager')) {
        const engs = await this.prisma.engagement.findMany({ where: await visibleEngagementWhere(this.prisma, me), select: { id: true } });
        or.push({ engagementId: { in: engs.map((e) => e.id) } }, { deliverable: { cycle: { engagementId: { in: engs.map((e) => e.id) } } } });
      }
      if (hasRole(me, 'qc_reviewer')) or.push({ kind: 'qc' });
      scope = { orgId: me.orgId, OR: or };
    }
    const rows = await this.prisma.task.findMany({
      where: { AND: [scope, { status: { not: 'cancelled' }, OR: this.or<Prisma.TaskWhereInput>([{ title: like }], h) }] },
      include: { owner: { select: { name: true } }, deliverable: { select: { cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } },
      take: FETCH,
      orderBy: [{ status: 'asc' }, { deadline: 'asc' }],
    });
    return rows.map((t) => ({
      kind: 'task',
      id: t.id,
      title: t.title,
      sub: [t.deliverable?.cycle.engagement.clientOrg.name, t.owner?.name ?? 'Unassigned', t.status.replace('_', ' ')].filter(Boolean).join(' · '),
      href: t.deliverableId ? `/team/deliverables/${t.deliverableId}` : t.engagementId ? `/team/projects/${t.engagementId}` : '/team/tasks',
    }));
  }

  private async people(me: Me, like: Prisma.StringFilter, admin: boolean, h: Hits): Promise<TeamSearchItem[]> {
    // The team directory (names, roles, departments) is open to every team member; contact details only to people admins.
    const peopleAdmin = hasRole(me, 'founder', 'admin', 'hr_ops', 'department_head') && capable(me, 'users_roles_hierarchy');
    const rows = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', deletedAt: null, ...(peopleAdmin ? {} : { status: 'active' }), OR: this.or<Prisma.UserWhereInput>([{ name: like }, ...(peopleAdmin ? [{ email: like }, { phone: like }] : [])], h) },
      include: { department: { select: { name: true } }, roles: { include: { role: { select: { name: true } } } } },
      take: FETCH,
      orderBy: { name: 'asc' },
    });
    return rows.map((u) => ({
      kind: 'person',
      id: u.id,
      title: u.name,
      sub: [u.roles[0]?.role.name, u.department?.name, peopleAdmin ? u.email : null, u.status === 'suspended' ? 'suspended' : null].filter(Boolean).join(' · ') || null,
      href: peopleAdmin && (admin || hasRole(me, 'founder', 'admin', 'hr_ops', 'department_head')) ? `/admin/users?u=${u.id}` : '/team/capacity',
    }));
  }
}
