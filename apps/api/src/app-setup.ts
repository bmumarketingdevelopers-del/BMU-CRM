// HTTP settings shared by the long-running server (main.ts) and the Vercel function (serverless.ts).
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { requestBasics } from './runtime/http.js';
import { isServerless } from './runtime/process-role.js';
import { storedUploadMiddleware } from './storage/uploads.js';

export function configureApp(app: NestExpressApplication) {
  // Rate limits on public forms count each visitor, not the proxy in front. Default: the website on this machine
  // (loopback); on Vercel, Vercel's own proxy, which sets X-Forwarded-For itself. Behind Docker or a load balancer
  // set TRUST_PROXY (e.g. "uniquelocal", or the number of proxies).
  const trust = process.env.TRUST_PROXY?.trim() || (isServerless() ? 'true' : 'loopback');
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' ? true : trust);
  app.disable('x-powered-by');
  app.use(requestBasics);
  app.use(cookieParser());
  // Files uploaded straight to Supabase Storage arrive as req.file like any other upload (storage/uploads.ts).
  app.use(storedUploadMiddleware);
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((o) => o.trim()),
    credentials: true,
  });
}
