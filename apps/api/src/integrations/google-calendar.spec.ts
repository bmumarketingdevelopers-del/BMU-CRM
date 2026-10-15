import { buildCalendarEvent } from './google-calendar.js';

const base = { meetingId: 'm1', title: 'Kick-off', startAt: new Date('2026-10-20T05:30:00Z'), endAt: new Date('2026-10-20T06:00:00Z'), description: 'Client: Acme', location: null };

describe('Google Calendar event for a meeting', () => {
  it('asks Google for a Meet link and keeps the CRM meeting id', () => {
    const e = buildCalendarEvent({ ...base, attendees: [], addMeet: true });
    expect(e.conferenceData?.createRequest).toEqual({ requestId: 'bmu-m1', conferenceSolutionKey: { type: 'hangoutsMeet' } });
    expect(e.extendedProperties.private.bmuMeetingId).toBe('m1');
    expect(e.start).toEqual({ dateTime: '2026-10-20T05:30:00.000Z', timeZone: 'Asia/Kolkata' });
    expect(e.guestsCanModify).toBe(false);
  });

  it('invites each person once and skips addresses Google would reject', () => {
    const e = buildCalendarEvent({
      ...base,
      addMeet: true,
      attendees: [
        { email: 'Asha@Client.com', name: 'Asha' },
        { email: 'asha@client.com', name: 'Asha again' },
        { email: 'not-an-email', name: 'Nobody' },
        { email: 'ravi@gmail.com', name: 'Ravi' },
      ],
    });
    expect(e.attendees).toEqual([
      { email: 'asha@client.com', displayName: 'Asha' },
      { email: 'ravi@gmail.com', displayName: 'Ravi' },
    ]);
  });

  it('adds no Meet link when it is not wanted, and keeps a given location', () => {
    const e = buildCalendarEvent({ ...base, location: 'Office, Indiranagar', attendees: [], addMeet: false });
    expect('conferenceData' in e).toBe(false);
    expect(e.location).toBe('Office, Indiranagar');
  });
});
