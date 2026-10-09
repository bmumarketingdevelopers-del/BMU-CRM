import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, createApiClient, homePathFor, type Me } from "@bmu/shared";
import { API_URL } from "./api";

/**
 * The API for this request: API_URL in development, else /api on the address the visitor used. The website and the
 * API are one Vercel deployment, so this always reaches the same version (and works on preview links too).
 */
async function apiBase() {
  if (process.env.API_URL) return API_URL;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}/api` : API_URL;
}

/** API client for server components, forwarding the signed-in user's session cookie. */
export async function serverApi() {
  const cookieHeader = (await cookies()).toString();
  return createApiClient(await apiBase(), { headers: { cookie: cookieHeader } });
}

/** Signed-in user, or a redirect to sign-in. Optionally limits a surface to some user types. */
export async function requireMe(allow?: Me["type"][]): Promise<Me> {
  let me: Me;
  try {
    me = await (await serverApi()).auth.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect("/sign-in");
    throw e;
  }
  // v20: roles that must use two-factor set it up before anything else.
  if (me.mustEnroll2fa) redirect("/security?required=1");
  if (allow && !allow.includes(me.type)) redirect(homePathFor(me));
  return me;
}
