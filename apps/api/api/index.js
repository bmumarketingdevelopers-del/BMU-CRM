// Vercel function: the whole BMU Hub API (src/serverless.ts, compiled by `nest build` into dist/ during the build).
// vercel.json sends every path here, so the API keeps its usual routes (/health, /auth/..., /cron/tick).
export { default } from '../dist/serverless.js';
