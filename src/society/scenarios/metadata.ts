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
  "ultimatum-game": {
    id: "ultimatum-game",
    name: "最后通牒博弈",
    shortDescription: "分配权在手时，公平感决定收益是否归零。",
    description: "提议者提出 10 点资源的分配方案，回应者可以用拒绝惩罚不公平，也让自己一无所获；轮换角色后，立场反转。",
    players: 2,
    defaultRounds: 5,
    minRounds: 2,
    maxRounds: 16,
    capabilities: ["分配谈判", "角色轮换", "拒绝与惩罚", "关系记忆"]
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
  },
  "beauty-contest": {
    id: "beauty-contest",
    name: "选美博弈",
    shortDescription: "你以为大家在猜平均数，其实大家在猜你猜大家猜什么。",
    description: "每个人私下选择 0–100 的整数，最接近所有人平均值 2/3 的人获胜。考验高阶信念、策略推理与群体误判。",
    players: 3,
    defaultRounds: 5,
    minRounds: 2,
    maxRounds: 12,
    capabilities: ["高阶信念", "同时行动", "策略误导", "群体心理"]
  },
  "sealed-bid-auction": {
    id: "sealed-bid-auction",
    name: "密封拍卖",
    shortDescription: "私密估值、公开试探、次价结算。",
    description: "每个参与者持有私密估值，讨论后同时提交密封出价；最高价者获胜并支付次高价。考验策略误导、高阶信念与长期声誉。",
    players: 3,
    defaultRounds: 4,
    minRounds: 2,
    maxRounds: 10,
    capabilities: ["私密估值", "同时出价", "策略误导", "次价结算"]
  },
  avalon: {
    id: "avalon",
    name: "阿瓦隆",
    shortDescription: "忠臣与内奸混在圆桌边，任务成败只藏在一次举手之间。",
    description: "五名忠臣与两名内奸争夺三次任务。队长组队，全体表决，队员暗中决定任务成败；一旦任务全胜，刺客将用最后一剑赌上梅林的身份。",
    players: 6,
    defaultRounds: 4,
    minRounds: 2,
    maxRounds: 5,
    capabilities: ["隐藏阵营", "组队与表决", "暗中破坏", "最终刺杀"]
  },
  "centipede-game": {
    id: "centipede-game",
    name: "蜈蚣博弈",
    shortDescription: "罐子越传越大，谁先伸手拿走，谁就背叛了共同的未来。",
    description: "两人轮流决定拿走或传递不断翻倍的奖池。每一次传递都在积累信任，也把背叛的诱惑留给下一个人。",
    players: 2,
    defaultRounds: 6,
    minRounds: 2,
    maxRounds: 10,
    capabilities: ["轮流传递", "奖池翻倍", "信任与背叛", "后发制人"]
  },
  "chicken-game": {
    id: "chicken-game",
    name: "胆小鬼博弈",
    shortDescription: "谁也不先打方向盘，直到两辆车撞在一起。",
    description: "双方同时决定闪避还是硬冲：闪避者保住性命但丢面子，对冲者赢下一切，两人都不闪则两败俱伤。",
    players: 2,
    defaultRounds: 6,
    minRounds: 2,
    maxRounds: 12,
    capabilities: ["同时选择", "虚张声势", "面子博弈", "升级冲突"]
  },
  "stag-hunt": {
    id: "stag-hunt",
    name: "猎鹿博弈",
    shortDescription: "一起猎鹿收获最大，但任何一人转向兔子，另一个人就一无所获。",
    description: "两人同时选择合作猎鹿还是独自猎兔。猎鹿需要彼此托付，猎兔永远安全——信任的高收益与确定性之间永恒的对峙。",
    players: 2,
    defaultRounds: 6,
    minRounds: 2,
    maxRounds: 12,
    capabilities: ["同时选择", "协作承诺", "风险厌恶", "信任校准"]
  }
};

export const ALL_SCENARIOS = Object.values(SCENARIO_METADATA);
