import { Controller, Get, Param, Query } from '@nestjs/common';
import type { FlowGateStrip, FlowJourney, FlowJourneyOption, FlowMap, FlowPulse, Me } from '@bmu/shared';
import { CurrentUser } from '../common/decorators.js';
import { FlowsService } from './flows.service.js';
import { JourneyService } from './journey.service.js';

/** v9 flows: business flow map, project journeys, projects gate strip and the founder pulse. Read-only. */
@Controller('flows')
export class FlowsController {
  constructor(
    private readonly flows: FlowsService,
    private readonly journeys: JourneyService,
  ) {}

  /** Founder, Admin, AM Lead and Department Heads. */
  @Get('map')
  map(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string): Promise<FlowMap> {
    return this.flows.map(me, from, to);
  }

  /** Any staff member, over the engagements they can see. */
  @Get('gate-strip')
  gateStrip(@CurrentUser() me: Me): Promise<FlowGateStrip> {
    if (me.type !== 'staff') return Promise.resolve([]);
    return this.flows.gateStrip(me);
  }

  @Get('journeys')
  journeysList(@CurrentUser() me: Me, @Query('clientId') clientId?: string): Promise<FlowJourneyOption[]> {
    return this.journeys.options(me, clientId);
  }

  /** Staff with access to the client; client users for their own engagements (client-safe events only). */
  @Get('engagements/:id/journey')
  journey(@CurrentUser() me: Me, @Param('id') id: string): Promise<FlowJourney> {
    return this.journeys.journey(me, id);
  }

  /** Founder and Admin only. */
  @Get('pulse')
  pulse(@CurrentUser() me: Me): Promise<FlowPulse> {
    return this.flows.pulse(me);
  }
}
