import { GameCommand, GameConfig, GameEvent, GameState, MatchMetrics, WerewolfRulesetId } from "../../core/types";
import { HARNESS_AGENT_SNAPSHOT_FRAME_VERSION, HarnessAgentSnapshotFrame, HarnessCheckpointEnvelope, HarnessCheckpointSource, HarnessEpisodeArtifactEnvelope } from "../episodeArtifacts";
import { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../profiles";
import { SocialEpisodeArtifact } from "../social";
import { AdversarialEvaluation, AgentHarnessState, HarnessAgentProfile, HarnessEvaluationReport, HarnessForkProvenance, HarnessRunResult, HarnessStepRecord } from "../types";
export const MATCH_ARTIFACT_VERSION = "harness.match.v2";
export const HARNESS_CHECKPOINT_VERSION = "harness.checkpoint.v2";
export const AGENT_SNAPSHOT_FRAME_VERSION = HARNESS_AGENT_SNAPSHOT_FRAME_VERSION;

export interface AgentSnapshotFrame extends HarnessAgentSnapshotFrame<AgentHarnessState> {
  artifactVersion: typeof AGENT_SNAPSHOT_FRAME_VERSION;
  kind: "agent-snapshot-frame";
}

/** Werewolf specialization of the domain-neutral social episode envelope. */
export interface MatchArtifact
  extends HarnessEpisodeArtifactEnvelope<
    GameState,
    unknown,
    unknown,
    unknown,
    AgentHarnessState,
    HarnessForkProvenance
  > {
  artifactVersion: typeof MATCH_ARTIFACT_VERSION;
  kind: "match";
  runId: string;
  matchId?: string;
  createdAt: string;
  seed: string;
  /** Domain-owned replay semantic identity, derived only from initial state. */
  rulesetId: WerewolfRulesetId;
  config: GameConfig;
  models: string[];
  profiles: HarnessAgentProfile[];
  assignment?: HarnessAssignmentConfig;
  resolvedAssignments: ResolvedAgentAssignment[];
  status: HarnessRunResult["status"];
  truncationReason?: string;
  failureReason?: string;
  failureStateHash?: string;
  forkOf?: HarnessForkProvenance;
  initialState: GameState;
  finalState: GameState;
  /** Legacy Werewolf committed-command projection retained for checkpoint migration. */
  trajectory: HarnessStepRecord[];
  /** Native generic scheduler/environment/message-bus execution authority. */
  socialEpisode: SocialEpisodeArtifact<GameState, unknown, unknown, unknown>;
  events: GameEvent[];
  evaluation: AdversarialEvaluation;
  evaluationReport: HarnessEvaluationReport;
  metrics: MatchMetrics;
  agents: AgentHarnessState[];
  agentSnapshotFrames?: AgentSnapshotFrame[];
}

export type TrajectoryJsonlStepSource = Omit<
  HarnessStepRecord,
  "pendingAction" | "observation" | "policyPlan" | "reasonerOutput" | "command" | "actionArbitration"
> & {
  pendingAction: unknown;
  observation: unknown;
  policyPlan: unknown;
  reasonerOutput: unknown;
  command: unknown;
};

/**
 * An export view may deliberately omit evaluator truth. JSONL is a rendered
 * artifact surface, not replay authority, so it must model that redaction
 * honestly instead of pretending every source is a canonical match artifact.
 */
export type TrajectoryJsonlEvaluationReportSource = Partial<
  Pick<
    HarnessEvaluationReport,
    "id" | "createdAt" | "status" | "failures" | "evaluatorIds" | "evaluatorRegistry" | "metricCount" | "warnings" | "summary" | "metrics"
  >
>;

/**
 * JSONL export consumes a rendered artifact view and never requires canonical
 * replay authority. Optional identity, evaluation, metric, and trajectory
 * fields allow a server-owned truth-redacted projection to omit sensitive
 * postgame evidence rather than smuggling it back in as a fallback.
 */
export interface TrajectoryJsonlSource {
  artifactVersion?: string;
  kind?: string;
  runId?: string;
  matchId?: string;
  createdAt?: string;
  seed?: string;
  rulesetId?: WerewolfRulesetId;
  models?: unknown;
  profiles?: unknown;
  assignment?: unknown;
  resolvedAssignments?: unknown;
  status?: unknown;
  truncationReason?: string;
  failureReason?: string;
  failureStateHash?: string;
  forkOf?: unknown;
  metrics?: unknown;
  evaluationReport?: TrajectoryJsonlEvaluationReportSource;
  socialEpisode: Pick<SocialEpisodeArtifact, "id" | "channels" | "steps" | "messages" | "exposureRecords">;
  trajectory?: readonly TrajectoryJsonlStepSource[];
  events?: readonly GameEvent[];
  agents?: readonly AgentHarnessState[];
  agentSnapshotFrames?: readonly Pick<AgentSnapshotFrame, "frameId" | "agentsHash" | "agents">[];
}

export interface WerewolfHarnessCheckpointSource extends HarnessCheckpointSource {
  sourceArtifactVersion: typeof MATCH_ARTIFACT_VERSION;
  matchId?: string;
  seed: string;
  /** Explicit domain semantic binding; never inferred from an artifact version. */
  rulesetId: WerewolfRulesetId;
  status: HarnessRunResult["status"];
}

/** Werewolf specialization of the generic checkpoint envelope. */
export interface HarnessCheckpoint
  extends HarnessCheckpointEnvelope<
    GameState,
    AgentHarnessState,
    unknown,
    unknown,
    GameCommand,
    WerewolfHarnessCheckpointSource
  > {
  artifactVersion: typeof HARNESS_CHECKPOINT_VERSION;
  kind: "checkpoint";
  executionPrefix: SocialEpisodeArtifact<GameState, unknown, unknown, GameCommand>;
}

export interface HarnessCheckpointPrefixSelector {
  traceId?: string;
  nativeTurnIndex?: number;
  nativeStepCount?: number;
}

export type HarnessCheckpointSelectionErrorCode =
  | "ambiguous_selector"
  | "selector_not_found"
  | "missing_agent_snapshots"
  | "unsafe_batch_boundary"
  | "prefix_replay_mismatch";

export class HarnessCheckpointSelectionError extends Error {
  constructor(
    readonly code: HarnessCheckpointSelectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HarnessCheckpointSelectionError";
  }
}
