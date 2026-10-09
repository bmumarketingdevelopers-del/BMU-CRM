import { Module } from '@nestjs/common';
import { TeamFlowsModule } from '../team-flows/team-flows.module.js';
import { OffboardingService } from './offboarding.service.js';
import { PeopleActionsController } from './people-actions.controller.js';
import { PeopleActionsService } from './people-actions.service.js';
import { PersonImport } from './person-import.js';

/**
 * v11 people & hierarchy actions: add / edit / move / change role / offboard people, branches, departments, teams,
 * client pods, custom roles, the hierarchy tree and CSV import of people. Builds on the shared action system
 * (ActionsModule is global) and the v10 onboarding/offboarding checklists (TeamFlowsModule).
 */
@Module({ imports: [TeamFlowsModule], controllers: [PeopleActionsController], providers: [PeopleActionsService, OffboardingService, PersonImport] })
export class PeopleActionsModule {}
