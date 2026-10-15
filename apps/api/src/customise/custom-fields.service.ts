// v14 custom fields: the Founder/Admin add fields to leads, clients, projects, requests and creators; anyone who
// can open a record sees its fields, and anyone who can change the record fills them in.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  CUSTOM_FIELD_ENTITIES,
  customFieldCoerce,
  customFieldInputSchema,
  customFieldKey,
  customFieldUpdateSchema,
  opsCanManageCreators,
  type CustomFieldDefView,
  type CustomFieldEntity,
  type CustomFieldRecordView,
  type CustomFieldType,
  type CustomFieldValues,
  type Me,
} from '@bmu/shared';
import type { CustomFieldDef, Prisma } from '../generated/prisma/client.js';
import { hasRole } from '../actions/people.js';
import { AuditService } from '../audit/audit.service.js';
import { isClientLead, loadClient } from '../clients-actions/clients-access.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FieldAccessService } from '../security/field-access.service.js';
import { readCustomValues } from '../workflows/facts.js';

const TABLE: Record<CustomFieldEntity, string> = { lead: 'leads', client: 'client_orgs', engagement: 'engagements', request: 'requests', creator: 'creators' };
const MAX_PER_ENTITY = 50;

export const isFoundingAdmin = (me: Me) => me.type === 'staff' && hasRole(me, 'founder', 'admin');
const assertStaff = (me: Me) => {
  if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
};
const assertAdmin = (me: Me) => {
  if (!isFoundingAdmin(me)) throw new ForbiddenException('Only the Founder and Branch Managers can change custom fields');
};
export const isCustomEntity = (v: string): v is CustomFieldEntity => (CUSTOM_FIELD_ENTITIES as readonly string[]).includes(v);

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly fieldAccess?: FieldAccessService,
  ) {}

  view(d: CustomFieldDef, used = 0): CustomFieldDefView {
    return {
      id: d.id,
      entity: d.entity as CustomFieldEntity,
      key: d.key,
      label: d.label,
      type: d.type as CustomFieldType,
      options: Array.isArray(d.options) ? (d.options as string[]) : [],
      required: d.required,
      helpText: d.helpText,
      position: d.position,
      archived: !!d.archivedAt,
      used,
    };
  }

  defs(orgId: string, entity: CustomFieldEntity, includeArchived = false) {
    return this.prisma.customFieldDef.findMany({ where: { orgId, entity, ...(includeArchived ? {} : { archivedAt: null }) }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  private async usedCount(orgId: string, entity: CustomFieldEntity, key: string) {
    // Table names come from a fixed map; the key is a validated identifier passed as a parameter.
    const rows = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${TABLE[entity]}" WHERE "orgId" = $1 AND COALESCE("customFields"->>$2, '') <> ''`, orgId, key);
    return Number(rows[0]?.n ?? 0);
  }

  async list(me: Me, entity?: string, archived = false): Promise<CustomFieldDefView[]> {
    assertStaff(me);
    if (entity && !isCustomEntity(entity)) throw new BadRequestException('Unknown record type');
    const rows = await this.prisma.customFieldDef.findMany({ where: { orgId: me.orgId, ...(entity ? { entity } : {}), ...(archived ? {} : { archivedAt: null }) }, orderBy: [{ entity: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] });
    const used = isFoundingAdmin(me) ? await Promise.all(rows.map((r) => this.usedCount(me.orgId, r.entity as CustomFieldEntity, r.key))) : rows.map(() => 0);
    return rows.map((r, i) => this.view(r, used[i]));
  }

  async create(me: Me, raw: unknown, ip?: string) {
    assertAdmin(me);
    const input = parse(customFieldInputSchema, raw);
    const existing = await this.prisma.customFieldDef.findMany({ where: { orgId: me.orgId, entity: input.entity }, select: { key: true, position: true, archivedAt: true } });
    if (existing.filter((e) => !e.archivedAt).length >= MAX_PER_ENTITY) throw new BadRequestException(`Up to ${MAX_PER_ENTITY} custom fields per record type`);
    let key = input.key ?? customFieldKey(input.label);
    if (input.key && existing.some((e) => e.key === key)) throw new BadRequestException(`There is already a field with the key "${key}"`);
    for (let n = 2; existing.some((e) => e.key === key); n++) key = `${customFieldKey(input.label).slice(0, 36)}_${n}`;
    const d = await this.prisma.customFieldDef.create({
      data: { orgId: me.orgId, entity: input.entity, key, label: input.label, type: input.type, options: input.type === 'select' ? input.options : [], required: input.required, helpText: input.helpText ?? null, position: Math.max(0, ...existing.map((e) => e.position + 1)) },
    });
    await this.audit.log(me, 'custom_field.created', 'CustomFieldDef', d.id, undefined, { entity: d.entity, key, label: d.label, type: d.type }, ip);
    return this.view(d);
  }

  async update(me: Me, id: string, raw: unknown, ip?: string) {
    assertAdmin(me);
    const input = parse(customFieldUpdateSchema, raw);
    const before = await this.prisma.customFieldDef.findFirst({ where: { id, orgId: me.orgId } });
    if (!before) throw new NotFoundException('Custom field not found');
    if (input.options && before.type === 'select' && input.options.length < 2) throw new BadRequestException('Add at least two choices');
    const d = await this.prisma.customFieldDef.update({
      where: { id },
      data: {
        label: input.label,
        options: input.options && before.type === 'select' ? input.options : undefined,
        required: input.required,
        helpText: input.helpText === undefined ? undefined : input.helpText,
        position: input.position,
        archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
      },
    });
    this.fieldAccess?.clear(me.orgId);
    await this.audit.log(me, input.archived ? 'custom_field.archived' : 'custom_field.updated', 'CustomFieldDef', id, this.view(before), this.view(d), ip);
    return this.view(d, await this.usedCount(me.orgId, d.entity as CustomFieldEntity, d.key));
  }

  // -------------------------------------------------------------------------
  // Values on a record

  /** Throws when `me` can't see the record; returns whether they may change it. */
  async access(me: Me, entity: CustomFieldEntity, id: string): Promise<{ canEdit: boolean }> {
    assertStaff(me);
    switch (entity) {
      case 'lead': {
        const scope = me.permissions.leads_pipeline?.scope ?? 'none';
        if (scope === 'none') throw new ForbiddenException('Leads are for the sales team');
        const l = await this.prisma.lead.findFirst({ where: { id, orgId: me.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: me.id } : {}) }, select: { id: true } });
        if (!l) throw new NotFoundException('Lead not found');
        return { canEdit: true };
      }
      case 'client': {
        const r = await loadClient(this.prisma, me, id);
        return { canEdit: !r.readOnly };
      }
      case 'engagement': {
        const e = await this.prisma.engagement.findFirst({ where: { ...(await visibleEngagementWhere(this.prisma, me)), id }, select: { id: true, amId: true } });
        if (!e) throw new NotFoundException('Project not found');
        return { canEdit: isClientLead(me) || e.amId === me.id || hasRole(me, 'department_head') };
      }
      case 'request': {
        const r = await this.prisma.request.findFirst({ where: { id, orgId: me.orgId }, select: { assigneeId: true, engagement: { select: { amId: true } } } });
        if (!r) throw new NotFoundException('Request not found');
        if (!isClientLead(me) && r.engagement.amId !== me.id && r.assigneeId !== me.id && !hasRole(me, 'department_head', 'finance')) throw new ForbiddenException("This request belongs to another Client Manager's client");
        return { canEdit: !hasRole(me, 'finance') || isClientLead(me) || r.engagement.amId === me.id || r.assigneeId === me.id };
      }
      case 'creator': {
        const c = await this.prisma.creator.findFirst({ where: { id, orgId: me.orgId }, select: { id: true } });
        if (!c) throw new NotFoundException('Creator not found');
        return { canEdit: opsCanManageCreators(me) };
      }
    }
  }

  async values(me: Me, entity: string, id: string): Promise<CustomFieldRecordView> {
    if (!isCustomEntity(entity)) throw new BadRequestException('Unknown record type');
    const { canEdit } = await this.access(me, entity, id);
    const [defs, values] = await Promise.all([this.defs(me.orgId, entity), readCustomValues(this.prisma, entity, id)]);
    const out: CustomFieldValues = {};
    for (const d of defs) {
      const v = values?.[d.key];
      out[d.key] = v === undefined ? null : (v as CustomFieldValues[string]);
    }
    return { entity, id, canEdit, fields: defs.map((d) => this.view(d)), values: out };
  }

  async setValues(me: Me, entity: string, id: string, incoming: Record<string, unknown>, ip?: string): Promise<CustomFieldRecordView> {
    if (!isCustomEntity(entity)) throw new BadRequestException('Unknown record type');
    const { canEdit } = await this.access(me, entity, id);
    if (!canEdit) throw new ForbiddenException("You can see this record but can't change it");
    const defs = await this.defs(me.orgId, entity);
    const current = (await readCustomValues(this.prisma, entity, id)) ?? {};
    const next: Record<string, unknown> = { ...current };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(incoming)) {
      const def = defs.find((d) => d.key === key);
      if (!def) throw new BadRequestException(`"${key}" is not one of the custom fields`);
      const r = customFieldCoerce(def, raw);
      if ('error' in r) throw new BadRequestException(r.error);
      if (def.required && (r.value === null || r.value === '')) throw new BadRequestException(`${def.label} is required`);
      if ((current[key] ?? null) === r.value) continue;
      before[key] = current[key] ?? null;
      after[key] = r.value;
      next[key] = r.value;
    }
    if (Object.keys(after).length) {
      const data = { customFields: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue };
      if (entity === 'lead') await this.prisma.lead.update({ where: { id }, data });
      else if (entity === 'client') await this.prisma.clientOrg.update({ where: { id }, data });
      else if (entity === 'engagement') await this.prisma.engagement.update({ where: { id }, data });
      else if (entity === 'request') await this.prisma.request.update({ where: { id }, data });
      else await this.prisma.creator.update({ where: { id }, data });
      const auditEntity = { lead: 'Lead', client: 'ClientOrg', engagement: 'Engagement', request: 'Request', creator: 'Creator' }[entity];
      await this.audit.log(me, 'custom_field.values_changed', auditEntity, id, before, after, ip);
    }
    return this.values(me, entity, id);
  }

  /** Prisma filters for `cf.<key>=<value>` list parameters (unknown keys are ignored). */
  async listFilters(orgId: string, entity: CustomFieldEntity, query: Record<string, unknown>): Promise<Prisma.JsonFilter[]> {
    const wanted = Object.entries(query).filter(([k, v]) => k.startsWith('cf.') && typeof v === 'string' && v !== '');
    if (!wanted.length) return [];
    const defs = await this.defs(orgId, entity);
    const out: Prisma.JsonFilter[] = [];
    for (const [k, raw] of wanted) {
      const def = defs.find((d) => d.key === k.slice(3));
      if (!def) continue;
      const value = String(raw);
      if (def.type === 'text' || def.type === 'long_text') out.push({ path: [def.key], string_contains: value });
      else if (def.type === 'checkbox') out.push({ path: [def.key], equals: value === 'yes' || value === 'true' });
      else if (def.type === 'number' || def.type === 'money') {
        if (Number.isFinite(Number(value))) out.push({ path: [def.key], equals: Number(value) });
      } else out.push({ path: [def.key], equals: value });
    }
    return out;
  }
}
