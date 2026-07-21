import type { AgentSnapshotFrame, MatchArtifact } from "../harness/artifacts";
import type { GameState } from "../core/types";
import type { MatchComparisonProjection } from "../harness/matchComparison";
import type {
  SocialAction,
  SocialDeliveryReceipt,
  SocialEpisodeArtifact,
  SocialHarnessStep,
  SocialMessage,
  SocialSpeechAct,
  SocialStepFailureEvidence
} from "../harness/social";
import type {
  AgentHarnessState,
  HarnessStepRecord,
  HarnessTurnTrace,
  PolicyPlan,
  ReasonerOutputSummary
} from "../harness/types";

export type MatchArtifactView = "full" | "postgame-redacted" | "truth-redacted";

export const REDACTED_PRIVATE_OBSERVATION = "[REDACTED private harness observation]" as const;
export const REDACTED_PRIVATE_SOCIAL_OBSERVATION = "[REDACTED private social observation]" as const;
export const REDACTED_DELIVERY_POLICY = "[REDACTED delivery redaction policy]" as const;
export const REDACTED_SOCIAL_STEP_FAILURE = "[REDACTED social step failure detail]" as const;

export interface RedactedPendingActionDto {
  kind: string;
  actorId?: string;
  phase?: string;
  redacted: true;
}

export interface RedactedCommandDto {
  type: string;
  actorId?: string;
  redacted: true;
}

export type RedactedPolicyPlanDto = Omit<PolicyPlan, "command" | "targetId" | "pressureTargetId" | "arbitration"> & {
  command: RedactedCommandDto;
  targetId?: never;
  pressureTargetId?: never;
  arbitration?: never;
};

export type RedactedReasonerOutputDto = Omit<
  ReasonerOutputSummary,
  "providerRequestId" | "retryHistory" | "stream"
> & {
  providerRequestId?: never;
  retryHistory?: never;
  stream?: never;
};

export type RedactedTurnTraceDto = Omit<
  HarnessTurnTrace,
  "targetId" | "arbitration" | "beliefs" | "providerRequestId" | "retryHistory" | "stream"
> & {
  targetId?: never;
  arbitration?: never;
  beliefs: Record<string, never>;
  providerRequestId?: never;
  retryHistory?: never;
  stream?: never;
};

export type RedactedHarnessStepDto = Omit<
  HarnessStepRecord,
  "pendingAction" | "observation" | "policyPlan" | "reasonerOutput" | "command" | "turnTrace" | "agentSnapshotsAfterStep"
> & {
  pendingAction: RedactedPendingActionDto;
  observation: typeof REDACTED_PRIVATE_OBSERVATION;
  policyPlan: RedactedPolicyPlanDto;
  reasonerOutput: RedactedReasonerOutputDto;
  command: RedactedCommandDto;
  turnTrace: RedactedTurnTraceDto;
  agentSnapshotsAfterStep?: never;
};

export type RedactedSocialStepFailureDto = Omit<SocialStepFailureEvidence, "metadata"> & {
  message: typeof REDACTED_SOCIAL_STEP_FAILURE;
  metadata?: never;
};

export type RedactedSocialDeliveryReceiptDto = Omit<SocialDeliveryReceipt, "redactionPolicy"> & {
  redactionPolicy: typeof REDACTED_DELIVERY_POLICY;
};

export type RedactedSocialSpeechActDto = Omit<SocialSpeechAct, "evidenceRefs" | "metadata"> & {
  evidenceRefs: Array<Omit<SocialSpeechAct["evidenceRefs"][number], "description">>;
  metadata?: never;
};

export type RedactedSocialMessageDto = Omit<SocialMessage, "speechActs" | "deliveryReceipts" | "metadata"> & {
  speechActs?: RedactedSocialSpeechActDto[];
  deliveryReceipts?: RedactedSocialDeliveryReceiptDto[];
  metadata?: Record<string, unknown>;
};

export type RedactedSocialMessageDraftDto = Omit<RedactedSocialMessageDto, "id" | "seq" | "createdAt">;

export type RedactedSocialActionDto = Omit<SocialAction<unknown>, "command" | "messages" | "metadata"> & {
  command: RedactedCommandDto;
  messages?: RedactedSocialMessageDraftDto[];
  metadata?: Record<string, unknown>;
};

export type RedactedSocialStepDto = Omit<
  SocialHarnessStep<unknown, unknown, unknown>,
  "pendingAction" | "observation" | "action" | "failure" | "actorSnapshotsAfterStep" | "infosByAgent"
> & {
  pendingAction: RedactedPendingActionDto;
  observation: typeof REDACTED_PRIVATE_SOCIAL_OBSERVATION;
  action: RedactedSocialActionDto;
  failure?: RedactedSocialStepFailureDto;
  actorSnapshotsAfterStep?: never;
  infosByAgent?: never;
};

export type RedactedSocialEpisodeDto = Omit<
  SocialEpisodeArtifact<GameState, unknown, unknown, unknown>,
  "steps" | "messages"
> & {
  steps: RedactedSocialStepDto[];
  messages: RedactedSocialMessageDto[];
};

type AgentSocialStateSource = NonNullable<AgentHarnessState["social"]>;
type RedactedEvidenceRefDto = Omit<AgentSocialStateSource["memory"]["entries"][number]["evidenceRefs"][number], "description">;
type RedactedMemoryEntryDto = Omit<
  AgentSocialStateSource["memory"]["entries"][number],
  "observation" | "pendingAction" | "action" | "metadata" | "evidenceRefs"
> & {
  observation?: never;
  pendingAction?: never;
  action?: never;
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedBeliefClaimDto = Omit<
  AgentSocialStateSource["beliefs"]["claims"][string],
  "metadata" | "evidenceRefs"
> & {
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedRelationshipEdgeDto = Omit<
  AgentSocialStateSource["relationships"]["edges"][string],
  "metadata" | "evidenceRefs"
> & {
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedReputationRecordDto = Omit<
  AgentSocialStateSource["reputation"]["records"][string],
  "metadata" | "evidenceRefs"
> & {
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedJournalEntryDto = Omit<
  NonNullable<AgentSocialStateSource["journal"]>["entries"][number],
  "beforeSummary" | "afterSummary" | "deltaSummary" | "metadata" | "evidenceRefs"
> & {
  beforeSummary?: never;
  afterSummary?: never;
  deltaSummary?: never;
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};

export type RedactedAgentSocialStateDto = Omit<
  AgentSocialStateSource,
  | "profile"
  | "memory"
  | "beliefs"
  | "relationships"
  | "norms"
  | "reputation"
  | "goals"
  | "commitments"
  | "coalitions"
  | "gossip"
  | "normSanctions"
  | "trustRepairs"
  | "betrayals"
  | "lastPlan"
  | "journal"
> & {
  profile: Omit<AgentSocialStateSource["profile"], "persona" | "metadata"> & {
    persona?: never;
    metadata?: never;
  };
  memory: Omit<AgentSocialStateSource["memory"], "entries"> & { entries: RedactedMemoryEntryDto[] };
  beliefs: { claims: Record<string, RedactedBeliefClaimDto> };
  relationships: { edges: Record<string, RedactedRelationshipEdgeDto> };
  norms: { norms: Record<string, never> };
  reputation: { records: Record<string, RedactedReputationRecordDto> };
  goals: { goals: [] };
  commitments?: never;
  coalitions?: never;
  gossip?: never;
  normSanctions?: never;
  trustRepairs?: never;
  betrayals?: never;
  lastPlan?: string;
  journal?: Omit<NonNullable<AgentSocialStateSource["journal"]>, "entries"> & {
    entries: RedactedJournalEntryDto[];
  };
};

/**
 * Agent state remains useful as a postgame social-state summary, but the
 * explicitly private top-level stores are replaced with redacted values.
 */
export type RedactedAgentStateDto = Omit<AgentHarnessState, "beliefs" | "privateMemos" | "lastIntent" | "social"> & {
  beliefs: Record<string, never>;
  privateMemos: string[];
  lastIntent?: string;
  social?: RedactedAgentSocialStateDto;
};

export type RedactedAgentSnapshotFrameDto = Omit<AgentSnapshotFrame, "agents"> & {
  agents: RedactedAgentStateDto[];
};

export interface PostgameMatchProjectionDto
  extends Omit<
    MatchArtifact,
    | "runId"
    | "matchId"
    | "seed"
    | "trajectory"
    | "socialEpisode"
    | "evaluation"
    | "evaluationReport"
    | "metrics"
    | "agents"
    | "agentSnapshotFrames"
  > {
  /** Omitted by truth-redacted projections because current run ids are seed-derived. */
  runId?: string;
  matchId?: string;
  /** Omitted by truth-redacted projections because it can reconstruct hidden assignments. */
  seed?: string;
  projection: {
    view: "postgame-redacted" | "truth-redacted";
    privateEvidenceRedacted: boolean;
    postgameTruthRedacted: boolean;
    generatedAt: string;
  };
  trajectory: RedactedHarnessStepDto[];
  socialEpisode: RedactedSocialEpisodeDto;
  /** Truth-redacted projections intentionally expose empty evaluator records. */
  evaluation: Partial<MatchArtifact["evaluation"]>;
  evaluationReport: Partial<MatchArtifact["evaluationReport"]>;
  metrics: Partial<MatchArtifact["metrics"]>;
  agents: RedactedAgentStateDto[];
  agentSnapshotFrames?: RedactedAgentSnapshotFrameDto[];
}

/**
 * A transient, server-derived frame after one complete native scheduler
 * boundary. It is intentionally not a MatchArtifact, checkpoint, or replay
 * authority: the browser receives only a redacted state projection and audit
 * counters, never commands, observations, actor state, or provider evidence.
 */
export interface PostgameReplayFrameDto {
  artifactVersion: "server.match-replay-frame.v1";
  kind: "match-replay-frame";
  authority: "native-social-episode";
  source: "server-owned-match-artifact";
  cursor: {
    nativeStepCount: number;
    messageCount: number;
    eventCount: number;
    /** Hash produced by canonical deterministic prefix replay. */
    stateHash?: string;
    /** Present when the selected recorded native step carried a post-state hash. */
    recordedPostStateHash?: string;
  };
  projection: PostgameMatchProjectionDto["projection"];
  /** Server-redacted prefix state; it is not a claim about the final artifact state. */
  state: PostgameMatchProjectionDto["finalState"];
  replay: {
    ok: true;
    replayedSteps: number;
    replayedBatches: number;
    rejectedSteps: number;
  };
}

export type MatchArtifactViewDto = MatchArtifact | PostgameMatchProjectionDto;
