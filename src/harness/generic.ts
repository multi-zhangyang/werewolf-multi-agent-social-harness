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
  CreateGenericForkProvenanceOptions,
  GenericForkProvenance,
  HarnessAgentSnapshotFrame,
  HarnessCheckpointEnvelope,
  HarnessCheckpointSource,
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
  SocialMessage,
  SocialRuntimeActorBinding
} from "./social";
export {
  GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
  GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION,
  GENERIC_EXPERIMENT_PROVENANCE_VERSION,
  LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION,
  GENERIC_EXPERIMENT_SPEC_VERSION,
  createGenericExperimentExecutionAttestation,
  createGenericExperimentForkLineage,
  createGenericExperimentProvenance,
  normalizeGenericExperimentSpec,
  validateGenericExperimentExecutionAttestation,
  validateGenericExperimentExecutionEvidence,
  validateGenericExperimentForkLineage,
  validateGenericExperimentProvenance,
  validateGenericExperimentSpec
} from "./experimentSpec";
export type {
  GenericExperimentArtifactPolicyV1,
  GenericExperimentExecutionActorAttestationV1,
  GenericExperimentExecutionAttestationV1,
  GenericExperimentAssignmentPolicyV1,
  GenericExperimentCheckpointPolicyV1,
  GenericExperimentForkChangeDeclarationV1,
  GenericExperimentForkChangedFieldV1,
  GenericExperimentForkChangeFieldV1,
  GenericExperimentForkLineageV1,
  GenericExperimentKind,
  GenericExperimentModelAssignmentV1,
  GenericExperimentPolicyRefV1,
  GenericExperimentProfileSpecV1,
  GenericExperimentProviderPolicyV1,
  GenericExperimentProvenanceV1,
  GenericExperimentRetryPolicyV1,
  GenericExperimentSpecV1,
  GenericExperimentTimeoutPolicyV1,
  GenericJsonObject,
  GenericJsonPrimitive,
  GenericJsonValue,
  NormalizedGenericExperimentSpecV1
} from "./experimentSpec";
export {
  HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION,
  HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION,
  HARNESS_EPISODE_EVALUATION_RECORD_VERSION,
  HARNESS_EPISODE_FAILURE_ROW_VERSION,
  HARNESS_EPISODE_METRIC_ROW_VERSION,
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
  CanonicalHarnessCheckpointVerifier,
  HarnessEpisodeArtifactStoreOptions,
  HarnessEpisodeCheckpointStoreEntry,
  HarnessEpisodeCheckpointStoreIndex,
  HarnessEpisodeCheckpointStoreManifest,
  HarnessEpisodeFailureRow,
  HarnessEpisodeEvaluationRecordV1,
  HarnessEpisodeMetricRow,
  HarnessEpisodeStoreEntry,
  HarnessEpisodeStoreIndex,
  HarnessEpisodeStoreManifest,
  HarnessEpisodeStorePutOptions
} from "./episodeArtifactStore";
export { runGenericExperiment } from "./experimentOrchestrator";
export type {
  ExecutedGenericExperimentEpisode,
  GenericExperimentArtifactStore,
  GenericExperimentEpisodeContext,
  GenericExperimentEvaluationAdapter,
  GenericExperimentExecutionAdapter,
  GenericExperimentExecutionResult,
  GenericExperimentRunStore,
  RunGenericExperimentOptions
} from "./experimentOrchestrator";
export {
  HARNESS_EXPERIMENT_RUN_INDEX_VERSION,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
  HarnessExperimentRunStore
} from "./experimentRunStore";
export type {
  GenericExperimentEpisodeAuthority,
  HarnessExperimentRunEpisodeReferenceV1,
  HarnessExperimentRunManifestV1,
  HarnessExperimentRunRecordV1,
  HarnessExperimentRunStoreEntry,
  HarnessExperimentRunStoreIndexV1,
  HarnessExperimentRunStoreOptions
} from "./experimentRunStore";
export {
  GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE,
  runTournamentEpisodes
} from "./tournamentRunner";
export type {
  GenericTournamentEpisode,
  GenericTournamentResult,
  GenericTournamentRunnerOptions,
  TournamentEpisodeContext,
  TournamentEpisodeLifecycle
} from "./tournamentRunner";
export {
  GENERIC_TOURNAMENT_RUN_SET_ARTIFACT_VERSION,
  buildGenericTournamentRunSetArtifact,
  validateGenericTournamentRunSetArtifact,
  writeGenericTournamentRunSetArtifact
} from "./genericTournamentArtifacts";
export type {
  BuildGenericTournamentRunSetOptions,
  GenericTournamentArtifactAdapter,
  GenericTournamentArtifactDirectory,
  GenericTournamentRunSetArtifact,
  GenericTournamentRunSetEpisode
} from "./genericTournamentArtifacts";
