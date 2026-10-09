# Deliver flow (v10): paid client → final delivery

This covers everything after the first payment, for one-time projects and monthly retainers: onboarding, plan,
tasks, versions, QC, Review Studio, sign-off, final payment and the handover. I tested it in a real browser as the
client owner and approver (a brand-new client and the Sunrise demo accounts), AM, AM lead, strategist, producer,
QC, design head and Founder.

- Journey scripts: `apps/web/e2e/deliver/*.mjs`. Run one with
  `BASE_URL=http://localhost:3000 node apps/web/e2e/deliver/project-journey.mjs`.
- API rules: `apps/api/test/deliver.e2e-spec.ts`.

| Script | What it drives |
| --- | --- |
| `project-journey.mjs` | A new client on a one-time project, from enquiry to the zip download and feedback (G1–G5). |
| `retainer-calendar.mjs` | A new retainer's first month, "Start next month", items rolled over to the next month, and the content calendar. |
| `sla-approvals.mjs` | Delivery SLA and escalation, and the approval rule on the Sunrise accounts. Also checks every new page at phone width. |

## What I tested (end to end)
- **Onboarding (G1)**:
  - The client uploads a file (real PDF) or sends a note for each item on the checklist.
  - The AM opens the file, marks an item blocked (a reason is required), then received.
  - The project start date (RCD) needs every item received, then passes Gate 1.
- **Plan (G2)**:
  - The strategist writes the plan and submits it for internal review.
  - The AM sends it to the client. The client asks for changes, and the planning task reopens.
  - The strategist edits and resubmits, and the AM sends it again.
  - The approvers approve under the client's approval rule.
- **Tasks (G3)**:
  - Tasks are created with owners and deadlines, one chain per deliverable.
  - Task board: Start, Blocked (reason required), Resume, "+30 min" and "Log time" (custom hours), Mark done.
  - A step can't start before the step before it is done.
- **Versions and QC**:
  - Real png, mp4 and pdf uploads, plus a live link.
  - The uploader never gets the QC checklist and the server refuses their QC.
  - A failed QC shows the note to the maker. The fixed version passes.
  - Send to the client is refused until QC passes.
- **Review Studio**:
  - Pinned comments on images, comments at a point in a video, comments on PDFs and links.
  - Requesting changes uses one revision round.
  - The client compares v3 with v1 side by side and approves a specific version. An older version can't be approved.
- **G4 → G5**:
  - When everything is approved, Gate 4 passes and the balance invoice is due.
  - The client signs off and pays (test payment). Gate 5 passes, the engagement is delivered, and every final file is
    released.
  - The zip download contains the final files.
- **It shows up everywhere**:
  - Notifications (bell) for the AM, client, planner, task owners and approvers.
  - My Day, the Projects board, the Client 360 journey and the client journey.
  - Delivery analytics and Client Health.
- **Mobile app (`apps/mobile`)**:
  - Client review: comment, approve version, request changes.
  - Team tasks: Start/Resume, Mark done.
  - These go through the shared API client and hit the same endpoints as the website. The type check and
    `expo export` both pass.

## What was broken and is now fixed
- **Missing notifications.** Nobody was told about most delivery steps, so these are now sent:
  - Requirement sent: to the AM.
  - Project started (RCD): to the planner and the client.
  - Plan submitted: to the AM.
  - Plan ready: to the client deciders.
  - Plan changes requested and plan approved: to the AM.
  - Tasks assigned: to each owner.
  - Final sign-off: to the AM.
- **Plan changes.** When the client asked for changes, the planning task stayed "done", so nobody picked the plan
  up again. It now reopens.
- **Onboarding uploads.** Clients could only type a note on onboarding items. They can now upload the file
  itself, and the AM sees it as an "open file" link. Clients can open their own uploaded files.
- **Client Files** listed every superseded version. It now shows one row per deliverable: the approved version,
  otherwise the latest one sent.
- **Overdue invoices.** The Gate 3 check only counted invoices already marked "overdue". It now also counts issued
  or partly paid invoices past their due date. Production that was held is released automatically when the
  invoice is paid. Before, Gate 3 was never checked again.
- **Old retainer months.** A decision on an older retainer month could move the engagement's current gate back.
  Only the latest month moves it now.
- **Task board** had no way to log anything other than 30 minutes. "Log time" now takes hours.
- **Escalation scope.** The "run escalation now" and "run retainer months now" buttons ran for every organisation.
  They now run only for the caller's own organisation.

## What I added
1. **Monthly retainer months**
   - A job (every 10 minutes, idempotent) and an AM button, "Start <next month>", start each month.
   - Each month gets deliverables from the tier's monthly quota plus whatever was unused last month, spread across
     the month as a draft plan to approve.
   - Starting a month also creates a planning task and issues the month's retainer invoice. If the client has an
     overdue invoice, production is held under the gate rule.
   - The Cycles panel on the project shows quota against planned and approved, what is unused and rolls over, and
     what was carried over.
   - A month can't be started twice: a database lock plus a unique (engagement, month) index. Clicking again is
     refused.
2. **Content calendar**
   - Pages: `/team/content-calendar` and `/client/calendar`, each with month and week views.
   - The team drags an approved post onto a day to schedule it, and drags it again to move it.
   - Time and channel can be edited. A post is marked published with its live link, and the client is notified.
   - The client view is read-only and shows the live link.
3. **Approval rule per client**
   - The options are any one approver, the owner must approve, or every approver.
   - The client owner sets it under Team users; the AM can set it on Client 360.
   - It applies to plan approvals and Review Studio, and shows who approved and who is pending.
   - Pending approvers can be reminded with a button, and are also reminded automatically once every working day while they wait.
4. **Delivery SLA and escalation**
   - Each deliverable has a due date from the plan.
   - Late and at-risk steps and deliverables show on the Projects board (a "Late or at risk" tile and a Delivery
     SLA panel, plus badges on cards), on My Day and on the project page.
   - A step more than one working day late is escalated once to the department head (the AM lead if there is
     none), and the owner and AM are told.
5. **Handover pack at G5**
   - A Final delivery page (`/client/handover/[id]`) lists the approved files plus the links, logins and notes the
     AM added. The logins stay hidden until release.
   - "Download all (.zip)" is streamed from the server.
   - The client gives an NPS score (0–10) and a comment. It goes to the AM, and a low score lowers Client Health.
6. **Seed data** (`apps/api/prisma/seed/deliver.ts`, idempotent)
   - Scheduled and published calendar posts.
   - Handover items, and feedback on delivered projects.
   - One client with "the owner must approve".
   - Retainer months are started by the job on API start.

## Test results
- `deliver.e2e-spec.ts`: 12 tests pass. The full API e2e suite, tsc (api/web/mobile), eslint, the shared build and
  tests, and `expo export` all pass. Final numbers are in the commit report.
- All three browser journeys pass with no page errors.
