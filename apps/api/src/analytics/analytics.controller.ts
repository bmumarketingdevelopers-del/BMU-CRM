import { Controller, Get, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { CurrentUser } from '../common/decorators.js';
import { AnalyticsService } from './analytics.service.js';

/** Sales & money analytics. `from`/`to` are ISO dates (default: the last 90 days); each view compares with the previous period. */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('scorecard')
  scorecard(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.scorecard(me, from, to);
  }

  @Get('funnel')
  funnel(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.funnel(me, from, to);
  }

  @Get('forecast')
  forecast(@CurrentUser() me: Me) {
    return this.analytics.forecast(me);
  }

  @Get('retention')
  retention(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.retention(me, from, to);
  }

  @Get('profitability')
  profitability(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.profitability(me, from, to);
  }
}
