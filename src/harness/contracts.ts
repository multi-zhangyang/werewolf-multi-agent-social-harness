import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState, PendingAction, PlayerView } from "../core/types";
import type { AgentHarnessState, HarnessPlayerView, HarnessTurnTrace, PolicyPlan } from "./types";

export interface MultiAgentEnvironment {
  snapshot(): GameState;
  pending(): PendingAction[];
  pendingActions(): AgentPendingAction[];
  observe(playerId: string, action: AgentPendingAction): PlayerView;
  step(command: GameCommand): GameState;
  done(): boolean;
}

export interface MultiAgentActor {
  readonly state: AgentHarnessState;
  observe(view: PlayerView | HarnessPlayerView, context?: { traceId: string; turnIndex: number }): void;
  plan(action: AgentPendingAction): PolicyPlan;
  act(plan: PolicyPlan): GameCommand;
  commitTurn(
    plan: PolicyPlan,
    privateMemo: string,
    context?: { traceId: string; turnIndex: number; pendingAction: AgentPendingAction; providerRequestId?: string }
  ): void;
}

export interface HarnessRecorder {
  recordTurn(trace: HarnessTurnTrace): void;
  recordError(error: unknown): void;
}
