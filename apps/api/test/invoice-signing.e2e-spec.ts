// v28 invoice signing: a Founder sets the signing password and turns on "invoices go to clients only after they are
// signed". Invoices made from then on (by hand or automatically) are held: the client cannot see, pay or hear about
// them, and the Founders are told they are waiting. Signing with the password adds the seal and signature and sends
// the invoice. Wrong passwords are logged and, from the third, the Founders are alerted (no lock-out).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { CmInvoiceList, InvoiceBrandingView, InvoiceSignResult, ServiceClientBilling, ServiceTaxInvoice, SigningProfileView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ServiceBillingService } from '../src/service/service-billing.service.js';

delete process.env.ANTHROPIC_API_KEY;

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const since = new Date();
const PASSWORD = `Seal-${stamp}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const dueIn = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + days * 86_400_000));

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
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', client: 'client@sunrise.demo', cm: 'am@bmu.demo', producer: 'producer@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.sunrise = (await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' }, select: { clientUser: { select: { clientOrgId: true } } } })).clientUser!.clientOrgId;
});

afterAll(async () => {
  // Leave the demo organisation as other tests expect it: signing not required.
  await http().put('/finance/invoice-branding/rule').set(as('founder')).send({ requireSignature: false });
  await app.close();
});

describe('invoice signing', () => {
  it('only a Founder sets the signing password and turns the rule on (after the signature and seal are uploaded)', async () => {
    await http().put('/finance/invoice-branding/password').set(as('admin')).send({ password: PASSWORD, confirm: PASSWORD }).expect(403);
    await http().put('/finance/invoice-branding/password').set(as('founder')).send({ password: 'short', confirm: 'short' }).expect(400);
    await http().put('/finance/invoice-branding/password').set(as('founder')).send({ password: PASSWORD, confirm: `${PASSWORD}x` }).expect(400);
    await http().delete('/finance/invoice-branding/seal').set(as('founder')).expect(200);
    let b = (await http().put('/finance/invoice-branding/password').set(as('founder')).send({ password: PASSWORD, confirm: PASSWORD }).expect(200)).body as InvoiceBrandingView;
    expect(b.passwordSet).toBe(true);
    expect(JSON.stringify(b)).not.toContain(PASSWORD);
    // The password is stored only as a hash.
    const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { settings: true } });
    expect(JSON.stringify(org.settings)).not.toContain(PASSWORD);
    await http().put('/finance/invoice-branding/rule').set(as('founder')).send({ requireSignature: true }).expect(400); // seal missing
    await http().post('/finance/invoice-branding/signature').set(as('founder')).attach('file', png, { filename: 'sign.png', contentType: 'image/png' }).expect(200);
    await http().post('/finance/invoice-branding/seal').set(as('founder')).attach('file', png, { filename: 'seal.png', contentType: 'image/png' }).expect(200);
    await http().put('/finance/invoice-branding/rule').set(as('admin')).send({ requireSignature: true }).expect(403);
    b = (await http().put('/finance/invoice-branding/rule').set(as('founder')).send({ requireSignature: true }).expect(200)).body as InvoiceBrandingView;
    expect(b.requireSignature).toBe(true);
    expect(b.requiredSince).toBeTruthy();
  });

  it('a new invoice is held: the client cannot see, pay or hear about it; the Founders are told it waits', async () => {
    const r = (await http().post('/ops/finance/invoices').set(as('admin')).send({ clientOrgId: ids.sunrise, dueDate: dueIn(10), issue: true, lines: [{ label: `held work ${stamp}`, kind: 'service', amountPaise: 1234500 }] }).expect(201)).body as { id: string; number: string };
    ids.held = r.id;
    ids.number = r.number;
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.id } });
    expect(inv.deliveryHeldAt).toBeTruthy();
    expect(inv.signedAt).toBeNull();
    const billing = (await http().get('/service/client/billing').set(as('client')).expect(200)).body as ServiceClientBilling;
    expect(billing.invoices.some((i) => i.id === r.id)).toBe(false);
    await http().get(`/service/client/invoices/${r.id}/tax-invoice`).set(as('client')).expect(404);
    expect(((await http().get('/client/invoices').set(as('client')).expect(200)).body as { id: string }[]).some((i) => i.id === r.id)).toBe(false);
    await http().post(`/client/invoices/${r.id}/checkout`).set(as('client')).expect(404);
    expect(await prisma.notification.findFirst({ where: { userId: users.client, createdAt: { gte: since }, title: { contains: r.number } } })).toBeNull();
    expect(await prisma.notification.findFirst({ where: { userId: users.founder, createdAt: { gte: since }, title: `Invoice ${r.number} is waiting for your signature` } })).toBeTruthy();
    // It is on the waiting list, and the team sees it as held.
    const b = (await http().get('/finance/invoice-branding').set(as('founder')).expect(200)).body as InvoiceBrandingView;
    expect(b.waiting.some((w) => w.id === r.id)).toBe(true);
    const t = (await http().get(`/service/finance/invoices/${r.id}/tax-invoice`).set(as('admin')).expect(200)).body as ServiceTaxInvoice;
    expect(t.signing).toMatchObject({ signed: false, held: true, canSign: true });
    expect(t.signatory.signatureUrl).toBeNull();
    // Sending it again or reminding is refused until it is signed.
    await http().post(`/service/finance/invoices/${r.id}/email`).set(as('admin')).expect(400);
  });

  it('wrong passwords are logged and alert the Founders from the third, without locking', async () => {
    for (let i = 1; i <= 3; i++) await http().post(`/finance/invoices/${ids.held}/sign`).set(as('admin')).send({ password: `wrong-${i}` }).expect(403);
    expect(await prisma.auditEvent.count({ where: { actorId: users.admin, action: 'invoice.sign_failed', at: { gte: since } } })).toBeGreaterThanOrEqual(3);
    const alert = await prisma.notification.findFirst({ where: { userId: users.founder, createdAt: { gte: since }, title: { startsWith: 'Signing password entered wrongly' } } });
    expect(alert?.body).toContain(ids.number);
    expect(alert?.critical).toBe(true);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ids.held } })).signedAt).toBeNull();
  });

  it('the right password adds the seal and signature and sends the invoice to the client', async () => {
    const r = (await http().post(`/finance/invoices/${ids.held}/sign`).set(as('admin')).send({ password: PASSWORD }).expect(200)).body as InvoiceSignResult;
    expect(r).toMatchObject({ signed: true, delivered: true });
    await http().post(`/finance/invoices/${ids.held}/sign`).set(as('admin')).send({ password: PASSWORD }).expect(400); // already signed
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.held } });
    expect(inv.signedById).toBe(users.admin);
    expect(inv.deliveryHeldAt).toBeNull();
    expect(await prisma.notification.findFirst({ where: { userId: users.client, createdAt: { gte: since }, title: { contains: ids.number } } })).toBeTruthy();
    const t = (await http().get(`/service/client/invoices/${ids.held}/tax-invoice`).set(as('client')).expect(200)).body as ServiceTaxInvoice;
    expect(t.signing.signed).toBe(true);
    expect(t.signatory.signatureUrl).toBeTruthy();
    expect(t.signatory.sealUrl).toBeTruthy();
    const billing = (await http().get('/service/client/billing').set(as('client')).expect(200)).body as ServiceClientBilling;
    expect(billing.invoices.some((i) => i.id === ids.held)).toBe(true);
  });

  it('an automatic invoice is held the same way until it is signed', async () => {
    const { orgId } = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.held }, select: { orgId: true } });
    const auto = await prisma.invoice.create({ data: { orgId, clientOrgId: ids.sunrise, number: `AUTO-${stamp}`, lines: [{ label: 'Retainer', amountPaise: 100000 }], subtotalPaise: 100000, gstPaise: 18000, totalPaise: 118000, dueDate: new Date(Date.now() + 7 * 86_400_000), status: 'issued', kind: 'retainer' } });
    expect(await app.get(ServiceBillingService).invoiceIssued(auto.id)).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: auto.id } })).deliveryHeldAt).toBeTruthy();
    await http().get(`/service/client/invoices/${auto.id}/tax-invoice`).set(as('client')).expect(404);
    const r = (await http().post(`/finance/invoices/${auto.id}/sign`).set(as('founder')).send({ password: PASSWORD }).expect(200)).body as InvoiceSignResult;
    expect(r.delivered).toBe(true);
    await http().get(`/service/client/invoices/${auto.id}/tax-invoice`).set(as('client')).expect(200);
  });

  it('a Client Manager creates and signs invoices for their own clients with their own signature and password', async () => {
    // Neha (Client Manager) manages Sunrise; another client is not hers.
    await prisma.clientOrg.update({ where: { id: ids.sunrise }, data: { amUserId: users.cm } });
    const other = await prisma.clientOrg.create({ data: { orgId: (await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.sunrise } })).orgId, name: `Not hers ${stamp}` } });
    await prisma.signingProfile.deleteMany({ where: { userId: users.cm } }); // a clean start on every run
    await http().get('/finance/my-signing').set(as('producer')).expect(403);
    let p = (await http().get('/finance/my-signing').set(as('cm')).expect(200)).body as SigningProfileView;
    expect(p).toMatchObject({ designation: 'Client Manager', passwordSet: false, ready: false });
    p = (await http().post('/finance/my-signing/signature').set(as('cm')).attach('file', png, { filename: 'neha.png', contentType: 'image/png' }).expect(200)).body;
    p = (await http().put('/finance/my-signing/password').set(as('cm')).send({ password: `Neha-${stamp}`, confirm: `Neha-${stamp}` }).expect(200)).body;
    expect(p.ready).toBe(true);
    // The New invoice form lists only her clients; she cannot invoice another client.
    const opts = (await http().get('/ops/finance/options').set(as('cm')).expect(200)).body as { clients: { id: string }[] };
    expect(opts.clients.some((c) => c.id === ids.sunrise)).toBe(true);
    expect(opts.clients.some((c) => c.id === other.id)).toBe(false);
    await http().post('/ops/finance/invoices').set(as('cm')).send({ clientOrgId: other.id, dueDate: dueIn(10), issue: true, lines: [{ label: 'x', kind: 'service', amountPaise: 100000 }] }).expect((r) => expect([400, 403]).toContain(r.status));
    const made = (await http().post('/ops/finance/invoices').set(as('cm')).send({ clientOrgId: ids.sunrise, dueDate: dueIn(10), issue: true, lines: [{ label: `cm work ${stamp}`, kind: 'service', amountPaise: 2500000 }] }).expect(201)).body as { id: string; number: string };
    // Held, and she is told it waits for her signature.
    expect(await prisma.notification.findFirst({ where: { userId: users.cm, createdAt: { gte: since }, title: `Invoice ${made.number} is waiting for your signature`, link: `/team/invoices/${made.id}` } })).toBeTruthy();
    const list = (await http().get('/finance/cm/invoices').set(as('cm')).expect(200)).body as CmInvoiceList;
    expect(list.waiting.some((w) => w.id === made.id)).toBe(true);
    const view = (await http().get(`/finance/cm/invoices/${made.id}/tax-invoice`).set(as('cm')).expect(200)).body as ServiceTaxInvoice;
    expect(view.signing).toMatchObject({ held: true, canSign: true });
    // The company password is not hers; her own one signs.
    await http().post(`/finance/invoices/${made.id}/sign`).set(as('cm')).send({ password: PASSWORD }).expect(403);
    const r = (await http().post(`/finance/invoices/${made.id}/sign`).set(as('cm')).send({ password: `Neha-${stamp}` }).expect(200)).body as InvoiceSignResult;
    expect(r.delivered).toBe(true);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: made.id } });
    expect(inv).toMatchObject({ signedRole: 'client_manager', signedById: users.cm, signatoryDesignation: 'Client Manager' });
    const t = (await http().get(`/service/client/invoices/${made.id}/tax-invoice`).set(as('client')).expect(200)).body as ServiceTaxInvoice;
    expect(t.signatory).toMatchObject({ name: 'Neha Iyer', designation: 'Client Manager', signatureUrl: `/api/invoice-branding/file/${p.signature!.url.split('/').pop()}` });
    expect(t.signatory.sealUrl).toBeTruthy();
    const img = await http().get(t.signatory.signatureUrl!.replace(/^\/api/, '')).set(as('client'));
    expect([200, 302]).toContain(img.status);
    // A signed invoice keeps the signature it was signed with.
    await http().post('/finance/my-signing/signature').set(as('cm')).attach('file', png, { filename: 'neha2.png', contentType: 'image/png' }).expect(200);
    const again = (await http().get(`/service/client/invoices/${made.id}/tax-invoice`).set(as('client')).expect(200)).body as ServiceTaxInvoice;
    expect(again.signatory.signatureUrl).toBe(t.signatory.signatureUrl);
    // She cannot see or sign another client's invoice.
    const theirs = await prisma.invoice.create({ data: { orgId: inv.orgId, clientOrgId: other.id, number: `OTHER-${stamp}`, lines: [{ label: 'x', amountPaise: 100000 }], subtotalPaise: 100000, gstPaise: 18000, totalPaise: 118000, dueDate: new Date(Date.now() + 7 * 86_400_000), status: 'issued', kind: 'standard' } });
    await http().get(`/finance/cm/invoices/${theirs.id}/tax-invoice`).set(as('cm')).expect(404);
    await http().post(`/finance/invoices/${theirs.id}/sign`).set(as('cm')).send({ password: `Neha-${stamp}` }).expect(403);
    // When the Founder signs, the invoice says "Founder".
    await http().post(`/finance/invoices/${theirs.id}/sign`).set(as('founder')).send({ password: PASSWORD }).expect(200);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ signedRole: 'founder', signatoryDesignation: expect.any(String) });
  });
});
