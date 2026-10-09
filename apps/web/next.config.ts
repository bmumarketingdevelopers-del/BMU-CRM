import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  // Lets `pnpm dev` work when opened by network address (e.g. http://192.168.0.106:3000, or a phone
  // on the same Wi-Fi). Without this, Next.js blocks its dev scripts and buttons stop working.
  allowedDevOrigins: ["*.*.*.*", "*.local"],
  // The browser calls /api/*, served by src/pages/api/[...path].ts: the NestJS API itself on Vercel, or a pass-through
  // to the API server in development. Same origin, so the httpOnly session cookie works without any CORS setup.
  //
  // On Vercel that route loads the API as one self-contained file (apps/api/dist/vercel/serverless.mjs, built by
  // `pnpm --filter @bmu/api build:vercel`) at run time; it is not bundled into the website. These lines put that file
  // and the migration list (for /api/health/ready) into the function. Keys are route globs: "/api/**" is that route.
  outputFileTracingRoot: join(process.cwd(), "../.."),
  outputFileTracingIncludes: {
    "/api/**": ["../api/dist/vercel/serverless.mjs", "../api/prisma/migrations/**/*"],
  },
};

export default nextConfig;
