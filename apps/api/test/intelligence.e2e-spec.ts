// v20 intelligence:
// - revenue forecast and churn risk show on the founder dashboard with reasons (TypeScript and the Python service);
// - the metric layer, anomaly alerts (a client's activity drops), scheduled PDF reports, goals with check-ins.
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { GoalView, IntelligenceOverview, MetricAlertView, MetricValueView, ScheduledReportView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ReportsService } from '../src/intelligence/reports.service.js';

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const DAY = 86_400_000;
let clientId = '';

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', head: 'design.head@bmu.demo', sales: 'sales@bmu.demo', am: 'am@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  // A retainer client whose contract ends in 10 days, with no renewal raised.
  const service = await prisma.service.findFirstOrThrow({ where: { orgId } });
  clientId = (await prisma.clientOrg.create({ data: { orgId, name: `Ending Soon ${stamp}`, amUserId: users.am } })).id;
  await prisma.engagement.create({ data: { orgId, clientOrgId: clientId, serviceId: service.id, tier: 'growth', billingType: 'monthly', status: 'active_retainer', amId: users.am, startDate: new Date(Date.now() - 200 * DAY), endDate: new Date(Date.now() + 10 * DAY) } });
});

afterAll(async () => {
  delete process.env.FORECAST_URL;
  await app.close();
});

describe('Forecast & risks on the founder dashboard', () => {
  it('shows the revenue forecast and churn risk with reasons', async () => {
    await http().post('/intelligence/refresh').set(as('founder')).expect(200);
    const ov = (await http().get('/intelligence/overview').set(as('founder')).expect(200)).body as IntelligenceOverview;
    expect(ov.source).toBe('ts');
    expect(ov.revenue!.months).toHaveLength(3);
    expect(ov.revenue!.nextMonthPaise).toBeGreaterThan(0);
    expect(ov.revenue!.reasons.map((r) => r.label).join(' ')).toMatch(/Live retainers/);
    const ending = ov.churn.find((c) => c.subjectId === clientId)!;
    expect(ending).toBeTruthy();
    expect(ending.score).toBeGreaterThanOrEqual(15);
    expect(ending.reasons.map((r) => r.label)).toContain('Retainer ends in 10 days with no renewal yet');
    expect(ending.href).toBe(`/team/clients/${clientId}`);
    // Every risk carries its reasons.
    for (const c of [...ov.churn, ...ov.slip, ...ov.win]) expect(c.reasons.length).toBeGreaterThan(0);
    expect(ov.capacity.every((c) => c.reasons[0].label.includes('h of work due'))).toBe(true);
  });

  it('the founder dashboard layout includes the Forecast & risks section', async () => {
    const dash = (await http().get('/dashboards/home/admin').set(as('founder')).expect(200)).body as { layout: { section?: string }[] };
    expect(dash.layout.map((w) => w.section)).toContain('forecast_risks');
  });

  it('hides money from non-money roles and the page from people outside the Command Centre', async () => {
    const ov = (await http().get('/intelligence/overview').set(as('head')).expect(200)).body as IntelligenceOverview;
    expect(ov.revenue).toBeNull();
    expect(ov.churn.every((c) => c.value === 0)).toBe(true);
    expect(JSON.stringify(ov.churn)).not.toMatch(/₹/);
    await http().get('/intelligence/overview').set(as('sales')).expect(403);
  });

  it('uses the Python forecasting service when FORECAST_URL is set', async () => {
    const port = await freePort();
    const py: ChildProcess = spawn('python3', ['main.py'], { cwd: resolve(__dirname, '../../../services/forecast'), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    try {
      process.env.FORECAST_URL = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 40; i++) {
        const up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
        if (up) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      await http().post('/intelligence/refresh').set(as('founder')).expect(200);
      const ov = (await http().get('/intelligence/overview').set(as('founder')).expect(200)).body as IntelligenceOverview;
      expect(ov.source).toBe('python');
      expect(ov.revenue!.reasons.map((r) => r.label).join(' ')).toMatch(/forecasting service/);
      expect(ov.churn.find((c) => c.subjectId === clientId)!.source).toBe('python');
    } finally {
      py.kill();
      delete process.env.FORECAST_URL;
    }
    // Falls back to TypeScript when the service is gone.
    process.env.FORECAST_URL = `http://127.0.0.1:${port}`;
    await http().post('/intelligence/refresh').set(as('founder')).expect(200);
    expect(((await http().get('/intelligence/overview').set(as('founder'))).body as IntelligenceOverview).source).toBe('ts');
    delete process.env.FORECAST_URL;
  });
});

describe('Metric layer', () => {
  it('returns every metric with its formula; money metrics only for money roles', async () => {
    const all = (await http().get('/intelligence/metrics').set(as('founder')).expect(200)).body as MetricValueView[];
    const mrr = all.find((m) => m.key === 'mrr')!;
    expect(mrr.value).toBeGreaterThan(0);
    expect(mrr.formula).toMatch(/retainer/);
    expect(all.find((m) => m.key === 'leads')!.value).toBeGreaterThanOrEqual(0);
    const head = (await http().get('/intelligence/metrics').set(as('head')).expect(200)).body as MetricValueView[];
    expect(head.some((m) => m.key === 'mrr')).toBe(false);
    expect(head.some((m) => m.key === 'on_time_pct')).toBe(true);
    await http().get('/intelligence/metrics/mrr').set(as('head')).expect(403);
  });

  it('the same number as Analytics → Explore', async () => {
    const from = new Date(Date.now() - 29 * DAY + 330 * 60_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const m = (await http().get('/intelligence/metrics/leads').query({ from, to }).set(as('founder')).expect(200)).body as MetricValueView;
    const ex = await http().post('/ops-analytics/explore').set(as('founder')).send({ metric: 'leads', dimension: 'month', from, to }).expect(200);
    expect(m.value).toBe(ex.body.total);
  });
});

describe('Anomaly alerts', () => {
  it('fires when a client goes quiet, once, and tells the right people', async () => {
    const u = await prisma.user.create({ data: { orgId, type: 'client', name: 'Quiet Client', email: `quiet${stamp}@example.com`, status: 'active' } });
    await prisma.clientUser.create({ data: { userId: u.id, orgId, clientOrgId: clientId, clientRole: 'client_owner', brandScope: [] } });
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: clientId } });
    for (let i = 0; i < 6; i++) await prisma.request.create({ data: { orgId, engagementId: eng.id, type: 'question', description: `Old question ${i}`, createdById: u.id, createdAt: new Date(Date.now() - (35 + i) * DAY) } });
    await prisma.request.create({ data: { orgId, engagementId: eng.id, type: 'question', description: 'Recent question', createdById: u.id, createdAt: new Date(Date.now() - 2 * DAY) } });

    const list = (await http().get('/intelligence/alerts').set(as('founder')).expect(200)).body as { alerts: MetricAlertView[] };
    const builtIn = list.alerts.find((a) => a.metricKey === 'client_activity')!;
    expect(builtIn.builtIn).toBe(true);
    expect(builtIn.summary).toMatch(/for any client/);

    const r = await http().post('/intelligence/alerts/check').set(as('founder')).expect(200);
    const mine = (r.body.fired as { subject: string; message: string }[]).find((e) => e.subject === clientId)!;
    expect(mine.message).toMatch(/fell 83%/);
    expect(await prisma.notification.count({ where: { userId: users.founder, title: builtIn.name } })).toBeGreaterThanOrEqual(1);
    const again = await http().post('/intelligence/alerts/check').set(as('founder')).expect(200);
    expect((again.body.fired as { subject: string }[]).some((e) => e.subject === clientId)).toBe(false);
    const ov = (await http().get('/intelligence/overview').set(as('founder'))).body as IntelligenceOverview;
    expect(ov.alerts.some((e) => e.subject === clientId)).toBe(true);
  });

  it('custom alerts: validation, editing, built-ins cannot be deleted', async () => {
    await http().post('/intelligence/alerts').set(as('founder')).send({ name: 'x', metricKey: 'nope', condition: 'above', threshold: 1, roles: [] }).expect(400);
    await http().post('/intelligence/alerts').set(as('head')).send({ name: 'Too many overdue', metricKey: 'overdue_tasks', condition: 'above', threshold: 5, roles: ['founder'] }).expect(403);
    const a = (await http().post('/intelligence/alerts').set(as('founder')).send({ name: 'Too many overdue', metricKey: 'overdue_tasks', condition: 'above', threshold: 0, roles: ['founder'] }).expect(201)).body as MetricAlertView;
    expect(a.summary).toBe('When overdue tasks goes above 0');
    const off = (await http().patch(`/intelligence/alerts/${a.id}`).set(as('founder')).send({ active: false }).expect(200)).body as MetricAlertView;
    expect(off.active).toBe(false);
    await http().delete(`/intelligence/alerts/${a.id}`).set(as('founder')).expect(200);
    const list = (await http().get('/intelligence/alerts').set(as('founder'))).body as { alerts: MetricAlertView[] };
    await http().delete(`/intelligence/alerts/${list.alerts.find((x) => x.builtIn)!.id}`).set(as('founder')).expect(403);
  });
});

describe('Scheduled reports', () => {
  it('builds a PDF and emails it on schedule', async () => {
    await http().post('/intelligence/reports').set(as('founder')).send({ name: 'Monday numbers', cadence: 'weekly', dayOfWeek: 1, metricKeys: [], recipients: ['boss@example.com'] }).expect(400);
    const r = (await http().post('/intelligence/reports').set(as('founder')).send({ name: 'Monday numbers', cadence: 'weekly', dayOfWeek: 1, hourIst: 9, metricKeys: ['mrr', 'leads', 'on_time_pct'], recipients: ['boss@example.com'] }).expect(201)).body as ScheduledReportView;
    expect(r.schedule).toBe('Every Monday at 09:00 IST');
    expect(new Date(r.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const pdf = await http().get(`/intelligence/reports/${r.id}/pdf`).set(as('founder')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(body.toString('latin1')).toContain('Monthly recurring');
    expect(pdf.headers['content-type']).toBe('application/pdf');

    // Due now → sent with the PDF attached, next run moves on a week.
    await prisma.scheduledReport.update({ where: { id: r.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    expect(await app.get(ReportsService).runDue()).toBeGreaterThanOrEqual(1);
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { entityId: r.id }, orderBy: { createdAt: 'desc' } });
    expect(mail.toEmail).toBe('boss@example.com');
    expect((mail.attachments as { contentType: string }[])[0].contentType).toBe('application/pdf');
    expect(mail.text).toMatch(/Monthly recurring revenue: ₹/);
    const after = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.lastSentAt).toBeTruthy();
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    // A Department Head can't put money numbers in a report.
    await http().post('/intelligence/reports').set(as('head')).send({ name: 'Sneaky', cadence: 'daily', metricKeys: ['mrr'], recipients: ['x@example.com'] }).expect(403);
  });
});

describe('Goals', () => {
  it('a company goal follows its metric; personal goals move with check-ins', async () => {
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const start = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
    await http().post('/intelligence/goals').set(as('sales')).send({ title: 'Company leads', level: 'company', metricKey: 'leads', target: 500, startDate: start, endDate: end }).expect(403);
    const company = (await http().post('/intelligence/goals').set(as('founder')).send({ title: 'Leads this quarter', level: 'company', metricKey: 'leads', target: 500, startDate: start, endDate: end }).expect(201)).body as GoalView;
    expect(company.current).toBeGreaterThanOrEqual(0);
    expect(company.metricLabel).toBe('Leads');
    expect(company.canCheckIn).toBe(false);

    const mine = (await http().post('/intelligence/goals').set(as('sales')).send({ title: 'Book 20 discovery calls', level: 'person', target: 20, unit: 'calls', startDate: today, endDate: end }).expect(201)).body as GoalView;
    expect(mine.owner?.id).toBe(users.sales);
    expect(mine.progress).toBe(0);
    const checked = (await http().post(`/intelligence/goals/${mine.id}/check-ins`).set(as('sales')).send({ value: 10, note: 'Halfway' }).expect(201)).body as GoalView;
    expect(checked.progress).toBe(50);
    expect(checked.status).toBe('on_track');
    expect(checked.display.current).toBe('10 calls');
    await http().post(`/intelligence/goals/${company.id}/check-ins`).set(as('founder')).send({ value: 1 }).expect(403);
    await http().post(`/intelligence/goals/${mine.id}/check-ins`).set(as('head')).send({ value: 12 }).expect(403);

    const list = (await http().get('/intelligence/goals').set(as('sales')).expect(200)).body as { goals: GoalView[] };
    expect(list.goals.map((g) => g.id)).toEqual(expect.arrayContaining([company.id, mine.id]));
    const am = (await http().get('/intelligence/goals').set(as('am')).expect(200)).body as { goals: GoalView[] };
    expect(am.goals.some((g) => g.id === mine.id)).toBe(false);
    const ov = (await http().get('/intelligence/overview').set(as('founder'))).body as IntelligenceOverview;
    expect(ov.goals.some((g) => g.id === company.id)).toBe(true);
  });
});
