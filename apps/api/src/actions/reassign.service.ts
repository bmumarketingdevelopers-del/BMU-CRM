// v11 core: the reassignment engine (spec reassignment_engine). One flow for every registered record type:
// candidates (eligible people with load %, leave, active tasks, skills) → impact preview → apply with deadline
// handling, reason, handover note, Assignment row, audit, notifications and undo. Approved leave on the deadline date
// is blocked unless a Department Head/Admin overrides; above 120% capacity needs Department Head approval.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  CORE_REASSIGN_REASONS,
  coreReassignApplySchema,
  coreReassignReasonLabels,
  istDate,
  type CoreBulkReassign,
  type CoreCandidate,
  type CoreCandidates,
  type CoreImpactLine,
  type CoreOpenWork,
  type CoreReassignApply,
  type CoreReassignPreview,
  type CoreReassignPreviewInput,
  type CoreReassignResult,
  type Me,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { ApprovalsService } from './approvals.service.js';
import { DAY_MS, hasRole, isLeader, parseDue, PeopleDirectory, type PersonLoad } from './people.js';
import { ActionsRegistry, type ReassignItem, type ReassignTarget, type UndoRow } from './registry.js';
import { UndoService } from './undo.service.js';

const READ_ACCESS_DAYS = 7;
const fmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const short = (d: Date | null | undefined) => (d ? fmt.format(d) : 'no deadline');

type Evaluated = {
  target: ReassignTarget;
  items: ReassignItem[];
  to: PersonLoad;
  deadlines: Map<string, Date | null | undefined>;
  preview: CoreReassignPreview;
  /** The approver when the change needs approval. */
  approverId: string | null;
};

type RunOpts = { approved?: boolean; approvalId?: string; bulkLabel?: string; skipUndo?: boolean; skipNotify?: boolean };

@Injectable()
export class ReassignService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
    private readonly people: PeopleDirectory,
    private readonly approvals: ApprovalsService,
    private readonly undo: UndoService,
  ) {}

  onModuleInit() {
    // One approval handler serves every target type: the stored input is re-applied as the requester.
    this.registry.registerApprovalHandler({
      action: 'reassign.approval',
      label: 'Reassignment needs approval',
      href: (r) => (r.targetType === 'task' ? `/team/tasks/${r.targetId}` : null),
      apply: async ({ approver, requester, req }) => {
        const p = req.payload as { type: string; input: CoreReassignApply };
        const { undoRows: _rows, ...result } = await this.run(requester ?? approver, p.type, p.input, { approved: true, approvalId: req.id });
        return result;
      },
    });
  }

  target(type: string): ReassignTarget {
    const t = this.registry.reassignTargets.get(type);
    if (!t) throw new NotFoundException(`Unknown record type "${type}"`);
    return t;
  }

  types() {
    return [...this.registry.reassignTargets.values()].map((t) => ({ type: t.type, label: t.label }));
  }

  // -------------------------------------------------------------------------
  // Candidates

  private async pool(me: Me, target: ReassignTarget, items: ReassignItem[], ctx: { departmentId?: string | null; role?: string }) {
    const elig = await target.eligibility(me, items, ctx);
    const loads = await this.people.loads(me.orgId, elig.where ?? {}, new Date(), elig.userTypes);
    return { elig, loads };
  }

  private candidateRows(loads: PersonLoad[], items: ReassignItem[], elig: { departmentId?: string | null; specialty?: string | null; blocked?: (u: { id: string; name: string; roles: string[] }) => string | null }, extraHours?: number): CoreCandidate[] {
    const hours = extraHours ?? items.reduce((s, i) => s + i.hours, 0);
    const owners = new Set(items.map((i) => i.ownerId).filter(Boolean));
    const dueDays = items.map((i) => PeopleDirectory.day(i.deadline)).filter((d): d is string => !!d);
    const rows = loads.map((p) => {
      const leaveHit = dueDays.find((d) => p.leaveDays.has(d)) ?? null;
      const blockedReason = elig.blocked?.(p) ?? null;
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        department: p.department,
        specialty: p.specialty,
        skills: p.skills,
        loadPct: p.loadPct,
        loadAfterPct: PeopleDirectory.after(p, owners.has(p.id) ? 0 : hours),
        openTasks: p.openTasks,
        hoursOpen: p.hoursOpen,
        capacityHours: p.capacityHours,
        onLeave: !!leaveHit,
        leaveNote: leaveHit ? `On leave ${fmt.format(new Date(`${leaveHit}T12:00:00+05:30`))}` : p.onLeaveToday ? 'On leave today' : null,
        onLeaveToday: p.onLeaveToday,
        suggested: false,
        current: owners.size === 1 && owners.has(p.id),
        blockedReason,
        _fit: (elig.specialty && p.specialty === elig.specialty ? 0 : 1) + (elig.departmentId && p.departmentId === elig.departmentId ? 0 : 1),
      };
    });
    rows.sort((a, b) => Number(!!a.blockedReason) - Number(!!b.blockedReason) || Number(a.onLeave) - Number(b.onLeave) || a._fit - b._fit || a.loadPct - b.loadPct || a.name.localeCompare(b.name));
    const best = rows.find((r) => !r.blockedReason && !r.onLeave && !r.current && r.loadAfterPct <= 100);
    if (best) best.suggested = true;
    return rows.map(({ _fit: _f, ...r }) => r);
  }

  async candidates(me: Me, type: string, ids: string[], ctx: { departmentId?: string; deadline?: string; estimateHours?: string; role?: string }): Promise<CoreCandidates> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const target = this.target(type);
    const items = ids.length ? await target.load(me, ids, ctx.role) : [];
    if (items.length) await target.assertCanReassign(me, items, ctx.role);
    const { elig, loads } = await this.pool(me, target, items, { departmentId: ctx.departmentId ?? null, role: ctx.role });
    // A new record: pretend one item with the given deadline and estimate.
    const virtual: ReassignItem[] = items.length ? items : [{ id: 'new', title: 'New', ownerId: null, deadline: ctx.deadline ? parseDue(ctx.deadline) : null, status: null, inProgress: false, hours: Number(ctx.estimateHours) || 4 }];
    const departmentHead = elig.departmentId ? await this.people.isHeadOf(me, elig.departmentId) : hasRole(me, 'founder', 'admin');
    return {
      type,
      label: target.label,
      items: items.map((i) => ({ id: i.id, title: i.title, ownerId: i.ownerId, ownerName: loads.find((l) => l.id === i.ownerId)?.name ?? null, deadline: i.deadline?.toISOString() ?? null, status: i.status, inProgress: i.inProgress })),
      candidates: this.candidateRows(loads, virtual, elig),
      roles: target.roles ?? [],
      canOverrideLeave: departmentHead,
      reasons: CORE_REASSIGN_REASONS.map((key) => ({ key, label: coreReassignReasonLabels[key] })),
    };
  }

  // -------------------------------------------------------------------------
  // Preview + rules

  private async newDeadlines(orgId: string, items: ReassignItem[], d: CoreReassignApply['deadline']) {
    const map = new Map<string, Date | null | undefined>();
    const handling = d ?? { mode: 'keep' as const };
    if (handling.mode === 'keep') return map;
    const cal = await calendarFor(this.prisma, orgId);
    for (const i of items) {
      if (handling.mode === 'extend') {
        const base = i.deadline && i.deadline > new Date(Date.now() - 365 * DAY_MS) ? i.deadline : new Date();
        const next = addWorkingDays(base, handling.days, cal);
        map.set(i.id, new Date(`${istDate(next)}T18:00:00+05:30`));
      } else {
        const due = parseDue(handling.date);
        if (Number.isNaN(due.getTime())) throw new BadRequestException('Pick a valid new deadline');
        map.set(i.id, due);
      }
    }
    return map;
  }

  private async evaluate(me: Me, type: string, raw: CoreReassignPreviewInput & { overrideLeave?: boolean; handoverNote?: string }, opts: RunOpts = {}): Promise<Evaluated> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const target = this.target(type);
    const ids = [...new Set(raw.ids)];
    const items = await target.load(me, ids, raw.role);
    if (!items.length) throw new NotFoundException('Nothing to reassign');
    await target.assertCanReassign(me, items, raw.role);
    const { elig, loads } = await this.pool(me, target, items, { role: raw.role });
    const to = loads.find((p) => p.id === raw.toUserId);
    if (!to) {
      const exists = await this.prisma.user.findFirst({ where: { id: raw.toUserId, orgId: me.orgId }, select: { name: true, status: true } });
      if (!exists) throw new BadRequestException('Pick an active team member');
      throw new BadRequestException(exists.status !== 'active' ? `${exists.name} is not active` : `${exists.name} can't take this kind of work`);
    }
    const blockedFor = elig.blocked?.(to);
    const deadlines = await this.newDeadlines(me.orgId, items, raw.deadline as CoreReassignApply['deadline']);
    const moving = items.filter((i) => i.ownerId !== to.id);
    const hours = moving.reduce((s, i) => s + i.hours, 0);
    const loadAfter = PeopleDirectory.after(to, hours);
    const finalDue = (i: ReassignItem) => (deadlines.has(i.id) ? deadlines.get(i.id)! : i.deadline);
    const leaveDates = items.map((i) => PeopleDirectory.day(finalDue(i))).filter((d): d is string => !!d && to.leaveDays.has(d));
    const onLeave = leaveDates.length > 0;

    // Dependents (open records waiting on these) for the impact list.
    const impact: CoreImpactLine[] = [];
    let blocked: string | null = null;
    let needsApproval: CoreReassignPreview['needsApproval'] = null;
    let approverId: string | null = null;
    const deptForApproval = to.departmentId ?? elig.departmentId ?? items[0]?.departmentId ?? null;
    const canOverride = await this.people.isHeadOf(me, deptForApproval);
    const approver = async (why: string) => {
      approverId = (await this.people.departmentHead(me.orgId, deptForApproval)) ?? (await this.people.nextUp(me.orgId, me.id));
      if (approverId === me.id) approverId = await this.people.nextUp(me.orgId, me.id);
      const name = approverId ? (await this.people.names([approverId])).get(approverId) ?? null : null;
      needsApproval = { approver: name, why };
    };

    if (blockedFor) blocked = blockedFor;
    else if (!moving.length) blocked = `${to.name} already owns ${items.length === 1 ? 'this' : 'all of these'}`;
    if (!blocked && onLeave) {
      const when = fmt.format(new Date(`${leaveDates[0]}T12:00:00+05:30`));
      if (opts.approved) impact.push({ level: 'info', text: `${to.name} is on leave on ${when}; approved by the Department Head.` });
      else if (canOverride) {
        if (raw.overrideLeave) impact.push({ level: 'warning', text: `${to.name} is on approved leave on ${when}. You are overriding this as Department Head.` });
        else blocked = `${to.name} is on approved leave on ${when} (the deadline). Pick someone else, change the deadline, or tick "Override leave".`;
      } else await approver(`${to.name} is on approved leave on ${when} (the deadline)`);
    }
    if (!blocked) {
      if (hours > 0 && loadAfter > 120 && !opts.approved && !canOverride) await approver(`${to.name} would be at ${loadAfter}% of capacity (above 120%)`);
      else if (loadAfter > 120) impact.push({ level: 'warning', text: `${to.name} will be at ${loadAfter}% of capacity (above 120%).` });
      else if (loadAfter > 100) impact.push({ level: 'warning', text: `${to.name} will be over capacity: ${loadAfter}% (now ${to.loadPct}%).` });
      else impact.push({ level: 'info', text: `${to.name} goes from ${to.loadPct}% to ${loadAfter}% of capacity this week.` });
    }
    if (needsApproval) impact.push({ level: 'approval', text: `Needs Department Head approval: ${(needsApproval as { why: string }).why}. It will be sent to ${(needsApproval as { approver: string | null }).approver ?? 'an admin'} instead of applying now.` });

    const now = Date.now();
    const rows = items.map((i) => {
      const due = finalDue(i);
      const atRisk = !!due && (due.getTime() < now + DAY_MS || loadAfter > 100 || (!!PeopleDirectory.day(due) && to.leaveDays.has(PeopleDirectory.day(due)!)));
      const clientFacing = !!i.clientDueAt && !!due && due > i.clientDueAt;
      return {
        id: i.id,
        title: i.title,
        from: loads.find((l) => l.id === i.ownerId)?.name ?? (i.ownerId ? 'someone else' : null),
        deadlineFrom: i.deadline?.toISOString() ?? null,
        deadlineTo: due?.toISOString() ?? null,
        atRisk,
        clientFacing,
        dependents: i.dependents ?? [],
        inProgress: i.inProgress,
      };
    });
    const risk = rows.filter((r) => r.atRisk);
    if (risk.length) impact.push({ level: 'warning', text: `${risk.length} deadline${risk.length > 1 ? 's' : ''} at risk: ${risk.slice(0, 3).map((r) => r.title).join(', ')}${risk.length > 3 ? '…' : ''}` });
    const cf = rows.filter((r) => r.clientFacing);
    if (cf.length) impact.push({ level: 'warning', text: `The new deadline is after the client-facing date for ${cf.map((r) => r.title).slice(0, 3).join(', ')}. The account manager will be asked to confirm and post an update in the client thread.` });
    const deps = rows.flatMap((r) => r.dependents);
    if (deps.length) impact.push({ level: 'info', text: `${deps.length} later step${deps.length > 1 ? 's wait' : ' waits'} on this: ${deps.slice(0, 3).join(', ')}${deps.length > 3 ? '…' : ''}` });
    const needsHandover = items.some((i) => i.inProgress && i.ownerId && i.ownerId !== to.id);
    if (needsHandover) impact.push({ level: 'info', text: 'Work has already started: add a handover note for the new owner.' });
    impact.push({ level: 'info', text: 'Comments, files, time logs and history stay on the record.' });

    return {
      target,
      items,
      to,
      deadlines,
      approverId,
      preview: { to: { id: to.id, name: to.name, loadPct: to.loadPct, loadAfterPct: loadAfter, onLeave }, items: rows, impact, needsHandover, needsApproval, blocked },
    };
  }

  /**
   * Same leave / capacity rules for a brand-new record (task create, template, import): blocked (with reason),
   * needs Department Head approval (approverId + why), or fine (with an optional warning).
   */
  async assessNew(me: Me, input: { toUserId: string; deadline: Date | null; hours: number; departmentId: string | null; overrideLeave?: boolean }) {
    const [p] = await this.people.loads(me.orgId, { id: input.toUserId });
    if (!p) throw new BadRequestException('Pick an active team member');
    const dept = p.departmentId ?? input.departmentId;
    const canOverride = await this.people.isHeadOf(me, dept);
    const day = PeopleDirectory.day(input.deadline ?? new Date());
    const after = PeopleDirectory.after(p, input.hours);
    const approverFor = async () => {
      let a = (await this.people.departmentHead(me.orgId, dept)) ?? (await this.people.nextUp(me.orgId, me.id));
      if (a === me.id) a = await this.people.nextUp(me.orgId, me.id);
      return a;
    };
    if (p.id !== me.id && day && p.leaveDays.has(day)) {
      const when = fmt.format(new Date(`${day}T12:00:00+05:30`));
      if (!canOverride) return { person: p, blocked: null, approval: { approverId: await approverFor(), why: `${p.name} is on approved leave on ${when} (the deadline)` }, warning: null, loadAfter: after };
      if (!input.overrideLeave) return { person: p, blocked: `${p.name} is on approved leave on ${when} (the deadline). Pick someone else, change the deadline, or tick "Override leave".`, approval: null, warning: null, loadAfter: after };
    }
    if (p.id !== me.id && after > 120 && !canOverride) return { person: p, blocked: null, approval: { approverId: await approverFor(), why: `${p.name} would be at ${after}% of capacity (above 120%)` }, warning: null, loadAfter: after };
    return { person: p, blocked: null, approval: null, warning: after > 100 ? `${p.name} is now at ${after}% of capacity this week.` : null, loadAfter: after };
  }

  async preview(me: Me, type: string, input: CoreReassignPreviewInput): Promise<CoreReassignPreview> {
    return (await this.evaluate(me, type, input)).preview;
  }

  // -------------------------------------------------------------------------
  // Apply

  async apply(me: Me, type: string, body: unknown, ip?: string): Promise<CoreReassignResult> {
    const parsed = coreReassignApplySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid request');
    const { undoRows: _rows, ...result } = await this.run(me, type, parsed.data, { ip } as RunOpts & { ip?: string });
    return result;
  }

  /** Validates and applies (or sends for approval). Used by the endpoint, bulk reassign and the approval handler. */
  async run(me: Me, type: string, input: CoreReassignApply, opts: RunOpts & { ip?: string } = {}): Promise<CoreReassignResult & { undoRows?: UndoRow[] }> {
    const ev = await this.evaluate(me, type, input, opts);
    const { preview } = ev;
    if (preview.blocked) throw new BadRequestException(preview.blocked);
    if (preview.needsHandover && (input.handoverNote ?? '').trim().length < 3) throw new BadRequestException('Add a handover note: the work has already started');
    if (input.reason === 'other' && (input.note ?? '').trim().length < 3) throw new BadRequestException('Say a little more about the reason ("Other")');

    if (preview.needsApproval && !opts.approved) {
      const req = await this.approvals.create(
        me,
        {
          action: 'reassign.approval',
          targetType: type,
          targetId: ev.items[0].id,
          summary: `Move ${ev.items.length === 1 ? `"${ev.items[0].title}"` : `${ev.items.length} ${ev.target.label.toLowerCase()}s`} to ${ev.to.name}`,
          payload: { type, input },
          reason: `${coreReassignReasonLabels[input.reason as keyof typeof coreReassignReasonLabels] ?? input.reason}: ${preview.needsApproval.why}${input.note ? ` · ${input.note}` : ''}`,
          approverId: ev.approverId,
          diff: ev.items.slice(0, 5).map((i) => ({ field: i.title, before: preview.items.find((r) => r.id === i.id)?.from ?? 'Unassigned', after: ev.to.name })),
        },
        opts.ip,
      );
      return { ok: true, applied: 0, approval: { id: req.id, approver: preview.needsApproval.approver, summary: req.summary }, undo: null, message: `Sent to ${preview.needsApproval.approver ?? 'an admin'} for approval` };
    }

    const moving = ev.items.filter((i) => i.ownerId !== ev.to.id);
    const snapshot = await ev.target.snapshot(moving, input.role);
    await ev.target.apply(me, moving, { to: { id: ev.to.id, name: ev.to.name }, deadlines: ev.deadlines, input: { ...input, reason: input.reason } });
    const undoRows: UndoRow[] = [...snapshot];
    const readAccessUntil = new Date(Date.now() + READ_ACCESS_DAYS * DAY_MS);
    const entity = ev.target.auditEntity ?? type;
    for (const i of moving) {
      const due = ev.deadlines.get(i.id);
      const a = await this.prisma.assignment.create({
        data: {
          orgId: me.orgId,
          targetType: type,
          targetId: i.id,
          role: input.role ?? 'owner',
          fromUserId: i.ownerId,
          toUserId: ev.to.id,
          reason: input.reason,
          note: input.note ?? null,
          handoverNote: input.handoverNote ?? null,
          deadlineChange: due !== undefined ? { mode: input.deadline?.mode ?? 'keep', from: i.deadline?.toISOString() ?? null, to: due?.toISOString() ?? null } : undefined,
          approvalRequestId: opts.approvalId ?? null,
          readAccessUntil: i.ownerId ? readAccessUntil : null,
          byId: me.id,
        },
      });
      undoRows.push({ model: 'assignment', id: a.id, delete: true });
      await this.audit.log(
        me,
        `${type}.${i.ownerId ? 'reassigned' : 'assigned'}`,
        entity,
        i.id,
        { ownerId: i.ownerId, deadline: i.deadline },
        { ownerId: ev.to.id, owner: ev.to.name, deadline: due === undefined ? i.deadline : due, reason: coreReassignReasonLabels[input.reason as keyof typeof coreReassignReasonLabels] ?? input.reason, note: input.note ?? null, handover: input.handoverNote ?? null, approvalId: opts.approvalId ?? null, role: input.role ?? null },
        opts.ip,
      );
    }
    if (!opts.skipNotify) await this.notifyMoved(me, ev.target, moving, ev.to, ev.deadlines, input);
    const label = opts.bulkLabel ?? `${moving.length === 1 ? `"${moving[0].title}"` : `${moving.length} ${ev.target.label.toLowerCase()}s`} moved to ${ev.to.name}`;
    const undo = opts.skipUndo || opts.approved ? null : await this.undo.create(me, label, undoRows);
    return { ok: true, applied: moving.length, approval: null, undo, message: label, undoRows };
  }

  private async notifyMoved(me: Me, target: ReassignTarget, items: ReassignItem[], to: { id: string; name: string; managerId: string | null }, deadlines: Map<string, Date | null | undefined>, input: CoreReassignApply) {
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null;
    const link = one ? (target.href?.(one) ?? one.href ?? '/team/tasks') : '/team/tasks';
    const why = coreReassignReasonLabels[input.reason as keyof typeof coreReassignReasonLabels] ?? input.reason;
    const dueText = one ? short(deadlines.has(one.id) ? deadlines.get(one.id) : one.deadline) : null;
    const skip = (ids: (string | null | undefined)[]) => ids.filter((x): x is string => !!x && x !== me.id);
    await this.notifications.notify(me.orgId, skip([to.id]), {
      kind: 'task_assigned',
      title: one ? `${me.name} assigned you: ${one.title}` : `${me.name} assigned you ${items.length} ${target.label.toLowerCase()}s`,
      body: [dueText ? `Due ${dueText}` : null, `Reason: ${why}`, input.handoverNote ? `Handover: ${input.handoverNote}` : null].filter(Boolean).join(' · '),
      link,
    });
    const prev = [...new Set(items.map((i) => i.ownerId).filter((x): x is string => !!x && x !== to.id))];
    for (const p of skip(prev)) {
      const moved = items.filter((i) => i.ownerId === p);
      await this.notifications.notify(me.orgId, [p], {
        kind: 'task_assigned',
        title: moved.length === 1 ? `${moved[0].title} moved to ${to.name}` : `${moved.length} of your ${target.label.toLowerCase()}s moved to ${to.name}`,
        body: `Reassigned by ${me.name} (${why}). You can still open it for 7 days for handover questions.`,
        link: moved.length === 1 ? (target.href?.(moved[0]) ?? link) : link,
      });
    }
    if (to.managerId && to.managerId !== me.id && to.managerId !== to.id) {
      await this.notifications.notify(me.orgId, [to.managerId], { kind: 'task_assigned', title: `${to.name} took over ${one ? one.title : `${items.length} ${target.label.toLowerCase()}s`}`, body: `Moved by ${me.name} (${why}).`, link });
    }
    const ams = [...new Set(items.map((i) => i.amId).filter((x): x is string => !!x && x !== to.id && x !== to.managerId))];
    for (const am of skip(ams)) {
      const mine = items.filter((i) => i.amId === am);
      const lateForClient = mine.filter((i) => i.clientDueAt && deadlines.get(i.id) && deadlines.get(i.id)! > i.clientDueAt);
      await this.notifications.notify(me.orgId, [am], {
        kind: 'task_assigned',
        title: `Client work moved to ${to.name}: ${mine.length === 1 ? mine[0].title : `${mine.length} items`}`,
        body: lateForClient.length ? `The new deadline is after the client-facing date for ${lateForClient.map((i) => i.title).join(', ')}. Please confirm and post an update in the client thread.` : `Moved by ${me.name} (${why}).`,
        link: mine.length === 1 ? (target.href?.(mine[0]) ?? link) : link,
        critical: lateForClient.length > 0,
      });
    }
  }

  /**
   * For existing endpoints that move tasks their own way (Manager workspace assign, leave cover): records the
   * Assignment rows so every move shows in one history. Does not notify (they already do).
   */
  async record(me: Me, type: string, moves: { id: string; fromUserId: string | null; toUserId: string }[], reason: string, note?: string) {
    const until = new Date(Date.now() + READ_ACCESS_DAYS * DAY_MS);
    const rows = moves.filter((m) => m.fromUserId !== m.toUserId);
    if (!rows.length) return;
    await this.prisma.assignment.createMany({
      data: rows.map((m) => ({ orgId: me.orgId, targetType: type, targetId: m.id, fromUserId: m.fromUserId, toUserId: m.toUserId, reason, note: note ?? null, readAccessUntil: m.fromUserId ? until : null, byId: me.id })),
    });
  }

  // -------------------------------------------------------------------------
  // Bulk: move all open work from A to B (or split)

  private async assertBulk(me: Me, userId: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    if (isLeader(me) || hasRole(me, 'founder', 'admin')) return;
    const dept = await this.people.departmentOf(userId);
    if (hasRole(me, 'department_head') && (await this.people.isHeadOf(me, dept))) return;
    throw new ForbiddenException('Only a Branch Manager or the Department Head can move all of someone’s work');
  }

  async openWork(me: Me, userId: string): Promise<CoreOpenWork> {
    await this.assertBulk(me, userId);
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId: me.orgId }, select: { id: true, name: true, departmentId: true } });
    if (!user) throw new NotFoundException('Person not found');
    const groups: CoreOpenWork['groups'] = [];
    for (const t of this.registry.reassignTargets.values()) {
      if (!t.openWorkOf) continue;
      const rows = await t.openWorkOf(me.orgId, userId);
      if (rows.length) groups.push({ type: t.type, label: t.label, items: rows.map((r) => ({ id: r.id, title: r.title, deadline: r.deadline?.toISOString() ?? null, status: r.status, client: r.client })) });
    }
    const loads = await this.people.loads(me.orgId, { id: { not: userId }, roles: { some: { role: { baseRole: { in: ['producer', 'strategist', 'qc_reviewer', 'intern', 'account_manager', 'am_lead', 'department_head', 'sales_executive', 'sales_manager'] } } } } });
    const hours = groups.reduce((s, g) => s + g.items.length * 4, 0);
    const candidates = this.candidateRows(loads, [], { departmentId: user.departmentId }, hours);
    return { user: { id: user.id, name: user.name }, groups, candidates };
  }

  async bulk(me: Me, input: CoreBulkReassign, ip?: string): Promise<CoreReassignResult> {
    await this.assertBulk(me, input.fromUserId);
    const from = await this.prisma.user.findFirst({ where: { id: input.fromUserId, orgId: me.orgId }, select: { name: true } });
    if (!from) throw new NotFoundException('Person not found');
    // Validate everything first (evaluate throws on any rule), then apply.
    const plan: { type: string; input: CoreReassignApply }[] = [];
    for (const m of input.moves) {
      const byType = new Map<string, string[]>();
      for (const it of m.items) byType.set(it.type, [...(byType.get(it.type) ?? []), it.id]);
      for (const [type, ids] of byType) {
        const one: CoreReassignApply = { ids, toUserId: m.toUserId, reason: input.reason, note: input.note, handoverNote: input.handoverNote ?? `Handover from ${from.name}`, deadline: { mode: 'keep' }, overrideLeave: input.overrideLeave };
        const ev = await this.evaluate(me, type, one);
        if (ev.items.some((i) => i.ownerId !== input.fromUserId)) throw new BadRequestException(`Some ${ev.target.label.toLowerCase()}s are no longer ${from.name}'s. Refresh and try again.`);
        if (ev.preview.blocked) throw new BadRequestException(ev.preview.blocked);
        if (ev.preview.needsApproval) throw new BadRequestException(`${ev.preview.needsApproval.why}. Split the work differently, or ask the Department Head to do this move.`);
        plan.push({ type, input: one });
      }
    }
    const undoRows: UndoRow[] = [];
    let applied = 0;
    for (const p of plan) {
      const r = await this.run(me, p.type, p.input, { skipUndo: true, ip });
      applied += r.applied;
      undoRows.push(...(r.undoRows ?? []));
    }
    await this.audit.log(me, 'user.work_reassigned', 'User', input.fromUserId, null, { moves: input.moves.map((m) => ({ toUserId: m.toUserId, count: m.items.length })), reason: input.reason }, ip);
    const label = `${applied} item${applied === 1 ? '' : 's'} moved from ${from.name}`;
    const undo = await this.undo.create(me, label, undoRows);
    return { ok: true, applied, approval: null, undo, message: label };
  }
}
