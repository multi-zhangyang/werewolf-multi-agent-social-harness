import path from "node:path";
import { normalizeModelList } from "../agents/schema";
import {
  type HarnessCheckpointPrefixSelector,
  HarnessCheckpointSelectionError,
  type MatchArtifact,
  assertValidMatchArtifactIntegrity
} from "../harness/artifacts";
import { HarnessCheckpointSelectionError as GenericHarnessCheckpointSelectionError } from "../harness/episodeArtifacts";
import {
  type NormalizedTournamentExperiment,
  type TournamentExperimentSpecV1,
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec
} from "../harness/experiment";
import {
  type NormalizedMatrixExperiment,
  mergeMatrixExperimentOverrides,
  normalizeMatrixExperimentSpec
} from "../harness/experimentMatrix";
import { isRecord, removeUndefined } from "./jsonUtil";

export const FORBIDDEN_CHECKPOINT_BODY_FIELDS = [
  "checkpointId",
  "path",
  "file",
  "artifactPath",
  "checkpointPath",
  "outputDir",
  "artifact",
  "checkpoint",
  "state",
  "initialState",
  "agents",
  "initialAgentStates",
  "trajectory",
  "socialEpisode",
  "executionPrefix",
  "channels",
  "socialMessages",
  "initialSocialMessages",
  "stateHash",
  "trajectoryHash",
  "executionPrefixHash",
  "agentsHash",
  "channelsHash",
  "messagesHash",
  "socialMessagesHash",
  "agentSnapshots",
  "agentSnapshotFrames",
  "agentSnapshotsAfterStep",
  "actorSnapshotsAfterStep",
  "agentSnapshotsHashAfterStep",
  "actorSnapshotsHashAfterStep",
  "agentSnapshotFrameIdAfterStep",
  "actorSnapshotFrameIdAfterStep"
];

export const FORBIDDEN_TOURNAMENT_BODY_FIELDS = [
  "path",
  "file",
  "artifactPath",
  "outputDir",
  "exportDir",
  "checkpointPath",
  "artifact",
  "artifacts",
  "checkpoint",
  "overwrite",
  "baseDir",
  "manifestPath",
  "registryPath"
];

export const FORBIDDEN_TOURNAMENT_SHARE_BODY_FIELDS = [
  ...FORBIDDEN_TOURNAMENT_BODY_FIELDS,
  "shareId",
  "token",
  "artifactSetId",
  "id",
  "downloads",
  "files",
  "projection",
  "publicShareSafe"
];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export function requestBodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new HttpError(400, "Request body must be a JSON object.");
  return body;
}

export function normalizeOptionalDirectory(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(500, "Configured artifact base directory must be a string.");
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

export function assertAllowedBodyFields(body: Record<string, unknown>, allowed: string[], context: string): void {
  const allowedSet = new Set(allowed);
  const unknownFields = Object.keys(body).filter((field) => !allowedSet.has(field));
  if (unknownFields.length) {
    throw new HttpError(400, `${context} request contains unsupported field(s): ${unknownFields.join(", ")}.`);
  }
}

export function assertForbiddenBodyFields(body: Record<string, unknown>, forbidden: string[], context: string): void {
  const forbiddenFields = forbidden.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbiddenFields.length) {
    throw new HttpError(400, `${context} request contains forbidden field(s): ${forbiddenFields.join(", ")}.`);
  }
}

export function assertForbiddenTournamentRequestFields(body: Record<string, unknown>, context: string): void {
  assertForbiddenBodyFields(body, FORBIDDEN_TOURNAMENT_BODY_FIELDS, context);
  if (isRecord(body.spec)) {
    assertForbiddenBodyFields(body.spec, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} spec`);
  }
}

export function assertForbiddenMatrixRequestFields(body: Record<string, unknown>, context: string): void {
  assertForbiddenTournamentRequestFields(body, context);
  const spec = isRecord(body.spec) ? body.spec : body;
  if (isRecord(spec.base)) {
    assertForbiddenBodyFields(spec.base, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} base`);
  }
  if (Array.isArray(spec.cells)) {
    spec.cells.forEach((cell, index) => {
      if (!isRecord(cell)) return;
      assertForbiddenBodyFields(cell, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} cell ${index + 1}`);
      if (isRecord(cell.spec)) {
        assertForbiddenBodyFields(cell.spec, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} cell ${index + 1} spec`);
      }
    });
  }
}

export function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string.`);
  return value;
}

export function parseOptionalBoundedString(value: unknown, name: string, maxLength: number): string | undefined {
  const parsed = parseOptionalString(value, name)?.trim();
  if (!parsed) return undefined;
  if (parsed.length > maxLength) throw new HttpError(400, `${name} must not exceed ${maxLength} characters.`);
  return parsed;
}

export function checkpointPrefixSelectorFromBody(body: Record<string, unknown>): HarnessCheckpointPrefixSelector | undefined {
  const hasTraceId = body.traceId !== undefined && body.traceId !== null && body.traceId !== "";
  const hasNativeTurnIndex = body.nativeTurnIndex !== undefined && body.nativeTurnIndex !== null && body.nativeTurnIndex !== "";
  const hasNativeStepCount = body.nativeStepCount !== undefined && body.nativeStepCount !== null && body.nativeStepCount !== "";
  const selectorCount = [hasTraceId, hasNativeTurnIndex, hasNativeStepCount].filter(Boolean).length;
  if (selectorCount === 0) return undefined;
  if (selectorCount > 1) throw new HttpError(400, "checkpoint creation request must include at most one prefix selector.");
  if (hasTraceId) return { traceId: parseOptionalString(body.traceId, "traceId") };
  if (hasNativeTurnIndex) return { nativeTurnIndex: parseOptionalPositiveInteger(body.nativeTurnIndex, "nativeTurnIndex") };
  return { nativeStepCount: parseOptionalPositiveInteger(body.nativeStepCount, "nativeStepCount") };
}

export function httpErrorFromCheckpointSelectionError(error: unknown): unknown {
  if (!(error instanceof HarnessCheckpointSelectionError)) return error;
  const status = error.code === "ambiguous_selector" || error.code === "selector_not_found" ? 400 : 409;
  return new HttpError(status, error.message, error.code);
}

export function requiredReplayFrameNativeStepCount(body: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(body, "nativeStepCount")) {
    throw new HttpError(400, "server-owned replay frame requires nativeStepCount.", "replay_frame_selector_required");
  }
  try {
    const value = parseOptionalPositiveInteger(body.nativeStepCount, "nativeStepCount");
    if (value === undefined) throw new Error("missing nativeStepCount");
    return value;
  } catch {
    throw new HttpError(400, "nativeStepCount must be a positive integer.", "replay_frame_selector_invalid");
  }
}

export function assertStoredMatchArtifactIntegrity(artifact: MatchArtifact): void {
  try {
    assertValidMatchArtifactIntegrity(artifact);
  } catch {
    throw new HttpError(409, "Stored match artifact failed integrity validation.", "artifact_integrity_invalid");
  }
}

export function httpErrorFromReplayFrameError(error: unknown): unknown {
  // Replay frames use the generic prefix selector.  The older Werewolf
  // checkpoint compatibility layer has a similarly named error class, but it
  // is a distinct runtime constructor and must not be used to classify a
  // generic replay-frame selection failure.
  if (!(error instanceof GenericHarnessCheckpointSelectionError)) return error;
  switch (error.code) {
    case "ambiguous_selector":
    case "selector_not_found":
      return new HttpError(400, "Replay frame nativeStepCount did not match a recorded native step.", "replay_frame_selector_not_found");
    case "unsafe_batch_boundary":
      return new HttpError(409, "Replay frame must end at a complete native scheduler batch boundary.", "replay_frame_unsafe_batch_boundary");
    case "prefix_replay_mismatch":
      return new HttpError(409, "Recorded replay prefix failed integrity verification.", "replay_frame_integrity_mismatch");
    default:
      return new HttpError(409, "Replay frame cannot be built from the selected native boundary.", "replay_frame_unavailable");
  }
}

export function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new HttpError(400, `${name} must be a boolean.`);
}

export function optionalSingleQueryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Artifact recovery audit ${key} filter is invalid.`);
  }
  return value.trim();
}

export function optionalIntegerQuery(query: Record<string, unknown>, key: string, options: { min: number; max: number; label?: string }): number | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  const label = options.label ?? "Artifact recovery audit";
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new HttpError(400, `${label} ${key} parameter is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new HttpError(400, `${label} ${key} parameter is out of range.`);
  }
  return parsed;
}

export function parseOptionalJointPhaseScheduler(
  value: unknown
): "aec-batched-decision" | "parallel" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "aec-batched-decision" || value === "parallel") return value;
  throw new Error('jointPhaseScheduler must be "aec-batched-decision" or "parallel".');
}

export function parseOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export function parseTemperature(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) throw new Error("temperature must be between 0 and 2.");
  return parsed;
}

export function parseOptionalDurationMs(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer number of milliseconds.`);
    return value;
  }
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new Error(`${name} must be a duration like 60000, 60s, or 5m.`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = amount * multiplier;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`${name} must resolve to a positive integer number of milliseconds.`);
  return ms;
}

export function normalizeTournamentExperimentRequest(body: unknown): NormalizedTournamentExperiment {
  const record = isRecord(body) ? body : {};
  const spec = record.spec ?? record;
  const overrides: Partial<TournamentExperimentSpecV1> = record.spec
    ? (removeUndefined({
        models: record.models,
        profiles: record.profiles,
        assignment: record.assignment as TournamentExperimentSpecV1["assignment"],
        seed: typeof record.seed === "string" ? record.seed : undefined,
        games: record.games,
        maxTransitions: record.maxTransitions ?? record.steps,
        jointPhaseScheduler: record.jointPhaseScheduler as TournamentExperimentSpecV1["jointPhaseScheduler"],
        timeout: record.timeoutMs ?? record.timeout,
        temperature: record.temperature,
        json: record.json as TournamentExperimentSpecV1["json"],
        continueOnError: record.continueOnError,
        config: record.config as TournamentExperimentSpecV1["config"]
      }) as Partial<TournamentExperimentSpecV1>)
    : {};
  return normalizeTournamentExperimentSpec(mergeExperimentOverrides(spec, overrides), {
    models: normalizeModelList(process.env.LLM_MODELS),
    profiles: process.env.AGENT_PROFILES,
    assignment: process.env.AGENT_ASSIGNMENT,
    games: 3,
    maxTransitions: process.env.MATCH_MAX_TRANSITIONS,
    jointPhaseScheduler: process.env.WEREWOLF_JOINT_PHASE_SCHEDULER as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: process.env.TOURNAMENT_TIMEOUT_MS,
    temperature: process.env.AGENT_TEMPERATURE ?? 0.7
  });
}

export function normalizeMatrixExperimentRequest(body: unknown): NormalizedMatrixExperiment {
  const record = isRecord(body) ? body : {};
  const specInput = record.spec ?? record;
  const overrides = removeUndefined({
    models: record.models,
    profiles: record.profiles,
    assignment: record.assignment as TournamentExperimentSpecV1["assignment"],
    seed: typeof record.seed === "string" ? record.seed : undefined,
    games: record.games,
    maxTransitions: record.maxTransitions ?? record.steps,
    jointPhaseScheduler: record.jointPhaseScheduler as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: record.timeoutMs ?? record.timeout,
    temperature: record.temperature,
    json: record.json as TournamentExperimentSpecV1["json"],
    continueOnError: record.continueOnError,
    config: record.config as TournamentExperimentSpecV1["config"]
  }) as Partial<TournamentExperimentSpecV1>;
  return normalizeMatrixExperimentSpec(mergeMatrixExperimentOverrides(specInput, overrides), {
    models: normalizeModelList(process.env.LLM_MODELS),
    profiles: process.env.AGENT_PROFILES,
    assignment: process.env.AGENT_ASSIGNMENT,
    games: 3,
    maxTransitions: process.env.MATCH_MAX_TRANSITIONS,
    jointPhaseScheduler: process.env.WEREWOLF_JOINT_PHASE_SCHEDULER as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: process.env.TOURNAMENT_TIMEOUT_MS,
    temperature: process.env.AGENT_TEMPERATURE ?? 0.7
  });
}

export function matrixExperimentTimeoutMs(experiment: NormalizedMatrixExperiment): number | undefined {
  const timeouts = experiment.cells.map((cell) => cell.tournament.timeoutMs);
  if (timeouts.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return undefined;
  return (timeouts as number[]).reduce((sum, value) => sum + value, 0);
}
