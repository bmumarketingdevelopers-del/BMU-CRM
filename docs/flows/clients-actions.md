# Clients and requests actions (v11 clients)

v11 lets the team add, change, reassign, pause and close client accounts from the screen they are on, without a
proposal or a lead. This part, "clients", builds:

1. **Clients**: add a client by hand, migrate an existing client at its current gates, edit details (each role edits
   only its own fields), invite client users, add brands and locations, reassign the Client Manager, add a service,
   change a tier, pause a service, offboard a client and override health.
2. **Requests**: raise a request for a client, reassign it, quote a custom-priced add-on (with a limit), turn an
   approved request into tasks, and ask a colleague for an internal approval.

- API rules and permissions: `apps/api/test/clients-actions.e2e-spec.ts` (27 tests).
- Browser journeys: `apps/web/e2e/clients-actions/*.mjs`. Run each one with
  `BASE_URL=http://localhost:3321 node apps/web/e2e/clients-actions/manual-client.mjs`. The other scripts are
  `migrated-client.mjs`, `am-reassign.mjs` and `forbidden.mjs`. Screenshots go to `/tmp/claude-0/clients-shots/`.

## Where to find it

### + New (top right)
- **Client**: Founder, Admin, Sales Manager, CM Lead.
- **Request**: CM (own clients), CM Lead, Admin, Founder. Raised for the client.
- **Engagement**: CM, CM Lead, Sales Manager, Admin. Sends the client a quote for a new service.
- **Approval**: any team member. Asks one named person to approve something by a date.

### Clients list (Client 360 in the sidebar; Clients in the Command Centre)
- **+ Add**, **Migrate existing client**, **Import CSV** (Founder, Admin, CM Lead).
- Search (name, contact, phone, email, CM), filters (status, health, Client Manager, industry, branch, tag),
  **Current / Archived**, **Views** (saved filters) and **Export CSV**.
- Tick clients for the bulk bar: **Reassign CM** (CM Lead, Admin), **Tag**, **Archive** / **Restore** (with a
  reason, Undo for 10 minutes) and **Export**.
- With no clients yet the list says "No clients yet" with an **Add client** button.
- CMs see only their own clients (plus clients they handed over in the last 7 days, read only).

### Client 360 (open a client)
- Header: health, **Payment pending**, **Migrated** and **Archived** badges; **+ Add** (Task, Request, Service,
  User, Brand or location, Note), **Edit**, **Reassign CM** and **⋯** (Set health, Ask for approval, View history,
  Offboard client, Archive/Restore). Buttons appear only for people who may use them.
- Tabs (the URL keeps `?tab=`): Overview, Services, Work, Requests, Users, Brands, Notes, Billing, History.
  Every tab has its own **+ Add**.
- **Services** tab: each service has **⋯** with Open project, Add task, Raise request, Change tier, Pause /
  Resume and (migrated services only) Set current gate. Quotes are listed underneath with **Send to client** and
  **Cancel**.
- **Users** tab: invite a user; Owners invited by the CM wait for the client's Owner (or an Admin) to confirm.
- **History** tab: who has been the Client Manager (with handover notes) and the full audit trail.
- When a client is being offboarded, the checklist appears at the top.

### Requests inbox
- **+ Raise request** at the top.
- On a request, the **Handling** card shows who handles it, when the client needs it and whether the team raised
  it, with **Reassign**, **Convert to tasks**, **Custom price** and **Ask for approval**.

### Client app
- **Settings → Account and services** (`/client/settings`): main contact (Owner edits; the CM is told), the
  Client Manager, brands and locations (Owner adds), services with **Ask for a service** and **Change plan**,
  quotes to **Approve** / **Decline** and pay, Owners waiting for confirmation, and the "confirm you have received
  everything" step when the account is closed.

## The rules

### Adding a client by hand
- Fields: business name, primary contact (name, phone, email), industry, billing name, GSTIN (optional, format
  checked, e.g. 29ABCDE1234F1Z5), billing address, branch. Optional: brands, services from the live price book,
  handover note, client users to invite now (or later).
- **Duplicates**: the form checks GSTIN, phone, email and business name as you type. On a match you choose
  **Merge into this client** (empty fields there are filled, the new services, brands and users are added) or
  **Continue: it's a different client**. The API refuses a duplicate (409) without one of the two.
- **Client Manager**: suggested by fewest active services and lowest load, preferring someone who already looks
  after that industry ("Best fit"). You can pick anyone.
- **New onboarding**: each service starts at G1 with its requirement checklist and the client's conversation thread.
- **Payment**: online (the first invoice is paid in the client app) or offline (bank, UPI or cheque, with a
  reference). Offline payment creates an approval for **Finance**. Until the payment is confirmed (paid online or
  approved by Finance) the service shows "Waiting for first payment" and **cannot pass Gate 1**. If Finance rejects,
  the CM is told and the hold stays.
- Notified: the CM (with the handover note), CM Leads and Finance. Invited users get a welcome message from their CM
  in Messages.
- An Owner invited by the CM on an account that already has an Owner is not added until that Owner (or an Admin)
  confirms.

### Migrating an existing client
- Founder, Admin, CM Lead or Sales Manager. Sales steps are skipped; a reason is required.
- Each service is set at its current gate with a reason. Earlier gates are recorded as approved and marked
  **migrated** (not a real client sign-off). No payment hold.
- Past invoices can be added (now, or later by Finance or leadership) and are marked migrated.
- The CM can later move a migrated service's gate (with a reason). New services only move through real work.

### Editing
- CM (own clients) and CM Lead: contact details and industry. Finance: billing fields. Admin and Founder: everything.
- A field you may not change is refused with its name ("You can't change billing name"). Every edit is audited and
  can be undone for 10 minutes.
- The client's Owner edits their own contact details in Settings; the CM is notified. Billing details stay on the
  Billing page.

### Reassigning the Client Manager
- CM Lead, Admin or Founder only, from Client 360 or the bulk bar, through the shared reassignment dialog (reason,
  handover note required).
- The client's open services move to the new CM. The client gets an introduction message from the new CM in
  Messages and a notification. The handover note stays internal.
- The previous CM keeps read-only access for 7 days ("You handed this client over"), then loses it.

### Add a service, change a tier
- CM / Sales Manager / Admin sends a quote from the live price book (or the client's Owner asks for one in Settings
  and the CM sends it).
- The Owner approves in writing in the app. Anything to pay now (a month in advance for retainers, half for
  projects, or the pro-rata difference for an upgrade "now") becomes an invoice; once it is paid the change applies.
  A new service opens at G1 with its onboarding checklist.
- Tier changes apply from the next cycle by default; upgrades can start now with a pro-rata charge. Downgrades are
  next cycle only and tell the CM Lead.

### Pausing a service
- The CM asks with a reason and an end date; the CM Lead approves (CM Lead and Admin pause directly).
- While paused: open tasks wait and their deadlines and deliverable due dates are cleared (clocks stop); no invoices
  are raised for the service. On resume (by hand or automatically on the end date) everything is restored and the
  dates move forward by the working days the service was paused.

### Offboarding a client
- CM Lead or Admin starts it with a reason and the last cycle; an Admin approves.
- Checklist: dues cleared (checked against unpaid invoices), final files, our access removed, client logins and
  permissions reviewed, final report, pending work, contract closed.
- Then the client's Owner confirms receipt in Settings. The account closes: client users keep **read-only** access
  for 90 days (they can view and download; any change is refused), then the account is archived.

### Health
- The CM (own clients) and CM Lead can override health with a reason. "At risk" tells the CM Leads.

### Requests
- **Raise on behalf**: CM (own clients) or leadership, with type, description, when it is needed and links. The
  client sees it in their app and their decision makers are notified. The CM is the assignee.
- **Reassign**: the request's assignee can be changed through the shared dialog (target `request`). Eligible: CMs,
  CM Leads, Department Heads, strategists. Moving it to someone above 120% of capacity needs Department Head
  approval (core rule).
- **Custom-priced add-on**: up to ₹25,000 the CM sends it; above that an Admin approves first.
- **Convert to tasks**: only once the request is decided (in scope) or, for extra work, approved and paid. The
  drawer suggests lines from the matching flow template with owner, department and deadline; work before G3 is
  marked pre-production and extra work is marked out of scope.
- **Internal approval**: pick the person and the date; it lands in their "Needs you".

## For other areas
- `ClientsCreateService.createClientFromLead(me, leadId, input, ip)` (exported from `ClientsActionsModule`) and
  `POST /clients-actions/from-lead/:leadId` (shared client: `api.clientsActions.fromLead`). Sales Manager, Founder
  or Admin. Uses the lead's contact; services from the live price book; payment proof reference required, so Finance
  confirms the payment and Gate 1 waits for it. The lead is marked won. The lead page button itself is left to the
  leads area.
- Reassign targets registered: `client_am` and `request`. Approval actions: `clients.confirm_payment`,
  `clients.owner_invite`, `clients.pause`, `clients.offboard`, `clients.custom_quote`, `clients.internal`.
  Import entity: `clients`. Archive entity: `client`.
