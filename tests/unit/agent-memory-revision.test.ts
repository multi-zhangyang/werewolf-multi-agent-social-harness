import { expect, it } from "vitest";
import { activeMemories, cognitionForPrompt, createAgentMind, enterEpisode, remember, reviseMemory } from "../../src/agents/cognition";
import { recallCognitiveMemories } from "../../src/agents/recall";
import { GeneralAgentContext } from "../../src/runtime/agent-context";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import type { WorldEvent } from "../../src/runtime/types";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkToolResult } from "../helpers/sdk-fixture";

const rule = { kind: "procedural" as const, scope: "transferable" as const, text: "对方总会兑现承诺", confidence: .95,
  when: "对方作出承诺", then: "立即提高投入", sourceIds: ["old-promise"], tags: ["互惠"] };
const replacement = { kind: "procedural" as const, scope: "transferable" as const, text: "承诺需要实际行为支持", confidence: .5,
  when: "承诺尚无兑现记录", then: "先核验行为再决定投入", tags: ["互惠"] };

it("revises a belief using counterevidence, keeps its prior versions, and retires it without deleting history", () => {
  const original = createAgentMind("self", "old"); const memory = remember(original, rule);
  const snapshot = JSON.stringify(original); const mind = enterEpisode(original, "self", "new");
  const revised = reviseMemory(mind, { id: memory.id, change: "revise", sourceIds: ["actual-breach"], reason: "实际返还为零，原来的绝对判断过强", replacement });
  expect(revised).toMatchObject({ id: memory.id, revision: 2, confidence: .5, sourceIds: ["actual-breach"], episode: "new", status: "active" });
  expect(revised.revisions?.[0].previous).toEqual(memory);
  expect(revised.revisions?.[0]).toMatchObject({ sourceIds: ["actual-breach"], episode: "new" });
  expect(JSON.stringify(cognitionForPrompt(mind))).not.toContain(rule.text);
  const retired = reviseMemory(mind, { id: memory.id, change: "retire", sourceIds: ["changed-rules"], reason: "新的规则使这条策略不再适用", replacement: null });
  expect(retired.revision).toBe(3); expect(retired.revisions).toHaveLength(2);
  expect(retired.revisions?.[1].previous).not.toHaveProperty("revisions");
  expect(mind.memories).toHaveLength(1); expect(activeMemories(mind)).toEqual([]);
  expect(recallCognitiveMemories(mind, "承诺互惠")).toEqual([]);
  expect(cognitionForPrompt(enterEpisode(mind, "self", "third")).memories).toEqual([]);
  expect(JSON.stringify(original)).toBe(snapshot);
});

it("rejects invalid revisions atomically and never rewrites an episode experience", () => {
  const mind = createAgentMind("self", "new"); const belief = remember(mind, rule);
  const episode = remember(mind, { ...rule, kind: "episodic", text: "账本记录实际返还为零", when: null, then: null });
  const local = remember(mind, { ...rule, kind: "semantic", scope: "episode" }); local.episode = "old";
  const before = JSON.stringify(mind);
  const change = { change: "revise" as const, sourceIds: ["counterevidence"], reason: "修订解释", replacement };
  expect(() => reviseMemory(mind, { ...change, id: episode.id })).toThrow("经历记录不可改写");
  expect(() => reviseMemory(mind, { ...change, id: local.id })).toThrow("当前可用");
  expect(() => reviseMemory(mind, { ...change, id: belief.id, replacement: { ...replacement, when: " " } })).toThrow("when 和 then");
  expect(() => reviseMemory(mind, { ...change, id: belief.id, change: "retire" })).toThrow("null");
  expect(JSON.stringify(mind)).toBe(before);
});

it("keeps an old local interpretation in research history without transferring its text in current memory input", () => {
  const mind = createAgentMind("self", "old");
  const memory = remember(mind, { ...rule, kind: "semantic", scope: "episode", text: "old-local-role-canary" });
  reviseMemory(mind, { id: memory.id, change: "revise", sourceIds: ["end-of-game"], reason: "改记可迁移经验", replacement });
  const next = enterEpisode(mind, "self", "new");
  expect(next.memories[0].revisions?.[0].previous.text).toBe("old-local-role-canary");
  expect(JSON.stringify(cognitionForPrompt(next))).not.toContain("old-local-role-canary");
});

it("hydrates retrieved evidence under actor visibility and gives the model exact usable source references", () => {
  const { context, spec } = generalContext(); context.cognition = createAgentMind("self", "r");
  remember(context.cognition, rule);
  remember(context.cognition, { ...rule, text: "另一条返还判断", sourceIds: ["foreign-secret"] });
  const source: WorldEvent = { id: "old-promise", runId: "old", seq: 1, at: "", type: "message", text: "对方曾经作出返还承诺", visibility: "public", data: {} };
  context.lookupEvidence = id => id === source.id ? source : { ...source, id, visibility: ["peer"], text: "foreign-source-canary" };
  const c = new GeneralAgentContext(context, spec, "r"); const input = JSON.parse(c.modelInput());
  const citation = input.evidence.find((event: WorldEvent) => event.text === source.text).id;
  expect(c.validateSources([citation])).toEqual([source.id]);
  expect(input.cognition.memories.find((memory: { text: string }) => memory.text === rule.text).sourceIds).toEqual([citation]);
  expect(JSON.stringify(input)).not.toContain("foreign-source-canary");
});

it("uses the official SDK revision receipt for the following action and commits the revised rule only once", async () => {
  const { context, spec, activations } = generalContext(); context.cognition = createAgentMind("self", "r");
  const memory = remember(context.cognition, rule); const before = JSON.stringify(context.cognition);
  const fixture = sdkFixture((request, index) => {
    expect(activations).toHaveLength(0);
    if (!index) return sdkCall("appraise_event", generalAppraisal("e1"));
    if (index === 1) return sdkCall("revise_memory", { id: "m1", change: "revise", sourceIds: ["e1"], reason: "根据新的可见结果降低把握", replacement });
    expect(sdkToolResult(request)).toMatchObject({ id: "m1", revision: 2, text: replacement.text, status: "active" });
    expect(sdkToolResult(request)).not.toHaveProperty("revisions");
    return sdkCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(activations).toHaveLength(1);
  expect(activations[0].cognition?.memories[0]).toMatchObject({ id: memory.id, sourceIds: ["visible"], revision: 2 });
  expect(activations[0].cognition?.memories[0].revisions?.[0].previous.text).toBe(rule.text);
  expect(JSON.stringify(context.cognition)).toBe(before);
});

it("discards a staged memory revision when the subsequent model request fails", async () => {
  const { context, spec, activations } = generalContext(); context.cognition = createAgentMind("self", "r");
  remember(context.cognition, rule); const before = JSON.stringify(context.cognition);
  const fixture = sdkFixture((_request, index) => {
    if (!index) return sdkCall("appraise_event", generalAppraisal("e1"));
    if (index === 1) return sdkCall("revise_memory", { id: "m1", change: "retire", sourceIds: ["e1"], reason: "新证据推翻旧判断", replacement: null });
    throw new Error("provider failed after the staged revision");
  });
  await expect(modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context)).rejects.toThrow("provider failed");
  expect(activations).toHaveLength(0); expect(JSON.stringify(context.cognition)).toBe(before);
});
