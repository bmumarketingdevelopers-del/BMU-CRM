import { workflowData } from "./data/workflow.js";

export { workflowData };

export type GateId = (typeof workflowData.gates)[number]["id"];
export type PhaseId = (typeof workflowData.phases)[number]["id"];

export const GATES = workflowData.gates;
export const PHASES = workflowData.phases;

/** Five-segment gate track shown on every engagement. */
export type GateTrack = Record<GateId, "locked" | "open" | "passed">;

export const emptyGateTrack = (): GateTrack =>
  Object.fromEntries(GATES.map((g, i) => [g.id, i === 0 ? "open" : "locked"])) as GateTrack;
