import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readdirSync } from 'node:fs';
import { APP_VERSION, type Health } from '@bmu/shared';
import { Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { processRole } from '../runtime/process-role.js';

/**
 * Health checks for people and for load balancers, Docker and Kubernetes:
 * - GET /health        status summary (always 200; `database` says up or down).
 * - GET /health/live   the process is running (200). Use it as the liveness probe.
 * - GET /health/ready  the process can serve: database reachable and every migration applied (200, else 503).
 *                      Use it as the readiness probe so traffic only reaches a process that can answer.
 * The worker answers /health/live and /health/ready on its own port (WORKER_PORT, default 4001), see worker.ts.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<Health> {
    let database: Health['database'] = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return {
      status: 'ok',
      service: 'bmu-hub-api',
      time: new Date().toISOString(),
      database,
    };
  }

  @Get('live')
  live() {
    return { status: 'ok', role: processRole(), version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const r = await readiness(this.prisma);
    res.status(r.ready ? 200 : 503);
    return r;
  }
}

/** Migration folders shipped with this build (src/ and dist/ both sit two levels below apps/api). */
function shippedMigrations(): string[] | null {
  try {
    return readdirSync(new URL('../../prisma/migrations/', import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
}

/** Shared by the API's /health/ready and the worker's health port. */
export async function readiness(prisma: Pick<PrismaService, '$queryRaw'>) {
  const checks: { database: 'up' | 'down'; migrations: 'applied' | 'pending' | 'unknown'; pending: string[] } = { database: 'up', migrations: 'unknown', pending: [] };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.database = 'down';
  }
  const shipped = shippedMigrations();
  if (checks.database === 'up' && shipped) {
    try {
      const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const applied = new Set(rows.map((r) => r.name));
      checks.pending = shipped.filter((m) => !applied.has(m));
      checks.migrations = checks.pending.length ? 'pending' : 'applied';
    } catch {
      checks.migrations = 'unknown';
    }
  }
  return { ready: checks.database === 'up' && checks.migrations !== 'pending', role: processRole(), version: APP_VERSION, ...checks };
}
