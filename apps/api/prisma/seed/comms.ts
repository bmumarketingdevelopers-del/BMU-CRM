import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { initialDocState } from '../../src/comms/doc-state.js';

// v17 communications demo data. Idempotent: every block checks before it writes.
// - Reply templates for the inbox.
// - Booking pages for the Client Managers and Sales (so the client portal and public links work at once).
// - A WhatsApp conversation from a demo client person (also on their message thread) and one from a lead.
// - A shared brief on one project and a past meeting with notes and a summary.

const IST = 330 * 60_000;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'meet';
/** Today (IST) at hh:mm, plus `days`. */
const at = (days: number, hh: number, mm = 0) => {
  const midnight = Math.floor((Date.now() + IST) / 86_400_000) * 86_400_000 - IST;
  return new Date(midnight + days * 86_400_000 + (hh * 60 + mm) * 60_000);
};

export async function seedComms(prisma: PrismaClient, orgId: string) {
  const founder = await prisma.user.findFirst({ where: { orgId, email: 'founder@bmu.demo' }, select: { id: true } });
  if (!founder) return;

  // 1. Reply templates.
  if ((await prisma.replyTemplate.count({ where: { orgId } })) === 0) {
    await prisma.replyTemplate.createMany({
      data: [
        { orgId, name: 'Got it, on it', channel: 'any', body: 'Hi {{first_name}}, thanks for your message. I am on it and will update you by end of day.\n\n{{my_name}}, BMU Marketing', createdById: founder.id },
        { orgId, name: 'Draft ready', channel: 'whatsapp', body: 'Hi {{first_name}}, your draft is ready. You can approve it in one tap from your portal: {{portal_link}}', createdById: founder.id },
        { orgId, name: 'Book a call', channel: 'any', body: 'Hi {{first_name}}, happy to talk it through. Pick a time that suits you in your portal (Meetings), or reply with a time.\n\n{{my_name}}', createdById: founder.id },
      ],
    });
  }

  // 2. Booking pages.
  const hosts = await prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: { in: ['account_manager', 'am_lead', 'sales_executive', 'sales_manager'] } } } } }, select: { id: true, name: true } });
  for (const h of hosts) {
    if (await prisma.bookingPage.findUnique({ where: { userId: h.id } })) continue;
    const base = slugify(h.name);
    let slug = base;
    for (let i = 2; await prisma.bookingPage.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
    await prisma.bookingPage.create({ data: { orgId, userId: h.id, slug, title: `Call with ${h.name.split(' ')[0]}`, days: [1, 2, 3, 4, 5, 6] } });
  }

  // 3. Inbox conversations.
  if ((await prisma.conversation.count({ where: { orgId } })) === 0) {
    const person = await prisma.clientUser.findFirst({
      where: { orgId, user: { phone: { not: null }, deletedAt: null }, clientOrg: { amUserId: { not: null } } },
      select: { userId: true, clientOrgId: true, user: { select: { name: true, phone: true } }, clientOrg: { select: { amUserId: true } } },
    });
    if (person?.user.phone) {
      const thread = (await prisma.thread.findFirst({ where: { clientOrgId: person.clientOrgId, type: 'client_am' } })) ?? (await prisma.thread.create({ data: { orgId, clientOrgId: person.clientOrgId, type: 'client_am' } }));
      const address = person.user.phone.replace(/\D/g, '').slice(-10);
      const conv = await prisma.conversation.create({
        data: { orgId, channel: 'whatsapp', address, name: person.user.name, clientOrgId: person.clientOrgId, userId: person.userId, threadId: thread.id, assigneeId: person.clientOrg.amUserId, unread: 1, lastMessageAt: new Date(Date.now() - 20 * 60_000) },
      });
      const body = 'Hi! Can we push the festive post to Friday? Our offer starts then.';
      const m = await prisma.message.create({ data: { orgId, threadId: thread.id, authorId: person.userId, body, source: 'whatsapp', createdAt: new Date(Date.now() - 20 * 60_000) } });
      await prisma.conversationMessage.create({ data: { orgId, conversationId: conv.id, direction: 'in', body, status: 'received', messageId: m.id, externalId: 'seed:wa:1', createdAt: new Date(Date.now() - 20 * 60_000) } });
    }
    const lead = await prisma.lead.findFirst({ where: { orgId, deletedAt: null, stage: { in: ['new', 'contacted', 'discovery'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, contact: true, ownerId: true } });
    const contact = (lead?.contact ?? {}) as { name?: string; phone?: string };
    const leadPhone = (contact.phone ?? '').replace(/\D/g, '').slice(-10);
    if (lead && leadPhone.length === 10) {
      const conv = await prisma.conversation.create({
        data: { orgId, channel: 'whatsapp', address: leadPhone, name: contact.name ?? null, leadId: lead.id, assigneeId: lead.ownerId, unread: 1, lastMessageAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      await prisma.conversationMessage.create({ data: { orgId, conversationId: conv.id, direction: 'in', body: 'Hello, saw your reels work. What would 8 reels a month cost?', status: 'received', externalId: 'seed:wa:2', createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    }
    await prisma.conversation.create({ data: { orgId, channel: 'email', address: 'hello@newcafe.example', name: 'New Cafe', unread: 1, lastMessageAt: new Date(Date.now() - 5 * 3_600_000), messages: { create: { orgId, direction: 'in', subject: 'Website and Instagram', body: 'Hi team, we are opening a cafe in Indiranagar next month and need a website and Instagram. Can we talk?', status: 'received', externalId: 'seed:em:1' } } } });
  }

  // 4. A shared brief and a past meeting on a live project.
  const eng = await prisma.engagement.findFirst({ where: { orgId, status: { in: ['in_production', 'active_retainer'] }, amId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { id: true, clientOrgId: true, amId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
  if (eng && (await prisma.collabDoc.count({ where: { orgId } })) === 0) {
    const text = `Goal: more walk-ins during the festive season.\n\nAudience: families in Bengaluru, 25 to 45.\n\nKey message: festive offers, this week only.\n\nDeliverables: 4 posts, 2 reels, 6 stories.\n\nMust include: logo, store address, offer dates.\n\nTone and look: warm, bright, festive colours.\n`;
    await prisma.collabDoc.create({ data: { orgId, title: `${eng.clientOrg.name} festive brief`, kind: 'brief', clientOrgId: eng.clientOrgId, engagementId: eng.id, clientVisible: true, state: initialDocState(text), text, createdById: eng.amId!, updatedById: eng.amId! } });
  }
  if (eng && (await prisma.meeting.count({ where: { orgId } })) === 0) {
    const notes = 'Reviewed October results. Reels did best. Client wants more behind-the-scenes content.\n- [ ] Share 5 reel ideas by Friday\nAction: send the November plan draft';
    await prisma.meeting.create({
      data: {
        orgId,
        title: `${eng.clientOrg.name} monthly review`,
        hostId: eng.amId!,
        startAt: at(-3, 11),
        endAt: at(-3, 11, 30),
        clientOrgId: eng.clientOrgId,
        status: 'done',
        bookedVia: 'team',
        notes,
        summary: 'We reviewed October results; reels performed best. The client wants more behind-the-scenes content in November.',
        actionItems: [
          { text: 'Share 5 reel ideas by Friday', taskId: null },
          { text: 'Send the November plan draft', taskId: null },
        ],
      },
    });
  }
}
