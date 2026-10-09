import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { FEATURE_FLAG_KEYS, featureFlagUpdateSchema, livePresenceSchema, type FeatureFlagKey, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { EventsService } from './events.service.js';
import { FlagsService } from './flags.service.js';
import { RealtimeService } from './realtime.service.js';
import { assertSystemAdmin, SystemService } from './system.service.js';

/** v13 live updates: GET /realtime/stream (server-sent events) and presence heartbeats. */
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('stream')
  async stream(@CurrentUser() me: Me, @Res() res: Response) {
    await this.realtime.open(me, res);
  }

  @Post('presence')
  presence(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.realtime.presence(me, parse(livePresenceSchema, body));
  }
}

/** v13 System health and feature flags. */
@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly flags: FlagsService,
    private readonly events: EventsService,
  ) {}

  /** The flags as they apply to the signed-in person. */
  @Get('flags')
  myFlags(@CurrentUser() me: Me) {
    return this.flags.forMe(me);
  }

  @Get('flags/all')
  allFlags(@CurrentUser() me: Me) {
    assertSystemAdmin(me);
    return this.flags.rows(me.orgId);
  }

  @Patch('flags/:key')
  setFlag(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: unknown, @ClientIp() ip?: string) {
    if (!(FEATURE_FLAG_KEYS as string[]).includes(key)) throw new NotFoundException('No such feature flag');
    return this.flags.set(me, key as FeatureFlagKey, parse(featureFlagUpdateSchema, body), ip);
  }

  @Get('health')
  health(@CurrentUser() me: Me) {
    return this.system.health(me);
  }

  @Post('events/failures/:id/retry')
  retry(@CurrentUser() me: Me, @Param('id') id: string) {
    assertSystemAdmin(me);
    return this.events.attempt(id, me.orgId);
  }

  @Post('events/failures/:id/dismiss')
  dismiss(@CurrentUser() me: Me, @Param('id') id: string) {
    assertSystemAdmin(me);
    return this.events.dismiss(me.orgId, id);
  }

  @Post('search/rebuild')
  rebuild(@CurrentUser() me: Me) {
    return this.system.rebuildSearch(me);
  }
}
