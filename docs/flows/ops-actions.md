# Leads, finance, creators, files, communication and admin actions (v11 ops)

This part, "ops", plugs the leads and sales, finance, creators, files, communication and admin configuration areas
into the v11 shared action system (+ New, the ⋯ row menu, drawers, the reassignment engine, approvals, Undo, saved
views, archive and CSV import). Every action is checked again on the server for role and scope. Each one writes an
audit entry and sends the right notifications. Errors are in plain English.

- API rules and permissions: `apps/api/test/ops-actions.e2e-spec.ts` (38 tests).
- Browser journeys: `apps/web/e2e/ops-actions/*.mjs`. Run each one with
  `BASE_URL=http://localhost:3000 node apps/web/e2e/ops-actions/leads.mjs`.
  - The other scripts are `finance.mjs`, `creators-files.mjs` and `comms-admin.mjs`.
  - Every script includes forbidden-role checks and a 390px check.
  - Screenshots go to `/tmp/claude-0/ops-shots/`.
- Shared types: `packages/shared/src/ops-actions.ts`. Client methods: `packages/shared/src/api/ops-actions.ts`
  (`api.ops.*`). API: `apps/api/src/ops-actions/`, all routes under `/ops`.
- Schema: migration `20261003172000_v11_ops`. It is additive only:
  - New fields on Lead, Creator, File, Payment, Invoice, Thread and Request.
  - New tables OpsCreatorRating, OpsShareLink, OpsAnnouncement and OpsIntegration.

## + New entries added here

| Entry | Who sees it | Drawer |
| --- | --- | --- |
| Lead | Founder, Admin, Sales Manager, Sales Executive, Client Manager (referrals only) | `components/ops/lead-drawer.tsx` |
| Invoice | Founder, Admin, Finance | `components/ops/invoice-drawer.tsx` |
| File upload | All staff | `components/ops/file-upload-drawer.tsx` |
| Creator | Founder, Admin, CM Lead, Client Manager, Department Head | `components/ops/creator-drawer.tsx` |
| Announcement | Founder, Admin | `components/ops/announcement-drawer.tsx` |

**Note** and **Meeting** (core entries) can now be about a **lead** as well as a client. Sales roles see them too.

## Leads and sales (`/team/leads`, `/admin/pipeline`, `/team/leads/:id`)

### Adding a lead
- Three ways in:
  - **+ Add lead** in the toolbar.
  - **+ Add** on each open column of the board. The new lead is moved into that stage.
  - **+ New → Lead**.
- Required: contact name, mobile, business name, source and at least one service.
- The duplicate check runs **live** on mobile and email. If the server still finds a match, it refuses the save until
  you choose **Add anyway**.
- Owner:
  - Managers pick **Auto (round-robin)** or a person.
  - Executives get the lead themselves, or pick **Auto**.
  - The owner is notified straight away.
- **First-reply timer.** The deadline is set from the SLA settings, in working hours. The first logged conversation
  stops the timer. A job runs every 10 minutes. When a reply is overdue, it alerts the owner and the sales managers once.
- Client managers see **Add a referral**. The source is fixed to referral and the lead goes to round-robin.

### Lead ⋯ menu (board cards, list rows and the lead page)
- **Reassign owner** uses the engine's dialog (target `lead_owner`; a reason is required).
- **Add note or meeting.**
- **New proposal.** **Revise** sits next to the latest proposal on the lead page.
- **Make client (payment received)**: the proposal, amount, method, reference and date, plus a **payment proof upload**.
- **Merge into another lead.**
- **Mark lost** needs a reason (common reasons are offered).
- **History.**
- **Archive** needs a reason and can be undone.

### List view
- Checkboxes and a bulk bar:
  - Move to stage.
  - Reassign.
  - Tag.
  - Mark lost (with a reason).
  - Archive (with a reason).
- **Export** (CSV of what is shown), **Import CSV** (entity `leads`, managers only) and **saved views**.

### Activity rules and History
- A call, meeting, WhatsApp or email needs its **outcome**.
- It also needs the **next follow-up**, unless the lead is not interested.
- The lead page shows the **History** tab (audit trail).

### Manual convert to client: how it is wired
- **Web.** The only call site is `apps/web/src/components/ops/lead-convert.ts` (`convertLeadToClient`). It calls
  `POST /ops/leads/:id/convert`.
- **Approval.** Sales Manager, Founder and Admin may convert. The request becomes a `lead.convert` approval for
  Finance.
- **API.** When Finance approves, `apps/api/src/ops-actions/ops-convert.ts` runs, and it is the only server call site:
  1. It accepts a sent proposal offline.
  2. It calls `OnboardingService.recordFirstPayment`.
  3. It links the proof to the payment.
- **Merge note.** The clients area exposes `POST /clients-actions/from-lead/:leadId` (`api.clientsActions.fromLead`).
  When the branches are merged, point `convertLeadToClient` (web) and `opsCreateClientFromLead` (API) at that
  service. Nothing else needs to change.

## Finance (`/admin/finance/invoices`)

- **+ New invoice**:
  - Client, optional service, due date and lines.
  - **Service lines** carry GST. **Ad spend**, **creator fee** and other pass-through lines are billed at cost with no
    GST, on separate lines.
  - The totals footer shows the split.
  - **Save as draft** or **Issue invoice**. Issuing emails the client's owner and finance contacts.
- **Drafts** appear in their own panel on the invoices page, with **Issue**.
- The invoices list has:
  - Search and filters, saved views and **Export**.
  - Checkboxes with **Send reminders**.
  - A row menu: Open, Change due date, Send payment reminder, Record a payment, Print/PDF, History.
- **Change due date**:
  - A reason is always required.
  - A move of up to 7 days applies at once and can be undone.
  - A longer move becomes an `invoice.due_extension` approval for an Admin.
- **Record a payment** (offline) now needs a **proof upload**. The route is `POST /ops/finance/invoices/:id/offline-payment`.
  The older `/finance/invoices/:id/payments` route still accepts payments without proof, because older tests and
  scripts use it.
- **Credit note.** A credit note raised by Finance becomes an `invoice.credit_note` approval for an Admin. A credit
  note raised by an Admin or Founder applies directly.
- **Creator payout**:
  - The coordinator proposes it from the brief page (**Propose the payout**). This creates a `payout.create` approval
    for Finance.
  - When Finance proposes it, it is booked directly.
  - TDS is 10%.

## Creators (`/team/creators`, `/team/creators/:id`, `/team/creators/briefs/:id`)

- **+ Add creator** with name, mobile, handle, niche, city and rates.
  - The same mobile or email is refused.
  - A handle that is already used asks you to confirm (**Add anyway**).
  - The creator signs in with that mobile.
- **Import CSV**: entity `creators`.
- The roster has search, niche, city and rating filters, saved views, **Export**, bulk **Archive** (with a reason) and
  a row menu.
- Archive is refused while the creator has open briefs.
- The creator page shows profile, briefs, ratings, **Edit**, Archive and **History**.
- Brief page:
  - **Move to another creator**: engine target `creator_brief`, creators only.
  - **Rate creator** after delivery: 1 to 5 stars and a note, once per brief.
  - **Propose the payout.**
- Department heads now see the roster. Briefs stay with Client Managers.

## Files (`/team/files`, client and project pages, `/client/files`, `/s/:token`)

- Files are grouped by folder: **From client**, **Working files**, **Final files**, **Brand assets** and **General**.
- Uploading:
  - **+ Upload**, **+ New → File upload**, or **Upload files** on Client 360 and project pages.
  - The client and project are filled in when you start from those pages.
- Row menu:
  - Open.
  - **Move, rename or tag.**
  - **Release to client.** Only for final files, and only after Gate 5 has passed on the file's project. Otherwise the
    menu explains why it is blocked.
  - **Share link.**
  - History.
  - Archive.
- Bulk actions: move to a folder, tag, archive. **Export** and **saved views** are also available.
- **Share links**:
  - Expire after 1 to 90 days, with an optional password.
  - Can be revoked.
  - Each link counts its views.
- **Public page** `/s/:token`:
  - Shows the file and its expiry, and asks for the password when one is set.
  - Password tries are limited to 8 every 15 minutes.
  - Expired or revoked links say so plainly.
- **Client uploads** (`/client/files`, Send us files):
  - Files land in **From client**.
  - They tick the chosen checklist item, or the items whose tags match, as received.
  - The Client Manager is told.
  - Clients see their uploads plus the brand and final files released to them.

## Communication (`/team/discussions`, `/team/messages`)

- **Start discussion** (also on the Messages page):
  - A **project** discussion: the client's team on that project can read and reply.
  - An **internal** discussion: only the people you add, plus leadership.
- On the message ⋯ menu:
  - **Create task** reuses the core task drawer, pre-filled.
  - **Create request** (CM and leadership) picks the service and type and uses the SLA from settings. A message can
    become only one request. An internal note is posted in the thread.
- **+ New → Announcement** (Founder and Admin only):
  - Audience: all clients, a client segment (by service or health), all team, or one department.
  - Channels: in-app notice, email, or both. Email goes through the Outbox.
  - Before sending, it asks you to confirm and shows the recipient count.

## Admin configuration

- **Price book** stays Founder-only (verified).
- **SOPs**: a department head's new SOP is saved as a draft. Publishing it, or changing a live SOP, creates a
  `sop.publish` approval for an Admin. The page shows "Sent to an Admin to publish".
- **Flow and QC templates**: saves by anyone other than a Founder or Admin become `template.flow_publish` or
  `template.qc_publish` approvals. The current version stays live until then.
- **Holidays and working hours**: saving them recalculates open deadlines:
  - Lead first-reply timers.
  - Request SLAs.
  - Open tasks that now fall on a day off. These move to the next working time.
- **Notification templates**: each alert has a **WhatsApp (Meta)** status (not submitted, waiting, approved or
  rejected). WhatsApp can only be turned on once Meta has approved the template; the server checks this too.
- **Integrations**: a **Connect or disconnect** panel for Founder and Admin.
  - A service can be connected only when its keys are on the server.
  - Disconnecting needs a reason.
  - Client account connections (Meta Ads, Google Ads, Instagram and others, with the client's consent) are available
    through `api.ops.admin.*Account*`.

## Mobile

- Team: the floating **+** (on every tab) adds **Photo or video**. You pick a client, an optional project and a
  folder, then choose from the library or use the camera (`expo-image-picker`).
- Clients: a floating **+** on every client tab offers **Request** and **Photo or video**. The photo or video lands in
  From client.

## Approvals added

| Action | Approver |
| --- | --- |
| `lead.convert` | Finance |
| `invoice.due_extension` (more than 7 days) | Admin |
| `invoice.credit_note` (raised by Finance) | Admin |
| `payout.create` (proposed by the coordinator) | Finance |
| `sop.publish` | Admin |
| `template.flow_publish`, `template.qc_publish` | Admin |

## Reassign, import and archive registrations

- Reassign targets:
  - `lead_owner` (sales team).
  - `creator_brief` (creators). The engine's `userTypes` lets a target pick non-staff users.
- Imports: `leads`, `creators`.
- Archive entities: `lead`, `creator`, `file`.
