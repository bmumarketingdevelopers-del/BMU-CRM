// Generated from BMU_Hub_Architecture_Prompt.json. Edit the JSON spec, then regenerate.
export const workflowData = {
  "phases": [
    {
      "id": "sell",
      "owner": "sales",
      "steps": [
        "lead",
        "discovery",
        "proposal",
        "commercial_approved?",
        "payment_agreement",
        "handover"
      ]
    },
    {
      "id": "onboard",
      "owner": "account_manager",
      "steps": [
        "onboarding",
        "requirement_collection",
        "all_inputs_received?",
        "rcd"
      ]
    },
    {
      "id": "plan",
      "owner": "strategist",
      "window": "up to 4 working days after RCD",
      "steps": [
        "planning",
        "internal_approval?",
        "client_plan_presentation",
        "client_approved?"
      ]
    },
    {
      "id": "build",
      "owner": "department",
      "first_draft": "2–3 working days after approved plan + inputs",
      "steps": [
        "ready_to_execute?",
        "production",
        "internal_qc?",
        "first_draft_to_client",
        "draft_approved?"
      ]
    },
    {
      "id": "deliver",
      "owner": "account_manager",
      "steps": [
        "final_approval",
        "payment_complete?",
        "publish_deploy_handover",
        "reporting",
        "retainer_continues? → next cycle (back to plan) or offboarding"
      ]
    }
  ],
  "gates": [
    {
      "id": "G1",
      "name": "Requirements Complete",
      "unlock_when": "All requirement checklist items received AND AM marks RCD",
      "locks": [
        "planning timer",
        "strategy workspace",
        "project clock"
      ]
    },
    {
      "id": "G2",
      "name": "Plan Approved",
      "unlock_when": "Client Owner/Approver approves plan in writing in-app",
      "locks": [
        "production task generation"
      ],
      "effect": "plan becomes read-only"
    },
    {
      "id": "G3",
      "name": "Production Approved to Start",
      "unlock_when": "requirements + approved plan + assets + access + payment condition met + task assigned",
      "locks": [
        "start production"
      ],
      "effect": "deadline written to schedule"
    },
    {
      "id": "G4",
      "name": "Draft Approved",
      "unlock_when": "Internal QC passed AND client approves draft",
      "locks": [
        "send to client (needs QC)",
        "final production"
      ],
      "effect": "approved version locked"
    },
    {
      "id": "G5",
      "name": "Final Delivery",
      "unlock_when": "Written final sign-off AND final payment cleared",
      "locks": [
        "final file download",
        "deploy",
        "handover"
      ]
    }
  ],
  "state_machines": {
    "lead": [
      "new",
      "contacted",
      "discovery",
      "proposal_sent",
      "won",
      "lost"
    ],
    "engagement": [
      "pending_payment",
      "onboarding",
      "blocked",
      "planning",
      "awaiting_plan_approval",
      "in_production",
      "in_review",
      "awaiting_final_payment",
      "delivered",
      "active_retainer",
      "paused",
      "offboarding",
      "closed"
    ],
    "deliverable": [
      "planned",
      "in_production",
      "in_qc",
      "qc_failed",
      "ready_for_client",
      "changes_requested",
      "approved",
      "scheduled",
      "published"
    ],
    "task": [
      "todo",
      "in_progress",
      "blocked",
      "waiting",
      "in_qc",
      "done",
      "cancelled"
    ],
    "request": [
      "received",
      "scope_check",
      "in_scope",
      "quoted",
      "approved",
      "paid",
      "in_progress",
      "done",
      "declined",
      "rescheduled"
    ],
    "invoice": [
      "draft",
      "issued",
      "partially_paid",
      "paid",
      "overdue",
      "void",
      "credit_noted"
    ]
  }
} as const;
