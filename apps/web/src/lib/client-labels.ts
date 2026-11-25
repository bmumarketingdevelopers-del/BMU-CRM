// Client-facing status labels (glossary: Blocked → Waiting on input).
export const clientProjectStatus: Record<string, string> = {
  pending_payment: "Awaiting payment",
  onboarding: "Getting started",
  blocked: "Waiting on input",
  planning: "Planning",
  awaiting_plan_approval: "Plan ready for you",
  in_production: "In production",
  in_review: "Ready for your review",
  awaiting_final_payment: "Final payment due",
  delivered: "Delivered",
  active_retainer: "Active",
  paused: "Paused",
  offboarding: "Wrapping up",
  closed: "Closed",
};
