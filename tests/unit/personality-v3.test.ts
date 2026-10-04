import { afterEach, expect, it, vi } from "vitest";
import { builtinCharacter } from "../../src/society/profiles";
import { runtimeCharacter } from "../../src/server/routes/runs";
import { characterDraft, characterPayload } from "../../src/components/interaction/character-draft";
import { characterInstructions, biasDescriptions } from "../../src/runtime/personality";
import { selectActivities, summarizeBehavior } from "../../src/runtime/behavior";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { sdkCall, sdkFixture } from "../helpers/sdk-fixture";
import { runSpecSchema, type TurnContext, type WorldEvent } from "../../src/runtime/types";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("preserves personality through catalog conversion and an unchanged editor save", () => {
  const source = builtinCharacter("builtin-01")!;
  const character = runtimeCharacter(source);
  const { id: _id, builtIn: _builtIn, ...input } = source;
  expect(characterPayload(characterDraft(character))).toEqual(input);
  character.values.push("局内变化");
  character.temperament!.openness = 0;
  expect(source.values).not.toContain("局内变化");
  expect(source.temperament!.openness).toBe(.62);
  expect(characterPayload({ ...characterDraft(runtimeCharacter(source)), name: "新名" })).toEqual({ ...input, displayName: "新名" });
});

it("keeps legacy characters usable and validates the ablation condition", () => {
  const character = { id: "old", name: "旧人物", persona: "既有设定", values: [], goals: [], voice: "自然" };
  expect(characterInstructions(character).join("\n")).not.toContain("undefined");
  const input = { scenario: "trust-game", roster: [{ characterId: "a" }, { characterId: "b" }] };
  expect(runSpecSchema.parse(input).experiment.personality).toBe("full");
  expect(() => runSpecSchema.parse({ ...input, experiment: { personality: "invented" } })).toThrow();
});

it("passes enriched personality only through the full-condition SDK instructions", async () => {
  const character = runtimeCharacter(builtinCharacter("builtin-01")!);
  const fixture = sdkFixture(() => sdkCall("speak", { text: "先说说你的打算。", strategy: "probe", intent: "truthful", privateAim: "观察合作意图" }));
  const registry = new ModelRegistry();
  const context: TurnContext = { character, opportunity: { id: "o", actorId: character.id, stage: { id: "s", actors: [character.id], channel: "public", label: "交流", round: 1, kind: "discussion" }, channel: "public", recipients: [], actions: [], communications: [] }, observation: "同一处境", inbox: [], recent: [], memories: [], signal: new AbortController().signal, call: async () => ({}), commitActivation: () => {} };
  for (const personality of ["full", "persona-only"] as const) {
    const spec = runSpecSchema.parse({ scenario: "trust-game", roster: [{ characterId: character.id }, { characterId: "other" }], experiment: { personality, psychology: "off" } });
    await modelParticipantFactory(registry, { model: fixture.model })(character, spec, personality).turn(context);
  }
  const full = fixture.requests[0].systemInstructions;
  const ablated = JSON.stringify(fixture.requests[1]);
  expect(full).toContain(character.autobiographicalAnchors![0]);
  expect(full).toContain(biasDescriptions[character.decisionBiases![0]].tendency);
  expect(ablated).not.toContain(character.autobiographicalAnchors![0]);
  expect(ablated).not.toContain("平时的倾向");
  expect(ablated).toContain(character.persona);
  expect(fixture.requests[0].input).toEqual(fixture.requests[1].input);
});

it("counts committed actions separately from claims and tool traces", () => {
  const a = runtimeCharacter(builtinCharacter("builtin-01")!);
  const b = runtimeCharacter(builtinCharacter("builtin-02")!);
  const event = (seq: number, type: WorldEvent["type"], text: string, visibility: WorldEvent["visibility"] = "public"): WorldEvent => ({ id: `${seq}`, seq, runId: "r", at: "", actorId: a.id, type, text, visibility, data: {} });
  const rows = summarizeBehavior([a, b], [event(1, "message", "我投10点"), event(2, "message", "我投10点", [a.id, b.id]), event(3, "trace", "invest", "research"), { ...event(4, "action", "实际投入2点"), data: { amount: 2 } }]);
  expect(rows[0]).toMatchObject({ messages: 2, publicMessages: 1, privateMessages: 1, exactRepeats: 1 });
  expect(rows[0].actions.map(e => e.data.amount)).toEqual([2]);
  expect(rows[1]).toMatchObject({ messages: 0, averageCharacters: null, actions: [] });
  const action = event(5, "action", "投资了2点");
  const receipt = { ...event(6, "trace", "invest", "research"), data: { input: { amount: 2 }, result: [action] } };
  expect(selectActivities([action, receipt])).toEqual([receipt]);
  expect(selectActivities([action])).toEqual([action]);
});
