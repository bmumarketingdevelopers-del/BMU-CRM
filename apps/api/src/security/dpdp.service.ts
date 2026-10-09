// v20 DPDP Act 2023 tools: data-principal requests with deadlines, consent records, retention rules that run nightly,
// and the breach runbook. Client-level export and erasure stay in Command Centre → Data Export / Deletion (v8).
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  BREACH_RUNBOOK,
  DATA_REQUEST_DAYS,
  PRIVACY_NOTICE_VERSION,
  RETENTION_TYPES,
  type ConsentView,
  type DataRequestView,
  type DpdpOverview,
  type Me,
  type RetentionRuleView,
  type RetentionType,
} from '@bmu/shared';
import { z } from 'zod';
import { dataRequestCreateSchema, dataRequestUpdateSchema, retentionSaveSchema } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parse } from '../common/zod.js';
import { claimOnce } from '../runtime/claims.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const DAY = 86_400_000;
const FA = ['founder', 'admin'];
type Contact = { name?: string; email?: string; phone?: string; company?: string };

export const assertDpdp = (me: Me) => {
  if (me.type !== 'staff' || !me.roles.some((r) => FA.includes(r))) throw new ForbiddenException('Only the Founder or an Admin can manage data-protection requests');
};

@Injectable()
export class DpdpService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'security.retention', hint: 'Data retention rules (daily after 02:00 IST)', everyMs: 60 * 60_000, run: () => this.maybeRunRetention() });
    // Retention rules run once a day after 02:00 IST (checked hourly).
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  // ---------------------------------------------------------------------------------------------- requests

  /** Public: anyone can ask for a copy, a correction or erasure of their data (privacy page). */
  async createPublic(orgId: string, body: unknown) {
    const input = parse(dataRequestCreateSchema, body);
    // Link the record straight away when the email matches exactly one person or lead.
    const found = await this.matches(orgId, input.requesterEmail);
    const subject = found.length === 1 ? found[0] : found.find((m) => m.type === 'user') ?? null;
    const r = await this.prisma.dataRequest.create({
      data: { orgId, kind: input.kind, subjectType: subject?.type ?? 'lead', subjectId: subject?.id ?? null, requesterName: input.requesterName, requesterEmail: input.requesterEmail.toLowerCase(), details: input.details ?? null, dueAt: new Date(Date.now() + DATA_REQUEST_DAYS * DAY) },
    });
    await this.audit.logSystem(orgId, 'privacy.request_received', 'DataRequest', r.id, { kind: r.kind });
    const admins = await this.prisma.user.findMany({ where: { orgId, deletedAt: null, status: 'active', roles: { some: { role: { baseRole: { in: FA } } } } }, select: { id: true } });
    await this.notifications.notify(orgId, admins.map((a) => a.id), { kind: 'automation', title: `Privacy request: ${input.kind}`, body: `${input.requesterName} (${input.requesterEmail}). Due within ${DATA_REQUEST_DAYS} days.`, link: '/admin/privacy' });
    return { id: r.id, dueAt: r.dueAt.toISOString() };
  }

  private async matches(orgId: string, email: string) {
    const e = email.toLowerCase();
    const [leads, users] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; contact: Contact }[]>`SELECT id, contact FROM leads WHERE "orgId" = ${orgId} AND "deletedAt" IS NULL AND lower(contact->>'email') = ${e} LIMIT 20`,
      this.prisma.user.findMany({ where: { orgId, email: e, deletedAt: null }, select: { id: true, name: true, type: true, clientUser: { select: { clientOrg: { select: { id: true, name: true } } } } } }),
    ]);
    const out: DataRequestView['matches'] = leads.map((l) => ({ type: 'lead' as const, id: l.id, name: l.contact?.company || l.contact?.name || 'Lead' }));
    for (const u of users) {
      out.push({ type: 'user', id: u.id, name: u.name });
      if (u.clientUser?.clientOrg) out.push({ type: 'client', id: u.clientUser.clientOrg.id, name: u.clientUser.clientOrg.name });
    }
    return out;
  }

  private async view(r: Awaited<ReturnType<PrismaService['dataRequest']['findFirstOrThrow']>>): Promise<DataRequestView> {
    const assignee = r.assigneeId ? await this.prisma.user.findUnique({ where: { id: r.assigneeId }, select: { id: true, name: true } }) : null;
    const open = r.status === 'open' || r.status === 'in_progress';
    return {
      id: r.id,
      kind: r.kind as DataRequestView['kind'],
      requesterName: r.requesterName,
      requesterEmail: r.requesterEmail,
      details: r.details,
      status: r.status as DataRequestView['status'],
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      matches: open ? await this.matches(r.orgId, r.requesterEmail) : [],
      dueAt: r.dueAt.toISOString(),
      overdue: open && r.dueAt < new Date(),
      assignee,
      resolution: r.resolution,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async list(me: Me) {
    assertDpdp(me);
    const rows = await this.prisma.dataRequest.findMany({ where: { orgId: me.orgId }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }], take: 200 });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async create(me: Me, body: unknown, ip?: string) {
    assertDpdp(me);
    const input = parse(dataRequestCreateSchema, body);
    const r = await this.prisma.dataRequest.create({
      data: { orgId: me.orgId, kind: input.kind, subjectType: 'lead', requesterName: input.requesterName, requesterEmail: input.requesterEmail.toLowerCase(), details: input.details ?? null, dueAt: new Date(Date.now() + DATA_REQUEST_DAYS * DAY), createdById: me.id },
    });
    await this.audit.log(me, 'privacy.request_logged', 'DataRequest', r.id, undefined, { kind: r.kind }, ip);
    return this.view(r);
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    assertDpdp(me);
    const r = await this.prisma.dataRequest.findFirst({ where: { id, orgId: me.orgId } });
    if (!r) throw new NotFoundException('Request not found');
    const input = parse(dataRequestUpdateSchema, body);
    if ((input.status === 'done' || input.status === 'rejected') && !(input.resolution ?? r.resolution)) throw new BadRequestException('Write what was done (or why it was refused) before closing the request');
    const updated = await this.prisma.dataRequest.update({
      where: { id },
      data: { ...input, completedAt: input.status === 'done' || input.status === 'rejected' ? new Date() : input.status ? null : undefined },
    });
    await this.audit.log(me, 'privacy.request_updated', 'DataRequest', id, { status: r.status }, input, ip);
    return this.view(updated);
  }

  /** Everything held about one lead or person, as JSON (for an access request). */
  async exportSubject(me: Me, type: 'lead' | 'user', id: string, ip?: string) {
    assertDpdp(me);
    if (type === 'lead') {
      const lead = await this.prisma.lead.findFirst({ where: { id, orgId: me.orgId }, include: { activities: true } });
      if (!lead) throw new NotFoundException('Lead not found');
      const consents = await this.prisma.consent.findMany({ where: { orgId: me.orgId, subjectType: 'lead', subjectId: id } });
      await this.audit.log(me, 'privacy.data_exported', 'Lead', id, undefined, { type }, ip);
      return { exportedAt: new Date().toISOString(), lead: { id: lead.id, contact: lead.contact, need: lead.need, source: lead.source, stage: lead.stage, createdAt: lead.createdAt, customFields: lead.customFields }, activity: lead.activities.map((a) => ({ kind: a.kind, body: a.body, at: a.at })), consents };
    }
    const user = await this.prisma.user.findFirst({ where: { id, orgId: me.orgId }, select: { id: true, name: true, email: true, phone: true, type: true, status: true, createdAt: true } });
    if (!user) throw new NotFoundException('Person not found');
    const [messages, sessions, consents] = await Promise.all([
      this.prisma.message.findMany({ where: { authorId: id }, select: { body: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 5000 }),
      this.prisma.userSession.findMany({ where: { userId: id }, select: { method: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, revokedAt: true } }),
      this.prisma.consent.findMany({ where: { orgId: me.orgId, OR: [{ subjectType: 'user', subjectId: id }, ...(user.email ? [{ email: user.email }] : [])] } }),
    ]);
    await this.audit.log(me, 'privacy.data_exported', 'User', id, undefined, { type }, ip);
    return { exportedAt: new Date().toISOString(), person: user, messages, sessions, consents };
  }

  /** Erasure for a lead: contact details and free text are removed, the record stays for the sales numbers. */
  async eraseLead(me: Me, id: string, ip?: string) {
    assertDpdp(me);
    const lead = await this.prisma.lead.findFirst({ where: { id, orgId: me.orgId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.stage === 'won') throw new BadRequestException('This lead became a client. Use Data Export / Deletion for the client instead.');
    await this.anonymiseLead(id);
    await this.audit.log(me, 'privacy.lead_erased', 'Lead', id, undefined, { stage: lead.stage }, ip);
    return { ok: true as const };
  }

  private async anonymiseLead(id: string) {
    await this.prisma.lead.update({ where: { id }, data: { contact: { name: 'Erased', company: null, email: null, phone: null }, need: '(erased on request)', customFields: {} } });
    await this.prisma.leadActivity.updateMany({ where: { leadId: id }, data: { body: '(erased)' } });
    await this.prisma.consent.updateMany({ where: { subjectType: 'lead', subjectId: id }, data: { email: null, phone: null, withdrawnAt: new Date() } });
  }

  // ---------------------------------------------------------------------------------------------- consents

  async withdrawConsent(me: Me, id: string, ip?: string) {
    assertDpdp(me);
    const c = await this.prisma.consent.findFirst({ where: { id, orgId: me.orgId } });
    if (!c) throw new NotFoundException('Consent not found');
    await this.prisma.consent.update({ where: { id }, data: { withdrawnAt: new Date(), granted: false } });
    await this.audit.log(me, 'privacy.consent_withdrawn', 'Consent', id, undefined, { purpose: c.purpose }, ip);
    return { ok: true as const };
  }

  /** Public: "stop sending me marketing" from an email link or the privacy page. */
  async withdrawByEmail(orgId: string, email: string, purpose: string) {
    const r = await this.prisma.consent.updateMany({ where: { orgId, email: email.toLowerCase(), purpose, withdrawnAt: null }, data: { withdrawnAt: new Date(), granted: false } });
    if (r.count) await this.audit.logSystem(orgId, 'privacy.consent_withdrawn', 'Consent', email.toLowerCase(), { purpose, count: r.count });
    return { withdrawn: r.count };
  }

  // ---------------------------------------------------------------------------------------------- retention

  async retention(orgId: string): Promise<RetentionRuleView[]> {
    const rows = await this.prisma.retentionRule.findMany({ where: { orgId } });
    return RETENTION_TYPES.map((t) => {
      const r = rows.find((x) => x.recordType === t.recordType);
      return { recordType: t.recordType, label: t.label, keepDays: r?.keepDays ?? t.defaultDays, action: (r?.action ?? t.actions[0]) as 'anonymise' | 'delete', enabled: r?.enabled ?? false, lastRunAt: r?.lastRunAt?.toISOString() ?? null, lastCount: r?.lastCount ?? null, actions: t.actions };
    });
  }

  async saveRetention(me: Me, body: unknown, ip?: string) {
    assertDpdp(me);
    const { rules } = parse(retentionSaveSchema, body);
    for (const r of rules) {
      const t = RETENTION_TYPES.find((x) => x.recordType === r.recordType);
      if (!t) throw new BadRequestException(`Unknown record type ${r.recordType}`);
      if (!(t.actions as readonly string[]).includes(r.action)) throw new BadRequestException(`${t.label} can only be ${t.actions.join(' or ')}d`);
      // Invoices and payments are never on this list: GST law needs them for 8 years.
      await this.prisma.retentionRule.upsert({ where: { orgId_recordType: { orgId: me.orgId, recordType: r.recordType } }, create: { orgId: me.orgId, ...r }, update: r });
    }
    await this.audit.log(me, 'privacy.retention_saved', 'Organisation', me.orgId, undefined, { rules }, ip);
    return this.retention(me.orgId);
  }

  private lastRunDay = '';
  private async maybeRunRetention(now = new Date()) {
    const ist = new Date(now.getTime() + 330 * 60_000);
    const day = ist.toISOString().slice(0, 10);
    if (ist.getUTCHours() < 2 || this.lastRunDay === day) return;
    this.lastRunDay = day;
    if (!(await claimOnce(this.prisma, `security.retention:${day}`))) return;
    const orgs = await this.prisma.retentionRule.findMany({ where: { enabled: true }, distinct: ['orgId'], select: { orgId: true } });
    for (const o of orgs) await this.runRetention(o.orgId, now);
  }

  /** Applies every enabled rule now. Returns how many records each rule touched. */
  async runRetention(orgId: string, now = new Date()) {
    const rules = await this.prisma.retentionRule.findMany({ where: { orgId, enabled: true } });
    const out: Record<string, number> = {};
    for (const r of rules) {
      const before = new Date(now.getTime() - r.keepDays * DAY);
      const n = await this.apply(orgId, r.recordType as RetentionType, r.action, before);
      out[r.recordType] = n;
      await this.prisma.retentionRule.update({ where: { id: r.id }, data: { lastRunAt: now, lastCount: n } });
    }
    if (rules.length) await this.audit.logSystem(orgId, 'privacy.retention_ran', 'Organisation', orgId, out);
    return out;
  }

  private async apply(orgId: string, type: RetentionType, action: string, before: Date): Promise<number> {
    switch (type) {
      case 'lost_lead': {
        const rows = await this.prisma.lead.findMany({ where: { orgId, stage: 'lost', updatedAt: { lt: before }, NOT: { need: '(erased on request)' } }, select: { id: true } });
        if (action === 'delete') return (await this.prisma.lead.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deletedAt: new Date() } })).count;
        for (const r of rows) await this.anonymiseLead(r.id);
        return rows.length;
      }
      case 'otp_code':
        return (await this.prisma.otpCode.deleteMany({ where: { createdAt: { lt: before } } })).count;
      case 'notification':
        return (await this.prisma.notification.deleteMany({ where: { orgId, readAt: { not: null, lt: before } } })).count;
      case 'email_outbox':
        return (await this.prisma.emailOutbox.deleteMany({ where: { orgId, createdAt: { lt: before } } })).count;
      case 'webhook_delivery':
        return (await this.prisma.webhookDelivery.deleteMany({ where: { orgId, createdAt: { lt: before }, status: { not: 'pending' } } })).count;
      case 'form_submission':
        if (action === 'delete') return (await this.prisma.formSubmission.deleteMany({ where: { orgId, createdAt: { lt: before } } })).count;
        return (await this.prisma.formSubmission.updateMany({ where: { orgId, createdAt: { lt: before } }, data: { data: {}, ipHash: null } })).count;
      case 'audit_ip':
        // The hash chain leaves out IP addresses on purpose, so clearing them keeps the chain valid.
        return (await this.prisma.auditEvent.updateMany({ where: { orgId, at: { lt: before }, ip: { not: null } }, data: { ip: null } })).count;
      case 'revoked_session':
        return (await this.prisma.userSession.deleteMany({ where: { orgId, revokedAt: { not: null, lt: before } } })).count;
    }
  }

  // ---------------------------------------------------------------------------------------------- overview

  async overview(me: Me): Promise<DpdpOverview> {
    assertDpdp(me);
    const [requests, retention, total, marketing, withdrawn, recent] = await Promise.all([
      this.list(me),
      this.retention(me.orgId),
      this.prisma.consent.count({ where: { orgId: me.orgId } }),
      this.prisma.consent.count({ where: { orgId: me.orgId, purpose: 'marketing', withdrawnAt: null } }),
      this.prisma.consent.count({ where: { orgId: me.orgId, withdrawnAt: { not: null } } }),
      this.prisma.consent.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    return {
      requests,
      retention,
      consents: { total, marketing, withdrawn, recent: recent.map((c): ConsentView => ({ id: c.id, subjectType: c.subjectType, subjectId: c.subjectId, email: c.email, phone: c.phone, purpose: c.purpose as ConsentView['purpose'], granted: c.granted, source: c.source, noticeVersion: c.noticeVersion, createdAt: c.createdAt.toISOString(), withdrawnAt: c.withdrawnAt?.toISOString() ?? null })) },
      noticeVersion: PRIVACY_NOTICE_VERSION,
      breachRunbook: BREACH_RUNBOOK,
    };
  }
}

export const withdrawSchema = z.object({ email: z.string().trim().email(), purpose: z.enum(['marketing', 'whatsapp', 'analytics']) });
