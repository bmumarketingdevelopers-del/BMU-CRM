"use client";

import { useParams } from "next/navigation";
import { AgentRunView } from "@/components/agents/agent-run";

export default function AgentRunPage() {
  const { id } = useParams<{ id: string }>()!;
  return <AgentRunView key={id} id={id} back={{ href: "/admin/agents/runs", label: "Run log" }} />;
}
