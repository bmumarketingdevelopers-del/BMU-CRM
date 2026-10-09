import type { Transport } from "./transport.js";
import type { FeatureFlagKey, FeatureFlagRow, FeatureFlagUpdate, LivePresenceInput, SystemHealth } from "../platform.js";

/** v13 foundation: presence heartbeats, feature flags and the System health page. The live stream itself is GET /realtime/stream. */
export const platformApi = (t: Transport) => ({
  realtime: {
    presence: (input: LivePresenceInput) => t.post<{ ok: true }>("/realtime/presence", input),
  },
  system: {
    flags: () => t.get<Record<FeatureFlagKey, boolean>>("/system/flags"),
    flagRows: () => t.get<FeatureFlagRow[]>("/system/flags/all"),
    setFlag: (key: FeatureFlagKey, input: FeatureFlagUpdate) => t.patch<FeatureFlagRow>(`/system/flags/${key}`, input),
    health: () => t.get<SystemHealth>("/system/health"),
    retryFailure: (id: string) => t.post<{ ok: boolean; message: string }>(`/system/events/failures/${id}/retry`),
    dismissFailure: (id: string) => t.post<{ ok: true }>(`/system/events/failures/${id}/dismiss`),
    rebuildSearch: () => t.post<{ documents: number }>("/system/search/rebuild"),
  },
});
