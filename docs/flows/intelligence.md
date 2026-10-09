# v20 Intelligence: metrics, forecasts, alerts, reports, goals

This is part of the eighth phase (v20) of `docs/spec/architecture-v2.json`. It runs inside the API and needs only
PostgreSQL. The Python forecasting service is optional.

Code:
- `packages/shared/src/metrics/index.ts`: metric registry, alert, report and goal schemas, forecasting rules
- `apps/api/src/intelligence/`
- `services/forecast/` (optional Python service)
- `apps/web/src/components/intelligence/`, `apps/web/src/app/(admin)/admin/intelligence/`, `apps/web/src/app/(team)/team/goals/`

Migration: `20261007090000_v20_intelligence_security`.

## Metric layer (`metrics.service.ts`)

- `METRICS` holds one definition per number: key, label, unit (count, paise, %, hours), which way is good, the formula
  in plain words, who may see it (Command Centre or money roles), whether it can be measured per client, and whether it
  is a "right now" number or a total over a period. The Report Builder's numbers (`OPS_METRICS`) are included and
  computed by the same engine as Analytics → Explore, so the figures always agree.
- `MetricsService.view(me, key, period, clientOrgId?)` returns the value, the previous period and the change. Money
  metrics need money access; profit margin also follows the "Profit and margin" field rule.
- Routes: `GET /intelligence/metrics` (everything the person may see), `GET /intelligence/metrics/:key`.

## Forecasts with reasons (`forecast.service.ts`)

Worked out at startup if nothing is stored, every night after 01:00 IST, and on **Recalculate now**. Stored in
`forecasts` with `reasons` (label, impact, detail) and `meta`.

- **Revenue**: the last 12 months of invoiced revenue, a Holt trend, live retainers and open deals weighted by stage;
  a low/high range from past error. Money roles only.
- **Churn**: per client from the client-health score and its reasons (late work, overdue invoices, feedback, open
  escalations), the change in the client's own activity (last 30 days vs the 30 before), how soon the last retainer
  ends without a renewal, and how long they have been a client. Value = monthly revenue at risk.
- **Win**: per open deal from the stage's probability, lead score, days since the last activity, proposal views,
  an overdue follow-up and the deal's age.
- **Slip**: per open task from hours left before the deadline against the estimate, whether it has started, the
  owner's load, deadline changes and open dependencies.
- **Capacity**: next 4 weeks of booked hours against available hours, by skill.
- `FORECAST_URL` set: revenue and churn come from the Python service (`POST /forecast/revenue`, `/forecast/churn`,
  8-second limit). Any error or timeout falls back to the TypeScript models, and the overview says which ran.

## Founder dashboard

`GET /intelligence/overview` feeds the **Forecast & risks** section of the Weekly Review (Command Centre home, a
Dashboard Studio section, added to existing Command Centre dashboards by the migration) and the Forecast & Risks page.
People without money access get no revenue forecast and no amounts. Cached per person for a minute, cleared on any
change.

## Alerts (`alerts.service.ts`)

- An alert watches a metric for the company, for each client separately, or for one client: drops by %, rises by %,
  goes above or goes below. Drops and rises compare the last N days with the N before and ignore baselines under 3.
- Four built-in alerts are created for every organisation and can be switched off or edited.
- Checked every morning after 08:00 IST (and **Check now**). One event per alert and subject per window; notifications
  go to the chosen roles and people (and to their phones).

## Scheduled reports (`reports.service.ts`, `pdf.ts`)

- Chosen numbers or a dashboard's numbers, daily, weekly or monthly at an hour (IST), to up to 20 emails.
- Built as the report's creator, so nobody receives numbers its creator can't see. Rendered to PDF by a small built-in
  writer (no extra packages) and sent through the email outbox with the PDF attached. Due reports are checked every 5
  minutes. `GET /intelligence/reports/:id/pdf` previews.

## Goals (`goals.service.ts`)

- Company goals (Founder/Admin) can follow a metric; the value is worked out as the system and cached for 5 minutes.
- Team goals (department heads for their department) and personal goals (yourself, or your reports) move with
  check-ins. Status: progress compared with the share of time gone (within 10 points on track, within 25 at risk).

## Tests

- `apps/api/test/intelligence.e2e-spec.ts`, `packages/shared/src/metrics.test.ts`, `services/forecast/test_models.py`
- Browser: `apps/web/e2e/intelligence/intelligence.mjs`
