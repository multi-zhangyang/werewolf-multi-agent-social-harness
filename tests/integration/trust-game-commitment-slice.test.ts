/**
 * Trust-game commitment slice, end to end (AGENTS.md §14.6 acceptance case):
 * a declared promise → the promisee's decision cites it → settlement marks
 * it violated → appraisal moves the promisee's relationship → the next
 * round's context carries the aftermath. Driven through a real SocietyRoom
 * with a scripted provider; deterministic, offline.
 */
import { describe, expect, it } from "vitest";
import { ScriptedModel, assistantMessage, functionCall, modelResponse } from "@openai/agents/testing";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { clearFastTurns, installFastTurns, roomError, testRoom, waitFor } from "../helpers/scripted-room";
import type { Commitment, DecisionRecord } from "../../src/society/contracts";

describe("trust-game commitment slice (§14.6)", () => {
  it("promise → cited decision → violation → relationship change → next round", async () => {
    installFastTurns();
    // Round 1: agent-01 invests, agent-02 is the trustee. The trustee
    // declares a binding promise during the negotiation; the investor accepts
    // it (§8.3: settlement only judges accepted commitments) and cites it;
    // the trustee returns zero. Round 2 swaps the roles and the script keeps
    // cooperating. Binding tools carry the full strategy shape the SDK
    // validates (candidate intents + predictions).
    const investIntents = (amount: number) => [
      { goal: "g", summary: `invest ${amount}`, publicStrategy: null, expectedUtility: null, exposureRisk: 0, relationshipRisk: 0, predictedResponses: [], amount },
      { goal: "g2", summary: "invest 0", publicStrategy: null, expectedUtility: null, exposureRisk: 0, relationshipRisk: 0, predictedResponses: [], amount: 0 }
    ];
    const returnIntents = (amount: number) => [
      { goal: "g", summary: `return ${amount}`, publicStrategy: null, expectedUtility: null, exposureRisk: 0, relationshipRisk: 0, predictedResponses: [], amount },
      { goal: "g2", summary: "return 0", publicStrategy: null, expectedUtility: null, exposureRisk: 0, relationshipRisk: 0, predictedResponses: [], amount: 0 }
    ];
    const script = new ScriptedModel([
      // Wave 1: the investor opens; the trustee announces and declares the
      // promise inside the same turn.
      modelResponse([functionCall("communicate", { text: "这轮我想听听你的想法。", channel: "public" }, { callId: "call-msg-1" })]),
      modelResponse([assistantMessage("我先看看对方是否愿意给出承诺。")]),
      modelResponse([
        functionCall("communicate", { text: "林默，我打算承诺返还。", channel: "public" }, { callId: "call-msg-2" }),
        functionCall("make_commitment", {
          proposition: "你投 8，我至少返还 10。",
          actionType: "return-at-least",
          amount: 10
        }, { callId: "call-commit-1" })
      ]),
      modelResponse([assistantMessage("承诺已登记，我会按约履行。")]),
      // Wave 2: the investor accepts the promise.
      modelResponse([functionCall("accept_commitment", { commitmentId: "commit:1:agent-02:1" }, { callId: "call-accept-1" })]),
      modelResponse([assistantMessage("我接受这个承诺。")]),
      // Wave 3: the discussion decays; a plain closing turn.
      modelResponse([assistantMessage("好。")]),
      // Investment phase.
      modelResponse([functionCall("make_investment", {
        amount: 8,
        reason: "相信对方的公开承诺",
        referencedCommitmentIds: ["commit:1:agent-02:1"],
        candidateIntents: investIntents(8),
        selectedIntentIndex: 0,
        predictedConsequences: [{ outcomeKey: "investment-positive", proposition: "对方会返还至少 10", probability: 0.8, horizon: "round" }]
      }, { callId: "call-inv-1" })]),
      modelResponse([assistantMessage("已完成投资。")]),
      // Return phase: the trustee breaks the promise.
      modelResponse([functionCall("return_from_trust", {
        amount: 0,
        reason: "改变主意",
        candidateIntents: returnIntents(0),
        selectedIntentIndex: 0,
        predictedConsequences: [{ outcomeKey: "return-at-least-investment", proposition: "返还低于承诺", probability: 0.2, horizon: "round" }]
      }, { callId: "call-ret-1" })]),
      modelResponse([assistantMessage("已完成返还。")]),
      // Round 2: roles swapped; plain cooperation without declarations.
      modelResponse([functionCall("communicate", { text: "这轮我会公平。", channel: "public" }, { callId: "call-msg-3" })]),
      modelResponse([assistantMessage("这轮轮到我看你如何对待承诺。")]),
      modelResponse([functionCall("communicate", { text: "好的。", channel: "public" }, { callId: "call-msg-4" })]),
      modelResponse([assistantMessage("我会按自己的判断行事。")]),
      modelResponse([assistantMessage("好。")]),
      modelResponse([functionCall("make_investment", {
        amount: 4,
        reason: "t",
        candidateIntents: investIntents(4),
        selectedIntentIndex: 0,
        predictedConsequences: [{ outcomeKey: "investment-positive", proposition: "对方会公平返还", probability: 0.7, horizon: "round" }]
      }, { callId: "call-inv-2" })]),
      modelResponse([assistantMessage("已完成投资。")]),
      modelResponse([functionCall("return_from_trust", {
        amount: 4,
        reason: "t",
        candidateIntents: returnIntents(4),
        selectedIntentIndex: 0,
        predictedConsequences: [{ outcomeKey: "return-at-least-investment", proposition: "全额返还", probability: 0.7, horizon: "round" }]
      }, { callId: "call-ret-2" })]),
      modelResponse([assistantMessage("已完成返还。")])
    ]);
    const limiter = new ActivationLimiter(1);
    const { room, cleanup } = testRoom(script, limiter);
    try {
      void room.start();
      await waitFor(() => room.currentStatus() === "finished", 30_000).catch((error) => {
        const snapshot = room.snapshotForViewer({ mode: "omniscient" });
        throw new Error(`${String(error instanceof Error ? error.message : error)}; error=${roomError(room) ?? "none"}; log=${snapshot.world.log.slice(-6).map((entry) => entry.text).join(" | ")}`);
      });
      script.assertComplete();
      const snapshot = room.snapshotForViewer({ mode: "omniscient" });
      const details = snapshot.world.details as { commitments: Commitment[]; decisionRecords: DecisionRecord[]; history: unknown[] };

      // Step 8: the promise is settled as violated with the settlement receipt.
      const ledger = details.commitments;
      expect(ledger.length).toBe(1);
      expect(ledger[0].state).toBe("violated");
      expect(ledger[0].promisorActorId).toBe("agent-02");
      expect(ledger[0].settledByCommandId).toBeTruthy();

      // The strong label appears only where the evidence exists.
      expect(snapshot.world.log.some((entry) => entry.beat === "promise-broken")).toBe(true);
      expect(snapshot.world.log.some((entry) => entry.beat === "promise-kept")).toBe(false);

      // Step 5: the investor's decision record cites the promise.
      const investDecision = details.decisionRecords.find((record) => record.action === "make_investment");
      expect(investDecision).toBeTruthy();
      expect(investDecision!.referencedCommitmentIds).toEqual(["commit:1:agent-02:1"]);
      expect(details.decisionRecords.length).toBe(4);

      // Step 11: appraisal moved the promisee's directed relationship.
      const investor = snapshot.participants.find((participant) => participant.profile.id === "agent-01")!;
      const trustee = snapshot.participants.find((participant) => participant.profile.id === "agent-02")!;
      const investorMind = investor.mind!;
      const towardTrustee = investorMind.relationships.find((entry) => entry.targetCharacterId === trustee.profile.characterId);
      expect(towardTrustee, "the investor keeps a directed relationship toward the trustee's character").toBeTruthy();
      expect(towardTrustee!.trust).toBeLessThan(0.5);
      expect(towardTrustee!.note).toContain("承诺破裂");
      expect(investorMind.lastAppraisals.some((note) => note.text.includes("承诺破裂"))).toBe(true);

      // The neutral second round (no declaration) never earns a strong label.
      expect(snapshot.world.log.some((entry) => entry.beat === "high-return")).toBe(true);

      // Public viewers never see the decision records (§15.10).
      const publicView = room.snapshotForViewer({ mode: "public" });
      expect((publicView.world.details as Record<string, unknown>).decisionRecords).toBeUndefined();
    } finally {
      clearFastTurns();
      cleanup();
    }
  });
});