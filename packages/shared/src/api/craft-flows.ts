import type { Transport } from "./transport.js";
import type {
  CraftBrandKitInput,
  CraftBrandKitView,
  CraftChecklistInput,
  CraftChecklistKind,
  CraftChecklistView,
  CraftComment,
  CraftDashboard,
  CraftHookInput,
  CraftHookView,
  CraftScriptInput,
  CraftScriptView,
  CraftSpecialistRow,
  CraftAdhocTaskInput,
  CraftAssignInput,
  CraftBoardTask,
  CraftBulkAssignInput,
  CraftClientCard,
  CraftClientNoteInput,
  CraftManagerView,
  CraftTaskUpdateInput,
} from "../craft-flows.js";

export * from "../craft-flows.js";

const craftQs = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return q ? `?${q}` : "";
};

/** v10 craft area: specialist dashboards and their actions. */
export const craftFlowsApi = (t: Transport) => ({
  craft: {
    /** Your own dashboard, or (leads) someone else's read-only with `userId`. */
    dashboard: (opts: { userId?: string; from?: string; to?: string } = {}) => t.get<CraftDashboard>(`/craft/dashboard${craftQs(opts)}`),
    specialists: () => t.get<CraftSpecialistRow[]>("/craft/specialists"),
    resolveComment: (id: string) => t.post<CraftComment>(`/craft/comments/${id}/resolve`),
    reopenComment: (id: string) => t.post<CraftComment>(`/craft/comments/${id}/reopen`),
    nudge: (deliverableId: string, message?: string) => t.post<{ ok: true; threadId: string; at: string }>(`/craft/deliverables/${deliverableId}/nudge`, { message }),
    hooks: () => t.get<CraftHookView[]>("/craft/hooks"),
    saveHook: (input: CraftHookInput) => t.post<CraftHookView>("/craft/hooks", input),
    useHook: (id: string) => t.post<CraftHookView>(`/craft/hooks/${id}/use`),
    deleteHook: (id: string) => t.del<{ ok: true }>(`/craft/hooks/${id}`),
    scripts: () => t.get<CraftScriptView[]>("/craft/scripts"),
    createScript: (input: CraftScriptInput) => t.post<CraftScriptView>("/craft/scripts", input),
    saveScript: (id: string, input: CraftScriptInput) => t.put<CraftScriptView>(`/craft/scripts/${id}`, input),
    /** Saves the script as a new version (a .md file) of its deliverable, which sends it to QC. */
    submitScript: (id: string) => t.post<CraftScriptView>(`/craft/scripts/${id}/submit`),
    saveChecklist: (deliverableId: string, kind: CraftChecklistKind, input: CraftChecklistInput) => t.put<CraftChecklistView>(`/craft/checklists/${deliverableId}/${kind}`, input),
    brandKit: (clientId: string) => t.get<CraftBrandKitView>(`/craft/brand/${clientId}`),
    saveBrandKit: (clientId: string, input: CraftBrandKitInput) => t.put<CraftBrandKitView>(`/craft/brand/${clientId}`, input),
    uploadBrandFile: (clientId: string, file: Blob, name?: string) => {
      const form = new FormData();
      form.append("file", file, name ?? (file as File).name ?? "brand-file");
      return t.request<CraftBrandKitView>(`/craft/brand/${clientId}/files`, { method: "POST", body: form });
    },
  },
  /** Manager workspace: assign work across the team and look after clients. */
  craftManager: {
    view: () => t.get<CraftManagerView>("/craft/manager"),
    assign: (taskId: string, input: CraftAssignInput) => t.post<CraftBoardTask>(`/craft/manager/tasks/${taskId}/assign`, input),
    bulkAssign: (input: CraftBulkAssignInput) => t.post<{ ok: true; assigned: number }>("/craft/manager/tasks/assign", input),
    updateTask: (taskId: string, input: CraftTaskUpdateInput) => t.patch<CraftBoardTask>(`/craft/manager/tasks/${taskId}`, input),
    createTask: (input: CraftAdhocTaskInput) => t.post<CraftBoardTask>("/craft/manager/tasks", input),
    addClientNote: (clientId: string, input: CraftClientNoteInput) => t.post<CraftClientCard["notes"][number]>(`/craft/manager/clients/${clientId}/notes`, input),
  },
});
