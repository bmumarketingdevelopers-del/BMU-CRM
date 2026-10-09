// v20 hardening:
// - a viewer without rights never sees a hidden field via web/app API, search or AI (and can't change it);
// - device sessions (list, sign out others, admin sign-out), TOTP two-factor with recovery codes, required 2FA by role;
// - the hash-chained audit log detects edits and deletions;
// - DPDP: consent on the enquiry form, public data requests, export, erase, consent withdrawal, retention.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { AuditChainView, DpdpOverview, FieldAccessView, SecurityOverview, SessionView, ViewAsView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MeService } from '../src/auth/me.service.js';
import { staffTools } from '../src/ai/ai-tools.js';
import { timeStep, totpCode } from '../src/security/totp.js';

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const stamp = Date.now();

async function otp(email: string) {
  const r = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return http().post('/auth/otp/verify').send({ identifier: email, code: r.body.devCode }).expect(200);
}
async function signIn(email: string) {
  return (await otp(email)).body.token as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', sales: 'sales@bmu.demo', manager: 'sales.manager@bmu.demo', finance: 'finance@bmu.demo', hr: 'hr@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
});

afterAll(async () => {
  await http().put('/security-admin/fields').set(as('founder')).send({ fields: { 'lead.budget': {} } });
  await http().put('/settings/security').set(as('founder')).send({ require2faRoles: [], sessionDays: 30 });
  await prisma.userTotp.deleteMany({ where: { userId: users.finance } });
  await app.close();
});

describe('Field-level permissions', () => {
  let leadId: string;
  const budget = 7_31_337_00; // ₹7,31,337 in paise: easy to spot anywhere in a response

  beforeAll(async () => {
    const lead = await prisma.lead.create({ data: { orgId, source: 'website', stage: 'new', need: `Hidden budget test ${stamp}`, contact: { name: 'Budget Tester', company: `Hidden Budget Co ${stamp}`, email: `budget${stamp}@example.com` }, budgetPaise: budget, ownerId: users.sales, serviceIds: [] } });
    leadId = lead.id;
  });

  it('the Founder hides Lead budget from Sales Executives in the field editor', async () => {
    const view = (await http().get('/security-admin/fields').set(as('founder')).expect(200)).body as FieldAccessView;
    const f = view.fields.find((x) => x.key === 'lead.budget')!;
    expect(f.modes.sales_executive).toBe('edit');
    expect(f.modes.founder).toBe('edit');
    const saved = (await http().put('/security-admin/fields').set(as('founder')).send({ fields: { 'lead.budget': { sales_executive: 'hidden', founder: 'hidden' } } }).expect(200)).body as FieldAccessView;
    const g = saved.fields.find((x) => x.key === 'lead.budget')!;
    expect(g.modes.sales_executive).toBe('hidden');
    // The Founder can never be locked out.
    expect(g.modes.founder).toBe('edit');
    await http().get('/security-admin/fields').set(as('sales')).expect(403);
  });

  it('is not in any API response for that role (list, detail)', async () => {
    const list = await http().get('/leads').set(as('sales')).expect(200);
    const mine = (list.body as { id: string }[]).find((l) => l.id === leadId)!;
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty('budgetPaise');
    expect(JSON.stringify(list.body)).not.toContain(String(budget));
    const detail = await http().get(`/sell/leads/${leadId}`).set(as('sales')).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(String(budget));
    expect(detail.body.lead).not.toHaveProperty('budgetPaise');
    // A Sales Manager still sees it.
    const mgr = await http().get(`/sell/leads/${leadId}`).set(as('manager')).expect(200);
    expect(mgr.body.lead.budgetPaise).toBe(budget);
  });

  it('is not in search results', async () => {
    const r = await http().get('/team-flows/search').query({ q: `Hidden Budget Co ${stamp}` }).set(as('sales')).expect(200);
    expect(JSON.stringify(r.body)).not.toContain(String(budget));
    const byAmount = await http().get('/team-flows/search').query({ q: '731337' }).set(as('sales')).expect(200);
    expect(JSON.stringify(byAmount.body)).not.toContain(leadId);
  });

  it('is not given to the AI', async () => {
    const me = (await app.get(MeService).load(users.sales))!;
    const tools = staffTools(app.get(ModuleRef), me);
    const found = await tools.find((t) => t.name === 'find_leads')!.run({ query: `Hidden Budget Co ${stamp}` });
    const rows = found.data as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]).not.toHaveProperty('budget');
    const detail = await tools.find((t) => t.name === 'lead_details')!.run({ lead_id: leadId });
    expect(JSON.stringify(detail.data)).not.toMatch(/7,31,337|731337/);
    // The manager's assistant still gets it.
    const mgr = (await app.get(MeService).load(users.manager))!;
    const m = await staffTools(app.get(ModuleRef), mgr).find((t) => t.name === 'find_leads')!.run({ query: `Hidden Budget Co ${stamp}` });
    expect((m.data as Record<string, unknown>[])[0].budget).toContain('7,31,337');
  });

  it('"View as" shows exactly what that person sees', async () => {
    const v = (await http().get(`/security-admin/view-as/${users.sales}`).set(as('founder')).expect(200)).body as ViewAsView;
    expect(v.fields.find((f) => f.key === 'lead.budget')!.mode).toBe('hidden');
    expect(v.sample?.hiddenKeys).toContain('budgetPaise');
    expect(v.capabilities.length).toBeGreaterThan(5);
  });

  it('hides and protects a custom field from a role, on read and on write', async () => {
    const def = await http().post('/custom-fields').set(as('founder')).send({ entity: 'lead', label: `Discount ceiling ${stamp}`, key: `discount_${stamp % 100000}`, type: 'number' }).expect(201);
    const key = def.body.key as string;
    await http().put(`/custom-fields/values/lead/${leadId}`).set(as('founder')).send({ values: { [key]: 18 } }).expect(200);
    await http().put('/security-admin/fields').set(as('founder')).send({ fields: { [`custom.${def.body.id}`]: { sales_executive: 'hidden' } } }).expect(200);
    const values = await http().get(`/custom-fields/values/lead/${leadId}`).set(as('sales')).expect(200);
    expect(JSON.stringify(values.body)).not.toContain(key);
    const mgr = await http().get(`/custom-fields/values/lead/${leadId}`).set(as('manager')).expect(200);
    expect(JSON.stringify(mgr.body)).toContain(key);
    const blocked = await http().put(`/custom-fields/values/lead/${leadId}`).set(as('sales')).send({ values: { [key]: 50 } }).expect(403);
    expect(blocked.body.message).toContain(key);
  });

  it('read-only roles cannot change a protected field', async () => {
    await http().put('/security-admin/fields').set(as('founder')).send({ fields: { 'people.contact': { hr_ops: 'read' } } }).expect(200);
    const r = await http().patch(`/org/users/${users.sales}`).set(as('hr')).send({ phone: '+919999999999' });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain('phone');
    await http().put('/security-admin/fields').set(as('founder')).send({ fields: { 'people.contact': {} } }).expect(200);
  });
});

describe('Sessions and two-factor', () => {
  it('lists device sessions, signs out the others and the old token stops working', async () => {
    const second = await signIn('admin@bmu.demo');
    const list = (await http().get('/security/sessions').set(bearer(second)).expect(200)).body as SessionView[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const r = await http().post('/security/sessions/sign-out-others').set(bearer(second)).expect(200);
    expect(r.body.signedOut).toBeGreaterThanOrEqual(1);
    const old = await http().get('/auth/me').set(as('admin'));
    expect(old.status).toBe(401);
    expect(old.body.message).toContain('signed out');
    await http().get('/auth/me').set(bearer(second)).expect(200);
    tokens.admin = second;
  });

  it('the Founder can sign someone out of every device; logout ends this session', async () => {
    const t = await signIn('hr@bmu.demo');
    await http().post(`/security/users/${users.hr}/sign-out`).set(as('founder')).expect(200);
    await http().get('/auth/me').set(bearer(t)).expect(401);
    await http().post(`/security/users/${users.hr}/sign-out`).set(as('sales')).expect(403);
    const t2 = await signIn('hr@bmu.demo');
    await http().post('/auth/logout').set(bearer(t2)).expect(204);
    await http().get('/auth/me').set(bearer(t2)).expect(401);
    tokens.hr = await signIn('hr@bmu.demo');
  });

  let secret = '';
  let recovery: string[] = [];

  it('sets up an authenticator app; sign-in then needs the code', async () => {
    const setup = await http().post('/security/totp/setup').set(as('finance')).expect(200);
    secret = setup.body.secret;
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await http().post('/security/totp/enable').set(as('finance')).send({ code: '000000' }).expect(400);
    const en = await http().post('/security/totp/enable').set(as('finance')).send({ code: totpCode(secret, timeStep()) }).expect(200);
    recovery = en.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    const ov = (await http().get('/security/me').set(as('finance')).expect(200)).body as SecurityOverview;
    expect(ov.totp).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    const first = (await otp('finance@bmu.demo')).body;
    expect(first.token).toBeUndefined();
    expect(first.needsSecondFactor).toBe(true);
    expect(first.methods).toContain('totp');
    await http().post('/auth/2fa').send({ challenge: first.challenge, code: '123456' }).expect(400);
    const ok = await http().post('/auth/2fa').send({ challenge: first.challenge, code: totpCode(secret, timeStep() + 1) }).expect(200);
    expect(ok.body.token).toBeTruthy();
    await http().get('/auth/me').set(bearer(ok.body.token)).expect(200);
    // The same code can't be used twice.
    const again = (await otp('finance@bmu.demo')).body;
    await http().post('/auth/2fa').send({ challenge: again.challenge, code: totpCode(secret, timeStep() + 1) }).expect(400);
    // A recovery code works once.
    const rec = await http().post('/auth/2fa').send({ challenge: again.challenge, code: recovery[0] }).expect(200);
    tokens.finance = rec.body.token;
    const third = (await otp('finance@bmu.demo')).body;
    await http().post('/auth/2fa').send({ challenge: third.challenge, code: recovery[0] }).expect(400);
  });

  it('a role that must use two-factor is limited to setting it up until it does', async () => {
    await http().put('/settings/security').set(as('founder')).send({ require2faRoles: ['hr_ops'], sessionDays: 30 }).expect(200);
    const t = await signIn('hr@bmu.demo');
    const blocked = await http().get('/leads').set(bearer(t));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('two_factor_required');
    const me = await http().get('/auth/me').set(bearer(t)).expect(200);
    expect(me.body.mustEnroll2fa).toBe(true);
    const setup = await http().post('/security/totp/setup').set(bearer(t)).expect(200);
    await http().post('/security/totp/enable').set(bearer(t)).send({ code: totpCode(setup.body.secret, timeStep()) }).expect(200);
    // Setting it up counts for this session.
    const after = await http().get('/auth/me').set(bearer(t)).expect(200);
    expect(after.body.mustEnroll2fa).toBeFalsy();
    await http().put('/settings/security').set(as('founder')).send({ require2faRoles: [], sessionDays: 30 }).expect(200);
    await prisma.userTotp.deleteMany({ where: { userId: users.hr } });
  });

  it('turns two-factor off with a code', async () => {
    await http().post('/security/totp/disable').set(as('finance')).send({ code: recovery[1] }).expect(200);
    const s = (await otp('finance@bmu.demo')).body;
    expect(s.token).toBeTruthy();
    tokens.finance = s.token;
  });

  it('passkey sign-in options are offered without an account hint', async () => {
    const r = await http().post('/auth/passkey/options').send({}).expect(200);
    expect(r.body.options.challenge).toBeTruthy();
    expect(r.body.token).toBeTruthy();
  });
});

describe('Tamper-evident audit log', () => {
  it('verifies the chain and points at an edited or deleted entry', async () => {
    // Make sure there are a few chained entries.
    await http().put('/settings/security').set(as('founder')).send({ require2faRoles: [], sessionDays: 31 }).expect(200);
    await http().put('/settings/security').set(as('founder')).send({ require2faRoles: [], sessionDays: 30 }).expect(200);
    const ok = (await http().get('/security-admin/audit-chain').set(as('founder')).expect(200)).body as AuditChainView;
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBeGreaterThan(2);
    await http().get('/security-admin/audit-chain').set(as('sales')).expect(403);

    const victim = await prisma.auditEvent.findFirstOrThrow({ where: { orgId, seq: { not: null } }, orderBy: { seq: 'desc' }, skip: 1 });
    await prisma.auditEvent.update({ where: { id: victim.id }, data: { action: 'nothing.to.see' } });
    const broken = (await http().get('/security-admin/audit-chain').set(as('founder')).expect(200)).body as AuditChainView;
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt?.seq).toBe(victim.seq);
    expect(broken.brokenAt?.reason).toContain('changed');
    await prisma.auditEvent.update({ where: { id: victim.id }, data: { action: victim.action } });
    expect(((await http().get('/security-admin/audit-chain').set(as('founder'))).body as AuditChainView).ok).toBe(true);

    await prisma.auditEvent.delete({ where: { id: victim.id } });
    const gap = (await http().get('/security-admin/audit-chain').set(as('founder'))).body as AuditChainView;
    expect(gap.ok).toBe(false);
    expect(gap.brokenAt?.reason).toContain('missing');
    await prisma.auditEvent.create({ data: victim as never });
    expect(((await http().get('/security-admin/audit-chain').set(as('founder'))).body as AuditChainView).ok).toBe(true);
  });
});

describe('DPDP', () => {
  const email = `dpdp${stamp}@example.com`;
  let leadId = '';

  it('the enquiry form records consent per purpose with the notice version', async () => {
    const r = await http().post('/leads/enquiry').send({ name: 'Priya Consent', phone: `98${String(stamp).slice(-8)}`, email, company: 'Consent Co', need: 'Need a new website and social media', consentMarketing: true, consentWhatsapp: false }).expect(201);
    leadId = r.body.id;
    const rows = await prisma.consent.findMany({ where: { orgId, email } });
    expect(rows.map((c) => c.purpose).sort()).toEqual(['marketing', 'service']);
    expect(rows.every((c) => c.noticeVersion === '2026-10')).toBe(true);
    // Bots that fill the hidden field get a polite answer and nothing is saved.
    const bot = await http().post('/leads/enquiry').send({ name: 'Bot', email: 'bot@example.com', phone: `96${String(stamp).slice(-8)}`, need: 'spam spam spam spam', website: 'http://spam' }).expect(201);
    expect(bot.body.id).toBe('received');
  });

  it('anyone can withdraw marketing consent by email', async () => {
    const r = await http().post('/public/privacy/withdraw').send({ email, purpose: 'marketing' }).expect(200);
    expect(r.body.withdrawn).toBe(1);
    expect((await prisma.consent.findFirstOrThrow({ where: { orgId, email, purpose: 'marketing' } })).withdrawnAt).toBeTruthy();
  });

  it('a public data request lands in Privacy with a 30-day due date, matched to the lead', async () => {
    await http().post('/public/privacy/requests').send({ kind: 'export', requesterName: 'Priya Consent', requesterEmail: email }).expect(201);
    const ov = (await http().get('/security-admin/privacy').set(as('founder')).expect(200)).body as DpdpOverview;
    const req = ov.requests.find((r) => r.requesterEmail === email)!;
    expect(req.status).toBe('open');
    expect(req.subjectId).toBe(leadId);
    const days = (new Date(req.dueAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(ov.breachRunbook.length).toBeGreaterThan(3);
    await http().get('/security-admin/privacy').set(as('sales')).expect(403);
    // Closing needs a note of what was done.
    await http().patch(`/security-admin/privacy/requests/${req.id}`).set(as('founder')).send({ status: 'done' }).expect(400);
    await http().patch(`/security-admin/privacy/requests/${req.id}`).set(as('founder')).send({ status: 'done', resolution: 'Sent the export by email' }).expect(200);
  });

  it('exports everything held about a lead, then erases it', async () => {
    const ex = await http().get(`/security-admin/privacy/export/lead/${leadId}`).set(as('founder')).expect(200);
    expect(JSON.stringify(ex.body)).toContain(email);
    expect(ex.body.consents.length).toBe(2);
    await http().post(`/security-admin/privacy/erase-lead/${leadId}`).set(as('founder')).expect(200);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(JSON.stringify(lead.contact)).not.toContain(email);
    expect(JSON.stringify(lead.contact)).not.toContain('Priya');
    expect(await prisma.consent.count({ where: { orgId, email } })).toBe(0);
  });

  it('retention rules anonymise old lost leads', async () => {
    const old = await prisma.lead.create({ data: { orgId, source: 'website', stage: 'lost', lostReason: 'No budget', need: 'old', contact: { name: 'Old Lost Lead', email: `old${stamp}@example.com`, phone: '+919800000000' }, serviceIds: [], createdAt: new Date('2023-01-01'), updatedAt: new Date('2023-01-01') } });
    const ov = (await http().get('/security-admin/privacy').set(as('founder'))).body as DpdpOverview;
    const rules = ov.retention.map((r) => ({ recordType: r.recordType, keepDays: r.keepDays, action: r.action, enabled: r.recordType === 'lost_lead' }));
    await http().put('/security-admin/privacy/retention').set(as('founder')).send({ rules }).expect(200);
    const ran = await http().post('/security-admin/privacy/retention/run').set(as('founder')).expect(200);
    expect(ran.body.ran.lost_lead).toBeGreaterThanOrEqual(1);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: old.id } });
    expect(JSON.stringify(after.contact)).not.toContain('Old Lost Lead');
  });
});
