// Plan approved (Gate 2) → department tasks from flow templates, then the Gate 3 check.
// Plain functions over a Prisma client so the seed can use them too.
// v37 manual hand-off: steps get no people automatically (only the Client Manager's client-review step). The Client
// Manager sends each deliverable to its Department Head, who picks the people (deliver/handoff.service.ts). A project's
// later months reuse the same people until the project ends. `autoAssign` keeps the old least-loaded picking for demo
// data and older tests.
import { addWorkingDays, craftFitsStep, flowForType, flowStepSchema, workCalendar, type FlowStep, type WorkCalendar } from '@bmu/shared';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';

type Db = Pick<PrismaClient, 'cycle' | 'flowTemplate' | 'user' | 'task' | 'deliverable' | 'invoice' | 'engagement' | 'organisation' | 'department'>;

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;

export async function holidaysFor(db: Pick<PrismaClient, 'organisation'>, orgId: string): Promise<string[]> {
  const org = await db.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  return ((org.settings ?? {}) as { holidays?: string[] }).holidays ?? [];
}

/** Holidays plus the working hours set in Command Centre → Holidays & Working Hours (for SLA timers). */
export async function calendarFor(db: Pick<PrismaClient, 'organisation'>, orgId: string): Promise<WorkCalendar> {
  const org = await db.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const st = (org.settings ?? {}) as { holidays?: string[]; v8?: { workingHours?: { start: string; end: string; days: number[] } } };
  return workCalendar(st.holidays ?? [], st.v8?.workingHours);
}

/** Least-loaded active user with a role, preferring the given department. */
async function ownerPicker(db: Db, orgId: string, amId: string | null) {
  const load = new Map<string, number>();
  const cache = new Map<string, { id: string; departmentId: string | null; teamId: string | null; specialty: string | null }[]>();
  const am = amId ? await db.user.findUnique({ where: { id: amId }, select: { teamId: true } }) : null;

  return async (role: string, departmentId: string | null, stepKey?: string): Promise<string | null> => {
    if (role === 'am') return amId;
    if (!cache.has(role)) {
      const users = await db.user.findMany({
        where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: role } } } },
        select: { id: true, departmentId: true, teamId: true, specialty: true },
      });
      cache.set(role, users);
      for (const u of users) {
        if (!load.has(u.id)) load.set(u.id, await db.task.count({ where: { ownerId: u.id, status: { in: [...OPEN_TASK] } } }));
      }
    }
    let pool = cache.get(role)!;
    if (pool.length === 0) return null;
    // v10 craft: keep specialists on steps that fit their job (no developer on a design step), when anyone else can take it.
    if (pool.some((u) => craftFitsStep(u.specialty, stepKey))) pool = pool.filter((u) => craftFitsStep(u.specialty, stepKey));
    // Strategists work in the CM's pod when there is one.
    if (role === 'strategist' && am?.teamId && pool.some((u) => u.teamId === am.teamId)) pool = pool.filter((u) => u.teamId === am.teamId);
    else if (departmentId && pool.some((u) => u.departmentId === departmentId)) pool = pool.filter((u) => u.departmentId === departmentId);
    const pick = [...pool].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
    load.set(pick.id, (load.get(pick.id) ?? 0) + 1);
    return pick.id;
  };
}

export async function generateProductionTasks(db: Db, cycleId: string, now = new Date(), opts: { autoAssign?: boolean } = {}) {
  const cycle = await db.cycle.findUniqueOrThrow({
    where: { id: cycleId },
    include: { engagement: true, deliverables: { include: { tasks: { select: { id: true } } } } },
  });
  const orgId = cycle.orgId;
  const holidays = await calendarFor(db, orgId);
  const templates = (await db.flowTemplate.findMany({ where: { orgId, active: true }, orderBy: { version: 'desc' } })).map((t) => ({
    ...t,
    stepsParsed: z.array(flowStepSchema).parse(t.steps) as FlowStep[],
  }));
  // Latest version per key.
  const flows = templates.filter((t, i) => templates.findIndex((x) => x.key === t.key) === i);
  const auto = opts.autoAssign ? await ownerPicker(db, orgId, cycle.engagement.amId) : null;
  // The same team for the whole project: who did each step (by deliverable type) in the project's earlier months.
  const earlier = await db.task.findMany({
    where: { engagementId: cycle.engagementId, ownerId: { not: null }, deliverable: { cycleId: { not: cycleId } }, owner: { status: 'active', deletedAt: null } },
    select: { ownerId: true, flowStep: true, deliverable: { select: { type: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  // Per deliverable type and step: whoever did it most often in this project (the most recent one on a tie).
  const counts = new Map<string, Map<string, number>>();
  for (const t of earlier) {
    const key = `${t.deliverable?.type}|${t.flowStep}`;
    const m = counts.get(key) ?? new Map<string, number>();
    m.set(t.ownerId!, (m.get(t.ownerId!) ?? 0) + 1);
    counts.set(key, m);
  }
  const sameTeam = new Map<string, string>();
  for (const [key, m] of counts) sameTeam.set(key, [...m.entries()].reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0]);
  const pick = async (role: string, departmentId: string | null, stepKey: string, type: string): Promise<string | null> => {
    if (role === 'am') return cycle.engagement.amId;
    if (auto) return auto(role, departmentId, stepKey);
    return sameTeam.get(`${type}|${stepKey}`) ?? null;
  };
  const heads = new Map((await db.department.findMany({ where: { orgId }, select: { id: true, headUserId: true } })).map((d) => [d.id, d.headUserId]));

  let created = 0;
  let unassigned = 0;
  let latestDraft: Date | null = null;
  for (const d of cycle.deliverables) {
    if (d.tasks.length) continue; // already generated
    const flow = flowForType(flows, d.type);
    if (!flow) continue;
    let prev: { id: string; deadline: Date } | null = null;
    let draftDue: Date | null = null;
    let allOwned = true;
    for (const [i, step] of flow.stepsParsed.entries()) {
      const deadline = addWorkingDays(prev?.deadline ?? now, Math.max(step.days, i === 0 ? 1 : 0), holidays);
      const ownerId = await pick(step.role, flow.departmentId, step.key, d.type);
      if (!ownerId) {
        unassigned++;
        allOwned = false;
      }
      const task: { id: string } = await db.task.create({
        data: {
          orgId,
          deliverableId: d.id,
          engagementId: cycle.engagementId,
          title: `${step.name}: ${d.title}`,
          flowStep: step.key,
          kind: step.kind,
          role: step.role,
          sort: i,
          ownerId,
          departmentId: flow.departmentId,
          deadline,
          dependsOn: prev ? [prev.id] : [],
        },
      });
      created++;
      if (step.kind === 'client_review' && !draftDue) draftDue = prev?.deadline ?? deadline;
      prev = { id: task.id, deadline };
    }
    await db.deliverable.update({
      where: { id: d.id },
      data: {
        status: 'in_production',
        flowKey: flow.key,
        departmentId: flow.departmentId,
        dueAt: d.dueAt ?? draftDue ?? prev?.deadline,
        // Every step already has its person (same team as last month, or demo data): nothing to hand off.
        ...(allOwned ? { handoffHeadId: flow.departmentId ? (heads.get(flow.departmentId) ?? null) : null, handoffAt: now, handoffAssignedAt: now, handoffNote: auto ? null : 'Same team as the earlier months of this project' } : {}),
      },
    });
    if (draftDue && (!latestDraft || draftDue > latestDraft)) latestDraft = draftDue;
  }
  if (latestDraft) await db.cycle.update({ where: { id: cycleId }, data: { firstDraftDue: latestDraft } });

  // Gate 3: approved plan + requirements (already true here) + payment condition + every task assigned.
  // Overdue = marked overdue, or still unpaid after its due date.
  const overdue = await db.invoice.count({
    where: { clientOrgId: cycle.engagement.clientOrgId, OR: [{ status: 'overdue' }, { status: { in: ['issued', 'partially_paid'] }, dueDate: { lt: now } }] },
  });
  // Gate rule (Command Centre → Gate Rules): an overdue invoice holds production unless switched off.
  const org = await db.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const rules = ((org.settings ?? {}) as { v8?: { gateRules?: { blockProductionOnOverdueInvoice?: boolean } } }).v8?.gateRules;
  const blockOnOverdue = rules?.blockProductionOnOverdueInvoice ?? true;
  const passed = unassigned === 0 && (!blockOnOverdue || overdue === 0);
  await db.engagement.update({
    where: { id: cycle.engagementId },
    data: passed ? { currentGate: 'G4', status: 'in_production' } : { currentGate: 'G3', status: 'in_production' },
  });
  return { created, unassigned, overdueInvoices: overdue, g3Passed: passed };
}

/**
 * v37: Gate 3 for one project, run whenever people are assigned: production starts once every open step of the latest
 * cycle has a person and no overdue invoice holds it (Command Centre → Gate Rules). Returns true when it moved to G4.
 */
export async function passGate3IfReady(db: Db, engagementId: string, now = new Date()): Promise<boolean> {
  const e = await db.engagement.findUnique({ where: { id: engagementId }, select: { id: true, orgId: true, clientOrgId: true, currentGate: true } });
  if (!e || e.currentGate !== 'G3') return false;
  const latest = await db.cycle.findFirst({ where: { engagementId }, orderBy: { period: 'desc' }, include: { deliverables: { include: { tasks: { select: { ownerId: true, status: true } } } } } });
  if (!latest?.deliverables.length) return false;
  if (latest.deliverables.some((d) => d.tasks.some((t) => !t.ownerId && !['done', 'cancelled'].includes(t.status)))) return false;
  const org = await db.organisation.findUniqueOrThrow({ where: { id: e.orgId }, select: { settings: true } });
  const blockOnOverdue = ((org.settings ?? {}) as { v8?: { gateRules?: { blockProductionOnOverdueInvoice?: boolean } } }).v8?.gateRules?.blockProductionOnOverdueInvoice ?? true;
  if (blockOnOverdue) {
    const overdue = await db.invoice.count({ where: { clientOrgId: e.clientOrgId, OR: [{ status: 'overdue' }, { status: { in: ['issued', 'partially_paid'] }, dueDate: { lt: now } }] } });
    if (overdue) return false;
  }
  await db.engagement.update({ where: { id: engagementId }, data: { currentGate: 'G4' } });
  return true;
}

/**
 * Fills every open step of a project's latest cycle that has no person with the old automatic pick (least-loaded
 * person with the step's role, preferring the department), marks the hand-off done and runs the Gate 3 check. Real
 * projects use the manual hand-off; this stands in for the Department Heads in older journey tests.
 */
export async function fillOpenStepsAutomatically(db: Db, engagementId: string, now = new Date()) {
  const e = await db.engagement.findUniqueOrThrow({ where: { id: engagementId }, select: { orgId: true, amId: true } });
  const latest = await db.cycle.findFirst({ where: { engagementId }, orderBy: { period: 'desc' }, select: { id: true } });
  if (!latest) return 0;
  const pick = await ownerPicker(db, e.orgId, e.amId);
  const open = await db.task.findMany({ where: { deliverable: { cycleId: latest.id }, ownerId: null, status: { notIn: ['done', 'cancelled'] } }, select: { id: true, role: true, departmentId: true, flowStep: true, deliverableId: true } });
  for (const t of open) {
    const ownerId = await pick(t.role ?? 'producer', t.departmentId, t.flowStep ?? undefined);
    if (ownerId) await db.task.update({ where: { id: t.id }, data: { ownerId } });
  }
  await db.deliverable.updateMany({ where: { cycleId: latest.id, handoffAssignedAt: null }, data: { handoffAt: now, handoffAssignedAt: now } });
  await passGate3IfReady(db, engagementId, now);
  return open.length;
}
