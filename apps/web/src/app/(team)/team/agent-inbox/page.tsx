"use client";

import { AgentInbox } from "@/components/agents/agent-inbox";

export default function AgentInboxPage() {
  return <AgentInbox runHref={(id) => `/team/agent-runs/${id}`} />;
}
