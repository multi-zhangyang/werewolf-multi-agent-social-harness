import type { Team, Role } from "../../core/types";
import type { HarnessAssignmentConfig, HarnessAssignmentStrategy } from "../../harness/profiles";
import type { HarnessAgentProfile, PolicyName } from "../../harness/types";

/**
 * A browser-side control-plane draft. It is deliberately not a resolved
 * assignment, game state, artifact, or source of Werewolf role truth.
 */
export interface CockpitExperimentDraft {
  profiles: HarnessAgentProfile[];
  assignment: HarnessAssignmentConfig;
}

/** The safe subset of a draft that the Cockpit may submit to the existing API. */
export interface CockpitExperimentRequest {
  models: string[];
  profiles: HarnessAgentProfile[];
  assignment: HarnessAssignmentConfig;
}

export const COCKPIT_ASSIGNMENT_STRATEGIES: HarnessAssignmentStrategy[] = [
  "profile-rotation",
  "seat",
  "role",
  "team"
];

export function createCockpitExperimentDraft(input: {
  defaultProfiles?: ReadonlyArray<HarnessAgentProfile>;
  models?: ReadonlyArray<string>;
  selectedModel?: string;
  temperature?: number;
} = {}): CockpitExperimentDraft {
  const profiles = input.defaultProfiles?.length
    ? input.defaultProfiles.map(cloneProfile)
    : [
        {
          id: "research-agent-1",
          model: input.selectedModel?.trim() || input.models?.find((model) => model.trim())?.trim() || "",
          temperature: input.temperature ?? 0.7
        }
      ];
  return {
    profiles,
    assignment: { strategy: "profile-rotation", fallback: "profile-rotation" }
  };
}

/**
 * Builds an explicit experiment request without leaking any resolved
 * role/seat assignment, state, artifact, winner, seed, or replay material
 * from the browser. The server remains the assignment and legality authority.
 */
export function buildCockpitExperimentRequest(draft: CockpitExperimentDraft): CockpitExperimentRequest {
  const profiles = draft.profiles.map(cloneProfile);
  return {
    models: distinctModels(profiles),
    profiles,
    assignment: cloneAssignment(draft.assignment)
  };
}

export function validateCockpitExperimentDraft(
  draft: CockpitExperimentDraft,
  availableModels: ReadonlyArray<string> = []
): string | undefined {
  if (!draft.profiles.length) return "至少需要一个 Agent profile。";
  const ids = new Set<string>();
  const allowedModels = new Set(availableModels.map((model) => model.trim()).filter(Boolean));
  for (const [index, profile] of draft.profiles.entries()) {
    const id = profile.id.trim();
    const model = profile.model.trim();
    if (!id) return `profile ${index + 1} 缺少 id。`;
    if (ids.has(id)) return `profile id ${id} 重复。`;
    ids.add(id);
    if (!model) return `profile ${id} 缺少模型。`;
    if (allowedModels.size && !allowedModels.has(model)) return `profile ${id} 使用了未在 /api/config 中公布的模型。`;
    if (profile.temperature !== undefined && (!Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2)) {
      return `profile ${id} 的 temperature 必须在 0 到 2 之间。`;
    }
  }
  return undefined;
}

function distinctModels(profiles: ReadonlyArray<HarnessAgentProfile>): string[] {
  return Array.from(new Set(profiles.map((profile) => profile.model.trim()).filter(Boolean)));
}

function cloneProfile(profile: HarnessAgentProfile): HarnessAgentProfile {
  return {
    id: profile.id.trim(),
    model: profile.model.trim(),
    ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
    ...(profile.policyName === undefined ? {} : { policyName: profile.policyName as PolicyName })
  };
}

function cloneAssignment(assignment: HarnessAssignmentConfig): HarnessAssignmentConfig {
  const strategy = COCKPIT_ASSIGNMENT_STRATEGIES.includes(assignment.strategy ?? "profile-rotation")
    ? assignment.strategy ?? "profile-rotation"
    : "profile-rotation";
  return {
    strategy,
    ...(assignment.fallback === "error" ? { fallback: "error" } : { fallback: "profile-rotation" }),
    ...(strategy === "seat" && assignment.seats ? { seats: cloneStringMap(assignment.seats) } : {}),
    ...(strategy === "role" && assignment.roles ? { roles: cloneRoleMap(assignment.roles) } : {}),
    ...(strategy === "team" && assignment.teams ? { teams: cloneTeamMap(assignment.teams) } : {})
  };
}

function cloneStringMap(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => key.trim() && value.trim()));
}

function cloneRoleMap(values: NonNullable<HarnessAssignmentConfig["roles"]>): Partial<Record<Role, string | string[]>> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => Boolean(key) && (typeof value === "string" ? value.trim() : Array.isArray(value) && value.length))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
  ) as Partial<Record<Role, string | string[]>>;
}

function cloneTeamMap(values: NonNullable<HarnessAssignmentConfig["teams"]>): Partial<Record<Team, string | string[]>> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => Boolean(key) && (typeof value === "string" ? value.trim() : Array.isArray(value) && value.length))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
  ) as Partial<Record<Team, string | string[]>>;
}
