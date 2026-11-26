import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { endOfWorkingDay, type ClientChatList, type Me, type ThreadAttachment, type ThreadMessage, type ThreadSummary, type ThreadView } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { calendarFor } from '../production/generate.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canSeeFile, fileScope } from '../ops-actions/file-access.js';

const include = { clientOrg: { include: { am: { select: { id: true, name: true } } } }, messages: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.ThreadInclude;
type Row = Prisma.ThreadGetPayload<{ include: typeof include }>;

export type UploadedAttachment = { path: string; originalname: string; mimetype: string; size: number };
export const ATTACHMENT_KIND = 'message_attachment';

/** Client ↔ Client Manager chat (one per client, always there). */
export const CM_THREAD = 'client_am';
/** Client ↔ BMU Owner (Founder) chat: only the Founder starts it; the client sees it after the first message. */
export const OWNER_THREAD = 'client_owner';
/** v53: a team member talking with the client directly, started from Discussions (one per person and client). */
export const CLIENT_STAFF_THREAD = 'client_staff';
const isFounder = (me: Me) => me.type === 'staff' && me.roles.includes('founder');

/**
 * v53: client chats started by team members: the person who started it, the people they added, the client's Client
 * Manager and leadership. Never anyone else on the team.
 */
export function clientStaffWhere(me: Me): Prisma.ThreadWhereInput {
  const base = { orgId: me.orgId, type: CLIENT_STAFF_THREAD };
  if (isLeadership(me)) return base;
  return { ...base, OR: [{ createdById: me.id }, { participantIds: { has: me.id } }, { clientOrg: { amUserId: me.id } }] };
}

/** v53: how long a heartbeat counts as "has it open" (the screen sends one every few seconds). */
const VIEWING_MS = 20_000;

/** v53: of these people, the ones who have this conversation open right now (no notification for them). */
export async function viewingNow(prisma: PrismaService, threadId: string, userIds: string[]) {
  if (!userIds.length) return new Set<string>();
  const rows = await prisma.threadRead.findMany({ where: { threadId, userId: { in: userIds }, viewingAt: { gte: new Date(Date.now() - VIEWING_MS) } }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

/** Staff who see client threads: their own clients for CMs, every client for leadership. Owner chats: Founder only. */
export async function threadScope(me: Me): Promise<Prisma.ThreadWhereInput> {
  if (me.type !== 'staff') throw new ForbiddenException();
  if (isFounder(me)) return { orgId: me.orgId };
  if (isLeadership(me)) return { orgId: me.orgId, type: { not: OWNER_THREAD } };
  if (me.roles.includes('account_manager')) return { orgId: me.orgId, type: { not: OWNER_THREAD }, clientOrg: { amUserId: me.id } };
  throw new ForbiddenException('Client threads are for Client Managers and leadership');
}

/**
 * Unread messages from the other side for a person, per thread. Team: client messages since they last opened
 * the thread. Client: team messages (never internal notes) since they last opened it.
 */
export async function unreadByThread(prisma: PrismaService, me: Me, threadIds: string[]) {
  const out = new Map<string, number>();
  if (!threadIds.length) return out;
  const reads = await prisma.threadRead.findMany({ where: { userId: me.id, threadId: { in: threadIds } } });
  const msgs = await prisma.message.findMany({
    where: { threadId: { in: threadIds }, isInternal: false, authorId: { not: me.id } },
    select: { threadId: true, authorId: true, createdAt: true },
  });
  const authorIds = [...new Set(msgs.map((m) => m.authorId))];
  const authors = authorIds.length ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, type: true } }) : [];
  const isClient = new Set(authors.filter((a) => a.type === 'client').map((a) => a.id));
  for (const m of msgs) {
    const fromOtherSide = me.type === 'client' ? !isClient.has(m.authorId) : isClient.has(m.authorId);
    if (!fromOtherSide) continue;
    const since = reads.find((r) => r.threadId === m.threadId)?.lastReadAt;
    if (since && m.createdAt <= since) continue;
    out.set(m.threadId, (out.get(m.threadId) ?? 0) + 1);
  }
  return out;
}

/** Total unread for the menu badge (clients: their thread; CMs: their clients; leadership: every client thread). */
export async function unreadMessages(prisma: PrismaService, me: Me) {
  let where: Prisma.ThreadWhereInput;
  if (me.type === 'client' && me.clientOrg) where = { clientOrgId: me.clientOrg.id, type: { in: [CM_THREAD, OWNER_THREAD, CLIENT_STAFF_THREAD] } };
  else if (me.type === 'staff' && me.roles.includes('account_manager') && !isLeadership(me)) where = { orgId: me.orgId, type: CM_THREAD, clientOrg: { amUserId: me.id } };
  else if (isFounder(me)) where = { orgId: me.orgId, type: { in: [CM_THREAD, OWNER_THREAD] } };
  else if (me.type === 'staff' && isLeadership(me)) where = { orgId: me.orgId, type: CM_THREAD };
  else return 0;
  const threads = await prisma.thread.findMany({ where, select: { id: true } });
  const map = await unreadByThread(
    prisma,
    me,
    threads.map((t) => t.id),
  );
  return [...map.values()].reduce((s, n) => s + n, 0);
}

/** Client ↔ CM thread (no WhatsApp groups). Internal notes are team-only. */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async authors(rows: Row['messages']) {
    return this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((m) => m.authorId))] } }, select: { id: true, name: true, type: true } });
  }

  private async awaiting(t: Row, authors: { id: string; type: string }[]) {
    const visible = t.messages.filter((m) => !m.isInternal);
    const last = visible.at(-1);
    if (!last || authors.find((a) => a.id === last.authorId)?.type !== 'client') return null;
    // First unanswered client message in the current run.
    let i = visible.length - 1;
    while (i > 0 && authors.find((a) => a.id === visible[i - 1].authorId)?.type === 'client') i--;
    const since = visible[i].createdAt;
    const due = endOfWorkingDay(since, await calendarFor(this.prisma, t.orgId));
    return { since: since.toISOString(), due: due.toISOString(), overdue: Date.now() > due.getTime() };
  }

  private async attachments(ids: string[]): Promise<Map<string, ThreadAttachment>> {
    if (!ids.length) return new Map();
    const files = await this.prisma.file.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, mimeType: true, sizeBytes: true, kind: true, path: true } });
    // v53: client chats started from Discussions can also carry Drive (or other) links.
    return new Map(files.map((f) => [f.id, { id: f.id, name: f.name ?? 'file', url: f.kind === 'link' ? f.path : `/api/thread-files/${f.id}`, mimeType: f.mimeType, sizeBytes: f.sizeBytes }]));
  }

  /** Builds the view and marks the thread read for this person (unread = count before opening). */
  private async view(me: Me, t: Row): Promise<ThreadView> {
    const authors = await this.authors(t.messages);
    const visibleRows = t.messages.filter((m) => me.type === 'staff' || !m.isInternal);
    const files = await this.attachments(visibleRows.flatMap((m) => m.attachments));
    const msgs: ThreadMessage[] = visibleRows.map((m) => {
      const a = authors.find((x) => x.id === m.authorId);
      return {
        id: m.id,
        body: m.body,
        internal: m.isInternal,
        author: a?.name ?? '',
        isClient: a?.type === 'client',
        mine: m.authorId === me.id,
        at: m.createdAt.toISOString(),
        attachments: m.attachments.map((id) => files.get(id)).filter((x): x is ThreadAttachment => !!x),
      };
    });
    const unread = (await unreadByThread(this.prisma, me, [t.id])).get(t.id) ?? 0;
    await this.prisma.threadRead.upsert({
      where: { threadId_userId: { threadId: t.id, userId: me.id } },
      create: { threadId: t.id, userId: me.id, orgId: t.orgId, lastReadAt: new Date() },
      update: { lastReadAt: new Date() },
    });
    return { id: t.id, kind: t.type === OWNER_THREAD ? OWNER_THREAD : t.type === CLIENT_STAFF_THREAD ? CLIENT_STAFF_THREAD : CM_THREAD, client: { id: t.clientOrg.id, name: t.clientOrg.name }, am: t.clientOrg.am?.name ?? null, messages: msgs, awaitingReply: me.type === 'staff' ? await this.awaiting(t, authors) : null, unread };
  }

  private async clientThread(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    const existing = await this.prisma.thread.findFirst({ where: { clientOrgId: me.clientOrg.id, type: CM_THREAD }, include, orderBy: { id: 'asc' } });
    if (existing) return existing;
    return this.prisma.thread.create({ data: { orgId: me.orgId, clientOrgId: me.clientOrg.id, type: CM_THREAD }, include });
  }

  /** The client's Owner chat, or null until the Founder has sent the first message. Clients never create it. */
  private async clientOwnerThread(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.prisma.thread.findFirst({ where: { clientOrgId: me.clientOrg.id, type: OWNER_THREAD, messages: { some: {} } }, include, orderBy: { id: 'asc' } });
  }

  /** v53: a chat a team member started with this client (once they have written in it). */
  private async clientStaffThread(me: Me, id: string) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.prisma.thread.findFirst({ where: { id, clientOrgId: me.clientOrg.id, type: CLIENT_STAFF_THREAD, messages: { some: { isInternal: false } } }, include });
  }

  async forClientStaff(me: Me, id: string) {
    const t = await this.clientStaffThread(me, id);
    if (!t) throw new NotFoundException('Chat not found');
    return this.view(me, t);
  }

  async forClient(me: Me) {
    return this.view(me, await this.clientThread(me));
  }

  async forClientOwner(me: Me) {
    const t = await this.clientOwnerThread(me);
    if (!t) throw new NotFoundException('BMU Owner has not messaged you yet');
    return this.view(me, t);
  }

  /** The client's chat list (WhatsApp style): BMU Owner (once they have written) and their Client Manager. Does not mark anything read. */
  async clientChats(me: Me): Promise<ClientChatList> {
    const cm = await this.clientThread(me);
    const owner = await this.clientOwnerThread(me);
    const rows = owner ? [owner, cm] : [cm];
    const unread = await unreadByThread(
      this.prisma,
      me,
      rows.map((t) => t.id),
    );
    const summary = async (t: Row) => {
      const authors = await this.authors(t.messages);
      const last = t.messages.filter((m) => !m.isInternal).at(-1);
      const a = last && authors.find((x) => x.id === last.authorId);
      return {
        lastMessage: last ? { body: (last.body || (last.attachments.length ? 'Sent an attachment' : '')).slice(0, 140), author: a?.name ?? '', at: last.createdAt.toISOString(), mine: last.authorId === me.id } : null,
        unread: unread.get(t.id) ?? 0,
      };
    };
    // v53: chats team members started with this client, with who it is and their department.
    const staffRows = await this.prisma.thread.findMany({ where: { clientOrgId: me.clientOrg!.id, type: CLIENT_STAFF_THREAD, messages: { some: { isInternal: false } } }, include });
    const starters = await this.prisma.user.findMany({ where: { id: { in: staffRows.map((t) => t.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true, department: { select: { name: true } } } });
    const staffUnread = await unreadByThread(this.prisma, me, staffRows.map((t) => t.id));
    const staff = [];
    for (const t of staffRows) {
      const who = starters.find((u) => u.id === t.createdById);
      const s = await summary(t);
      staff.push({ id: t.id, name: who?.name ?? 'BMU team', title: who?.department?.name ?? null, ...s, unread: staffUnread.get(t.id) ?? 0 });
    }
    staff.sort((a, b) => (b.lastMessage?.at ?? '').localeCompare(a.lastMessage?.at ?? ''));
    return {
      owner: owner ? await summary(owner) : null,
      am: { name: cm.clientOrg.am?.name ?? null, ...(await summary(cm)) },
      staff,
    };
  }

  /** Founder only: opens (or starts) the Owner chat with a client. */
  async ownerThreadFor(me: Me, clientOrgId: string) {
    if (!isFounder(me)) throw new ForbiddenException('Only the Founder has an Owner chat with clients');
    const client = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId }, select: { id: true } });
    if (!client) throw new NotFoundException('Client not found');
    const t =
      (await this.prisma.thread.findFirst({ where: { clientOrgId, type: OWNER_THREAD }, include, orderBy: { id: 'asc' } })) ??
      (await this.prisma.thread.create({ data: { orgId: me.orgId, clientOrgId, type: OWNER_THREAD }, include }));
    return this.view(me, t);
  }

  async list(me: Me): Promise<ThreadSummary[]> {
    // The Founder also sees their Owner chats that have messages (an opened but empty one stays out of the list).
    const types = isFounder(me) ? { OR: [{ type: CM_THREAD }, { type: OWNER_THREAD, messages: { some: {} } }] } : { type: CM_THREAD };
    const rows = await this.prisma.thread.findMany({ where: { AND: [await threadScope(me), types] }, include });
    const unread = await unreadByThread(
      this.prisma,
      me,
      rows.map((t) => t.id),
    );
    const out: ThreadSummary[] = [];
    for (const t of rows) {
      const authors = await this.authors(t.messages);
      const last = t.messages.filter((m) => !m.isInternal).at(-1);
      const a = last && authors.find((x) => x.id === last.authorId);
      out.push({
        id: t.id,
        kind: t.type === OWNER_THREAD ? OWNER_THREAD : CM_THREAD,
        client: { id: t.clientOrg.id, name: t.clientOrg.name },
        lastMessage: last ? { body: (last.body || (last.attachments.length ? 'Sent an attachment' : '')).slice(0, 140), author: a?.name ?? '', at: last.createdAt.toISOString(), isClient: a?.type === 'client' } : null,
        awaitingReply: await this.awaiting(t, authors),
        unread: unread.get(t.id) ?? 0,
      });
    }
    return out.sort((x, y) => (y.lastMessage?.at ?? '').localeCompare(x.lastMessage?.at ?? ''));
  }

  async get(me: Me, id: string) {
    const t = await this.prisma.thread.findFirst({ where: { AND: [{ id }, await threadScope(me)] }, include });
    if (!t) throw new NotFoundException('Thread not found');
    return this.view(me, t);
  }

  /** Staff: the thread by id (within their scope). Client: their Client Manager chat, or their Owner chat with `owner`. */
  private async threadFor(me: Me, threadId: string | null, owner = false) {
    const t = threadId && me.type === 'client'
      ? await this.clientStaffThread(me, threadId)
      : threadId
      ? await this.prisma.thread.findFirst({ where: { AND: [{ id: threadId }, await threadScope(me)] }, include })
      : owner
        ? await this.clientOwnerThread(me)
        : await this.clientThread(me);
    if (!t) throw new NotFoundException('Thread not found');
    return t;
  }

  /** Stores an uploaded file for a thread; it is attached when the message is sent. */
  async upload(me: Me, threadId: string | null, file: UploadedAttachment | undefined, storageRoot: string, owner = false) {
    if (!file) throw new BadRequestException('Choose a file to attach');
    const t = await this.threadFor(me, threadId, owner);
    const rel = file.path.startsWith(storageRoot) ? file.path.slice(storageRoot.length).replace(/^[/\\]+/, '') : file.path;
    const row = await this.prisma.file.create({
      data: { orgId: t.orgId, clientOrgId: t.clientOrgId, path: rel, kind: ATTACHMENT_KIND, name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, released: true },
    });
    await this.audit.log(me, 'message.attachment_uploaded', 'Thread', t.id, undefined, { fileId: row.id, name: row.name });
    return { id: row.id, name: row.name ?? 'file', url: `/api/thread-files/${row.id}`, mimeType: row.mimeType, sizeBytes: row.sizeBytes } satisfies ThreadAttachment;
  }

  /** A message attachment, if this person can see that thread (clients never see files on internal notes). */
  async attachmentFor(me: Me, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, orgId: me.orgId, kind: ATTACHMENT_KIND } });
    if (!file) throw new NotFoundException('File not found');
    if (me.type === 'client') {
      const msg = await this.prisma.message.findFirst({ where: { attachments: { has: fileId } }, select: { isInternal: true, authorId: true } });
      if (file.clientOrgId !== me.clientOrg?.id || (msg ? msg.isInternal : false)) throw new NotFoundException('File not found');
    } else {
      // v36: people who may see the file in Files (it was sent in the client conversation) can open it too.
      const msg = await this.prisma.message.findFirst({ where: { attachments: { has: fileId } }, select: { thread: { select: { type: true } } } });
      if (msg?.thread.type === OWNER_THREAD && !isFounder(me)) throw new NotFoundException('File not found');
      // v53: client chats started from Discussions: the people who may read that chat.
      if (msg?.thread.type === CLIENT_STAFF_THREAD) {
        const seen = await this.prisma.message.findFirst({ where: { attachments: { has: fileId }, thread: clientStaffWhere(me) }, select: { id: true } });
        if (seen) return file;
        throw new NotFoundException('File not found');
      }
      if (msg?.thread.type === CM_THREAD && canSeeFile(me, await fileScope(this.prisma, me), file)) return file;
      const scope = await threadScope(me).catch(() => null);
      const ok = scope && (await this.prisma.thread.findFirst({ where: { AND: [{ clientOrgId: file.clientOrgId ?? '' }, scope] }, select: { id: true } }));
      if (!ok) throw new NotFoundException('File not found');
    }
    return file;
  }

  async send(me: Me, threadId: string | null, body: string, internal: boolean, ip?: string, attachmentIds: string[] = [], owner = false) {
    const t = await this.threadFor(me, threadId, owner);
    const isOwnerChat = t.type === OWNER_THREAD;
    const isInternal = me.type === 'staff' && internal;
    const ids = [...new Set(attachmentIds)];
    if (ids.length) {
      const ok = await this.prisma.file.count({ where: { id: { in: ids }, orgId: t.orgId, clientOrgId: t.clientOrgId, kind: ATTACHMENT_KIND } });
      if (ok !== ids.length) throw new BadRequestException('One of the attachments could not be found. Attach it again.');
    }
    await this.prisma.message.create({ data: { orgId: t.orgId, threadId: t.id, authorId: me.id, body, isInternal, attachments: ids } });
    await this.audit.log(me, 'message.sent', 'Thread', t.id, undefined, { internal: isInternal, attachments: ids.length }, ip);
    const preview = (body || `Sent ${ids.length} attachment${ids.length === 1 ? '' : 's'}`).slice(0, 140);
    if (me.type === 'client' && t.type === CLIENT_STAFF_THREAD) {
      // v53: a reply in a chat a team member started: the people in it, except those reading it right now.
      const team = [...new Set([t.createdById, ...t.participantIds])].filter((x): x is string => !!x);
      const reading = await viewingNow(this.prisma, t.id, team);
      await this.notifications.notify(t.orgId, team.filter((x) => !reading.has(x)), { kind: 'message', title: `Message from ${me.name} (${t.clientOrg.name})`, body: preview, link: `/team/discussions/${t.id}` });
    } else if (me.type === 'client') {
      // Owner chat → the Founder(s); Client Manager chat → the client's CM.
      const to = isOwnerChat
        ? (await this.prisma.user.findMany({ where: { orgId: t.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } })).map((u) => u.id)
        : [t.clientOrg.am?.id];
      await this.notifications.notify(t.orgId, to, { kind: 'message', title: `Message from ${me.name} (${t.clientOrg.name})`, body: preview, link: `/team/messages/${t.id}` });
    } else if (!isInternal) {
      const clientUsers = await this.prisma.clientUser.findMany({ where: { clientOrgId: t.clientOrgId }, select: { userId: true } });
      await this.notifications.notify(t.orgId, clientUsers.map((c) => c.userId), { kind: 'message', title: `New message from ${me.name}`, body: preview, link: isOwnerChat ? '/client/messages?chat=owner' : '/client/messages' });
    }
    const fresh = await this.prisma.thread.findUniqueOrThrow({ where: { id: t.id }, include });
    return this.view(me, fresh);
  }
}
