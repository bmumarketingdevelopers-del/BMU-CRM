// v10 deliver: paid client → final delivery for a one-time project, plus the advanced flows:
// retainer months that roll over, content calendar, multi-approver approvals, delivery SLA escalation, handover pack.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DeliverCyclesService } from '../src/deliver/deliver-cycles.service.js';
import { DeliverSlaService } from '../src/deliver/deliver-sla.service.js';
import { DeliverApprovalsService } from '../src/deliver/deliver-approvals.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let orgId: string;
let clientOrgId: string;
let otherClientToken: string;
let projectId: string;
let retainerId: string;
const createdStaff: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

/** Signs in as whoever owns a task (flows assign by load). */
async function asUser(userId: string) {
  if (!tokens[userId]) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    tokens[userId] = await signIn(u.email!);
  }
  return { Authorization: `Bearer ${tokens[userId]}` };
}

const notes = async (who: string) => ((await http().get('/notifications').set(as(who)).expect(200)).body.items as { title: string; kind: string }[]);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  // Keep one listening server so requests built while another is in flight share it.
  await app.listen(0);
  prisma = app.get(PrismaService);

  const stamp = Date.now();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });
  const service = (key: string) => prisma.service.findFirstOrThrow({ where: { key, priceBook: { orgId, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Deliver Test ${stamp}`, amUserId: am.id, tenureStart: new Date() } });
  clientOrgId = client.id;
  for (const [who, clientRole] of [
    ['owner', 'client_owner'],
    ['approver', 'client_approver'],
    ['viewer', 'client_viewer'],
  ] as const) {
    const u = await prisma.user.create({
      data: { orgId, type: 'client', name: `Deliver ${who}`, email: `deliver.${who}.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role(clientRole)).id } } },
    });
    await prisma.clientUser.create({ data: { userId: u.id, orgId, clientOrgId, clientRole, brandScope: [] } });
    tokens[who] = await signIn(u.email!);
  }
  // A second client account, to prove isolation.
  const other = await prisma.clientOrg.create({ data: { orgId, name: `Deliver Other ${stamp}`, amUserId: am.id } });
  const ou = await prisma.user.create({
    data: { orgId, type: 'client', name: 'Other owner', email: `deliver.other.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role('client_owner')).id } } },
  });
  await prisma.clientUser.create({ data: { userId: ou.id, orgId, clientOrgId: other.id, clientRole: 'client_owner', brandScope: [] } });
  otherClientToken = await signIn(ou.email!);

  const logo = await service('logo_brand_kit');
  const project = await prisma.engagement.create({
    data: {
      orgId,
      clientOrgId,
      serviceId: logo.id,
      tier: 'starter',
      billingType: 'one_time',
      status: 'onboarding',
      currentGate: 'G1',
      amId: am.id,
      startDate: new Date(),
      cycles: {
        create: {
          orgId,
          period: 'project',
          status: 'onboarding',
          requirements: { create: [{ orgId, label: 'Brand guidelines', type: 'asset' }, { orgId, label: 'Instagram access', type: 'access' }] },
        },
      },
    },
  });
  projectId = project.id;

  // A running retainer whose last month was September: the job should start October.
  const smm = await service('smm');
  const retainer = await prisma.engagement.create({
    data: {
      orgId,
      clientOrgId,
      serviceId: smm.id,
      tier: 'growth',
      billingType: 'monthly',
      status: 'active_retainer',
      currentGate: 'G5',
      amId: am.id,
      startDate: new Date(Date.now() - 40 * 86_400_000),
      cycles: {
        create: {
          orgId,
          period: '2026-09',
          rcdAt: new Date(Date.now() - 35 * 86_400_000),
          status: 'production',
          // Only 9 posts and 4 reels planned of the 12 + 4 + 4 quota: 3 posts + 4 stories roll over.
          plans: {
            create: {
              orgId,
              status: 'approved',
              content: { deliverables: [...Array.from({ length: 9 }, (_, i) => ({ type: 'post', title: `Sep post ${i + 1}` })), ...Array.from({ length: 4 }, (_, i) => ({ type: 'reel', title: `Sep reel ${i + 1}` }))] },
            },
          },
        },
      },
    },
  });
  retainerId = retainer.id;

  for (const who of ['am', 'am.lead', 'strategist', 'producer', 'qc', 'design.head', 'founder', 'sales']) tokens[who] = await signIn(`${who}@bmu.demo`);
});

afterAll(async () => {
  // Leave no open work behind: other specs assign tasks by load.
  if (prisma) await prisma.task.updateMany({ where: { engagementId: { in: [projectId, retainerId].filter(Boolean) }, status: { notIn: ['done', 'cancelled'] } }, data: { status: 'cancelled' } });
  if (createdStaff.length) await prisma.user.updateMany({ where: { id: { in: createdStaff } }, data: { deletedAt: new Date() } });
  await app.close();
});

describe('one-time project: onboarding → plan → production → review → final delivery', () => {
  let planId: string;
  const deliverables: Record<string, string> = {};

  it('client sends a file and a note; AM blocks then receives; RCD needs everything received', async () => {
    const onb = (await http().get('/client/onboarding').set(as('owner')).expect(200)).body;
    const items = onb.engagements.find((e: { id: string }) => e.id === projectId).requirements as { id: string; label: string }[];
    const guide = items.find((i) => i.label === 'Brand guidelines')!;
    const access = items.find((i) => i.label === 'Instagram access')!;

    await http().post(`/deliver/client/requirements/${guide.id}/upload`).set(as('owner')).attach('file', pdf, 'guidelines.pdf').field('note', 'Latest guide').expect(200);
    await http().post(`/client/requirements/${access.id}/submit`).set(as('owner')).send({ note: 'Invite sent to the BMU account' }).expect(200);
    // Another client can't upload to this item.
    await http().post(`/deliver/client/requirements/${guide.id}/upload`).set({ Authorization: `Bearer ${otherClientToken}` }).attach('file', pdf, 'x.pdf').expect(404);

    let det = (await http().get(`/engagements/${projectId}`).set(as('am')).expect(200)).body;
    const note = det.cycle.requirements.find((r: { id: string }) => r.id === guide.id).clientNote as string;
    expect(note).toMatch(/\/api\/files\/\w+/);
    // The AM can open the uploaded file and so can the client who uploaded it.
    const fileUrl = note.match(/\/api\/files\/(\w+)/)![0].replace('/api', '');
    await http().get(fileUrl).set(as('am')).expect(200);
    await http().get(fileUrl).set(as('owner')).expect(200);
    await http().get(fileUrl).set({ Authorization: `Bearer ${otherClientToken}` }).expect(404);
    expect((await notes('am')).some((n) => n.kind === 'requirement_sent')).toBe(true);

    await http().patch(`/engagements/requirements/${access.id}`).set(as('am')).send({ status: 'blocked' }).expect(400);
    det = (await http().patch(`/engagements/requirements/${access.id}`).set(as('am')).send({ status: 'blocked', blockedReason: 'Invite not received yet' }).expect(200)).body;
    expect(det.status).toBe('blocked');
    await http().post(`/engagements/${projectId}/rcd`).set(as('am')).expect(400);
    await http().patch(`/engagements/requirements/${guide.id}`).set(as('producer')).send({ status: 'received' }).expect(404);
    for (const r of det.cycle.requirements) await http().patch(`/engagements/requirements/${r.id}`).set(as('am')).send({ status: 'received' }).expect(200);
    det = (await http().post(`/engagements/${projectId}/rcd`).set(as('am')).expect(200)).body;
    expect(det.currentGate).toBe('G2');
    expect(det.cycle.rcdAt).toBeTruthy();
    expect((await notes('owner')).some((n) => n.kind === 'project_started')).toBe(true);
  });

  it('plan: strategist drafts and submits, AM sends, client asks for changes (planning reopens)', async () => {
    const content = {
      objectives: 'Launch identity',
      audience: 'Families in Bengaluru',
      pillars: ['Trust'],
      creativeDirection: 'Clean',
      deliverables: [
        { type: 'post', title: 'Logo concepts' },
        { type: 'reel', title: 'Logo reveal reel' },
      ],
    };
    await http().put(`/engagements/${projectId}/plan`).set(as('strategist')).send(content).expect(200);
    await http().post(`/engagements/${projectId}/plan/submit`).set(as('strategist')).expect(200);
    expect((await notes('am')).some((n) => n.kind === 'plan_review')).toBe(true);
    await http().post(`/engagements/${projectId}/plan/send`).set(as('strategist')).expect(403);
    await http().post(`/engagements/${projectId}/plan/send`).set(as('am')).expect(200);
    expect((await notes('owner')).some((n) => n.kind === 'plan_ready')).toBe(true);

    const plans = (await http().get('/client/plans').set(as('owner')).expect(200)).body;
    planId = plans.find((p: { engagementId: string }) => p.engagementId === projectId).plan.id;
    await http().post(`/client/plans/${planId}/approve`).set(as('viewer')).expect(403);
    await http().post(`/client/plans/${planId}/request-changes`).set(as('approver')).send({ comment: 'Add a business card' }).expect(200);
    const planning = await prisma.task.findFirstOrThrow({ where: { engagementId: projectId, kind: 'planning' } });
    expect(planning.status).toBe('in_progress');
    expect((await notes('strategist')).some((n) => n.kind === 'plan_changes')).toBe(true);

    content.deliverables.push({ type: 'other', title: 'Brand guide PDF' });
    await http().put(`/engagements/${projectId}/plan`).set(as('strategist')).send(content).expect(200);
    await http().post(`/engagements/${projectId}/plan/submit`).set(as('strategist')).expect(200);
    await http().post(`/engagements/${projectId}/plan/send`).set(as('am')).expect(200);
  });

  it('multi-approver: "all approvers" needs both; votes are per round; tasks are generated once approved (G2 → G3)', async () => {
    // Only the owner (or AM) can change the rule.
    await http().put('/deliver/client/approval-settings').set(as('approver')).send({ mode: 'all' }).expect(403);
    const s = (await http().put('/deliver/client/approval-settings').set(as('owner')).send({ mode: 'all' }).expect(200)).body;
    expect(s.mode).toBe('all');
    expect(s.approvers).toHaveLength(2);

    let plans = (await http().post(`/client/plans/${planId}/approve`).set(as('approver')).expect(200)).body;
    let p = plans.find((x: { engagementId: string }) => x.engagementId === projectId);
    expect(p.plan.status).toBe('sent_to_client');
    expect(p.youApproved).toBe(true);
    expect(p.plan.approvalStatus.pending).toEqual(['Deliver owner']);
    await http().post(`/client/plans/${planId}/approve`).set(as('approver')).expect(400);
    // AM reminds the pending owner.
    const r = (await http().post('/deliver/approvals/remind').set(as('am')).send({ target: 'plan', id: planId }).expect(200)).body;
    expect(r.reminded).toEqual(['Deliver owner']);
    expect((await notes('owner')).some((n) => n.kind === 'approval_reminder')).toBe(true);
    await http().post('/deliver/approvals/remind').set(as('producer')).send({ target: 'plan', id: planId }).expect(403);

    plans = (await http().post(`/client/plans/${planId}/approve`).set(as('owner')).expect(200)).body;
    p = plans.find((x: { engagementId: string }) => x.engagementId === projectId);
    expect(p.plan.status).toBe('approved');
    expect(p.plan.approvalStatus.satisfied).toBe(true);
    const det = (await http().get(`/engagements/${projectId}`).set(as('am')).expect(200)).body;
    expect(det.currentGate).toBe('G4');
    for (const d of det.deliverables) deliverables[d.title] = d.id;
    const tasks = await prisma.task.findMany({ where: { deliverableId: { in: Object.values(deliverables) } } });
    expect(tasks.length).toBeGreaterThan(6);
    expect(tasks.every((t) => t.ownerId && t.deadline)).toBe(true);
    expect((await notes('am')).some((n) => n.kind === 'plan_approved')).toBe(true);
    expect(await prisma.approval.count({ where: { targetType: 'plan', targetId: planId, gate: 'G2' } })).toBe(1);
  });

  it('task board: start, block with a reason, log time, done (dependencies enforced)', async () => {
    const tasks = await prisma.task.findMany({ where: { deliverableId: deliverables['Logo concepts'] }, orderBy: { sort: 'asc' } });
    const [brief, design] = tasks;
    await http().patch(`/tasks/${design.id}`).set(await asUser(design.ownerId!)).send({ status: 'in_progress' }).expect(400);
    const owner = await asUser(brief.ownerId!);
    await http().patch(`/tasks/${brief.id}`).set(owner).send({ status: 'in_progress' }).expect(200);
    await http().patch(`/tasks/${brief.id}`).set(owner).send({ status: 'blocked' }).expect(400);
    const blocked = (await http().patch(`/tasks/${brief.id}`).set(owner).send({ status: 'blocked', blockedReason: 'Waiting for reference images' }).expect(200)).body;
    expect(blocked.blockedReason).toBe('Waiting for reference images');
    await http().patch(`/tasks/${brief.id}`).set(owner).send({ status: 'in_progress' }).expect(200);
    const logged = (await http().patch(`/tasks/${brief.id}`).set(owner).send({ logMinutes: 90 }).expect(200)).body;
    expect(logged.timeLoggedMin).toBe(90);
    await http().patch(`/tasks/${brief.id}`).set(owner).send({ status: 'done' }).expect(200);
    await http().patch(`/tasks/${design.id}`).set(await asUser(design.ownerId!)).send({ status: 'in_progress' }).expect(200);
  });

  it('versions → QC (uploader cannot QC own work) → send only after a pass → client approvals under the rule', async () => {
    for (const [title, file, name] of [
      ['Logo concepts', png, 'logo.png'],
      ['Logo reveal reel', png, 'reveal.png'],
      ['Brand guide PDF', pdf, 'guide.pdf'],
    ] as const) {
      const id = deliverables[title];
      const tasks = await prisma.task.findMany({ where: { deliverableId: id }, orderBy: { sort: 'asc' } });
      const maker = tasks.filter((t) => t.kind === 'work').at(-1)!;
      const qcOwner = tasks.find((t) => t.kind === 'qc')!;
      let d = (await http().post(`/deliverables/${id}/versions`).set(await asUser(maker.ownerId!)).attach('file', file, name).field('note', 'First draft').expect(201)).body;
      const v = d.versions.at(-1);
      expect(d.status).toBe('in_qc');
      if (maker.ownerId !== qcOwner.ownerId) {
        await http().post(`/deliverables/versions/${v.id}/qc`).set(await asUser(maker.ownerId!)).send({ items: d.qcChecklist.map((l: string) => ({ label: l, ok: true })) }).expect(403);
      }
      await http().post(`/deliverables/versions/${v.id}/send`).set(as('am')).expect(400);
      d = (await http().post(`/deliverables/versions/${v.id}/qc`).set(as('qc')).send({ items: d.qcChecklist.map((l: string) => ({ label: l, ok: true })) }).expect(200)).body;
      expect(d.status).toBe('qc_passed');
      d = (await http().post(`/deliverables/versions/${v.id}/send`).set(as('am')).expect(200)).body;
      expect(d.status).toBe('ready_for_client');
    }

    // Image: pinned comment, then changes (revision round); second version, QC fail, fix, pass, send.
    const logo = deliverables['Logo concepts'];
    let rd = (await http().get(`/client/reviews/${logo}`).set(as('owner')).expect(200)).body;
    rd = (await http().post(`/client/reviews/${logo}/comments`).set(as('owner')).send({ versionId: rd.versions[0].id, body: 'Bigger logo', anchor: { x: 40, y: 30 } }).expect(201)).body;
    expect(rd.comments[0].anchor).toEqual({ x: 40, y: 30 });
    rd = (await http().post(`/client/reviews/${logo}/request-changes`).set(as('owner')).send({}).expect(200)).body;
    expect(rd.status).toBe('changes_requested');
    expect(rd.revisionRounds.used).toBe(1);
    const maker = (await prisma.task.findMany({ where: { deliverableId: logo, kind: 'work' }, orderBy: { sort: 'asc' } })).at(-1)!;
    let d = (await http().post(`/deliverables/${logo}/versions`).set(await asUser(maker.ownerId!)).attach('file', png, 'logo-v2.png').expect(201)).body;
    d = (await http().post(`/deliverables/versions/${d.versions.at(-1).id}/qc`).set(as('qc')).send({ items: d.qcChecklist.map((l: string, i: number) => ({ label: l, ok: i > 0 })), note: 'Wrong colour' }).expect(200)).body;
    expect(d.status).toBe('qc_failed');
    await http().post(`/deliverables/versions/${d.versions.at(-1).id}/send`).set(as('am')).expect(400);
    d = (await http().post(`/deliverables/${logo}/versions/link`).set(await asUser(maker.ownerId!)).send({ url: 'https://www.figma.com/file/logo-v3', note: 'Colour fixed' }).expect(201)).body;
    d = (await http().post(`/deliverables/versions/${d.versions.at(-1).id}/qc`).set(as('qc')).send({ items: d.qcChecklist.map((l: string) => ({ label: l, ok: true })) }).expect(200)).body;
    d = (await http().post(`/deliverables/versions/${d.versions.at(-1).id}/send`).set(as('am')).expect(200)).body;

    // Video-style time comment on the reel, approve by the approver only → still pending (rule "all").
    const reel = deliverables['Logo reveal reel'];
    rd = (await http().get(`/client/reviews/${reel}`).set(as('approver')).expect(200)).body;
    await http().post(`/client/reviews/${reel}/comments`).set(as('approver')).send({ versionId: rd.versions[0].id, body: 'Logo too early', anchor: { t: 1.5 } }).expect(201);
    rd = (await http().post(`/client/reviews/${reel}/approve`).set(as('approver')).send({ versionId: rd.versions[0].id }).expect(200)).body;
    expect(rd.status).toBe('ready_for_client');
    expect(rd.can.approve).toBe(false);
    expect(rd.approvalStatus.pending).toEqual(['Deliver owner']);
    const list = (await http().get('/client/reviews').set(as('approver')).expect(200)).body;
    expect(list.find((x: { id: string }) => x.id === reel).waitingOnYou).toBe(false);
    const team = (await http().get(`/deliverables/${reel}`).set(as('am')).expect(200)).body;
    expect(team.approvalStatus.summary).toContain('Approved by Deliver approver');
    expect((await notes('am')).some((n) => n.kind === 'approval_partial')).toBe(true);

    // Switch to "owner must approve": approver approval alone not enough; owner completes.
    await http().put(`/deliver/clients/${clientOrgId}/approval-mode`).set(as('producer')).send({ mode: 'owner' }).expect(404);
    await http().put(`/deliver/clients/${clientOrgId}/approval-mode`).set(as('strategist')).send({ mode: 'owner' }).expect(403);
    await http().put(`/deliver/clients/${clientOrgId}/approval-mode`).set(as('am')).send({ mode: 'owner' }).expect(200);
    rd = (await http().post(`/client/reviews/${reel}/approve`).set(as('owner')).send({ versionId: rd.versions[0].id }).expect(200)).body;
    expect(rd.status).toBe('approved');

    // Older versions can't be approved; latest can.
    rd = (await http().get(`/client/reviews/${logo}`).set(as('owner')).expect(200)).body;
    // v2 failed QC and never reached the client; v3 is the fixed link.
    expect(rd.versions.map((v: { number: number }) => v.number)).toEqual([1, 3]);
    await http().post(`/client/reviews/${logo}/approve`).set(as('owner')).send({ versionId: rd.versions[0].id }).expect(400);
    await http().post(`/client/reviews/${logo}/approve`).set(as('owner')).send({ versionId: rd.versions.at(-1).id }).expect(200);

    // Back to "any one approver" for the PDF.
    await http().put('/deliver/client/approval-settings').set(as('owner')).send({ mode: 'any' }).expect(200);
    const guide = deliverables['Brand guide PDF'];
    rd = (await http().get(`/client/reviews/${guide}`).set(as('approver')).expect(200)).body;
    rd = (await http().post(`/client/reviews/${guide}/approve`).set(as('approver')).send({ versionId: rd.versions[0].id }).expect(200)).body;
    expect(rd.status).toBe('approved');
  });

  it('G4 → balance invoice → sign-off + pay → G5; handover pack, zip download and feedback feed Client Health', async () => {
    let det = (await http().get(`/engagements/${projectId}`).set(as('am')).expect(200)).body;
    expect(det.status).toBe('awaiting_final_payment');
    expect(det.currentGate).toBe('G5');
    const delivery = (await http().get('/client/delivery').set(as('owner')).expect(200)).body.find((x: { engagementId: string }) => x.engagementId === projectId);
    expect(delivery.balanceInvoice.status).toBe('issued');

    // AM adds a login before release: client can't see it yet, nor download.
    let hv = (await http().post(`/deliver/engagements/${projectId}/handover/items`).set(as('am')).send({ kind: 'credential', label: 'Brand Drive', value: 'drive@client.in / s3cret' }).expect(201)).body;
    expect(hv.items).toHaveLength(1);
    await http().post(`/deliver/engagements/${projectId}/handover/items`).set(as('producer')).send({ kind: 'note', label: 'Fonts', value: 'y' }).expect(404);
    await http().post(`/deliver/engagements/${projectId}/handover/items`).set(as('am')).send({ kind: 'link', label: 'Figma', value: 'not-a-link' }).expect(400);
    let ch = (await http().get(`/deliver/engagements/${projectId}/handover`).set(as('owner')).expect(200)).body;
    expect(ch.released).toBe(false);
    expect(ch.items).toHaveLength(0);
    expect(ch.zipUrl).toBeNull();
    await http().get(`/deliver/engagements/${projectId}/handover.zip`).set(as('owner')).expect(403);
    await http().get(`/deliver/engagements/${projectId}/handover`).set({ Authorization: `Bearer ${otherClientToken}` }).expect(404);
    await http().post(`/deliver/engagements/${projectId}/feedback`).set(as('owner')).send({ score: 9 }).expect(403);

    await http().post(`/client/engagements/${projectId}/sign-off`).set(as('owner')).expect(200);
    await http().post(`/client/invoices/${delivery.balanceInvoice.id}/pay-test`).set(as('owner')).expect(200);
    det = (await http().get(`/engagements/${projectId}`).set(as('am')).expect(200)).body;
    expect(det.status).toBe('delivered');

    ch = (await http().get(`/deliver/engagements/${projectId}/handover`).set(as('owner')).expect(200)).body;
    expect(ch.released).toBe(true);
    expect(ch.files.map((f: { deliverable: string }) => f.deliverable).sort()).toEqual(['Brand guide PDF', 'Logo reveal reel']);
    expect(ch.links).toEqual([{ label: 'Logo concepts', url: 'https://www.figma.com/file/logo-v3', source: 'deliverable' }]);
    expect(ch.items[0].value).toBe('drive@client.in / s3cret');
    const zip = await http()
      .get(`/deliver/engagements/${projectId}/handover.zip`)
      .set(as('owner'))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const buf = zip.body as Buffer;
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(3); // two files + links/logins text
    expect(buf.includes(Buffer.from('Brand guide PDF v1.pdf'))).toBe(true);
    expect(buf.includes(Buffer.from('drive@client.in / s3cret'))).toBe(true);

    // Feedback (NPS): a detractor score turns the client red and alerts the AM.
    await http().post(`/deliver/engagements/${projectId}/feedback`).set(as('viewer')).send({ score: 9 }).expect(403);
    await http().post(`/deliver/engagements/${projectId}/feedback`).set(as('owner')).send({ score: 11 }).expect(400);
    hv = (await http().post(`/deliver/engagements/${projectId}/feedback`).set(as('owner')).send({ score: 4, comment: 'Too slow' }).expect(200)).body;
    expect(hv.feedback.mine.score).toBe(4);
    expect((await prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } })).health).toBe('red');
    expect((await notes('am')).some((n) => n.kind === 'client_feedback')).toBe(true);
    const team = (await http().get(`/deliver/engagements/${projectId}/handover`).set(as('am')).expect(200)).body;
    expect(team.feedback.all[0]).toMatchObject({ score: 4, comment: 'Too slow' });
    const health = (await http().get('/insights/client-health').set(as('founder')).expect(200)).body.find((c: { id: string }) => c.id === clientOrgId);
    expect(health.reasons.join(' ')).toContain('rated');
  });
});

describe('monthly retainer cycles that roll over', () => {
  it('the job starts this month once with the quota, carried-over items, a draft plan and the retainer invoice', async () => {
    const cycles = app.get(DeliverCyclesService);
    const run = await cycles.runAuto(new Date(), [retainerId]);
    expect(run.created).toHaveLength(1);
    expect((await cycles.runAuto(new Date(), [retainerId])).created).toHaveLength(0);

    const v = (await http().get(`/deliver/engagements/${retainerId}/cycles`).set(as('am')).expect(200)).body;
    const oct = v.cycles[0];
    expect(oct.period).toBe('2026-10');
    expect(oct.startedBy).toBe('auto');
    expect(oct.carriedOver).toEqual(expect.arrayContaining([{ type: 'post', count: 3, fromPeriod: '2026-09' }, { type: 'story', count: 4, fromPeriod: '2026-09' }]));
    expect(oct.quota.find((q: { type: string }) => q.type === 'post')).toMatchObject({ count: 15, planned: 15 });
    expect(oct.invoice.status).toBe('issued');
    expect(oct.planStatus).toBe('draft');
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: oct.invoice.id } });
    expect(inv.kind).toBe('retainer');
    expect(inv.engagementId).toBe(retainerId);
    const det = (await http().get(`/engagements/${retainerId}`).set(as('am')).expect(200)).body;
    expect(det.currentGate).toBe('G2');
    expect(det.can.editPlan).toBe(true);
    expect(det.plan.content.deliverables.length).toBe(15 + 4 + 8);
  });

  it('AM starts next month manually (once); others cannot; the month after is blocked until then', async () => {
    await http().post(`/deliver/engagements/${retainerId}/cycles/next`).set(as('strategist')).expect(403);
    const v = (await http().post(`/deliver/engagements/${retainerId}/cycles/next`).set(as('am')).expect(200)).body;
    expect(v.cycles[0].period).toBe('2026-11');
    expect(v.cycles[0].startedBy).toBe('manual');
    expect(v.can.startNext).toBe(false);
    expect(v.startNextBlocked).toContain('November 2026');
    await http().post(`/deliver/engagements/${retainerId}/cycles/next`).set(as('am')).expect(400);
    expect(await prisma.cycle.count({ where: { engagementId: retainerId, period: '2026-11' } })).toBe(1);
    // A one-time project has no months.
    const p = (await http().get(`/deliver/engagements/${projectId}/cycles`).set(as('am')).expect(200)).body;
    expect(p.isRetainer).toBe(false);
  });

  it('an overdue invoice holds production (gate rule) and paying it releases Gate 3', async () => {
    const v = (await http().get(`/deliver/engagements/${retainerId}/cycles`).set(as('am')).expect(200)).body;
    const oct = v.cycles.find((c: { period: string }) => c.period === '2026-10');
    await prisma.invoice.update({ where: { id: oct.invoice.id }, data: { dueDate: new Date(Date.now() - 3 * 86_400_000) } });
    const held = (await http().get(`/deliver/engagements/${retainerId}/cycles`).set(as('am')).expect(200)).body;
    expect(held.cycles[0].heldForPayment).toContain(oct.invoice.number);

    // November plan → client approves → tasks created but Gate 3 waits.
    const nov = held.cycles[0];
    const plan = await prisma.plan.findFirstOrThrow({ where: { cycleId: nov.id } });
    const short = { objectives: 'November', audience: '', pillars: [], creativeDirection: '', deliverables: [{ type: 'post', title: 'Nov post 1' }] };
    await http().put(`/engagements/${retainerId}/plan`).set(as('strategist')).send(short).expect(200);
    await http().post(`/engagements/${retainerId}/plan/submit`).set(as('strategist')).expect(200);
    await http().post(`/engagements/${retainerId}/plan/send`).set(as('am')).expect(200);
    await http().post(`/client/plans/${plan.id}/approve`).set(as('owner')).expect(200);
    let det = (await http().get(`/engagements/${retainerId}`).set(as('am')).expect(200)).body;
    expect(det.currentGate).toBe('G3');

    // Pay every open invoice of this client: production goes ahead.
    const open = await prisma.invoice.findMany({ where: { clientOrgId, status: { in: ['issued', 'partially_paid'] } } });
    for (const i of open) await http().post(`/client/invoices/${i.id}/pay-test`).set(as('owner')).expect(200);
    det = (await http().get(`/engagements/${retainerId}`).set(as('am')).expect(200)).body;
    expect(det.currentGate).toBe('G4');
  });
});

describe('content calendar', () => {
  let postId: string;
  it('only approved social work can be scheduled; scheduled → published with a live link; client sees it', async () => {
    const cycle = await prisma.cycle.findFirstOrThrow({ where: { engagementId: retainerId, period: '2026-10' } });
    const post = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'post', title: 'Diwali post', status: 'in_production' } });
    postId = post.id;
    const at = '2026-10-20T11:00:00+05:30';
    await http().patch(`/deliver/deliverables/${postId}/schedule`).set(as('am')).send({ scheduledAt: at, channel: 'instagram' }).expect(400);
    // v16: publishing needs an approved version on record, not just the status.
    const file = await prisma.file.create({ data: { orgId, path: 'https://example.com/diwali.png', kind: 'link', name: 'diwali.png' } });
    const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
    const version = await prisma.version.create({ data: { orgId, deliverableId: postId, fileId: file.id, number: 1, uploadedById: am.id, sentToClientAt: new Date() } });
    await prisma.deliverable.update({ where: { id: postId }, data: { status: 'approved', approvedVersionId: version.id } });
    const cal = (await http().get('/deliver/calendar?from=2026-10-01T00:00:00%2B05:30&to=2026-11-01T00:00:00%2B05:30').set(as('am')).expect(200)).body;
    expect(cal.unscheduled.some((i: { deliverableId: string }) => i.deliverableId === postId)).toBe(true);
    await http().patch(`/deliver/deliverables/${postId}/schedule`).set(as('producer')).send({ scheduledAt: at, channel: 'instagram' }).expect(403);
    await http().post(`/deliver/deliverables/${postId}/publish`).set(as('am')).send({ liveUrl: 'https://instagram.com/p/x' }).expect(400);
    let item = (await http().patch(`/deliver/deliverables/${postId}/schedule`).set(as('am')).send({ scheduledAt: at, channel: 'instagram' }).expect(200)).body;
    expect(item.status).toBe('scheduled');
    // Drag to another day = reschedule.
    item = (await http().patch(`/deliver/deliverables/${postId}/schedule`).set(as('strategist')).send({ scheduledAt: '2026-10-22T18:00:00+05:30', channel: 'facebook' }).expect(200)).body;
    expect(item.channel).toBe('facebook');
    let client = (await http().get('/deliver/client/calendar?from=2026-10-01T00:00:00%2B05:30&to=2026-11-01T00:00:00%2B05:30').set(as('owner')).expect(200)).body;
    expect(client.items.find((i: { deliverableId: string }) => i.deliverableId === postId).scheduledAt).toBe(new Date('2026-10-22T18:00:00+05:30').toISOString());
    expect(client.canSchedule).toBe(false);
    await http().post(`/deliver/deliverables/${postId}/publish`).set(as('am')).send({ liveUrl: 'nope' }).expect(400);
    item = (await http().post(`/deliver/deliverables/${postId}/publish`).set(as('am')).send({ liveUrl: 'https://instagram.com/p/diwali' }).expect(200)).body;
    expect(item.status).toBe('published');
    client = (await http().get('/deliver/client/calendar?from=2026-10-01T00:00:00%2B05:30&to=2026-11-01T00:00:00%2B05:30').set(as('owner')).expect(200)).body;
    expect(client.items.find((i: { deliverableId: string }) => i.deliverableId === postId).liveUrl).toBe('https://instagram.com/p/diwali');
    expect((await notes('owner')).some((n) => n.kind === 'post_published')).toBe(true);
    await http().get('/deliver/client/calendar').set({ Authorization: `Bearer ${otherClientToken}` }).expect(200).expect((r) => expect(r.body.items.some((i: { deliverableId: string }) => i.deliverableId === postId)).toBe(false));
  });
});

describe('delivery SLA and escalation', () => {
  it('flags overdue steps, escalates once to the department head after 1 working day, and shows on My Day', async () => {
    const cycle = await prisma.cycle.findFirstOrThrow({ where: { engagementId: retainerId, period: '2026-11' } });
    const dept = await prisma.department.findFirstOrThrow({ where: { orgId, name: 'Creative / Design' } });
    const producer = await prisma.user.findFirstOrThrow({ where: { email: 'producer@bmu.demo' } });
    const d = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'post', title: 'Late carousel', status: 'in_production', dueAt: new Date(Date.now() - 2 * 86_400_000), departmentId: dept.id } });
    const late = await prisma.task.create({
      data: { orgId, deliverableId: d.id, engagementId: retainerId, title: 'Design: Late carousel', kind: 'work', ownerId: producer.id, departmentId: dept.id, deadline: new Date(Date.now() - 5 * 86_400_000) },
    });
    const sla = app.get(DeliverSlaService);
    expect((await sla.escalate(new Date(), [late.id])).escalated).toBe(1);
    expect((await sla.escalate(new Date(), [late.id])).escalated).toBe(0);
    expect((await notes('design.head')).some((n) => n.kind === 'sla_escalation' && n.title.includes('Late carousel'))).toBe(true);
    expect((await notes('producer')).some((n) => n.kind === 'sla_escalated')).toBe(true);

    const view = (await http().get('/deliver/sla').set(as('am')).expect(200)).body;
    const item = view.items.find((i: { taskId: string }) => i.taskId === late.id);
    expect(item).toMatchObject({ state: 'overdue', escalated: true });
    expect(item.workingDaysLate).toBeGreaterThanOrEqual(2);
    expect(view.items.some((i: { deliverableId: string; kind: string }) => i.kind === 'deliverable' && i.deliverableId === d.id)).toBe(true);
    const day = (await http().get('/my-day').set(as('producer')).expect(200)).body;
    expect(day.deliverSla.some((i: { taskId: string }) => i.taskId === late.id)).toBe(true);
    const rows = (await http().get('/engagements').set(as('am')).expect(200)).body;
    expect(rows.find((r: { id: string }) => r.id === retainerId).slaOverdue).toBeGreaterThanOrEqual(1);
    await http().get('/deliver/sla').set(as('owner')).expect(403);
    await http().post('/deliver/sla/run').set(as('am')).expect(403);
  });

  it('auto-reminds pending approvers once a round is more than a working day old', async () => {
    const cycle = await prisma.cycle.findFirstOrThrow({ where: { engagementId: retainerId, period: '2026-10' } });
    const d = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'post', title: 'Waiting post', status: 'ready_for_client' } });
    const file = await prisma.file.create({ data: { orgId, clientOrgId, path: 'x.png', kind: 'image', name: 'x.png' } });
    const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
    await prisma.version.create({ data: { orgId, deliverableId: d.id, fileId: file.id, number: 1, uploadedById: am.id, sentToClientAt: new Date(Date.now() - 5 * 86_400_000), sentById: am.id } });
    const approvals = app.get(DeliverApprovalsService);
    const first = await approvals.autoRemind();
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect((await notes('approver')).some((n) => n.kind === 'approval_reminder' && n.title.includes('Waiting post'))).toBe(true);
    const again = await prisma.auditEvent.count({ where: { entityId: d.id, action: 'approval.auto_reminded' } });
    await approvals.autoRemind();
    expect(await prisma.auditEvent.count({ where: { entityId: d.id, action: 'approval.auto_reminded' } })).toBe(again);
  });
});
