# Service flows (v10): client desk, messages, notifications, billing, automations

Driven end to end in a real browser as client@sunrise.demo (owner), approver@sunrise.demo, am@bmu.demo,
am.lead@bmu.demo, finance@bmu.demo and admin@bmu.demo. The scripts live in `apps/web/e2e/service/`:

```
BASE_URL=http://localhost:3000 node apps/web/e2e/service/requests-desk.mjs
BASE_URL=http://localhost:3000 node apps/web/e2e/service/messages.mjs
BASE_URL=http://localhost:3000 node apps/web/e2e/service/billing-finance.mjs
BASE_URL=http://localhost:3000 node apps/web/e2e/service/automations.mjs
```

The API side is covered by `apps/api/test/service.e2e-spec.ts`.

## What was tested

**Requests desk**
- Every request type (change, add-on, urgent, question, billing) raised from the client app.
- The team inbox, and reply timers that count working hours only.
- Scope check, a quote built from add-ons and from a Founder custom price, owner approval, payment, the work task, done.
- The client sees the status at every step. The decline and reschedule paths work. An SLA breach shows in the inbox.

**Messages**
- Client to AM and AM to client. Internal notes never reach the client.
- Unread counts in the menu and per conversation. File attachments.
- Same-working-day reply tracking. Bell links open the right page for every notification kind.
- Notification preferences are respected, on both the client profile and the team profile.

**Billing and finance**
- Client Billing page and Pay now (dev test payment; the Razorpay path charges the balance).
- Finance invoice list and detail. A manual payment with a reference, refused when the reference is a duplicate or the amount is too high.
- Partial payments and credit notes. GST summary and CSV exports.
- Collections actions. Phone-width layout.

**Automations**
- Each of the 15 triggers was built through the rule builder, tested against current data and saved.
- A client-request rule (condition, in-app alert, task, internal note, client message, email) ran with Run now. Each action was checked for real: AM bell, AM task list, the client thread (the internal note stays hidden), and the Outbox.
- A lead rule assigned an owner round-robin and moved the stage.
- Webhooks to this computer or a private network are refused; a public address is accepted.
- Checked the run log, the rule history, and switching a rule off and on from the list. Account Managers cannot run or switch rules.

## What was broken and is fixed

- Pay now, the test payment and Razorpay verify charged the full invoice total, ignoring part payments and credit notes. They now charge the balance.
- Manual payments and settling credit notes did not start the paid add-on's work task or Gate 5. All payment routes now share one "invoice paid" event.
- The payment reminder link pointed to a page that does not exist (`/client/invoices`).
- Void invoices showed a Pay button on the client Billing page.
- Notification templates (Command Centre) and personal preferences were never applied. Both now are.
- Chat needed a page reload to show new messages. It now refreshes every 15 seconds, keeps text typed while sending, and puts the text back if sending fails.
- There were no unread counts and no attachments in messages.
- The client-comment notification used the same kind as the team reply, so preferences could not tell them apart.
- The automation "Send an email" action only pretended to send. It now goes through the email Outbox and respects people's email preferences.
- Sign-in codes were only printed to the server log. They are now emailed (or saved to the Outbox, with the code masked).
- `/client/billing` scrolled sideways on a phone.

## What was added

1. **GST tax invoice**: a printable invoice with seller and buyer GSTIN, place of supply, CGST + SGST (or IGST between states), amount in words, payments and credit notes, bank and UPI details. "Save as PDF" uses the print styles. Clients and Finance can edit billing details (client owner or client finance only on the client side). Invoice emails carry the tax invoice.
2. **Dunning**: reminders at 1, 7 and 14 working days late (configurable on Collections). The tone gets firmer each time. Each reminder sends a client message, an email and a Finance + AM alert. Only the latest due step is sent, and reminders stop when the invoice is paid or pause while a promise to pay is pending. Collections can log a promise to pay and send a reminder by hand.
3. **Email Outbox**: real emails through SMTP when `SMTP_*` is set (see `apps/api/.env.example`). Otherwise every email is saved to Command Centre > Platform > Outbox with a preview. Wired in: sign-in codes, invoices, quotes, reminders, draft ready and the automation email action, all respecting templates and preferences.
4. **Ratings**: thumbs up or down plus a comment on done requests. Ratings feed Client Health and the SLA analytics page. A client can reopen a request within 7 days, which puts it back in progress and creates a task.
5. **Billing run** (Finance): preview this month's retainer invoices, then issue all or selected. Duplicates are checked by engagement + month inside a lock, including retainer invoices made at cycle start. Every run is logged.
