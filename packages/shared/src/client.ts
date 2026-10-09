import type { GateTrack } from "./workflow.js";

export type ClientEngagement = {
  id: string;
  serviceName: string;
  tier: string;
  billingType: string;
  status: string;
  currentGate: string;
  track: GateTrack;
  requirementsPending: number;
};

export type ClientInvoice = {
  id: string;
  number: string;
  status: string;
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  paidPaise: number;
  dueDate: string;
  createdAt: string;
};

export type ClientOverview = {
  clientOrg: { id: string; name: string };
  accountManager: { name: string; email: string | null; phone: string | null } | null;
  engagements: ClientEngagement[];
  invoicesDue: ClientInvoice[];
};

export type ClientRow = {
  id: string;
  name: string;
  industry: string | null;
  health: string;
  am: { id: string; name: string } | null;
  engagements: { id: string; serviceName: string; status: string; currentGate: string }[];
  createdAt: string;
};
