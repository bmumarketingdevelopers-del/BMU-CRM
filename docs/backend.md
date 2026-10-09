# BMU Hub backend (v21)

How the backend is organised, how it runs as real server processes, and how to deploy and operate it.
Everything here works with only Postgres: no Redis, queue service or API keys are needed.

## 1. Processes

The API code (`apps/api`) starts in one of three roles, chosen with `PROCESS_ROLE`:

| Role | Start with | What it does | How many |
|---|---|---|---|
| `all` (default) | `pnpm dev`, or `node dist/main.js` | HTTP API, live updates and every background job in one process | 1 |
| `api` | `pnpm start:api` (`node dist/main.js`) | HTTP API (port `PORT`, default 4000) and live updates (SSE) | 1 or more |
| `worker` | `pnpm start:worker` (`node dist/worker.js`) | Background jobs, workflows, AI agents, outgoing webhooks. Health port `WORKER_PORT` (default 4001) | 1 (a 2nd waits on standby) |

The website (`apps/web`, Next.js) is a separate process on port 3000 and forwards `/api/*` to the API.

```
 Browser / phone app
        │
        ▼
  web (Next.js :3000) ──/api──▶ api (:4000) ×N ──┐
                                                  │      Postgres
                                worker (:4001) ───┼──▶  tables + LISTEN/NOTIFY "bmu_events"
                                                  │      + advisory lock "jobs"
                         forecast (Python :8000) ◀┘ (optional)
```

### How the processes stay in step

- **Events** (`src/runtime/event-bridge.ts`). Every database write publishes a `change` event and every audited
  action a `domain` event on the in-process event bus. The bridge sends each event once through Postgres
  `NOTIFY bmu_events`, and every other process re-publishes it on its own bus. So a lead saved through the API moves
  a workflow on in the worker, and a task the worker creates appears live on screens served by any API process.
  The per-person read cache, and the small caches for sessions, field access, feature switches, pipelines and
  webhook targets, are cleared in every process the same way, so signing out everywhere or hiding a field takes
  effect on every API process at once. Turn it off with `EVENT_BRIDGE=0` (only for a single process).
- **One job runner** (`src/runtime/leader.ts`). The process that runs jobs holds a Postgres advisory lock for its
  whole life. A second worker waits on standby and takes over within 15 seconds if the first stops. In `all` mode,
  a second copy notices the lock and serves the API only, so jobs never run twice.
- **Heartbeats** (`src/runtime/heartbeat.service.ts`). Each process writes a row in `runtime_processes` every
  20 seconds (role, host, jobs and their last runs). Command Centre → System health shows every process.

### Which code runs where

| | all | api | worker |
|---|---|---|---|
| HTTP routes, auth, permissions, field access | ✓ | ✓ | |
| Live updates and presence (SSE `/realtime`) | ✓ | ✓ | |
| Search index (in memory, kept fresh by events) | ✓ | ✓ | built on demand |
| Background jobs (table below) | ✓ | | ✓ |
| Workflow engine, AI agents (react to events) | ✓ | | ✓ |
| Outgoing webhooks (queued from domain events) | ✓ | | ✓ |
| Event retries (each process retries its own listeners) | ✓ | ✓ | ✓ |

## 2. Background jobs

Every timer goes through one registry, `src/runtime/jobs.ts` (`startJob`): it decides whether this process runs
jobs, never lets two runs of the same job overlap, logs failures, records runs for System health and the worker's
`/health/ready`, and on shutdown waits for runs in progress.

| Job | Every | What it does | Switch off with |
|---|---|---|---|
| actions.jobs | 10 min | Approval expiry, recurring tasks, not-started alerts, leave cover | ACTIONS_JOBS_DISABLED |
| agents.scheduler | 1 min + on events | AI agents on their schedules and right after new leads/requests | AGENTS_DISABLED |
| ai.digest | 5 min | AI daily digests and summaries | |
| automations.engine | 1 min | Automation rules, reminders, digests | |
| clients.lifecycle | 10 min | Resumes paused services, finishes client offboarding | ACTIONS_JOBS_DISABLED |
| comms.meeting_reminders | 1 min | Meeting reminders | |
| comms.notification_router | 1 min | Batched notification emails and digests | |
| creative.timers | 5 min | Proofing reminders, creative calendar rules | |
| deliver.jobs | 10 min | Retainer months, SLA escalation, approval reminders | DELIVER_JOBS_DISABLED |
| devices.snoozed | 1 min | Brings snoozed notifications back and pushes them | |
| events.retries | 30 s | Retries failed event deliveries (every process) | |
| integrations.metrics_sync | 15 min | Ads and analytics results from connected accounts | |
| integrations.publisher | 1 min | Publishes scheduled social posts | |
| integrations.webhooks | 15 s | Delivers outgoing webhooks with retries | |
| intelligence.alerts | 30 min | Daily metric alerts after 08:00 IST | |
| intelligence.forecast | 30 min | Nightly revenue forecast and churn risk after 01:00 IST | |
| intelligence.reports | 5 min | Scheduled reports that are due | |
| money.invoice_plans | 15 min | Raises invoices from invoice plans | |
| ops.lead_alerts | 10 min | Lead first-reply alerts | ACTIONS_JOBS_DISABLED |
| people.leavers | 10 min | Suspends leavers on their last day (runs even with AUTOMATIONS_DISABLED) | |
| people.scheduled_changes | 10 min | Scheduled moves and role changes (runs even with AUTOMATIONS_DISABLED) | |
| security.retention | 1 h | Data retention rules, daily after 02:00 IST | |
| sell.scheduler | 1 min | Follow-up reminders, proposal expiry | |
| service.dunning | 15 min | Overdue invoice reminders | |
| workflows.engine | 30 s + on events | Moves workflow runs along | WORKFLOWS_DISABLED |

`AUTOMATIONS_DISABLED=1` switches off every job except the two people jobs. Tests never run jobs.

## 3. Code layout (`apps/api/src`)

| Area | Folders |
|---|---|
| Runtime (v21) | `runtime/` process roles, job registry, event bridge, jobs lock, heartbeats, env check, HTTP basics · `main.ts` API entry · `worker.ts` worker entry · `health/` |
| Platform | `prisma/` database client (publishes change events) · `platform/` event bus, live updates, search, flags, System health · `audit/` hash-chained audit log · `common/` guards and decorators |
| Identity & security | `auth/` OTP, sessions, 2FA, passkeys · `security/` field access, DPDP · `org/` hierarchy and roles · `settings/` · `devices/` phone sync and push |
| Sell | `leads/` `sell/` `proposals/` `catalogue/` `ops-actions/` |
| Deliver | `engagements/` `deliver/` `production/` `craft/` `creative/` `flows/` `requests/` `clients/` `clients-actions/` |
| Money | `service/` invoices and dunning · `money/` pay links, invoice plans, expenses, cash flow |
| People | `team-flows/` leave, attendance, timesheets · `people-actions/` · `workspace/` |
| Automation & AI | `automations/` `workflows/` `agents/` `ai/` `actions/` (shared add/assign/approve/undo) |
| Insight | `insights/` `analytics/` `ops-analytics/` `dashboards/` `intelligence/` (metrics, forecasts, alerts, reports, goals) |
| Admin & comms | `admin-org/` `admin-platform/` `customise/` `comms/` (inbox, docs, meetings, notifications) `integrations/` (accounts, publishing, public API, webhooks) `notifications/` |

Shared types, validation schemas, permission rules and the API client live in `packages/shared` and are used by the
API, the website and the phone app. Database schema: `apps/api/prisma/schema.prisma`; migrations in
`apps/api/prisma/migrations` (one folder per version).

## 4. Configuration

All settings are environment variables (`apps/api/.env` locally, `.env.production` with Docker).
`pnpm env:check` checks them without starting anything; the API and worker run the same check at start-up and
refuse to start on a live server (`NODE_ENV=production`) when a required setting is missing or unsafe.

| Setting | Needed | Notes |
|---|---|---|
| DATABASE_URL | always | Postgres connection |
| DIRECT_DATABASE_URL | with PgBouncer / Supabase transaction pooler | Session connection for migrations, live events and the jobs lock |
| SUPABASE_URL, SUPABASE_SECRET_KEY | on Vercel | Files go to Supabase Storage (private bucket `SUPABASE_STORAGE_BUCKET`, default `bmu-files`) |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | | Sent with direct browser uploads |
| CRON_SECRET | on Vercel | Guards `/cron/tick`, which runs the background jobs |
| JWT_SECRET | live | 32+ random characters |
| APP_URL, CORS_ORIGINS | live | Public web address |
| INTEGRATIONS_KEY | live, for integrations | Encrypts saved sign-ins |
| OWNER_EMAIL | first setup | Becomes the Founder login |
| SMTP_* | live | Sign-in codes and all email. `OTP_LOG=1` prints codes to the log for the very first sign-in |
| PROCESS_ROLE | | all (default), api, worker |
| PORT, WORKER_PORT | | 4000, 4001 |
| TRUST_PROXY | behind proxies | `loopback` (default), `uniquelocal`, or a number of hops |
| LOG_FORMAT, LOG_LEVEL, LOG_REQUESTS | | `json` lines; `debug`; `1` = one line per request with its id |
| EVENT_BRIDGE | | `0` turns off cross-process events |
| STORAGE_DIR | | Uploaded files (shared by API and worker) |
| AUTOMATIONS_DISABLED and the per-area flags | | See the jobs table |

Optional services, each with a built-in fallback: ANTHROPIC_API_KEY, RAZORPAY_*, WHATSAPP_*, META/LINKEDIN/GOOGLE_*,
FORECAST_URL. The full list with explanations is in `apps/api/.env.example` and `.env.production.example`.

## 5. Health checks

| URL | Answer |
|---|---|
| `GET :4000/health` | Summary, always 200 (`database: up/down`) |
| `GET :4000/health/live` | 200 while the API process runs (liveness) |
| `GET :4000/health/ready` | 200 when the database answers and every migration is applied, else 503 (readiness) |
| `GET :4001/health/live` | 200 while the worker runs (`state`: standby / running / stopping) |
| `GET :4001/health/ready` | Database, migrations and every job with its last run, failures and last error |

Every API response carries an `X-Request-Id` header (kept from the incoming one if a proxy set it), and request log
lines include it.

## 6. Database

- `pnpm db:deploy` (or `npx prisma migrate deploy`) applies new migrations on a live database. Never use
  `prisma migrate dev` on a live database.
- `pnpm db:seed` is safe to run any time: it only adds what is missing. On a live database (`NODE_ENV=production`,
  or `SEED_DEMO=0`) it creates only the organisation, departments, roles and permissions, the 2026 catalogue,
  templates, settings and the OWNER_EMAIL Founder login. Demo people and history are added only in development.
- Backups: `pg_dump -Fc "$DATABASE_URL" > bmu-$(date +%F).dump`; restore with `pg_restore -d <db> --clean <file>`.
  With Docker: `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U bmu -Fc bmu_hub > backup.dump`.
  Also back up the uploaded files (`STORAGE_DIR`, the `storage` volume in Docker).

## 7. Deploying

### A. Docker (recommended for a server)

```
cp .env.production.example .env.production   # fill in every CHANGE value
pnpm docker:up                                # = docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
pnpm docker:logs
```

This builds one image and runs `postgres`, `migrate` (migrations + first-time setup, then exits), `api`, `worker`
and `web`. Add `--profile forecast` for the Python forecasting service (set `FORECAST_URL=http://forecast:8000`).
Put Caddy or Nginx with HTTPS in front of port 3000 for your domain. More API capacity: `--scale api=3` behind a
load balancer (keep one worker).

Updating: `git pull` (or unzip the new version), then `pnpm docker:up` again: migrations run before the new API starts.

### B. One server without Docker (Windows or Linux)

```
pnpm install
pnpm build:prod          # after every update
pnpm start               # applies migrations, then runs api + worker + website; restarts any that crash
```

Settings come from `apps/api/.env` (copy the values from `.env.production.example`, with `localhost` as the
database host). For a service manager, run the three processes separately: `pnpm start:api`, `pnpm start:worker`,
`pnpm start:web`.

### C. Vercel + Supabase (v22)

The website and the API are two Vercel projects from this one repository; Supabase holds the database and files.

1. **Supabase.** Note the project's Transaction pooler (port 6543) and Session pooler (port 5432) connection
   strings (dashboard > Connect), the project URL and the secret and publishable keys (Project Settings > API Keys).
2. **API project** (Vercel > Add New > Project, root directory `apps/api`; `apps/api/vercel.json` does the rest).
   Environment variables: `DATABASE_URL` (transaction pooler), `DIRECT_DATABASE_URL` (session pooler),
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `CRON_SECRET`, `JWT_SECRET`,
   `NODE_ENV=production`, `APP_URL` and `CORS_ORIGINS` (the website's address), `OWNER_EMAIL`, `SMTP_*` and any
   integration keys. Each build applies new migrations (`pnpm db:deploy`).
3. **Website project** (root directory `apps/web`): set `API_URL` to the API project's address. The browser calls
   `/api/*` on the website, which forwards to the API, so the sign-in cookie stays on the website's domain.
4. **Background jobs.** Run `scripts/supabase-cron.sql` once in the Supabase SQL editor (with the API address and
   `CRON_SECRET` filled in): Supabase then calls `POST /cron/tick` every minute. (A Vercel Cron Job can call it
   instead, but every minute needs Vercel Pro.)
5. **Existing files.** Run `pnpm --filter @bmu/api storage:upload` once on the computer that has them.

What changes on Vercel (`VERCEL=1` switches it on; `SERVERLESS=1` forces it elsewhere):

- No timers: each `/cron/tick` call runs the jobs that are due (a 15-minute job on every 15th call). A second call
  for the same minute is ignored; daily jobs record the day in `cron_claims` so they run once.
  "Right after a change" nudges are off, so workflows and AI agents react within a minute instead of seconds.
- Files: uploads go from the browser straight to Supabase Storage (Vercel refuses requests over 4.5 MB); the
  upload endpoints receive them as usual (`storage/uploads.ts`). Downloads redirect to a one-hour signed link.
- Live updates reach screens served by the same function instance only, so some screens refresh on the next load
  instead of instantly (`EVENT_BRIDGE=1` shares events through Postgres again, at one session connection per
  instance). Phone app uploads still go through the API, so they are limited to 4.5 MB.

### D. Development

`pnpm dev` is unchanged: embedded or Docker Postgres, one all-in-one API process with demo data, and the website.

## 8. Limits

- Postgres row-level security is not used: every query is scoped by organisation and permission in the API.
- Live co-editing of a shared document (Yjs) keeps its in-memory state in the API process that serves it. With
  several API processes, people editing the same document must reach the same process (sticky sessions), or run
  one API process.
- Uploaded files are stored on disk (`STORAGE_DIR`). With API processes on several machines, put that folder on
  shared storage.
- NOTIFY messages are capped at 8 KB; very large bulk writes are shared as "several rows changed" (screens reload).
