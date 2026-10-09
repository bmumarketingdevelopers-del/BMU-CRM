// v10 craft: specialties, specialist dashboards (own data only, leads read-only) and the Manager workspace.
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
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const ids: Record<string, string> = {};
const createdTasks: string[] = [];

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
  ids.org = org.id;

  const people: Record<string, string> = {
    founder: 'founder@bmu.demo',
    hr: 'hr@bmu.demo',
    amLead: 'am.lead@bmu.demo',
    am: 'am@bmu.demo',
    pm: 'pm@bmu.demo',
    head: 'design.head@bmu.demo',
    producer: 'producer@bmu.demo',
    video: 'video@bmu.demo',
    script: 'script@bmu.demo',
    social: 'social@bmu.demo',
    dev: 'dev@bmu.demo',
    uxui: 'uxui@bmu.demo',
    design: 'design@bmu.demo',
  };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  // A throwaway staff member whose specialty we change (soft-deleted in afterAll).
  const producerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole: 'producer', isCustom: false } });
  const temp = await prisma.user.create({
    data: { orgId: org.id, type: 'staff', name: 'Craft Temp', email: `craft.temp.${stamp}@example.com`, status: 'active', roles: { create: { roleId: producerRole.id } } },
  });
  ids.temp = temp.id;

  // A client user for the 403 checks.
  const owner = await prisma.clientUser.findFirstOrThrow({ where: { clientRole: 'client_owner', clientOrg: { name: 'Peak Motors' } }, include: { user: true } });
  tokens.client = await signIn(owner.user.email!);

  // Engagements: one of pm's (Peak Motors) and one of am@'s (Saffron Table).
  ids.pmEng = (await prisma.engagement.findFirstOrThrow({ where: { amId: ids.pm, clientOrg: { name: 'Peak Motors' } } })).id;
  ids.amEng = (await prisma.engagement.findFirstOrThrow({ where: { amId: ids.am, clientOrg: { name: 'Saffron Table Restaurants' } } })).id;
  ids.peak = (await prisma.clientOrg.findFirstOrThrow({ where: { name: 'Peak Motors' } })).id;
  ids.saffron = (await prisma.clientOrg.findFirstOrThrow({ where: { name: 'Saffron Table Restaurants' } })).id;
  const mk = async (engagementId: string, title: string, specialty: string) => {
    const t = await prisma.task.create({ data: { orgId: org.id, engagementId, title, specialty, kind: 'work', status: 'todo', deadline: new Date(Date.now() + 3 * 86_400_000) } });
    createdTasks.push(t.id);
    return t.id;
  };
  ids.pmTask = await mk(ids.pmEng, `Craft e2e banner ${stamp}`, 'graphic_designer');
  ids.amTask = await mk(ids.amEng, `Craft e2e story ${stamp}`, 'graphic_designer');
});

afterAll(async () => {
  await prisma.user.updateMany({ where: { email: `craft.temp.${stamp}@example.com` }, data: { deletedAt: new Date() } });
  const adhoc = await prisma.task.findMany({ where: { title: { contains: `${stamp}` } }, select: { id: true } });
  await prisma.notification.deleteMany({ where: { title: { contains: `${stamp}` } } });
  await prisma.task.deleteMany({ where: { id: { in: [...createdTasks, ...adhoc.map((t) => t.id)] } } });
  await prisma.craftClientNote.deleteMany({ where: { body: { contains: `${stamp}` } } });
  await app.close();
});

describe('Specialty on users', () => {
  it('lets the founder and HR set a specialty', async () => {
    const a = await http().patch(`/org/users/${ids.temp}`).set(as('founder')).send({ specialty: 'video_editor' }).expect(200);
    expect(a.body.specialty).toBe('video_editor');
    const b = await http().patch(`/org/users/${ids.temp}`).set(as('hr')).send({ specialty: 'project_manager' }).expect(200);
    expect(b.body.specialty).toBe('project_manager');
    await http().patch(`/org/users/${ids.temp}`).set(as('hr')).send({ specialty: null }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.temp } })).specialty).toBeNull();
  });

  it('refuses producers and malformed values', async () => {
    await http().patch(`/org/users/${ids.temp}`).set(as('producer')).send({ specialty: 'developer' }).expect(403);
    await http().patch(`/org/users/${ids.temp}`).set(as('founder')).send({ specialty: 'Not A Key!' }).expect(400);
  });

  it('shows the specialty on /auth/me and the profile', async () => {
    const me = await http().get('/auth/me').set(as('video')).expect(200);
    expect(me.body.specialty).toBe('video_editor');
  });
});

describe('Specialist dashboards', () => {
  const cases = [
    ['video', 'video_editor'],
    ['script', 'script_writer'],
    ['social', 'social_media_manager'],
    ['dev', 'developer'],
    ['uxui', 'ux_ui_designer'],
    ['design', 'graphic_designer'],
  ] as const;
  it.each(cases)('%s gets their own %s dashboard with only their own work', async (who, specialty) => {
    const r = await http().get('/craft/dashboard').set(as(who)).expect(200);
    expect(r.body.specialty).toBe(specialty);
    expect(r.body.person.id).toBe(ids[who]);
    expect(r.body.readOnly).toBe(false);
    expect(r.body.kpis.length).toBeGreaterThan(2);
    expect(r.body.workload.weeks.length).toBe(10);
    // Every task-backed "next" item belongs to this person.
    const taskIds = r.body.next.filter((n: { id: string }) => /^[otnb]-/.test(n.id)).map((n: { id: string }) => n.id.slice(2));
    if (taskIds.length) {
      const owners = await prisma.task.findMany({ where: { id: { in: taskIds } }, select: { ownerId: true } });
      expect(owners.every((t) => t.ownerId === ids[who])).toBe(true);
    }
  });

  it("a specialist can't open someone else's dashboard", async () => {
    await http().get(`/craft/dashboard?userId=${ids.design}`).set(as('video')).expect(403);
  });

  it('a producer cannot view others', async () => {
    await http().get(`/craft/dashboard?userId=${ids.design}`).set(as('producer')).expect(403);
    await http().get('/craft/specialists').set(as('producer')).expect(403);
  });

  it('leads can view others read-only', async () => {
    const r = await http().get(`/craft/dashboard?userId=${ids.design}`).set(as('amLead')).expect(200);
    expect(r.body.readOnly).toBe(true);
    expect(r.body.person.id).toBe(ids.design);
    // A department head sees their own department only.
    await http().get(`/craft/dashboard?userId=${ids.uxui}`).set(as('head')).expect(200);
    await http().get(`/craft/dashboard?userId=${ids.dev}`).set(as('head')).expect(403);
    const list = await http().get('/craft/specialists').set(as('founder')).expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(6);
  });

  it('clients get 403 on every craft endpoint', async () => {
    await http().get('/craft/dashboard').set(as('client')).expect(403);
    await http().get('/craft/specialists').set(as('client')).expect(403);
    await http().get('/craft/hooks').set(as('client')).expect(403);
    await http().get('/craft/manager').set(as('client')).expect(403);
  });

  it('script writers keep a private hooks library', async () => {
    const h = await http().post('/craft/hooks').set(as('script')).send({ text: `A hook nobody else sees ${stamp}`, tags: ['test'] }).expect(201);
    const mine = await http().get('/craft/hooks').set(as('script')).expect(200);
    expect(mine.body.some((x: { id: string }) => x.id === h.body.id)).toBe(true);
    const theirs = await http().get('/craft/hooks').set(as('video')).expect(200);
    expect(theirs.body.some((x: { id: string }) => x.id === h.body.id)).toBe(false);
    await http().delete(`/craft/hooks/${h.body.id}`).set(as('video')).expect(404);
    await http().delete(`/craft/hooks/${h.body.id}`).set(as('script')).expect(200);
  });
});

describe('Manager workspace', () => {
  it('scopes the board: an AM sees only their own clients', async () => {
    const pm = await http().get('/craft/manager').set(as('pm')).expect(200);
    expect(pm.body.scope).toBe('own_clients');
    const boardIds = pm.body.board.map((t: { id: string }) => t.id);
    expect(boardIds).toContain(ids.pmTask);
    expect(boardIds).not.toContain(ids.amTask);
    expect(pm.body.clients.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([ids.peak]));
    expect(pm.body.clients.map((c: { id: string }) => c.id)).not.toContain(ids.saffron);
    const lead = await http().get('/craft/manager').set(as('amLead')).expect(200);
    expect(lead.body.scope).toBe('all');
    const card = pm.body.board.find((t: { id: string }) => t.id === ids.pmTask);
    expect(card.suggestion?.userId).toBeTruthy();
  });

  it("an AM can't assign tasks of another AM's client", async () => {
    await http().post(`/craft/manager/tasks/${ids.amTask}/assign`).set(as('pm')).send({ ownerId: ids.design }).expect(403);
    await http().patch(`/craft/manager/tasks/${ids.amTask}`).set(as('pm')).send({ priority: 'high' }).expect(403);
  });

  it("a producer can't assign or open the workspace", async () => {
    await http().get('/craft/manager').set(as('producer')).expect(403);
    await http().post(`/craft/manager/tasks/${ids.pmTask}/assign`).set(as('producer')).send({ ownerId: ids.design }).expect(403);
  });

  it('assigning notifies the assignee and writes the audit log', async () => {
    const r = await http().post(`/craft/manager/tasks/${ids.pmTask}/assign`).set(as('pm')).send({ ownerId: ids.design, priority: 'high', deadline: '2026-12-01' }).expect(200);
    expect(r.body.owner.id).toBe(ids.design);
    expect(r.body.priority).toBe('high');
    const n = await prisma.notification.findFirst({ where: { userId: ids.design, kind: 'task_assigned', title: { contains: `Craft e2e banner ${stamp}` } } });
    expect(n).toBeTruthy();
    expect(n!.link).toBe('/team/tasks');
    expect(await prisma.auditEvent.count({ where: { entity: 'Task', entityId: ids.pmTask, action: 'task.assigned' } })).toBe(1);
    // The designer sees it as new work on their dashboard.
    const dash = await http().get('/craft/dashboard').set(as('design')).expect(200);
    expect(dash.body.next.some((x: { id: string; kind: string }) => x.id === `n-${ids.pmTask}` && x.kind === 'assigned')).toBe(true);

    // Reassign: the new owner is told, and so is the previous one.
    await http().post(`/craft/manager/tasks/${ids.pmTask}/assign`).set(as('pm')).send({ ownerId: ids.uxui }).expect(200);
    expect(await prisma.notification.count({ where: { userId: ids.design, title: { contains: `moved to` } , createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBeGreaterThan(0);
    expect(await prisma.auditEvent.count({ where: { entityId: ids.pmTask, action: 'task.reassigned' } })).toBe(1);
  });

  it('lets an AM view the dashboard of someone working on their clients', async () => {
    await http().get(`/craft/dashboard?userId=${ids.uxui}`).set(as('pm')).expect(200);
  });

  it('bulk reassigns and updates deadline and priority', async () => {
    const b = await http().post('/craft/manager/tasks/assign').set(as('pm')).send({ taskIds: [ids.pmTask], ownerId: ids.design }).expect(200);
    expect(b.body.assigned).toBe(1);
    await http().post('/craft/manager/tasks/assign').set(as('pm')).send({ taskIds: [ids.pmTask, ids.amTask], ownerId: ids.design }).expect(403);
    const u = await http().patch(`/craft/manager/tasks/${ids.pmTask}`).set(as('pm')).send({ deadline: '2026-12-05', priority: 'urgent' }).expect(200);
    expect(u.body.priority).toBe('urgent');
    expect(u.body.deadline.slice(0, 10)).toBe('2026-12-05');
    await http().patch(`/craft/manager/tasks/${ids.pmTask}`).set(as('pm')).send({}).expect(400);
  });

  it('keeps the QC rule: the uploader of the latest version cannot QC it', async () => {
    const qc = await prisma.task.findFirst({
      where: { kind: 'qc', status: { in: ['todo', 'waiting', 'in_progress'] }, engagementId: ids.pmEng, deliverable: { versions: { some: {} } } },
      include: { deliverable: { include: { versions: { orderBy: { number: 'desc' }, take: 1 } } } },
    });
    expect(qc).toBeTruthy();
    const uploader = qc!.deliverable!.versions[0].uploadedById;
    await http().post(`/craft/manager/tasks/${qc!.id}/assign`).set(as('pm')).send({ ownerId: uploader }).expect(400);
    // Makers without the QC role can't take QC tasks either.
    await http().post(`/craft/manager/tasks/${qc!.id}/assign`).set(as('pm')).send({ ownerId: ids.producer }).expect(400);
  });

  it('refuses to reassign finished work', async () => {
    const done = await prisma.task.findFirstOrThrow({ where: { engagementId: ids.pmEng, status: 'done' } });
    await http().post(`/craft/manager/tasks/${done.id}/assign`).set(as('pm')).send({ ownerId: ids.design }).expect(400);
  });

  it('creates an ad-hoc task with an assignee', async () => {
    const r = await http()
      .post('/craft/manager/tasks')
      .set(as('pm'))
      .send({ title: `Craft e2e ad-hoc ${stamp}`, engagementId: ids.pmEng, specialty: 'graphic_designer', ownerId: ids.design, deadline: '2026-12-02', priority: 'high' })
      .expect(201);
    expect(r.body.owner.id).toBe(ids.design);
    expect(r.body.specialty).toBe('graphic_designer');
    expect(r.body.client.id).toBe(ids.peak);
    expect(await prisma.notification.count({ where: { userId: ids.design, title: { contains: `Craft e2e ad-hoc ${stamp}` } } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityId: r.body.id, action: 'task.created' } })).toBe(1);
    // Not on another AM's engagement, and an AM must pick a client.
    await http().post('/craft/manager/tasks').set(as('pm')).send({ title: `Craft e2e nope ${stamp}`, engagementId: ids.amEng }).expect(403);
    await http().post('/craft/manager/tasks').set(as('pm')).send({ title: `Craft e2e nope ${stamp}` }).expect(400);
  });

  it('logs client notes only for own clients', async () => {
    const n = await http().post(`/craft/manager/clients/${ids.peak}/notes`).set(as('pm')).send({ kind: 'call', body: `Call note ${stamp}` }).expect(201);
    expect(n.body.kind).toBe('call');
    await http().post(`/craft/manager/clients/${ids.peak}/notes`).set(as('pm')).send({ kind: 'meeting', body: `Meeting ${stamp}` }).expect(400);
    await http().post(`/craft/manager/clients/${ids.saffron}/notes`).set(as('pm')).send({ kind: 'note', body: `Nope ${stamp}` }).expect(403);
  });
});
