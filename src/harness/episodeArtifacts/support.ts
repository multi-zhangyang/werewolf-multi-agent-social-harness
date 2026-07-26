import { hashStableState } from "../hash";
import { SocialEpisodeArtifact } from "../social";
import { HARNESS_AGENT_SNAPSHOT_FRAME_VERSION, HarnessAgentSnapshotFrame, harnessAgentSnapshotFrameId } from "./envelopeModel";
export function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function assertClosedProjectionKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[]
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${label} contains unsupported field ${key}.`);
  }
}

export function validatePortableProjectionJson(value: unknown, path: string, seen = new Set<object>()): string[] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return [];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [`${path} contains a non-finite number.`];
  if (typeof value !== "object") return [`${path} contains unsupported non-JSON data.`];
  if (seen.has(value)) return [`${path} contains a cycle.`];
  seen.add(value);
  const errors: string[] = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      errors.push(...validatePortableProjectionJson(item, `${path}[${index}]`, seen));
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      errors.push(`${path} contains a non-JSON object.`);
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) errors.push(`${path}.${key} is undefined.`);
        else errors.push(...validatePortableProjectionJson(item, `${path}.${key}`, seen));
      }
    }
  }
  seen.delete(value);
  return errors;
}

export function assertCanonicalHarnessAgentSnapshotFrame<TAgentState>(frame: HarnessAgentSnapshotFrame<TAgentState>, label: string): void {
  if (frame.artifactVersion !== HARNESS_AGENT_SNAPSHOT_FRAME_VERSION) {
    throw new Error(`${label}: artifactVersion must be ${HARNESS_AGENT_SNAPSHOT_FRAME_VERSION}.`);
  }
  if (frame.kind !== "agent-snapshot-frame") throw new Error(`${label}: kind must be agent-snapshot-frame.`);
  if (!isNonemptyString(frame.frameId)) throw new Error(`${label}: frameId is required.`);
  if (!Array.isArray(frame.agents)) throw new Error(`${label}: agents must be an array.`);
  const actualHash = hashStableState(frame.agents);
  if (frame.agentsHash !== actualHash) throw new Error(`${label}: agentsHash mismatch.`);
  if (frame.frameId !== harnessAgentSnapshotFrameId(frame.agentsHash)) {
    throw new Error(`${label}: frameId does not match agentsHash.`);
  }
}

export function endsAtCompleteNativeBatch(steps: SocialEpisodeArtifact["steps"]): boolean {
  const boundary = steps.at(-1);
  if (!boundary?.batchId || boundary.schedulerMode === "aec") return true;
  if (!boundary.batchSize || boundary.batchSize < 1) return false;
  let contiguousBatchSize = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].batchId !== boundary.batchId) break;
    contiguousBatchSize += 1;
  }
  return contiguousBatchSize === boundary.batchSize;
}

/**
 * Harness artifacts are required to be serializable.  Clone at every generic
 * artifact boundary so checkpoint builders never retain a domain actor's
 * mutable state object.
 */
export function cloneArtifact<T>(value: T): T {
  return structuredClone(value);
}
