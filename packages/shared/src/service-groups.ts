// v47: what BMU sells: service groups and their sub-services, with the "what it covers" text from bmumarketing.in/services.
// The Client Manager ticks sub-services when adding a service, and the quotation starts from them. Admins can add more.
import { z } from "zod";

/** Each group is a project-level service; its Service row has this key prefix and lives outside the price book. */
export const SERVICE_GROUP_KEY_PREFIX = "group_";
/** The hidden price book that holds those rows, so proposals, the website feed and the price list never see them. */
export const SERVICE_GROUPS_BOOK = "service-groups";

// ---------------------------------------------------------------------------------------------------------------- v52 price list
/** The three plans; a sub-service may offer any of them (a plan with no price is not offered). */
export const PLANS = ["starter", "growth", "premium"] as const;
export type Plan = (typeof PLANS)[number];
export const planLabels: Record<Plan, string> = { starter: "Starter", growth: "Growth", premium: "Premium" };
export const SUB_SERVICE_BILLING = ["monthly", "one_time", "per_unit"] as const;
export type SubServiceBilling = (typeof SUB_SERVICE_BILLING)[number];
export const billingLabels: Record<SubServiceBilling, string> = { monthly: "Monthly", one_time: "One-time project", per_unit: "Per unit" };
/** After a price: "₹25,000 per month". */
export const billingPer: Record<SubServiceBilling, string> = { monthly: "per month", one_time: "one time", per_unit: "per unit" };
export type PlanPrices = Record<Plan, number | null>;

export type SubServiceView = { id: string; name: string; covers: string; archived: boolean; billing: SubServiceBilling; prices: PlanPrices };
export type ServiceGroupView = { id: string; name: string; serviceId: string; archived: boolean; subServices: SubServiceView[] };

const name = z.string().trim().min(2, "Enter a name").max(120);
const covers = z.string().trim().max(600);
const price = z.number().int().min(0).max(10_000_000_000).nullable().optional();
export const serviceGroupInputSchema = z.object({ name, archived: z.boolean().optional() });
export const subServiceInputSchema = z.object({
  name,
  covers: covers.default(""),
  archived: z.boolean().optional(),
  billing: z.enum(SUB_SERVICE_BILLING).optional(),
  starterPaise: price,
  growthPaise: price,
  premiumPaise: price,
});
export type ServiceGroupInput = z.input<typeof serviceGroupInputSchema>;
export type SubServiceInput = z.input<typeof subServiceInputSchema>;

/** A bundle's plan price is worked out, never stored: its sub-services' prices for that plan minus the saving, in paise. */
export function bundlePlanPricePaise(memberPrices: (number | null | undefined)[], savingPct: number): number | null {
  if (!memberPrices.length || memberPrices.some((p) => p == null)) return null;
  const sum = memberPrices.reduce<number>((s, p) => s + (p ?? 0), 0);
  return Math.round((sum * (100 - savingPct)) / 100);
}

export type BundleView = { id: string; name: string; subServiceIds: string[]; savingPct: number; selectable: boolean; prices: PlanPrices };
export const bundleInputSchema = z.object({
  name: z.string().trim().min(2, "Name the bundle").max(120),
  subServiceIds: z
    .array(z.string().min(1))
    .min(2, "A bundle needs at least 2 sub services")
    .max(20, "A bundle holds up to 20 sub services")
    .refine((ids) => new Set(ids).size === ids.length, "Each sub service can be in a bundle once"),
  savingPct: z.number().int().min(0, "Saving is 0–90%").max(90, "Saving is 0–90%").default(10),
  selectable: z.boolean().default(true),
});
export type BundleInput = z.input<typeof bundleInputSchema>;

/** Works out every plan's price for a bundle from the current sub-service prices. */
export function bundlePrices(subServiceIds: string[], subs: Map<string, { prices: PlanPrices }>, savingPct: number): PlanPrices {
  return Object.fromEntries(PLANS.map((p) => [p, bundlePlanPricePaise(subServiceIds.map((id) => subs.get(id)?.prices[p]), savingPct)])) as PlanPrices;
}

export type IndustryView = { id: string; name: string; archived: boolean };
export const industryInputSchema = z.object({ name: z.string().trim().min(2, "Enter an industry").max(80), archived: z.boolean().optional() });
export type IndustryInput = z.input<typeof industryInputSchema>;

/** Everything a form needs to pick from: services with their sub-services, and the bundles. */
export type PriceList = { groups: ServiceGroupView[]; bundles: BundleView[] };

/** One choice in the "Add item" picker: a sub-service or bundle at one plan. */
export type PriceListEntry = {
  key: string;
  kind: "sub" | "bundle";
  id: string;
  /** The group's name, or "Bundle" */
  service: string;
  name: string;
  plan: Plan;
  pricePaise: number;
  billing: SubServiceBilling;
  description: string;
  label: string;
};

/** The lowest priced plan a sub-service or bundle offers (used when a client's service has no plan chosen). */
export function lowestPlan(prices: PlanPrices): Plan | null {
  const offered = PLANS.filter((p) => prices[p] != null);
  return offered.length ? offered.reduce((a, b) => ((prices[b] as number) < (prices[a] as number) ? b : a)) : null;
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The picker's choices, e.g. "Marketing & Visibility › SEO — Growth · ₹25,000 per month" and "Bundle › Brand Launch — Starter · ₹67,500 per month". */
export function priceListEntries(list: PriceList, opts: { includeHidden?: boolean } = {}): PriceListEntry[] {
  const subs = new Map(list.groups.flatMap((g) => g.subServices.map((s) => [s.id, { ...s, group: g.name }] as const)));
  const out: PriceListEntry[] = [];
  for (const g of list.groups) {
    if (g.archived && !opts.includeHidden) continue;
    for (const s of g.subServices) {
      if (s.archived && !opts.includeHidden) continue;
      for (const plan of PLANS) {
        const p = s.prices[plan];
        if (p == null) continue;
        out.push({ key: `sub:${s.id}:${plan}`, kind: "sub", id: s.id, service: g.name, name: s.name, plan, pricePaise: p, billing: s.billing, description: s.covers, label: `${g.name} › ${s.name} — ${planLabels[plan]} · ${inr(p)} ${billingPer[s.billing]}` });
      }
    }
  }
  for (const b of list.bundles) {
    if (!b.selectable && !opts.includeHidden) continue;
    for (const plan of PLANS) {
      const p = b.prices[plan];
      if (p == null) continue;
      const description = b.subServiceIds.map((id) => subs.get(id)?.name).filter(Boolean).join(" + ");
      out.push({ key: `bundle:${b.id}:${plan}`, kind: "bundle", id: b.id, service: "Bundle", name: b.name, plan, pricePaise: p, billing: "monthly", description, label: `Bundle › ${b.name} — ${planLabels[plan]} · ${inr(p)} per month` });
    }
  }
  return out;
}

export const SERVICE_GROUPS_SEED: { name: string; subServices: { name: string; covers: string }[] }[] = [
  {
    name: "Marketing & Visibility",
    subServices: [
      { name: "SEO", covers: "Gets your website found when people search Google for what you sell. Includes a technical SEO audit, keyword and page map, on-page work, service and location pages, content plan and articles, and links and citations." },
      { name: "Local SEO", covers: 'Gets your business into the Google Maps map pack for "near me" searches. Includes a local ranking audit, Business Profile optimisation, citation cleanup, location pages, review requests and local links.' },
      { name: "Google Business Profile Optimisation", covers: "Set-up and verification of your Google Business Profile, then upkeep: categories and services, photos and videos, regular posts, review replies, and monitoring for duplicates and unwanted edits." },
      { name: "Google Ads", covers: "Google Search, Performance Max and YouTube campaigns built around leads and sales, with conversion tracking set up before spend starts. Includes account setup or audit, keyword research, ads and assets, landing page changes and ongoing optimisation." },
      { name: "Meta Ads", covers: "Facebook and Instagram ads for leads and sales: Pixel and Conversions API setup, campaign structure, creative testing, lead forms or WhatsApp ads, lead routing and weekly optimisation." },
      { name: "Performance Marketing", covers: "Paid campaigns across Google, Meta and other channels against a cost-per-lead or ROAS target: target and budget plan, cross-channel tracking, landing page tests, CRM feedback loop and one weekly report." },
      { name: "AI Search Visibility", covers: "Helps AI tools such as ChatGPT, Gemini, Perplexity and Google AI Overviews find and recommend your business: visibility checks, consistent business facts, answer-ready pages and structured data." },
      { name: "Digital Marketing", covers: "One monthly plan run by one team across SEO, Google and Meta ads, social media and Maps: full digital audit, channel plan, social calendar, and one report with a monthly review call." },
      { name: "Content Marketing", covers: "Blogs, guides, sales page copy and newsletters that answer customers' questions: question research, editorial calendar, expert interviews, articles, sales page copy, newsletters and case studies." },
    ],
  },
  {
    name: "Social & Personal Brand",
    subServices: [
      { name: "Social Media Management", covers: "Monthly Instagram, Facebook and LinkedIn management: content calendar, reels, posts and carousels, captions and hashtags, replies to comments and DMs, and a monthly insights report." },
      { name: "Instagram Marketing", covers: "Instagram growth for your business: profile and highlights, a reels-first calendar, stories, collab posts, DM replies and lead capture, and Instagram-placement ads." },
      { name: "Personal Branding", covers: "Personal branding for founders, doctors and experts on Instagram, YouTube and LinkedIn: positioning session, content idea bank, scripts, batch recording, editing and posting, and profile setup." },
      { name: "LinkedIn Branding", covers: "LinkedIn for founders and B2B companies: profile rewrite, content strategy, ghostwritten posts approved by you, carousels and visuals, company page management and an engagement playbook." },
    ],
  },
  {
    name: "UGC & Creator Marketing",
    subServices: [
      { name: "UGC Videos", covers: "Phone-style UGC videos by real creators (unboxings, reviews, testimonials) for ads and product pages: creator sourcing, briefs, shoot coordination, hook variations, edits for ads and written usage rights." },
      { name: "Influencer Marketing", covers: "Instagram and YouTube creator campaigns: creator shortlist, audience vetting, agreements, briefs with ASCI-compliant disclosure, campaign coordination, and tracking through unique codes and links." },
    ],
  },
  {
    name: "Brand & Design",
    subServices: [
      { name: "Brand Identity Design", covers: "Logo, colour palette, typography and brand guidelines so your business looks consistent everywhere: discovery, logo suite, colour and type, guidelines, brand applications and a master file pack." },
      { name: "Packaging Design", covers: "Packaging for D2C and retail products (boxes, labels, pouches): concepts shown as 3D mock-ups, label and copy layout, print-ready dieline artwork, range system and listing images." },
      { name: "UI/UX Design", covers: "UI/UX design for websites, web apps and mobile apps: user research, flows and wireframes, visual design, clickable Figma prototype, design system and developer handover." },
      { name: "Pitch Decks", covers: "Investor and sales pitch decks: story and structure, slide copywriting, charts and diagrams, custom slide design, presentation and detailed versions, and editable master slides." },
    ],
  },
  {
    name: "Web & AI",
    subServices: [
      { name: "Website Design", covers: "Website design that turns visits into enquiries: site structure, wireframes, copy hierarchy, mobile-first page designs, call, form and WhatsApp conversion elements, and build-ready Figma files." },
      { name: "Website Development", covers: "Fast, mobile-first websites built to bring enquiries: sitemap and content plan, custom design, responsive build (WordPress, Shopify or custom), page copy, SEO and tracking setup, and team training." },
      { name: "Web App Development", covers: "Custom web apps such as customer portals, booking systems, dashboards and internal tools: MVP scope, UX and screen design, front-end and back-end build, integrations, testing and security, deployment and support." },
      { name: "Mobile App Development", covers: "Android and iOS apps built from one cross-platform codebase: app scope, screen design, back end and admin panel, Play Store and App Store submission, and analytics and crash reporting." },
      { name: "AI Chatbots", covers: "AI chatbots for your website and WhatsApp that answer questions from your own information, qualify leads and book appointments: knowledge base, conversation design, lead capture, hand-off and monitoring." },
      { name: "WhatsApp Automation", covers: "WhatsApp Business API setup with broadcasts to opted-in customers, automated flows, message templates, a WhatsApp catalogue and a shared team inbox, so enquiries and reorders are not missed." },
      { name: "Marketing Automation", covers: "CRM setup (Zoho, HubSpot or LeadSquared), lead source integration, lead routing rules, email and WhatsApp nurture sequences, lead scoring, and dashboards with team training." },
    ],
  },
  {
    name: "Content & Production",
    subServices: [
      { name: "Photography", covers: "Commercial photography for products, food, interiors and teams: shot list, product and food shots, interiors, corporate portraits, and edited images in the sizes you need for ads, websites and marketplaces." },
      { name: "Video Production", covers: "Video for reels, ads, brand films and testimonials: concept and script, storyboard, shoot day, editing and motion graphics, platform versions for Instagram and YouTube, and a B-roll library." },
      { name: "Drone Shoots", covers: "Aerial drone video and photos for real estate, resorts, events and construction: site recce, airspace and permission check, aerial video and photography, progress shoots, and edited films and reels." },
    ],
  },
];
