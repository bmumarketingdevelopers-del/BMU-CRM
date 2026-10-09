// v12 Dashboard Studio: editing built-in dashboards, building custom ones, who sees what, versions, and the
// widget data (scoped to the viewer). Every built-in layout this spec changes is reset in afterAll.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { dashboardDefaultLayout, type DashboardView, type DashboardWidget } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const created: string[] = [];
const touchedBuiltins = new Set<string>();

async function signIn(identifier: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier, code: otp.body.devCode }).expect(200)).body.token as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const people: Record<string, string> = {
    founder: 'founder@bmu.demo',
    admin: 'admin@bmu.demo',
    sales: 'sales@bmu.demo',
    salesManager: 'sales.manager@bmu.demo',
    am: 'am@bmu.demo',
    finance: 'finance@bmu.demo',
    video: 'video@bmu.demo',
    producer: 'producer@bmu.demo',
    client: 'client@sunrise.demo',
  };
  for (const [k, v] of Object.entries(people)) tokens[k] = await signIn(v);
});

afterAll(async () => {
  for (const id of touchedBuiltins) await http().post(`/dashboards/${id}/reset`).set(as('founder'));
  if (created.length) await prisma.dashboard.deleteMany({ where: { id: { in: created } } });
  await app.close();
});

const builtin = async (key: string, who = 'founder') => (await http().get(`/dashboards/builtin/${key}`).set(as(who)).expect(200)).body as DashboardView;

describe('Studio list and permissions', () => {
  it('lists the six built-in dashboards with the original layout for the Founder', async () => {
    const r = await http().get('/dashboards').set(as('founder')).expect(200);
    expect(r.body.builtins.map((b: { builtin: string }) => b.builtin)).toEqual(['command_centre', 'scorecard', 'my_day', 'manager', 'specialist', 'client_home']);
    expect(r.body.templates.map((t: { key: string }) => t.key)).toContain('sales');
    expect(r.body.roles.some((x: { id: string }) => x.id === 'sales_executive')).toBe(true);
  });

  it('only the Founder and Admins can open the Studio or change a dashboard', async () => {
    for (const who of ['am', 'finance', 'sales', 'producer', 'client']) await http().get('/dashboards').set(as(who)).expect(403);
    const d = await builtin('my_day');
    await http().patch(`/dashboards/${d.id}`).set(as('am')).send({ layout: [] }).expect(403);
    await http().post('/dashboards').set(as('salesManager')).send({ name: 'Nope' }).expect(403);
    await http().get('/dashboards').set(as('admin')).expect(200);
  });
});

describe('Editing a built-in dashboard', () => {
  it('hides, moves, resizes and adds widgets, keeps a version, and resets to the original', async () => {
    const d = await builtin('command_centre');
    touchedBuiltins.add(d.id);
    expect(d.customised).toBe(false);
    const original = dashboardDefaultLayout('command_centre');
    const layout: DashboardWidget[] = [
      { id: 'kpi1', type: 'kpi', size: 'third', metric: 'leads', period: 'this_month' },
      ...original.filter((w) => w.type === 'section' && w.section !== 'pipeline').map((w) => (w.type === 'section' && w.section === 'blocked_tasks' ? { ...w, size: 'full' as const } : w)),
    ];
    const saved = (await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout, note: `e2e ${stamp}` }).expect(200)).body as DashboardView;
    expect(saved.customised).toBe(true);
    expect(saved.layout[0]).toMatchObject({ type: 'kpi', metric: 'leads' });
    expect(saved.layout.some((w) => w.type === 'section' && w.section === 'pipeline')).toBe(false);
    expect(saved.updatedBy).toBeTruthy();

    // Everyone landing on the Command Centre gets the saved layout.
    const home = (await http().get('/dashboards/home/admin').set(as('finance')).expect(200)).body as DashboardView;
    expect(home.builtin).toBe('command_centre');
    expect(home.layout[0].id).toBe('kpi1');
    expect(home.canEdit).toBe(false);

    const versions = (await http().get(`/dashboards/${d.id}/versions`).set(as('founder')).expect(200)).body;
    expect(versions[0]).toMatchObject({ note: `e2e ${stamp}`, current: true });

    const reset = (await http().post(`/dashboards/${d.id}/reset`).set(as('founder')).expect(201)).body as DashboardView;
    expect(reset.customised).toBe(false);
    expect(reset.layout).toEqual(original);

    // Restore the customised version from History.
    const after = (await http().get(`/dashboards/${d.id}/versions`).set(as('founder')).expect(200)).body;
    const mine = after.find((v: { note: string }) => v.note === `e2e ${stamp}`);
    const restored = (await http().post(`/dashboards/${d.id}/versions/${mine.id}/restore`).set(as('founder')).expect(201)).body as DashboardView;
    expect(restored.layout[0].id).toBe('kpi1');
    const audit = await prisma.auditEvent.findMany({ where: { entity: 'dashboard', entityId: d.id }, orderBy: { at: 'desc' }, take: 5 });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dashboard.updated', 'dashboard.reset']));
  });

  it('refuses bad layouts with a plain reason', async () => {
    const d = await builtin('my_day');
    let r = await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout: [{ id: 'x', type: 'section', size: 'full', dashboard: 'my_day', section: 'nope' }] }).expect(400);
    expect(r.body.message).toMatch(/not a section/);
    r = await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout: [{ id: 'a', type: 'note', text: 'x' }, { id: 'a', type: 'note', text: 'y' }] }).expect(400);
    expect(r.body.message).toMatch(/same id/);
    r = await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout: [{ id: 'l', type: 'links', links: [{ label: 'x', href: 'javascript:alert(1)' }] }] }).expect(400);
    expect(r.body.message).toMatch(/Links must start/);
    r = await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout: [{ id: 'c', type: 'chart', metric: 'revenue_raised', dimension: 'person' }] }).expect(400);
    expect(r.body.message).toMatch(/grouping is not available/);
    r = await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ audience: { everyone: true } }).expect(400);
    expect(r.body.message).toMatch(/fixed/);
    await http().post(`/dashboards/${d.id}/archive`).set(as('founder')).send({ reason: 'try it' }).expect(400);
  });

  it('the client home takes only its own sections, notes and links', async () => {
    const d = await builtin('client_home');
    touchedBuiltins.add(d.id);
    await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout: [{ id: 'k', type: 'kpi', metric: 'leads' }] }).expect(400);
    await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout: [{ id: 's', type: 'section', size: 'full', dashboard: 'my_day', section: 'tasks' }] }).expect(400);
    const layout = [{ id: 'n', type: 'note', size: 'full', title: 'Diwali hours', text: `Closed 1–3 Nov ${stamp}` }, ...dashboardDefaultLayout('client_home').filter((w) => w.type === 'section' && w.section !== 'account_manager')];
    await http().patch(`/dashboards/${d.id}`).set(as('founder')).send({ layout }).expect(200);
    const home = (await http().get('/dashboards/home/client').set(as('client')).expect(200)).body as DashboardView;
    expect(home.layout[0]).toMatchObject({ type: 'note', title: 'Diwali hours' });
    await http().get('/dashboards/home/team').set(as('client')).expect(403);
    await http().get('/dashboards/builtin/command_centre').set(as('client')).expect(403);
  });
});

describe('Custom dashboards and who sees them', () => {
  let salesDash: DashboardView;

  it('creates from a template, shown as the sales team home', async () => {
    await http().post('/dashboards').set(as('founder')).send({ name: '' }).expect(400);
    await http().post('/dashboards').set(as('founder')).send({ name: 'x', audience: { roles: ['wizard'] } }).expect(400);
    const r = await http()
      .post('/dashboards')
      .set(as('founder'))
      .send({ name: `Sales floor ${stamp}`, description: 'Leads and follow-ups', startFrom: 'sales', placement: 'team_home', audience: { roles: ['sales_executive'] } })
      .expect(201);
    salesDash = r.body;
    created.push(salesDash.id);
    expect(salesDash.builtin).toBeNull();
    expect(salesDash.layout.length).toBeGreaterThan(4);
    expect(salesDash.layout.some((w) => w.type === 'list' && w.source === 'new_leads')).toBe(true);

    const home = (await http().get('/dashboards/home/team').set(as('sales')).expect(200)).body as DashboardView;
    expect(home.id).toBe(salesDash.id);
    const mine = (await http().get('/dashboards/mine').set(as('sales')).expect(200)).body;
    expect(mine.some((d: { id: string }) => d.id === salesDash.id)).toBe(true);
    // Others keep their own home and cannot open it.
    expect(((await http().get('/dashboards/home/team').set(as('am')).expect(200)).body as DashboardView).builtin).toBe('manager');
    expect(((await http().get('/dashboards/home/team').set(as('video')).expect(200)).body as DashboardView).builtin).toBe('specialist');
    await http().get(`/dashboards/${salesDash.id}`).set(as('finance')).expect(403);
    await http().get(`/dashboards/${salesDash.id}`).set(as('sales')).expect(200);
  });

  it('a dashboard for a named person wins over one for their role', async () => {
    const sales = await prisma.user.findFirst({ where: { email: 'sales@bmu.demo' } });
    const r = await http()
      .post('/dashboards')
      .set(as('founder'))
      .send({ name: `Just for ${stamp}`, startFrom: 'blank', placement: 'team_home', audience: { userIds: [sales!.id] } })
      .expect(201);
    created.push(r.body.id);
    expect(((await http().get('/dashboards/home/team').set(as('sales')).expect(200)).body as DashboardView).id).toBe(r.body.id);
    await http().post(`/dashboards/${r.body.id}/archive`).set(as('founder')).send({ reason: 'only a test' }).expect(201);
    expect(((await http().get('/dashboards/home/team').set(as('sales')).expect(200)).body as DashboardView).id).toBe(salesDash.id);
  });

  it('edits name, audience and layout, duplicates, archives and restores', async () => {
    const u = await http()
      .patch(`/dashboards/${salesDash.id}`)
      .set(as('founder'))
      .send({ name: `Sales floor v2 ${stamp}`, audience: { roles: ['sales_executive', 'sales_manager'] }, layout: [{ id: 'n1', type: 'note', size: 'full', text: 'Call every new lead within an hour' }, ...salesDash.layout] })
      .expect(200);
    expect(u.body.name).toBe(`Sales floor v2 ${stamp}`);
    expect(((await http().get('/dashboards/home/team').set(as('salesManager')).expect(200)).body as DashboardView).id).toBe(salesDash.id);

    const copy = (await http().post(`/dashboards/${salesDash.id}/duplicate`).set(as('founder')).expect(201)).body as DashboardView;
    created.push(copy.id);
    expect(copy.name).toMatch(/^Copy of Sales floor v2/);
    expect(copy.placement).toBe('menu');
    expect(copy.layout).toEqual(u.body.layout);

    // Copy a built-in into a custom dashboard.
    const md = await builtin('manager');
    const fromBuiltin = (await http().post(`/dashboards/${md.id}/duplicate`).set(as('founder')).expect(201)).body as DashboardView;
    created.push(fromBuiltin.id);
    expect(fromBuiltin.layout.every((w) => w.type === 'section' && w.dashboard === 'manager')).toBe(true);
    const cl = await builtin('client_home', 'client');
    await http().post(`/dashboards/${cl.id}/duplicate`).set(as('founder')).expect(400);

    await http().post(`/dashboards/${salesDash.id}/archive`).set(as('founder')).send({ reason: 'x' }).expect(400);
    await http().post(`/dashboards/${salesDash.id}/archive`).set(as('founder')).send({ reason: 'season over' }).expect(201);
    expect(((await http().get('/dashboards/home/team').set(as('sales')).expect(200)).body as DashboardView).builtin).toBe('my_day');
    await http().get(`/dashboards/${salesDash.id}`).set(as('sales')).expect(403);
    await http().patch(`/dashboards/${salesDash.id}`).set(as('founder')).send({ name: 'x' }).expect(400);
    const studio = (await http().get('/dashboards').set(as('founder')).expect(200)).body;
    expect(studio.archived.some((d: { id: string; archivedReason: string }) => d.id === salesDash.id && d.archivedReason === 'season over')).toBe(true);
    await http().post(`/dashboards/${salesDash.id}/restore`).set(as('founder')).expect(201);
    expect(((await http().get('/dashboards/home/team').set(as('sales')).expect(200)).body as DashboardView).id).toBe(salesDash.id);
  });

  it('a saved report on a dashboard must still exist, and gets shared when the owner adds it', async () => {
    await http().patch(`/dashboards/${salesDash.id}`).set(as('founder')).send({ layout: [{ id: 'r', type: 'report', reportId: 'missing' }] }).expect(400);
    const rep = await http()
      .post('/ops-analytics/reports')
      .set(as('founder'))
      .send({ name: `Leads by source ${stamp}`, config: { metric: 'leads', dimension: 'lead_source', from: '2026-01-01', to: '2026-12-31', chart: 'bars' } })
      .expect(201);
    await http().patch(`/dashboards/${salesDash.id}`).set(as('founder')).send({ layout: [{ id: 'r', type: 'report', reportId: rep.body.id }] }).expect(200);
    expect((await prisma.savedReport.findUnique({ where: { id: rep.body.id } }))?.shared).toBe(true);
    const data = await http().get(`/dashboards/data/report/${rep.body.id}`).set(as('sales')).expect(200);
    expect(data.body.name).toBe(`Leads by source ${stamp}`);
    expect(data.body.ownOnly).toBe(true);
    await prisma.savedReport.delete({ where: { id: rep.body.id } });
  });
});

describe('Widget data is scoped to the viewer', () => {
  const range = { from: '2026-01-01', to: '2026-12-31' };

  it('Command Centre readers get everyone; others get their own numbers', async () => {
    const all = (await http().post('/dashboards/data/explore').set(as('founder')).send({ metric: 'leads', dimension: 'person', ...range }).expect(201)).body;
    const own = (await http().post('/dashboards/data/explore').set(as('sales')).send({ metric: 'leads', dimension: 'person', ...range }).expect(201)).body;
    expect(all.ownOnly).toBe(false);
    expect(own.ownOnly).toBe(true);
    expect(own.total).toBeLessThanOrEqual(all.total);
    expect(own.rows.length).toBeLessThanOrEqual(1);
  });

  it('money numbers stay with money roles, and numbers with no person stay with the Command Centre', async () => {
    await http().post('/dashboards/data/explore').set(as('sales')).send({ metric: 'revenue_raised', dimension: 'month', ...range }).expect(403);
    await http().post('/dashboards/data/explore').set(as('finance')).send({ metric: 'revenue_raised', dimension: 'month', ...range }).expect(201);
    await http().post('/dashboards/data/explore').set(as('client')).send({ metric: 'leads', dimension: 'month', ...range }).expect(403);
  });

  it('lists are scoped: own tasks, own leads, invoices only for money roles', async () => {
    const mine = (await http().get('/dashboards/data/list/my_tasks?limit=20').set(as('producer')).expect(200)).body;
    const producer = await prisma.user.findFirst({ where: { email: 'producer@bmu.demo' } });
    for (const row of mine.rows) expect((await prisma.task.findUnique({ where: { id: row.id } }))?.ownerId).toBe(producer!.id);
    const overdueAll = (await http().get('/dashboards/data/list/overdue_tasks').set(as('founder')).expect(200)).body;
    const overdueOwn = (await http().get('/dashboards/data/list/overdue_tasks').set(as('producer')).expect(200)).body;
    expect(overdueOwn.total).toBeLessThanOrEqual(overdueAll.total);

    const leadsAll = (await http().get('/dashboards/data/list/new_leads').set(as('salesManager')).expect(200)).body;
    const leadsOwn = (await http().get('/dashboards/data/list/new_leads').set(as('sales')).expect(200)).body;
    expect(leadsOwn.total).toBeLessThanOrEqual(leadsAll.total);
    await http().get('/dashboards/data/list/new_leads').set(as('producer')).expect(403);

    await http().get('/dashboards/data/list/overdue_invoices').set(as('am')).expect(403);
    const inv = (await http().get('/dashboards/data/list/overdue_invoices').set(as('finance')).expect(200)).body;
    expect(inv.label).toBe('Overdue invoices');
    await http().get('/dashboards/data/list/nope').set(as('founder')).expect(400);
    await http().get('/dashboards/data/list/my_tasks').set(as('client')).expect(403);
  });
});
