import { hashStableJsonValue } from "../hash";
import {
  GENERIC_EXPERIMENT_FORK_LINEAGE_VERSION,
  type GenericExperimentForkChangeDeclarationV1,
  type GenericExperimentForkChangeFieldV1,
  type GenericExperimentForkLineageV1,
  type GenericExperimentProvenanceV1,
  type NormalizedGenericExperimentSpecV1
} from "./types";
import {
  NORMALIZED_SPEC_CHANGE_FIELDS,
  NORMALIZED_SPEC_CHANGE_FIELD_SET,
  assertUnique,
  clonePortable,
  isRecord,
  optionalString,
  requireRecord,
  requiredString
} from "./normalizeSpec";
import { validateGenericExperimentProvenance } from "./provenance";

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

export function changedExperimentFields(
  parent: NormalizedGenericExperimentSpecV1,
  child: NormalizedGenericExperimentSpecV1
): GenericExperimentForkChangeFieldV1[] {
  return NORMALIZED_SPEC_CHANGE_FIELDS
    .filter((field) => hashExperimentField(parent, field) !== hashExperimentField(child, field))
    .sort((left, right) => left.localeCompare(right));
}

export function hashExperimentField(
  spec: NormalizedGenericExperimentSpecV1,
  field: GenericExperimentForkChangeFieldV1
): string {
  return hashStableJsonValue(
    Object.prototype.hasOwnProperty.call(spec, field)
      ? { present: true, value: spec[field] }
      : { present: false }
  );
}

export function normalizeExperimentChangeDeclarations(input: unknown): GenericExperimentForkChangeDeclarationV1[] {
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
