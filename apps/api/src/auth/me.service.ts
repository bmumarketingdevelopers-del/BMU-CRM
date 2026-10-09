import { Injectable } from '@nestjs/common';
import { widerScope, type AccessScope, type Me, type PermissionMap } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Loads a user with merged permissions across all their roles (widest scope wins). */
  async load(userId: string): Promise<Me | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: { not: 'suspended' } },
      include: {
        roles: { include: { role: { include: { permissions: true } } } },
        clientUser: { include: { clientOrg: true } },
      },
    });
    if (!user) return null;

    const permissions: PermissionMap = {};
    for (const { role } of user.roles) {
      for (const p of role.permissions) {
        const key = p.capability as keyof PermissionMap;
        const current = permissions[key];
        const scope = p.scope as AccessScope;
        if (!current || widerScope(current.scope, scope) === scope) permissions[key] = { scope, rule: p.rule };
      }
    }

    return {
      id: user.id,
      orgId: user.orgId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      type: user.type,
      roles: user.roles.map((r) => r.role.baseRole),
      permissions,
      specialty: user.specialty,
      clientOrg: user.clientUser
        ? { id: user.clientUser.clientOrgId, name: user.clientUser.clientOrg.name, role: user.clientUser.clientRole }
        : null,
    };
  }
}
