import type { Action, ActorId, ActorObservation, Phase, PublicObservation, WorldState } from "./contracts";
import type { PartnerMind } from "./mind";
import type { CognitiveProtocol } from "./cognition";
import type { PartnerDecisionCase } from "./agent";
import type { ModelStreamContent } from "./stream-content";

export type Mechanism = "full" | "no-inertia" | "no-mind" | "record-only";
export type DecisionSummary = Omit<PartnerDecisionCase, "exchanges" | "activities" | "observation" | "transportNormalizations" | "shadow"> & {
  shadow?: Omit<NonNullable<PartnerDecisionCase["shadow"]>, "exchanges" | "activities">;
};
export type RunStatus = "paused" | "running" | "waiting-human" | "completed" | "failed" | "stopped";
export interface CreateRun {
  mode: "human" | "observe";
  maxRounds?: number;
  agreeableness?: [number, number];
  mechanism?: Mechanism;
  protocol?: CognitiveProtocol;
  seed?: number;
  autoStart?: boolean;
  /** Researcher-provided private objectives; never included in a peer's observation. */
  actorSettings?: Partial<Record<ActorId, { name?: string; privateObjective?: string }>>;
}
export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  mode: "human" | "observe";
  mechanism: Mechanism;
  protocol?: CognitiveProtocol;
  createdAt: string;
  round: number;
  maxRounds: number;
  revision: number;
  phase: Phase;
  actors: { id: ActorId; name: string; kind: "human" | "ai" }[];
  parentId?: string;
  studyId?: string;
  condition?: string;
}
export interface ToolActivity {
  id: string;
  actorId: ActorId;
  revision: number;
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  kind?: "agent" | "model" | "tool" | "retry";
  channel?: "decision" | "shadow";
  attempt?: number;
  callId?: string;
  stream?: ModelStreamContent;
}
export interface CheckpointSummary {
  id: string;
  revision: number;
  round: number;
  phase: Phase;
  createdAt: string;
}
export interface ResearchMetrics {
  decisions: number;
  failures: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
export interface PartnerSnapshot extends RunSummary {
  /** Monotonic presentation version includes activity/status changes, not just world turns. */
  version: number;
  observation: ActorObservation | PublicObservation;
  viewer: { actorId?: ActorId; research: boolean; canControl: boolean; canAct: boolean };
  ownMind?: PartnerMind;
  error?: string;
  activeActor?: ActorId;
  research?: {
    world: WorldState;
    minds: Record<ActorId, PartnerMind>;
    activities: ToolActivity[];
    checkpoints: CheckpointSummary[];
    metrics: ResearchMetrics;
    experimentNote?: string;
  };
}
export interface CreatedRun { id: string; ownerToken: string; playerToken?: string; snapshot: PartnerSnapshot }
export interface ActionRequest { expectedRevision: number; commandId: string; action: Action }
export interface ForkRequest {
  checkpointId: string;
  intervention?: { kind: "none" | "apology" | "compensation"; amount?: number };
  autoStart?: boolean;
}
export interface StudySpec {
  protocol?: CognitiveProtocol;
  repeats: number;
  agreeableness: number[];
  mechanisms: Mechanism[];
  maxRounds: number;
  seed: number;
}
export interface StudyRow {
  runId: string;
  condition: "none" | "apology" | "compensation";
  agreeableness: number;
  mechanism: Mechanism;
  repeat: number;
  status: RunStatus;
  error?: string;
  returned: number | null;
  compensation: number | null;
  investment: number | null;
  payoff: number | null;
  durationMs: number;
}
export interface StudyView {
  id: string;
  status: "paused" | "running" | "completed" | "stopped";
  createdAt: string;
  spec: StudySpec;
  total: number;
  completed: number;
  failed: number;
  note: string;
  rows: StudyRow[];
}
