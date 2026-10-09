"use client";

import { useParams } from "next/navigation";
import { AgentRunView } from "@/components/agents/agent-run";

export default function TeamAgentRunPage() {
  const { id } = useParams<{ id: string }>()!;
  return <AgentRunView key={id} id={id} back={{ href: "/team/agent-inbox", label: "Agent Inbox" }} />;
}
