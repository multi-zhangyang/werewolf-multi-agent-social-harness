import {
  WEREWOLF_CLASSIC_9_SEAT_RULESET_ID,
  type GameConfig,
  type Role,
  type RoleDefinition,
  type Team,
  type WerewolfRulesetId
} from "./types";

/**
 * Domain-owned semantic registry.  Adding a different role/timing/victory
 * contract requires a distinct identifier and engine implementation; callers
 * may not relabel an unsupported record as the current classic adapter.
 */
export const SUPPORTED_WEREWOLF_RULESET_IDS = [WEREWOLF_CLASSIC_9_SEAT_RULESET_ID] as const;

export function isSupportedWerewolfRulesetId(value: unknown): value is WerewolfRulesetId {
  return value === WEREWOLF_CLASSIC_9_SEAT_RULESET_ID;
}

export function assertSupportedWerewolfRulesetId(value: unknown): asserts value is WerewolfRulesetId {
  if (!isSupportedWerewolfRulesetId(value)) {
    throw new Error(`Unsupported Werewolf ruleset: ${typeof value === "string" && value ? value : "<missing>"}.`);
  }
}

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  villager: {
    role: "villager",
    team: "village",
    displayName: "村民",
    nightOrder: null,
    objective: "通过发言、投票和复盘找出所有狼人。",
    abilitySummary: "没有夜间技能，依赖公开信息和投票逻辑。"
  },
  werewolf: {
    role: "werewolf",
    team: "werewolves",
    displayName: "狼人",
    nightOrder: 2,
    objective: "隐藏身份并让狼人阵营人数压制或消灭村民阵营。",
    abilitySummary: "夜晚共同选择击杀目标，白天通过伪装、切割和带票影响投票。"
  },
  seer: {
    role: "seer",
    team: "village",
    displayName: "预言家",
    nightOrder: 1,
    objective: "用查验结果建立可信信息链，帮助村民放逐狼人。",
    abilitySummary: "每晚查验一名玩家阵营。"
  },
  witch: {
    role: "witch",
    team: "village",
    displayName: "女巫",
    nightOrder: 3,
    objective: "用解药保关键好人，用毒药移除高置信狼人。",
    abilitySummary: "整局一次解药、一次毒药。"
  },
  hunter: {
    role: "hunter",
    team: "village",
    displayName: "猎人",
    nightOrder: null,
    objective: "用死亡后的开枪威慑狼人或带走高置信狼人。",
    abilitySummary: "死亡后可开枪带走一名玩家。"
  }
};

export const DEFAULT_CONFIG: GameConfig = {
  rulesetId: WEREWOLF_CLASSIC_9_SEAT_RULESET_ID,
  seats: 9,
  roles: ["werewolf", "werewolf", "villager", "villager", "villager", "villager", "seer", "witch", "hunter"],
  sheriff: "off",
  sheriffVoteWeight: 1.5,
  wolfDiscussion: "off",
  revealOnDeath: true,
  lastWords: "all",
  maxDays: 6,
  timers: {
    speechSeconds: 45,
    debateSeconds: 120,
    voteSeconds: 25,
    nightActionSeconds: 20
  }
};

const GAME_CONFIG_FIELDS = new Set([
  "rulesetId",
  "seats",
  "roles",
  "sheriff",
  "sheriffVoteWeight",
  "wolfDiscussion",
  "revealOnDeath",
  "lastWords",
  "maxDays",
  "timers"
]);
const TIMER_FIELDS = new Set(["speechSeconds", "debateSeconds", "voteSeconds", "nightActionSeconds"]);
const VALID_ROLES = new Set<Role>(["villager", "werewolf", "seer", "witch", "hunter"]);

/** Runtime parser for the current Werewolf ruleset. A ruleset id is useful
 * replay authority only if unknown enum/number/object values cannot silently
 * acquire accidental engine semantics. */
export function normalizeWerewolfGameConfig(input?: unknown): GameConfig {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new Error("Werewolf config must be an object.");
  }
  const source = (input ?? {}) as Record<string, unknown>;
  assertKnownFields(source, GAME_CONFIG_FIELDS, "Werewolf config");
  const timerInput = source.timers;
  if (timerInput !== undefined && (!timerInput || typeof timerInput !== "object" || Array.isArray(timerInput))) {
    throw new Error("Werewolf config timers must be an object.");
  }
  const timers = (timerInput ?? {}) as Record<string, unknown>;
  assertKnownFields(timers, TIMER_FIELDS, "Werewolf config timers");
  const roles = source.roles === undefined ? [...DEFAULT_CONFIG.roles] : normalizeRoles(source.roles);
  const config: GameConfig = {
    rulesetId: source.rulesetId === undefined ? DEFAULT_CONFIG.rulesetId : normalizeRulesetId(source.rulesetId),
    seats: source.seats === undefined ? DEFAULT_CONFIG.seats : positiveInteger(source.seats, "seats"),
    roles,
    sheriff: source.sheriff === undefined ? DEFAULT_CONFIG.sheriff : enumValue(source.sheriff, ["off", "day1"], "sheriff"),
    sheriffVoteWeight: source.sheriffVoteWeight === undefined
      ? DEFAULT_CONFIG.sheriffVoteWeight
      : positiveFinite(source.sheriffVoteWeight, "sheriffVoteWeight"),
    wolfDiscussion: source.wolfDiscussion === undefined
      ? DEFAULT_CONFIG.wolfDiscussion
      : enumValue(source.wolfDiscussion, ["off", "one_turn"], "wolfDiscussion"),
    revealOnDeath: source.revealOnDeath === undefined
      ? DEFAULT_CONFIG.revealOnDeath
      : booleanValue(source.revealOnDeath, "revealOnDeath"),
    lastWords: source.lastWords === undefined
      ? DEFAULT_CONFIG.lastWords
      : enumValue(source.lastWords, ["none", "firstNightOnly", "all"], "lastWords"),
    maxDays: source.maxDays === undefined ? DEFAULT_CONFIG.maxDays : positiveInteger(source.maxDays, "maxDays"),
    timers: {
      speechSeconds: timerValue(timers.speechSeconds, DEFAULT_CONFIG.timers.speechSeconds, "speechSeconds"),
      debateSeconds: timerValue(timers.debateSeconds, DEFAULT_CONFIG.timers.debateSeconds, "debateSeconds"),
      voteSeconds: timerValue(timers.voteSeconds, DEFAULT_CONFIG.timers.voteSeconds, "voteSeconds"),
      nightActionSeconds: timerValue(timers.nightActionSeconds, DEFAULT_CONFIG.timers.nightActionSeconds, "nightActionSeconds")
    }
  };
  if (config.roles.length !== config.seats) {
    throw new Error(`Role count (${config.roles.length}) must equal seat count (${config.seats}).`);
  }
  return config;
}

function normalizeRulesetId(value: unknown): WerewolfRulesetId {
  assertSupportedWerewolfRulesetId(value);
  return value;
}

function normalizeRoles(value: unknown): Role[] {
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string" || !VALID_ROLES.has(role as Role))) {
    throw new Error("Werewolf config roles must contain only supported role ids.");
  }
  return value.slice() as Role[];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Werewolf config ${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Werewolf config ${field} must be a boolean.`);
  return value;
}

function positiveFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Werewolf config ${field} must be a finite positive number.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Werewolf config ${field} must be a positive integer.`);
  }
  return value;
}

function timerValue(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Werewolf config timers.${field} must be a non-negative integer.`);
  }
  return value;
}

function assertKnownFields(record: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !fields.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(", ")}.`);
}

export function teamForRole(role: Role): Team {
  return ROLE_DEFINITIONS[role].team;
}
