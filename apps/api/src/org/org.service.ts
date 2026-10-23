import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CAPABILITIES,
  normaliseIdentifier,
  type InviteUser,
  type Me,
  type OrgTree,
  type OrgUser,
  type RoleWithPermissions,
  type UpdateUser,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { approvesNewPeople, canAddPeople } from '../people-actions/people-access.js';

const userInclude = { roles: { include: { role: true } } } as const;
type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

const toOrgUser = (u: UserWithRoles): OrgUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  type: u.type,
  status: u.status,
  managerId: u.managerId,
  departmentId: u.departmentId,
  teamId: u.teamId,
  branchId: u.branchId,
  specialty: u.specialty,
  roles: u.roles.map((r) => ({ id: r.role.id, name: r.role.name, baseRole: r.role.baseRole })),
});

@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private access(me: Me) {
    return me.permissions.users_roles_hierarchy ?? { scope: 'none' as const, rule: 'none' };
  }

  /** Which users `me` may see, per users_roles_hierarchy scope. */
  private async visibleUsersWhere(me: Me): Promise<Prisma.UserWhereInput> {
    const { scope } = this.access(me);
    const self = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    const base: Prisma.UserWhereInput = { orgId: me.orgId, deletedAt: null };
    switch (scope) {
      case 'all':
        return base;
      case 'branch':
        return { ...base, branchId: self.branchId };
      case 'department':
        return { ...base, departmentId: self.departmentId };
      case 'own':
        return me.clientOrg
          ? { ...base, clientUser: { clientOrgId: me.clientOrg.id } }
          : { ...base, OR: [{ id: me.id }, { managerId: me.id }] };
      default:
        throw new ForbiddenException("You don't have access to people data");
    }
  }

  private assertCanEdit(me: Me) {
    const { scope, rule } = this.access(me);
    if (scope === 'none' || rule.startsWith('view')) throw new ForbiddenException('You can view people but not change them');
  }

  async tree(me: Me): Promise<OrgTree> {
    const [branches, users] = await Promise.all([
      this.prisma.branch.findMany({
        where: { orgId: me.orgId, deletedAt: null },
        include: { departments: { where: { deletedAt: null }, include: { teams: { where: { deletedAt: null } } }, orderBy: { name: 'asc' } } },
      }),
      this.users(me),
    ]);
    return {
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        city: b.city,
        departments: b.departments.map((d) => ({ id: d.id, name: d.name, teams: d.teams.map((t) => ({ id: t.id, name: t.name })) })),
      })),
      users,
    };
  }

  async users(me: Me): Promise<OrgUser[]> {
    const rows = await this.prisma.user.findMany({
      where: { ...(await this.visibleUsersWhere(me)), type: me.clientOrg ? 'client' : 'staff' },
      include: userInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map(toOrgUser);
  }

  private async assertRoleAssignable(me: Me, roleId: string, inviting = false) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, orgId: me.orgId } });
    if (!role) throw new BadRequestException('Unknown role');
    if (role.baseRole === 'founder' && !me.roles.includes('founder')) {
      throw new ForbiddenException('Only the Founder can grant the Founder role');
    }
    // v11 people: making someone a Branch Manager needs the Founder (approval_matrix); the Change role action asks for it.
    if (role.baseRole === 'admin' && !me.roles.includes('founder') && !me.roles.includes('hr_ops')) {
      throw new ForbiddenException("Making someone a Branch Manager needs the Founder's approval. Use Change role on the person.");
    }
    // A new Branch Manager from HR goes through Add person, where the Founder approves it; never straight from an invite.
    if (role.baseRole === 'admin' && inviting && !me.roles.includes('founder')) {
      throw new ForbiddenException('Add a new Branch Manager with Add person: the Founder approves it');
    }
    if (this.access(me).rule === 'people data only') {
      // HR invites new team members with their starting role, but cannot change roles afterwards or hand out leadership roles.
      if (!inviting) throw new ForbiddenException('HR can edit people data, not roles');
      if (['founder', 'admin'].includes(role.baseRole) || role.baseRole.startsWith('client_')) throw new ForbiddenException('HR cannot invite someone as Founder or Branch Manager');
    }
    return role;
  }

  async invite(me: Me, input: InviteUser, ip?: string): Promise<OrgUser> {
    if (!canAddPeople(me)) throw new ForbiddenException('Only the Founder or HR can add people');
    if (!approvesNewPeople(me)) throw new ForbiddenException('Your new people need approval: use Add person, and a Founder or the HR Department Head approves');
    this.assertCanEdit(me);
    await this.assertRoleAssignable(me, input.roleId, true);
    if (input.phone && !/^(\+?91)?[6-9]\d{9}$/.test(input.phone.replace(/[\s-]/g, ''))) throw new BadRequestException('Enter a 10-digit Indian mobile number');
    const email = input.email ? normaliseIdentifier(input.email) : null;
    const phone = input.phone ? normaliseIdentifier(input.phone) : null;
    const clash = await this.prisma.user.findFirst({
      where: { orgId: me.orgId, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] },
    });
    if (clash) throw new BadRequestException('Someone already uses that email or phone');

    const user = await this.prisma.user.create({
      data: {
        orgId: me.orgId,
        type: 'staff',
        name: input.name,
        email,
        phone,
        departmentId: input.departmentId,
        teamId: input.teamId,
        managerId: input.managerId,
        branchId: input.branchId,
        specialty: input.specialty ?? null,
        roles: { create: { roleId: input.roleId } },
      },
      include: userInclude,
    });
    const result = toOrgUser(user);
    await this.audit.log(me, 'user.invited', 'User', user.id, undefined, result, ip);
    return result;
  }

  async updateUser(me: Me, id: string, input: UpdateUser, ip?: string): Promise<OrgUser> {
    this.assertCanEdit(me);
    const visible = await this.visibleUsersWhere(me);
    const existing = await this.prisma.user.findFirst({ where: { ...visible, id }, include: userInclude });
    if (!existing) throw new NotFoundException('User not found');
    if (existing.roles.some((r) => r.role.baseRole === 'founder') && !me.roles.includes('founder')) {
      throw new ForbiddenException("Only the Founder can change the Founder's account");
    }
    if (input.managerId === id) throw new BadRequestException("Someone can't report to themselves");
    if (id === me.id && input.status === 'suspended') throw new BadRequestException("You can't suspend your own account");
    if (input.managerId && (await this.wouldCreateCycle(id, input.managerId))) {
      throw new BadRequestException('That would create a reporting loop');
    }
    if (input.roleId) await this.assertRoleAssignable(me, input.roleId);

    const { roleId, ...fields } = input;
    const user = await this.prisma.$transaction(async (tx) => {
      if (roleId) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.create({ data: { userId: id, roleId } });
      }
      return tx.user.update({ where: { id }, data: fields, include: userInclude });
    });
    const result = toOrgUser(user);
    const action = input.status === 'suspended' && existing.status !== 'suspended' ? 'user.suspended' : input.status === 'active' && existing.status === 'suspended' ? 'user.reactivated' : 'user.updated';
    await this.audit.log(me, action, 'User', id, toOrgUser(existing), result, ip);
    return result;
  }

  /** True if making managerId the manager of userId would loop the reporting tree. */
  private async wouldCreateCycle(userId: string, managerId: string): Promise<boolean> {
    let cursor: string | null = managerId;
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor === userId) return true;
      const next: { managerId: string | null } | null = await this.prisma.user.findUnique({
        where: { id: cursor },
        select: { managerId: true },
      });
      cursor = next?.managerId ?? null;
    }
    return false;
  }

  async roles(me: Me): Promise<RoleWithPermissions[]> {
    const roles = await this.prisma.role.findMany({
      where: { orgId: me.orgId },
      include: { permissions: true },
      orderBy: [{ isCustom: 'asc' }, { name: 'asc' }],
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      baseRole: r.baseRole,
      isCustom: r.isCustom,
      permissions: CAPABILITIES.map((c) => {
        const p = r.permissions.find((x) => x.capability === c);
        return { capability: c, scope: p?.scope ?? 'none', rule: p?.rule ?? 'none' };
      }),
    }));
  }

  private assertCanEditRoles(me: Me) {
    if (this.access(me).scope !== 'all' || this.access(me).rule !== 'full') {
      throw new ForbiddenException('Only the Founder can change roles and permissions');
    }
  }

  async setPermission(me: Me, roleId: string, capability: string, scope: string, ip?: string) {
    this.assertCanEditRoles(me);
    if (!(CAPABILITIES as string[]).includes(capability)) throw new BadRequestException('Unknown capability');
    const role = await this.prisma.role.findFirst({ where: { id: roleId, orgId: me.orgId }, include: { permissions: true } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.baseRole === 'founder') throw new BadRequestException("The Founder role always has full access");
    const before = role.permissions.find((p) => p.capability === capability) ?? null;
    const rule = scope === 'none' ? 'none' : scope === 'own' ? 'own' : scope === 'all' ? 'full' : scope;
    await this.prisma.permission.upsert({
      where: { roleId_capability: { roleId, capability } },
      update: { scope: scope as never, rule },
      create: { roleId, capability, scope: scope as never, rule },
    });
    await this.audit.log(me, 'permission.changed', 'Role', roleId, before, { capability, scope, rule }, ip);
    return (await this.roles(me)).find((r) => r.id === roleId)!;
  }

  async cloneRole(me: Me, roleId: string, name: string, ip?: string) {
    this.assertCanEditRoles(me);
    const role = await this.prisma.role.findFirst({ where: { id: roleId, orgId: me.orgId }, include: { permissions: true } });
    if (!role) throw new NotFoundException('Role not found');
    if (await this.prisma.role.findFirst({ where: { orgId: me.orgId, name } })) throw new BadRequestException('A role with that name exists');
    const created = await this.prisma.role.create({
      data: {
        orgId: me.orgId,
        name,
        baseRole: role.baseRole,
        isCustom: true,
        permissions: { create: role.permissions.map(({ capability, scope, rule }) => ({ capability, scope, rule })) },
      },
    });
    await this.audit.log(me, 'role.cloned', 'Role', created.id, { from: role.id }, { name }, ip);
    return (await this.roles(me)).find((r) => r.id === created.id)!;
  }
}
