# v20 Hardening: sign-in security, field-level permissions, DPDP, audit chain, phone parity, speed

This is part of the eighth phase (v20) of `docs/spec/architecture-v2.json`. Everything runs in the API with
PostgreSQL only.

Code:
- `apps/api/src/auth/` (sessions, two-step sign-in, passkeys), `apps/api/src/security/` (field access, DPDP, TOTP)
- `apps/api/src/audit/audit.service.ts` (hash chain), `apps/api/src/devices/` (offline sync, push)
- `apps/api/src/platform/read-cache.ts`, `apps/api/src/platform/search-index.service.ts` (speed)
- `packages/shared/src/security-types.ts`, `packages/shared/src/sync/index.ts`, `packages/shared/src/api/v20.ts`
- Web: `apps/web/src/components/security/`, `apps/web/src/app/(account)/security/`, `apps/web/src/app/(admin)/admin/security/`,
  `apps/web/src/app/(admin)/admin/privacy/`, `apps/web/src/app/(marketing)/privacy/`
- Phone: `apps/mobile/src/offline.ts`, `push.ts`, `lock.tsx`

Migration: `20261007090000_v20_intelligence_security`.

## Sessions and two-step sign-in

- Every sign-in creates a `user_sessions` row; the session token carries its id. Signing out (one device, all others,
  or an admin's **Sign out everywhere**) stops that token on the next request.
- **Authenticator app** (RFC 6238, 30-second steps, 6 digits, ±1 step for clock drift, no code used twice) with 10
  one-time recovery codes (stored hashed). With it on, the sign-in code returns a short-lived challenge and
  `POST /auth/2fa` finishes sign-in.
- **Passkeys** (WebAuthn via `@simplewebauthn`): add on **Sign-in security**; **Sign in with a passkey** needs no code
  and counts as two-step. The site address must match `APP_URL` (passkeys are tied to the domain).
- **Required two-step by role** (Settings → security, edited on Command Centre → Security → Sign-in rules): people in
  those roles reach only sign-in and `/security` until they set it up; the API answers `403 two_factor_required`.

## Field-level permissions (`security/field-access.ts`)

- Protected fields: lead budget, hourly cost rates, profit and margin, creator rate cards, team phone numbers, plus
  every custom field. Each role gets **Can change**, **Can see** or **Hidden**; defaults come from the spec and the
  Founder always keeps full access.
- One interceptor redacts every API answer for the person asking, so the website, the phone, the public API and search
  all get the same result; AI tools pass their data through the same filter and AI prompts never include hidden
  values. Writes to a field the person can't change are refused.
- **View as** shows a person's capabilities, field modes and a real record as they would see it.

## DPDP Act 2023 (`security/dpdp.service.ts`)

- Public `/privacy`: the notice (what, why, how long) and a form for copy, correction or deletion requests, plus
  consent withdrawal. Requests get a 30-day deadline and are matched to leads, clients or people by email.
- Consent records (purpose, notice version, source, IP) from the enquiry form's optional WhatsApp and marketing boxes.
- Export (JSON) and erase lead details; retention rules (anonymise or delete) run nightly after 02:00 IST; the breach
  runbook is on Command Centre → Privacy.
- The enquiry form has a hidden trap field for bots.

## Hash-chained audit log

Each audit entry stores a sequence number and `sha256(previous hash + entry)`, written under a per-organisation lock.
**Audit Log → Verify chain** re-computes the chain and names the first entry that was changed or removed. Entries from
before v20 are counted as "not chained".

## Row-level security

Not built in v20. Every query is scoped to the signed-in person's organisation in the API (and covered by the
permission tests); Postgres row-level policies were left out because they would need a database role per request
and add risk for a single-company install. Revisit if BMU Hub ever hosts several companies in one database.

## Phone parity (`devices/`, `apps/mobile/src/`)

- **Offline**: screens keep their last copy in SQLite on the phone and show it with "You're offline". Task changes
  go to an outbox (combined per task) and are sent on reconnect or when the app comes back to the front.
  `POST /sync/push` merges each change field by field against what the phone last saw: untouched fields take the
  phone's value, a field changed on both sides keeps the newer one and reports a conflict, checklists merge item by
  item, logged minutes add up, and resending the same change is a no-op.
- **Push**: Expo push with categories (approval: Approve/Reject/Snooze; message: Reply; task: Done; all: Snooze 1h).
  `POST /devices/quick-action` runs the action as the person. Quiet hours are respected; dead tokens are removed.
  Off in tests unless `EXPO_PUSH_URL` is set; `PUSH_DISABLED=1` turns it off.
- **App lock**: Face ID, fingerprint or passcode on open and after a minute in the background.

## Speed targets and the load test

- Targets: API p95 ≤ 300 ms, search p95 ≤ 200 ms, page first load ≤ 1.5 s.
- Search: each document's text is normalised once and typo distances are worked out once per distinct word per search.
- Read cache: Weekly Review, Forecast & risks, task lists and search are cached per person for 30–60 seconds; any real
  write clears that organisation's cache straight away (`EventBus.publish`). `READ_CACHE=0` turns it off.
- `pnpm loadtest` (`scripts/loadtest.mjs`): 10 people, 30 API requests/s and 10 searches/s together for 30 s while a task
  is edited every second, then a flat-out run; with `WEB_URL` it times page loads. Results go to `docs/loadtest-results.md`.

## Tests

- `apps/api/test/security.e2e-spec.ts`, `apps/api/test/devices.e2e-spec.ts`, `packages/shared/src/sync.test.ts`
- Browser: `apps/web/e2e/hardening/hardening.mjs` (uses a virtual passkey authenticator)
