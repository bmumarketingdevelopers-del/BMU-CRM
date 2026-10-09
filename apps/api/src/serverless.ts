// v22 serverless: the API inside the website's Vercel function (apps/web/src/pages/api/[...path].ts loads this, with
// the /api prefix already removed). The Nest app is built once per
// function instance and reused by the requests it serves. Differences from main.ts (see docs/backend.md):
// - background jobs do not run on timers: POST /cron/tick runs them (runtime/cron.controller.ts);
// - after the response is sent the function stays alive until the event bus has delivered this request's events
//   (search index, queued webhooks), using Vercel's waitUntil.
import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { waitUntil } from '@vercel/functions';
import { AppModule } from './app.module.js';
import { configureApp } from './app-setup.js';
import { eventBus } from './platform/event-bus.js';
import { assertEnv } from './runtime/env.js';
import { makeLogger } from './runtime/http.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let ready: Promise<Handler> | undefined;

async function boot(): Promise<Handler> {
  Logger.overrideLogger(makeLogger());
  assertEnv('BMU Hub API (serverless)');
  // rawBody keeps the exact bytes so the WhatsApp webhook signature can be checked.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: makeLogger() });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as Handler;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // A failed start is retried on the next request instead of leaving the instance broken.
  const app = await (ready ??= boot().catch((e: unknown) => {
    ready = undefined;
    throw e;
  }));
  waitUntil(new Promise<void>((done) => res.once('close', () => done())).then(() => eventBus.idle()));
  app(req, res);
}
