// v21 backend runtime: shared start-up pieces for the API and worker processes.
import { ConsoleLogger, Logger, type LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** LOG_FORMAT=json prints one JSON object per line (for log collectors); otherwise readable coloured lines. */
export function makeLogger(): LoggerService {
  const json = process.env.LOG_FORMAT === 'json';
  return new ConsoleLogger({ json, colors: !json && Boolean(process.stdout.isTTY), logLevels: process.env.LOG_LEVEL === 'debug' ? ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] : ['log', 'error', 'warn', 'fatal'] });
}

const logger = new Logger('HTTP');

/**
 * Every request gets an id (kept from X-Request-Id when a proxy sets one) that is returned in the response header,
 * plus a few safe headers. LOG_REQUESTS=1 logs one line per request with its status and time.
 */
export function requestBasics(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[\w.-]{1,100}$/.test(incoming) ? incoming : randomUUID();
  (req as Request & { id?: string }).id = id;
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.LOG_REQUESTS === '1') {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (req.path.startsWith('/health')) return;
      logger.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms id=${id}`);
    });
  }
  next();
}

/** Runs `close` once on SIGTERM/SIGINT (Docker stop, Ctrl+C), then exits; a second signal or 30 s forces the exit. */
export function onShutdown(close: () => Promise<void>) {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) process.exit(1);
    closing = true;
    logger.log(`${signal} received: finishing work in progress and shutting down`);
    setTimeout(() => process.exit(1), 30_000).unref();
    close()
      .then(() => process.exit(0))
      .catch((e: Error) => {
        logger.error(`Shutdown failed: ${e.message}`);
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => handler('SIGTERM'));
  process.once('SIGINT', () => handler('SIGINT'));
}
