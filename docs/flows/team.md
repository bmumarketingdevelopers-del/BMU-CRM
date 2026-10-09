# Team area: people, organisation, settings, catalogue, templates, creators, analytics, sign-in, mobile

Area owner: the "team" flow builder (v10). Everything below was clicked through as real users in a real browser
(Playwright) and is also covered by API tests.

## How to re-run the checks

API tests (from `apps/api`): `npx vitest run --config ./vitest.config.e2e.ts test/team.e2e-spec.ts`

Browser journeys (start the API and web first, then from the repo root):

| Script | What it drives |
| --- | --- |
| `node apps/web/e2e/team/sign-in.mjs` | Every role by email, phone codes, wrong code, unknown email, session expiry, off-site `next` links, client kept out of the Command Centre, client app branding, OWNER_EMAIL (set `OWNER_EMAIL`) |
| `node apps/web/e2e/team/admin.mjs` | Invite, edit, permission matrix, clone role, suspend/restore, departments, branches, every settings page, holidays and working days, catalogue, SOP draft/publish/read, flow template and QC editors, DPDP export (set `DATABASE_URL` so it cleans up after itself) |
| `node apps/web/e2e/team/people.mjs` | Leave chain, attendance check-in, cover, timesheet submit/return/approve, who's out, onboarding and offboarding |
| `node apps/web/e2e/team/creators.mjs` | Brief, accept, submit, revision, approve, payout with TDS, finance pays, creator sees it; a declined brief |
| `node apps/web/e2e/team/analytics.mjs` | Every analytics page through every period, every CSV export opened and checked, report builder save/pin/share/delete |
| `node apps/web/e2e/team/search-activity.mjs` | Ctrl/Cmd+K search with the keyboard, results limited by permission, activity feeds on client, lead, engagement and invoice pages |
| `node apps/web/e2e/team/crawl.mjs` | Opens every page as each role and reports crashes, server errors and error text |

Set `BASE_URL` (default `http://localhost:3000`).

## What was broken and is now fixed

- **Phone sign-in:** none of the demo accounts had a mobile number, so phone codes could not be tried. Demo phones are now seeded: founder +91 98000 00001, admin 02, hr 03, design.head 04, am.lead 05, producer 06, finance 07, am 08, creator 09, client 10.
- **Session expiry:** an expired session left pages showing errors.
  - Web: now goes to sign-in with "Your session has ended" and returns you to the same page afterwards. A link that points to another website is ignored.
  - Mobile: now goes back to the sign-in screen with the same message.
- **Wrong code:** you can now ask for a new code from the code screen, and the sign-in box explains which phone formats work.
- **HR invites:** HR could not invite people. HR can now invite team members, but cannot hand out Founder, Admin or client roles, and cannot change roles. Phone numbers are checked when inviting.
- **Suspend:** you could suspend your own account. Now you can't. Restoring someone is logged as "reactivated".
- **Notification templates:** templates in the Command Centre were saved but never used. Turning an alert off now stops it, and custom wording replaces the standard text. Critical alerts always arrive. Creator "payout sent" notices follow the templates too.
- **Working days and holidays:**
  - Request SLAs, plan deadlines, automation due dates and engagement dates ignored the working-days setting and only skipped holidays. They now use the full office calendar.
  - Leave day counts used a fixed Monday-to-Saturday week. They now follow the working-days setting.
- **Creator payouts:** when Finance paid a creator, the brief stayed "approved" and the creator was not told. The brief now closes as "paid" and the creator gets a notice with the amount after TDS and the reference.
- **Payment reminder link:** it pointed to a page that does not exist (`/client/invoices`). It now opens Billing.
- **SOPs:** every save went live straight away. SOPs can now be saved as a draft, which only editors can see, and then published or unpublished. Each one shows how many people have read the current version.
- **Catalogue:**
  - Bundle discounts and add-ons could not be edited. You can now edit bundle savings and add, edit and remove add-ons.
  - Every change creates a new price book version, so proposals already sent keep their prices.
  - Price book history is shown.
  - The "Add-ons" menu link now lands on the add-ons section.
- **Discount limits:** the "saved" confirmation disappeared straight after saving. It now stays.
- **Users page:** search results now open the Users page with that person highlighted.

## What was added

1. **Onboarding and offboarding** (Command Centre → Organisation → Onboarding & Offboarding; team app → My onboarding)
   - **New hires:** HR starts a checklist for a new hire, and can create the person as an invited user at the same time. The checklist covers documents, laptop, accounts, SOPs to read and a buddy.
   - **SOP items:** these tick themselves when the new hire presses "I have read this" on each SOP. The buddy item and first sign-in tick themselves too.
   - **Leavers:** the checklist shows everything the person still owns. HR ticks tasks, clients (with their open services) and leads, picks a new owner, and moves them in one go. The handover items tick themselves when nothing is left.
   - **Last day:** access is suspended automatically on the last day.
   - **Completing:** a checklist can't be marked complete while items are open.
2. **Timesheets** (team app → My timesheet and Approvals; Command Centre → Timesheets)
   - Each week is built from "log time" on tasks plus time you add by hand (meetings, admin, training, internal work).
   - You submit the week. Your manager, your department head or HR then approves it, or returns it with a comment, which is required when returning. Nobody can approve their own week.
   - Time added by hand can be tagged to a client (a client call, for example). Once the week is approved, those hours count in that client's Profitability. Task time keeps counting as before.
3. **Leave approval chain** (team app → Approvals)
   - The manager decides first. Leave over 3 working days then goes to HR for the final decision.
   - The person sees who it is waiting for.
   - Requests that leave tasks due while the person is away are flagged "cover needed". A cover page lets you move those tasks to a teammate, and it shows who is also out.
   - The team calendar has a "Who's out" strip for the next two weeks.
4. **Global search:** Ctrl+K (Cmd+K on Mac) in the team app and the Command Centre.
   - Searches clients, leads, proposals, invoices, tasks, people and SOPs.
   - Use the arrow keys to move, Enter to open and Esc to close.
   - You only see what your role is allowed to open.
5. **Activity feed** on client, lead, engagement, invoice and person pages.
   - Lists who did what and when, in plain sentences, read from the audit log.
   - Filter by person, open "Details" to see before and after values, and "Show older" to go further back.
6. **Client app branding:** the client app now uses the name and colours set in Branding & Theme.

## Checked and working (no change needed)

- **Users:** department, team and branch create and edit, the hierarchy tree, and permission matrix edits changing access on the very next request. A cloned role's extra access turns the menu and the API on and off.
- **Attendance:** check-in and check-out show on HR's attendance board.
- **Settings:** every Command Centre settings page saves and keeps the change after a reload: tenant, branding, SLA rules, gate rules, notification templates, requirement checklists, GST, accounting and discount limits.
- **Templates:** flow template and QC checklist editors save new versions.
- **DPDP:** client data export downloads valid JSON. Deleting personal data needs the client name typed first.
- **Analytics:** all 9 analytics pages switch through every period without errors.
  - 13 CSV exports were opened and checked: same number of columns on every row, and no "undefined", "NaN" or "null" values.
  - Report builder save, pin, share, stop sharing and delete all work. A colleague sees shared reports.
- **Mobile app:**
  - Every call the app makes was run against the current API with a mobile sign-in token, and all succeed.
  - The type check passes and the Android export builds.

## Known limits

- Run the API e2e suite with the dev API stopped, or point them at different databases. The dev automation engine reacts to the test leads and creates "Call …" tasks for the sales user, which breaks a production test.

- Signing out on one device does not end sessions on other devices. Sign-in tokens last 30 days, and a suspended account stops working straight away.
