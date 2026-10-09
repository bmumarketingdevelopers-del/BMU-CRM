# v18 Finance 2.0 and capacity

Sixth phase (v18) of `docs/spec/architecture-v2.json`. Runs inside the API with only PostgreSQL. Razorpay is live only
when `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are set; otherwise pay links open a test
page (development only). The GST e-invoice (IRN and signed QR from the IRP) needs a GST Suvidha Provider and is not
built. Quotes and contracts are the existing proposals with e-signature and agreements.

Code: `apps/api/src/money/`, `apps/api/src/agents/finance-plan.ts`, `packages/shared/src/finance2-types.ts`,
`packages/shared/src/api/finance2.ts`, `apps/web/src/components/money/`. Migration `20261005090000_v18_finance_capacity`.

## Payment links and reconciliation (`payments-hub.service.ts`)

- `PaymentLink`: one active link per invoice for its open balance. With Razorpay keys it is a Razorpay Payment Link
  (`externalId` = Razorpay's id, `notes.token` and `notes.invoiceId` carry ours); without keys a `test` link whose
  public page `/pay/<token>` has a **test payment** button (refused when `NODE_ENV=production`).
- `POST /webhooks/razorpay` (no sign-in): the `X-Razorpay-Signature` HMAC-SHA256 of the raw body must match
  `RAZORPAY_WEBHOOK_SECRET`. Without the secret, calls are refused in production or when Razorpay keys are set.
  Handles `payment_link.paid` and `payment.captured`.
- Matching, in order: the link's `externalId`, `notes.token`, `notes.invoiceId`, then an order's `razorpayRef`. A
  match calls the normal `recordPayment` (same receipts, balances and notices as a hand-entered payment). Retries are
  stored once (`UnmatchedPayment` is unique per org, provider and reference; payments by reference).
- When the invoice becomes fully paid, its links close and a message is posted on the client's `client_am` thread by
  the Account Manager (or the Founder): "Payment received …: invoice X (₹) is now fully paid. Thank you!".
- Anything that cannot be placed is an `UnmatchedPayment` and Finance is alerted. **Payments to match**
  (`/admin/finance/reconcile`) lists them with suggestions (invoice number in the reference, the payer's email on the
  client, the same amount, the payer's name), **Match** or **Ignore**. Bank credits can be added by hand.
- TDS: a payment can carry `tdsPaise`; it is stored as a second payment with method `tds` (reference `<ref>-tds`), so
  every balance calculation stays the same.

## Invoice plans (`schedules.service.ts`)

- `InvoiceSchedule` rows are instalments (`planned`, `issued`, `skipped`) for a client and optionally a project.
  **Plan instalments** splits a fee by percentages that must add up to 100%; the last part absorbs rounding.
- A 15-minute timer issues due instalments (claimed first so nothing goes twice), emails them and tells service
  billing. Failures stay planned with the error shown. Off in tests and with `AUTOMATIONS_DISABLED=1`.
- Who sees them: Finance, leadership and the client's Account Manager. Finance writes.

## Expenses and vendor bills (`expenses.service.ts`)

- `Expense` kinds: `expense` (anyone on staff claims) and `vendor_bill` (Finance only, approved on entry).
  Status: submitted, approved, rejected (needs a note), paid. Nobody approves their own claim except the Founder.
- GST and TDS amounts are kept; profit uses the amount before GST.
- **Re-bill**: approved billable expenses for a client become one invoice with "Re-billed: …" lines.

## Time tracking (`timer.service.ts`)

- One `ActiveTimer` per person. Starting a new one stops the old one. Stopping logs a `TimeEntry` (`source: timer`),
  minutes rounded (at least 1, at most 12 hours) and adds to the task's logged time. Locked weeks are refused.
- Timer entries on a task cannot be deleted from the timesheet.

## Profit and cash flow (`profit.service.ts`, `cashflow.service.ts`)

- Profit formula (shown on the page):
  - Revenue = invoice amounts before GST in the period minus pass-through lines minus credit notes.
  - Team cost = time entry hours × the person's highest role cost rate × (1 + overhead %).
  - Creator payouts for the client's briefs; approved or paid client expenses before GST.
  - Profit = Revenue − Team cost − Creator payouts − Expenses. Breakdowns by client, project, service and person.
- Cash flow, 13 weeks from today. In: open invoice balances on their due date plus that client's average days late;
  planned instalments paid a week after issue plus the same lateness. Out: approved expenses and bills, pending
  creator payouts, payroll and overheads on the 1st of each month. Opening balance, payroll and overheads are the
  `cashflow` settings section (edited on the page).

## Capacity (`capacity.service.ts`)

- `User.weeklyHours` (default 45). Available hours in a week = weekly hours ÷ working days × (open days − approved
  leave days); holidays come from the holiday calendar and settings.
- Load = `ResourceBooking` hours + open task estimates (2 hours when a task has none; overdue tasks count this week).
- `ResourceBooking`: a person or a skill (`specialty`, status `requested`) on a project for a week (Monday) with
  hours. Booking several weeks skips refused weeks and says which.
- Refusals: "X is on approved leave that week (approved leave …)" or "X has only N of M hours free that week".
- Who books: Founder, Admin, AM lead, department heads, producers, Account Managers. Weekly hours: Founder, Admin,
  HR, department heads.
- **Workload** (`/team/workload`, admin menu too): six-week heatmap (amber over 100%, red over 120%), skill requests,
  bookings, **Who is free?** suggestions.

## Agents

- **Finance collector** (`finance_collector`): daily; proposes `match_payment` for unmatched payments with a strong
  suggestion and `send_payment_reminder` for overdue invoices (both need approval, money and client-facing), and
  notifies Finance about unbilled billable expenses and projects over budget.
- **Producer**: new action `book_person` (needs approval). Its check runs the same refusal rules, so a booking for
  someone on approved leave is blocked. Bookings can be undone from the run log. Eval `no_booking_on_leave` proves it.

## Tests

- API: `apps/api/test/finance.e2e-spec.ts` (Razorpay webhook paid → client thread once, signature, unmatched and
  match, TDS, instalments, expenses and re-bill, timer, profit equals a hand calculation, cash flow, leave refusal).
- Agents: `apps/api/test/agents.e2e-spec.ts` (9 evals including `no_booking_on_leave`).
- Browser: `apps/web/e2e/finance/finance.mjs` (pay link → test payment → client thread; reconcile; expense →
  re-bill; 50/30/20 plan; profit and cash flow; stopwatch; booking and leave refusal).
