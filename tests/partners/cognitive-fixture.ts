import { createSdkParticipant, type PartnerParticipant } from "../../src/partners/agent";
import type { Mechanism } from "../../src/partners/api-types";
import { observeWorld } from "../../src/partners/world";
import { ModelRegistry } from "../../src/society/models/registry";
import { fixtureDecision } from "./fixture";
import { appraisal, plan, sdkCall, sdkFixture, sdkInput } from "../helpers/sdk-fixture";

/** UI fixture only: choices are deterministic and never evidence of model behavior. */
export function cognitiveFixtureParticipant(mechanism: Mechanism = "full"): PartnerParticipant {
  return { configuration: { fixture: true }, async decide(input) {
    const observation = observeWorld(input.world, input.actorId); let predicted = false;
    const { model } = sdkFixture(request => {
      const data = sdkInput(request); const names = request.tools.flatMap(tool => tool.type === "function" ? [tool.name] : []);
      if (names.includes("appraise_event")) return sdkCall("appraise_event", appraisal(data.appraisalRequired?.event.id ?? observation.events.at(-1)!.id,
        { reason: "UI 夹具：评价可见事件并保留不同解释", emotions: { anger: 0.7, anxiety: 0.3, guilt: 0.05, hope: 0.5 }, regulation: "reappraise" }));
      if (names.includes("finish_record")) return sdkCall("finish_record", {});
      if (names.includes("create_plan")) return sdkCall("create_plan", { ...plan(observation.events.at(-1)!.id, observation.maxRounds), fromRound: observation.round });
      if (names.includes("forecast") && data.nextCounterpartOpportunity && !predicted) {
        predicted = true; const opportunity = data.nextCounterpartOpportunity;
        return sdkCall("forecast", { eventId: observation.events.at(-1)!.id, ...opportunity,
          threshold: opportunity.metric === "continue" ? 1 : opportunity.metric === "promiseRatio" ? 0.5 : 4, probability: 0.65 });
      }
      const { type, message, intent, ...action } = fixtureDecision(input).action;
      return sdkCall(type, { ...action, ...(type === "settle" ? { claimedIncome: null, revealIncome: true } : {}),
        message: `UI 夹具：${message ?? "继续观察合作"}`, intent: intent ?? "UI 夹具：验证状态流", basis: "one-off" });
    });
    const result = await createSdkParticipant(new ModelRegistry(), { model,
      psychology: mechanism === "record-only" ? "record-only" : mechanism === "no-mind" ? "off" : mechanism === "no-inertia" ? "no-inertia" : "hybrid" }).decide(input);
    result.decisionCase.configuration.fixture = true; return result;
  } };
}
