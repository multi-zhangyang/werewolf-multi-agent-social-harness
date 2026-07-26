import { hashStableJsonValue } from "../hash";
import {
  GENERIC_EXPERIMENT_PROVENANCE_VERSION,
  GENERIC_EXPERIMENT_SPEC_VERSION,
  LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION,
  LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2,
  type GenericExperimentProvenanceV1,
  type NormalizedGenericExperimentSpecV1
} from "./types";
import { isRecord, normalizeGenericExperimentSpec } from "./normalizeSpec";

/** Normalize once, then bind the complete portable spec to a stable identity. */
export function createGenericExperimentProvenance(
  input: unknown,
  options: { assignmentResolutionRequired?: boolean } = {}
): GenericExperimentProvenanceV1 {
  const spec = normalizeGenericExperimentSpec(input);
  const assignmentResolutionRequired = options.assignmentResolutionRequired ?? false;
  return {
    schemaVersion: assignmentResolutionRequired
      ? GENERIC_EXPERIMENT_PROVENANCE_VERSION
      : LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2,
    specVersion: GENERIC_EXPERIMENT_SPEC_VERSION,
    specId: spec.id,
    specHash: hashStableJsonValue(spec),
    spec,
    executionAttestationRequired: true,
    ...(assignmentResolutionRequired ? { assignmentResolutionRequired: true as const } : {})
  };
}

export function validateGenericExperimentProvenance(input: unknown, path = "experiment"): string[] {
  if (!isRecord(input)) return [`${path} must be an object.`];
  const errors: string[] = [];
  const unknownFields = Object.keys(input).filter(
    (key) => ![
      "schemaVersion",
      "specVersion",
      "specId",
      "specHash",
      "spec",
      "executionAttestationRequired",
      "assignmentResolutionRequired"
    ].includes(key)
  );
  if (unknownFields.length) errors.push(`${path} contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
  if (
    input.schemaVersion !== GENERIC_EXPERIMENT_PROVENANCE_VERSION &&
    input.schemaVersion !== LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2 &&
    input.schemaVersion !== LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION
  ) {
    errors.push(
      `${path}.schemaVersion must be ${GENERIC_EXPERIMENT_PROVENANCE_VERSION} or legacy ${LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2}/${LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION}.`
    );
  }
  if (input.specVersion !== GENERIC_EXPERIMENT_SPEC_VERSION) {
    errors.push(`${path}.specVersion must be ${GENERIC_EXPERIMENT_SPEC_VERSION}.`);
  }
  if (input.executionAttestationRequired !== undefined && input.executionAttestationRequired !== true) {
    errors.push(`${path}.executionAttestationRequired must be true when present.`);
  }
  if (input.assignmentResolutionRequired !== undefined && input.assignmentResolutionRequired !== true) {
    errors.push(`${path}.assignmentResolutionRequired must be true when present.`);
  }
  if (
    input.schemaVersion === GENERIC_EXPERIMENT_PROVENANCE_VERSION &&
    input.executionAttestationRequired !== true
  ) {
    errors.push(`${path}.executionAttestationRequired is required by ${GENERIC_EXPERIMENT_PROVENANCE_VERSION}.`);
  }
  if (
    input.schemaVersion === LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2 &&
    input.executionAttestationRequired !== true
  ) {
    errors.push(`${path}.executionAttestationRequired is required by ${LEGACY_GENERIC_EXPERIMENT_PROVENANCE_VERSION_V2}.`);
  }
  if (
    input.schemaVersion === GENERIC_EXPERIMENT_PROVENANCE_VERSION &&
    input.assignmentResolutionRequired !== true
  ) {
    errors.push(`${path}.assignmentResolutionRequired is required by ${GENERIC_EXPERIMENT_PROVENANCE_VERSION}.`);
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

