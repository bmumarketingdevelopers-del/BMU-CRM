// v17 communications: the shared inbox (a WhatsApp from a known client number lands on that client's thread; unknown
// numbers and leads; replies; webhooks with their secrets), one-tap approval from the WhatsApp proof link moving the
// work on, two people editing the same brief at once without losing text, meeting booking (client portal and the
// public link) with notes, summary and tasks, and the notification router (WhatsApp copies, quiet hours, digest).
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as Y from 'yjs';
import type { BookingSlots, DeliverableDetail, DocDetail, InboxDetail, InboxList, MeetingList, MeetingView, ProofLinkView, ServiceNotificationPrefsView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { NotificationsService, inQuietHours, nextIst } from '../src/notifications/notifications.service.js';
import { generateProductionTasks } from '../src/production/generate.js';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_APP_SECRET;
delete process.env.INBOUND_EMAIL_SECRET;

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
let clientId: string;
let amId: string;
let ownerId: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const ownerPhone = `8${String(stamp).slice(-9)}`;
const ownerEmail = `comms.${stamp}@example.com`;
const viewerEmail = `comms.viewer.${stamp}@example.com`;
const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(2000, 1)]);

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const waPayload = (from: string, id: string, text: string, name = 'Meera') => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, type: 'text', text: { body: text } }] } }] }],
});

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  amId = am.id;
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const viewerRole = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_viewer', isCustom: false } });
  const service = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Comms Test ${stamp}`, amUserId: am.id } });
  clientId = client.id;
  const owner = await prisma.user.create({ data: { orgId, type: 'client', name: 'Meera Owner', email: ownerEmail, phone: ownerPhone, status: 'active', roles: { create: { roleId: ownerRole.id } } } });
  ownerId = owner.id;
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  const viewer = await prisma.user.create({ data: { orgId, type: 'client', name: 'Vik Viewer', email: viewerEmail, status: 'active', roles: { create: { roleId: viewerRole.id } } } });
  await prisma.clientUser.create({ data: { userId: viewer.id, orgId, clientOrgId: client.id, clientRole: 'client_viewer', brandScope: [] } });
  const eng = await prisma.engagement.create({
    data: { orgId, clientOrgId: client.id, serviceId: service.id, tier: 'growth', billingType: 'monthly', status: 'in_production', currentGate: 'G3', amId: am.id, cycles: { create: { orgId, period: '2026-10', rcdAt: new Date(), status: 'production' } } },
  });
  ids.engagement = eng.id;
  // Clean slate for the AM's calendar so the slot checks are predictable.
  await prisma.meeting.deleteMany({ where: { hostId: am.id } });
  await prisma.bookingPage.deleteMany({ where: { userId: am.id } });
  for (const who of ['am', 'producer', 'qc', 'founder', 'sales', 'admin']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn(ownerEmail);
  tokens.viewer = await signIn(viewerEmail);
});

afterAll(async () => {
  await app?.close();
});

describe('shared inbox', () => {
  it('a WhatsApp from a known client number lands on that client’s thread and in the AM’s inbox', async () => {
    const r = await http().post('/webhooks/whatsapp').send(waPayload(`91${ownerPhone}`, `wamid.${stamp}.1`, 'Hi! Can we move the Diwali post to Friday?')).expect(200);
    expect(r.body).toMatchObject({ ok: true, received: 1 });
    // Meta retries the same message id: stored once.
    await http().post('/webhooks/whatsapp').send(waPayload(`91${ownerPhone}`, `wamid.${stamp}.1`, 'Hi! Can we move the Diwali post to Friday?')).expect(200);

    const list = (await http().get('/inbox').set(as('am')).expect(200)).body as InboxList;
    const row = list.items.find((c) => c.client?.id === clientId)!;
    expect(row).toMatchObject({ channel: 'whatsapp', address: ownerPhone, name: 'Meera Owner', unread: 1, assignee: { id: amId } });
    ids.conv = row.id;
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: row.id } });
    expect(conv.userId).toBe(ownerId);
    const msgs = await prisma.conversationMessage.findMany({ where: { conversationId: row.id } });
    expect(msgs).toHaveLength(1);
    // On the client's thread, written by the client, marked as WhatsApp.
    const threadMsg = await prisma.message.findUniqueOrThrow({ where: { id: msgs[0].messageId! } });
    expect(threadMsg).toMatchObject({ threadId: conv.threadId, authorId: ownerId, source: 'whatsapp' });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: conv.threadId! } });
    expect(thread).toMatchObject({ clientOrgId: clientId, type: 'client_am' });
    const clientView = (await http().get('/client/thread').set(as('client')).expect(200)).body;
    expect(JSON.stringify(clientView)).toContain('move the Diwali post to Friday');
    // The AM was told, with a link straight to the conversation.
    const note = await prisma.notification.findFirst({ where: { userId: amId, link: `/team/inbox?c=${row.id}` } });
    expect(note?.kind).toBe('inbox_message');
  });

  it('the AM opens it (marked read), uses a template and replies on WhatsApp; the reply is on the thread too', async () => {
    const tpl = (await http().post('/inbox/templates').set(as('am')).send({ name: `Thanks ${stamp}`, channel: 'whatsapp', body: 'Hi {first_name}, thanks! {my_name} here.' }).expect(201)).body;
    const d = (await http().get(`/inbox/${ids.conv}`).set(as('am')).expect(200)).body as InboxDetail;
    expect(d.unread).toBe(0);
    expect(d.variables.first_name).toBe('Meera');
    expect(d.templates.some((t) => t.id === tpl.id)).toBe(true);
    const after = (await http().post(`/inbox/${ids.conv}/reply`).set(as('am')).send({ body: 'Hi Meera, yes, moving it to Friday.' }).expect(201)).body as InboxDetail;
    const out = after.messages.at(-1)!;
    expect(out).toMatchObject({ direction: 'out', status: 'queued' });
    const wa = await prisma.whatsAppMessage.findFirst({ where: { toPhone: { endsWith: ownerPhone }, source: 'inbox' }, orderBy: { createdAt: 'desc' } });
    expect(wa?.body).toContain('moving it to Friday');
    const onThread = await prisma.message.findFirst({ where: { threadId: d.threadId!, body: { contains: 'moving it to Friday' } } });
    expect(onThread?.authorId).toBe(amId);
    // AI off: the draft still comes back in basic mode.
    const draft = (await http().post(`/inbox/${ids.conv}/draft`).set(as('am')).expect(201)).body;
    expect(draft.basic).toBe(true);
    expect(draft.body).toContain('Meera');
    await http().delete(`/inbox/templates/${tpl.id}`).set(as('am')).expect(200);
  });

  it('an unknown number is unassigned and goes to leadership; a lead’s number lands on the lead', async () => {
    const stranger = `91${String(stamp + 7).slice(-10)}`;
    await http().post('/webhooks/whatsapp').send(waPayload(stranger, `wamid.${stamp}.2`, 'What do you charge for reels?', 'Ravi')).expect(200);
    const un = (await http().get('/inbox?box=unassigned').set(as('founder')).expect(200)).body as InboxList;
    const row = un.items.find((c) => c.address === stranger.slice(-10))!;
    expect(row).toMatchObject({ client: null, lead: null, assignee: null, name: 'Ravi' });

    const leadPhone = `7${String(stamp).slice(-9)}`;
    const sales = await prisma.user.findFirstOrThrow({ where: { email: 'sales@bmu.demo' } });
    const lead = await prisma.lead.create({ data: { orgId, source: 'website', contact: { name: 'Anil', company: `Anil Foods ${stamp}`, phone: `+91${leadPhone}` }, need: 'Reels', ownerId: sales.id, serviceIds: [] } });
    await http().post('/webhooks/whatsapp').send(waPayload(`91${leadPhone}`, `wamid.${stamp}.3`, 'Sending the brief today')).expect(200);
    const mine = (await http().get('/inbox?box=mine').set(as('sales')).expect(200)).body as InboxList;
    expect(mine.items.find((c) => c.lead?.id === lead.id)).toBeTruthy();
    const act = await prisma.leadActivity.findFirst({ where: { leadId: lead.id, kind: 'whatsapp' } });
    expect(act?.body).toContain('Sending the brief today');
    // The AM does not see a lead conversation that belongs to sales.
    const amList = (await http().get('/inbox').set(as('am')).expect(200)).body as InboxList;
    expect(amList.items.find((c) => c.lead?.id === lead.id)).toBeFalsy();
    // Producers have no inbox.
    await http().get('/inbox').set(as('producer')).expect(403);
  });

  it('assigns, links and closes a conversation', async () => {
    const un = (await http().get('/inbox?box=unassigned').set(as('founder')).expect(200)).body as InboxList;
    const id = un.items.find((c) => c.name === 'Ravi')!.id;
    const d = (await http().patch(`/inbox/${id}`).set(as('founder')).send({ assigneeId: amId, clientOrgId: clientId }).expect(200)).body as InboxDetail;
    expect(d).toMatchObject({ assignee: { id: amId }, client: { id: clientId } });
    const closed = (await http().patch(`/inbox/${id}`).set(as('am')).send({ status: 'closed' }).expect(200)).body as InboxDetail;
    expect(closed.status).toBe('closed');
    const list = (await http().get('/inbox?status=closed').set(as('am')).expect(200)).body as InboxList;
    expect(list.items.some((c) => c.id === id)).toBe(true);
  });

  it('checks the WhatsApp signature when the app secret is set, and Meta’s verify call', async () => {
    process.env.WHATSAPP_APP_SECRET = 'test-secret';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
    try {
      const body = waPayload(`91${ownerPhone}`, `wamid.${stamp}.4`, 'Signed hello');
      await http().post('/webhooks/whatsapp').send(body).expect(401);
      await http().post('/webhooks/whatsapp').set('X-Hub-Signature-256', 'sha256=bad').send(body).expect(401);
      const sig = `sha256=${createHmac('sha256', 'test-secret').update(JSON.stringify(body)).digest('hex')}`;
      const ok = await http().post('/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(200);
      expect(ok.body.received).toBe(1);
      const v = await http().get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345').expect(200);
      expect(v.text).toBe('12345');
      await http().get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1').expect(403);
    } finally {
      delete process.env.WHATSAPP_APP_SECRET;
      delete process.env.WHATSAPP_VERIFY_TOKEN;
    }
  });

  it('inbound email needs its secret, then matches the client person by email', async () => {
    const mail = { from: ownerEmail, fromName: 'Meera', subject: 'Invoice question', text: 'Is GST included?', messageId: `<m${stamp}@mail>` };
    await http().post('/webhooks/email').send(mail).expect(403);
    process.env.INBOUND_EMAIL_SECRET = 'mail-secret';
    try {
      await http().post('/webhooks/email').set('X-BMU-Webhook-Secret', 'nope').send(mail).expect(401);
      const r = await http().post('/webhooks/email').set('X-BMU-Webhook-Secret', 'mail-secret').send(mail).expect(200);
      const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: r.body.conversationId } });
      expect(conv).toMatchObject({ channel: 'email', address: ownerEmail, clientOrgId: clientId, userId: ownerId, assigneeId: amId });
      const d = (await http().post(`/inbox/${conv.id}/reply`).set(as('am')).send({ body: 'Yes, GST is included.' }).expect(201)).body as InboxDetail;
      expect(d.messages.at(-1)!.subject).toBe('Re: Invoice question');
      const out = await prisma.emailOutbox.findFirst({ where: { toEmail: ownerEmail, subject: 'Re: Invoice question' } });
      expect(out).toBeTruthy();
    } finally {
      delete process.env.INBOUND_EMAIL_SECRET;
    }
  });
});

describe('one-tap approval from WhatsApp', () => {
  it('the client approves from the WhatsApp link and the work moves on', async () => {
    const cycle = await prisma.cycle.findFirstOrThrow({ where: { engagementId: ids.engagement } });
    const del = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'post', title: `Festive post ${stamp}` } });
    await generateProductionTasks(prisma, cycle.id);
    const up = (await http().post(`/deliverables/${del.id}/versions`).set(as('am')).attach('file', mp4, { filename: 'post.mp4', contentType: 'video/mp4' }).expect(201)).body as DeliverableDetail;
    const v = up.versions.at(-1)!;
    await http().post(`/deliverables/versions/${v.id}/qc`).set(as('qc')).send({ items: [{ label: 'Brand', ok: true }] }).expect(200);
    const since = new Date();
    await http().post(`/deliverables/versions/${v.id}/send`).set(as('am')).expect(200);
    const review = await prisma.task.findFirst({ where: { deliverableId: del.id, kind: 'client_review' } });
    const wa = await prisma.whatsAppMessage.findFirstOrThrow({ where: { entityId: del.id, source: 'proofing', createdAt: { gte: since } } });
    const token = /\/proof\/([\w-]+)/.exec(wa.body)?.[1];
    expect(token).toBeTruthy();
    const done = (await http().post(`/public/proof/${token}/decide`).send({ decision: 'approve' }).expect(200)).body as ProofLinkView;
    expect(done.status).toBe('approved');
    const d = (await http().get(`/deliverables/${del.id}`).set(as('am')).expect(200)).body as DeliverableDetail;
    expect(d.status).toBe('approved');
    expect(d.rounds?.at(-1)?.client).toMatchObject({ decision: 'approved', via: 'whatsapp' });
    if (review) expect((await prisma.task.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('done');
  });
});

describe('collaborative documents', () => {
  const enc = (u: Uint8Array) => Buffer.from(u).toString('base64');
  const dec = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

  it('the AM starts a brief for the project; the client sees it only once shared', async () => {
    const d = (await http().post('/docs').set(as('am')).send({ title: 'Diwali campaign brief', engagementId: ids.engagement, text: 'Goal: more store visits.\n' }).expect(201)).body as DocDetail;
    expect(d).toMatchObject({ client: { id: clientId }, kind: 'brief', clientVisible: false, can: { edit: true, share: true } });
    ids.doc = d.id;
    await http().get(`/docs/${d.id}`).set(as('client')).expect(404);
    expect(((await http().get('/client/docs').set(as('client')).expect(200)).body as DocDetail[]).length).toBe(0);
    await http().patch(`/docs/${d.id}`).set(as('am')).send({ clientVisible: true }).expect(200);
    expect(await prisma.notification.findFirst({ where: { userId: ownerId, kind: 'doc_shared', link: `/client/docs/${d.id}` } })).toBeTruthy();
    const seen = (await http().get(`/docs/${d.id}`).set(as('client')).expect(200)).body as DocDetail;
    expect(seen.can).toMatchObject({ edit: true, share: false });
    expect(((await http().get(`/docs/${d.id}`).set(as('viewer')).expect(200)).body as DocDetail).can.edit).toBe(false);
    await http().post(`/docs/${d.id}/edit`).set(as('viewer')).send({ update: 'AAA=' }).expect(403);
    expect(((await http().get(`/docs?engagementId=${ids.engagement}`).set(as('am')).expect(200)).body as DocDetail[]).some((x) => x.id === d.id)).toBe(true);
  });

  it('two people type at the same time and neither loses text', async () => {
    const start = (await http().get(`/docs/${ids.doc}`).set(as('am')).expect(200)).body as DocDetail;
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, dec(start.state));
    Y.applyUpdate(b, dec(start.state));
    const ta = a.getText('body');
    const tb = b.getText('body');
    // Both edit from the same starting text, before seeing each other's change.
    const svA = Y.encodeStateVector(a);
    const svB = Y.encodeStateVector(b);
    ta.insert(ta.length, 'Audience: families in Bengaluru.\n');
    tb.insert(0, 'DRAFT ');
    const upA = Y.encodeStateAsUpdate(a, svA);
    const upB = Y.encodeStateAsUpdate(b, svB);
    const [ra, rb] = await Promise.all([
      http().post(`/docs/${ids.doc}/edit`).set(as('am')).send({ update: enc(upA), sv: enc(Y.encodeStateVector(a)) }).expect(200),
      http().post(`/docs/${ids.doc}/edit`).set(as('client')).send({ update: enc(upB), sv: enc(Y.encodeStateVector(b)) }).expect(200),
    ]);
    Y.applyUpdate(a, dec(ra.body.update));
    Y.applyUpdate(b, dec(rb.body.update));
    // Whoever saved first is caught up by pulling.
    Y.applyUpdate(a, dec((await http().post(`/docs/${ids.doc}/pull`).set(as('am')).send({ sv: enc(Y.encodeStateVector(a)) }).expect(200)).body.update));
    Y.applyUpdate(b, dec((await http().post(`/docs/${ids.doc}/pull`).set(as('client')).send({ sv: enc(Y.encodeStateVector(b)) }).expect(200)).body.update));
    const want = 'DRAFT Goal: more store visits.\nAudience: families in Bengaluru.\n';
    expect(ta.toString()).toBe(want);
    expect(tb.toString()).toBe(want);
    const saved = (await http().get(`/docs/${ids.doc}`).set(as('am')).expect(200)).body as DocDetail;
    expect(saved.text).toBe(want);
    expect(saved.version).toBeGreaterThanOrEqual(start.version + 2);
    // Many small edits racing from both sides still all land.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const doc = i % 2 ? a : b;
        const sv = Y.encodeStateVector(doc);
        doc.getText('body').insert(0, `${i}`);
        return http().post(`/docs/${ids.doc}/edit`).set(as(i % 2 ? 'am' : 'client')).send({ update: enc(Y.encodeStateAsUpdate(doc, sv)) }).expect(200);
      }),
    );
    const final = (await http().get(`/docs/${ids.doc}`).set(as('am')).expect(200)).body as DocDetail;
    for (let i = 0; i < 10; i++) expect(final.text).toContain(`${i}`);
    expect(final.text).toContain('Audience: families in Bengaluru.');
    await http().post(`/docs/${ids.doc}/edit`).set(as('am')).send({ update: 'bm90IHlqcw==' }).expect(400);
  });
});

describe('meetings', () => {
  it('the client books a call with their AM from free slots; the slot is then taken', async () => {
    const page = (await http().get('/meetings/booking-page').set(as('am')).expect(200)).body;
    expect(page.slug).toBeTruthy();
    await http().put('/meetings/booking-page').set(as('am')).send({ title: 'Call with your AM', durationMin: 30, days: [1, 2, 3, 4, 5, 6, 7], startTime: '10:00', endTime: '18:00', noticeHours: 2, active: true }).expect(200);
    const slots = (await http().get('/client/meetings/slots').set(as('client')).expect(200)).body as BookingSlots;
    expect(slots.durationMin).toBe(30);
    expect(slots.days.length).toBeGreaterThan(5);
    const pick = slots.days[1].slots[0];
    const m = (await http().post('/client/meetings').set(as('client')).send({ startAt: pick, agenda: 'Plan November' }).expect(201)).body as MeetingView;
    expect(m).toMatchObject({ bookedVia: 'client', status: 'booked', host: { id: amId }, client: { id: clientId }, notes: null });
    ids.meeting = m.id;
    await http().post('/client/meetings').set(as('client')).send({ startAt: pick }).expect(409);
    await http().post('/client/meetings').set(as('viewer')).send({ startAt: slots.days[1].slots[1] }).expect(403);
    const again = (await http().get('/client/meetings/slots').set(as('client')).expect(200)).body as BookingSlots;
    expect(again.days.flatMap((d) => d.slots)).not.toContain(pick);
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: ownerEmail, kind: 'meeting' }, orderBy: { createdAt: 'desc' } });
    const ics = /\/api(\/public\/meetings\/[\w]+\/ics\?t=[0-9a-f]+)/.exec(mail.text)?.[1];
    expect(ics).toBeTruthy();
    const file = await http().get(ics!).expect(200);
    expect(file.text).toContain('BEGIN:VEVENT');
    await http().get(`/public/meetings/${m.id}/ics?t=wrong`).expect(404);
    const list = (await http().get('/meetings').set(as('am')).expect(200)).body as MeetingList;
    expect(list.upcoming.some((x) => x.id === m.id)).toBe(true);
    expect(await prisma.notification.findFirst({ where: { userId: amId, kind: 'meeting' } })).toBeTruthy();
  });

  it('notes become a summary and action items (basic mode), then tasks', async () => {
    const notes = 'Discussed November plan. Client wants more reels.\n- [ ] Share reel ideas by Friday\nAction: send the revised quote\nRahul will book the shoot';
    await http().patch(`/meetings/${ids.meeting}`).set(as('am')).send({ notes }).expect(200);
    const s = (await http().post(`/meetings/${ids.meeting}/summarise`).set(as('am')).expect(200)).body;
    expect(s.basic).toBe(true);
    expect(s.actionItems).toEqual(['Share reel ideas by Friday', 'send the revised quote', 'Rahul will book the shoot']);
    await http().patch(`/meetings/${ids.meeting}`).set(as('am')).send({ summary: s.summary, actionItems: s.actionItems.map((text: string) => ({ text })), status: 'done' }).expect(200);
    const m = (await http().post(`/meetings/${ids.meeting}/tasks`).set(as('am')).send({ items: [0, 1] }).expect(201)).body as MeetingView;
    expect(m.actionItems.filter((a) => a.taskId)).toHaveLength(2);
    const t = await prisma.task.findUniqueOrThrow({ where: { id: m.actionItems[0].taskId! } });
    expect(t).toMatchObject({ ownerId: amId, engagementId: ids.engagement, title: 'Share reel ideas by Friday' });
    await http().post(`/meetings/${ids.meeting}/tasks`).set(as('am')).send({ items: [0] }).expect(400);
    // The client sees the summary but never the team's notes.
    const c = (await http().get('/client/meetings').set(as('client')).expect(200)).body as MeetingList;
    const mine = [...c.upcoming, ...c.past].find((x) => x.id === ids.meeting)!;
    expect(mine.summary).toBeTruthy();
    expect(mine.notes).toBeNull();
    await http().patch(`/meetings/${ids.meeting}`).set(as('sales')).send({ notes: 'x' }).expect(404);
  });

  it('anyone can book from the public link; it creates a lead owned by the host', async () => {
    const page = (await http().get('/meetings/booking-page').set(as('am')).expect(200)).body;
    const slots = (await http().get(`/public/book/${page.slug}`).expect(200)).body as BookingSlots;
    const pick = slots.days[2].slots[2];
    const email = `prospect.${stamp}@example.com`;
    const r = await http().post(`/public/book/${page.slug}`).send({ startAt: pick, name: 'Priya', email, company: `Priya Cafe ${stamp}`, agenda: 'Want Instagram help' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, startAt: pick });
    const lead = await prisma.lead.findFirstOrThrow({ where: { orgId, contact: { path: ['email'], equals: email } } });
    expect(lead).toMatchObject({ source: 'booking', ownerId: amId });
    const m = await prisma.meeting.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(m).toMatchObject({ bookedVia: 'public', guestEmail: email });
    await http().post(`/public/book/${page.slug}`).send({ startAt: pick, name: 'Priya', email }).expect(409);
    await http().get('/public/book/not-a-page').expect(404);
    // The host cancels; the guest gets an email.
    await http().post(`/meetings/${m.id}/cancel`).set(as('am')).expect(200);
    expect(await prisma.emailOutbox.findFirst({ where: { toEmail: email, subject: { startsWith: 'Cancelled' } } })).toBeTruthy();
  });
});

describe('notification router', () => {
  it('works out quiet hours across midnight and the next send time (IST)', () => {
    const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00+05:30`);
    expect(inQuietHours('21:00', '08:00', at('23:30'))).toBe(true);
    expect(inQuietHours('21:00', '08:00', at('07:59'))).toBe(true);
    expect(inQuietHours('21:00', '08:00', at('12:00'))).toBe(false);
    expect(inQuietHours('13:00', '14:00', at('13:30'))).toBe(true);
    expect(nextIst(at('23:30'), '08:00').toISOString()).toBe(new Date('2026-10-06T08:00:00+05:30').toISOString());
    expect(nextIst(at('07:00'), '08:00').toISOString()).toBe(new Date('2026-10-05T08:00:00+05:30').toISOString());
  });

  it('saves WhatsApp, quiet hours and digest choices', async () => {
    const before = (await http().get('/service/notification-preferences').set(as('am')).expect(200)).body as ServiceNotificationPrefsView;
    expect(before.prefs.find((p) => p.kind === 'inbox_message')).toHaveProperty('whatsapp');
    const prefs = before.prefs.map((p) => ({ kind: p.kind, inApp: p.inApp, email: p.email, whatsapp: p.kind === 'inbox_message' }));
    // Quiet all day long (00:00 to 23:59) so the test does not depend on the clock.
    const after = (await http().put('/service/notification-preferences').set(as('am')).send({ prefs, quietStart: '00:00', quietEnd: '23:59' }).expect(200)).body as ServiceNotificationPrefsView;
    expect(after).toMatchObject({ quietStart: '00:00', quietEnd: '23:59', digest: 'off' });
    expect(after.prefs.find((p) => p.kind === 'inbox_message')?.whatsapp).toBe(true);
  });

  it('holds the AM’s WhatsApp copy during quiet hours and sends it after', async () => {
    const am = await prisma.user.findUniqueOrThrow({ where: { id: amId } });
    if (!am.phone) await prisma.user.update({ where: { id: amId }, data: { phone: '9876501234' } });
    const phone = (await prisma.user.findUniqueOrThrow({ where: { id: amId } })).phone!;
    const notifications = app.get(NotificationsService);
    const quiet = new Date(Date.now() - 1000);
    await notifications.notify(orgId, [amId], { kind: 'inbox_message', title: `Quiet test ${stamp}`, body: 'Hello', link: '/team/inbox' });
    const held = await prisma.notificationDelivery.findFirstOrThrow({ where: { userId: amId, title: `Quiet test ${stamp}` } });
    expect(held).toMatchObject({ channel: 'whatsapp', reason: 'quiet', sentAt: null });
    expect(await prisma.whatsAppMessage.findFirst({ where: { toPhone: phone, body: { contains: `Quiet test ${stamp}` }, createdAt: { gte: quiet } } })).toBeNull();
    // The same unread alert again within 10 minutes is not repeated in the app.
    await notifications.notify(orgId, [amId], { kind: 'inbox_message', title: `Quiet test ${stamp}`, body: 'Hello', link: '/team/inbox' });
    expect(await prisma.notification.count({ where: { userId: amId, title: `Quiet test ${stamp}` } })).toBe(1);
    // Money alerts are never held.
    await notifications.notify(orgId, [amId], { kind: 'payment_received', title: `Paid ${stamp}`, body: 'x' });
    expect(await prisma.notificationDelivery.count({ where: { title: `Paid ${stamp}` } })).toBe(0);
    const r = await notifications.flushDue(new Date(held.sendAfter.getTime() + 1000));
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(await prisma.whatsAppMessage.findFirst({ where: { toPhone: phone, body: { contains: `Quiet test ${stamp}` } } })).toBeTruthy();
    await http().put('/service/notification-preferences').set(as('am')).send({ prefs: [{ kind: 'inbox_message', inApp: true, email: true, whatsapp: false }], quietStart: null, quietEnd: null }).expect(200);
  });

  it('bundles a client’s emails into one daily digest', async () => {
    await http().put('/service/notification-preferences').set(as('client')).send({ prefs: [], digest: 'daily', digestHour: 18 }).expect(200);
    const notifications = app.get(NotificationsService);
    await notifications.notify(orgId, [ownerId], { kind: 'message', title: `Digest one ${stamp}`, body: 'a', link: '/client/messages' });
    await notifications.notify(orgId, [ownerId], { kind: 'request_update', title: `Digest two ${stamp}`, body: 'b', link: '/client/requests' });
    const held = await prisma.notificationDelivery.findMany({ where: { userId: ownerId, sentAt: null, reason: 'digest' } });
    expect(held.length).toBeGreaterThanOrEqual(2);
    const prefs = (await http().get('/service/notification-preferences').set(as('client')).expect(200)).body as ServiceNotificationPrefsView;
    expect(prefs.waiting).toBeGreaterThanOrEqual(2);
    expect(await prisma.emailOutbox.findFirst({ where: { toEmail: ownerEmail, subject: `Digest one ${stamp}` } })).toBeNull();
    await notifications.flushDue(new Date(held[0].sendAfter.getTime() + 1000));
    const digest = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: ownerEmail, kind: 'digest' }, orderBy: { createdAt: 'desc' } });
    expect(digest.text).toContain(`Digest one ${stamp}`);
    expect(digest.text).toContain(`Digest two ${stamp}`);
    await http().put('/service/notification-preferences').set(as('client')).send({ prefs: [], digest: 'off' }).expect(200);
  });
});
