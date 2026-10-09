// The whole BMU Hub API on the website's own address, as ONE function: /api/<anything> → NestJS (apps/api).
// - On Vercel (API_URL not set): the NestJS app runs inside this function (apps/api/src/serverless.ts, bundled into
//   apps/api/dist/vercel/serverless.mjs). Every API
//   route, the cron endpoint (/api/cron/tick), webhooks and live updates share it, which keeps the deployment far
//   under the Hobby plan's function limit.
// - In development (`pnpm dev` writes API_URL=http://localhost:4000 to .env.local): requests are passed on to the
//   API server running next to the website, so API code still reloads on save.
// A Pages Router API route (not an App Router handler) because it hands NestJS the plain Node request and response:
// uploads, raw webhook bodies and live-update streams pass through untouched.
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const config = {
  api: { bodyParser: false, externalResolver: true, responseLimit: false },
  // Seconds. Background jobs started by /api/cron/tick and live-update streams run up to this long.
  maxDuration: 300,
};

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

let nest: Promise<NodeHandler> | undefined;

/** Next.js adds its own helpers to the request and response; NestJS (Express) must see its own instead. */
function asPlainNode(req: IncomingMessage, res: ServerResponse) {
  for (const k of ["query", "cookies", "body", "env", "preview", "previewData", "draftMode"]) delete (req as unknown as Record<string, unknown>)[k];
  for (const k of ["status", "send", "json", "redirect", "setDraftMode", "setPreviewData", "clearPreviewData", "revalidate", "unstable_revalidate"])
    delete (res as unknown as Record<string, unknown>)[k];
}

/** Development: passes the request on to the API server and streams its answer back. */
function forward(base: string, req: IncomingMessage, res: ServerResponse) {
  const target = new URL(req.url!, base.replace(/\/$/, "") + "/");
  const client = target.protocol === "https:" ? https : http;
  return new Promise<void>((done) => {
    const out = client.request(
      target,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: target.host,
          "x-forwarded-host": req.headers.host ?? "",
          "x-forwarded-proto": (req.headers["x-forwarded-proto"] as string | undefined) ?? "http",
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on("end", done);
      },
    );
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ statusCode: 502, message: `The API at ${base} is not running. Start it with pnpm dev.` }));
      done();
    });
    res.on("close", () => out.destroy());
    req.pipe(out);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // "/api/health?x=1" → "/health?x=1": the API's own routes have no /api prefix.
  req.url = (req.url ?? "/").replace(/^\/api(?=\/|\?|$)/, "") || "/";
  if (!req.url.startsWith("/")) req.url = `/${req.url}`;

  const upstream = process.env.API_URL?.trim();
  if (upstream) return forward(upstream, req, res);

  asPlainNode(req, res);
  // The API as one self-contained file built by `pnpm --filter @bmu/api build:vercel` (apps/api/dist/vercel), loaded by
  // Node at run time rather than bundled into the website; next.config.ts includes it in this function. Functions
  // run from apps/web, on Vercel as with `next start`.
  const entry = pathToFileURL(join(/* turbopackIgnore: true */ process.cwd(), "../api/dist/vercel/serverless.mjs")).href;
  nest ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ entry)
    .then((m) => m.default as NodeHandler)
    .catch((e: unknown) => {
      nest = undefined;
      throw e;
    });
  const finished = new Promise<void>((done) => res.once("close", () => done()));
  try {
    // Loading the file, then (on the first request) starting NestJS, which checks the settings first.
    await (await nest)(req, res);
  } catch (e) {
    // Say why: start-up messages name settings, never their values.
    console.error("BMU Hub API failed to start:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ statusCode: 500, message: `The API could not start: ${(e as Error)?.message ?? e}` }));
    return;
  }
  // Keep the function running until NestJS has finished answering (live-update streams stay open for a while).
  await finished;
}
