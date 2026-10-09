import { Global, Module } from '@nestjs/common';
import { ActionsController, ImportsController } from './actions.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { ImportsService } from './imports.service.js';
import { ActionsJobsService } from './jobs.service.js';
import { PaletteService } from './palette.service.js';
import { PeopleDirectory } from './people.js';
import { ReassignService } from './reassign.service.js';
import { RecordsService } from './records.service.js';
import { ActionsRegistry } from './registry.js';
import { TaskAccess } from './tasks/task-access.js';
import { TaskImport } from './tasks/task-import.js';
import { TaskTargets } from './tasks/task-targets.js';
import { TasksActionsController } from './tasks/tasks.controller.js';
import { TasksActionsService } from './tasks/tasks.service.js';
import { UndoService } from './undo.service.js';

/**
 * v11 core: the shared action system. Global, so any module can inject ActionsRegistry (to register reassign targets,
 * approval handlers, import entities, archive entities), ReassignService, ApprovalsService, UndoService,
 * RecordsService and PeopleDirectory. See docs/flows/core-actions.md.
 */
@Global()
@Module({
  controllers: [TasksActionsController, ActionsController, ImportsController],
  providers: [ActionsRegistry, PeopleDirectory, UndoService, ApprovalsService, ReassignService, RecordsService, ImportsService, PaletteService, TaskAccess, TaskTargets, TasksActionsService, TaskImport, ActionsJobsService],
  exports: [ActionsRegistry, PeopleDirectory, UndoService, ApprovalsService, ReassignService, RecordsService, ImportsService, TaskAccess, TasksActionsService],
})
export class ActionsModule {}

