export const SESSION_COOKIE = 'bmu_session';
/** Default for tokens signed without their own expiry; sign-in sessions use the organisation's session length (v42). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
/** The browser keeps the cookie for the longest possible session (90 days); the session itself ends earlier when shorter. */
export const SESSION_COOKIE_MAX_SECONDS = 60 * 60 * 24 * 90;
/** sid: the UserSession row (v20, sign out anywhere); amr: how they signed in (otp, google, otp+totp, passkey…). */
export type SessionClaims = { sub: string; org: string; sid?: string; amr?: string };
