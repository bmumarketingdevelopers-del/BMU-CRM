// v36: who may see a file, by department.
// - Founder, Branch Manager, CM Lead, Finance: every file.
// - Client Managers: every file of their own clients (they work across departments with the client).
// - Department Heads: their department's files across all clients, plus Client files (client uploads, client chat)
//   of clients their department works on.
// - Team members: their department's files and the Client files of the clients they work on.
// - Everyone: files they uploaded themselves. Files with no client: the uploader's department and leadership.
import type { Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ALL_FILES = ['founder', 'admin', 'am_lead', 'finance'];
const has = (me: Me, roles: string[]) => me.roles.some((r) => roles.includes(r));

export type FileScope =
  | { all: true }
  | {
      all: false;
      /** Clients this person manages as Client Manager: every department. */
      cmClients: string[];
      /** Departments whose files they see: a head's across all clients; a member's only on clients they work on. */
      headDepts: string[];
      memberDept: string | null;
      /** Clients they (or, for a head, their department) work on: Client files and a member's department files. */
      workClients: string[];
    };

export async function fileScope(prisma: PrismaService, me: Me): Promise<FileScope> {
  if (me.type !== 'staff') return { all: false, cmClients: [], headDepts: [], memberDept: null, workClients: [] };
  if (has(me, ALL_FILES)) return { all: true };
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
  return { all: false, cmClients, headDepts, memberDept: self?.departmentId ?? null, workClients };
}

/** The files a person may see, as a Prisma filter. */
export function fileWhere(me: Me, s: FileScope): Prisma.FileWhereInput {
  if (s.all) return {};
  const myDepts = [...new Set([...s.headDepts, ...(s.memberDept ? [s.memberDept] : [])])];
  return {
    OR: [
      { uploadedById: me.id },
      ...(s.cmClients.length ? [{ clientOrgId: { in: s.cmClients } }] : []),
      ...(s.headDepts.length ? [{ departmentId: { in: s.headDepts } }] : []),
      ...(s.memberDept ? [{ departmentId: s.memberDept, clientOrgId: { in: s.workClients } }] : []),
      // Client files (no department): for everyone working on that client.
      { departmentId: null, clientOrgId: { in: s.workClients } },
      // Department files not tied to a client.
      ...(myDepts.length ? [{ clientOrgId: null, departmentId: { in: myDepts } }] : []),
    ],
  };
}

/** Whether a person may see one file (same rules as fileWhere). */
export function canSeeFile(me: Me, s: FileScope, f: { uploadedById: string | null; clientOrgId: string | null; departmentId: string | null }) {
  if (s.all || f.uploadedById === me.id) return true;
  if (f.clientOrgId && s.cmClients.includes(f.clientOrgId)) return true;
  if (f.departmentId && s.headDepts.includes(f.departmentId)) return true;
  if (f.departmentId && f.departmentId === s.memberDept && f.clientOrgId && s.workClients.includes(f.clientOrgId)) return true;
  if (!f.departmentId && f.clientOrgId && s.workClients.includes(f.clientOrgId)) return true;
  if (!f.clientOrgId && f.departmentId && (s.headDepts.includes(f.departmentId) || f.departmentId === s.memberDept)) return true;
  return false;
}

/** The department a new team upload belongs to: the one picked, else the uploader's. */
export async function uploaderDepartment(prisma: PrismaService, userId: string) {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } }))?.departmentId ?? null;
}
