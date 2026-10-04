import { activeMemories, isWorldDecision, type AgentMind, type Experience } from "./cognition";
import { payoffFeedback } from "./decision-analysis";

/** A ledger event is one observation even when several personal records cite it. */
export function buildExperienceEvidence(mind: AgentMind, events: readonly Experience[]) {
  const available = activeMemories(mind).filter(memory => memory.kind === "episodic");
  const outcomes = [...new Map(events.filter(event => event.kind === "outcome" && event.name === "settlement" && event.data.settlement === true)
    .map(event => [event.id, event])).values()].map(event => {
    const records = available.filter(memory => memory.sourceIds.includes(event.id));
    const environment = event.environment ?? records.find(memory => memory.origin === "ledger" && memory.observation?.sourceId === event.id)?.observation?.environment;
    return { sourceId: event.id, episode: event.episode, round: event.round, ...(environment ? { environment } : {}),
      ...(event.role ? { role: event.role } : {}), ...(event.reward ? { reward: { ...event.reward } } : {}),
      text: event.text, facts: structuredClone(event.data), memoryIds: records.map(memory => memory.id),
      actions: mind.decisions.filter(decision => decision.episode === event.episode && decision.feedbackId === event.id && isWorldDecision(decision))
        .map(({ id, action, round, parameters, payoffComparison, beliefSnapshot, beliefFeedback, expectedOwnPayoff, estimatedImmediateCost }) => ({ id, action, round, ...(parameters ? { parameters: structuredClone(parameters) } : {}),
          ...(beliefSnapshot ? { beliefSnapshot: structuredClone(beliefSnapshot), beliefFeedback, expectedOwnPayoff, estimatedImmediateCost } : {}),
          ...(payoffComparison && parameters && event.reward ? { payoffComparison: structuredClone(payoffComparison),
            payoffFeedback: payoffFeedback(payoffComparison, parameters, event.data, event.reward.value) } : {}) })),
      records: records.map(memory => ({ id: memory.id, origin: memory.origin ?? "legacy-unspecified", text: memory.text, confidence: memory.confidence })),
    };
  });
  const episodes = [...new Set(outcomes.map(outcome => outcome.episode))].map(episode => {
    const events = outcomes.filter(outcome => outcome.episode === episode);
    const counts = (names: string[]) => Object.fromEntries([...new Set(names)].map(name => [name, names.filter(item => item === name).length]));
    const rewards = events.flatMap(event => event.reward ?? []);
    return { episode, settlementCount: events.length, roundCount: new Set(events.map(event => event.round)).size,
      roleCounts: counts(events.flatMap(event => event.role ?? [])),
      actionCounts: counts(events.flatMap(event => event.actions.map(action => action.action))),
      returns: [...new Set(rewards.map(reward => reward.unit))].map(unit => {
        const samples = rewards.filter(reward => reward.unit === unit);
        return { unit, total: Math.round(samples.reduce((sum, reward) => sum + reward.value, 0) * 100) / 100, settlementCount: samples.length };
      }),
    };
  });
  return { distinctOutcomeCount: outcomes.length, recordCount: new Set(outcomes.flatMap(outcome => outcome.memoryIds)).size,
    episodeCount: episodes.length, episodes, outcomes,
    note: "按原始结算事件去重；多条笔记不是多次结算。facts 是当前本人可见的账本记录，records 是记录或个人解释。不同轮次也未必统计独立。先核对事实，再比较可复用关系与不能迁移的差异。" };
}
