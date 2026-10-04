import { expect, it } from "vitest";
import { createAgentMind, integrateExperience, type PrivateDecision } from "../../src/agents/cognition";
import { ledgerExperience } from "../../src/runtime/agent-state";
import { runSpecSchema, type WorldEvent } from "../../src/runtime/types";

function decision(id: string, round: number, action: string): PrivateDecision {
  return { id, episode: "run", round, action, parameters: { amount: 0 }, strategy: "cooperate", intent: "truthful", privateAim: "检查真实反馈", predictionIds: [] };
}
it("does not credit a prior-round action to a later round when its own outcome is missing", () => {
  const mind = createAgentMind("self", "run");
  mind.decisions.push(decision("old-repair", 1, "repair_transfer"), decision("new-investment", 2, "invest"));
  integrateExperience(mind, { id: "second-outcome", episode: "run", seq: 20, round: 2, kind: "outcome", name: "settlement", text: "第二轮实际所得", data: { settlement: true }, reward: { value: 15, normalized: .5, unit: "points" } });
  expect(mind.decisions[0].feedbackId).toBeUndefined();
  expect(mind.decisions[1].feedbackId).toBe("second-outcome");
  expect(mind.memories[0].observation?.actions.map(action => action.id)).toEqual(["new-investment"]);
  expect(mind.memories[0].text).not.toContain("repair_transfer");
});
it("keeps terminal episode feedback across days while retaining each action's actual day", () => {
  const mind = createAgentMind("self", "run");
  mind.decisions.push(decision("day-one-vote", 1, "vote"), decision("day-two-vote", 2, "vote"));
  const spec = runSpecSchema.parse({ scenario: "werewolf", roster: ["self", "peer", "third", "fourth", "fifth", "sixth"].map(characterId => ({ characterId })) });
  const event: WorldEvent = { id: "final", runId: "run", seq: 99, at: "", type: "fact", visibility: "public", text: "村庄获胜", data: { day: 2, settlement: true, winners: ["self"] } };
  const experience = ledgerExperience(event, spec, "self")!;
  expect(experience.reward).toMatchObject({ value: 1, scope: "episode" });
  integrateExperience(mind, experience);
  expect(mind.decisions.map(item => item.feedbackId)).toEqual(["final", "final"]);
  expect(mind.memories[0].observation?.actions.map(action => action.round)).toEqual([1, 2]);
});
