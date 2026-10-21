import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { endOfWorkingDay, type Me, type ThreadAttachment, type ThreadMessage, type ThreadSummary, type ThreadView } from '@bmu/shared';
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

/** Staff who see client threads: their own clients for CMs, every client for leadership. */
export async function threadScope(me: Me): Promise<Prisma.ThreadWhereInput> {
  if (me.type !== 'staff') throw new ForbiddenException();
  if (isLeadership(me)) return { orgId: me.orgId };
  if (me.roles.includes('account_manager')) return { orgId: me.orgId, clientOrg: { amUserId: me.id } };
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
  if (me.type === 'client' && me.clientOrg) where = { clientOrgId: me.clientOrg.id, type: 'client_am' };
  else if (me.type === 'staff' && me.roles.includes('account_manager') && !isLeadership(me)) where = { orgId: me.orgId, type: 'client_am', clientOrg: { amUserId: me.id } };
  else if (me.type === 'staff' && isLeadership(me)) where = { orgId: me.orgId, type: 'client_am' };
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
    const files = await this.prisma.file.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, mimeType: true, sizeBytes: true } });
    return new Map(files.map((f) => [f.id, { id: f.id, name: f.name ?? 'file', url: `/api/thread-files/${f.id}`, mimeType: f.mimeType, sizeBytes: f.sizeBytes }]));
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
    return { id: t.id, client: { id: t.clientOrg.id, name: t.clientOrg.name }, am: t.clientOrg.am?.name ?? null, messages: msgs, awaitingReply: me.type === 'staff' ? await this.awaiting(t, authors) : null, unread };
  }

  private async clientThread(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    const existing = await this.prisma.thread.findFirst({ where: { clientOrgId: me.clientOrg.id, type: 'client_am' }, include, orderBy: { id: 'asc' } });
    if (existing) return existing;
    return this.prisma.thread.create({ data: { orgId: me.orgId, clientOrgId: me.clientOrg.id, type: 'client_am' }, include });
  }

  async forClient(me: Me) {
    return this.view(me, await this.clientThread(me));
  }

  async list(me: Me): Promise<ThreadSummary[]> {
    const rows = await this.prisma.thread.findMany({ where: { ...(await threadScope(me)), type: 'client_am' }, include });
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

  private async threadFor(me: Me, threadId: string | null) {
    const t = threadId ? await this.prisma.thread.findFirst({ where: { AND: [{ id: threadId }, await threadScope(me)] }, include }) : await this.clientThread(me);
    if (!t) throw new NotFoundException('Thread not found');
    return t;
  }

  /** Stores an uploaded file for a thread; it is attached when the message is sent. */
  async upload(me: Me, threadId: string | null, file: UploadedAttachment | undefined, storageRoot: string) {
    if (!file) throw new BadRequestException('Choose a file to attach');
    const t = await this.threadFor(me, threadId);
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
      if (msg?.thread.type === 'client_am' && canSeeFile(me, await fileScope(this.prisma, me), file)) return file;
      const scope = await threadScope(me).catch(() => null);
      const ok = scope && (await this.prisma.thread.findFirst({ where: { AND: [{ clientOrgId: file.clientOrgId ?? '' }, scope] }, select: { id: true } }));
      if (!ok) throw new NotFoundException('File not found');
    }
    return file;
  }

  async send(me: Me, threadId: string | null, body: string, internal: boolean, ip?: string, attachmentIds: string[] = []) {
    const t = await this.threadFor(me, threadId);
    const isInternal = me.type === 'staff' && internal;
    const ids = [...new Set(attachmentIds)];
    if (ids.length) {
      const ok = await this.prisma.file.count({ where: { id: { in: ids }, orgId: t.orgId, clientOrgId: t.clientOrgId, kind: ATTACHMENT_KIND } });
      if (ok !== ids.length) throw new BadRequestException('One of the attachments could not be found. Attach it again.');
    }
    await this.prisma.message.create({ data: { orgId: t.orgId, threadId: t.id, authorId: me.id, body, isInternal, attachments: ids } });
    await this.audit.log(me, 'message.sent', 'Thread', t.id, undefined, { internal: isInternal, attachments: ids.length }, ip);
    const preview = (body || `Sent ${ids.length} attachment${ids.length === 1 ? '' : 's'}`).slice(0, 140);
    if (me.type === 'client') {
      await this.notifications.notify(t.orgId, [t.clientOrg.am?.id], { kind: 'message', title: `Message from ${me.name} (${t.clientOrg.name})`, body: preview, link: `/team/messages/${t.id}` });
    } else if (!isInternal) {
      const clientUsers = await this.prisma.clientUser.findMany({ where: { clientOrgId: t.clientOrgId }, select: { userId: true } });
      await this.notifications.notify(t.orgId, clientUsers.map((c) => c.userId), { kind: 'message', title: `New message from ${me.name}`, body: preview, link: '/client/messages' });
    }
    const fresh = await this.prisma.thread.findUniqueOrThrow({ where: { id: t.id }, include });
    return this.view(me, fresh);
  }
}
