/**
 * Werewolf role system (AGENTS.md §7.4) — grounded in the standard Chinese
 * werewolf boards researched for this project:
 *
 *  - 12-player classic 预女猎守 board: 3 small wolves + wolf king, seer, witch,
 *    hunter, guard, 4 villagers (wolf king takes one player when eliminated).
 *  - Standard player counts run 6-12; wolf counts follow the published tables
 *    (2 wolves at 6-8, 3 at 9-11, 4 at 12).
 *  - Witch holds one antidote and one poison, cannot save herself, cannot use
 *    both in the same night, and learns the wolf kill target while the
 *    antidote is unused.
 *  - Guard protects from the wolf kill only, cannot protect the same target
 *    on consecutive nights, and 同守同救 (guard + antidote on the same victim)
 *    still lets the victim die.
 *  - Hunter may shoot when eliminated, but a poisoned hunter cannot.
 *  - Jester is the third faction: voted out → solo win, and the game continues.
 *
 * A deck is a typed role list per player count; the room creator picks the
 * seat count and the world deals the matching deck. No role ability exists
 * only in prose — every ability has a tool, a phase and settlement logic.
 */

export type WerewolfRoleId =
  | "wolf"
  | "wolf-king"
  | "seer"
  | "witch"
  | "hunter"
  | "guard"
  | "jester"
  | "villager";

export type WerewolfFaction = "wolves" | "village" | "jester";

export interface WerewolfRoleDef {
  id: WerewolfRoleId;
  label: string;
  faction: WerewolfFaction;
  objective: string;
}

export const WEREWOLF_ROLES: Record<WerewolfRoleId, WerewolfRoleDef> = {
  wolf: {
    id: "wolf",
    label: "狼人",
    faction: "wolves",
    objective: "与狼队夜间协作淘汰好人，白天隐藏身份、转移怀疑，直到狼队控制投票。"
  },
  "wolf-king": {
    id: "wolf-king",
    label: "狼王",
    faction: "wolves",
    objective: "像狼人一样协作夜袭；若被投票放逐或被猎人击杀，可以开枪带走一名玩家（被毒杀不能开枪）。"
  },
  seer: {
    id: "seer",
    label: "预言家",
    faction: "village",
    objective: "每晚查验一名存活玩家的身份，引导村庄淘汰所有狼人，同时避免过早暴露。"
  },
  witch: {
    id: "witch",
    label: "女巫",
    faction: "village",
    objective: "用解药救回被狼人袭击的目标（不能自救），或用毒药带走一名可疑玩家；两瓶药各只能使用一次，且不能在同一晚使用。"
  },
  hunter: {
    id: "hunter",
    label: "猎人",
    faction: "village",
    objective: "帮助村庄找出狼人；被淘汰时可以开枪带走一名玩家（被毒杀不能开枪），也可以选择压枪。"
  },
  guard: {
    id: "guard",
    label: "守卫",
    faction: "village",
    objective: "每晚守护一名玩家免受狼人袭击；不能连续两晚守护同一人。守卫挡不住女巫的毒药。"
  },
  jester: {
    id: "jester",
    label: "小丑",
    faction: "jester",
    objective: "让自己在白天被投票出局。被投出即单独获胜并离场，游戏继续；被毒杀或夜间被杀不算成功。"
  },
  villager: {
    id: "villager",
    label: "村民",
    faction: "village",
    objective: "没有夜间能力，只能通过发言和投票找出并放逐所有狼人。"
  }
};

export interface WerewolfDeck {
  playerCount: number;
  name: string;
  description: string;
  roles: WerewolfRoleId[];
}

/**
 * Built-in deck templates (AGENTS.md §7.4). Wolf counts follow the standard
 * tables: 6-8P → 2 wolves, 9-10P → 3 wolves, 12P → 4 wolves (incl. wolf king).
 */
export const WEREWOLF_DECKS: WerewolfDeck[] = [
  {
    playerCount: 6,
    name: "6 人快速局",
    description: "双狼 · 预言家 · 女巫 · 双村民：入门节奏，两晚内见分晓。",
    roles: ["wolf", "wolf", "seer", "witch", "villager", "villager"]
  },
  {
    playerCount: 8,
    name: "8 人标准局",
    description: "双狼 · 预言家 · 女巫 · 猎人 · 小丑 · 双村民：加入猎人威慑与小丑搅局。",
    roles: ["wolf", "wolf", "seer", "witch", "hunter", "jester", "villager", "villager"]
  },
  {
    playerCount: 9,
    name: "9 人标准局",
    description: "三狼 · 预言家 · 女巫 · 猎人 · 守卫 · 双村民：预女猎守初步成型。",
    roles: ["wolf", "wolf", "wolf", "seer", "witch", "hunter", "guard", "villager", "villager"]
  },
  {
    playerCount: 10,
    name: "10 人进阶局",
    description: "三狼（含狼王）· 预言家 · 女巫 · 猎人 · 守卫 · 小丑 · 双村民：双枪与小丑同场。",
    roles: ["wolf", "wolf", "wolf-king", "seer", "witch", "hunter", "guard", "jester", "villager", "villager"]
  },
  {
    playerCount: 12,
    name: "12 人多能力局",
    description: "四狼（三小狼+狼王）· 预言家 · 女巫 · 猎人 · 守卫 · 小丑 · 三村民：经典预女猎守满配。",
    roles: ["wolf", "wolf", "wolf", "wolf-king", "seer", "witch", "hunter", "guard", "jester", "villager", "villager", "villager"]
  }
];

export function deckForPlayerCount(count: number): WerewolfDeck {
  const deck = WEREWOLF_DECKS.find((entry) => entry.playerCount === count);
  if (!deck) throw new Error(`PLAYER_COUNT_INVALID: Werewolf supports 6, 8, 9, 10 or 12 seats (${WEREWOLF_DECKS.map((entry) => entry.playerCount).join("/")}), got ${count}.`);
  return deck;
}

export function isWolfRole(role: WerewolfRoleId | undefined): boolean {
  return role === "wolf" || role === "wolf-king";
}

export function isVillageRole(role: WerewolfRoleId | undefined): boolean {
  return role === "seer" || role === "witch" || role === "hunter" || role === "guard" || role === "villager";
}

export function roleLabel(role: WerewolfRoleId | undefined): string {
  return role ? WEREWOLF_ROLES[role].label : "未知";
}
