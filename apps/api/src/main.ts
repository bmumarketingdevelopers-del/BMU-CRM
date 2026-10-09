// The HTTP API process (PROCESS_ROLE=all or api). Background jobs run here only in the all-in-one mode; a separate
// worker process (worker.ts, PROCESS_ROLE=worker) runs them otherwise. See docs/backend.md.
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { assertEnv } from './runtime/env.js';
import { makeLogger, onShutdown, requestBasics } from './runtime/http.js';
import { drainJobs } from './runtime/jobs.js';
import { releaseJobsLock, takeJobsLock } from './runtime/leader.js';
import { processRole } from './runtime/process-role.js';

async function bootstrap() {
  const log = new Logger('Startup');
  Logger.overrideLogger(makeLogger());
  assertEnv('BMU Hub API');
  if (processRole() === 'worker') {
    log.error('PROCESS_ROLE=worker runs the background worker: start it with `node dist/worker.js` (pnpm start:worker).');
    process.exit(1);
  }
  // All-in-one mode runs the jobs too, unless another process already does (then this one serves the API only).
  if (processRole() === 'all') {
    const leader = await takeJobsLock().catch((e: Error) => {
      log.warn(`Could not check the jobs lock (${e.message}); running jobs here`);
      return true;
    });
    if (!leader) {
      log.warn('Another process is already running the background jobs: this one serves the API only');
      process.env.PROCESS_ROLE = 'api';
    }
  }

  // rawBody keeps the exact bytes so the WhatsApp webhook signature can be checked.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: makeLogger() });
  // Rate limits on public forms count each visitor, not the proxy in front. Default: the website on this machine
  // (loopback). Behind Docker or a load balancer set TRUST_PROXY (e.g. "uniquelocal", or the number of proxies).
  const trust = process.env.TRUST_PROXY?.trim() || 'loopback';
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' ? true : trust);
  app.disable('x-powered-by');
  app.use(requestBasics);
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((o) => o.trim()),
    credentials: true,
  });
  const port = Number(process.env.PORT ?? 4000);
  // 0.0.0.0 so the Expo app on your phone (and other containers) can reach the API.
  await app.listen(port, '0.0.0.0');
  // Keep idle connections open longer than the website's proxy and load balancers do (they reuse them); otherwise a
  // request can land on a connection the API is just closing and fail with a 502/500.
  const server = app.getHttpServer() as import('node:http').Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  log.log(`BMU Hub API running on http://localhost:${port} (role ${processRole()})`);

  onShutdown(async () => {
    await drainJobs();
    await app.close();
    await releaseJobsLock();
  });
}
await bootstrap();
