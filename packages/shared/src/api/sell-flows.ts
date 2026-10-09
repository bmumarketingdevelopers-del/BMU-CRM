import type { Transport } from "./transport.js";
import type { PricedAddOn, PricedBundle, PricedService, ProposalView } from "../proposals.js";
import type { PublicProposal } from "../api-client.js";
import type {
  SellActivityInput,
  SellApprovalInbox,
  SellChangeRequestInput,
  SellFollowUp,
  SellLeadDetail,
  SellRenewal,
  SellReviseInput,
} from "../sell-flows.js";

export * from "../sell-flows.js";

export type SellPublicPricing = { priceBookId: string; services: PricedService[]; addOns: PricedAddOn[]; bundles: PricedBundle[] };
export type SellAgreement = {
  proposal: ProposalView;
  company: { name: string; address: string | null; gstin: string | null };
  agreementText: string;
  termsText: string;
  signed: boolean;
};

/** v10 sell area: lead detail and activity, follow-ups, duplicates, negotiation, approvals, renewals. */
export const sellFlowsApi = (t: Transport) => ({
  sell: {
    publicPricing: () => t.get<SellPublicPricing>("/sell/public/pricing"),
    lead: (id: string) => t.get<SellLeadDetail>(`/sell/leads/${id}`),
    logActivity: (id: string, input: SellActivityInput) => t.post<SellLeadDetail>(`/sell/leads/${id}/activities`, input),
    setFollowUp: (id: string, nextFollowUpAt: string | null) => t.patch<SellLeadDetail>(`/sell/leads/${id}/follow-up`, { nextFollowUpAt }),
    mergeLead: (id: string) => t.post<{ mergedInto: string }>(`/sell/leads/${id}/merge`),
    keepSeparate: (id: string) => t.post<SellLeadDetail>(`/sell/leads/${id}/keep-separate`),
    followUps: () => t.get<SellFollowUp[]>("/sell/follow-ups"),
    revise: (proposalId: string, input: Partial<SellReviseInput> & Pick<SellReviseInput, "lines">) => t.post<ProposalView>(`/sell/proposals/${proposalId}/revise`, input),
    extend: (proposalId: string, days: number) => t.post<ProposalView>(`/sell/proposals/${proposalId}/extend`, { days }),
    approvals: () => t.get<SellApprovalInbox>("/sell/approvals"),
    approve: (stepId: string, note?: string) => t.post<SellApprovalInbox>(`/sell/approvals/${stepId}/approve`, { note }),
    reject: (stepId: string, note: string) => t.post<SellApprovalInbox>(`/sell/approvals/${stepId}/reject`, { note }),
    renewals: () => t.get<SellRenewal[]>("/sell/renewals"),
    createRenewal: (clientOrgId: string, engagementIds: string[]) => t.post<ProposalView>("/sell/renewals", { clientOrgId, engagementIds }),
    requestChanges: (token: string, input: SellChangeRequestInput) => t.post<PublicProposal>(`/public/proposals/${token}/request-changes`, input),
    agreement: (token: string) => t.get<SellAgreement>(`/public/proposals/${token}/agreement`),
  },
});
