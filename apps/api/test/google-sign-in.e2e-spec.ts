// Continue with Google: sign-in always starts on the main address (the one Google comes back to), so the state cookie
// is there on the way back. Started on another address (www or not, a vercel.app link) it moves to the main one first.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const saved = { ...process.env };

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.APP_URL = 'https://crm.example.com';
  delete process.env.API_PUBLIC_URL;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
});

afterAll(async () => {
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_URL', 'API_PUBLIC_URL']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app.close();
});

describe('Continue with Google', () => {
  it('started on the main address: sets the state cookie and goes to Google', async () => {
    const r = await http().get('/auth/google/start?next=/team/tasks').set('Host', 'crm.example.com').expect(302);
    expect(r.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(new URL(r.headers.location).searchParams.get('redirect_uri')).toBe('https://crm.example.com/api/auth/google/callback');
    expect(String(r.headers['set-cookie'])).toContain('bmu_google_state=');
  });

  it('started on another address (www, vercel.app): moves to the main address first, keeping where to go next', async () => {
    for (const host of ['www.crm.example.com', 'bmu-crm.vercel.app']) {
      const r = await http().get('/auth/google/start?next=/team/tasks').set('Host', host).expect(302);
      expect(r.headers.location).toBe('https://crm.example.com/api/auth/google/start?hop=1&next=%2Fteam%2Ftasks');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    // Behind the local pass-through the browser's address arrives as x-forwarded-host.
    const proxied = await http().get('/auth/google/start').set('Host', 'localhost:4000').set('x-forwarded-host', 'crm.example.com').expect(302);
    expect(proxied.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('never loops: after one move it goes to Google whatever the host says', async () => {
    const r = await http().get('/auth/google/start?hop=1').set('Host', 'internal-proxy:8080').expect(302);
    expect(r.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(String(r.headers['set-cookie'])).toContain('bmu_google_state=');
  });

  it('coming back without the state cookie is refused as expired', async () => {
    const start = await http().get('/auth/google/start').set('Host', 'crm.example.com').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const r = await http().get(`/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`).set('Host', 'crm.example.com').expect(302);
    expect(r.headers.location).toBe('https://crm.example.com/sign-in?google_error=expired');
  });
});
