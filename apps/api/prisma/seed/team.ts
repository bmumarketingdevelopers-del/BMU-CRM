// v10 team demo data: phone logins, onboarding/offboarding checklists, timesheets with time entries,
// a leave approval chain and a draft SOP. Idempotent: creates only what is missing.
import type { PrismaClient } from '../../src/generated/prisma/client.js';

const DAY = 86_400_000;
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const dbDay = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const addDays = (ymd: string, n: number) => new Date(dbDay(ymd).getTime() + n * DAY).toISOString().slice(0, 10);
const mondayOf = (ymd: string) => addDays(ymd, -((dbDay(ymd).getUTCDay() + 6) % 7));

/** Demo mobile numbers so phone sign-in can be tried for every role (dev shows the code on screen). */
export const TEAM_DEMO_PHONES: Record<string, string> = {
  'founder@bmu.demo': '+919800000001',
  'admin@bmu.demo': '+919800000002',
  'hr@bmu.demo': '+919800000003',
  'design.head@bmu.demo': '+919800000004',
  'am.lead@bmu.demo': '+919800000005',
  'producer@bmu.demo': '+919800000006',
  'finance@bmu.demo': '+919800000007',
  'am@bmu.demo': '+919800000008',
  'creator@bmu.demo': '+919800000009',
  'client@sunrise.demo': '+919800000010',
};

export async function seedTeam(prisma: PrismaClient, orgId: string) {
  // Phones
  for (const [email, phone] of Object.entries(TEAM_DEMO_PHONES)) {
    const u = await prisma.user.findFirst({ where: { orgId, email } });
    if (!u || u.phone) continue;
    if (await prisma.user.findFirst({ where: { orgId, phone } })) continue;
    await prisma.user.update({ where: { id: u.id }, data: { phone } });
  }

  const byEmail = async (email: string) => prisma.user.findFirst({ where: { orgId, email } });
  const hr = await byEmail('hr@bmu.demo');
  const head = await byEmail('design.head@bmu.demo');
  const producer = await byEmail('producer@bmu.demo');
  const am = await byEmail('am@bmu.demo');
  const amLead = await byEmail('am.lead@bmu.demo');
  if (!hr || !head || !producer || !am || !amLead) return;
  const today = istDay(new Date());
  const role = async (base: string) => prisma.role.findFirst({ where: { orgId, baseRole: base, isCustom: false } });

  // Draft SOP (Founder/Admin/heads see it; the team library only shows published ones)
  const design = await prisma.department.findFirst({ where: { orgId, name: { contains: 'Design' }, deletedAt: null } });
  if (design && !(await prisma.sOP.findFirst({ where: { orgId, title: 'Reel editing standards (draft)' } }))) {
    await prisma.sOP.create({
      data: { orgId, departmentId: design.id, title: 'Reel editing standards (draft)', status: 'draft', body: '# Purpose\nOne way of cutting reels across the team.\n\n## Steps\n1. Hook in the first 2 seconds.\n2. Captions burnt in, brand font.\n3. Export 1080x1920, under 60 seconds.' },
    });
  }

  // Onboarding: a new hire with SOPs to read and a buddy
  const producerRole = await role('producer');
  let hire = await prisma.user.findFirst({ where: { orgId, email: 'riya.newhire@bmu.demo' } });
  if (!hire && producerRole) {
    hire = await prisma.user.create({
      data: { orgId, type: 'staff', name: 'Riya Sharma', email: 'riya.newhire@bmu.demo', phone: '+919800000011', status: 'invited', managerId: head.id, departmentId: head.departmentId, branchId: head.branchId, roles: { create: { roleId: producerRole.id } } },
    });
  }
  if (hire && !(await prisma.peopleProcess.findFirst({ where: { userId: hire.id, kind: 'onboarding' } }))) {
    const sops = await prisma.sOP.findMany({ where: { orgId, status: 'published' }, take: 3, orderBy: { title: 'asc' } });
    const now = new Date().toISOString();
    const items = [
      { key: 'offer_letter', label: 'Signed offer letter received', group: 'documents', done: true, doneAt: now, doneBy: hr.name },
      { key: 'id_proof', label: 'ID and address proof (Aadhaar / PAN) collected', group: 'documents', done: true, doneAt: now, doneBy: hr.name },
      { key: 'bank_details', label: 'Bank details for salary collected', group: 'documents', done: false, doneAt: null, doneBy: null },
      { key: 'laptop_issued', label: 'Laptop issued', group: 'equipment', done: true, doneAt: now, doneBy: hr.name },
      { key: 'laptop_setup', label: 'Laptop set up (email, chat, shared drive)', group: 'equipment', done: false, doneAt: null, doneBy: null },
      { key: 'hub_login', label: 'Signed in to BMU Hub for the first time', group: 'accounts', done: false, doneAt: null, doneBy: null, auto: true },
      { key: 'workspace_account', label: 'Email and Google Workspace account created', group: 'accounts', done: true, doneAt: now, doneBy: hr.name },
      { key: 'tool_licences', label: 'Tool licences assigned (Figma, Adobe, Canva…)', group: 'accounts', done: false, doneAt: null, doneBy: null },
      { key: 'buddy_assigned', label: 'Buddy assigned', group: 'buddy', done: true, doneAt: now, doneBy: 'BMU Hub', auto: true },
      { key: 'buddy_checkin', label: 'First-week check-in with buddy', group: 'buddy', done: false, doneAt: null, doneBy: null },
      ...sops.map((s) => ({ key: `sop_${s.id}`, label: `Read: ${s.title}`, group: 'induction', done: false, doneAt: null, doneBy: null, sopId: s.id, sopVersion: s.version, auto: true })),
    ];
    await prisma.peopleProcess.create({ data: { orgId, userId: hire.id, kind: 'onboarding', startedById: hr.id, buddyId: producer.id, startDate: dbDay(addDays(today, -2)), items } });
  }

  // Offboarding: a leaver who still owns a lead and a couple of tasks
  const salesRole = await role('sales_executive');
  let leaver = await prisma.user.findFirst({ where: { orgId, email: 'karan.leaving@bmu.demo' } });
  if (!leaver && salesRole) {
    leaver = await prisma.user.create({
      data: { orgId, type: 'staff', name: 'Karan Mehta', email: 'karan.leaving@bmu.demo', status: 'active', managerId: amLead.id, departmentId: amLead.departmentId, branchId: amLead.branchId, roles: { create: { roleId: salesRole.id } } },
    });
    await prisma.lead.create({ data: { orgId, source: 'referral', contact: { name: 'Deepa Rao', company: 'Indiranagar Yoga Loft (team seed)', email: 'deepa@yogaloft.example' }, need: 'Instagram and Google Business profile', stage: 'discovery', ownerId: leaver.id, score: 45 } });
    await prisma.task.createMany({
      data: [
        { orgId, title: 'Follow up: Yoga Loft discovery notes (team seed)', ownerId: leaver.id, deadline: new Date(Date.now() + 2 * DAY), kind: 'work' },
        { orgId, title: 'Send pricing deck to Yoga Loft (team seed)', ownerId: leaver.id, deadline: new Date(Date.now() + 5 * DAY), kind: 'work' },
      ],
    });
  }
  if (leaver && !(await prisma.peopleProcess.findFirst({ where: { userId: leaver.id, kind: 'offboarding' } }))) {
    const items = [
      ['reassign_tasks', 'Open tasks reassigned', 'handover', true],
      ['reassign_clients', 'Clients moved to another account manager', 'handover', true],
      ['reassign_leads', 'Open leads reassigned', 'handover', true],
      ['handover_notes', 'Handover notes shared with the team', 'handover', false],
      ['laptop_returned', 'Laptop and equipment returned', 'equipment', false],
      ['exit_interview', 'Exit interview done', 'documents', false],
      ['final_settlement', 'Full and final settlement started', 'documents', false],
      ['access_suspended', 'BMU Hub access suspended on the last day', 'access', true],
    ].map(([key, label, group, auto]) => ({ key, label, group, done: false, doneAt: null, doneBy: null, ...(auto ? { auto: true } : {}) }));
    await prisma.peopleProcess.create({ data: { orgId, userId: leaver.id, kind: 'offboarding', startedById: hr.id, lastDay: dbDay(addDays(today, 10)), items, note: 'Moving to another city.' } });
  }

  // Timesheets: six weeks of time entries for the producer and the AM; older weeks approved, last week submitted.
  const thisMonday = mondayOf(today);
  for (const person of [producer, am]) {
    if (await prisma.timeEntry.findFirst({ where: { userId: person.id, note: { contains: '(team seed)' } } })) continue;
    const tasks = await prisma.task.findMany({ where: { orgId, ownerId: person.id }, select: { id: true, engagementId: true, deliverable: { select: { cycle: { select: { engagementId: true } } } } }, take: 8 });
    const entries: { orgId: string; userId: string; date: Date; minutes: number; category: string; source: string; taskId: string | null; engagementId: string | null; note: string }[] = [];
    for (let w = 6; w >= 1; w--) {
      const monday = addDays(thisMonday, -7 * w);
      for (let d = 0; d < 6; d++) {
        const date = addDays(monday, d);
        const t = tasks[(w + d) % Math.max(1, tasks.length)];
        if (t) entries.push({ orgId, userId: person.id, date: dbDay(date), minutes: 240 + ((w * 7 + d * 13) % 5) * 30, category: 'task', source: 'task_log', taskId: t.id, engagementId: t.engagementId ?? t.deliverable?.cycle.engagementId ?? null, note: 'Logged on task (team seed)' });
        entries.push({ orgId, userId: person.id, date: dbDay(date), minutes: d === 0 ? 90 : 45, category: d === 0 ? 'meeting' : 'admin', source: 'manual', taskId: null, engagementId: null, note: d === 0 ? 'Weekly team meeting (team seed)' : 'Email and planning (team seed)' });
      }
      const total = entries.filter((e) => e.date >= dbDay(monday) && e.date < dbDay(addDays(monday, 7))).reduce((s, e) => s + e.minutes, 0);
      const status = w === 1 ? 'submitted' : 'approved';
      const approver = person.id === producer.id ? head.id : amLead.id;
      await prisma.timesheet.upsert({
        where: { userId_weekStart: { userId: person.id, weekStart: dbDay(monday) } },
        update: {},
        create: { orgId, userId: person.id, weekStart: dbDay(monday), status, totalMinutes: total, submittedAt: new Date(dbDay(addDays(monday, 5)).getTime() + 13 * 3600_000), ...(status === 'approved' ? { decidedById: approver, decidedAt: new Date(dbDay(addDays(monday, 7)).getTime() + 5 * 3600_000) } : {}) },
      });
    }
    await prisma.timeEntry.createMany({ data: entries });
  }

  // Leave chain: a long leave waiting for HR, a short one waiting for the manager, an upcoming approved one with tasks due.
  if (!(await prisma.leaveRequest.findFirst({ where: { userId: producer.id, reason: { contains: '(team seed)' } } }))) {
    const start = addDays(today, 20);
    await prisma.leaveRequest.create({
      data: { orgId, userId: producer.id, from: dbDay(start), to: dbDay(addDays(start, 4)), type: 'casual', reason: 'Family wedding in Mysuru (team seed)', stage: 'hr', managerDecidedById: head.id, managerDecidedAt: new Date() },
    });
  }
  if (hire && !(await prisma.leaveRequest.findFirst({ where: { userId: hire.id, reason: { contains: '(team seed)' } } }))) {
    const d = addDays(today, 6);
    await prisma.leaveRequest.create({ data: { orgId, userId: hire.id, from: dbDay(d), to: dbDay(d), type: 'sick', reason: 'Doctor appointment (team seed)', stage: 'manager' } });
  }
  if (!(await prisma.leaveRequest.findFirst({ where: { userId: am.id, reason: { contains: '(team seed)' } } }))) {
    const from = addDays(today, 3);
    await prisma.leaveRequest.create({
      data: { orgId, userId: am.id, from: dbDay(from), to: dbDay(addDays(from, 1)), type: 'casual', reason: 'Short break (team seed)', status: 'approved', stage: 'done', decidedById: amLead.id, decidedAt: new Date(), managerDecidedById: amLead.id, managerDecidedAt: new Date() },
    });
    await prisma.task.create({ data: { orgId, title: 'Client check-in call notes (team seed)', ownerId: am.id, deadline: new Date(`${addDays(from, 1)}T12:00:00+05:30`), kind: 'work' } });
  }
  console.log('Seeded team flows: phones, onboarding/offboarding, timesheets, leave chain.');
}
