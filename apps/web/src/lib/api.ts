import { createApiClient, rupeesToPaise, services, type ServiceSummary } from "@bmu/shared";

/**
 * Browser-side client. Goes through the /api rewrite so the session cookie is sent.
 * When the session has expired (401), the browser goes back to sign-in and returns here afterwards.
 */
export const api = createApiClient("/api", {
  onUnauthorized: () => {
    if (typeof window === "undefined") return;
    const here = window.location.pathname;
    if (here.startsWith("/sign-in") || !/^\/(admin|team|client|creator)(\/|$)/.test(here)) return;
    // A full page load (not router.push): this runs outside React, and the sign-in page must start fresh.
    window.location.href = new URL(`/sign-in?expired=1&next=${encodeURIComponent(here + window.location.search)}`, window.location.origin).href;
  },
  // v20: roles that must use two-factor go to set it up first.
  onTwoFactorRequired: () => {
    if (typeof window === "undefined" || window.location.pathname.startsWith("/security")) return;
    window.location.href = new URL("/security?required=1", window.location.origin).href;
  },
});

/**
 * Where server-side code reaches the API without a visitor's request at hand (e.g. a page built ahead of time):
 * API_URL in development (the API server next to the website), else this site's own /api on Vercel.
 */
export const API_URL =
  process.env.API_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api` : "http://localhost:4000");

/** Catalogue from the API, or the bundled seed if the API isn't running yet. Server-side. */
export async function getServices(): Promise<{ data: ServiceSummary[]; live: boolean }> {
  try {
    return { data: await createApiClient(API_URL).services(), live: true };
  } catch {
    return {
      live: false,
      data: services.map((s) => ({
        id: s.id,
        name: s.name,
        track: s.track,
        billingType: s.billing_type,
        tiers: Object.entries(s.tiers).map(([tier, rupees]) => ({ tier, pricePaise: rupeesToPaise(rupees) })),
      })),
    };
  }
}
