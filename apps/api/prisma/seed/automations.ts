import { AUTOMATION_TEMPLATES, automationRuleInputSchema, formatINR, type AutomationRunDetail, type AutomationStep } from '@bmu/shared';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

// v9 automations demo data: the most useful recipes installed as rules, plus ~60 runs over the last
// 30 days so the dashboard and log look alive. Idempotent: rules are matched by templateKey (a deleted one
// is not brought back), demo runs by their "demo:" dedupe keys, which never collide with the real engine's.

const INSTALL: { key: string; enabled: boolean }[] = [
  { key: 'escalate_overdue_10d', enabled: true },
  { key: 'welcome_new_leads', enabled: true },
  { key: 'sla_missed_alert', enabled: true },
  { key: 'blocked_task_head', enabled: true },
  // Messages clients, so it starts switched off until the team has read the wording.
  { key: 'payment_reminder_3d', enabled: false },
];

const DAY = 86_400_000;

export async function seedAutomations(prisma: PrismaClient, orgId: string) {
  const founder = await prisma.user.findFirst({ where: { orgId, email: 'founder@bmu.demo' }, select: { id: true } });
  const rules: Record<string, { id: string; name: string }> = {};
  for (const { key, enabled } of INSTALL) {
    const t = AUTOMATION_TEMPLATES.find((x) => x.key === key)!;
    const existing = await prisma.automationRule.findFirst({ where: { orgId, templateKey: key, createdById: founder?.id ?? null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
    if (existing) {
      rules[key] = existing;
      continue;
    }
    const d = automationRuleInputSchema.parse(t.rule);
    rules[key] = await prisma.automationRule.create({
      data: {
        orgId,
        name: t.name,
        description: t.description,
        enabled,
        trigger: d.trigger,
        triggerArgs: d.triggerArgs,
        conditions: d.conditions,
        actions: JSON.parse(JSON.stringify(d.actions)),
        templateKey: key,
        createdById: founder?.id ?? null,
        createdAt: new Date(Date.now() - 32 * DAY),
        watermark: new Date(),
      },
      select: { id: true, name: true },
    });
  }

  const ruleIds = Object.values(rules).map((r) => r.id);
  const already = await prisma.automationRun.count({ where: { ruleId: { in: ruleIds }, dedupeKey: { startsWith: 'demo:' } } });
  if (already >= 50) return;

  // Real records to point at where we have them; stable fallbacks otherwise.
  const [invoices, leads, requests, tasks, staff] = await Promise.all([
    prisma.invoice.findMany({ where: { orgId, status: { not: 'draft' }, NOT: [{ number: { startsWith: 'AUTO/' } }, { number: { startsWith: 'TEST/' } }] }, include: { clientOrg: { select: { name: true } } }, take: 12, orderBy: { createdAt: 'desc' } }),
    prisma.lead.findMany({ where: { orgId, deletedAt: null, NOT: { source: { startsWith: 'e2e-' } } }, take: 12, orderBy: { createdAt: 'desc' } }),
    prisma.request.findMany({ where: { orgId }, include: { engagement: { select: { clientOrg: { select: { name: true } } } } }, take: 12, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({ where: { orgId }, include: { deliverable: { select: { id: true } } }, take: 12, orderBy: { createdAt: 'desc' } }),
    prisma.user.findMany({ where: { orgId, email: { endsWith: '.demo' } }, select: { email: true, name: true } }),
  ]);
  const nameOf = (email: string, fallback: string) => staff.find((s) => s.email === email)?.name ?? fallback;
  const am = nameOf('am@bmu.demo', 'Neha Iyer');
  const amLead = nameOf('am.lead@bmu.demo', 'Kiran Rao');
  const head = nameOf('design.head@bmu.demo', 'Arjun Das');
  const sales = [nameOf('sales@bmu.demo', 'Priya Shah'), nameOf('sales.manager@bmu.demo', 'Rahul Menon')];
  const clients = ['Sunrise Realty Pvt Ltd', 'Kaveri Foods', 'Nimbus Fitness', 'Lotus Dental Care', 'Indigo Interiors'];
  const pick = <T>(arr: T[], i: number) => (arr.length ? arr[i % arr.length] : undefined);

  type Demo = { ruleKey: string; entity: string; entityId: string; status: 'success' | 'failed' | 'skipped'; detail: AutomationRunDetail };
  const make = (i: number): Demo => {
    const r = i % 10;
    if (r <= 2) {
      const inv = pick(invoices, i);
      const client = inv?.clientOrg?.name ?? pick(clients, i)!;
      const number = inv?.number ?? `BMU/2026-27/${String(100 + i).padStart(4, '0')}`;
      const amount = formatINR(inv?.totalPaise ?? 4_720_000 + i * 11_800);
      const failed = i === 12;
      const steps: AutomationStep[] = [
        { action: 'notify', ok: true, text: `Alerted Founder: "${client} is 10 days late on invoice ${number} (${amount} owed)."` },
        failed ? { action: 'notify', ok: false, text: 'Could not notify: the account manager account was suspended' } : { action: 'notify', ok: true, text: `Alerted ${am}: "${client} is 10 days late on invoice ${number}. Please call them today."` },
      ];
      return { ruleKey: 'escalate_overdue_10d', entity: 'Invoice', entityId: inv?.id ?? `demo-invoice-${i}`, status: failed ? 'failed' : 'success', detail: { summary: failed ? `1 of 2 actions failed for Invoice ${number} · ${client}` : `2 actions done for Invoice ${number} · ${client}`, record: `Invoice ${number} · ${client}`, link: inv ? `/admin/finance/invoices/${inv.id}` : null, steps, demo: true } };
    }
    if (r <= 5) {
      const lead = pick(leads, i);
      const c = (lead?.contact ?? {}) as { name?: string; company?: string };
      const who = c.name ?? `Lead ${i}`;
      const owner = sales[i % 2];
      const skipped = i === 24 || i === 44 || i === 53;
      const steps: AutomationStep[] = skipped
        ? [
            { action: 'assign_lead_owner', ok: true, skipped: true, text: `Skipped: the lead already belongs to ${owner}` },
            { action: 'create_task', ok: true, skipped: true, text: 'Skipped task: the owner already has a call booked' },
          ]
        : [
            { action: 'assign_lead_owner', ok: true, text: `Assigned the lead to ${owner} (next in turn)` },
            { action: 'create_task', ok: true, text: `Created task "Call ${who} (${c.company ?? who}) about social media" for ${owner}, due today` },
          ];
      return { ruleKey: 'welcome_new_leads', entity: 'Lead', entityId: lead?.id ?? `demo-lead-${i}`, status: skipped ? 'skipped' : 'success', detail: { summary: skipped ? `Nothing to do for Lead ${who}` : `2 actions done for Lead ${who}`, record: `Lead ${who}${c.company && c.company !== who ? ` · ${c.company}` : ''}`, link: '/team/leads', steps, demo: true } };
    }
    if (r <= 7) {
      const req = pick(requests, i);
      const client = req?.engagement.clientOrg.name ?? pick(clients, i)!;
      const failed = i === 37;
      const steps: AutomationStep[] = [
        { action: 'notify', ok: true, text: `Alerted ${am}: "${client}'s change request is waiting for a reply."` },
        failed ? { action: 'notify', ok: false, text: 'Could not notify: the database was busy' } : { action: 'notify', ok: true, text: `Alerted ${amLead}: "Reply time missed for ${client} (change request)."` },
      ];
      return { ruleKey: 'sla_missed_alert', entity: 'Request', entityId: req?.id ?? `demo-request-${i}`, status: failed ? 'failed' : 'success', detail: { summary: failed ? `1 of 2 actions failed for Change request · ${client}` : `2 actions done for Change request · ${client}`, record: `Change request · ${client}`, link: req ? `/team/requests/${req.id}` : null, steps, demo: true } };
    }
    const task = pick(tasks, i);
    const title = task?.title ?? 'Reel edit for launch week';
    const failed = i === 9 || i === 58;
    const steps: AutomationStep[] = [failed ? { action: 'notify', ok: false, text: 'Could not notify: this task has no department head' } : { action: 'notify', ok: true, text: `Alerted ${head}: "${title} is blocked: waiting for brand fonts from the client"` }];
    return { ruleKey: 'blocked_task_head', entity: 'Task', entityId: task?.id ?? `demo-task-${i}`, status: failed ? 'failed' : 'success', detail: { summary: failed ? `1 of 1 actions failed for Task "${title}"` : `1 action done for Task "${title}"`, record: `Task "${title}"`, link: task?.deliverable ? `/team/deliverables/${task.deliverable.id}` : '/team/tasks', steps, demo: true } };
  };

  const now = Date.now();
  const total = 62;
  for (let i = 0; i < total; i++) {
    const d = make(i);
    const rule = rules[d.ruleKey];
    // Spread over 30 days, a little busier recently, inside IST working hours.
    const daysAgo = Math.floor(((total - i) / total) ** 1.3 * 29);
    const at = new Date(now - daysAgo * DAY);
    at.setUTCHours(4 + (i % 8), (i * 17) % 60, 0, 0);
    if (at.getTime() > now) at.setTime(now - (i + 1) * 60_000);
    await prisma.automationRun.upsert({
      where: { ruleId_entity_entityId_dedupeKey: { ruleId: rule.id, entity: d.entity, entityId: d.entityId, dedupeKey: `demo:${i}` } },
      update: {},
      create: { orgId, ruleId: rule.id, entity: d.entity, entityId: d.entityId, dedupeKey: `demo:${i}`, status: d.status, detail: JSON.parse(JSON.stringify(d.detail)), at },
    });
  }
  for (const r of Object.values(rules)) {
    const [count, last] = await Promise.all([
      prisma.automationRun.count({ where: { ruleId: r.id } }),
      prisma.automationRun.findFirst({ where: { ruleId: r.id }, orderBy: { at: 'desc' }, select: { at: true } }),
    ]);
    await prisma.automationRule.update({ where: { id: r.id }, data: { runCount: count, lastRunAt: last?.at ?? null } });
  }
}
