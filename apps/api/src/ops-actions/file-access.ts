// v36: who may see a file, by department.
// - Founder, Branch Manager, CM Lead, Finance: every file.
// - Client Managers: every file of their own clients (they work across departments with the client).
// - Department Heads: their department's files across all clients, plus every file (all departments and Client files)
//   of clients their department works on (v37).
// - Team members: their department's files and the Client files of the clients they work on.
// - Everyone: files they uploaded themselves. Files with no client: the uploader's department and leadership.
// - v38: files sent in a discussion or on a task are private to that conversation: the sender, the people in the
//   discussion (project threads: everyone on the client) or the task's owner, creator and watchers, plus the Founder
//   and Branch Managers. The department rules above don't open them to anyone else.
import type { Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ALL_FILES = ['founder', 'admin', 'am_lead', 'finance'];
/** v38: who also sees files sent in discussions and on tasks they are not part of. */
const SENT_FILES_ALL = ['founder', 'admin'];
/** v38: tags of files sent to teammates in a discussion or on a task. */
export const SENT_FILE_TAGS = ['discussion-file', 'task-file'];
const has = (me: Me, roles: string[]) => me.roles.some((r) => roles.includes(r));

type Sent = {
  /** v38: files sent to this person (or by them) in discussions and on tasks. */
  sent: string[];
  /** v38: Founder / Branch Manager: every sent file too. */
  allSent: boolean;
};

export type FileScope =
  | ({ all: true } & Sent)
  | ({
      all: false;
      /** Clients this person manages as Client Manager: every department. */
      cmClients: string[];
      /** Departments whose files they see: a head's across all clients; a member's only on clients they work on. */
      headDepts: string[];
      memberDept: string | null;
      /** Clients they (or, for a head, their department) work on: Client files and a member's department files. */
      workClients: string[];
      /** v37: clients a head's department works on: every department's files there. */
      headClients: string[];
    } & Sent);

/** v38: files in discussions this person is in (project threads: on clients they work on) and on their tasks. */
async function sentFiles(prisma: PrismaService, me: Me, projectClients: 'all' | string[]): Promise<string[]> {
  const watched = (await prisma.watcher.findMany({ where: { userId: me.id, targetType: 'task' }, select: { targetId: true } })).map((w) => w.targetId);
  const [messages, tasks] = await Promise.all([
    prisma.message.findMany({
      where: {
        orgId: me.orgId,
        attachments: { isEmpty: false },
        thread: {
          type: { in: ['project', 'internal'] },
          OR: [projectClients === 'all' ? { type: 'project' } : { type: 'project', clientOrgId: { in: projectClients } }, { createdById: me.id }, { participantIds: { has: me.id } }],
        },
      },
      select: { attachments: true },
    }),
    prisma.task.findMany({ where: { orgId: me.orgId, attachments: { isEmpty: false }, OR: [{ ownerId: me.id }, { createdById: me.id }, ...(watched.length ? [{ id: { in: watched } }] : [])] }, select: { attachments: true } }),
  ]);
  return [...new Set([...messages.flatMap((m) => m.attachments), ...tasks.flatMap((t) => t.attachments)])];
}

export async function fileScope(prisma: PrismaService, me: Me): Promise<FileScope> {
  if (me.type !== 'staff') return { all: false, cmClients: [], headDepts: [], memberDept: null, workClients: [], headClients: [], sent: [], allSent: false };
  const allSent = has(me, SENT_FILES_ALL);
  // Project threads are open to leadership and Department Heads (as in Discussions).
  const allProjects = has(me, ['founder', 'admin', 'am_lead', 'department_head']);
  if (has(me, ALL_FILES)) return { all: true, allSent, sent: allSent ? [] : await sentFiles(prisma, me, allProjects ? 'all' : []) };
  const self = await prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
  const [managed, engs, myTasks] = await Promise.all([
    prisma.clientOrg.findMany({ where: { orgId: me.orgId, amUserId: me.id }, select: { id: true } }),
    prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id }, select: { clientOrgId: true } }),
    prisma.task.findMany({ where: { orgId: me.orgId, ownerId: me.id, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] }),
  ]);
  const cmClients = me.roles.includes('account_manager') ? [...new Set([...managed.map((c) => c.id), ...engs.map((e) => e.clientOrgId)])] : [];
  let headDepts: string[] = [];
  if (me.roles.includes('department_head')) {
    headDepts = (await prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } })).map((d) => d.id);
    if (!headDepts.length && self?.departmentId) headDepts = [self.departmentId];
  }
  const engIds = myTasks.map((t) => t.engagementId!);
  // A head's department works on a client when it has tasks or deliverables there.
  const deptTasks = headDepts.length
    ? await prisma.task.findMany({ where: { orgId: me.orgId, departmentId: { in: headDepts }, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] })
    : [];
  const deptEngs = headDepts.length
    ? await prisma.engagement.findMany({
        where: { orgId: me.orgId, OR: [{ id: { in: deptTasks.map((t) => t.engagementId!) } }, { cycles: { some: { deliverables: { some: { departmentId: { in: headDepts } } } } } }] },
        select: { clientOrgId: true },
      })
    : [];
  const mine = engIds.length ? await prisma.engagement.findMany({ where: { id: { in: engIds } }, select: { clientOrgId: true } }) : [];
  const workClients = [...new Set([...mine.map((e) => e.clientOrgId), ...deptEngs.map((e) => e.clientOrgId), ...cmClients])];
  const sent = await sentFiles(prisma, me, allProjects ? 'all' : [...new Set([...mine.map((e) => e.clientOrgId), ...cmClients])]);
  return { all: false, cmClients, headDepts, memberDept: self?.departmentId ?? null, workClients, headClients: [...new Set(deptEngs.map((e) => e.clientOrgId))], sent, allSent };
}

/** The files a person may see, as a Prisma filter. */
export function fileWhere(me: Me, s: FileScope): Prisma.FileWhereInput {
  if (s.all && s.allSent) return {};
  // v38: files sent in discussions and on tasks: only the people they were sent to (and the sender).
  const mine: Prisma.FileWhereInput[] = [{ uploadedById: me.id }, ...(s.sent.length ? [{ id: { in: s.sent } }] : [])];
  const notSent: Prisma.FileWhereInput = { NOT: { tags: { hasSome: SENT_FILE_TAGS } } };
  if (s.all) return { OR: [...mine, notSent] };
  const myDepts = [...new Set([...s.headDepts, ...(s.memberDept ? [s.memberDept] : [])])];
  return { OR: [...mine, { AND: [notSent, byDepartment(s, myDepts)] }] };
}

function byDepartment(s: Extract<FileScope, { all: false }>, myDepts: string[]): Prisma.FileWhereInput {
  return {
    OR: [
      ...(s.cmClients.length ? [{ clientOrgId: { in: s.cmClients } }] : []),
      ...(s.headDepts.length ? [{ departmentId: { in: s.headDepts } }] : []),
      // v37: a head sees every department's files for clients their department works on.
      ...(s.headClients.length ? [{ clientOrgId: { in: s.headClients } }] : []),
      ...(s.memberDept ? [{ departmentId: s.memberDept, clientOrgId: { in: s.workClients } }] : []),
      // Client files (no department): for everyone working on that client.
      { departmentId: null, clientOrgId: { in: s.workClients } },
      // Department files not tied to a client.
      ...(myDepts.length ? [{ clientOrgId: null, departmentId: { in: myDepts } }] : []),
    ],
  };
}

/** Whether a person may see one file (same rules as fileWhere). */
export function canSeeFile(me: Me, s: FileScope, f: { id: string; tags: string[]; uploadedById: string | null; clientOrgId: string | null; departmentId: string | null }) {
  if (f.uploadedById === me.id || s.sent.includes(f.id)) return true;
  if (f.tags.some((t) => SENT_FILE_TAGS.includes(t))) return s.all && s.allSent;
  if (s.all) return true;
  if (f.clientOrgId && s.cmClients.includes(f.clientOrgId)) return true;
  if (f.departmentId && s.headDepts.includes(f.departmentId)) return true;
  if (f.clientOrgId && s.headClients.includes(f.clientOrgId)) return true;
  if (f.departmentId && f.departmentId === s.memberDept && f.clientOrgId && s.workClients.includes(f.clientOrgId)) return true;
  if (!f.departmentId && f.clientOrgId && s.workClients.includes(f.clientOrgId)) return true;
  if (!f.clientOrgId && f.departmentId && (s.headDepts.includes(f.departmentId) || f.departmentId === s.memberDept)) return true;
  return false;
}

/** The department a new team upload belongs to: the one picked, else the uploader's. */
export async function uploaderDepartment(prisma: PrismaService, userId: string) {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } }))?.departmentId ?? null;
}
