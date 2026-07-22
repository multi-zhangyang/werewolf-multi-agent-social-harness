import { describe, expect, it } from "vitest";
import type { ModelClient, ModelCompletionResult } from "../src/agents/modelClient";
import { applyCommand, createGame } from "../src/core/engine";
import { WerewolfAgentActor, applyWerewolfReasonerProposal } from "../src/harness/actor";
import { WerewolfEnvironment } from "../src/harness/environment";
import { policyForRole } from "../src/harness/policy";
import { OpenAIHarnessReasoner } from "../src/harness/reasoner";
import type { AgentHarnessState, HarnessPlayerView, PolicyPlan, ReasonerInput } from "../src/harness/types";

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

  it("rejects poison advice when the pending action has no poison authority", () => {
    const plan: PolicyPlan = {
      policyName: "witch-conservative",
      command: { type: "witch.act", actorId: "witch" },
      intent: "preserve resources",
      confidence: 0.7,
      strategyTags: []
    };
    const applied = applyWerewolfReasonerProposal(
      plan,
      {
        kind: "witch",
        phase: "night_witch",
        actorId: "witch",
        canSave: false,
        canPoison: false,
        legalPoisonTargetIds: ["p2"]
      },
      { commandType: "witch.act", poisonTargetId: "p2", confidence: 1 }
    );

    expect(applied).toBe(plan);
  });

  it("rejects false abstention advice without a legal vote target", () => {
    const plan: PolicyPlan = {
      policyName: "village-analyst",
      command: { type: "vote.cast", actorId: "voter", targetId: "p2" },
      intent: "vote from public evidence",
      confidence: 0.6,
      strategyTags: []
    };
    const applied = applyWerewolfReasonerProposal(
      plan,
      {
        kind: "vote",
        phase: "day_vote",
        actorId: "voter",
        legalTargetIds: ["p2", "p3"]
      },
      { commandType: "vote.cast", abstain: false, confidence: 1 }
    );

    expect(applied).toBe(plan);
  });

  it("rejects false abstention advice without a legal sheriff-vote target", () => {
    const plan: PolicyPlan = {
      policyName: "village-analyst",
      command: { type: "sheriff.vote", actorId: "voter", targetId: "p2" },
      intent: "vote for a sheriff candidate from public evidence",
      confidence: 0.6,
      strategyTags: []
    };
    const applied = applyWerewolfReasonerProposal(
      plan,
      {
        kind: "sheriff_vote",
        phase: "sheriff_vote",
        actorId: "voter",
        legalTargetIds: ["p2", "p3"]
      },
      { commandType: "sheriff.vote", abstain: false, confidence: 1 }
    );

    expect(applied).toBe(plan);
  });

  it("parses bounded social-intent drafts while keeping public speech as plain text", async () => {
    const { input } = createSeerInput();
    const targetIds = input.view.publicPlayers
      .map((player) => player.id)
      .filter((playerId) => playerId !== input.agent.playerId);
    const [targetId, allyId] = targetIds;
    if (!targetId || !allyId) throw new Error("Expected visible speech targets.");
    const speechInput: ReasonerInput = {
      ...input,
      view: { ...input.view, phase: "day_speech" },
      action: {
        kind: "speech",
        phase: "day_speech",
        actorId: input.agent.playerId,
        legalPressureTargetIds: targetIds
      },
      policyPlan: {
        ...input.policyPlan,
        command: {
          type: "speech.submit",
          actorId: input.agent.playerId,
          text: "policy placeholder"
        }
      }
    };
    const client: ModelClient = {
      async complete(): Promise<ModelCompletionResult> {
        return {
          content: [
            "我会先核对票型，再和后置位一起验证目标；如果证据不成立，我会公开修正。",
            `SOCIAL_ACTS: [{"kind":"commitment","targetId":"${targetId}","value":"在投票前公开复核证据","confidence":0.86},{"kind":"coalition_signal","targetId":"${targetId}","value":"共同核对票型","memberIds":["${allyId}"],"confidence":0.73}]`
          ].join("\n"),
          latencyMs: 9,
          usage: {},
          attempts: 1,
          stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
        };
      }
    };

    const output = await new OpenAIHarnessReasoner(client).think(speechInput);

    expect(output.content).toBe("我会先核对票型，再和后置位一起验证目标；如果证据不成立，我会公开修正。");
    expect(output.content).not.toContain("SOCIAL_ACTS");
    expect(output.actionProposal).toBeUndefined();
    expect(output.speechActDrafts).toEqual([
      {
        kind: "commitment",
        targetId,
        value: "在投票前公开复核证据",
        confidence: 0.86
      },
      {
        kind: "coalition_signal",
        targetId,
        value: "共同核对票型",
        memberIds: [allyId],
        confidence: 0.73
      }
    ]);
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
