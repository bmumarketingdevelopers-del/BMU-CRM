export const SESSION_COOKIE = 'bmu_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
/** sid: the UserSession row (v20, sign out anywhere); amr: how they signed in (otp, otp+totp, passkey…). */
export type SessionClaims = { sub: string; org: string; sid?: string; amr?: string };
