import type { Transport } from "./transport.js";
import type { FlowGateStrip, FlowJourney, FlowJourneyOption, FlowMap, FlowPulse } from "../flows-types.js";

export * from "../flows-types.js";

const flowQs = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return q ? `?${q}` : "";
};

/** v9 flows area: business flow map, journeys, gate strip and founder pulse. */
export const flowsApi = (t: Transport) => ({
  flows: {
    map: (from?: string, to?: string) => t.get<FlowMap>(`/flows/map${flowQs({ from, to })}`),
    gateStrip: () => t.get<FlowGateStrip>("/flows/gate-strip"),
    journeys: (clientId?: string) => t.get<FlowJourneyOption[]>(`/flows/journeys${flowQs({ clientId })}`),
    journey: (engagementId: string) => t.get<FlowJourney>(`/flows/engagements/${engagementId}/journey`),
    pulse: () => t.get<FlowPulse>("/flows/pulse"),
  },
});
