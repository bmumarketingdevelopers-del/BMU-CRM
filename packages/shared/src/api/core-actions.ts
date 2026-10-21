import type { Transport } from "./transport.js";
import type {
  CoreApprovalView,
  CoreBulkReassign,
  CoreCandidates,
  CoreDecideApproval,
  CoreDraft,
  CoreImportEntityInfo,
  CoreImportJob,
  CoreOpenWork,
  CorePaletteResult,
  CoreReassignApply,
  CoreReassignPreview,
  CoreReassignPreviewInput,
  CoreReassignResult,
  CoreRecurrence,
  CoreSavedView,
  CoreSavedViewInput,
  CoreTag,
  CoreTaskBulk,
  CoreTaskCreate,
  CoreTaskDetail,
  CoreTaskEdit,
  CoreTaskFormOptions,
  CoreTaskMutation,
  CoreTaskQuery,
  CoreTaskRow,
  CoreTemplatePreview,
  CoreTemplatePreviewInput,
  CoreUndo,
  CoreWatchers,
} from "../core-actions.js";
import type { TaskStatus } from "../production.js";

const qs = (params: Record<string, string | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v);
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}` : "";
};

/** v11 core: shared action system (reassign engine, approvals, undo, drafts, views, watchers, tags, imports) and task actions. */
export const coreActionsApi = (t: Transport) => ({
  actions: {
    reassign: {
      /** Eligible people for the selected records (or for a new record: pass ctx instead of ids). */
      candidates: (type: string, ids: string[], ctx: { departmentId?: string; deadline?: string; estimateHours?: string; engagementId?: string; role?: string } = {}) =>
        t.get<CoreCandidates>(`/actions/reassign/${type}/candidates${qs({ ids: ids.join(","), ...ctx })}`),
      preview: (type: string, input: CoreReassignPreviewInput) => t.post<CoreReassignPreview>(`/actions/reassign/${type}/preview`, input),
      apply: (type: string, input: CoreReassignApply) => t.post<CoreReassignResult>(`/actions/reassign/${type}/apply`, input),
      types: () => t.get<{ type: string; label: string }[]>("/actions/reassign/types"),
      openWork: (userId: string) => t.get<CoreOpenWork>(`/actions/reassign/open-work/${userId}`),
      bulk: (input: CoreBulkReassign) => t.post<CoreReassignResult>("/actions/reassign/bulk", input),
    },
    approvals: {
      list: (box: "mine" | "requested" | "all" = "mine", status?: string) => t.get<CoreApprovalView[]>(`/actions/approvals${qs({ box, status })}`),
      get: (id: string) => t.get<CoreApprovalView>(`/actions/approvals/${id}`),
      decide: (id: string, input: CoreDecideApproval) => t.post<CoreApprovalView>(`/actions/approvals/${id}/decide`, input),
      cancel: (id: string) => t.post<CoreApprovalView>(`/actions/approvals/${id}/cancel`),
      count: () => t.get<{ pending: number }>("/actions/approvals/count"),
    },
    undo: (token: string) => t.post<{ ok: true; message: string }>(`/actions/undo/${token}`),
    drafts: {
      get: (entity: string, key = "new") => t.get<CoreDraft | null>(`/actions/drafts/${entity}${qs({ key })}`),
      save: (entity: string, key: string, payload: Record<string, unknown>) => t.put<CoreDraft>(`/actions/drafts/${entity}`, { key, payload }),
      remove: (entity: string, key = "new") => t.del<{ ok: true }>(`/actions/drafts/${entity}${qs({ key })}`),
    },
    views: {
      list: (entity: string) => t.get<CoreSavedView[]>(`/actions/views/${entity}`),
      create: (entity: string, input: CoreSavedViewInput) => t.post<CoreSavedView>(`/actions/views/${entity}`, input),
      update: (id: string, input: Partial<CoreSavedViewInput>) => t.patch<CoreSavedView>(`/actions/views/item/${id}`, input),
      remove: (id: string) => t.del<{ ok: true }>(`/actions/views/item/${id}`),
    },
    watchers: {
      get: (type: string, id: string) => t.get<CoreWatchers>(`/actions/watchers/${type}/${id}`),
      watch: (type: string, id: string, userIds?: string[]) => t.post<CoreWatchers>(`/actions/watchers/${type}/${id}`, { userIds }),
      unwatch: (type: string, id: string, userId?: string) => t.del<CoreWatchers>(`/actions/watchers/${type}/${id}${qs({ userId })}`),
    },
    tags: {
      list: () => t.get<CoreTag[]>("/actions/tags"),
      create: (name: string, color?: string) => t.post<CoreTag>("/actions/tags", { name, color }),
      of: (type: string, id: string) => t.get<CoreTag[]>(`/actions/tags/${type}/${id}`),
      set: (type: string, id: string, input: { tagIds?: string[]; names?: string[] }) => t.put<CoreTag[]>(`/actions/tags/${type}/${id}`, input),
    },
    archive: (entity: string, id: string, reason: string) => t.post<{ ok: true; undo: CoreUndo | null }>(`/actions/archive/${entity}/${id}`, { reason }),
    restore: (entity: string, id: string) => t.post<{ ok: true }>(`/actions/restore/${entity}/${id}`),
    palette: (q: string) => t.get<CorePaletteResult>(`/actions/palette${qs({ q })}`),
    runJobs: () => t.post<{ ok: true; results: Record<string, number> }>("/actions/jobs/run"),
  },
  imports: {
    entities: () => t.get<CoreImportEntityInfo[]>("/imports"),
    preview: (entity: string, input: { csv: string; fileName?: string; mapping?: Record<string, string> }) => t.post<CoreImportJob>(`/imports/${entity}`, input),
    remap: (jobId: string, mapping: Record<string, string>) => t.post<CoreImportJob>(`/imports/jobs/${jobId}/mapping`, { mapping }),
    commit: (jobId: string, skipDuplicates = true) => t.post<CoreImportJob>(`/imports/jobs/${jobId}/commit`, { skipDuplicates }),
    jobs: (entity?: string) => t.get<CoreImportJob[]>(`/imports/jobs${qs({ entity })}`),
    job: (jobId: string) => t.get<CoreImportJob>(`/imports/jobs/${jobId}`),
    /** Path (under the API base) of the CSV error report. */
    errorReportPath: (jobId: string) => `/imports/jobs/${jobId}/errors.csv`,
  },
  coreTasks: {
    query: (q: CoreTaskQuery = {}) => t.get<CoreTaskRow[]>(`/tasks/query${qs(q as Record<string, string | undefined>)}`),
    get: (id: string) => t.get<CoreTaskDetail>(`/tasks/${id}`),
    /** v38: send a file on the task (the owner, creator and watchers find it in Files too). */
    attachFile: (id: string, file: Blob) => {
      const form = new FormData();
      form.append("file", file);
      return t.request<{ message: string; task: CoreTaskDetail }>(`/tasks/${id}/files`, { method: "POST", body: form });
    },
    formOptions: (engagementId?: string) => t.get<CoreTaskFormOptions>(`/tasks/form-options${qs({ engagementId })}`),
    create: (input: CoreTaskCreate) => t.post<CoreTaskMutation>("/tasks", input),
    edit: (id: string, input: CoreTaskEdit) => t.patch<CoreTaskMutation>(`/tasks/${id}/details`, input),
    status: (id: string, status: TaskStatus, blocked?: { reason: string; waitingFor: string; responsibleId?: string | null; responsibleName?: string; expectedAt: string }) =>
      t.post<CoreTaskMutation>(`/tasks/${id}/status`, { status, blocked }),
    deadline: (id: string, deadline: string, reason: string) => t.post<CoreTaskMutation>(`/tasks/${id}/deadline`, { deadline, reason }),
    duplicate: (id: string, input: { withSubtasks?: boolean; count?: number } = {}) => t.post<{ ids: string[]; undo: CoreUndo | null }>(`/tasks/${id}/duplicate`, input),
    archive: (id: string, reason: string) => t.post<CoreTaskMutation>(`/tasks/${id}/archive`, { reason }),
    restore: (id: string) => t.post<CoreTaskMutation>(`/tasks/${id}/restore`),
    handback: (id: string, reason: string) => t.post<CoreTaskMutation>(`/tasks/${id}/handback`, { reason }),
    activate: (id: string, addOnRequestId: string) => t.post<CoreTaskMutation>(`/tasks/${id}/activate`, { addOnRequestId }),
    addDependency: (id: string, dependsOnId: string) => t.post<CoreTaskMutation>(`/tasks/${id}/dependencies`, { dependsOnId }),
    removeDependency: (id: string, dependsOnId: string) => t.del<CoreTaskMutation>(`/tasks/${id}/dependencies/${dependsOnId}`),
    bulk: (input: CoreTaskBulk) => t.post<{ ok: true; changed: number; undo: CoreUndo | null; message: string }>("/tasks/bulk", input),
    templatePreview: (input: CoreTemplatePreviewInput) => t.post<CoreTemplatePreview>("/tasks/from-template/preview", input),
    fromTemplate: (input: CoreTemplatePreviewInput) => t.post<{ ids: string[]; undo: CoreUndo | null; message: string }>("/tasks/from-template", input),
    recurring: () => t.get<CoreRecurrence[]>("/tasks/recurring"),
    stopRecurring: (id: string) => t.del<CoreRecurrence[]>(`/tasks/recurring/${id}`),
  },
});
