import type { GameConfig, GameState, MatchMetrics, Role, Team } from "../../core/types";
import type { NormalizedTournamentExperiment } from "../experiment";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../profiles";
import type { HarnessCheckpoint, MatchArtifact } from "../artifacts";
import type { HarnessEpisodeArtifactStore } from "../episodeArtifactStore";
import type { HarnessExperimentRunStore } from "../experimentRunStore";
import type {
  GenericExperimentArtifactStore,
  GenericExperimentRunStore
} from "../experimentOrchestrator";
import type {
  AdversarialEvaluation,
  HarnessAgentConfig,
  HarnessAgentProfile,
  HarnessEvaluationReport,
  HarnessForkProvenance,
  HarnessReasoner,
  HarnessRunResult,
  HarnessStepRecord,
  PolicyName,
  WerewolfJointPhaseScheduler
} from "../types";
import type { SocialEpisodeArtifact, SocialExecutionLimits } from "../social";

export interface TournamentOrchestrationOptions {
  artifactStore: GenericExperimentArtifactStore<MatchArtifact, HarnessCheckpoint>;
  runStore: GenericExperimentRunStore<MatchArtifact>;
  /** Stable durable run authority. Defaults to the normalized experiment id. */
  runSetId?: string;
}

export interface OpenedTournamentOrchestrationOptions extends TournamentOrchestrationOptions {
  artifactStore: HarnessEpisodeArtifactStore<MatchArtifact, HarnessCheckpoint>;
  runStore: HarnessExperimentRunStore<MatchArtifact>;
}

export interface TournamentOptions {
  models: string[];
  profiles?: HarnessAgentProfile[];
  games: number;
  seed: string;
  reasoner: HarnessReasoner;
  config?: Partial<GameConfig> & { roles?: Role[] };
  maxTransitions?: number;
  executionLimits?: SocialExecutionLimits;
  jointPhaseScheduler?: WerewolfJointPhaseScheduler;
  temperature?: number;
  assignment?: HarnessAssignmentConfig;
  continueOnError?: boolean;
  includeArtifacts?: boolean;
  artifactSink?: (record: TournamentMatchArtifactRecord) => void | Promise<void>;
  experiment?: NormalizedTournamentExperiment;
  /** When present, production execution uses the V2 durable experiment
   * lifecycle instead of calling the episode scheduler directly. */
  orchestration?: TournamentOrchestrationOptions;
}

export interface TournamentMatchArtifactRecord {
  index: number;
  seed: string;
  runId: string;
  matchId?: string;
  artifact: MatchArtifact;
}

export interface TournamentEpisode {
  index: number;
  seed: string;
  runId?: string;
  matchId?: string;
  /** Tournament-level status preserves the harness lifecycle outcome. */
  status: HarnessRunResult["status"] | "failed";
  harnessStatus?: HarnessRunResult["status"];
  /** Recorded control-plane condition for this episode's joint action phases. */
  jointPhaseScheduler?: WerewolfJointPhaseScheduler;
  winner?: Team;
  phase?: string;
  day?: number;
  metrics?: MatchMetrics;
  evaluation?: AdversarialEvaluation;
  evaluationReport?: HarnessEvaluationReport;
  forkOf?: HarnessForkProvenance;
  trajectory?: HarnessStepRecord[];
  socialEpisode?: SocialEpisodeArtifact;
  assignment?: HarnessAssignmentConfig;
  resolvedAssignments: ResolvedAgentAssignment[];
  agents: Array<{
    playerId: string;
    seat: number;
    profileId?: string;
    model: string;
    role?: Role;
    team?: Team;
    policyName?: PolicyName;
    won?: boolean;
    reward?: number;
  }>;
  error?: string;
  artifact?: MatchArtifact;
}

export interface TournamentModelStats {
  model: string;
  seatGames: number;
  seatWins: number;
  villageSeatGames: number;
  villageSeatWins: number;
  werewolfSeatGames: number;
  werewolfSeatWins: number;
  roleGames: Record<Role, number>;
  roleWins: Record<Role, number>;
  harnessTurns: number;
  harnessErrors: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  rewardTotal: number;
  averageReward: number;
}

export interface TournamentProfileStats extends TournamentModelStats {
  profileId: string;
  policyName?: PolicyName;
}

export interface TournamentResult {
  experiment: NormalizedTournamentExperiment;
  seed: string;
  models: string[];
  profiles: HarnessAgentProfile[];
  gamesRequested: number;
  gamesCompleted: number;
  gamesFailed: number;
  /** Present on new results; optional for legacy artifact inputs. */
  gamesTruncated?: number;
  /** Present on new results; optional for legacy artifact inputs. */
  gamesUnstarted?: number;
  maxTransitions?: number;
  assignment?: HarnessAssignmentConfig;
  episodes: TournamentEpisode[];
  modelStats: Record<string, TournamentModelStats>;
  profileStats: Record<string, TournamentProfileStats>;
  artifacts?: TournamentMatchArtifactRecord[];
}

export interface WerewolfTournamentPreparedEpisode {
  initialState: GameState;
  agents: HarnessAgentConfig[];
  resolvedAssignments: ResolvedAgentAssignment[];
  runId: string;
}

export interface WerewolfTournamentExecution {
  result: HarnessRunResult;
  artifactInfo?: {
    runId: string;
    matchId: string;
    artifact?: MatchArtifact;
  };
}

export interface DurableWerewolfEpisodeResult {
  result: HarnessRunResult;
  agents: HarnessAgentConfig[];
  resolvedAssignments: ResolvedAgentAssignment[];
  runId: string;
}
