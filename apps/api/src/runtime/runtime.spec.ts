import { decodeEvent, encodeEvent } from './event-bridge.js';
import { checkEnv } from './env.js';
import { isDue } from './jobs.js';
import { isServerless, runsJobs } from './process-role.js';
import type { ChangeEvent } from '../platform/event-bus.js';

const change = (ids: string[]): ChangeEvent => ({ kind: 'change', orgId: 'o1', entity: 'Task', op: 'update', ids, at: new Date('2026-10-07T10:00:00Z'), actorId: 'u1', quiet: false, refs: { engagementId: 'e1' } });

describe('event bridge messages', () => {
  it('round-trips an event from another process and ignores our own', () => {
    const body = encodeEvent(change(['t1']));
    expect(decodeEvent(body)).toBeNull();
    const other = decodeEvent(body, 'another-process');
    expect(other).toMatchObject({ kind: 'change', entity: 'Task', ids: ['t1'], refs: { engagementId: 'e1' } });
    expect((other as ChangeEvent).at).toBeInstanceOf(Date);
  });

  it('stays under the Postgres notification limit for big bulk writes', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `cmxyz${i.toString().padStart(20, '0')}`);
    const body = encodeEvent(change(ids));
    expect(Buffer.byteLength(body)).toBeLessThan(8000);
    expect((decodeEvent(body, 'x') as ChangeEvent).ids).toEqual([]);
  });

  it('ignores malformed messages', () => {
    expect(decodeEvent('not json', 'x')).toBeNull();
    expect(decodeEvent(undefined, 'x')).toBeNull();
  });
});

describe('start-up settings check', () => {
  it('refuses a live server with the development secret', () => {
    const r = checkEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', JWT_SECRET: 'dev-only-change-me' });
    expect(r.errors.join(' ')).toMatch(/JWT_SECRET/);
  });

  it('accepts a complete live setup and lists optional services', () => {
    const r = checkEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a'.repeat(40), APP_URL: 'https://hub.example.in', CORS_ORIGINS: 'https://hub.example.in', INTEGRATIONS_KEY: 'k', SMTP_HOST: 'smtp', OWNER_EMAIL: 'me@example.in' });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.optional.find((o) => o.name.startsWith('Email'))?.on).toBe(true);
  });

  it('rejects an unknown process role', () => {
    const before = process.env.PROCESS_ROLE;
    process.env.PROCESS_ROLE = 'nope';
    try {
      expect(checkEnv({ DATABASE_URL: 'postgresql://x' }).errors.join(' ')).toMatch(/PROCESS_ROLE/);
    } finally {
      if (before === undefined) delete process.env.PROCESS_ROLE;
      else process.env.PROCESS_ROLE = before;
    }
  });
});

describe('where jobs run', () => {
  it('never in tests', () => {
    expect(runsJobs()).toBe(false);
  });
});

describe('serverless (Vercel)', () => {
  const MIN = 60_000;
  const at = (iso: string) => new Date(iso).getTime();

  it('is on when Vercel runs the API, and SERVERLESS overrides it', () => {
    expect(isServerless({ VERCEL: '1' })).toBe(true);
    expect(isServerless({})).toBe(false);
    expect(isServerless({ VERCEL: '1', SERVERLESS: '0' })).toBe(false);
    expect(isServerless({ SERVERLESS: '1' })).toBe(true);
  });

  it('runs a job on the cron call that crosses its interval', () => {
    expect(isDue(15_000, at('2026-10-09T10:07:00Z'), MIN)).toBe(true); // shorter than a minute: every call
    expect(isDue(MIN, at('2026-10-09T10:07:00Z'), MIN)).toBe(true);
    expect(isDue(15 * MIN, at('2026-10-09T10:15:00Z'), MIN)).toBe(true);
    expect(isDue(15 * MIN, at('2026-10-09T10:16:00Z'), MIN)).toBe(false);
    // A call a little late still counts the boundary it crossed, and only once.
    expect(isDue(15 * MIN, at('2026-10-09T10:15:20Z'), MIN)).toBe(true);
    expect(isDue(15 * MIN, at('2026-10-09T10:16:20Z'), MIN)).toBe(false);
  });

  it('runs a 15-minute job 4 times an hour', () => {
    let runs = 0;
    for (let m = 0; m < 60; m++) if (isDue(15 * MIN, at('2026-10-09T10:00:00Z') + m * MIN, MIN)) runs++;
    expect(runs).toBe(4);
  });

  it('explains a web address in DATABASE_URL and asks for storage and cron settings', () => {
    const r = checkEnv({ VERCEL: '1', DATABASE_URL: 'https://abc.supabase.co' });
    expect(r.errors.join(' ')).toMatch(/Postgres connection string/);
    expect(r.errors.join(' ')).toMatch(/SUPABASE_URL and SUPABASE_SECRET_KEY/);
    expect(r.warnings.join(' ')).toMatch(/CRON_SECRET/);
    const ok = checkEnv({ VERCEL: '1', DATABASE_URL: 'postgresql://x', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x', CRON_SECRET: 'c' });
    expect(ok.errors).toEqual([]);
  });
});
