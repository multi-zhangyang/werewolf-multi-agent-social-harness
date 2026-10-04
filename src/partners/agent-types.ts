import type { AgentInputItem, Model } from "@openai/agents";
import type { Action, ActorId, ActorObservation, World } from "./contracts";
import type { AttentionSelection, CognitivePreparation, CognitiveReceipt, ShadowAppraisal } from "./cognition";
import type { EpisodicMemory, MindState, PlanConsistency, PlanDecision, PsychologyMode } from "./mind";
import type { PlanOperation } from "./plans";
import type { ModelStreamContent } from "./stream-content";

export interface PartnerActivity {
  id: string; actorId: ActorId;
  kind: "agent_start" | "agent_end" | "model_start" | "model_delta" | "model_end" | "model_error" | "tool_start" | "tool_end" | "tool_error" | "retry";
  at: string; attempt: number; tool?: string; callId?: string; input?: unknown; output?: unknown;
  message?: string; durationMs?: number; channel?: "decision" | "shadow"; stream?: ModelStreamContent;
}
export interface PartnerModelExchange {
  attempt: number; request: unknown; response?: unknown; error?: string; durationMs: number;
  inputTokens: number; outputTokens: number; finishReason?: string;
  providerRequest?: unknown; sdkOutput?: unknown; stream?: ModelStreamContent;
}
export interface PartnerAppraisal {
  eventId: string; sourceIds: string[]; reason: string; required: boolean;
  before: MindState; after: MindState;
}
export interface PartnerPlanOperation {
  kind: PlanOperation["kind"]; eventId: string; reason: string;
  beforeVersion: number; afterVersion: number; planId?: string; planVersion?: number;
}
export interface PartnerDecisionCase {
  id: string; worldId: string; actorId: ActorId; revision: number; createdAt: string;
  sourceHash: string; harnessVersion: string; observation: ActorObservation; before: MindState;
  configuration: Record<string, unknown>; exchanges: PartnerModelExchange[]; activities: PartnerActivity[];
  status: "completed" | "failed"; action?: Action; after?: MindState; error?: string;
  inputTokens: number; outputTokens: number; durationMs: number; retries: number; failures: number;
  toolFailures?: number; planDecision?: PlanDecision; planConsistency?: PlanConsistency;
  appraisal?: PartnerAppraisal; planOperations?: PartnerPlanOperation[];
  /** The exact subjective state used when staging the action; excludes later shadow records. */
  actionMind?: MindState;
  receipt?: CognitiveReceipt; attention?: AttentionSelection; shadow?: ShadowAppraisal;
  /** Historical evidence only. The Responses agent never creates candidates or rewrites arguments. */
  preparation?: CognitivePreparation;
  transportNormalizations?: { callId?: string; tool: string; raw: unknown; canonical: unknown }[];
}
export interface PartnerDecisionInput {
  world: World; actorId: ActorId; mind?: MindState; memories?: EpisodicMemory[];
  sessionItems?: AgentInputItem[]; signal?: AbortSignal; onActivity?: (activity: PartnerActivity) => void;
}
export interface PartnerDecisionResult {
  action: Action; speech?: string; mind: MindState; memories: EpisodicMemory[];
  sessionItems: AgentInputItem[]; decisionCase: PartnerDecisionCase;
}
export interface PartnerParticipant {
  configuration: Record<string, unknown>;
  decide(input: PartnerDecisionInput): Promise<PartnerDecisionResult>;
}
export interface PartnerAgentOptions {
  psychology?: PsychologyMode | "record-only"; modelProfileId?: string;
  reasoningEffort?: "low" | "medium";
  requestTimeoutMs?: number; maxTurns?: number; streamOutput?: boolean;
  /** Official SDK Model injection for deterministic boundary tests; never live-model evidence. */
  model?: Model;
}
export class PartnerDecisionError extends Error {
  constructor(message: string, public readonly decisionCase: PartnerDecisionCase) {
    super(message); this.name = "PartnerDecisionError";
  }
}
