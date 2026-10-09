# v15 AI agents

Third phase (v15) of `docs/spec/architecture-v2.json`. Runs inside the API with only PostgreSQL. Without
`ANTHROPIC_API_KEY` every agent uses its basic (rule-based) plan; with a key it runs a tool-use loop.

## Agents (`apps/api/src/agents/`, `packages/shared/src/agents-types.ts`)

| Agent | Runs | What it does |
|---|---|---|
| Sales assistant | new leads (stage new, duplicates flagged), daily quiet-deal check | score, brief note, follow-up date; proposes the reply and an owner |
| Request triage | new requests (status received) | internal note, proposes request type, reply and assignee |
| Producer | daily | overdue reminders (once a day per owner); proposes reassignments for leave clashes and overload (>12 tasks due in 7 days), max 10 |
| Analyst | on demand ("Ask the Analyst"), monthly report on the 1st | answers from copilot facts and knowledge, always with sources |

Each org gets one `Agent` row per agent, created switched off and acting for the Founder. Switching on needs an
acting person and sets `scannedAt = now`, so only records created afterwards are picked up.

Scheduler (`agents.service.ts`): ticks every 60 s and 5 s after a lead or request is created. Daily jobs run at
10:00 IST or later, the monthly report on the 1st at 09:00 IST or later (markers in `agent.settings`). Knowledge
refreshes hourly per org. Off under tests, `AGENTS_DISABLED=1` or `AUTOMATIONS_DISABLED=1`.

## The gate (`runtime.ts`, `catalogue.ts`)

Every action an agent asks for goes through, in order:

1. Known action in the catalogue (16 actions).
2. Policy `never` (delete, change price, create invoice, refund, change role) is refused.
3. In this agent's allowed list.
4. Input parsed with zod.
5. `check()` as the acting person: the same permission and visibility rules the API uses for that person.
6. Policy `auto` (lead note, score, follow-up, request note, notify a person): applied as the acting person, with
   undo rows stored on the step.
7. Policy `confirm` (reply to a lead or request, assign lead/request, reassign task, set request type): an
   `AgentProposal` goes to the Agent Inbox and the deciders are notified. Everything client-facing or money-related
   is `confirm` or `never`.

Approving re-checks as both the acting person and the approver, merges only the editable fields, and applies as the
approver. Rejecting records the note on the run. Proposals expire.

## Undo

`AgentStep.undo` keeps the rows before the change. Undo (one step or the whole run) restores them, for the models in
`AGENT_UNDO_MODELS`. Messages already sent stay sent. Only Admins, the acting person, whoever started the run or whoever approved the step
can undo.

## Knowledge (`knowledge.service.ts`)

`KnowledgeChunk` rows built from published SOPs, active services and tiers, approved plans, brand kits and client
notes (redacted, ~1500 characters per part). Search is PostgreSQL full-text (`ts_rank`, prefix matches, snippets);
client-specific chunks are filtered to clients the person can see. Meaning-based (vector) search needs an embeddings
provider and is left for later; the search function is the only place to change.

## Budget, logs and evals

- Monthly budget per agent (`monthlyBudgetPaise`, default ₹1,000). When spent, runs use the basic plan.
- `AgentRun` + `AgentStep`: trigger, mode, summary, answer, citations, cost, tokens, feedback. AI calls are also
  in the AI log (features `agent_run`, `agent_ask`). Switch agents off for the org under Settings → AI.
- `evals.ts`: eight safety checks with a scripted fake model (never actions, outside the catalogue, acting-person
  limits, client-facing waits, money never automatic, sources shown, undo restores, injection fenced). Run from the
  AI Agents page and in `test/agents.e2e-spec.ts`.

Screens: Command Centre → Agents → **AI Agents**, **Agent Inbox** (`/team/agent-inbox`, also under You in the team
app), **Agent Run Log** (`/admin/agents/runs`). Browser journey: `apps/web/e2e/agents/agents.mjs`.
