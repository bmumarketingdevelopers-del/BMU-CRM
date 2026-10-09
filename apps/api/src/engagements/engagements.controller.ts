import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { planContentSchema, updateRequirementSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { EngagementsService } from './engagements.service.js';

const addRequirementSchema = z.object({ label: z.string().trim().min(2), type: z.enum(['info', 'asset', 'access', 'payment']) });

@Controller('engagements')
export class EngagementsController {
  constructor(private readonly engagements: EngagementsService) {}

  @Get()
  list(@CurrentUser() me: Me) {
    return this.engagements.list(me);
  }

  @Get(':id')
  detail(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.engagements.detail(me, id);
  }

  @Patch('requirements/:itemId')
  updateRequirement(@CurrentUser() me: Me, @Param('itemId') itemId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.engagements.updateRequirement(me, itemId, parse(updateRequirementSchema, body), ip);
  }

  @Post(':id/requirements')
  addRequirement(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { label, type } = parse(addRequirementSchema, body);
    return this.engagements.addRequirement(me, id, label, type, ip);
  }

  @Post(':id/rcd')
  @HttpCode(200)
  markRcd(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.engagements.markRcd(me, id, ip);
  }

  @Put(':id/plan')
  savePlan(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.engagements.savePlan(me, id, parse(planContentSchema, body), ip);
  }

  @Post(':id/plan/submit')
  @HttpCode(200)
  submitPlan(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.engagements.submitPlan(me, id, ip);
  }

  @Post(':id/plan/send')
  @HttpCode(200)
  sendPlan(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.engagements.sendPlan(me, id, ip);
  }
}
