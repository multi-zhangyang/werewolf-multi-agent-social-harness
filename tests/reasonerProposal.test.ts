import { describe, expect, it } from "vitest";
import type { ModelClient, ModelCompletionResult } from "../src/agents/modelClient";
import { applyCommand, createGame } from "../src/core/engine";
import { WerewolfAgentActor } from "../src/harness/actor";
import { WerewolfEnvironment } from "../src/harness/environment";
import { policyForRole } from "../src/harness/policy";
import { OpenAIHarnessReasoner } from "../src/harness/reasoner";
import type { AgentHarnessState, HarnessPlayerView, ReasonerInput } from "../src/harness/types";

describe("OpenAIHarnessReasoner advisory candidates", () => {
  it("uses one streaming cognition request and keeps the candidate advisory", async () => {
    const { actor, action, input } = createSeerInput();
    const alternateTarget = action.legalTargetIds.find((id) => id !== input.policyPlan.targetId) ?? action.legalTargetIds[0];
    if (!alternateTarget) throw new Error("Expected a legal seer target.");
    const requests: Parameters<ModelClient["complete"]>[0][] = [];
    const client: ModelClient = {
      async complete(request): Promise<ModelCompletionResult> {
        requests.push(request);
        return {
          content: [
            "当前公开信息不足，先记录验人结果并避免把私有结果写进公开叙事。",
            `ACTION_CANDIDATE: {"commandType":"seer.inspect","targetId":"${alternateTarget}","confidence":0.84,"rationale":"优先验证未被现有线索覆盖的座位"}`
          ].join("\n"),
          latencyMs: 7,
          usage: {},
          attempts: 1,
          stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
        };
      }
    };
    const reasoner = new OpenAIHarnessReasoner(client);

    const output = await reasoner.think(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: input.agent.model, stream: true });
    expect(requests[0].messages.map((message) => message.content).join("\n")).toContain("已检索记忆=#1/observation/environment/");
    expect(output.content).toContain("当前公开信息不足");
    expect(output.content).not.toContain("ACTION_CANDIDATE");
    expect(output.actionProposal).toMatchObject({ commandType: "seer.inspect", targetId: alternateTarget, confidence: 0.84 });

    const applied = actor.applyReasonerProposal(input.policyPlan, action, output.actionProposal);
    expect(applied).not.toBe(input.policyPlan);
    expect(applied.command).toMatchObject({ type: "seer.inspect", targetId: alternateTarget });
    expect(applied.strategyTags).toContain("reasoner-candidate");
  });

  it("keeps the policy plan when a streamed candidate is outside the pending legal set", () => {
    const { actor, action, input } = createSeerInput();
    const applied = actor.applyReasonerProposal(input.policyPlan, action, {
      commandType: "seer.inspect",
      targetId: "not-a-seat",
      confidence: 1,
      rationale: "invalid candidate must not escape policy arbitration"
    });

    expect(applied).toBe(input.policyPlan);
  });
});

function createSeerInput(): {
  actor: WerewolfAgentActor;
  action: Extract<ReturnType<WerewolfEnvironment["pendingActions"]>[number], { kind: "inspect" }>;
  input: ReasonerInput;
} {
  const initial = createGame({ id: "reasoner-proposal", seed: "reasoner-proposal" });
  const environment = new WerewolfEnvironment(applyCommand(initial, { type: "system.advance", actorId: "system" }));
  const action = environment.pendingActions().find((pending): pending is Extract<typeof pending, { kind: "inspect" }> => pending.kind === "inspect");
  if (!action) throw new Error("Expected seer inspection pending action.");
  const view = environment.observe(action.actorId, action);
  const state: AgentHarnessState = {
    playerId: action.actorId,
    model: "streaming-test-model",
    temperature: 0.2,
    policyName: policyForRole(view.you.role),
    turns: 0,
    observations: 0,
    beliefs: {},
    privateMemos: []
  };
  const actor = new WerewolfAgentActor(state);
  const harnessView: HarnessPlayerView = {
    ...view,
    social: { channels: [], messages: [] }
  };
  actor.observe(harnessView, { traceId: "reasoner-proposal:1", turnIndex: 1 });
  const policyPlan = actor.plan(action);
  const recalledMemory = actor.reasonerMemoryEntries(policyPlan.memoryRetrieval);
  return {
    actor,
    action,
    input: {
      traceId: "reasoner-proposal:1",
      view: harnessView,
      action,
      agent: {
        playerId: state.playerId,
        model: state.model,
        temperature: state.temperature,
        policyName: state.policyName,
        turns: state.turns,
        observations: state.observations,
        beliefs: state.beliefs,
        socialStateHash: state.socialStateHash
      },
      policyPlan,
      memoryRetrieval: policyPlan.memoryRetrieval,
      recalledMemory
    }
  };
}
