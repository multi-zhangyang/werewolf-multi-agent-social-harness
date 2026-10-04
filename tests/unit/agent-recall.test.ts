import { expect, it } from "vitest";
import { createAgentMind, remember } from "../../src/agents/cognition";
import { rankRecall, recallCognitiveMemories } from "../../src/agents/recall";
import { GeneralAgentContext } from "../../src/runtime/agent-context";
import { generalContext } from "../helpers/general-agent-fixture";

it("retrieves an older Chinese conditional rule by words in its condition and consequent", () => {
  const mind = createAgentMind("self", "new");
  const rule = remember(mind, { kind: "procedural", scope: "transferable", text: "用小规模行动检验", sourceIds: ["visible-outcome"], confidence: .6,
    when: "对方没有兑现承诺", then: "等待实际补偿再增加投入", tags: ["合作"] });
  rule.episode = "past";
  for (let i = 0; i < 20; i++) remember(mind, { kind: "episodic", scope: "transferable", text: "对方更换了座位", sourceIds: [`seat-${i}`], confidence: 1, when: null, then: null, tags: [] });
  expect(recallCognitiveMemories(mind, "对方承诺没有兑现后如何补偿", 1).map(item => item.id)).toEqual([rule.id]);
});
it("does not retrieve a previous episode's hidden role or mutate remembered evidence", () => {
  const mind = createAgentMind("self", "old");
  remember(mind, { kind: "semantic", scope: "episode", text: "林默本局的隐藏身份是狼人", sourceIds: ["private-role"], confidence: .8, when: null, then: null, tags: ["角色"] });
  mind.episode = "next"; const before = JSON.stringify(mind);
  expect(recallCognitiveMemories(mind, "林默隐藏角色狼人")).toEqual([]);
  expect(JSON.stringify(mind)).toBe(before);
});
it("normalizes case and full-width characters while keeping returned evidence unchanged", () => {
  const rows = [{ id: "one", text: "TRUST depends on actual RETURN." }, { id: "two", text: "unrelated notes" }];
  expect(rankRecall(rows, "ｔｒｕｓｔ return", row => row.text)).toEqual([rows[0]]);
  expect(rankRecall(rows, "***", row => row.text)).toEqual([]);
});
it("places relevant older experience in the actual next decision input despite recent unrelated memories", () => {
  const { context, spec } = generalContext();
  context.cognition = createAgentMind("self", "r");
  const rule = remember(context.cognition, { kind: "procedural", scope: "transferable", text: "比较承诺和实际返还，再决定投资", sourceIds: ["past-feedback"], confidence: .6,
    when: "对方提出返还承诺", then: "根据实际兑现记录控制投资", tags: ["互惠"] });
  rule.episode = "past";
  for (let i = 0; i < 20; i++) remember(context.cognition, { kind: "episodic", scope: "transferable", text: `刚才调整了第${i}个座位`, sourceIds: [`seat-${i}`], confidence: 1, when: null, then: null, tags: [] });
  delete context.worldObservation; context.observation = "对方提出返还承诺，现在需要决定投资";
  const input = JSON.parse(new GeneralAgentContext(context, spec, "r").modelInput());
  expect(input.cognition.memories.some((memory: { text: string }) => memory.text === rule.text)).toBe(true);
  expect(input.cognition.memories).toHaveLength(16);
  expect(input.cognition.memories.some((memory: { text: string }) => memory.text === "刚才调整了第19个座位")).toBe(true);
});
