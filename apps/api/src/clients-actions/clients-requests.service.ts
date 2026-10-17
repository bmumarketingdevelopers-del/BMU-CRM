// v11 clients (requests_approvals): raise a request on behalf of a client, custom-priced add-on quotes with a Branch Manager
// limit, convert an approved (and paid) request into tasks (template when one matches), and internal approvals.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  addWorkingMinutes,
  CLIENTS_ADDON_CUSTOM_LIMIT_PAISE,
  formatINR,
  istDate,
  SLA_FIRST_REPLY_MIN,
  type ClientsConvert,
  type ClientsConvertPreview,
  type ClientsCustomQuote,
  type ClientsInternalApproval,
  type ClientsRaiseRequest,
  type Me,
  clientsCanRaiseRequest,
} from '@bmu/shared';
import { ApprovalsService } from '../actions/approvals.service.js';
import { hasRole } from '../actions/people.js';
import { ActionsRegistry } from '../actions/registry.js';
import { TasksActionsService } from '../actions/tasks/tasks.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { SettingsService } from '../settings/settings.service.js';
import { assertStaff, isAdmin, isClientLead } from './clients-access.js';
import { assignScope } from '../actions/tasks/assign-rules.js';

const CONVERTIBLE = ['paid', 'in_progress', 'in_scope', 'approved'];
type FlowStep = { key: string; days: number; kind: string; name: string; role: string };

@Injectable()
export class ClientsRequestsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly registry: ActionsRegistry,
    private readonly approvals: ApprovalsService,
    private readonly tasks: TasksActionsService,
  ) {}

  onModuleInit() {
    this.registry.registerApprovalHandler({
      action: 'clients.custom_quote',
      label: 'Custom add-on price above the limit',
      href: (r) => `/team/requests/${r.targetId}`,
      apply: async ({ approver, requester, req }) => {
        if (!isAdmin(approver)) throw new ForbiddenException('Only a Branch Manager can approve a custom price above the limit');
        return this.sendCustomQuote(requester ?? approver, req.targetId, req.payload as ClientsCustomQuote, approver);
      },
    });
    this.registry.registerApprovalHandler({
      action: 'clients.internal',
      label: 'Internal approval',
      href: (r) => {
        const p = r.payload as { targetType?: string; targetId?: string | null };
        if (p.targetType === 'client' && p.targetId) return `/team/clients/${p.targetId}`;
        if (p.targetType === 'request' && p.targetId) return `/team/requests/${p.targetId}`;
        if (p.targetType === 'engagement' && p.targetId) return `/team/projects/${p.targetId}`;
        return '/team/approvals';
      },
      // Nothing to apply: the decision itself is the record (audited, and the requester is told).
      apply: async () => ({ recorded: true }),
    });
  }

  private async requestFor(me: Me, id: string) {
    assertStaff(me);
    const r = await this.prisma.request.findFirst({ where: { id, orgId: me.orgId }, include: { engagement: { include: { clientOrg: { select: { id: true, name: true } }, service: { select: { name: true } } } } } });
    if (!r) throw new NotFoundException('Request not found');
    if (!isClientLead(me) && r.engagement.amId !== me.id && r.assigneeId !== me.id && !hasRole(me, 'department_head')) throw new ForbiddenException("This request belongs to another Client Manager's client");
    return r;
  }

  // -------------------------------------------------------------------------
  // raise_request: the CM raises it on the client's behalf

  async raise(me: Me, input: ClientsRaiseRequest, ip?: string) {
    assertStaff(me);
    if (!clientsCanRaiseRequest(me)) throw new ForbiddenException("Only the client's Client Manager (or leadership) can raise a request for them");
    const e = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, orgId: me.orgId, deletedAt: null }, include: { clientOrg: true, service: { select: { name: true } } } });
    if (!e) throw new NotFoundException('Service not found');
    if (!(isClientLead(me) || (hasRole(me, 'account_manager') && (e.amId === me.id || e.clientOrg.amUserId === me.id)))) throw new ForbiddenException("Only the client's Client Manager (or leadership) can raise a request for them");
    if (e.clientOrg.readOnlyUntil || e.status === 'closed') throw new BadRequestException('This client is offboarded');
    const files = input.attachmentIds?.length ? await this.prisma.file.findMany({ where: { id: { in: input.attachmentIds }, orgId: me.orgId, clientOrgId: e.clientOrgId }, select: { id: true } }) : [];
    if ((input.attachmentIds?.length ?? 0) !== files.length) throw new BadRequestException("One of the files isn't on this client's account");
    const cal = await calendarFor(this.prisma, me.orgId);
    const sla = await this.settings.get(me.orgId, 'sla');
    const minutes = sla.firstReplyMinutes[input.type] ?? SLA_FIRST_REPLY_MIN[input.type];
    const neededBy = input.neededBy ? new Date(`${input.neededBy}T18:00:00+05:30`) : null;
    if (neededBy && neededBy.getTime() < Date.now() - 86_400_000) throw new BadRequestException('"Needed by" is in the past');
    const description = [input.description, ...(input.links ?? []).filter(Boolean).map((l) => `Link: ${l}`)].join('\n');
    const r = await this.prisma.request.create({
      data: {
        orgId: me.orgId,
        engagementId: e.id,
        type: input.type,
        description,
        createdById: me.id,
        status: input.type === 'new_scope' ? 'scope_check' : 'received',
        slaDue: addWorkingMinutes(new Date(), minutes, cal),
        firstReplyAt: new Date(),
        neededBy,
        attachments: files.map((f) => f.id),
        raisedOnBehalf: true,
        assigneeId: e.amId,
      },
    });
    await this.audit.log(me, 'request.created', 'Request', r.id, null, { type: input.type, onBehalfOf: e.clientOrg.name, neededBy: input.neededBy || null, attachments: files.length }, ip);
    const deciders = await this.notifications.clientDeciders(e.clientOrgId);
    await this.notifications.notify(me.orgId, deciders, { kind: 'request_created', title: `${me.name} raised a request for you`, body: description.slice(0, 140), link: `/client/requests/${r.id}` });
    if (e.amId && e.amId !== me.id) await this.notifications.notify(me.orgId, [e.amId], { kind: 'request_created', title: `${me.name} raised a request for ${e.clientOrg.name}`, body: description.slice(0, 140), link: `/team/requests/${r.id}`, critical: input.type === 'urgent' });
    return { id: r.id, message: `Request raised for ${e.clientOrg.name}` };
  }

  // -------------------------------------------------------------------------
  // quote_addon: custom price, Branch Manager approval above the limit

  async customQuote(me: Me, id: string, input: ClientsCustomQuote, ip?: string) {
    const r = await this.requestFor(me, id);
    if (!(isClientLead(me) || r.engagement.amId === me.id)) throw new ForbiddenException("Only the client's Client Manager or a Branch Manager can quote");
    if (['approved', 'paid', 'in_progress', 'done', 'declined'].includes(r.status)) throw new BadRequestException(`This request is already ${r.status.replace(/_/g, ' ')}`);
    if (input.amountPaise > CLIENTS_ADDON_CUSTOM_LIMIT_PAISE && !isAdmin(me)) {
      const req = await this.approvals.create(
        me,
        { action: 'clients.custom_quote', targetType: 'request', targetId: r.id, summary: `Custom price ${formatINR(input.amountPaise)} for ${r.engagement.clientOrg.name}: ${input.item}`, payload: input, reason: `Above the ${formatINR(CLIENTS_ADDON_CUSTOM_LIMIT_PAISE)} limit for custom prices`, approverId: null, approverRoles: ['admin'], diff: [{ field: 'Quote', before: null, after: `${formatINR(input.amountPaise)} + GST · ${input.timeline}` }] },
        ip,
      );
      return { ok: true as const, message: `Above ${formatINR(CLIENTS_ADDON_CUSTOM_LIMIT_PAISE)}: sent to a Branch Manager for approval first`, approval: { id: req.id, summary: req.summary } };
    }
    await this.sendCustomQuote(me, r.id, input, me, ip);
    return { ok: true as const, message: 'Quote sent to the client', approval: null };
  }

  private async sendCustomQuote(me: Me, id: string, input: ClientsCustomQuote, by: Me, ip?: string) {
    const r = await this.prisma.request.findUniqueOrThrow({ where: { id }, include: { engagement: { include: { clientOrg: { select: { id: true, name: true } } } } } });
    if (['approved', 'paid', 'in_progress', 'done', 'declined'].includes(r.status)) throw new BadRequestException(`This request is already ${r.status.replace(/_/g, ' ')}`);
    await this.prisma.$transaction([
      this.prisma.request.update({ where: { id }, data: { status: 'quoted', type: 'new_scope', scopeDecision: 'new_direction', quoteAmountPaise: input.amountPaise, timeline: input.timeline, firstReplyAt: r.firstReplyAt ?? new Date(), addOnId: null } }),
      this.prisma.comment.create({ data: { orgId: r.orgId, targetType: 'request', targetId: id, body: `${input.item}: ${formatINR(input.amountPaise)} + GST, ${input.timeline}.${input.message ? ` ${input.message}` : ''}`, authorId: me.id } }),
    ]);
    await this.audit.log(by, 'request.quote', 'Request', id, { status: r.status }, { status: 'quoted', amountPaise: input.amountPaise, custom: true, item: input.item, requestedBy: me.id === by.id ? null : me.name }, ip);
    await this.notifications.notify(r.orgId, await this.notifications.clientDeciders(r.engagement.clientOrgId), { kind: 'request_quote', title: 'You have a quote to review', body: `${input.item}: ${formatINR(input.amountPaise)} + GST`, link: `/client/requests/${id}`, critical: true });
    return { quoted: true };
  }

  // -------------------------------------------------------------------------
  // convert_request_to_tasks

  async convertPreview(me: Me, id: string): Promise<ClientsConvertPreview> {
    const r = await this.requestFor(me, id);
    const canConvert = isClientLead(me) || r.engagement.amId === me.id || hasRole(me, 'department_head');
    let blocked: string | null = null;
    if (!canConvert) blocked = 'Only the Client Manager or a Department Head can convert requests to tasks';
    else if (r.type === 'new_scope' && !['paid', 'in_progress'].includes(r.status)) blocked = 'Extra requests need the client’s written approval and payment first';
    else if (!CONVERTIBLE.includes(r.status)) blocked = r.status === 'done' ? 'This request is already done' : 'Decide the request first (in scope, or quote and get it approved)';
    const [depts, people, templates, addOn] = await Promise.all([
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, headUserId: true }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true, name: true, departmentId: true, roles: { select: { role: { select: { baseRole: true } } } } }, orderBy: { name: 'asc' } }),
      this.prisma.flowTemplate.findMany({ where: { orgId: me.orgId, active: true } }),
      r.addOnId ? this.prisma.addOn.findUnique({ where: { id: r.addOnId }, select: { name: true } }) : null,
    ]);
    // Template match: a deliverable type ("reel", "post", "blog", "page"…) named in the request or its add-on.
    const text = `${r.description} ${addOn?.name ?? ''}`.toLowerCase();
    const tpl = templates.filter((t) => t.key !== 'general').find((t) => t.deliverableTypes.some((d) => new RegExp(`\\b${d}s?\\b`).test(text))) ?? null;
    const cal = await calendarFor(this.prisma, me.orgId);
    let at = new Date();
    const deptHead = (deptId: string | null) => depts.find((d) => d.id === deptId)?.headUserId ?? null;
    // v32: Department Heads give work to their team; others (Client Managers, leads) to the department's head.
    const scope = await assignScope(this.prisma, me);
    const headIds = new Set(depts.map((d) => d.headUserId).filter((x): x is string => !!x));
    const allowed = (p: { id: string; departmentId: string | null }) =>
      scope.kind === 'heads' ? headIds.has(p.id) : scope.kind === 'team' ? p.id === me.id || (!!p.departmentId && scope.departmentIds.includes(p.departmentId)) : p.id === me.id;
    const ownerFor = (deptId: string | null, preferred?: { id: string; departmentId: string | null } | null) =>
      scope.kind === 'heads' ? deptHead(deptId) : preferred && allowed(preferred) ? preferred.id : scope.kind === 'team' ? me.id : (preferred?.id ?? deptHead(deptId));
    const lines: ClientsConvertPreview['lines'] = [];
    if (tpl) {
      for (const s of (tpl.steps as FlowStep[]).filter((x) => x.kind === 'work')) {
        at = addWorkingDays(at, Math.max(1, s.days), cal);
        const owner = s.role === 'strategist' ? people.find((p) => p.roles.some((x) => x.role.baseRole === 'strategist')) : people.find((p) => p.departmentId === tpl.departmentId && p.roles.some((x) => x.role.baseRole === 'producer'));
        const deptId = scope.kind === 'heads' ? tpl.departmentId : (owner?.departmentId ?? tpl.departmentId);
        lines.push({ title: `${s.name}: ${r.description.slice(0, 60)}`, departmentId: deptId, ownerId: ownerFor(deptId, owner) ?? deptHead(tpl.departmentId), deadline: istDate(at) });
      }
    }
    if (!lines.length) {
      const amDept = people.find((p) => p.id === r.engagement.amId)?.departmentId ?? null;
      const preferred = people.find((p) => p.id === (r.assigneeId ?? r.engagement.amId)) ?? null;
      lines.push({ title: r.description.slice(0, 120), departmentId: amDept, ownerId: ownerFor(amDept, preferred) ?? r.assigneeId ?? r.engagement.amId, deadline: istDate(r.neededBy ?? addWorkingDays(new Date(), r.type === 'urgent' ? 1 : 2, cal)) });
    }
    return {
      request: { id: r.id, description: r.description, status: r.status, client: r.engagement.clientOrg.name, engagementId: r.engagementId },
      template: tpl ? { id: tpl.id, name: tpl.name } : null,
      lines,
      departments: depts.map((d) => ({ id: d.id, name: d.name })),
      people: people.filter(allowed).map((p) => ({ id: p.id, name: p.name, departmentId: p.departmentId, role: p.roles[0]?.role.baseRole ?? '' })),
      blocked,
    };
  }

  async convert(me: Me, id: string, input: ClientsConvert, ip?: string) {
    const preview = await this.convertPreview(me, id);
    if (preview.blocked) throw new BadRequestException(preview.blocked);
    const r = await this.prisma.request.findUniqueOrThrow({ where: { id }, include: { engagement: { select: { currentGate: true, amId: true } } } });
    const gate = Number(/^G(\d)/.exec(r.engagement.currentGate)?.[1] ?? 0);
    const ids: string[] = [];
    const waiting: string[] = [];
    for (const l of input.lines) {
      const res = await this.tasks.create(
        me,
        {
          title: l.title,
          engagementId: r.engagementId,
          departmentId: l.departmentId,
          ownerId: l.ownerId,
          deadline: l.deadline,
          description: `From client request: ${r.description.slice(0, 2000)}`,
          preProduction: gate < 3,
          outOfScope: r.type === 'new_scope',
          addOnRequestId: r.type === 'new_scope' ? r.id : null,
          priority: r.type === 'urgent' ? 'urgent' : 'normal',
        },
        ip,
      );
      if (res.approval) waiting.push(l.title);
      ids.push(res.task.id);
    }
    // Link the tasks to the request (done on the request closes them) and retire the automatic placeholder task.
    await this.prisma.task.updateMany({ where: { id: { in: ids } }, data: { flowStep: `request:${r.id}` } });
    await this.prisma.task.updateMany({ where: { flowStep: `request:${r.id}`, id: { notIn: ids }, status: 'todo', startedAt: null, timeLoggedMin: 0 }, data: { status: 'cancelled' } });
    if (r.status !== 'in_progress') await this.prisma.request.update({ where: { id }, data: { status: 'in_progress' } });
    await this.audit.log(me, 'request.converted_to_tasks', 'Request', id, { status: r.status }, { status: 'in_progress', tasks: ids.length, template: preview.template?.name ?? null }, ip);
    return { ok: true as const, taskIds: ids, message: `${ids.length} task${ids.length > 1 ? 's' : ''} created from the request${waiting.length ? ` (${waiting.length} waiting for Department Head approval)` : ''}` };
  }

  // -------------------------------------------------------------------------
  // request_approval_internal: any staff, any approver

  async internalApproval(me: Me, input: ClientsInternalApproval, ip?: string) {
    assertStaff(me);
    if (input.approverId === me.id) throw new BadRequestException("You can't approve your own request. Pick someone else.");
    const approver = await this.prisma.user.findFirst({ where: { id: input.approverId, orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true, name: true } });
    if (!approver) throw new BadRequestException('Pick an active team member to approve');
    if (input.byWhen < istDate(new Date())) throw new BadRequestException('"By when" is in the past');
    let targetType = 'internal';
    let targetId = `internal:${Date.now()}`;
    if (input.targetType !== 'none' && input.targetId) {
      if (input.targetType === 'client') {
        const c = await this.prisma.clientOrg.findFirst({ where: { id: input.targetId, orgId: me.orgId } });
        if (!c) throw new NotFoundException('Client not found');
        targetType = 'client_org';
      } else if (input.targetType === 'request') await this.requestFor(me, input.targetId);
      else if (!(await this.prisma.engagement.findFirst({ where: { id: input.targetId, orgId: me.orgId } }))) throw new NotFoundException('Service not found');
      else targetType = 'engagement';
      if (input.targetType === 'request') targetType = 'request';
      targetId = input.targetId;
    }
    const req = await this.approvals.create(
      me,
      { action: 'clients.internal', targetType, targetId, summary: input.what.slice(0, 140), payload: { targetType: input.targetType, targetId: input.targetId ?? null, byWhen: input.byWhen }, reason: `Needed by ${input.byWhen}${input.what.length > 140 ? ` · ${input.what}` : ''}`, approverId: approver.id, diff: [] },
      ip,
    );
    return { ok: true as const, message: `Sent to ${approver.name} for approval`, approval: { id: req.id, summary: req.summary } };
  }
}
