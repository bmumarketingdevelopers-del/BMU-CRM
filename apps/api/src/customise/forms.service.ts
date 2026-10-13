// v14 forms: built in the Command Centre, shared as a link (/f/<slug>) or embedded on a website. Each submission
// creates a lead (duplicate-checked, scored, first-reply timer) and starts any "A website form is filled in" workflows.
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  customFieldCoerce,
  formInputSchema,
  formSubmitSchema,
  rupeesToPaise,
  services as catalogue,
  type FormDetail,
  type FormField,
  type FormPublic,
  type FormRow,
  type FormSubmissionRow,
  type FormSubmitResult,
  type Me,
} from '@bmu/shared';
import type { FormDef, Prisma } from '../generated/prisma/client.js';
import { hasRole } from '../actions/people.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { createInboundLead } from '../leads/inbound-lead.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Submissions allowed from one address per form in 10 minutes. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const canManageForms = (me: Me) => me.type === 'staff' && hasRole(me, 'founder', 'admin', 'sales_manager');
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'form';

@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private assertManage(me: Me) {
    if (!canManageForms(me)) throw new ForbiddenException('Forms are managed by the Founder, Branch Managers and sales managers');
  }

  private fields = (f: FormDef) => (Array.isArray(f.fields) ? (f.fields as FormField[]) : []);

  private async row(f: FormDef): Promise<FormRow> {
    const last = await this.prisma.formSubmission.findFirst({ where: { formId: f.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return { id: f.id, slug: f.slug, name: f.name, title: f.title, enabled: f.enabled, submitCount: f.submitCount, lastSubmissionAt: last?.createdAt.toISOString() ?? null, createdAt: f.createdAt.toISOString(), fieldCount: this.fields(f).length };
  }

  private async detail(f: FormDef): Promise<FormDetail> {
    return { ...(await this.row(f)), intro: f.intro, fields: this.fields(f), submitLabel: f.submitLabel, successMessage: f.successMessage, serviceIds: f.serviceIds, publicPath: `/f/${f.slug}` };
  }

  private async find(me: Me, id: string) {
    const f = await this.prisma.formDef.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!f) throw new NotFoundException('Form not found');
    return f;
  }

  async list(me: Me): Promise<FormRow[]> {
    this.assertManage(me);
    const rows = await this.prisma.formDef.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map((r) => this.row(r)));
  }

  async get(me: Me, id: string) {
    this.assertManage(me);
    return this.detail(await this.find(me, id));
  }

  private async validate(me: Me, raw: unknown) {
    const input = parse(formInputSchema, raw);
    const keys = input.fields.map((f) => f.customFieldKey).filter((k): k is string => !!k);
    if (keys.length) {
      const defs = await this.prisma.customFieldDef.findMany({ where: { orgId: me.orgId, entity: 'lead', archivedAt: null, key: { in: keys } }, select: { key: true } });
      const missing = keys.find((k) => !defs.some((d) => d.key === k));
      if (missing) throw new BadRequestException(`The lead field "${missing}" does not exist`);
    }
    const unknownService = input.serviceIds.find((s) => !catalogue.some((c) => c.id === s));
    if (unknownService) throw new BadRequestException('Pick services from the catalogue');
    return input;
  }

  private async freeSlug(base: string, exceptId?: string) {
    let slug = slugify(base);
    if (slug.length < 3) slug = `${slug}-form`;
    for (let n = 2; ; n++) {
      const taken = await this.prisma.formDef.findUnique({ where: { slug }, select: { id: true } });
      if (!taken || taken.id === exceptId) return slug;
      slug = `${slugify(base).slice(0, 44)}-${n}`;
    }
  }

  async create(me: Me, raw: unknown, ip?: string) {
    this.assertManage(me);
    const input = await this.validate(me, raw);
    if (input.slug && (await this.prisma.formDef.findUnique({ where: { slug: input.slug } }))) throw new BadRequestException('That web address is taken. Try another.');
    const f = await this.prisma.formDef.create({
      data: {
        orgId: me.orgId,
        slug: input.slug ?? (await this.freeSlug(input.name)),
        name: input.name,
        title: input.title,
        intro: input.intro ?? null,
        fields: input.fields as unknown as Prisma.InputJsonValue,
        submitLabel: input.submitLabel,
        successMessage: input.successMessage,
        serviceIds: input.serviceIds,
        enabled: input.enabled,
        createdById: me.id,
      },
    });
    await this.audit.log(me, 'form.created', 'FormDef', f.id, undefined, { name: f.name, slug: f.slug }, ip);
    return this.detail(f);
  }

  async update(me: Me, id: string, raw: unknown, ip?: string) {
    this.assertManage(me);
    const before = await this.find(me, id);
    const input = await this.validate(me, raw);
    if (input.slug && input.slug !== before.slug) {
      const taken = await this.prisma.formDef.findUnique({ where: { slug: input.slug } });
      if (taken) throw new BadRequestException('That web address is taken. Try another.');
    }
    const f = await this.prisma.formDef.update({
      where: { id },
      data: { slug: input.slug ?? before.slug, name: input.name, title: input.title, intro: input.intro ?? null, fields: input.fields as unknown as Prisma.InputJsonValue, submitLabel: input.submitLabel, successMessage: input.successMessage, serviceIds: input.serviceIds, enabled: input.enabled },
    });
    await this.audit.log(me, 'form.updated', 'FormDef', id, { name: before.name, slug: before.slug, enabled: before.enabled }, { name: f.name, slug: f.slug, enabled: f.enabled }, ip);
    return this.detail(f);
  }

  async remove(me: Me, id: string, ip?: string) {
    this.assertManage(me);
    const f = await this.find(me, id);
    // Free the address so it can be reused, keep the submissions for the leads they created.
    await this.prisma.formDef.update({ where: { id }, data: { deletedAt: new Date(), enabled: false, slug: `${f.slug}--deleted-${Date.now().toString(36)}` } });
    await this.audit.log(me, 'form.deleted', 'FormDef', id, { name: f.name, slug: f.slug }, undefined, ip);
    return { ok: true as const };
  }

  async submissions(me: Me, id: string): Promise<FormSubmissionRow[]> {
    this.assertManage(me);
    const f = await this.find(me, id);
    const rows = await this.prisma.formSubmission.findMany({ where: { formId: f.id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const leads = await this.prisma.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter((x): x is string => !!x) } }, select: { id: true, contact: true } });
    const fields = this.fields(f);
    return rows.map((r) => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const l = leads.find((x) => x.id === r.leadId);
      const c = (l?.contact ?? {}) as { name?: string; company?: string };
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        lead: l ? { id: l.id, name: c.company || c.name || 'Lead' } : null,
        answers: fields.filter((q) => data[q.id] !== undefined && data[q.id] !== '' && data[q.id] !== null).map((q) => ({ label: q.label, value: show(data[q.id], q) })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Public

  private async publicRow(slug: string) {
    const f = await this.prisma.formDef.findUnique({ where: { slug } });
    if (!f || f.deletedAt || !f.enabled) throw new NotFoundException('This form is not available');
    return f;
  }

  async publicForm(slug: string): Promise<FormPublic> {
    const f = await this.publicRow(slug);
    const allowed = f.serviceIds.length ? catalogue.filter((s) => f.serviceIds.includes(s.id)) : catalogue;
    return {
      slug: f.slug,
      title: f.title,
      intro: f.intro,
      fields: this.fields(f).map(({ customFieldKey: _k, ...q }) => q),
      submitLabel: f.submitLabel,
      services: this.fields(f).some((q) => q.type === 'services') ? allowed.map((s) => ({ id: s.id, name: s.name })) : [],
    };
  }

  async submit(slug: string, raw: unknown, ip?: string): Promise<FormSubmitResult> {
    const f = await this.publicRow(slug);
    const body = parse(formSubmitSchema, raw);
    // The hidden "website" box is a trap for bots: pretend it worked and keep nothing.
    if (body.website) return { ok: true, message: f.successMessage };
    const ipHash = ip ? createHash('sha256').update(`${f.orgId}:${ip}`).digest('hex').slice(0, 32) : null;
    if (ipHash) {
      const recent = await this.prisma.formSubmission.count({ where: { formId: f.id, ipHash, createdAt: { gte: new Date(Date.now() - RATE_WINDOW_MS) } } });
      if (recent >= RATE_LIMIT) throw new HttpException('Too many submissions from this connection. Please try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const fields = this.fields(f);
    const answers: Record<string, unknown> = {};
    const lead = { name: null as string | null, email: null as string | null, phone: null as string | null, company: null as string | null, budgetPaise: null as number | null, serviceIds: [] as string[], message: '' };
    const extras: string[] = [];
    const custom: Record<string, unknown> = {};
    const defs = await this.prisma.customFieldDef.findMany({ where: { orgId: f.orgId, entity: 'lead', archivedAt: null } });
    const allowedServices = f.serviceIds.length ? f.serviceIds : catalogue.map((s) => s.id);
    for (const q of fields) {
      const raw = body.answers[q.id];
      const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length) || raw === false;
      if (empty) {
        if (q.required) throw new BadRequestException(`Please fill in "${q.label}"`);
        continue;
      }
      const str = Array.isArray(raw) ? '' : String(raw).trim();
      switch (q.type) {
        case 'name':
          lead.name = str.slice(0, 120);
          break;
        case 'company':
          lead.company = str.slice(0, 160);
          break;
        case 'email':
          if (!EMAIL.test(str) || str.length > 200) throw new BadRequestException('Please enter a valid email address');
          lead.email = str.toLowerCase();
          break;
        case 'phone': {
          const digits = str.replace(/[^\d+]/g, '');
          if (digits.replace('+', '').length < 10 || digits.length > 16) throw new BadRequestException('Please enter a valid phone number');
          lead.phone = digits;
          break;
        }
        case 'budget': {
          const n = Number(str.replace(/[₹,\s]/g, ''));
          if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new BadRequestException('Please enter your budget as a number');
          lead.budgetPaise = rupeesToPaise(n);
          break;
        }
        case 'services': {
          const list = (Array.isArray(raw) ? raw : [str]).map(String).filter((s) => allowedServices.includes(s));
          lead.serviceIds = [...new Set(list)].slice(0, 10);
          break;
        }
        case 'message':
          lead.message = str.slice(0, 4000);
          break;
        default: {
          let value: unknown = str;
          if (q.type === 'select' && !(q.options ?? []).includes(str)) throw new BadRequestException(`Please pick one of the choices for "${q.label}"`);
          if (q.type === 'number' && !Number.isFinite(Number(str))) throw new BadRequestException(`"${q.label}" must be a number`);
          if (q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new BadRequestException(`"${q.label}" must be a date`);
          if (q.type === 'checkbox') value = true;
          const def = q.customFieldKey ? defs.find((d) => d.key === q.customFieldKey) : undefined;
          const coerced = def ? customFieldCoerce(def, value) : null;
          if (def && coerced && 'value' in coerced) custom[def.key] = coerced.value;
          else extras.push(`${q.label}: ${q.type === 'checkbox' ? 'Yes' : str}`);
          value = q.type === 'checkbox' ? true : str;
          answers[q.id] = value;
          continue;
        }
      }
      answers[q.id] = Array.isArray(raw) ? raw : str;
    }
    if (!lead.email && !lead.phone) throw new BadRequestException('Please give an email or a phone number so we can reply');
    if (!lead.name && !lead.company) throw new BadRequestException('Please tell us your name');
    const need = [lead.message || `Enquiry from the form "${f.name}"`, ...extras].join('\n').slice(0, 4000);
    const created = await createInboundLead(
      { prisma: this.prisma, audit: this.audit, notifications: this.notifications },
      { orgId: f.orgId, source: 'form', name: lead.name, email: lead.email, phone: lead.phone, company: lead.company, need, budgetPaise: lead.budgetPaise, serviceIds: lead.serviceIds.length ? lead.serviceIds : f.serviceIds.slice(0, 1), customFields: custom, via: `Form "${f.name}"` },
    );
    await this.prisma.formSubmission.create({ data: { orgId: f.orgId, formId: f.id, leadId: created.id, data: JSON.parse(JSON.stringify(answers)), ipHash, pageUrl: body.pageUrl?.slice(0, 500) ?? null } });
    await this.prisma.formDef.update({ where: { id: f.id }, data: { submitCount: { increment: 1 } } });
    await this.audit.logSystem(f.orgId, 'form.submitted', 'Lead', created.id, { formId: f.id, form: f.name });
    return { ok: true, message: f.successMessage };
  }
}

function show(v: unknown, q: FormField): string {
  if (q.type === 'services' && Array.isArray(v)) return v.map((id) => catalogue.find((s) => s.id === id)?.name ?? String(id)).join(', ');
  if (q.type === 'checkbox') return v ? 'Yes' : 'No';
  if (q.type === 'budget') return `₹${Number(v).toLocaleString('en-IN')}`;
  return Array.isArray(v) ? v.join(', ') : String(v);
}
