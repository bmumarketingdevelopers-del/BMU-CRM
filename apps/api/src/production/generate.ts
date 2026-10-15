// Plan approved (Gate 2) → department tasks from flow templates, then the Gate 3 check.
// Plain functions over a Prisma client so the seed can use them too.
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

export async function generateProductionTasks(db: Db, cycleId: string, now = new Date()) {
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
  const pick = await ownerPicker(db, orgId, cycle.engagement.amId);

  let created = 0;
  let unassigned = 0;
  let latestDraft: Date | null = null;
  for (const d of cycle.deliverables) {
    if (d.tasks.length) continue; // already generated
    const flow = flowForType(flows, d.type);
    if (!flow) continue;
    let prev: { id: string; deadline: Date } | null = null;
    let draftDue: Date | null = null;
    for (const [i, step] of flow.stepsParsed.entries()) {
      const deadline = addWorkingDays(prev?.deadline ?? now, Math.max(step.days, i === 0 ? 1 : 0), holidays);
      const ownerId = await pick(step.role, flow.departmentId, step.key);
      if (!ownerId) unassigned++;
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
      data: { status: 'in_production', flowKey: flow.key, departmentId: flow.departmentId, dueAt: d.dueAt ?? draftDue ?? prev?.deadline },
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
