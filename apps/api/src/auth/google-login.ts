// Sign in with Google (OpenID Connect) for existing BMU Hub accounts. Google only proves that the person owns the email
// address; finding the account, two-factor and the session are exactly the same as for an email code
// (AuthService.signInWithGoogle → SessionsService.afterFirstFactor). Nobody without a BMU account gets in, and roles and
// permissions come from the CRM as always.
//
// Setup: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the same OAuth client as Integrations), and in Google Cloud Console
// > Credentials > that client > Authorised redirect URIs: <API_PUBLIC_URL>/auth/google/callback
// (default <APP_URL>/api/auth/google/callback, e.g. https://bmu-crm.vercel.app/api/auth/google/callback).
import { apiPublicUrl } from '../integrations/integrations.service.js';

/** httpOnly cookie holding the random value that must come back in the signed state (stops forged sign-in links). */
export const GOOGLE_STATE_COOKIE = 'bmu_google_state';
export const GOOGLE_STATE_TTL_SECONDS = 600;

export const googleLoginEnabled = () => !!process.env.GOOGLE_CLIENT_ID?.trim() && !!process.env.GOOGLE_CLIENT_SECRET?.trim();
export const googleRedirectUri = () => `${apiPublicUrl()}/auth/google/callback`;

/** Google's account chooser, asking only for the person's identity (no access to their mail or files). */
export function googleAuthUrl(state: string) {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  })}`;
}

export type GoogleIdentity = { email: string; emailVerified: boolean; name: string | null };

/** Exchanges the one-time code (server to server, with the client secret) and reads who signed in. */
export async function googleIdentity(code: string): Promise<GoogleIdentity> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '',
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new Error(`Google sign-in: code exchange failed (${tokenRes.status}) ${(await tokenRes.text()).slice(0, 200)}`);
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new Error('Google sign-in: no access token');
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!infoRes.ok) throw new Error(`Google sign-in: could not read the account (${infoRes.status})`);
  const u = (await infoRes.json()) as { email?: string; email_verified?: boolean | string; name?: string };
  return { email: (u.email ?? '').trim().toLowerCase(), emailVerified: u.email_verified === true || u.email_verified === 'true', name: u.name ?? null };
}

/** Only paths inside the app ("/team/…"), never another site. */
export const safeNext = (next: unknown): string | null => (typeof next === 'string' && /^\/(?!\/)[\w\-/.?=&%#]*$/.test(next) ? next.slice(0, 300) : null);
