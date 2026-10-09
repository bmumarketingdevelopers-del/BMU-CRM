import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { cloneRoleSchema, inviteUserSchema, setPermissionSchema, updateUserSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser, RequireCapability } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { OrgService } from './org.service.js';

@Controller('org')
@RequireCapability('users_roles_hierarchy')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('tree')
  tree(@CurrentUser() me: Me) {
    return this.org.tree(me);
  }

  @Get('users')
  users(@CurrentUser() me: Me) {
    return this.org.users(me);
  }

  @Post('users')
  invite(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.org.invite(me, parse(inviteUserSchema, body), ip);
  }

  @Patch('users/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.org.updateUser(me, id, parse(updateUserSchema, body), ip);
  }

  @Get('roles')
  roles(@CurrentUser() me: Me) {
    return this.org.roles(me);
  }

  @Patch('roles/:id/permissions')
  setPermission(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { capability, scope } = parse(setPermissionSchema, body);
    return this.org.setPermission(me, id, capability, scope, ip);
  }

  @Post('roles/:id/clone')
  clone(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.org.cloneRole(me, id, parse(cloneRoleSchema, body).name, ip);
  }
}
