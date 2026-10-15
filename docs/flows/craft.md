# Craft: specialist workspaces and the Manager workspace (v10)

## Who gets what

| Person | `/team` home | How it is decided |
| --- | --- | --- |
| Video editor, script writer, social media manager, developer, UX/UI designer, graphic designer | Their specialist dashboard | `User.specialty` is one of the maker specialties (`isCraftSpecialty`) |
| Client manager, CM lead, department head, or anyone with the `project_manager` specialty | Manager workspace | `isCraftManager(me)`. A maker specialty wins over the manager role |
| Everyone else | My Day (unchanged) | |

Founders and admins open the Manager workspace at `/team/manager` (nav: "Manager workspace"). Leads see every specialist at `/team/specialists` and open anyone's dashboard read-only at `/team/specialists/:id`.

Founder, Admin and HR set the specialty in Admin, Users: on the invite form and in the Specialty column. It shows on the profile. The values are the six maker specialties plus `project_manager`. Any lowercase key is accepted, so more can be added later.

Auto-assignment (`generate.ts` ownerPicker) now prefers people whose specialty fits the flow step (`craftFitsStep`). For example, developers don't get design steps. People without a specialty still fit every step, so production.e2e keeps picking producer@bmu.demo.

## Specialist dashboards (`GET /craft/dashboard`)

Every specialist dashboard has the same frame:

- **My Day strip**: check in/out, overdue, due today, blocked, and a quick end-of-day report.
- **KPIs vs the previous period**: a period picker, with `deltaVs` arrows.
- **"What to do next"**: overdue, then due today, then **new work a manager just assigned** (from the audit log, last 3 days), then client feedback, then blocked.
- **Plain-English insight lines**.
- **Weekly workload**: hours and tasks over 8 past weeks plus 2 planned weeks, and a day-of-week heatmap.

Panels per specialty:

- **Video editor**:
  - Edit queue by stage, with "Upload cut".
  - Time-coded client notes to resolve.
  - Footage and asset checklist from the client.
  - Render/export checklist.
  - Revision rounds left.
  - Shoots and deadlines this week.
  - Hours per video and turnaround.
- **Script writer**:
  - Script editor with live word count and runtime (150 wpm).
  - Insert a hook; submit a script as a version (it becomes a .md file and goes to QC).
  - Private hooks library with tags.
  - Briefs, feedback, and first-time approval.
- **Social media manager**:
  - Pipeline per client (idea, design, copy, client, approved, scheduled, published).
  - 7-day posting schedule.
  - Approvals waiting, with **Nudge client** (one per deliverable per 24h, posted on the client thread).
  - Client requests.
  - Monthly package usage, read from the price book.
  - No made-up performance metrics.
- **Developer**:
  - Web projects and their milestones.
  - Task board.
  - Bugs and change requests.
  - Staging and live links: adding a staging link sends that build to QC.
  - Web QC matrix.
  - Hours vs estimate (flow-step days × 6h).
- **UX/UI designer**:
  - Phases (research, wireframe, UI, prototype, handoff).
  - Client pins.
  - **Compare versions** side by side at `/team/craft/compare/:id`.
  - Handoff checklist.
  - Brand kits.
- **Graphic designer**:
  - Queue with upload, plus quick upload.
  - Daily output and streak.
  - QC first pass.
  - Pins, revision rounds and brand kits (colours, fonts, notes, brand files).

Access rules:

- You can always see your own dashboard.
- Founder, Admin and CM lead see anyone's, read-only.
- A department head sees their own department.
- An account or project manager sees anyone who works on their clients.
- Producers can't view other people's dashboards.
- Clients and creators get 403 on every `/craft/*` route.

## Manager workspace (`GET /craft/manager`)

**Scope** is enforced on the server for every read and write:

- **Client manager / project manager**: engagements where they are the CM.
- **Department head**: tasks in their department. Assignees must also be in it.
- **CM lead, founder, admin**: everything.
- **Anyone else**: 403.

A task outside your scope returns 403 ("belongs to another manager's client").

### What is on the page

- **My Day strip** and KPIs: open, unassigned, overdue, on-time over 30 days (vs the previous 30), and waiting on clients.
- **Today**, most urgent first:
  - Blocked tasks, overdue tasks and failed QC.
  - Unassigned tasks due within 3 days.
  - Clients who spoke last on their thread, and requests without a first reply (with a reply timer).
  - Approvals waiting 2+ days, each with a Nudge button.
  - Overdue invoices.
  - The manager's meeting and call reminders.
- **Assign work**: all open tasks for the scope.
  - Filters: unassigned/all, client, service, specialty and due date.
  - **Drag a task card onto a person**. The keyboard/select fallback is "Assign to…" on every card.
  - **Suggest**: one click assigns the best person. That is the right specialty (from the task's specialty or its flow step), the lowest load, and not on leave today. QC tasks only go to QC reviewers or department heads, never to the uploader of the latest version. Client reviews go to CMs.
  - Bulk select and reassign.
  - Deadline and priority (urgent, high, normal, low) on each card.
  - **+ New task** creates an ad-hoc task: title, client engagement, optional deliverable, specialty, assignee, due date and priority. A CM must pick one of their own engagements.
  - Member cards show specialty, hours due this week vs capacity (open tasks × 4h against 48h, minus 8h per leave day), open/due/overdue counts, and an "On leave today" badge. While you drag, the best fit is outlined.
- **My clients**: one card per client, showing:
  - Health and the CM.
  - Last contact (who spoke last, and when).
  - Each service's gate, cycle progress and next milestone.
  - Approvals waiting, with days waiting and Nudge.
  - Open requests with reply timers.
  - Next deliverables due.
  - Overdue invoices.
  - The latest notes.
  - Quick actions: **Message client** (`/team/messages/:threadId`), **Client 360**, and **Log call / note / meeting** (a meeting needs a reminder time; reminders appear in Today).
- **Team, next 2 weeks**:
  - Heatmap of planned hours per person per day. Leave days are grey.
  - CSV export.
  - On-time % (30 days), QC first pass and tasks done per person (all their work, not just this manager's clients), with a link to each member's read-only dashboard.

### Writes (all audited, assignees notified)

| Endpoint | Rule | Audit | Notification |
| --- | --- | --- | --- |
| `POST /craft/manager/tasks/:id/assign` `{ownerId, deadline?, priority?, note?}` | Open tasks only; QC and client-review rules; dependencies are kept (assigning never changes status) | `task.assigned` / `task.reassigned` | `task_assigned` to the new owner; "moved to …" to the previous owner |
| `POST /craft/manager/tasks/assign` `{taskIds, ownerId}` | Every task must be in scope, otherwise nothing is changed | one event per task | one summary to the new owner |
| `PATCH /craft/manager/tasks/:id` `{deadline?, priority?}` | Open tasks only | `task.updated` | `task_updated` to the owner (critical when urgent) |
| `POST /craft/manager/tasks` | Ad-hoc task (`kind: work`, `Task.specialty`) | `task.created` | `task_assigned` when an assignee is set |
| `POST /craft/manager/clients/:id/notes` `{kind: call\|note\|meeting, body, remindAt?}` | Own clients only (department: clients your department works for) | `client.call_logged` / `client.note_added` / `client.meeting_scheduled` | — |

### Mobile

The team "My Day" tab adds:

- **Specialists**: the top 4 KPIs and "What to do next".
- **Managers**: KPIs and **Today**, plus "Assign or reassign" cards for unassigned, overdue and blocked tasks. Each card has a one-tap "Assign to <suggested>" and a picker list of team members with their load.

## Schema (one migration: `20261003124000_v10_craft`, additive only)

- `User.specialty`
- `Comment.resolvedAt`, `Comment.resolvedById`
- `File.tags`
- `Task.priority` (default `normal`), `Task.specialty`
- New tables:
  - `craft_hooks`
  - `craft_scripts`
  - `craft_checklists`
  - `craft_brand_kits`
  - `craft_client_notes`

## Demo logins (OTP, dev code shown)

Specialists, all on `@bmu.demo`:

- `video@` (Aman Verma, on leave today and tomorrow)
- `script@` (Nisha Kulkarni)
- `social@` (Tara Fernandes)
- `dev@` (Karthik Iyer, on leave in 8 days)
- `uxui@` (Zoya Mirza)
- `design@` (Rhea Bose)

Managers:

- `pm@bmu.demo` (Devika Rao): project manager, CM of Peak Motors and Brightpath Academy. Has unassigned tasks, a client waiting for a reply, an overdue invoice, call notes and a meeting reminder.
- `am@bmu.demo`: Saffron Table and Urbanloom.
- `am.lead@bmu.demo`: everything.
- `design.head@bmu.demo`: Creative / Design.

## Tests

- `apps/api/test/craft.e2e-spec.ts` covers:
  - who can set a specialty
  - each dashboard returning only its owner's work
  - leads reading others
  - producers and clients refused
  - CM scope on the manager board
  - a CM can't assign another CM's client's tasks
  - producers can't assign
  - assignment creates a notification and audit
  - bulk and update
  - QC uploader rule
  - done-task rule
  - ad-hoc task creation
  - client notes
- `apps/web/e2e/craft/specialists.mjs` signs in as each specialist and checks in, resolves a comment, ticks a checklist, uploads a version, saves a hook, nudges a client, adds a staging link and compares versions, taking screenshots.
- `apps/web/e2e/craft/manager.mjs`: the PM drags a task onto the graphic designer, uses the select fallback, creates an ad-hoc task, logs a call and opens a member dashboard. The designer then sees the task as "New" on their dashboard and in the bell.

Run the journeys with `BASE_URL=http://localhost:<web port> node apps/web/e2e/craft/<file>.mjs`.
