// v11 ops: admin configuration gaps. Integrations connect / disconnect (Founder / Admin), per-client ad and social
// accounts connected by the AM with client consent, holiday / working-hour changes recalculating SLA timers and
// working-day deadlines, and Admin publishing of department-head drafts (SOPs, flow templates, QC checklists).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingMinutes,
  clampToWorkingTime,
  istDate,
  OPS_INTEGRATION_KEYS,
  opsClientAccountSchema,
  opsPlatformLabels,
  SLA_FIRST_REPLY_MIN,
  type Me,
  type OpsClientAccountRow,
  type OpsIntegrationRow,
} from '@bmu/shared';
import { OPEN_TASK } from '../actions/people.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { SettingsService } from '../settings/settings.service.js';
import { hasRole, isFounderAdmin } from './ops-util.js';
import { OpsLeadsService } from './ops-leads.service.js';

const env = (k: string) => !!process.env[k]?.trim();

@Injectable()
export class OpsAdminService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
    private readonly settings: SettingsService,
    private readonly leads: OpsLeadsService,
  ) {}

  onModuleInit() {
    this.settings.onSaved(async (me, section) => {
      if (section === 'holidays' || section === 'workingHours') await this.recalculate(me, section);
    });

    // Department heads save drafts; a Branch Manager publishes them.
    this.registry.registerApprovalHandler({
      action: 'sop.publish',
      label: 'Publish SOP',
      href: (r) => `/admin/operations/sops?open=${r.targetId}`,
      apply: async ({ approver, req }) => {
        const p = req.payload as { title: string; body: string; departmentId: string };
        const before = await this.prisma.sOP.findFirst({ where: { id: req.targetId, orgId: approver.orgId } });
        if (!before) throw new NotFoundException('The SOP was deleted');
        const s = await this.prisma.sOP.update({ where: { id: before.id }, data: { title: p.title, body: p.body, departmentId: p.departmentId, status: 'published', publishedAt: new Date(), version: before.status === 'published' ? { increment: 1 } : undefined } });
        await this.audit.log(approver, 'sop.published', 'SOP', s.id, { status: before.status, version: before.version, body: before.body }, { status: 'published', version: s.version, body: s.body, requestedById: req.requestedById }, undefined);
        return { id: s.id };
      },
    });
    this.registry.registerApprovalHandler({
      action: 'template.flow_publish',
      label: 'Publish flow template',
      href: () => '/admin/templates',
      apply: async ({ approver, req }) => {
        const p = req.payload as { key: string; name: string; departmentId: string; deliverableTypes: string[]; steps: unknown[] };
        const current = await this.prisma.flowTemplate.findFirst({ where: { orgId: approver.orgId, key: p.key, active: true }, orderBy: { version: 'desc' } });
        if (!current) throw new BadRequestException('Unknown flow');
        const created = await this.prisma.flowTemplate.create({ data: { orgId: approver.orgId, departmentId: p.departmentId, key: p.key, name: p.name, deliverableTypes: p.deliverableTypes, steps: p.steps as never, version: current.version + 1 } });
        await this.audit.log(approver, 'flow_template.updated', 'FlowTemplate', created.id, { version: current.version }, { version: created.version, steps: p.steps.length, requestedById: req.requestedById }, undefined);
        return { id: created.id };
      },
    });
    this.registry.registerApprovalHandler({
      action: 'template.qc_publish',
      label: 'Publish QC checklist',
      href: () => '/admin/templates',
      apply: async ({ approver, req }) => {
        const p = req.payload as { key: string; name: string; items: string[] };
        const current = await this.prisma.checklistTemplate.findFirst({ where: { orgId: approver.orgId, kind: 'qc', key: p.key }, orderBy: { version: 'desc' } });
        if (!current) throw new BadRequestException('Unknown checklist');
        const created = await this.prisma.checklistTemplate.create({ data: { orgId: approver.orgId, kind: 'qc', key: p.key, name: p.name, items: p.items, departmentId: current.departmentId, version: current.version + 1 } });
        await this.audit.log(approver, 'qc_checklist.updated', 'ChecklistTemplate', created.id, { version: current.version }, { version: created.version, requestedById: req.requestedById }, undefined);
        return { id: created.id };
      },
    });
  }

  // -------------------------------------------------------------------------
  // Holidays / working hours → recalculate

  /** SLA timers (new-lead first reply, client request first reply) and open task deadlines that now fall on a day off. */
  async recalculate(me: Me, section: string) {
    const orgId = me.orgId;
    const cal = await calendarFor(this.prisma, orgId);
    const leads = await this.leads.recalcFirstReply(orgId);
    const sla = await this.settings.get(orgId, 'sla');
    const reqs = await this.prisma.request.findMany({ where: { orgId, firstReplyAt: null, slaDue: { not: null }, status: { in: ['received', 'scope_check'] } }, select: { id: true, type: true, createdAt: true } });
    for (const r of reqs) {
      const minutes = sla.firstReplyMinutes[r.type as keyof typeof sla.firstReplyMinutes] ?? SLA_FIRST_REPLY_MIN[r.type as keyof typeof SLA_FIRST_REPLY_MIN] ?? 240;
      await this.prisma.request.update({ where: { id: r.id }, data: { slaDue: addWorkingMinutes(r.createdAt, minutes, cal) } });
    }
    // Working-day deadlines: an open task due on a day that is no longer a working day moves to the next working time.
    const tasks = await this.prisma.task.findMany({ where: { orgId, status: { in: [...OPEN_TASK] }, archivedAt: null, deadline: { gte: new Date() } }, select: { id: true, deadline: true, ownerId: true, title: true } });
    let moved = 0;
    for (const t of tasks) {
      const d = t.deadline!;
      const day = istDate(d);
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (cal.days.includes(dow) && !cal.holidays.includes(day)) continue;
      const next = clampToWorkingTime(d, cal);
      await this.prisma.task.update({ where: { id: t.id }, data: { deadline: next } });
      await this.notifications.notify(orgId, [t.ownerId], { kind: 'task_deadline_changed', title: `New deadline for "${t.title}"`, body: `It fell on a day off, so it moved to ${istDate(next)}.`, link: `/team/tasks/${t.id}`, noEmail: true });
      moved++;
    }
    await this.audit.log(me, 'settings.deadlines_recalculated', 'Organisation', orgId, undefined, { section, leads, requests: reqs.length, tasksMoved: moved });
    return { leads, requests: reqs.length, tasksMoved: moved };
  }

  // -------------------------------------------------------------------------
  // Integrations (org level)

  private assertAdmin(me: Me) {
    if (me.type !== 'staff' || !isFounderAdmin(me)) throw new ForbiddenException('Only the Founder or a Branch Manager connects integrations');
  }

  private configured(key: string, accountingTool: string) {
    if (key === 'razorpay') return env('RAZORPAY_KEY_ID') && env('RAZORPAY_KEY_SECRET');
    if (key === 'email') return env('SMTP_HOST');
    if (key === 'whatsapp') return env('WHATSAPP_TOKEN');
    if (key === 'accounting') return accountingTool !== 'none';
    return true;
  }

  async integrations(me: Me): Promise<OpsIntegrationRow[]> {
    this.assertAdmin(me);
    const [rows, accounting] = await Promise.all([this.prisma.opsIntegration.findMany({ where: { orgId: me.orgId, clientOrgId: null } }), this.settings.get(me.orgId, 'accounting')]);
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.connectedById) } }, select: { id: true, name: true } });
    return OPS_INTEGRATION_KEYS.map((key) => {
      const r = rows.find((x) => x.key === key);
      const configured = this.configured(key, accounting.tool);
      return { key, label: opsPlatformLabels[key] ?? key, configured, connected: !!r?.connected && configured, connectedBy: r?.connected ? (users.find((u) => u.id === r.connectedById)?.name ?? null) : null, connectedAt: r?.connected ? r.connectedAt.toISOString() : null };
    });
  }

  async connect(me: Me, key: string, ip?: string) {
    this.assertAdmin(me);
    if (!(OPS_INTEGRATION_KEYS as readonly string[]).includes(key)) throw new NotFoundException('Unknown integration');
    const accounting = await this.settings.get(me.orgId, 'accounting');
    if (!this.configured(key, accounting.tool)) throw new BadRequestException(`${opsPlatformLabels[key]} has no keys on the server yet. Ask your developer to add them, then connect.`);
    const existing = await this.prisma.opsIntegration.findFirst({ where: { orgId: me.orgId, key, clientOrgId: null } });
    if (existing?.connected) throw new BadRequestException('Already connected');
    const data = { connected: true, connectedById: me.id, connectedAt: new Date(), disconnectedAt: null, disconnectedById: null };
    const row = existing ? await this.prisma.opsIntegration.update({ where: { id: existing.id }, data }) : await this.prisma.opsIntegration.create({ data: { orgId: me.orgId, key, ...data } });
    await this.audit.log(me, 'integration.connected', 'Organisation', me.orgId, { key, connected: false }, { key, connected: true, id: row.id }, ip);
    return { ok: true, message: `${opsPlatformLabels[key]} connected` };
  }

  async disconnect(me: Me, key: string, reason: string | undefined, ip?: string) {
    this.assertAdmin(me);
    if (!reason || reason.trim().length < 3) throw new BadRequestException('Say why you are disconnecting it');
    const row = await this.prisma.opsIntegration.findFirst({ where: { orgId: me.orgId, key, clientOrgId: null, connected: true } });
    if (!row) throw new BadRequestException('Not connected');
    await this.prisma.opsIntegration.update({ where: { id: row.id }, data: { connected: false, disconnectedAt: new Date(), disconnectedById: me.id } });
    await this.audit.log(me, 'integration.disconnected', 'Organisation', me.orgId, { key, connected: true }, { key, connected: false, reason: reason.trim() }, ip);
    return { ok: true, message: `${opsPlatformLabels[key] ?? key} disconnected` };
  }

  // -------------------------------------------------------------------------
  // Per-client ad / social accounts (AM with client consent)

  private async assertClientAm(me: Me, clientOrgId: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!c) throw new NotFoundException('Client not found');
    if (!hasRole(me, 'founder', 'admin', 'am_lead') && c.amUserId !== me.id) throw new ForbiddenException("Only the client's Account Manager connects their accounts");
    return c;
  }

  async clientAccounts(me: Me, clientOrgId: string): Promise<OpsClientAccountRow[]> {
    await this.assertClientAm(me, clientOrgId);
    const rows = await this.prisma.opsIntegration.findMany({ where: { orgId: me.orgId, clientOrgId }, orderBy: { connectedAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.connectedById) } }, select: { id: true, name: true } });
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform ?? r.key,
      label: opsPlatformLabels[r.platform ?? r.key] ?? r.key,
      accountName: r.accountName ?? '',
      connected: r.connected,
      consentBy: r.consentBy,
      consentAt: r.consentAt?.toISOString() ?? null,
      connectedBy: users.find((u) => u.id === r.connectedById)?.name ?? 'Team',
      connectedAt: r.connectedAt.toISOString(),
    }));
  }

  async connectClientAccount(me: Me, clientOrgId: string, body: unknown, ip?: string) {
    const c = await this.assertClientAm(me, clientOrgId);
    const input = parse(opsClientAccountSchema, body);
    const dup = await this.prisma.opsIntegration.findFirst({ where: { orgId: me.orgId, clientOrgId, platform: input.platform, accountName: { equals: input.accountName, mode: 'insensitive' }, connected: true } });
    if (dup) throw new BadRequestException('This account is already connected');
    const row = await this.prisma.opsIntegration.create({
      data: { orgId: me.orgId, key: `client_${input.platform}`, clientOrgId, platform: input.platform, accountName: input.accountName, consentBy: input.consentBy, consentAt: new Date(), connectedById: me.id },
    });
    await this.audit.log(me, 'integration.client_account_connected', 'ClientOrg', clientOrgId, undefined, { id: row.id, platform: input.platform, accountName: input.accountName, consentBy: input.consentBy }, ip);
    await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(c.id), { kind: 'account_connected', title: `${opsPlatformLabels[input.platform]} account connected`, body: `${me.name} connected ${input.accountName} with consent from ${input.consentBy}.`, link: '/client' });
    return { id: row.id, message: `${opsPlatformLabels[input.platform]} connected for ${c.name}` };
  }

  async disconnectClientAccount(me: Me, id: string, reason: string | undefined, ip?: string) {
    const row = await this.prisma.opsIntegration.findFirst({ where: { id, orgId: me.orgId, clientOrgId: { not: null } } });
    if (!row) throw new NotFoundException('Account not found');
    await this.assertClientAm(me, row.clientOrgId!);
    if (!row.connected) throw new BadRequestException('Already disconnected');
    if (!reason || reason.trim().length < 3) throw new BadRequestException('Say why you are disconnecting it');
    await this.prisma.opsIntegration.update({ where: { id }, data: { connected: false, disconnectedAt: new Date(), disconnectedById: me.id } });
    await this.audit.log(me, 'integration.client_account_disconnected', 'ClientOrg', row.clientOrgId!, { connected: true }, { connected: false, platform: row.platform, reason: reason.trim() }, ip);
    return { ok: true, message: 'Disconnected' };
  }
}
