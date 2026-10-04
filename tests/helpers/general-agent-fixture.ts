import type { ModelRequest } from "@openai/agents";
import { ModelRegistry } from "../../src/society/models/registry";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import { runSpecSchema, type Character, type StagedActivation, type TurnContext } from "../../src/runtime/types";
import { sdkCall, sdkFixture, sdkInput } from "./sdk-fixture";

export const characters: Character[] = ["self", "peer", "third", "fourth", "fifth", "sixth", "seventh", "eighth"].map((id, index) => ({ id, name: `人物${index + 1}`, persona: "依据所见作出选择", goals: ["达成自己的目标"], values: ["收益", "关系"], voice: "简短" }));
export const decisionMeta = { strategy: "cooperate", intent: "truthful", privateAim: "fixture-private-intent" };
export function generalAppraisal(id: string) { return { sourceIds: [id], interpretation: "先核对可见事实再判断", desirability: 0, control: .5, certainty: .5, responsibility: null,
  emotions: [{ emotion: "anxiety", intensity: .8 }], needs: [{ need: "security", tension: .6 }], regulation: "suppress" }; }
export function generalContext(psychology: "hybrid" | "off" = "hybrid") {
  const world = new EconomicScenario("trust-game", characters.slice(0, 2), 2); world.advance();
  const spec = runSpecSchema.parse({ scenario: "trust-game", roster: characters.slice(0, 2).map(c => ({ characterId: c.id })), experiment: { psychology }, budgets: { maxTurns: 8, discussionTurns: 2 } });
  const activations: StagedActivation[] = [];
  const context: TurnContext = { character: characters[0], opportunity: { id: "op", actorId: "self", stage: world.stage()!, actions: world.actions("self"), channel: "private", recipients: ["self"], communications: [] },
    observation: world.observe("self"), worldObservation: world.observation("self"), recent: [{ id: "visible", runId: "r", seq: 1, at: "", type: "fact", visibility: ["self"], text: "当前可见处境", data: { round: 1 } }], inbox: [], memories: [], signal: new AbortController().signal,
    call: async () => { throw new Error("Tools must not write the environment during the SDK run"); }, commitActivation: value => { activations.push(structuredClone(value)); } };
  return { world, spec, context, activations };
}
/** Deterministic SDK-loop fixture. Its choices are not evidence of live model behavior. */
export function generalFixture(extra?: (request: ModelRequest) => ReturnType<typeof sdkCall> | undefined) {
  const fixture = sdkFixture(request => {
    const data = sdkInput(request); const toolNames = request.tools.filter(t => t.type === "function").map(t => t.name);
    const called = Array.isArray(request.input) ? request.input.filter(i => i.type === "function_call").map(i => i.name) : [];
    if (data.appraisalRequired && !called.includes("appraise_event")) return sdkCall("appraise_event", generalAppraisal(data.newEvidenceIds.at(-1)));
    const additional = extra?.(request); if (additional) return additional;
    if (data.strategyLearning?.assessmentRequired && !called.includes("assess_strategy")) return sdkCall("assess_strategy", {
      id: data.strategyLearning.assessmentCandidateIds[0], sourceIds: [data.newEvidenceIds.at(-1) ?? data.evidence.at(-1).id], verdict: "reject",
      matching: "夹具只检查旧策略会在动作前接受检验", differences: "夹具不声称当前条件足以采用", adaptation: null });
    if (toolNames.includes("finish_episode_review")) return sdkCall("finish_episode_review", {
      sourceIds: [data.episodeReview.outcomes.at(-1).id], strategyIds: [], summary: "夹具仅验证复盘提交机制，不声称学会了可迁移策略" });
    if (toolNames.includes("finish_record")) return sdkCall("finish_record", {});
    const action = data.opportunity.actions.find((a: { name: string }) => toolNames.includes(a.name));
    if (action) {
      const args = Object.fromEntries(action.fields.map((field: { name: string; type: string; min: number; max: number; options?: Array<{ value: unknown }> }) => [field.name, field.type === "number" ? Math.min(field.max, 4) : field.options![0].value]));
      return sdkCall(action.name, { ...args, ...decisionMeta });
    }
    return sdkCall("speak", { text: "测试交流", ...decisionMeta });
  });
  return { ...fixture, factory: modelParticipantFactory(new ModelRegistry(), { model: fixture.model }) };
}
