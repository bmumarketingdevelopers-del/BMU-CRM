// v17 meetings: each team member has a booking page (working days and hours, notice period). Clients book their
// Account Manager from the portal, anyone can book from the public link (which links or creates a lead), and the
// team adds meetings by hand. After the meeting, notes become a summary and action items (AI or basic), and action
// items become tasks in one click. Calendar sync is not built: an .ics link adds the meeting to any calendar.
import { createHmac } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  basicActionItems,
  basicSummary,
  bookingPageSchema,
  meetingBookSchema,
  meetingCreateSchema,
  meetingNotesSchema,
  meetingTasksSchema,
  publicBookingSchema,
  type BookingPageView,
  type BookingSlots,
  type Me,
  type MeetingList,
  type MeetingView,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { appUrl, EmailService } from '../service/email.service.js';
import { AiService, jsonOf, textOf } from '../ai/ai.service.js';
import { clientScope, inScope, isLeadership } from '../creative/scope.js';
import { createInboundLead, findDuplicateLead } from '../leads/inbound-lead.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

type MeetingRec = Prisma.MeetingGetPayload<object>;
type BookingRec = Prisma.BookingPageGetPayload<object>;

const IST = 330 * 60_000;
const DAY = 86_400_000;
const SLOT_DAYS = 14;
const SECRET = () => process.env.JWT_SECRET ?? 'dev-only-change-me';
const leadName = (contact: unknown) => {
  const c = (contact ?? {}) as { name?: string; company?: string };
  return c.company || c.name || 'Lead';
};
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const istLabel = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'meet';

/** Signed link token so a guest can download the calendar file without signing in. */
export const icsToken = (id: string) => createHmac('sha256', SECRET()).update(`ics:${id}`).digest('hex').slice(0, 32);

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

@Injectable()
export class MeetingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Meetings');
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly ai: AiService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'comms.meeting_reminders', hint: 'Meeting reminders', everyMs: 60_000, run: () => this.remind() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  // ------------------------------------------------------------------------------------------------ booking pages

  private bookingView(b: BookingRec): BookingPageView {
    return { slug: b.slug, title: b.title, durationMin: b.durationMin, days: b.days, startTime: b.startTime, endTime: b.endTime, noticeHours: b.noticeHours, active: b.active, url: appUrl(`/book/${b.slug}`) };
  }

  /** The user's booking page, created with sensible defaults the first time. */
  async ensureBookingPage(orgId: string, userId: string): Promise<BookingRec> {
    const found = await this.prisma.bookingPage.findUnique({ where: { userId } });
    if (found) return found;
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    const base = slugify(u.name);
    let slug = base;
    for (let i = 2; await this.prisma.bookingPage.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
    return this.prisma.bookingPage.create({ data: { orgId, userId, slug, title: `Call with ${u.name.split(' ')[0]}` } });
  }

  private assertStaff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  }

  async bookingPage(me: Me): Promise<BookingPageView> {
    this.assertStaff(me);
    return this.bookingView(await this.ensureBookingPage(me.orgId, me.id));
  }

  async saveBookingPage(me: Me, body: unknown, ip?: string): Promise<BookingPageView> {
    this.assertStaff(me);
    const input = parse(bookingPageSchema, body);
    if (minutes(input.endTime) - minutes(input.startTime) < input.durationMin) throw new BadRequestException('End time must be at least one meeting after the start time');
    const before = await this.ensureBookingPage(me.orgId, me.id);
    const after = await this.prisma.bookingPage.update({ where: { id: before.id }, data: { ...input, days: [...new Set(input.days)].sort() } });
    await this.audit.log(me, 'booking_page.updated', 'BookingPage', after.id, this.bookingView(before), this.bookingView(after), ip);
    return this.bookingView(after);
  }

  // ------------------------------------------------------------------------------------------------ free slots

  private async freeSlots(b: BookingRec, now = new Date()): Promise<{ day: string; slots: string[] }[]> {
    const from = new Date(now.getTime() + b.noticeHours * 3_600_000);
    const until = new Date(now.getTime() + (SLOT_DAYS + 1) * DAY);
    const busy = await this.prisma.meeting.findMany({ where: { hostId: b.userId, status: 'booked', endAt: { gt: now }, startAt: { lt: until } }, select: { startAt: true, endAt: true } });
    const leave = await this.prisma.leaveRequest.findMany({ where: { userId: b.userId, status: 'approved', to: { gte: new Date(now.getTime() - DAY) }, from: { lte: until } }, select: { from: true, to: true } });
    const out: { day: string; slots: string[] }[] = [];
    const todayIst = new Date(Math.floor((now.getTime() + IST) / DAY) * DAY); // midnight IST, as a UTC-shifted date
    for (let i = 0; i < SLOT_DAYS; i++) {
      const dayStart = new Date(todayIst.getTime() + i * DAY); // UTC fields = IST calendar day
      const dow = dayStart.getUTCDay() === 0 ? 7 : dayStart.getUTCDay();
      if (!b.days.includes(dow)) continue;
      const dayKey = dayStart.toISOString().slice(0, 10);
      const midnight = dayStart.getTime() - IST; // real instant of IST midnight
      if (leave.some((l) => l.from.toISOString().slice(0, 10) <= dayKey && l.to.toISOString().slice(0, 10) >= dayKey)) continue;
      const slots: string[] = [];
      for (let m = minutes(b.startTime); m + b.durationMin <= minutes(b.endTime); m += b.durationMin) {
        const s = new Date(midnight + m * 60_000);
        const e = new Date(s.getTime() + b.durationMin * 60_000);
        if (s < from) continue;
        if (busy.some((x) => x.startAt < e && x.endAt > s)) continue;
        slots.push(s.toISOString());
      }
      if (slots.length) out.push({ day: dayKey, slots });
    }
    return out;
  }

  private async slotsView(b: BookingRec): Promise<BookingSlots> {
    const host = await this.prisma.user.findUniqueOrThrow({ where: { id: b.userId }, select: { name: true, roles: { select: { role: { select: { name: true } } }, take: 1 } } });
    return { host: { name: host.name, title: host.roles[0]?.role.name ?? null }, title: b.title, durationMin: b.durationMin, days: await this.freeSlots(b) };
  }

  private async assertFree(b: BookingRec, startAt: Date) {
    const days = await this.freeSlots(b);
    if (!days.some((d) => d.slots.includes(startAt.toISOString()))) throw new ConflictException('That time is no longer free. Please pick another slot.');
  }

  // ------------------------------------------------------------------------------------------------ views

  private async views(me: Me | null, list: MeetingRec[]): Promise<MeetingView[]> {
    const ids = (k: 'hostId' | 'clientOrgId' | 'leadId') => [...new Set(list.map((m) => m[k]).filter((x): x is string => !!x))];
    const [hosts, clients, leads] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids('hostId') } }, select: { id: true, name: true } }),
      this.prisma.clientOrg.findMany({ where: { id: { in: ids('clientOrgId') } }, select: { id: true, name: true } }),
      me?.type === 'staff' ? this.prisma.lead.findMany({ where: { id: { in: ids('leadId') } }, select: { id: true, contact: true } }) : [],
    ]);
    return list.map((m) => {
      const lead = leads.find((l) => l.id === m.leadId);
      const staff = me?.type === 'staff';
      const mine = staff && (m.hostId === me.id || isLeadership(me));
      const clientCan = me?.type === 'client' && m.status === 'booked' && m.startAt > new Date() && me.clientOrg?.role !== 'client_viewer';
      return {
        id: m.id,
        title: m.title,
        startAt: m.startAt.toISOString(),
        endAt: m.endAt.toISOString(),
        host: hosts.find((h) => h.id === m.hostId) ?? { id: m.hostId, name: 'BMU team' },
        client: clients.find((c) => c.id === m.clientOrgId) ?? null,
        lead: lead ? { id: lead.id, name: leadName(lead.contact) } : null,
        guest: { name: m.guestName, email: staff ? m.guestEmail : null, phone: staff ? m.guestPhone : null },
        agenda: m.agenda,
        location: m.location,
        status: m.status as MeetingView['status'],
        bookedVia: m.bookedVia as MeetingView['bookedVia'],
        // Clients see the summary and action items, never the team's raw notes.
        notes: staff ? m.notes : null,
        summary: m.summary,
        actionItems: Array.isArray(m.actionItems) ? (m.actionItems as { text: string; taskId?: string | null }[]).map((a) => ({ text: a.text, taskId: staff ? (a.taskId ?? null) : null })) : [],
        can: { edit: !!mine, cancel: m.status === 'booked' && (!!mine || clientCan) },
      };
    });
  }

  private async view(me: Me | null, m: MeetingRec) {
    return (await this.views(me, [m]))[0];
  }

  private split(list: MeetingView[]) {
    const now = Date.now();
    const upcoming = list.filter((m) => m.status === 'booked' && new Date(m.endAt).getTime() >= now).sort((a, b) => a.startAt.localeCompare(b.startAt));
    const past = list.filter((m) => !upcoming.includes(m)).sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { upcoming, past: past.slice(0, 50) };
  }

  // ------------------------------------------------------------------------------------------------ team

  private async loadForStaff(me: Me, id: string) {
    this.assertStaff(me);
    const m = await this.prisma.meeting.findFirst({ where: { id, orgId: me.orgId } });
    if (!m) throw new NotFoundException('Meeting not found');
    if (m.hostId !== me.id && !isLeadership(me)) {
      const scope = await clientScope(this.prisma, me);
      if (!(m.clientOrgId && inScope(scope, m.clientOrgId))) throw new NotFoundException('Meeting not found');
    }
    return m;
  }

  private assertEdit(me: Me, m: MeetingRec) {
    if (m.hostId !== me.id && !isLeadership(me)) throw new ForbiddenException('Only the host can change this meeting');
  }

  async list(me: Me): Promise<MeetingList> {
    this.assertStaff(me);
    const where: Prisma.MeetingWhereInput = { orgId: me.orgId, startAt: { gte: new Date(Date.now() - 60 * DAY) } };
    if (!isLeadership(me)) where.hostId = me.id;
    const list = await this.prisma.meeting.findMany({ where, orderBy: { startAt: 'asc' }, take: 300 });
    return { ...this.split(await this.views(me, list)), booking: await this.bookingPage(me) };
  }

  async get(me: Me, id: string) {
    if (me.type === 'client') {
      const m = await this.prisma.meeting.findFirst({ where: { id, orgId: me.orgId, clientOrgId: me.clientOrg?.id ?? '-' } });
      if (!m) throw new NotFoundException('Meeting not found');
      return this.view(me, m);
    }
    return this.view(me, await this.loadForStaff(me, id));
  }

  async create(me: Me, body: unknown, ip?: string) {
    this.assertStaff(me);
    const input = parse(meetingCreateSchema, body);
    const startAt = new Date(input.startAt);
    if (input.clientOrgId && !(await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId }, select: { id: true } }))) throw new BadRequestException('Client not found');
    const lead = input.leadId ? await this.prisma.lead.findFirst({ where: { id: input.leadId, orgId: me.orgId }, select: { id: true, contact: true } }) : null;
    if (input.leadId && !lead) throw new BadRequestException('Lead not found');
    const contact = (lead?.contact ?? {}) as { name?: string; email?: string; phone?: string };
    const m = await this.prisma.meeting.create({
      data: {
        orgId: me.orgId,
        title: input.title,
        hostId: me.id,
        startAt,
        endAt: new Date(startAt.getTime() + input.durationMin * 60_000),
        clientOrgId: input.clientOrgId ?? null,
        leadId: input.leadId ?? null,
        bookedById: me.id,
        guestName: contact.name ?? null,
        guestEmail: contact.email ?? null,
        guestPhone: contact.phone ?? null,
        agenda: input.agenda || null,
        location: input.location || null,
        bookedVia: 'team',
      },
    });
    await this.audit.log(me, 'meeting.created', 'Meeting', m.id, null, { title: m.title, startAt: m.startAt }, ip);
    if (m.leadId) await this.prisma.leadActivity.create({ data: { orgId: me.orgId, leadId: m.leadId, kind: 'meeting', body: `Meeting booked for ${istLabel(m.startAt)}: ${m.title}` } });
    return this.view(me, m);
  }

  async saveNotes(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadForStaff(me, id);
    this.assertEdit(me, m);
    const input = parse(meetingNotesSchema, body);
    const after = await this.prisma.meeting.update({
      where: { id },
      data: {
        notes: input.notes ?? undefined,
        summary: input.summary === undefined ? undefined : input.summary,
        actionItems: input.actionItems ? input.actionItems.map((a) => ({ text: a.text, taskId: a.taskId ?? null })) : undefined,
        status: input.status ?? undefined,
      },
    });
    if (input.status === 'done' && m.status !== 'done') {
      await this.audit.log(me, 'meeting.done', 'Meeting', id, { status: m.status }, { status: 'done' }, ip);
      if (m.leadId) await this.prisma.leadActivity.create({ data: { orgId: me.orgId, leadId: m.leadId, kind: 'meeting', body: `Meeting held: ${m.title}${after.summary ? `. ${after.summary}` : ''}`.slice(0, 4000) } });
    }
    return this.view(me, after);
  }

  /** Summary and action items from the notes: AI when connected, otherwise simple rules. */
  async summarise(me: Me, id: string) {
    const m = await this.loadForStaff(me, id);
    this.assertEdit(me, m);
    const notes = (m.notes ?? '').trim();
    if (notes.length < 20) throw new BadRequestException('Write a few lines of notes first');
    const basic = { summary: basicSummary(notes) || notes.slice(0, 300), actionItems: basicActionItems(notes) };
    let out = basic;
    let isBasic = true;
    try {
      const r = await this.ai.execute({ orgId: me.orgId, userId: me.id, me }, 'meeting_notes', {
        target: { type: 'Meeting', id },
        basic: () => ({ text: basic.summary, data: { kind: 'meeting_notes', value: { summary: basic.summary, actions: basic.actionItems, followUpDate: null } } }),
        ai: async (run) => {
          const msg = await run({
            fast: true,
            system: 'You turn meeting notes from BMU Marketing (a marketing agency in Bengaluru) into a short summary and clear action items. Use only what the notes say.',
            messages: [{ role: 'user', content: `Meeting: ${m.title}\n\nNotes:\n<notes>\n${notes.slice(0, 12_000)}\n</notes>\n\nReturn JSON: summary (3-5 sentences), actions (short imperative lines, with an owner if the notes name one), followUpDate (YYYY-MM-DD or null).` }],
            maxTokens: 2000,
            schema: {
              type: 'object',
              properties: { summary: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } }, followUpDate: { type: ['string', 'null'] } },
              required: ['summary', 'actions', 'followUpDate'],
              additionalProperties: false,
            },
          });
          const j = jsonOf<{ summary: string; actions: string[]; followUpDate: string | null }>(msg);
          if (!j) return { text: textOf(msg) };
          return { text: j.summary, data: { kind: 'meeting_notes', value: j } };
        },
      });
      const v = (r.data as { value?: { summary?: string; actions?: string[] } } | null)?.value;
      if (r.mode === 'ai' && v?.summary) {
        out = { summary: v.summary, actionItems: (v.actions ?? []).slice(0, 30) };
        isBasic = false;
      }
    } catch (e) {
      this.log.warn(`Summary fell back: ${(e as Error).message}`);
    }
    return { ...out, basic: isBasic };
  }

  /** Turns chosen action items into tasks owned by the host (or the project's team when a project is picked). */
  async createTasks(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadForStaff(me, id);
    this.assertEdit(me, m);
    const input = parse(meetingTasksSchema, body);
    const items = (Array.isArray(m.actionItems) ? m.actionItems : []) as { text: string; taskId?: string | null }[];
    let engagementId: string | null = input.engagementId ?? null;
    if (engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: me.orgId }, select: { id: true } });
      if (!e) throw new BadRequestException('Project not found');
    } else if (m.clientOrgId) {
      engagementId = (await this.prisma.engagement.findFirst({ where: { clientOrgId: m.clientOrgId, status: { notIn: ['delivered', 'closed', 'offboarding', 'pending_payment'] } }, orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id ?? null;
    }
    const deadline = new Date(Date.now() + 2 * DAY);
    let made = 0;
    for (const i of input.items) {
      const item = items[i];
      if (!item || item.taskId) continue;
      const t = await this.prisma.task.create({
        data: { orgId: me.orgId, title: item.text.slice(0, 200), ownerId: me.id, engagementId, isInternal: !engagementId, deadline, description: `From the meeting "${m.title}" on ${istLabel(m.startAt)}.` },
      });
      item.taskId = t.id;
      made++;
    }
    if (!made) throw new BadRequestException('Those action items already have tasks');
    const after = await this.prisma.meeting.update({ where: { id }, data: { actionItems: items.map((a) => ({ text: a.text, taskId: a.taskId ?? null })) } });
    await this.audit.log(me, 'meeting.tasks_created', 'Meeting', id, null, { count: made }, ip);
    return this.view(me, after);
  }

  async cancel(me: Me, id: string, ip?: string) {
    const m = me.type === 'client' ? await this.prisma.meeting.findFirst({ where: { id, orgId: me.orgId, clientOrgId: me.clientOrg?.id ?? '-' } }) : await this.loadForStaff(me, id);
    if (!m) throw new NotFoundException('Meeting not found');
    const v = await this.view(me, m);
    if (!v.can.cancel) throw new ForbiddenException('This meeting cannot be cancelled');
    const after = await this.prisma.meeting.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    await this.audit.log(me, 'meeting.cancelled', 'Meeting', id, { status: m.status }, { status: 'cancelled' }, ip);
    const who = me.type === 'client' ? `${me.name} (${me.clientOrg?.name ?? 'client'})` : me.name;
    if (m.hostId !== me.id) await this.notifications.notify(m.orgId, [m.hostId], { kind: 'meeting', title: `Meeting cancelled: ${m.title}`, body: `${who} cancelled ${istLabel(m.startAt)}.`, link: '/team/meetings' });
    if (me.type === 'staff' && m.guestEmail) {
      await this.email.send({ orgId: m.orgId, to: m.guestEmail, toName: m.guestName, subject: `Cancelled: ${m.title}`, paragraphs: [`Hi ${m.guestName?.split(' ')[0] ?? 'there'},`, `Our meeting on ${istLabel(m.startAt)} (IST) is cancelled. ${me.name} will be in touch to find a new time.`], kind: 'meeting', entity: 'Meeting', entityId: m.id });
    }
    return this.view(me, after);
  }

  // ------------------------------------------------------------------------------------------------ client portal

  private async clientAm(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    const c = await this.prisma.clientOrg.findUnique({ where: { id: me.clientOrg.id }, select: { amUserId: true } });
    return c?.amUserId ?? null;
  }

  async clientList(me: Me): Promise<MeetingList & { am: { name: string } | null }> {
    const amId = await this.clientAm(me);
    const list = await this.prisma.meeting.findMany({ where: { orgId: me.orgId, clientOrgId: me.clientOrg!.id, startAt: { gte: new Date(Date.now() - 120 * DAY) } }, orderBy: { startAt: 'asc' }, take: 100 });
    const am = amId ? await this.prisma.user.findUnique({ where: { id: amId }, select: { name: true } }) : null;
    return { ...this.split(await this.views(me, list)), booking: null, am: am ? { name: am.name } : null };
  }

  async clientSlots(me: Me): Promise<BookingSlots> {
    const amId = await this.clientAm(me);
    if (!amId) throw new BadRequestException('Your Account Manager is not set yet. Message BMU and we will set up a call.');
    return this.slotsView(await this.ensureBookingPage(me.orgId, amId));
  }

  async clientBook(me: Me, body: unknown, ip?: string) {
    const amId = await this.clientAm(me);
    if (!amId) throw new BadRequestException('Your Account Manager is not set yet');
    if (me.clientOrg!.role === 'client_viewer') throw new ForbiddenException('Ask your company admin to book calls');
    const input = parse(meetingBookSchema, body);
    const b = await this.ensureBookingPage(me.orgId, amId);
    const startAt = new Date(input.startAt);
    await this.assertFree(b, startAt);
    const m = await this.prisma.meeting.create({
      data: {
        orgId: me.orgId,
        title: `${me.clientOrg!.name} call`,
        hostId: amId,
        startAt,
        endAt: new Date(startAt.getTime() + b.durationMin * 60_000),
        clientOrgId: me.clientOrg!.id,
        bookedById: me.id,
        guestName: me.name,
        guestEmail: me.email,
        guestPhone: me.phone,
        agenda: input.agenda || null,
        bookedVia: 'client',
      },
    });
    await this.audit.log(me, 'meeting.booked', 'Meeting', m.id, null, { startAt: m.startAt, via: 'client' }, ip);
    await this.notifications.notify(me.orgId, [amId], { kind: 'meeting', title: `${me.clientOrg!.name} booked a call`, body: `${me.name}, ${istLabel(startAt)}${input.agenda ? `: ${input.agenda.slice(0, 120)}` : ''}`, link: '/team/meetings' });
    await this.confirm(m, b);
    return this.view(me, m);
  }

  // ------------------------------------------------------------------------------------------------ public booking

  private async publicPage(slug: string) {
    const b = await this.prisma.bookingPage.findUnique({ where: { slug } });
    if (!b || !b.active) throw new NotFoundException('This booking link is not active');
    const host = await this.prisma.user.findUnique({ where: { id: b.userId }, select: { deletedAt: true } });
    if (!host || host.deletedAt) throw new NotFoundException('This booking link is not active');
    return b;
  }

  async publicSlots(slug: string) {
    return this.slotsView(await this.publicPage(slug));
  }

  async publicBook(slug: string, body: unknown, ip?: string) {
    const b = await this.publicPage(slug);
    const input = parse(publicBookingSchema, body);
    const startAt = new Date(input.startAt);
    // A small guard against someone filling the calendar: at most 3 upcoming bookings per email.
    const mine = await this.prisma.meeting.count({ where: { orgId: b.orgId, guestEmail: input.email.toLowerCase(), status: 'booked', startAt: { gte: new Date() } } });
    if (mine >= 3) throw new ConflictException('You already have calls booked with us. Reply to the confirmation email to change one.');
    await this.assertFree(b, startAt);
    const host = await this.prisma.user.findUniqueOrThrow({ where: { id: b.userId }, select: { name: true } });
    // Known client person? Book it against their company. Otherwise link (or create) a lead.
    const clientUser = await this.prisma.clientUser.findFirst({ where: { user: { orgId: b.orgId, email: input.email.toLowerCase(), deletedAt: null } }, select: { clientOrgId: true } }).catch(() => null);
    let leadId: string | null = null;
    if (!clientUser) {
      const dup = await findDuplicateLead(this.prisma, b.orgId, input.email, input.phone);
      const lead =
        dup && !['won', 'lost'].includes(dup.stage)
          ? dup
          : await createInboundLead(
              { prisma: this.prisma, audit: this.audit, notifications: this.notifications },
              { orgId: b.orgId, source: 'booking', name: input.name, email: input.email.toLowerCase(), phone: input.phone || null, company: input.company || null, need: input.agenda || 'Booked a call from the booking link', budgetPaise: null, serviceIds: [], via: `Booking link (${host.name})` },
            );
      leadId = lead.id;
      if (!lead.ownerId) await this.prisma.lead.update({ where: { id: lead.id }, data: { ownerId: b.userId } });
      await this.prisma.leadActivity.create({ data: { orgId: b.orgId, leadId, kind: 'meeting', body: `Booked a call for ${istLabel(startAt)} from the booking link${input.agenda ? `: ${input.agenda}` : ''}`.slice(0, 4000) } });
    }
    const m = await this.prisma.meeting.create({
      data: {
        orgId: b.orgId,
        title: `Call with ${input.company || input.name}`,
        hostId: b.userId,
        startAt,
        endAt: new Date(startAt.getTime() + b.durationMin * 60_000),
        clientOrgId: clientUser?.clientOrgId ?? null,
        leadId,
        guestName: input.name,
        guestEmail: input.email.toLowerCase(),
        guestPhone: input.phone || null,
        agenda: input.agenda || null,
        bookedVia: 'public',
      },
    });
    await this.audit.logSystem(b.orgId, 'meeting.booked', 'Meeting', m.id, { startAt: m.startAt, via: 'public', ip: ip ? 'recorded' : null });
    await this.notifications.notify(b.orgId, [b.userId], { kind: 'meeting', title: `New call booked: ${input.company || input.name}`, body: istLabel(startAt), link: '/team/meetings' });
    await this.confirm(m, b);
    return { ok: true as const, startAt: m.startAt.toISOString(), host: host.name };
  }

  /** Confirmation email to the guest with an "Add to calendar" link. */
  private async confirm(m: MeetingRec, b: BookingRec) {
    if (!m.guestEmail) return;
    const host = await this.prisma.user.findUnique({ where: { id: m.hostId }, select: { name: true } });
    await this.email.send({
      orgId: m.orgId,
      to: m.guestEmail,
      toName: m.guestName,
      subject: `Booked: ${b.title}, ${istLabel(m.startAt)}`,
      heading: 'Your call is booked',
      paragraphs: [`Hi ${m.guestName?.split(' ')[0] ?? 'there'},`, `You're booked with ${host?.name ?? 'BMU Marketing'} on ${istLabel(m.startAt)} (IST) for ${b.durationMin} minutes.`, 'We will send the meeting link before the call.'],
      button: { label: 'Add to calendar', url: this.icsUrl(m.id) },
      kind: 'meeting',
      entity: 'Meeting',
      entityId: m.id,
    });
  }

  icsUrl(id: string) {
    return appUrl(`/api/public/meetings/${id}/ics?t=${icsToken(id)}`);
  }

  async ics(id: string, token: string) {
    if (!token || token !== icsToken(id)) throw new NotFoundException('Calendar file not found');
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Calendar file not found');
    const host = await this.prisma.user.findUnique({ where: { id: m.hostId }, select: { name: true, email: true } });
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BMU Marketing//BMU Hub//EN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${m.id}@bmu-hub`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(m.startAt)}`,
      `DTEND:${icsDate(m.endAt)}`,
      `SUMMARY:${icsText(m.title)}`,
      `DESCRIPTION:${icsText([`With ${host?.name ?? 'BMU Marketing'}`, m.agenda ?? ''].filter(Boolean).join('\n'))}`,
      m.location ? `LOCATION:${icsText(m.location)}` : '',
      host?.email ? `ORGANIZER;CN=${icsText(host.name)}:mailto:${host.email}` : '',
      `STATUS:${m.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean);
    return lines.join('\r\n');
  }

  // ------------------------------------------------------------------------------------------------ reminders

  /** One hour before: remind the host (in the app) and the guest (email). */
  async remind(now = new Date()) {
    const due = await this.prisma.meeting.findMany({ where: { status: 'booked', reminderAt: null, startAt: { gt: now, lte: new Date(now.getTime() + 3_600_000) } }, take: 50 });
    for (const m of due) {
      const claimed = await this.prisma.meeting.updateMany({ where: { id: m.id, reminderAt: null }, data: { reminderAt: now } });
      if (!claimed.count) continue;
      await this.notifications.notify(m.orgId, [m.hostId], { kind: 'meeting', title: `Starting soon: ${m.title}`, body: istLabel(m.startAt), link: '/team/meetings' });
      if (m.guestEmail && m.bookedVia !== 'team') {
        await this.email.send({ orgId: m.orgId, to: m.guestEmail, toName: m.guestName, subject: `Reminder: ${m.title} at ${istLabel(m.startAt)}`, paragraphs: [`Hi ${m.guestName?.split(' ')[0] ?? 'there'}, a reminder that our call starts at ${istLabel(m.startAt)} (IST).`], button: { label: 'Add to calendar', url: this.icsUrl(m.id) }, kind: 'meeting', entity: 'Meeting', entityId: m.id });
      }
    }
    return due.length;
  }
}
