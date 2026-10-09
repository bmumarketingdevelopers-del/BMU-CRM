/**
 * The ONE web call site for "convert lead to client by hand" (lead ⋯ menu → Make client).
 *
 * Calls POST /ops/leads/:id/convert: Finance confirms the payment proof, then the lead's proposal is accepted offline
 * and the first payment is recorded (apps/api/src/ops-actions/ops-convert.ts), exactly like an online payment.
 * A lead with no proposal goes through POST /clients-actions/from-lead/:leadId instead (see ConvertDrawer).
 */
import type { OpsLeadConvert, OpsMaybeApproval } from "@bmu/shared";
import { api } from "@/lib/api";

export function convertLeadToClient(leadId: string, input: OpsLeadConvert): Promise<OpsMaybeApproval> {
  return api.ops.leads.convert(leadId, input);
}
