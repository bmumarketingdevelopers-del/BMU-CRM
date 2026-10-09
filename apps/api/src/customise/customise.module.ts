import { Global, Module } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomiseController } from './customise.controller.js';
import { FormsService } from './forms.service.js';
import { PipelinesService } from './pipelines.service.js';

/** v14 no-code customisation. Global so leads and dashboards can use custom-field filters and pipeline rules. */
@Global()
@Module({ controllers: [CustomiseController], providers: [CustomFieldsService, FormsService, PipelinesService], exports: [CustomFieldsService, PipelinesService] })
export class CustomiseModule {}
