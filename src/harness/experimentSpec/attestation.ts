import { hashStableJsonValue } from "../hash";
import type {
  SocialAssignmentActorResolution,
  SocialAssignmentResolutionEvidence,
  SocialEpisodeArtifact,
  SocialRuntimeActorBinding
} from "../social";
import { SOCIAL_ASSIGNMENT_RESOLUTION_VERSION, validateSocialReasonerCallEvidence } from "../social";
import {
  GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
  LEGACY_GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
  type GenericExperimentExecutionAttestationV1,
  type GenericExperimentProfileSpecV1,
  type NormalizedGenericExperimentSpecV1
} from "./types";
import { clonePortable, isRecord } from "./normalizeSpec";

/**
 * Stamp domain-resolved assignment rows with control-plane policy/configuration
 * and deterministic episode identity. The adapter supplies only the resolved
 * rows; it cannot choose the policy, seed, index, or evidence schema.
 */
export function createGenericExperimentAssignmentResolution(
  spec: NormalizedGenericExperimentSpecV1,
  episode: { index: number; seed: string },
  actors: readonly SocialAssignmentActorResolution[]
): SocialAssignmentResolutionEvidence {
  const canonicalActors = [...clonePortable(actors)].sort((left, right) => left.actorId.localeCompare(right.actorId));
  return {
    schemaVersion: SOCIAL_ASSIGNMENT_RESOLUTION_VERSION,
    policy: {
      id: spec.assignmentPolicy.id,
      version: spec.assignmentPolicy.version,
      configurationHash: hashStableJsonValue(spec.assignmentPolicy.configuration ?? {})
    },
    episode: {
      index: episode.index,
      seed: episode.seed
    },
    actors: canonicalActors
  };
}

export function createGenericExperimentExecutionAttestation(
  spec: NormalizedGenericExperimentSpecV1,
  episode: Pick<
    SocialEpisodeArtifact,
    "assignmentResolution" | "execution" | "runtimeActorIds" | "runtimeActors" | "profiles" | "schedulerMode" | "steps"
  >,
  options: { assignmentResolutionRequired?: boolean } = {}
): GenericExperimentExecutionAttestationV1 {
  const assignmentResolutionRequired = options.assignmentResolutionRequired ?? false;
  const evidenceErrors = validateGenericExperimentExecutionEvidence(spec, episode, "socialEpisode", {
    requireAssignmentResolution: assignmentResolutionRequired
  });
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
    schemaVersion: assignmentResolutionRequired
      ? GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION
      : LEGACY_GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION,
    specHash: hashStableJsonValue(spec),
    schedulerMode: episode.schedulerMode,
    ...(episode.execution?.maxTransitions === undefined
      ? {}
      : { maxTransitions: episode.execution.maxTransitions }),
    ...(episode.execution?.decisionTimeoutMs === undefined
      ? {}
      : { decisionTimeoutMs: episode.execution.decisionTimeoutMs }),
    ...(episode.execution?.reasonerExecutionClass === undefined
      ? {}
      : { reasonerExecutionClass: episode.execution.reasonerExecutionClass }),
    actors: episode.runtimeActors!.map((binding) => {
      const profile = profileById.get(binding.profileId)!;
      const modelAssignment = modelByProfileId.get(binding.profileId);
      return {
        actorId: binding.actorId,
        profile: clonePortable(profile),
        ...(modelAssignment === undefined ? {} : { modelAssignment: clonePortable(modelAssignment) })
      };
    }),
    ...(assignmentResolutionRequired
      ? { assignmentResolution: clonePortable(episode.assignmentResolution!) }
      : {}),
    ...(bindsProviderBackedReasoners ? { reasonerCalls: clonePortable(reasonerCalls) } : {})
  };
}

export function validateGenericExperimentExecutionAttestation(
  input: unknown,
  spec: NormalizedGenericExperimentSpecV1,
  episode: Pick<
    SocialEpisodeArtifact,
    "assignmentResolution" | "execution" | "runtimeActorIds" | "runtimeActors" | "profiles" | "schedulerMode" | "steps"
  >,
  path = "executionAttestation"
): string[] {
  if (!isRecord(input)) return [`${path} must be an object.`];
  let expected: GenericExperimentExecutionAttestationV1;
  try {
    const current = createGenericExperimentExecutionAttestation(spec, episode, {
      assignmentResolutionRequired:
        input.schemaVersion !== LEGACY_GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION
    });
    expected = current;
  } catch (error) {
    return [`${path} cannot be validated: ${error instanceof Error ? error.message : "invalid execution evidence"}`];
  }
  const unknownFields = Object.keys(input).filter(
    (key) => ![
      "schemaVersion",
      "specHash",
      "schedulerMode",
      "maxTransitions",
      "decisionTimeoutMs",
      "reasonerExecutionClass",
      "actors",
      "assignmentResolution",
      "reasonerCalls"
    ].includes(key)
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
    "assignmentResolution" | "execution" | "runtimeActorIds" | "runtimeActors" | "profiles" | "steps"
  >,
  path = "socialEpisode",
  options: { requireAssignmentResolution?: boolean } = {}
): string[] {
  const errors: string[] = [];
  if (episode.execution?.maxTransitions !== spec.maxTransitions) {
    errors.push(`${path}.execution.maxTransitions must match experiment.spec.maxTransitions.`);
  }
  if (episode.execution?.decisionTimeoutMs !== spec.timeoutPolicy.decisionTimeoutMs) {
    errors.push(`${path}.execution.decisionTimeoutMs must match experiment.spec.timeoutPolicy.decisionTimeoutMs.`);
  }
  if (spec.providerPolicy && episode.execution?.reasonerExecutionClass !== "live-provider") {
    errors.push(
      `${path}.execution.reasonerExecutionClass must be live-provider when experiment.spec.providerPolicy is present.`
    );
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
  validateExperimentAssignmentResolution({
    spec,
    resolution: episode.assignmentResolution,
    runtimeActors,
    path,
    errors,
    required: options.requireAssignmentResolution ?? false
  });
  validateExperimentReasonerCallEvidence({ spec, episode, runtimeActors, path, errors });
  return errors;
}

export function validateExperimentAssignmentResolution(input: {
  spec: NormalizedGenericExperimentSpecV1;
  resolution: SocialAssignmentResolutionEvidence | undefined;
  runtimeActors: SocialRuntimeActorBinding[];
  path: string;
  errors: string[];
  required: boolean;
}): void {
  const label = `${input.path}.assignmentResolution`;
  if (!input.resolution) {
    if (input.required) input.errors.push(`${label} is required by experiment assignment policy execution authority.`);
    return;
  }
  const resolution = input.resolution;
  if (resolution.schemaVersion !== SOCIAL_ASSIGNMENT_RESOLUTION_VERSION) {
    input.errors.push(`${label}.schemaVersion must be ${SOCIAL_ASSIGNMENT_RESOLUTION_VERSION}.`);
  }
  if (
    resolution.policy?.id !== input.spec.assignmentPolicy.id ||
    resolution.policy?.version !== input.spec.assignmentPolicy.version
  ) {
    input.errors.push(`${label}.policy must match experiment.spec.assignmentPolicy identity.`);
  }
  const expectedConfigurationHash = hashStableJsonValue(input.spec.assignmentPolicy.configuration ?? {});
  if (resolution.policy?.configurationHash !== expectedConfigurationHash) {
    input.errors.push(`${label}.policy.configurationHash must match experiment.spec.assignmentPolicy.configuration.`);
  }
  if (!Number.isInteger(resolution.episode?.index) || resolution.episode.index < 0) {
    input.errors.push(`${label}.episode.index must be a nonnegative integer.`);
  } else {
    const expectedSeed = `${input.spec.seed}:g${resolution.episode.index + 1}`;
    if (resolution.episode.seed !== expectedSeed) {
      input.errors.push(`${label}.episode.seed must match the deterministic experiment episode schedule.`);
    }
  }
  if (!Array.isArray(resolution.actors)) {
    input.errors.push(`${label}.actors must be an array.`);
    return;
  }
  if (resolution.actors.length !== input.runtimeActors.length) {
    input.errors.push(`${label}.actors must contain exactly the runtime actor roster.`);
    return;
  }
  const expectedByActor = new Map(input.runtimeActors.map((binding) => [binding.actorId, binding]));
  const actorIds = resolution.actors.map((actor) =>
    actor && typeof actor === "object" ? (actor as Partial<SocialAssignmentActorResolution>).actorId : undefined
  );
  if (new Set(actorIds).size !== actorIds.length) {
    input.errors.push(`${label}.actors must not contain duplicate actor ids.`);
  }
  const sorted = [...actorIds].sort((left, right) => String(left).localeCompare(String(right)));
  if (sorted.some((actorId, index) => actorId !== actorIds[index])) {
    input.errors.push(`${label}.actors must be sorted by actorId.`);
  }
  for (const [index, actor] of resolution.actors.entries()) {
    if (!actor || typeof actor !== "object") {
      input.errors.push(`${label}.actors[${index}] must be an object.`);
      continue;
    }
    const row = actor as Partial<SocialAssignmentActorResolution>;
    const binding = typeof row.actorId === "string" ? expectedByActor.get(row.actorId) : undefined;
    if (!binding) {
      input.errors.push(`${label}.actors[${index}].actorId must reference the exact runtime actor roster.`);
      continue;
    }
    if (row.profileId !== binding.profileId) {
      input.errors.push(`${label}.actors[${index}].profileId must match the runtime actor binding.`);
    }
    if (row.model !== binding.model) {
      input.errors.push(`${label}.actors[${index}].model must match the runtime actor binding.`);
    }
  }
}

export function validateExperimentReasonerCallEvidence(input: {
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
      if (input.spec.providerPolicy && call?.outcome !== "aborted" && stream?.enabled !== true) {
        input.errors.push(`${label}.stream.enabled must be true under experiment.spec.providerPolicy.`);
      }
      if (input.spec.providerPolicy && call?.outcome === "completed" && stream?.completed !== true) {
        input.errors.push(`${label} did not complete its provider stream.`);
      }
      if (binding && assignedModels.get(binding.profileId) !== call?.model) {
        input.errors.push(`${label}.model must match experiment.spec.modelAssignments.`);
      }
    }
  }
}

export function validateExperimentRuntimeActorBinding(input: {
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
