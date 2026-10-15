// v23 Google Meet + Google Calendar. Each organiser connects their own Google Workspace calendar once; meetings they
// host then become Google Calendar events with a Google Meet link, and Google emails the invitations (any email
// provider can open them, and guests join Meet from a browser without a Google account).
//
// The sign-in reuses the integrations return address (/integrations/oauth/callback, see IntegrationsService), so the
// Google Cloud OAuth client needs only one redirect URI. Tokens are encrypted with INTEGRATIONS_KEY.
import type { PrismaService } from '../prisma/prisma.service.js';
import { seal, signToken, unseal } from './crypto.js';
import { http, ProviderError } from './providers/types.js';

/** Create / change / cancel events in calendars the person can edit, plus their email address. Nothing else. */
export const CALENDAR_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export type CalendarOAuthState = { k: 'calendar'; o: string; u: string; n: string };

/** Google sign-in is set up on the server. */
export const calendarAvailable = () => !!process.env.GOOGLE_CLIENT_ID?.trim() && !!process.env.GOOGLE_CLIENT_SECRET?.trim() && (!!process.env.INTEGRATIONS_KEY?.trim() || process.env.NODE_ENV !== 'production');

async function tokenRequest(body: Record<string, string>, label: string) {
  return http<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string }>('https://oauth2.googleapis.com/token', {
    label,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...body }),
  });
}

/** The Google sign-in page for connecting the person's calendar. */
export function calendarAuthUrl(orgId: string, userId: string, redirectUri: string, nonce: string) {
  const state = signToken({ k: 'calendar', o: orgId, u: userId, n: nonce } satisfies CalendarOAuthState, 600);
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: CALENDAR_SCOPES.join(' '),
    state,
  })}`;
}

/** Finishes the sign-in: stores (encrypted) tokens for the person and returns the Google account's email. */
export async function finishCalendarConnect(prisma: PrismaService, st: CalendarOAuthState, code: string, redirectUri: string): Promise<string> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'Google sign-in');
  if (!t.refresh_token) throw new ProviderError('Google did not return lasting access. Remove BMU Hub under myaccount.google.com → Security → Third-party apps, then connect again.');
  const info = await http<{ email?: string; email_verified?: boolean }>('https://openidconnect.googleapis.com/v1/userinfo', { label: 'Google account', headers: { authorization: `Bearer ${t.access_token}` } });
  if (!info.email) throw new ProviderError('Google did not share the account email');
  const data = { email: info.email.toLowerCase(), tokenEnc: seal(t.access_token), refreshEnc: seal(t.refresh_token), tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000), status: 'connected', lastError: null };
  await prisma.calendarConnection.upsert({ where: { userId: st.u }, create: { orgId: st.o, userId: st.u, ...data }, update: data });
  return data.email;
}

/** A working access token for the person's calendar (refreshed when it is about to expire), or null if not connected. */
export async function calendarToken(prisma: PrismaService, userId: string): Promise<string | null> {
  const c = await prisma.calendarConnection.findUnique({ where: { userId } });
  if (!c || c.status === 'disconnected' || !c.refreshEnc) return null;
  const token = unseal(c.tokenEnc);
  if (token && c.tokenExpiresAt && c.tokenExpiresAt.getTime() > Date.now() + 2 * 60_000) return token;
  const refresh = unseal(c.refreshEnc);
  if (!refresh) return null;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, 'Google token refresh');
    await prisma.calendarConnection.update({ where: { id: c.id }, data: { tokenEnc: seal(t.access_token), tokenExpiresAt: new Date(Date.now() + t.expires_in * 1000), status: 'connected', lastError: null } });
    return t.access_token;
  } catch (e) {
    // Revoked or expired access: the person has to connect again.
    await prisma.calendarConnection.update({ where: { id: c.id }, data: { status: 'error', lastError: (e as Error).message.slice(0, 300) } });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- events

export type CalendarAttendee = { email: string; name: string };
export type CalendarEventInput = {
  meetingId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  description: string;
  location: string | null;
  attendees: CalendarAttendee[];
  addMeet: boolean;
};

/** The Google Calendar event for a meeting (a pure function, so it can be tested without Google). */
export function buildCalendarEvent(m: CalendarEventInput) {
  const seen = new Set<string>();
  const attendees = m.attendees
    .map((a) => ({ email: a.email.trim().toLowerCase(), displayName: a.name }))
    .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email) && !seen.has(a.email) && !!seen.add(a.email));
  return {
    summary: m.title,
    description: m.description,
    ...(m.location ? { location: m.location } : {}),
    start: { dateTime: m.startAt.toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: m.endAt.toISOString(), timeZone: 'Asia/Kolkata' },
    attendees,
    guestsCanModify: false,
    reminders: { useDefault: true },
    // Lets us find the CRM meeting from the Google event.
    extendedProperties: { private: { bmuMeetingId: m.meetingId } },
    ...(m.addMeet ? { conferenceData: { createRequest: { requestId: `bmu-${m.meetingId}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
}

type GoogleEvent = {
  id: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
  attendees?: { email: string; responseStatus?: string }[];
  status?: string;
};

const meetLinkOf = (e: GoogleEvent) => e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;

/** Creates the event in the person's primary calendar; Google emails the invitations. */
export async function createCalendarEvent(token: string, m: CalendarEventInput) {
  const e = await http<GoogleEvent>(`${CAL}?conferenceDataVersion=1&sendUpdates=all`, {
    label: 'Google Calendar',
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildCalendarEvent(m)),
  });
  return { eventId: e.id, meetUrl: meetLinkOf(e) };
}

/**
 * Changes who is invited (people added later, a Branch Manager who said no). Attendees still invited keep their
 * reply; Google emails only the people added or removed. Returns false when the event is gone.
 */
export async function setCalendarAttendees(token: string, eventId: string, attendees: CalendarAttendee[]): Promise<boolean> {
  const res = await fetch(`${CAL}/${encodeURIComponent(eventId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) throw new ProviderError(`Google Calendar: could not read the event (${res.status})`);
  const current = ((await res.json()) as GoogleEvent).attendees ?? [];
  const wanted = buildCalendarEvent({ meetingId: '', title: '', startAt: new Date(0), endAt: new Date(0), description: '', location: null, attendees, addMeet: false }).attendees;
  const next = wanted.map((w) => current.find((c) => c.email.toLowerCase() === w.email) ?? w);
  await http<GoogleEvent>(`${CAL}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    label: 'Google Calendar',
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attendees: next }),
  });
  return true;
}

/** Cancels the event; Google tells every attendee. A missing event counts as cancelled. */
export async function cancelCalendarEvent(token: string, eventId: string) {
  const res = await fetch(`${CAL}/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new ProviderError(`Google Calendar: could not cancel the event (${res.status})`);
}

/** Each attendee's reply (accepted, declined, tentative, needsAction), by email. Null when the event is gone. */
export async function calendarReplies(token: string, eventId: string): Promise<Map<string, string> | null> {
  const res = await fetch(`${CAL}/${encodeURIComponent(eventId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new ProviderError(`Google Calendar: could not read the event (${res.status})`);
  const e = (await res.json()) as GoogleEvent;
  return new Map((e.attendees ?? []).map((a) => [a.email.toLowerCase(), a.responseStatus ?? 'needsAction']));
}
