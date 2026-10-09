// v11 core: generic CSV import. Upload → column mapping → validation preview (with duplicate check) → commit.
// Entities register an ImportEntity in ActionsRegistry (core registers `tasks`). Each run is an ImportJob with rows
// ok/failed and a downloadable error report.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { coreCsvLine, coreParseCsv, type CoreImportEntityInfo, type CoreImportJob, type CoreImportRow, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActionsRegistry, type ImportEntity } from './registry.js';

type StoredRow = CoreImportRow & { cells: string[] };
type JobRow = Awaited<ReturnType<PrismaService['importJob']['findFirstOrThrow']>>;
const MAX_ROWS = 2000;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: ActionsRegistry,
  ) {}

  private entity(me: Me, entity: string): ImportEntity {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const e = this.registry.importEntities.get(entity);
    if (!e) throw new NotFoundException(`Import for "${entity}" isn't available`);
    if (!e.canImport(me)) throw new ForbiddenException(`You can't import ${e.label.toLowerCase()}`);
    return e;
  }

  entities(me: Me): CoreImportEntityInfo[] {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    return [...this.registry.importEntities.values()].filter((e) => e.canImport(me)).map((e) => ({ entity: e.entity, label: e.label, fields: e.fields, sampleCsv: e.sampleCsv }));
  }

  private guessMapping(e: ImportEntity, columns: string[]) {
    const mapping: Record<string, string> = {};
    for (const c of columns) {
      const f = e.fields.find((x) => norm(x.key) === norm(c) || norm(x.label) === norm(c));
      if (f && !Object.values(mapping).includes(f.key)) mapping[c] = f.key;
    }
    return mapping;
  }

  private async evaluate(me: Me, e: ImportEntity, columns: string[], cells: string[][], mapping: Record<string, string>): Promise<StoredRow[]> {
    const values = cells.map((r) => {
      const v: Record<string, string> = {};
      columns.forEach((c, i) => {
        const key = mapping[c];
        if (key) v[key] = (r[i] ?? '').trim();
      });
      return v;
    });
    const missing = e.fields.filter((f) => f.required && !Object.values(mapping).includes(f.key));
    const checks = await e.validate(me, values);
    // Duplicates inside the file itself.
    const seen = new Map<string, number>();
    return values.map((v, i) => {
      const errors = [...missing.map((f) => `Map a column to "${f.label}"`), ...(checks[i]?.errors ?? [])];
      for (const f of e.fields) if (f.required && !missing.includes(f) && !v[f.key]) errors.push(`${f.label} is empty`);
      const sig = JSON.stringify(v);
      let duplicate = checks[i]?.duplicate ?? null;
      if (seen.has(sig)) duplicate = duplicate ?? `Same as row ${seen.get(sig)}`;
      else seen.set(sig, i + 2);
      return { row: i + 2, ok: errors.length === 0, errors, duplicate, values: v, cells: cells[i] };
    });
  }

  private out(job: JobRow, by: string): CoreImportJob {
    const rows = (job.rows as unknown as StoredRow[]).map(({ cells: _c, ...r }) => r);
    const meta = (job.mapping ?? {}) as { columns?: string[]; map?: Record<string, string> };
    return {
      id: job.id,
      entity: job.entity,
      fileName: job.fileName,
      status: job.status as CoreImportJob['status'],
      columns: meta.columns ?? [],
      mapping: meta.map ?? {},
      rowsTotal: job.rowsTotal,
      rowsOk: job.rowsOk,
      rowsFailed: job.rowsFailed,
      rows,
      createdAt: job.createdAt.toISOString(),
      committedAt: job.committedAt?.toISOString() ?? null,
      by,
    };
  }

  private async byName(id: string) {
    return (await this.prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? '';
  }

  async preview(me: Me, entity: string, input: { csv: string; fileName?: string; mapping?: Record<string, string> }) {
    const e = this.entity(me, entity);
    const table = coreParseCsv(input.csv);
    if (table.length < 2) throw new BadRequestException('The file needs a header row and at least one row of data');
    const columns = table[0].map((c, i) => c.trim() || `Column ${i + 1}`);
    const cells = table.slice(1);
    if (cells.length > MAX_ROWS) throw new BadRequestException(`Import up to ${MAX_ROWS} rows at a time`);
    const mapping = input.mapping ?? this.guessMapping(e, columns);
    const rows = await this.evaluate(me, e, columns, cells, mapping);
    const job = await this.prisma.importJob.create({
      data: {
        orgId: me.orgId,
        entity,
        fileName: input.fileName ?? null,
        mapping: { columns, map: mapping },
        rows: JSON.parse(JSON.stringify(rows)),
        rowsTotal: rows.length,
        rowsOk: rows.filter((r) => r.ok).length,
        rowsFailed: rows.filter((r) => !r.ok).length,
        byId: me.id,
      },
    });
    return this.out(job, me.name);
  }

  private async job(me: Me, id: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, orgId: me.orgId } });
    if (!job) throw new NotFoundException('Import not found');
    if (job.byId !== me.id && !me.roles.some((r) => ['founder', 'admin'].includes(r))) throw new ForbiddenException('This import belongs to someone else');
    return job;
  }

  async remap(me: Me, id: string, mapping: Record<string, string>) {
    const job = await this.job(me, id);
    if (job.status !== 'preview') throw new BadRequestException('This import is already done');
    const e = this.entity(me, job.entity);
    const meta = job.mapping as { columns: string[] };
    const cells = (job.rows as unknown as StoredRow[]).map((r) => r.cells);
    const rows = await this.evaluate(me, e, meta.columns, cells, mapping);
    const updated = await this.prisma.importJob.update({
      where: { id },
      data: { mapping: { columns: meta.columns, map: mapping }, rows: JSON.parse(JSON.stringify(rows)), rowsOk: rows.filter((r) => r.ok).length, rowsFailed: rows.filter((r) => !r.ok).length },
    });
    return this.out(updated, await this.byName(job.byId));
  }

  async commit(me: Me, id: string, skipDuplicates: boolean, ip?: string) {
    const job = await this.job(me, id);
    if (job.status !== 'preview') throw new BadRequestException('This import is already done');
    const e = this.entity(me, job.entity);
    const meta = job.mapping as { columns: string[]; map: Record<string, string> };
    // Validate again: data may have changed since the preview.
    const rows = await this.evaluate(me, e, meta.columns, (job.rows as unknown as StoredRow[]).map((r) => r.cells), meta.map);
    const take = rows.filter((r) => r.ok && !(skipDuplicates && r.duplicate));
    if (!take.length) throw new BadRequestException('No rows are ready to import. Fix the errors in the file and upload it again.');
    const claimed = await this.prisma.importJob.updateMany({ where: { id, status: 'preview' }, data: { status: 'committed', committedAt: new Date() } });
    if (!claimed.count) throw new BadRequestException('This import is already done');
    let ids: string[] = [];
    try {
      ids = await e.commit(me, take.map((r) => r.values), ip);
    } catch (err) {
      await this.prisma.importJob.update({ where: { id }, data: { status: 'preview', committedAt: null } });
      throw err;
    }
    for (const r of rows) if (r.ok && skipDuplicates && r.duplicate) r.errors.push(`Skipped: possible duplicate (${r.duplicate})`);
    const failed = rows.filter((r) => !take.includes(r));
    const updated = await this.prisma.importJob.update({
      where: { id },
      data: {
        rows: JSON.parse(JSON.stringify(rows.map((r) => ({ ...r, ok: take.includes(r) })))),
        rowsOk: take.length,
        rowsFailed: failed.length,
        createdIds: ids,
        errors: failed.map((r) => ({ row: r.row, message: r.errors.join('; ') })),
      },
    });
    await this.audit.log(me, 'import.committed', 'ImportJob', id, null, { entity: job.entity, rowsOk: take.length, rowsFailed: failed.length, fileName: job.fileName }, ip);
    return this.out(updated, await this.byName(job.byId));
  }

  async jobs(me: Me, entity?: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const admin = me.roles.some((r) => ['founder', 'admin'].includes(r));
    const rows = await this.prisma.importJob.findMany({ where: { orgId: me.orgId, ...(entity ? { entity } : {}), ...(admin ? {} : { byId: me.id }) }, orderBy: { createdAt: 'desc' }, take: 30 });
    const names = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.byId))] } }, select: { id: true, name: true } });
    return rows.map((r) => ({ ...this.out(r, names.find((n) => n.id === r.byId)?.name ?? ''), rows: [] }));
  }

  async get(me: Me, id: string) {
    const job = await this.job(me, id);
    return this.out(job, await this.byName(job.byId));
  }

  /** CSV of the rows that failed or were skipped, with the reason, for fixing and re-uploading. */
  async errorReport(me: Me, id: string) {
    const job = await this.job(me, id);
    const meta = job.mapping as { columns: string[] };
    const rows = (job.rows as unknown as StoredRow[]).filter((r) => !r.ok || r.errors.length);
    return [coreCsvLine(['Row', 'Problem', ...meta.columns]), ...rows.map((r) => coreCsvLine([r.row, r.errors.join('; ') || r.duplicate || '', ...r.cells]))].join('\n') + '\n';
  }
}
