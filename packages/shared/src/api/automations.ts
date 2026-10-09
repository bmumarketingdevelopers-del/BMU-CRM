import type { Transport } from "./transport.js";
import type {
  AutomationOptions,
  AutomationOverview,
  AutomationRuleDetail,
  AutomationRuleInput,
  AutomationRunFilters,
  AutomationRunNowResult,
  AutomationRunRow,
  AutomationTestResult,
} from "../automations-types.js";

export * from "../automations-types.js";

const automationQs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** Automations: rules ("when this happens, do that"), templates, dry runs and the run log. */
export const automationsApi = (t: Transport) => ({
  automations: {
    overview: () => t.get<AutomationOverview>("/automations/overview"),
    options: () => t.get<AutomationOptions>("/automations/options"),
    get: (id: string) => t.get<AutomationRuleDetail>(`/automations/${id}`),
    create: (body: AutomationRuleInput) => t.post<AutomationRuleDetail>("/automations", body),
    update: (id: string, body: AutomationRuleInput) => t.put<AutomationRuleDetail>(`/automations/${id}`, body),
    setEnabled: (id: string, enabled: boolean) => t.patch<AutomationRuleDetail>(`/automations/${id}`, { enabled }),
    remove: (id: string) => t.del<{ ok: true }>(`/automations/${id}`),
    fromTemplate: (templateKey: string) => t.post<AutomationRuleDetail>("/automations/from-template", { templateKey }),
    test: (id: string) => t.post<AutomationTestResult>(`/automations/${id}/test`),
    testDraft: (body: AutomationRuleInput) => t.post<AutomationTestResult>("/automations/test", body),
    runNow: (ruleId?: string) => t.post<AutomationRunNowResult>("/automations/run-now", ruleId ? { ruleId } : {}),
    runs: (f: AutomationRunFilters = {}) => t.get<AutomationRunRow[]>(`/automations/runs${automationQs(f)}`),
  },
});
