// v45 quotations: the CM makes one from a template, sends it, the client's Owner accepts it in the app and the advance
// invoice follows; the CM raises the balance invoice later.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86400000).toISOString().slice(0, 10);
const made: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  tokens.client = await signIn('client@sunrise.demo');
  ids.clientUser = (await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' } })).id;
  ids.sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: ids.clientUser } })).clientOrgId;
  const cm = (await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.sunrise }, include: { am: true } })).am!;
  tokens.cm = await signIn(cm.email!);
  tokens.producer = await signIn('producer@bmu.demo');
  tokens.founder = await signIn('founder@bmu.demo');
});

afterAll(async () => {
  const qs = await prisma.quotation.findMany({ where: { id: { in: made } } });
  const inv = qs.flatMap((q) => [q.advanceInvoiceId, q.balanceInvoiceId]).filter((x): x is string => !!x);
  await prisma.invoice.deleteMany({ where: { id: { in: inv } } }).catch(() => undefined);
  await prisma.quotation.deleteMany({ where: { id: { in: made } } });
  await app.close();
});

describe('quotations (v45)', () => {
  it('template → quote → send → client accepts → advance invoice; then the balance invoice', async () => {
    const templates = (await http().get('/quotes/templates').set(as('cm')).expect(200)).body as { id: string; name: string; lines: unknown[]; title: string }[];
    const tpl = templates.find((t) => t.name === 'Influencer Campaign')!;
    expect(tpl.lines).toHaveLength(2);

    const { id: _id, name: _n, serviceKey: _s, updatedAt: _u, ...content } = tpl as unknown as Record<string, unknown>;
    // v46: several of the client's services; the terms are fixed whatever is sent.
    const services = await prisma.engagement.findMany({ where: { clientOrgId: ids.sunrise, deletedAt: null }, select: { id: true, service: { select: { name: true } } }, take: 2 });
    expect(services.length).toBe(2);
    const body = { ...content, terms: [{ title: 'Changed', text: 'Someone tried to change the terms' }], clientOrgId: ids.sunrise, engagementIds: services.map((s) => s.id), templateId: tpl.id, preparedFor: ['Real Estate Developer', 'Bengaluru, Karnataka'], validUntil: inDays(15) };
    await http().post('/quotes').set(as('cm')).send({ ...body, engagementIds: ['not-this-client'] }).expect(400);
    await http().post('/quotes').set(as('producer')).send(body).expect(403);
    const res = await http().post('/quotes').set(as('cm')).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const q = res.body;
    made.push(q.id);
    // 6 × ₹10,000 + 15% management = ₹69,000; GST 18% ₹12,420; total ₹81,420 (as in BMU's quotation).
    expect(q).toMatchObject({ status: 'draft', subtotalPaise: 6_900_000, gstPaise: 1_242_000, totalPaise: 8_142_000 });
    expect(q.amounts).toEqual([6_000_000, 900_000]);
    expect(q.services.sort()).toEqual(services.map((s) => s.service.name).sort());
    expect(q.content.terms.map((t: { title: string }) => t.title)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(q.content.terms[7].text).toContain("30 days' written notice");

    // v49: the project overview: written for the manager, who can change it.
    await http().post('/quotes/overview').set(as('producer')).send({ title: 'x' }).expect(403);
    await http().post('/quotes/overview').set(as('cm')).send({}).expect(400);
    const written = (await http().post('/quotes/overview').set(as('cm')).send({ clientOrgId: ids.sunrise, title: 'Web & AI', lines: [{ title: 'AI Chatbots' }] }).expect(200)).body;
    expect(written.text).toContain('AI Chatbots');
    expect(q.number).toMatch(/^BMU\/Q\/\d{4}\/\d{4}$/);

    // Drafts aren't visible to the client.
    await http().get(`/client/quotes/${q.id}`).set(as('client')).expect(404);
    const sent = (await http().post(`/quotes/${q.id}/send`).set(as('cm')).expect(200)).body;
    expect(sent.status).toBe('sent');
    expect(await prisma.notification.count({ where: { userId: ids.clientUser, kind: 'quote_ready', link: `/client/quotes/${q.id}` } })).toBe(1);

    const seen = (await http().get(`/client/quotes/${q.id}`).set(as('client')).expect(200)).body;
    expect(seen.can.decide).toBe(true);
    await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'accept' }).expect(400); // name needed
    await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'accept', name: 'Ravi Kumar' }).expect(400); // signature needed

    // v49: changes go back to the manager, who edits and sends again.
    await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'changes' }).expect(400);
    const back = (await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'changes', reason: 'Please add one more reel' }).expect(200)).body;
    expect(back).toMatchObject({ status: 'draft', changeRequest: 'Please add one more reel' });
    expect((await http().post(`/quotes/${q.id}/send`).set(as('cm')).expect(200)).body).toMatchObject({ status: 'sent', changeRequest: null });

    // v49: signed for BMU by the person who sent it.
    expect(seen.signer.role).toBe('Client Manager');

    // v49: the Owner adds a signature and accepts; no invoice yet.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await http().post(`/client/quotes/${q.id}/files/signature`).set(as('client')).attach('file', Buffer.from('nope'), { filename: 'a.txt', contentType: 'text/plain' }).expect(400);
    const sig = (await http().post(`/client/quotes/${q.id}/files/signature`).set(as('client')).attach('file', png, { filename: 'sign.png', contentType: 'image/png' }).expect(200)).body;
    await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'accept', name: 'Ravi Kumar', signatureFileId: 'not-mine' }).expect(400);
    await http().post(`/quotes/${q.id}/advance-invoice`).set(as('cm')).expect(400); // not accepted yet
    const ok = (await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'accept', name: 'Ravi Kumar', signatureFileId: sig.fileId }).expect(200)).body;
    expect(ok.status).toBe('accepted');
    expect(ok.acceptance.signatureUrl).toContain(sig.fileId);
    expect(ok.advanceInvoice).toBeNull();
    // Answering twice is refused.
    await http().post(`/client/quotes/${q.id}/decision`).set(as('client')).send({ decision: 'accept', name: 'Ravi Kumar', signatureFileId: sig.fileId }).expect(400);

    // v49: the client says they paid; the CM and Founders are told; the invoice then records it.
    const advanceTotal = Math.round(3_450_000 * 1.18);
    await http().post(`/client/quotes/${q.id}/paid`).set(as('client')).send({ amountPaise: advanceTotal }).expect(400);
    const told = (await http().post(`/client/quotes/${q.id}/paid`).set(as('client')).send({ amountPaise: advanceTotal, reference: 'UTR123456' }).expect(200)).body;
    expect(told.paymentNotes).toHaveLength(1);
    expect(await prisma.notification.count({ where: { kind: 'quote_paid', link: `/team/quotes/${q.id}` } })).toBeGreaterThanOrEqual(2);
    await http().post(`/quotes/${q.id}/balance-invoice`).set(as('cm')).expect(400); // the advance comes first
    const sentInv = (await http().post(`/quotes/${q.id}/advance-invoice`).set(as('cm')).expect(200)).body;
    expect(sentInv.advanceInvoice).toMatchObject({ totalPaise: advanceTotal, status: 'paid' });
    const adv = await prisma.invoice.findUniqueOrThrow({ where: { id: sentInv.advanceInvoice.id } });
    expect(adv).toMatchObject({ kind: 'quote_advance', clientOrgId: ids.sunrise, subtotalPaise: 3_450_000 });
    await http().post(`/quotes/${q.id}/advance-invoice`).set(as('cm')).expect(400);

    // The founder can do the same, and the invoice is in the quotation's design.
    const bal = (await http().post(`/quotes/${q.id}/balance-invoice`).set(as('founder')).expect(200)).body;
    expect(bal.balanceInvoice).toMatchObject({ totalPaise: advanceTotal, status: 'issued' });
    await http().post(`/quotes/${q.id}/balance-invoice`).set(as('cm')).expect(400);
    const tax = (await http().get(`/finance/cm/invoices/${bal.balanceInvoice.id}/tax-invoice`).set(as('cm')).expect(200)).body;
    expect(tax.quote).toMatchObject({ number: q.number, signedBy: { role: 'Client Manager' } });

    // A payment reported after the invoice went out is confirmed from the quotation.
    await http().post(`/client/quotes/${q.id}/paid`).set(as('client')).send({ amountPaise: advanceTotal, reference: 'UTR999999' }).expect(200);
    const seenAgain = (await http().get(`/quotes/${q.id}`).set(as('cm')).expect(200)).body;
    expect(seenAgain.can.confirmPayment).toBe(true);
    const done = (await http().post(`/quotes/${q.id}/confirm-payment`).set(as('cm')).expect(200)).body;
    expect(done.balanceInvoice.status).toBe('paid');
  });

  it('decline with a reason; an expired quote cannot be accepted', async () => {
    const tpl = ((await http().get('/quotes/templates').set(as('cm')).expect(200)).body as Record<string, unknown>[])[0];
    const { id: _id, name: _n, serviceKey: _s, updatedAt: _u, ...content } = tpl;
    const a = (await http().post('/quotes').set(as('cm')).send({ ...content, clientOrgId: ids.sunrise, validUntil: inDays(10) }).expect(201)).body;
    made.push(a.id);
    await http().post(`/quotes/${a.id}/send`).set(as('cm')).expect(200);
    const d = (await http().post(`/client/quotes/${a.id}/decision`).set(as('client')).send({ decision: 'decline', reason: 'Over budget' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'declined', declineReason: 'Over budget', advanceInvoice: null });

    const b = (await http().post('/quotes').set(as('cm')).send({ ...content, clientOrgId: ids.sunrise, validUntil: inDays(10) }).expect(201)).body;
    made.push(b.id);
    await http().post(`/quotes/${b.id}/send`).set(as('cm')).expect(200);
    await prisma.quotation.update({ where: { id: b.id }, data: { validUntil: new Date(`${inDays(-1)}T00:00:00Z`) } });
    await http().post(`/client/quotes/${b.id}/decision`).set(as('client')).send({ decision: 'accept', name: 'Ravi Kumar', signedCopyFileId: 'x' }).expect(400);
  });
});
