// v11 ops: communication. Project threads and internal discussions (team only), turning a message into a request
// (tasks use the core Add task drawer) and announcements by Founder / Admin to clients or the team (in-app + email).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addWorkingMinutes,
  fileKindFromMime,
  opsAnnouncementSchema,
  opsCanAnnounce,
  opsMessageToRequestSchema,
  opsThreadCreateSchema,
  opsThreadPostSchema,
  SLA_FIRST_REPLY_MIN,
  type Me,
  type OpsAnnouncementOptions,
  type OpsAnnouncementRow,
  type OpsThreadSummary,
  type OpsThreadView,
  type SentFile,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { threadScope } from '../requests/messages.service.js';
import { EmailService } from '../service/email.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { hasRole, isLeadership, relPath, sha256, type OpsUpload } from './ops-util.js';

const OPS_TYPES = ['project', 'internal'];
const threadInclude = { clientOrg: { select: { id: true, name: true, amUserId: true } }, engagement: { select: { id: true, service: { select: { name: true } } } }, messages: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.ThreadInclude;
type ThreadFull = Prisma.ThreadGetPayload<{ include: typeof threadInclude }>;

@Injectable()
export class OpsCommsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly settings: SettingsService,
  ) {}

  private staff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  }

  /** Clients a team member works on (leadership: all). */
  private async myClientIds(me: Me): Promise<'all' | string[]> {
    if (isLeadership(me) || hasRole(me, 'department_head')) return 'all';
    const [clients, engs, tasks] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, amUserId: me.id }, select: { id: true } }),
      this.prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id }, select: { clientOrgId: true } }),
      this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: me.id, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] }),
    ]);
    const taskEngs = tasks.length ? await this.prisma.engagement.findMany({ where: { id: { in: tasks.map((t) => t.engagementId!) } }, select: { clientOrgId: true } }) : [];
    return [...new Set([...clients.map((c) => c.id), ...engs.map((e) => e.clientOrgId), ...taskEngs.map((e) => e.clientOrgId)])];
  }

  /** Project threads: everyone on that client. Internal discussions: the people in it (and leadership). */
  private async visibleWhere(me: Me): Promise<Prisma.ThreadWhereInput> {
    const ids = await this.myClientIds(me);
    if (ids === 'all') return { orgId: me.orgId, type: { in: OPS_TYPES } };
    return {
      orgId: me.orgId,
      OR: [
        { type: 'project', clientOrgId: { in: ids } },
        { type: { in: OPS_TYPES }, createdById: me.id },
        { type: { in: OPS_TYPES }, participantIds: { has: me.id } },
      ],
    };
  }

  private async summaries(me: Me, rows: ThreadFull[]): Promise<OpsThreadSummary[]> {
    const ids = [...new Set(rows.flatMap((t) => [...t.participantIds, ...t.messages.map((m) => m.authorId), t.createdById ?? '']))].filter(Boolean);
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? 'Team';
    return rows.map((t) => {
      const last = t.messages.at(-1);
      return {
        id: t.id,
        kind: t.type,
        title: t.title ?? 'Discussion',
        client: { id: t.clientOrg.id, name: t.clientOrg.name },
        engagement: t.engagement?.service.name ?? null,
        participants: [...new Set([t.createdById, ...t.participantIds])].filter((x): x is string => !!x).map(name),
        lastMessage: last ? { body: last.body.slice(0, 160), author: name(last.authorId), at: last.createdAt.toISOString() } : null,
        createdAt: t.createdAt.toISOString(),
      };
    });
  }

  async threads(me: Me, q: { clientOrgId?: string; kind?: string }) {
    this.staff(me);
    const rows = await this.prisma.thread.findMany({
      where: { AND: [await this.visibleWhere(me), q.clientOrgId ? { clientOrgId: q.clientOrgId } : {}, q.kind && OPS_TYPES.includes(q.kind) ? { type: q.kind } : {}] },
      include: threadInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const out = await this.summaries(me, rows);
    return out.sort((a, b) => (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt));
  }

  async options(me: Me) {
    this.staff(me);
    const ids = await this.myClientIds(me);
    const [clients, people] = await Promise.all([
      this.prisma.clientOrg.findMany({
        where: { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
        select: { id: true, name: true, engagements: { where: { deletedAt: null, archivedAt: null }, select: { id: true, service: { select: { name: true } } } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: me.id } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return { clients: clients.map((c) => ({ id: c.id, name: c.name, engagements: c.engagements.map((e) => ({ id: e.id, name: e.service.name })) })), people };
  }

  private async load(me: Me, id: string) {
    this.staff(me);
    const t = await this.prisma.thread.findFirst({ where: { AND: [{ id }, await this.visibleWhere(me)] }, include: threadInclude });
    if (!t) throw new NotFoundException('Discussion not found');
    return t;
  }

  async thread(me: Me, id: string): Promise<OpsThreadView> {
    const t = await this.load(me, id);
    const [s] = await this.summaries(me, [t]);
    const fileIds = t.messages.flatMap((m) => m.attachments);
    const [users, files] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: t.messages.map((m) => m.authorId) } }, select: { id: true, name: true } }),
      fileIds.length ? this.prisma.file.findMany({ where: { id: { in: fileIds } }, select: { id: true, name: true, mimeType: true, sizeBytes: true } }) : [],
    ]);
    const sent = (id: string): SentFile | null => {
      const f = files.find((x) => x.id === id);
      return f ? { id: f.id, name: f.name ?? 'file', url: `/api/files/${f.id}`, mimeType: f.mimeType, sizeBytes: f.sizeBytes } : null;
    };
    return {
      ...s,
      messages: t.messages.map((m) => ({
        id: m.id,
        body: m.body,
        author: users.find((u) => u.id === m.authorId)?.name ?? 'Team',
        mine: m.authorId === me.id,
        at: m.createdAt.toISOString(),
        attachments: m.attachments.map(sent).filter((x): x is SentFile => !!x),
      })),
      canPost: true,
    };
  }

  /**
   * v38: a file to send in a discussion. It lands in Files labelled "Discussion", for the people in it only (project
   * threads: everyone on the client) and the Founder / Branch Managers.
   */
  async attach(me: Me, id: string, file: OpsUpload | undefined, ip?: string): Promise<SentFile> {
    const t = await this.load(me, id);
    if (!file) throw new BadRequestException('Choose a file to send');
    const f = await this.prisma.file.create({
      data: {
        orgId: me.orgId,
        clientOrgId: t.clientOrgId,
        engagementId: t.engagementId,
        path: relPath(file.path),
        kind: fileKindFromMime(file.mimetype),
        name: file.originalname.slice(0, 200),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum: await sha256(file.path),
        folder: 'general',
        tags: ['discussion-file'],
        uploadedById: me.id,
      },
    });
    await this.audit.log(me, 'thread.file_attached', 'File', f.id, undefined, { threadId: t.id, name: f.name, sizeBytes: f.sizeBytes }, ip);
    return { id: f.id, name: f.name ?? 'file', url: `/api/files/${f.id}`, mimeType: f.mimeType, sizeBytes: f.sizeBytes };
  }

  async create(me: Me, body: unknown, ip?: string) {
    this.staff(me);
    const input = parse(opsThreadCreateSchema, body);
    const ids = await this.myClientIds(me);
    if (ids !== 'all' && !ids.includes(input.clientOrgId)) throw new ForbiddenException('You can only start discussions on clients you work on');
    const client = await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!client) throw new BadRequestException('Pick a client');
    if (input.engagementId && !(await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrgId: client.id, deletedAt: null } }))) throw new BadRequestException('That project does not belong to this client');
    const people = input.participantIds.length ? await this.prisma.user.findMany({ where: { id: { in: input.participantIds }, orgId: me.orgId, type: 'staff', deletedAt: null }, select: { id: true } }) : [];
    if (people.length !== new Set(input.participantIds).size) throw new BadRequestException('Some people you picked are not on the team');
    if (input.kind === 'internal' && !people.length) throw new BadRequestException('Add at least one person to an internal discussion');
    const t = await this.prisma.thread.create({
      data: {
        orgId: me.orgId,
        clientOrgId: client.id,
        engagementId: input.engagementId || null,
        type: input.kind,
        title: input.title,
        createdById: me.id,
        participantIds: people.map((p) => p.id),
        messages: { create: { orgId: me.orgId, authorId: me.id, body: input.message, isInternal: true } },
      },
    });
    await this.audit.log(me, 'thread.started', 'ClientOrg', client.id, undefined, { threadId: t.id, kind: input.kind, title: input.title, participants: people.length }, ip);
    // Project threads also tell the client's CM; internal discussions tell the people added.
    const notifyIds = input.kind === 'project' ? [...people.map((p) => p.id), client.amUserId] : people.map((p) => p.id);
    await this.notifications.notify(
      me.orgId,
      notifyIds.filter((x) => x !== me.id),
      { kind: 'thread_started', title: `${me.name} started "${input.title}"`, body: `${client.name}: ${input.message.slice(0, 120)}`, link: `/team/discussions/${t.id}`, noEmail: true },
    );
    return { id: t.id, message: input.kind === 'project' ? 'Project thread started' : 'Internal discussion started' };
  }

  async post(me: Me, id: string, body: unknown, ip?: string) {
    const input = parse(opsThreadPostSchema, body);
    const t = await this.load(me, id);
    // v38: files uploaded for this discussion by this person, not sent yet.
    const ids = [...new Set(input.attachmentIds)];
    if (ids.length) {
      const ok = await this.prisma.file.count({ where: { id: { in: ids }, orgId: me.orgId, clientOrgId: t.clientOrgId, uploadedById: me.id, tags: { has: 'discussion-file' } } });
      if (ok !== ids.length) throw new BadRequestException('One of the files could not be found. Attach it again.');
    }
    const m = await this.prisma.message.create({ data: { orgId: me.orgId, threadId: t.id, authorId: me.id, body: input.body, isInternal: true, attachments: ids } });
    await this.audit.log(me, 'thread.message_posted', 'ClientOrg', t.clientOrgId, undefined, { threadId: t.id, messageId: m.id, files: ids.length }, ip);
    const others = [...new Set([t.createdById, ...t.participantIds, ...t.messages.map((x) => x.authorId)])].filter((x): x is string => !!x && x !== me.id);
    const preview = input.body || `Sent ${ids.length} file${ids.length === 1 ? '' : 's'}`;
    await this.notifications.notify(me.orgId, others, { kind: 'thread_reply', title: `${me.name} replied in "${t.title ?? 'Discussion'}"`, body: preview.slice(0, 140), link: `/team/discussions/${t.id}`, noEmail: true });
    return this.thread(me, id);
  }

  // -------------------------------------------------------------------------
  // Message → request

  async toRequest(me: Me, body: unknown, ip?: string) {
    this.staff(me);
    const input = parse(opsMessageToRequestSchema, body);
    const msg = await this.prisma.message.findFirst({ where: { id: input.messageId, orgId: me.orgId }, include: { thread: true } });
    if (!msg) throw new NotFoundException('Message not found');
    // The person must see that thread (client threads: CM / leadership; ops threads: as above).
    const visible = OPS_TYPES.includes(msg.thread.type)
      ? await this.prisma.thread.findFirst({ where: { AND: [{ id: msg.threadId }, await this.visibleWhere(me)] }, select: { id: true } })
      : await this.prisma.thread.findFirst({ where: { AND: [{ id: msg.threadId }, await threadScope(me)] }, select: { id: true } });
    if (!visible) throw new NotFoundException('Message not found');
    const existing = await this.prisma.request.findFirst({ where: { sourceMessageId: msg.id } });
    if (existing) throw new BadRequestException('A request was already created from this message');
    const eng = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrgId: msg.thread.clientOrgId, deletedAt: null }, include: { clientOrg: { select: { name: true } } } });
    if (!eng) throw new BadRequestException("Pick one of this client's services");
    if (!isLeadership(me) && eng.amId !== me.id) throw new ForbiddenException("Only the client's Client Manager can log requests for this service");
    const author = await this.prisma.user.findUnique({ where: { id: msg.authorId }, select: { type: true } });
    const [cal, sla] = await Promise.all([calendarFor(this.prisma, me.orgId), this.settings.get(me.orgId, 'sla')]);
    const minutes = sla.firstReplyMinutes[input.type] ?? SLA_FIRST_REPLY_MIN[input.type];
    const r = await this.prisma.request.create({
      data: {
        orgId: me.orgId,
        engagementId: eng.id,
        type: input.type,
        description: input.description,
        createdById: author?.type === 'client' ? msg.authorId : me.id,
        status: input.type === 'new_scope' ? 'scope_check' : 'received',
        slaDue: addWorkingMinutes(new Date(), minutes, cal),
        sourceMessageId: msg.id,
      },
    });
    await this.prisma.message.create({ data: { orgId: me.orgId, threadId: msg.threadId, authorId: me.id, body: `Logged as a ${input.type.replace('_', ' ')} request: /team/requests/${r.id}`, isInternal: true } });
    await this.audit.log(me, 'request.created_from_message', 'Request', r.id, undefined, { type: input.type, messageId: msg.id, threadId: msg.threadId }, ip);
    if (eng.amId && eng.amId !== me.id) await this.notifications.notify(me.orgId, [eng.amId], { kind: 'request_created', title: `New request for ${eng.clientOrg.name}`, body: input.description.slice(0, 140), link: `/team/requests/${r.id}`, critical: input.type === 'urgent' });
    return { id: r.id, href: `/team/requests/${r.id}`, message: 'Request created and linked to the message' };
  }

  // -------------------------------------------------------------------------
  // Announcements

  private assertAnnounce(me: Me) {
    if (!opsCanAnnounce(me)) throw new ForbiddenException('Only Founders and Branch Managers send announcements');
  }

  private async audience(orgId: string, audience: string, segment?: string | null): Promise<string[]> {
    if (audience === 'all_team') return (await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true } })).map((u) => u.id);
    if (audience === 'department') {
      if (!segment) return [];
      return (await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, departmentId: segment }, select: { id: true } })).map((u) => u.id);
    }
    const clientWhere: Prisma.ClientOrgWhereInput = { orgId, deletedAt: null, archivedAt: null };
    if (audience === 'segment') {
      const [kind, value] = (segment ?? '').split(':');
      if (kind === 'service') clientWhere.engagements = { some: { deletedAt: null, archivedAt: null, status: { notIn: ['closed', 'pending_payment'] }, service: { key: value } } };
      else if (kind === 'health') clientWhere.health = value;
      else return [];
    }
    const rows = await this.prisma.clientUser.findMany({ where: { clientOrg: clientWhere, user: { deletedAt: null, status: 'active' } }, select: { userId: true } });
    return [...new Set(rows.map((r) => r.userId))];
  }

  async announcementOptions(me: Me): Promise<OpsAnnouncementOptions> {
    this.assertAnnounce(me);
    const [departments, services] = await Promise.all([
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.service.findMany({ where: { orgId: me.orgId }, select: { key: true, name: true }, orderBy: { name: 'asc' }, distinct: ['key'] }),
    ]);
    const counts: Record<string, number> = {
      all_clients: (await this.audience(me.orgId, 'all_clients')).length,
      all_team: (await this.audience(me.orgId, 'all_team')).length,
    };
    for (const d of departments) counts[`department:${d.id}`] = (await this.audience(me.orgId, 'department', d.id)).length;
    for (const s of services) counts[`service:${s.key}`] = (await this.audience(me.orgId, 'segment', `service:${s.key}`)).length;
    for (const h of ['green', 'amber', 'red']) counts[`health:${h}`] = (await this.audience(me.orgId, 'segment', `health:${h}`)).length;
    return { departments, services, counts };
  }

  async announcements(me: Me): Promise<OpsAnnouncementRow[]> {
    this.assertAnnounce(me);
    const rows = await this.prisma.opsAnnouncement.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.sentById) } }, select: { id: true, name: true } });
    return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, audience: r.audience, segment: r.segment, channels: r.channels, recipientCount: r.recipientCount, sentBy: users.find((u) => u.id === r.sentById)?.name ?? 'Team', createdAt: r.createdAt.toISOString() }));
  }

  async announce(me: Me, body: unknown, ip?: string) {
    this.assertAnnounce(me);
    const input = parse(opsAnnouncementSchema, body);
    if (input.audience === 'department' && !(await this.prisma.department.findFirst({ where: { id: input.segment, orgId: me.orgId, deletedAt: null } }))) throw new BadRequestException('Pick a department');
    if (input.audience === 'segment' && !/^(service:[\w-]+|health:(green|amber|red))$/.test(input.segment ?? '')) throw new BadRequestException('Pick a client segment');
    const ids = (await this.audience(me.orgId, input.audience, input.segment)).filter((id) => id !== me.id);
    if (!ids.length) throw new BadRequestException('Nobody is in that audience yet');
    const toClients = input.audience === 'all_clients' || input.audience === 'segment';
    const link = toClients ? '/client' : '/team';
    if (input.channels.includes('in_app')) {
      await this.notifications.notify(me.orgId, ids, { kind: 'announcement', title: input.title, body: input.body, link, critical: true, forceEmail: input.channels.includes('email'), noEmail: !input.channels.includes('email') });
    } else {
      // Email only: straight to the outbox.
      const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
      for (const u of users) {
        if (!u.email) continue;
        await this.email.send({ orgId: me.orgId, to: u.email, toName: u.name, toUserId: u.id, kind: 'announcement', subject: input.title, paragraphs: [`Hi ${u.name.split(' ')[0]},`, ...input.body.split(/\n{2,}/)], button: { label: 'Open BMU Hub', url: link } });
      }
    }
    const a = await this.prisma.opsAnnouncement.create({ data: { orgId: me.orgId, title: input.title, body: input.body, audience: input.audience, segment: input.segment ?? null, channels: input.channels, recipientCount: ids.length, sentById: me.id } });
    await this.audit.log(me, 'announcement.sent', 'Organisation', me.orgId, undefined, { announcementId: a.id, audience: input.audience, segment: input.segment, channels: input.channels, recipients: ids.length }, ip);
    return { id: a.id, recipientCount: ids.length, message: `Sent to ${ids.length} ${ids.length === 1 ? 'person' : 'people'}` };
  }
}
