import { Module } from '@nestjs/common';
import { WorkflowEngine } from './engine.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

/** v14 workflows: builder, versions, the engine (waits, branches, approvals) and the run log. */
@Module({ controllers: [WorkflowsController], providers: [WorkflowsService, WorkflowEngine], exports: [WorkflowEngine] })
export class WorkflowsModule {}
