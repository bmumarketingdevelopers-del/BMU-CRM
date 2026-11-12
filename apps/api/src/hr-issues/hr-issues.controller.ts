import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { hrIssueSchema, hrIssueUpdateSchema, type Me } from '@bmu/shared';
import { CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { HrIssuesService } from './hr-issues.service.js';

/** v50 Raise an issue with HR (see HrIssuesService). */
@Controller('hr-issues')
export class HrIssuesController {
  constructor(private readonly issues: HrIssuesService) {}

  @Post()
  raise(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.issues.raise(me, parse(hrIssueSchema, body));
  }

  @Get('mine')
  mine(@CurrentUser() me: Me) {
    return this.issues.mine(me);
  }

  @Get()
  inbox(@CurrentUser() me: Me, @Query('status') status?: string) {
    return this.issues.inbox(me, status);
  }

  @Patch(':id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.issues.update(me, id, parse(hrIssueUpdateSchema, body));
  }
}
