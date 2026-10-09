// The background worker process (PROCESS_ROLE=worker): reminders, sweeps, syncs, nightly forecasts, workflows,
// AI agents and outgoing webhooks. It serves no API; a tiny health port (WORKER_PORT, default 4001) answers
// /health/live and /health/ready (with every job's last run) for Docker and monitoring. Run one worker; a second
// waits on standby and takes over if the first stops. See docs/backend.md.
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { AppModule } from './app.module.js';
import { readiness } from './health/health.controller.js';
import { PrismaService } from './prisma/prisma.service.js';
import { assertEnv } from './runtime/env.js';
import { makeLogger, onShutdown } from './runtime/http.js';
import { drainJobs, jobStats } from './runtime/jobs.js';
import { releaseJobsLock, waitForJobsLock } from './runtime/leader.js';

async function bootstrap() {
  process.env.PROCESS_ROLE = 'worker';
  const log = new Logger('Worker');
  Logger.overrideLogger(makeLogger());
  assertEnv('BMU Hub worker');

  const port = Number(process.env.WORKER_PORT || 4001);
  let prisma: PrismaService | null = null;
  let state: 'standby' | 'running' | 'stopping' = 'standby';
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health/live') return send(200, { status: 'ok', role: 'worker', state, uptimeSeconds: Math.round(process.uptime()) });
    if (req.url === '/health/ready' || req.url === '/health') {
      if (!prisma) return send(state === 'standby' ? 200 : 503, { ready: state === 'standby', state, jobs: [] });
      void readiness(prisma).then((r) => send(r.ready ? 200 : 503, { ...r, state, jobs: jobStats() }));
      return;
    }
    send(404, { message: 'Not found' });
  });
  server.listen(port, '0.0.0.0', () => log.log(`Worker health on http://localhost:${port}/health/ready`));

  await waitForJobsLock();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: makeLogger() });
  prisma = app.get(PrismaService);
  state = 'running';
  log.log(`BMU Hub worker running ${jobStats().length} background jobs`);

  onShutdown(async () => {
    state = 'stopping';
    await drainJobs();
    await app.close();
    await releaseJobsLock();
    server.close();
  });
}
await bootstrap();
