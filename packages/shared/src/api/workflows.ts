import type { Transport } from "./transport.js";
import type {
  WorkflowDetail,
  WorkflowInput,
  WorkflowMoveResult,
  WorkflowOptions,
  WorkflowOverview,
  WorkflowRunDetail,
  WorkflowRunFilters,
  WorkflowRunRow,
  WorkflowTestResult,
  WorkflowTickResult,
  WhatsAppQueueRow,
} from "../workflows-types.js";

export * from "../workflows-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v14 workflows: builder, versions, test, run log, and moving older automations across. */
export const workflowsApi = (t: Transport) => ({
  workflows: {
    overview: () => t.get<WorkflowOverview>("/workflows/overview"),
    options: () => t.get<WorkflowOptions>("/workflows/options"),
    get: (id: string) => t.get<WorkflowDetail>(`/workflows/${id}`),
    create: (body: WorkflowInput) => t.post<WorkflowDetail>("/workflows", body),
    update: (id: string, body: WorkflowInput) => t.put<WorkflowDetail>(`/workflows/${id}`, body),
    setEnabled: (id: string, enabled: boolean) => t.patch<WorkflowDetail>(`/workflows/${id}`, { enabled }),
    remove: (id: string) => t.del<{ ok: true }>(`/workflows/${id}`),
    fromTemplate: (templateKey: string) => t.post<WorkflowDetail>("/workflows/from-template", { templateKey }),
    test: (body: WorkflowInput) => t.post<WorkflowTestResult>("/workflows/test", body),
    runNow: () => t.post<WorkflowTickResult>("/workflows/run-now", {}),
    runs: (f: WorkflowRunFilters = {}) => t.get<WorkflowRunRow[]>(`/workflows/runs${qs(f)}`),
    run: (id: string) => t.get<WorkflowRunDetail>(`/workflows/runs/${id}`),
    cancelRun: (id: string) => t.post<WorkflowRunDetail>(`/workflows/runs/${id}/cancel`, {}),
    forRecord: (entity: string, id: string) => t.get<WorkflowRunRow[]>(`/workflows/runs${qs({ entity, entityId: id })}`),
    whatsappQueue: () => t.get<WhatsAppQueueRow[]>("/workflows/whatsapp-queue"),
    moveAutomations: (ruleId?: string) => t.post<WorkflowMoveResult>("/workflows/move-automations", ruleId ? { ruleId } : {}),
  },
});
