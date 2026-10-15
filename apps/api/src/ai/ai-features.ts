// The AI features wired into existing screens. Each one: load the record through the existing service with the
// signed-in person's scope (so the 403/404 rules are the same as on screen), build a minimal prompt (client text
// fenced, contact details removed), and give a deterministic basic-mode version that is useful on its own.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  addWorkingDays,
  aiGenerateSchema,
  aiToneOf,
  formatINR,
  leadStageLabels,
  planContentSchema,
  requestTypeLabels,
  settingsDefaults,
  type AiMeetingNotes,
  type AiQcIssue,
  type AiResult,
  type AiStreamEvent,
  type AiTone,
  type AiTriage,
  type DeliverableDetail,
  type Me,
  type PlanContent,
  type RequestType,
  type SellLeadDetail,
} from '@bmu/shared';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { InsightsService } from '../insights/insights.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductionService } from '../production/production.service.js';
import { MessagesService } from '../requests/messages.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { SellService } from '../sell/sell.service.js';
import { FieldAccessService } from '../security/field-access.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { fence, redact, SAFETY_RULES } from './ai-safety.js';
import { AiService, jsonOf, textOf, type AiOut, type AiRunner } from './ai.service.js';

type Emit = (e: AiStreamEvent) => void;
type Input = z.output<typeof aiGenerateSchema>;

const get = <T>(ref: ModuleRef, cls: new (...args: never[]) => T): T => ref.get(cls as never, { strict: false }) as T;
const day = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(d)) : 'not set';
const isoDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

const WRITER = `You are the writing assistant inside BMU Hub, the CRM of BMU Marketing, a marketing agency in Bengaluru (social media, branding, web, video, SEO, ads).
You write drafts for the BMU team. Format with short paragraphs, "- " bullets and **bold** labels only (no tables, no headings with #).

${SAFETY_RULES}`;

/** Prompt per feature (frozen text so the system prompt caches; record data goes in the user message). */
const TASKS: Record<string, string> = {
  lead_brief:
    'Write a lead brief for the salesperson: **Who** (one line), **What they need**, **Score explained** (why the score is what it is, from the score parts), **Where it stands**, and **Next best action** (one concrete step with when, plus one backup step). Under 180 words.',
  lead_followup:
    'Draft a follow-up to the lead from the salesperson, based on the stage and the latest activity. For email: a subject line ("Subject: …") then the body, under 150 words. For WhatsApp: under 70 words, friendly, no subject. End with a clear, easy next step. Sign off with the salesperson’s first name and BMU Marketing.',
  proposal_intro:
    'Write the proposal introduction (2 short paragraphs addressed to the client, about their goal and how BMU will help) followed by **Scope** as bullets per chosen service, using only the tier deliverables given. Do not mention prices.',
  meeting_notes:
    'Turn the meeting notes into JSON: summary (3-5 sentences), actions (each a short imperative line with an owner if mentioned), followUpDate (YYYY-MM-DD for the next follow-up: use a date mentioned in the notes, otherwise 2 working days after today; never a Sunday).',
  creative_brief:
    'Write a creative brief for the producer: **Objective**, **Audience**, **Key message**, **Deliverable spec** (format, size/length for the type), **Must include**, **Tone & look**, **References/inputs** (from the requirements given), **Due** and **Revisions included**. Under 250 words.',
  social_captions:
    'Write for this social deliverable: **Hooks** (5 scroll-stopping first lines), **Captions** (3 options, 40-90 words each, with a call to action), **Hashtags** (15, mixing niche, local Bengaluru/India and broad). Avoid claims like "best" or "guaranteed".',
  video_script:
    'Write a video script outline with timings: **Hook (0-3s)**, **Problem/Context**, **Main points** (3 beats with visuals and voice-over lines), **Proof**, **Call to action**, plus **Shot list** and **On-screen text**. Assume a 30-45 second vertical reel unless the title says otherwise.',
  plan_draft:
    'Draft the monthly content plan as JSON with: objectives (2-3 sentences), audience (1-2 sentences), pillars (3-5 short names), creativeDirection (2-3 sentences), deliverables (exactly the quota given; each has type from [post, carousel, reel, story, video, blog, ad, page, other], a specific title, and due as YYYY-MM-DD spread across the month on working days).',
  qc_precheck:
    'Pre-check this text before QC. Return JSON {issues: [{kind: spelling|brand|claim|style, text: the exact problem words, suggestion: the fix}]}. Check spelling and grammar, the brand/client name written exactly as given, risky claims (best, No.1, guaranteed, 100%, cure, lowest price, medical or financial promises) and tone. Return an empty list if it is clean.',
  feedback_summary:
    'Summarise the client feedback on this deliverable into a numbered **Change list** for the producer (one change per line, most recent version first, merge duplicates, mark anything unclear with "(confirm with client)"), then one line **Revisions** with rounds used vs included.',
  reply_suggest:
    'Draft a reply from the client manager to the client’s latest message or request. Polite, warm Indian business English, under 110 words. Acknowledge what they asked, give the next step and a realistic time frame (working hours 9:30-18:30 Mon-Sat), never promise free extra work or discounts. If it sounds unhappy, apologise sincerely without blaming anyone.',
  request_triage:
    'Triage this client request against their package. Return JSON: type (change|new_scope|urgent|question|billing), urgency (low|normal|high), scope (in_scope|out_of_scope|unclear), reasoning (2-3 sentences citing the package or revision rounds), addOnId (the id of the best matching add-on from the list, or null), suggestedQuotePaise (integer paise from that add-on price, or null).',
  sentiment:
    'Rate the tone of each client message. Return JSON {items: [{id, tone: negative|urgent|positive|neutral}], overall: negative|urgent|positive|neutral, reason: one short sentence}.',
  anomaly_notes:
    'Write 2-4 short notes for the analytics page explaining what changed and the most likely reason, using ONLY the numbers given (e.g. "Revenue is down 18% vs last month, mainly because fewer proposals were won."). One line each, starting with "- ". If nothing notable changed, say so in one line.',
};

const schemas = {
  meeting_notes: {
    type: 'object',
    properties: { summary: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } }, followUpDate: { type: ['string', 'null'] } },
    required: ['summary', 'actions', 'followUpDate'],
    additionalProperties: false,
  },
  plan_draft: {
    type: 'object',
    properties: {
      objectives: { type: 'string' },
      audience: { type: 'string' },
      pillars: { type: 'array', items: { type: 'string' } },
      creativeDirection: { type: 'string' },
      deliverables: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' } }, required: ['type', 'title', 'due'], additionalProperties: false } },
    },
    required: ['objectives', 'audience', 'pillars', 'creativeDirection', 'deliverables'],
    additionalProperties: false,
  },
  qc_precheck: {
    type: 'object',
    properties: { issues: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['spelling', 'brand', 'claim', 'style'] }, text: { type: 'string' }, suggestion: { type: 'string' } }, required: ['kind', 'text', 'suggestion'], additionalProperties: false } } },
    required: ['issues'],
    additionalProperties: false,
  },
  request_triage: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['change', 'new_scope', 'urgent', 'question', 'billing'] },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      scope: { type: 'string', enum: ['in_scope', 'out_of_scope', 'unclear'] },
      reasoning: { type: 'string' },
      addOnId: { type: ['string', 'null'] },
      suggestedQuotePaise: { type: ['integer', 'null'] },
    },
    required: ['type', 'urgency', 'scope', 'reasoning', 'addOnId', 'suggestedQuotePaise'],
    additionalProperties: false,
  },
  sentiment: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tone: { type: 'string', enum: ['negative', 'urgent', 'positive', 'neutral'] } }, required: ['id', 'tone'], additionalProperties: false } },
      overall: { type: 'string', enum: ['negative', 'urgent', 'positive', 'neutral'] },
      reason: { type: 'string' },
    },
    required: ['items', 'overall', 'reason'],
    additionalProperties: false,
  },
} as const;

/** Context a feature prepared: facts for the prompt, a basic answer, an optional structured parse of the AI reply. */
type Prepared = {
  target?: { type: string; id: string };
  facts: string;
  basic: () => AiOut | Promise<AiOut>;
  parse?: (raw: string, json: unknown) => AiOut;
  schema?: Record<string, unknown>;
};

const MISSPELT: Record<string, string> = {
  recieve: 'receive',
  seperate: 'separate',
  definately: 'definitely',
  occured: 'occurred',
  untill: 'until',
  accomodate: 'accommodate',
  acheive: 'achieve',
  beleive: 'believe',
  teh: 'the',
  adress: 'address',
  sucess: 'success',
  succesful: 'successful',
  garantee: 'guarantee',
  enviroment: 'environment',
  buisness: 'business',
  calender: 'calendar',
  goverment: 'government',
  independant: 'independent',
  neccessary: 'necessary',
  noticable: 'noticeable',
  reccomend: 'recommend',
  tommorow: 'tomorrow',
  truely: 'truly',
  wierd: 'weird',
  oppurtunity: 'opportunity',
  experiance: 'experience',
  excelent: 'excellent',
  servise: 'service',
  offical: 'official',
};
const CLAIMS = ['best', 'no.1', 'no. 1', 'number one', '#1', 'guaranteed', 'guarantee', '100%', 'cure', 'permanent', 'lowest price', 'cheapest', 'clinically proven', 'risk-free', 'risk free', 'miracle', 'instant results'];

const HASHTAGS: Record<string, string[]> = {
  dental: ['#DentalCare', '#SmileMakeover', '#HealthyTeeth', '#DentistInBangalore', '#OralHealth'],
  bakery: ['#FreshlyBaked', '#BakeryLove', '#Cakes', '#BangaloreFood', '#Desserts'],
  real: ['#RealEstate', '#DreamHome', '#PropertyInBangalore', '#NewLaunch', '#HomeBuyers'],
  fitness: ['#FitnessGoals', '#Workout', '#HealthyLiving', '#GymLife', '#BangaloreFitness'],
  fashion: ['#Fashion', '#OOTD', '#StyleInspo', '#Ethnicwear', '#ShopLocal'],
  food: ['#FoodLovers', '#BangaloreFoodie', '#Restaurant', '#Foodie', '#TasteOfIndia'],
  education: ['#Learning', '#Education', '#Students', '#Skills', '#CareerGrowth'],
};

@Injectable()
export class AiFeaturesService {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly ref: ModuleRef,
  ) {}

  /** POST /ai/generate: one drafting feature on one record. */
  async generate(me: Me, input: Input, emit: Emit = () => {}): Promise<AiResult> {
    if (me.type !== 'staff') throw new ForbiddenException('AI drafting is for the BMU team');
    await this.ai.assertOn({ orgId: me.orgId, userId: me.id, me }, input.feature);
    const p = await this.prepare(me, input);
    const task = TASKS[input.feature];
    return this.ai.execute({ orgId: me.orgId, userId: me.id, me }, input.feature, {
      target: p.target,
      basic: p.basic,
      ai: async (run: AiRunner) => {
        const schema = p.schema;
        const msg = await run({
          system: WRITER,
          messages: [{ role: 'user', content: `Task: ${task}\n\nToday is ${day(new Date())} (IST). Written by: ${me.name}.\n\n${p.facts}` }],
          maxTokens: 16_000,
          effort: input.feature === 'plan_draft' || input.feature === 'lead_brief' ? 'medium' : 'low',
          schema,
          onText: schema ? undefined : (text) => emit({ t: 'delta', text }),
        });
        const raw = textOf(msg);
        if (p.parse) return p.parse(raw, schema ? jsonOf(msg) : null);
        return { text: raw };
      },
    });
  }

  private async prepare(me: Me, input: Input): Promise<Prepared> {
    const need = (id: string | undefined, what: string) => {
      if (!id) throw new BadRequestException(`Pick the ${what} first`);
      return id;
    };
    switch (input.feature) {
      case 'lead_brief':
      case 'lead_followup':
        return this.lead(me, need(input.targetId, 'lead'), input);
      case 'proposal_intro':
        return this.proposal(me, input);
      case 'meeting_notes':
        return this.meeting(me, input);
      case 'creative_brief':
      case 'social_captions':
      case 'video_script':
      case 'qc_precheck':
      case 'feedback_summary':
        return this.deliverable(me, input);
      case 'plan_draft':
        return this.plan(me, need(input.targetId, 'project'));
      case 'reply_suggest':
      case 'sentiment':
        return input.options.kind === 'request' ? this.request(me, need(input.targetId, 'request'), input.feature) : this.thread(me, need(input.targetId, 'conversation'), input.feature);
      case 'request_triage':
        return this.request(me, need(input.targetId, 'request'), 'request_triage');
      case 'anomaly_notes':
        return this.anomalies(me, input.options.page ?? 'scorecard');
    }
  }

  // ---------------------------------------------------------------- sales

  private async loadLead(me: Me, id: string): Promise<SellLeadDetail> {
    if ((me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException('Leads are for the sales team');
    const d = await get(this.ref, SellService).detail(me, id);
    // v20: the AI gets the lead exactly as this person may see it (a hidden budget stays hidden).
    return get(this.ref, FieldAccessService).forMe(me, d);
  }

  private nextAction(d: SellLeadDetail): string {
    const l = d.lead;
    const sent = d.proposals.find((p) => p.sentAt);
    if (d.followUpDue) return `The follow-up date (${day(d.nextFollowUpAt)}) has passed — call ${first(l.contact.name)} today and log the outcome.`;
    if (!l.owner) return 'Assign an owner now; a new lead answered within an hour converts far better.';
    switch (l.stage) {
      case 'new':
        return `Call ${first(l.contact.name)} today to confirm the need and budget, then move the lead to Contacted.`;
      case 'contacted':
        return 'Book a 20-minute discovery call this week to understand goals, timeline and decision maker.';
      case 'discovery':
        return 'Send a proposal within 2 working days while the conversation is fresh.';
      case 'proposal_sent':
        return sent && (sent.viewCount ?? 0) > 0
          ? `They have opened the proposal ${sent.viewCount} time${sent.viewCount === 1 ? '' : 's'} — call to answer questions and agree a start date.`
          : 'The proposal has not been opened yet — send a short WhatsApp with the link and offer a quick walkthrough.';
      case 'won':
        return 'Make sure the first payment is collected and onboarding has started.';
      default:
        return 'Record why it was lost and set a reminder to check back in 3 months.';
    }
  }

  private async lead(me: Me, id: string, input: Input): Promise<Prepared> {
    const d = await this.loadLead(me, id);
    const l = d.lead;
    const company = l.contact.company || l.contact.name;
    const services = l.serviceIds.length ? l.serviceIds.join(', ').replaceAll('_', ' ') : 'not specified';
    const last = d.timeline[0];
    const facts = [
      `Lead: ${l.contact.name}${l.contact.company ? ` from ${l.contact.company}` : ''} (source: ${l.source}). Contact details withheld.`,
      `Stage: ${leadStageLabels[l.stage]}. Owner: ${l.owner?.name ?? 'none'}. Created ${day(l.createdAt)}. Next follow-up: ${day(d.nextFollowUpAt)}${d.followUpDue ? ' (overdue)' : ''}.`,
      `Budget: ${!('budgetPaise' in l) ? 'not shown to this role' : l.budgetPaise ? formatINR(l.budgetPaise) : 'not given'}. Services asked for: ${services}.`,
      `Score ${d.score.score}/100 made of: ${d.score.parts.map((p) => `${p.label} ${p.points}/${p.max}`).join('; ')}.`,
      `Proposals: ${d.proposals.length ? d.proposals.map((p) => `v${p.version} ${p.status}, ${formatINR(p.totalPaise)}, sent ${day(p.sentAt)}, opened ${p.viewCount} times`).join('; ') : 'none yet'}.`,
      `Need in their words:\n${fence('lead need', l.need, 1500)}`,
      `Recent activity (newest first):\n${d.timeline.slice(0, 6).map((t) => `- ${day(t.at)} ${t.kind}: ${t.title}${t.body ? ` — ${redact(t.body).slice(0, 200)}` : ''}`).join('\n') || '- none'}`,
      input.feature === 'lead_followup' ? `Channel: ${input.options.channel ?? 'email'}.` : '',
      input.input ? `Extra instructions from the salesperson: ${input.input.slice(0, 500)}` : '',
    ].join('\n');
    const nba = this.nextAction(d);
    if (input.feature === 'lead_brief') {
      return {
        target: { type: 'Lead', id },
        facts,
        basic: () => ({
          text: [
            `**Who:** ${l.contact.name}${l.contact.company ? `, ${l.contact.company}` : ''} — came in via ${l.source} on ${day(l.createdAt)}.`,
            `**What they need:** ${redact(l.need).slice(0, 300)}${!('budgetPaise' in l) ? '' : l.budgetPaise ? ` Budget ${formatINR(l.budgetPaise)}.` : ' No budget given yet.'}`,
            `**Score ${d.score.score}/100:**\n${bullets(d.score.parts.map((p) => `${p.label}: ${p.points} of ${p.max}`))}`,
            `**Where it stands:** ${leadStageLabels[l.stage]}${l.owner ? `, owned by ${l.owner.name}` : ', no owner yet'}. ${last ? `Last activity ${day(last.at)} (${last.title}).` : 'No activity logged yet.'}${d.proposals.length ? ` ${d.proposals.length} proposal version${d.proposals.length === 1 ? '' : 's'}.` : ''}`,
            `**Next best action:** ${nba}`,
          ].join('\n\n'),
        }),
      };
    }
    const channel = input.options.channel ?? 'email';
    const stageLine =
      l.stage === 'proposal_sent'
        ? 'Did you get a chance to look at the proposal we shared? I would be happy to walk you through it on a short call.'
        : l.stage === 'discovery'
          ? 'I am putting together a plan based on our conversation and would love 20 minutes to confirm a couple of details.'
          : 'Could we set up a quick 15-minute call this week to understand your goals?';
    const text =
      channel === 'whatsapp'
        ? `Hi ${first(l.contact.name)}, this is ${first(me.name)} from BMU Marketing. Following up on your enquiry about ${services}. ${stageLine} What time works for you?`
        : `Subject: Next steps for ${company}\n\nHi ${first(l.contact.name)},\n\nThank you for reaching out to BMU Marketing about ${services}. ${stageLine}\n\nPlease let me know a convenient time, or simply reply to this email with your questions.\n\nWarm regards,\n${first(me.name)}\nBMU Marketing`;
    return { target: { type: 'Lead', id }, facts, basic: () => ({ text }) };
  }

  private async proposal(me: Me, input: Input): Promise<Prepared> {
    if ((me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException('Proposals are for the sales team');
    const lead = input.options.leadId ? await this.loadLead(me, input.options.leadId) : null;
    const keys = input.options.serviceKeys ?? lead?.lead.serviceIds ?? [];
    const book = await this.prisma.priceBook.findFirst({ where: { orgId: me.orgId, status: 'active' }, orderBy: { effectiveFrom: 'desc' } });
    const svc = await this.prisma.service.findMany({ where: { orgId: me.orgId, key: { in: keys }, ...(book ? { priceBookId: book.id } : {}) }, include: { tiers: true } });
    const templates = await this.settings.get(me.orgId, 'documentTemplates');
    const client = input.options.clientName || lead?.lead.contact.company || lead?.lead.contact.name || 'your business';
    const need = input.options.need ?? lead?.lead.need ?? '';
    const scope = svc.map((s) => ({ name: s.name, deliverables: (s.tiers.find((t) => t.tier === 'growth') ?? s.tiers[0])?.deliverables ?? [], excluded: s.excludedNote }));
    return {
      target: lead ? { type: 'Lead', id: lead.lead.id } : undefined,
      facts: [
        `Client: ${client}.`,
        `Their need:\n${fence('lead need', need, 1500)}`,
        `Chosen services and tier deliverables:\n${scope.map((s) => `- ${s.name}: ${s.deliverables.join(', ') || 'as per tier'}${s.excluded ? ` (not included: ${s.excluded})` : ''}`).join('\n') || '- none chosen yet'}`,
        `House style intro to adapt: ${templates.proposalIntro}`,
      ].join('\n'),
      basic: () => ({
        text: `Dear ${client === 'your business' ? 'Sir/Madam' : `${client} team`},\n\n${templates.proposalIntro || settingsDefaults.documentTemplates.proposalIntro}${need ? ` You told us you are looking for: “${redact(need).slice(0, 200)}”. The plan below is built around that goal.` : ''}\n\n**Scope**\n${scope.length ? scope.map((s) => `- **${s.name}:** ${s.deliverables.join(', ') || 'as per the chosen tier'}`).join('\n') : '- Choose services in the builder to list the scope here.'}`,
      }),
    };
  }

  private async meeting(me: Me, input: Input): Promise<Prepared> {
    const notes = (input.input ?? '').trim();
    if (notes.length < 20) throw new BadRequestException('Paste the meeting notes or transcript (at least a couple of sentences)');
    let leadLine = '';
    if (input.targetId) {
      const d = await this.loadLead(me, input.targetId);
      leadLine = `Meeting with ${d.lead.contact.name}${d.lead.contact.company ? ` of ${d.lead.contact.company}` : ''}, stage ${leadStageLabels[d.lead.stage]}.`;
    }
    const toText = (m: AiMeetingNotes) => `**Summary**\n${m.summary}\n\n**Action items**\n${bullets(m.actions.length ? m.actions : ['No clear action items found — add them before saving.'])}\n\n**Follow-up date:** ${m.followUpDate ? day(`${m.followUpDate}T12:00:00+05:30`) : 'not set'}`;
    return {
      target: input.targetId ? { type: 'Lead', id: input.targetId } : undefined,
      facts: `${leadLine}\nNotes or transcript:\n${fence('meeting notes', notes, 12_000)}`,
      schema: schemas.meeting_notes as unknown as Record<string, unknown>,
      parse: (raw, json) => {
        const m = z.object({ summary: z.string(), actions: z.array(z.string()), followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).safeParse(json);
        if (!m.success) return { text: raw };
        return { text: toText(m.data), data: { kind: 'meeting_notes', value: m.data } };
      },
      basic: () => {
        const m = basicMeeting(notes);
        return { text: toText(m), data: { kind: 'meeting_notes', value: m } };
      },
    };
  }

  // ---------------------------------------------------------------- delivery

  private async deliverable(me: Me, input: Input): Promise<Prepared> {
    const id = input.targetId;
    const text = (input.input ?? '').trim();
    if (input.feature === 'qc_precheck' && !id && text.length < 3) throw new BadRequestException('Paste the text to check');
    if (!id && input.feature !== 'qc_precheck') throw new BadRequestException('Pick the deliverable first');
    const d: DeliverableDetail | null = id ? await get(this.ref, ProductionService).deliverable(me, id) : null;
    const ctx = d ? await this.deliverableContext(d) : null;
    const facts = d
      ? [
          `Client: ${d.client.name}${ctx?.industry ? ` (${ctx.industry})` : ''}. Service: ${d.serviceName}. Deliverable: "${d.title}" (type ${d.type}), status ${d.status}, due ${day(d.dueAt)}. Revisions: ${d.revisionRounds.used} used of ${d.revisionRounds.included}.`,
          ctx?.plan ? `Approved plan: objectives ${ctx.plan.objectives || '—'}; audience ${ctx.plan.audience || '—'}; pillars ${ctx.plan.pillars.join(', ') || '—'}; direction ${ctx.plan.creativeDirection || '—'}.` : '',
          ctx?.requirements.length ? `Requirements received:\n${ctx.requirements.map((r) => `- ${r}`).join('\n')}` : '',
          input.feature === 'feedback_summary' ? `Client comments (newest first):\n${fence('client feedback', d.comments.filter((c) => c.author.isClient && !c.internal).reverse().map((c) => `[v${versionNo(d, c.versionId)} · ${day(c.at)}] ${c.body}`).join('\n'), 8000)}` : '',
          input.feature === 'qc_precheck' ? `QC checklist: ${d.qcChecklist.join('; ') || 'standard'}.` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '';
    const brand = d?.client.name ?? input.options.clientName ?? '';
    const target = d ? { type: 'Deliverable', id: d.id } : undefined;

    switch (input.feature) {
      case 'creative_brief':
        return {
          target,
          facts: `${facts}${text ? `\nExtra notes from the team: ${text.slice(0, 1000)}` : ''}`,
          basic: () => ({
            text: [
              `**Objective:** ${ctx?.plan?.objectives || `Deliver “${d!.title}” for ${d!.client.name} that supports this month's plan.`}`,
              `**Audience:** ${ctx?.plan?.audience || `${d!.client.name}'s customers${ctx?.industry ? ` in ${ctx.industry}` : ''}, mainly in Bengaluru.`}`,
              `**Key message:** One clear idea per piece — what ${d!.client.name} offers and why it matters now.`,
              `**Deliverable spec:** ${specFor(d!.type)}`,
              `**Must include:** ${d!.client.name} logo and brand colours, a clear call to action, correct contact details from the brand kit.`,
              `**Tone & look:** ${ctx?.plan?.creativeDirection || 'Clean, confident and on-brand; follow the brand guidelines received at onboarding.'}`,
              `**References/inputs:**\n${bullets(ctx?.requirements.length ? ctx.requirements : ['No requirement items received yet — check onboarding.'])}`,
              `**Due:** ${day(d!.dueAt)} · **Revisions included:** ${d!.revisionRounds.included} (used ${d!.revisionRounds.used})`,
            ].join('\n\n'),
          }),
        };
      case 'social_captions': {
        const tags = hashtagsFor(ctx?.industry ?? '', brand);
        return {
          target,
          facts: `${facts}${text ? `\nTopic or angle from the team: ${text.slice(0, 500)}` : ''}`,
          basic: () => ({
            text: [
              `**Hooks**\n${bullets([`Here’s what most people get wrong about ${topicOf(d!.title)}…`, `3 things to know before you choose ${topicOf(d!.title)}`, `Bengaluru, this one’s for you 👇`, `We asked our customers one question. Their answers surprised us.`, `Stop scrolling if you care about ${topicOf(d!.title)}.`])}`,
              `**Captions**\n${bullets([
                `${d!.title}. At ${brand}, we keep it simple: quality you can see and service you can trust. Drop us a message to know more.`,
                `Planning something special? ${brand} has you covered — from the first step to the final result. Tap the link in bio to get started.`,
                `Small details make a big difference. That’s how we work at ${brand}. Save this post and share it with someone who needs it!`,
              ])}`,
              `**Hashtags**\n${tags.join(' ')}`,
            ].join('\n\n'),
          }),
        };
      }
      case 'video_script':
        return {
          target,
          facts: `${facts}${text ? `\nAngle from the team: ${text.slice(0, 500)}` : ''}`,
          basic: () => ({
            text: [
              `**Hook (0–3s):** A bold question or visual about ${topicOf(d!.title)} — on-screen text in 5 words or fewer.`,
              `**Context (3–8s):** The everyday problem ${brand}'s customers face.`,
              `**Main points (8–30s):**\n${bullets(['Beat 1 — show the product/service in action (close-up shots).', 'Beat 2 — the key benefit, said in one line of voice-over.', 'Beat 3 — a quick proof point: a customer moment or before/after.'])}`,
              `**Proof (30–38s):** A short testimonial line or a number from the brand kit.`,
              `**Call to action (38–45s):** “Visit ${brand} today” / “DM us to book” with logo end card.`,
              `**Shot list:** wide establishing shot, 3 close-ups, 1 team/customer shot, logo end card.`,
              `**On-screen text:** hook line, 3 benefit words, CTA.`,
            ].join('\n\n'),
          }),
        };
      case 'qc_precheck': {
        const body = text || d?.title || '';
        return {
          target,
          facts: `${facts}\nBrand name to check: "${brand || 'not given'}".\nText to check:\n${fence('draft copy', body, 10_000)}`,
          schema: schemas.qc_precheck as unknown as Record<string, unknown>,
          parse: (raw, json) => {
            const parsed = z.object({ issues: z.array(z.object({ kind: z.enum(['spelling', 'brand', 'claim', 'style']), text: z.string(), suggestion: z.string() })) }).safeParse(json);
            if (!parsed.success) return { text: raw };
            return { text: qcText(parsed.data.issues), data: { kind: 'qc', value: parsed.data.issues } };
          },
          basic: () => {
            const issues = basicQc(body, brand);
            return { text: qcText(issues), data: { kind: 'qc', value: issues } };
          },
        };
      }
      default: {
        const comments = d!.comments.filter((c) => c.author.isClient && !c.internal).reverse();
        return {
          target,
          facts,
          basic: () => ({
            text: comments.length
              ? `**Change list**\n${comments.map((c, i) => `${i + 1}. ${redact(c.body).replace(/\s+/g, ' ').slice(0, 240)} (v${versionNo(d!, c.versionId)}, ${day(c.at)})`).join('\n')}\n\n**Revisions:** ${d!.revisionRounds.used} used of ${d!.revisionRounds.included} included.`
              : 'No client feedback on this deliverable yet.',
          }),
        };
      }
    }
  }

  private async deliverableContext(d: DeliverableDetail) {
    const e = await this.prisma.engagement.findUnique({
      where: { id: d.engagementId },
      select: { clientOrg: { select: { industry: true } }, cycles: { orderBy: { period: 'desc' }, take: 1, select: { requirements: { where: { status: 'received' }, select: { label: true } }, plans: { where: { status: 'approved' }, take: 1, select: { content: true } } } } },
    });
    const planRaw = e?.cycles[0]?.plans[0]?.content;
    const plan = planRaw ? planContentSchema.safeParse(planRaw) : null;
    return { industry: e?.clientOrg.industry ?? null, requirements: (e?.cycles[0]?.requirements ?? []).map((r) => r.label), plan: plan?.success ? plan.data : null };
  }

  private async plan(me: Me, engagementId: string): Promise<Prepared> {
    const e = await this.prisma.engagement.findFirst({
      where: { AND: [{ id: engagementId }, await visibleEngagementWhere(this.prisma, me)] },
      include: {
        clientOrg: { select: { name: true, industry: true } },
        service: { include: { tiers: true } },
        cycles: { orderBy: { period: 'desc' }, take: 1, include: { requirements: true } },
      },
    });
    if (!e) throw new NotFoundException('Project not found');
    const tier = e.service.tiers.find((t) => t.tier === e.tier);
    const quota = tier?.deliverables ?? [];
    const cycle = e.cycles[0];
    const notes = cycle ? await this.prisma.comment.findMany({ where: { targetType: 'requirement', targetId: { in: cycle.requirements.map((r) => r.id) } }, orderBy: { createdAt: 'asc' }, take: 20 }) : [];
    const month = cycle?.period && /^\d{4}-\d{2}$/.test(cycle.period) ? cycle.period : isoDay(new Date()).slice(0, 7);
    const facts = [
      `Client: ${e.clientOrg.name}${e.clientOrg.industry ? ` (${e.clientOrg.industry})` : ''}. Service: ${e.service.name}, ${e.tier} tier. Plan month: ${month}.`,
      `Tier quota (deliverables included): ${quota.join(', ') || 'not listed'}.`,
      `Requirements: ${cycle?.requirements.map((r) => `${r.label} (${r.status})`).join('; ') || 'none'}.`,
      notes.length ? `Client brief notes:\n${fence('client brief', notes.map((n) => n.body).join('\n'), 4000)}` : '',
    ].join('\n');
    const toText = (p: PlanContent) =>
      `**Objectives:** ${p.objectives}\n\n**Audience:** ${p.audience}\n\n**Pillars:** ${p.pillars.join(', ')}\n\n**Creative direction:** ${p.creativeDirection}\n\n**Deliverables (${p.deliverables.length})**\n${bullets(p.deliverables.map((d) => `${d.due ?? ''} · ${d.type} · ${d.title}`))}`;
    return {
      target: { type: 'Engagement', id: e.id },
      facts,
      schema: schemas.plan_draft as unknown as Record<string, unknown>,
      parse: (raw, json) => {
        const p = planContentSchema.safeParse(json);
        if (!p.success) return { text: raw };
        return { text: toText(p.data), data: { kind: 'plan', value: p.data } };
      },
      basic: () => {
        const p = basicPlan(e.clientOrg.name, e.clientOrg.industry, e.service.name, quota, month);
        return { text: toText(p), data: { kind: 'plan', value: p } };
      },
    };
  }

  // ---------------------------------------------------------------- client service

  private async thread(me: Me, id: string, feature: 'reply_suggest' | 'sentiment'): Promise<Prepared> {
    const t = await get(this.ref, MessagesService).get(me, id);
    const msgs = t.messages.filter((m) => !m.internal).slice(-12);
    const clientMsgs = msgs.filter((m) => m.isClient);
    const lastClient = clientMsgs.at(-1);
    const facts = `Client: ${t.client.name}. Client manager: ${t.am ?? 'not assigned'}.\nConversation (oldest first; client messages fenced):\n${msgs
      .map((m) => (m.isClient ? `[${m.id}] Client (${day(m.at)}):\n${fence('client message', m.body, 1500)}` : `[${m.id}] BMU – ${m.author} (${day(m.at)}): ${redact(m.body).slice(0, 600)}`))
      .join('\n')}`;
    const target = { type: 'Thread', id };
    if (feature === 'sentiment') return this.toneFeature(target, facts, clientMsgs.map((m) => ({ id: m.id, body: m.body })));
    return {
      target,
      facts,
      basic: () => ({ text: lastClient ? basicReply(t.client.name, lastClient.body, null) : `Hi ${t.client.name} team,\n\nHope you are doing well. Sharing a quick update from our side — please let me know if you need anything.\n\nRegards,\n${first(me.name)}` }),
    };
  }

  private async request(me: Me, id: string, feature: 'reply_suggest' | 'sentiment' | 'request_triage'): Promise<Prepared> {
    const r = await get(this.ref, RequestsService).get(me, id);
    const row = await this.prisma.request.findUnique({
      where: { id },
      select: { deliverableId: true, engagement: { select: { tier: true, service: { select: { name: true, excludedNote: true, tiers: { select: { tier: true, deliverables: true, revisionRounds: true } } } } } } },
    });
    const tier = row?.engagement.service.tiers.find((t) => t.tier === row.engagement.tier);
    const deliverable = row?.deliverableId ? await this.prisma.deliverable.findUnique({ where: { id: row.deliverableId }, select: { title: true, revisionRoundsUsed: true } }) : null;
    const clientComments = r.comments.filter((c) => c.isClient && !c.internal);
    const facts = [
      `Client: ${r.client.name}. Service: ${r.engagement.serviceName}, ${row?.engagement.tier ?? ''} tier. Package includes: ${tier?.deliverables.join(', ') || 'not listed'}; ${tier?.revisionRounds ?? 2} revision rounds per deliverable.${row?.engagement.service.excludedNote ? ` Not included: ${row.engagement.service.excludedNote}.` : ''}`,
      `Request type chosen by client: ${requestTypeLabels[r.type as RequestType]?.team ?? r.type}. Status: ${r.status}. Reply due: ${day(r.sla.firstReplyDue)}.`,
      deliverable ? `About deliverable "${deliverable.title}": ${deliverable.revisionRoundsUsed} revision rounds used.` : '',
      `Request text:\n${fence('client request', r.description, 3000)}`,
      clientComments.length ? `Client follow-ups:\n${fence('client comments', clientComments.map((c) => c.body).join('\n'), 2000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const target = { type: 'Request', id };
    if (feature === 'sentiment') return this.toneFeature(target, facts, [{ id: r.id, body: r.description }, ...clientComments.map((c) => ({ id: c.id, body: c.body }))]);
    if (feature === 'reply_suggest') return { target, facts, basic: () => ({ text: basicReply(r.client.name, r.description, r.type as RequestType) }) };
    const addOns = await get(this.ref, RequestsService).addOns(me);
    const toText = (t: AiTriage) =>
      `**Type:** ${requestTypeLabels[t.type].team} · **Urgency:** ${t.urgency} · **Scope:** ${t.scope === 'in_scope' ? 'In scope' : t.scope === 'out_of_scope' ? 'Out of scope (add-on)' : 'Unclear — confirm with client'}\n\n**Why:** ${t.reasoning}${t.addOn ? `\n\n**Suggested add-on:** ${t.addOn.name}${t.suggestedQuotePaise ? ` — quote ${formatINR(t.suggestedQuotePaise)} + GST` : ' (custom quote)'}` : ''}`;
    return {
      target,
      facts: `${facts}\nAdd-on price list:\n${addOns.map((a) => `- id ${a.id}: ${a.name} — ${a.pricePaise ? `${a.pricePaise} paise` : 'custom quote'}${a.unit ? ` per ${a.unit}` : ''}`).join('\n')}`,
      schema: schemas.request_triage as unknown as Record<string, unknown>,
      parse: (raw, json) => {
        const v = z
          .object({ type: z.enum(['change', 'new_scope', 'urgent', 'question', 'billing']), urgency: z.enum(['low', 'normal', 'high']), scope: z.enum(['in_scope', 'out_of_scope', 'unclear']), reasoning: z.string(), addOnId: z.string().nullable(), suggestedQuotePaise: z.number().int().nullable() })
          .safeParse(json);
        if (!v.success) return { text: raw };
        const a = addOns.find((x) => x.id === v.data.addOnId) ?? null;
        const t: AiTriage = { ...v.data, addOn: a ? { id: a.id, name: a.name, pricePaise: a.pricePaise } : null, suggestedQuotePaise: a ? (v.data.suggestedQuotePaise ?? a.pricePaise) : null };
        return { text: toText(t), data: { kind: 'triage', value: t } };
      },
      basic: () => {
        const t = basicTriage(`${r.description} ${clientComments.map((c) => c.body).join(' ')}`, r.type as RequestType, deliverable?.revisionRoundsUsed ?? null, tier?.revisionRounds ?? 2, addOns);
        return { text: toText(t), data: { kind: 'triage', value: t } };
      },
    };
  }

  private toneFeature(target: { type: string; id: string }, facts: string, items: { id: string; body: string }[]): Prepared {
    const overall = (list: { tone: AiTone }[]): AiTone => (['negative', 'urgent', 'positive'] as AiTone[]).find((t) => list.some((x) => x.tone === t)) ?? 'neutral';
    return {
      target,
      facts,
      schema: schemas.sentiment as unknown as Record<string, unknown>,
      parse: (raw, json) => {
        const v = z.object({ items: z.array(z.object({ id: z.string(), tone: z.enum(['negative', 'urgent', 'positive', 'neutral']) })), overall: z.enum(['negative', 'urgent', 'positive', 'neutral']), reason: z.string() }).safeParse(json);
        if (!v.success) return { text: raw };
        return { text: `**Tone:** ${v.data.overall} — ${v.data.reason}`, data: { kind: 'tone', value: { tone: v.data.overall, reason: v.data.reason, items: v.data.items } } };
      },
      basic: () => {
        const scored = items.map((i) => ({ id: i.id, ...aiToneOf(i.body) }));
        const tone = overall(scored);
        const reason = scored.find((s) => s.tone === tone)?.reason ?? 'No client messages yet';
        return { text: `**Tone:** ${tone} — ${reason}`, data: { kind: 'tone', value: { tone, reason, items: scored.map((s) => ({ id: s.id, tone: s.tone })) } } };
      },
    };
  }

  // ---------------------------------------------------------------- management

  private async anomalies(me: Me, page: 'scorecard' | 'weekly'): Promise<Prepared> {
    const pct = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);
    if (page === 'scorecard') {
      const s = await get(this.ref, AnalyticsService).scorecard(me);
      const rows = s.kpis.filter((k) => k.value !== null && k.previous !== null).map((k) => ({ label: k.label, value: k.value!, previous: k.previous!, unit: k.unit, change: pct(k.value!, k.previous!), lowerIsBetter: !!k.lowerIsBetter }));
      const fmt = (v: number, unit: string) => (unit === 'paise' ? formatINR(v) : unit === 'pct' ? `${v}%` : unit === 'days' ? `${v} days` : String(v));
      return {
        target: { type: 'Page', id: 'scorecard' },
        facts: `Sales scorecard, ${s.month.label}: revenue ${formatINR(s.month.revenuePaise)} vs target ${formatINR(s.month.targetPaise)} (${s.month.pct ?? '—'}%), projected ${formatINR(s.month.projectedPaise)}, ${s.month.workingDaysElapsed}/${s.month.workingDaysTotal} working days gone.\nKPIs this period vs previous:\n${rows.map((r) => `- ${r.label}: ${fmt(r.value, r.unit)} vs ${fmt(r.previous, r.unit)} (${r.change === null ? 'n/a' : `${r.change > 0 ? '+' : ''}${r.change}%`}${r.lowerIsBetter ? ', lower is better' : ''})`).join('\n')}`,
        basic: () => {
          const notable = rows.filter((r) => r.change !== null && Math.abs(r.change) >= 10).sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!)).slice(0, 3);
          const lines = notable.map((r) => {
            const up = r.change! > 0;
            const good = r.lowerIsBetter ? !up : up;
            return `- ${r.label} is ${up ? 'up' : 'down'} ${Math.abs(r.change!)}% vs the previous period (${fmt(r.value, r.unit)} vs ${fmt(r.previous, r.unit)})${good ? '.' : ' — worth a look.'}`;
          });
          lines.unshift(`- Revenue is at ${s.month.pct ?? 0}% of this month's target with ${s.month.workingDaysTotal - s.month.workingDaysElapsed} working days left; projected ${formatINR(s.month.projectedPaise)}${s.month.onTrack ? ' (on track).' : ' (behind target).'}`);
          return { text: lines.join('\n') };
        },
      };
    }
    const w = await get(this.ref, InsightsService).weekly(me);
    const facts = [
      w.money ? `Revenue this month ${formatINR(w.money.revenueThisMonthPaise)} vs last month ${formatINR(w.money.revenueLastMonthPaise)}; collected ${formatINR(w.money.collectedThisMonthPaise)}; outstanding ${formatINR(w.money.outstandingPaise)}.` : 'Money figures not visible to this role.',
      `Active clients ${w.activeClients}, open leads ${w.openLeads}, overdue tasks ${w.overdueTasks}, reply-time misses this week ${w.slaBreachesThisWeek}, QC pass rate ${w.qcPassRate ?? '—'}% on ${w.qcChecksThisWeek} checks.`,
      `Pipeline: ${w.pipeline.map((p) => `${p.label} ${p.count}`).join(', ')}.`,
      `At-risk clients: ${w.attention.atRiskClients.length}; blocked tasks: ${w.attention.blockedTasks.length}; overdue invoices: ${w.attention.overdueInvoices?.length ?? 'n/a'}.`,
    ].join('\n');
    return {
      target: { type: 'Page', id: 'weekly' },
      facts,
      basic: () => {
        const lines: string[] = [];
        if (w.money) {
          const c = pct(w.money.revenueThisMonthPaise, w.money.revenueLastMonthPaise);
          if (c !== null) lines.push(`- Revenue is ${c >= 0 ? 'up' : 'down'} ${Math.abs(c)}% vs last month so far (${formatINR(w.money.revenueThisMonthPaise)} vs ${formatINR(w.money.revenueLastMonthPaise)}).`);
          if (w.money.outstandingPaise > 0) lines.push(`- ${formatINR(w.money.outstandingPaise)} is still outstanding${w.attention.overdueInvoices?.length ? `, ${w.attention.overdueInvoices.length} invoice${w.attention.overdueInvoices.length === 1 ? '' : 's'} overdue` : ''}.`);
        }
        if (w.overdueTasks) lines.push(`- ${w.overdueTasks} task${w.overdueTasks === 1 ? ' is' : 's are'} overdue; ${w.attention.blockedTasks.length} blocked.`);
        if (w.slaBreachesThisWeek) lines.push(`- ${w.slaBreachesThisWeek} client request${w.slaBreachesThisWeek === 1 ? '' : 's'} missed the reply time this week.`);
        if (w.attention.atRiskClients.length) lines.push(`- ${w.attention.atRiskClients.length} client${w.attention.atRiskClients.length === 1 ? ' is' : 's are'} at risk: ${w.attention.atRiskClients.slice(0, 3).map((c) => c.name).join(', ')}.`);
        return { text: lines.join('\n') || '- Nothing unusual this week.' };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Basic-mode helpers (pure functions, also unit-tested through the e2e spec)

const versionNo = (d: DeliverableDetail, versionId: string) => d.versions.find((v) => v.id === versionId)?.number ?? '?';

function specFor(type: string) {
  const specs: Record<string, string> = {
    post: 'Single image post, 1080×1350 (4:5), max 20% text.',
    carousel: '5–8 slides, 1080×1350, first slide is the hook, last slide the call to action.',
    reel: 'Vertical video 1080×1920, 15–45 seconds, captions burned in, hook in the first 3 seconds.',
    story: 'Vertical 1080×1920, 1–3 frames, sticker or link for action.',
    video: 'Landscape 1920×1080 or vertical 1080×1920 as agreed, 30–90 seconds with subtitles.',
    blog: '800–1,200 words, one focus keyword, H2 sections, meta title and description.',
    ad: 'Feed ad 1080×1080 plus 1080×1920 variant, headline under 40 characters, clear offer.',
    page: 'Responsive web page: hero, benefits, proof, call to action; copy and images ready for development.',
  };
  return specs[type] ?? 'As agreed in the plan.';
}

const topicOf = (title: string) => title.replace(/^(post|reel|carousel|story|video|blog|ad)\s*[:\-–]\s*/i, '').replace(/\s*\(.*\)$/, '').toLowerCase() || 'this';

function hashtagsFor(industry: string, brand: string): string[] {
  const key = Object.keys(HASHTAGS).find((k) => industry.toLowerCase().includes(k));
  const brandTag = `#${brand.replace(/[^A-Za-z0-9]/g, '')}`;
  return [brandTag, ...(key ? HASHTAGS[key] : ['#SmallBusiness', '#SupportLocal', '#MadeInIndia', '#Quality', '#CustomerFirst']), '#Bangalore', '#Bengaluru', '#NammaBengaluru', '#India', '#Trending', '#InstaDaily', '#ExplorePage', '#Reels', '#Brand'].slice(0, 15);
}

export function basicMeeting(notes: string, now = new Date()): AiMeetingNotes {
  const sentences = notes
    .replace(/\r/g, '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length > 3);
  const actionWord = /\b(will|to do|todo|action|send|share|call|schedule|prepare|follow up|follow-up|confirm|review|draft|finali[sz]e|book|arrange|update|need to|needs to|should|must|by (mon|tue|wed|thu|fri|sat|tomorrow|next))/i;
  const actions = sentences.filter((s) => actionWord.test(s)).slice(0, 10);
  const summary = sentences.filter((s) => !actions.includes(s)).slice(0, 4).join(' ') || sentences.slice(0, 3).join(' ');
  return { summary: redact(summary).slice(0, 800) || 'Meeting notes captured.', actions: actions.map((a) => redact(a).slice(0, 200)), followUpDate: followUpFrom(notes, now) };
}

function followUpFrom(notes: string, now: Date): string {
  const t = notes.toLowerCase();
  const ist = new Date(now.getTime() + 330 * 60_000);
  const plus = (n: number) => isoDay(new Date(now.getTime() + n * 86_400_000));
  const inDays = t.match(/in (\d{1,2}) days?/);
  if (inDays) return plus(Number(inDays[1]));
  if (/\btomorrow\b/.test(t)) return ist.getUTCDay() === 6 ? plus(2) : plus(1);
  if (/\bnext week\b/.test(t)) return plus(((8 - ist.getUTCDay()) % 7 || 7));
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const named = days.findIndex((d) => new RegExp(`\\b(${d}|${d.slice(0, 3)})\\b`).test(t));
  if (named > 0) return plus(((named - ist.getUTCDay() + 7) % 7) || 7);
  return isoDay(addWorkingDays(now, 2));
}

export function basicQc(text: string, brand: string): AiQcIssue[] {
  const issues: AiQcIssue[] = [];
  const lower = text.toLowerCase();
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    const fix = MISSPELT[m[0].toLowerCase()];
    if (fix && !issues.some((i) => i.text === m[0])) issues.push({ kind: 'spelling', text: m[0], suggestion: fix });
  }
  for (const m of text.matchAll(/\b(\w+)\s+\1\b/gi)) issues.push({ kind: 'spelling', text: m[0], suggestion: m[1] });
  if (brand) {
    const words = brand.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words) {
      for (const m of text.matchAll(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'))) {
        if (m[0] !== w && !issues.some((i) => i.text === m[0])) issues.push({ kind: 'brand', text: m[0], suggestion: `Write the brand as “${w}”` });
      }
    }
  }
  for (const c of CLAIMS) {
    const re = new RegExp(`(^|[^a-z0-9])${c.replace(/[.*+?^${}()|[\]\\#%]/g, '\\$&')}($|[^a-z0-9])`, 'i');
    if (re.test(lower)) issues.push({ kind: 'claim', text: c, suggestion: 'Avoid absolute or unproven claims; use a fact the client can back up (e.g. “trusted by 2,000+ customers”).' });
  }
  if (/ {2,}/.test(text)) issues.push({ kind: 'style', text: 'double spaces', suggestion: 'Use single spaces between words.' });
  if (/!{2,}/.test(text)) issues.push({ kind: 'style', text: '!!', suggestion: 'Use one exclamation mark at most.' });
  for (const m of text.matchAll(/\b[A-Z]{5,}\b/g)) if (!issues.some((i) => i.text === m[0])) issues.push({ kind: 'style', text: m[0], suggestion: 'Avoid all-caps words; they read as shouting.' });
  if (/rs\.?\s?\d/i.test(text)) issues.push({ kind: 'style', text: 'Rs.', suggestion: 'Write amounts with ₹ and Indian grouping, e.g. ₹1,25,000.' });
  return issues.slice(0, 25);
}

function qcText(issues: AiQcIssue[]) {
  if (!issues.length) return 'No problems found. Still read it once before sending to QC.';
  const label: Record<AiQcIssue['kind'], string> = { spelling: 'Spelling', brand: 'Brand words', claim: 'Claims', style: 'Style' };
  return (['spelling', 'brand', 'claim', 'style'] as const)
    .filter((k) => issues.some((i) => i.kind === k))
    .map((k) => `**${label[k]}**\n${bullets(issues.filter((i) => i.kind === k).map((i) => `“${i.text}” → ${i.suggestion}`))}`)
    .join('\n\n');
}

export function basicReply(clientName: string, lastText: string, type: RequestType | null): string {
  const tone = aiToneOf(lastText).tone;
  const open =
    tone === 'negative'
      ? 'I am really sorry for the trouble and thank you for telling us. I have personally taken this up with the team.'
      : tone === 'urgent'
        ? 'Thank you for flagging this — I understand it is urgent and have shared it with the team right away.'
        : tone === 'positive'
          ? 'Thank you so much for the kind words — it means a lot to the team!'
          : 'Thank you for your message.';
  const next: Record<string, string> = {
    change: 'We will make the changes and share the updated version within 1–2 working days.',
    new_scope: 'This is outside your current package, so I will share a quote with the timeline for your approval before we start.',
    urgent: 'I will update you with the status by end of day today.',
    question: 'Let me check the details and get back to you by end of day.',
    billing: 'I have looped in our finance team and will confirm the details shortly.',
  };
  const step = type ? next[type] : tone === 'urgent' ? next.urgent : tone === 'negative' ? 'I will call you today to understand this better and agree on the fix.' : 'I will get back to you shortly with the next steps.';
  return `Hi ${clientName} team,\n\n${open} ${step}\n\nPlease feel free to reach out if there is anything else.\n\nWarm regards`;
}

export function basicTriage(
  text: string,
  chosen: RequestType,
  roundsUsed: number | null,
  roundsIncluded: number,
  addOns: { id: string; name: string; pricePaise: number | null }[],
): AiTriage {
  const t = text.toLowerCase();
  const tone = aiToneOf(text);
  let type: RequestType = chosen;
  if (/\b(invoice|payment|gst|refund|bill)\b/.test(t)) type = 'billing';
  else if (/\b(new|additional|extra|another|also need|one more|add on|add-on)\b/.test(t) && chosen !== 'billing') type = 'new_scope';
  else if (tone.tone === 'urgent' && chosen !== 'new_scope') type = 'urgent';
  else if (/\?\s*$/.test(text.trim()) && chosen === 'question') type = 'question';
  const urgency: AiTriage['urgency'] = tone.tone === 'urgent' || tone.tone === 'negative' || type === 'urgent' ? 'high' : type === 'question' ? 'low' : 'normal';
  let scope: AiTriage['scope'] = 'unclear';
  let reasoning: string;
  if (type === 'new_scope') {
    scope = 'out_of_scope';
    reasoning = 'The request asks for something new or additional, which is not part of the monthly package. It needs a quote and the client’s written approval before work starts.';
  } else if (type === 'change' || type === 'urgent') {
    if (roundsUsed !== null && roundsUsed >= roundsIncluded) {
      scope = 'out_of_scope';
      reasoning = `The deliverable has already used ${roundsUsed} of ${roundsIncluded} included revision rounds, so a further change is chargeable.`;
    } else {
      scope = 'in_scope';
      reasoning = roundsUsed !== null ? `Revision ${roundsUsed + 1} of ${roundsIncluded} included rounds — covered by the package.` : 'A change to current work is normally covered by the included revision rounds.';
    }
  } else {
    scope = 'in_scope';
    reasoning = type === 'billing' ? 'Billing questions are part of account service; loop in Finance.' : 'Questions are answered as part of account service.';
  }
  if (tone.tone !== 'neutral') reasoning += ` Tone: ${tone.reason.toLowerCase()}.`;
  const words = t.split(/[^a-z]+/).filter((w) => w.length > 3);
  const match = scope === 'out_of_scope' ? addOns.map((a) => ({ a, hits: a.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && words.some((x) => x.startsWith(w.slice(0, 5)))).length })).sort((x, y) => y.hits - x.hits)[0] : null;
  const addOn = match && match.hits > 0 ? { id: match.a.id, name: match.a.name, pricePaise: match.a.pricePaise } : null;
  return { type, urgency, scope, reasoning, addOn, suggestedQuotePaise: addOn?.pricePaise ?? null };
}

export function basicPlan(client: string, industry: string | null, service: string, quota: string[], month: string): PlanContent {
  const [y, m] = month.split('-').map(Number);
  const items: { type: string; label: string }[] = [];
  for (const q of quota) {
    const n = Number(q.match(/\d+/)?.[0] ?? 1);
    const l = q.toLowerCase();
    const type = l.includes('reel') ? 'reel' : l.includes('carousel') ? 'carousel' : l.includes('stor') ? 'story' : l.includes('video') ? 'video' : l.includes('blog') ? 'blog' : l.includes('ad') && !l.includes('adapt') ? 'ad' : l.includes('page') ? 'page' : l.includes('post') || l.includes('creative') ? 'post' : 'other';
    if (!/\d/.test(q) && type === 'other') continue;
    for (let i = 0; i < Math.min(n, 31); i++) items.push({ type, label: q.replace(/^\d+\s*/, '').trim() });
  }
  if (!items.length) items.push({ type: 'post', label: 'post' }, { type: 'post', label: 'post' }, { type: 'reel', label: 'reel' }, { type: 'carousel', label: 'carousel' });
  const pillars = ['Brand story', 'Product & service spotlight', 'Customer proof', 'Tips & education', 'Offers & festive moments'];
  const workDays: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) break;
    if (date.getUTCDay() !== 0) workDays.push(date.toISOString().slice(0, 10));
  }
  const step = workDays.length / items.length;
  return {
    objectives: `Grow ${client}'s reach and enquiries this month with consistent, on-brand ${service.toLowerCase()} content.`,
    audience: `${industry ? `People looking for ${industry.toLowerCase()} services` : `${client}'s customers`} in Bengaluru, 25–45, active on Instagram and Facebook.`,
    pillars: pillars.slice(0, items.length >= 8 ? 5 : 3),
    creativeDirection: 'Clean layouts in the brand colours, real photos over stock, short hooks and one clear call to action per piece.',
    deliverables: items.map((it, i) => ({
      type: it.type,
      title: `${pillars[i % pillars.length]} — ${it.type === 'reel' ? 'reel' : it.label || it.type} ${i + 1}`,
      due: workDays[Math.min(workDays.length - 1, Math.floor(i * step + step / 2))],
    })),
  };
}
