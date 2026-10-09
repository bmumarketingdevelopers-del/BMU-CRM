# v13 foundation: event bus, live updates, presence, smart search, System health

First phase (v13) of `docs/spec/architecture-v2.json`. Nothing extra to install: everything runs inside the API
and the web app with only PostgreSQL.

## Event bus (`apps/api/src/platform/`)

- `event-bus.ts`: one in-process bus per API. Two kinds of events:
  - `change`: published for **every database write** by the Prisma extension in `prisma-events.ts` (create,
    update, upsert, delete and the bulk versions). Carries the model name, ids, organisation, who did it and a few
    routing references (clientOrgId, engagementId, threadId, userId). It never carries record data.
  - `domain`: published by `AuditService` for every audited action (`lead.stage_changed`, `task.reassigned`…).
    Workflows (v14) and AI agents (v15) will listen to these.
- Writes made while serving a GET (lazy generation, "last seen" stamps) are marked `quiet` and are not pushed to
  screens, so a screen reloading can never cause another reload.
- Bookkeeping tables (audit log, undo entries, OTP codes, the search index itself…) do not publish: see
  `QUIET_MODELS`.
- Delivery is asynchronous and never slows or fails the request. A listener that throws is stored in
  `EventFailure` and retried after 1, 2, 4 and 8 minutes (`events.service.ts`), then kept as "dead" for a person to
  Retry or Dismiss on System health.
- Listen from any service: `eventBus.subscribe('my_listener', handler, ['change'])` in `onModuleInit`, and call the
  returned function in `onModuleDestroy`.
- The current request's user is available anywhere below the controller through `requestContext`
  (`request-context.ts`, set by a global interceptor after the auth guard).

## Live updates

- `GET /realtime/stream` (server-sent events). The web app reads it at `/api/realtime/stream`, served by
  `apps/web/src/app/api/realtime/stream/route.ts` (the `/api` rewrite would cut the stream after 30 seconds).
- Messages: `hello` (connection id and this person's feature flags), `change` (entity, op, ids), `presence`.
- Who hears a change: team members in the organisation; personal records (notifications, drafts, saved views) only
  their owner; clients only changes linked to their own client account (directly, or through an engagement or a
  thread); creators only their own records.
- Web: `LiveProvider` (`apps/web/src/lib/live.tsx`) wraps every signed-in surface. `useLoad()` reloads quietly
  after changes (pass `{ live: false }` to opt out, or `{ live: ["Lead"] }` to limit it). Server-rendered pages get
  `router.refresh()`, skipped while someone is typing. `useLiveChanges(fn, entities?)` for anything else.
- Phone: `apps/mobile/src/live.ts`; `useData()` reloads quietly after changes. The stream pauses in the
  background.

## Presence

- `POST /realtime/presence { connId, rooms: ["Lead:<id>"] }`, sent by the web app every 20 seconds and whenever
  the page changes (bursts are merged and sent in order). Rooms expire after 45 seconds without a heartbeat.
- Team members only. Shown by `<PageTitle presence={{ entity, id }} />` on lead, client, project, request,
  deliverable and creator pages.

## Smart search

- `SearchDoc` table + an in-memory copy per organisation (`search-index.service.ts`), kept fresh by `change`
  events and built on first use. Scoring (`searchScore` in `packages/shared/src/platform.ts`): exact, prefix,
  substring, words within one or two typos, then shared letter groups.
- The index only proposes candidates; `team-flows/search.service.ts` runs every candidate through the same access
  rules as a plain match. Results found only by the index are marked `fuzzy` ("Close match" in the palette).
- `GET /team-flows/search?q=&surface=&kinds=project,task` (kinds optional).

## Feature flags and System health

- Flags (`FEATURE_FLAGS` in shared): `live_updates`, `presence`, `smart_search`. Missing row = default (on).
  A flag can be limited to roles. `GET /system/flags` (mine), `GET /system/flags/all` and
  `PATCH /system/flags/:key` (Founder and Admins, audited). Changes reach open screens straight away.
- `GET /system/health` (Founder and Admins): database, events per hour/day, listeners, failures, live connections,
  search index, background jobs, flags. `POST /system/events/failures/:id/retry|dismiss`,
  `POST /system/search/rebuild`. Page: `/admin/system`.

## Tests

- API: `apps/api/test/platform.e2e-spec.ts` (real HTTP streams).
- Browser: `apps/web/e2e/platform/live.mjs` (two people on one lead, live update without reload, search, flags).
- Journey helpers treat "networkidle" as "no request other than the live stream for 500 ms"
  (`quietNetworkIdle` in `apps/web/e2e/team/lib.mjs`), because a signed-in page always keeps its stream open.
