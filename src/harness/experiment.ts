import type { GameConfig } from "../core/types";
import {
  assignmentFromUnknown,
  profilesFromUnknown,
  type HarnessAssignmentConfig
} from "./profiles";
import type { HarnessAgentProfile } from "./types";

export const TOURNAMENT_EXPERIMENT_VERSION = "werewolf.experiment.v1";

export interface TournamentExperimentSpecV1 {
  version?: typeof TOURNAMENT_EXPERIMENT_VERSION;
  id?: string;
  kind?: "tournament";
  seed?: string;
  models?: string[] | string;
  profiles?: HarnessAgentProfile[] | string;
  assignment?: HarnessAssignmentConfig | string;
  games?: number | string;
  maxTransitions?: number | string;
  timeout?: string | number;
  timeoutMs?: string | number;
  temperature?: number | string;
  json?: "summary" | "full";
  continueOnError?: boolean;
  config?: Partial<GameConfig> & { roles?: GameConfig["roles"] };
}

export interface NormalizedTournamentExperiment {
  version: typeof TOURNAMENT_EXPERIMENT_VERSION;
  id: string;
  kind: "tournament";
  seed: string;
  models: string[];
  profiles: HarnessAgentProfile[];
  assignment?: HarnessAssignmentConfig;
  games: number;
  maxTransitions?: number;
  timeoutMs?: number;
  temperature: number;
  json: "summary" | "full";
  continueOnError: boolean;
  config?: Partial<GameConfig> & { roles?: GameConfig["roles"] };
}

export function normalizeTournamentExperimentSpec(
  input: unknown,
  defaults: Partial<TournamentExperimentSpecV1> = {}
): NormalizedTournamentExperiment {
  const spec = input === undefined || input === null ? {} : input;
  if (!isRecord(spec)) throw new Error("Experiment spec must be an object.");
  const defaultRecord = defaults as Record<string, unknown>;
  const specRecord = spec as Record<string, unknown>;

  const version = stringField(specRecord, "version") ?? stringField(defaultRecord, "version") ?? TOURNAMENT_EXPERIMENT_VERSION;
  if (version !== TOURNAMENT_EXPERIMENT_VERSION) {
    throw new Error(`Experiment spec version must be ${TOURNAMENT_EXPERIMENT_VERSION}.`);
  }
  const kind = stringField(specRecord, "kind") ?? stringField(defaultRecord, "kind") ?? "tournament";
  if (kind !== "tournament") throw new Error("Experiment spec kind must be tournament.");
  const id = stringField(specRecord, "id") ?? stringField(defaultRecord, "id") ?? "tournament";
  const temperature = parseTemperature(specRecord.temperature ?? defaultRecord.temperature ?? 0.7);
  const profilesRaw = specRecord.profiles ?? defaultRecord.profiles;
  const modelsRaw = specRecord.models ?? (profilesRaw === undefined ? defaultRecord.models : undefined);
  const explicitModels = modelsFromUnknown(modelsRaw);
  const profiles = profilesFromUnknown(profilesRaw, explicitModels, temperature);
  const models = modelsFromProfiles(profiles);
  if (!models.length) throw new Error("Experiment spec requires at least one model or profile.");

  return {
    version: TOURNAMENT_EXPERIMENT_VERSION,
    id,
    kind: "tournament",
    seed: stringField(specRecord, "seed") ?? stringField(defaultRecord, "seed") ?? id,
    models,
    profiles,
    assignment: assignmentFromUnknown(specRecord.assignment ?? defaultRecord.assignment),
    games: parsePositiveInteger(specRecord.games ?? defaultRecord.games ?? 3, "games"),
    maxTransitions: parseOptionalNonNegativeInteger(specRecord.maxTransitions ?? defaultRecord.maxTransitions, "maxTransitions"),
    timeoutMs: parseOptionalDurationMs(specRecord.timeoutMs ?? specRecord.timeout ?? defaultRecord.timeoutMs ?? defaultRecord.timeout, "timeout"),
    temperature,
    json: parseJsonMode(specRecord.json ?? defaultRecord.json),
    continueOnError:
      typeof specRecord.continueOnError === "boolean"
        ? specRecord.continueOnError
        : typeof defaultRecord.continueOnError === "boolean"
          ? defaultRecord.continueOnError
          : true,
    config: isRecord(specRecord.config) ? cloneJson(specRecord.config) : isRecord(defaultRecord.config) ? cloneJson(defaultRecord.config) : undefined
  };
}

export function mergeExperimentOverrides(
  spec: unknown,
  overrides: Partial<TournamentExperimentSpecV1>
): TournamentExperimentSpecV1 {
  if (spec === undefined || spec === null) return { ...overrides };
  if (!isRecord(spec)) throw new Error("Experiment spec must be an object.");
  return {
    ...(cloneJson(spec) as TournamentExperimentSpecV1),
    ...removeUndefined(overrides)
  };
}

function modelsFromUnknown(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return splitModels(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
    return value.map((item) => item.trim());
  }
  throw new Error("Experiment models must be a comma/space separated string or string array.");
}

function modelsFromProfiles(profiles: HarnessAgentProfile[]): string[] {
  return Array.from(new Set(profiles.map((profile) => profile.model.trim()).filter(Boolean)));
}

function splitModels(value: string): string[] {
  return value
    .split(/[,\s/]+/)
    .map((model) => model.trim())
    .filter(Boolean);
}

function parseJsonMode(value: unknown): "summary" | "full" {
  if (value === undefined || value === null || value === "") return "summary";
  if (value === "summary" || value === "full") return value;
  throw new Error("Experiment json must be summary or full.");
}

function parseTemperature(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) throw new Error("temperature must be between 0 and 2.");
  return parsed;
}

function parsePositiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parsePositiveInteger(value, name);
}

function parseOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function parseOptionalDurationMs(value: unknown, name: string): number | undefined {
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
