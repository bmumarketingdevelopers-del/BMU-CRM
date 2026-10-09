// Meta: one login (Facebook) finds the person's Facebook pages, the Instagram business accounts linked to them and
// their ad accounts. Pages and Instagram use the page token; ad accounts use the long-lived user token.
// Instagram needs a public image or video URL, so media goes out through a signed /public/media link.
import type { IntegrationProvider } from '@bmu/shared';
import { http, ProviderError, type AdRow, type Connector, type DiscoveredAccount, type LoginFlow, type PostStats } from './types.js';

const G = 'https://graph.facebook.com/v21.0';
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'ads_read', 'business_management'];
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const metaLogin: LoginFlow = {
  env: ['META_APP_ID', 'META_APP_SECRET'],
  authUrl(state, redirectUri) {
    return `https://www.facebook.com/v21.0/dialog/oauth?${q({ client_id: process.env.META_APP_ID ?? '', redirect_uri: redirectUri, state, scope: SCOPES.join(','), response_type: 'code' })}`;
  },
  async exchange(code, redirectUri, provider) {
    const app = { client_id: process.env.META_APP_ID ?? '', client_secret: process.env.META_APP_SECRET ?? '' };
    const short = await http<{ access_token: string }>(`${G}/oauth/access_token?${q({ ...app, redirect_uri: redirectUri, code })}`, { label: 'Meta sign-in' });
    const long = await http<{ access_token: string; expires_in?: number }>(`${G}/oauth/access_token?${q({ ...app, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token })}`, { label: 'Meta sign-in' });
    const userToken = long.access_token;
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
    const out: DiscoveredAccount[] = [];
    if (provider === 'meta_ads') {
      const ads = await http<{ data: { id: string; name: string }[] }>(`${G}/me/adaccounts?${q({ fields: 'id,name', limit: '100', access_token: userToken })}`, { label: 'Meta ad accounts' });
      for (const a of ads.data) out.push({ provider: 'meta_ads', externalId: a.id.replace(/^act_/, ''), name: a.name, token: userToken, expiresAt, scopes: SCOPES });
      return out;
    }
    const pages = await http<{ data: { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[] }>(
      `${G}/me/accounts?${q({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: userToken })}`,
      { label: 'Meta pages' },
    );
    for (const p of pages.data) {
      if (provider === 'facebook') out.push({ provider: 'facebook', externalId: p.id, name: p.name, token: p.access_token, scopes: SCOPES });
      if (provider === 'instagram' && p.instagram_business_account) out.push({ provider: 'instagram', externalId: p.instagram_business_account.id, name: p.instagram_business_account.username ? `@${p.instagram_business_account.username}` : p.name, token: p.access_token, scopes: SCOPES });
    }
    return out;
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const metric = (data: { name: string; values?: { value: number }[] }[] | undefined, name: string) => data?.find((m) => m.name === name)?.values?.[0]?.value ?? 0;

export const metaConnector: Connector = {
  async publish(acct, post) {
    const token = acct.token ?? '';
    if (acct.provider === 'facebook') {
      const m = post.media;
      if (m.kind === 'image' && m.url) {
        const r = await http<{ id: string; post_id?: string }>(`${G}/${acct.externalId}/photos`, { label: 'Facebook', method: 'POST', body: new URLSearchParams({ url: m.url, caption: post.caption, access_token: token }) });
        const id = r.post_id ?? r.id;
        return { externalId: id, url: `https://www.facebook.com/${id}` };
      }
      if (m.kind === 'video' && m.url) {
        const r = await http<{ id: string }>(`${G}/${acct.externalId}/videos`, { label: 'Facebook', method: 'POST', body: new URLSearchParams({ file_url: m.url, description: post.caption, access_token: token }) });
        return { externalId: r.id, url: `https://www.facebook.com/${r.id}` };
      }
      const body = new URLSearchParams({ message: post.caption || post.title, access_token: token });
      if (m.kind === 'link' && m.url) body.set('link', m.url);
      const r = await http<{ id: string }>(`${G}/${acct.externalId}/feed`, { label: 'Facebook', method: 'POST', body });
      return { externalId: r.id, url: `https://www.facebook.com/${r.id}` };
    }
    if (acct.provider === 'instagram') {
      const m = post.media;
      if (!m.url || (m.kind !== 'image' && m.kind !== 'video')) throw new ProviderError('Instagram needs an approved image or video file');
      const create = new URLSearchParams({ caption: post.caption, access_token: token });
      if (m.kind === 'image') create.set('image_url', m.url);
      else {
        create.set('media_type', 'REELS');
        create.set('video_url', m.url);
      }
      const c = await http<{ id: string }>(`${G}/${acct.externalId}/media`, { label: 'Instagram', method: 'POST', body: create });
      if (m.kind === 'video') {
        for (let i = 0; i < 30; i++) {
          const s = await http<{ status_code: string }>(`${G}/${c.id}?${q({ fields: 'status_code', access_token: token })}`, { label: 'Instagram' });
          if (s.status_code === 'FINISHED') break;
          if (s.status_code === 'ERROR') throw new ProviderError('Instagram could not process the video');
          await sleep(5000);
        }
      }
      const p = await http<{ id: string }>(`${G}/${acct.externalId}/media_publish`, { label: 'Instagram', method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: token }) });
      const link = await http<{ permalink?: string }>(`${G}/${p.id}?${q({ fields: 'permalink', access_token: token })}`, { label: 'Instagram' }).catch(() => ({ permalink: undefined }));
      return { externalId: p.id, url: link.permalink ?? null };
    }
    throw new ProviderError('This account cannot publish posts');
  },

  async postStats(acct, posts) {
    const token = acct.token ?? '';
    const out = new Map<string, PostStats>();
    for (const p of posts) {
      if (acct.provider === 'instagram') {
        const r = await http<{ data: { name: string; values: { value: number }[] }[] }>(`${G}/${p.externalId}/insights?${q({ metric: 'reach,views,total_interactions', access_token: token })}`, { label: 'Instagram results' });
        out.set(p.externalId, { reach: metric(r.data, 'reach'), impressions: metric(r.data, 'views'), engagement: metric(r.data, 'total_interactions'), clicks: 0 });
      } else if (acct.provider === 'facebook') {
        const r = await http<{ data: { name: string; values: { value: number }[] }[] }>(`${G}/${p.externalId}/insights?${q({ metric: 'post_impressions,post_impressions_unique,post_clicks', access_token: token })}`, { label: 'Facebook results' });
        const e = await http<{ reactions?: { summary?: { total_count: number } }; comments?: { summary?: { total_count: number } }; shares?: { count: number } }>(
          `${G}/${p.externalId}?${q({ fields: 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares', access_token: token })}`,
          { label: 'Facebook results' },
        ).catch(() => ({}) as { reactions?: { summary?: { total_count: number } }; comments?: { summary?: { total_count: number } }; shares?: { count: number } });
        out.set(p.externalId, {
          reach: metric(r.data, 'post_impressions_unique'),
          impressions: metric(r.data, 'post_impressions'),
          clicks: metric(r.data, 'post_clicks'),
          engagement: (e.reactions?.summary?.total_count ?? 0) + (e.comments?.summary?.total_count ?? 0) + (e.shares?.count ?? 0),
        });
      }
    }
    return out;
  },

  async adRows(acct, from, to) {
    if (acct.provider !== 'meta_ads') return [];
    const rows: AdRow[] = [];
    let url: string | null = `${G}/act_${acct.externalId}/insights?${q({
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since: from, until: to }),
      fields: 'campaign_name,spend,impressions,clicks,actions',
      limit: '500',
      access_token: acct.token ?? '',
    })}`;
    const CONVERSIONS = ['lead', 'purchase', 'complete_registration', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'offsite_conversion.fb_pixel_purchase'];
    while (url) {
      const r: { data: { date_start: string; campaign_name?: string; spend?: string; impressions?: string; clicks?: string; actions?: { action_type: string; value: string }[] }[]; paging?: { next?: string } } = await http(url, { label: 'Meta Ads results' });
      for (const d of r.data) {
        rows.push({
          date: d.date_start,
          campaign: d.campaign_name ?? '',
          spendPaise: Math.round(Number(d.spend ?? 0) * 100),
          impressions: Number(d.impressions ?? 0),
          clicks: Number(d.clicks ?? 0),
          conversions: Math.round((d.actions ?? []).filter((a) => CONVERSIONS.includes(a.action_type)).reduce((s, a) => s + Number(a.value), 0)),
          sessions: 0,
          users: 0,
          revenuePaise: 0,
        });
      }
      url = r.paging?.next ?? null;
    }
    return rows;
  },
};

export const META_PROVIDERS: IntegrationProvider[] = ['instagram', 'facebook', 'meta_ads'];
