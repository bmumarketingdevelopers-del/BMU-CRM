import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { agentAskSchema, agentDecideSchema, agentFeedbackSchema, agentPatchSchema, agentRunNowSchema, type Me } from '@bmu/shared';
import { CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { AgentsService } from './agents.service.js';
import { AgentEvals } from './evals.js';

/** v15 AI agents. Founder/Admin set them up; anyone on the team decides suggestions addressed to them. */
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly evals: AgentEvals,
  ) {}

  @Get()
  overview(@CurrentUser() me: Me) {
    return this.agents.overview(me);
  }

  @Get('runs')
  runs(@CurrentUser() me: Me, @Query('agent') agent?: string, @Query('subjectId') subjectId?: string, @Query('status') status?: string) {
    return this.agents.runs(me, { agent, subjectId, status });
  }

  @Get('runs/:id')
  run(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.agents.run(me, id);
  }

  @Post('runs/:id/undo')
  @HttpCode(200)
  undoRun(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.agents.undoRun(me, id);
  }

  @Post('runs/:id/steps/:stepId/undo')
  @HttpCode(200)
  undoStep(@CurrentUser() me: Me, @Param('id') id: string, @Param('stepId') stepId: string) {
    return this.agents.undoStep(me, id, stepId);
  }

  @Post('runs/:id/feedback')
  @HttpCode(200)
  feedback(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.agents.feedback(me, id, parse(agentFeedbackSchema, body));
  }

  @Get('inbox')
  inbox(@CurrentUser() me: Me, @Query('status') status?: string) {
    return this.agents.inbox(me, status === 'decided' ? 'decided' : 'pending');
  }

  @Post('inbox/:id/decide')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown) {
    return this.agents.decide(me, id, parse(agentDecideSchema, body));
  }

  @Post('analyst/ask')
  @HttpCode(200)
  ask(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.agents.ask(me, parse(agentAskSchema, body).question);
  }

  @Post('evals')
  @HttpCode(200)
  runEvals(@CurrentUser() me: Me) {
    return this.evals.run(me);
  }

  @Post('knowledge/refresh')
  @HttpCode(200)
  refresh(@CurrentUser() me: Me) {
    return this.agents.refreshKnowledge(me);
  }

  @Post('tick')
  @HttpCode(200)
  async tick(@CurrentUser() me: Me) {
    if (!me.roles.some((r) => r === 'founder' || r === 'admin')) return { runs: 0, byAgent: {} };
    return (await this.agents.tick(new Date(), { orgId: me.orgId })) ?? { runs: 0, byAgent: {} };
  }

  @Patch(':key')
  update(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: unknown) {
    return this.agents.update(me, key, parse(agentPatchSchema, body));
  }

  @Post(':key/run')
  @HttpCode(200)
  runNow(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: unknown) {
    return this.agents.runNow(me, key, parse(agentRunNowSchema, body ?? {}).subjectId);
  }
}
