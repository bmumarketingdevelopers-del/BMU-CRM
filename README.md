# BMU Hub

One TypeScript monorepo for the BMU website, client app, team app, admin panel and API.

| Folder | What it is | Tech |
|---|---|---|
| `apps/web` | Website (bmu.marketing) plus client, team, admin and creator web surfaces | Next.js 16, Tailwind 4 |
| `apps/mobile` | Client + team mobile app (iOS and Android) | Expo SDK 57, React Native |
| `apps/api` | Backend API | NestJS 12, Prisma 7, PostgreSQL |
| `services/forecast` | Optional forecasting service (the API works without it) | Python 3, FastAPI |
| `packages/shared` | Code shared by all three: design tokens, INR/GST money helpers, catalogue, roles, permission matrix, gates, validation, typed API client | TypeScript, Zod |

The spec these come from is `BMU_Hub_Architecture_Prompt.json` (a copy is in `docs/spec/`). The catalogue, roles, permission
matrix, gates and screen lists in `packages/shared/src/data` are generated from it.

---

## Run it on your computer

### 1. Install these once

- **Node.js 22 LTS**: https://nodejs.org
- **VS Code**: https://code.visualstudio.com
- **Expo Go** on your phone (App Store / Google Play), for the mobile app

Then install pnpm once. In the VS Code terminal or PowerShell:

```bash
npm install -g pnpm
```

Close the terminal and open a new one so it picks up pnpm. (On a Mac you can use `corepack enable` instead.
Don't use `corepack enable` on Windows: it needs administrator rights and fails with `EPERM`.)

### 2. Run the website (two commands)

Unzip the project (on Windows: right-click the zip → **Extract All**), open the extracted folder in VS Code (the one
with `package.json` inside), open the terminal (**Terminal → New Terminal**) and run:

```bash
pnpm install
pnpm dev
```

No Docker needed. The first `pnpm dev` creates the settings files, sets up a private database inside
the project folder (`.bmu-data/`), creates the tables and loads BMU's data. Then open **http://localhost:3000**.
Press **Ctrl+C** in the terminal to stop everything. If you already run Postgres (or Docker with
`pnpm db:up`) on port 5432, it is used instead.

### 3. Sign in

Go to **http://localhost:3000/sign-in** and click any demo account, or type your own email
(`OWNER_EMAIL` in `apps/api/.env`, which gets a Founder login). In development the code is filled
in for you, so just press **Sign in**.

| Demo account | Lands on |
|---|---|
| Founder | Command Centre: everything, including prices and permissions |
| Asha Reddy (Admin) | Command Centre, can't change prices or permissions |
| Rahul Menon (Sales Manager) | Team app, all leads, can assign them |
| Priya Shah (Sales Executive) | Team app, only her own leads |
| Neha Iyer (Account Manager) | Team app: her clients, onboarding, sending drafts |
| Rohan Gupta (Strategist) | Team app: plans and briefs |
| Meera Nair (Producer) | Team app: her tasks, uploads versions |
| Vikram Joshi (QC Reviewer) | Team app: QC queue |
| Finance (finance@bmu.demo) | Command Centre: revenue, collections, invoices, payments, GST |
| HR & Ops (hr@bmu.demo) | Command Centre: attendance, leave, holidays and working hours |
| Anil Kumar (Client, Sunrise Realty) | Client app (owner: can approve quotes and pay) |
| Approver (approver@sunrise.demo) | Client app (approves drafts) |
| Ishita Verma (Creator, creator@bmu.demo) | Creator portal: briefs, revisions, payouts |
| Devika Rao (Project Manager, pm@bmu.demo) | Manager workspace: assign work, her clients, team load |
| Aman Verma (Video Editor, video@bmu.demo) | Video editor dashboard |
| Nisha Kulkarni (Script Writer, script@bmu.demo) | Script writer dashboard |
| Tara Fernandes (Social Media Manager, social@bmu.demo) | Social media dashboard and content calendar |
| Karthik Iyer (Developer, dev@bmu.demo) | Developer dashboard |
| Zoya Mirza (UX/UI Designer, uxui@bmu.demo) | UX/UI designer dashboard |
| Rhea Bose (Graphic Designer, design@bmu.demo) | Graphic designer dashboard |

### Try production (already set up in the demo data)

The demo client Sunrise Realty has a **Logo & Brand Kit** project in production.

1. **Rohan Gupta** (Strategist): on **My Day**, check in, then **Start** and **Mark done** on *Brief and references*.
2. **Meera Nair** (Producer): open **Tasks**, click *Design: Logo concepts*, upload an image as version 1.
3. **Vikram Joshi** (QC): open **QC queue**, untick a check and **Fail QC**, or tick all and **Pass QC**.
4. **Neha Iyer** (AM): open the deliverable and **Send to client**. Try an 🔒 internal note: the client never sees it.
5. **Anil Kumar** (Client): **Review Studio**, click on the image to pin a comment, then approve or request changes.

### Try extra requests, messages and final delivery

1. **Anil Kumar** (Client): **Requests**, pick **Extra request**, describe it, **Send request**.
2. **Neha Iyer** (AM): **Requests inbox** shows the reply timer (working hours). Open it, pick an add-on, add a
   timeline, **Send quote for approval**. AMs can only quote from the price list; Founder/Admin can set a custom price.
3. **Anil Kumar**: the home page shows *A quote is ready*. **Approve quote**, then **Pay** (test mode).
   Only now is a task created for the team.
4. Message each other in **Messages**. Tick 🔒 Internal on the team side: the client never sees it.
5. The 🔔 bell (top left) shows every update and links straight to the right screen.
6. When every deliverable is approved, the client gets the final invoice. **Files** shows *Sign off* and *Pay*;
   final files unlock for download only after both.

### Try workflows, forms and custom fields (v14)

1. **Founder**: Command Centre → **Workflows**, click **Use this** on *Overdue invoice: day 1, 7, 14 and 30*. Click
   any step to change it, use **+** to add one, then **Save changes**.
2. **Customise → Custom Fields**: add *Industry* (Pick from a list: Retail, Healthcare). Open any lead and fill it
   under **More details**. On the lead board, **Filter by a custom field**.
3. **Customise → Forms → New form**, then **Open the form** and send it like a visitor. The new lead appears on the
   board; with the *New lead* template switched on it is scored, assigned and gets a WhatsApp welcome (see
   Outbox → WhatsApp queue).
4. **Workflow Runs** shows where each record is. Click **Details** for the step-by-step log.

### Try AI agents (v15)

Agents start switched off. They work without an AI key (simple built-in rules); with a key they think for themselves.

1. **Founder**: Command Centre → Agents → **AI Agents**. On *Sales assistant*, pick who it acts for (for example
   **Rahul Menon**), then switch it on. It can never do more than that person could.
2. Send an enquiry from the website, then press **Run now** on the card. The agent scores the lead, adds a brief
   and sets a follow-up date on its own. The reply it drafts waits for a person.
3. Sign in as **Rahul Menon**, open **Agent Inbox** (under You). Click **Edit** to change the reply, then **Approve
   with my changes**. Only now is the email sent.
4. Back as the Founder, open **Agent Run Log**, click the run and press **Undo** on any step (or **Undo this run**).
5. Press **Run safety checks** on the AI Agents page: every check should pass. Switch on the *Analyst* and ask it a
   question, for example "What does the handling client revisions SOP say?". The answer lists its sources.

### Try the creative studio (v16)

1. **Client** (`client@sunrise.demo`): **Review Studio**, open work waiting for review. On a video, pause where
   something should change, press **Comment at current time**, click the spot on the frame (and **✎ Draw** to circle
   it), then **Add comment**. On an image just click or draw.
2. **AM** (`am@bmu.demo`) with the same work open: the comment appears without refreshing. Click its time to jump to
   that frame with the pin on it. Upload a new version: open comments move to it, marked *Carried over*.
3. **Send to client**: each approver gets an email (see Command Centre → Outbox) with **Review and approve**. The link
   works on a phone without signing in. After approval, **Approval certificate** shows who approved which file and how.
4. **Content calendar**: only approved work can be scheduled or published. Add a caption, schedule, mark published
   with the live link, then type in the results. Under **Channels and publishing rules**, *Bellandur Smile Dental*
   lets BMU approve posts itself (button **Approve for publishing** on the deliverable).
5. **Asset library** (team and client) and **Brand kits**: upload big files (they resume if the connection drops),
   versions, collections, tags and usage-rights end dates.

### Try the inbox, shared briefs and meetings (v17)

1. **Founder** (`founder@bmu.demo`): open **Inbox**. Three demo conversations are there. Under the list, press
   **Test: pretend a message arrived**, type a client person's mobile number or email and a message, and press
   **Receive it**: it lands on the right client (and on their message thread), assigned to their Account Manager.
2. Open a conversation: **Insert template** fills in the person's name, **Draft a reply** writes one for you, then
   **Send**. Without WhatsApp keys the reply says *Waiting to send* (see "Connect WhatsApp" below).
3. **AM** (`am@bmu.demo`): open a project, press **Start a shared brief**, then **Share with client**. Sign in as the
   client in another browser (or a private window) and open **Documents**: type in both windows at the same time.
   Both see each other's words within a couple of seconds, and nothing is lost.
4. **Client**: **Meetings → Book a call** with your Account Manager. As the AM, open **Meetings**, press **Notes**
   on that call, write notes, press **Summarise and find action items**, tick items and press **Make tasks**.
   **Your booking page** (on the same screen) has a public link anyone can use to book you; it creates a lead.
5. **Profile → What we tell you about**: pick WhatsApp alerts per type, quiet hours and a daily digest email.

### Try money and workload (v18)

1. **Finance** (`finance@bmu.demo`): open any open invoice and press **Create pay link**. Open the link in a
   private window and press **Pay … (test payment)**: the invoice turns paid and the client sees "Payment received" on their
   message thread. With Razorpay keys the same page takes real payments (see "Connect Razorpay" below).
2. **Payments to match**: a bank credit nobody could place waits here with suggested invoices. Pick one and press
   **Match**.
3. **AM** (`am@bmu.demo`): **My expenses → Claim an expense**, tick **Bill this to the client**. As Finance, open **Expenses & Bills**,
   **Approve**, then **Invoice <client>** to re-bill it. Vendor bills are added here too.
4. **Invoice Plans**: split a fee 50/30/20 (or any split adding up to 100%). Each part is invoiced and emailed on its
   date by itself; **Issue now** sends one early.
5. **Founder**: **Profit** shows what each client, project, service and person earns after team time, creators and
   expenses, with the formula written out. **Cash Flow** shows the next 13 weeks (set your bank balance, payroll and
   overheads on that page).
6. **Producer** (`producer@bmu.demo`): **Timesheet** has a stopwatch. **Workload** shows six weeks of everyone's
   booked hours against their free hours after leave and holidays. **Book someone** refuses people on approved leave
   or without free hours; **Who is free?** suggests the best person for a skill.

### Try integrations, publishing and the API (v19)

1. **Founder**: **Command Centre → Integrations**. Pick a client at the top of **Connect an account**, then press
   **Add test account** on Instagram, Meta Ads and Google Analytics 4 (test accounts need no keys). Press **Sync now**
   on the ads account.
2. Open that client in the Team app → **Ads & website**: spend, clicks, leads, website visits and campaigns. The client
   sees the same numbers on **Insights**.
3. **AM**: open an approved post that is scheduled on Instagram for that client and press **Publish now** (or wait for
   its scheduled time). It goes live on the test account, and its reach and likes arrive the next morning.
4. **Command Centre → API & Webhooks**: create a key (tick only **Read leads**) and copy it. It can read
   `http://localhost:4000/v1/leads` but is refused when it tries to add a lead. Add a webhook (for example a
   webhook.site address) for **A lead came in**, send a website enquiry, and see the signed delivery under **Deliveries**.
   The full API description is at `http://localhost:4000/v1/openapi.json`.
5. **Finance → Accounting Sync**: pick **Tally Prime import (XML)** or the Zoho Books files and download.

### Try forecasts, alerts, reports and goals (v20)

1. **Founder**: the **Weekly Review** now has **Forecast & risks**: next month's revenue with its likely range, clients
   at risk of leaving, deals most likely to close, work likely to slip and capacity by skill. Every line says why.
   **Command Centre → Intelligence → Forecast & Risks** shows the full version (and **Recalculate now**).
2. **Intelligence → Metrics**: every number BMU Hub uses, with its formula and the change from the previous period.
3. **Intelligence → Alerts**: four alerts are ready (a client's activity drops 40%, missed reply times double,
   collections drop 30%, more than 20 overdue tasks). Add your own and press **Check now**; people are told in their
   notifications (and on their phone).
4. **Intelligence → Scheduled Reports**: pick numbers, a day and a time, add emails, **Preview PDF**, **Send now**.
5. **Goals** (Command Centre and the Team app): company goals follow a metric by themselves; team and personal goals
   move with check-ins. Status compares progress with how much of the time has gone.

### Try sign-in security and privacy (v20)

1. Click **Sign-in security** at the bottom of the menu. Turn on an **authenticator app** (scan the QR code with
   Google or Microsoft Authenticator) and save the recovery codes. Next sign-in asks for the 6-digit code.
2. **Add a passkey** there, then use **Sign in with a passkey** on the sign-in page (Face ID, fingerprint or Windows
   Hello; no code to type). **Signed-in devices** lets you sign out a lost laptop.
3. **Command Centre → Security**: **Field access** decides who can change, see or not see sensitive fields (lead
   budget, cost rates, margins, creator rates, team phone numbers, custom fields). Hidden fields are removed by the
   server, so they never reach the website, the app, the API, search or AI answers. **View as** shows what one person
   sees. **Sign-in rules** can make two-step sign-in required for roles (recommended: Founder, Admin, Finance).
4. **Command Centre → Privacy (DPDP)**: requests from the public **/privacy** page (copy, correct or delete my data)
   with their 30-day deadline, consent records from the enquiry form, how long each kind of data is kept (runs
   nightly), and the breach runbook. **Audit Log → Verify chain** proves no entry was edited or deleted.

### Try a full sale

1. Sign in as **Rahul Menon**, open **Leads**, and click **Create proposal** on a lead.
2. Pick services, **Save proposal**, then **Send to client**. Open the client link it shows.
3. Tick the box, **Accept and sign**, then **Pay now** (test mode, no real money).
4. Sign in with the lead's email (e.g. `hello@kavyabakery.demo`) to see the new client app.

### Python forecasting service (optional, v20)

Forecasts work without it. To use the Python models instead, in a third terminal:

```bash
cd services/forecast
pip install -r requirements.txt
python main.py
```

Then add `FORECAST_URL=http://localhost:8000` to `apps/api/.env` and restart `pnpm dev`. Forecast & Risks then says
"forecasting service". If the service stops, BMU Hub quietly goes back to its own forecasts.

### Turn on the AI Copilot (optional)

Everything works without it (you get "Basic" suggestions). To switch on the real AI:

1. Go to **console.anthropic.com**, sign in, open **API Keys**, click **Create Key** and copy it (starts with `sk-ant-`).
2. Open `apps/api/.env` and add the line `ANTHROPIC_API_KEY=sk-ant-...your key...`
3. Press Ctrl + C in the terminal and run `pnpm dev` again.
4. Sign in as the Founder, open **Command Centre → AI Copilot**: it should say **Connected**. Set a monthly budget there.

Keep the key private: never paste it into chat or messages.

### Real emails (optional)

Emails (sign-in codes, invoices, reminders) are shown in **Command Centre → Outbox** until you fill in the
`SMTP_...` lines in `apps/api/.env` with your email provider's details. Restart `pnpm dev` after changing it.

### Connect WhatsApp (optional)

1. In Meta's developer site (developers.facebook.com) create an app with **WhatsApp**, and copy the **access token**
   and **phone number ID** into `apps/api/.env` as `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID`.
2. For messages coming in, your API needs a public web address. In Meta, set the webhook to
   `https://<your API address>/webhooks/whatsapp`, pick any verify token and put the same value in
   `WHATSAPP_VERIFY_TOKEN`, and put the app secret in `WHATSAPP_APP_SECRET`. Subscribe to **messages**.
3. Restart `pnpm dev`. Note: WhatsApp only allows free-text replies within 24 hours of the person's last message.

### Connect Razorpay (optional)

1. In the Razorpay dashboard copy the **Key ID** and **Key Secret** into `apps/api/.env` as `RAZORPAY_KEY_ID` and
   `RAZORPAY_KEY_SECRET`.
2. Under **Webhooks**, add `https://<your API address>/webhooks/razorpay`, tick **payment_link.paid** and
   **payment.captured**, pick a secret and put the same value in `RAZORPAY_WEBHOOK_SECRET`.
3. Restart `pnpm dev`. Payments then mark invoices paid on their own; ones that can't be placed go to
   **Payments to match**.

### Connect Instagram, Facebook, LinkedIn, YouTube, Google Ads and GA4 (optional)

Real accounts need an app with each platform (free, but Meta and Google review apps before other businesses can use
them). Your API also needs a public **https** address for Instagram to fetch images: set `API_PUBLIC_URL` to it.

1. **Meta** (Instagram, Facebook pages, Meta Ads): developers.facebook.com → **Create app** (Business). Add
   **Facebook Login for Business**, **Instagram Graph API** and **Marketing API**. Put the App ID and secret in
   `META_APP_ID` and `META_APP_SECRET`.
2. **LinkedIn**: linkedin.com/developers → **Create app** → request **Community Management API**. Put the client ID
   and secret in `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`.
3. **Google** (YouTube, Google Ads, GA4): console.cloud.google.com → new project → enable **YouTube Data API v3**,
   **Google Ads API** and **Google Analytics Data API** → **Credentials → OAuth client ID (Web)**. Put them in
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Google Ads also needs a developer token from your Ads manager
   account (**Tools → API Center**) in `GOOGLE_ADS_DEVELOPER_TOKEN`.
4. In each app, add the **sign-in return address** shown at the bottom of **Connect an account** on the Integrations
   page (it ends in `/integrations/oauth/callback`).
5. Set `INTEGRATIONS_KEY` to a long random value (it encrypts the saved sign-ins), restart `pnpm dev`, then press
   **Connect** on the Integrations page and link each account to its client.

### 4. Run the mobile app on your phone

Keep `pnpm dev` running. Open a **second** terminal (the **+** in the VS Code terminal panel) and run:

```bash
pnpm dev:mobile
```

Scan the QR code: with **Expo Go** on Android, or the **Camera** app on iPhone. Phone and computer must be
on the same Wi-Fi. On Windows, click **Allow** if the firewall asks about Node.js. If it won't connect,
press `Ctrl+C` and run `pnpm --filter @bmu/mobile start --tunnel` instead.

Android emulator: start a device from Android Studio, then press `a` in the Expo terminal.

**v20 on the phone**: recent screens open without signal, and task changes made offline show at once ("Waiting to
sync") and sync by themselves when you are back online. **More → App lock** adds Face ID or a fingerprint.
Notifications have buttons (Approve, Reject, Reply, Done, Snooze 1h). Push notifications need a development build or a store build of the
app (see Expo's "Create a development build" guide); Expo Go on Android cannot receive them, and the app says so
under **More → Push notifications**. Everything else works in Expo Go.

## Run it as a real backend (v21)

`pnpm dev` stays the easiest way to try BMU Hub on your computer. For a real server the backend now runs as
separate processes: the **API** (answers the website and phone app), the **worker** (all background jobs:
reminders, workflows, AI agents, syncs, nightly forecasts) and the **website**. They share live changes through
Postgres, so nothing else (no Redis, no queue service) is needed. Full details: `docs/backend.md`.

**Check your settings** (no harm in running it any time):

```bash
pnpm env:check
```

**Option A, Docker on a server** (recommended):

```bash
cp .env.production.example .env.production      # then open it and change every value marked CHANGE
pnpm docker:up                                   # builds and starts database, migrations, API, worker, website
pnpm docker:logs                                 # watch the logs (Ctrl+C stops watching, not the app)
```

Open `http://<server address>:3000`. Sign in with your `OWNER_EMAIL`. Until email (SMTP) is set up, put `OTP_LOG=1`
in `.env.production` and read the code with `docker compose -f docker-compose.prod.yml logs api | grep "Sign-in code"`.
A live database starts clean: no demo accounts, just your Founder login, roles, the catalogue and templates.

**Option B, one computer or server without Docker** (Windows works):

```bash
pnpm install
pnpm build:prod     # after every update
pnpm start          # applies new migrations, then runs API + worker + website; restarts any that stop
```

It uses `apps/api/.env`. For a live server set `NODE_ENV=production`, a long random `JWT_SECRET`, `APP_URL`,
`OWNER_EMAIL` and email (copy them from `.env.production.example`, with `localhost` as the database host), then run
`pnpm db:seed` once.

**Is it healthy?** `http://localhost:4000/health/ready` (API) and `http://localhost:4001/health/ready` (worker, with
every job's last run). In the app: **Command Centre → System health** shows each running process and its jobs.

## What's built so far

- **Website**: home, services with live prices, package builder with automatic bundle savings and GST,
  discovery-call form. Every enquiry becomes a lead.
- **Sign-in**: one-time code by email or phone for staff and clients, on web and mobile.
- **Command Centre** (`/admin`): Weekly Review, Pipeline, Hierarchy Tree, Users (invite, role, department,
  manager, suspend), Roles & Permissions matrix (clone custom roles), Catalogue & Pricing (Founder edits prices),
  Audit Log.
- **Proposals**: build from any lead (bundle saving, special discount with Founder approval beyond the limit),
  send a link, client accepts with e-signature and pays. Payment creates the client account, assigns the
  least-busy Account Manager, opens each service at Milestone 1 with its requirement checklist, and marks the lead won.
- **Payments**: Razorpay when `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are set in `apps/api/.env`; otherwise a
  test-payment button (development only). GST invoices numbered `BMU/2026-27/0001`.
- **Onboarding and planning**: requirement checklist (client sends items, AM marks received or blocked with a
  reason), project start date (RCD, Gate 1) with a 4-working-day plan deadline, plan editor, internal review,
  client plan approval (Gate 2).
- **Production**: approving a plan generates department tasks from flow templates with owners, dependencies and
  working-day deadlines (Gate 3). Tasks board/list, blocked needs a reason, time logging. Versions (files or links),
  department QC checklists, and **Send to client only after a QC pass on that exact version**.
- **Review Studio**: image pins, time-coded video comments, PDFs and live links, version compare, internal notes
  hidden from clients, revision rounds counted against the package, immutable client approval of a specific
  version (Gate 4).
- **My Day**: check-in/out, overdue / due today / blocked tasks, QC and send-to-client counters, pre-filled
  end-of-day report.
- **Admin templates**: visual flow editor (steps, owner role, working days, QC and client-review points) and QC
  checklists; every save is a new version.
- **Team app** (`/team`): My Day, Leads, Proposals, Clients, Projects, Tasks, QC queue, Review Studio, Requests inbox, Messages. **Client app** (`/client`): services with milestones,
  onboarding checklist, plan approvals, Review Studio, Requests, Files, Messages, billing with Pay now.
- **Requests desk**: change, extra request, urgent, question and billing requests with first-reply timers counted
  in working hours (9:30 to 6:30, Mon to Sat, holidays excluded). Extra requests become quotes from the add-on
  price list; work starts only after the client owner approves in writing and pays (invoice with GST).
- **Messages and notifications**: client to Account Manager chat with same-working-day reply tracking and internal
  notes; in-app notification bell with deep links for drafts, QC, quotes, payments and messages.
- **Final delivery (Gate 5)**: balance invoice raised automatically when every deliverable is approved; files are
  released for download only after written sign-off **and** payment. Client **Pay now** on any invoice.
- **Command Centre, every section** (v8): Revenue, Collections, Capacity, Quality, Client Health, Departments &
  Teams, Branches, Attendance & Leave, Holidays & Working Hours, Engagements, AM Assignment, Requests & Add-ons,
  Offboarding, Discount Limits, Document Templates, SOP Library, Requirement Checklists, Gate Rules, SLA Rules,
  Error Log, Finance (Invoices, Payments, Credit Notes, Creator Payouts, GST, Accounting export), Notification
  Templates, Integrations, Branding, Data & Exports, Company settings. Settings you change here (holidays, working
  hours, reply-time targets, gate rules, proposal text) are used by the rest of the app straight away.
- **Team app extras** (v8): Client 360, Calendar, Capacity, SOP library, Profile with leave requests and attendance,
  Creators (brief a creator, review their work, approve payouts). Projects board by milestone.
- **Client app extras** (v8): monthly report (printable), team users (invite colleagues as approver or viewer),
  profile and notification choices.
- **Creator portal** (`/creator`, v8): accept briefs, upload work, see revision notes and payouts.
- **Mobile app** (v8): redesigned in the same light style, with tabs for Home, Reviews, Requests, Messages and More.
- **Automations** (v9, Command Centre → Flow → Automations): "When this happens, if these are true, do this"
  rules with a visual WHEN → IF → THEN builder. 15 triggers (new lead, idle lead, proposal not accepted, invoice
  overdue, payment received, task overdue or blocked, 3rd revision, request missed its reply time, gate reached,
  client at risk, leave request...), conditions, and 8 actions (alert people, create a task, assign a lead, move a
  lead, internal note, client reminder, email, webhook). 11 ready-made recipes, a "test against current data" dry
  run, and a full run log. Rules run every minute while `pnpm dev` is running. Email is simulated until an email
  provider is connected.
- **Analytics** (v9, Command Centre → Analytics): Scorecard against your monthly target, Sales Funnel (conversion
  and days per stage, by source and service, lost reasons), Revenue Forecast for the next 6 months (committed
  retainers + weighted pipeline, best/worst case), MRR & Retention (movement waterfall, churn, cohorts),
  Profitability per client and service (hours × cost rates), Team Performance, Delivery Speed (days per milestone,
  bottlenecks), SLA & Response (heatmaps), and a Report Builder with saved, shareable reports. Every page has
  period filters with comparison to the previous period, plain-English insights and CSV export.
- **Flows** (v9): Business Flow Map (the whole agency on one line, with stuck items), project journey timelines
  (team Client 360 and client "Project journey"), drag-and-drop lead and task boards, "My performance" for every
  team member, "Insights" for clients, and a founder "Pulse" tab in the mobile app.
- **Menus by role** (v9): each person only sees the Command Centre pages their role can open.
- **v21: backend ready for live use** (notes in `docs/backend.md`): the backend runs as an API process and a worker
  process (or both in one for `pnpm dev`), sharing events through Postgres LISTEN/NOTIFY; one registry for all 25
  background jobs with overlap protection and run history; a Postgres lock so jobs never run twice (a second worker
  waits on standby); `/health/live` and `/health/ready` on the API and worker; start-up settings check
  (`pnpm env:check`) that refuses unsafe live settings; JSON logs with request ids; graceful shutdown that lets jobs
  finish; `Dockerfile` + `docker-compose.prod.yml` (database, migrations, API, worker, website, optional forecast);
  `pnpm build:prod` / `pnpm start` for a server without Docker; a clean live seed (no demo data); System health lists
  every process and job; shared documents stay correct with several API processes.
- **v20: intelligence, phone parity and hardening** (notes in `docs/flows/intelligence.md` and `docs/flows/hardening.md`):
  - **Metric layer**: one definition per number (MRR, weighted pipeline, win rate, on-time delivery, utilisation,
    margin, client activity and the Report Builder's numbers), used by dashboards, alerts, goals, reports and AI.
  - **Forecasts with reasons**: revenue for the next months with a likely range, churn risk per client, win chance
    per deal, tasks likely to slip and capacity by skill, worked out nightly. Built-in TypeScript models; the optional
    Python service (`services/forecast`) is used when it is running.
  - **Alerts, scheduled reports and goals**: anomaly alerts per company, per client or for one client; PDF reports
    by email on a schedule; company, team and personal goals.
  - **Phone app**: offline copies of recent screens, an outbox for task changes that merges field by field when back
    online (a teammate's change is kept), push notifications with quick actions, app lock, two-step sign-in.
  - **Sign-in security**: authenticator app with recovery codes, passkeys, signed-in devices, required two-step
    sign-in by role, sign out everywhere.
  - **Field-level permissions**: an editor for who can change, see or not see each sensitive field; enforced by the
    server for the website, app, API, search and AI; **View as**.
  - **DPDP tools**: public privacy notice and request form, consent records, 30-day request tracking, export and
    erase, retention rules, breach runbook. **Hash-chained audit log** with Verify chain.
  - **Speed**: search compares each distinct word once; heavy screens are cached per person and cleared on any
    change. `pnpm loadtest` checks the targets (results in `docs/loadtest-results.md`).
- **v19: integrations, publishing and public API** (notes in `docs/flows/integrations.md`):
  - **Integrations hub**: connect Instagram, Facebook pages, LinkedIn pages, YouTube channels, Meta Ads, Google Ads
    and Google Analytics 4 per client (sign in with Meta, LinkedIn or Google), see each account's status, sync log and
    errors, and get alerted when one breaks. Test accounts let you try everything without keys.
  - **Auto-publishing**: approved posts on the content calendar publish themselves at their time to the client's
    account (or **Publish now**). Failures retry after 5, 15 and 60 minutes, then the AM is told. Each post's reach,
    impressions, likes and clicks are pulled every morning.
  - **Ads and website results**: daily spend, clicks, leads, cost per lead and website visits from Google Ads, Meta Ads
    and GA4 on the client's Insights and the team's client page, with a campaign table.
  - **Public API v1**: API keys with scopes (read or create leads, read clients, projects, tasks, invoices, posts),
    a per-key rate limit, an OpenAPI document and a small TypeScript client. A key acts as the person who made it.
  - **Webhooks**: pick events (or `lead.*`, `*`); every delivery is signed (HMAC-SHA256) and retried for about a day;
    delivery log, send again, pause, new secret.
  - **Accounting**: Tally Prime XML (party ledgers, sales, receipts, credit notes with CGST/SGST or IGST) and Zoho Books
    invoice and payment import files, next to the voucher CSV.
  - Honest limits: real publishing needs your own Meta, LinkedIn and Google apps (Meta and Google review them before
    use with other businesses); LinkedIn video posts are not supported; Instagram needs a public `API_PUBLIC_URL`;
    the rate limit counts per API process; no Zapier app yet (use webhooks and the API); the GST e-invoice is still
    not built; Zoho and Tally get import files, not a live two-way sync.
- **v18: money and workload** (notes in `docs/flows/finance-capacity.md`):
  - **Payment links**: one link per invoice (Razorpay with keys, a test page without). Paying marks the invoice paid
    and thanks the client on their message thread. TDS deducted by the client can be recorded with a payment.
  - **Automatic matching**: Razorpay payments are matched to invoices by link, invoice number or order. Anything
    else lands in **Payments to match** with suggestions (invoice number in the reference, payer email, amount, name).
  - **Invoice plans**: milestones and instalments planned up front and invoiced on their dates without anyone
    remembering. Quotes and contracts are the existing proposals with e-signature.
  - **Expenses and vendor bills**: staff claims with approval (nobody approves their own), vendor bills by Finance,
    GST and TDS, mark paid, and billable expenses re-billed to the client in one click.
  - **Time tracking**: a stopwatch on the timesheet that logs to the task (locked weeks are refused).
  - **Profit** per client, project, service and person (revenue minus team time at cost rates, creator payouts and
    expenses), and a 13-week **Cash Flow** forecast using each client's usual lateness.
  - **Workload**: six-week heatmap of booked hours plus task estimates against free hours after leave and holidays;
    book people or a skill on a project; skill requests; hours per week per person.
  - **Finance collector agent** (v15 Agent Inbox): proposes payment matches and payment reminders, flags unbilled
    expenses and projects over budget. The **Producer agent** now books people for skill requests and refuses anyone
    on approved leave.
  - Honest limits: the GST e-invoice (IRN and QR from the government portal) needs a GST Suvidha Provider account and
    is not built; Razorpay is live only with keys plus the webhook secret; bank statements are not imported (add
    a credit by hand on **Payments to match**); accounting software gets CSV exports only (no Zoho or Tally sync).
- **v17: client portal 2.0 and communications** (notes in `docs/flows/comms.md`):
  - **Inbox** (team): every WhatsApp number and email address that writes in is one conversation. Known client people
    land on their client (and their message thread, so the client portal shows it too), leads land on the lead's
    timeline, everything else waits unassigned for leadership. Tabs for mine, unassigned and closed; assign, link to
    a client, close; reply templates with the person's name filled in; AI reply drafts (basic without a key).
  - **One-tap approval from WhatsApp**: the review link in the WhatsApp message approves the work without signing in
    and moves it on, exactly like the email link.
  - **Shared documents**: briefs, proposal drafts and notes that several people (team and client) can type in at the
    same time without losing anyone's words. Start a project's brief from the project page; share it with the client.
  - **Meetings**: each team member has a booking page (days, hours, call length, notice). Clients book their Account
    Manager from the portal, anyone can book from the public link (it creates or links a lead), confirmation and
    reminder emails with an "Add to calendar" file. Notes become a summary and action items (AI or simple rules) and
    action items become tasks in one click. Clients see the summary, never the team's notes.
  - **Notification router**: per alert type, in-app, email and WhatsApp; quiet hours (alerts wait until they end)
    and a daily digest email. Money and approval alerts are never held back. The same unread alert is not repeated
    within 10 minutes.
  - **Client portal**: home shows the next call and shared documents; menus follow the person's client role (only
    owners and finance see billing; viewers can read but not edit shared documents or book calls).
  - Honest limits: WhatsApp sends and receives only once Meta's keys are added (until then messages wait in the
    queue); incoming email needs a forwarding service pointed at the webhook (Gmail sign-in sync comes later);
    calendars sync through the .ics file only (Google/Outlook sync later); a custom portal domain and phone push
    notifications are not built yet.
- **v16: creative studio** (notes in `docs/flows/creative.md`):
  - **Asset library** (team and client): every logo, photo, video and approved post with versions (make any version
    current, compare side by side), collections, tags, AI tags from the picture (with an AI key), usage rights with an
    end date and a warning 7 days before, share links, and uploads up to 5 GB that resume after a dropped connection.
    Approved work lands in the library automatically and is shared with the client.
  - **Proofing**: pins and freehand drawings on images; on video, comments at a moment with an optional spot and
    drawing that show on that frame while it plays, plus markers on the timeline. Comments appear live for everyone
    with the page open. Open comments carry over to the next version; makers mark them resolved.
  - **Approval rounds**: internal check first, then the client, shown per version. Clients approve in the portal or
    in one tap from the email or WhatsApp link, no sign-in needed. Each approval issues a printable **approval
    certificate** sealed with a fingerprint of the file, so any later change shows.
  - **Brand kits**: tone of voice, do's, don'ts and competitors on top of colours, fonts and files, with a
    completeness score per client.
  - **Content calendar**: captions, channels per client, nothing scheduled or published without approval (or BMU
    sign-off where the client allows it), a "due to post now" list, and results (reach, engagement, clicks, spend)
    typed in after posting, with a summary for the team and each client.
  - **Creative reviewer** agent: checks new versions before QC (right file type for the job, file size, the brand
    kit's don'ts; with an AI key it also looks at the image) and leaves an internal note for the maker.
  - Honest limits: files stay on the computer running the API (cloud storage later), posting itself is done on each
    platform for now, and AI tags and the AI review need an AI key.
- **v15: AI agents** (notes in `docs/flows/agents.md`):
  - **Four agents** (Command Centre → Agents → AI Agents; v16 adds the Creative reviewer): *Sales assistant* (scores and briefs new leads, sets
    follow-ups, drafts replies, nudges quiet deals daily), *Request triage* (sorts client requests, adds a note,
    drafts the reply, suggests who handles it), *Producer* (daily overdue reminders, spots leave clashes and
    overloaded people and suggests reassignments) and *Analyst* (answers questions from your data and SOPs with
    sources, plus a monthly report on the 1st).
  - **Safe by design**: each agent acts for one person you choose and can never do more than them. Small internal
    changes (notes, scores, follow-up dates, reminders) happen on their own; anything that messages a client or
    lead, assigns people or changes a request type waits in the **Agent Inbox** for approval (edit before
    approving, or reject with a note). Deleting, prices, invoices, refunds and roles are never allowed.
  - **Agent Run Log**: every step an agent took, what it looked up, what it was refused, AI cost, thumbs up/down,
    and **Undo** for any change, with no time limit.
  - **Knowledge**: agents search your published SOPs, services and prices, approved plans, brand kits and client
    notes (refreshed every hour), and only see client details the acting person can see.
  - **Budget and safety checks**: a monthly AI budget per agent (it falls back to basic rules when spent), and a
    **Run safety checks** button that proves the rules hold. The same checks run in the automated tests.
- **v14: workflows and no-code customisation** (notes in `docs/flows/workflows.md`):
  - **Workflows** (Command Centre → Flow → Workflows): build follow-ups as a picture. Pick what starts it, then
    add steps with the + buttons: do something, wait (days or working days), wait until a date, if/else with two
    paths, ask someone to approve, stop. Test against current data before switching on. Every save is a new
    version; runs already going keep theirs. Seven ready-made templates (new lead, proposal chase, overdue invoice
    day 1/7/14/30, request reply time, renewal, approved creative, offboarding handover).
  - **Workflow Runs**: where every record is in each workflow, what already happened, what comes next, and Stop.
    Waits carry on after a restart. Your old automations move across with one click.
  - **Custom Fields** (Command Centre → Customise): add your own fields to leads, clients, projects, requests and
    creators. Fill them on the record page (More details), filter the lead board by them, chart them on a
    dashboard, and check or set them in workflows.
  - **Forms**: build an enquiry form, share the link or paste the website code. Every answer becomes a lead and
    starts your new-lead workflow.
  - **Pipeline Settings**: rename, reorder or hide lead stages, set time targets ("12 days in stage") and what must
    be filled in before a lead moves on.
  - **WhatsApp queue** on the Outbox page: messages workflows want to send, until WhatsApp Business is connected.
- **v13: live and smart** (first phase of the new architecture, `docs/spec/architecture-v2.json`; notes in
  `docs/flows/platform.md`):
  - **Live updates**: lists, boards, dashboards, records and the notification bell update by themselves when anyone
    changes something, on the web and in the phone app. A small "Live" dot next to the version shows it is
    connected; if the connection drops it says "Reconnecting" and checks for changes every 20 seconds.
  - **Who else is here**: on a lead, client, project, request, deliverable or creator page you see the faces of
    teammates looking at the same record.
  - **Smart search** (Ctrl/Cmd+K): finds records even with a typo or part of a name ("sunrse" finds Sunrise),
    now also projects, requests and creators. Filter chips (Clients, Leads, Projects, Tasks…), and your recent
    records before you type.
  - **System health** (Command Centre → Platform → System Health, Founder and Admins): database, changes per hour,
    people online, search index (with Rebuild), failed deliveries with Retry and Dismiss, background jobs, and
    **feature switches** to turn live updates, presence or smart search off and on for everyone (or some roles).
  - Under the hood: every change now goes through one event bus that the rest of the system listens to. This is
    the base the next phases (workflows, AI agents) build on. Nothing new to install.
- **v12: Dashboard Studio** (Command Centre → Dashboards → Dashboard Studio, Founder and Admins; notes in
  `docs/flows/dashboards.md`):
  - **Edit every dashboard**: Weekly Review, Scorecard, My Day, Manager workspace, Specialist workspace and the
    Client home. Hide, move (drag or arrows) and resize their sections, and add your own widgets. "Customise this
    dashboard" on each one opens it in the Studio. Every save is kept: History restores any earlier version, and
    "Reset to original" brings back the standard layout.
  - **Build new dashboards** from a blank page, a template (Sales, Delivery, Client service, Finance) or a copy of
    any dashboard. Widgets: numbers with the change against the previous period, charts, saved reports, lists
    (tasks, requests, leads, follow-ups, overdue invoices), any built-in section, notes and quick links.
  - **Choose who sees it**: everyone, roles, specialties or named people, either under Dashboards in the menu or
    as their home page. Each person only sees the numbers their role allows (people outside the Command Centre
    see their own numbers).
- **v11: add, edit, assign and reassign from anywhere** (spec: `docs/spec/actions-v1.1.json`, notes in
  `docs/flows/*-actions.md`):
  - **+ New** button in the top bar (and a floating + on the phone) for Person, Client, Lead, Task, Request,
    Service, Invoice, File upload, Creator, Note, Meeting and Announcement, showing only what your role can do.
    Ctrl/Cmd + K also understands actions like "new task for Sunrise" or "reassign Reel 03 to Meera".
  - **⋯ menu on every row and card**: Edit, Reassign, Change deadline, Move, Duplicate, Archive, View history.
    Side-panel forms with "Save and add another" and drafts, duplicate warnings, Undo for a few seconds after
    changes, multi-select bulk actions, CSV import with a preview, saved views and export on lists.
  - **People and hierarchy**: "+ Add person" and "+ Add team" on any node of the Hierarchy Tree, drag to move
    someone (with a preview of what they gain or lose access to), change role with a permission diff, client
    pods, and offboarding that can't finish while the person still owns any open work.
  - **Clients**: add a client by hand (no lead needed) or migrate an existing client at its current gate,
    reassign the Account Manager (the client gets an intro), add a service or change tier with client approval,
    pause, offboard, client users and brands.
  - **Tasks**: add a task from anywhere (board column, list, calendar day, client, project, message), templates,
    recurring tasks, subtasks and dependencies, reassign with load %, leave and impact shown, deadline changes
    with a reason, "Can't take this" for producers, drag between people on Capacity, move all of someone's work.
  - **Approvals**: sensitive changes (Admin role, cross-department moves, big discounts, credit notes, pausing a
    client, long due-date extensions...) wait in "Needs you" on Approvals and in Command Centre → Approvals.
  - **Leads, finance, creators, files**: add leads inside the CRM, manual invoices with pass-through lines,
    offline payments with proof, creator roster and ratings, a Files page with share links (expiry and
    password), discussions, announcements, and "Create task" on any message.
- **v10: every flow works end to end**, tested in a real browser role by role (journey scripts in
  `apps/web/e2e/`, notes in `docs/flows/`):
  - **Sell**: lead page with full timeline, call/meeting logging, follow-ups, duplicate merge, multi-step discount
    approvals (sales manager → admin → Founder), proposal versions, view tracking, expiry, e-sign, payment plans,
    renewals desk.
  - **Service**: GST tax invoices (with UPI/bank details), dunning reminders, monthly retainer billing run, email
    Outbox (real email when SMTP is set), request ratings, files in chat, notification preferences.
  - **Deliver**: monthly retainer cycles, content calendar, client approval modes, SLA escalation, final handover
    pack as one zip, client feedback score (NPS) feeding Client Health.
  - **Specialist dashboards** for video editors, script writers, social media managers, developers, UX/UI designers
    and graphic designers, each with their own KPIs, next actions, workload heatmap and craft tools.
  - **Managers**: a Manager workspace for project/account managers and department heads to assign and reassign
    work (with load per person), see their clients' health, and handle approvals (Team app → Manager workspace; leaders also get Plan → Specialists).
  - **AI Copilot**: "Ask BMU" (Ctrl/Cmd + J) on every staff page, lead briefs, follow-up drafts, proposal intros,
    plan drafts, captions, scripts, QC pre-check, request triage, suggested replies, client tone check, Monday
    weekly digest, and an AI step in Automations. Safe by design: it never messages clients itself.
  - **People**: leave chain (manager, then HR over 3 days), cover for tasks during leave, timesheets with approval,
    onboarding/offboarding checklists with handover, SOP drafts and read receipts, Approvals inbox.
  - **Everywhere**: global search (Ctrl/Cmd + K), activity feed on clients, leads, projects and invoices, phone
    sign-in, session expiry that brings you back to the same page, working-day calendar for every deadline.
- **Design**: light only, matching bmumarketing.in: white work area, ivory sidebar, charcoal text, one green accent,
  hairline borders and clean dashboards.
- **Price books**: every price change creates a new version; existing proposals keep their prices.
- **API**: every permission in the spec's matrix is checked on the server, and every change is audit logged.
- **Database**: all 43 entities from the spec. Uploaded files are stored in `apps/api/storage/`.

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Website + API + shared package in watch mode |
| `pnpm dev:mobile` | Expo dev server for the mobile app |
| `pnpm build` | Production build of everything |
| `pnpm build:prod` / `pnpm start` | Build, then run API + worker + website for real use (v21) |
| `pnpm start:api` / `pnpm start:worker` / `pnpm start:web` | Run one process on its own |
| `pnpm env:check` | Check the settings in `apps/api/.env` |
| `pnpm db:deploy` | Apply new database migrations on a live database |
| `pnpm docker:up` / `pnpm docker:logs` | Run everything with Docker (`docker-compose.prod.yml`) |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Checks across all packages |
| `pnpm test:e2e` | Permission tests against the local database |
| `pnpm loadtest` | Load test against the speed targets (API and website must be running) |
| `pnpm db:studio` | Browse the database in your browser |
| `pnpm db:up` / `pnpm db:down` | Optional: run the database in Docker instead |

## Troubleshooting

- **`corepack enable` fails with `EPERM` on Windows**: skip it and run `npm install -g pnpm` instead.
- **`Command "dev" not found`** (Windows): you are in the outer folder that **Extract All** made. Run `cd` into
  the inner folder (for example `cd bmu-hub-v18`), the one that has `package.json`, then `pnpm install` and `pnpm dev`.
- **"pnpm is not recognized"**: close every terminal and open a new one after installing pnpm. Still missing?
  Run `npx pnpm install` and `npx pnpm dev` instead.
- **"running scripts is disabled on this system"** (PowerShell): run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`, then try again.

- **No demo accounts on the sign-in page, or a red "server isn't answering" box**: the API isn't running.
  Look in the terminal for a red `[bmu]` line and send it to Claude.
- **"Could not start the database"**: run `pnpm dev` again. If it keeps failing, delete the `.bmu-data`
  folder in the project and run `pnpm dev` again (this resets the demo data).
- **Port 3000 or 4000 already in use**: close the other app, or change `PORT` in `apps/api/.env`.
- **Phone says "Can't reach the API"**: check same Wi-Fi, allow Node.js through the firewall, or use `--tunnel`
  and set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to an address the phone can reach.
- **Expo Go says the project is incompatible**: update Expo Go from the store. This project uses Expo SDK 57.
