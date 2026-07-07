import type { GameConfig, Role, RoleDefinition, Team } from "./types";

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
  seats: 9,
  roles: ["werewolf", "werewolf", "villager", "villager", "villager", "villager", "seer", "witch", "hunter"],
  sheriff: "off",
  sheriffVoteWeight: 1.5,
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

export function teamForRole(role: Role): Team {
  return ROLE_DEFINITIONS[role].team;
}
