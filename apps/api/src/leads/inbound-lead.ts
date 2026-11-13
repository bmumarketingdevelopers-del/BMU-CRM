// A lead from outside (website enquiry, package builder, v14 forms): scored, duplicate-checked, first-reply
// timer started, and the earlier owner told when the same contact enquires again.
import { addWorkingMinutes, OPS_LEAD_FIRST_REPLY_MINUTES, PRIVACY_NOTICE_VERSION, sellLeadScore } from '@bmu/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { logLeadActivity } from '../proposals/lead-activity.js';
import { calendarFor } from '../production/generate.js';

const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '').slice(-10);
const OPEN_STAGES = ['new', 'contacted', 'discovery', 'proposal_sent'];

export type InboundLead = {
  orgId: string;
  source: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  need: string;
  budgetPaise: number | null;
  serviceIds: string[];
  customFields?: Record<string, unknown>;
  /** Shown in the lead's activity as where it came from, e.g. 'Form "Diwali offer"'. */
  via?: string;
  /** v20 DPDP: what the person agreed to on the form, and from where. */
  consent?: { marketing?: boolean; whatsapp?: boolean; source?: string; ip?: string | null };
  /** Who the lead goes to straight away (a booking link's host). Leads with nobody on them alert the sales leaders. */
  ownerId?: string | null;
};

const dueFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/**
 * Who hears about a new outside lead that nobody owns yet: the Founder, Branch Managers (admin), Sales Managers and
 * the head of the Sales department, but only those whose roles can open leads (Roles & Permissions, leads_pipeline).
 */
export async function leadAlertRecipients(prisma: PrismaService, orgId: string): Promise<string[]> {
  const salesDepts = await prisma.department.findMany({ where: { orgId, deletedAt: null, headUserId: { not: null }, name: { contains: 'sales', mode: 'insensitive' } }, select: { headUserId: true } });
  const heads = salesDepts.map((d) => d.headUserId!);
  const users = await prisma.user.findMany({
    where: {
      orgId,
      type: 'staff',
      status: 'active',
      deletedAt: null,
      OR: [{ roles: { some: { role: { baseRole: { in: ['founder', 'admin', 'sales_manager'] } } } } }, ...(heads.length ? [{ id: { in: heads } }] : [])],
    },
    select: { id: true, roles: { select: { role: { select: { permissions: { where: { capability: 'leads_pipeline' }, select: { scope: true } } } } } } },
  });
  return users.filter((u) => u.roles.some((r) => r.role.permissions.some((p) => p.scope !== 'none'))).map((u) => u.id);
}

/** Same email or phone as an earlier lead: prefer an open one, then the newest. */
export async function findDuplicateLead(prisma: PrismaService, orgId: string, email?: string | null, phone?: string | null) {
  const e = email?.trim().toLowerCase();
  const p = digits(phone);
  if (!e && p.length < 10) return null;
  const leads = await prisma.lead.findMany({ where: { orgId, deletedAt: null }, select: { id: true, contact: true, stage: true, ownerId: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
  const matches = leads.filter((l) => {
    const c = (l.contact ?? {}) as { email?: string; phone?: string };
    return (!!e && c.email?.trim().toLowerCase() === e) || (p.length === 10 && digits(c.phone) === p);
  });
  return matches.find((m) => OPEN_STAGES.includes(m.stage)) ?? matches[0] ?? null;
}

export async function createInboundLead(deps: { prisma: PrismaService; audit: AuditService; notifications: NotificationsService }, input: InboundLead) {
  const { prisma, audit, notifications } = deps;
  const original = await findDuplicateLead(prisma, input.orgId, input.email, input.phone);
  const lead = await prisma.lead.create({
    data: {
      orgId: input.orgId,
      source: input.source,
      contact: { name: input.name ?? undefined, email: input.email ?? undefined, phone: input.phone ?? undefined, company: input.company ?? undefined },
      need: input.need,
      budgetPaise: input.budgetPaise,
      serviceIds: input.serviceIds,
      score: sellLeadScore(input.budgetPaise, input.serviceIds.length, !!input.company).score,
      duplicateOfId: original?.id ?? null,
      // A repeat enquiry stays with the person who already knows this contact.
      ownerId: input.ownerId ?? (original && OPEN_STAGES.includes(original.stage) ? original.ownerId : null),
      // v11 ops: the first-reply timer starts (working hours, 120 minutes).
      firstReplyDueAt: addWorkingMinutes(new Date(), OPS_LEAD_FIRST_REPLY_MINUTES, await calendarFor(prisma, input.orgId)),
      customFields: JSON.parse(JSON.stringify(input.customFields ?? {})),
    },
  });
  await logLeadActivity(prisma, { orgId: input.orgId, leadId: lead.id, kind: 'enquiry', body: input.via ? `${input.via}: ${input.need}` : input.need });
  // v20 DPDP: consent records (replying to the enquiry is the purpose they gave it for; extras only when ticked).
  const purposes = ['service', ...(input.consent?.marketing ? ['marketing'] : []), ...(input.consent?.whatsapp ? ['whatsapp'] : [])];
  await prisma.consent.createMany({
    data: purposes.map((purpose) => ({ orgId: input.orgId, subjectType: 'lead', subjectId: lead.id, email: input.email?.trim().toLowerCase() || null, phone: input.phone || null, purpose, source: input.consent?.source ?? (input.source === 'website' ? 'website_enquiry' : 'form'), noticeVersion: PRIVACY_NOTICE_VERSION, ip: input.consent?.ip ?? null })),
  });
  // v19: website and inbox enquiries raise lead.created too, so webhooks see every new lead.
  await audit.logSystem(input.orgId, 'lead.created', 'Lead', lead.id, { source: input.source, via: input.via ?? null, duplicateOf: original?.id ?? null });
  if (original) {
    const when = original.stage === 'won' ? 'an existing client' : original.stage === 'lost' ? 'a lead marked lost earlier' : 'an open lead';
    await logLeadActivity(prisma, { orgId: input.orgId, leadId: original.id, kind: 'enquiry', body: `Repeat enquiry ${input.via ? `(${input.via})` : 'from the website'} (same email or phone): “${input.need}”` });
    await audit.logSystem(input.orgId, 'lead.duplicate_detected', 'Lead', lead.id, { duplicateOf: original.id });
    await notifications.notify(input.orgId, [original.ownerId], {
      kind: 'lead_duplicate',
      title: `${input.company || input.name} enquired again`,
      body: `Same email or phone as ${when}. Merge or keep separate.`,
      link: `/team/leads/${lead.id}`,
    });
  }
  // Nobody has this lead yet: tell the sales leaders straight away so someone picks it up within the reply time.
  if (!lead.ownerId) {
    const who = input.company || input.name || input.email || input.phone || 'Someone';
    const from = input.via ?? (input.source === 'website' ? 'Website enquiry' : 'New enquiry');
    await notifications.notify(input.orgId, await leadAlertRecipients(prisma, input.orgId), {
      kind: 'lead_new',
      title: `New lead: ${who}`,
      body: `${from} · reply by ${dueFmt.format(lead.firstReplyDueAt!)}. ${input.need.slice(0, 100)}`,
      link: `/team/leads/${lead.id}`,
    });
  }
  return lead;
}
