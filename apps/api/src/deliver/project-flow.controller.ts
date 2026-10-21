import { Body, Controller, Get, HttpCode, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { opsUpload, type OpsUpload } from '../ops-actions/ops-util.js';
import { ProjectFlowService } from './project-flow.service.js';

/** v40 project flow: finish dates from Department Heads, and finished parts the client approves. */
@Controller('project-flow')
export class ProjectFlowController {
  constructor(private readonly flow: ProjectFlowService) {}

  @Get('inbox')
  inbox(@CurrentUser() me: Me) {
    return this.flow.inbox(me);
  }

  @Get('client/progress')
  clientProgress(@CurrentUser() me: Me) {
    return this.flow.clientProgress(me);
  }

  @Post('client/milestones/:id/decision')
  @HttpCode(200)
  decide(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.flow.decide(me, id, body, ip);
  }

  @Get('projects/:id')
  view(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.flow.view(me, id);
  }

  @Post('projects/:id/estimates')
  @HttpCode(200)
  request(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.flow.requestEstimates(me, id, body, ip);
  }

  @Post('projects/:id/estimates/share')
  @HttpCode(200)
  share(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.flow.shareEstimates(me, id, body, ip);
  }

  @Post('estimates/:id')
  @HttpCode(200)
  submit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.flow.submitEstimate(me, id, body, ip);
  }

  @Post('projects/:id/milestone-files')
  @UseInterceptors(opsUpload)
  stageFile(@CurrentUser() me: Me, @Param('id') id: string, @UploadedFile() file: OpsUpload | undefined, @ClientIp() ip?: string) {
    return this.flow.stageFile(me, id, file, ip);
  }

  @Post('projects/:id/milestone-links')
  stageLink(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.flow.stageLink(me, id, body, ip);
  }

  @Post('projects/:id/milestones')
  @HttpCode(200)
  shareMilestone(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.flow.shareMilestone(me, id, body, ip);
  }
}
