import { requestStatusLabels, requestTypeLabels, type RequestStatus, type RequestType, type SlaState } from "@bmu/shared";
import { Badge } from "@/components/ui";

export const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

const hm = (m: number) => {
  const a = Math.abs(m);
  return a >= 60 ? `${Math.floor(a / 60)}h ${a % 60 ? `${a % 60}m` : ""}`.trim() : `${a}m`;
};

/** First-reply SLA, counted in working hours (9:30–18:30 Mon–Sat IST). */
export function SlaBadge({ sla }: { sla: SlaState }) {
  if (!sla.firstReplyDue) return null;
  if (sla.state === "met") return <Badge tone="green">Replied on time</Badge>;
  if (sla.state === "breached") return <Badge tone="red">Replied late</Badge>;
  if (sla.state === "overdue") return <Badge tone="red">Reply overdue {hm(sla.workingMinutesLeft ?? 0)}</Badge>;
  const left = sla.workingMinutesLeft ?? 0;
  return <Badge tone={left <= 60 ? "amber" : "neutral"}>Reply in {hm(left)}</Badge>;
}

export function RequestStatusBadge({ status, side }: { status: RequestStatus; side: "client" | "team" }) {
  const tone = ["done"].includes(status) ? "green" : ["declined"].includes(status) ? "red" : ["quoted", "approved"].includes(status) ? "amber" : "dark";
  return <Badge tone={tone}>{requestStatusLabels[status]?.[side] ?? status}</Badge>;
}

export function RequestTypeLabel({ type, side }: { type: RequestType; side: "client" | "team" }) {
  return <span className={type === "urgent" ? "font-semibold text-red" : ""}>{requestTypeLabels[type]?.[side] ?? type}</span>;
}
