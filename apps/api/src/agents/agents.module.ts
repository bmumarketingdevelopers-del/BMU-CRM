import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { AgentEvals } from './evals.js';
import { KnowledgeService } from './knowledge.service.js';
import { AgentRuntime } from './runtime.js';

/** v15 AI agents: runtime with approval policy, knowledge search, the four agents, Agent Inbox, run log and evals. */
@Module({ controllers: [AgentsController], providers: [AgentsService, AgentRuntime, KnowledgeService, AgentEvals], exports: [AgentsService, KnowledgeService] })
export class AgentsModule {}
