import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState } from "../core/types";
export { runHarnessEpisode } from "./runner";
export type { HarnessAgentSnapshotProvider, HarnessEpisodeOptions } from "./runner";
export { buildSocialCheckpointForkSeed, runForkedHarnessEpisode } from "./checkpointRuntime";
export type {
  ForkedHarnessEpisodeResult,
  RunForkedHarnessEpisodeOptions,
  SocialCheckpointForkSeed,
  SocialCheckpointRuntimeAdapter
} from "./checkpointRuntime";
export {
  buildGenericTournamentRunSetArtifact,
  validateGenericTournamentRunSetArtifact,
  writeGenericTournamentRunSetArtifact
} from "./genericTournamentArtifacts";
export { runGenericExperimentMatrix, validateGenericExperimentMatrixSpec } from "./experimentMatrixRunner";
export type {
  GenericExperimentMatrixCell,
  GenericExperimentMatrixCellResult,
  GenericExperimentMatrixResult,
  GenericExperimentMatrixSpec,
  RunGenericExperimentMatrixOptions
} from "./experimentMatrixRunner";
export type {
  BuildGenericTournamentRunSetOptions,
  GenericTournamentArtifactAdapter,
  GenericTournamentArtifactDirectory,
  GenericTournamentRunSetArtifact,
  GenericTournamentRunSetEpisode
} from "./genericTournamentArtifacts";
export type { SocialEpisodeArtifact, SocialEpisodeOptions } from "./social";
import type {
  HarnessAgentConfig,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessTurnTrace
} from "./types";
import {
  probeWerewolfSocialHarnessTurn,
  runWerewolfSocialHarnessPrefixAsHarnessResult
} from "./werewolfAdapter";

export async function runHarnessMatch(options: HarnessRunOptions): Promise<HarnessRunResult> {
  return runWerewolfSocialHarnessPrefixAsHarnessResult({
    id: options.initialState.id,
    ...options
  });
}

export async function probeHarnessTurn(options: {
  state: GameState;
  action: AgentPendingAction;
  agent: HarnessAgentConfig;
  reasoner: HarnessRunOptions["reasoner"];
}): Promise<{ trace: HarnessTurnTrace; command: GameCommand }> {
  return probeWerewolfSocialHarnessTurn(options);
}
