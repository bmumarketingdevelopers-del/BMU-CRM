import type { PrismaClient } from '../../src/generated/prisma/client.js';

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

const DEMO_SOPS: { department: string; title: string; body: string }[] = [
  {
    department: 'Account Management',
    title: 'Client onboarding in the first 48 hours',
    body: `## Why\nA calm, fast start sets the tone for the whole engagement.\n\n## Steps\n1. Send the welcome message from Messages within 2 working hours of payment.\n2. Open the requirements checklist and add anything specific to this client.\n3. Book the kick-off call and add it to the checklist.\n4. Chase missing items once a day, politely, in the client thread.\n5. When every item is received, mark the Project start date (RCD). Planning gets 4 working days from then.\n\n## Done when\nAll requirements are received and the start date is set.`,
  },
  {
    department: 'Account Management',
    title: 'Handling extra requests and quotes',
    body: `## Rule\nNothing outside the agreed scope starts without a written approval in the app.\n\n## Steps\n1. Reply within the first-reply time shown on the request.\n2. Decide: in scope, extra (quote from the add-on list) or decline with a reason.\n3. For extras, send the quote. Work starts only after the client approves and pays.\n4. Keep all decisions in the request thread, never on WhatsApp alone.`,
  },
  {
    department: 'Creative / Design',
    title: 'Design file handover and naming',
    body: `## Naming\nclient_deliverable_v{number}.{ext}, e.g. sunrise_logo_v2.png\n\n## Before you upload\n- Check the brand colours and fonts against the plan.\n- Export at the size the platform needs.\n- Run through the QC checklist yourself first.\n\n## Upload\nUpload each round as a new version on the deliverable. QC reviews it before it goes to the client.`,
  },
  {
    department: 'QC',
    title: 'QC review checklist basics',
    body: `## What QC checks\n- Spelling, grammar and phone numbers\n- Brand colours, logo use and fonts\n- Platform sizes and safe areas\n- The brief and plan were followed\n\n## Outcome\nPass sends the version to the AM to share. Fail returns it to the maker with notes on every failed item. You cannot QC your own work.`,
  },
  {
    department: 'HR / Ops',
    title: 'Leave and attendance policy',
    body: `## Working hours\n9:30 AM to 6:30 PM, Monday to Saturday. Sundays and listed holidays are off.\n\n## Leave\n- 12 casual and 12 sick days a year.\n- Apply in the app under Profile, leave & attendance. Your manager is notified.\n- Apply for planned leave at least 3 working days ahead.\n\n## Attendance\nCheck in and out from My Day every working day. Submit your end-of-day report before you leave.`,
  },
];

/** Demo data for this area. Must be idempotent: create only what's missing. */
export async function seedWorkspace(prisma: PrismaClient, orgId: string) {
  const users = await prisma.user.findMany({ where: { orgId, email: { endsWith: '.demo' } }, select: { id: true, email: true } });
  const idOf = (email: string) => users.find((u) => u.email === email)?.id;
  const amId = idOf('am@bmu.demo');
  const sunrise = await prisma.clientOrg.findFirst({ where: { orgId, name: 'Sunrise Realty Pvt Ltd' } });
  const role = async (base: string) => (await prisma.role.findFirst({ where: { orgId, baseRole: base, isCustom: false } }))?.id;

  // Demo creator who can sign in to the creator portal (type creator → lands on /creator).
  const creatorUser = await prisma.user.upsert({
    where: { orgId_email: { orgId, email: 'creator@bmu.demo' } },
    update: {},
    create: { orgId, type: 'creator', name: 'Ishita Verma', email: 'creator@bmu.demo', status: 'active' },
  });
  const creator =
    (await prisma.creator.findUnique({ where: { userId: creatorUser.id } })) ??
    (await prisma.creator.create({
      data: {
        orgId,
        userId: creatorUser.id,
        niche: ['Real estate', 'Lifestyle', 'Home decor'],
        rates: [
          { label: 'Instagram reel', pricePaise: 800000 },
          { label: 'Story set (3)', pricePaise: 300000 },
          { label: 'UGC testimonial video', pricePaise: 1200000 },
        ],
        rating: 4.6,
      },
    }));

  if (amId && (await prisma.creatorBrief.count({ where: { creatorId: creator.id } })) === 0) {
    const now = Date.now();
    await prisma.creatorBrief.create({
      data: {
        orgId,
        creatorId: creator.id,
        clientOrgId: sunrise?.id,
        title: 'Diwali home tour reel for Sunrise Heights',
        brief: 'A 30–45 second walkthrough of the 3BHK show flat with warm festive lighting. Hook in the first 2 seconds, show the balcony view at golden hour, end on the Sunrise Heights logo and "Book a site visit".',
        deliverables: ['1 vertical reel (9:16, 30–45s)', '3 story frames', 'Raw clips folder'],
        dueAt: new Date(now + 10 * 86_400_000),
        feePaise: 1500000,
        createdById: amId,
      },
    });
    const revision = await prisma.creatorBrief.create({
      data: {
        orgId,
        creatorId: creator.id,
        clientOrgId: sunrise?.id,
        title: 'First-time buyer testimonial (UGC)',
        brief: 'Talk to camera as a young couple who just booked their first home. Natural, unscripted feel. Mention the clubhouse and the 10-minute drive to the metro.',
        deliverables: ['1 UGC video (60s)', '2 cut-downs (15s)'],
        dueAt: new Date(now + 4 * 86_400_000),
        feePaise: 1200000,
        status: 'revision',
        createdById: amId,
      },
    });
    await prisma.creatorSubmission.create({
      data: {
        orgId,
        briefId: revision.id,
        number: 1,
        url: 'https://drive.google.com/demo-ugc-testimonial-v1',
        note: 'First cut. Shot in natural light on the balcony.',
        feedback: 'Lovely energy! Please mention the metro distance earlier and trim the intro by 5 seconds.',
        approved: false,
        reviewedAt: new Date(now - 86_400_000),
        createdAt: new Date(now - 2 * 86_400_000),
      },
    });
    const approved = await prisma.creatorBrief.create({
      data: {
        orgId,
        creatorId: creator.id,
        clientOrgId: sunrise?.id,
        title: 'Launch week story set',
        brief: 'Three Instagram stories announcing the launch offer with a poll sticker and a link to the enquiry form.',
        deliverables: ['3 story frames'],
        dueAt: new Date(now - 7 * 86_400_000),
        feePaise: 300000,
        status: 'approved',
        createdById: amId,
      },
    });
    await prisma.creatorSubmission.create({
      data: { orgId, briefId: approved.id, number: 1, url: 'https://drive.google.com/demo-launch-stories', note: 'All three frames attached.', approved: true, reviewedAt: new Date(now - 6 * 86_400_000), createdAt: new Date(now - 8 * 86_400_000) },
    });
    await prisma.creatorPayout.create({ data: { orgId, creatorId: creator.id, briefId: approved.id, amountPaise: 300000, tdsPaise: 30000, netPaise: 270000 } });
  }

  // A second Sunrise user who approves creative.
  const approverRole = await role('client_approver');
  if (sunrise && approverRole) {
    const approver = await prisma.user.upsert({
      where: { orgId_email: { orgId, email: 'approver@sunrise.demo' } },
      update: {},
      create: { orgId, type: 'client', name: 'Lakshmi Prasad', email: 'approver@sunrise.demo', status: 'active' },
    });
    await prisma.clientUser.upsert({
      where: { userId: approver.id },
      update: {},
      create: { userId: approver.id, orgId, clientOrgId: sunrise.id, clientRole: 'client_approver', brandScope: [] },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId_scopeRef: { userId: approver.id, roleId: approverRole, scopeRef: '' } },
      update: {},
      create: { userId: approver.id, roleId: approverRole },
    });
  }

  // A couple of Sunrise requests this month, so the client's monthly report has something to show.
  const clientOwner = await prisma.user.findFirst({ where: { orgId, email: 'client@sunrise.demo' } });
  const smmEngagement = sunrise ? await prisma.engagement.findFirst({ where: { clientOrgId: sunrise.id, service: { key: 'smm' } } }) : null;
  if (smmEngagement && clientOwner && (await prisma.request.count({ where: { engagementId: smmEngagement.id, description: { startsWith: 'Can we add' } } })) === 0) {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    await prisma.request.createMany({
      data: [
        { orgId, engagementId: smmEngagement.id, type: 'question', description: 'Can we add our new site-visit number to the bio?', status: 'done', scopeDecision: 'in_scope', createdById: clientOwner.id, createdAt: hoursAgo(30), slaDue: hoursAgo(26), firstReplyAt: hoursAgo(28), resolvedAt: hoursAgo(20) },
        { orgId, engagementId: smmEngagement.id, type: 'change', description: 'Can we add a Diwali offer banner to next week’s posts?', status: 'in_progress', scopeDecision: 'in_scope', createdById: clientOwner.id, createdAt: hoursAgo(6), slaDue: hoursAgo(2), firstReplyAt: hoursAgo(4) },
      ],
    });
  }

  // Leave requests and a little attendance for the Account Manager.
  if (amId && (await prisma.leaveRequest.count({ where: { userId: amId } })) === 0) {
    const leadId = idOf('am.lead@bmu.demo');
    await prisma.leaveRequest.createMany({
      data: [
        { orgId, userId: amId, from: day('2026-08-17'), to: day('2026-08-18'), type: 'sick', reason: 'Fever', status: 'approved', decidedById: leadId, decidedAt: new Date('2026-08-17T04:00:00Z') },
        { orgId, userId: amId, from: day('2026-10-12'), to: day('2026-10-13'), type: 'casual', reason: 'Family function in Mysuru', status: 'approved', decidedById: leadId, decidedAt: new Date('2026-09-28T06:00:00Z') },
        { orgId, userId: amId, from: day('2026-11-09'), to: day('2026-11-11'), type: 'casual', reason: 'Diwali travel', status: 'pending' },
      ],
    });
  }
  if (amId && (await prisma.attendance.count({ where: { userId: amId } })) === 0) {
    const today = istDay(new Date());
    for (let i = 1; i <= 12; i++) {
      const d = istDay(new Date(Date.now() - i * 86_400_000));
      if (d >= today || new Date(`${d}T12:00:00Z`).getUTCDay() === 0) continue;
      const inMin = 9 * 60 + 20 + ((i * 7) % 25);
      const outMin = 18 * 60 + 25 + ((i * 11) % 40);
      const at = (m: number) => new Date(new Date(`${d}T00:00:00+05:30`).getTime() + m * 60_000);
      await prisma.attendance.create({ data: { orgId, userId: amId, date: day(d), checkIn: at(inMin), checkOut: at(outMin) } });
      if (i <= 5) {
        await prisma.eODReport.create({
          data: { orgId, userId: amId, date: day(d), completed: ['Client check-in with Sunrise', 'Shared logo concepts v1'], pending: ['Chase brand guidelines'], blocked: [], waiting: ['Social media access from client'] },
        });
      }
    }
  }

  // Starter SOP library (only when nobody has added SOPs yet).
  if ((await prisma.sOP.count({ where: { orgId } })) === 0) {
    const departments = await prisma.department.findMany({ where: { orgId }, select: { id: true, name: true } });
    for (const s of DEMO_SOPS) {
      const dept = departments.find((d) => d.name === s.department);
      if (dept) await prisma.sOP.create({ data: { orgId, departmentId: dept.id, title: s.title, body: s.body } });
    }
  }
}
