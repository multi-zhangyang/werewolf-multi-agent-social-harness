import type { SocialDomainAdapterManifest } from "../domainAdapter";
import type {
  SocialAssignmentResolutionEvidence,
  SocialReasonerCallEvidence,
  SocialReasonerExecutionClass,
  SocialResolvedSchedulerMode
} from "../social";

/**
 * Portable, domain-neutral experiment control-plane input.
 *
 * This contract is data only. Runtime factories, actors, policies, reasoners,
 * provider clients, abort signals, credentials, endpoints, prompts, and raw
 * request options must be resolved from reviewed registries outside the
 * persisted experiment specification.
 */
export const GENERIC_EXPERIMENT_SPEC_VERSION = "harness.experiment.v1" as const;
export const LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION = "harness.experiment-provenance.v1" as const;
export const LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2 = "harness.experiment-provenance.v2" as const;
export const GENERIC_EXPERIMENT_PROVENANCE_VERSION = "harness.experiment-provenance.v3" as const;
export const GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION = "harness.experiment-fork-lineage.v1" as const;
export const LEGACY_GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION = "harness.experiment-execution-attestation.v1" as const;
export const GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION = "harness.experiment-execution-attestation.v2" as const;

export type GenericExperimentKind = "episode" | "tournament";

export type GenericJsonPrimitive = string | number | boolean | null;
export type GenericJsonValue = GenericJsonPrimitive | GenericJsonValue[] | GenericJsonObject;
export interface GenericJsonObject {
  [key: string]: GenericJsonValue;
}

export interface GenericExperimentProfileSpecV1 {
  id: string;
  version: string;
  policyId: string;
  reasonerId?: string;
  personaId?: string;
  temperature?: number;
}

/** A model id is assignment data; provider transport configuration is not. */
export interface GenericExperimentModelAssignmentV1 {
  profileId: string;
  modelId: string;
}

export interface GenericExperimentPolicyRefV1 {
  id: string;
  version: string;
}

/**
 * Role/seat/team semantics remain domain owned. The generic control plane
 * records the selected versioned assignment policy and its portable input.
 */
export interface GenericExperimentAssignmentPolicyV1 extends GenericExperimentPolicyRefV1 {
  configuration?: GenericJsonObject;
}

export interface GenericExperimentTimeoutPolicyV1 extends GenericExperimentPolicyRefV1 {
  runTimeoutMs?: number;
  decisionTimeoutMs?: number;
}

export interface GenericExperimentRetryPolicyV1 extends GenericExperimentPolicyRefV1 {
  maxAttempts: number;
  backoffMs?: number;
}

export interface GenericExperimentArtifactPolicyV1 extends GenericExperimentPolicyRefV1 {
  visibility: "research-full" | "postgame-redacted" | "public";
}

export interface GenericExperimentCheckpointPolicyV1 extends GenericExperimentPolicyRefV1 {
  mode: "none" | "final" | "native-boundaries";
}

/**
 * Only a reviewed provider-policy identity and the required streaming flag are
 * portable. Endpoint, headers, keys, request bodies, and max-token controls
 * belong to local runtime configuration and are intentionally unrepresentable.
 */
export interface GenericExperimentProviderPolicyV1 extends GenericExperimentPolicyRefV1 {
  stream: true;
}

export interface GenericExperimentSpecV1 {
  version?: typeof GENERIC_EXPERIMENT_SPEC_VERSION;
  id?: string;
  kind?: GenericExperimentKind;
  domainId?: string;
  domainAdapter?: SocialDomainAdapterManifest;
  seed?: string;
  episodeCount?: number;
  actorCount?: number;
  schedulerMode?: SocialResolvedSchedulerMode;
  profiles?: GenericExperimentProfileSpecV1[];
  modelAssignments?: GenericExperimentModelAssignmentV1[];
  assignmentPolicy?: GenericExperimentAssignmentPolicyV1;
  maxTransitions?: number;
  timeoutPolicy?: GenericExperimentTimeoutPolicyV1;
  retryPolicy?: GenericExperimentRetryPolicyV1;
  evaluatorIds?: string[];
  artifactPolicy?: GenericExperimentArtifactPolicyV1;
  checkpointPolicy?: GenericExperimentCheckpointPolicyV1;
  providerPolicy?: GenericExperimentProviderPolicyV1;
  continueOnError?: boolean;
  domainConfig?: GenericJsonObject;
}

export interface NormalizedGenericExperimentSpecV1 {
  version: typeof GENERIC_EXPERIMENT_SPEC_VERSION;
  id: string;
  kind: GenericExperimentKind;
  domainId: string;
  domainAdapter: SocialDomainAdapterManifest;
  seed: string;
  episodeCount: number;
  actorCount: number;
  schedulerMode: SocialResolvedSchedulerMode;
  profiles: GenericExperimentProfileSpecV1[];
  modelAssignments: GenericExperimentModelAssignmentV1[];
  assignmentPolicy: GenericExperimentAssignmentPolicyV1;
  maxTransitions?: number;
  timeoutPolicy: GenericExperimentTimeoutPolicyV1;
  retryPolicy: GenericExperimentRetryPolicyV1;
  evaluatorIds: string[];
  artifactPolicy: GenericExperimentArtifactPolicyV1;
  checkpointPolicy: GenericExperimentCheckpointPolicyV1;
  providerPolicy?: GenericExperimentProviderPolicyV1;
  continueOnError: boolean;
  domainConfig: GenericJsonObject;
}

/**
 * Canonical, portable experiment authority embedded in episode/checkpoint
 * artifacts.  The full normalized spec is retained so a hash is independently
 * auditable after restart instead of becoming an opaque caller assertion.
 */
export interface GenericExperimentProvenanceV1 {
  schemaVersion:
    | typeof GENERIC_EXPERIMENT_PROVENANCE_VERSION
    | typeof LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2
    | typeof LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION;
  specVersion: typeof GENERIC_EXPERIMENT_SPEC_VERSION;
  specId: string;
  specHash: string;
  spec: NormalizedGenericExperimentSpecV1;
  /** Required by v2 provenance; v1 remains parseable only as legacy metadata. */
  executionAttestationRequired?: true;
  /** Required by v3 provenance; older schemas remain parseable legacy authority. */
  assignmentResolutionRequired?: true;
}

export interface GenericExperimentExecutionActorAttestationV1 {
  actorId: string;
  profile: GenericExperimentProfileSpecV1;
  modelAssignment?: GenericExperimentModelAssignmentV1;
}

/**
 * Central control-plane binding between one portable spec and runner-authored
 * execution facts. The adapter cannot supply this record directly.
 */
export interface GenericExperimentExecutionAttestationV1 {
  schemaVersion:
    | typeof GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION
    | typeof LEGACY_GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION;
  specHash: string;
  schedulerMode: SocialResolvedSchedulerMode;
  maxTransitions?: number;
  decisionTimeoutMs?: number;
  /** Exact episode-level cognition provenance authored by runHarnessEpisode. */
  reasonerExecutionClass?: SocialReasonerExecutionClass;
  actors: GenericExperimentExecutionActorAttestationV1[];
  /** Required by v2 attestation; absent only on legacy v1 records. */
  assignmentResolution?: SocialAssignmentResolutionEvidence;
  /** Exact runner-bound provider/reasoner calls, in native step/call order. */
  reasonerCalls?: SocialReasonerCallEvidence[];
}

export type GenericExperimentForkChangeFieldV1 = Exclude<keyof NormalizedGenericExperimentSpecV1, "version">;

/** The caller selects the fields whose semantics changed; the harness only verifies that declaration. */
export interface GenericExperimentForkChangeDeclarationV1 {
  field: GenericExperimentForkChangeFieldV1;
  reason?: string;
}

/** Stable before/after evidence for one explicitly declared top-level spec change. */
export interface GenericExperimentForkChangedFieldV1 extends GenericExperimentForkChangeDeclarationV1 {
  parentValueHash: string;
  childValueHash: string;
}

export interface GenericExperimentForkLineageV1 {
  schemaVersion: typeof GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION;
  parent: GenericExperimentProvenanceV1;
  child: GenericExperimentProvenanceV1;
  changedFields: GenericExperimentForkChangedFieldV1[];
}
