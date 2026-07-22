import {
  cloneSocialDomainAdapterManifest,
  validateSocialDomainAdapterManifest,
  type SocialDomainAdapterManifest
} from "./domainAdapter";
import type { SocialResolvedSchedulerMode } from "./social";

/**
 * Portable, domain-neutral experiment control-plane input.
 *
 * This contract is data only. Runtime factories, actors, policies, reasoners,
 * provider clients, abort signals, credentials, endpoints, prompts, and raw
 * request options must be resolved from reviewed registries outside the
 * persisted experiment specification.
 */
export const GENERIC_EXPERIMENT_SPEC_VERSION = "harness.experiment.v1" as const;

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
    if (FORBIDDEN_PORTABLE_KEYS.has(normalizedKey)) {
      throw new Error(`${path}.${key} is not allowed in a portable experiment spec.`);
    }
    result[key] = normalizePortableJsonValue(record[key], `${path}.${key}`);
  }
  return result;
}

function normalizePortableJsonValue(value: unknown, path: string): GenericJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
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
