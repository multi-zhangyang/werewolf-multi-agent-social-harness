import { appendHarnessError, appendHarnessTurn, applyCommand, getPendingActions } from "../core/engine";
import { isAgentPendingAction, type AgentPendingAction } from "../core/pending";
import { createPlayerView } from "../core/view";
import type { GameCommand, GameState, PendingAction, PlayerView } from "../core/types";
import type { MultiAgentEnvironment } from "./contracts";
import type { HarnessErrorPayload } from "./types";

export class WerewolfEnvironment implements MultiAgentEnvironment {
  private state: GameState;

  constructor(initialState: GameState) {
    this.state = cloneGameState(initialState);
  }

  snapshot(): GameState {
    return cloneGameState(this.state);
  }

  pending(): PendingAction[] {
    return getPendingActions(this.state);
  }

  pendingActions(): AgentPendingAction[] {
    return this.pending().filter(isAgentPendingAction);
  }

  observe(playerId: string, action: AgentPendingAction): PlayerView {
    if (action.actorId !== playerId) {
      throw new Error(`Player ${playerId} cannot observe pending action for ${action.actorId}.`);
    }
    const current = this.requirePendingAction(action);
    return createPlayerView(this.snapshot(), playerId, current);
  }

  step(command: GameCommand): GameState {
    this.assertCommandIsPending(command);
    this.state = applyCommand(this.state, command);
    return this.snapshot();
  }

  done(): boolean {
    return this.state.phase === "game_over" || this.pending().length === 0;
  }

  recordTurn(payload: unknown): GameState {
    this.state = appendHarnessTurn(this.state, payload);
    return this.snapshot();
  }

  recordError(actorId: string, payload: HarnessErrorPayload): GameState {
    this.state = appendHarnessError(this.state, actorId, payload);
    return this.snapshot();
  }

  private requirePendingAction(action: AgentPendingAction): AgentPendingAction {
    const current = this.pendingActions().find((candidate) => samePendingAction(candidate, action));
    if (!current) {
      throw new Error(`Pending action ${action.kind} is not available for ${action.actorId} during ${action.phase}.`);
    }
    return current;
  }

  private assertCommandIsPending(command: GameCommand): void {
    const pending = this.pending();
    if (command.type === "system.advance") {
      if (!pending.some((action) => action.kind === "advance")) {
        throw new Error(`System advance is not pending during ${this.state.phase}.`);
      }
      return;
    }

    const expectedKind = actionKindForCommand(command);
    const action = pending
      .filter(isAgentPendingAction)
      .find((candidate) => candidate.actorId === command.actorId && candidate.kind === expectedKind);
    if (!action) {
      throw new Error(`Command ${command.type} is not pending for ${command.actorId} during ${this.state.phase}.`);
    }
    assertCommandMatchesAction(command, action);
  }
}

function actionKindForCommand(command: Exclude<GameCommand, { type: "system.advance" }>): AgentPendingAction["kind"] {
  if (command.type === "seer.inspect") return "inspect";
  if (command.type === "werewolf.killVote") return "kill";
  if (command.type === "witch.act") return "witch";
  if (command.type === "speech.submit") return "speech";
  if (command.type === "vote.cast") return "vote";
  return "shoot";
}

function assertCommandMatchesAction(command: Exclude<GameCommand, { type: "system.advance" }>, action: AgentPendingAction): void {
  if (command.type === "seer.inspect" && action.kind === "inspect") {
    assertLegalTarget(action.legalTargetIds, command.targetId, command.type);
    return;
  }
  if (command.type === "werewolf.killVote" && action.kind === "kill") {
    assertLegalTarget(action.legalTargetIds, command.targetId, command.type);
    return;
  }
  if (command.type === "witch.act" && action.kind === "witch") {
    if (command.saveTargetId && (!action.canSave || command.saveTargetId !== action.nightVictimId)) {
      throw new Error(`Command ${command.type} cannot save ${command.saveTargetId ?? "none"} for this pending action.`);
    }
    if (command.poisonTargetId) {
      if (!action.canPoison) throw new Error(`Command ${command.type} cannot poison during this pending action.`);
      assertLegalTarget(action.legalPoisonTargetIds, command.poisonTargetId, command.type);
    }
    return;
  }
  if (command.type === "speech.submit" && action.kind === "speech") {
    if (command.pressureTargetId) {
      assertLegalTarget(action.legalPressureTargetIds, command.pressureTargetId, command.type);
    }
    return;
  }
  if (command.type === "vote.cast" && action.kind === "vote") {
    if (!command.abstain) {
      if (!command.targetId) throw new Error(`Command ${command.type} requires a target unless abstaining.`);
      assertLegalTarget(action.legalTargetIds, command.targetId, command.type);
    }
    return;
  }
  if (command.type === "hunter.shoot" && action.kind === "shoot") {
    if (command.targetId) assertLegalTarget(action.legalTargetIds, command.targetId, command.type);
    return;
  }
  throw new Error(`Command ${command.type} does not match pending action ${action.kind}.`);
}

function assertLegalTarget(legalTargetIds: string[], targetId: string, commandType: GameCommand["type"]): void {
  if (!legalTargetIds.includes(targetId)) {
    throw new Error(`Command ${commandType} target ${targetId} is not legal for this pending action.`);
  }
}

function samePendingAction(left: AgentPendingAction, right: AgentPendingAction): boolean {
  return left.kind === right.kind && left.actorId === right.actorId && left.phase === right.phase;
}

function cloneGameState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}
