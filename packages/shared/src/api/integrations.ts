import type { Transport } from "./transport.js";
import type {
  AccountUpdateInput,
  AdResultsView,
  ApiKeyCreated,
  ApiKeyCreateInput,
  ApiKeyView,
  IntegrationAccountView,
  IntegrationsHubView,
  OauthStartInput,
  PublicationView,
  SyncJobView,
  TestAccountInput,
  WebhookCreated,
  WebhookCreateInput,
  WebhookDeliveryView,
  WebhookUpdateInput,
  WebhookView,
} from "../integrations-types.js";

export * from "../integrations-types.js";
export * from "../public-api.js";

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
};

/** v19: integrations hub, auto-publishing, ad and website results, API keys and outgoing webhooks. */
export const integrationsApi = (t: Transport) => ({
  integrations: {
    hub: () => t.get<IntegrationsHubView>("/integrations"),
    addTest: (body: TestAccountInput) => t.post<IntegrationAccountView>("/integrations/test-accounts", body),
    oauthStart: (body: OauthStartInput) => t.post<{ url: string }>("/integrations/oauth/start", body),
    updateAccount: (id: string, body: AccountUpdateInput) => t.patch<IntegrationAccountView>(`/integrations/accounts/${id}`, body),
    disconnect: (id: string) => t.post<IntegrationAccountView>(`/integrations/accounts/${id}/disconnect`),
    sync: (id: string) => t.post<SyncJobView[]>(`/integrations/accounts/${id}/sync`),
    jobs: (accountId?: string) => t.get<SyncJobView[]>(`/integrations/jobs${qs({ accountId })}`),
    publishNow: (deliverableId: string) => t.post<PublicationView>(`/integrations/publish/${deliverableId}`),
    retryPublication: (id: string) => t.post<PublicationView>(`/integrations/publications/${id}/retry`),
    publication: (deliverableId: string) => t.get<PublicationView | null>(`/integrations/publications/by-post/${deliverableId}`),
    results: (q: { clientOrgId: string; from?: string; to?: string }) => t.get<AdResultsView>(`/integrations/results${qs(q)}`),
    clientResults: (q: { from?: string; to?: string } = {}) => t.get<AdResultsView>(`/client/ad-results${qs(q)}`),
    testPost: (externalId: string) => t.get<{ externalId: string; provider: string; account: string; caption: string | null; title: string; publishedAt: string }>(`/public/test-posts/${encodeURIComponent(externalId)}`),
  },
  developer: {
    keys: () => t.get<ApiKeyView[]>("/developer/keys"),
    createKey: (body: ApiKeyCreateInput) => t.post<ApiKeyCreated>("/developer/keys", body),
    revokeKey: (id: string) => t.post<ApiKeyView>(`/developer/keys/${id}/revoke`),
    webhooks: () => t.get<WebhookView[]>("/developer/webhooks"),
    createWebhook: (body: WebhookCreateInput) => t.post<WebhookCreated>("/developer/webhooks", body),
    updateWebhook: (id: string, body: WebhookUpdateInput) => t.patch<WebhookView>(`/developer/webhooks/${id}`, body),
    deleteWebhook: (id: string) => t.del<{ ok: true }>(`/developer/webhooks/${id}`),
    rotateSecret: (id: string) => t.post<WebhookCreated>(`/developer/webhooks/${id}/rotate`),
    testWebhook: (id: string) => t.post<WebhookDeliveryView>(`/developer/webhooks/${id}/test`),
    deliveries: (id: string) => t.get<WebhookDeliveryView[]>(`/developer/webhooks/${id}/deliveries`),
    redeliver: (deliveryId: string) => t.post<WebhookDeliveryView>(`/developer/deliveries/${deliveryId}/redeliver`),
  },
});
