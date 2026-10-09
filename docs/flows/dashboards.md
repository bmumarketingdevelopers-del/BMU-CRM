# Dashboard Studio (v12)

Command Centre → **Dashboards → Dashboard Studio** (`/admin/dashboards`). Only the Founder and Admins can change
dashboards; the API checks this on every change.

## What you can do
- **Edit a built-in dashboard**: Weekly Review (`/admin`), Scorecard (`/admin/analytics`), My Day, Manager
  workspace and Specialist workspace (`/team`, `/team/manager`) and the Client home (`/client`). In the editor, each
  section has a toolbar: drag handle and ↑ ↓ to move, width (Full, 2/3, 1/2, 1/3), ✕ to hide. Hidden sections
  are listed and come back from **+ Add widget → Sections**. Who sees a built-in dashboard does not change.
- **Add widgets**: Numbers (any Report Builder metric, a period, change vs the period before), Charts (metric ×
  grouping, line/columns/bars/table), Saved reports (shared automatically when added), Lists (my tasks, tasks due
  this week, overdue, blocked, open requests, requests past reply time, new leads, follow-ups due, overdue
  invoices), Sections from any built-in dashboard, Notes and Quick links. The Client home only takes its own
  sections, notes and links: team numbers never reach clients.
- **Create a dashboard**: + New dashboard (or + New → Dashboard): blank, a template (Sales, Delivery, Client
  service, Finance) or a copy of any dashboard. Pick who sees it (everyone, roles, specialties, named people) and
  where (under Dashboards in the menu, or as their team app / Command Centre home). For home pages, named people
  win over specialties, then roles.
- **Save, history, reset**: Save keeps a version with an optional note. ⋯ → History restores any version (saved as
  the newest one). Built-ins: ⋯ → Reset to original. Custom: Duplicate, Archive (with a reason) and Restore from the
  Archived tab. Every change is in the Audit Log.

## Data and permissions
Widget data comes from `/dashboards/data/*` and is scoped to the viewer: Command Centre readers see everyone's
numbers; other team members see their own (facts where they are the person). Money numbers stay with the Founder,
Admin and Finance. Lists follow the same rules (own tasks, own leads, invoices for money roles).

## Code
- Shared: `packages/shared/src/dashboards.ts` (built-in sections, widget schema, templates, audience rules).
- API: `apps/api/src/dashboards/` (models `Dashboard`, `DashboardVersion`, migration `20261004090000_v12_dashboards`).
- Web: `apps/web/src/components/dashboards/` (grid, widgets, editor, library, settings); built-in dashboards pass
  their sections to `DashGrid`.

## Tested
- API: `apps/api/test/dashboards.e2e-spec.ts` (editing, versions, reset, client home rules, audiences and homes,
  archive/restore, saved reports, scoped data, forbidden roles).
- Browser: `apps/web/e2e/dashboards/studio.mjs` (edit Weekly Review, history, build a sales home, what sales and
  finance see, client home note, every built-in editor, forbidden roles, phone width, archive).
