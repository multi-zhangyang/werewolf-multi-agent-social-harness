import type { Role, Team } from "../core/types";
import type { HarnessAgentConfig, HarnessAgentProfile, PolicyName } from "./types";

export type HarnessAssignmentStrategy = "profile-rotation" | "seat" | "role" | "team";

export interface HarnessAssignmentConfig {
  strategy?: HarnessAssignmentStrategy;
  seats?: Record<string, string>;
  roles?: Partial<Record<Role, string | string[]>>;
  teams?: Partial<Record<Team, string | string[]>>;
  fallback?: "profile-rotation" | "error";
}

export interface ResolvedAgentAssignment {
  playerId: string;
  seat: number;
  role?: Role;
  team?: Team;
  profileId?: string;
  model: string;
  temperature: number;
  policyName?: PolicyName;
}

export const POLICY_NAMES: PolicyName[] = [
  "balanced",
  "wolf-deceiver",
  "village-analyst",
  "seer-information",
  "witch-conservative",
  "hunter-punisher"
];

export function isPolicyName(value: unknown): value is PolicyName {
  return typeof value === "string" && POLICY_NAMES.includes(value as PolicyName);
}

export function profilesFromModels(models: string[], temperature: number): HarnessAgentProfile[] {
  return models.map((model, index) => ({
    id: profileIdFromModel(model, index),
    model,
    temperature
  }));
}

export function profilesFromUnknown(value: unknown, fallbackModels: string[], temperature: number): HarnessAgentProfile[] {
  const profiles =
    typeof value === "string" && value.trim()
      ? parseProfilesArgument(value, temperature)
      : Array.isArray(value)
        ? value.map((item, index) => normalizeProfileRecord(item, index, temperature))
        : profilesFromModels(fallbackModels, temperature);
  return assertUniqueProfileIds(profiles);
}

export function parseProfilesArgument(value: string, temperature: number): HarnessAgentProfile[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new Error("--profiles JSON must be an array.");
    return assertUniqueProfileIds(parsed.map((item, index) => normalizeProfileRecord(item, index, temperature)));
  }

  return assertUniqueProfileIds(
    trimmed.split(",").map((chunk, index) => {
      const [id, model, rawPolicyName, rawTemperature] = chunk.split(":").map((part) => part.trim());
      if (!id || !model) {
        throw new Error("--profiles entries must use id:model[:policyName[:temperature]].");
      }
      if (rawPolicyName && !isPolicyName(rawPolicyName)) {
        throw new Error(`Unknown policyName ${rawPolicyName}. Valid policies: ${POLICY_NAMES.join(", ")}.`);
      }
      const policyName: PolicyName | undefined = rawPolicyName ? (rawPolicyName as PolicyName) : undefined;
      return {
        id,
        model,
        policyName,
        temperature: rawTemperature ? parseTemperature(rawTemperature, `profiles[${index}].temperature`) : temperature
      };
    })
  );
}

export function buildProfileBalancedAgents(
  players: Array<{ id: string; seat: number }>,
  profiles: HarnessAgentProfile[],
  episodeIndex: number,
  defaultTemperature: number
): HarnessAgentConfig[] {
  return resolveAgentConfigs(players, profiles, episodeIndex, defaultTemperature, { strategy: "profile-rotation" });
}

export function resolveAgentConfigs(
  players: Array<{ id: string; seat: number; role?: Role; team?: Team }>,
  profiles: HarnessAgentProfile[],
  episodeIndex: number,
  defaultTemperature: number,
  assignment: HarnessAssignmentConfig = { strategy: "profile-rotation" }
): HarnessAgentConfig[] {
  if (!profiles.length) throw new Error("At least one Agent profile is required.");
  assertUniquePlayers(players);
  assertUniqueProfileIds(profiles);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const sorted = players.slice().sort((a, b) => a.seat - b.seat);
  const roleCounts: Partial<Record<Role, number>> = {};
  const teamCounts: Partial<Record<Team, number>> = {};

  return sorted.map((player, seatIndex) => {
    const profile =
      profileForSeat(player, profileById, assignment) ??
      profileForRole(player, profileById, assignment, roleCounts, episodeIndex) ??
      profileForTeam(player, profileById, assignment, teamCounts, episodeIndex) ??
      fallbackProfile(profiles, seatIndex, episodeIndex, assignment);
    if (!profile) {
      throw new Error(`No Agent profile assignment for player ${player.id} seat ${player.seat}.`);
    }
    return agentConfigForProfile(player.id, profile, defaultTemperature);
  });
}

export function describeResolvedAssignments(
  players: Array<{ id: string; seat: number; role?: Role; team?: Team }>,
  agents: HarnessAgentConfig[]
): ResolvedAgentAssignment[] {
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));
  return players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((player) => {
      const agent = agentByPlayer.get(player.id);
      if (!agent) throw new Error(`No resolved Agent assignment for player ${player.id}.`);
      return {
        playerId: player.id,
        seat: player.seat,
        role: player.role,
        team: player.team,
        profileId: agent.profileId,
        model: agent.model,
        temperature: agent.temperature,
        policyName: agent.policyName
      };
    });
}

export function assignmentFromUnknown(value: unknown): HarnessAssignmentConfig | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return normalizeAssignment(JSON.parse(trimmed));
  }
  return normalizeAssignment(value);
}

export function assignmentProfileReferences(assignment: HarnessAssignmentConfig | undefined): string[] {
  if (!assignment) return [];
  return [
    ...Object.values(assignment.seats ?? {}),
    ...Object.values(assignment.roles ?? {}).flatMap(profileReferenceList),
    ...Object.values(assignment.teams ?? {}).flatMap(profileReferenceList)
  ].filter(Boolean);
}

export function assertAssignmentProfileReferences(
  assignment: HarnessAssignmentConfig | undefined,
  profiles: HarnessAgentProfile[]
): void {
  const profileIds = new Set(profiles.map((profile) => profile.id.trim()).filter(Boolean));
  const unknownReferences = Array.from(new Set(assignmentProfileReferences(assignment).filter((profileId) => !profileIds.has(profileId))));
  if (unknownReferences.length) {
    throw new Error(`Agent assignment references unknown profile id(s): ${unknownReferences.join(", ")}.`);
  }
}

function profileForSeat(
  player: { seat: number },
  profileById: Map<string, HarnessAgentProfile>,
  assignment: HarnessAssignmentConfig
): HarnessAgentProfile | undefined {
  if (assignment.strategy !== "seat") return undefined;
  const profileId = assignment.seats?.[String(player.seat)];
  if (!profileId) return undefined;
  return requireProfile(profileById, profileId, `seat ${player.seat}`);
}

function profileForRole(
  player: { role?: Role },
  profileById: Map<string, HarnessAgentProfile>,
  assignment: HarnessAssignmentConfig,
  counts: Partial<Record<Role, number>>,
  episodeIndex: number
): HarnessAgentProfile | undefined {
  if (assignment.strategy !== "role" || !player.role) return undefined;
  const value = assignment.roles?.[player.role];
  if (!value) return undefined;
  counts[player.role] = (counts[player.role] ?? 0) + 1;
  return requireProfile(profileById, chooseProfileId(value, counts[player.role]! - 1, episodeIndex), `role ${player.role}`);
}

function profileForTeam(
  player: { team?: Team },
  profileById: Map<string, HarnessAgentProfile>,
  assignment: HarnessAssignmentConfig,
  counts: Partial<Record<Team, number>>,
  episodeIndex: number
): HarnessAgentProfile | undefined {
  if (assignment.strategy !== "team" || !player.team) return undefined;
  const value = assignment.teams?.[player.team];
  if (!value) return undefined;
  counts[player.team] = (counts[player.team] ?? 0) + 1;
  return requireProfile(profileById, chooseProfileId(value, counts[player.team]! - 1, episodeIndex), `team ${player.team}`);
}

function fallbackProfile(
  profiles: HarnessAgentProfile[],
  seatIndex: number,
  episodeIndex: number,
  assignment: HarnessAssignmentConfig
): HarnessAgentProfile | undefined {
  if (assignment.strategy === "profile-rotation") {
    return profiles[(seatIndex + episodeIndex) % profiles.length];
  }
  // Unmatched explicit seat/role/team assignments fail closed by default.
  // Profile rotation remains a primary strategy, and is available as an
  // explicit legacy fallback, but must never silently replace a missing
  // production assignment.
  if ((assignment.fallback ?? "error") === "error") return undefined;
  return profiles[(seatIndex + episodeIndex) % profiles.length];
}

function chooseProfileId(value: string | string[], localIndex: number, episodeIndex: number): string {
  if (typeof value === "string") return value;
  if (!value.length) throw new Error("Profile assignment array cannot be empty.");
  return value[(localIndex + episodeIndex) % value.length];
}

function profileReferenceList(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function requireProfile(profileById: Map<string, HarnessAgentProfile>, profileId: string, source: string): HarnessAgentProfile {
  const profile = profileById.get(profileId);
  if (!profile) throw new Error(`Assignment for ${source} references unknown profile ${profileId}.`);
  return profile;
}

function agentConfigForProfile(playerId: string, profile: HarnessAgentProfile, defaultTemperature: number): HarnessAgentConfig {
  return {
    playerId,
    profileId: profile.id,
    model: profile.model,
    temperature: profile.temperature ?? defaultTemperature,
    policyName: profile.policyName
  };
}

function normalizeAssignment(value: unknown): HarnessAssignmentConfig {
  if (!isRecord(value)) throw new Error("assignment must be an object.");
  const strategy = value.strategy ?? "profile-rotation";
  if (strategy !== "profile-rotation" && strategy !== "seat" && strategy !== "role" && strategy !== "team") {
    throw new Error("assignment.strategy must be profile-rotation, seat, role, or team.");
  }
  const fallback = value.fallback ?? "error";
  if (fallback !== "profile-rotation" && fallback !== "error") {
    throw new Error("assignment.fallback must be profile-rotation or error.");
  }
  return {
    strategy,
    seats: isRecord(value.seats) ? normalizeStringRecord(value.seats, "assignment.seats") : undefined,
    roles: isRecord(value.roles) ? normalizeAssignmentMap<Role>(value.roles, "assignment.roles", VALID_ROLES) : undefined,
    teams: isRecord(value.teams) ? normalizeAssignmentMap<Team>(value.teams, "assignment.teams", VALID_TEAMS) : undefined,
    fallback
  };
}

function normalizeStringRecord(record: Record<string, unknown>, field: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (typeof value !== "string" || !value.trim()) throw new Error(`${field}.${key} must be a profile id string.`);
      return [key, value.trim()];
    })
  );
}

function normalizeAssignmentMap<K extends string>(
  record: Record<string, unknown>,
  field: string,
  validKeys: readonly K[]
): Partial<Record<K, string | string[]>> {
  const normalized: Partial<Record<K, string | string[]>> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!validKeys.includes(key as K)) {
      throw new Error(`${field}.${key} is not supported. Valid keys: ${validKeys.join(", ")}.`);
    }
    if (typeof value === "string" && value.trim()) {
      normalized[key as K] = value.trim();
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
      normalized[key as K] = value.map((item) => item.trim());
    } else {
      throw new Error(`${field}.${key} must be a profile id string or string array.`);
    }
  }
  return normalized;
}

function normalizeProfileRecord(value: unknown, index: number, temperature: number): HarnessAgentProfile {
  if (!isRecord(value)) throw new Error(`profiles[${index}] must be an object.`);
  const id = stringField(value, "id") ?? profileIdFromModel(stringField(value, "model") ?? "", index);
  const model = stringField(value, "model");
  if (!model) throw new Error(`profiles[${index}].model is required.`);
  const policyName = value.policyName;
  if (policyName !== undefined && !isPolicyName(policyName)) {
    throw new Error(`profiles[${index}].policyName must be one of: ${POLICY_NAMES.join(", ")}.`);
  }
  return {
    id,
    model,
    policyName,
    temperature:
      value.temperature === undefined ? temperature : parseTemperature(String(value.temperature), `profiles[${index}].temperature`)
  };
}

function assertUniqueProfileIds(profiles: HarnessAgentProfile[]): HarnessAgentProfile[] {
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id.trim()) throw new Error("Agent profile id cannot be empty.");
    if (seen.has(profile.id)) throw new Error(`Duplicate Agent profile id ${profile.id}.`);
    seen.add(profile.id);
  }
  return profiles;
}

function assertUniquePlayers(players: Array<{ id: string; seat: number }>): void {
  const ids = new Set<string>();
  const seats = new Set<number>();
  for (const player of players) {
    if (!player.id.trim()) throw new Error("Player id cannot be empty.");
    if (ids.has(player.id)) throw new Error(`Duplicate player id ${player.id}.`);
    ids.add(player.id);
    if (seats.has(player.seat)) throw new Error(`Duplicate player seat ${player.seat}.`);
    seats.add(player.seat);
  }
}

function parseTemperature(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error(`${field} must be a number between 0 and 2.`);
  }
  return parsed;
}

function profileIdFromModel(model: string, index: number): string {
  const sanitized = model.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized ? `${sanitized}-${index + 1}` : `profile-${index + 1}`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_ROLES: readonly Role[] = ["villager", "werewolf", "seer", "witch", "hunter"];
const VALID_TEAMS: readonly Team[] = ["village", "werewolves"];
