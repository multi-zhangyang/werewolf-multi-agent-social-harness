/**
 * Domain-neutral execution provenance.
 *
 * A social episode records commands, observations, messages, and hashes, but
 * those records are only meaningful with the domain implementation that gave
 * them semantics.  This manifest deliberately describes only stable, public
 * semantic identities.  It must never contain closures, prompts, endpoint
 * URLs, credentials, provider diagnostics, or private game state.
 */
export const SOCIAL_DOMAIN_ADAPTER_MANIFEST_VERSION = "harness.domain-adapter.v1";

export type SocialDomainAdapterComponentKind =
  | "environment"
  | "command_codec"
  | "observation_projection"
  | "scheduler"
  | "agent_state_schema";

export interface SocialDomainAdapterComponentManifest {
  kind: SocialDomainAdapterComponentKind;
  id: string;
  version: string;
  /** SHA-256 (or an equivalent stable digest) of a safe semantic descriptor. */
  semanticHash: string;
}

export interface SocialDomainAdapterManifest {
  schemaVersion: typeof SOCIAL_DOMAIN_ADAPTER_MANIFEST_VERSION;
  domainId: string;
  adapterId: string;
  adapterVersion: string;
  /** Digest of the safe, domain-owned adapter semantic descriptor. */
  semanticHash: string;
  /** Sorted once by kind/id/version; each execution-critical kind occurs once. */
  components: readonly SocialDomainAdapterComponentManifest[];
}

const COMPONENT_KINDS: readonly SocialDomainAdapterComponentKind[] = [
  "environment",
  "command_codec",
  "observation_projection",
  "scheduler",
  "agent_state_schema"
];

const REQUIRED_COMPONENT_KINDS = new Set<SocialDomainAdapterComponentKind>(COMPONENT_KINDS);

export function validateSocialDomainAdapterManifest(manifest: unknown, path = "domainAdapter"): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [`${path} must be an object.`];
  }
  const value = manifest as Partial<SocialDomainAdapterManifest>;
  if (value.schemaVersion !== SOCIAL_DOMAIN_ADAPTER_MANIFEST_VERSION) {
    errors.push(`${path}.schemaVersion must be ${SOCIAL_DOMAIN_ADAPTER_MANIFEST_VERSION}.`);
  }
  for (const field of ["domainId", "adapterId", "adapterVersion", "semanticHash"] as const) {
    if (!isNonemptyString(value[field])) errors.push(`${path}.${field} is required.`);
  }
  if (!Array.isArray(value.components)) {
    errors.push(`${path}.components must be an array.`);
    return errors;
  }
  const seenKinds = new Set<string>();
  let previousKey: string | undefined;
  for (const [index, component] of value.components.entries()) {
    const componentPath = `${path}.components[${index}]`;
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      errors.push(`${componentPath} must be an object.`);
      continue;
    }
    const record = component as Partial<SocialDomainAdapterComponentManifest>;
    if (!COMPONENT_KINDS.includes(record.kind as SocialDomainAdapterComponentKind)) {
      errors.push(`${componentPath}.kind is invalid.`);
    }
    for (const field of ["id", "version", "semanticHash"] as const) {
      if (!isNonemptyString(record[field])) errors.push(`${componentPath}.${field} is required.`);
    }
    if (typeof record.kind === "string") {
      if (seenKinds.has(record.kind)) errors.push(`${path}.components contains duplicate kind ${record.kind}.`);
      seenKinds.add(record.kind);
    }
    const key = `${record.kind ?? ""}\u0000${record.id ?? ""}\u0000${record.version ?? ""}`;
    if (previousKey !== undefined && previousKey.localeCompare(key) >= 0) {
      errors.push(`${path}.components must be sorted canonically by kind, id, and version.`);
    }
    previousKey = key;
  }
  for (const kind of REQUIRED_COMPONENT_KINDS) {
    if (!seenKinds.has(kind)) errors.push(`${path}.components is missing required ${kind} provenance.`);
  }
  return errors;
}

/**
 * Exact semantic equality is required for a recorded replay or checkpoint
 * restore.  A child experiment that intentionally changes semantics must
 * create a new episode manifest and explicit fork provenance; it cannot
 * silently reinterpret its parent execution history.
 */
export function compareSocialDomainAdapterManifests(
  recorded: SocialDomainAdapterManifest | undefined,
  runtime: SocialDomainAdapterManifest | undefined,
  options: { recordedPath?: string; runtimePath?: string } = {}
): string[] {
  const recordedPath = options.recordedPath ?? "recorded domainAdapter";
  const runtimePath = options.runtimePath ?? "runtime domainAdapter";
  if (!recorded) {
    // Artifacts written before this contract remain readable/replayable, but
    // cannot claim adapter-bound provenance retroactively.
    return [];
  }
  const errors = validateSocialDomainAdapterManifest(recorded, recordedPath);
  if (!runtime) {
    errors.push(`${runtimePath} is required to replay or restore an adapter-bound artifact.`);
    return errors;
  }
  errors.push(...validateSocialDomainAdapterManifest(runtime, runtimePath));
  if (errors.length) return errors;
  const recordedJson = JSON.stringify(recorded);
  const runtimeJson = JSON.stringify(runtime);
  if (recordedJson !== runtimeJson) {
    errors.push(`${runtimePath} does not exactly match ${recordedPath}.`);
  }
  return errors;
}

export function cloneSocialDomainAdapterManifest(manifest: SocialDomainAdapterManifest): SocialDomainAdapterManifest {
  return structuredClone(manifest);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
