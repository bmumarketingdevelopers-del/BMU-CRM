import type { ProposalView } from "@bmu/shared";
import { Badge } from "@/components/ui";

export function statusBadge(p: ProposalView) {
  if (p.paid) return <Badge tone="green">paid</Badge>;
  if (p.status === "draft" && p.discountStatus === "rejected") return <Badge tone="red">discount rejected</Badge>;
  if (p.discountNeedsApproval && !p.discountApproved && p.status === "draft") return <Badge tone="amber">needs approval</Badge>;
  const tones = { draft: "neutral", sent: "dark", accepted: "green", rejected: "red", expired: "red", superseded: "neutral" } as const;
  const open = p.changeRequests?.some((c) => !c.resolvedAt);
  if (p.status === "sent" && open) return <Badge tone="amber">changes requested</Badge>;
  return <Badge tone={tones[p.status]}>{p.status === "sent" && p.viewedAt ? "viewed" : p.status === "accepted" ? "signed" : p.status}</Badge>;
}
