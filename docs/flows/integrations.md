# v19 Integrations, publishing and public API

This is the seventh phase (v19) of `docs/spec/architecture-v2.json`. It runs inside the API and needs only PostgreSQL. Real
Meta, LinkedIn and Google accounts need app keys (see README → "Connect Instagram, Facebook, LinkedIn, YouTube,
Google Ads and GA4"). Without keys, **test accounts** (`mode = test`) behave like real ones. They publish to a page
on BMU Hub (`/test-account/<id>`) and return realistic numbers. Test accounts are allowed in development, or when
`INTEGRATIONS_TEST_ACCOUNTS=1` is set.

Code:
- `apps/api/src/integrations/`
- `apps/api/src/insights/accounting-formats.ts`
- `packages/shared/src/integrations-types.ts`
- `packages/shared/src/public-api.ts`
- `packages/shared/src/api/integrations.ts`
- `apps/web/src/components/integrations/`
- `apps/web/src/app/(admin)/admin/developer/`

Migration: `20261006090000_v19_integrations`.

## Connected accounts (`integrations.service.ts`, `providers/`)

- `IntegrationAccount`: one row per page, channel, ad account or GA4 property. Each row has a provider, a mode (live or
  test), a client, and a status (connected, error or disconnected). Tokens are sealed with AES-256-GCM (`crypto.ts`).
  The key comes from `INTEGRATIONS_KEY`. In development it falls back to a key derived from `JWT_SECRET`. On a
  production server, connecting or using an account fails until it is set.
- Sign-in: `POST /integrations/oauth/start` returns the provider's sign-in address. The `state` value is an
  HMAC-signed token that expires after 10 minutes and carries the org, the provider, the client and the person.
  `GET /integrations/oauth/callback` takes the code and finds every page or account that login can reach. It saves
  them all, then sends the person back to `/admin/integrations?connected=N` (or `?error=`).
  - **Meta**: Graph v21.0. A long-lived token covers pages, Instagram business accounts and ad accounts.
  - **LinkedIn**: organisation pages through `organizationAcls`, with a refresh token.
  - **Google**: offline access covers YouTube channels, Google Ads customers (with the developer token) and GA4
    properties.
- Who can manage accounts: Founder, Admin and CM lead manage all of them. A Client Manager or strategist manages
  only the clients they work on.
- `runJob` writes a `SyncJob` row for every publish or numbers pull. When a non-publish job fails, the account is
  marked `error` with the reason. Founder, Admin and the client's CM are told once (notification kind `integration`),
  and `integration.sync_failed` is audited.

## Auto-publishing (`publisher.service.ts`)

- Every minute the publisher picks scheduled posts that are due, approved, and on a channel with a connected account
  for that client. A live account is used before a test one. Publishing has the same gates as the content calendar.
- One `PostPublication` row is kept per post, which stops a post going out twice even across processes. Images and
  videos reach the platform through a signed `/public/media/<token>` link, which is why Instagram needs a public
  `API_PUBLIC_URL`.
- When it succeeds, the post is marked published with its live link, `deliverable.published` is audited with
  `{ auto: true }`, and the client's approvers are told.
- When it fails, it retries after 5, 15 and 60 minutes. After the third failure the status is `failed`,
  `post.publish_failed` is audited, and the CM is told. **Retry** on the calendar or in Integrations sends it again.
  **Publish now** skips the wait.
- LinkedIn supports text, link and image posts; video is refused with a clear message. YouTube uploads the video
  with its caption as the description.

## Results (`metrics-sync.service.ts`)

- The sync runs once a day after 07:00 IST (it checks every 15 minutes), plus whenever someone presses **Sync now**.
- **Post results**: every post published in the last 28 days, up to yesterday, gets one `PostMetric` row per day
  with the provider as `source`. Running the sync again on the same day updates that row instead of adding one. These
  numbers feed the existing calendar Results and the creative analytics.
- **Ads and website results**: the first sync backfills 30 days, and later syncs refresh the last 3 days. Rows are
  stored in `AdMetricDaily`, one per account, day and campaign: spend, impressions, clicks, conversions, sessions,
  users and revenue.
- `GET /integrations/results?clientOrgId=` (team) and `GET /client/ad-results` (the client's own) return totals,
  click rate, cost per click, cost per lead, figures per platform, a daily series and a campaign table. The default
  range is the last 30 days, ending yesterday.

## Public API v1 (`v1.controller.ts`, `api-keys.ts`, `openapi.ts`)

- Keys look like `bmu_<43 characters>`. Only their SHA-256 is stored, and the key is shown once. Founder and Admin
  create them in **API & Webhooks**. Each key has a name, scopes, a limit of 10 to 600 requests a minute, an optional
  expiry and a revoke button. Up to 25 keys can be active.
- `AuthGuard`: a bearer token starting with `bmu_` works only on routes marked `@ApiRoute(scope)` (the `/v1` routes).
  - An unknown, revoked or expired key gets 401.
  - A key without the route's scope gets 403 "This API key does not have the X scope".
  - Going over the limit gets 429 with `Retry-After`. Every response carries `X-RateLimit-Limit` and
    `X-RateLimit-Remaining`.
- A key acts as the person who made it. Their visibility rules, validation, audit log and service rules all apply:
  leads are created through `OpsLeadsService.create`, tasks through `TasksActionsService.create`, and invoices need
  finance read access.
- `GET /v1/openapi.json` is public: an OpenAPI 3.1 document built from `PUBLIC_ROUTES`. The same table drives
  `createBmuClient()` in `@bmu/shared`.
- Lists come newest first with cursor paging (`limit` 1 to 100, `cursor`, `updatedSince`).

## Webhooks (`webhooks.service.ts`)

- `WebhookSubscription`: a URL, events (an exact event, `area.*` or `*`) and a sealed secret shown once
  (`whsec_…`). There can be up to 20.
- Every audited domain event that matches creates a `WebhookDelivery` with the payload
  `{ id, type, occurredAt, entity, entityId, data }`. `data` is a public snapshot of the record. Website and inbox
  enquiries now audit `lead.created` too.
- Sending: a POST with `X-BMU-Event`, `X-BMU-Delivery`, `X-BMU-Timestamp` and
  `X-BMU-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. It times out after 10 seconds and does
  not follow redirects.
- Retries come after 1, 5, 30, 120, 360 and 720 minutes. After 7 tries the delivery is `dead`. The first failure sets
  `failingSince` and admins are told once; the next success clears it. **Send test**, **Send again**, **Pause** and
  **New secret** are on the page.
- In production (or with `WEBHOOKS_ALLOW_PRIVATE=0`), URLs must be https and must not point at private or loopback
  addresses.

## Accounting exports (`accounting-formats.ts`)

`GET /finance/export.csv?from&to&format=` returns one of these formats:

- `csv`: the v8 voucher list.
- `tally_xml`: a Tally Prime import file. Party ledgers go under Sundry Debtors. Sales, Receipt and Credit Note
  vouchers use the ledgers `Sales - Services`, `Output CGST` / `Output SGST` (same state) or `Output IGST`
  (another state), and `Bank`, `Cash` or `TDS Receivable`. The state is the client's place of supply, or the first two
  digits of their GSTIN, compared with BMU's state code in GST Settings.
- `zoho_invoices`: a Zoho Books invoice import, one row per line, with GST treatment, place of supply and SAC.
- `zoho_payments`: Zoho Books customer payments.

The Accounting Sync page picks a default format from the saved accounting software.

## Tests

- `apps/api/test/integrations.e2e-spec.ts` (15 tests): the hub, publishing with retries and next-day results, ads
  results and access, API key scopes and rate limits, signed and retried webhooks, and the accounting formats.
- `apps/web/e2e/integrations/integrations.mjs`: the browser journey covering all three acceptance checks.
