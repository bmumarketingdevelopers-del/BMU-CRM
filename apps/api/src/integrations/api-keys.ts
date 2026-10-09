// v19 public API keys. A key is "bmu_" + 32 random bytes; only its SHA-256 is stored. Requests made with it act as
// the person who created it (their permissions still apply) and may only use the routes its scopes allow.
import { createHash, randomBytes } from 'node:crypto';
import type { ApiScope, Me } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MeService } from '../auth/me.service.js';

export const newApiKey = () => `bmu_${randomBytes(32).toString('base64url')}`;
export const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');

export type ApiKeyAuth = { id: string; name: string; prefix: string; scopes: ApiScope[]; rateLimitPerMin: number };

/** The key's row and the person it acts as, or null when unknown, revoked, expired or the person left. */
export async function resolveApiKey(prisma: PrismaService, me: MeService, raw: string): Promise<{ key: ApiKeyAuth; user: Me } | null> {
  const row = await prisma.apiKey.findUnique({ where: { hash: hashKey(raw) } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) return null;
  const user = await me.load(row.userId);
  if (!user || user.type !== 'staff') return null;
  if (!row.lastUsedAt || row.lastUsedAt.getTime() < Date.now() - 60_000) await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return { key: { id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes as ApiScope[], rateLimitPerMin: row.rateLimitPerMin }, user };
}

/** Fixed one-minute window per key (per API process). */
const windows = new Map<string, { start: number; count: number }>();
export function takeRate(keyId: string, limit: number, now = Date.now()) {
  const minute = Math.floor(now / 60_000) * 60_000;
  const w = windows.get(keyId);
  const cur = w && w.start === minute ? w : { start: minute, count: 0 };
  cur.count++;
  windows.set(keyId, cur);
  if (windows.size > 10_000) for (const [k, v] of windows) if (v.start < minute) windows.delete(k);
  return { allowed: cur.count <= limit, remaining: Math.max(0, limit - cur.count), resetSec: Math.ceil((minute + 60_000 - now) / 1000) };
}
