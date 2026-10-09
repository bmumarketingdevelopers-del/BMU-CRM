import type { Transport } from "./transport.js";
import type {
  AiAskInput,
  AiConversationSummary,
  AiConversationView,
  AiDigestView,
  AiGenerateInput,
  AiResult,
  AiSettings,
  AiStatus,
  AiUsageView,
} from "../ai-flows.js";

export * from "../ai-flows.js";

/** v10 AI Copilot. Streaming variants (POST /ai/generate/stream, /ai/ask/stream) are read with fetch in the web app. */
export const aiFlowsApi = (t: Transport) => ({
  ai: {
    status: () => t.get<AiStatus>("/ai/status"),
    generate: (input: AiGenerateInput) => t.post<AiResult>("/ai/generate", input),
    ask: (input: AiAskInput) => t.post<AiResult>("/ai/ask", input),
    clientAsk: (input: AiAskInput) => t.post<AiResult>("/ai/client/ask", input),
    conversations: () => t.get<AiConversationSummary[]>("/ai/conversations"),
    conversation: (id: string) => t.get<AiConversationView>(`/ai/conversations/${id}`),
    deleteConversation: (id: string) => t.del<{ ok: true }>(`/ai/conversations/${id}`),
    digest: () => t.get<AiDigestView | null>("/ai/digest"),
    makeDigest: () => t.post<AiDigestView>("/ai/digest"),
    usage: () => t.get<AiUsageView>("/ai/usage"),
    saveSettings: (value: AiSettings) => t.put<AiUsageView>("/ai/settings", value),
  },
});
