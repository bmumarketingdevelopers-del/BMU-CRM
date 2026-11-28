# AI Copilot (v10)

The AI Copilot is built into BMU Hub, not sold as an add-on. It works from the agency's own data and only sees what the
signed-in person is allowed to see. It drafts things and never sends anything to a client by itself: a person always
reviews the draft and sends it.

When no API key has been added, it runs in **basic mode**. Every feature still works, using ready-made suggestions
built from your data, and is labelled **Basic**. Only the Founder and Branch Managers also see the note "Basic
suggestions — connect AI in Command Centre → AI Copilot for smarter results".

In basic mode, Ask BMU picks its answer from keywords in the question (`STAFF_KEYWORDS` and `CLIENT_KEYWORDS` in
`apps/api/src/ai/ai-copilot.ts`, tested in `ai-keywords.spec.ts`). The keyword groups follow what each dashboard shows:

- **Team (My Day and Command Centre)**:
  - attendance and leave (check-in, late, holiday, WFH, leave decision)
  - end-of-day report and the team's reports
  - QC sent back, checks waiting, work ready to send to the client
  - tasks overdue, due today, due this week, blocked or done
  - delivery steps at risk
  - my day or week
  - clients at risk, the client list, one client by name
  - invoices and money owed
  - leads, follow-ups and proposals
  - requests and reply times
  - sales scorecard and target
  - team performance and workload, and what one person is working on
  - the weekly summary
- **Client portal**:
  - client manager and how to reach them
  - monthly plans
  - what BMU still needs (onboarding checklist)
  - drafts waiting for approval
  - invoices and payments
  - requests
  - services and milestones (the default answer)

Everything in a person's menu can be asked about:
- **Answered with data:** goals, meetings, leave balance and requests, timesheet, expenses, approvals waiting, my
  performance (tools `my_goals`, `my_meetings`, `my_leave`, `my_timesheet`, `my_expenses`, `my_approvals`,
  `my_performance`).
- **Answered with what the page holds and a link:** other pages such as Documents, SOP library, Files, Brand kits,
  Content calendar and Capacity.

**Only what the person has.** `apps/api/src/ai/ai-topics.ts` follows the same rules as the team and client menus:
- The help list, the starter questions in the panel (`AiStatus.examples`) and the page answers include only what that
  person's role can open. A producer is never offered money, sales, team or client questions.
- Examples use a real client and a real colleague, never a system account.
- A page the person doesn't have is answered plainly: "Quotations is not on your dashboard".
- Tests: `ai-topics.spec.ts` and `ai-routing.spec.ts`.

**Every tab in the menu** (Team app, Command Centre and client portal) is a page skill in `apps/api/src/ai/pages/`:
- Each skill has `label`, `href`, `can(me)` (the same rule as the menu, from `access.ts`), keywords, example
  questions, a read-only `load` through the page's own service with the person's scope, and a basic-mode `answer`.
- The files are grouped: `team-work`, `team-clients`, `admin-command`, `admin-org`, `admin-catalogue`,
  `admin-finance` and `client`.
- The same skills are the model's tools in AI mode, so the model also sees only that person's tabs.
- Command Centre access rules live in `packages/shared/src/admin-nav-rules.ts`, shared with the menu.
- When two tabs match, the most specific phrase wins: "capacity by department" (Command Centre) beats "capacity"
  (Team app).
- `pages/skills.spec.ts` checks:
  - every skill follows the contract
  - every example question reaches its own tab, for someone who has it
  - the core questions still reach the core answers
- **Adding a tab to a menu means adding its skill.**

A question that matches nothing gets that person's own help list. With an AI key, the model answers instead, using
the same tools.

- Journey scripts (basic mode): `apps/web/e2e/ai/*.mjs`, run with `BASE_URL=http://localhost:3000 node apps/web/e2e/ai/copilot.mjs`.
  The other two are `sales-delivery.mjs` and `service-management.mjs`. Screenshots are saved to `/tmp/claude-0/ai-shots/`.
- API rules: `apps/api/test/ai.e2e-spec.ts`. These tests use a fake model client and never call the real API.

## How to add the AI key (plain steps)
1. Go to **console.anthropic.com** and sign in (or create an account). Open **API Keys** and click **Create Key**.
   Copy the key; it starts with `sk-ant-`.
2. In the BMU Hub folder, open the file `apps/api/.env` and add this line:
   `ANTHROPIC_API_KEY=sk-ant-...your key...`
3. Restart BMU Hub: press Ctrl + C in the terminal, then run `pnpm dev` again.
4. Sign in as the Founder or an Admin and open **Command Centre → AI Copilot**. It should now show **Connected**.
5. On the same page, set a **monthly budget** in ₹. Once spend reaches the budget, everyone gets basic suggestions
   until the next month or until you raise the budget.

Optional settings: `AI_MODEL` sets the main model (default `claude-opus-5-5`) and `AI_FAST_MODEL` sets the model for
quick tasks (default `claude-haiku-4-5`). Leave both empty to use the defaults. Keep the key private and never paste
it into chat or messages.

## Command Centre → AI Copilot (Founder and Admins)
- **Connection status**, with the steps above when no key is set.
- **Settings**:
  - organisation on/off switch
  - monthly budget (₹, estimated)
  - monthly token limit
  - AI answers per person per hour
  - on/off switches for each group: Ask BMU, Sales, Delivery, Client service, Management, Automations, Client app
- **Usage**:
  - calls this month (AI vs basic), estimated cost against the budget, tokens and average answer time
  - calls per day
  - calls by feature and by person
  - the recent-call log, with CSV export
- Changes are saved through the normal settings service and recorded in the audit log.

## Features and where they live
| Where | What |
|---|---|
| Every staff page (except creators) | **Ask BMU** side panel: a button at the bottom right, or Ctrl/Cmd + J. Asks questions about clients, leads, invoices, tasks, requests, the week and team performance. Answers link to the records they came from (only links that came from tool results are kept). Conversation history, New chat and Delete are included. |
| Client portal | **Ask about your account**: invoices, requests, approvals waiting, plans, what BMU still needs, the client manager's contact details, account summary. Only that client's own data. |
| Lead page | **Lead brief**: who they are, why the score is what it is, and the next best action. **Follow-up draft** for email or WhatsApp: open in WhatsApp or email, then "Log as sent". **Meeting notes**: becomes a summary, action items and a follow-up date; "Save to timeline" logs a meeting with that follow-up date. |
| New proposal | **Proposal intro & scope** from the lead and the picked services. Copy only: proposals have no intro field. |
| Project page (strategist) | **Draft the plan with AI**: "Fill the plan form" fills objectives, audience, pillars, direction and deliverables. Nothing is saved until Save. |
| Deliverable page | **Creative brief**, **Captions & hooks** (post, carousel, story, ad and reel types), **Video script** (reel and video types), **QC pre-check** on pasted copy (spelling, brand name, risky claims, style), **Feedback → change list** (when the client has commented). "Post as internal note" adds an internal comment, which the client never sees. |
| Request page | **Triage**: type, urgency, in scope or not, and a suggested add-on. "Use suggested add-on" fills the quote form. **Suggested reply**: "Put in reply box"; the CM clicks Reply to send. |
| Message thread | **Suggested reply** goes into the message box. **How is the client feeling?** runs a tone check. |
| Weekly Review | **Weekly digest**: written every Monday at 9 am IST, the Founder gets a notification, and it can be refreshed any time. **What stands out**: notes on unusual numbers. |
| Scorecard | **What stands out**: notes worked out only from the computed numbers. |
| Automations | New action **AI draft**: writes a client message, an internal summary or a next-steps note and sends it as a notification to the chosen people. It never goes to the client. New request condition **Tone of the request** (negative, urgent, positive or neutral). |
| Client Health | Unhappy client messages and requests (tone flag) lower the health score: 5 points each, up to 15, over 30 days. |

Every result offers **Copy**, **Edit**, **Regenerate** and, where it makes sense, **Insert**. Every result is labelled
**AI** or **Basic**.

## Safety
- **Permissions**: all data is loaded through the same services and scopes the screens use. If a tool returns
  "not allowed", the model is told so and does not guess. A producer asking about invoices is told that money is
  outside their role.
- **Clients**: clients can only use the client endpoints and tools, which are scoped to their own company.
- **No secrets**: OTP-like codes, API keys and tokens are removed. Emails and phone numbers are masked in client-written
  text before it is sent to the model.
- **Prompt injection**: client-written text is wrapped as quoted data (`<client_text>`), any tags it contains are
  stripped, and the system prompt says to treat it as data only.
- **Limits**: a per-person hourly limit, a monthly budget and a token cap. When any of these is reached, the person
  gets basic suggestions and a plain message.
- **Logging**: every call is logged, including basic answers and blocked attempts. The log holds the feature, mode,
  model, tokens, cost and time, but not the prompt text.
- **No sending**: the AI never messages a client. Drafts go into boxes that a person sends.
- **Errors**: if the model fails or the key is rejected, the person gets the basic suggestion and a plain message,
  never a raw error.

## About the "AI says negative/urgent" automation trigger
Running the model on every request for each automation check would cost money on every run, and the results could
differ from one run to the next. So the trigger uses BMU Hub's built-in tone check: a fixed word list for unhappy and
urgent language. It is free, instant and gives the same answer every time.

The tone sweep that feeds Client Health works differently. It runs every 5 minutes and uses the fast model when AI is
connected, and the same word list when it is not. The seeded rule "Unhappy request → AI draft for the CM" shows the
two working together.

## Data (one additive migration: `20261003125000_v10_ai`)
- `AiLog`: one row per call.
- `AiConversation`: Ask BMU history, per person, soft-deleted.
- `AiSignal`: tone flags on client messages and requests.
- `AiDigest`: weekly digests.
- Settings section `ai`.
- Seed: AI settings, 40 demo usage rows (marked `DemoSeed`), and the "unhappy request → AI draft" automation.

## Endpoints (all under `/api/ai`)
- `GET status`: mode, the switches, and whether you can manage AI.
- `POST generate` and `POST generate/stream` (NDJSON): all drafting features (staff only).
- `POST ask` and `POST ask/stream`: Ask BMU for staff.
- `POST client/ask` and `POST client/ask/stream`: Ask BMU for clients.
- `GET conversations`, `GET conversations/:id`, `DELETE conversations/:id`.
- `GET digest`, `POST digest`: Command Centre roles.
- `GET usage`, `PUT settings`: Founder and Admins only.
