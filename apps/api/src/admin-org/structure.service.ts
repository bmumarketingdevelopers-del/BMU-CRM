import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { BranchInput, DepartmentInput, DepartmentUpdate, Me, MoveMember, OrgStructureView, TeamInput, TeamUpdate } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertOrgEditor, assertOrgReader, canEditOrg } from './access.js';

/** Branches, departments and teams (pods) with heads, leads and members. */
@Injectable()
export class StructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(me: Me): Promise<OrgStructureView> {
    assertOrgReader(me);
    const [branches, staff] = await Promise.all([
      this.prisma.branch.findMany({
        where: { orgId: me.orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: {
          departments: {
            where: { deletedAt: null },
            orderBy: { name: 'asc' },
            include: { teams: { where: { deletedAt: null }, orderBy: { name: 'asc' } } },
          },
        },
      }),
      this.prisma.user.findMany({
        where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, branchId: true, departmentId: true, teamId: true, roles: { select: { role: { select: { baseRole: true } } } } },
      }),
    ]);
    const people = staff.map((u) => ({ id: u.id, name: u.name, branchId: u.branchId, departmentId: u.departmentId, teamId: u.teamId, roles: u.roles.map((r) => r.role.baseRole) }));
    const ref = (id: string | null) => {
      const u = id ? people.find((p) => p.id === id) : undefined;
      return u ? { id: u.id, name: u.name } : null;
    };
    const firstBranch = branches[0]?.id;
    return {
      canEdit: canEditOrg(me),
      staff: people,
      branches: branches.map((b) => {
        const departments = b.departments.map((d) => {
          const members = people.filter((p) => p.departmentId === d.id);
          return {
            id: d.id,
            name: d.name,
            head: ref(d.headUserId),
            headcount: members.length,
            teams: d.teams.map((t) => ({
              id: t.id,
              name: t.name,
              lead: ref(t.leadUserId),
              members: people.filter((p) => p.teamId === t.id).map((p) => ({ id: p.id, name: p.name })),
            })),
            unassigned: members.filter((p) => !p.teamId || !d.teams.some((t) => t.id === p.teamId)).map((p) => ({ id: p.id, name: p.name })),
          };
        });
        // People with no branch count towards the first (head-office) branch.
        const headcount = people.filter((p) => p.branchId === b.id || (!p.branchId && b.id === firstBranch)).length;
        return { id: b.id, name: b.name, city: b.city, headcount, departments };
      }),
    };
  }

  private async staffUser(me: Me, id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, orgId: me.orgId, type: 'staff', deletedAt: null } });
    if (!u) throw new BadRequestException('That person is not on the team');
    return u;
  }

  async createBranch(me: Me, input: BranchInput, ip?: string) {
    assertOrgEditor(me);
    if (await this.prisma.branch.findFirst({ where: { orgId: me.orgId, name: input.name, deletedAt: null } })) throw new ConflictException('A branch with that name already exists');
    const b = await this.prisma.branch.create({ data: { orgId: me.orgId, ...input } });
    await this.audit.log(me, 'branch.created', 'Branch', b.id, null, input, ip);
    return this.view(me);
  }

  async updateBranch(me: Me, id: string, input: Partial<BranchInput>, ip?: string) {
    assertOrgEditor(me);
    const b = await this.prisma.branch.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!b) throw new NotFoundException('Branch not found');
    if (input.name && input.name !== b.name && (await this.prisma.branch.findFirst({ where: { orgId: me.orgId, name: input.name, deletedAt: null } })))
      throw new ConflictException('A branch with that name already exists');
    await this.prisma.branch.update({ where: { id }, data: input });
    await this.audit.log(me, 'branch.updated', 'Branch', id, { name: b.name, city: b.city }, input, ip);
    return this.view(me);
  }

  async createDepartment(me: Me, input: DepartmentInput, ip?: string) {
    assertOrgEditor(me);
    const branch = await this.prisma.branch.findFirst({ where: { id: input.branchId, orgId: me.orgId, deletedAt: null } });
    if (!branch) throw new BadRequestException('Branch not found');
    const existing = await this.prisma.department.findUnique({ where: { branchId_name: { branchId: branch.id, name: input.name } } });
    if (existing && !existing.deletedAt) throw new ConflictException('This branch already has a department with that name');
    // A soft-deleted department with the same name is brought back (the name is unique per branch).
    const d = existing
      ? await this.prisma.department.update({ where: { id: existing.id }, data: { deletedAt: null, headUserId: null } })
      : await this.prisma.department.create({ data: { orgId: me.orgId, branchId: branch.id, name: input.name } });
    await this.audit.log(me, 'department.created', 'Department', d.id, null, input, ip);
    return this.view(me);
  }

  async updateDepartment(me: Me, id: string, input: DepartmentUpdate, ip?: string) {
    assertOrgEditor(me);
    const d = await this.prisma.department.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!d) throw new NotFoundException('Department not found');
    if (input.name && input.name !== d.name && (await this.prisma.department.findUnique({ where: { branchId_name: { branchId: d.branchId, name: input.name } } })))
      throw new ConflictException('This branch already has a department with that name');
    if (input.headUserId) await this.staffUser(me, input.headUserId);
    await this.prisma.department.update({ where: { id }, data: input });
    await this.audit.log(me, 'department.updated', 'Department', id, { name: d.name, headUserId: d.headUserId }, input, ip);
    return this.view(me);
  }

  async deleteDepartment(me: Me, id: string, ip?: string) {
    assertOrgEditor(me);
    const d = await this.prisma.department.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!d) throw new NotFoundException('Department not found');
    const [people, teams] = await Promise.all([
      this.prisma.user.count({ where: { departmentId: id, deletedAt: null } }),
      this.prisma.team.count({ where: { departmentId: id, deletedAt: null } }),
    ]);
    if (people || teams) throw new ConflictException(`Move its ${people} people and remove its ${teams} teams before deleting this department`);
    await this.prisma.department.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(me, 'department.deleted', 'Department', id, { name: d.name }, null, ip);
    return this.view(me);
  }

  async createTeam(me: Me, input: TeamInput, ip?: string) {
    assertOrgEditor(me);
    const d = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null } });
    if (!d) throw new BadRequestException('Department not found');
    if (await this.prisma.team.findFirst({ where: { departmentId: d.id, name: input.name, deletedAt: null } })) throw new ConflictException('This department already has a team with that name');
    if (input.leadUserId) await this.staffUser(me, input.leadUserId);
    const t = await this.prisma.team.create({ data: { orgId: me.orgId, departmentId: d.id, name: input.name, leadUserId: input.leadUserId ?? null } });
    if (input.leadUserId) await this.placeUser(input.leadUserId, t.id, d.id, d.branchId);
    await this.audit.log(me, 'team.created', 'Team', t.id, null, input, ip);
    return this.view(me);
  }

  async updateTeam(me: Me, id: string, input: TeamUpdate, ip?: string) {
    assertOrgEditor(me);
    const t = await this.prisma.team.findFirst({ where: { id, orgId: me.orgId, deletedAt: null }, include: { department: true } });
    if (!t) throw new NotFoundException('Team not found');
    if (input.leadUserId) await this.staffUser(me, input.leadUserId);
    await this.prisma.team.update({ where: { id }, data: input });
    if (input.leadUserId) await this.placeUser(input.leadUserId, t.id, t.departmentId, t.department.branchId);
    await this.audit.log(me, 'team.updated', 'Team', id, { name: t.name, leadUserId: t.leadUserId }, input, ip);
    return this.view(me);
  }

  async deleteTeam(me: Me, id: string, ip?: string) {
    assertOrgEditor(me);
    const t = await this.prisma.team.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!t) throw new NotFoundException('Team not found');
    const people = await this.prisma.user.count({ where: { teamId: id, deletedAt: null } });
    if (people) throw new ConflictException(`Move its ${people} members out before removing this team`);
    await this.prisma.team.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(me, 'team.deleted', 'Team', id, { name: t.name }, null, ip);
    return this.view(me);
  }

  private placeUser(userId: string, teamId: string | null, departmentId: string, branchId: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { teamId, departmentId, branchId } });
  }

  async moveMember(me: Me, input: MoveMember, ip?: string) {
    assertOrgEditor(me);
    const u = await this.staffUser(me, input.userId);
    const before = { teamId: u.teamId, departmentId: u.departmentId, branchId: u.branchId };
    if (input.teamId) {
      const t = await this.prisma.team.findFirst({ where: { id: input.teamId, orgId: me.orgId, deletedAt: null }, include: { department: true } });
      if (!t) throw new BadRequestException('Team not found');
      await this.placeUser(u.id, t.id, t.departmentId, t.department.branchId);
    } else if (input.departmentId) {
      const d = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null } });
      if (!d) throw new BadRequestException('Department not found');
      await this.placeUser(u.id, null, d.id, d.branchId);
    } else {
      await this.prisma.user.update({ where: { id: u.id }, data: { teamId: null } });
    }
    // A lead who leaves their team stops being its lead.
    if (u.teamId && u.teamId !== input.teamId) await this.prisma.team.updateMany({ where: { id: u.teamId, leadUserId: u.id }, data: { leadUserId: null } });
    await this.audit.log(me, 'user.team_changed', 'User', u.id, before, input, ip);
    return this.view(me);
  }
}
