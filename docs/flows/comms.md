# v17 Client portal 2.0 and communications

Fifth phase (v17) of `docs/spec/architecture-v2.json`. Runs inside the API with only PostgreSQL. WhatsApp goes out
only when `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are set (otherwise messages wait in the WhatsApp queue). Incoming
WhatsApp and email arrive through webhooks. Gmail sign-in sync, Google/Outlook calendar sync, a custom portal domain
and phone push notifications are not built yet.

Code: `apps/api/src/comms/`, `packages/shared/src/comms-types.ts`, `packages/shared/src/api/comms.ts`,
`apps/web/src/components/comms/`. Migration `20261004220000_v17_portal_comms`.

## Shared inbox (`inbox.service.ts`, `inbox.controller.ts`)

- `Conversation` is one per `(org, channel, address)`; WhatsApp addresses are the last 10 digits of the number, email
  addresses are lower-cased. `ConversationMessage` rows are `in` or `out`; `externalId` (Meta's message id or the
  email Message-ID) is unique per organisation, so a webhook retried by Meta is stored once.
- Matching a new sender, in order: a client person by phone (ends with the 10 digits) or email; a lead by contact
  phone or email (a won lead counts as its client); a client's primary contact or billing email. Unknown senders stay
  unlinked and unassigned.
- New conversations are assigned to the client's Client Manager or the lead's owner. The assignee (or Founder and
  Admin when nobody is) gets an `inbox_message` notification linking to `/team/inbox?c=<id>`.
- A known client person's message is also written on the client's `client_am` thread as a `Message` by that person,
  with `source` = `whatsapp` or `email`, so the client portal and Client 360 show it. Replies are mirrored there too.
  A lead's messages and replies are logged as lead activity.
- Who sees what: Founder, Admin, CM lead and Sales manager see everything. Client Managers and Sales executives see
  conversations assigned to them, unassigned ones, their clients' and their leads'. Other roles have no inbox.
- Replies: WhatsApp through `WhatsAppSender` (status `queued` without keys, `sent` or `failed` with Meta's reason);
  email through the outbox with a `Re:` subject (`sent` with SMTP, otherwise `simulated`).
- Templates (`ReplyTemplate`) use `{{first_name}}`, `{{name}}`, `{{client}}`, `{{am}}`, `{{my_name}}`,
  `{{portal_link}}`; the web fills them from the conversation's `variables`.
- **Draft a reply** uses the AI feature `reply_suggest` (basic polite reply without a key).
- **Simulator** (`POST /inbox/simulate`): development only, Founder and Admin. Runs the same code as the webhooks.

### Webhooks (no sign-in)

- `GET /webhooks/whatsapp`: Meta's verify call; answers `hub.challenge` when `hub.verify_token` matches
  `WHATSAPP_VERIFY_TOKEN`.
- `POST /webhooks/whatsapp`: Meta's format (`entry[].changes[].value.messages[]` with `contacts[].profile.name`).
  With `WHATSAPP_APP_SECRET` set, the `X-Hub-Signature-256` HMAC of the raw body must match; on a live server
  (`NODE_ENV=production`) unsigned calls are refused.
- `POST /webhooks/email`: `{ from, fromName?, subject?, text, messageId? }` with header `X-BMU-Webhook-Secret` equal to
  `INBOUND_EMAIL_SECRET` (off until that is set). Any mail service that can forward as JSON can post here.

## One-tap approval from WhatsApp

v16 proof links already carried `channel = whatsapp`. v17 sends the WhatsApp copy through `WhatsAppSender` (really
sent when keys are set). Approving from the link calls the same `clientApprove` as the portal: the client review task
completes, the work moves on, and the round records `via: whatsapp`.

## Collaborative documents (`docs.service.ts`, `doc-editor.tsx`)

- `CollabDoc` stores the Yjs document (`state`), a plain copy of the text (`text`, for lists and search) and a
  `version` counter. Kinds: brief, proposal draft, notes. Linked to a client, a project and/or a lead.
- Editing: the browser keeps its own `Y.Doc`. Each keystroke batch becomes a Yjs update; the editor sends it
  (`POST /docs/:id/edit { update, sv }`) and the server applies it to the stored state inside a per-document queue, so
  two saves never overwrite each other, then returns what that browser is missing for its state vector. Others' edits
  arrive by `POST /docs/:id/pull { sv }` on live `CollabDoc` changes and a 1.5 s poll while the page is visible. The
  textarea applies the smallest insert/delete for each change and keeps the cursor with Yjs relative positions.
- Access: team members who work on the client (same rule as the asset library), the lead's owner or Sales leadership
  for lead documents, and the author. Clients see only documents shared with them (`clientVisible`) for their own
  company; client viewers and finance can read but not edit. Only the author or leadership archive.
- The project page has **Start a shared brief** (a brief outline) and lists the project's documents.
- Limits: plain text (no rich formatting yet); 200,000 characters per document; the edit queue is per API process
  (one API server).

## Meetings (`meetings.service.ts`, `meetings.tsx`)

- `BookingPage` per team member (created on first use): title, call length 15/30/45/60, days (1 = Monday), start and
  end time (IST), minimum notice in hours, on/off. Public link `/book/<slug>`.
- Free slots: the next 14 days in IST on the chosen days and hours, minus booked meetings, approved leave and the
  notice period. Booking re-checks the slot, so two people cannot take the same time.
- Client booking (`/client/meetings`): with their Client Manager; viewers cannot book. Public booking: links an open
  lead with the same email or phone, or creates one (`source: booking`, owner = the host); a known client person is
  booked against their company. At most 3 upcoming public bookings per email.
- Emails: confirmation with **Add to calendar** (a signed `.ics` link, `/public/meetings/:id/ics?t=…`), a reminder one
  hour before (host in the app, guest by email) and a cancellation email when the team cancels.
- After the call: notes (team only), **Summarise** (AI `meeting_notes`, or simple rules: lines like `- [ ] …`,
  `Action: …`, `X will …`), a summary the client can see, action items, **Make tasks** (owner = host; the client's
  active project when there is one; due in 2 days) and **Save and mark held** (logged on the lead when linked).

### v23 Google Meet (`integrations/google-calendar.ts`)

- Each person connects their own Google Workspace calendar once (**Meetings → Connect Google Calendar**). Scopes:
  `openid`, `email`, `calendar.events`. The sign-in returns through `/integrations/oauth/callback` (state `k: 'calendar'`),
  so the Google OAuth client needs one redirect URI. Tokens are sealed with `INTEGRATIONS_KEY` in `calendar_connections`.
- When a meeting the host hosts becomes **booked** (a client request the Client Manager fixes, a meeting the team adds
  with **Add a Google Meet link**, a portal or booking-link call) it becomes an event in the host's Google Calendar with
  a Meet link, saved in `joinUrl`; Google emails the invitations (`sendUpdates=all`). Invited: team participants who
  are not "ignored" and the client's people / guest (`meeting_attendees`: the person who asked, else every client user).
- Team members added later (Department Head, the team form) are added to the event and a Branch Manager who ignores is
  removed; replies already given are kept. Cancelling cancels the event. Replies are read every 15 minutes
  (`comms.meeting_replies`) into `meeting_attendees.response` and `meeting_participants.googleResponse`.
- Never blocks the meeting: without a connected calendar (or when Google refuses) the reason is in `googleError`, the
  team sees it, and the Client Manager can still paste a link (**Send link to everyone**), which also replaces a Meet link.
- Setup: Google Calendar API on, consent screen **Internal**, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `INTEGRATIONS_KEY`, `API_PUBLIC_URL`. Migrations `20261014090000_v23_google_meet`, `20261015090000_v23_google_meet_merge`.
  Tests: `test/google-meet.e2e-spec.ts` (fake Google), `src/integrations/google-calendar.spec.ts`.

## Notification router (`notifications.service.ts`, `comms/notification-router.ts`)

- Per alert type each person chooses in-app, email and (v17) WhatsApp (needs a phone number on their profile).
- `NotificationSetting`: quiet hours (IST, may cross midnight) and digest (`off` / `daily` at an hour 6 to 22).
- During quiet hours, emails and WhatsApp alerts are stored as `NotificationDelivery` (`reason: quiet`) and sent when
  quiet hours end. With the daily digest on, plain emails are stored (`reason: digest`) and sent as one email at the
  chosen hour. In-app notices always show at once.
- Never held back: critical notices, money and approval alerts (invoice issued, payment reminder, quote ready,
  payment received, extra request paid, quote decision), emails forced by a feature, and custom emails (e.g. review
  links with buttons).
- The same unread in-app notice (same kind, title, text and link) is not repeated within 10 minutes.
- A one-minute timer sends due deliveries (off in tests and with `AUTOMATIONS_DISABLED=1`). Deliveries are claimed
  before sending so nothing goes twice.
- New alert types: `inbox_message` and `meeting` (team), `doc_shared` (client).

## Client portal 2.0

- Home: **Your Client Manager** card adds **Book a call**, the next call and shared documents.
- Menu: **Meetings** and **Documents** added; **Billing** only for client owners and client finance.
- Live timeline, approvals, results and requests were built in earlier phases (v9 journey, v16 proofing and results)
  and update live.

## Tests

- API: `apps/api/test/comms.e2e-spec.ts` (inbox matching, threads, replies, webhooks and secrets, WhatsApp approval,
  two concurrent editors, meetings, quiet hours and digest).
- Browser: `apps/web/e2e/comms/comms.mjs` (WhatsApp in → inbox and client thread → template reply; CM and client
  typing in the same brief at once; client booking; notes to tasks; public booking; notification settings).
