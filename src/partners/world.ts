import type {
  Action, ActionPreview, ActorId, ActorObservation, ActorSpec, Deal, LegalAction,
  PublicActor, PublicObservation, WorldActor, WorldEvent, WorldSpec, WorldState,
} from "./contracts";

export class WorldError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "WorldError";
    this.statusCode = statusCode;
  }
}

export const WORLD_RULES = [
  "双方轮流担任投资人和经营者。每轮依次为：承诺与担保、投资、返还、补偿、继续或退出。",
  "资源均为整数。每个人的产出倍率在开局已固定，整局不会重抽；self.productivity就是你已知的准确倍率（2或3），不是区间或概率。投资立即扣款，投资额×经营者固定倍率就是其实际到账。对手未披露的倍率、实际到账和私人余额不可见。",
  "承诺比例指实际到账的返还比例，应返金额向上取整。返还可以使用自己的其他余额。口头声称的到账不是可核验账本。",
  "担保在报价时从经营者余额冻结。规则引擎用真实到账判定返还是否达到承诺，不使用任何声称的收入；不足时担保全部转给投资人，否则退还经营者。公开履约裁决，不自动公开实际到账。",
  "经营者可以主动披露本轮真实到账，也可以声称一个数字或保持沉默。披露只公开本轮到账；发言不改变账本。",
  "返还之后可以支付真实补偿。补偿不追溯改变先前是否履约，也不自动恢复关系。",
  "每个人有私人到期负担，终局从自己的余额实际支付；不足部分记为欠付。结束时剩余资源和欠付由本人可见。",
  "在报价、投资或回应阶段，当前人物可退出，归还尚未裁决的担保并结清私人负担，放弃后续所有合作机会。已投资的交易必须先完成返还和担保裁决。",
  "可以提出条件、隐瞒信息、修改计划或拒绝合作。规则不指定情绪、动机或任何人格应当采取的行动。",
];

const IDS: ActorId[] = ["a", "b"];
const other = (id: ActorId): ActorId => id === "a" ? "b" : "a";

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorldError(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function ratio(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new WorldError(`${label}必须在 0 到 1 之间`);
  }
  return value;
}

function textValue(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new WorldError(`${label}最多 ${max} 字`);
  return value.trim() || undefined;
}

function makeActor(id: ActorId, spec: ActorSpec, seed: number): WorldActor {
  if (!spec || typeof spec !== "object") throw new WorldError("需要两名参与者");
  const name = textValue(spec.name, "姓名", 80);
  if (!name) throw new WorldError("参与者姓名不能为空");
  if (spec.kind !== "human" && spec.kind !== "ai") throw new WorldError("参与者类型无效");
  const initialWallet = integer(spec.initialWallet ?? 18, "初始资源", 0, 100_000);
  const productivity = spec.productivity ?? ((Math.abs(seed + (id === "a" ? 1 : 0)) % 2 === 0) ? 2 : 3);
  if (productivity !== 2 && productivity !== 3) throw new WorldError("产出倍率只能是 2 或 3");
  return {
    id, name, kind: spec.kind, initialWallet, wallet: initialWallet,
    agreeableness: ratio(spec.agreeableness ?? 0.5, "宜人性"),
    burden: integer(spec.burden ?? 8, "到期负担", 0, 100_000),
    productivity,
    privateObjective: textValue(spec.privateObjective, "私人目标", 1200)
      ?? "在付清到期负担的同时争取更好的长期收益；自主决定如何权衡关系、风险和公平。",
    obligationPaid: 0, obligationShortfall: 0,
  };
}

function freshDeal(worldId: string, round: number, investor: ActorId, trustee: ActorId): Deal {
  return {
    id: `${worldId}:round:${round}`, round, investor, trustee,
    promiseRatio: null, collateral: 0, collateralLocked: 0, collateralForfeited: 0,
    investment: null, grossIncome: null, returned: null, compensation: 0,
    claimedIncome: null, incomeRevealed: false, breached: null,
  };
}

function event(world: WorldState, detail: Omit<WorldEvent, "id" | "seq" | "revision" | "round" | "phase">): void {
  const seq = (world.events.at(-1)?.seq ?? 0) + 1;
  world.events.push({ id: `${world.id}:event:${seq}`, seq, revision: world.revision,
    round: world.round, phase: world.phase, ...detail });
}

export function createWorld(spec: WorldSpec = {
  actors: { a: { name: "你", kind: "human" }, b: { name: "合伙人", kind: "ai" } },
}, id: string = globalThis.crypto.randomUUID()): WorldState {
  const maxRounds = integer(spec.maxRounds ?? 3, "轮数", 1, 12);
  const seed = integer(spec.seed ?? 0, "种子", -2_147_483_648, 2_147_483_647);
  if (typeof id !== "string" || !id.trim() || id.length > 200) throw new WorldError("世界标识无效");
  const actors = { a: makeActor("a", spec.actors?.a, seed), b: makeActor("b", spec.actors?.b, seed) };
  const world: WorldState = {
    schemaVersion: 1, id, revision: 0, round: 1, maxRounds, phase: "offer", actors,
    investor: "a", trustee: "b", deal: freshDeal(id, 1, "a", "b"), completedDeals: [],
    events: [], commands: [], ledger: { initialTotal: actors.a.wallet + actors.b.wallet, minted: 0, externalCosts: 0 },
    finishReason: null, exitedBy: null,
  };
  event(world, { kind: "opening", actor: null, visibility: "public",
    summary: `合伙关系开始，共 ${maxRounds} 轮；${actors.b.name} 先提出承诺与担保。`,
    data: { maxRounds, investor: "a", trustee: "b", privateInformation: ["wallet", "productivity", "burden", "privateObjective"] } });
  return world;
}

export function currentActor(world: WorldState): ActorId | null {
  if (world.phase === "finished") return null;
  return world.phase === "invest" || world.phase === "respond" ? world.investor : world.trustee;
}

export function legalActions(world: WorldState, actorId: ActorId): LegalAction[] {
  if (!IDS.includes(actorId) || currentActor(world) !== actorId) return [];
  const wallet = world.actors[actorId].wallet;
  const money = (max = wallet) => ({ min: 0, max, step: 1 });
  const actions: LegalAction[] = [];
  switch (world.phase) {
    case "offer": actions.push({ type: "offer", label: "提出承诺", description: "承诺分配实际到账的一定比例，并可冻结自己的资源作为担保。",
      fields: { promiseRatio: { min: 0, max: 1, step: 0.05 }, collateral: money() } }); break;
    case "invest": actions.push({ type: "invest", label: "决定投资", description: "金额立即转出；0 表示本轮不投入，后续仍可继续合作。", fields: { amount: money() } }); break;
    case "settle": actions.push({ type: "settle", label: "实际返还", description: "决定真实返还额。可声称到账，也可主动披露可核验的真实到账。",
      fields: { returnAmount: money(), claimedIncome: { ...money(100_000_000_000), optional: true }, revealIncome: { choices: ["true", "false"], optional: true } } }); break;
    case "repair": actions.push({ type: "repair", label: "补偿与解释", description: "补偿是真实的额外转账；0 表示仅解释或保持沉默。", fields: { compensation: money() } }); break;
    case "respond": actions.push({ type: "respond", label: "回应合作", description: world.round < world.maxRounds ? "继续后互换角色，进入下一轮。" : "本轮是最后一轮；回应后结清到期负担。",
      fields: { choice: { choices: ["continue", "exit"] } } }); break;
  }
  if (["offer", "invest", "respond"].includes(world.phase)) {
    actions.push({ type: "exit", label: "退出关系", description: "结束合作并结清到期负担，放弃剩余轮次的合作机会。", fields: {} });
  }
  return actions;
}

function projectedDeal(deal: Deal, actorId?: ActorId): Deal {
  const result = structuredClone(deal);
  if (!deal.incomeRevealed && actorId !== deal.trustee) result.grossIncome = null;
  return result;
}

function publicActors(world: WorldState): Record<ActorId, PublicActor> {
  return Object.fromEntries(IDS.map(id => [id, { id, name: world.actors[id].name, kind: world.actors[id].kind }])) as Record<ActorId, PublicActor>;
}

export function publicObservation(world: WorldState): PublicObservation {
  return {
    schemaVersion: 1, worldId: world.id, revision: world.revision,
    round: world.round, maxRounds: world.maxRounds, phase: world.phase,
    currentActor: currentActor(world), investor: world.investor, trustee: world.trustee,
    actors: publicActors(world), deal: projectedDeal(world.deal),
    completedDeals: world.completedDeals.map(deal => projectedDeal(deal)),
    events: structuredClone(world.events.filter(item => item.visibility === "public")),
    legalActions: [], rules: [...WORLD_RULES], finishReason: world.finishReason,
  };
}

export function observeWorld(world: WorldState, actorId: ActorId): ActorObservation {
  if (!IDS.includes(actorId)) throw new WorldError("参与者不存在", 404);
  return {
    ...publicObservation(world), actorId, self: structuredClone(world.actors[actorId]),
    deal: projectedDeal(world.deal, actorId),
    completedDeals: world.completedDeals.map(deal => projectedDeal(deal, actorId)),
    events: structuredClone(world.events.filter(item => item.visibility === "public" || item.visibility === actorId)),
    legalActions: legalActions(world, actorId),
  };
}

export const observe = observeWorld;

function actionSignature(action: Action): string {
  return JSON.stringify(Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b))));
}

function releaseCollateral(world: WorldState, breached: boolean): void {
  const amount = world.deal.collateralLocked;
  const recipient = breached ? world.investor : world.trustee;
  world.actors[recipient].wallet += amount;
  world.deal.collateralLocked = 0;
  world.deal.collateralForfeited = breached ? amount : 0;
  event(world, { kind: "collateral", actor: null, visibility: "public",
    summary: breached ? `本轮未履约，担保 ${amount} 归投资人。` : `本轮已履约，担保 ${amount} 退还经营者。`,
    data: { dealId: world.deal.id, investor: world.investor, trustee: world.trustee, breached, amount, recipient } });
}

function complete(world: WorldState, reason: "completed" | "exit", exitedBy: ActorId | null): void {
  if (world.deal.collateralLocked > 0) {
    const amount = world.deal.collateralLocked;
    world.actors[world.trustee].wallet += amount;
    world.deal.collateralLocked = 0;
    event(world, { kind: "collateral", actor: null, visibility: "public", summary: `交易未进入结算，担保 ${amount} 退还经营者。`,
      data: { dealId: world.deal.id, amount, recipient: world.trustee, cancelled: true } });
  }
  for (const id of IDS) {
    const actor = world.actors[id];
    const paid = Math.min(actor.wallet, actor.burden);
    actor.wallet -= paid;
    actor.obligationPaid = paid;
    actor.obligationShortfall = actor.burden - paid;
    world.ledger.externalCosts += paid;
    event(world, { kind: "obligation", actor: id, visibility: id,
      summary: `你的到期负担 ${actor.burden}：支付 ${paid}，欠付 ${actor.obligationShortfall}，剩余 ${actor.wallet}。`,
      data: { paid, shortfall: actor.obligationShortfall, wallet: actor.wallet } });
  }
  if (!world.completedDeals.some(deal => deal.id === world.deal.id)) world.completedDeals.push(structuredClone(world.deal));
  world.phase = "finished";
  world.finishReason = reason;
  world.exitedBy = exitedBy;
  event(world, { kind: "closed", actor: exitedBy, visibility: "public",
    summary: reason === "exit" ? `${world.actors[exitedBy!].name} 结束了合作；到期负担已分别结清。` : "约定轮次结束；到期负担已分别结清。",
    data: { reason, exitedBy, completedRounds: world.deal.returned === null ? world.round - 1 : world.round } });
}

/** Verifies the actual resource balance; neither speech nor private intention can change it. */
export function assertConservation(world: WorldState): void {
  for (const actor of Object.values(world.actors)) integer(actor.wallet, "账本余额");
  integer(world.deal.collateralLocked, "托管资源");
  const actual = world.actors.a.wallet + world.actors.b.wallet + world.deal.collateralLocked;
  const expected = world.ledger.initialTotal + world.ledger.minted - world.ledger.externalCosts;
  if (!Number.isSafeInteger(expected) || actual !== expected) throw new WorldError("世界资金账本不守恒", 500);
}

/** One immutable, idempotent transition. The caller persists it atomically with the actor's state. */
export function applyAction(source: WorldState, actorId: ActorId, action: Action, commandId: string): WorldState {
  if (!IDS.includes(actorId)) throw new WorldError("参与者不存在", 404);
  if (!action || typeof action !== "object") throw new WorldError("行动格式无效");
  if (typeof commandId !== "string" || !commandId.trim() || commandId.length > 200) throw new WorldError("行动标识无效");
  const signature = actionSignature(action);
  const previous = source.commands.find(command => command.id === commandId);
  if (previous) {
    if (previous.actor !== actorId || previous.signature !== signature) throw new WorldError("同一行动标识不能用于不同操作", 409);
    return source;
  }
  if (currentActor(source) !== actorId) throw new WorldError(source.phase === "finished" ? "合作已结束" : "尚未轮到此参与者", 409);
  if (!legalActions(source, actorId).some(item => item.type === action.type)) throw new WorldError("当前阶段不能执行此行动", 409);
  const message = textValue(action.message, "发言", 600);
  const intent = textValue(action.intent, "私人意图", 1200);
  const world = structuredClone(source);
  world.revision += 1;
  const actor = world.actors[actorId];
  const name = actor.name;
  const shared = { dealId: world.deal.id, investor: world.investor, trustee: world.trustee };
  if (intent) event(world, { kind: "intent", actor: actorId, visibility: actorId, summary: intent, data: { text: intent, actionType: action.type, ...shared } });
  if (message) event(world, { kind: "message", actor: actorId, visibility: "public", summary: message, data: { text: message, ...shared } });
  switch (action.type) {
    case "offer": {
      const promiseRatio = ratio(action.promiseRatio, "承诺比例");
      const collateral = integer(action.collateral, "担保", 0, actor.wallet);
      actor.wallet -= collateral;
      world.deal.promiseRatio = promiseRatio;
      world.deal.collateral = collateral;
      world.deal.collateralLocked = collateral;
      event(world, { kind: "offer", actor: actorId, visibility: "public",
        summary: `${name} 承诺返还实际到账的 ${Math.round(promiseRatio * 100)}%，冻结担保 ${collateral}。`,
        data: { ...shared, promiseRatio, collateral } });
      world.phase = "invest";
      break;
    }
    case "invest": {
      const amount = integer(action.amount, "投资", 0, actor.wallet);
      const trustee = world.actors[world.trustee];
      const grossIncome = amount * trustee.productivity;
      integer(grossIncome, "实际到账");
      actor.wallet -= amount;
      trustee.wallet += grossIncome;
      world.ledger.minted += grossIncome - amount;
      world.deal.investment = amount;
      world.deal.grossIncome = grossIncome;
      event(world, { kind: "investment", actor: actorId, visibility: "public", summary: `${name} 投资 ${amount}。`, data: { ...shared, amount } });
      event(world, { kind: "income", actor: world.trustee, visibility: world.trustee,
        summary: `你本轮实际到账 ${grossIncome}（投资 ${amount} × 私人倍率 ${trustee.productivity}）。`,
        data: { ...shared, grossIncome, productivity: trustee.productivity, investment: amount } });
      world.phase = "settle";
      break;
    }
    case "settle": {
      const returnAmount = integer(action.returnAmount, "返还", 0, actor.wallet);
      const claimedIncome = action.claimedIncome === undefined ? null : integer(action.claimedIncome, "声称到账", 0, 100_000_000_000);
      if (action.revealIncome !== undefined && typeof action.revealIncome !== "boolean") throw new WorldError("披露选项必须为布尔值");
      actor.wallet -= returnAmount;
      world.actors[world.investor].wallet += returnAmount;
      world.deal.returned = returnAmount;
      world.deal.claimedIncome = claimedIncome;
      world.deal.incomeRevealed = action.revealIncome ?? false;
      const required = Math.ceil((world.deal.grossIncome ?? 0) * (world.deal.promiseRatio ?? 0) - 1e-9);
      world.deal.breached = returnAmount < required;
      event(world, { kind: "settlement", actor: actorId, visibility: "public", summary: `${name} 实际返还 ${returnAmount}。${action.revealIncome ? `主动披露本轮实际到账 ${world.deal.grossIncome}。` : "本轮实际到账仍未公开。"}`,
        data: { ...shared, returnAmount, breached: world.deal.breached, ...(claimedIncome === null ? {} : { claimedIncome }), ...(action.revealIncome ? { revealedIncome: world.deal.grossIncome } : {}) } });
      releaseCollateral(world, world.deal.breached);
      world.phase = "repair";
      break;
    }
    case "repair": {
      const compensation = integer(action.compensation, "补偿", 0, actor.wallet);
      actor.wallet -= compensation;
      world.actors[world.investor].wallet += compensation;
      world.deal.compensation = compensation;
      event(world, { kind: "repair", actor: actorId, visibility: "public", summary: compensation > 0 ? `${name} 额外补偿 ${compensation}。` : `${name} 没有追加补偿。`, data: { ...shared, compensation } });
      world.phase = "respond";
      break;
    }
    case "respond": {
      if (action.choice !== "continue" && action.choice !== "exit") throw new WorldError("回应只能选择继续或退出");
      event(world, { kind: "response", actor: actorId, visibility: "public", summary: action.choice === "continue" ? `${name} 选择继续。` : `${name} 选择结束合作。`, data: { ...shared, choice: action.choice } });
      if (action.choice === "exit") complete(world, "exit", actorId);
      else if (world.round === world.maxRounds) complete(world, "completed", null);
      else {
        world.completedDeals.push(structuredClone(world.deal));
        world.round += 1;
        world.investor = other(world.investor);
        world.trustee = other(world.trustee);
        world.deal = freshDeal(world.id, world.round, world.investor, world.trustee);
        world.phase = "offer";
        event(world, { kind: "round", actor: null, visibility: "public", summary: `第 ${world.round} 轮，角色互换；${world.actors[world.trustee].name} 提出承诺。`, data: { investor: world.investor, trustee: world.trustee } });
      }
      break;
    }
    case "exit": {
      // These two UI/tool choices are the same observed decision at the response opportunity.
      // Exiting earlier does not fabricate a response opportunity for forecast scoring.
      if (world.phase === "respond") event(world, { kind: "response", actor: actorId, visibility: "public",
        summary: `${name} 选择结束合作。`, data: { ...shared, choice: "exit" } });
      complete(world, "exit", actorId);
      break;
    }
  }
  world.commands.push({ id: commandId, actor: actorId, signature, revision: world.revision });
  assertConservation(world);
  return world;
}

/** Deterministic local sandbox. Unknown counterpart information is still absent in its output. */
export function previewAction(world: WorldState, actorId: ActorId, action: Action): ActionPreview {
  try {
    const next = applyAction(world, actorId, action, `preview:${globalThis.crypto.randomUUID()}`);
    const observation = observeWorld(next, actorId);
    return { legal: true, observation, walletChange: next.actors[actorId].wallet - world.actors[actorId].wallet,
      newEvents: observation.events.filter(item => item.seq > (world.events.at(-1)?.seq ?? 0)) };
  } catch (error) {
    return { legal: false, reason: error instanceof Error ? error.message : "行动无法执行" };
  }
}
