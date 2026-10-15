import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { isAbsolute, join, resolve } from 'node:path';
import { CRAFT_CHECKLISTS, DEFAULT_QC_CHECKLISTS } from '@bmu/shared';
import type { PrismaClient, Tier } from '../../src/generated/prisma/client.js';
import { sameDept } from './dept-names.js';

/**
 * v10 craft demo data: one specialist per job function so every specialist dashboard is alive.
 *
 * - Six specialists (…@bmu.demo): video@, script@, social@, dev@, uxui@, design@ with a `specialty`.
 * - Clients (stable names): Saffron Table Restaurants (social retainer), Urbanloom Apparel (graphic design +
 *   social), Peak Motors (video project + landing page) and Brightpath Academy (website + UX project).
 * - Deliverables at every stage (idea → published), versions (real PNG files for designs, links for video and
 *   staging sites, Markdown for scripts), QC passes and fails, client pins and time-coded notes, revision
 *   rounds, approvals, change requests, hooks, script drafts, checklists and brand kits.
 * - Each producer specialist carries a healthy open workload, so least-loaded assignment in production.e2e
 *   still picks producer@bmu.demo.
 * - A project manager (pm@bmu.demo, base role account_manager) who is the CM of Peak Motors and Brightpath
 *   Academy: unassigned tasks to hand out, client messages waiting, an overdue invoice, call notes and a reminder.
 * Idempotent: users are upserted; the client data is created once (checked by client name).
 */

const DAY = 86_400_000;
const IST = 330 * 60_000;

/** Deterministic pseudo-random numbers so a fresh seed always looks the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` days from now at hh:mm IST. */
const at = (n: number, hour = 18, minute = 0) => {
  const ist = new Date(Date.now() + n * DAY + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute) - IST);
};
const period = (monthOffset: number) => {
  const ist = new Date(Date.now() + IST);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + monthOffset, 1));
  return d.toISOString().slice(0, 7);
};

// ---------------------------------------------------------------------------
// Tiny PNG writer (no dependencies) for realistic design versions and brand files.

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** A simple "social creative": brand background, a card, a sun/circle and a few text bars. Varies by version. */
function creative(palette: string[], seed: number, w = 720, h = 720): Buffer {
  const r = rng(seed);
  const [bg, card, accent, ink] = palette.map(hex);
  const cx = w * (0.3 + r() * 0.4);
  const cy = h * (0.25 + r() * 0.2);
  const rad = w * (0.12 + r() * 0.08);
  const bars = Array.from({ length: 3 }, (_, i) => ({ y: h * (0.62 + i * 0.08), len: w * (0.35 + r() * 0.35) }));
  return png(w, h, (x, y) => {
    const inCard = x > w * 0.08 && x < w * 0.92 && y > h * 0.08 && y < h * 0.92;
    if (!inCard) return bg;
    if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) return accent;
    for (const b of bars) if (y > b.y && y < b.y + h * 0.035 && x > w * 0.14 && x < w * 0.14 + b.len) return ink;
    return card;
  });
}

// ---------------------------------------------------------------------------
// People

const SPECIALISTS = [
  { key: 'video', email: 'video@bmu.demo', name: 'Aman Verma', specialty: 'video_editor', role: 'producer', dept: 'Video / Production', manager: 'admin@bmu.demo' },
  { key: 'script', email: 'script@bmu.demo', name: 'Nisha Kulkarni', specialty: 'script_writer', role: 'producer', dept: 'Strategy', manager: 'am.lead@bmu.demo' },
  { key: 'social', email: 'social@bmu.demo', name: 'Tara Fernandes', specialty: 'social_media_manager', role: 'strategist', dept: 'Strategy', manager: 'am.lead@bmu.demo' },
  { key: 'dev', email: 'dev@bmu.demo', name: 'Karthik Iyer', specialty: 'developer', role: 'producer', dept: 'Web / AI', manager: 'admin@bmu.demo' },
  { key: 'uxui', email: 'uxui@bmu.demo', name: 'Zoya Mirza', specialty: 'ux_ui_designer', role: 'producer', dept: 'Creative / Design', manager: 'design.head@bmu.demo' },
  { key: 'design', email: 'design@bmu.demo', name: 'Rhea Bose', specialty: 'graphic_designer', role: 'producer', dept: 'Creative / Design', manager: 'design.head@bmu.demo' },
] as const;
type Who = (typeof SPECIALISTS)[number]['key'] | 'qc' | 'am';
const PM = { email: 'pm@bmu.demo', name: 'Devika Rao', specialty: 'project_manager', role: 'account_manager', dept: 'Client Management', manager: 'am.lead@bmu.demo' };
/** Clients the project manager looks after (everything else stays with am@bmu.demo). */
const PM_CLIENTS = ['Peak Motors', 'Brightpath Academy'];

// ---------------------------------------------------------------------------
// Flows (owners by specialist)

type Step = { key: string; name: string; role: string; kind: 'work' | 'qc' | 'client_review'; who: Who };
const QC: Step = { key: 'qc', name: 'Internal QC', role: 'qc_reviewer', kind: 'qc', who: 'qc' };
const CLIENT: Step = { key: 'client', name: 'Client review', role: 'am', kind: 'client_review', who: 'am' };
const FLOWS: Record<string, { dept: string; qcKey: string; steps: Step[] }> = {
  design: {
    dept: 'Creative / Design',
    qcKey: 'design',
    steps: [{ key: 'brief', name: 'Brief and references', role: 'strategist', kind: 'work', who: 'social' }, { key: 'design', name: 'Design', role: 'producer', kind: 'work', who: 'design' }, QC, CLIENT],
  },
  video: {
    dept: 'Video / Production',
    qcKey: 'video',
    steps: [
      { key: 'script', name: 'Script and shot list', role: 'strategist', kind: 'work', who: 'script' },
      { key: 'shoot', name: 'Shoot or source footage', role: 'producer', kind: 'work', who: 'video' },
      { key: 'edit', name: 'Edit', role: 'producer', kind: 'work', who: 'video' },
      QC,
      CLIENT,
    ],
  },
  web: {
    dept: 'Web / AI',
    qcKey: 'web',
    steps: [{ key: 'wireframe', name: 'Wireframe', role: 'producer', kind: 'work', who: 'uxui' }, { key: 'build', name: 'Build', role: 'producer', kind: 'work', who: 'dev' }, QC, { ...CLIENT, name: 'Client review on live URL' }],
  },
  writing: { dept: 'Strategy', qcKey: 'writing', steps: [{ key: 'write', name: 'Write', role: 'producer', kind: 'work', who: 'script' }, QC, CLIENT] },
  ux: {
    dept: 'Creative / Design',
    qcKey: 'design',
    steps: [
      { key: 'research', name: 'Research', role: 'producer', kind: 'work', who: 'uxui' },
      { key: 'wireframe', name: 'Wireframe', role: 'producer', kind: 'work', who: 'uxui' },
      { key: 'ui', name: 'UI design', role: 'producer', kind: 'work', who: 'uxui' },
      { key: 'prototype', name: 'Prototype', role: 'producer', kind: 'work', who: 'uxui' },
      QC,
      CLIENT,
    ],
  },
};

type State = 'planned' | 'making' | 'queued' | 'in_qc' | 'qc_failed' | 'qc_passed' | 'client' | 'changes' | 'approved' | 'scheduled' | 'published';
type Note = { body: string; t?: number; x?: number; y?: number; resolved?: boolean; internal?: boolean };
type Spec = {
  eng: string;
  cycle: number | 'project';
  type: string;
  title: string;
  flow: keyof typeof FLOWS;
  state: State;
  /** Days from now when the maker's current step is due (negative = past). */
  due: number;
  rounds?: number;
  qcFails?: number;
  /** For 'making' / 'queued': index of the work step that is open (default the last work step). */
  step?: number;
  /** For 'client': days since it was sent. */
  sent?: number;
  notes?: Note[];
  hours?: number;
};

const ENGAGEMENTS: Record<string, { client: string; service: string; tier: Tier; billing: 'monthly' | 'one_time'; status: 'active_retainer' | 'in_production' | 'in_review'; palette: string[] }> = {
  saffron_smm: { client: 'Saffron Table Restaurants', service: 'smm', tier: 'growth', billing: 'monthly', status: 'active_retainer', palette: ['#7A2E14', '#FFF4E3', '#E89B2D', '#3B1A0C'] },
  urbanloom_gd: { client: 'Urbanloom Apparel', service: 'graphic_design', tier: 'growth', billing: 'monthly', status: 'active_retainer', palette: ['#23313F', '#F2EEE7', '#C9A27E', '#23313F'] },
  urbanloom_smm: { client: 'Urbanloom Apparel', service: 'smm_brands', tier: 'premium', billing: 'monthly', status: 'active_retainer', palette: ['#23313F', '#F2EEE7', '#C9A27E', '#23313F'] },
  peak_video: { client: 'Peak Motors', service: 'video_editing', tier: 'premium', billing: 'one_time', status: 'in_review', palette: ['#111111', '#EDEDED', '#D7261E', '#111111'] },
  peak_web: { client: 'Peak Motors', service: 'website', tier: 'starter', billing: 'one_time', status: 'in_production', palette: ['#111111', '#EDEDED', '#D7261E', '#111111'] },
  brightpath_web: { client: 'Brightpath Academy', service: 'website', tier: 'premium', billing: 'one_time', status: 'in_production', palette: ['#0E3B5C', '#F7FAFC', '#2BB3A3', '#0E3B5C'] },
};

const CLIENTS: Record<string, { industry: string; owner: string; email: string; brand: { colours: string[]; fonts: string[]; notes: string } }> = {
  'Saffron Table Restaurants': {
    industry: 'Restaurants',
    owner: 'Ritu Malhotra',
    email: 'ritu@saffrontable.example',
    brand: { colours: ['#7A2E14', '#E89B2D', '#FFF4E3', '#3B1A0C'], fonts: ['Playfair Display', 'Work Sans'], notes: 'Warm, homely tone. Food close-ups on terracotta. Logo always bottom-right on posts, never on the dish.' },
  },
  'Urbanloom Apparel': {
    industry: 'Fashion retail',
    owner: 'Kabir Sethi',
    email: 'kabir@urbanloom.example',
    brand: { colours: ['#23313F', '#C9A27E', '#F2EEE7'], fonts: ['Cormorant Garamond', 'Inter'], notes: 'Minimal and airy. Lots of negative space, no drop shadows, product on linen textures.' },
  },
  'Peak Motors': {
    industry: 'Automobile dealership',
    owner: 'Sandeep Rao',
    email: 'sandeep@peakmotors.example',
    brand: { colours: ['#D7261E', '#111111', '#EDEDED'], fonts: ['Barlow Condensed', 'Barlow'], notes: 'Bold, fast cuts. Red only for calls to action. Always show the showroom address on end cards.' },
  },
  'Brightpath Academy': {
    industry: 'Education',
    owner: 'Dr. Meenakshi Iyer',
    email: 'meenakshi@brightpath.example',
    brand: { colours: ['#0E3B5C', '#2BB3A3', '#F7FAFC', '#F4B740'], fonts: ['Poppins', 'Source Sans 3'], notes: 'Trustworthy and friendly. Real student photos only, no stock. WCAG AA contrast on every screen.' },
  },
};

const VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

const SPECS: Spec[] = [
  // --- Saffron Table · this month (social retainer) -------------------------
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Navratri thali launch post', flow: 'design', state: 'client', due: -3, sent: 3 },
  { eng: 'saffron_smm', cycle: 0, type: 'carousel', title: "Chef's tasting menu carousel", flow: 'design', state: 'changes', due: 1, rounds: 1, notes: [{ body: 'Can the price be bigger on slide 1?', x: 62, y: 28 }, { body: 'Use the photo with the brass thali here instead', x: 40, y: 55 }] },
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Weekend brunch offer', flow: 'design', state: 'making', due: 0 },
  { eng: 'saffron_smm', cycle: 0, type: 'story', title: 'Diwali countdown stories', flow: 'design', state: 'making', due: -2 },
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Customer review spotlight', flow: 'design', state: 'in_qc', due: 2 },
  { eng: 'saffron_smm', cycle: 0, type: 'reel', title: 'Behind the kitchen reel', flow: 'video', state: 'client', due: -2, sent: 4, notes: [{ body: 'Love this shot! Can we hold it a second longer?', t: 7 }, { body: 'Music is a bit loud over the chef talking', t: 18 }] },
  { eng: 'saffron_smm', cycle: 0, type: 'reel', title: 'Signature biryani reel', flow: 'video', state: 'changes', due: 1, rounds: 2, notes: [{ body: 'The dum opening shot feels rushed, slow it down', t: 3 }, { body: 'Spelling: "Hyderabadi" in the caption', t: 12 }, { body: 'End card should show the Indiranagar address', t: 27 }] },
  { eng: 'saffron_smm', cycle: 0, type: 'reel', title: 'Festive menu teaser', flow: 'video', state: 'making', due: 3 },
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Diwali greeting post', flow: 'design', state: 'planned', due: 10 },
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Monsoon special post', flow: 'design', state: 'approved', due: -3 },
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Founder story post', flow: 'design', state: 'scheduled', due: 2, rounds: 1 },
  { eng: 'saffron_smm', cycle: 0, type: 'post', title: 'Anniversary giveaway post', flow: 'design', state: 'published', due: -5 },
  { eng: 'saffron_smm', cycle: 0, type: 'story', title: 'Lunch combo stories', flow: 'design', state: 'qc_passed', due: 1 },
  { eng: 'saffron_smm', cycle: 0, type: 'script', title: 'Reel script: biryani secrets', flow: 'writing', state: 'approved', due: -6 },
  { eng: 'saffron_smm', cycle: 0, type: 'script', title: 'Reel script: Diwali feast', flow: 'writing', state: 'making', due: 2 },
  { eng: 'saffron_smm', cycle: 0, type: 'script', title: 'Reel script: meet the chefs', flow: 'writing', state: 'queued', due: 5 },
  // Saffron · last month and the month before (history)
  { eng: 'saffron_smm', cycle: -1, type: 'post', title: 'Ganesh Chaturthi modak post', flow: 'design', state: 'published', due: -32, qcFails: 1 },
  { eng: 'saffron_smm', cycle: -1, type: 'carousel', title: 'Onam sadya carousel', flow: 'design', state: 'published', due: -26, rounds: 1 },
  { eng: 'saffron_smm', cycle: -1, type: 'reel', title: 'Filter coffee pour reel', flow: 'video', state: 'published', due: -24, hours: 6 },
  { eng: 'saffron_smm', cycle: -1, type: 'story', title: 'Weekday lunch stories', flow: 'design', state: 'published', due: -20 },
  { eng: 'saffron_smm', cycle: -1, type: 'post', title: 'Teachers day offer post', flow: 'design', state: 'published', due: -28 },
  { eng: 'saffron_smm', cycle: -1, type: 'reel', title: 'Tandoor live reel', flow: 'video', state: 'published', due: -15, rounds: 1, hours: 7 },
  { eng: 'saffron_smm', cycle: -1, type: 'post', title: 'New outlet announcement', flow: 'design', state: 'published', due: -12, qcFails: 1, rounds: 1 },
  { eng: 'saffron_smm', cycle: -1, type: 'script', title: 'Reel script: filter coffee ritual', flow: 'writing', state: 'approved', due: -27 },
  { eng: 'saffron_smm', cycle: -1, type: 'script', title: 'Reel script: tandoor masters', flow: 'writing', state: 'approved', due: -18, rounds: 1 },
  { eng: 'saffron_smm', cycle: -2, type: 'post', title: 'Independence day thali post', flow: 'design', state: 'published', due: -50 },
  { eng: 'saffron_smm', cycle: -2, type: 'reel', title: 'Monsoon chai reel', flow: 'video', state: 'published', due: -46, hours: 5 },
  { eng: 'saffron_smm', cycle: -2, type: 'carousel', title: 'Rainy day menu carousel', flow: 'design', state: 'published', due: -44, rounds: 2 },
  { eng: 'saffron_smm', cycle: -2, type: 'script', title: 'Reel script: monsoon chai', flow: 'writing', state: 'approved', due: -49 },

  // --- Urbanloom Apparel · graphic design retainer ---------------------------
  { eng: 'urbanloom_gd', cycle: 0, type: 'post', title: 'Autumn collection hero banner', flow: 'design', state: 'making', due: 1 },
  { eng: 'urbanloom_gd', cycle: 0, type: 'carousel', title: 'Linen edit carousel', flow: 'design', state: 'qc_failed', due: 0, qcFails: 1 },
  { eng: 'urbanloom_gd', cycle: 0, type: 'ad', title: 'Festive sale ad set (4 sizes)', flow: 'design', state: 'changes', due: 2, rounds: 1, notes: [{ body: 'Logo too close to the edge on the square size', x: 12, y: 86 }, { body: 'Make "Flat 30%" the hero, not the model', x: 50, y: 35 }, { body: 'This beige looks grey on my phone', x: 78, y: 70 }] },
  { eng: 'urbanloom_gd', cycle: 0, type: 'post', title: 'Store launch poster', flow: 'design', state: 'client', due: -1, sent: 1, notes: [{ body: 'Looks great, checking the date with our store team', x: 50, y: 80 }] },
  { eng: 'urbanloom_gd', cycle: 0, type: 'post', title: 'Size guide graphic', flow: 'design', state: 'queued', due: 5 },
  { eng: 'urbanloom_gd', cycle: 0, type: 'post', title: 'Influencer collab post', flow: 'design', state: 'in_qc', due: 3 },
  { eng: 'urbanloom_gd', cycle: 0, type: 'carousel', title: 'Care instructions carousel', flow: 'design', state: 'queued', due: 7 },
  { eng: 'urbanloom_gd', cycle: 0, type: 'post', title: 'Gift card design', flow: 'design', state: 'approved', due: -2 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'post', title: 'Monsoon sale banner', flow: 'design', state: 'approved', due: -29, qcFails: 1 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'carousel', title: 'Kurta sets carousel', flow: 'design', state: 'approved', due: -25 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'ad', title: 'Retargeting ad set', flow: 'design', state: 'approved', due: -21, rounds: 1 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'post', title: 'Lookbook cover', flow: 'design', state: 'approved', due: -17 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'story', title: 'Back in stock stories', flow: 'design', state: 'approved', due: -14 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'post', title: 'Customer love post', flow: 'design', state: 'approved', due: -9, qcFails: 1 },
  { eng: 'urbanloom_gd', cycle: -1, type: 'post', title: 'Price drop post', flow: 'design', state: 'approved', due: -6 },
  { eng: 'urbanloom_gd', cycle: -2, type: 'post', title: 'Summer clearance banner', flow: 'design', state: 'approved', due: -55 },
  { eng: 'urbanloom_gd', cycle: -2, type: 'carousel', title: 'Fabric guide carousel', flow: 'design', state: 'approved', due: -48, rounds: 1 },
  { eng: 'urbanloom_gd', cycle: -2, type: 'post', title: 'Store hours update', flow: 'design', state: 'approved', due: -40 },

  // --- Urbanloom · social ----------------------------------------------------
  { eng: 'urbanloom_smm', cycle: 0, type: 'reel', title: 'Linen lookbook reel', flow: 'video', state: 'making', step: 1, due: 4 },
  { eng: 'urbanloom_smm', cycle: 0, type: 'story', title: 'New arrivals stories', flow: 'design', state: 'client', due: -2, sent: 2 },
  { eng: 'urbanloom_smm', cycle: 0, type: 'post', title: 'Customer styling post', flow: 'design', state: 'scheduled', due: 3 },
  { eng: 'urbanloom_smm', cycle: 0, type: 'reel', title: 'Studio behind-the-scenes reel', flow: 'video', state: 'approved', due: -2, hours: 6 },
  { eng: 'urbanloom_smm', cycle: 0, type: 'post', title: 'Weekend sale post', flow: 'design', state: 'published', due: -2 },
  { eng: 'urbanloom_smm', cycle: 0, type: 'post', title: 'Fabric of the week post', flow: 'design', state: 'planned', due: 8 },
  { eng: 'urbanloom_smm', cycle: -1, type: 'reel', title: 'Festive drape reel', flow: 'video', state: 'published', due: -22, rounds: 1, hours: 8 },
  { eng: 'urbanloom_smm', cycle: -1, type: 'post', title: 'Wedding edit post', flow: 'design', state: 'published', due: -19 },

  // --- Peak Motors · video project -------------------------------------------
  { eng: 'peak_video', cycle: 'project', type: 'video', title: 'Showroom brand film (90s)', flow: 'video', state: 'in_qc', due: 2, rounds: 1, hours: 14 },
  { eng: 'peak_video', cycle: 'project', type: 'video', title: 'Launch teaser (15s)', flow: 'video', state: 'qc_passed', due: 1, hours: 5 },
  { eng: 'peak_video', cycle: 'project', type: 'video', title: 'Customer testimonial cut', flow: 'video', state: 'qc_failed', due: 0, qcFails: 1, hours: 4 },
  { eng: 'peak_video', cycle: 'project', type: 'reel', title: 'Test-drive day reel', flow: 'video', state: 'approved', due: -8, hours: 6 },
  { eng: 'peak_video', cycle: 'project', type: 'reel', title: 'Service centre tour reel', flow: 'video', state: 'approved', due: -12, rounds: 1, hours: 7 },
  { eng: 'peak_video', cycle: 'project', type: 'script', title: 'Brand film voice-over script', flow: 'writing', state: 'client', due: -1, sent: 1, notes: [{ body: 'Second paragraph: mention the 24x7 roadside assistance' }] },
  { eng: 'peak_video', cycle: 'project', type: 'script', title: 'Testimonial interview questions', flow: 'writing', state: 'changes', due: 1, rounds: 1, notes: [{ body: 'Add a question about the financing process' }, { body: 'Keep it to 6 questions, customers get nervous' }] },

  // --- Peak Motors · landing page --------------------------------------------
  { eng: 'peak_web', cycle: 'project', type: 'page', title: 'Test-drive landing page', flow: 'web', state: 'client', due: -1, sent: 1, hours: 9 },
  { eng: 'peak_web', cycle: 'project', type: 'page', title: 'Thank-you & booking page', flow: 'web', state: 'making', due: 4 },
  { eng: 'peak_web', cycle: 'project', type: 'page', title: 'Privacy & terms pages', flow: 'web', state: 'approved', due: -15, hours: 4 },

  // --- Brightpath Academy · website + UX ---------------------------------------
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Home page', flow: 'web', state: 'client', due: -1, sent: 2, hours: 16 },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Courses page', flow: 'web', state: 'making', due: 2 },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Admissions page', flow: 'web', state: 'changes', due: 1, rounds: 1, hours: 10, notes: [{ body: 'The fee table should collapse into cards on mobile' }, { body: 'Please add the scholarship deadline banner on top' }] },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Contact & enquiry form', flow: 'web', state: 'qc_failed', due: 0, qcFails: 1, hours: 6 },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Blog listing page', flow: 'web', state: 'making', step: 0, due: 6 },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Fee structure page', flow: 'web', state: 'approved', due: -4, hours: 7 },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'About & faculty page', flow: 'web', state: 'in_qc', due: 3, hours: 8 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Admissions app flow (UX research)', flow: 'ux', state: 'making', step: 0, due: 2 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Student portal dashboard UI', flow: 'ux', state: 'changes', due: 1, rounds: 1, notes: [{ body: 'Attendance widget should be first, parents look at that most', x: 22, y: 30 }, { body: 'Too many colours in the chart, keep it to brand teal', x: 68, y: 58 }, { body: 'Can the fee-due alert be red?', x: 80, y: 18 }] },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Parent app onboarding prototype', flow: 'ux', state: 'client', due: 0, sent: 1 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Brightpath design system v1', flow: 'ux', state: 'approved', due: -3, hours: 12 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Mobile course catalogue wireframes', flow: 'ux', state: 'making', step: 1, due: 4 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Sitemap & user journeys', flow: 'ux', state: 'approved', due: -20, hours: 8 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Moodboard & style tiles', flow: 'ux', state: 'approved', due: -25, rounds: 1, hours: 6 },
  { eng: 'brightpath_web', cycle: 'project', type: 'blog', title: 'Blog: choosing the right course after 12th', flow: 'writing', state: 'making', due: 3 },

  // --- Earlier history (the previous comparison period) ------------------------
  { eng: 'peak_video', cycle: 'project', type: 'reel', title: 'Pre-launch countdown reel', flow: 'video', state: 'approved', due: -38, hours: 5 },
  { eng: 'peak_video', cycle: 'project', type: 'video', title: 'Dealer walkaround (60s)', flow: 'video', state: 'approved', due: -44, rounds: 1, hours: 9 },
  { eng: 'urbanloom_smm', cycle: -2, type: 'reel', title: 'Monsoon linen reel', flow: 'video', state: 'published', due: -52, hours: 6 },
  { eng: 'urbanloom_smm', cycle: -2, type: 'reel', title: 'Founder message reel', flow: 'video', state: 'published', due: -40, qcFails: 1, hours: 5 },
  { eng: 'peak_video', cycle: 'project', type: 'script', title: 'Dealer walkaround script', flow: 'writing', state: 'approved', due: -47, rounds: 1 },
  { eng: 'peak_video', cycle: 'project', type: 'script', title: 'Countdown reel script', flow: 'writing', state: 'approved', due: -41 },
  { eng: 'brightpath_web', cycle: 'project', type: 'blog', title: 'Blog: how to prepare for entrance exams', flow: 'writing', state: 'approved', due: -36 },
  { eng: 'peak_web', cycle: 'project', type: 'page', title: 'Old campaign landing page', flow: 'web', state: 'approved', due: -42, hours: 8 },
  { eng: 'peak_web', cycle: 'project', type: 'page', title: 'Service booking page', flow: 'web', state: 'approved', due: -34, qcFails: 1, hours: 7 },
  { eng: 'brightpath_web', cycle: 'project', type: 'page', title: 'Coming-soon page', flow: 'web', state: 'approved', due: -45, hours: 3 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Stakeholder interviews summary', flow: 'ux', state: 'approved', due: -39, hours: 6 },
  { eng: 'brightpath_web', cycle: 'project', type: 'other', title: 'Competitor UX audit', flow: 'ux', state: 'approved', due: -33, rounds: 1, hours: 7 },
];

// Upcoming work (next month and phase 2) so every specialist has a realistic pipeline.
const UPCOMING: Spec[] = [
  ...['Kids menu launch post', 'Christmas brunch post', 'Chef Q&A post', 'Weekend live music post', 'Winter soups carousel', 'Corporate lunch offer', 'Loyalty card post', 'New year countdown post'].map(
    (title, i): Spec => ({ eng: i % 2 ? 'urbanloom_gd' : 'saffron_smm', cycle: 1, type: i === 4 ? 'carousel' : 'post', title, flow: 'design', state: 'queued', due: 12 + i * 2 }),
  ),
  ...['Winter specials reel', 'Kitchen hygiene reel', 'Chef birthday reel', 'Wedding season reel', 'Fit check reel', 'Year in review reel'].map(
    (title, i): Spec => ({ eng: i < 3 ? 'saffron_smm' : 'urbanloom_smm', cycle: 1, type: 'reel', title, flow: 'video', state: 'queued', step: 0, due: 10 + i * 2 }),
  ),
  ...['Alumni stories page', 'Events calendar page', 'Careers page', 'Scholarships page', 'Campus tour page', 'Placements page', 'Library page', 'Hostel & transport page'].map(
    (title, i): Spec => ({ eng: 'brightpath_web', cycle: 'project', type: 'page', title, flow: 'web', state: 'queued', step: 0, due: 9 + i * 2 }),
  ),
  ...['Brightpath blog: hostel life', 'Peak Motors service reminder script', 'Saffron menu card copy'].map(
    (title, i): Spec => ({ eng: ['brightpath_web', 'peak_video', 'saffron_smm'][i], cycle: i === 2 ? 1 : 'project', type: i === 0 ? 'blog' : 'script', title, flow: 'writing', state: 'queued', due: 8 + i * 3 }),
  ),
];

const HOOKS: { text: string; tags: string[]; client?: string; uses: number }[] = [
  { text: 'Nobody in Bengaluru makes biryani like this. Here is why.', tags: ['food', 'curiosity'], client: 'Saffron Table Restaurants', uses: 4 },
  { text: 'Stop scrolling if you have ever burnt your dosa.', tags: ['food', 'pattern-break'], uses: 3 },
  { text: '3 things every first-time car buyer forgets to ask.', tags: ['auto', 'listicle'], client: 'Peak Motors', uses: 2 },
  { text: 'This is what ₹999 gets you at our tasting counter.', tags: ['food', 'offer'], client: 'Saffron Table Restaurants', uses: 1 },
  { text: 'POV: you finally found linen that does not crease by noon.', tags: ['fashion', 'pov'], client: 'Urbanloom Apparel', uses: 2 },
  { text: 'Your child chose a course. Did they choose a career?', tags: ['education', 'question'], client: 'Brightpath Academy', uses: 1 },
  { text: 'We tested 7 coffee beans so you do not have to.', tags: ['food', 'proof'], uses: 0 },
  { text: 'Before you sign that loan, watch this.', tags: ['auto', 'warning'], uses: 1 },
];

export async function seedCraft(prisma: PrismaClient, orgId: string) {
  const user = (email: string) => prisma.user.findFirst({ where: { orgId, email } });
  const depts = await prisma.department.findMany({ where: { orgId } });
  const dept = (name: string) => depts.find((d) => sameDept(d.name, name));
  const roles = await prisma.role.findMany({ where: { orgId, isCustom: false } });
  const branch = await prisma.branch.findFirst({ where: { orgId } });

  // --- Specialists ----------------------------------------------------------
  const people: Record<string, string> = {};
  for (const s of SPECIALISTS) {
    const manager = await user(s.manager);
    let u = await user(s.email);
    if (!u) {
      u = await prisma.user.create({
        data: { orgId, type: 'staff', name: s.name, email: s.email, status: 'active', specialty: s.specialty, departmentId: dept(s.dept)?.id, branchId: branch?.id, managerId: manager?.id },
      });
      const role = roles.find((r) => r.baseRole === s.role);
      if (role) await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    } else if (!u.specialty) {
      await prisma.user.update({ where: { id: u.id }, data: { specialty: s.specialty } });
    }
    people[s.key] = u.id;
  }
  let pm = await user(PM.email);
  if (!pm) {
    pm = await prisma.user.create({
      data: { orgId, type: 'staff', name: PM.name, email: PM.email, status: 'active', specialty: PM.specialty, departmentId: dept(PM.dept)?.id, branchId: branch?.id, managerId: (await user(PM.manager))?.id },
    });
    const role = roles.find((r) => r.baseRole === PM.role);
    if (role) await prisma.userRole.create({ data: { userId: pm.id, roleId: role.id } });
  }

  // Social packages: write the monthly quota into the price book when it is empty, so quotas read real data.
  const quotas: Record<string, string[]> = {
    starter: ['12 posts / month', '4 reels / month', '8 stories / month'],
    growth: ['16 posts / month', '8 reels / month', '12 stories / month'],
    premium: ['24 posts / month', '12 reels / month', '20 stories / month'],
  };
  for (const key of ['smm', 'smm_brands', 'smm_influencers', 'personal_branding']) {
    const tiers = await prisma.serviceTier.findMany({ where: { service: { key, priceBook: { orgId, status: 'active' } } } });
    for (const t of tiers) if (!t.deliverables.length) await prisma.serviceTier.update({ where: { serviceId_tier: { serviceId: t.serviceId, tier: t.tier } }, data: { deliverables: quotas[t.tier] } });
  }

  if (await prisma.clientOrg.findFirst({ where: { orgId, name: 'Saffron Table Restaurants' } })) return; // client data already seeded

  const am = await user('am@bmu.demo');
  const qcUser = (await user('sana.sheikh@ops.demo')) ?? (await user('qc@bmu.demo'));
  if (!am || !qcUser) return;
  const owners: Record<Who, string> = { ...(people as Record<string, string>), qc: qcUser.id, am: am.id } as Record<Who, string>;
  const r = rng(1003);
  const between = (a: number, b: number) => a + r() * (b - a);

  const dir = process.env.STORAGE_DIR ?? 'storage';
  const root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  mkdirSync(join(root, 'demo/craft'), { recursive: true });
  const writeFile = (rel: string, data: Buffer | string) => writeFileSync(join(root, rel), data);

  // --- Clients, owners, brand kits --------------------------------------------
  const clientRole = roles.find((x) => x.baseRole === 'client_owner');
  const clients: Record<string, { id: string; ownerId: string; threadId: string }> = {};
  for (const [name, c] of Object.entries(CLIENTS)) {
    const amFor = PM_CLIENTS.includes(name) ? pm.id : am.id;
    const client = await prisma.clientOrg.create({ data: { orgId, name, industry: c.industry, amUserId: amFor, tenureStart: at(-75, 10), health: name === 'Brightpath Academy' ? 'amber' : 'green' } });
    const owner = await prisma.user.create({ data: { orgId, type: 'client', name: c.owner, email: c.email, status: 'active', ...(clientRole ? { roles: { create: { roleId: clientRole.id } } } : {}) } });
    await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
    const thread = await prisma.thread.create({ data: { orgId, clientOrgId: client.id, type: 'client_am' } });
    clients[name] = { id: client.id, ownerId: owner.id, threadId: thread.id };
    await prisma.craftBrandKit.create({ data: { orgId, clientOrgId: client.id, colours: c.brand.colours, fonts: c.brand.fonts, notes: c.brand.notes, updatedById: people.design } });
    const slug = name.toLowerCase().replace(/\W+/g, '-');
    const logo = `demo/craft/${slug}-logo.png`;
    writeFile(logo, creative([c.brand.colours[2] ?? '#FFFFFF', c.brand.colours[2] ?? '#FFFFFF', c.brand.colours[0], c.brand.colours[1] ?? c.brand.colours[0]], name.length * 7, 480, 480));
    await prisma.file.create({ data: { orgId, clientOrgId: client.id, path: logo, kind: 'image', name: `${name} logo.png`, mimeType: 'image/png', tags: ['brand'], createdAt: at(-70, 11) } });
    await prisma.file.create({ data: { orgId, clientOrgId: client.id, path: `https://brand.${slug}.example/guidelines.pdf`, kind: 'link', name: 'Brand guidelines (PDF)', tags: ['brand'], createdAt: at(-70, 12) } });
  }

  // --- Engagements and cycles ---------------------------------------------------
  const services = await prisma.service.findMany({ where: { priceBook: { orgId, status: 'active' } } });
  const engs: Record<string, { id: string; clientId: string; ownerId: string; amId: string; cycles: Map<string, string> }> = {};
  for (const [key, e] of Object.entries(ENGAGEMENTS)) {
    const service = services.find((s) => s.key === e.service);
    if (!service) continue;
    const client = clients[e.client];
    const amId = PM_CLIENTS.includes(e.client) ? pm.id : am.id;
    const eng = await prisma.engagement.create({
      data: { orgId, clientOrgId: client.id, serviceId: service.id, tier: e.tier, billingType: e.billing, status: e.status, currentGate: 'G4', amId, startDate: at(e.billing === 'monthly' ? -70 : -35, 10), createdAt: at(e.billing === 'monthly' ? -72 : -38, 10) },
    });
    engs[key] = { id: eng.id, clientId: client.id, ownerId: client.ownerId, amId, cycles: new Map() };
  }
  const cycleFor = async (engKey: string, c: number | 'project') => {
    const e = engs[engKey];
    const p = c === 'project' ? 'project' : period(c);
    if (e.cycles.has(p)) return e.cycles.get(p)!;
    const startOffset = c === 'project' ? -32 : c * 30 - 2;
    const isVideo = engKey.includes('smm') || engKey === 'peak_video';
    const cycle = await prisma.cycle.create({
      data: {
        orgId,
        engagementId: e.id,
        period: p,
        rcdAt: at(startOffset, 11),
        planningDue: at(startOffset + 4, 18),
        status: typeof c === 'number' && c > 0 ? 'planning' : 'production',
        requirements: {
          create: isVideo
            ? [
                { orgId, label: 'Raw footage from the shoot (Drive link)', type: 'asset', status: c === 0 || c === 'project' ? 'received' : 'received', ownerId: am.id },
                { orgId, label: 'Logo animation and brand music', type: 'asset', status: 'received', ownerId: am.id },
                { orgId, label: c === 0 || c === 1 ? 'Festive menu photos for end cards' : 'Product photos for end cards', type: 'asset', status: c === 0 || c === 1 || c === 'project' ? 'waiting' : 'received', waitingFor: c === 0 || c === 1 || c === 'project' ? 'Client to share by Monday' : null, ownerId: am.id },
                { orgId, label: 'Approved talking points / script inputs', type: 'info', status: 'received', ownerId: am.id },
              ]
            : [
                { orgId, label: 'Brand guidelines and logo files', type: 'asset', status: 'received', ownerId: am.id },
                { orgId, label: 'Content inputs for the month', type: 'info', status: 'received', ownerId: am.id },
              ],
        },
      },
    });
    e.cycles.set(p, cycle.id);
    return cycle.id;
  };

  const checklists = await prisma.checklistTemplate.findMany({ where: { orgId, kind: 'qc' } });
  const qcItems = (key: string) => (checklists.find((c) => c.key === key)?.items as string[] | undefined) ?? DEFAULT_QC_CHECKLISTS.find((c) => c.key === key)?.items ?? ['Matches the brief'];

  let made = 0;
  for (const s of [...SPECS, ...UPCOMING]) {
    const e = engs[s.eng];
    if (!e) continue;
    const flow = FLOWS[s.flow];
    const cycleId = await cycleFor(s.eng, s.cycle);
    const due = at(s.due, 18, 0);
    const now = new Date();
    const rounds = s.rounds ?? 0;
    const qcFails = s.qcFails ?? 0;
    const work = flow.steps.filter((x) => x.kind === 'work');
    const status =
      s.state === 'planned' ? 'planned' : s.state === 'making' || s.state === 'queued' ? 'in_production' : s.state === 'changes' ? 'changes_requested' : s.state === 'client' ? 'ready_for_client' : s.state;
    const clientDueAt = s.state === 'planned' ? due : at(s.due + 2, 18);
    const deliverable = await prisma.deliverable.create({
      data: { orgId, cycleId, type: s.type, title: s.title, status, revisionRoundsUsed: rounds, dueAt: clientDueAt, departmentId: dept(flow.dept)?.id, flowKey: s.flow },
    });

    // Versions first (they set the timeline of the finished steps).
    const done = ['in_qc', 'qc_passed', 'client', 'approved', 'scheduled', 'published'].includes(s.state);
    const nv = s.state === 'qc_failed' ? Math.max(1, qcFails) + rounds : s.state === 'changes' ? qcFails + Math.max(1, rounds) : done ? qcFails + rounds + 1 : 0;
    const lastAt = s.state === 'client' ? new Date(at(-(s.sent ?? 1), 12).getTime() - 3 * 3_600_000) : new Date(Math.min(now.getTime() - 3 * 3_600_000, due.getTime() + (done ? 0 : -DAY)));
    const maker = owners[work.at(-1)!.who];
    const versions: { id: string; at: Date; sentAt: Date | null; pass: boolean | null }[] = [];
    for (let i = 0; i < nv; i++) {
      const vAt = new Date(lastAt.getTime() - (nv - 1 - i) * between(0.8, 1.4) * DAY);
      const n = i + 1;
      const isLast = i === nv - 1;
      const pass = s.state === 'in_qc' && isLast ? null : s.state === 'qc_failed' && isLast ? false : i < (s.state === 'qc_failed' ? qcFails - 1 : qcFails) ? false : true;
      const failed = pass === false;
      const sent = pass === true && !(s.state === 'qc_passed' && isLast);
      const sentAt = sent ? (s.state === 'client' && isLast ? at(-(s.sent ?? 1), 12) : new Date(vAt.getTime() + 3 * 3_600_000)) : null;
      let fileData: { path: string; kind: string; name: string; mimeType?: string };
      if (s.flow === 'design' || s.flow === 'ux') {
        const rel = `demo/craft/${deliverable.id}-v${n}.png`;
        writeFile(rel, creative(ENGAGEMENTS[s.eng].palette, made * 13 + n, s.flow === 'ux' ? 960 : 720, s.flow === 'ux' ? 600 : 720));
        fileData = { path: rel, kind: 'image', name: `${s.title} v${n}.png`, mimeType: 'image/png' };
      } else if (s.flow === 'video') {
        fileData = { path: `${VIDEO_URL}#${deliverable.id}-v${n}`, kind: 'link', name: `${s.title} v${n} (preview)` };
      } else if (s.flow === 'web') {
        const slug = s.title.toLowerCase().replace(/\W+/g, '-').replace(/-+$/, '');
        const host = s.eng.startsWith('peak') ? 'peakmotors' : 'brightpathacademy';
        fileData = { path: `https://staging.${host}.example/${slug}?build=${n}`, kind: 'link', name: `Staging: ${s.title} (build ${n})` };
      } else {
        const rel = `demo/craft/${deliverable.id}-v${n}.md`;
        writeFile(rel, `# ${s.title}\n\nHOOK: ${HOOKS[made % HOOKS.length].text}\n\nVO: Welcome in. This is draft ${n}.\n\nCTA: Book a table / visit today.\n`);
        fileData = { path: rel, kind: 'other', name: `${s.title} v${n}.md`, mimeType: 'text/markdown' };
      }
      const file = await prisma.file.create({ data: { orgId, clientOrgId: e.clientId, ...fileData, createdAt: vAt } });
      const v = await prisma.version.create({
        data: { orgId, deliverableId: deliverable.id, fileId: file.id, number: n, uploadedById: maker, note: n === 1 ? 'First draft' : failed ? 'Fixes from QC' : `Round ${n - 1 - qcFails} changes`, sentToClientAt: sentAt, sentById: sentAt ? e.amId : null, createdAt: vAt },
      });
      if (pass !== null) {
        const list = qcItems(flow.qcKey);
        const bad = failed ? [Math.floor(r() * list.length)] : [];
        await prisma.qCResult.create({
          data: {
            orgId,
            versionId: v.id,
            checklistId: flow.qcKey,
            result: failed ? 'fail' : 'pass',
            reviewerId: qcUser.id,
            createdAt: new Date(vAt.getTime() + 2 * 3_600_000),
            items: { list: list.map((label, k) => ({ label, ok: !bad.includes(k), ...(bad.includes(k) ? { note: s.flow === 'web' ? 'Enquiry form does not send the email' : 'Needs a fix before the client sees it' } : {}) })), note: failed ? 'Please fix and re-upload' : null, checklist: list },
          },
        });
        if (failed) await prisma.comment.create({ data: { orgId, targetType: 'version', targetId: v.id, body: `QC failed\n${list[bad[0]]}`, isInternal: true, authorId: qcUser.id, createdAt: new Date(vAt.getTime() + 2 * 3_600_000) } });
      }
      versions.push({ id: v.id, at: vAt, sentAt, pass });
    }
    // Client rounds: each sent version except the latest (or the latest too when changes are requested) got feedback.
    const sentVersions = versions.filter((v) => v.sentAt);
    const changed = s.state === 'changes' ? sentVersions : sentVersions.slice(0, -1);
    const roundNotes = s.flow === 'video' ? ['Trim the intro, it drags', 'Swap the music for something more upbeat'] : s.flow === 'web' ? ['Header looks crowded on mobile', 'Use the new campus photo'] : ['Make the logo a bit smaller', 'Try a warmer background'];
    for (const [i, v] of changed.entries()) {
      const isCurrent = s.state === 'changes' && i === changed.length - 1;
      const notes: Note[] = isCurrent && s.notes ? s.notes : [{ body: roundNotes[i % roundNotes.length], ...(s.flow === 'video' ? { t: 4 + i * 6 } : s.flow === 'design' || s.flow === 'ux' ? { x: 30 + i * 20, y: 40 } : {}) }];
      for (const [k, n] of notes.entries()) {
        const cAt = new Date(v.sentAt!.getTime() + (6 + k) * 3_600_000);
        await prisma.comment.create({
          data: {
            orgId,
            targetType: 'version',
            targetId: v.id,
            body: n.body,
            timestampOrPin: n.t !== undefined ? JSON.stringify({ t: n.t }) : n.x !== undefined ? JSON.stringify({ x: n.x, y: n.y }) : null,
            authorId: e.ownerId,
            createdAt: cAt,
            resolvedAt: isCurrent ? null : new Date(cAt.getTime() + DAY),
            resolvedById: isCurrent ? null : maker,
          },
        });
      }
    }
    // Notes left on the version currently with the client (not yet a decision).
    if (s.state === 'client' && s.notes && sentVersions.length) {
      const v = sentVersions.at(-1)!;
      for (const [k, n] of s.notes.entries())
        await prisma.comment.create({
          data: { orgId, targetType: 'version', targetId: v.id, body: n.body, timestampOrPin: n.t !== undefined ? JSON.stringify({ t: n.t }) : n.x !== undefined ? JSON.stringify({ x: n.x, y: n.y }) : null, authorId: e.ownerId, createdAt: new Date(v.sentAt!.getTime() + (5 + k) * 3_600_000) },
        });
    }

    // Tasks along the flow.
    const lastVersion = versions.at(-1);
    const approvedAt = ['approved', 'scheduled', 'published'].includes(s.state) && lastVersion ? new Date(Math.min(now.getTime() - 3_600_000, lastVersion.sentAt!.getTime() + between(0.4, 2) * DAY)) : null;
    const openIdx = s.state === 'making' || s.state === 'queued' ? (s.step ?? work.length - 1) : s.state === 'qc_failed' || s.state === 'changes' ? work.length - 1 : -1;
    let prev: string | null = null;
    for (const [i, step] of flow.steps.entries()) {
      const wi = work.indexOf(step);
      const isWork = step.kind === 'work';
      let st: 'todo' | 'in_progress' | 'waiting' | 'done' = 'todo';
      if (s.state === 'planned') st = 'todo';
      else if (isWork) {
        if (openIdx === -1) st = 'done';
        else if (wi < openIdx) st = 'done';
        else if (wi === openIdx) st = s.state === 'queued' ? 'todo' : 'in_progress';
        else st = 'todo';
      } else if (step.kind === 'qc') {
        st = ['qc_passed', 'client', 'approved', 'scheduled', 'published'].includes(s.state) ? 'done' : s.state === 'qc_failed' ? 'waiting' : 'todo';
      } else {
        st = ['approved', 'scheduled', 'published'].includes(s.state) ? 'done' : s.state === 'client' ? 'in_progress' : s.state === 'changes' ? 'waiting' : 'todo';
      }
      // Deadlines: the maker's step lands on `due`; earlier work a day apart; QC +1, client +3 working days.
      const deadline = isWork ? at(s.due - (work.length - 1 - wi), 18) : step.kind === 'qc' ? at(s.due + 1, 18) : at(s.due + 3, 18);
      const firstV = versions[0]?.at;
      const lastV = versions.at(-1)?.at;
      const workDone = (lastV && wi === work.length - 1 ? lastV : new Date((firstV ?? deadline).getTime() - (work.length - 1 - wi) * 0.6 * DAY - (firstV ? 0 : 0.2 * DAY))).getTime();
      const completedAt =
        st !== 'done'
          ? null
          : isWork
            ? new Date(Math.min(now.getTime() - (work.length - wi) * 3_600_000, workDone))
            : step.kind === 'qc'
              ? new Date((versions.filter((v) => v.pass).at(-1)?.at ?? now).getTime() + 2 * 3_600_000)
              : (approvedAt ?? now);
      // Time: the maker's last step carries the hours; earlier steps by the same person half, other people's steps up to 2h.
      const share = wi === work.length - 1 ? 1 : step.who === work.at(-1)!.who ? 0.5 : 0.3;
      const minutes = isWork && (st === 'done' || st === 'in_progress') ? Math.round(Math.min(share < 1 ? 2.5 : 99, (s.hours ?? between(1.5, 4)) * share) * 60 * (st === 'done' ? 1 : 0.4)) : step.kind === 'qc' && st === 'done' ? 30 : 0;
      const startedAt = st === 'todo' ? null : new Date((completedAt ?? now).getTime() - (st === 'done' ? between(0.5, 2.2) : between(0.1, 1.2)) * DAY);
      const task: { id: string } = await prisma.task.create({
        data: {
          orgId,
          deliverableId: deliverable.id,
          engagementId: e.id,
          title: `${step.name}: ${s.title}`,
          flowStep: step.key,
          kind: step.kind,
          role: step.role,
          sort: i,
          ownerId: step.who === 'am' ? e.amId : owners[step.who],
          departmentId: dept(flow.dept)?.id,
          deadline,
          status: st,
          dependsOn: prev ? [prev] : [],
          timeLoggedMin: minutes,
          startedAt,
          completedAt,
          createdAt: at(s.due - work.length - 3, 10),
        },
      });
      prev = task.id;
    }
    if (approvedAt && lastVersion) {
      await prisma.deliverable.update({ where: { id: deliverable.id }, data: { approvedVersionId: lastVersion.id } });
      await prisma.approval.create({ data: { orgId, targetType: 'deliverable', targetId: deliverable.id, gate: 'G4', userId: e.ownerId, at: approvedAt, versionId: lastVersion.id } });
      await prisma.auditEvent.create({ data: { orgId, actorId: e.ownerId, action: 'deliverable.approved', entity: 'Deliverable', entityId: deliverable.id, at: approvedAt, after: { versionId: lastVersion.id } } });
    }
    // Working checklists: video exports and UX handoffs partly ticked.
    if (s.flow === 'video' && ['qc_passed', 'approved', 'in_qc'].includes(s.state) && s.cycle !== -1 && s.cycle !== -2) {
      const tick = s.state === 'approved' ? 4 : s.state === 'qc_passed' ? 3 : 1;
      await prisma.craftChecklist.create({ data: { orgId, deliverableId: deliverable.id, kind: 'export', items: CRAFT_CHECKLISTS.export.map((label, k) => ({ label, done: k < tick })), updatedById: people.video } });
    }
    if (s.flow === 'ux' && ['approved', 'client'].includes(s.state) && s.due > -10) {
      await prisma.craftChecklist.create({ data: { orgId, deliverableId: deliverable.id, kind: 'handoff', items: CRAFT_CHECKLISTS.handoff.map((label, k) => ({ label, done: k < (s.state === 'approved' ? 4 : 2) })), updatedById: people.uxui } });
    }
    made++;
  }

  // --- Social media manager's own planning work (not tied to one deliverable) ----
  for (const [engKey, title, dueIn, state] of [
    ['saffron_smm', 'Plan November content calendar', 3, 'in_progress'],
    ['urbanloom_smm', 'Monthly performance report for September', -1, 'in_progress'],
    ['saffron_smm', 'Reply to community comments and DMs', 0, 'todo'],
    ['urbanloom_smm', 'Plan November content calendar', 5, 'todo'],
    ['urbanloom_smm', 'Influencer shortlist for the giveaway', 4, 'blocked'],
    ['saffron_smm', 'Plan October content calendar', -27, 'done'],
    ['urbanloom_smm', 'Plan October content calendar', -26, 'done'],
    ['saffron_smm', 'Monthly performance report for August', -29, 'done'],
  ] as const) {
    const e = engs[engKey];
    if (!e) continue;
    await prisma.task.create({
      data: {
        orgId,
        engagementId: e.id,
        title: `${title}: ${ENGAGEMENTS[engKey].client}`,
        flowStep: 'plan',
        kind: 'planning',
        role: 'strategist',
        ownerId: people.social,
        departmentId: dept('Strategy')?.id,
        deadline: at(dueIn, 18),
        status: state,
        blockedReason: state === 'blocked' ? 'Waiting for the client to confirm the giveaway budget' : null,
        timeLoggedMin: state === 'done' ? 150 : state === 'in_progress' ? 60 : 0,
        startedAt: state === 'todo' ? null : at(dueIn - 2, 11),
        completedAt: state === 'done' ? at(dueIn, 16) : null,
        createdAt: at(dueIn - 6, 10),
      },
    });
  }

  // --- Client requests (change requests on the web projects, social asks) -------
  const req = async (engKey: string, type: string, description: string, status: string, ago: number, deliverableTitle?: string, replied = true) => {
    const e = engs[engKey];
    if (!e) return;
    const created = at(-ago, 11);
    const d = deliverableTitle ? await prisma.deliverable.findFirst({ where: { title: deliverableTitle, cycle: { engagementId: e.id } } }) : null;
    await prisma.request.create({
      data: { orgId, engagementId: e.id, type, description, status: status as never, createdById: e.ownerId, deliverableId: d?.id, slaDue: new Date(created.getTime() + 8 * 3_600_000), firstReplyAt: replied ? new Date(created.getTime() + 3 * 3_600_000) : null, resolvedAt: status === 'done' ? new Date(created.getTime() + DAY) : null, createdAt: created },
    });
  };
  await req('brightpath_web', 'change', 'Change the hero image on the home page to the new campus photo', 'in_progress', 2, 'Home page');
  await req('brightpath_web', 'urgent', 'Enquiry form is not sending to admissions@ — parents are calling us', 'in_scope', 1, 'Contact & enquiry form', false);
  await req('brightpath_web', 'change', 'Update the fee table with the 2027 batch fees', 'done', 9, 'Fee structure page');
  await req('peak_web', 'change', 'Add the Diwali offer strip on the test-drive page', 'received', 0, 'Test-drive landing page', false);
  await req('saffron_smm', 'change', 'Can we push the Diwali greeting post to Friday evening?', 'in_progress', 1, 'Diwali greeting post');
  await req('saffron_smm', 'question', 'Can you add the Swiggy link in the bio this week?', 'received', 0, undefined, false);
  await req('urbanloom_smm', 'new_scope', 'Can you also run a giveaway with an influencer next month?', 'quoted', 3);

  // --- Project manager: work to hand out, client conversations, money and notes ---
  if (engs.brightpath_web && engs.peak_web && engs.peak_video) {
    // One flow step without an owner (the builder left), plus ad-hoc asks that came in on calls.
    const orphan = await prisma.task.findFirst({ where: { engagementId: engs.brightpath_web.id, flowStep: 'build', status: 'todo', deadline: { gte: new Date() } }, orderBy: { deadline: 'asc' } });
    if (orphan) await prisma.task.update({ where: { id: orphan.id }, data: { ownerId: null, priority: 'high' } });
    for (const [engKey, title, specialty, dueIn, priority, deptName] of [
      ['peak_web', 'Design the Diwali offer banner for the test-drive page', 'graphic_designer', 2, 'high', 'Creative / Design'],
      ['peak_video', 'Cut a 15-second teaser from the launch film', 'video_editor', 4, 'normal', 'Video / Production'],
      ['brightpath_web', 'Write copy for the new scholarships page', 'script_writer', 3, 'normal', 'Strategy'],
      ['brightpath_web', 'Fix enquiry form email routing to admissions@', 'developer', 1, 'urgent', 'Web / AI'],
      ['brightpath_web', 'Wireframe the parent portal login flow', 'ux_ui_designer', 6, 'low', 'Creative / Design'],
    ] as const) {
      await prisma.task.create({
        data: { orgId, engagementId: engs[engKey].id, title, specialty, kind: 'work', status: 'todo', priority, departmentId: dept(deptName)?.id, deadline: at(dueIn, 18), sort: 900, createdAt: at(-1, 15) },
      });
    }
    const peak = clients['Peak Motors'];
    const bright = clients['Brightpath Academy'];
    const msg = (threadId: string, authorId: string, body: string, when: Date) => prisma.message.create({ data: { orgId, threadId, authorId, body, createdAt: when } });
    await msg(peak.threadId, peak.ownerId, 'Hi Devika, the launch film looks great. Can we get a short teaser for Instagram too?', at(-3, 11, 5));
    await msg(peak.threadId, pm.id, 'Thanks! Yes, we will cut a 15-second teaser this week and share it for review.', at(-3, 12, 40));
    await msg(bright.threadId, bright.ownerId, 'Parents are still not getting a reply from the enquiry form. Can someone look at it today please?', new Date(Date.now() - 5 * 3_600_000));
    await prisma.invoice.create({
      data: {
        orgId,
        clientOrgId: peak.id,
        number: 'BMU-CRAFT-0001',
        lines: [{ description: 'Website: Starter — balance payment', qty: 1, ratePaise: 4_500_000 }],
        subtotalPaise: 4_500_000,
        gstPaise: 810_000,
        totalPaise: 5_310_000,
        dueDate: at(-6, 18),
        status: 'overdue',
        kind: 'project_balance',
        engagementId: engs.peak_web.id,
        createdAt: at(-21, 11),
      },
    });
    await prisma.craftClientNote.create({ data: { orgId, clientOrgId: peak.id, authorId: pm.id, kind: 'call', body: 'Call with Sandeep: happy with the launch film, wants a teaser and the Diwali offer on the site. Balance payment promised by Friday.', createdAt: at(-3, 12, 30) } });
    // Approved leave so the board's load, "on leave today" and the 2-week heatmap have something real to show.
    const day = (n: number) => new Date(`${new Date(Date.now() + n * DAY + IST).toISOString().slice(0, 10)}T00:00:00Z`);
    await prisma.leaveRequest.create({ data: { orgId, userId: people.video, from: day(0), to: day(1), type: 'casual', reason: 'Family function', status: 'approved', decidedById: am.id, decidedAt: at(-4, 10) } });
    await prisma.leaveRequest.create({ data: { orgId, userId: people.dev, from: day(8), to: day(9), type: 'casual', reason: 'Wedding in Chennai', status: 'approved', decidedById: am.id, decidedAt: at(-2, 10) } });
    await prisma.craftClientNote.create({ data: { orgId, clientOrgId: bright.id, authorId: pm.id, kind: 'meeting', body: 'Walk the principal through the new admissions pages', remindAt: at(1, 11), createdAt: at(-1, 16) } });
  }

  // --- Hooks library and script drafts (script writer) --------------------------
  for (const h of HOOKS) {
    await prisma.craftHook.create({ data: { orgId, userId: people.script, text: h.text, tags: h.tags, clientOrgId: h.client ? clients[h.client]?.id : null, uses: h.uses, createdAt: at(-20 + HOOKS.indexOf(h) * 2, 12) } });
  }
  const diwali = await prisma.deliverable.findFirst({ where: { title: 'Reel script: Diwali feast', cycle: { engagementId: engs.saffron_smm?.id } } });
  await prisma.craftScript.create({
    data: {
      orgId,
      authorId: people.script,
      deliverableId: diwali?.id,
      title: 'Reel script: Diwali feast',
      body: `## Hook (0–3s)\nNobody in Bengaluru makes a Diwali thali like this. Here is why.\n\n## Scene 1 — the spread (3–10s)\nVO: Twenty-one dishes. One table. Every recipe from Chef Ravi's grandmother.\n\n## Scene 2 — the sweets (10–20s)\nVO: Kaju katli made fresh every morning, and our famous saffron jalebi.\n\n## CTA (20–25s)\nVO: Book your Diwali table at Saffron Table, Indiranagar. Link in bio.`,
      updatedAt: at(-1, 15),
    },
  });
  await prisma.craftScript.create({
    data: { orgId, authorId: people.script, title: 'Ideas: winter soups series', body: 'Hook options:\n- Your grandmother was right about this soup.\n- 3 soups under ₹200 that taste like home.\n\nFormat: 3 reels, 20s each, chef talking to camera.', updatedAt: at(-4, 17) },
  });

  // --- Attendance for the last two weeks (so streaks and the strip look lived-in) --
  for (const key of Object.keys(people)) {
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.now() - i * DAY);
      if (new Date(d.getTime() + IST).getUTCDay() === 0) continue;
      const date = new Date(`${new Date(d.getTime() + IST).toISOString().slice(0, 10)}T00:00:00Z`);
      await prisma.attendance.upsert({
        where: { userId_date: { userId: people[key], date } },
        update: {},
        create: { userId: people[key], date, orgId, checkIn: at(-i, 9, 25 + Math.floor(r() * 20)), checkOut: at(-i, 18, 35 + Math.floor(r() * 30)) },
      });
    }
  }
  console.log(`Seeded craft specialists: ${SPECIALISTS.length} people, ${made} deliverables across ${Object.keys(engs).length} engagements.`);
}
