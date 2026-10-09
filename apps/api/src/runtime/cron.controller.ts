// v22 serverless: the background jobs' clock. On Vercel nothing runs between requests, so something outside calls
// this once a minute: Supabase pg_cron + pg_net (scripts/supabase-cron.sql, works on every Vercel plan; Vercel's own
// Cron Jobs run only once a day on Hobby). On Vercel the address is https://<site>/api/cron/tick. Each call runs the
// jobs that are due (jobs.ts).
//
// Jobs run after the answer is sent (Vercel waitUntil keeps the function alive for up to its maxDuration).
// Guarded by CRON_SECRET (Authorization: Bearer <secret>, which is also what Vercel Cron sends). A repeated call for
// the same minute is ignored, so a retried or doubled delivery never runs the jobs twice.
import { Controller, Get, Headers, HttpCode, Post, Query, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { claimOnce, pruneClaims } from './claims.js';
import { runCronTick } from './jobs.js';
import { isServerless } from './process-role.js';

const WINDOW_MS = 60_000;

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Public()
@Controller('cron')
export class CronController {
  constructor(private readonly prisma: PrismaService) {}

  /** What Vercel Cron sends. */
  @Get('tick')
  tickGet(@Headers('authorization') auth?: string, @Query('job') job?: string, @Query('wait') wait?: string) {
    return this.tick(auth, job, wait);
  }

  /**
   * What pg_net sends. Answers at once and runs the jobs in the background (pg_net gives up after a few seconds);
   * `?wait=1` waits and returns how each job went. `?job=a,b` runs just those jobs now, whatever the time.
   */
  @Post('tick')
  @HttpCode(200)
  tickPost(@Headers('authorization') auth?: string, @Query('job') job?: string, @Query('wait') wait?: string) {
    return this.tick(auth, job, wait);
  }

  private async tick(auth?: string, job?: string, wait?: string) {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) throw new ServiceUnavailableException('CRON_SECRET is not set on the API, so background jobs cannot be started');
    if (!sameSecret(auth ?? '', `Bearer ${secret}`)) throw new UnauthorizedException('Wrong cron secret');
    if (!isServerless()) return { skipped: 'This API runs its own background jobs (not serverless)' };

    const now = Date.now();
    const only = job?.split(',').map((s) => s.trim()).filter(Boolean);
    if (!only) {
      const minute = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS).toISOString();
      if (!(await claimOnce(this.prisma, `cron:${minute}`))) return { skipped: `Already ran for ${minute}` };
      if (new Date(now).getUTCMinutes() === 0) await pruneClaims(this.prisma);
    }
    const run = runCronTick(now, WINDOW_MS, only);
    if (wait === '1') return run;
    waitUntil(run.then(() => undefined));
    return { started: new Date(now).toISOString() };
  }
}
