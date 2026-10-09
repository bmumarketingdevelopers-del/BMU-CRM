# v14 workflows and no-code customisation

Second phase (v14) of `docs/spec/architecture-v2.json`. Runs inside the API and the web app with only PostgreSQL.

## Workflows (`apps/api/src/workflows/`, `packages/shared/src/workflows-types.ts`)

- A workflow is a trigger (the 30+ automation triggers plus six new ones: proposal sent, deliverable approved,
  request reply time 75% gone, renewal due, offboarding started, website form filled in), optional start checks
  (all / any), and a tree of steps:
  - **Do something**: every automation action, plus score the lead, send a WhatsApp, change a status, set a custom
    field, hand over open work.
  - **If / else**: checks on the trigger's fields (as they were when the run started), live record facts
    (`record.*`, read fresh each time) and custom fields (`custom.<entity>.<key>`). Two paths.
  - **Wait** (minutes, hours, days, working days) and **Wait until** a date on the record (± days).
  - **Ask for approval**: an Approval request for a role or person; Approved and "Rejected or no answer" paths.
  - **Stop**.
- `compileWorkflow()` flattens the tree into a list of instructions with jumps. A run stores its position (`pc`),
  status, `wakeAt` and approval id in `WorkflowRun`, so waits survive restarts. Every step done is a
  `WorkflowRunStep` row (the run log).
- Every save that changes something is a new `WorkflowVersion`. A run keeps the version it started on.
- Engine (`engine.ts`): `tick(now)` starts runs for new matching records (each record once per workflow) and moves
  due runs along, at most 50 steps per run per tick, with a row lock so two API processes never run the same step.
  It ticks every 30 seconds and 3 seconds after any change. Tests drive it with a simulated clock.
  Switch timers off with `WORKFLOWS_DISABLED=1` (also off under tests).
- Move older automations with **Move them into workflows** on the Workflows page: each rule becomes a workflow, its
  history comes along (so records are never handled twice) and the rule is switched off.
- Seven templates: new lead, proposal chase 3/7 days, approved creative to Scheduled, overdue invoice day
  1/7/14/30 (with a Founder approval to pause work), request reply time 75%/100%, renewal 30 days out,
  offboarding handover.

Screens: Command Centre → Flow → **Workflows** (list, templates, visual builder with + inserts, test against
current data, versions, per-step counts) and **Workflow Runs** (filters, run details drawer with the outline,
what happened and Stop). Records with runs show a **Workflows** box (lead, project, request pages).

## Custom fields (`apps/api/src/customise/custom-fields.service.ts`)

- Founder/Admin add fields to leads, clients, projects, requests and creators: short/long text, number, amount,
  date, pick from a list, yes/no. Stored as JSON `customFields` on each record. Archive keeps the values.
- Record pages show **More details**; people who can change the record fill them in.
- Lead board: **Filter by a custom field**, also from a link `/team/leads?cf.<key>=<value>`. API list filter
  `GET /leads?cf.<key>=<value>`.
- Dashboard Studio: **Custom fields** widget group ("Leads by industry"), bars link to the filtered board.
- Workflows: checks and "Set a custom field".

## Forms (`apps/api/src/customise/forms.service.ts`)

- Command Centre → Customise → **Forms** (Founder, Admins, sales managers): questions that fill the lead (name,
  email, phone, business, budget, services, need) and your own questions, saved to a lead custom field or the
  lead's notes. Live preview, share link `/f/<slug>`, and website code (an iframe plus a script that resizes it).
- `GET /public/forms/:slug`, `POST /public/forms/:slug/submit` need no sign-in. A hidden trap field drops bots;
  5 submissions per form per connection in 10 minutes. The API trusts the forwarded-for header from the website
  on the same machine (`trust proxy loopback`) so each visitor is counted separately.
- Each submission is a lead (duplicate check, first-reply timer) and starts "A new lead comes in" and "A website
  form is filled in" workflows.

## Pipelines (`apps/api/src/customise/pipelines.service.ts`)

- Command Centre → Customise → **Pipeline Settings** (Founder/Admin): rename, reorder and hide lead stages,
  project phases and request statuses; time targets; fields a lead must have before it enters a stage (checked on
  every move, single or bulk). Won and Lost can't be hidden. The stage keys never change, so reports and rules keep
  working. The lead board uses the names, order and targets ("12 days in stage (target 7)").

## WhatsApp queue

"Send a WhatsApp" steps queue messages (`WhatsAppMessage`). Until WhatsApp Business is connected they are listed
on Outbox → **WhatsApp queue**, with a wa.me link to send from a phone.

## Tests

- API: `apps/api/test/workflows.e2e-spec.ts` (overdue flow day 1/7/14 on a simulated clock with an API restart
  mid-wait, approvals, versions, moving automations, custom fields in filter/dashboard/workflow, forms, pipelines).
- Browser: `apps/web/e2e/workflows/workflows.mjs`.
