// Workflow-only actions: score a lead, queue a WhatsApp, change a status, set a custom field, hand over work.
// Like the automation actions, each describes what it did (or would do) in plain words.
import { automationFill, customFieldCoerce, sellLeadScore, WORKFLOW_SET_STATUS, type AutomationStep, type CustomFieldEntity, type WorkflowAction } from '@bmu/shared';
import type { ActionCtx } from '../automations/actions.js';
import { contactOf } from '../clients-actions/clients-access.js';
import { logLeadActivity } from '../proposals/lead-activity.js';
import { CUSTOM_MODEL, customTarget, readCustomValues } from './facts.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const OPEN_LEAD = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;

type Extra = Extract<WorkflowAction, { type: 'score_lead' | 'send_whatsapp' | 'set_status' | 'set_custom_field' | 'reassign_open_work' }>;
export const isExtraAction = (a: WorkflowAction): a is Extra => ['score_lead', 'send_whatsapp', 'set_status', 'set_custom_field', 'reassign_open_work'].includes(a.type);

const step = (ok: boolean, text: string, skipped = false): AutomationStep => ({ action: 'notify', ok, text, ...(skipped ? { skipped: true } : {}) });
const contactJson = (c: unknown) => (c ?? {}) as { name?: string; email?: string; phone?: string; company?: string };
const digits = (p: string) => p.replace(/[^\d+]/g, '');

export async function runExtraAction(ctx: ActionCtx, a: Extra): Promise<AutomationStep> {
  const s = ctx.subject;
  const fill = (tpl: string) => automationFill(tpl, { record: s.record, ...s.vars });
  switch (a.type) {
    case 'score_lead': {
      if (!s.leadId) return step(true, 'Skipped scoring: no lead on this record', true);
      const lead = await ctx.prisma.lead.findUnique({ where: { id: s.leadId }, select: { budgetPaise: true, serviceIds: true, contact: true, score: true } });
      if (!lead) return step(false, 'The lead no longer exists');
      const r = sellLeadScore(lead.budgetPaise, lead.serviceIds.length, !!contactJson(lead.contact).company);
      const why = r.parts.map((p) => `${p.label} ${p.points}/${p.max}`).join('; ');
      if (!ctx.dryRun) {
        if (r.score !== lead.score) await ctx.prisma.lead.update({ where: { id: s.leadId }, data: { score: r.score } });
        await ctx.audit.logSystem(ctx.orgId, 'lead.scored', 'Lead', s.leadId, { score: r.score, from: lead.score, byWorkflow: ctx.rule.id });
      }
      s.fields.score = r.score;
      s.vars.score = r.score;
      return step(true, `${ctx.dryRun ? 'Would score' : 'Scored'} the lead ${r.score}/100 (${why})`);
    }

    case 'send_whatsapp': {
      let to: { name: string | null; phone: string | null } = { name: null, phone: null };
      if (a.to === 'lead') {
        if (!s.leadId) return step(true, 'Skipped WhatsApp: no lead on this record', true);
        const lead = await ctx.prisma.lead.findUnique({ where: { id: s.leadId }, select: { contact: true } });
        const c = contactJson(lead?.contact);
        to = { name: c.name ?? c.company ?? null, phone: c.phone ?? null };
      } else {
        if (!s.clientOrgId) return step(true, 'Skipped WhatsApp: this record has no client account yet', true);
        const client = await ctx.prisma.clientOrg.findUnique({ where: { id: s.clientOrgId }, select: { primaryContact: true, name: true } });
        const c = client ? contactOf(client) : { name: null, phone: null };
        to = { name: c.name ?? client?.name ?? null, phone: c.phone };
      }
      if (!to.phone || digits(to.phone).replace('+', '').length < 10) return step(true, `Skipped WhatsApp: ${to.name ?? 'the contact'} has no phone number`, true);
      const body = fill(a.message).slice(0, 1000);
      if (!ctx.dryRun) {
        await ctx.prisma.whatsAppMessage.create({ data: { orgId: ctx.orgId, toPhone: digits(to.phone), toName: to.name, body, entity: s.entity, entityId: s.entityId, source: `workflow:${ctx.rule.id}` } });
        if (s.leadId && a.to === 'lead') await logLeadActivity(ctx.prisma, { orgId: ctx.orgId, leadId: s.leadId, kind: 'whatsapp', body: `WhatsApp (workflow "${ctx.rule.name}"): ${body}` });
      }
      return step(true, `${ctx.dryRun ? 'Would queue' : 'Queued'} a WhatsApp to ${to.name ?? to.phone} (${to.phone}): "${body.slice(0, 100)}${body.length > 100 ? '…' : ''}". It sends once WhatsApp Business is connected.`);
    }

    case 'set_status': {
      const allowed = WORKFLOW_SET_STATUS[s.entity] ?? [];
      const label = allowed.find((o) => o.value === a.status)?.label;
      if (!label) return step(false, `A workflow can't move a ${s.entity.toLowerCase()} to "${a.status}"`);
      let from: string | null = null;
      if (s.entity === 'Deliverable') {
        const d = await ctx.prisma.deliverable.findUnique({ where: { id: s.entityId }, select: { status: true } });
        if (!d) return step(false, 'The deliverable no longer exists');
        from = d.status;
        if (from === a.status) return step(true, `Skipped: it is already ${label}`, true);
        if (from === 'published' && a.status === 'scheduled') return step(true, 'Skipped: it is already published', true);
        if (!ctx.dryRun) await ctx.prisma.deliverable.update({ where: { id: s.entityId }, data: { status: a.status as 'scheduled' | 'published', ...(a.status === 'published' ? { publishedAt: ctx.now } : {}) } });
      } else if (s.entity === 'Task') {
        const t = await ctx.prisma.task.findUnique({ where: { id: s.entityId }, select: { status: true } });
        if (!t) return step(false, 'The task no longer exists');
        from = t.status;
        if (from === a.status) return step(true, `Skipped: it is already ${label}`, true);
        if (!ctx.dryRun) await ctx.prisma.task.update({ where: { id: s.entityId }, data: { status: a.status as 'in_progress' | 'waiting' | 'done' | 'cancelled' } });
      } else if (s.entity === 'Request') {
        const r = await ctx.prisma.request.findUnique({ where: { id: s.entityId }, select: { status: true } });
        if (!r) return step(false, 'The request no longer exists');
        from = r.status;
        if (from === a.status) return step(true, `Skipped: it is already ${label}`, true);
        if (!ctx.dryRun) await ctx.prisma.request.update({ where: { id: s.entityId }, data: { status: a.status as 'in_progress' | 'done' | 'rescheduled' } });
      }
      if (!ctx.dryRun) await ctx.audit.logSystem(ctx.orgId, `${s.entity.toLowerCase()}.status_changed`, s.entity, s.entityId, { from, status: a.status, byWorkflow: ctx.rule.id });
      return step(true, `${ctx.dryRun ? 'Would move' : 'Moved'} ${s.record} to ${label}`);
    }

    case 'set_custom_field': {
      const [, entity, key] = a.field.split('.') as [string, CustomFieldEntity, string];
      const def = await ctx.prisma.customFieldDef.findFirst({ where: { orgId: ctx.orgId, entity, key, archivedAt: null } });
      if (!def) return step(false, `The custom field "${key}" no longer exists`);
      const id = customTarget(s, entity);
      if (!id) return step(true, `Skipped: this record has no ${entity} to set "${def.label}" on`, true);
      const coerced = customFieldCoerce(def, fill(a.value));
      if ('error' in coerced) return step(false, coerced.error);
      if (!ctx.dryRun) {
        const current = (await readCustomValues(ctx.prisma, entity, id)) ?? {};
        const next = JSON.parse(JSON.stringify({ ...current, [key]: coerced.value }));
        const model = CUSTOM_MODEL[entity];
        // One delegate per type keeps Prisma's types happy.
        if (model === 'lead') await ctx.prisma.lead.update({ where: { id }, data: { customFields: next } });
        else if (model === 'clientOrg') await ctx.prisma.clientOrg.update({ where: { id }, data: { customFields: next } });
        else if (model === 'engagement') await ctx.prisma.engagement.update({ where: { id }, data: { customFields: next } });
        else if (model === 'request') await ctx.prisma.request.update({ where: { id }, data: { customFields: next } });
        else await ctx.prisma.creator.update({ where: { id }, data: { customFields: next } });
        await ctx.audit.logSystem(ctx.orgId, 'custom_field.set', entity, id, { key, value: coerced.value, byWorkflow: ctx.rule.id });
      }
      return step(true, `${ctx.dryRun ? 'Would set' : 'Set'} ${def.label} to "${coerced.value ?? 'empty'}"`);
    }

    case 'reassign_open_work': {
      if (s.entity !== 'User') return step(true, 'Skipped: this only works when someone is offboarding', true);
      const leaver = await ctx.prisma.user.findUnique({ where: { id: s.entityId }, select: { id: true, name: true, managerId: true } });
      if (!leaver) return step(false, 'The person no longer exists');
      let target: { id: string; name: string } | null = null;
      if (a.to === 'manager') target = leaver.managerId ? await ctx.prisma.user.findFirst({ where: { id: leaver.managerId, deletedAt: null, status: 'active' }, select: { id: true, name: true } }) : null;
      else if (a.to === 'user') target = a.userId ? await ctx.prisma.user.findFirst({ where: { id: a.userId, orgId: ctx.orgId, deletedAt: null, status: 'active', type: 'staff' }, select: { id: true, name: true } }) : null;
      else {
        const pool = await ctx.prisma.user.findMany({ where: { orgId: ctx.orgId, deletedAt: null, status: 'active', type: 'staff', id: { not: leaver.id }, roles: { some: { role: { baseRole: a.role ?? '' } } } }, select: { id: true, name: true } });
        let best: { u: (typeof pool)[number]; load: number } | null = null;
        for (const u of pool) {
          const load = await ctx.prisma.task.count({ where: { ownerId: u.id, status: { in: [...OPEN_TASK] } } });
          if (!best || load < best.load) best = { u, load };
        }
        target = best?.u ?? null;
      }
      if (!target || target.id === leaver.id) return step(true, `Skipped handover: ${a.to === 'manager' ? `${leaver.name} has no active manager` : 'nobody active to hand the work to'}`, true);
      const [tasks, leads] = await Promise.all([
        ctx.prisma.task.findMany({ where: { orgId: ctx.orgId, ownerId: leaver.id, status: { in: [...OPEN_TASK] }, archivedAt: null }, select: { id: true } }),
        ctx.prisma.lead.findMany({ where: { orgId: ctx.orgId, ownerId: leaver.id, stage: { in: [...OPEN_LEAD] }, deletedAt: null, archivedAt: null }, select: { id: true } }),
      ]);
      const words = `${tasks.length} open task${tasks.length === 1 ? '' : 's'} and ${leads.length} open lead${leads.length === 1 ? '' : 's'}`;
      if (!tasks.length && !leads.length) return step(true, `Skipped handover: ${leaver.name} has no open tasks or leads`, true);
      if (!ctx.dryRun) {
        await ctx.prisma.task.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { ownerId: target.id } });
        await ctx.prisma.lead.updateMany({ where: { id: { in: leads.map((l) => l.id) } }, data: { ownerId: target.id } });
        const by = ctx.systemAuthorId ?? target.id;
        await ctx.prisma.assignment.createMany({
          data: [...tasks.map((t) => ({ type: 'task', id: t.id })), ...leads.map((l) => ({ type: 'lead', id: l.id }))].map((m) => ({ orgId: ctx.orgId, targetType: m.type, targetId: m.id, fromUserId: leaver.id, toUserId: target!.id, reason: 'offboarding', note: `Workflow "${ctx.rule.name}"`, byId: by })),
        });
        await ctx.audit.logSystem(ctx.orgId, 'offboarding.work_reassigned', 'User', leaver.id, { tasks: tasks.length, leads: leads.length, toUserId: target.id, toName: target.name, byWorkflow: ctx.rule.id });
      }
      return step(true, `${ctx.dryRun ? 'Would move' : 'Moved'} ${words} from ${leaver.name} to ${target.name}`);
    }
  }
}
