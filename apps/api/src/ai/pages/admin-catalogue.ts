// Ask BMU page skills: see ./types.ts for the contract and ./access.ts for who sees each tab.
// Command Centre → Catalogue, Operations and Customise pages. Each load() makes the same read the page makes, with the
// same permission check the API applies (the global guard's @RequireCapability is repeated here, since a direct call
// skips the guard). Nothing here writes.
import { ForbiddenException } from '@nestjs/common';
import { billingPer, customFieldEntityLabels, formatINR, GATES, PLANS, planLabels, pipelineKindLabels, quoteTotals, requestTypeLabels, type CustomFieldEntity, type Me, type PipelineKind, type QuoteContent, type RequestType } from '@bmu/shared';
import { ErrorsController } from '../../admin-platform/errors.controller.js';
import { SopsController } from '../../admin-platform/sops.controller.js';
import { CatalogueController } from '../../catalogue/catalogue.controller.js';
import { CustomFieldsService } from '../../customise/custom-fields.service.js';
import { FormsService } from '../../customise/forms.service.js';
import { PipelinesService } from '../../customise/pipelines.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TemplatesController } from '../../production/templates.controller.js';
import { SettingsService } from '../../settings/settings.service.js';
import { redact } from '../ai-safety.js';
import { admin } from './access.js';
import { bullets, day, link, plural, svc, type PageSkill } from './types.js';

/** What the global guard checks for routes marked @RequireCapability(capability). */
const need = (me: Me, capability: keyof Me['permissions'], what: string) => {
  if (me.type !== 'staff' || (me.permissions[capability]?.scope ?? 'none') === 'none') throw new ForbiddenException(`your role can't see ${what}`);
};
const price = (paise: number | null | undefined) => (paise == null ? null : formatINR(paise));
const short = (text: string | null | undefined, max = 400) => {
  const t = redact(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const ROLE_LABEL: Record<string, string> = { founder: 'Founder', admin: 'Branch Manager', department_head: 'Department head', sales_manager: 'Sales manager', sales_executive: 'Sales executive', am_lead: 'CM lead', account_manager: 'Client manager', finance: 'Finance' };
/** Roles that sell (Discount Limits page). */
const SELLING_ROLES = ['sales_executive', 'sales_manager', 'am_lead', 'account_manager', 'admin'];
const minutes = (m: number) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return [h ? `${h} h` : '', r ? `${r} min` : ''].filter(Boolean).join(' ') || '0 min';
};
/** The plan named in the question, if any ("growth tier", "premium plan"). */
const planIn = (q: string) => PLANS.find((p) => new RegExp(`\\b${p}\\b`).test(q));

// ------------------------------------------------------------------------------------------------ Catalogue

type PlanPriceText = { plan: string; price: string };
export type ServicesData = {
  services: { name: string; subServices: { name: string; billing: string; prices: PlanPriceText[] }[] }[];
  priceBook: { version: string; services: { name: string; tiers: PlanPriceText[] }[] };
};

const services: PageSkill = {
  name: 'page_services_tiers',
  label: 'Services & Tiers',
  href: '/admin/catalogue',
  surface: 'admin',
  can: admin('Services & Tiers'),
  keywords: /\b(services (and|&) tiers|what services (do|does|can) (we|bmu) (offer|sell|have)|services we (offer|sell)|(starter|growth|premium) (tiers?|plans?|prices?|packages?)|price of (the )?(starter|growth|premium)|tier prices?|plan prices?|sub[- ]services?|price book)\b/,
  examples: ['What services do we offer?', 'What is the price of the Growth tier?'],
  description: 'Services BMU sells with their sub-services and Starter / Growth / Premium plan prices, plus the price book tiers.',
  load: async (ref, me) => {
    need(me, 'catalogue_pricing_engine', 'the price list');
    const ctrl = svc(ref, CatalogueController);
    const [groups, cat] = await Promise.all([ctrl.groups(me), ctrl.admin(me)]);
    const plans = (p: Record<string, number | null>, per = '') => PLANS.filter((k) => p[k] != null).map((k) => ({ plan: planLabels[k], price: `${price(p[k])}${per}` }));
    return {
      services: groups
        .filter((g) => !g.archived)
        .map((g) => ({ name: g.name, subServices: g.subServices.filter((s) => !s.archived).map((s) => ({ name: s.name, billing: billingPer[s.billing], prices: plans(s.prices) })) })),
      priceBook: { version: cat.priceBook.version, services: cat.services.map((s) => ({ name: s.name, tiers: s.tiers.map((t) => ({ plan: t.tier.charAt(0).toUpperCase() + t.tier.slice(1), price: formatINR(t.pricePaise) })) })) },
    } satisfies ServicesData;
  },
  answer: (d: ServicesData, q) => {
    const page = link('Services & Tiers', '/admin/catalogue');
    if (!d.services.length && !d.priceBook.services.length) return `No services are set up yet. Add them on ${page}.`;
    const plan = planIn(q);
    if (plan) {
      const label = planLabels[plan];
      const rows = [
        ...d.services.flatMap((g) => g.subServices.flatMap((s) => s.prices.filter((p) => p.plan === label).map((p) => `${g.name} · ${s.name}: ${p.price} ${s.billing}`))),
        ...d.priceBook.services.flatMap((s) => s.tiers.filter((t) => t.plan === label).map((t) => `${s.name} (price book ${d.priceBook.version}): ${t.price}`)),
      ];
      if (!rows.length) return `Nothing has a ${label} price yet. See ${page}.`;
      return `${label} prices (excluding GST):\n${bullets(rows, 15)}\n\nSee ${page}.`;
    }
    const rows = d.services.map((g) => {
      const subs = g.subServices.map((s) => s.name);
      return `**${g.name}**: ${subs.length ? `${plural(subs.length, 'sub-service')} (${subs.slice(0, 5).join(', ')}${subs.length > 5 ? ', …' : ''})` : 'no sub-services yet'}`;
    });
    const book = d.priceBook.services.length ? `\n\nPrice book ${d.priceBook.version} also lists ${plural(d.priceBook.services.length, 'service')}: ${d.priceBook.services.slice(0, 8).map((s) => s.name).join(', ')}${d.priceBook.services.length > 8 ? ', …' : ''}.` : '';
    return `We offer ${plural(d.services.length, 'service')}:\n${bullets(rows, 12)}${book}\n\nAsk about a plan (e.g. "Growth tier prices"), or see ${page}.`;
  },
};

export type BundlesData = {
  bundles: { name: string; subServices: string[]; savingPct: number; selectable: boolean; prices: PlanPriceText[] }[];
  priceBookBundles: { name: string; services: number; discountPct: number }[];
};

const bundles: PageSkill = {
  name: 'page_bundles',
  label: 'Bundles',
  href: '/admin/bundles',
  surface: 'admin',
  can: admin('Bundles'),
  keywords: /\b(bundles?|bundled|package deals?|combo (packages?|offers?))\b/,
  examples: ['What bundles do we have?', 'How much do we save on a bundle?'],
  description: 'Bundles of sub-services sold together: members, saving %, plan prices, and whether sellers can pick them; plus the old price book bundles.',
  load: async (ref, me) => {
    need(me, 'catalogue_pricing_engine', 'bundles');
    const ctrl = svc(ref, CatalogueController);
    const [rows, groups, cat] = await Promise.all([ctrl.bundles(me), ctrl.groups(me), ctrl.admin(me)]);
    const names = new Map(groups.flatMap((g) => g.subServices.map((s) => [s.id, s.name] as const)));
    return {
      bundles: rows.slice(0, 20).map((b) => ({
        name: b.name,
        subServices: b.subServiceIds.map((id) => names.get(id) ?? 'a removed sub-service'),
        savingPct: b.savingPct,
        selectable: b.selectable,
        prices: PLANS.filter((p) => b.prices[p] != null).map((p) => ({ plan: planLabels[p], price: formatINR(b.prices[p]!) })),
      })),
      priceBookBundles: cat.bundles.map((b) => ({ name: b.name, services: b.serviceKeys.length, discountPct: b.discountPct })),
    } satisfies BundlesData;
  },
  answer: (d: BundlesData) => {
    const page = link('Bundles', '/admin/bundles');
    if (!d.bundles.length && !d.priceBookBundles.length) return `No bundles are set up yet. Create one on ${page}.`;
    const rows = d.bundles.map((b) => `**${b.name}** (${b.savingPct}% saving${b.selectable ? '' : ', hidden from sellers'}): ${b.subServices.join(' + ')}${b.prices.length ? ` · ${b.prices.map((p) => `${p.plan} ${p.price}`).join(', ')}` : ''}`);
    const old = d.priceBookBundles.length ? `\n\nOlder price book bundles (still used by running proposals): ${d.priceBookBundles.map((b) => `${b.name} (${b.discountPct}% off ${plural(b.services, 'service')})`).join(', ')}.` : '';
    return `${d.bundles.length ? `${plural(d.bundles.length, 'bundle')}, priced from today's plan prices minus the saving (excluding GST):\n${bullets(rows)}` : 'No sub-service bundles yet.'}${old}\n\nSee ${page}.`;
  },
};

export type AddOnsData = { priceBook: string; addOns: { name: string; price: string | null; unit: string | null; customQuote: boolean }[] };

const addOns: PageSkill = {
  name: 'page_add_ons',
  label: 'Add-ons',
  href: '/admin/add-ons',
  surface: 'admin',
  can: admin('Add-ons'),
  keywords: /\b(add-?ons? (on (the|our) )?price list|add-?on prices?|price (of|for) (an |the |our )?add-?ons?|add-?ons? (do|can) we (sell|offer)|extras we (sell|offer))\b/,
  examples: ['Which add-ons do we sell?', 'What are our add-on prices?'],
  description: 'Add-ons (extras sold on top of a service) from the active price book, with a fixed price and unit or "custom quote".',
  load: async (ref, me) => {
    need(me, 'catalogue_pricing_engine', 'add-ons');
    const cat = await svc(ref, CatalogueController).admin(me);
    return { priceBook: cat.priceBook.version, addOns: cat.addOns.map((a) => ({ name: a.name, price: price(a.pricePaise), unit: a.unit, customQuote: a.isCustomQuote })) } satisfies AddOnsData;
  },
  answer: (d: AddOnsData) => {
    const page = link('Add-ons', '/admin/add-ons');
    if (!d.addOns.length) return `No add-ons are on the price list yet. Add them on ${page}.`;
    const rows = d.addOns.map((a) => `${a.name}: ${a.customQuote || !a.price ? 'custom quote' : `${a.price}${a.unit ? ` per ${a.unit}` : ''}`}`);
    return `${plural(d.addOns.length, 'add-on')} on price book ${d.priceBook} (excluding GST):\n${bullets(rows, 15)}\n\nSee ${page}.`;
  },
};

export type DiscountLimitsData = { limits: { role: string; pct: number }[] };

const discountLimits: PageSkill = {
  name: 'page_discount_limits',
  label: 'Discount Limits',
  href: '/admin/discount-limits',
  surface: 'admin',
  can: admin('Discount Limits'),
  keywords: /\b(discount limits?|max(imum)? discounts?|discount caps?|how much (of a )?discount (can|may)|discount (can|may) (a |an |the )?\w+( \w+)? (give|offer))\b/,
  examples: ['What are the discount limits?', 'How much discount can a sales manager give?'],
  description: "Each selling role's extra discount limit (%). Above it the Founder must approve; the Founder has no limit.",
  load: async (ref, me) => {
    const s = await svc(ref, SettingsService).all(me);
    return { limits: SELLING_ROLES.map((r) => ({ role: ROLE_LABEL[r] ?? r, pct: s.discountLimits[r] ?? 0 })) } satisfies DiscountLimitsData;
  },
  answer: (d: DiscountLimitsData, q) => {
    const page = link('Discount Limits', '/admin/discount-limits');
    const one = d.limits.find((l) => q.includes(l.role.toLowerCase()));
    if (one) return `A ${one.role} can add up to ${one.pct}% extra discount. Above that the proposal waits for the Founder's sign-off. See ${page}.`;
    return `Extra discount each role may give on top of bundle savings:\n${bullets(d.limits.map((l) => `${l.role}: up to ${l.pct}%`))}\n- Founder: no limit (signs off anything above a limit)\n\nSee ${page}.`;
  },
};

export type DocumentTemplatesData = { proposalIntro: string; proposalTerms: string; agreementBody: string };

const documentTemplates: PageSkill = {
  name: 'page_document_templates',
  label: 'Proposal & Agreement Templates',
  href: '/admin/document-templates',
  surface: 'admin',
  can: admin('Proposal & Agreement Templates'),
  keywords: /\b(agreement (templates?|text|body|wording)|proposal (intro|introduction|terms|templates?|wording)|(our|the) agreement say|terms on (our )?proposals)\b/,
  examples: ['What does our agreement template say?', 'What are the proposal terms?'],
  description: 'The proposal intro, proposal terms and client agreement text printed on every proposal (shortened).',
  load: async (ref, me) => {
    const t = (await svc(ref, SettingsService).all(me)).documentTemplates;
    return { proposalIntro: short(t.proposalIntro), proposalTerms: short(t.proposalTerms, 600), agreementBody: short(t.agreementBody, 600) } satisfies DocumentTemplatesData;
  },
  answer: (d: DocumentTemplatesData, q) => {
    const page = link('Proposal & Agreement Templates', '/admin/document-templates');
    const part = (title: string, text: string) => `**${title}**: ${text || '(empty)'}`;
    if (/\bagreement\b/.test(q) && !/\bproposal/.test(q)) return `${part('Agreement', d.agreementBody)}\n\nEdit it on ${page}.`;
    if (/\bterms\b/.test(q)) return `${part('Proposal terms', d.proposalTerms)}\n\nEdit them on ${page}.`;
    return `${part('Proposal intro', d.proposalIntro)}\n\n${part('Proposal terms', d.proposalTerms)}\n\n${part('Agreement', d.agreementBody)}\n\nEdit them on ${page}.`;
  },
};

export type QuoteTemplatesData = { templates: { name: string; title: string; service: string | null; lines: number; subtotal: string; updated: string | null }[] };

const quoteTemplates: PageSkill = {
  name: 'page_quote_templates',
  label: 'Quotation Templates',
  href: '/admin/quote-templates',
  surface: 'admin',
  can: admin('Quotation Templates'),
  keywords: /\b(quot(ation|e) templates?|templates? for quot(ations?|es))\b/,
  examples: ['Which quotation templates do we have?'],
  description: 'Saved quotation templates: name, project title, service, number of cost lines and subtotal before GST.',
  load: async (ref, me) => {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    // Same rows as QuotesService.templates, read directly: that method also adds a starting template when there are
    // none, and Ask BMU never writes.
    const rows = await svc(ref, PrismaService).quoteTemplate.findMany({ where: { orgId: me.orgId }, orderBy: { name: 'asc' }, take: 20 });
    const names = new Map((await svc(ref, CatalogueController).services()).map((s) => [s.id, s.name]));
    return {
      templates: rows.map((t) => {
        const c = t.content as unknown as Partial<QuoteContent>;
        const lines = Array.isArray(c.lines) ? c.lines : [];
        return { name: t.name, title: short(c.title, 160), service: t.serviceKey ? (names.get(t.serviceKey) ?? t.serviceKey) : null, lines: lines.length, subtotal: formatINR(quoteTotals(lines, 0).subtotalPaise), updated: day(t.updatedAt) };
      }),
    } satisfies QuoteTemplatesData;
  },
  answer: (d: QuoteTemplatesData) => {
    const page = link('Quotation Templates', '/admin/quote-templates');
    if (!d.templates.length) return `No quotation templates are saved yet (a starting template is added when ${page} is first opened).`;
    const rows = d.templates.map((t) => `**${t.name}**${t.service ? ` (${t.service})` : ''}: "${t.title}", ${plural(t.lines, 'cost line')}, ${t.subtotal} before GST${t.updated ? ` · updated ${t.updated}` : ''}`);
    return `${plural(d.templates.length, 'quotation template')}:\n${bullets(rows)}\n\nSee ${page}.`;
  },
};

// ------------------------------------------------------------------------------------------------ Operations

export type SopsData = { total: number; drafts: { title: string; department: string }[]; published: { title: string; department: string; version: number; acknowledged: number }[]; canEditAny: boolean };

const sops: PageSkill = {
  name: 'page_admin_sops',
  label: 'SOP Library',
  href: '/admin/sops',
  surface: 'admin',
  can: admin('SOP Library'),
  keywords: /\b(draft sops?|sop drafts?|sops? (are )?(still )?(in )?drafts?|unpublished sops?|sops? (waiting|yet) to be published|sop acknowledg(e)?ments?|acknowledged (the |our )?sops?|sops? (have been |been )?acknowledged)\b/,
  examples: ['Which SOPs are still drafts?', 'How many people acknowledged our SOPs?'],
  description: 'SOP Library admin view: drafts waiting to be published (only those you may edit) and how many team members acknowledged each published SOP.',
  load: async (ref, me) => {
    const rows = await svc(ref, SopsController).list(me);
    const published = rows.filter((s) => s.status !== 'draft');
    return {
      total: rows.length,
      drafts: rows.filter((s) => s.status === 'draft').slice(0, 15).map((s) => ({ title: redact(s.title), department: s.department.name })),
      published: published
        .sort((a, b) => (a.acknowledged ?? 0) - (b.acknowledged ?? 0))
        .slice(0, 15)
        .map((s) => ({ title: redact(s.title), department: s.department.name, version: s.version, acknowledged: s.acknowledged ?? 0 })),
      canEditAny: rows.some((s) => s.canEdit),
    } satisfies SopsData;
  },
  answer: (d: SopsData, q) => {
    const page = link('SOP Library', '/admin/sops');
    if (!d.total) return `The SOP library is empty. Add the first SOP on ${page}.`;
    const drafts = d.drafts.length ? `${plural(d.drafts.length, 'draft')} waiting to be published:\n${bullets(d.drafts.map((s) => `${s.title} (${s.department})`))}` : 'No drafts are waiting to be published.';
    const acks = d.published.length ? `Acknowledgements on the current version (fewest first):\n${bullets(d.published.map((s) => `${s.title} v${s.version} (${s.department}): ${plural(s.acknowledged, 'person', 'people')}`))}` : 'Nothing is published yet.';
    const first = /acknowledg/.test(q) ? [acks, drafts] : [drafts, acks];
    return `${first.join('\n\n')}\n\nSee ${page}.`;
  },
};

export type RequirementChecklistsData = { defaultList: { label: string; type: string }[]; services: { name: string; items: { label: string; type: string }[] }[]; servicesUsingDefault: number };
const ITEM_TYPE: Record<string, string> = { file: 'file', access: 'access', call: 'call', text: 'answer' };

const requirementChecklists: PageSkill = {
  name: 'page_requirement_checklists',
  label: 'Requirement Checklists',
  href: '/admin/requirement-checklists',
  surface: 'admin',
  can: admin('Requirement Checklists'),
  keywords: /\b(requirement checklists?|requirements? checklists?|default requirement|what (do )?we (collect|need|ask for) from (a |every )?new clients?|onboarding checklists?)\b/,
  examples: ['What do we collect from a new client before starting?', 'What is on the default requirement checklist?'],
  description: 'What is collected from a new client before work starts: the default list and services with their own list.',
  load: async (ref, me) => {
    const [settings, all] = await Promise.all([svc(ref, SettingsService).all(me), svc(ref, CatalogueController).services()]);
    const lists = settings.requirementChecklists;
    const item = (i: { label: string; type: string }) => ({ label: redact(i.label), type: ITEM_TYPE[i.type] ?? i.type });
    const own = all.filter((s) => lists[s.id]?.length);
    return { defaultList: (lists.default ?? []).map(item), services: own.slice(0, 10).map((s) => ({ name: s.name, items: lists[s.id].map(item) })), servicesUsingDefault: all.length - own.length } satisfies RequirementChecklistsData;
  },
  answer: (d: RequirementChecklistsData) => {
    const page = link('Requirement Checklists', '/admin/requirement-checklists');
    const list = (items: { label: string; type: string }[]) => bullets(items.map((i) => `${i.label} (${i.type})`), 15);
    const def = d.defaultList.length ? `Default list (${plural(d.servicesUsingDefault, 'service')} use it):\n${list(d.defaultList)}` : 'The default list is empty.';
    const own = d.services.length ? `\n\nServices with their own list:\n${bullets(d.services.map((s) => `${s.name}: ${s.items.map((i) => i.label).join(', ')}`))}` : '';
    return `${def}${own}\n\nChanges apply to new engagements only. See ${page}.`;
  },
};

export type FlowTemplatesData = { flows: { name: string; department: string; version: number; deliverables: string[]; days: number; steps: string[] }[] };

const flowTemplates: PageSkill = {
  name: 'page_flow_templates',
  label: 'Department Flow Templates',
  href: '/admin/templates',
  surface: 'admin',
  can: admin('Department Flow Templates'),
  keywords: /\b(flow templates?|department flows?|production flows?|steps (does|in|of) the [\w /-]+ flow|[\w-]+ flow (have|take|steps))\b/,
  examples: ['Which department flow templates are set up?', 'What steps does the design flow have?'],
  description: 'Department flow templates: the steps (role, working days) each kind of work goes through, by department.',
  load: async (ref, me) => {
    const flows = await svc(ref, TemplatesController).flows(me);
    return {
      flows: flows.slice(0, 15).map((f) => ({
        name: f.name,
        department: f.department,
        version: f.version,
        deliverables: f.deliverableTypes,
        days: f.steps.reduce((s, x) => s + (x.days ?? 0), 0),
        steps: f.steps.map((s) => `${s.name} (${s.role}, ${plural(s.days ?? 0, 'day')})`),
      })),
    } satisfies FlowTemplatesData;
  },
  answer: (d: FlowTemplatesData, q) => {
    const page = link('Department Flow Templates', '/admin/templates');
    if (!d.flows.length) return `No department flows are set up yet. See ${page}.`;
    const one = d.flows.find((f) => q.includes(f.name.toLowerCase()) || f.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && new RegExp(`\\b${w}\\b`).test(q)));
    if (one) return `**${one.name}** (${one.department}, v${one.version}, about ${plural(one.days, 'working day')}):\n${bullets(one.steps, 15)}\n\nSee ${page}.`;
    const rows = d.flows.map((f) => `**${f.name}** (${f.department}): ${plural(f.steps.length, 'step')}, about ${plural(f.days, 'working day')}${f.deliverables.length ? ` · for ${f.deliverables.join(', ')}` : ''}`);
    return `${plural(d.flows.length, 'flow template')}:\n${bullets(rows, 15)}\n\nAsk about one by name for its steps, or see ${page}.`;
  },
};

export type QcChecklistsData = { checklists: { name: string; version: number; items: string[] }[] };

const qcChecklists: PageSkill = {
  name: 'page_qc_checklists',
  label: 'QC Checklists',
  href: '/admin/qc-checklists',
  surface: 'admin',
  can: admin('QC Checklists'),
  keywords: /\b(qc checklists?|quality checklists?|review(er)? checklists?|checklists? (do |that )?reviewers)\b/,
  examples: ['What checklists do reviewers follow?', 'Which review checklists are set up?'],
  description: 'QC checklists reviewers tick before work passes: name, version and the checks on each.',
  load: async (ref, me) => {
    const rows = await svc(ref, TemplatesController).qc(me);
    return { checklists: rows.slice(0, 15).map((r) => ({ name: r.name, version: r.version, items: r.items.map((i) => redact(i)) })) } satisfies QcChecklistsData;
  },
  answer: (d: QcChecklistsData) => {
    const page = link('QC Checklists', '/admin/qc-checklists');
    if (!d.checklists.length) return `No QC checklists are set up yet. See ${page}.`;
    const rows = d.checklists.map((c) => `**${c.name}** (v${c.version}, ${plural(c.items.length, 'check')}): ${c.items.slice(0, 5).join('; ')}${c.items.length > 5 ? '; …' : ''}`);
    return `${plural(d.checklists.length, 'QC checklist')}:\n${bullets(rows, 15)}\n\nSee ${page}.`;
  },
};

export type GateRulesData = { gates: { id: string; name: string; unlockWhen: string }[]; planDeadlineWorkingDays: number; blockProductionOnOverdueInvoice: boolean; requireQcBeforeSend: boolean; releaseFilesAfterFinalPayment: boolean };

const gateRules: PageSkill = {
  name: 'page_gate_rules',
  label: 'Gate Rules',
  href: '/admin/gate-rules',
  surface: 'admin',
  can: admin('Gate Rules'),
  keywords: /\b(gate rules?|gates?|plan deadline|how long .* send the plan)\b/,
  examples: ['What are our gate rules?', 'How long do we get to send the plan to a client?'],
  description: 'Gate rules: the five gates every engagement passes, the plan deadline in working days, and the on/off rules (production stops on an overdue invoice, QC before sending, files after final payment).',
  load: async (ref, me) => {
    const g = (await svc(ref, SettingsService).all(me)).gateRules;
    return { gates: GATES.map((x) => ({ id: x.id, name: x.name, unlockWhen: x.unlock_when })), ...g } satisfies GateRulesData;
  },
  answer: (d: GateRulesData) => {
    const on = (v: boolean) => (v ? 'on' : 'off');
    return [
      `Every engagement passes ${plural(d.gates.length, 'gate')}: ${d.gates.map((g) => `${g.id} ${g.name}`).join(', ')}.`,
      bullets([
        `Plan deadline: ${plural(d.planDeadlineWorkingDays, 'working day')} after requirements are complete`,
        `Stop production when an invoice is overdue: ${on(d.blockProductionOnOverdueInvoice)}`,
        `QC must pass before work is sent to the client: ${on(d.requireQcBeforeSend)} (locked)`,
        `Final files released only after the final payment: ${on(d.releaseFilesAfterFinalPayment)} (locked)`,
      ]),
      `See ${link('Gate Rules', '/admin/gate-rules')}.`,
    ].join('\n\n');
  },
};

export type SlaRulesData = { firstReply: { type: string; target: string }[]; messageReply: string };

const slaRules: PageSkill = {
  name: 'page_sla_rules',
  label: 'SLA Rules',
  href: '/admin/sla-rules',
  surface: 'admin',
  can: admin('SLA Rules'),
  keywords: /\b(sla rules?|sla targets?|reply[- ]time (rules?|targets?)|first[- ]reply (rules?|targets?)|how fast (must|should|do) we (reply|respond))\b/,
  examples: ['Which SLA rules are set?', 'How fast must we reply to an urgent request?'],
  description: 'SLA rules: first-reply target per request type (working time) and the rule for replying to client messages.',
  load: async (ref, me) => {
    const s = (await svc(ref, SettingsService).all(me)).sla;
    return {
      firstReply: (Object.entries(s.firstReplyMinutes) as [RequestType, number][]).map(([t, m]) => ({ type: requestTypeLabels[t]?.team ?? t, target: minutes(m) })),
      messageReply: s.messageReply === 'next_working_day' ? 'by the next working day' : 'the same working day',
    } satisfies SlaRulesData;
  },
  answer: (d: SlaRulesData, q) => {
    const page = link('SLA Rules', '/admin/sla-rules');
    const one = d.firstReply.find((r) => r.type.toLowerCase().split(/[\s()]+/).some((w) => w.length > 3 && !['request', 'within'].includes(w) && new RegExp(`\\b${w}\\b`).test(q)));
    if (one) return `First reply target for **${one.type}**: ${one.target} of working time. See ${page}.`;
    return `First reply targets (working time, 9:30–18:30):\n${bullets(d.firstReply.map((r) => `${r.type}: ${r.target}`))}\n\nClient messages get a reply ${d.messageReply}. See ${page}.`;
  },
};

export type ErrorLogData = { total: number; open: number; byCause: { cause: string; count: number }[]; recent: { what: string; cause: string; prevented: boolean; date: string | null }[] };
const CAUSE: Record<string, string> = { none: 'Not decided yet' };

const errorLog: PageSkill = {
  name: 'page_error_log',
  label: 'Error Log',
  href: '/admin/error-log',
  surface: 'admin',
  can: admin('Error Log'),
  keywords: /\b(error log|errors? logged|logged (errors?|mistakes?)|mistakes? (logged|log)|root causes?|prevention steps?)\b/,
  examples: ["What's in the error log?", 'Which logged mistakes have no prevention step yet?'],
  description: 'Error log: mistakes logged with their cause, how many still have no prevention step, and the latest entries.',
  load: async (ref, me) => {
    const d = await svc(ref, ErrorsController).list(me);
    const label = (c: string | null) => CAUSE[c ?? 'none'] ?? (c ?? 'none').replace(/_/g, ' ');
    return {
      total: d.total,
      open: d.open,
      byCause: d.stats.map((s) => ({ cause: label(s.cause), count: s.count })),
      recent: d.rows.slice(0, 10).map((r) => ({ what: short(r.what, 160), cause: label(r.cause), prevented: !!r.prevention?.trim(), date: day(r.createdAt) })),
    } satisfies ErrorLogData;
  },
  answer: (d: ErrorLogData, q) => {
    const page = link('Error Log', '/admin/error-log');
    if (!d.total) return `Nothing is in the error log yet. See ${page}.`;
    const rows = (/\b(no|without|missing|open)\b/.test(q) ? d.recent.filter((r) => !r.prevented) : d.recent).map((r) => `${r.what} · ${r.cause}${r.date ? ` · ${r.date}` : ''}${r.prevented ? '' : ' · no prevention step yet'}`);
    return `${plural(d.total, 'mistake')} logged, ${d.open} without a prevention step yet. By cause: ${d.byCause.map((c) => `${c.cause} ${c.count}`).join(', ')}.${rows.length ? `\n\nLatest:\n${bullets(rows)}` : ''}\n\nSee ${page}.`;
  },
};

// ------------------------------------------------------------------------------------------------ Customise

export type CustomFieldsData = { byEntity: { entity: string; fields: { label: string; type: string; required: boolean; used: number }[] }[] };

const customFields: PageSkill = {
  name: 'page_custom_fields',
  label: 'Custom Fields',
  href: '/admin/custom-fields',
  surface: 'admin',
  can: admin('Custom Fields'),
  keywords: /\b(custom fields?|extra fields?)\b/,
  examples: ['Which custom fields have we added?'],
  description: 'Custom fields on leads, clients, projects, client requests and creators: label, type, required, and how many records use each.',
  load: async (ref, me) => {
    const rows = (await svc(ref, CustomFieldsService).list(me)).filter((f) => !f.archived);
    const entities = [...new Set(rows.map((f) => f.entity))];
    return {
      byEntity: entities.map((e) => ({
        entity: customFieldEntityLabels[e as CustomFieldEntity]?.many ?? e,
        fields: rows.filter((f) => f.entity === e).slice(0, 15).map((f) => ({ label: f.label, type: f.type, required: f.required, used: f.used })),
      })),
    } satisfies CustomFieldsData;
  },
  answer: (d: CustomFieldsData) => {
    const page = link('Custom Fields', '/admin/custom-fields');
    const n = d.byEntity.reduce((s, e) => s + e.fields.length, 0);
    if (!n) return `No custom fields have been added yet. Add them on ${page}.`;
    const parts = d.byEntity.map((e) => `**${e.entity}**:\n${bullets(e.fields.map((f) => `${f.label} (${f.type}${f.required ? ', required' : ''}) · filled on ${plural(f.used, 'record')}`))}`);
    return `${plural(n, 'custom field')} in use:\n\n${parts.join('\n\n')}\n\nSee ${page}.`;
  },
};

export type FormsData = { forms: { name: string; title: string; live: boolean; fields: number; submissions: number; last: string | null }[] };

const forms: PageSkill = {
  name: 'page_forms',
  label: 'Forms',
  href: '/admin/forms',
  surface: 'admin',
  can: admin('Forms'),
  keywords: /\b(forms|web ?forms?|website forms?|enquiry forms?|form submissions?|which forms?|each form)\b/,
  examples: ['Which forms are live on the website?', 'How many submissions has each form had?'],
  description: 'Public forms (website enquiry forms): live or off, number of fields, submissions and the last submission date.',
  load: async (ref, me) => {
    const rows = await svc(ref, FormsService).list(me);
    return { forms: rows.slice(0, 20).map((f) => ({ name: f.name, title: f.title, live: f.enabled, fields: f.fieldCount, submissions: f.submitCount, last: day(f.lastSubmissionAt) })) } satisfies FormsData;
  },
  answer: (d: FormsData) => {
    const page = link('Forms', '/admin/forms');
    if (!d.forms.length) return `No forms have been made yet. Create one on ${page}.`;
    const live = d.forms.filter((f) => f.live).length;
    const rows = d.forms.map((f) => `**${f.name}** (${f.live ? 'live' : 'off'}): ${plural(f.fields, 'field')}, ${plural(f.submissions, 'submission')}${f.last ? `, last on ${f.last}` : ''}`);
    return `${plural(d.forms.length, 'form')}, ${live} live:\n${bullets(rows, 15)}\n\nSee ${page}.`;
  },
};

export type PipelineSettingsData = { pipelines: { kind: string; customised: boolean; updated: string | null; stages: { label: string; hidden: boolean; targetDays: number | null; required: number }[] }[] };

const pipelineSettings: PageSkill = {
  name: 'page_pipeline_settings',
  label: 'Pipeline Settings',
  href: '/admin/pipelines',
  surface: 'admin',
  can: admin('Pipeline Settings'),
  keywords: /\b(pipeline settings|stage settings|stage targets?|stages? (are |is )?(hidden|renamed)|hidden stages?|renamed stages?|project phases|request statuses)\b/,
  examples: ['Which stages are hidden or renamed?', 'What are the stage targets in our pipelines?'],
  description: 'Pipeline settings for lead stages, project phases and request statuses: labels, hidden stages, days-in-stage targets and required fields.',
  load: async (ref, me) => {
    const v = await svc(ref, PipelinesService).all(me);
    return {
      pipelines: v.pipelines.map((p) => ({
        kind: pipelineKindLabels[p.kind as PipelineKind]?.label ?? p.kind,
        customised: p.customised,
        updated: day(p.updatedAt),
        stages: p.stages.map((s) => ({ label: s.label, hidden: s.hidden, targetDays: s.targetDays, required: s.requiredFields.length })),
      })),
    } satisfies PipelineSettingsData;
  },
  answer: (d: PipelineSettingsData) => {
    const page = link('Pipeline Settings', '/admin/pipelines');
    if (!d.pipelines.length) return `No pipelines are set up. See ${page}.`;
    const parts = d.pipelines.map((p) => {
      const shown = p.stages.filter((s) => !s.hidden);
      const hidden = p.stages.filter((s) => s.hidden).map((s) => s.label);
      const targets = p.stages.filter((s) => s.targetDays != null).map((s) => `${s.label} ${plural(s.targetDays!, 'day')}`);
      return [
        `**${p.kind}** (${p.customised ? `customised${p.updated ? ` ${p.updated}` : ''}` : 'default'}): ${shown.map((s) => `${s.label}${s.required ? ` (${s.required} required)` : ''}`).join(' → ')}`,
        hidden.length ? `  Hidden: ${hidden.join(', ')}` : '',
        targets.length ? `  Days-in-stage targets: ${targets.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    return `${parts.join('\n\n')}\n\nSee ${page}.`;
  },
};

export const SKILLS: PageSkill[] = [services, bundles, addOns, discountLimits, documentTemplates, quoteTemplates, sops, requirementChecklists, flowTemplates, qcChecklists, gateRules, slaRules, errorLog, customFields, forms, pipelineSettings];
