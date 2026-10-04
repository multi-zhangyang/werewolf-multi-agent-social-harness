import { expect, it } from "vitest";
import { appraise, cognitionForPrompt, createAgentMind, enterEpisode, finishEpisode, forecast, integrateExperience, remember, setPlan, updateOpponent, type Experience } from "../../src/agents/cognition";
import { generalAppraisal } from "../helpers/general-agent-fixture";

it("applies inertia once per evidence and keeps suppressed emotion available to decisions", () => {
  const mind = createAgentMind("arbitrary-actor", "first");
  const result = appraise(mind, { ...generalAppraisal("event"), emotions: [{ emotion: "anxiety", intensity: .8 }], needs: [{ need: "security", tension: .6 }], regulation: "suppress" });
  expect(result.emotions.anxiety).toBeCloseTo(.38); expect(result.emotions.anxiety).not.toBe(.8);
  expect(() => appraise(mind, { ...generalAppraisal("event"), emotions: [{ emotion: "anxiety", intensity: .8 }], needs: [], regulation: "none" })).toThrow("已评价");
  expect(mind.emotions.anxiety).toBeCloseTo(.38);
});
it("supports multiple uncertain relationships, portable plans and memories without transferring local identities", () => {
  const mind = createAgentMind("self-id", "trade");
  for (const [id, scope] of [["partner-id", "relationship"], ["hidden-role-id", "episode"]] as const) updateOpponent(mind, { targetId: id, sourceIds: ["fact"], willingness: .4, competence: .6, hypothesis: "可能愿意合作", alternative: "也可能只是短期利益", confidence: .45, scope });
  const plan = setPlan(mind, { id: null, sourceIds: ["fact"], goal: "先验证再增加暴露", strategy: "probe", steps: ["收集一次可核验反馈"], when: "对方意图未知", reviseWhen: "观察到行动", stopWhen: "代价超过收益", portable: true });
  remember(mind, { kind: "procedural", sourceIds: ["fact"], text: "先观察承诺与行为的差异", confidence: .5, tags: ["verification"], scope: "transferable", when: "合作意图不明", then: "用小规模行动检验" });
  remember(mind, { kind: "semantic", sourceIds: ["role"], text: "本局某人是狼人", confidence: .8, tags: ["role"], scope: "episode", when: null, then: null });
  const next = enterEpisode(mind, "self-id", "deduction");
  expect(next.relationships["partner-id"].alternative).toBeTruthy(); expect(next.relationships["hidden-role-id"]).toBeUndefined();
  expect(next.plans[0].id).toBe(plan.id); expect(cognitionForPrompt(next).memories).toHaveLength(1);
  expect(mind.episode).toBe("trade"); expect(() => enterEpisode(mind, "another", "deduction")).toThrow("其他人物");
});
it("preserves a relationship when an episode hypothesis about the same person changes", () => {
  const mind = createAgentMind("self", "deduction");
  const shared = { targetId: "peer", sourceIds: ["past-return"], willingness: .8, competence: .7, confidence: .6, alternative: "动机也可能是短期收益" };
  updateOpponent(mind, { ...shared, scope: "relationship", hypothesis: "曾经兑现返还，跨场景保留有限信任" });
  updateOpponent(mind, { ...shared, sourceIds: ["round-claim"], scope: "episode", hypothesis: "本局可能持有隐藏阵营身份" });
  const next = enterEpisode(mind, "self", "public-good");
  expect(next.relationships.peer?.hypothesis).toBe("曾经兑现返还，跨场景保留有限信任");
  expect(JSON.stringify(cognitionForPrompt(next))).not.toContain("本局可能持有隐藏阵营身份");
  expect(JSON.stringify(cognitionForPrompt(mind))).toContain("本局可能持有隐藏阵营身份");
});
it("reads a legacy local belief in its original episode without rewriting the snapshot", () => {
  const legacy = createAgentMind("self", "old"); legacy.version = "psychology-responses-v1"; delete legacy.episodeBeliefs;
  legacy.relationships.peer = { targetId: "peer", sourceIds: ["claim"], willingness: .4, competence: .6, hypothesis: "本局的角色猜测", alternative: "也可能只是谨慎", confidence: .5, scope: "episode", episode: "old", updates: 2 };
  const original = JSON.stringify(legacy);
  const same = enterEpisode(legacy, "self", "old");
  expect(same.version).toBe("psychology-responses-v14");
  expect(same.episodeBeliefs?.peer.hypothesis).toBe("本局的角色猜测");
  expect(same.relationships).toEqual({});
  expect(enterEpisode(same, "self", "new").episodeBeliefs).toEqual({});
  expect(JSON.stringify(legacy)).toBe(original);
});
it("scores only a future matching visible outcome once and expires unobserved predictions honestly", () => {
  const mind = createAgentMind("a", "r");
  forecast(mind, { sourceIds: ["prior"], targetId: "b", kind: "action", eventName: "return_funds", field: "amount", operator: "gte", expected: 5, probability: .8 }, 2);
  const event: Experience = { id: "outcome", episode: "r", seq: 3, round: 1, actorId: "b", kind: "action", name: "return_funds", data: { amount: 0 }, text: "实际返还 0" };
  integrateExperience(mind, { ...event, seq: 2 }); expect(mind.learning.scored).toBe(0);
  integrateExperience(mind, event); integrateExperience(mind, event);
  expect(mind.predictions[0]).toMatchObject({ result: false, sourceId: "outcome" }); expect(mind.learning.brierSum).toBeCloseTo(.64); expect(mind.learning.scored).toBe(1);
  forecast(mind, { sourceIds: ["outcome"], targetId: "b", kind: "action", eventName: "unobserved", field: "amount", operator: "gte", expected: 5, probability: .8 }, 3);
  finishEpisode(mind); expect(mind.predictions[1].expired).toBe(true); expect(mind.predictions[1].result).toBeUndefined();
});
it("learns from ledger feedback and transfers observed strategy statistics across episodes", () => {
  const mind = createAgentMind("self", "trade");
  mind.decisions.push({ id: "decision", episode: "trade", round: 1, action: "invest", strategy: "probe", intent: "none", privateAim: "检验合作", predictionIds: [] });
  const event: Experience = { id: "payoff", episode: "trade", seq: 2, round: 1, kind: "outcome", name: "settlement", text: "结算", data: {}, reward: { value: 3, normalized: .1, unit: "points" } };
  integrateExperience(mind, event); integrateExperience(mind, event); finishEpisode(mind);
  const next = enterEpisode(mind, "self", "public-good");
  expect(next.learning.strategies.probe).toMatchObject({ samples: 1, meanReturn: .1 });
  expect(next.learning.episodes).toEqual(["trade"]); expect(next.memories[0].sourceIds).toEqual(["payoff"]);
  expect(cognitionForPrompt(next).memories[0].text).toContain("不是策略优越性的证明");
});
it("scores a person's payoff from an authorless world settlement without matching the person as its speaker", () => {
  const mind = createAgentMind("self", "trade");
  forecast(mind, { sourceIds: ["prior"], targetId: "peer", kind: "outcome", eventName: "settlement", field: "payoffs.peer", operator: "gte", expected: 10, probability: .7 }, 1);
  integrateExperience(mind, { id: "settlement", episode: "trade", seq: 2, round: 1, kind: "outcome", name: "settlement", text: "真实结算", data: { payoffs: { peer: 7, self: 13 } } });
  expect(mind.predictions[0]).toMatchObject({ result: false, sourceId: "settlement" }); expect(mind.learning.scored).toBe(1);
  expect(mind.learning.brierSum).toBeCloseTo(.49);
});
