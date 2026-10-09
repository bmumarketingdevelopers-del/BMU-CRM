import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // Lets `pnpm dev` work when opened by network address (e.g. http://192.168.0.106:3000, or a phone
  // on the same Wi-Fi). Without this, Next.js blocks its dev scripts and buttons stop working.
  allowedDevOrigins: ["*.*.*.*", "*.local"],
  // The browser calls /api/*, which Next forwards to the NestJS API. Same origin, so the
  // httpOnly session cookie set at sign-in works without any CORS setup.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
};

export default nextConfig;
