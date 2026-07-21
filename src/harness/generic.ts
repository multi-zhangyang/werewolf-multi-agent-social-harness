/**
 * Domain-neutral harness public surface.
 *
 * This barrel deliberately excludes `runtime.ts`, the Werewolf environment,
 * adapters, artifacts compatibility layer, server, and React. A new domain
 * can consume scheduler/replay/checkpoint primitives without loading the
 * first proof domain.
 */
export { runHarnessEpisode } from "./runner";
export type { HarnessAgentSnapshotProvider, HarnessEpisodeOptions } from "./runner";
export { replaySocialEpisode } from "./socialReplay";
export type { SocialEpisodeReplayResult } from "./socialReplay";
export {
  buildReplayableSocialPrefix,
  buildHarnessCheckpointAtPrefix,
  buildHarnessCheckpointFromEpisode,
  compactRecordedSocialAgentSnapshots,
  createGenericForkProvenance,
  createHarnessAgentSnapshotFrameResolver,
  validateHarnessAgentSnapshotFrameRegistry,
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  validateHarnessEpisodeArtifactEnvelope
} from "./episodeArtifacts";
export type {
  BuildReplayableSocialPrefixOptions,
  GenericForkProvenance,
  HarnessAgentSnapshotFrame,
  HarnessCheckpointEnvelope,
  HarnessEpisodeArtifactEnvelope,
  ReplayableSocialPrefix
} from "./episodeArtifacts";
export { buildSocialCheckpointForkSeed, runForkedHarnessEpisode } from "./checkpointRuntime";
export type {
  ForkedHarnessEpisodeResult,
  RunForkedHarnessEpisodeOptions,
  SocialCheckpointForkSeed,
  SocialCheckpointRuntimeAdapter
} from "./checkpointRuntime";
export {
  countSocialStepCommits,
  countSocialStepCommitsByActor,
  deriveSocialExposureRecords,
  runSocialEpisode,
  validateSocialEpisodeArtifact
} from "./social";
export type {
  SocialAction,
  SocialActor,
  SocialChannel,
  SocialEnvironment,
  SocialEpisodeArtifact,
  SocialEpisodeOptions,
  SocialMessage
} from "./social";
