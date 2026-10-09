// v19: tokens and webhook secrets are stored encrypted (AES-256-GCM). The key comes from INTEGRATIONS_KEY; in
// development it falls back to one derived from JWT_SECRET. A live server refuses to store secrets without it.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const key = () => {
  const raw = process.env.INTEGRATIONS_KEY;
  if (!raw && process.env.NODE_ENV === 'production') throw new Error('INTEGRATIONS_KEY is not set on the server');
  return createHash('sha256').update(raw ?? `bmu-integrations:${process.env.JWT_SECRET ?? 'dev-only-change-me'}`).digest();
};

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [v, iv, tag, enc] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !enc) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Short signed tokens for OAuth state and public media links: base64url(json).hmac */
export function signToken(payload: Record<string, unknown>, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}
