import { applyCommand, getPendingActions } from "../core/engine";
import { isAgentPendingAction, type AgentPendingAction } from "../core/pending";
import { createPlayerView } from "../core/view";
import type { GameCommand, GameState, PendingAction, PlayerView } from "../core/types";
import type { SocialActionValidationResult } from "./social";

export class WerewolfEnvironment {
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

  /**
   * Pure legality boundary used by the generic social runner. `step` keeps its
   * defensive assertion as a second line of protection, while this method
   * lets the harness reject a command before any message draft is committed.
   */
  validate(command: GameCommand): SocialActionValidationResult {
    try {
      this.assertCommandIsPending(command);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        code: "illegal-command",
        message: error instanceof Error ? error.message : String(error),
        metadata: {
          phase: this.state.phase,
          commandType: command.type,
          actorId: command.actorId
        }
      };
    }
  }

  /**
   * True joint-action apply for simultaneous phases (night wolf kill votes and
   * day votes). All commands are validated against the same pre-batch pending
   * set, then applied in that pending order without intermediate observation
   * leakage. Final maybeAutoAdvance still happens through applyCommand on the
   * last legal member of the joint set.
   */
  stepBatch(commandsByAgent: Record<string, GameCommand>): GameState {
    const pending = this.pendingActions();
    if (pending.length === 0) {
      throw new Error("stepBatch requires at least one pending agent action.");
    }

    const pendingActorIds = pending.map((action) => action.actorId);
    const commandActorIds = Object.keys(commandsByAgent);
    const pendingSet = new Set(pendingActorIds);
    const commandSet = new Set(commandActorIds);

    if (pendingSet.size !== pendingActorIds.length) {
      throw new Error("stepBatch cannot resolve duplicate pending actor ids.");
    }
    if (commandSet.size !== commandActorIds.length) {
      throw new Error("stepBatch rejects duplicate actor commands.");
    }
    if (pendingSet.size !== commandSet.size || pendingActorIds.some((actorId) => !commandSet.has(actorId))) {
      const missing = pendingActorIds.filter((actorId) => !commandSet.has(actorId));
      const unexpected = commandActorIds.filter((actorId) => !pendingSet.has(actorId));
      throw new Error(
        `stepBatch requires the complete pending agent set. missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`
      );
    }

    // Validate every command against the shared pre-batch decision state before
    // any command mutates environment truth.
    for (const action of pending) {
      const command = commandsByAgent[action.actorId];
      if (!command) {
        throw new Error(`stepBatch missing command for pending actor ${action.actorId}.`);
      }
      if (command.actorId !== action.actorId) {
        throw new Error(`stepBatch command actor ${command.actorId} does not match map key ${action.actorId}.`);
      }
      if (command.type === "system.advance") {
        throw new Error("stepBatch does not accept system.advance; use step() for system transitions.");
      }
      this.assertCommandIsPending(command);
      assertCommandMatchesAction(command, action);
    }

    const expectedKind = pending[0]?.kind;
    if (!pending.every((action) => action.kind === expectedKind)) {
      throw new Error("stepBatch requires a homogeneous pending action kind for joint resolution.");
    }

    // Apply against an isolated working state, then publish it only after every
    // command succeeds. This fulfills the generic SocialParallelEnvironment
    // contract: a thrown batch leaves observable environment state unchanged.
    let nextBatchState = cloneGameState(this.state);
    for (const action of pending) {
      const command = commandsByAgent[action.actorId];
      const nextState = applyCommand(nextBatchState, command);
      nextBatchState = nextState;
    }
    this.state = nextBatchState;
    return this.snapshot();
  }

  done(): boolean {
    return this.state.phase === "game_over" || this.pending().length === 0;
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
  if (command.type === "lastWords.submit") return "last_words";
  if (command.type === "sheriff.vote") return "sheriff_vote";
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
  if (command.type === "lastWords.submit" && action.kind === "last_words") {
    if (!command.text.trim()) throw new Error("Command lastWords.submit requires non-empty text.");
    return;
  }
  if (command.type === "sheriff.vote" && action.kind === "sheriff_vote") {
    if (!command.abstain) {
      if (!command.targetId) throw new Error(`Command ${command.type} requires a target unless abstaining.`);
      assertLegalTarget(action.legalTargetIds, command.targetId, command.type);
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
