// v44 browser notifications (Web Push):
// - a browser turns them on; every new in-app notification is pushed to it (encrypted, signed with the VAPID keys);
// - quiet hours hold back ordinary ones, critical ones still go; signing out stops them;
// - a browser that turned them off at the push service (410) is forgotten; only real push services are accepted.
import 'dotenv/config';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import webpush from 'web-push';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { allowedPushEndpoint, WebPushService } from '../src/devices/web-push.service.js';

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
let base: string;
let pushService: Server;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What reached the stand-in push service: the path (which browser) and the headers the browser's service checks. */
const received: { path: string; auth: string; encoding: string; ttl: string; urgency: string; bytes: number }[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
/** A browser's subscription: its push address plus real P-256 / auth keys (the server encrypts to them). */
function browser(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `${base}/push/${name}-${stamp}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 50 && !pred(); i++) await sleep(100);
};

beforeAll(async () => {
  // A stand-in for a browser push service (FCM / Mozilla / WNS / Apple): answers 201, or 410 for "gone" browsers.
  pushService = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      received.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), encoding: String(req.headers['content-encoding'] ?? ''), ttl: String(req.headers.ttl ?? ''), urgency: String(req.headers.urgency ?? ''), bytes });
      res.statusCode = req.url?.includes('gone') ? 410 : 201;
      res.end();
    });
  }).listen(0);
  base = `http://127.0.0.1:${(pushService.address() as AddressInfo).port}`;
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.WEB_PUSH_ALLOW_HOSTS = '127.0.0.1';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const [k, email] of Object.entries({ design: 'design@bmu.demo', video: 'video@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
});

afterAll(async () => {
  await prisma.webPushSubscription.deleteMany({ where: { endpoint: { contains: `-${stamp}` } } });
  await prisma.notificationSetting.deleteMany({ where: { userId: users.video } });
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_ALLOW_HOSTS;
  pushService.close();
  await app.close();
});

describe('Browser notifications', () => {
  it('gives the browser the public key, then pushes every new notification to it, encrypted and signed', async () => {
    const config = (await http().get('/devices/web-push').set(as('design')).expect(200)).body;
    expect(config).toMatchObject({ available: true, publicKey: process.env.VAPID_PUBLIC_KEY });
    const laptop = browser('design-laptop');
    const after = (await http().post('/devices/web-push').set(as('design')).set('user-agent', 'Chrome on Windows').send(laptop).expect(200)).body;
    expect(after.devices).toBeGreaterThanOrEqual(1);
    const row = await prisma.webPushSubscription.findUniqueOrThrow({ where: { endpoint: laptop.endpoint } });
    expect(row).toMatchObject({ userId: users.design, userAgent: 'Chrome on Windows' });
    expect(row.sessionId).toBeTruthy();

    await app.get(NotificationsService).notify(orgId, [users.design], { kind: 'task_assigned', title: `Web push ${stamp}`, body: 'Due Friday', link: '/team/tasks' });
    await waitFor(() => received.some((r) => r.path.includes('design-laptop')));
    const hit = received.find((r) => r.path.includes('design-laptop'))!;
    expect(hit.encoding).toBe('aes128gcm');
    expect(hit.auth).toMatch(/^vapid t=.+, k=/);
    expect(hit.ttl).toBe('86400');
    expect(hit.urgency).toBe('normal');
    expect(hit.bytes).toBeGreaterThan(100);
  });

  it('sends a test alert on request', async () => {
    const before = received.length;
    const r = (await http().post('/devices/web-push/test').set(as('design')).expect(200)).body;
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeGreaterThan(before);
  });

  it('holds ordinary alerts in quiet hours, but critical ones still go (high urgency)', async () => {
    const desk = browser('video-desk');
    await http().post('/devices/web-push').set(as('video')).send(desk).expect(200);
    // Quiet all day except the minute that never comes: start 00:00, end 23:59.
    await prisma.notificationSetting.upsert({ where: { userId: users.video }, create: { userId: users.video, orgId, quietStart: '00:00', quietEnd: '23:59' }, update: { quietStart: '00:00', quietEnd: '23:59' } });
    const svc = app.get(WebPushService);
    const quiet = await svc.deliver([{ id: `n1-${stamp}`, orgId, userId: users.video, kind: 'task_assigned', title: 'Ordinary', body: null, link: null, critical: false }], new Date('2026-11-02T06:30:00Z'));
    expect(quiet).toBe(0);
    const critical = await svc.deliver([{ id: `n2-${stamp}`, orgId, userId: users.video, kind: 'approval_needed', title: 'Critical', body: null, link: null, critical: true }], new Date('2026-11-02T06:30:00Z'));
    expect(critical).toBe(1);
    expect(received.filter((r) => r.path.includes('video-desk')).at(-1)?.urgency).toBe('high');
  });

  it('stops after the person signs out of the sign-in it was turned on in', async () => {
    const token = await signIn('video@bmu.demo');
    const phone = browser('video-browser-2');
    await request(app.getHttpServer()).post('/devices/web-push').set({ Authorization: `Bearer ${token}` }).send(phone).expect(200);
    await request(app.getHttpServer()).post('/auth/logout').set({ Authorization: `Bearer ${token}` }).expect((r) => expect(r.status).toBeLessThan(300));
    await prisma.notificationSetting.deleteMany({ where: { userId: users.video } });
    const n = await app.get(WebPushService).deliver([{ id: `n3-${stamp}`, orgId, userId: users.video, kind: 'task_assigned', title: 'After sign-out', body: null, link: null, critical: false }]);
    // The first browser (still signed in) gets it; the signed-out one doesn't.
    expect(n).toBe(1);
    expect(received.some((r) => r.path.includes('video-browser-2'))).toBe(false);
  });

  it('forgets a browser the push service says is gone (410), and on request', async () => {
    const old = browser('gone-design');
    await http().post('/devices/web-push').set(as('design')).send(old).expect(200);
    await app.get(WebPushService).deliver([{ id: `n4-${stamp}`, orgId, userId: users.design, kind: 'task_assigned', title: 'Gone?', body: null, link: null, critical: false }]);
    expect(await prisma.webPushSubscription.count({ where: { endpoint: old.endpoint } })).toBe(0);
    const laptop = await prisma.webPushSubscription.findFirstOrThrow({ where: { userId: users.design, endpoint: { contains: `design-laptop-${stamp}` } } });
    // Someone else can't remove it; its owner can.
    await http().post('/devices/web-push/remove').set(as('video')).send({ endpoint: laptop.endpoint }).expect(200);
    expect(await prisma.webPushSubscription.count({ where: { id: laptop.id } })).toBe(1);
    await http().post('/devices/web-push/remove').set(as('design')).send({ endpoint: laptop.endpoint }).expect(200);
    expect(await prisma.webPushSubscription.count({ where: { id: laptop.id } })).toBe(0);
  });

  it('accepts only real browser push services (never an internal address)', async () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc', env)).toBe(true);
    expect(allowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc', env)).toBe(true);
    expect(allowedPushEndpoint('https://wns2-pn1p.notify.windows.com/w/?token=abc', env)).toBe(true);
    expect(allowedPushEndpoint('https://web.push.apple.com/abc', env)).toBe(true);
    expect(allowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc', env)).toBe(false);
    expect(allowedPushEndpoint('https://169.254.169.254/latest/meta-data', env)).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com.evil.example/x', env)).toBe(false);
    const bad = { endpoint: 'https://internal.example.com/hook', keys: browser('x').keys };
    await http().post('/devices/web-push').set(as('design')).send(bad).expect(400);
  });
});
