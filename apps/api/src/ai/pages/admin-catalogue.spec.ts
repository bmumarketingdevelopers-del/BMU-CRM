// Command Centre Catalogue / Operations / Customise page skills: the basic-mode answers, from sample data shaped like
// each skill's load() result (and the empty case).
import { describe, expect, it } from 'vitest';
import type { AddOnsData, BundlesData, CustomFieldsData, DiscountLimitsData, DocumentTemplatesData, ErrorLogData, FlowTemplatesData, FormsData, GateRulesData, PipelineSettingsData, QcChecklistsData, QuoteTemplatesData, RequirementChecklistsData, ServicesData, SlaRulesData, SopsData } from './admin-catalogue.js';
import { SKILLS } from './admin-catalogue.js';

const skill = (name: string) => {
  const s = SKILLS.find((x) => x.name === name);
  if (!s) throw new Error(`no skill ${name}`);
  return (data: unknown, q = '') => s.answer(data as never, q.toLowerCase());
};

describe('Ask BMU Catalogue, Operations and Customise page skills', () => {
  it('Services & Tiers lists services, and a plan\'s prices when asked', () => {
    const answer = skill('page_services_tiers');
    const d: ServicesData = {
      services: [
        { name: 'Social Media Marketing', subServices: [{ name: 'Instagram management', billing: 'per month', prices: [{ plan: 'Starter', price: '₹15,000' }, { plan: 'Growth', price: '₹25,000' }] }] },
        { name: 'Website', subServices: [] },
      ],
      priceBook: { version: '2026.1', services: [{ name: 'SEO', tiers: [{ plan: 'Growth', price: '₹30,000' }] }] },
    };
    const all = answer(d, 'What services do we offer?');
    expect(all).toContain('2 services');
    expect(all).toContain('**Social Media Marketing**: 1 sub-service (Instagram management)');
    expect(all).toContain('Website**: no sub-services yet');
    expect(all).toContain('[Services & Tiers](/admin/catalogue)');
    const growth = answer(d, 'What is the price of the Growth tier?');
    expect(growth).toContain('Growth prices');
    expect(growth).toContain('Social Media Marketing · Instagram management: ₹25,000 per month');
    expect(growth).toContain('SEO (price book 2026.1): ₹30,000');
    expect(growth).not.toContain('₹15,000');
    expect(answer({ services: [], priceBook: { version: 'v1', services: [] } })).toContain('No services are set up yet');
  });

  it('Bundles shows members, saving and prices', () => {
    const answer = skill('page_bundles');
    const d: BundlesData = {
      bundles: [{ name: 'Launch Pack', subServices: ['Logo', 'Website'], savingPct: 10, selectable: false, prices: [{ plan: 'Starter', price: '₹45,000' }] }],
      priceBookBundles: [{ name: 'Growth combo', services: 3, discountPct: 15 }],
    };
    const text = answer(d);
    expect(text).toContain('1 bundle');
    expect(text).toContain('**Launch Pack** (10% saving, hidden from sellers): Logo + Website · Starter ₹45,000');
    expect(text).toContain('Growth combo (15% off 3 services)');
    expect(text).toContain('(/admin/bundles)');
    expect(answer({ bundles: [], priceBookBundles: [] })).toContain('No bundles are set up yet');
  });

  it('Add-ons shows a price per unit or custom quote', () => {
    const answer = skill('page_add_ons');
    const d: AddOnsData = { priceBook: '2026.1', addOns: [{ name: 'Extra reel', price: '₹3,000', unit: 'reel', customQuote: false }, { name: 'Shoot day', price: null, unit: null, customQuote: true }] };
    const text = answer(d);
    expect(text).toContain('2 add-ons on price book 2026.1');
    expect(text).toContain('Extra reel: ₹3,000 per reel');
    expect(text).toContain('Shoot day: custom quote');
    expect(answer({ priceBook: 'v1', addOns: [] })).toContain('No add-ons');
  });

  it('Discount Limits lists every role, or the one asked about', () => {
    const answer = skill('page_discount_limits');
    const d: DiscountLimitsData = { limits: [{ role: 'Sales executive', pct: 5 }, { role: 'Sales manager', pct: 10 }, { role: 'Branch Manager', pct: 20 }] };
    expect(answer(d, 'How much discount can a sales manager give?')).toContain('A Sales manager can add up to 10% extra discount');
    const all = answer(d, 'What are the discount limits?');
    expect(all).toContain('Sales executive: up to 5%');
    expect(all).toContain('Founder: no limit');
    expect(all).toContain('(/admin/discount-limits)');
  });

  it('Proposal & Agreement Templates quotes the asked part', () => {
    const answer = skill('page_document_templates');
    const d: DocumentTemplatesData = { proposalIntro: 'Thank you for considering BMU.', proposalTerms: 'Prices exclude GST.', agreementBody: 'This agreement is between BMU and the client.' };
    const agreement = answer(d, 'What does our agreement template say?');
    expect(agreement).toContain('**Agreement**: This agreement is between BMU');
    expect(agreement).not.toContain('Prices exclude GST');
    expect(answer(d, 'What are the proposal terms?')).toContain('**Proposal terms**: Prices exclude GST.');
    expect(answer({ proposalIntro: '', proposalTerms: '', agreementBody: '' }, 'templates')).toContain('(empty)');
  });

  it('Quotation Templates lists templates', () => {
    const answer = skill('page_quote_templates');
    const d: QuoteTemplatesData = { templates: [{ name: 'Influencer campaign', title: 'Bengaluru Influencer Campaign', service: 'Influencer Marketing', lines: 4, subtotal: '₹1,20,000', updated: '12 Nov 2026' }] };
    const text = answer(d);
    expect(text).toContain('1 quotation template');
    expect(text).toContain('**Influencer campaign** (Influencer Marketing): "Bengaluru Influencer Campaign", 4 cost lines, ₹1,20,000 before GST · updated 12 Nov 2026');
    expect(answer({ templates: [] })).toContain('No quotation templates are saved yet');
  });

  it('SOP Library shows drafts and acknowledgements', () => {
    const answer = skill('page_admin_sops');
    const d: SopsData = { total: 3, drafts: [{ title: 'Reel editing', department: 'Video' }], published: [{ title: 'Client onboarding', department: 'Client Management', version: 2, acknowledged: 1 }, { title: 'Design QC', department: 'Design', version: 1, acknowledged: 6 }], canEditAny: true };
    const drafts = answer(d, 'Which SOPs are still drafts?');
    expect(drafts.indexOf('1 draft waiting')).toBeLessThan(drafts.indexOf('Acknowledgements'));
    expect(drafts).toContain('Reel editing (Video)');
    const acks = answer(d, 'How many people acknowledged our SOPs?');
    expect(acks.indexOf('Acknowledgements')).toBeLessThan(acks.indexOf('draft'));
    expect(acks).toContain('Client onboarding v2 (Client Management): 1 person');
    expect(acks).toContain('Design QC v1 (Design): 6 people');
    expect(answer({ total: 0, drafts: [], published: [], canEditAny: false })).toContain('The SOP library is empty');
  });

  it('Requirement Checklists shows the default list and own lists', () => {
    const answer = skill('page_requirement_checklists');
    const d: RequirementChecklistsData = { defaultList: [{ label: 'Brand logo files', type: 'file' }, { label: 'Kick-off call', type: 'call' }], services: [{ name: 'Website', items: [{ label: 'Domain login', type: 'access' }] }], servicesUsingDefault: 7 };
    const text = answer(d);
    expect(text).toContain('Default list (7 services use it)');
    expect(text).toContain('- Brand logo files (file)');
    expect(text).toContain('Website: Domain login');
    expect(answer({ defaultList: [], services: [], servicesUsingDefault: 0 })).toContain('The default list is empty');
  });

  it('Department Flow Templates lists flows, or one flow\'s steps', () => {
    const answer = skill('page_flow_templates');
    const d: FlowTemplatesData = { flows: [{ name: 'Design asset', department: 'Creative / Design', version: 2, deliverables: ['post', 'story'], days: 6, steps: ['Brief and references (strategist, 1 day)', 'Design (producer, 2 days)'] }, { name: 'Reel', department: 'Video', version: 1, deliverables: ['reel'], days: 5, steps: ['Edit (producer, 3 days)'] }] };
    const one = answer(d, 'What steps does the design flow have?');
    expect(one).toContain('**Design asset** (Creative / Design, v2, about 6 working days)');
    expect(one).toContain('- Design (producer, 2 days)');
    expect(one).not.toContain('Reel');
    const all = answer(d, 'Which department flow templates are set up?');
    expect(all).toContain('2 flow templates');
    expect(all).toContain('**Reel** (Video): 1 step');
    expect(answer({ flows: [] })).toContain('No department flows');
  });

  it('QC Checklists lists the checks', () => {
    const answer = skill('page_qc_checklists');
    const d: QcChecklistsData = { checklists: [{ name: 'Design QC', version: 3, items: ['Brand colours', 'Spelling', 'Logo placement'] }] };
    expect(answer(d)).toContain('**Design QC** (v3, 3 checks): Brand colours; Spelling; Logo placement');
    expect(answer({ checklists: [] })).toContain('No QC checklists');
  });

  it('Gate Rules shows gates and on/off rules', () => {
    const answer = skill('page_gate_rules');
    const d: GateRulesData = { gates: [{ id: 'G1', name: 'Requirements Complete', unlockWhen: 'x' }, { id: 'G2', name: 'Plan Approved', unlockWhen: 'y' }], planDeadlineWorkingDays: 4, blockProductionOnOverdueInvoice: false, requireQcBeforeSend: true, releaseFilesAfterFinalPayment: true };
    const text = answer(d);
    expect(text).toContain('2 gates: G1 Requirements Complete, G2 Plan Approved');
    expect(text).toContain('Plan deadline: 4 working days');
    expect(text).toContain('invoice is overdue: off');
    expect(text).toContain('(/admin/gate-rules)');
  });

  it('SLA Rules lists targets, or the asked request type', () => {
    const answer = skill('page_sla_rules');
    const d: SlaRulesData = { firstReply: [{ type: 'Change within scope', target: '4 h' }, { type: 'Urgent request', target: '2 h' }, { type: 'Question', target: '1 h 30 min' }], messageReply: 'the same working day' };
    expect(answer(d, 'How fast must we reply to an urgent request?')).toContain('**Urgent request**: 2 h');
    const all = answer(d, 'Which SLA rules are set?');
    expect(all).toContain('- Question: 1 h 30 min');
    expect(all).toContain('Client messages get a reply the same working day');
  });

  it('Error Log shows counts and the entries without prevention', () => {
    const answer = skill('page_error_log');
    const d: ErrorLogData = { total: 5, open: 2, byCause: [{ cause: 'process', count: 3 }, { cause: 'Not decided yet', count: 2 }], recent: [{ what: 'Wrong logo sent', cause: 'process', prevented: false, date: '20 Nov 2026' }, { what: 'Missed caption', cause: 'process', prevented: true, date: '18 Nov 2026' }] };
    const all = answer(d, "What's in the error log?");
    expect(all).toContain('5 mistakes logged, 2 without a prevention step yet');
    expect(all).toContain('Missed caption');
    const open = answer(d, 'Which logged mistakes have no prevention step yet?');
    expect(open).toContain('Wrong logo sent · process · 20 Nov 2026 · no prevention step yet');
    expect(open).not.toContain('Missed caption');
    expect(answer({ total: 0, open: 0, byCause: [], recent: [] })).toContain('Nothing is in the error log yet');
  });

  it('Custom Fields groups fields by record type', () => {
    const answer = skill('page_custom_fields');
    const d: CustomFieldsData = { byEntity: [{ entity: 'Leads', fields: [{ label: 'Budget band', type: 'select', required: true, used: 12 }] }] };
    const text = answer(d);
    expect(text).toContain('1 custom field');
    expect(text).toContain('**Leads**:\n- Budget band (select, required) · filled on 12 records');
    expect(answer({ byEntity: [] })).toContain('No custom fields');
  });

  it('Forms shows live state and submissions', () => {
    const answer = skill('page_forms');
    const d: FormsData = { forms: [{ name: 'Website enquiry', title: 'Talk to us', live: true, fields: 6, submissions: 41, last: '27 Nov 2026' }, { name: 'Old form', title: 'Old', live: false, fields: 3, submissions: 0, last: null }] };
    const text = answer(d);
    expect(text).toContain('2 forms, 1 live');
    expect(text).toContain('**Website enquiry** (live): 6 fields, 41 submissions, last on 27 Nov 2026');
    expect(text).toContain('**Old form** (off): 3 fields, 0 submissions');
    expect(answer({ forms: [] })).toContain('No forms');
  });

  it('Pipeline Settings shows stages, hidden ones and targets', () => {
    const answer = skill('page_pipeline_settings');
    const d: PipelineSettingsData = {
      pipelines: [
        { kind: 'Lead stages', customised: true, updated: '1 Nov 2026', stages: [{ label: 'New', hidden: false, targetDays: 2, required: 0 }, { label: 'Qualified', hidden: false, targetDays: null, required: 2 }, { label: 'Nurture', hidden: true, targetDays: null, required: 0 }] },
        { kind: 'Request statuses', customised: false, updated: null, stages: [{ label: 'Open', hidden: false, targetDays: null, required: 0 }] },
      ],
    };
    const text = answer(d);
    expect(text).toContain('**Lead stages** (customised 1 Nov 2026): New → Qualified (2 required)');
    expect(text).toContain('Hidden: Nurture');
    expect(text).toContain('Days-in-stage targets: New 2 days');
    expect(text).toContain('**Request statuses** (default): Open');
    expect(answer({ pipelines: [] })).toContain('No pipelines');
  });

  it('every skill ends with a link to its own page', () => {
    for (const s of SKILLS) expect(s.href).toMatch(/^\/admin\//);
  });
});
