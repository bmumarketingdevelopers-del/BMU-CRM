# Shared actions and tasks (v11 core)

v11 lets anyone who can see something add, edit, assign, reassign, move, duplicate, archive or restore it, from
wherever they are, without leaving the screen. This part, "core", builds two things:

1. **The shared action system** that every other area plugs into: the "+ New" button, the "⋯" row menu, drawers,
   the reassignment engine, approvals ("Needs you"), Undo, drafts, saved views, watchers, tags, archive/restore,
   CSV import and the Ctrl/Cmd+K action phrases.
2. **Tasks, end to end**, on the website and the mobile app.

- API rules and permissions: `apps/api/test/core-actions.e2e-spec.ts` (34 tests).
- Browser journeys: `apps/web/e2e/core-actions/*.mjs`. Run each one with
  `BASE_URL=http://localhost:3000 node apps/web/e2e/core-actions/tasks.mjs`. The other scripts are `approvals.mjs`,
  `entry-points.mjs` and `forbidden.mjs`. Screenshots go to `/tmp/claude-0/core-shots/`.

## What you can do, and where

### Everywhere (team app and Command Centre)
- **+ New** (top right, or press **N**). The menu shows only what you are allowed to add. Core adds **Task**, **Note**
  and **Meeting**; the other areas add Person, Client, Lead, Request, Engagement, Invoice, Creator and so on.
- **Needs you** (top right, next to + New). Shows how many approvals are waiting for you and links to them.
- **Ctrl/Cmd + K** still searches, and also understands actions:
  - "new task for Aroma"
  - "new task for Aroma: Diwali banner"
  - "reassign Reel 03 to Arjun"
  - "add user to Design"
  - "new client" / "new lead" …
  The palette opens the right drawer already filled in.
- **Keyboard** (when you are not typing): **N** new, **R** reassign, **D** change deadline, **E** edit, **/** search
  the list.
- **Undo**: after you edit, move, reassign, archive or run a bulk action, a message appears at the bottom for 10
  seconds with an **Undo** button.

### Tasks (`/team/tasks`)
- Buttons at the top: **+ Add task**, **From template** (department heads, AMs, strategists), **Import** (CSV),
  **Recurring** (see and stop recurring tasks).
- Search, **Mine / Everything I can see**, **Board / List**, filters (owner, client or Internal, department, status
  including Overdue, due-date range, tag, Open / Drafts / Archived), **Views** (save the current filters, share them
  with the team) and **Export CSV**.
- Board: drag cards between columns. Dropping a card on **Blocked** asks for the blocked details. The **+ Add** link on
  To do and In progress opens the task form. Every card has a **⋯** menu.
- List: tick rows (or "select all"). The bar at the bottom offers **Reassign** (through the engine), **Status**,
  **Deadline** (with a reason), **Priority**, **Tag** and **Archive** (with a reason). Each runs once and gives a single
  Undo.
- **⋯ menu** on every row and card: Open, Edit, Reassign/Assign, Change deadline (producers see "Ask for a new
  deadline"), Mark blocked, Add subtask, Can't take this (producers), Duplicate, View history, Archive/Restore. You
  only see what you are allowed to do. Things a rule blocks are greyed out, with the reason shown.

### Task page (`/team/tasks/<id>`)
- Start / Resume / Mark done, Blocked, Edit, Reassign, Change deadline (or Ask for a new deadline), Can't take this,
  and the ⋯ menu for the rest.
- Details: description, brief, references, a checklist you can tick, subtasks (with **+ Add subtask**), the tasks it
  "waits on" (add or remove them) and the tasks waiting on it, watchers (Watch / Stop watching) and tags.
- Boxes for **Blocked** (reason, waiting for, who can unblock it, expected date), **Waiting for approval**, **Draft**
  (out of scope: activate it once an approved add-on exists) and **Archived** (with Restore).
- **History** tab: who has had the task (the reassignment trail with reasons and handover notes), plus every change
  from the audit log with before → after.
- `?reassign=1` in the address opens Reassign straight away (links in notifications use this).

### Adding a task from where you are
- **Client 360**: "+ Add task" offers only that client's services. **Project page**: the engagement is filled in.
  **Deliverable page**: "+ Add" on the Tasks card fills in the client and the deliverable. **Calendar**: "+ Add task"
  on the selected day uses that day as the deadline.
- **Messages**: the ⋯ on any message → **Create task** uses the message as the title and description and records
  where it came from.
- **Manager workspace**: each card has **Reassign… / Assign…**, which opens the reassignment engine (impact, reason,
  approval).
- **Capacity**: drag an unassigned task onto a person (or press **Assign**) to open the reassignment dialog with that
  person picked. **Move work…** moves an overloaded person's open work, with a preview.

### Task rules (the server checks all of these)
- Required: title, client engagement (or Internal), department, assignee, deadline, priority. Everything else is
  under **More details**: description, brief, references and links, checklist, subtasks, dependencies, estimate,
  linked deliverable, watchers and Repeat. The form autosaves a draft every 10 seconds, so if you close it you can
  restore it later. You can also choose **Save and add another** or **Save as draft**.
- Client tasks need the engagement at **Gate 3 or later**, or must be ticked **Pre-production** (planning or
  onboarding work).
- **Out of scope** work without an approved add-on request is saved as a **Draft**, and the AM is told to raise an
  add-on. Once the client approves the add-on, use Activate.
- **Producers** add tasks only for themselves, or add subtasks of their own work. They can't assign other people or
  change deadlines. Instead they **Ask for a new deadline** or press **Can't take this**, and their Department Head
  decides.
- An assignee who is on approved leave on the deadline is refused. A Department Head or Admin can tick "Override
  leave"; anyone else's request goes to the Department Head for approval. Above 100% load you see a warning. Above
  120%, someone who is not the Department Head needs their approval.
- A parent task can't be marked Done while any of its subtasks are open. A task waiting on another shows "Waiting"
  and can't start until the other task is Done.
- **Blocked** needs a reason, what you are waiting for, who can unblock it and an expected date. Those people, the
  AM and the Department Head are told.
- **Done** on an ad-hoc task attached to a deliverable goes to **QC** (a QC step is created if there isn't one). It
  never goes straight to the client.
- A deadline change needs a reason. If it moves a client-facing date, the AM is asked to post an update in the client
  thread. Every change is counted on the task (`deadlineChanges`) for delivery reports.
- Archive needs a reason and also archives the task's subtasks. Restore puts everything back to its previous status.
- **Recurring**: daily, weekly, monthly or at each cycle start, with an end date. Tasks are created 7 days ahead and
  skip Sundays and holidays. A background job (every 10 minutes) keeps this going, and is switched off in tests.
- **Templates**: pick a flow template, a client (or Internal) and a start date. Choose a person for each role (their
  load is shown), check the preview of every task and deadline (working days), then create them all.
- **Automatic help** (same background job):
  - A task still "To do" one working day before its deadline alerts the Department Head (once per task).
  - Tasks due during someone's approved leave are suggested for reassignment to the Department Head 2 working days
    before the leave starts.

### Approvals (`/team/approvals` → "Needs you", and Command Centre → **Approvals**)
- Covers reassignments above 120% load or onto someone on leave, producers' deadline requests, "Can't take this"
  hand-backs (the approver picks the new owner), new tasks for someone on leave, and anything other areas register.
- Approve (with an optional note) or Reject (a reason is required). The change is made only when it is approved.
  Requests expire after **72 working hours**. "What I asked for" lists your own requests, and you can withdraw one.
- The Command Centre queue shows all requests to Founders and Admins. AM Leads and Department Heads see their own
  area's requests. It has a status filter.

### Mobile app
- A floating **+** on every team tab: **Task** (for a client or internal, with the same rules), **Note** (on a client's
  record, for managers) and **Blocked report** (pick one of your tasks, then give the reason, what you are waiting
  for, who can unblock it and the expected date).
- Task cards on the Tasks tab show the status buttons as before, plus **Reassign** (people with their load after the
  move, a reason and a handover note when the work has started) and **Deadline** (or **Ask new date** for
  producers).

## Building blocks for other areas (`apps/web/src/components/actions/`)
Each file starts with a short comment explaining how to use it. In summary:

| Block | Use it for |
| --- | --- |
| `actions-provider.tsx`: `useActions()` | `openNew(kind, prefill)`, `openReassign({ type, ids })`, `openBulkReassign(userId)`, `notify(msg, undo)`, `version` (reload when it changes), `changed()`. `useActionShortcuts({ n, a, r, d, e, slash })`. |
| `action-drawer.tsx` | `ActionDrawer` (side drawer, full screen on phones, "More details", Save / Save and add another / Save as draft), `ActionDialog` (small prompt), `Field`, `inputCls`, `TextArea`, `useDraftAutosave`. |
| `row-menu.tsx` | The ⋯ menu: items with `hidden` (not allowed) or `disabledReason` (blocked by a rule). |
| `person-picker.tsx` | Choosing an owner, with load bar, leave, open tasks, skills and "Best fit". |
| `reassign-dialog.tsx` | The engine UI for any registered type (impact, deadline handling, reason, handover note, approval). Open it with `openReassign`. |
| `bulk-bar.tsx` | `useSelection(ids)` + `<BulkBar>` + `<BulkButton>` for multi-select lists. |
| `saved-views-menu.tsx` | `<SavedViewsMenu entity="lead" filters={f} onApply={setF} />`. |
| `import-wizard.tsx` | `<ImportWizard entity="leads" open onClose onDone />` for any registered import entity. |
| `history-tab.tsx` | `<HistoryTab entity="Lead" id={id} />`: the audit trail, plus the assignment trail if you pass it. |
| `duplicate-warning.tsx` | `<DuplicateWarning value={name} search={(q) => …} />`: "A similar record already exists". |
| `approvals-list.tsx` | `<ApprovalsList box="mine" \| "requested" \| "all" />`. |
| `tasks/add-task-button.tsx` | `<AddTaskButton prefill={{ engagementId, deliverableId, clientId, deadline }} />` on any page. |
| `tasks/task-menu.tsx` | `<TaskRowMenu task={row} />` and `useTaskActionDialogs()` for task lists on your pages. |

Export: use the existing `CsvButton` from `@/components/charts`.

## How to plug in

### 1. A "+ New" entry
Add it to **your own** file in `apps/web/src/components/actions/plug/` (`people.tsx`, `clients.tsx` or `ops.tsx`), not
to the registry. That way builders working in parallel don't clash.

```tsx
// apps/web/src/components/actions/plug/clients.tsx
import type { NewEntry } from "../new-registry";
import { AddClientDrawer } from "@/components/clients/add-client-drawer";

export const clientsNewEntries: NewEntry[] = [
  { id: "client", label: "Client", hint: "Without a proposal", allowed: (me) => me.roles.some((r) => ["founder", "admin", "am_lead"].includes(r)), Drawer: AddClientDrawer },
];
```

Your drawer gets `{ open, onClose, prefill, onSaved }`. Build it with `ActionDrawer`. After saving, call
`onSaved(newId, "Client added", undoToken?)`. The provider then shows the message (with Undo if you pass a token) and
bumps `version`. The menu order is fixed (`NEW_ORDER`). Entries appear only when `allowed(me)` is true, so the menu
never has dead entries. Ctrl+K "new client" and the **N** key use the same entry automatically.

### 2. A reassign target
In your Nest service, inject `ActionsRegistry` (it is global) and register in `onModuleInit()`:

```ts
this.registry.registerReassignTarget({
  type: 'lead', label: 'Lead', auditEntity: 'Lead',
  load: async (me, ids) => (await this.prisma.lead.findMany({ where: { id: { in: ids }, orgId: me.orgId } }))
    .map((l) => ({ id: l.id, title: l.company, ownerId: l.ownerId, deadline: l.nextActionAt, status: l.stage, inProgress: false, hours: 1 })),
  assertCanReassign: async (me) => { if (!me.roles.includes('sales_manager')) throw new ForbiddenException('Only a sales manager can move leads'); },
  eligibility: async () => ({ where: { roles: { some: { role: { baseRole: { in: ['sales', 'sales_manager'] } } } } } }),
  snapshot: async (items) => items.map((i) => ({ model: 'lead', id: i.id, data: { ownerId: i.ownerId } })),
  apply: async (me, items, { to }) => { await this.prisma.lead.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { ownerId: to.id } }); },
  openWorkOf: async (orgId, userId) => …,           // optional: shows up in "Move all of A's work"
  href: (i) => `/team/leads/${i.id}`,
});
this.registry.registerUndoModel('lead');            // so Undo may restore lead rows
```

The engine handles the rest: the candidate list with load and leave, the impact preview, deadline handling, leave
and capacity rules with Department Head approval, reasons, handover notes, `Assignment` rows (with 7-day read access
for the previous owner), audit, notifications and Undo. On the web, call
`openReassign({ type: 'lead', ids: [lead.id] })`. For records with more than one seat (an engagement's AM /
strategist / producer), pass `roles`. The dialog then asks which seat to change.

### 3. An approval handler
```ts
this.registry.registerApprovalHandler({
  action: 'client.pause', label: 'Pause engagement',
  href: (r) => `/team/projects/${r.targetId}`,
  apply: async ({ approver, req }) => this.pauseNow(approver, req.targetId, req.payload as { until: string }),
  onReject: async ({ approver, req }) => { /* optional */ },
});
// When the action needs approval:
await this.approvals.create(me, { action: 'client.pause', targetType: 'engagement', targetId: id, summary: `Pause ${name}`, payload: { until }, reason, approverRoles: ['am_lead'], diff: [{ field: 'Status', before: 'Active', after: 'Paused' }] });
```
If you leave out `approverId` and `approverRoles`, the approver is the next rank up from the requester. Set
`approveNeeds: 'assignee'` if the approver has to pick a person. The request shows in "Needs you", the top-bar count
and the Command Centre queue. It expires after 72 working hours and is audited. The handler runs only on approval;
if it throws, the request goes back to pending.

### 4. An import entity
Copy `apps/api/src/actions/tasks/task-import.ts`. Register `{ entity, label, fields, sampleCsv, canImport, validate,
commit }`. `validate` returns one `{ errors, duplicate }` per row; `commit` creates the rows (through your normal
create service, so every rule applies) and returns their ids. On the web: `<ImportWizard entity="leads" … />`. Upload,
column mapping (guessed from the headers), the preview with errors and duplicates, the import and the error-report
CSV all come for free.

### 5. An archive entity
```ts
this.registry.registerArchiveEntity({ entity: 'lead', model: 'lead', auditEntity: 'Lead',
  assertCan: async (me, id, action) => { … }, beforeArchive: async (me, id) => { /* refuse if… */ } });
```
Then `api.actions.archive('lead', id, reason)` and `api.actions.restore('lead', id)` work, with a reason, audit and
Undo. The schema already has `archivedAt` and `archivedReason` on clients, leads, engagements, creators and
deliverables.

### 6. Watchers and tags on your records
`api.actions.watchers.*` and `api.actions.tags.*` work for any `type`. Register a visibility check in
`RecordsService.visibility` (core registers `task`) so people can only watch or tag what they can see.

## Data added (one migration: `20261003160000_v11_core`)
New tables: `ApprovalRequest`, `Assignment` (the reassignment trail), `UndoEntry`, `Draft`, `SavedView`, `Watcher`,
`Tag` + `TagLink`, `ImportJob` and `TaskRecurrence`. `archivedAt`/`archivedReason` added to clients, leads,
engagements, creators and deliverables. New task fields: archive, parent/subtasks, description, brief, references,
checklist, estimate, internal, pre-production, draft, out of scope + add-on, blocked details, deadline-change count,
recurrence and created-by. Drafts and archived tasks are stored as status `cancelled` (with `isDraft` / `archivedAt`),
so every existing list and report keeps ignoring them.

## Existing features folded in
- Manager workspace assign / bulk assign, Team leave cover (`leave/:id/reassign`) and the task board's owner change
  now write `Assignment` rows through the engine (`ReassignService.record`), so the history is the same everywhere.
  Their endpoints and tests are unchanged.
- `PATCH /tasks/:id` with edit fields (title, description, priority…) is the task edit action. With status, time or
  owner it behaves exactly as before. That route now also refuses archived and draft tasks, and refuses Done while
  subtasks are open.
- The Activity feed understands tasks (`entity=Task`, including subtasks) and the new action phrases.

## Known limits
- Attachments on new tasks are reference links, or existing files passed by id. Uploading a new file from the task
  form isn't built yet.
- The task card's quick **Blocked** button keeps its one-line reason. The full blocked details are asked for from the ⋯
  menu, the task page, dropping a card on the Blocked column, and the mobile Blocked report.
- The mobile quick add has no photo/video upload or client request (other areas own those).
