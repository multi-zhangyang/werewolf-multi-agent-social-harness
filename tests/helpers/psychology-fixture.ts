import type { PsychologicalState } from "../../src/runtime/psychology";

/** Explicit offline fixture; never injected into real-model experiments. */
export function mindFixture(sourceId: string, targetId: string): PsychologicalState {
  return {
    appraisal: "他说会还一半，最后却一分没还。我更在意他把我的信任当成了什么。",
    sourceIds: [sourceId], emotions: [{ emotion: "hurt", intensity: .8 }, { emotion: "anger", intensity: .55 }],
    needs: [{ need: "fairness", tension: .8 }, { need: "security", tension: .6 }],
    relationships: [{ targetId, trust: -.65, hypothesis: "他可能觉得我会一直让步。", alternative: "也可能是他临时被眼前的收益诱惑。", confidence: .6, expectedNextMove: "如果我拒绝继续投入，他可能先道歉，但未必愿意付出补偿。" }],
    strategy: { kind: "protect", aim: "先保住剩下的资源，等他拿出实际行动。", boundary: "如果他付出自己的所得补偿，我可以考虑小额再试一次。", publicFace: "平静地问清楚他准备怎么补偿，不急着宣布原谅。" },
  };
}
