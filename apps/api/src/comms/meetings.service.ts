// v17 meetings: each team member has a booking page (working days and hours, notice period). Clients book their
// Client Manager from the portal, anyone can book from the public link (which links or creates a lead), and the
// team adds meetings by hand. After the meeting, notes become a summary and action items (AI or basic), and action
// items become tasks in one click. An .ics link adds the meeting to any calendar.
// v23 Google Meet: when the host has connected their Google Workspace calendar, every fixed meeting they host (a
// client's request once the Client Manager fixes it, a meeting the team adds, a call booked from the portal or the
// booking link) becomes a Google Calendar event with a Google Meet link in joinUrl, and Google emails the invitations.
// People added later (team members, Branch Manager) are added to the event; cancelling cancels it. Replies are read
// back every 15 minutes. Without a connected calendar everything works as before (the link can be pasted by hand).
import { createHmac, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  basicActionItems,
  basicSummary,
  bookingPageSchema,
  founderMeetingSchema,
  meetingArrangeSchema,
  meetingBookSchema,
  meetingCreateSchema,
  meetingFixSchema,
  meetingJoinSchema,
  meetingLinkSchema,
  meetingMembersSchema,
  meetingNotesSchema,
  meetingRequestSchema,
  meetingRespondSchema,
  meetingTasksSchema,
  publicBookingSchema,
  type BookingPageView,
  type BookingSlots,
  type CalendarConnectionView,
  type Me,
  type MeetingAttendeeResponse,
  type MeetingPerson,
  type MeetingArrangeOptions,
  type MeetingList,
  type MeetingParticipantRole,
  type MeetingParticipantStatus,
  type MeetingView,
  zonedDay,
  zonedLabel,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { appUrl, EmailService } from '../service/email.service.js';
import { AiService, jsonOf, textOf } from '../ai/ai.service.js';
import { clientScope, hasRole, inScope, isLeadership } from '../creative/scope.js';
import { createInboundLead, findDuplicateLead } from '../leads/inbound-lead.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';
import { apiPublicUrl } from '../integrations/integrations.service.js';
import {
  calendarAuthUrl,
  calendarAvailable,
  calendarReplies,
  calendarToken,
  cancelCalendarEvent,
  createCalendarEvent,
  setCalendarAttendees,
  type CalendarAttendee,
} from '../integrations/google-calendar.js';

type MeetingRec = Prisma.MeetingGetPayload<object>;
type BookingRec = Prisma.BookingPageGetPayload<object>;
type ParticipantRec = Prisma.MeetingParticipantGetPayload<object>;
type AttendeeRec = Prisma.MeetingAttendeeGetPayload<object>;
/** v23 Google Meet: someone outside the team invited to a meeting. */
type Invitee = { userId: string | null; email: string; name: string; kind: 'client' | 'guest' };

/** v23: a request still being arranged by the Client Manager. */
const OPEN = ['requested', 'awaiting'];
/** v23: people who confirm a client meeting before it is fixed. */
const APPROVERS: MeetingParticipantRole[] = ['founder', 'department_head'];

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
  private repliesJob?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly ai: AiService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'comms.meeting_reminders', hint: 'Meeting reminders', everyMs: 60_000, run: () => this.remind() });
    this.repliesJob = startJob({ name: 'comms.meeting_replies', hint: 'Reads Google Calendar replies (accepted / declined) for upcoming meetings', everyMs: 15 * 60_000, run: () => this.syncReplies() });
  }

  onModuleDestroy() {
    this.job?.stop();
    this.repliesJob?.stop();
  }

  // ------------------------------------------------------------------------------------------------ Google Calendar

  /** My Google Calendar connection (meetings I host get a Google Meet link when connected). */
  async googleStatus(me: Me): Promise<CalendarConnectionView> {
    this.assertStaff(me);
    const c = await this.prisma.calendarConnection.findUnique({ where: { userId: me.id } });
    const connected = !!c && c.status === 'connected' && !!c.refreshEnc;
    return { available: calendarAvailable(), connected, email: c && c.status !== 'disconnected' ? c.email : null, status: (c?.status ?? null) as CalendarConnectionView['status'], error: c?.status === 'error' ? c.lastError : null };
  }

  /** The Google sign-in link for connecting my calendar. */
  async googleConnect(me: Me) {
    this.assertStaff(me);
    if (!calendarAvailable()) throw new BadRequestException('Google Calendar is not set up on the server yet: add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and INTEGRATIONS_KEY in Vercel (see the setup guide).');
    return { url: calendarAuthUrl(me.orgId, me.id, `${apiPublicUrl()}/integrations/oauth/callback`, randomBytes(6).toString('hex')) };
  }

  async googleDisconnect(me: Me, ip?: string): Promise<CalendarConnectionView> {
    this.assertStaff(me);
    const c = await this.prisma.calendarConnection.findUnique({ where: { userId: me.id } });
    if (c) {
      const token = await calendarToken(this.prisma, me.id).catch(() => null);
      // Best effort: also withdraw the access at Google.
      if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      await this.prisma.calendarConnection.update({ where: { id: c.id }, data: { status: 'disconnected', tokenEnc: null, refreshEnc: null, tokenExpiresAt: null } });
      await this.audit.log(me, 'calendar.disconnected', 'User', me.id, { email: c.email }, null, ip);
    }
    return this.googleStatus(me);
  }

  /** Team members who can be invited to a meeting. */
  async people(me: Me): Promise<MeetingPerson[]> {
    this.assertStaff(me);
    const rows = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null }, select: { id: true, name: true, department: { select: { name: true } } }, orderBy: { name: 'asc' } });
    return rows.map((u) => ({ id: u.id, name: u.name, department: u.department?.name ?? null }));
  }

  /** Team members picked for a meeting the team adds (they join as participants: "Team member", invited). */
  private async teamInvitees(orgId: string, hostId: string, attendeeIds: string[]) {
    const ids = [...new Set(attendeeIds.filter((id) => id !== hostId))];
    if (!ids.length) return [];
    const team = await this.prisma.user.findMany({ where: { id: { in: ids }, orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } }, select: { id: true } });
    if (team.length !== ids.length) throw new BadRequestException('Pick team members from your organisation');
    return ids;
  }

  /**
   * People outside the team to invite, by the same rule as the meeting emails: the person who asked (or the lead /
   * guest), otherwise everyone at the client with a portal login.
   */
  private async outsiders(m: MeetingRec): Promise<Invitee[]> {
    const out: Invitee[] = [];
    const add = (i: Invitee) => {
      const email = i.email.trim().toLowerCase();
      if (email && !out.some((o) => o.email === email)) out.push({ ...i, email });
    };
    const clientUsers = await this.clientPeople(m.clientOrgId);
    if (m.guestEmail) {
      const u = clientUsers.find((c) => c.email?.toLowerCase() === m.guestEmail!.toLowerCase());
      add({ userId: u?.id ?? null, email: m.guestEmail, name: m.guestName ?? u?.name ?? m.guestEmail, kind: u ? 'client' : 'guest' });
    } else {
      for (const u of clientUsers) if (u.email) add({ userId: u.id, email: u.email, name: u.name, kind: 'client' });
    }
    return out;
  }

  private async saveOutsiders(m: MeetingRec) {
    const list = await this.outsiders(m);
    if (list.length) await this.prisma.meetingAttendee.createMany({ data: list.map((i) => ({ meetingId: m.id, ...i })), skipDuplicates: true });
    return list;
  }

  /** Everyone on the Google event: team members in the meeting who are coming, and the client's people and guests. */
  private async guestList(m: MeetingRec): Promise<CalendarAttendee[]> {
    const [outside, parts, host] = await Promise.all([
      this.prisma.meetingAttendee.findMany({ where: { meetingId: m.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.meetingParticipant.findMany({ where: { meetingId: m.id, status: { not: 'ignored' } }, select: { userId: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.user.findUnique({ where: { id: m.hostId }, select: { email: true } }),
    ]);
    const team = parts.length ? await this.prisma.user.findMany({ where: { id: { in: parts.map((p) => p.userId) }, deletedAt: null }, select: { name: true, email: true } }) : [];
    const hostEmail = host?.email?.toLowerCase();
    return [...team.filter((u) => !!u.email).map((u) => ({ email: u.email!, name: u.name })), ...outside.map((a) => ({ email: a.email, name: a.name }))].filter((a) => a.email.toLowerCase() !== hostEmail);
  }

  /**
   * Puts a fixed meeting in the host's Google Calendar with a Google Meet link (Google emails the invitations), or
   * brings an existing event's guest list up to date. Never fails the meeting: a problem is stored on it (googleError)
   * and shown to the team.
   */
  private async toGoogle(m: MeetingRec, addMeet = true): Promise<MeetingRec> {
    if (m.status !== 'booked') return m;
    if (m.googleEventId && m.googleUserId) {
      try {
        const token = await calendarToken(this.prisma, m.googleUserId).catch(() => null);
        if (!token) throw new Error('the Google Calendar connection is not working (connect it again on Meetings)');
        if (!(await setCalendarAttendees(token, m.googleEventId, await this.guestList(m)))) throw new Error('the event was deleted in Google Calendar');
        return m.googleError ? this.prisma.meeting.update({ where: { id: m.id }, data: { googleError: null } }) : m;
      } catch (err) {
        this.log.warn(`Google Calendar guests for meeting ${m.id}: ${(err as Error).message}`);
        return this.prisma.meeting.update({ where: { id: m.id }, data: { googleError: `Guest list not updated in Google Calendar: ${(err as Error).message}`.slice(0, 300) } });
      }
    }
    if (!addMeet) return m;
    const token = await calendarToken(this.prisma, m.hostId).catch(() => null);
    if (!token) {
      const why = !calendarAvailable() ? 'Google Calendar is not set up on the server yet' : 'The host has not connected Google Calendar (Meetings → Connect Google Calendar)';
      return this.prisma.meeting.update({ where: { id: m.id }, data: { googleError: why } });
    }
    const [host, client] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: m.hostId }, select: { name: true } }),
      m.clientOrgId ? this.prisma.clientOrg.findUnique({ where: { id: m.clientOrgId }, select: { name: true } }) : null,
    ]);
    try {
      const e = await createCalendarEvent(token, {
        meetingId: m.id,
        title: m.title,
        startAt: m.startAt,
        endAt: m.endAt,
        description: [client ? `Client: ${client.name}` : null, m.agenda, `Host: ${host?.name ?? 'BMU Marketing'}`, 'Scheduled in BMU Hub.'].filter(Boolean).join('\n\n'),
        location: m.location,
        attendees: await this.guestList(m),
        addMeet: true,
      });
      return this.prisma.meeting.update({ where: { id: m.id }, data: { joinUrl: m.joinUrl ?? e.meetUrl, googleEventId: e.eventId, googleUserId: m.hostId, googleError: null } });
    } catch (err) {
      this.log.warn(`Google Calendar event for meeting ${m.id} failed: ${(err as Error).message}`);
      return this.prisma.meeting.update({ where: { id: m.id }, data: { googleError: (err as Error).message.slice(0, 300) } });
    }
  }

  /** A meeting the team added: team members hear in the app, client users in their portal, and email when Google did not. */
  private async announce(m: MeetingRec, team: string[], outside: Invitee[], by: string) {
    const when = `${istLabel(m.startAt)} (IST)`;
    if (team.length) await this.notifications.notify(m.orgId, team, { kind: 'meeting', title: `${by} invited you: ${m.title}`, body: `${when}. ${this.linkLine(m.joinUrl)}`, link: '/team/meetings' });
    const clients = outside.filter((i) => i.kind === 'client' && i.userId).map((i) => i.userId!);
    if (clients.length) await this.notifications.notify(m.orgId, clients, { kind: 'meeting', title: `Meeting with BMU: ${m.title}`, body: `${when}. ${this.linkLine(m.joinUrl)}`, link: '/client/meetings' });
    // Google already emailed an invitation (with the Meet link) to everyone on the event.
    if (m.googleEventId) return;
    for (const i of outside) {
      await this.email.send({
        orgId: m.orgId,
        to: i.email,
        toName: i.name,
        subject: `Meeting: ${m.title}, ${istLabel(m.startAt)}`,
        heading: 'You are invited to a meeting',
        paragraphs: [`Hi ${i.name.split(' ')[0]},`, `${by} from BMU Marketing has set up "${m.title}" on ${when}.`, m.joinUrl ? `Join here: ${m.joinUrl}` : m.location ? `Where: ${m.location}` : 'We will share the meeting link before the call.', m.agenda ? `Agenda: ${m.agenda}` : ''].filter(Boolean),
        button: { label: 'Add to calendar', url: this.icsUrl(m.id) },
        kind: 'meeting',
        entity: 'Meeting',
        entityId: m.id,
      });
    }
  }

  /** Reads replies (accepted / declined / maybe) from Google Calendar for upcoming meetings (every 15 minutes). */
  async syncReplies(now = new Date()) {
    const list = await this.prisma.meeting.findMany({
      where: { status: 'booked', googleEventId: { not: null }, googleUserId: { not: null }, endAt: { gt: new Date(now.getTime() - DAY) }, startAt: { lt: new Date(now.getTime() + 30 * DAY) } },
      select: { id: true, googleEventId: true, googleUserId: true },
      orderBy: { startAt: 'asc' },
      take: 60,
    });
    const tokens = new Map<string, string | null>();
    let updated = 0;
    for (const m of list) {
      if (!tokens.has(m.googleUserId!)) tokens.set(m.googleUserId!, await calendarToken(this.prisma, m.googleUserId!).catch(() => null));
      const token = tokens.get(m.googleUserId!);
      if (!token) continue;
      const replies = await calendarReplies(token, m.googleEventId!).catch(() => undefined);
      if (!replies) continue;
      for (const [email, response] of replies) {
        const r = await this.prisma.meetingAttendee.updateMany({ where: { meetingId: m.id, email, NOT: { response } }, data: { response } });
        updated += r.count;
      }
      const parts = await this.prisma.meetingParticipant.findMany({ where: { meetingId: m.id }, select: { id: true, userId: true, googleResponse: true } });
      const users = parts.length ? await this.prisma.user.findMany({ where: { id: { in: parts.map((p) => p.userId) } }, select: { id: true, email: true } }) : [];
      for (const p of parts) {
        const response = replies.get(users.find((u) => u.id === p.userId)?.email?.toLowerCase() ?? '');
        if (response && response !== p.googleResponse) {
          await this.prisma.meetingParticipant.update({ where: { id: p.id }, data: { googleResponse: response } });
          updated++;
        }
      }
    }
    return updated;
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
    const ids = (k: 'hostId' | 'clientOrgId' | 'leadId' | 'departmentId') => [...new Set(list.map((m) => m[k]).filter((x): x is string => !!x))];
    const parts = list.length ? await this.prisma.meetingParticipant.findMany({ where: { meetingId: { in: list.map((m) => m.id) } }, orderBy: { createdAt: 'asc' } }) : [];
    const attendees: AttendeeRec[] = list.length ? await this.prisma.meetingAttendee.findMany({ where: { meetingId: { in: list.map((m) => m.id) } }, orderBy: { createdAt: 'asc' } }) : [];
    const [hosts, clients, leads, depts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [...new Set([...ids('hostId'), ...parts.map((p) => p.userId)])] } }, select: { id: true, name: true } }),
      this.prisma.clientOrg.findMany({ where: { id: { in: ids('clientOrgId') } }, select: { id: true, name: true } }),
      me?.type === 'staff' ? this.prisma.lead.findMany({ where: { id: { in: ids('leadId') } }, select: { id: true, contact: true } }) : [],
      this.prisma.department.findMany({ where: { id: { in: ids('departmentId') } }, select: { id: true, name: true } }),
    ]);
    const now = new Date();
    return list.map((m) => {
      const lead = leads.find((l) => l.id === m.leadId);
      const staff = me?.type === 'staff';
      const mine = staff && (m.hostId === me.id || isLeadership(me));
      const open = OPEN.includes(m.status);
      const future = m.startAt > now;
      const clientCan = me?.type === 'client' && (m.status === 'booked' || open) && future && me.clientOrg?.role !== 'client_viewer';
      const people = parts.filter((p) => p.meetingId === m.id);
      const my = staff ? people.find((p) => p.userId === me.id) : undefined;
      // Clients see who is joining, never the team's internal answers or who chose not to come.
      const shown = staff ? people : people.filter((p) => ['accepted', 'joined'].includes(p.status) || (p.role === 'member' && p.status === 'invited'));
      return {
        id: m.id,
        title: m.title,
        startAt: m.startAt.toISOString(),
        endAt: m.endAt.toISOString(),
        durationMin: Math.round((m.endAt.getTime() - m.startAt.getTime()) / 60_000),
        host: hosts.find((h) => h.id === m.hostId) ?? { id: m.hostId, name: 'BMU team' },
        client: clients.find((c) => c.id === m.clientOrgId) ?? null,
        lead: lead ? { id: lead.id, name: leadName(lead.contact) } : null,
        guest: { name: m.guestName, email: staff ? m.guestEmail : null, phone: staff ? m.guestPhone : null },
        agenda: m.agenda,
        location: m.location,
        status: m.status as MeetingView['status'],
        bookedVia: m.bookedVia as MeetingView['bookedVia'],
        timeZone: m.timeZone,
        department: depts.find((d) => d.id === m.departmentId) ?? null,
        joinUrl: m.status === 'booked' ? m.joinUrl : null,
        rescheduledAt: m.rescheduledAt?.toISOString() ?? null,
        participants: shown.map((p) => ({
          userId: p.userId,
          name: hosts.find((h) => h.id === p.userId)?.name ?? 'BMU team',
          role: p.role as MeetingParticipantRole,
          status: p.status as MeetingParticipantStatus,
          proposedStartAt: staff ? (p.proposedStartAt?.toISOString() ?? null) : null,
          note: staff ? p.note : null,
          googleResponse: (p.googleResponse as MeetingAttendeeResponse | null) ?? null,
        })),
        myRole: (my?.role as MeetingParticipantRole | undefined) ?? null,
        // Clients see the summary and action items, never the team's raw notes.
        notes: staff ? m.notes : null,
        summary: m.summary,
        actionItems: Array.isArray(m.actionItems) ? (m.actionItems as { text: string; taskId?: string | null }[]).map((a) => ({ text: a.text, taskId: staff ? (a.taskId ?? null) : null })) : [],
        attendees: attendees.filter((a) => a.meetingId === m.id).map((a) => ({ name: a.name, email: staff ? a.email : null, kind: a.kind as 'client' | 'guest', response: a.response as MeetingAttendeeResponse })),
        google: staff ? { synced: !!m.googleEventId, error: m.googleError } : null,
        can: {
          edit: !!mine,
          cancel: (m.status === 'booked' || open) && (!!mine || clientCan),
          arrange: !!staff && open && (m.hostId === me.id || hasRole(me, 'am_lead')),
          respond: m.status === 'awaiting' && !!my && APPROVERS.includes(my.role as MeetingParticipantRole),
          addMembers: m.status === 'booked' && future && my?.role === 'department_head',
          join: m.status === 'booked' && m.endAt > now && my?.role === 'branch_manager',
          shareLink: !!staff && m.status === 'booked' && m.endAt > now && (m.hostId === me.id || hasRole(me, 'am_lead')),
        },
      };
    });
  }

  private async view(me: Me | null, m: MeetingRec) {
    return (await this.views(me, [m]))[0];
  }

  private split(list: MeetingView[]) {
    const now = Date.now();
    const requests = list.filter((m) => OPEN.includes(m.status)).sort((a, b) => a.startAt.localeCompare(b.startAt));
    const upcoming = list.filter((m) => m.status === 'booked' && new Date(m.endAt).getTime() >= now).sort((a, b) => a.startAt.localeCompare(b.startAt));
    const past = list.filter((m) => !upcoming.includes(m) && !requests.includes(m)).sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { requests, upcoming, past: past.slice(0, 50) };
  }

  // ------------------------------------------------------------------------------------------------ team

  private async loadForStaff(me: Me, id: string) {
    this.assertStaff(me);
    const m = await this.prisma.meeting.findFirst({ where: { id, orgId: me.orgId } });
    if (!m) throw new NotFoundException('Meeting not found');
    const brought = await this.prisma.meetingParticipant.findUnique({ where: { meetingId_userId: { meetingId: id, userId: me.id } }, select: { id: true } });
    if (m.hostId !== me.id && !isLeadership(me) && !brought) {
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
    // v23: also the meetings this person was brought into (Founder, Department Head, Branch Manager, team member).
    if (!isLeadership(me)) where.OR = [{ hostId: me.id }, { participants: { some: { userId: me.id } } }];
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
    const team = await this.teamInvitees(me.orgId, me.id, input.attendeeIds ?? []);
    // One click, one meeting: a repeat of the same meeting (same host, title and time) within two minutes, e.g. the
    // button pressed again while Google was still making the Meet link, returns the meeting already made. The lock
    // makes requests that arrive together wait for each other.
    const { m, repeat } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`select pg_advisory_xact_lock(hashtext(${`meeting:${me.id}:${input.title}:${startAt.toISOString()}`}))::text`;
      const same = await tx.meeting.findFirst({ where: { orgId: me.orgId, hostId: me.id, title: input.title, startAt, status: { not: 'cancelled' }, createdAt: { gte: new Date(Date.now() - 2 * 60_000) } }, orderBy: { createdAt: 'asc' } });
      if (same) return { m: same, repeat: true };
      const made = await tx.meeting.create({
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
      return { m: made, repeat: false };
    });
    if (repeat) return this.view(me, m);
    // v23: invited team members join as participants; the client's people / guest are invited; Google Meet when connected.
    if (team.length) await this.prisma.meetingParticipant.createMany({ data: team.map((userId) => ({ meetingId: m.id, userId, role: 'member', status: 'invited' })), skipDuplicates: true });
    const outside = await this.saveOutsiders(m);
    const after = await this.toGoogle(m, input.addMeet ?? true);
    await this.audit.log(me, 'meeting.created', 'Meeting', m.id, null, { title: m.title, startAt: m.startAt, invited: team.length + outside.length, googleMeet: !!after.googleEventId }, ip);
    if (m.leadId) await this.prisma.leadActivity.create({ data: { orgId: me.orgId, leadId: m.leadId, kind: 'meeting', body: `Meeting booked for ${istLabel(m.startAt)}: ${m.title}` } });
    await this.announce(after, team, outside, me.name);
    return this.view(me, after);
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
    // v23: everyone brought into the meeting hears too.
    const brought = (await this.prisma.meetingParticipant.findMany({ where: { meetingId: id, status: { not: 'ignored' } }, select: { userId: true } })).map((p) => p.userId).filter((u) => u !== me.id && u !== m.hostId);
    if (brought.length) await this.notifications.notify(m.orgId, brought, { kind: 'meeting', title: `Meeting cancelled: ${m.title}`, body: `${who} cancelled ${istLabel(m.startAt)} (IST).`, link: '/team/meetings' });
    // v23 Google Meet: cancelling the Google event tells everyone on it (Google emails them).
    if (m.googleEventId && m.googleUserId) {
      const token = await calendarToken(this.prisma, m.googleUserId).catch(() => null);
      const failed = token ? await cancelCalendarEvent(token, m.googleEventId).then(() => null, (e: Error) => e.message) : 'The Google Calendar connection is not working';
      if (!failed) return this.view(me, after);
      await this.prisma.meeting.update({ where: { id }, data: { googleError: `Cancelled here, but not in Google Calendar: ${failed}`.slice(0, 300) } });
    }
    // No Google event (or it could not be cancelled): email the client's people who were invited.
    if (me.type === 'staff') {
      for (const a of await this.prisma.meetingAttendee.findMany({ where: { meetingId: id, NOT: { email: m.guestEmail?.toLowerCase() ?? '' } } })) {
        await this.email.send({ orgId: m.orgId, to: a.email, toName: a.name, subject: `Cancelled: ${m.title}`, paragraphs: [`Hi ${a.name.split(' ')[0]},`, `Our meeting on ${istLabel(m.startAt)} (IST) is cancelled. ${me.name} will be in touch to find a new time.`], kind: 'meeting', entity: 'Meeting', entityId: m.id });
      }
    }
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
    if (!amId) throw new BadRequestException('Your Client Manager is not set yet. Message BMU and we will set up a call.');
    return this.slotsView(await this.ensureBookingPage(me.orgId, amId));
  }

  async clientBook(me: Me, body: unknown, ip?: string) {
    const amId = await this.clientAm(me);
    if (!amId) throw new BadRequestException('Your Client Manager is not set yet');
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
    await this.saveOutsiders(m);
    const after = await this.toGoogle(m);
    await this.audit.log(me, 'meeting.booked', 'Meeting', m.id, null, { startAt: m.startAt, via: 'client', googleMeet: !!after.googleEventId }, ip);
    await this.notifications.notify(me.orgId, [amId], { kind: 'meeting', title: `${me.clientOrg!.name} booked a call`, body: `${me.name}, ${istLabel(startAt)}${input.agenda ? `: ${input.agenda.slice(0, 120)}` : ''}`, link: '/team/meetings' });
    await this.confirm(after, b);
    return this.view(me, after);
  }

  // ------------------------------------------------------------------------------------------------ v23 meeting requests
  // Client asks (date, time in their time zone, length, what it is about) → Client Manager and Founders are told →
  // the Client Manager brings in a department (its head confirms) and/or a Founder → each accepts or asks for another
  // time the same day → the Client Manager confirms → fixed: client, Founder, Department Head (who then adds team
  // members) and the Branch Manager (join or ignore) are told. A Founder who wants a client meeting asks the Client
  // Manager, who arranges it the same way.

  private usersWithRole(orgId: string, baseRole: string, extra: Prisma.UserWhereInput = {}) {
    return this.prisma.user.findMany({
      where: { orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, roles: { some: { role: { baseRole } } }, ...extra },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Branch Managers of the respective branch only: the client's branch, or the Client Manager's when the client has none. */
  private async branchManagers(m: MeetingRec) {
    const clientBranch = m.clientOrgId ? (await this.prisma.clientOrg.findUnique({ where: { id: m.clientOrgId }, select: { branchId: true } }))?.branchId : null;
    const branchId = clientBranch ?? (await this.prisma.user.findUnique({ where: { id: m.hostId }, select: { branchId: true } }))?.branchId ?? null;
    return branchId ? this.usersWithRole(m.orgId, 'admin', { branchId }) : [];
  }

  /** Signed-in people of a client company (viewers included: they should know a meeting is on). */
  private async clientPeople(clientOrgId: string | null) {
    if (!clientOrgId) return [];
    const rows = await this.prisma.clientUser.findMany({ where: { clientOrgId, user: { deletedAt: null, status: { not: 'suspended' } } }, select: { user: { select: { id: true, name: true, email: true } } } });
    return rows.map((r) => r.user);
  }

  private async clientName(m: MeetingRec) {
    return m.clientOrgId ? ((await this.prisma.clientOrg.findUnique({ where: { id: m.clientOrgId }, select: { name: true } }))?.name ?? 'the client') : (m.guestName ?? 'the client');
  }

  private assertZone(timeZone: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format();
    } catch {
      throw new BadRequestException('Pick a valid time zone');
    }
  }

  /** "Mon, 20 Oct, 3:30 pm IST" plus the client's own time when they are elsewhere. */
  private bothTimes(at: Date, timeZone: string) {
    const ist = `${istLabel(at)} IST`;
    return timeZone === 'Asia/Kolkata' ? ist : `${ist} (${zonedLabel(at.toISOString(), timeZone)} ${timeZone})`;
  }

  private linkLine(joinUrl: string | null) {
    return joinUrl ? `Join here: ${joinUrl}` : 'Your meeting is scheduled.';
  }

  /** Tells the page (and anyone watching it) that the meeting changed. */
  private touch(id: string) {
    return this.prisma.meeting.update({ where: { id }, data: { updatedAt: new Date() } });
  }

  async clientRequest(me: Me, body: unknown, ip?: string) {
    const amId = await this.clientAm(me);
    if (!amId) throw new BadRequestException('Your Client Manager is not set yet. Message BMU and we will set up a call.');
    if (me.clientOrg!.role === 'client_viewer') throw new ForbiddenException('Ask your company admin to request meetings');
    const input = parse(meetingRequestSchema, body);
    this.assertZone(input.timeZone);
    const startAt = new Date(input.startAt);
    if (startAt.getTime() < Date.now() + 3_600_000) throw new BadRequestException('Pick a time at least an hour from now');
    if (startAt.getTime() > Date.now() + 180 * DAY) throw new BadRequestException('Pick a time within the next six months');
    const m = await this.prisma.meeting.create({
      data: {
        orgId: me.orgId,
        title: `${me.clientOrg!.name} meeting`,
        hostId: amId,
        startAt,
        endAt: new Date(startAt.getTime() + input.durationMin * 60_000),
        clientOrgId: me.clientOrg!.id,
        bookedById: me.id,
        guestName: me.name,
        guestEmail: me.email,
        guestPhone: me.phone,
        agenda: input.requirements,
        bookedVia: 'client',
        status: 'requested',
        timeZone: input.timeZone,
      },
    });
    await this.audit.log(me, 'meeting.requested', 'Meeting', m.id, null, { startAt: m.startAt, timeZone: m.timeZone, durationMin: input.durationMin }, ip);
    const when = this.bothTimes(startAt, input.timeZone);
    const about = input.requirements.slice(0, 160);
    await this.notifications.notify(me.orgId, [amId], { kind: 'meeting', title: `${me.clientOrg!.name} asked for a meeting`, body: `${me.name}, ${when}, ${input.durationMin} min: ${about}. Arrange it on Meetings.`, link: '/team/meetings' });
    const founders = (await this.usersWithRole(me.orgId, 'founder')).map((f) => f.id).filter((id) => id !== amId);
    if (founders.length) await this.notifications.notify(me.orgId, founders, { kind: 'meeting', title: `Meeting request from ${me.clientOrg!.name}`, body: `${me.name}, ${when}, ${input.durationMin} min: ${about}. Their Client Manager is arranging it.`, link: '/team/meetings' });
    if (me.email) {
      await this.email.send({
        orgId: me.orgId,
        to: me.email,
        toName: me.name,
        subject: `We got your meeting request for ${zonedLabel(startAt.toISOString(), input.timeZone)}`,
        heading: 'Meeting request received',
        paragraphs: [`Hi ${me.name.split(' ')[0]},`, `You asked for a ${input.durationMin}-minute meeting on ${zonedLabel(startAt.toISOString(), input.timeZone)} (${input.timeZone}).`, 'Your Client Manager is arranging it and will confirm the time shortly.'],
        kind: 'meeting',
        entity: 'Meeting',
        entityId: m.id,
      });
    }
    return this.view(me, m);
  }

  async founderRequest(me: Me, body: unknown, ip?: string) {
    this.assertStaff(me);
    if (!hasRole(me, 'founder')) throw new ForbiddenException('Only a Founder can ask for a client meeting this way');
    const input = parse(founderMeetingSchema, body);
    const c = await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, amUserId: true } });
    if (!c) throw new BadRequestException('Client not found');
    if (!c.amUserId) throw new BadRequestException(`${c.name} has no Client Manager yet. Assign one first: Founders meet clients through their Client Manager.`);
    const startAt = new Date(input.startAt);
    if (startAt.getTime() < Date.now() + 3_600_000) throw new BadRequestException('Pick a time at least an hour from now');
    const m = await this.prisma.meeting.create({
      data: {
        orgId: me.orgId,
        title: `${c.name} meeting with ${me.name.split(' ')[0]}`,
        hostId: c.amUserId,
        startAt,
        endAt: new Date(startAt.getTime() + input.durationMin * 60_000),
        clientOrgId: c.id,
        bookedById: me.id,
        agenda: input.requirements,
        bookedVia: 'founder',
        status: 'requested',
        participants: { create: { userId: me.id, role: 'founder', status: 'accepted', respondedAt: new Date() } },
      },
    });
    await this.audit.log(me, 'meeting.founder_requested', 'Meeting', m.id, null, { clientOrgId: c.id, startAt: m.startAt }, ip);
    await this.notifications.notify(me.orgId, [c.amUserId], {
      kind: 'meeting',
      title: `${me.name} wants a meeting with ${c.name}`,
      body: `Suggested ${istLabel(startAt)} IST, ${input.durationMin} min: ${input.requirements.slice(0, 160)}. Agree the time with the client, then fix it on Meetings.`,
      link: '/team/meetings',
    });
    return this.view(me, m);
  }

  async arrangeOptions(me: Me): Promise<MeetingArrangeOptions> {
    this.assertStaff(me);
    const [depts, founders] = await Promise.all([
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, headUserId: true }, orderBy: { name: 'asc' } }),
      this.usersWithRole(me.orgId, 'founder'),
    ]);
    const heads = await this.prisma.user.findMany({ where: { id: { in: depts.map((d) => d.headUserId).filter((x): x is string => !!x) }, deletedAt: null }, select: { id: true, name: true } });
    return { departments: depts.map((d) => ({ id: d.id, name: d.name, head: heads.find((h) => h.id === d.headUserId) ?? null })), founders };
  }

  private async loadOpen(me: Me, id: string) {
    const m = await this.loadForStaff(me, id);
    if (!(await this.view(me, m)).can.arrange) throw new ForbiddenException("Only the client's Client Manager (or the CM Lead) can arrange this meeting");
    return m;
  }

  /** The Client Manager brings in a department (its head confirms) and/or a Founder. */
  async arrange(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadOpen(me, id);
    const input = parse(meetingArrangeSchema, body);
    const want: { userId: string; role: MeetingParticipantRole }[] = [];
    let departmentId: string | null = null;
    if (input.departmentId) {
      const d = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, headUserId: true } });
      if (!d) throw new BadRequestException('Department not found');
      if (!d.headUserId) throw new BadRequestException(`${d.name} has no Department Head yet. Set one in People first.`);
      departmentId = d.id;
      want.push({ userId: d.headUserId, role: 'department_head' });
    }
    if (input.founderId) {
      if (!(await this.usersWithRole(me.orgId, 'founder', { id: input.founderId })).length) throw new BadRequestException('Pick a Founder');
      if (!want.some((w) => w.userId === input.founderId)) want.push({ userId: input.founderId, role: 'founder' });
    }
    const before = await this.prisma.meetingParticipant.findMany({ where: { meetingId: id, role: { in: APPROVERS } } });
    // A Founder who asked for this meeting stays in it.
    const keep = (p: ParticipantRec) => want.some((w) => w.userId === p.userId) || (m.bookedVia === 'founder' && p.role === 'founder' && p.userId === m.bookedById);
    await this.prisma.meetingParticipant.deleteMany({ where: { id: { in: before.filter((p) => !keep(p)).map((p) => p.id) } } });
    const asked: string[] = [];
    for (const w of want) {
      const had = before.find((p) => p.userId === w.userId);
      if (had && had.role === w.role) continue; // already asked: keep their answer
      await this.prisma.meetingParticipant.upsert({
        where: { meetingId_userId: { meetingId: id, userId: w.userId } },
        create: { meetingId: id, userId: w.userId, role: w.role, status: 'pending' },
        update: { role: w.role, status: 'pending', proposedStartAt: null, note: null, respondedAt: null },
      });
      asked.push(w.userId);
    }
    const after = await this.prisma.meeting.update({ where: { id }, data: { status: 'awaiting', departmentId } });
    await this.audit.log(me, 'meeting.arranged', 'Meeting', id, { status: m.status, departmentId: m.departmentId }, { status: 'awaiting', departmentId, asked }, ip);
    const client = await this.clientName(m);
    if (asked.length) {
      await this.notifications.notify(me.orgId, asked, {
        kind: 'meeting',
        title: `Meeting with ${client}: can you join?`,
        body: `${me.name} asks you to join a ${Math.round((m.endAt.getTime() - m.startAt.getTime()) / 60_000)}-minute meeting with ${client} on ${istLabel(m.startAt)} IST${m.agenda ? `: ${m.agenda.slice(0, 140)}` : ''}. Accept, or ask for another time the same day.`,
        link: '/team/meetings',
      });
    }
    return this.view(me, after);
  }

  /** A Department Head or Founder accepts, or asks for another time on the same day. */
  async respond(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadForStaff(me, id);
    const p = await this.prisma.meetingParticipant.findUnique({ where: { meetingId_userId: { meetingId: id, userId: me.id } } });
    if (!p || !APPROVERS.includes(p.role as MeetingParticipantRole)) throw new ForbiddenException('You were not asked to confirm this meeting');
    if (m.status !== 'awaiting') throw new BadRequestException(m.status === 'booked' ? 'This meeting is already fixed' : 'This meeting is not waiting for answers');
    const input = parse(meetingRespondSchema, body);
    let proposed: Date | null = null;
    if (input.decision === 'reschedule') {
      proposed = new Date(input.proposedStartAt!);
      if (zonedDay(proposed.toISOString(), 'Asia/Kolkata') !== zonedDay(m.startAt.toISOString(), 'Asia/Kolkata')) throw new BadRequestException(`Pick another time on the same day (${istLabel(m.startAt).split(',').slice(0, 2).join(',')})`);
      if (proposed.getTime() < Date.now() + 30 * 60_000) throw new BadRequestException('Pick a time at least 30 minutes from now');
      if (proposed.getTime() === m.startAt.getTime()) throw new BadRequestException('That is the time already asked for. Accept it instead.');
    }
    await this.prisma.meetingParticipant.update({ where: { id: p.id }, data: { status: input.decision === 'accept' ? 'accepted' : 'reschedule', proposedStartAt: proposed, note: input.note || null, respondedAt: new Date() } });
    await this.audit.log(me, `meeting.${input.decision === 'accept' ? 'accepted' : 'reschedule_asked'}`, 'Meeting', id, { status: p.status }, { status: input.decision, proposedStartAt: proposed }, ip);
    const client = await this.clientName(m);
    await this.notifications.notify(me.orgId, [m.hostId], {
      kind: 'meeting',
      title: input.decision === 'accept' ? `${me.name} accepted the ${client} meeting` : `${me.name} asks to move the ${client} meeting`,
      body: input.decision === 'accept' ? `${istLabel(m.startAt)} IST works.${input.note ? ` "${input.note}"` : ''}` : `Suggested ${istLabel(proposed!)} IST instead of ${istLabel(m.startAt)}.${input.note ? ` "${input.note}"` : ''} Confirm the new time on Meetings.`,
      link: '/team/meetings',
    });
    return this.maybeFix(me, await this.touch(id), ip);
  }

  /** Fixed on its own once everyone asked has accepted the time; a new time always waits for the Client Manager. */
  private async maybeFix(me: Me, m: MeetingRec, ip?: string) {
    const asked = await this.prisma.meetingParticipant.findMany({ where: { meetingId: m.id, role: { in: APPROVERS } } });
    if (m.status === 'awaiting' && asked.length && asked.every((p) => p.status === 'accepted')) return this.view(me, await this.fixNow(me, m, m.startAt, ip));
    return this.view(me, m);
  }

  /** The Client Manager fixes the meeting, at the asked time or a new one (a Department Head's or Founder's). */
  async fix(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadOpen(me, id);
    const input = parse(meetingFixSchema, body);
    const asked = await this.prisma.meetingParticipant.findMany({ where: { meetingId: id, role: { in: APPROVERS } } });
    const waiting = asked.filter((p) => p.status === 'pending');
    if (waiting.length) {
      const names = await this.prisma.user.findMany({ where: { id: { in: waiting.map((p) => p.userId) } }, select: { name: true } });
      throw new BadRequestException(`Still waiting for ${names.map((n) => n.name).join(' and ')} to answer`);
    }
    if (asked.some((p) => p.status === 'reschedule') && !input.startAt) throw new BadRequestException('Someone asked for another time. Pick the time to fix.');
    const startAt = input.startAt ? new Date(input.startAt) : m.startAt;
    if (startAt.getTime() < Date.now()) throw new BadRequestException('That time has passed. Pick a new time.');
    return this.view(me, await this.fixNow(me, m, startAt, ip));
  }

  /**
   * Fixes the meeting and tells the client, the Client Manager, the Founder, the Department Head and the Branch Manager
   * that it is scheduled. The meeting link follows in one click from the Client Manager (shareLink).
   */
  private async fixNow(me: Me, m: MeetingRec, startAt: Date, ip?: string) {
    const moved = startAt.getTime() !== m.startAt.getTime();
    const durationMs = m.endAt.getTime() - m.startAt.getTime();
    const after = await this.prisma.meeting.update({
      where: { id: m.id },
      data: { status: 'booked', startAt, endAt: new Date(startAt.getTime() + durationMs), rescheduledAt: moved ? new Date() : m.rescheduledAt, reminderAt: null },
    });
    // Anyone who asked for another time is now on the fixed time.
    await this.prisma.meetingParticipant.updateMany({ where: { meetingId: m.id, status: 'reschedule' }, data: { status: 'accepted', proposedStartAt: null } });
    const people = await this.prisma.meetingParticipant.findMany({ where: { meetingId: m.id } });
    const bms = (await this.branchManagers(m)).filter((b) => b.id !== m.hostId && !people.some((p) => p.userId === b.id));
    if (bms.length) await this.prisma.meetingParticipant.createMany({ data: bms.map((b) => ({ meetingId: m.id, userId: b.id, role: 'branch_manager', status: 'invited' })), skipDuplicates: true });
    // v23 Google Meet: the fixed meeting goes into the Client Manager's Google Calendar with a Meet link, and Google
    // emails the invitations to the client and everyone in it.
    await this.saveOutsiders(after);
    const synced = await this.toGoogle(after);
    const joinUrl = synced.joinUrl;
    await this.audit.log(me, 'meeting.fixed', 'Meeting', m.id, { status: m.status, startAt: m.startAt }, { status: 'booked', startAt, moved, googleMeet: !!synced.googleEventId }, ip);

    const client = await this.clientName(m);
    const ist = `${istLabel(startAt)} IST`;
    const line = this.linkLine(joinUrl);
    const notify = (ids: string[], title: string, body: string) => (ids.length ? this.notifications.notify(m.orgId, ids, { kind: 'meeting', title, body, link: '/team/meetings' }) : null);
    await notify([m.hostId], `Meeting fixed: ${client}`, `${ist}. ${joinUrl ? line : `Everyone accepted.${synced.googleError ? ` No Google Meet link: ${synced.googleError}.` : ''} Send the meeting link from Meetings.`}`);
    await notify(people.filter((p) => p.role === 'founder' && p.userId !== me.id).map((p) => p.userId), `Your meeting is scheduled: ${client}`, `${ist}. ${line}`);
    await notify(people.filter((p) => p.role === 'department_head' && p.userId !== me.id).map((p) => p.userId), `Your meeting is scheduled: ${client}`, `${ist}. ${line} Add your team members on Meetings.`);
    await notify(people.filter((p) => p.role === 'member').map((p) => p.userId), `Your meeting is scheduled: ${client}`, `${ist}. ${line}`);
    await notify(bms.map((b) => b.id), `Meeting with client ${client}: join now?`, `Scheduled for ${ist}. ${line} Join or ignore on Meetings.`);

    // The client: "scheduled", or an apology with the revised time when it moved.
    const theirs = `${zonedLabel(startAt.toISOString(), m.timeZone)} (${m.timeZone})`;
    const title = moved ? 'Sorry, we had to move your meeting' : 'Your meeting is scheduled';
    const body = moved ? `We are sorry: your meeting moved from ${zonedLabel(m.startAt.toISOString(), m.timeZone)} to ${theirs}. ${line}` : `${theirs}. ${line}`;
    const clientUsers = await this.clientPeople(m.clientOrgId);
    if (clientUsers.length) await this.notifications.notify(m.orgId, clientUsers.map((u) => u.id), { kind: 'meeting', title, body, link: '/client/meetings' });
    for (const [to, toName] of this.clientEmails(m, clientUsers)) {
      await this.email.send({
        orgId: m.orgId,
        to,
        toName,
        subject: moved ? `Sorry, your meeting moved to ${theirs}` : `Scheduled: your meeting on ${theirs}`,
        heading: title,
        paragraphs: [
          `Hi ${toName?.split(' ')[0] ?? 'there'},`,
          moved ? `We are sorry for the change. Your meeting with BMU Marketing moved from ${zonedLabel(m.startAt.toISOString(), m.timeZone)} to ${theirs}.` : `Your meeting with BMU Marketing is on ${theirs}, for ${Math.round(durationMs / 60_000)} minutes.`,
          joinUrl ? `Join here: ${joinUrl}` : 'Your meeting is scheduled. We will share the meeting link before the call.',
        ],
        button: { label: 'Add to calendar', url: this.icsUrl(m.id) },
        kind: 'meeting',
        entity: 'Meeting',
        entityId: m.id,
      });
    }
    return synced;
  }

  /** The Client Manager sends the meeting link (e.g. Google Meet) to everyone in one click; sending again updates it. */
  async shareLink(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadForStaff(me, id);
    if (!(await this.view(me, m)).can.shareLink) throw new ForbiddenException(m.status === 'booked' ? "Only the client's Client Manager (or the CM Lead) can send the meeting link" : 'Send the link once everyone has accepted and the meeting is fixed');
    const { joinUrl } = parse(meetingLinkSchema, body);
    const updated = !!m.joinUrl;
    const after = await this.prisma.meeting.update({ where: { id }, data: { joinUrl } });
    await this.audit.log(me, 'meeting.link_shared', 'Meeting', id, { joinUrl: m.joinUrl }, { joinUrl }, ip);
    const client = await this.clientName(m);
    const ist = `${istLabel(m.startAt)} IST`;
    const title = `${updated ? 'Updated meeting link' : 'Meeting link'}: ${client}`;
    // Everyone in it who is coming: Founder, Department Head, team members and the Branch Manager (unless they ignored it).
    const people = (await this.prisma.meetingParticipant.findMany({ where: { meetingId: id, status: { not: 'ignored' } } })).filter((p) => p.userId !== me.id);
    const bms = people.filter((p) => p.role === 'branch_manager').map((p) => p.userId);
    const others = [...new Set([...people.filter((p) => p.role !== 'branch_manager').map((p) => p.userId), ...(m.hostId !== me.id ? [m.hostId] : [])])];
    if (others.length) await this.notifications.notify(m.orgId, others, { kind: 'meeting', title, body: `${ist}. Join here: ${joinUrl}`, link: '/team/meetings' });
    if (bms.length) await this.notifications.notify(m.orgId, bms, { kind: 'meeting', title: `Meeting with client ${client}: join now?`, body: `${ist}. Join here: ${joinUrl} Join or ignore on Meetings.`, link: '/team/meetings' });
    const theirs = `${zonedLabel(m.startAt.toISOString(), m.timeZone)} (${m.timeZone})`;
    const clientUsers = await this.clientPeople(m.clientOrgId);
    if (clientUsers.length) await this.notifications.notify(m.orgId, clientUsers.map((u) => u.id), { kind: 'meeting', title: updated ? 'Updated link for your meeting' : 'Your meeting link', body: `${theirs}. Join here: ${joinUrl}`, link: '/client/meetings' });
    for (const [to, toName] of this.clientEmails(m, clientUsers)) {
      await this.email.send({
        orgId: m.orgId,
        to,
        toName,
        subject: `${updated ? 'Updated link' : 'Meeting link'}: your meeting on ${theirs}`,
        heading: updated ? 'Updated link for your meeting' : 'Your meeting link',
        paragraphs: [`Hi ${toName?.split(' ')[0] ?? 'there'},`, `Your meeting with BMU Marketing is on ${theirs}.`, `Join here: ${joinUrl}`],
        button: { label: 'Join meeting', url: joinUrl },
        kind: 'meeting',
        entity: 'Meeting',
        entityId: m.id,
      });
    }
    return this.view(me, after);
  }

  /** Who at the client gets meeting emails: the person who asked, or (for a Founder's request) everyone at the client. */
  private clientEmails(m: MeetingRec, clientUsers: { name: string; email: string | null }[]) {
    const emails = new Map<string, string | null>();
    if (m.guestEmail) emails.set(m.guestEmail.toLowerCase(), m.guestName);
    if (!emails.size) for (const u of clientUsers) if (u.email) emails.set(u.email.toLowerCase(), u.name);
    return emails;
  }

  /** People of the meeting's department the Department Head can add. */
  async memberOptions(me: Me, id: string) {
    const m = await this.loadForStaff(me, id);
    if (!(await this.view(me, m)).can.addMembers || !m.departmentId) throw new ForbiddenException('Only the Department Head can add team members');
    const taken = (await this.prisma.meetingParticipant.findMany({ where: { meetingId: id }, select: { userId: true } })).map((p) => p.userId);
    return this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: 'active', departmentId: m.departmentId, id: { notIn: [...taken, me.id, m.hostId] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  async addMembers(me: Me, id: string, body: unknown, ip?: string) {
    const options = await this.memberOptions(me, id);
    const { userIds } = parse(meetingMembersSchema, body);
    const add = [...new Set(userIds)];
    if (add.some((u) => !options.some((o) => o.id === u))) throw new BadRequestException('Add people from your own department who are not in the meeting yet');
    await this.prisma.meetingParticipant.createMany({ data: add.map((userId) => ({ meetingId: id, userId, role: 'member', status: 'invited' })), skipDuplicates: true });
    // v23 Google Meet: they are added to the Google event too (Google emails them the invitation).
    const m = await this.toGoogle(await this.touch(id));
    await this.audit.log(me, 'meeting.members_added', 'Meeting', id, null, { userIds: add }, ip);
    const client = await this.clientName(m);
    await this.notifications.notify(me.orgId, add, { kind: 'meeting', title: `Your meeting is scheduled: ${client}`, body: `${me.name} added you to the meeting with ${client} on ${istLabel(m.startAt)} IST. ${this.linkLine(m.joinUrl)}`, link: '/team/meetings' });
    return this.view(me, m);
  }

  /** The Branch Manager joins or ignores a fixed meeting. */
  async joinOrIgnore(me: Me, id: string, body: unknown, ip?: string) {
    const m = await this.loadForStaff(me, id);
    if (!(await this.view(me, m)).can.join) throw new ForbiddenException('This meeting is not waiting for you');
    const { decision } = parse(meetingJoinSchema, body);
    await this.prisma.meetingParticipant.update({ where: { meetingId_userId: { meetingId: id, userId: me.id } }, data: { status: decision === 'join' ? 'joined' : 'ignored', respondedAt: new Date() } });
    await this.audit.log(me, `meeting.${decision === 'join' ? 'joined' : 'ignored'}`, 'Meeting', id, null, null, ip);
    if (decision === 'join') await this.notifications.notify(me.orgId, [m.hostId], { kind: 'meeting', title: `${me.name} will join the ${await this.clientName(m)} meeting`, body: `${istLabel(m.startAt)} IST.`, link: '/team/meetings' });
    // v23 Google Meet: a Branch Manager who is not coming is taken off the Google event.
    const after = await this.touch(id);
    return this.view(me, decision === 'ignore' ? await this.toGoogle(after) : after);
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
    await this.saveOutsiders(m);
    const after = await this.toGoogle(m);
    await this.audit.logSystem(b.orgId, 'meeting.booked', 'Meeting', m.id, { startAt: m.startAt, via: 'public', googleMeet: !!after.googleEventId, ip: ip ? 'recorded' : null });
    await this.notifications.notify(b.orgId, [b.userId], { kind: 'meeting', title: `New call booked: ${input.company || input.name}`, body: istLabel(startAt), link: '/team/meetings' });
    await this.confirm(after, b);
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
      paragraphs: [
        `Hi ${m.guestName?.split(' ')[0] ?? 'there'},`,
        `You're booked with ${host?.name ?? 'BMU Marketing'} on ${istLabel(m.startAt)} (IST) for ${b.durationMin} minutes.`,
        m.joinUrl ? `Join with Google Meet: ${m.joinUrl} (works in any browser, no Google account needed).` : 'We will send the meeting link before the call.',
      ],
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
      `DESCRIPTION:${icsText([`With ${host?.name ?? 'BMU Marketing'}`, m.joinUrl ? `Join here: ${m.joinUrl}` : '', m.agenda ?? ''].filter(Boolean).join('\n'))}`,
      m.location || m.joinUrl ? `LOCATION:${icsText(m.location ?? m.joinUrl!)}` : '',
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
      // v23: and everyone brought into a client meeting who is coming.
      const coming = (await this.prisma.meetingParticipant.findMany({ where: { meetingId: m.id, OR: [{ status: { in: ['accepted', 'joined'] } }, { role: 'member', status: 'invited' }] }, select: { userId: true } })).map((p) => p.userId);
      await this.notifications.notify(m.orgId, [m.hostId, ...coming], { kind: 'meeting', title: `Starting soon: ${m.title}`, body: `${istLabel(m.startAt)}. ${this.linkLine(m.joinUrl)}`, link: '/team/meetings' });
      if (m.guestEmail && m.bookedVia !== 'team') {
        await this.email.send({ orgId: m.orgId, to: m.guestEmail, toName: m.guestName, subject: `Reminder: ${m.title} at ${istLabel(m.startAt)}`, paragraphs: [`Hi ${m.guestName?.split(' ')[0] ?? 'there'}, a reminder that our call starts at ${istLabel(m.startAt)} (IST).`, m.joinUrl ? `Join here: ${m.joinUrl}` : ''].filter(Boolean), button: m.joinUrl ? { label: 'Join meeting', url: m.joinUrl } : { label: 'Add to calendar', url: this.icsUrl(m.id) }, kind: 'meeting', entity: 'Meeting', entityId: m.id });
      }
    }
    return due.length;
  }
}