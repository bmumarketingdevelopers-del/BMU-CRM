// Generated from BMU_Hub_Architecture_Prompt.json. Edit the JSON spec, then regenerate.
export const permissionsData = {
  "legend": {
    "full": "all records in scope",
    "own": "only own records/assigned clients/tasks",
    "none": "no access"
  },
  "matrix": {
    "leads_pipeline": {
      "founder": "full",
      "admin": "full",
      "sales_manager": "full",
      "sales_executive": "own",
      "am_lead": "none",
      "account_manager": "none",
      "producer": "none",
      "finance": "none",
      "client_owner": "none"
    },
    "proposal_price_override": {
      "founder": "full",
      "admin": "full (within limit)",
      "sales_manager": "within discount_limit",
      "sales_executive": "none",
      "account_manager": "none"
    },
    "mark_rcd_gate1": {
      "founder": "full",
      "account_manager": "own",
      "am_lead": "full",
      "others": "none"
    },
    "plan_and_calendar": {
      "founder": "full",
      "strategist": "own",
      "account_manager": "own",
      "department_head": "full (dept)",
      "client_owner": "approve",
      "client_approver": "approve",
      "client_viewer": "view"
    },
    "tasks_files": {
      "founder": "full",
      "department_head": "full (dept)",
      "account_manager": "own",
      "strategist": "own",
      "producer": "own",
      "intern": "own",
      "qc_reviewer": "own",
      "client_any": "files: released only"
    },
    "qc_pass_fail": {
      "founder": "full",
      "department_head": "full (dept)",
      "qc_reviewer": "own",
      "others": "none"
    },
    "send_draft_to_client": {
      "founder": "full",
      "account_manager": "own (requires QC pass)",
      "others": "none"
    },
    "approve_creative": {
      "client_owner": "full",
      "client_approver": "full",
      "others": "none"
    },
    "quote_addon": {
      "founder": "full",
      "admin": "full",
      "account_manager": "own (from add-on price list only)",
      "others": "none"
    },
    "approve_addon_quote": {
      "client_owner": "full",
      "others": "none"
    },
    "invoices_payments": {
      "founder": "full",
      "admin": "full",
      "finance": "full",
      "client_owner": "own",
      "client_finance": "own",
      "others": "none"
    },
    "revenue_margins": {
      "founder": "full",
      "admin": "full",
      "finance": "view",
      "others": "none"
    },
    "users_roles_hierarchy": {
      "founder": "full",
      "admin": "branch",
      "department_head": "view dept",
      "hr_ops": "people data only",
      "client_owner": "own client users"
    },
    "catalogue_pricing_engine": {
      "founder": "full",
      "admin": "propose (founder approves)",
      "others": "none"
    },
    "sop_checklists_flow_templates": {
      "founder": "full",
      "admin": "full",
      "department_head": "edit dept (admin approves)",
      "others": "view"
    },
    "audit_log": {
      "founder": "full",
      "admin": "branch",
      "others": "none"
    },
    "credential_vault_reveal": {
      "account_manager": "own (logged)",
      "department_head": "on request, approved by CM (logged)",
      "founder": "full (logged)",
      "others": "none"
    }
  },
  "client_hidden_data": [
    "internal notes",
    "QC results",
    "task owners below CM",
    "costs, margins, staff rates",
    "other clients",
    "creator rates"
  ]
} as const;
