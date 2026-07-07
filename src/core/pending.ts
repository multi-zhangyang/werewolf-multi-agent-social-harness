import type { PendingAction } from "./types";

export type AgentPendingAction = Exclude<PendingAction, { kind: "advance" }>;

export function isAgentPendingAction(action: PendingAction): action is AgentPendingAction {
  return action.kind !== "advance";
}
