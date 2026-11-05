// v47: what BMU sells: service groups and their sub-services, with the "what it covers" text from bmumarketing.in/services.
// The Client Manager ticks sub-services when adding a service, and the quotation starts from them. Admins can add more.
import { z } from "zod";

/** Each group is a project-level service; its Service row has this key prefix and lives outside the price book. */
export const SERVICE_GROUP_KEY_PREFIX = "group_";
/** The hidden price book that holds those rows, so proposals, the website feed and the price list never see them. */
export const SERVICE_GROUPS_BOOK = "service-groups";

export type SubServiceView = { id: string; name: string; covers: string; archived: boolean };
export type ServiceGroupView = { id: string; name: string; serviceId: string; archived: boolean; subServices: SubServiceView[] };

const name = z.string().trim().min(2, "Enter a name").max(120);
const covers = z.string().trim().max(600);
export const serviceGroupInputSchema = z.object({ name, archived: z.boolean().optional() });
export const subServiceInputSchema = z.object({ name, covers: covers.default(""), archived: z.boolean().optional() });
export type ServiceGroupInput = z.input<typeof serviceGroupInputSchema>;
export type SubServiceInput = z.input<typeof subServiceInputSchema>;

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
