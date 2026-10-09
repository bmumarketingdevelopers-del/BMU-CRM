// v21 backend runtime: checks the environment once at start-up. On a live server (NODE_ENV=production) a missing or
// unsafe required setting stops the process with a clear message instead of failing later; optional services that
// are not set up are listed so it is obvious which features run in their built-in fallback mode.
import { Logger } from '@nestjs/common';
import { isServerless, processRole } from './process-role.js';

export type EnvReport = { errors: string[]; warnings: string[]; optional: { name: string; on: boolean }[] };

const DEV_SECRET = 'dev-only-change-me';

export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const live = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];
  const set = (k: string) => !!env[k]?.trim();

  if (!set('DATABASE_URL')) errors.push('DATABASE_URL is not set (postgresql://user:password@host:5432/database)');
  else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL!.trim()))
    errors.push(
      'DATABASE_URL must be a Postgres connection string (postgresql://...), not a web address. On Supabase: dashboard > Connect > Transaction pooler. The https://<project>.supabase.co address goes in SUPABASE_URL',
    );
  if (isServerless(env)) {
    if (!set('SUPABASE_URL') || !set('SUPABASE_SECRET_KEY')) errors.push('SUPABASE_URL and SUPABASE_SECRET_KEY are required on Vercel: uploaded files are kept in Supabase Storage (a function has no lasting disk)');
    if (!set('CRON_SECRET')) warnings.push('CRON_SECRET is not set: background jobs (reminders, workflows, scheduled posts, webhooks) will not run. See scripts/supabase-cron.sql');
  }
  try {
    processRole();
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (env.PORT && !/^\d+$/.test(env.PORT)) errors.push(`PORT must be a number (got "${env.PORT}")`);

  if (live) {
    const secret = env.JWT_SECRET ?? '';
    if (!secret || secret === DEV_SECRET || secret.length < 32) errors.push('JWT_SECRET must be a random value of at least 32 characters on a live server');
    if (!set('APP_URL') || /localhost|127\.0\.0\.1/.test(env.APP_URL!)) warnings.push('APP_URL is not your public web address: links in emails and passkey sign-in will not work');
    if (!set('CORS_ORIGINS')) warnings.push('CORS_ORIGINS is not set: only http://localhost:3000 may call the API from a browser');
    if (!set('INTEGRATIONS_KEY')) warnings.push('INTEGRATIONS_KEY is not set: connecting Instagram, Google or other accounts is refused until it is');
    if (!set('SMTP_HOST')) warnings.push(env.OTP_LOG === '1' ? 'SMTP_HOST is not set: sign-in codes are written to this log (OTP_LOG=1). Set up email and remove OTP_LOG soon' : 'SMTP_HOST is not set: sign-in codes cannot be emailed. Set SMTP_* (or OTP_LOG=1 for the very first sign-in)');
    if (!set('OWNER_EMAIL')) warnings.push('OWNER_EMAIL is not set: `pnpm db:seed` needs it to create the first Founder login');
  }

  const optional = [
    { name: 'Email (SMTP)', on: set('SMTP_HOST') },
    { name: 'AI (Anthropic)', on: set('ANTHROPIC_API_KEY') },
    { name: 'Payments (Razorpay)', on: set('RAZORPAY_KEY_ID') && set('RAZORPAY_KEY_SECRET') },
    { name: 'WhatsApp', on: set('WHATSAPP_TOKEN') && set('WHATSAPP_PHONE_ID') },
    { name: 'Forecast service (Python)', on: set('FORECAST_URL') },
    { name: 'File storage (Supabase)', on: set('SUPABASE_URL') && set('SUPABASE_SECRET_KEY') },
  ];
  return { errors, warnings, optional };
}

/** Logs the report; exits on errors. */
export function assertEnv(service: string) {
  const log = new Logger('Config');
  const r = checkEnv();
  for (const w of r.warnings) log.warn(w);
  if (r.errors.length) {
    for (const e of r.errors) log.error(e);
    const msg = `${service} did not start: fix the settings above in apps/api/.env (or your server's environment).`;
    log.error(msg);
    // A serverless function reports the failure on the request instead of ending the process.
    if (isServerless()) throw new Error(`${msg} ${r.errors.join('; ')}`);
    process.exit(1);
  }
  const on = r.optional.filter((o) => o.on).map((o) => o.name);
  const off = r.optional.filter((o) => !o.on).map((o) => o.name);
  log.log(`${service} · role ${processRole()} · ${process.env.NODE_ENV ?? 'development'} · connected: ${on.join(', ') || 'none'}${off.length ? ` · built-in fallback: ${off.join(', ')}` : ''}`);
}
