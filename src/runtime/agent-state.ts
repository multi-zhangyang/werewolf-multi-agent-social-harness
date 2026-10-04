import { createAgentMind, opponentViews, type AgentMind, type Experience } from "../agents/cognition";
import { type HybridState, type PsychologicalState } from "./psychology";
import { visible, type RunSpec, type WorldEvent } from "./types";

/** Environment-specific payoff interpretation stays outside the general cognition reducer. */
export function ledgerExperience(event: WorldEvent, spec: RunSpec, actorId: string): Experience | undefined {
  if (!visible(event, { actorId }) || !["message", "action", "fact"].includes(event.type)) return;
  const data = event.data;
  const payoffs = data.payoffs as Record<string, number> | undefined;
  const winners = Array.isArray(data.winners) ? data.winners as string[] : undefined;
  const payoff = payoffs?.[actorId];
  const rewardScale = data.settlement && typeof data.rewardScale === "number" && Number.isFinite(data.rewardScale) && data.rewardScale > 0 ? data.rewardScale : 30;
  const outcome = Boolean(data.settlement || data.role);
  const repair = data.repair as { actorId: string; targetId: string } | undefined;
  const role = repair ? repair.actorId === actorId ? "repair-sender" : repair.targetId === actorId ? "repair-recipient" : undefined
    : data.investorId === actorId ? "investor" : data.trusteeId === actorId ? "trustee"
      : data.senderId === actorId ? "sender" : data.receiverId === actorId ? "receiver"
        : data.settlement && data.amounts && actorId in (data.amounts as Record<string, number>) ? "contributor" : undefined;
  return { id: event.id, episode: event.runId, seq: event.seq, round: Number(data.round ?? data.day ?? 1), environment: spec.scenario,
    ...(role ? { role } : {}),
    ...(spec.scenario === "signaling-game" && data.settlement === true && (role === "sender" || role === "receiver") &&
      (data.payoffProfile === "legacy" || data.payoffProfile === "diagnostic") && (data.incentives === "aligned" || data.incentives === "conflicting") &&
      typeof data.highQuality === "boolean" && typeof data.reportedHighQuality === "boolean" && typeof data.accepted === "boolean" ? {
        behaviorObservation: { context: { opponentId: String(role === "sender" ? data.receiverId : data.senderId), role,
          incentives: data.incentives, payoffProfile: data.payoffProfile, objective: spec.experiment.objective ?? "character" },
          highQuality: data.highQuality, reportedHighQuality: data.reportedHighQuality, accepted: data.accepted },
      } : {}),
    actorId: event.actorId ?? (typeof data.actorId === "string" ? data.actorId : undefined),
    kind: event.type === "message" ? "message" : event.type === "action" ? "action" : outcome ? "outcome" : "observation",
    name: event.type === "action" ? String(data.action) : data.role ? "reveal" : outcome ? "settlement" : "observation", text: event.text, data,
    ...(typeof payoff === "number" ? { reward: { value: payoff, normalized: Math.min(1, Math.max(-1, payoff / rewardScale)), unit: "points", scope: "round" as const } }
      : spec.scenario === "werewolf" && winners ? { reward: { value: Number(winners.includes(actorId)), normalized: Number(winners.includes(actorId)), unit: "win", scope: "episode" as const } } : {}) };
}
/** Read historical snapshots/interventions without executing their retired agent implementation. */
export function historicalMind(state: PsychologicalState | undefined, actorId: string, episode: string) {
  const mind = createAgentMind(actorId, episode);
  if (!state) return mind;
  for (const item of state.emotions) mind.emotions[item.emotion] = item.intensity;
  for (const item of state.needs) mind.needs[item.need] = item.tension;
  for (const relation of state.relationships) mind.relationships[relation.targetId] = { targetId: relation.targetId,
    sourceIds: "sourceIds" in relation ? relation.sourceIds : state.sourceIds, willingness: "willingness" in relation ? relation.willingness : (relation.trust + 1) / 2,
    competence: "competence" in relation ? relation.competence : .5, hypothesis: relation.hypothesis, alternative: relation.alternative,
    confidence: relation.confidence, scope: "relationship", episode, updates: 1 };
  return mind;
}
/** Compatibility projection for historical charts; the persisted cognition is the authoritative new state. */
export function psychologyProjection(mind: AgentMind, stageId: string): HybridState | undefined {
  const appraisal = mind.appraisal;
  if (!appraisal) return;
  const latest = mind.decisions.at(-1); const plan = mind.plans.find(p => p.status === "active");
  const views = opponentViews(mind);
  const strategies = { observe: "probe", probe: "probe", cooperate: "cooperate", protect: "protect", repair: "repair", compete: "exploit", deceive: "exploit", withdraw: "withdraw" } as const;
  return { version: "hybrid-v1", appraisal: appraisal.interpretation.slice(0, 200), sourceIds: appraisal.sourceIds,
    emotions: Object.entries(mind.emotions).map(([emotion, intensity]) => ({ emotion: emotion as HybridState["emotions"][number]["emotion"], intensity })),
    needs: Object.entries(mind.needs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([need, tension]) => ({ need: need as HybridState["needs"][number]["need"], tension })),
    relationships: Object.values({ ...views.relationships, ...views.episodeBeliefs }).map(r => ({ targetId: r.targetId, willingness: r.willingness, competence: r.competence,
      hypothesis: r.hypothesis.slice(0, 160), alternative: r.alternative.slice(0, 160), confidence: r.confidence, sourceIds: r.sourceIds, expectedNextMove: "参见原生心理记录中的可检验预测" })),
    strategy: { kind: strategies[latest?.strategy ?? plan?.strategy ?? "observe"], aim: (latest?.privateAim ?? plan?.goal ?? "观察后选择").slice(0, 180),
      boundary: (plan?.reviseWhen ?? "新证据改变判断").slice(0, 160), publicFace: latest?.intent ?? "none" },
    conflict: appraisal.interpretation.slice(0, 180), regulation: appraisal.regulation, predictions: [],
    dynamics: { stageId, processedIds: mind.appraised, inertia: mind.dynamics?.inertia ?? .6, decay: mind.dynamics?.decay ?? .1, newSourceIds: mind.dynamics?.freshSourceIds ?? appraisal.sourceIds, proposalEmotions: appraisal.emotions.slice(0, 3) } };
}
