// Google: one OAuth app for YouTube (upload videos, read statistics), Google Ads (daily campaign results; needs a
// developer token) and GA4 (daily sessions, users, key events, revenue). Offline access gives a refresh token.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { IntegrationProvider } from '@bmu/shared';
import { http, ProviderError, type AdRow, type Connector, type DiscoveredAccount, type LoginFlow, type PostStats } from './types.js';

const SCOPES: Partial<Record<IntegrationProvider, string[]>> = {
  youtube: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
  google_ads: ['https://www.googleapis.com/auth/adwords'],
  ga4: ['https://www.googleapis.com/auth/analytics.readonly'],
};
const ADS = 'https://googleads.googleapis.com/v17';
const adsHeaders = (token: string) => ({ authorization: `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '', ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}) });

async function token(body: Record<string, string>, label: string) {
  return http<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }>('https://oauth2.googleapis.com/token', {
    label,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...body }),
  });
}

export const googleLogin: LoginFlow = {
  env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  authUrl(state, redirectUri, provider) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, scope: (SCOPES[provider] ?? []).join(' ') })}`;
  },
  async exchange(code, redirectUri, provider) {
    const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'Google sign-in');
    const base = { token: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: SCOPES[provider] ?? [] };
    const out: DiscoveredAccount[] = [];
    const auth = { authorization: `Bearer ${t.access_token}` };
    if (provider === 'youtube') {
      const r = await http<{ items?: { id: string; snippet: { title: string } }[] }>('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { label: 'YouTube channels', headers: auth });
      for (const c of r.items ?? []) out.push({ provider, externalId: c.id, name: c.snippet.title, ...base });
    } else if (provider === 'google_ads') {
      if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new ProviderError('Google Ads needs GOOGLE_ADS_DEVELOPER_TOKEN on the server');
      const r = await http<{ resourceNames: string[] }>(`${ADS}/customers:listAccessibleCustomers`, { label: 'Google Ads accounts', headers: adsHeaders(t.access_token) });
      for (const rn of r.resourceNames) {
        const id = rn.split('/').pop() ?? '';
        out.push({ provider, externalId: id, name: `Google Ads ${id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}`, ...base });
      }
    } else if (provider === 'ga4') {
      const r = await http<{ accountSummaries?: { displayName: string; propertySummaries?: { property: string; displayName: string }[] }[] }>('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', { label: 'GA4 properties', headers: auth });
      for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out.push({ provider, externalId: p.property.replace('properties/', ''), name: `${p.displayName} (${a.displayName})`, ...base });
    }
    return out;
  },
  async refresh(refreshToken) {
    const t = await token({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'Google token refresh');
    return { token: t.access_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  },
};

export const googleConnector: Connector = {
  async publish(acct, post) {
    if (acct.provider !== 'youtube') throw new ProviderError('This account cannot publish posts');
    const m = post.media;
    if (m.kind !== 'video' || !m.localPath) throw new ProviderError('YouTube needs an approved video file');
    const size = (await stat(m.localPath)).size;
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { authorization: `Bearer ${acct.token ?? ''}`, 'content-type': 'application/json', 'x-upload-content-length': String(size), 'x-upload-content-type': m.mimeType ?? 'video/mp4' },
      body: JSON.stringify({ snippet: { title: post.title.slice(0, 100), description: post.caption }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }),
    });
    const location = init.headers.get('location');
    if (!init.ok || !location) throw new ProviderError(`YouTube: ${(await init.text()).slice(0, 200) || `HTTP ${init.status}`}`);
    const up = await fetch(location, { method: 'PUT', headers: { 'content-length': String(size), 'content-type': m.mimeType ?? 'video/mp4' }, body: Readable.toWeb(createReadStream(m.localPath)) as unknown as BodyInit, duplex: 'half' } as RequestInit);
    const v = (await up.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
    if (!up.ok || !v?.id) throw new ProviderError(`YouTube upload failed: ${v?.error?.message ?? `HTTP ${up.status}`}`);
    return { externalId: v.id, url: `https://www.youtube.com/watch?v=${v.id}` };
  },

  async postStats(acct, posts) {
    const out = new Map<string, PostStats>();
    if (acct.provider !== 'youtube' || !posts.length) return out;
    for (let i = 0; i < posts.length; i += 50) {
      const ids = posts.slice(i, i + 50).map((p) => p.externalId).join(',');
      const r = await http<{ items?: { id: string; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}`, { label: 'YouTube results', headers: { authorization: `Bearer ${acct.token ?? ''}` } });
      for (const v of r.items ?? []) {
        const views = Number(v.statistics.viewCount ?? 0);
        out.set(v.id, { reach: views, impressions: views, engagement: Number(v.statistics.likeCount ?? 0) + Number(v.statistics.commentCount ?? 0), clicks: 0 });
      }
    }
    return out;
  },

  async adRows(acct, from, to) {
    if (acct.provider === 'google_ads') {
      const query = `SELECT campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`;
      const r = await http<{ results?: { campaign: { name: string }; segments: { date: string }; metrics: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number } }[] }[]>(
        `${ADS}/customers/${acct.externalId}/googleAds:searchStream`,
        { label: 'Google Ads results', method: 'POST', headers: { ...adsHeaders(acct.token ?? ''), 'content-type': 'application/json' }, body: JSON.stringify({ query }) },
      );
      return r.flatMap((batch) => batch.results ?? []).map((x): AdRow => ({
        date: x.segments.date,
        campaign: x.campaign.name,
        spendPaise: Math.round(Number(x.metrics.costMicros ?? 0) / 10_000),
        impressions: Number(x.metrics.impressions ?? 0),
        clicks: Number(x.metrics.clicks ?? 0),
        conversions: Math.round(Number(x.metrics.conversions ?? 0)),
        sessions: 0,
        users: 0,
        revenuePaise: 0,
      }));
    }
    if (acct.provider === 'ga4') {
      const r = await http<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(`https://analyticsdata.googleapis.com/v1beta/properties/${acct.externalId}:runReport`, {
        label: 'GA4 results',
        method: 'POST',
        headers: { authorization: `Bearer ${acct.token ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }, { name: 'purchaseRevenue' }], limit: 1000 }),
      });
      return (r.rows ?? []).map((x): AdRow => {
        const d = x.dimensionValues[0]?.value ?? '';
        return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, campaign: '', spendPaise: 0, impressions: 0, clicks: 0, conversions: Math.round(Number(x.metricValues[2]?.value ?? 0)), sessions: Number(x.metricValues[0]?.value ?? 0), users: Number(x.metricValues[1]?.value ?? 0), revenuePaise: Math.round(Number(x.metricValues[3]?.value ?? 0) * 100) };
      });
    }
    return [];
  },
};
