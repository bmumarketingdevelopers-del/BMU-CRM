import type { IntegrationProvider } from '@bmu/shared';

export type AccountCtx = { id: string; provider: IntegrationProvider; externalId: string; name: string; token: string | null; mode: string; createdAt: Date };

export type PostMedia = { kind: 'image' | 'video' | 'link' | 'none'; url: string | null; mimeType: string | null; localPath: string | null };
export type PostInput = { deliverableId: string; title: string; caption: string; media: PostMedia };
export type PublishResult = { externalId: string; url: string | null };
export type PostStats = { reach: number; impressions: number; engagement: number; clicks: number };
export type AdRow = { date: string; campaign: string; spendPaise: number; impressions: number; clicks: number; conversions: number; sessions: number; users: number; revenuePaise: number };

/** What a connected account can do. Each method throws ProviderError with a plain-English message on failure. */
export interface Connector {
  publish?(acct: AccountCtx, post: PostInput): Promise<PublishResult>;
  postStats?(acct: AccountCtx, posts: { externalId: string; publishedAt: Date }[], now: Date): Promise<Map<string, PostStats>>;
  adRows?(acct: AccountCtx, from: string, to: string): Promise<AdRow[]>;
}

export type DiscoveredAccount = { provider: IntegrationProvider; externalId: string; name: string; token: string; refreshToken?: string | null; expiresAt?: Date | null; scopes: string[] };

export interface LoginFlow {
  /** Env vars that must be set for "Connect" to work. */
  env: string[];
  authUrl(state: string, redirectUri: string, provider: IntegrationProvider): string;
  exchange(code: string, redirectUri: string, provider: IntegrationProvider): Promise<DiscoveredAccount[]>;
  /** New access token from a refresh token (Google, LinkedIn). */
  refresh?(refreshToken: string): Promise<{ token: string; expiresAt: Date | null }>;
}

export class ProviderError extends Error {}

/** fetch → JSON with the provider's error text surfaced. */
export async function http<T>(url: string, init: RequestInit & { label: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ProviderError(`${init.label}: could not reach the service (${(e as Error).message})`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const j = json as { error?: { message?: string } | string; message?: string; error_description?: string } | null;
    const msg = (typeof j?.error === 'object' ? j.error.message : undefined) ?? j?.error_description ?? j?.message ?? (typeof j?.error === 'string' ? j.error : undefined) ?? text.slice(0, 200);
    throw new ProviderError(`${init.label}: ${msg || `HTTP ${res.status}`}`);
  }
  return json as T;
}
