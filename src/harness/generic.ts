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
export { replaySocialEpisode, verifyHarnessEpisodeArtifact } from "./socialReplay";
export type {
  HarnessEpisodeArtifactVerificationResult,
  SocialArtifactVerificationRuntime,
  SocialEpisodeReplayResult,
  SocialRecordedAgentStateValidationPolicy,
  SocialRecordedAgentStateValidator,
  SocialRecordedStepValidator
} from "./socialReplay";
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
  cloneSocialDomainAdapterManifest,
  compareSocialDomainAdapterManifests,
  validateSocialDomainAdapterManifest,
  SOCIAL_DOMAIN_ADAPTER_MANIFEST_VERSION
} from "./domainAdapter";
export type {
  SocialDomainAdapterComponentKind,
  SocialDomainAdapterComponentManifest,
  SocialDomainAdapterManifest
} from "./domainAdapter";
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
export {
  GENERIC_EXPERIMENT_SPEC_VERSION,
  normalizeGenericExperimentSpec,
  validateGenericExperimentSpec
} from "./experimentSpec";
export type {
  GenericExperimentArtifactPolicyV1,
  GenericExperimentAssignmentPolicyV1,
  GenericExperimentCheckpointPolicyV1,
  GenericExperimentKind,
  GenericExperimentModelAssignmentV1,
  GenericExperimentPolicyRefV1,
  GenericExperimentProfileSpecV1,
  GenericExperimentProviderPolicyV1,
  GenericExperimentRetryPolicyV1,
  GenericExperimentSpecV1,
  GenericExperimentTimeoutPolicyV1,
  GenericJsonObject,
  GenericJsonPrimitive,
  GenericJsonValue,
  NormalizedGenericExperimentSpecV1
} from "./experimentSpec";
export {
  HARNESS_EPISODE_STORE_INDEX_VERSION,
  HARNESS_EPISODE_STORE_MANIFEST_VERSION,
  HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION,
  HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION,
  HARNESS_EPISODE_TRAJECTORY_STEP_VERSION,
  HarnessEpisodeArtifactStore,
  deriveHarnessEpisodeTrajectoryJsonl,
  openHarnessEpisodeArtifactStore
} from "./episodeArtifactStore";
export type {
  CanonicalEpisodeArtifactVerification,
  CanonicalEpisodeArtifactVerifier,
  HarnessEpisodeArtifactStoreOptions,
  HarnessEpisodeStoreEntry,
  HarnessEpisodeStoreIndex,
  HarnessEpisodeStoreManifest
} from "./episodeArtifactStore";
