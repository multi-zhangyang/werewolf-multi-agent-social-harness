import { isHybrid, psychologyFromEvent } from "./psychology";
import type { WorldEvent } from "./types";
import type { RunSpec } from "./types";
import type { HybridProposal } from "./psychology";
import type { Stage } from "./types";

export function predictionChoices(spec: RunSpec, actorId: string, stage: Stage) {
  if (spec.scenario !== "trust-game") return [];
  const phaseOrder = ["discussion", "pledge", "invest", "response", "return", "reflection", "repair", "after-repair"];
  const phase = phaseOrder.indexOf(stage.id.split(":")[1]);
  const choices: Array<Omit<HybridProposal["predictions"][number], "probability"> & { eventId: string }> = [];
  for (let round = stage.round; round <= spec.rounds; round++) for (let index = 0; index < spec.roster.length; index++) {
    const targetId = spec.roster[index].characterId; if (targetId === actorId) continue;
    const investor = index === (round - 1) % 2;
    const actions = investor ? ["invest"] as const : spec.trustProtocol === "pledge-repair" ? ["return_funds", "repair_transfer"] as const : ["return_funds"] as const;
    for (const action of actions) {
      const actionPhase = action === "invest" ? 2 : action === "return_funds" ? 4 : 6;
      if (round === stage.round && actionPhase < phase) continue;
      choices.push({ eventId: `${targetId}:${round}:${action}`, targetId, action, round, threshold: action === "invest" ? 5 : action === "return_funds" ? .5 : 1, unit: action === "return_funds" ? "received-share" : "points" });
    }
  }
  return choices;
}

export function validatePredictions(proposal: HybridProposal, spec: RunSpec, self: string, events: WorldEvent[]) {
  for (const p of proposal.predictions) {
    const target = spec.roster.findIndex(s => s.characterId === p.targetId);
    const investor = (p.round - 1) % 2;
    if (spec.scenario !== "trust-game" || target < 0 || p.targetId === self || p.round > spec.rounds || (p.action === "invest" ? target !== investor : target === investor) || p.unit === "received-share" && (p.action !== "return_funds" || p.threshold > 1)) throw new Error("预测须对应他人在合法轮次中的行动；返还比例阈值为0到1");
    if (events.some(e => e.type === "action" && e.actorId === p.targetId && e.data.action === p.action && e.data.round === p.round)) throw new Error("不能把已知行动作为未来预测");
  }
}

export function scorePredictions(events: WorldEvent[]) {
  return events.flatMap(source => {
    const mind = psychologyFromEvent(source);
    if (!mind || !isHybrid(mind)) return [];
    return mind.predictions.map((prediction, index) => {
      const outcome = events.find(e => e.seq > source.seq && e.type === "action" && e.actorId === prediction.targetId && e.data.action === prediction.action && e.data.round === prediction.round);
      let actual: number | undefined;
      if (outcome) {
        if (prediction.unit === "points") actual = Number(outcome.data.amount);
        else if (prediction.action === "return_funds") {
          const investment = events.find(e => e.seq < outcome.seq && e.type === "action" && e.data.action === "invest" && e.data.round === prediction.round);
          const received = Number(investment?.data.amount) * 3;
          if (received > 0) actual = Number(outcome.data.amount) / received;
        }
      }
      const hit = actual === undefined ? undefined : Number(actual >= prediction.threshold);
      return { id: `${source.id}:${index}`, sourceId: source.id, actorId: source.actorId, prediction, outcomeId: outcome?.id, actual, status: hit === undefined ? "unscored" : "scored", brier: hit === undefined ? undefined : (prediction.probability - hit) ** 2 };
    });
  });
}
