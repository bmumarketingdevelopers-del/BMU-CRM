// LinkedIn company pages: sign in as a page admin, then post as the page (text, link or one image) and read share
// statistics. Uses the versioned REST API (LinkedIn-Version header).
import { readFile } from 'node:fs/promises';
import { http, ProviderError, type Connector, type DiscoveredAccount, type LoginFlow, type PostStats } from './types.js';

const SCOPES = ['w_organization_social', 'r_organization_social', 'rw_organization_admin'];
const VERSION = '202409';
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'LinkedIn-Version': VERSION, 'X-Restli-Protocol-Version': '2.0.0' });

export const linkedinLogin: LoginFlow = {
  env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  authUrl(state, redirectUri) {
    return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: 'code', client_id: process.env.LINKEDIN_CLIENT_ID ?? '', redirect_uri: redirectUri, state, scope: SCOPES.join(' ') })}`;
  },
  async exchange(code, redirectUri) {
    const t = await http<{ access_token: string; expires_in: number; refresh_token?: string }>('https://www.linkedin.com/oauth/v2/accessToken', {
      label: 'LinkedIn sign-in',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: process.env.LINKEDIN_CLIENT_ID ?? '', client_secret: process.env.LINKEDIN_CLIENT_SECRET ?? '' }),
    });
    const acls = await http<{ elements: { organization: string }[] }>('https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED', { label: 'LinkedIn pages', headers: headers(t.access_token) });
    const out: DiscoveredAccount[] = [];
    for (const a of acls.elements) {
      const id = a.organization.split(':').pop() ?? '';
      const org = await http<{ localizedName?: string }>(`https://api.linkedin.com/rest/organizations/${id}`, { label: 'LinkedIn pages', headers: headers(t.access_token) }).catch(() => ({ localizedName: undefined }));
      out.push({ provider: 'linkedin', externalId: id, name: org.localizedName ?? `LinkedIn page ${id}`, token: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: SCOPES });
    }
    return out;
  },
  async refresh(refreshToken) {
    const t = await http<{ access_token: string; expires_in: number }>('https://www.linkedin.com/oauth/v2/accessToken', {
      label: 'LinkedIn token refresh',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: process.env.LINKEDIN_CLIENT_ID ?? '', client_secret: process.env.LINKEDIN_CLIENT_SECRET ?? '' }),
    });
    return { token: t.access_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  },
};

export const linkedinConnector: Connector = {
  async publish(acct, post) {
    const token = acct.token ?? '';
    const author = `urn:li:organization:${acct.externalId}`;
    const body: Record<string, unknown> = { author, commentary: post.caption || post.title, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
    const m = post.media;
    if (m.kind === 'image' && m.localPath) {
      const init = await http<{ value: { uploadUrl: string; image: string } }>('https://api.linkedin.com/rest/images?action=initializeUpload', { label: 'LinkedIn image', method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) });
      const bytes = await readFile(m.localPath);
      const up = await fetch(init.value.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: bytes });
      if (!up.ok) throw new ProviderError(`LinkedIn image upload failed (HTTP ${up.status})`);
      body.content = { media: { id: init.value.image, title: post.title } };
    } else if (m.kind === 'link' && m.url) {
      body.content = { article: { source: m.url, title: post.title } };
    } else if (m.kind === 'video') {
      throw new ProviderError('Video posts to LinkedIn are not supported yet; post it by hand and mark it published');
    }
    const res = await fetch('https://api.linkedin.com/rest/posts', { method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new ProviderError(`LinkedIn: ${(await res.text()).slice(0, 200) || `HTTP ${res.status}`}`);
    const urn = res.headers.get('x-restli-id') ?? '';
    return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
  },

  async postStats(acct, posts) {
    const out = new Map<string, PostStats>();
    if (!posts.length) return out;
    const org = encodeURIComponent(`urn:li:organization:${acct.externalId}`);
    const shares = posts.filter((p) => p.externalId.includes(':share:')).map((p) => encodeURIComponent(p.externalId));
    const ugc = posts.filter((p) => !p.externalId.includes(':share:')).map((p) => encodeURIComponent(p.externalId));
    const parts = [shares.length ? `shares=List(${shares.join(',')})` : '', ugc.length ? `ugcPosts=List(${ugc.join(',')})` : ''].filter(Boolean).join('&');
    const r = await http<{ elements: { share?: string; ugcPost?: string; totalShareStatistics: { impressionCount: number; uniqueImpressionsCount: number; clickCount: number; likeCount: number; commentCount: number; shareCount: number } }[] }>(
      `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${org}&${parts}`,
      { label: 'LinkedIn results', headers: headers(acct.token ?? '') },
    );
    for (const e of r.elements) {
      const id = e.share ?? e.ugcPost;
      if (!id) continue;
      const s = e.totalShareStatistics;
      out.set(id, { reach: s.uniqueImpressionsCount, impressions: s.impressionCount, clicks: s.clickCount, engagement: s.likeCount + s.commentCount + s.shareCount });
    }
    return out;
  },
};
