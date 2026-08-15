import type { ScenarioSummary } from "../contracts";

export const SCENARIO_METADATA: Record<ScenarioSummary["id"], ScenarioSummary> = {
  "prisoners-dilemma": {
    id: "prisoners-dilemma",
    name: "囚徒困境",
    shortDescription: "承诺没有约束力，行动会留下记忆。",
    description: "多回合谈判中，合作带来共同收益，背叛带来短期优势，也会重写双方的信任。",
    players: 2,
    defaultRounds: 6,
    minRounds: 2,
    maxRounds: 20,
    capabilities: ["公开谈判", "私人记忆", "同时行动", "关系变化"]
  },
  "public-goods": {
    id: "public-goods",
    name: "公共品博弈",
    shortDescription: "每个人都能搭便车，集体收益却取决于总投入。",
    description: "四名参与者决定把多少资源放入公共池；短期保留资源与长期群体信任持续冲突。",
    players: 4,
    defaultRounds: 5,
    minRounds: 2,
    maxRounds: 16,
    capabilities: ["群体谈判", "同时行动", "搭便车", "联盟记忆"]
  },
  "trust-game": {
    id: "trust-game",
    name: "信任博弈",
    shortDescription: "先交出选择权，再看对方如何处理你的信任。",
    description: "投资者把资源交给受托者，资源会增长；受托者决定返还多少，随后角色交换。",
    players: 2,
    defaultRounds: 5,
    minRounds: 2,
    maxRounds: 16,
    capabilities: ["角色交换", "承诺与兑现", "关系记忆", "分阶段行动"]
  },
  werewolf: {
    id: "werewolf",
    name: "狼人杀",
    shortDescription: "隐藏身份、公开发言与三方动机。",
    description: "狼人、村民、预言家与想被投票出局的小丑在白天发言和投票，夜晚用私密信息改变局势。",
    players: 6,
    defaultRounds: 4,
    minRounds: 2,
    maxRounds: 8,
    capabilities: ["隐藏身份", "多人讨论", "夜间私密行动", "第三阵营"]
  }
};

export const ALL_SCENARIOS = Object.values(SCENARIO_METADATA);
