/**
 * Trust-game commitment slice, end to end (AGENTS.md §14.6 acceptance case):
 * a declared promise → settlement marks it violated → appraisal moves the
 * promisee's relationship → the next round's context carries the aftermath.
 * Driven through a real SocietyRoom with a scripted provider; deterministic,
 * offline.
 */
import { describe, expect, it } from "vitest";
import { ScriptedModel, assistantMessage, functionCall, modelResponse } from "@openai/agents/testing";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { clearFastTurns, installFastTurns, roomError, testRoom, waitFor } from "../helpers/scripted-room";
import type { Commitment } from "../../src/society/contracts";

describe("trust-game commitment slice (§14.6)", () => {
  it("promise → violation → relationship change → next round", async () => {
    installFastTurns();
    // Round 1: agent-01 invests, agent-02 is the trustee. The trustee
    // declares a binding promise during the negotiation; the investor accepts
    // it (§8.3: settlement only judges accepted commitments) and cites it;
    // the trustee returns zero. Round 2 swaps the roles and the script keeps
    // cooperating. Binding tools carry the flat payloads the SDK validates.
    const script = new ScriptedModel([
      // Wave 1: the investor opens; the trustee announces and declares the
      // promise inside the same turn.
      modelResponse([functionCall("prepare_message", {
        channel: "public", recipientIds: [], replyTo: null, socialActs: []
      }, { callId: "call-msg-1" })]),
      modelResponse([assistantMessage("这轮我想听听你的想法。")]),
      modelResponse([
        functionCall("prepare_message", {
          channel: "public", recipientIds: [], replyTo: null, socialActs: []
        }, { callId: "call-msg-2" }),
        functionCall("make_commitment", {
          proposition: "你投 8，我至少返还 10。",
          actionType: "return-at-least",
          amount: 10
        }, { callId: "call-commit-1" })
      ]),
      modelResponse([assistantMessage("林默，我打算承诺返还。")]),
      // Wave 2: the investor accepts the promise.
      modelResponse([
        functionCall("accept_commitment", { commitmentId: "commit:1:agent-02:1" }, { callId: "call-accept-1" }),
        functionCall("prepare_message", {
          channel: "public", recipientIds: [], replyTo: null, socialActs: []
        }, { callId: "call-msg-accept-1" })
      ]),
      modelResponse([assistantMessage("我接受这个承诺。")]),
      // Investment phase: the investor cites the accepted promise.
      modelResponse([functionCall("make_investment", {
        amount: 8,
        reason: "相信对方的公开承诺",
        referencedCommitmentIds: ["commit:1:agent-02:1"]
      }, { callId: "call-inv-1" })]),
      modelResponse([assistantMessage("SILENT")]),
      // Return phase: the trustee breaks the promise.
      modelResponse([functionCall("return_from_trust", {
        amount: 0,
        reason: "改变主意"
      }, { callId: "call-ret-1" })]),
      modelResponse([assistantMessage("SILENT")]),
      // Round 2: roles swapped; plain cooperation without declarations.
      modelResponse([functionCall("prepare_message", {
        channel: "public", recipientIds: [], replyTo: null, socialActs: []
      }, { callId: "call-msg-3" })]),
      modelResponse([assistantMessage("这轮我会公平。")]),
      modelResponse([functionCall("prepare_message", {
        channel: "public", recipientIds: [], replyTo: null, socialActs: []
      }, { callId: "call-msg-4" })]),
      modelResponse([assistantMessage("好的。")]),
      modelResponse([functionCall("make_investment", {
        amount: 4,
        reason: "t"
      }, { callId: "call-inv-2" })]),
      modelResponse([assistantMessage("SILENT")]),
      modelResponse([functionCall("return_from_trust", {
        amount: 4,
        reason: "t"
      }, { callId: "call-ret-2" })]),
      modelResponse([assistantMessage("SILENT")])
    ]);
    const limiter = new ActivationLimiter(1);
    const { room, cleanup } = testRoom(script, limiter);
    try {
      void room.start();
      await waitFor(() => room.currentStatus() === "finished", 30_000).catch((error) => {
        const snapshot = room.snapshotForViewer({ mode: "omniscient" });
        const turns = (snapshot.agentTurns ?? []).map((turn) => `${turn.actorId}:${turn.activationLabel}:${turn.status}:${turn.tools.map((tool) => tool.toolName).join(",")}`).join(" | ");
        throw new Error(`${String(error instanceof Error ? error.message : error)}; error=${roomError(room) ?? "none"}; log=${snapshot.world.log.slice(-6).map((entry) => entry.text).join(" | ")}; turns=${turns}`);
      });
      script.assertComplete();
      const snapshot = room.snapshotForViewer({ mode: "omniscient" });
      const details = snapshot.world.details as { commitments: Commitment[]; history: unknown[] };

      // Step 8: the promise is settled as violated with the settlement receipt.
      const ledger = details.commitments;
      expect(ledger.length).toBe(1);
      expect(ledger[0].state).toBe("violated");
      expect(ledger[0].promisorActorId).toBe("agent-02");
      expect(ledger[0].settledByCommandId).toBeTruthy();

      // The strong label appears only where the evidence exists.
      expect(snapshot.world.log.some((entry) => entry.beat === "promise-broken")).toBe(true);
      expect(snapshot.world.log.some((entry) => entry.beat === "promise-kept")).toBe(false);

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
    } finally {
      clearFastTurns();
      cleanup();
    }
  });
});
