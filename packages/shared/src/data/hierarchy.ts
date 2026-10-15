// Generated from BMU_Hub_Architecture_Prompt.json. Edit the JSON spec, then regenerate.
export const hierarchyData = {
  "team_roles": [
    {
      "rank": 1,
      "id": "founder",
      "name": "Founder / Super Admin",
      "reports_to": null,
      "scope": "all tenants/branches",
      "can_manage": "everything, including roles, pricing, commercial terms"
    },
    {
      "rank": 2,
      "id": "admin",
      "name": "Branch Manager",
      "reports_to": "founder",
      "scope": "assigned branch(es)",
      "can_manage": "users, departments, clients, settings within branch; cannot change Founder or tenant billing"
    },
    {
      "rank": 3,
      "id": "department_head",
      "name": "Department Head",
      "reports_to": "admin",
      "scope": "own department",
      "can_manage": "department members, flow templates and QC checklists of own department (subject to admin approval), capacity, task reassignment"
    },
    {
      "rank": 4,
      "id": "sales_manager",
      "name": "Sales Manager",
      "reports_to": "admin",
      "scope": "sales team + all leads",
      "can_manage": "lead assignment, proposals, discounts up to configured limit"
    },
    {
      "rank": 4,
      "id": "am_lead",
      "name": "Client Manager Lead",
      "reports_to": "admin",
      "scope": "all CMs and their clients",
      "can_manage": "CM assignment, escalations, client health"
    },
    {
      "rank": 5,
      "id": "account_manager",
      "name": "Client Manager",
      "reports_to": "am_lead",
      "scope": "assigned clients",
      "can_manage": "onboarding, RCD, client comms, requests, quotes from add-on list, sending drafts"
    },
    {
      "rank": 5,
      "id": "strategist",
      "name": "Strategist",
      "reports_to": "department_head",
      "scope": "assigned engagements",
      "can_manage": "plans, calendars"
    },
    {
      "rank": 5,
      "id": "sales_executive",
      "name": "Sales Executive",
      "reports_to": "sales_manager",
      "scope": "own leads",
      "can_manage": "own leads and proposals at catalogue price"
    },
    {
      "rank": 5,
      "id": "qc_reviewer",
      "name": "QC Reviewer",
      "reports_to": "department_head",
      "scope": "assigned QC queue",
      "can_manage": "pass/fail QC"
    },
    {
      "rank": 5,
      "id": "finance",
      "name": "Finance",
      "reports_to": "admin",
      "scope": "all invoices/payments in branch",
      "can_manage": "invoices, credit notes, reconciliation, creator payouts"
    },
    {
      "rank": 5,
      "id": "hr_ops",
      "name": "HR / Ops",
      "reports_to": "admin",
      "scope": "people data",
      "can_manage": "attendance, leave, onboarding/offboarding of staff"
    },
    {
      "rank": 6,
      "id": "producer",
      "name": "Producer (Designer, Editor, Developer, SEO Exec, Ads Exec, UGC Coordinator)",
      "reports_to": "department_head",
      "scope": "assigned tasks",
      "can_manage": "own tasks, uploads, blocked status"
    },
    {
      "rank": 7,
      "id": "intern",
      "name": "Intern",
      "reports_to": "department_head",
      "scope": "assigned tasks, no client contact data",
      "can_manage": "own tasks only; uploads require producer/lead review"
    }
  ],
  "client_roles": [
    {
      "rank": 1,
      "id": "client_owner",
      "name": "Client Owner",
      "can": "approve plans and work, approve quotes, pay, add/remove client users, view all reports"
    },
    {
      "rank": 2,
      "id": "client_approver",
      "name": "Client Approver",
      "can": "review and approve creative only, raise requests"
    },
    {
      "rank": 3,
      "id": "client_viewer",
      "name": "Client Viewer",
      "can": "view progress, files and reports; comment only"
    },
    {
      "rank": 4,
      "id": "client_finance",
      "name": "Client Finance",
      "can": "view and pay invoices, download receipts"
    }
  ],
  "departments": [
    "Sales",
    "Client Management",
    "Strategy",
    "Creative / Design",
    "Video / Production",
    "Web / AI",
    "SEO",
    "Performance Ads",
    "Creator / UGC",
    "QC",
    "Finance",
    "HR / Ops"
  ]
} as const;
