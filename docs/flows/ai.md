# AI Copilot (v10)

The AI Copilot is built into BMU Hub, not sold as an add-on. It works from the agency's own data and only sees what the
signed-in person is allowed to see. It drafts things and never sends anything to a client by itself: a person always
reviews the draft and sends it.

When no API key has been added, it runs in **basic mode**. Every feature still works, using ready-made suggestions
built from your data, and is marked "Basic suggestions — connect AI in Command Centre → AI Copilot for smarter
results".

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
| Client portal | **Ask about your account**: invoices, requests, approvals waiting, account summary. Only that client's own data. |
| Lead page | **Lead brief**: who they are, why the score is what it is, and the next best action. **Follow-up draft** for email or WhatsApp: open in WhatsApp or email, then "Log as sent". **Meeting notes**: becomes a summary, action items and a follow-up date; "Save to timeline" logs a meeting with that follow-up date. |
| New proposal | **Proposal intro & scope** from the lead and the picked services. Copy only: proposals have no intro field. |
| Project page (strategist) | **Draft the plan with AI**: "Fill the plan form" fills objectives, audience, pillars, direction and deliverables. Nothing is saved until Save. |
| Deliverable page | **Creative brief**, **Captions & hooks** (post, carousel, story, ad and reel types), **Video script** (reel and video types), **QC pre-check** on pasted copy (spelling, brand name, risky claims, style), **Feedback → change list** (when the client has commented). "Post as internal note" adds an internal comment, which the client never sees. |
| Request page | **Triage**: type, urgency, in scope or not, and a suggested add-on. "Use suggested add-on" fills the quote form. **Suggested reply**: "Put in reply box"; the AM clicks Reply to send. |
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
connected, and the same word list when it is not. The seeded rule "Unhappy request → AI draft for the AM" shows the
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
