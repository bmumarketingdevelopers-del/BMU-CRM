import { decodeEvent, encodeEvent } from './event-bridge.js';
import { checkEnv } from './env.js';
import { runsJobs } from './process-role.js';
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
