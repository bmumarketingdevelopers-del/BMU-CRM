import { Module } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AssetsController, ClientAssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { CreativeClientController, CreativeController } from './creative.controller.js';
import { CreativeService } from './creative.service.js';
import { ProofingService } from './proofing.service.js';

/** v16 creative studio: asset library, proofing rounds and certificates, one-tap approval links, channels and post results. */
@Module({
  controllers: [AssetsController, ClientAssetsController, CreativeController, CreativeClientController],
  providers: [AssetsService, ProofingService, CreativeService, NotificationsService],
  exports: [AssetsService, ProofingService],
})
export class CreativeModule {}
