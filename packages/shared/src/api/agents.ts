import type { Transport } from "./transport.js";
import type {
  AgentAskInput,
  AgentAskResult,
  AgentDecideInput,
  AgentEvalResult,
  AgentFeedbackInput,
  AgentKey,
  AgentPatch,
  AgentProposalView,
  AgentRunDetail,
  AgentRunRow,
  AgentsOverview,
  AgentTickResult,
  AgentView,
} from "../agents-types.js";

export * from "../agents-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v15 AI agents: settings, run log with undo, the Agent Inbox, Ask the Analyst and the safety checks. */
export const agentsApi = (t: Transport) => ({
  agents: {
    overview: () => t.get<AgentsOverview>("/agents"),
    update: (key: AgentKey, body: AgentPatch) => t.patch<AgentView>(`/agents/${key}`, body),
    runNow: (key: AgentKey, subjectId?: string) => t.post<AgentRunDetail[]>(`/agents/${key}/run`, { subjectId }),
    tick: () => t.post<AgentTickResult>("/agents/tick", {}),
    ask: (body: AgentAskInput) => t.post<AgentAskResult>("/agents/analyst/ask", body),
    runs: (f: { agent?: string; subjectId?: string; status?: string } = {}) => t.get<AgentRunRow[]>(`/agents/runs${qs(f)}`),
    run: (id: string) => t.get<AgentRunDetail>(`/agents/runs/${id}`),
    undoRun: (id: string) => t.post<AgentRunDetail>(`/agents/runs/${id}/undo`, {}),
    undoStep: (runId: string, stepId: string) => t.post<AgentRunDetail>(`/agents/runs/${runId}/steps/${stepId}/undo`, {}),
    feedback: (id: string, body: AgentFeedbackInput) => t.post<AgentRunDetail>(`/agents/runs/${id}/feedback`, body),
    inbox: (status: "pending" | "decided" = "pending") => t.get<AgentProposalView[]>(`/agents/inbox${qs({ status })}`),
    decide: (id: string, body: AgentDecideInput) => t.post<AgentProposalView>(`/agents/inbox/${id}/decide`, body),
    evals: () => t.post<AgentEvalResult>("/agents/evals", {}),
    refreshKnowledge: () => t.post<{ chunks: number }>("/agents/knowledge/refresh", {}),
  },
});
