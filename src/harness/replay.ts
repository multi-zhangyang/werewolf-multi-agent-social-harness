import { isAgentPendingAction, type AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState } from "../core/types";
import { WerewolfEnvironment } from "./environment";
import type { HarnessAgentSnapshotFrame } from "./episodeArtifacts";
import { hashStableState } from "./hash";
import { replaySocialEpisode, type SocialEpisodeReplayResult } from "./socialReplay";
import type { SocialEnvironment, SocialEpisodeArtifact } from "./social";
import type { HarnessStepRecord } from "./types";

// Backward-compatible exports. New domain adapters should import generic replay
// directly from socialReplay.ts (or generic.ts), which has no Werewolf/core
// runtime dependency.
export { replaySocialEpisode } from "./socialReplay";
export type { SocialEpisodeReplayResult } from "./socialReplay";

export interface ReplayResult {
  ok: boolean;
  replayedCommands: number;
  finalState: GameState;
  finalHash: string;
  expectedFinalHash?: string;
  mismatches: string[];
}

/** Werewolf adapter over the generic, model-free recorded-command replay. */
export function replayWerewolfSocialEpisode(
  episode: SocialEpisodeArtifact,
  options: {
    stopOnMismatch?: boolean;
    agentSnapshotFrames?: readonly HarnessAgentSnapshotFrame<unknown>[];
    /** A checkpoint prefix can intentionally omit its parent's frame sidecar. */
    auditAgentSnapshots?: boolean;
  } = {}
): SocialEpisodeReplayResult<GameState> {
  const hasInlineSnapshots = episode.steps.some((step) => step.actorSnapshotsAfterStep !== undefined);
  return replaySocialEpisode({
    episode: episode as SocialEpisodeArtifact<GameState, unknown, unknown, GameCommand>,
    environment: new WerewolfEnvironment(episode.initialState as GameState) as unknown as SocialEnvironment<GameState, unknown, unknown, GameCommand>,
    hashState: hashStableState,
    hashMessages: hashStableState,
    eventSeq: (state) => state.events.at(-1)?.seq ?? 0,
    stopOnMismatch: options.stopOnMismatch,
    agentSnapshotFrames: options.agentSnapshotFrames ? [...options.agentSnapshotFrames] : undefined,
    auditAgentSnapshots: options.auditAgentSnapshots ?? (hasInlineSnapshots || options.agentSnapshotFrames !== undefined)
  });
}

/** Legacy Werewolf trajectory compatibility replay. Native social replay is the canonical path. */
export function replayHarnessTrajectory(options: {
  initialState: GameState;
  trajectory: HarnessStepRecord[];
  stopOnMismatch?: boolean;
  expectedFinalHash?: string;
}): ReplayResult {
  const environment = new WerewolfEnvironment(options.initialState);
  const mismatches: string[] = [];
  const stopOnMismatch = options.stopOnMismatch ?? true;
  let replayedCommands = 0;

  for (const step of options.trajectory) {
    advanceToNextAgentAction(environment);
    const pendingAction = environment.pendingActions().find((candidate) => samePendingAction(candidate, step.pendingAction));
    if (!pendingAction) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: pending action ${step.pendingAction.kind}/${step.actorId} is not available.`);
      if (stopOnMismatch) break;
      continue;
    }

    const preHash = hashStableState(environment.snapshot());
    if (preHash !== step.preStateHash) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: preStateHash mismatch ${preHash} !== ${step.preStateHash}.`);
      if (stopOnMismatch) break;
    }
    if (actionKindForCommand(step.command) !== step.pendingAction.kind) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: command ${step.command.type} does not match pending ${step.pendingAction.kind}.`);
      if (stopOnMismatch) break;
    }

    const beforeSeq = environment.snapshot().events.at(-1)?.seq ?? 0;
    try {
      environment.step(step.command);
    } catch (error) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: command application failed ${error instanceof Error ? error.message : String(error)}.`);
      break;
    }
    replayedCommands += 1;

    const afterState = environment.snapshot();
    const afterSeq = afterState.events.at(-1)?.seq ?? beforeSeq;
    const actualEventSeqRange: [number, number] = [beforeSeq + 1, afterSeq];
    if (actualEventSeqRange[0] !== step.eventSeqRange[0] || actualEventSeqRange[1] !== step.eventSeqRange[1]) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: eventSeqRange mismatch ${actualEventSeqRange.join("-")} !== ${step.eventSeqRange.join("-")}.`);
      if (stopOnMismatch) break;
    }
    const postHash = hashStableState(afterState);
    if (postHash !== step.postStateHash) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: postStateHash mismatch ${postHash} !== ${step.postStateHash}.`);
      if (stopOnMismatch) break;
    }
  }

  const finalState = environment.snapshot();
  const finalHash = hashStableState(finalState);
  if (options.expectedFinalHash && finalHash !== options.expectedFinalHash) {
    addMismatch(`Replay finalHash mismatch ${finalHash} !== ${options.expectedFinalHash}.`);
  }
  return { ok: mismatches.length === 0, replayedCommands, finalState, finalHash, expectedFinalHash: options.expectedFinalHash, mismatches };

  function addMismatch(message: string): void {
    mismatches.push(message);
  }
}

function advanceToNextAgentAction(environment: WerewolfEnvironment): void {
  let guard = 0;
  while (guard < 64) {
    const pending = environment.pending();
    if (pending.some(isAgentPendingAction)) return;
    if (pending.length !== 1 || pending[0].kind !== "advance") return;
    environment.step({ type: "system.advance", actorId: "system" });
    guard += 1;
  }
  throw new Error("Replay advance guard exceeded.");
}

function samePendingAction(left: AgentPendingAction, right: AgentPendingAction): boolean {
  return left.kind === right.kind && left.actorId === right.actorId && left.phase === right.phase;
}

function actionKindForCommand(command: GameCommand): AgentPendingAction["kind"] | "advance" {
  if (command.type === "seer.inspect") return "inspect";
  if (command.type === "werewolf.whisper") return "whisper";
  if (command.type === "werewolf.killVote") return "kill";
  if (command.type === "witch.act") return "witch";
  if (command.type === "speech.submit") return "speech";
  if (command.type === "lastWords.submit") return "last_words";
  if (command.type === "sheriff.vote") return "sheriff_vote";
  if (command.type === "vote.cast") return "vote";
  if (command.type === "hunter.shoot") return "shoot";
  return "advance";
}
