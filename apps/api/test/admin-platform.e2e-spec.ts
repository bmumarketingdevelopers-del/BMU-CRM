// Command Centre → Operations and Platform: SOPs, error log, checklist/gate/SLA rules wired into the product,
// integrations (no secrets), DPDP export and deletion.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { addWorkingDays, workingMinutesBetween } from '@bmu/shared';
import type { Prisma } from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
let orgId: string;
let originalSettings: Prisma.InputJsonValue;
let holidays: string[] = [];
let clientId: string;
let clientName: string;
let retainerId: string;
let ownerId: string;
let qcDeptId: string;
let designDeptId: string;

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

  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  originalSettings = org.settings as Prisma.InputJsonValue;
  holidays = ((org.settings ?? {}) as { holidays?: string[] }).holidays ?? [];
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
  qcDeptId = (await prisma.department.findFirstOrThrow({ where: { orgId, name: 'QC' } })).id;
  designDeptId = (await prisma.department.findFirstOrThrow({ where: { orgId, name: 'Creative / Design' } })).id;

  // A department head for QC only.
  const head = await prisma.user.create({
    data: { orgId, type: 'staff', name: 'QC Head', email: `qc.head.${stamp}@bmu.demo`, status: 'active', departmentId: qcDeptId, roles: { create: { roleId: (await role('department_head')).id } } },
  });
  tokens.head = await signIn(head.email!);

  clientName = `DPDP Test ${stamp}`;
  const client = await prisma.clientOrg.create({ data: { orgId, name: clientName, amUserId: am.id } });
  clientId = client.id;
  const owner = await prisma.user.create({
    data: { orgId, type: 'client', name: 'Priya Owner', email: `dpdp.owner.${stamp}@example.com`, phone: `+9198${String(stamp).slice(-8)}`, status: 'active', roles: { create: { roleId: (await role('client_owner')).id } } },
  });
  ownerId = owner.id;
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  tokens.client = await signIn(owner.email!);
  retainerId = (
    await prisma.engagement.create({ data: { orgId, clientOrgId: client.id, serviceId: smm.id, tier: 'growth', amId: am.id, billingType: 'monthly', status: 'in_production', currentGate: 'G4' } })
  ).id;
  const thread = await prisma.thread.create({ data: { orgId, clientOrgId: client.id, type: 'client_am' } });
  await prisma.message.create({ data: { orgId, threadId: thread.id, authorId: owner.id, body: 'Hello team' } });
  await prisma.message.create({ data: { orgId, threadId: thread.id, authorId: am.id, body: 'INTERNAL: client is price sensitive', isInternal: true } });

  for (const who of ['founder', 'admin', 'am', 'producer', 'sales.manager']) tokens[who] = await signIn(`${who}@bmu.demo`);
});

afterAll(async () => {
  await prisma.organisation.update({ where: { id: orgId }, data: { settings: originalSettings } });
  // Keep the demo SOP library and error log clean.
  await prisma.sOP.deleteMany({ where: { orgId, title: { contains: String(stamp) } } });
  await prisma.errorLog.deleteMany({ where: { orgId, what: { contains: String(stamp) } } });
  await app.close();
});

describe('SOP library', () => {
  let sopId: string;

  it('any team member can read; clients cannot', async () => {
    const list = (await http().get('/admin-platform/sops').set(as('producer')).expect(200)).body;
    expect(Array.isArray(list)).toBe(true);
    await http().get('/admin-platform/sops').set(as('client')).expect(403);
  });

  it('producers cannot write SOPs', async () => {
    await http().post('/admin-platform/sops').set(as('producer')).send({ title: 'Nope', body: 'Should not be saved at all', departmentId: qcDeptId }).expect(403);
  });

  it('admin creates an SOP; each edit bumps the version and is audit-logged with before/after', async () => {
    const created = (await http().post('/admin-platform/sops').set(as('admin')).send({ title: `Test SOP ${stamp}`, body: '# Steps\n1. First step', departmentId: designDeptId }).expect(201)).body;
    expect(created.version).toBe(1);
    sopId = created.id;
    const updated = (await http().put(`/admin-platform/sops/${sopId}`).set(as('admin')).send({ title: `Test SOP ${stamp}`, body: '# Steps\n1. First step\n2. Second step', departmentId: designDeptId }).expect(200)).body;
    expect(updated.version).toBe(2);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entity: 'SOP', entityId: sopId, action: 'sop.updated' } });
    expect((audit.before as { version: number }).version).toBe(1);
    expect((audit.after as { body: string }).body).toContain('Second step');
    const one = (await http().get(`/admin-platform/sops/${sopId}`).set(as('producer')).expect(200)).body;
    expect(one.canEdit).toBe(false);
    const found = (await http().get(`/admin-platform/sops?q=${encodeURIComponent(`Test SOP ${stamp}`)}`).set(as('producer')).expect(200)).body;
    expect(found).toHaveLength(1);
  });

  it('department heads edit only their own department', async () => {
    await http().put(`/admin-platform/sops/${sopId}`).set(as('head')).send({ title: 'Hijack', body: 'Changing another department', departmentId: designDeptId }).expect(403);
    const qc = (await http().post('/admin-platform/sops').set(as('head')).send({ title: `QC SOP ${stamp}`, body: 'Check every version carefully', departmentId: qcDeptId }).expect(201)).body;
    expect(qc.canEdit).toBe(true);
    const meta = (await http().get('/admin-platform/sops/meta').set(as('head')).expect(200)).body;
    expect(meta.editableDepartmentIds).toEqual([qcDeptId]);
  });
});

describe('error log', () => {
  it('any team member can log an error; only leadership edits', async () => {
    const e = (await http().post('/admin-platform/errors').set(as('producer')).send({ what: `Wrong logo used ${stamp}`, cause: 'process' }).expect(201)).body;
    expect(e.foundBy).toBeTruthy();
    await http().put(`/admin-platform/errors/${e.id}`).set(as('producer')).send({ what: e.what, prevention: 'x' }).expect(403);
    const edited = (await http().put(`/admin-platform/errors/${e.id}`).set(as('admin')).send({ what: e.what, cause: 'process', prevention: 'Logo check added to QC' }).expect(200)).body;
    expect(edited.prevention).toBe('Logo check added to QC');
    const list = (await http().get('/admin-platform/errors?cause=process').set(as('admin')).expect(200)).body;
    expect(list.rows.every((r: { cause: string }) => r.cause === 'process')).toBe(true);
    expect(list.stats.find((s: { cause: string }) => s.cause === 'process').count).toBeGreaterThan(0);
  });
});

describe('rules wired into the product', () => {
  it('only Founder/Admin/department heads change operations settings', async () => {
    await http().put('/admin-platform/settings/sla').set(as('producer')).send({}).expect(403);
    await http().put('/admin-platform/settings/sla').set(as('am')).send({}).expect(403);
  });

  it('changing the SLA changes the first-reply due time of new requests', async () => {
    const settings = (await http().get('/settings').set(as('admin')).expect(200)).body;
    await http()
      .put('/admin-platform/settings/sla')
      .set(as('admin'))
      .send({ ...settings.sla, firstReplyMinutes: { ...settings.sla.firstReplyMinutes, urgent: 180 } })
      .expect(200);
    const r = (await http().post('/client/requests').set(as('client')).send({ engagementId: retainerId, type: 'urgent', description: 'Please fix the banner today' }).expect(201)).body;
    expect(workingMinutesBetween(new Date(r.createdAt), new Date(r.sla.firstReplyDue), holidays)).toBe(180);
    const audit = await prisma.auditEvent.findFirst({ where: { orgId, action: 'settings.sla.updated' }, orderBy: { at: 'desc' } });
    expect(audit).toBeTruthy();
  });

  it('the plan deadline uses the gate rules setting', async () => {
    const settings = (await http().get('/settings').set(as('admin')).expect(200)).body;
    await http().put('/admin-platform/settings/gateRules').set(as('admin')).send({ ...settings.gateRules, planDeadlineWorkingDays: 6 }).expect(200);
    const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
    const seo = await prisma.service.findFirstOrThrow({ where: { key: 'seo', priceBook: { orgId, status: 'active' } } });
    const e = await prisma.engagement.create({
      data: {
        orgId,
        clientOrgId: clientId,
        serviceId: seo.id,
        tier: 'growth',
        amId: am.id,
        billingType: 'monthly',
        status: 'onboarding',
        cycles: { create: { orgId, period: '2026-10', status: 'onboarding', requirements: { create: [{ orgId, label: 'Questionnaire', type: 'text', status: 'received' }] } } },
      },
    });
    const before = new Date();
    const res = (await http().post(`/engagements/${e.id}/rcd`).set(as('am')).expect(200)).body;
    const expected = addWorkingDays(before, 6, holidays).getTime();
    expect(Math.abs(new Date(res.cycle.planningDue).getTime() - expected)).toBeLessThan(60_000);
  });

  it('new engagements get the requirement checklist for their service, else the default list', async () => {
    await http()
      .put('/admin-platform/settings/requirementChecklists')
      .set(as('admin'))
      .send({ default: [{ label: `Default item ${stamp}`, type: 'text' }], seo: [{ label: `SEO access ${stamp}`, type: 'access' }, { label: 'Keyword ideas', type: 'text' }] })
      .expect(200);
    const email = `checklist.${stamp}@example.com`;
    await http().post('/leads/enquiry').send({ name: 'Checklist Owner', email, phone: `97${String(stamp).slice(-8)}`, company: `Checklist Co ${stamp}`, need: 'SEO and GBP', serviceIds: [] }).expect(201);
    const lead = (await http().get('/leads').set(as('founder')).expect(200)).body.find((l: { contact: { email: string } }) => l.contact.email === email);
    const p = (await http().post('/proposals').set(as('sales.manager')).send({ leadId: lead.id, lines: [{ serviceKey: 'seo', tier: 'growth' }, { serviceKey: 'gbp', tier: 'growth' }] }).expect(201)).body;
    await http().post(`/proposals/${p.id}/send`).set(as('sales.manager')).expect(200);
    await http().post(`/public/proposals/${p.publicToken}/accept`).send({ signerName: 'Checklist Owner', signerEmail: email, agree: true }).expect(200);
    await http().post(`/public/proposals/${p.publicToken}/pay-test`).expect(200);
    const engagements = await prisma.engagement.findMany({
      where: { clientOrg: { leadId: lead.id } },
      include: { service: true, cycles: { include: { requirements: true } } },
    });
    const labels = (key: string) => engagements.find((e) => e.service.key === key)!.cycles[0].requirements.map((r) => r.label).sort();
    expect(labels('seo')).toEqual(['Keyword ideas', `SEO access ${stamp}`].sort());
    expect(labels('gbp')).toEqual([`Default item ${stamp}`]);
  });
});

describe('platform', () => {
  it('integrations are Founder/Admin only and return booleans, never secrets', async () => {
    await http().get('/admin-platform/integrations').set(as('am')).expect(403);
    await http().get('/admin-platform/integrations').set(as('head')).expect(403);
    const rows = (await http().get('/admin-platform/integrations').set(as('admin')).expect(200)).body;
    expect(rows.map((r: { key: string }) => r.key).sort()).toEqual(['accounting', 'email', 'razorpay', 'storage', 'whatsapp']);
    for (const r of rows) expect(typeof r.configured).toBe('boolean');
    const raw = JSON.stringify(rows);
    for (const k of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_KEY_ID', 'SMTP_PASS', 'WHATSAPP_TOKEN', 'JWT_SECRET']) {
      const v = process.env[k];
      if (v && v.length > 3) expect(raw).not.toContain(v);
    }
  });

  it('platform settings (branding, tenant, notifications) are Founder/Admin only', async () => {
    const settings = (await http().get('/settings').set(as('admin')).expect(200)).body;
    await http().put('/admin-platform/settings/branding').set(as('head')).send(settings.branding).expect(403);
    await http().put('/admin-platform/settings/branding').set(as('admin')).send({ ...settings.branding, accent: '#8BB72C' }).expect(200);
    await http().put('/admin-platform/settings/gst').set(as('admin')).send(settings.gst).expect(400);
    const tenant = (await http().get('/admin-platform/tenant').set(as('founder')).expect(200)).body;
    expect(tenant.plan).toBeTruthy();
  });
});

describe('data export and deletion (DPDP)', () => {
  it('export is Founder/Admin only, has the client data but no internal messages, and is audit-logged', async () => {
    await http().get(`/admin-platform/data/clients/${clientId}/export`).set(as('am')).expect(403);
    const out = (await http().get(`/admin-platform/data/clients/${clientId}/export`).set(as('admin')).expect(200)).body;
    expect(out.client.name).toBe(clientName);
    expect(out.users.map((u: { id: string }) => u.id)).toContain(ownerId);
    expect(out.engagements.length).toBeGreaterThan(0);
    expect(out.requests.length).toBeGreaterThan(0);
    expect(out.messages.map((m: { body: string }) => m.body)).toEqual(['Hello team']);
    expect(await prisma.auditEvent.findFirst({ where: { entityId: clientId, action: 'client.data_exported' } })).toBeTruthy();
  });

  it('deletion needs the typed client name and no unpaid invoices', async () => {
    await http().post(`/admin-platform/data/clients/${clientId}/anonymise`).set(as('am')).send({ confirmName: clientName }).expect(403);
    await http().post(`/admin-platform/data/clients/${clientId}/anonymise`).set(as('admin')).send({ confirmName: 'Someone else' }).expect(400);
    const inv = await prisma.invoice.create({
      data: { orgId, clientOrgId: clientId, number: `TEST/${stamp}`, lines: [], subtotalPaise: 100, gstPaise: 18, totalPaise: 118, dueDate: new Date(), status: 'issued' },
    });
    const refused = await http().post(`/admin-platform/data/clients/${clientId}/anonymise`).set(as('admin')).send({ confirmName: clientName }).expect(400);
    expect(refused.body.message).toMatch(/unpaid/);
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'paid' } });
    const res = (await http().post(`/admin-platform/data/clients/${clientId}/anonymise`).set(as('admin')).send({ confirmName: clientName.toUpperCase() }).expect(200)).body;
    expect(res.anonymised).toBe(1);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(u).toMatchObject({ name: 'Deleted user', email: null, phone: null, status: 'suspended' });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: clientId, action: 'client.personal_data_deleted' } });
    expect(JSON.stringify(audit.before)).not.toContain('Priya');
  });
});
