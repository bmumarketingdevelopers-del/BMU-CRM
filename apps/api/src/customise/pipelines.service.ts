// v14 pipeline settings: per-organisation names, order, hidden stages, required fields and time targets for lead
// stages, project phases and request statuses. The underlying keys never change, so reports and rules keep working.
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  PIPELINE_KINDS,
  PIPELINE_LEAD_REQUIRED,
  pipelineKeys,
  pipelineLabelMap,
  pipelineLeadRequiredLabels,
  pipelineLockedStages,
  pipelineMerge,
  pipelineUpdateSchema,
  type Me,
  type PipelineConfigView,
  type PipelineKind,
  type PipelineStage,
  type PipelinesView,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isFoundingAdmin } from './custom-fields.service.js';
import { eventBus } from '../platform/event-bus.js';

const CACHE_MS = 10_000;

@Injectable()
export class PipelinesService {
  private cache = new Map<string, { at: number; stages: PipelineStage[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    // v21: changes made by any backend process take effect at once.
    eventBus.watch(['PipelineConfig', 'CustomFieldDef'], () => this.cache.clear());
  }

  /** The merged stages for an org (cached briefly; saving clears the cache). */
  async stages(orgId: string, kind: PipelineKind): Promise<PipelineStage[]> {
    const key = `${orgId}:${kind}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.stages;
    const row = await this.prisma.pipelineConfig.findUnique({ where: { orgId_kind: { orgId, kind } } });
    const stages = pipelineMerge(kind, row?.stages);
    this.cache.set(key, { at: Date.now(), stages });
    return stages;
  }

  private async view(orgId: string, kind: PipelineKind): Promise<PipelineConfigView> {
    const row = await this.prisma.pipelineConfig.findUnique({ where: { orgId_kind: { orgId, kind } } });
    const by = row?.updatedById ? await this.prisma.user.findUnique({ where: { id: row.updatedById }, select: { name: true } }) : null;
    return { kind, stages: pipelineMerge(kind, row?.stages), customised: !!row, updatedAt: row?.updatedAt.toISOString() ?? null, updatedBy: by?.name ?? null };
  }

  async all(me: Me): Promise<PipelinesView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const [pipelines, fields] = await Promise.all([
      Promise.all(PIPELINE_KINDS.map((k) => this.view(me.orgId, k))),
      this.prisma.customFieldDef.findMany({ where: { orgId: me.orgId, entity: 'lead', archivedAt: null }, select: { key: true, label: true }, orderBy: { position: 'asc' } }),
    ]);
    return { canEdit: isFoundingAdmin(me), pipelines, leadCustomFields: fields };
  }

  async update(me: Me, kind: string, raw: unknown, ip?: string): Promise<PipelineConfigView> {
    if (!isFoundingAdmin(me)) throw new ForbiddenException('Only the Founder and Admins can change pipelines');
    if (!(PIPELINE_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('Unknown pipeline');
    const k = kind as PipelineKind;
    const input = parse(pipelineUpdateSchema, raw);
    const keys = pipelineKeys(k);
    const seen = new Set<string>();
    const leadFields = k === 'lead' ? (await this.prisma.customFieldDef.findMany({ where: { orgId: me.orgId, entity: 'lead', archivedAt: null }, select: { key: true } })).map((f) => `custom.${f.key}`) : [];
    for (const s of input.stages) {
      if (!keys.includes(s.key)) throw new BadRequestException(`"${s.key}" is not a ${k} stage`);
      if (seen.has(s.key)) throw new BadRequestException(`"${s.label}" is listed twice`);
      seen.add(s.key);
      if (s.hidden && pipelineLockedStages(k).includes(s.key)) throw new BadRequestException(`"${s.label}" can't be hidden`);
      for (const f of s.requiredFields) {
        if (k !== 'lead') throw new BadRequestException('Required fields are only for lead stages');
        if (!(PIPELINE_LEAD_REQUIRED as readonly string[]).includes(f) && !leadFields.includes(f)) throw new BadRequestException(`"${f}" is not a lead field`);
      }
    }
    if (input.stages.every((s) => s.hidden)) throw new BadRequestException('Keep at least one stage visible');
    const before = await this.view(me.orgId, k);
    const stages = pipelineMerge(k, input.stages);
    await this.prisma.pipelineConfig.upsert({ where: { orgId_kind: { orgId: me.orgId, kind: k } }, create: { orgId: me.orgId, kind: k, stages: JSON.parse(JSON.stringify(stages)), updatedById: me.id }, update: { stages: JSON.parse(JSON.stringify(stages)), updatedById: me.id } });
    this.cache.delete(`${me.orgId}:${k}`);
    await this.audit.log(me, 'pipeline.updated', 'PipelineConfig', k, { stages: before.stages }, { stages }, ip);
    return this.view(me.orgId, k);
  }

  async reset(me: Me, kind: string, ip?: string): Promise<PipelineConfigView> {
    if (!isFoundingAdmin(me)) throw new ForbiddenException('Only the Founder and Admins can change pipelines');
    if (!(PIPELINE_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('Unknown pipeline');
    await this.prisma.pipelineConfig.deleteMany({ where: { orgId: me.orgId, kind } });
    this.cache.delete(`${me.orgId}:${kind}`);
    await this.audit.log(me, 'pipeline.reset', 'PipelineConfig', kind, undefined, undefined, ip);
    return this.view(me.orgId, kind as PipelineKind);
  }

  /** Throws a plain-English error when a lead is missing fields its new stage requires. */
  async assertLeadCanEnter(orgId: string, leadId: string, stage: string) {
    const missing = await this.leadMissing(orgId, leadId, stage);
    if (missing.length) {
      const label = pipelineLabelMap(await this.stages(orgId, 'lead'))[stage] ?? stage;
      throw new BadRequestException(`Before moving to ${label}, fill in: ${missing.join(', ')}`);
    }
  }

  async leadMissing(orgId: string, leadId: string, stage: string): Promise<string[]> {
    const s = (await this.stages(orgId, 'lead')).find((x) => x.key === stage);
    if (!s?.requiredFields.length) return [];
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { ownerId: true, contact: true, budgetPaise: true, serviceIds: true, nextFollowUpAt: true, customFields: true } });
    if (!lead) return [];
    const c = (lead.contact ?? {}) as { email?: string; phone?: string; company?: string };
    const cf = (lead.customFields ?? {}) as Record<string, unknown>;
    const defs = s.requiredFields.some((f) => f.startsWith('custom.')) ? await this.prisma.customFieldDef.findMany({ where: { orgId, entity: 'lead' }, select: { key: true, label: true } }) : [];
    const missing: string[] = [];
    for (const f of s.requiredFields) {
      const filled =
        f === 'owner'
          ? !!lead.ownerId
          : f === 'email'
            ? !!c.email
            : f === 'phone'
              ? !!c.phone
              : f === 'company'
                ? !!c.company
                : f === 'budget'
                  ? !!lead.budgetPaise
                  : f === 'services'
                    ? lead.serviceIds.length > 0
                    : f === 'follow_up'
                      ? !!lead.nextFollowUpAt
                      : f.startsWith('custom.')
                        ? cf[f.slice(7)] !== undefined && cf[f.slice(7)] !== null && cf[f.slice(7)] !== ''
                        : true;
      if (!filled) missing.push(f.startsWith('custom.') ? (defs.find((d) => d.key === f.slice(7))?.label ?? f.slice(7)) : (pipelineLeadRequiredLabels[f as keyof typeof pipelineLeadRequiredLabels] ?? f));
    }
    return missing;
  }
}
