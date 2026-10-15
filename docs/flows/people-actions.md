# People and hierarchy (v11 people)

v11 lets the people who run the team add, move, promote and offboard staff from wherever they are: the Hierarchy
Tree, the Users list, a person's page or **+ New**. Every change needs a reason, is logged in the person's History,
and can be undone where that is safe. Some changes are sent to someone more senior for approval first.

- API rules and permissions: `apps/api/test/people-actions.e2e-spec.ts` (20 tests).
- Browser journeys: `apps/web/e2e/people-actions/*.mjs`. Run each one with
  `BASE_URL=http://localhost:3311 node apps/web/e2e/people-actions/tree.mjs`. The other scripts are `users.mjs`,
  `offboard.mjs` and `forbidden.mjs`. Screenshots go to `/tmp/claude-0/people-shots/`. Each script soft-deletes the
  people it creates (emails starting `journey.people.`) at the end, using `DATABASE_URL` or `apps/api/.env`.

## Where you can do it

| Action | Where |
| --- | --- |
| Add a person | + New → Person · "+ Add person" on any tree node (department, team or manager is filled in for you) · Users → + Add person · Users → Import (CSV) |
| Add a branch, department, team or client pod | + New → Team or pod · "+ Add department" / "+ Add team" / "+ Add branch" / "+ Add pod" on the tree |
| Move | Drag a person onto a department, team or manager on the tree · Move in the profile drawer, the ⋯ menu or the person page · several people at once from the Users list |
| Change role | Change role in the drawer, ⋯ menu or person page · Add role to several people from the Users list |
| Reassign work | Reassign work in the drawer (moves all their open work A → B, with a preview and Undo) |
| Offboard | Offboard in the drawer, ⋯ menu or person page; the checklist is at Onboarding & Offboarding |
| Leave | + New → Leave request, or Team → Profile, leave & attendance |
| Custom role | Roles & Permissions → New custom role, or Clone on a role column |
| Edit details | Edit in the drawer or ⋯ menu. On your own record you can change only your mobile, email and photo |

## Who can do what

| | Founder | Admin | HR / Ops | Department Head | CM Lead | Everyone else |
| --- | --- | --- | --- | --- | --- | --- |
| See the tree and Users | everyone | their branch | everyone | their department | everyone (tree) | no |
| Add a person | yes | yes | yes (not an Admin) | goes to an Admin for approval; only roles below Department Head | no | no |
| Move | yes | yes | no | within their department; across departments goes to an Admin | no | no |
| Change role | yes | yes; making someone an Admin goes to the Founder | no | no | no | no |
| Offboard | yes | yes | starts it; the final confirmation goes to an Admin | no | no | no |
| Branch / department / team | yes | yes | no | no | no | no |
| Client pod | yes | yes | no | no | yes | no |
| Custom role | created now | goes to the Founder | no | no | no | no |

More rules:

- The person giving a role must rank above it. Only the Founder can give the Founder role, and only the Founder can
  approve someone becoming an Admin (another Admin cannot approve it, even from the approvals queue).
- No one can change their own role, and only the Founder can change or move the Founder.
- Client roles are never given from here.
- The old Users endpoint (`PATCH /org/users/:id`) also refuses the Admin role unless the Founder or HR uses it.

## The actions

### Add a person
Required: name, mobile, email, main role (plus up to three secondary roles), department, team (when the department
has teams), manager, branch (follows the department), joining date and employment type. While you pick roles, a
permission preview shows what they will be able to do.
- Duplicate check on mobile and email, both while you type and on save (409 "Possible duplicate").
- Onboarding: pick laptop, accounts, SOP reading and shadowing. This starts the v10 onboarding checklist and gives HR
  and the manager a task due on the joining date.
- Invite: an email is sent, and an SMS is logged (SMS isn't connected yet). The person starts as **Invited** and
  becomes active when they first sign in. They can't own tasks until then.
- CSV import (entity `people`): name, email, phone, role, department, team, manager, branch, joining_date,
  employment_type. Duplicates are flagged and skipped.

### Move
Pick the new department, team and manager, an effective date and a reason. The preview lists what they gain and
lose sight of (department, team, branch and manager visibility) and says whether approval is needed. Open work
either stays with them or is reassigned straight after through the reassign engine.
- Today means it happens now (with Undo). A future date is scheduled, shows as "Change scheduled" on the person and
  can be cancelled. Scheduled changes are applied every 10 minutes, whenever the tree or list is loaded, and by
  `POST /people-actions/jobs/run`.
- A team lead or department head who moves out stops being lead or head of the old unit.
- Moves that would create a reporting loop are refused.

### Change role
Main and secondary roles, effective date and reason. The dialog shows a line-by-line permission diff before you
save. Admin-level changes wait for the Founder.

### Branch, department, team, pod
- **Branch**: name, city and a working-hours calendar (opening time, closing time, working days).
- **Department**: branch, head, and the flow templates and QC checklists to copy in.
- **Team**: department and lead (the lead is placed in the team).
- **Client pod**: CM, strategist, producers and clients. A client can be in only one pod. New tasks for a pod's clients
  go to a pod member by default: first a producer in the task's department with the fewest open tasks, then the
  strategist, then the CM. The task drawer fills this in, and the API does the same when no assignee is sent
  (`podDefaultAssignee` in `apps/api/src/people-actions/pod-defaults.ts`, called from the task create path).

### Leave
Apply from + New or Team → Profile. On the approvals page each leave request lists the tasks due while they are away,
with "Pick cover now". Approving leave that has tasks due links straight to the cover page. `/team/leave/<id>` now
opens that cover page.

### Offboard
1. Last working day, reason and an optional note. This starts the offboarding checklist.
2. It **can't finish** while they own anything open: tasks, clients or engagements as CM, leads, open client requests
   on their engagements, approvals waiting on them, and creator briefs. The dialog lists each one with links. "Move all
   their work…" uses the reassign engine; approvals and briefs have a one-click handover.
3. Checklist: assets returned, access revoked, vault access revoked, files transferred, and the v10 items.
4. Final confirmation: an Admin or the Founder confirms. HR's confirmation becomes an approval for an Admin. The v10
   "Mark complete" for offboarding follows the same rules.
5. Sign-in is disabled at the end of the last day (they keep access through that day). After that they appear under
   **Former** on the tree and with the Former filter on Users.

### Custom role
Clone an existing role, name it, and change the scope for each capability. A Founder's custom role is created
straight away; an Admin's waits for the Founder.

## Screens

- **Hierarchy Tree** (`/admin/hierarchy`): By department or Reporting lines; search; Load % and Leave toggles (kept
  in this browser). Branch → departments → teams → people. A person shows their roles, Invited, On leave, next leave,
  a pending change and their load. Below the branches: Client pods, then Former. Click a person to open the profile
  drawer with Reassign work, Change role, Move, Edit and Offboard. On a phone, use Move in the drawer instead of
  dragging.
- **Users** (`/admin/users`): + Add person, Import, search, filters (department, role, status, branch, employment
  type, Former), saved views, Export, multi-select with Move, Add role and Export, and a ⋯ menu per row (open,
  edit, move, change role, reassign, resend invite, suspend or restore, offboard, history). `?u=<id>` highlights a
  person. On a phone the table becomes cards.
- **Person page** (`/admin/users/<id>`): Overview (profile, actions, scheduled changes, permissions, everything they
  own now) and History (`?tab=history`, from the audit log).

## API

All routes are under `/people-actions`: `options`, `tree`, `people` (list and add), `people/duplicates`,
`people/:id` (get and edit), `:id/invite`, `:id/move/preview`, `:id/move`, `:id/role/preview`, `:id/role`,
`:id/offboarding`, `:id/offboard`, `:id/handover`, `:id/offboard/confirm`, `scheduled/:id/cancel`, `units`, `pods`
(CRUD), `roles`, `bulk` and `jobs/run`. Approval actions: `person.add`, `person.move`, `person.role`, `person.offboard`
and `role.custom`. Undo model: `user`. Import entity: `people`.

Data: `users` gained `joiningDate`, `employmentType`, `photoUrl` and `leftAt`. `branches` gained `workStart`,
`workEnd` and `workDays`. New tables: `people_scheduled_changes` and `client_pods` (migration
`20261003170000_v11_people`).
