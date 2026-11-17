// The client invitation email: sent when a client login is created (add client, + Invite user, a confirmed Owner,
// a client adding a teammate, an account opened by a paid proposal) and again from "Resend invite".
import type { PrismaService } from '../prisma/prisma.service.js';
import { appUrl, type EmailService } from '../service/email.service.js';

/**
 * Emails each client login that has not signed in yet a link to the portal. People with no email (phone only) are
 * skipped: they sign in with their mobile number. Returns how many invitations were sent.
 */
export async function sendClientInvites(
  prisma: PrismaService,
  email: EmailService,
  by: { orgId: string; name: string },
  clientOrgId: string,
  userIds: string[],
): Promise<number> {
  if (!userIds.length) return 0;
  const [users, client] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds }, orgId: by.orgId, type: 'client', status: 'invited', deletedAt: null }, select: { id: true, name: true, email: true, phone: true } }),
    prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: by.orgId }, select: { name: true, am: { select: { name: true } } } }),
  ]);
  const signIn = appUrl('/sign-in');
  const clientName = client?.name ?? 'your company';
  const cm = client?.am?.name;
  let sent = 0;
  for (const u of users) {
    if (!u.email) continue;
    await email.send({
      orgId: by.orgId,
      to: u.email,
      toName: u.name,
      toUserId: u.id,
      kind: 'client_invite',
      subject: `Your BMU Hub account for ${clientName} is ready`,
      heading: 'Welcome to BMU',
      paragraphs: [
        `Hi ${u.name.split(' ')[0]}, ${by.name} added you to BMU Hub for ${clientName}. Follow your work, review and approve deliverables, share files and message ${cm ? `${cm}, your client manager,` : 'your client manager'} in one place.`,
        `Sign in with this email${u.phone ? ' or your mobile number' : ''}. We send you a one-time code each time, so there is no password to remember.`,
      ],
      button: { label: 'Sign in to BMU Hub', url: signIn },
      entity: 'User',
      entityId: u.id,
    });
    sent++;
  }
  return sent;
}
