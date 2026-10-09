// v20 bot protection for public endpoints (enquiries, forms, privacy requests): a sliding window per key in memory.
// Local development (loopback) is never limited so the demo and tests keep working.
import { HttpException } from '@nestjs/common';

const hits = new Map<string, number[]>();

export function publicLimit(key: string, max: number, windowMs: number, ip?: string) {
  const local = !ip || /^(::1|127\.|::ffff:127\.)/.test(ip);
  if (local && process.env.NODE_ENV !== 'production') return;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new HttpException({ statusCode: 429, message: `Too many requests from your network. Please try again in ${Math.ceil((windowMs - (now - list[0])) / 60_000)} minutes.` }, 429);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
}
