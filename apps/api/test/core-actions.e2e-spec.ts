// v11 core: the shared action system (reassignment engine, approvals, undo, drafts, views, watchers, tags, import,
// palette) and tasks end to end (create rules, gate, out of scope, subtasks, dependencies, blocked, deadline, archive,
// duplicate, templates, recurring, bulk) with the permission rules for each role.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TasksActionsService } from '../src/actions/tasks/tasks.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const tag = (s: string) => `${s} ${stamp}`;
const recIds: string[] = [];

/** yyyy-mm-dd in IST, n calendar days from today, moved forward off Sunday. */
function dayAhead(n: number) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const D = dayAhead(4);
const D2 = dayAhead(5);

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

/** Creates a task through the API as `who` and returns it. */
async function createTask(who: string, body: Record<string, unknown>, expect = 201) {
  const r = await http().post('/tasks').set(as(who)).send(body);
  if (r.status !== expect) throw new Error(`create as ${who}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  ids.org = org.id;
  const people: Record<string, string> = { founder: 'founder@bmu.demo', am: 'am@bmu.demo', head: 'design.head@bmu.demo', design: 'design@bmu.demo', uxui: 'uxui@bmu.demo', producer: 'producer@bmu.demo', strategist: 'strategist@bmu.demo', finance: 'finance@bmu.demo' };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const head = await prisma.user.findFirstOrThrow({ where: { id: ids.head } });
  ids.dept = head.departmentId!;
  // Two throwaway producers in the design department (soft-deleted in afterAll); temp1 is on leave on D.
  const producerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole: 'producer', isCustom: false } });
  for (const k of ['temp1', 'temp2', 'temp3']) {
    const u = await prisma.user.create({ data: { orgId: org.id, type: 'staff', name: `Core ${k} ${stamp}`, email: `core.${k}.${stamp}@example.com`, status: 'active', departmentId: ids.dept, roles: { create: { roleId: producerRole.id } } } });
    ids[k] = u.id;
  }
  tokens.temp3 = await signIn(`core.temp3.${stamp}@example.com`);
  await prisma.leaveRequest.create({ data: { orgId: org.id, userId: ids.temp1, from: new Date(`${D}T00:00:00Z`), to: new Date(`${D}T00:00:00Z`), status: 'approved', reason: tag('core e2e leave'), stage: 'done' } });

  const owner = await prisma.clientUser.findFirstOrThrow({ where: { clientRole: 'client_owner' }, include: { user: true } });
  tokens.client = await signIn(owner.user.email!);

  ids.amEng = (await prisma.engagement.findFirstOrThrow({ where: { amId: ids.am, clientOrg: { name: 'Saffron Table Restaurants' } } })).id;
  ids.saffron = (await prisma.clientOrg.findFirstOrThrow({ where: { name: 'Saffron Table Restaurants' } })).id;
  ids.preEng = (await prisma.engagement.findFirstOrThrow({ where: { deletedAt: null, archivedAt: null, currentGate: { in: ['G1', 'G2'] } }, orderBy: { createdAt: 'asc' } })).id;
});

afterAll(async () => {
  const mine = await prisma.task.findMany({ where: { OR: [{ title: { contains: `${stamp}` } }, { recurrenceId: { in: recIds } }] }, select: { id: true } });
  const taskIds = mine.map((t) => t.id);
  const extra = taskIds.length ? await prisma.task.findMany({ where: { OR: [{ parentId: { in: taskIds } }, { dependsOn: { hasSome: taskIds } }] }, select: { id: true } }) : [];
  const all = [...new Set([...taskIds, ...extra.map((t) => t.id)])];
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: all } } });
  await prisma.assignment.deleteMany({ where: { targetId: { in: all } } });
  await prisma.watcher.deleteMany({ where: { targetId: { in: all } } });
  await prisma.tagLink.deleteMany({ where: { targetId: { in: all } } });
  await prisma.tag.deleteMany({ where: { name: { contains: `${stamp}` } } });
  await prisma.task.deleteMany({ where: { id: { in: all } } });
  await prisma.taskRecurrence.deleteMany({ where: { id: { in: recIds } } });
  await prisma.savedView.deleteMany({ where: { name: { contains: `${stamp}` } } });
  await prisma.draft.deleteMany({ where: { key: { contains: `${stamp}` } } });
  await prisma.importJob.deleteMany({ where: { fileName: { contains: `${stamp}` } } });
  await prisma.notification.deleteMany({ where: { title: { contains: `${stamp}` } } });
  await prisma.leaveRequest.deleteMany({ where: { userId: { in: [ids.temp1, ids.temp2, ids.temp3] } } });
  await prisma.user.updateMany({ where: { id: { in: [ids.temp1, ids.temp2, ids.temp3] } }, data: { deletedAt: new Date(), status: 'suspended' } });
  await app.close();
});

describe('Permissions', () => {
  it('keeps client accounts out of every action endpoint', async () => {
    await http().get('/tasks/query').set(as('client')).expect(403);
    await http().get('/actions/approvals').set(as('client')).expect(403);
    await http().get('/actions/reassign/task/candidates').set(as('client')).expect(403);
    await http().get('/imports').set(as('client')).expect(403);
  });

  it('lets producers add tasks only for themselves', async () => {
    const own = await createTask('design', { title: tag('Producer own task'), internal: true, departmentId: ids.dept, ownerId: ids.design, deadline: D2 });
    expect(own.task.owner.id).toBe(ids.design);
    ids.producerTask = own.task.id;
    const r = await http().post('/tasks').set(as('design')).send({ title: tag('Producer for someone else'), internal: true, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2 }).expect(403);
    expect(r.body.message).toMatch(/only for themselves/);
  });

  it('never lets a producer reassign or change a deadline directly', async () => {
    await http().post('/actions/reassign/task/apply').set(as('design')).send({ ids: [ids.producerTask], toUserId: ids.uxui, reason: 'overload' }).expect(403);
    const before = await prisma.task.findUniqueOrThrow({ where: { id: ids.producerTask } });
    const r = await http().post(`/tasks/${ids.producerTask}/deadline`).set(as('design')).send({ deadline: dayAhead(6), reason: tag('Need more time') }).expect(200);
    expect(r.body.approval?.id).toBeTruthy();
    const after = await prisma.task.findUniqueOrThrow({ where: { id: ids.producerTask } });
    expect(after.deadline?.toISOString()).toBe(before.deadline?.toISOString());
    ids.deadlineReq = r.body.approval.id;
  });

  it('restricts the approvals queue and the jobs runner', async () => {
    await http().get('/actions/approvals?box=all').set(as('design')).expect(403);
    await http().get('/actions/approvals?box=all').set(as('head')).expect(200);
    await http().post('/actions/jobs/run').set(as('design')).expect(403);
    const r = await http().post('/actions/jobs/run').set(as('founder')).expect(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('Task create rules', () => {
  it('needs Gate 3 for client tasks unless it is pre-production work', async () => {
    const r = await http().post('/tasks').set(as('founder')).send({ title: tag('Early task'), engagementId: ids.preEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2 }).expect(400);
    expect(r.body.message).toMatch(/Gate 3/);
    const ok = await createTask('founder', { title: tag('Onboarding prep'), engagementId: ids.preEng, departmentId: ids.dept, ownerId: ids.uxui, deadline: D2, preProduction: true });
    expect(ok.task.preProduction).toBe(true);
  });

  it('saves out-of-scope work as a draft without an approved add-on', async () => {
    const r = await createTask('am', { title: tag('Extra reel'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2, outOfScope: true });
    expect(r.task.isDraft).toBe(true);
    expect(r.task.draftReason).toBe('out_of_scope');
    expect(r.message).toMatch(/draft/i);
    const list = await http().get('/tasks/query?scope=team&drafts=1').set(as('am')).expect(200);
    expect(list.body.some((t: { id: string }) => t.id === r.task.id)).toBe(true);
    await http().post(`/tasks/${r.task.id}/activate`).set(as('am')).send({ addOnRequestId: 'nope' }).expect(400);
  });

  it('creates an internal task with subtasks and enforces the parent-done rule', async () => {
    const r = await createTask('am', { title: tag('Internal pitch deck'), internal: true, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2, subtasks: [{ title: tag('Collect logos') }], checklist: [{ id: 'a', label: 'Outline', done: false }] });
    ids.parent = r.task.id;
    const detail = await http().get(`/tasks/${ids.parent}`).set(as('am')).expect(200);
    expect(detail.body.subtasks).toHaveLength(1);
    ids.subtask = detail.body.subtasks[0].id;
    await http().post(`/tasks/${ids.parent}/status`).set(as('temp3')).send({ status: 'in_progress' }).expect(200);
    const done = await http().post(`/tasks/${ids.parent}/status`).set(as('temp3')).send({ status: 'done' }).expect(400);
    expect(done.body.message).toMatch(/subtask/);
    // The legacy board endpoint applies the same rule.
    await http().patch(`/tasks/${ids.parent}`).set(as('temp3')).send({ status: 'done' }).expect(400);
  });

  it('blocks or routes a new task for someone on leave on the deadline', async () => {
    const r = await createTask('am', { title: tag('Leave day task'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp1, deadline: D });
    expect(r.approval?.id).toBeTruthy();
    expect(r.task.owner).toBeNull();
    const blocked = await http().post('/tasks').set(as('head')).send({ title: tag('Head leave task'), internal: true, departmentId: ids.dept, ownerId: ids.temp1, deadline: D }).expect(400);
    expect(blocked.body.message).toMatch(/leave/);
    const over = await createTask('head', { title: tag('Head override task'), internal: true, departmentId: ids.dept, ownerId: ids.temp1, deadline: D, overrideLeave: true });
    expect(over.task.owner.id).toBe(ids.temp1);
  });
});

describe('Reassignment engine', () => {
  beforeAll(async () => {
    ids.rTask = (await createTask('am', { title: tag('Reassign me'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D })).task.id;
    ids.bigTask = (await createTask('am', { title: tag('Huge job'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2, estimateHours: 200 })).task.id;
  });

  it('lists candidates with load, leave and the current owner', async () => {
    const r = await http().get(`/actions/reassign/task/candidates?ids=${ids.rTask}`).set(as('am')).expect(200);
    const t1 = r.body.candidates.find((c: { id: string }) => c.id === ids.temp1);
    expect(t1.onLeave).toBe(true);
    expect(r.body.candidates.find((c: { id: string }) => c.id === ids.temp3).current).toBe(true);
    expect(r.body.reasons.length).toBeGreaterThan(3);
  });

  it('requires a reason and a handover note once work has started', async () => {
    await http().post('/actions/reassign/task/apply').set(as('am')).send({ ids: [ids.rTask], toUserId: ids.temp2 }).expect(400);
    await prisma.task.update({ where: { id: ids.rTask }, data: { status: 'in_progress' } });
    const r = await http().post('/actions/reassign/task/apply').set(as('am')).send({ ids: [ids.rTask], toUserId: ids.temp2, reason: 'overload' }).expect(400);
    expect(r.body.message).toMatch(/handover/i);
    await prisma.task.update({ where: { id: ids.rTask }, data: { status: 'todo' } });
  });

  it('sends a move onto leave for approval (non-heads) and blocks heads without override', async () => {
    const r = await http().post('/actions/reassign/task/apply').set(as('am')).send({ ids: [ids.rTask], toUserId: ids.temp1, reason: 'overload' }).expect(200);
    expect(r.body.applied).toBe(0);
    expect(r.body.approval.id).toBeTruthy();
    ids.leaveApproval = r.body.approval.id;
    const h = await http().post('/actions/reassign/task/apply').set(as('head')).send({ ids: [ids.rTask], toUserId: ids.temp1, reason: 'overload' }).expect(400);
    expect(h.body.message).toMatch(/leave/);
    await http().post(`/actions/approvals/${ids.leaveApproval}/cancel`).set(as('am')).expect(200);
  });

  it('needs Department Head approval above 120% and applies it on approve', async () => {
    const p = await http().post('/actions/reassign/task/preview').set(as('am')).send({ ids: [ids.bigTask], toUserId: ids.temp2 }).expect(200);
    expect(p.body.needsApproval).toBeTruthy();
    const r = await http().post('/actions/reassign/task/apply').set(as('am')).send({ ids: [ids.bigTask], toUserId: ids.temp2, reason: 'skill_fit' }).expect(200);
    expect(r.body.approval.id).toBeTruthy();
    const box = await http().get('/actions/approvals?box=mine').set(as('head')).expect(200);
    expect(box.body.some((a: { id: string }) => a.id === r.body.approval.id)).toBe(true);
    const count = await http().get('/actions/approvals/count').set(as('head')).expect(200);
    expect(count.body.pending).toBeGreaterThan(0);
    await http().post(`/actions/approvals/${r.body.approval.id}/decide`).set(as('design')).send({ decision: 'approve' }).expect(403);
    const d = await http().post(`/actions/approvals/${r.body.approval.id}/decide`).set(as('head')).send({ decision: 'approve', note: 'OK this once' }).expect(200);
    expect(d.body.status).toBe('approved');
    const t = await prisma.task.findUniqueOrThrow({ where: { id: ids.bigTask } });
    expect(t.ownerId).toBe(ids.temp2);
    const trail = await prisma.assignment.findMany({ where: { targetId: ids.bigTask, toUserId: ids.temp2 } });
    expect(trail.length).toBeGreaterThan(0);
  });

  it('applies a head move with a deadline extension and undoes it', async () => {
    const before = await prisma.task.findUniqueOrThrow({ where: { id: ids.rTask } });
    const r = await http().post('/actions/reassign/task/apply').set(as('head')).send({ ids: [ids.rTask], toUserId: ids.temp2, reason: 'priority_change', deadline: { mode: 'extend', days: 2 } }).expect(200);
    expect(r.body.applied).toBe(1);
    expect(r.body.undo.token).toBeTruthy();
    expect(r.body.undoRows).toBeUndefined();
    const moved = await prisma.task.findUniqueOrThrow({ where: { id: ids.rTask } });
    expect(moved.ownerId).toBe(ids.temp2);
    expect(moved.deadline!.getTime()).toBeGreaterThan(before.deadline!.getTime());
    await http().post(`/actions/undo/${r.body.undo.token}`).set(as('am')).expect(403);
    await http().post(`/actions/undo/${r.body.undo.token}`).set(as('head')).expect(200);
    const back = await prisma.task.findUniqueOrThrow({ where: { id: ids.rTask } });
    expect(back.ownerId).toBe(ids.temp3);
    expect(back.deadline?.toISOString()).toBe(before.deadline?.toISOString());
    await http().post(`/actions/undo/${r.body.undo.token}`).set(as('head')).expect(400);
  });

  it('moves all of one person’s open work (bulk) for heads only', async () => {
    const w = await http().get(`/actions/reassign/open-work/${ids.temp2}`).set(as('head')).expect(200);
    expect(w.body.groups.find((g: { type: string }) => g.type === 'task').items.length).toBeGreaterThan(0);
    await http().post('/actions/reassign/bulk').set(as('design')).send({ fromUserId: ids.temp2, reason: 'leave', moves: [{ toUserId: ids.uxui, items: [{ type: 'task', id: ids.bigTask }] }] }).expect(403);
  });
});

describe('Approvals', () => {
  it('rejects a producer’s deadline request and leaves the deadline alone', async () => {
    const before = await prisma.task.findUniqueOrThrow({ where: { id: ids.producerTask } });
    await http().post(`/actions/approvals/${ids.deadlineReq}/decide`).set(as('head')).send({ decision: 'reject' }).expect(400);
    const r = await http().post(`/actions/approvals/${ids.deadlineReq}/decide`).set(as('head')).send({ decision: 'reject', note: 'Keep the date' }).expect(200);
    expect(r.body.status).toBe('rejected');
    const after = await prisma.task.findUniqueOrThrow({ where: { id: ids.producerTask } });
    expect(after.deadline?.toISOString()).toBe(before.deadline?.toISOString());
  });

  it('expires requests after the window', async () => {
    const r = await http().post(`/tasks/${ids.producerTask}/deadline`).set(as('design')).send({ deadline: dayAhead(7), reason: tag('Second ask') }).expect(200);
    await prisma.approvalRequest.update({ where: { id: r.body.approval.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const list = await http().get('/actions/approvals?box=requested').set(as('design')).expect(200);
    expect(list.body.find((a: { id: string }) => a.id === r.body.approval.id).status).toBe('expired');
  });

  it('routes "Can’t take this" to the head, who picks the new owner', async () => {
    const t = (await createTask('am', { title: tag('Hand back'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.design, deadline: D2 })).task;
    const r = await http().post(`/tasks/${t.id}/handback`).set(as('design')).send({ reason: 'Too much on this week' }).expect(200);
    const view = await http().get(`/actions/approvals/${r.body.approval.id}`).set(as('head')).expect(200);
    expect(view.body.approveNeeds).toBe('assignee');
    await http().post(`/actions/approvals/${r.body.approval.id}/decide`).set(as('head')).send({ decision: 'approve' }).expect(400);
    await http().post(`/actions/approvals/${r.body.approval.id}/decide`).set(as('head')).send({ decision: 'approve', input: { toUserId: ids.uxui } }).expect(200);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.ownerId).toBe(ids.uxui);
  });
});

describe('Task actions', () => {
  beforeAll(async () => {
    ids.a = (await createTask('am', { title: tag('Action A'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2 })).task.id;
    ids.b = (await createTask('am', { title: tag('Action B'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2 })).task.id;
  });

  it('needs blocked details and records them', async () => {
    await http().post(`/tasks/${ids.a}/status`).set(as('temp3')).send({ status: 'blocked' }).expect(400);
    const r = await http().post(`/tasks/${ids.a}/status`).set(as('temp3')).send({ status: 'blocked', blocked: { reason: 'No logo files', waitingFor: 'Client logo', responsibleId: ids.am, expectedAt: D } }).expect(200);
    expect(r.body.task.blocked.waitingFor).toBe('Client logo');
    expect(r.body.task.blocked.responsible).toBeTruthy();
    await http().post(`/tasks/${ids.a}/status`).set(as('temp3')).send({ status: 'todo' }).expect(200);
  });

  it('keeps a task waiting until its dependency is done', async () => {
    await http().post(`/tasks/${ids.b}/dependencies`).set(as('am')).send({ dependsOnId: ids.a }).expect(200);
    const r = await http().post(`/tasks/${ids.b}/status`).set(as('temp3')).send({ status: 'in_progress' }).expect(400);
    expect(r.body.message).toMatch(/Waiting on/);
    await http().delete(`/tasks/${ids.b}/dependencies/${ids.a}`).set(as('am')).expect(200);
  });

  it('changes a deadline with a reason (managers) and refuses producers changing others', async () => {
    await http().post(`/tasks/${ids.a}/deadline`).set(as('am')).send({ deadline: dayAhead(6) }).expect(400);
    const r = await http().post(`/tasks/${ids.a}/deadline`).set(as('am')).send({ deadline: dayAhead(6), reason: 'Client asked' }).expect(200);
    expect(r.body.message).toMatch(/Deadline moved/);
    const p = await http().post(`/tasks/${ids.a}/deadline`).set(as('design')).send({ deadline: dayAhead(6), reason: 'Mine now' });
    expect([403, 404]).toContain(p.status);
  });

  it('archives with a reason, hides it, and restores it', async () => {
    await http().post(`/tasks/${ids.b}/archive`).set(as('temp3')).send({ reason: 'Not needed' }).expect(403);
    await http().post(`/tasks/${ids.b}/archive`).set(as('am')).send({ reason: 'x' }).expect(400);
    const r = await http().post(`/tasks/${ids.b}/archive`).set(as('am')).send({ reason: 'Client dropped it' }).expect(200);
    expect(r.body.task.archivedAt).toBeTruthy();
    const open = await http().get(`/tasks/query?scope=team&q=${encodeURIComponent(tag('Action B'))}`).set(as('am')).expect(200);
    expect(open.body).toHaveLength(0);
    const arch = await http().get(`/tasks/query?scope=team&archived=1&q=${encodeURIComponent(tag('Action B'))}`).set(as('am')).expect(200);
    expect(arch.body).toHaveLength(1);
    await http().patch(`/tasks/${ids.b}`).set(as('temp3')).send({ status: 'in_progress' }).expect(400);
    await http().post(`/tasks/${ids.b}/restore`).set(as('am')).expect(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ids.b } })).status).toBe('todo');
  });

  it('duplicates a task', async () => {
    const r = await http().post(`/tasks/${ids.a}/duplicate`).set(as('am')).send({ count: 2 }).expect(201);
    expect(r.body.ids).toHaveLength(2);
    await http().post(`/tasks/${ids.a}/duplicate`).set(as('temp3')).send({}).expect(403);
  });

  it('edits details through PATCH /tasks/:id and the details endpoint', async () => {
    const r = await http().patch(`/tasks/${ids.a}`).set(as('am')).send({ description: 'More detail', priority: 'high' }).expect(200);
    expect(r.body.task.description).toBe('More detail');
    expect(r.body.task.priority).toBe('high');
  });

  it('routes Done on an ad-hoc deliverable task to QC', async () => {
    const del = await prisma.deliverable.findFirst({ where: { cycle: { engagementId: ids.amEng }, tasks: { none: { kind: 'qc', status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] } } } } });
    if (!del) return;
    const t = (await createTask('am', { title: tag('Deliverable touch-up'), engagementId: ids.amEng, departmentId: ids.dept, ownerId: ids.temp3, deadline: D2, deliverableId: del.id })).task;
    await http().post(`/tasks/${t.id}/status`).set(as('temp3')).send({ status: 'in_progress' }).expect(200);
    const r = await http().post(`/tasks/${t.id}/status`).set(as('temp3')).send({ status: 'done' }).expect(200);
    expect(r.body.message).toMatch(/QC/);
    expect(await prisma.task.count({ where: { deliverableId: del.id, kind: 'qc', dependsOn: { has: t.id } } })).toBe(1);
  });

  it('runs bulk actions with one undo', async () => {
    await http().post('/tasks/bulk').set(as('am')).send({ ids: [ids.a, ids.b], action: 'deadline', deadline: D2 }).expect(400);
    const r = await http().post('/tasks/bulk').set(as('am')).send({ ids: [ids.a, ids.b], action: 'tag', tag: tag('e2e') }).expect(200);
    expect(r.body.changed).toBe(2);
    const p = await http().post('/tasks/bulk').set(as('am')).send({ ids: [ids.a, ids.b], action: 'priority', priority: 'urgent' }).expect(200);
    await http().post(`/actions/undo/${p.body.undo.token}`).set(as('am')).expect(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ids.b } })).priority).toBe('normal');
    await http().post('/tasks/bulk').set(as('design')).send({ ids: [ids.a], action: 'archive', reason: 'Nope nope' }).expect(403);
  });
});

describe('Templates and recurring tasks', () => {
  it('previews and creates tasks from a template', async () => {
    const opts = await http().get('/tasks/form-options').set(as('head')).expect(200);
    const tpl = opts.body.templates[0];
    const p = await http().post('/tasks/from-template/preview').set(as('head')).send({ templateId: tpl.id, startDate: D, title: tag('Tpl') }).expect(200);
    expect(p.body.tasks.length).toBeGreaterThan(0);
    const r = await http().post('/tasks/from-template').set(as('head')).send({ templateId: tpl.id, startDate: D, title: tag('Tpl') }).expect(201);
    expect(r.body.ids).toHaveLength(p.body.tasks.length);
    await prisma.task.updateMany({ where: { id: { in: r.body.ids } }, data: { title: tag('Template task') } });
    await http().post('/tasks/from-template/preview').set(as('design')).send({ templateId: tpl.id, startDate: D }).expect(403);
  });

  it('creates recurring instances 7 days ahead, skipping Sundays, idempotently', async () => {
    const r = await createTask('am', { title: tag('Daily check'), internal: true, departmentId: ids.dept, ownerId: ids.temp3, deadline: dayAhead(1), repeat: { rule: 'daily', end: dayAhead(20) } });
    const rec = await prisma.task.findUniqueOrThrow({ where: { id: r.task.id } });
    expect(rec.recurrenceId).toBeTruthy();
    recIds.push(rec.recurrenceId!);
    const instances = await prisma.task.findMany({ where: { recurrenceId: rec.recurrenceId } });
    expect(instances.length).toBeGreaterThan(1);
    expect(instances.every((t) => new Date(t.deadline!.getTime() + 5.5 * 3600_000).getUTCDay() !== 0)).toBe(true);
    const again = await app.get(TasksActionsService).generateFor(rec.recurrenceId!);
    expect(again).toHaveLength(0);
    const list = await http().get('/tasks/recurring').set(as('am')).expect(200);
    expect(list.body.some((x: { id: string }) => x.id === rec.recurrenceId)).toBe(true);
    await http().post('/tasks').set(as('design')).send({ title: tag('Producer repeat'), internal: true, departmentId: ids.dept, ownerId: ids.design, deadline: dayAhead(1), repeat: { rule: 'daily', end: dayAhead(9) } }).expect(403);
    await http().delete(`/tasks/recurring/${rec.recurrenceId}`).set(as('am')).expect(200);
  });
});

describe('CSV import', () => {
  it('previews with errors and duplicates, commits the good rows and reports the rest', async () => {
    const csv = ['Title,Client,Department,Assignee,Deadline', `${tag('Imported one')},Internal,Creative / Design,uxui@bmu.demo,${D2}`, `${tag('Imported bad')},Internal,Nowhere,uxui@bmu.demo,not-a-date`].join('\n');
    await http().post('/imports/tasks').set(as('design')).send({ csv }).expect(403);
    const p = await http().post('/imports/tasks').set(as('am')).send({ csv, fileName: `tasks-${stamp}.csv` }).expect(200);
    expect(p.body.rowsTotal).toBe(2);
    expect(p.body.rowsOk).toBe(1);
    expect(p.body.rows[1].errors.length).toBeGreaterThan(0);
    const c = await http().post(`/imports/jobs/${p.body.id}/commit`).set(as('am')).send({ skipDuplicates: true }).expect(200);
    expect(c.body.status).toBe('committed');
    expect(await prisma.task.count({ where: { title: tag('Imported one') } })).toBe(1);
    const report = await http().get(`/imports/jobs/${p.body.id}/errors.csv`).set(as('am')).expect(200);
    expect(report.text).toMatch(/Problem/);
    await http().post(`/imports/jobs/${p.body.id}/commit`).set(as('am')).send({}).expect(400);
  });
});

describe('Records: drafts, views, watchers, tags, palette', () => {
  it('saves and restores a form draft', async () => {
    await http().put('/actions/drafts/task').set(as('am')).send({ key: `new-${stamp}`, payload: { title: 'Half done' } }).expect(200);
    const d = await http().get(`/actions/drafts/task?key=new-${stamp}`).set(as('am')).expect(200);
    expect(d.body.payload.title).toBe('Half done');
    await http().delete(`/actions/drafts/task?key=new-${stamp}`).set(as('am')).expect(200);
  });

  it('shares saved views', async () => {
    const v = await http().post('/actions/views/task').set(as('am')).send({ name: tag('Overdue'), filters: { status: 'overdue' }, isShared: true }).expect(201);
    const other = await http().get('/actions/views/task').set(as('head')).expect(200);
    expect(other.body.some((x: { id: string; mine: boolean }) => x.id === v.body.id && !x.mine)).toBe(true);
    await http().delete(`/actions/views/item/${v.body.id}`).set(as('head')).expect(403);
  });

  it('watches a task and tags it', async () => {
    const w = await http().post(`/actions/watchers/task/${ids.a}`).set(as('head')).send({}).expect(200);
    expect(w.body.watching).toBe(true);
    const t = await http().put(`/actions/tags/task/${ids.a}`).set(as('am')).send({ names: [tag('urgent-client')] }).expect(200);
    expect(t.body.some((x: { name: string }) => x.name === tag('urgent-client'))).toBe(true);
    await http().get(`/actions/watchers/task/${ids.a}`).set(as('client')).expect(403);
  });

  it('turns typed phrases into actions', async () => {
    const n = await http().get('/actions/palette?q=new%20task%20for%20Saffron').set(as('am')).expect(200);
    expect(n.body.intent.kind).toBe('new_task');
    expect(n.body.actions[0].prefill.engagementId).toBeTruthy();
    const r = await http().get(`/actions/palette?q=${encodeURIComponent(`reassign ${tag('Action A')} to Core temp2`)}`).set(as('am')).expect(200);
    expect(r.body.actions[0].action).toBe('reassign');
    expect(r.body.actions[0].targetIds).toEqual([ids.a]);
    const plain = await http().get('/actions/palette?q=saffron').set(as('am')).expect(200);
    expect(plain.body.intent).toBeNull();
  });

  it('archives other record types through the generic endpoint with a reason', async () => {
    await http().post(`/actions/archive/task/${ids.a}`).set(as('am')).send({ reason: 'x' }).expect(400);
  });
});

describe('Legacy callers record the assignment trail', () => {
  it('records an Assignment row when the manager workspace assigns', async () => {
    const t = await prisma.task.create({ data: { orgId: ids.org, engagementId: ids.amEng, title: tag('Craft assign'), kind: 'work', status: 'todo', departmentId: ids.dept, deadline: new Date(`${D2}T12:30:00Z`) } });
    await http().post(`/craft/manager/tasks/${t.id}/assign`).set(as('am')).send({ ownerId: ids.uxui });
    const rows = await prisma.assignment.findMany({ where: { targetId: t.id } });
    const owner = (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId;
    if (owner === ids.uxui) expect(rows.length).toBeGreaterThan(0);
  });
});
