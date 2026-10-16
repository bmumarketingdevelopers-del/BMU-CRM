// v27 invoices: the Founder's short line descriptions become the printed wording (AI when on, plain wording when off),
// the tax invoice carries its design (due, paid, ...), BMU's contact details, the terms, and the Founder's signature and
// company seal, which only Founders can upload or change and every signed-in person of the client can see.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { InvoiceBrandingView, OpsInvoiceDescribeResult, ServiceTaxInvoice } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

delete process.env.ANTHROPIC_API_KEY;

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
// A 1x1 transparent PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const dueIn = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + days * 86_400_000));

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', client: 'client@sunrise.demo', am: 'am@bmu.demo' })) tokens[k] = await signIn(email);
  const client = await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' }, select: { clientUser: { select: { clientOrgId: true } } } });
  ids.sunrise = client.clientUser!.clientOrgId;
});

afterAll(async () => {
  await app.close();
});

describe('invoice wording, design and signature', () => {
  it('writes the printed wording for short descriptions (plain wording while AI is off)', async () => {
    const r = (await http().post('/ops/finance/invoices/describe').set(as('founder')).send({ clientOrgId: ids.sunrise, lines: [{ label: 'website redesign', kind: 'service' }, { label: 'meta ads october', kind: 'ad_spend' }] }).expect(200)).body as OpsInvoiceDescribeResult;
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].title).toBe('Website redesign');
    expect(r.lines[0].details).toContain('Sunrise Realty');
    expect(r.lines[1].details).toMatch(/at cost/);
    await http().post('/ops/finance/invoices/describe').set(as('am')).send({ lines: [{ label: 'seo', kind: 'service' }] }).expect(403);
  });

  it('saves the reviewed wording, or writes it when it was skipped', async () => {
    const reviewed = (await http()
      .post('/ops/finance/invoices')
      .set(as('founder'))
      .send({ clientOrgId: ids.sunrise, dueDate: dueIn(10), issue: false, lines: [{ label: 'logo', kind: 'service', amountPaise: 1500000, title: `Brand Logo Design ${stamp}`, details: 'Three logo concepts and two rounds of changes.' }] })
      .expect(201)).body as { id: string };
    const one = await prisma.invoice.findUniqueOrThrow({ where: { id: reviewed.id } });
    expect(one.lines).toEqual([expect.objectContaining({ label: 'logo', title: `Brand Logo Design ${stamp}`, details: 'Three logo concepts and two rounds of changes.' })]);
    const skipped = (await http().post('/ops/finance/invoices').set(as('founder')).send({ clientOrgId: ids.sunrise, dueDate: dueIn(10), issue: true, lines: [{ label: 'social media management', kind: 'service', amountPaise: 2500000 }] }).expect(201)).body as { id: string };
    ids.issued = skipped.id;
    const two = await prisma.invoice.findUniqueOrThrow({ where: { id: skipped.id } });
    expect(two.lines).toEqual([expect.objectContaining({ label: 'social media management', title: 'Social media management', details: expect.stringContaining('Sunrise Realty') })]);
  });

  it('the tax invoice carries its design, the printed wording, BMU contact details and the terms', async () => {
    const t = (await http().get(`/service/finance/invoices/${ids.issued}/tax-invoice`).set(as('founder')).expect(200)).body as ServiceTaxInvoice;
    expect(t.variant).toBe('due');
    expect(t.lines[0]).toMatchObject({ title: 'Social media management', passThrough: false });
    expect(t.lines[0].details).toContain('Sunrise Realty');
    expect(t.seller.email).toBeTruthy();
    expect(t.seller.phone).toBeTruthy();
    expect(t.terms.length).toBeGreaterThanOrEqual(4);
    expect(t.terms[0]).toContain(t.number);
    expect(t.signatory.designation).toBeTruthy();
    // Paid in full: the design becomes a receipt.
    const { orgId } = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.issued }, select: { orgId: true } });
    await prisma.payment.create({ data: { orgId, invoiceId: ids.issued, amountPaise: t.totalPaise, method: 'bank', ref: `UTR${stamp}` } });
    await prisma.invoice.update({ where: { id: ids.issued }, data: { status: 'paid' } });
    const paid = (await http().get(`/service/client/invoices/${ids.issued}/tax-invoice`).set(as('client')).expect(200)).body as ServiceTaxInvoice;
    expect(paid.variant).toBe('paid');
    expect(paid.payments[0]).toMatchObject({ ref: `UTR${stamp}`, amountPaise: t.totalPaise });
    expect(paid.balancePaise).toBe(0);
  });

  it('only a Founder uploads or changes the signature and seal; the client sees them on the invoice', async () => {
    await http().post('/finance/invoice-branding/signature').set(as('admin')).attach('file', png, { filename: 'sign.png', contentType: 'image/png' }).expect(403);
    await http().post('/finance/invoice-branding/signature').set(as('founder')).attach('file', Buffer.from('not an image'), { filename: 'sign.txt', contentType: 'text/plain' }).expect(400);
    await http().post('/finance/invoice-branding/wrong').set(as('founder')).attach('file', png, { filename: 'x.png', contentType: 'image/png' }).expect(400);
    let b = (await http().post('/finance/invoice-branding/signature').set(as('founder')).attach('file', png, { filename: 'sign.png', contentType: 'image/png' }).expect(200)).body as InvoiceBrandingView;
    expect(b.signature?.url).toMatch(/^\/api\/invoice-branding\/signature\?v=/);
    b = (await http().post('/finance/invoice-branding/seal').set(as('founder')).attach('file', png, { filename: 'seal.png', contentType: 'image/png' }).expect(200)).body as InvoiceBrandingView;
    expect(b.seal).toBeTruthy();
    b = (await http().put('/finance/invoice-branding').set(as('founder')).send({ signatoryName: 'Mukesh', designation: 'Founder & CEO' }).expect(200)).body as InvoiceBrandingView;
    expect(b).toMatchObject({ signatoryName: 'Mukesh', designation: 'Founder & CEO', canEdit: true });
    await http().put('/finance/invoice-branding').set(as('admin')).send({ signatoryName: 'Someone', designation: 'x' }).expect(403);
    expect(((await http().get('/finance/invoice-branding').set(as('admin')).expect(200)).body as InvoiceBrandingView).canEdit).toBe(false);
    // v28: printed only once the invoice is signed with the signing password; the client can load the images.
    let t = (await http().get(`/service/client/invoices/${ids.issued}/tax-invoice`).set(as('client')).expect(200)).body as ServiceTaxInvoice;
    expect(t.signatory).toMatchObject({ name: 'Mukesh', designation: 'Founder & CEO', signatureUrl: null, sealUrl: null });
    expect(t.signing.signed).toBe(false);
    await http().put('/finance/invoice-branding/password').set(as('founder')).send({ password: `sign-${stamp}`, confirm: `sign-${stamp}` }).expect(200);
    await http().post(`/finance/invoices/${ids.issued}/sign`).set(as('founder')).send({ password: `sign-${stamp}` }).expect(200);
    t = (await http().get(`/service/client/invoices/${ids.issued}/tax-invoice`).set(as('client')).expect(200)).body as ServiceTaxInvoice;
    expect(t.signing.signed).toBe(true);
    expect(t.signatory.signatureUrl).toBe(b.signature!.url);
    expect(t.signatory.sealUrl).toBe(b.seal!.url);
    const img = await http().get('/invoice-branding/signature').set(as('client'));
    expect([200, 302]).toContain(img.status);
    await http().get('/invoice-branding/signature').expect(401);
    // Changing it is reflected straight away; removing takes it off the invoice.
    const again = (await http().post('/finance/invoice-branding/signature').set(as('founder')).attach('file', png, { filename: 'sign2.png', contentType: 'image/png' }).expect(200)).body as InvoiceBrandingView;
    expect(again.signature!.url).not.toBe(b.signature!.url);
    await http().delete('/finance/invoice-branding/seal').set(as('founder')).expect(200);
    const after = (await http().get(`/service/finance/invoices/${ids.issued}/tax-invoice`).set(as('founder')).expect(200)).body as ServiceTaxInvoice;
    expect(after.signatory.sealUrl).toBeNull();
    expect(after.signatory.signatureUrl).toBe(again.signature!.url);
  });
});
