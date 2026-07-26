import { cloneJson } from "./valueUtils";
import { hashStableState } from "../hash";
import { SOCIAL_ASSIGNMENT_RESOLUTION_VERSION, type SocialAgentProfile, type SocialAssignmentResolutionEvidence, type SocialRuntimeActorBinding } from "./contracts";
export function normalizeRuntimeActorIds(
  runtimeActorIds: readonly string[] | undefined,
  errors: string[],
  label: string
): string[] | undefined {
  if (runtimeActorIds === undefined) return undefined;
  if (!Array.isArray(runtimeActorIds)) {
    errors.push(`${label} must be an array.`);
    return undefined;
  }
  const seen = new Set<string>();
  for (const [index, actorId] of runtimeActorIds.entries()) {
    if (typeof actorId !== "string" || !actorId.trim()) errors.push(`${label}[${index}] is missing actor id.`);
    else if (seen.has(actorId)) errors.push(`${label}[${index}] duplicates actor ${actorId}.`);
    if (typeof actorId === "string") seen.add(actorId);
  }
  const sorted = [...runtimeActorIds].sort();
  if (sorted.some((actorId, index) => actorId !== runtimeActorIds[index])) {
    errors.push(`${label} must be sorted for canonical artifact identity.`);
  }
  return [...runtimeActorIds];
}

export function normalizeRuntimeActorBindings(
  runtimeActors: readonly SocialRuntimeActorBinding[] | undefined,
  errors: string[],
  label: string
): SocialRuntimeActorBinding[] | undefined {
  if (runtimeActors === undefined) return undefined;
  if (!Array.isArray(runtimeActors)) {
    errors.push(`${label} must be an array.`);
    return undefined;
  }
  const seen = new Set<string>();
  let invalidShape = false;
  const allowedFields = new Set([
    "actorId",
    "profileId",
    "profileVersion",
    "model",
    "temperature",
    "policyId",
    "reasonerId",
    "personaId"
  ]);
  for (const [index, binding] of runtimeActors.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!binding || typeof binding !== "object") {
      errors.push(`${itemLabel} must be an object.`);
      invalidShape = true;
      continue;
    }
    const unknownFields = Object.keys(binding).filter((key) => !allowedFields.has(key));
    if (unknownFields.length) {
      errors.push(`${itemLabel} contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
    }
    if (typeof binding.actorId !== "string" || !binding.actorId.trim()) errors.push(`${itemLabel}.actorId is missing.`);
    else if (seen.has(binding.actorId)) errors.push(`${itemLabel}.actorId duplicates ${binding.actorId}.`);
    if (typeof binding.actorId === "string") seen.add(binding.actorId);
    if (typeof binding.profileId !== "string" || !binding.profileId.trim()) errors.push(`${itemLabel}.profileId is missing.`);
    if (typeof binding.model !== "string" || !binding.model.trim()) errors.push(`${itemLabel}.model is missing.`);
    for (const [field, value] of [
      ["profileVersion", binding.profileVersion],
      ["policyId", binding.policyId],
      ["reasonerId", binding.reasonerId],
      ["personaId", binding.personaId]
    ] as const) {
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        errors.push(`${itemLabel}.${field} must be nonempty when present.`);
      }
    }
    if (
      binding.temperature !== undefined &&
      (!Number.isFinite(binding.temperature) || binding.temperature < 0 || binding.temperature > 2)
    ) {
      errors.push(`${itemLabel}.temperature must be between 0 and 2 when present.`);
    }
  }
  if (invalidShape) return undefined;
  const actorIds = runtimeActors.map(({ actorId }) => actorId);
  const sortedActorIds = [...actorIds].sort();
  if (sortedActorIds.some((actorId, index) => actorId !== actorIds[index])) {
    errors.push(`${label} must be sorted by actorId for canonical artifact identity.`);
  }
  return runtimeActors.map(cloneJson);
}

export function validateSocialAssignmentResolutionEvidence(
  value: SocialAssignmentResolutionEvidence,
  errors: string[],
  label: string
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const record = value as unknown as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => !["schemaVersion", "policy", "episode", "actors"].includes(key));
  if (unknownFields.length) errors.push(`${label} contains unknown field(s): ${unknownFields.sort().join(", ")}.`);
  if (record.schemaVersion !== SOCIAL_ASSIGNMENT_RESOLUTION_VERSION) {
    errors.push(`${label}.schemaVersion must be ${SOCIAL_ASSIGNMENT_RESOLUTION_VERSION}.`);
  }
  const policy = record.policy && typeof record.policy === "object" && !Array.isArray(record.policy)
    ? record.policy as Record<string, unknown>
    : undefined;
  if (!policy) {
    errors.push(`${label}.policy must be an object.`);
  } else {
    const policyUnknown = Object.keys(policy).filter((key) => !["id", "version", "configurationHash"].includes(key));
    if (policyUnknown.length) errors.push(`${label}.policy contains unknown field(s): ${policyUnknown.sort().join(", ")}.`);
    for (const field of ["id", "version", "configurationHash"] as const) {
      if (typeof policy[field] !== "string" || !policy[field].trim()) errors.push(`${label}.policy.${field} is required.`);
    }
  }
  const episode = record.episode && typeof record.episode === "object" && !Array.isArray(record.episode)
    ? record.episode as Record<string, unknown>
    : undefined;
  if (!episode) {
    errors.push(`${label}.episode must be an object.`);
  } else {
    const episodeUnknown = Object.keys(episode).filter((key) => !["index", "seed"].includes(key));
    if (episodeUnknown.length) errors.push(`${label}.episode contains unknown field(s): ${episodeUnknown.sort().join(", ")}.`);
    if (!Number.isInteger(episode.index) || (episode.index as number) < 0) {
      errors.push(`${label}.episode.index must be a nonnegative integer.`);
    }
    if (typeof episode.seed !== "string" || !episode.seed.trim()) errors.push(`${label}.episode.seed is required.`);
  }
  if (!Array.isArray(record.actors)) {
    errors.push(`${label}.actors must be an array.`);
    return;
  }
  const seen = new Set<string>();
  for (const [index, rawActor] of record.actors.entries()) {
    const actorLabel = `${label}.actors[${index}]`;
    if (!rawActor || typeof rawActor !== "object" || Array.isArray(rawActor)) {
      errors.push(`${actorLabel} must be an object.`);
      continue;
    }
    const actor = rawActor as Record<string, unknown>;
    const actorUnknown = Object.keys(actor).filter(
      (key) => !["actorId", "profileId", "model", "seat", "role", "team", "domain"].includes(key)
    );
    if (actorUnknown.length) errors.push(`${actorLabel} contains unknown field(s): ${actorUnknown.sort().join(", ")}.`);
    for (const field of ["actorId", "profileId", "model"] as const) {
      if (typeof actor[field] !== "string" || !(actor[field] as string).trim()) errors.push(`${actorLabel}.${field} is required.`);
    }
    if (typeof actor.actorId === "string") {
      if (seen.has(actor.actorId)) errors.push(`${actorLabel}.actorId duplicates ${actor.actorId}.`);
      seen.add(actor.actorId);
    }
    if (actor.seat !== undefined && !(
      (typeof actor.seat === "string" && actor.seat.trim()) ||
      (typeof actor.seat === "number" && Number.isFinite(actor.seat))
    )) errors.push(`${actorLabel}.seat must be a nonempty string or finite number when present.`);
    for (const field of ["role", "team"] as const) {
      if (actor[field] !== undefined && (typeof actor[field] !== "string" || !(actor[field] as string).trim())) {
        errors.push(`${actorLabel}.${field} must be nonempty when present.`);
      }
    }
    if (actor.domain !== undefined && !isPortableAssignmentJson(actor.domain)) {
      errors.push(`${actorLabel}.domain must be a portable JSON object when present.`);
    }
  }
  const actorIds = (record.actors as Array<Record<string, unknown>>)
    .map((actor) => actor?.actorId)
    .filter((actorId): actorId is string => typeof actorId === "string");
  const sorted = [...actorIds].sort((left, right) => left.localeCompare(right));
  if (sorted.some((actorId, index) => actorId !== actorIds[index])) {
    errors.push(`${label}.actors must be sorted by actorId for canonical artifact identity.`);
  }
}

function isPortableAssignmentJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isPortableAssignmentJson(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isPortableAssignmentJson(entry, seen));
}

export function runtimeActorProfileIdentityHash(binding: SocialRuntimeActorBinding): string {
  return hashStableState({
    id: binding.profileId,
    ...(binding.profileVersion === undefined ? {} : { version: binding.profileVersion }),
    model: binding.model,
    ...(binding.temperature === undefined ? {} : { temperature: binding.temperature }),
    ...(binding.policyId === undefined ? {} : { policyId: binding.policyId }),
    ...(binding.reasonerId === undefined ? {} : { reasonerId: binding.reasonerId }),
    ...(binding.personaId === undefined ? {} : { personaId: binding.personaId })
  });
}

export function socialProfileIdentityHash(profile: SocialAgentProfile): string {
  return hashStableState({
    id: profile.id,
    ...(profile.version === undefined ? {} : { version: profile.version }),
    model: profile.model,
    ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
    ...(profile.policyId === undefined ? {} : { policyId: profile.policyId }),
    ...(profile.reasonerId === undefined ? {} : { reasonerId: profile.reasonerId }),
    ...(profile.personaId === undefined ? {} : { personaId: profile.personaId })
  });
}
