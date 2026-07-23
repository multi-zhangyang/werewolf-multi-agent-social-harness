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
  HARNESS_EPISODE_PROJECTION_VERSION,
  validateHarnessAgentSnapshotFrameRegistry,
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  validateHarnessEpisodeArtifactEnvelope,
  validateHarnessEpisodeProjectionEnvelope
} from "./episodeArtifacts";
export type {
  BuildReplayableSocialPrefixOptions,
  CreateGenericForkProvenanceOptions,
  GenericForkProvenance,
  HarnessAgentSnapshotFrame,
  HarnessCheckpointEnvelope,
  HarnessCheckpointSource,
  HarnessEpisodeArtifactEnvelope,
  HarnessEpisodeProjectionEnvelope,
  HarnessEpisodeProjectionVisibility,
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
  SOCIAL_ASSIGNMENT_RESOLUTION_VERSION,
  SOCIAL_REASONER_CALL_EVIDENCE_VERSION,
  validateSocialReasonerCallEvidence,
  validateSocialEpisodeArtifact
} from "./social";
export type {
  SocialAction,
  SocialActor,
  SocialActorStepReceipt,
  SocialAssignmentActorResolution,
  SocialAssignmentResolutionEvidence,
  SocialChannel,
  SocialEnvironment,
  SocialEpisodeArtifact,
  SocialEpisodeOptions,
  SocialMessage,
  SocialReasonerCallCollectionContext,
  SocialReasonerCallEvidence,
  SocialReasonerCallFailure,
  SocialReasonerCallOutcome,
  SocialReasonerCallReport,
  SocialRuntimeActorBinding
} from "./social";
export {
  GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
  GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION,
  GENERIC_EXPERIMENT_PROVENANCE_VERSION,
  LEGACY_GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
  LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION,
  LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2,
  GENERIC_EXPERIMENT_SPEC_VERSION,
  createGenericExperimentAssignmentResolution,
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
  deriveHarnessEpisodeArtifactSha256,
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
export {
  GENERIC_EXPERIMENT_PUBLICATION_RUN_SET_VERSION,
  GENERIC_EXPERIMENT_PUBLICATION_VERSION,
  runGenericExperiment
} from "./experimentOrchestrator";
export type {
  ExecutedGenericExperimentEpisode,
  GenericExperimentAttemptErrorClassification,
  GenericExperimentAttemptErrorContext,
  GenericExperimentAttemptIdentity,
  GenericExperimentArtifactStore,
  GenericExperimentEpisodeContext,
  GenericExperimentEvaluationAdapter,
  GenericExperimentExecutionAdapter,
  GenericExperimentExecutionResult,
  GenericExperimentPublicationEpisode,
  GenericExperimentPublicationResult,
  GenericExperimentPublicationRunSet,
  GenericExperimentPublicationTournament,
  GenericExperimentRestrictedExecutionResult,
  GenericExperimentRunStore,
  RunGenericExperimentOptions
} from "./experimentOrchestrator";
export {
  HARNESS_EXPERIMENT_RUN_INDEX_VERSION,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
  HarnessExperimentRunStore
} from "./experimentRunStore";
export type {
  GenericExperimentEpisodeAuthority,
  HarnessExperimentRunEpisodeReferenceV1,
  HarnessExperimentRunEpisodeReferenceV3,
  HarnessExperimentEpisodeRetryCode,
  HarnessExperimentRunManifestV1,
  HarnessExperimentRunManifestV2,
  HarnessExperimentRunManifestV3,
  HarnessExperimentRunManifest,
  HarnessExperimentRunCurrentEpisodeV2,
  HarnessExperimentRunCurrentEpisodeV3,
  HarnessExperimentRunRetriedAttemptV3,
  HarnessExperimentRunRetryWaitEpisodeV3,
  HarnessExperimentRunStartedEpisodeV3,
  HarnessExperimentRunStagedEpisodeV3,
  HarnessExperimentRunTerminalAttemptV3,
  HarnessExperimentRunRecovery,
  HarnessExperimentRunResume,
  HarnessExperimentRunRecord,
  HarnessExperimentRunRecordV1,
  HarnessExperimentRunRecordV2,
  HarnessExperimentRunRecordV3,
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
export {
  GENERIC_EXPERIMENT_MATRIX_AUTHORITY_VERSION,
  GENERIC_EXPERIMENT_MATRIX_CELL_FAILURE_MESSAGE,
  GENERIC_EXPERIMENT_MATRIX_VERSION,
  createGenericExperimentMatrixAuthoritySpec,
  runGenericExperimentMatrix,
  validateGenericExperimentMatrixAuthoritySpec,
  validateGenericExperimentMatrixSpec
} from "./experimentMatrixRunner";
export type {
  GenericExperimentMatrixAuthorityCellV1,
  GenericExperimentMatrixAuthoritySpecV1,
  GenericExperimentMatrixCell,
  GenericExperimentMatrixCellLifecycle,
  GenericExperimentMatrixCellResult,
  GenericExperimentMatrixResult,
  GenericExperimentMatrixSpec,
  RunGenericExperimentMatrixOptions
} from "./experimentMatrixRunner";
export {
  HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION,
  HarnessExperimentMatrixRunStore
} from "./experimentMatrixRunStore";
export type {
  ExperimentMatrixChildRunAuthority,
  GenericExperimentMatrixFinalizedChildV1,
  HarnessExperimentMatrixCellReferenceV1,
  HarnessExperimentMatrixCurrentCellV1,
  HarnessExperimentMatrixRunManifestV1,
  HarnessExperimentMatrixRunRecordV1,
  HarnessExperimentMatrixRunResume,
  HarnessExperimentMatrixRunStoreOptions
} from "./experimentMatrixRunStore";
export type {
  BuildGenericTournamentRunSetOptions,
  GenericTournamentArtifactAdapter,
  GenericTournamentArtifactDirectory,
  GenericTournamentRunSetArtifact,
  GenericTournamentRunSetEpisode
} from "./genericTournamentArtifacts";
