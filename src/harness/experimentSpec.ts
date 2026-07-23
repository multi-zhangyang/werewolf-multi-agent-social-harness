import {
  cloneSocialDomainAdapterManifest,
  validateSocialDomainAdapterManifest,
  type SocialDomainAdapterManifest
} from "./domainAdapter";
import { hashStableJsonValue } from "./hash";
import type {
  SocialEpisodeArtifact,
  SocialReasonerCallEvidence,
  SocialResolvedSchedulerMode,
  SocialRuntimeActorBinding
} from "./social";
import { validateSocialReasonerCallEvidence } from "./social";

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
export const GENERIC_EXPERIMENT_PROVENANCE_VERSION = "harness.experiment-provenance.v2" as const;
export const GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION = "harness.experiment-fork-lineage.v1" as const;
export const GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION = "harness.experiment-execution-attestation.v1" as const;

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
  maxTransitions: number;
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
    | typeof LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION;
  specVersion: typeof GENERIC_EXPERIMENT_SPEC_VERSION;
  specId: string;
  specHash: string;
  spec: NormalizedGenericExperimentSpecV1;
  /** Required by v2 provenance; v1 remains parseable only as legacy metadata. */
  executionAttestationRequired?: true;
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
  schemaVersion: typeof GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION;
  specHash: string;
  schedulerMode: SocialResolvedSchedulerMode;
  maxTransitions: number;
  decisionTimeoutMs?: number;
  actors: GenericExperimentExecutionActorAttestationV1[];
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

const NORMALIZED_SPEC_CHANGE_FIELDS = [
  "id",
  "kind",
  "domainId",
  "domainAdapter",
  "seed",
  "episodeCount",
  "actorCount",
  "schedulerMode",
  "profiles",
  "modelAssignments",
  "assignmentPolicy",
  "maxTransitions",
  "timeoutPolicy",
  "retryPolicy",
  "evaluatorIds",
  "artifactPolicy",
  "checkpointPolicy",
  "providerPolicy",
  "continueOnError",
  "domainConfig"
] as const satisfies readonly GenericExperimentForkChangeFieldV1[];

const NORMALIZED_SPEC_CHANGE_FIELD_SET = new Set<string>(NORMALIZED_SPEC_CHANGE_FIELDS);

const INPUT_FIELDS = new Set<keyof GenericExperimentSpecV1>([
  "version",
  "id",
  "kind",
  "domainId",
  "domainAdapter",
  "seed",
  "episodeCount",
  "actorCount",
  "schedulerMode",
  "profiles",
  "modelAssignments",
  "assignmentPolicy",
  "maxTransitions",
  "timeoutPolicy",
  "retryPolicy",
  "evaluatorIds",
  "artifactPolicy",
  "checkpointPolicy",
  "providerPolicy",
  "continueOnError",
  "domainConfig"
]);

const FORBIDDEN_PORTABLE_KEYS = new Set([
  "apikey",
  "authorization",
  "baseurl",
  "credential",
  "credentials",
  "endpoint",
  "headers",
  "maxtokens",
  "maxcompletiontokens",
  "provideroverrides",
  "provideroptions",
  "rawprovider",
  "requestbody",
  "secret",
  "token"
]);
const FORBIDDEN_PORTABLE_KEY_FRAGMENTS = [
  "apikey",
  "authorization",
  "baseurl",
  "credential",
  "endpoint",
  "header",
  "maxcompletiontoken",
  "maxtoken",
  "provideroverride",
  "provideroption",
  "rawprovider",
  "requestbody",
  "secret",
  "tokenvalue"
] as const;

export function normalizeGenericExperimentSpec(
  input: unknown,
  defaults: Partial<GenericExperimentSpecV1> = {}
): NormalizedGenericExperimentSpecV1 {
  const inputRecord = requireRecord(input, "Experiment spec");
  const defaultRecord = requireRecord(defaults, "Experiment defaults");
  assertKnownFields(inputRecord, INPUT_FIELDS, "Experiment spec");
  assertKnownFields(defaultRecord, INPUT_FIELDS, "Experiment defaults");
  const merged = { ...defaultRecord, ...inputRecord };

  const version = optionalString(merged.version, "version") ?? GENERIC_EXPERIMENT_SPEC_VERSION;
  if (version !== GENERIC_EXPERIMENT_SPEC_VERSION) {
    throw new Error(`Experiment version must be ${GENERIC_EXPERIMENT_SPEC_VERSION}.`);
  }
  const id = requiredString(merged.id, "id");
  const kind = normalizeKind(merged.kind);
  const domainId = requiredString(merged.domainId, "domainId");
  const domainAdapter = normalizeDomainAdapter(merged.domainAdapter, domainId);
  const profiles = normalizeProfiles(merged.profiles);
  const modelAssignments = normalizeModelAssignments(merged.modelAssignments, profiles);
  const providerPolicy = normalizeProviderPolicy(merged.providerPolicy, modelAssignments.length > 0);
  const episodeCount = positiveInteger(merged.episodeCount ?? 1, "episodeCount");
  if (kind === "episode" && episodeCount !== 1) {
    throw new Error("An episode experiment must have episodeCount equal to 1.");
  }

  return {
    version: GENERIC_EXPERIMENT_SPEC_VERSION,
    id,
    kind,
    domainId,
    domainAdapter,
    seed: optionalString(merged.seed, "seed") ?? id,
    episodeCount,
    actorCount: positiveInteger(merged.actorCount, "actorCount"),
    schedulerMode: normalizeSchedulerMode(merged.schedulerMode),
    profiles,
    modelAssignments,
    assignmentPolicy: normalizeAssignmentPolicy(merged.assignmentPolicy),
    maxTransitions: nonNegativeInteger(merged.maxTransitions, "maxTransitions"),
    timeoutPolicy: normalizeTimeoutPolicy(merged.timeoutPolicy),
    retryPolicy: normalizeRetryPolicy(merged.retryPolicy),
    evaluatorIds: normalizeUniqueIds(merged.evaluatorIds ?? [], "evaluatorIds", true),
    artifactPolicy: normalizeArtifactPolicy(merged.artifactPolicy),
    checkpointPolicy: normalizeCheckpointPolicy(merged.checkpointPolicy),
    ...(providerPolicy ? { providerPolicy } : {}),
    continueOnError: optionalBoolean(merged.continueOnError, "continueOnError") ?? true,
    domainConfig: normalizePortableJsonObject(merged.domainConfig ?? {}, "domainConfig")
  };
}

export function validateGenericExperimentSpec(input: unknown): string[] {
  try {
    normalizeGenericExperimentSpec(input);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : "Experiment spec is invalid."];
  }
}

/** Normalize once, then bind the complete portable spec to a stable identity. */
export function createGenericExperimentProvenance(input: unknown): GenericExperimentProvenanceV1 {
  const spec = normalizeGenericExperimentSpec(input);
  return {
    schemaVersion: GENERIC_EXPERIMENT_PROVENANCE_VERSION,
    specVersion: GENERIC_EXPERIMENT_SPEC_VERSION,
    specId: spec.id,
    specHash: hashStableJsonValue(spec),
    spec,
    executionAttestationRequired: true
  };
}

export function validateGenericExperimentProvenance(input: unknown, path = "experiment"): string[] {
  if (!isRecord(input)) return [`${path} must be an object.`];
  const errors: string[] = [];
  const unknownFields = Object.keys(input).filter(
    (key) => !["schemaVersion", "specVersion", "specId", "specHash", "spec", "executionAttestationRequired"].includes(key)
  );
  if (unknownFields.length) errors.push(`${path} contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
  if (
    input.schemaVersion !== GENERIC_EXPERIMENT_PROVENANCE_VERSION &&
    input.schemaVersion !== LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION
  ) {
    errors.push(
      `${path}.schemaVersion must be ${GENERIC_EXPERIMENT_PROVENANCE_VERSION} or legacy ${LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION}.`
    );
  }
  if (input.specVersion !== GENERIC_EXPERIMENT_SPEC_VERSION) {
    errors.push(`${path}.specVersion must be ${GENERIC_EXPERIMENT_SPEC_VERSION}.`);
  }
  if (input.executionAttestationRequired !== undefined && input.executionAttestationRequired !== true) {
    errors.push(`${path}.executionAttestationRequired must be true when present.`);
  }
  if (
    input.schemaVersion === GENERIC_EXPERIMENT_PROVENANCE_VERSION &&
    input.executionAttestationRequired !== true
  ) {
    errors.push(`${path}.executionAttestationRequired is required by ${GENERIC_EXPERIMENT_PROVENANCE_VERSION}.`);
  }
  let normalized: NormalizedGenericExperimentSpecV1 | undefined;
  try {
    normalized = normalizeGenericExperimentSpec(input.spec);
  } catch (error) {
    errors.push(`${path}.spec is invalid: ${error instanceof Error ? error.message : "invalid experiment spec"}`);
  }
  if (!normalized) return errors;
  if (input.specId !== normalized.id) errors.push(`${path}.specId must match spec.id.`);
  const expectedHash = hashStableJsonValue(normalized);
  if (input.specHash !== expectedHash) errors.push(`${path}.specHash does not match the normalized spec.`);
  if (hashStableJsonValue(input.spec) !== expectedHash) {
    errors.push(`${path}.spec must be the canonical normalized experiment spec.`);
  }
  return errors;
}

export function createGenericExperimentExecutionAttestation(
  spec: NormalizedGenericExperimentSpecV1,
  episode: Pick<
    SocialEpisodeArtifact,
    "execution" | "runtimeActorIds" | "runtimeActors" | "profiles" | "schedulerMode" | "steps"
  >
): GenericExperimentExecutionAttestationV1 {
  const evidenceErrors = validateGenericExperimentExecutionEvidence(spec, episode);
  if (evidenceErrors.length) {
    throw new Error(`Generic experiment execution evidence is invalid: ${evidenceErrors.join(" ")}`);
  }
  const profileById = new Map(spec.profiles.map((profile) => [profile.id, profile]));
  const modelByProfileId = new Map(spec.modelAssignments.map((assignment) => [assignment.profileId, assignment]));
  const reasonerCalls = episode.steps.flatMap((step) => step.reasonerCalls ?? []);
  const bindsProviderBackedReasoners = spec.profiles.some(
    (profile) => profile.reasonerId !== undefined && modelByProfileId.has(profile.id)
  );
  return {
    schemaVersion: GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
    specHash: hashStableJsonValue(spec),
    schedulerMode: episode.schedulerMode,
    maxTransitions: episode.execution!.maxTransitions!,
    ...(episode.execution?.decisionTimeoutMs === undefined
      ? {}
      : { decisionTimeoutMs: episode.execution.decisionTimeoutMs }),
    actors: episode.runtimeActors!.map((binding) => {
      const profile = profileById.get(binding.profileId)!;
      const modelAssignment = modelByProfileId.get(binding.profileId);
      return {
        actorId: binding.actorId,
        profile: clonePortable(profile),
        ...(modelAssignment === undefined ? {} : { modelAssignment: clonePortable(modelAssignment) })
      };
    }),
    ...(bindsProviderBackedReasoners ? { reasonerCalls: clonePortable(reasonerCalls) } : {})
  };
}

export function validateGenericExperimentExecutionAttestation(
  input: unknown,
  spec: NormalizedGenericExperimentSpecV1,
  episode: Pick<
    SocialEpisodeArtifact,
    "execution" | "runtimeActorIds" | "runtimeActors" | "profiles" | "schedulerMode" | "steps"
  >,
  path = "executionAttestation"
): string[] {
  if (!isRecord(input)) return [`${path} must be an object.`];
  let expected: GenericExperimentExecutionAttestationV1;
  try {
    expected = createGenericExperimentExecutionAttestation(spec, episode);
  } catch (error) {
    return [`${path} cannot be validated: ${error instanceof Error ? error.message : "invalid execution evidence"}`];
  }
  const unknownFields = Object.keys(input).filter(
    (key) => !["schemaVersion", "specHash", "schedulerMode", "maxTransitions", "decisionTimeoutMs", "actors", "reasonerCalls"].includes(key)
  );
  const errors = unknownFields.length
    ? [`${path} contains unknown field(s): ${unknownFields.sort().join(", ")}.`]
    : [];
  if (hashStableJsonValue(input) !== hashStableJsonValue(expected)) {
    errors.push(`${path} must exactly match the normalized spec and runner-authored execution evidence.`);
  }
  return errors;
}

/**
 * Validate the portable control-plane spec against facts emitted by the
 * generic social runner. This prevents an adapter from attaching the right
 * spec hash while silently running a different actor/profile/model roster or
 * ignoring transition/decision budgets.
 *
 * Assignment-policy semantics remain domain owned, but `runtimeActors` is the
 * exact recorded output of that assignment. Retry, checkpoint, artifact-view,
 * and provider-stream policies require their own lifecycle evidence and are
 * deliberately not guessed here.
 */
export function validateGenericExperimentExecutionEvidence(
  spec: NormalizedGenericExperimentSpecV1,
  episode: Pick<
    SocialEpisodeArtifact,
    "execution" | "runtimeActorIds" | "runtimeActors" | "profiles" | "steps"
  >,
  path = "socialEpisode"
): string[] {
  const errors: string[] = [];
  if (episode.execution?.maxTransitions !== spec.maxTransitions) {
    errors.push(`${path}.execution.maxTransitions must match experiment.spec.maxTransitions.`);
  }
  if (episode.execution?.decisionTimeoutMs !== spec.timeoutPolicy.decisionTimeoutMs) {
    errors.push(`${path}.execution.decisionTimeoutMs must match experiment.spec.timeoutPolicy.decisionTimeoutMs.`);
  }
  if (!Array.isArray(episode.runtimeActorIds) || episode.runtimeActorIds.length !== spec.actorCount) {
    errors.push(`${path}.runtimeActorIds must contain experiment.spec.actorCount actors.`);
  }
  const runtimeActors = Array.isArray(episode.runtimeActors) ? episode.runtimeActors : undefined;
  if (!runtimeActors || runtimeActors.length !== spec.actorCount) {
    errors.push(`${path}.runtimeActors must contain experiment.spec.actorCount actor bindings.`);
    return errors;
  }
  if (runtimeActors.some((binding) => !isRecord(binding))) {
    errors.push(`${path}.runtimeActors must contain only actor-binding objects.`);
    return errors;
  }
  const runtimeActorIds = Array.isArray(episode.runtimeActorIds) ? episode.runtimeActorIds : [];
  if (
    runtimeActors.some((binding, index) => binding.actorId !== runtimeActorIds[index])
  ) {
    errors.push(`${path}.runtimeActors must exactly bind the canonical runtimeActorIds roster.`);
  }
  const profileById = new Map(spec.profiles.map((profile) => [profile.id, profile]));
  const modelByProfileId = new Map(
    spec.modelAssignments.map((assignment) => [assignment.profileId, assignment.modelId])
  );
  for (const [index, binding] of runtimeActors.entries()) {
    validateExperimentRuntimeActorBinding({
      binding,
      index,
      profileById,
      modelByProfileId,
      path,
      errors
    });
  }
  validateExperimentReasonerCallEvidence({ spec, episode, runtimeActors, path, errors });
  return errors;
}

function validateExperimentReasonerCallEvidence(input: {
  spec: NormalizedGenericExperimentSpecV1;
  episode: Pick<SocialEpisodeArtifact, "steps">;
  runtimeActors: SocialRuntimeActorBinding[];
  path: string;
  errors: string[];
}): void {
  const runtimeByActorId = new Map(input.runtimeActors.map((binding) => [binding.actorId, binding]));
  const assignedModels = new Map(input.spec.modelAssignments.map((assignment) => [assignment.profileId, assignment.modelId]));
  const providerBackedActors = new Set(
    input.runtimeActors
      .filter((binding) => binding.reasonerId !== undefined && assignedModels.has(binding.profileId))
      .map((binding) => binding.actorId)
  );

  for (const [stepIndex, step] of input.episode.steps.entries()) {
    const calls = step.reasonerCalls ?? [];
    const binding = runtimeByActorId.get(step.actorId);
    const providerBacked = providerBackedActors.has(step.actorId);
    const failureBeforeDecision =
      step.failure?.stage === "pending_actor_resolution" ||
      step.failure?.stage === "actor_lookup" ||
      step.failure?.stage === "decision_identity" ||
      step.failure?.stage === "environment_observe" ||
      step.failure?.stage === "observation_assembly" ||
      step.failure?.stage === "actor_observe";
    const reachedDecision = step.actorId !== "system" && !failureBeforeDecision;
    const decisionEndedByHarnessControl =
      step.failure?.stage === "decision_timeout" ||
      step.failure?.stage === "execution_abort" ||
      (step.failure?.stage === "batch_aborted" && input.episode.steps.some((controlStep) =>
        controlStep.actorId === "system" &&
        controlStep.failure?.stage === "execution_abort" &&
        controlStep.batchId === `${step.batchId}:execution-control`
      ));
    if (providerBacked && reachedDecision && calls.length === 0 && !decisionEndedByHarnessControl) {
      input.errors.push(`${input.path}.steps[${stepIndex}] is missing runner-bound reasoner call evidence.`);
    }
    if (!providerBacked && calls.length > 0) {
      input.errors.push(`${input.path}.steps[${stepIndex}] records provider calls for a policy-only or unassigned actor.`);
    }
    for (const [callIndex, call] of calls.entries()) {
      const label = `${input.path}.steps[${stepIndex}].reasonerCalls[${callIndex}]`;
      input.errors.push(...validateSocialReasonerCallEvidence(call, {
        label,
        actorId: step.actorId,
        profileId: step.profileId,
        model: binding?.model,
        traceId: step.traceId
      }));
      const stream = call && typeof call === "object" && call.stream && typeof call.stream === "object"
        ? call.stream
        : undefined;
      if (call?.outcome !== "aborted" && stream?.enabled !== true) {
        input.errors.push(`${label}.stream.enabled must be true under experiment.spec.providerPolicy.`);
      }
      if (call?.outcome === "completed" && stream?.completed !== true) {
        input.errors.push(`${label} did not complete its provider stream.`);
      }
      if (binding && assignedModels.get(binding.profileId) !== call?.model) {
        input.errors.push(`${label}.model must match experiment.spec.modelAssignments.`);
      }
    }
  }
}

function validateExperimentRuntimeActorBinding(input: {
  binding: SocialRuntimeActorBinding;
  index: number;
  profileById: ReadonlyMap<string, GenericExperimentProfileSpecV1>;
  modelByProfileId: ReadonlyMap<string, string>;
  path: string;
  errors: string[];
}): void {
  const label = `${input.path}.runtimeActors[${input.index}]`;
  const expected = input.profileById.get(input.binding.profileId);
  if (!expected) {
    input.errors.push(`${label}.profileId references a profile outside experiment.spec.profiles.`);
    return;
  }
  if (input.binding.profileVersion !== expected.version) {
    input.errors.push(`${label}.profileVersion must match the selected experiment profile version.`);
  }
  if (input.binding.policyId !== expected.policyId) {
    input.errors.push(`${label}.policyId must match the selected experiment profile policyId.`);
  }
  if (input.binding.reasonerId !== expected.reasonerId) {
    input.errors.push(`${label}.reasonerId must match the selected experiment profile reasonerId.`);
  }
  if (input.binding.personaId !== expected.personaId) {
    input.errors.push(`${label}.personaId must match the selected experiment profile personaId.`);
  }
  if (input.binding.temperature !== expected.temperature) {
    input.errors.push(`${label}.temperature must match the selected experiment profile temperature.`);
  }
  const expectedModel = input.modelByProfileId.get(expected.id);
  if (expectedModel !== undefined && input.binding.model !== expectedModel) {
    input.errors.push(`${label}.model must match experiment.spec.modelAssignments.`);
  }
}

/**
 * Build fork lineage from caller-declared changed fields.  The harness never
 * assigns semantic labels by guessing: it verifies that the explicit field
 * set is complete and that each stable before/after hash matches both specs.
 */
export function createGenericExperimentForkLineage(input: {
  parent: GenericExperimentProvenanceV1;
  child: GenericExperimentProvenanceV1;
  changedFields: readonly GenericExperimentForkChangeDeclarationV1[];
}): GenericExperimentForkLineageV1 {
  const errors = [
    ...validateGenericExperimentProvenance(input.parent, "experimentLineage.parent"),
    ...validateGenericExperimentProvenance(input.child, "experimentLineage.child")
  ];
  if (errors.length) throw new Error(`Invalid experiment fork lineage: ${errors.join(" ")}`);
  const declared = normalizeExperimentChangeDeclarations(input.changedFields);
  const actualChangedFields = changedExperimentFields(input.parent.spec, input.child.spec);
  const declaredFields = declared.map(({ field }) => field);
  if (hashStableJsonValue(declaredFields) !== hashStableJsonValue(actualChangedFields)) {
    throw new Error(
      `Invalid experiment fork lineage: changedFields must explicitly and exactly declare ${actualChangedFields.join(", ") || "no fields"}.`
    );
  }
  return {
    schemaVersion: GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION,
    parent: clonePortable(input.parent),
    child: clonePortable(input.child),
    changedFields: declared.map(({ field, reason }) => ({
      field,
      parentValueHash: hashExperimentField(input.parent.spec, field),
      childValueHash: hashExperimentField(input.child.spec, field),
      ...(reason === undefined ? {} : { reason })
    }))
  };
}

export function validateGenericExperimentForkLineage(input: unknown, path = "experimentLineage"): string[] {
  if (!isRecord(input)) return [`${path} must be an object.`];
  const errors: string[] = [];
  const unknownFields = Object.keys(input).filter(
    (key) => !["schemaVersion", "parent", "child", "changedFields"].includes(key)
  );
  if (unknownFields.length) errors.push(`${path} contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
  if (input.schemaVersion !== GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION) {
    errors.push(`${path}.schemaVersion must be ${GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION}.`);
  }
  errors.push(...validateGenericExperimentProvenance(input.parent, `${path}.parent`));
  errors.push(...validateGenericExperimentProvenance(input.child, `${path}.child`));
  if (!Array.isArray(input.changedFields)) {
    errors.push(`${path}.changedFields must be an array.`);
    return errors;
  }
  if (errors.length) return errors;
  const parent = input.parent as unknown as GenericExperimentProvenanceV1;
  const child = input.child as unknown as GenericExperimentProvenanceV1;
  let declarations: GenericExperimentForkChangeDeclarationV1[];
  try {
    declarations = normalizeExperimentChangeDeclarations(input.changedFields);
  } catch (error) {
    errors.push(`${path}.changedFields is invalid: ${error instanceof Error ? error.message : "invalid declaration"}`);
    return errors;
  }
  const records = input.changedFields as Record<string, unknown>[];
  const originalFields = records.map((record) => record.field);
  if (hashStableJsonValue(originalFields) !== hashStableJsonValue(declarations.map(({ field }) => field))) {
    errors.push(`${path}.changedFields must be sorted canonically by field.`);
  }
  const recordsByField = new Map(records.map((record) => [record.field, record]));
  for (const [index, declaration] of declarations.entries()) {
    const record = recordsByField.get(declaration.field)!;
    if (record.reason !== declaration.reason) {
      errors.push(`${path}.changedFields[${index}].reason must be canonical when present.`);
    }
    const expectedParentHash = hashExperimentField(parent.spec, declaration.field);
    const expectedChildHash = hashExperimentField(child.spec, declaration.field);
    if (record.parentValueHash !== expectedParentHash) {
      errors.push(`${path}.changedFields[${index}].parentValueHash does not match parent.spec.${declaration.field}.`);
    }
    if (record.childValueHash !== expectedChildHash) {
      errors.push(`${path}.changedFields[${index}].childValueHash does not match child.spec.${declaration.field}.`);
    }
    const allowed = new Set(["field", "parentValueHash", "childValueHash", "reason"]);
    const unknown = Object.keys(record).filter((key) => !allowed.has(key));
    if (unknown.length) errors.push(`${path}.changedFields[${index}] contains unknown field(s): ${unknown.sort().join(", ")}.`);
  }
  const actualChangedFields = changedExperimentFields(parent.spec, child.spec);
  if (hashStableJsonValue(declarations.map(({ field }) => field)) !== hashStableJsonValue(actualChangedFields)) {
    errors.push(`${path}.changedFields must explicitly and exactly declare ${actualChangedFields.join(", ") || "no fields"}.`);
  }
  return errors;
}

function changedExperimentFields(
  parent: NormalizedGenericExperimentSpecV1,
  child: NormalizedGenericExperimentSpecV1
): GenericExperimentForkChangeFieldV1[] {
  return NORMALIZED_SPEC_CHANGE_FIELDS
    .filter((field) => hashExperimentField(parent, field) !== hashExperimentField(child, field))
    .sort((left, right) => left.localeCompare(right));
}

function hashExperimentField(
  spec: NormalizedGenericExperimentSpecV1,
  field: GenericExperimentForkChangeFieldV1
): string {
  return hashStableJsonValue(
    Object.prototype.hasOwnProperty.call(spec, field)
      ? { present: true, value: spec[field] }
      : { present: false }
  );
}

function normalizeExperimentChangeDeclarations(input: unknown): GenericExperimentForkChangeDeclarationV1[] {
  if (!Array.isArray(input)) throw new Error("changedFields must be an array.");
  const declarations = input.map((entry, index) => {
    const record = requireRecord(entry, `changedFields[${index}]`);
    const field = requiredString(record.field, `changedFields[${index}].field`);
    if (!NORMALIZED_SPEC_CHANGE_FIELD_SET.has(field)) {
      throw new Error(`changedFields[${index}].field is not a normalized experiment field.`);
    }
    const reason = optionalString(record.reason, `changedFields[${index}].reason`);
    return {
      field: field as GenericExperimentForkChangeFieldV1,
      ...(reason === undefined ? {} : { reason })
    };
  });
  assertUnique(declarations.map(({ field }) => field), "changed experiment field");
  return declarations.sort((left, right) => left.field.localeCompare(right.field));
}

function clonePortable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeKind(value: unknown): GenericExperimentKind {
  if (value === undefined) return "episode";
  if (value === "episode" || value === "tournament") return value;
  throw new Error("kind must be episode or tournament.");
}

function normalizeSchedulerMode(value: unknown): SocialResolvedSchedulerMode {
  if (value === "aec" || value === "aec-batched-decision" || value === "parallel") return value;
  throw new Error("schedulerMode must be aec, aec-batched-decision, or parallel.");
}

function normalizeDomainAdapter(value: unknown, domainId: string): SocialDomainAdapterManifest {
  const errors = validateSocialDomainAdapterManifest(value);
  if (errors.length) throw new Error(`domainAdapter is invalid: ${errors.join(" ")}`);
  const adapter = value as SocialDomainAdapterManifest;
  if (adapter.domainId !== domainId) throw new Error("domainAdapter.domainId must match domainId.");
  return cloneSocialDomainAdapterManifest(adapter);
}

function normalizeProfiles(value: unknown): GenericExperimentProfileSpecV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("profiles must be a nonempty array.");
  const profiles = value.map((entry, index) => {
    const record = requireRecord(entry, `profiles[${index}]`);
    assertKnownFields(record, new Set(["id", "version", "policyId", "reasonerId", "personaId", "temperature"]), `profiles[${index}]`);
    const temperature = record.temperature;
    if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      throw new Error(`profiles[${index}].temperature must be between 0 and 2.`);
    }
    return {
      id: requiredString(record.id, `profiles[${index}].id`),
      version: requiredString(record.version, `profiles[${index}].version`),
      policyId: requiredString(record.policyId, `profiles[${index}].policyId`),
      ...(record.reasonerId === undefined ? {} : { reasonerId: requiredString(record.reasonerId, `profiles[${index}].reasonerId`) }),
      ...(record.personaId === undefined ? {} : { personaId: requiredString(record.personaId, `profiles[${index}].personaId`) }),
      ...(temperature === undefined ? {} : { temperature })
    };
  });
  assertUnique(profiles.map(({ id }) => id), "profile id");
  return profiles;
}

function normalizeModelAssignments(
  value: unknown,
  profiles: readonly GenericExperimentProfileSpecV1[]
): GenericExperimentModelAssignmentV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("modelAssignments must be an array.");
  const profileIds = new Set(profiles.map(({ id }) => id));
  const assignments = value.map((entry, index) => {
    const record = requireRecord(entry, `modelAssignments[${index}]`);
    assertKnownFields(record, new Set(["profileId", "modelId"]), `modelAssignments[${index}]`);
    const profileId = requiredString(record.profileId, `modelAssignments[${index}].profileId`);
    if (!profileIds.has(profileId)) throw new Error(`modelAssignments[${index}].profileId references unknown profile ${profileId}.`);
    return {
      profileId,
      modelId: requiredString(record.modelId, `modelAssignments[${index}].modelId`)
    };
  });
  assertUnique(assignments.map(({ profileId }) => profileId), "model assignment profileId");
  return assignments.sort((left, right) => left.profileId.localeCompare(right.profileId));
}

function normalizeAssignmentPolicy(value: unknown): GenericExperimentAssignmentPolicyV1 {
  const record = requireRecord(value, "assignmentPolicy");
  assertKnownFields(record, new Set(["id", "version", "configuration"]), "assignmentPolicy");
  return {
    ...normalizePolicyRef(record, "assignmentPolicy"),
    ...(record.configuration === undefined
      ? {}
      : { configuration: normalizePortableJsonObject(record.configuration, "assignmentPolicy.configuration") })
  };
}

function normalizeTimeoutPolicy(value: unknown): GenericExperimentTimeoutPolicyV1 {
  const record = requireRecord(value, "timeoutPolicy");
  assertKnownFields(record, new Set(["id", "version", "runTimeoutMs", "decisionTimeoutMs"]), "timeoutPolicy");
  return {
    ...normalizePolicyRef(record, "timeoutPolicy"),
    ...(record.runTimeoutMs === undefined ? {} : { runTimeoutMs: positiveInteger(record.runTimeoutMs, "timeoutPolicy.runTimeoutMs") }),
    ...(record.decisionTimeoutMs === undefined
      ? {}
      : { decisionTimeoutMs: positiveInteger(record.decisionTimeoutMs, "timeoutPolicy.decisionTimeoutMs") })
  };
}

function normalizeRetryPolicy(value: unknown): GenericExperimentRetryPolicyV1 {
  const record = requireRecord(value, "retryPolicy");
  assertKnownFields(record, new Set(["id", "version", "maxAttempts", "backoffMs"]), "retryPolicy");
  return {
    ...normalizePolicyRef(record, "retryPolicy"),
    maxAttempts: positiveInteger(record.maxAttempts, "retryPolicy.maxAttempts"),
    ...(record.backoffMs === undefined ? {} : { backoffMs: nonNegativeInteger(record.backoffMs, "retryPolicy.backoffMs") })
  };
}

function normalizeArtifactPolicy(value: unknown): GenericExperimentArtifactPolicyV1 {
  const record = requireRecord(value, "artifactPolicy");
  assertKnownFields(record, new Set(["id", "version", "visibility"]), "artifactPolicy");
  const visibility = record.visibility;
  if (visibility !== "research-full" && visibility !== "postgame-redacted" && visibility !== "public") {
    throw new Error("artifactPolicy.visibility is invalid.");
  }
  return { ...normalizePolicyRef(record, "artifactPolicy"), visibility };
}

function normalizeCheckpointPolicy(value: unknown): GenericExperimentCheckpointPolicyV1 {
  const record = requireRecord(value, "checkpointPolicy");
  assertKnownFields(record, new Set(["id", "version", "mode"]), "checkpointPolicy");
  const mode = record.mode;
  if (mode !== "none" && mode !== "final" && mode !== "native-boundaries") {
    throw new Error("checkpointPolicy.mode is invalid.");
  }
  return { ...normalizePolicyRef(record, "checkpointPolicy"), mode };
}

function normalizeProviderPolicy(value: unknown, required: boolean): GenericExperimentProviderPolicyV1 | undefined {
  if (value === undefined) {
    if (required) throw new Error("providerPolicy is required when modelAssignments are present.");
    return undefined;
  }
  const record = requireRecord(value, "providerPolicy");
  assertKnownFields(record, new Set(["id", "version", "stream"]), "providerPolicy");
  if (record.stream !== true) throw new Error("providerPolicy.stream must be true.");
  return { ...normalizePolicyRef(record, "providerPolicy"), stream: true };
}

function normalizePolicyRef(record: Record<string, unknown>, path: string): GenericExperimentPolicyRefV1 {
  return {
    id: requiredString(record.id, `${path}.id`),
    version: requiredString(record.version, `${path}.version`)
  };
}

function normalizeUniqueIds(value: unknown, path: string, sort: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const ids = value.map((entry, index) => requiredString(entry, `${path}[${index}]`));
  assertUnique(ids, path);
  return sort ? ids.sort((left, right) => left.localeCompare(right)) : ids;
}

function normalizePortableJsonObject(value: unknown, path: string): GenericJsonObject {
  const record = requireRecord(value, path);
  return normalizePortableJsonRecord(record, path);
}

function normalizePortableJsonRecord(record: Record<string, unknown>, path: string): GenericJsonObject {
  const result: GenericJsonObject = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      FORBIDDEN_PORTABLE_KEYS.has(normalizedKey) ||
      FORBIDDEN_PORTABLE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))
    ) {
      throw new Error(`${path}.${key} is not allowed in a portable experiment spec.`);
    }
    result[key] = normalizePortableJsonValue(record[key], `${path}.${key}`);
  }
  return result;
}

function normalizePortableJsonValue(value: unknown, path: string): GenericJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && /https?:\/\//i.test(value)) {
      throw new Error(`${path} must not contain an endpoint URL.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizePortableJsonValue(entry, `${path}[${index}]`));
  if (isRecord(value)) return normalizePortableJsonRecord(value, path);
  throw new Error(`${path} must contain only portable JSON values.`);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive integer.`);
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${path} must be a non-negative integer.`);
  return value as number;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} is required.`);
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function assertKnownFields(record: Record<string, unknown>, fields: ReadonlySet<string>, path: string): void {
  const unknownFields = Object.keys(record).filter((key) => !fields.has(key));
  if (unknownFields.length) throw new Error(`${path} contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
}

function assertUnique(values: readonly string[], label: string): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length) throw new Error(`${label} must be unique; duplicate ${Array.from(new Set(duplicates)).join(", ")}.`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
