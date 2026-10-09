import type { Transport } from "./transport.js";
import type {
  CustomFieldDefView,
  CustomFieldEntity,
  CustomFieldInput,
  CustomFieldRecordView,
  CustomFieldUpdate,
  CustomFieldValues,
  FormDetail,
  FormInput,
  FormPublic,
  FormRow,
  FormSubmissionRow,
  FormSubmit,
  FormSubmitResult,
  PipelineKind,
  PipelineConfigView,
  PipelineUpdate,
  PipelinesView,
} from "../customise-types.js";

export * from "../customise-types.js";

/** v14 no-code customisation: custom fields, forms and pipeline settings. */
export const customiseApi = (t: Transport) => ({
  customFields: {
    list: (entity?: CustomFieldEntity, includeArchived = false) => t.get<CustomFieldDefView[]>(`/custom-fields${entity || includeArchived ? `?${new URLSearchParams({ ...(entity ? { entity } : {}), ...(includeArchived ? { archived: "1" } : {}) })}` : ""}`),
    create: (body: CustomFieldInput) => t.post<CustomFieldDefView>("/custom-fields", body),
    update: (id: string, body: CustomFieldUpdate) => t.patch<CustomFieldDefView>(`/custom-fields/${id}`, body),
    values: (entity: CustomFieldEntity, id: string) => t.get<CustomFieldRecordView>(`/custom-fields/values/${entity}/${id}`),
    setValues: (entity: CustomFieldEntity, id: string, values: CustomFieldValues) => t.put<CustomFieldRecordView>(`/custom-fields/values/${entity}/${id}`, { values }),
  },
  forms: {
    list: () => t.get<FormRow[]>("/forms"),
    get: (id: string) => t.get<FormDetail>(`/forms/${id}`),
    create: (body: FormInput) => t.post<FormDetail>("/forms", body),
    update: (id: string, body: FormInput) => t.put<FormDetail>(`/forms/${id}`, body),
    remove: (id: string) => t.del<{ ok: true }>(`/forms/${id}`),
    submissions: (id: string) => t.get<FormSubmissionRow[]>(`/forms/${id}/submissions`),
    publicForm: (slug: string) => t.get<FormPublic>(`/public/forms/${slug}`),
    submit: (slug: string, body: FormSubmit) => t.post<FormSubmitResult>(`/public/forms/${slug}/submit`, body),
  },
  pipelines: {
    all: () => t.get<PipelinesView>("/pipelines"),
    update: (kind: PipelineKind, body: PipelineUpdate) => t.put<PipelineConfigView>(`/pipelines/${kind}`, body),
    reset: (kind: PipelineKind) => t.del<PipelineConfigView>(`/pipelines/${kind}`),
  },
});
