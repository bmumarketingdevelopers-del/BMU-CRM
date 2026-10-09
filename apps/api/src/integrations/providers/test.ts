// BMU's built-in test account: publishing "works" without any keys and results are made-up but steady (the same
// post always shows the same numbers on the same day), so the whole flow can be tried and tested end to end.
// Clearly labelled "Test account" everywhere it shows.
import { createHash, randomBytes } from 'node:crypto';
import type { AdRow, Connector, PostStats } from './types.js';

const n = (seed: string, mod: number) => createHash('sha256').update(seed).digest().readUInt32BE(0) % mod;
const DAY = 86_400_000;
const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export const testConnector: Connector = {
  async publish(acct, post) {
    if (post.caption.includes('[fail]')) throw new Error('Test account refused the post (the caption contains [fail])');
    const externalId = `test-${acct.provider}-${randomBytes(6).toString('hex')}`;
    return { externalId, url: `${appUrl()}/test-account/${externalId}` };
  },

  async postStats(_acct, posts, now) {
    const out = new Map<string, PostStats>();
    for (const p of posts) {
      const age = Math.floor((now.getTime() - p.publishedAt.getTime()) / DAY);
      if (age < 1) continue; // platforms report the day after
      const base = 150 + n(p.externalId, 250);
      const reach = Math.round(base * (1 + Math.min(age, 7) * 0.6));
      out.set(p.externalId, { reach, impressions: Math.round(reach * 1.4), engagement: Math.round(reach * 0.06), clicks: Math.round(reach * 0.015) });
    }
    return out;
  },

  async adRows(acct, from, to) {
    const rows: AdRow[] = [];
    for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime(); t += DAY) {
      const date = new Date(t).toISOString().slice(0, 10);
      const seed = `${acct.id}:${date}`;
      if (acct.provider === 'ga4') {
        const sessions = 120 + n(seed, 280);
        rows.push({ date, campaign: '', spendPaise: 0, impressions: 0, clicks: 0, conversions: 3 + n(`${seed}:c`, 10), sessions, users: Math.round(sessions * 0.78), revenuePaise: 0 });
        continue;
      }
      for (const campaign of ['Lead generation', 'Brand awareness']) {
        const s = `${seed}:${campaign}`;
        const spendPaise = (800 + n(s, 1700)) * 100;
        const impressions = Math.round((spendPaise / 100) * (9 + n(`${s}:i`, 6)));
        const clicks = Math.round(impressions * (0.012 + n(`${s}:k`, 10) / 1000));
        const conversions = campaign === 'Lead generation' ? Math.round(clicks * 0.08) : Math.round(clicks * 0.01);
        rows.push({ date, campaign, spendPaise, impressions, clicks, conversions, sessions: 0, users: 0, revenuePaise: 0 });
      }
    }
    return rows;
  },
};
