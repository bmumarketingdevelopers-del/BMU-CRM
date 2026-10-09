import { Module } from '@nestjs/common';
import { ClientWorkspaceService } from './client-workspace.service.js';
import { CreatorsService } from './creators.service.js';
import { TeamWorkspaceService } from './team.service.js';
import { ClientWorkspaceController, CreatorAdminController, CreatorPortalController, TeamWorkspaceController } from './workspace.controller.js';

/** Workspace area: Client 360, calendar, capacity, SOP library, profile & leave, creators, client reports and team users. */
@Module({
  controllers: [TeamWorkspaceController, CreatorAdminController, CreatorPortalController, ClientWorkspaceController],
  providers: [TeamWorkspaceService, CreatorsService, ClientWorkspaceService],
})
export class WorkspaceModule {}
