import type { Transport } from "./transport.js";
import type { CraftBrandKitView } from "../craft-flows.js";
import type { DeliverCalendarItem } from "../deliver-flows.js";
import type {
  ApprovalCertificateView,
  AssetCollectionInput,
  AssetCollectionView,
  AssetDetail,
  AssetLinkInput,
  AssetList,
  AssetQuery,
  AssetUpdate,
  BrandKitListItem,
  ContentChannelInput,
  CreativeSettingsView,
  PostMetricInput,
  PostResultsSummary,
  ProofDecision,
  ProofLinkView,
  UploadSessionView,
  UploadStart,
} from "../creative-types.js";

export * from "../creative-types.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v16 creative studio: asset library, resumable uploads, approval certificates, one-tap proof links, channels and post results. */
export const creativeApi = (t: Transport) => ({
  assets: {
    list: (q: AssetQuery = {}) => t.get<AssetList>(`/assets${qs(q)}`),
    get: (id: string) => t.get<AssetDetail>(`/assets/${id}`),
    update: (id: string, body: AssetUpdate) => t.patch<AssetDetail>(`/assets/${id}`, body),
    archive: (id: string) => t.post<AssetDetail>(`/assets/${id}/archive`),
    restore: (id: string) => t.post<AssetDetail>(`/assets/${id}/restore`),
    makeCurrent: (id: string, versionId: string) => t.post<AssetDetail>(`/assets/${id}/versions/${versionId}/current`),
    aiTags: (id: string) => t.post<AssetDetail>(`/assets/${id}/ai-tags`),
    addLink: (body: AssetLinkInput) => t.post<AssetDetail>("/assets/link", body),
    collections: () => t.get<AssetCollectionView[]>("/assets/collections"),
    createCollection: (body: AssetCollectionInput) => t.post<AssetCollectionView>("/assets/collections", body),
    updateCollection: (id: string, body: AssetCollectionInput) => t.patch<AssetCollectionView>(`/assets/collections/${id}`, body),
    deleteCollection: (id: string) => t.del<{ ok: true }>(`/assets/collections/${id}`),
    startUpload: (body: UploadStart) => t.post<UploadSessionView>("/assets/uploads", body),
    uploadStatus: (id: string) => t.get<UploadSessionView>(`/assets/uploads/${id}`),
    uploadChunk: (id: string, offset: number, chunk: Blob) =>
      t.request<UploadSessionView>(`/assets/uploads/${id}?offset=${offset}`, { method: "PUT", body: chunk, headers: { "Content-Type": "application/octet-stream" } }),
    completeUpload: (id: string) => t.post<AssetDetail>(`/assets/uploads/${id}/complete`),
    /** v22: uploads the whole file straight to storage and finishes the upload; null when the API wants pieces instead. */
    completeWithFile: async (id: string, file: Blob) => {
      const headers = await t.storeFile(file);
      return headers ? t.request<AssetDetail>(`/assets/uploads/${id}/complete`, { method: "POST", headers }) : null;
    },
    cancelUpload: (id: string) => t.del<{ ok: true }>(`/assets/uploads/${id}`),
    clientList: (q: AssetQuery = {}) => t.get<AssetList>(`/client/assets${qs(q)}`),
    clientGet: (id: string) => t.get<AssetDetail>(`/client/assets/${id}`),
  },
  proofing: {
    certificate: (deliverableId: string) => t.get<ApprovalCertificateView>(`/deliverables/${deliverableId}/certificate`),
    clientCertificate: (deliverableId: string) => t.get<ApprovalCertificateView>(`/client/reviews/${deliverableId}/certificate`),
    link: (token: string) => t.get<ProofLinkView>(`/public/proof/${token}`),
    decide: (token: string, body: ProofDecision) => t.post<ProofLinkView>(`/public/proof/${token}/decide`, body),
  },
  creative: {
    brandKits: () => t.get<BrandKitListItem[]>("/creative/brand-kits"),
    clientBrandKit: () => t.get<CraftBrandKitView>("/client/brand-kit"),
    settings: () => t.get<CreativeSettingsView>("/creative/settings"),
    addChannel: (body: ContentChannelInput) => t.post<CreativeSettingsView>("/creative/channels", body),
    removeChannel: (id: string) => t.del<CreativeSettingsView>(`/creative/channels/${id}`),
    setPublishRule: (clientId: string, publishNeedsApproval: boolean) => t.put<CreativeSettingsView>(`/creative/clients/${clientId}/publish-rule`, { publishNeedsApproval }),
    setCaption: (deliverableId: string, caption: string | null) => t.put<DeliverCalendarItem>(`/creative/posts/${deliverableId}/caption`, { caption }),
    approveInternally: (deliverableId: string) => t.post<DeliverCalendarItem>(`/creative/posts/${deliverableId}/approve`),
    recordResults: (deliverableId: string, body: PostMetricInput) => t.put<DeliverCalendarItem>(`/creative/posts/${deliverableId}/results`, body),
    results: (from?: string, to?: string) => t.get<PostResultsSummary>(`/creative/results${qs({ from, to })}`),
    clientResults: (from?: string, to?: string) => t.get<PostResultsSummary>(`/client/post-results${qs({ from, to })}`),
  },
});
