import { settingsDefaults } from '@bmu/shared';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { defaultRequirements } from '../../src/proposals/requirements.js';

const SOPS: Record<string, { title: string; body: string }[]> = {
  'Creative / Design': [
    {
      title: 'Design brief intake',
      body: `# Design brief intake
Every design job starts from a complete brief. No brief, no start.

## Before you open the design file
1. Read the approved plan for this month and find the deliverable.
2. Check the client's brand kit: logo files, colours, fonts and tone notes.
3. Look at the last 3 approved posts so the new work feels consistent.

## What a complete brief has
- Objective: what the post or asset must achieve (awareness, offer, hiring…)
- Copy: final headline and caption, approved by the AM
- Format and size: e.g. 1080x1350 feed post, 1080x1920 story
- Mandatory elements: logo placement, offer terms, contact details
- Deadline from the task, not from chat

## If something is missing
- Mark the task blocked with a clear reason ("waiting for offer terms").
- Tag the AM on the task. Do not message the client directly.`,
    },
    {
      title: 'Design self-check before QC',
      body: `# Design self-check before QC
Run this list yourself before you upload a version for QC. QC should find taste issues, not typos.

## Brand
- Correct logo version and clear space
- Only brand colours and fonts
- Image quality: no pixelation, no watermarks

## Copy
- Spell-check the headline, caption and any text on the design
- Phone numbers, prices and dates match the brief exactly
- GST-inclusive or exclusive prices are labelled

## Files
- Export at the size in the brief
- Name the file client_deliverable_v1 (increase the number for every version)
- Add a short note on what changed since the last version`,
    },
    {
      title: 'Handling client revisions',
      body: `# Handling client revisions
## Count the rounds
Each package includes a fixed number of revision rounds. The Review Studio counts them for you.

## In scope
- Text edits, colour tweaks, swapping an image from the client's library
- Fix and upload a new version within one working day

## Out of scope
- A new concept, a new format or new copy direction
- Do not start. Ask the AM to raise an extra request so the client gets a quote.`,
    },
  ],
  'Account Management': [
    {
      title: 'Client review etiquette',
      body: `# Client review etiquette
How we ask clients for feedback so reviews are fast and kind.

## Sending work for review
1. Only send versions that passed internal QC.
2. Write one line on what you want feedback on ("Is the offer clear?").
3. Mention the review deadline: two working days unless the plan says otherwise.

## When feedback comes in
- Reply within the SLA, even if only to say "Got it, we're on it".
- Repeat back what you understood before the team starts.
- If feedback changes the direction, explain kindly that it is an extra request and share the quote.

## Tone
- Warm, short and clear. No jargon.
- Never blame the team or the client. Focus on the next step.`,
    },
    {
      title: 'New client kick-off',
      body: `# New client kick-off
## Within 24 working hours of payment
1. Introduce yourself in the client app thread.
2. Share the requirements checklist and explain what each item is for.
3. Book the kick-off call.

## On the call
- Confirm goals for the first 90 days
- Agree who approves work on the client's side
- Walk through the five gates so they know when files are released

## After the call
- Mark received items in the checklist
- Set RCD only when every item is received`,
    },
  ],
  QC: [
    {
      title: 'Design QC',
      body: `# Design QC
QC protects the client's brand and our reputation. A version cannot be sent to the client without a pass.

## Check in this order
1. Brief match: format, size, copy and mandatory elements
2. Brand: logo, colours, fonts, tone
3. Accuracy: spelling, numbers, dates, prices, contact details
4. Craft: alignment, spacing, contrast, readability on a phone

## Failing a version
- Tick the items that failed and write what to fix, not just "wrong".
- One clear comment per issue, pinned on the image when possible.

## Passing a version
- Pass only when you would be happy to see it posted today.`,
    },
    {
      title: 'Publishing checklist',
      body: `# Publishing checklist
Use before anything goes live on a client account.

## Before scheduling
- The approved version (not an older one) is the file you are posting
- Caption, hashtags and tags match the approved copy
- Links work and have tracking where the plan asks for it
- Posting date and time match the content calendar (IST)

## After publishing
- Open the live post on a phone and check it once
- Add the live link to the deliverable
- Report any problem in the error log the same day`,
    },
  ],
  'Video / Production': [
    {
      title: 'Video edit handover',
      body: `# Video edit handover
## Before editing
- Collect all raw footage in the client's folder; nothing on personal drives
- Confirm aspect ratio (9:16 for reels, 16:9 for YouTube) and length

## Edit checklist
- Hook in the first 2 seconds
- Captions burned in, spell-checked
- Licensed music only; note the track in the version note
- Brand outro with logo

## Upload
- Export H.264, under 200 MB
- Version note: what changed and the timestamps to review`,
    },
    {
      title: 'Shoot day checklist',
      body: `# Shoot day checklist
## A day before
1. Confirm location, time and contact person with the client.
2. Share the shot list and script with the crew.
3. Charge batteries and format cards.

## On the day
- Record a 5-second room tone for every location
- Back up cards to two drives before leaving the location

## After
- Upload footage the same day and note anything missing`,
    },
  ],
};

const ERRORS = [
  {
    what: 'Wrong offer price posted on a client story',
    why: 'Caption used last month’s price. The brief was not updated after the client changed the offer on a call.',
    foundBy: 'Client (Sunrise Bakery)',
    impact: 'Story live for 40 minutes; two customers asked for the old price. Client unhappy.',
    fix: 'Story removed and reposted with the correct price; AM apologised on the thread.',
    prevention: 'Offer changes agreed on calls must be written in the plan before production. Added to the design self-check.',
    cause: 'communication',
  },
  {
    what: 'Reel exported in 16:9 instead of 9:16',
    why: 'Editor reused a YouTube export preset.',
    foundBy: 'QC Reviewer',
    impact: 'Half a day lost re-exporting; client deadline still met.',
    fix: 'Re-exported with the reels preset.',
    prevention: 'Separate export presets per platform, named clearly. Added aspect ratio to the video handover SOP.',
    cause: 'tool',
  },
  {
    what: 'Planning started before all requirements were received',
    why: 'Brand guidelines were marked received by mistake.',
    foundBy: 'Strategist',
    impact: 'Plan had to be redone after the real guidelines arrived; 2 working days lost.',
    fix: 'Plan revised with the correct brand colours.',
    prevention: null,
    cause: 'process',
  },
];

const TYPE_MAP: Record<string, string> = { asset: 'file', info: 'text', access: 'access', payment: 'text' };

/** Demo data for this area. Must be idempotent: create only what's missing. */
export async function seedAdminPlatform(prisma: PrismaClient, orgId: string) {
  // SOP library
  const departments = await prisma.department.findMany({ where: { orgId, deletedAt: null } });
  for (const [deptName, sops] of Object.entries(SOPS)) {
    const dept = departments.find((d) => d.name === deptName);
    if (!dept) continue;
    for (const sop of sops) {
      if (await prisma.sOP.findFirst({ where: { orgId, title: sop.title } })) continue;
      await prisma.sOP.create({ data: { orgId, departmentId: dept.id, title: sop.title, body: sop.body } });
    }
  }

  // Error log
  for (const e of ERRORS) {
    if (await prisma.errorLog.findFirst({ where: { orgId, what: e.what } })) continue;
    await prisma.errorLog.create({ data: { orgId, ...e } });
  }

  // Requirement checklists: start from the built-in per-service lists so the editor shows real data.
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const v8 = (settings.v8 as Record<string, unknown> | undefined) ?? {};
  if (!v8.requirementChecklists) {
    const services = await prisma.service.findMany({ where: { priceBook: { orgId, status: 'active' } }, select: { key: true } });
    const lists: Record<string, { label: string; type: string }[]> = { default: settingsDefaults.requirementChecklists.default };
    for (const s of services) lists[s.key] = defaultRequirements(s.key).map((r) => ({ label: r.label, type: TYPE_MAP[r.type] ?? 'text' }));
    await prisma.organisation.update({
      where: { id: orgId },
      data: { settings: { ...settings, v8: { ...v8, requirementChecklists: lists } } as Prisma.InputJsonValue },
    });
  }
}
