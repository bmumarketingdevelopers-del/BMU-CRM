// v15 the four agents: what each one looks at (facts for the model), its built-in basic plan (used without an AI key,
// when the agent's budget is used up, and in tests), and its instructions for AI mode. Both modes act only through
// the runtime gate (h.act), so the same policy and permission rules apply whoever planned the step.
import type { ModuleRef } from '@nestjs/core';
import { formatINR, REQUEST_TYPES, sellLeadScore, type AgentKey, type Me, type RequestType } from '@bmu/shared';
import { ReassignService } from '../actions/reassign.service.js';
import { fence, redact } from '../ai/ai-safety.js';
import { basicReply, basicTriage } from '../ai/ai-features.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { KnowledgeService } from './knowledge.service.js';
import type { ActOutcome } from './runtime.js';
import { producerBookings } from './finance-plan.js';

export type Subject = { type: 'Lead' | 'Request' | 'Version' | 'Daily' | 'Monthly' | 'Question'; id: string; label: string };

export type PlanHelpers = {
  prisma: PrismaService;
  ref: ModuleRef;
  acting: Me;
  knowledge: KnowledgeService;
  act: (name: string, input: Record<string, unknown>) => Promise<ActOutcome>;
  note: (title: string, detail?: string) => Promise<void>;
  now: Date;
};

export type BasicResult = { summary: string; answer?: string | null };

const DAY = 86_400_000;
const istDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const dFmt = (d: Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const OPEN_TASK = { notIn: ['done', 'cancelled'] as ('done' | 'cancelled')[] };

export const leadLabel = (contact: unknown) => {
  const c = contact as { company?: string; name?: string };
  return c.company || c.name || 'Lead';
};

/** Tomorrow's working date (Sunday skipped) in IST, as YYYY-MM-DD. */
export function nextWorkingDate(now: Date): string {
  let d = new Date(now.getTime() + DAY);
  if (new Date(`${istDate(d)}T12:00:00+05:30`).getUTCDay() === 0) d = new Date(d.getTime() + DAY);
  return istDate(d);
}

// ----------------------------------------------------------------------------------------------- Sales assistant

export async function leadFacts(h: PlanHelpers, leadId: string) {
  const l = await h.prisma.lead.findFirstOrThrow({ where: { id: leadId, orgId: h.acting.orgId }, include: { owner: { select: { name: true } } } });
  const services = l.serviceIds.length ? await h.prisma.service.findMany({ where: { id: { in: l.serviceIds } }, select: { name: true } }) : [];
  const c = l.contact as { name?: string; company?: string; email?: string; phone?: string };
  return { lead: l, contact: c, services: services.map((s) => s.name) };
}

export async function salesBasic(h: PlanHelpers, leadId: string): Promise<BasicResult> {
  const { lead, contact, services } = await leadFacts(h, leadId);
  const score = sellLeadScore(lead.budgetPaise, lead.serviceIds.length, !!contact.company);
  await h.act('set_lead_score', { leadId, score: score.score, reason: score.parts.map((p) => `${p.label} ${p.points}/${p.max}`).join(', ') });
  const hits = await h.knowledge.search(h.acting, `${lead.need} ${services.join(' ')}`, 3).catch(() => []);
  const matched = hits.filter((x) => x.sourceType === 'service').map((x) => x.title.replace(/^Service: /, ''));
  const brief = [
    `Wants: ${redact(lead.need).slice(0, 200)}`,
    // v20: budget is a protected field, so notes say only whether one was given (the amount stays in the field).
    `Budget: ${lead.budgetPaise ? 'given (see the Budget field)' : 'not given, ask on the first call'}`,
    `Score ${score.score}/100 (${score.parts.map((p) => `${p.label} ${p.points}/${p.max}`).join(', ')})`,
    matched.length || services.length ? `Fits: ${[...new Set([...services, ...matched])].slice(0, 3).join(', ')}` : null,
    lead.duplicateOfId ? 'Possible duplicate of an earlier lead: check it on the lead page before calling.' : null,
    `Next step: call ${contact.name ?? 'them'} within working hours today; book a 15-minute discovery call.`,
  ]
    .filter(Boolean)
    .join('\n');
  await h.act('add_lead_note', { leadId, text: brief });
  if (!lead.nextFollowUpAt) await h.act('set_lead_follow_up', { leadId, date: nextWorkingDate(h.now) });
  if (!lead.ownerId) {
    const owner = await suggestOwner(h, 'lead_owner', leadId);
    if (owner) await h.act('assign_lead', { leadId, ownerId: owner.id, reason: owner.why });
  }
  const topic = services[0] ?? matched[0] ?? 'your enquiry';
  const text = `Hi ${contact.name?.split(/\s+/)[0] ?? 'there'},\n\nThank you for reaching out to BMU Marketing about ${topic}. We would love to understand your goals and suggest the right plan.\n\nCould we have a quick 15-minute call ${dFmt(new Date(`${nextWorkingDate(h.now)}T12:00:00+05:30`))} or the day after? Share a time that suits you.\n\nWarm regards,\nTeam BMU Marketing`;
  await h.act('send_lead_reply', { leadId, channel: contact.email ? 'email' : 'whatsapp', subject: contact.email ? `BMU Marketing: next steps on ${topic}` : undefined, text });
  return { summary: `Scored ${leadLabel(lead.contact)} ${score.score}/100, added a brief and drafted the first reply` };
}

/** Least-busy eligible person for a reassign target, from the acting person's point of view. */
async function suggestOwner(h: PlanHelpers, type: string, id: string): Promise<{ id: string; name: string; why: string } | null> {
  const c = await (h.ref.get(ReassignService as never, { strict: false }) as ReassignService).candidates(h.acting, type, [id], {}).catch(() => null);
  const all = (c?.candidates ?? []).filter((p) => !p.blockedReason && !p.current && !p.onLeaveToday);
  // Leads go to the sales team first (the Founder is eligible too, but only as a fallback).
  const sales = type === 'lead_owner' ? all.filter((p) => /sales/i.test(p.role ?? '')) : [];
  const pool = sales.length ? sales : all;
  const pick = pool.find((p) => p.suggested) ?? [...pool].sort((a, b) => a.loadPct - b.loadPct)[0];
  return pick ? { id: pick.id, name: pick.name, why: `${pick.name} is the best fit right now (${pick.loadPct}% busy, ${plural(pick.openTasks, 'open item')})` } : null;
}

export async function salesStalled(h: PlanHelpers): Promise<BasicResult> {
  const cutoff = new Date(h.now.getTime() - 7 * DAY);
  const leads = await h.prisma.lead.findMany({
    where: { orgId: h.acting.orgId, deletedAt: null, archivedAt: null, stage: { in: ['contacted', 'discovery', 'proposal_sent'] }, ownerId: { not: null }, OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, createdAt: { lt: cutoff } }] },
    orderBy: { lastActivityAt: 'asc' },
    take: 20,
  });
  let sent = 0;
  for (const l of leads) {
    const link = `/team/leads/${l.id}`;
    const recent = await h.prisma.notification.findFirst({ where: { orgId: l.orgId, userId: l.ownerId!, kind: 'agent', link, createdAt: { gte: cutoff } } });
    if (recent) continue;
    const days = Math.floor((h.now.getTime() - (l.lastActivityAt ?? l.createdAt).getTime()) / DAY);
    const r = await h.act('notify_person', { userId: l.ownerId!, title: `${leadLabel(l.contact)} has gone quiet (${days} days)`, body: `No activity for ${days} days at ${l.stage.replace('_', ' ')}. A short check-in call usually restarts it.`, link });
    if (r.status === 'done') sent++;
  }
  return { summary: sent ? `Reminded owners about ${plural(sent, 'quiet deal')}` : 'No quiet deals to chase' };
}

export function salesPrompt(f: Awaited<ReturnType<typeof leadFacts>>) {
  return `A new lead has arrived. Lead id: ${f.lead.id}
Source: ${f.lead.source}. Stage: ${f.lead.stage}. Budget: ${f.lead.budgetPaise ? formatINR(f.lead.budgetPaise) : 'not given'}. Services picked: ${f.services.join(', ') || 'none'}. Owner: ${f.lead.owner?.name ?? 'nobody yet'}. Follow-up set: ${f.lead.nextFollowUpAt ? 'yes' : 'no'}. Has email: ${f.contact.email ? 'yes' : 'no'}. Possible duplicate of an earlier lead: ${f.lead.duplicateOfId ? 'yes (say so in the brief)' : 'no'}.
Contact name: ${fence('lead contact', f.contact.name ?? '', 120)}
Company: ${fence('lead company', f.contact.company ?? '', 160)}
What they need: ${fence('lead enquiry', f.lead.need, 2000)}

Do this:
1. Use knowledge_search for the services that fit, and lead_details if useful.
2. set_lead_score (0-100) with a short reason.
3. add_lead_note: a brief of up to 5 short lines (wants, fit, risks, next step). Never write the budget amount in the note: it is a protected field some roles may not see; say only whether a budget was given.
4. If no follow-up is set, set_lead_follow_up for the next working day.
5. If nobody owns the lead, assign_lead to a salesperson (use find_people to pick someone with sales in their roles and the lowest load).
6. send_lead_reply: a warm first reply under 120 words that proposes a 15-minute call. Email if they have an email, otherwise WhatsApp.
Finish with one line saying what you did.`;
}

// ----------------------------------------------------------------------------------------------- Request triage

export async function requestFacts(h: PlanHelpers, requestId: string) {
  const r = await h.prisma.request.findFirstOrThrow({
    where: { id: requestId, orgId: h.acting.orgId },
    include: { engagement: { select: { amId: true, tier: true, serviceId: true, clientOrg: { select: { name: true } }, service: { select: { name: true, tiers: { select: { tier: true, revisionRounds: true } } } } } } },
  });
  const deliverable = r.deliverableId ? await h.prisma.deliverable.findFirst({ where: { id: r.deliverableId }, select: { title: true, revisionRoundsUsed: true } }) : null;
  const rounds = r.engagement.service.tiers.find((t) => t.tier === r.engagement.tier)?.revisionRounds ?? 2;
  return { request: r, client: r.engagement.clientOrg.name, service: r.engagement.service.name, deliverable, rounds };
}

export async function triageBasic(h: PlanHelpers, requestId: string): Promise<BasicResult> {
  const f = await requestFacts(h, requestId);
  const r = f.request;
  const addOns = await h.prisma.addOn.findMany({ where: { orgId: r.orgId, priceBook: { status: 'active' } }, select: { id: true, name: true, pricePaise: true } });
  const t = basicTriage(r.description, r.type as RequestType, f.deliverable?.revisionRoundsUsed ?? null, f.rounds, addOns);
  const note = [`Type: ${t.type.replace('_', ' ')}. Urgency: ${t.urgency}. Scope: ${t.scope.replaceAll('_', ' ')}.`, t.reasoning, t.addOn ? `Possible add-on: ${t.addOn.name}${t.addOn.pricePaise ? ` (${formatINR(t.addOn.pricePaise)})` : ''}.` : null].filter(Boolean).join('\n');
  await h.act('add_request_note', { requestId, text: note });
  if (t.urgency === 'high' && r.engagement.amId) await h.act('notify_person', { userId: r.engagement.amId, title: `Urgent request from ${f.client}`, body: redact(r.description).slice(0, 160), link: `/team/requests/${r.id}` });
  if (t.type !== r.type && (REQUEST_TYPES as readonly string[]).includes(t.type)) await h.act('set_request_type', { requestId, type: t.type, reason: t.reasoning.slice(0, 380) });
  if (!r.assigneeId) {
    const who = r.engagement.amId ? { id: r.engagement.amId, why: "The client's account manager" } : await suggestOwner(h, 'request', requestId);
    if (who) await h.act('assign_request', { requestId, assigneeId: who.id, reason: who.why });
  }
  if (!r.firstReplyAt) await h.act('reply_to_request', { requestId, text: basicReply(f.client, r.description, t.type).replace(/Warm regards$/, 'Warm regards,\nTeam BMU Marketing') });
  return { summary: `Triaged the ${f.client} request as ${t.type.replace('_', ' ')} (${t.urgency} urgency)` };
}

export function triagePrompt(f: Awaited<ReturnType<typeof requestFacts>>) {
  const r = f.request;
  return `A client raised a new request. Request id: ${r.id}
Client: ${f.client}. Service: ${f.service}. Type picked by the client: ${r.type}. Status: ${r.status}. Assigned to someone: ${r.assigneeId ? 'yes' : 'no'}. Account manager id: ${r.engagement.amId ?? 'none'}. Already replied: ${r.firstReplyAt ? 'yes' : 'no'}.
Deliverable: ${f.deliverable ? `${f.deliverable.title}, ${f.deliverable.revisionRoundsUsed} of ${f.rounds} revision rounds used` : 'not linked'}.
The request: ${fence('client request', r.description, 3000)}

Do this:
1. Decide the type (change, new_scope, urgent, question, billing), urgency (low, normal, high) and whether it is in scope. Use knowledge_search for the service's inclusions and SOPs when useful.
2. add_request_note with your triage in 2-4 short lines.
3. If urgency is high, notify_person the account manager.
4. If the type should be different, set_request_type.
5. If nobody is assigned, assign_request (usually the account manager).
6. If nobody has replied, reply_to_request with a short, warm acknowledgement that says what happens next. Never promise prices, dates or free work.
Finish with one line saying what you did.`;
}

// ----------------------------------------------------------------------------------------------- Producer

export async function producerBasic(h: PlanHelpers): Promise<BasicResult> {
  const orgId = h.acting.orgId;
  const today = istDate(h.now);
  const overdue = await h.prisma.task.findMany({ where: { orgId, status: OPEN_TASK, archivedAt: null, isDraft: false, ownerId: { not: null }, deadline: { lt: h.now } }, select: { id: true, title: true, ownerId: true, deadline: true }, orderBy: { deadline: 'asc' } });
  const byOwner = new Map<string, typeof overdue>();
  for (const t of overdue) byOwner.set(t.ownerId!, [...(byOwner.get(t.ownerId!) ?? []), t]);
  let reminded = 0;
  for (const [owner, tasks] of [...byOwner.entries()].slice(0, 25)) {
    const already = await h.prisma.notification.findFirst({ where: { orgId, userId: owner, kind: 'agent', title: { contains: 'overdue' }, createdAt: { gte: new Date(`${today}T00:00:00+05:30`) } } });
    if (already) continue;
    const r = await h.act('notify_person', { userId: owner, title: `You have ${plural(tasks.length, 'overdue task')}`, body: tasks.slice(0, 3).map((t) => `${t.title} (due ${dFmt(t.deadline!)})`).join('; '), link: '/team/tasks' });
    if (r.status === 'done') reminded++;
  }

  // People on approved leave when their work is due.
  const leaves = await h.prisma.leaveRequest.findMany({ where: { orgId, status: 'approved', to: { gte: new Date(`${today}T00:00:00Z`) }, from: { lte: new Date(h.now.getTime() + 7 * DAY) } }, select: { userId: true, from: true, to: true } });
  let proposed = 0;
  for (const lv of leaves) {
    const tasks = await h.prisma.task.findMany({ where: { orgId, ownerId: lv.userId, status: OPEN_TASK, archivedAt: null, isDraft: false, deadline: { gte: lv.from, lte: new Date(lv.to.getTime() + DAY) } }, select: { id: true, title: true }, take: 5 });
    for (const t of tasks) {
      if (proposed >= 10) break;
      const to = await suggestOwner(h, 'task', t.id);
      if (!to) continue;
      const r = await h.act('reassign_task', { taskId: t.id, toUserId: to.id, reason: 'leave', note: `The owner is on leave ${dFmt(lv.from)}–${dFmt(lv.to)} when this is due. ${to.why}.` });
      if (r.status === 'proposed') proposed++;
    }
  }

  // Overloaded people: more than 12 open tasks due in the next 7 days; suggest moving up to 2 not-started ones.
  const soon = await h.prisma.task.groupBy({ by: ['ownerId'], where: { orgId, status: OPEN_TASK, archivedAt: null, isDraft: false, ownerId: { not: null }, deadline: { gte: h.now, lte: new Date(h.now.getTime() + 7 * DAY) } }, _count: { _all: true } });
  for (const g of soon.filter((x) => x._count._all > 12).slice(0, 5)) {
    const movable = await h.prisma.task.findMany({ where: { orgId, ownerId: g.ownerId, status: 'todo', archivedAt: null, isDraft: false, deadline: { gte: h.now } }, orderBy: { deadline: 'desc' }, take: 2, select: { id: true } });
    for (const t of movable) {
      if (proposed >= 10) break;
      const to = await suggestOwner(h, 'task', t.id);
      if (!to) continue;
      const r = await h.act('reassign_task', { taskId: t.id, toUserId: to.id, reason: 'overload', note: `The owner has ${g._count._all} tasks due this week. ${to.why}.` });
      if (r.status === 'proposed') proposed++;
    }
  }
  // v18: skill requests on the workload board get the best free person (Agent Inbox).
  const booked = await producerBookings(h);
  return { summary: `${overdue.length ? `${plural(overdue.length, 'overdue task')}, reminded ${plural(reminded, 'person')}` : 'Nothing overdue'}; ${proposed ? `${plural(proposed, 'move')} suggested` : 'no moves needed'}${booked ? `; ${plural(booked, 'booking')} suggested` : ''}` };
}

export const PRODUCER_PROMPT = `Do the morning production check.
1. find_tasks to see overdue work. notify_person each owner once with how many tasks are overdue and the top three titles (link /team/tasks).
2. team_performance shows who is overloaded. For people on leave when their work is due, or with far more work than others, suggest reassign_task to someone with spare capacity (reason leave or overload, with a one-line note). Suggest at most 10 moves.
3. Skill requests on the workload board (booking requests without a person) can be filled with book_person; the booking is refused for anyone on approved leave or without free hours that week.
Never move work just to balance numbers when nobody is on leave or overloaded. Finish with one line saying what you did.`;

// ----------------------------------------------------------------------------------------------- Creative reviewer

const VIDEO_TYPES = ['reel', 'video', 'story'];
const STILL_TYPES = ['post', 'carousel', 'ad', 'banner', 'logo', 'creative', 'design'];

export async function versionFacts(h: PlanHelpers, versionId: string) {
  const v = await h.prisma.version.findFirstOrThrow({
    where: { id: versionId, orgId: h.acting.orgId },
    include: { file: true, deliverable: { include: { cycle: { select: { engagement: { select: { clientOrgId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } } } } } } },
  });
  const d = v.deliverable;
  const clientOrgId = d.cycle.engagement.clientOrgId;
  const [kit, brandFiles] = await Promise.all([h.prisma.craftBrandKit.findUnique({ where: { clientOrgId } }), h.prisma.file.count({ where: { clientOrgId, tags: { has: 'brand' }, archivedAt: null } })]);
  return { v, d, client: d.cycle.engagement.clientOrg.name, service: d.cycle.engagement.service.name, kit, brandFiles };
}

/** Obvious mismatches the rules can see without looking at the picture. */
export function creativeFlags(f: Awaited<ReturnType<typeof versionFacts>>): string[] {
  const flags: string[] = [];
  const type = f.d.type.toLowerCase();
  const kind = f.v.file.kind;
  if (VIDEO_TYPES.includes(type) && kind !== 'video' && kind !== 'link') flags.push(`This is a ${type} but the file is ${kind === 'image' ? 'a picture' : `a ${kind} file`}, not a video.`);
  if (STILL_TYPES.includes(type) && kind === 'video') flags.push(`This is a ${type} but the file is a video.`);
  if ((f.v.file.sizeBytes ?? 0) > 250 * 1024 * 1024 && ['post', 'story', 'reel', 'carousel'].includes(type)) flags.push('The file is over 250 MB; social platforms may reject it.');
  return flags;
}

export function brandLines(kit: Awaited<ReturnType<typeof versionFacts>>['kit']): string[] {
  if (!kit) return [];
  return [
    kit.colours.length ? `Colours: ${kit.colours.join(', ')}` : null,
    kit.fonts.length ? `Fonts: ${kit.fonts.join(', ')}` : null,
    kit.tone ? `Tone of voice: ${kit.tone}` : null,
    kit.dos.length ? `Do: ${kit.dos.join('; ')}` : null,
    kit.donts.length ? `Don't: ${kit.donts.join('; ')}` : null,
    kit.competitors.length ? `Never show or mention: ${kit.competitors.join(', ')}` : null,
    kit.notes ? `Notes: ${kit.notes.replace(/\s+/g, ' ').slice(0, 300)}` : null,
  ].filter((x): x is string => !!x);
}

export async function creativeBasic(h: PlanHelpers, versionId: string): Promise<BasicResult> {
  const f = await versionFacts(h, versionId);
  const flags = creativeFlags(f);
  const lines = brandLines(f.kit);
  const text = [
    `Brand check for v${f.v.number} (built-in rules; with an AI key the picture itself is checked too).`,
    ...flags.map((x) => `⚠ ${x}`),
    lines.length ? `For QC, check against ${f.client}'s brand kit:\n${lines.map((l) => `- ${l}`).join('\n')}` : `⚠ ${f.client} has no brand kit yet. Add colours, fonts, tone and do's and don'ts (Plan → Brand kits) so drafts can be checked.`,
    f.brandFiles ? null : `⚠ No logo or brand files uploaded for ${f.client}.`,
  ]
    .filter(Boolean)
    .join('\n');
  await h.act('add_version_note', { versionId, text });
  if (flags.length) await h.act('notify_person', { userId: f.v.uploadedById, title: `Check ${f.d.title} v${f.v.number} before QC`, body: flags.join(' '), link: `/team/deliverables/${f.d.id}` });
  return { summary: `Checked ${f.d.title} v${f.v.number}: ${flags.length ? `${plural(flags.length, 'problem')} flagged` : 'nothing obvious'}${lines.length ? '' : ', no brand kit'}` };
}

export function creativePrompt(f: Awaited<ReturnType<typeof versionFacts>>, hasImage: boolean) {
  const lines = brandLines(f.kit);
  return `A new draft was uploaded and is going to QC. Version id: ${f.v.id}
Client: ${f.client}. Service: ${f.service}. Deliverable: ${f.d.title} (type ${f.d.type}). Version ${f.v.number}. File: ${f.v.file.kind}${f.v.file.name ? `, ${f.v.file.name}` : ''}. Maker id: ${f.v.uploadedById}.
Maker's note: ${f.v.note ? fence('maker note', f.v.note, 1000) : 'none'}
Brand kit: ${lines.length ? fence('brand kit', lines.join('\n'), 3000) : 'none yet'}
Rule checks already found: ${creativeFlags(f).join(' ') || 'none'}
${hasImage ? 'The draft image is attached above. Look at it closely: colours, logo use, text (spelling, brand name), anything on the don\'t list or a competitor.' : 'You cannot see this file; judge from the facts only and list what QC should look at.'}

Do this:
1. add_version_note with a short brand check: what matches, what may break the brand kit, and 2-4 things QC should look at. Plain words, no more than 8 lines.
2. Only if something clearly breaks the brand kit or the file is the wrong kind, notify_person the maker with one line.
Finish with one line saying what you found.`;
}

// ----------------------------------------------------------------------------------------------- Analyst

export const ANALYST_ASK = `Answer the question using the tools (they only return what the person asking may see) and knowledge_search for SOPs, services, plans, brand kits and client notes.
Cite every fact as a markdown link using the exact "link" value from the tool results. If the data does not answer the question, say so plainly.`;

export const ANALYST_MONTHLY = `Write the monthly founder report for the month that just ended: revenue and collections, sales pipeline, client health (who is at risk and why), delivery (on time, overdue, blocked) and the three things to focus on this month.
Use business_summary, sales_numbers, clients_at_risk and team_performance. Keep it under 300 words with short headings. Cite figures with the exact links from tool results.`;

export const AGENT_SYSTEM: Record<AgentKey, string> = {
  sales_assistant: `You are the Sales assistant agent in BMU Hub, the CRM of BMU Marketing (a marketing agency in Bengaluru: social media, branding, web, video, SEO, ads). You prepare new leads for the sales team.`,
  request_triage: `You are the Request triage agent in BMU Hub, the CRM of BMU Marketing (a marketing agency in Bengaluru). You triage requests raised by clients so the account manager can act fast.`,
  producer: `You are the Producer agent in BMU Hub, the CRM of BMU Marketing (a marketing agency in Bengaluru). You keep production on track: chase overdue work and suggest fair reassignments.`,
  analyst: `You are the Analyst agent in BMU Hub, the CRM of BMU Marketing (a marketing agency in Bengaluru). You answer questions about the business and write the monthly founder report.`,
  finance_collector: `You are the Finance collector agent in BMU Hub, the CRM of BMU Marketing (a marketing agency in Bengaluru). You help Finance collect money: match payments to invoices, chase overdue invoices politely and flag costs nobody billed. Every payment match and reminder waits for a person.`,
  creative_reviewer: `You are the Creative reviewer agent in BMU Hub, the CRM of BMU Marketing (a marketing agency in Bengaluru). You check new drafts against the client's brand kit before human QC. You never talk to clients; your notes are internal.`,
};

export const AGENT_RULES = `How actions work:
- Actions are tools. Some run straight away and can be undone; client-facing, money and people changes go to the Agent Inbox for a person to approve. The tool result tells you which happened. Never say a message was sent when it is waiting for approval.
- You act for one person and can only do what they are allowed to do. If a tool says "Refused" or "not allowed", do not try another way; mention it in your final line.
- Agents can never delete anything, change prices or discounts, create invoices, issue refunds or change roles.
- Use only ids that appear in the facts or in tool results.`;
