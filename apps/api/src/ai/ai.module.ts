import { Global, Module } from '@nestjs/common';
import { AI_CLIENT, AnthropicAiClient } from './ai-client.js';
import { AiCopilotService } from './ai-copilot.js';
import { AiDigestService } from './ai-digest.js';
import { AiFeaturesService } from './ai-features.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';

/** v10 AI Copilot: Ask BMU, drafting features, weekly digest, tone flags and the automation "AI draft" action. */
@Global()
@Module({
  controllers: [AiController],
  providers: [AiService, AiCopilotService, AiFeaturesService, AiDigestService, { provide: AI_CLIENT, useClass: AnthropicAiClient }],
  exports: [AiService, AiDigestService, AiCopilotService],
})
export class AiModule {}
