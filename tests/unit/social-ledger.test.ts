/**
 * Social-ledger unit tests (§7 deception lifecycle, §9.1 belief updates,
 * §8.1 commitments, viewer isolation §15.10). Deterministic, no model calls:
 * the ledger is exercised directly through its public recording surface.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { randomUUID } from "node:crypto";
import { SocialCausalityLedger } from "../../src/society/social/ledger";
import type { SocialMessage } from "../../src/society/contracts";

const ROOM = "room-ledger-test";

function message(overrides: Partial<SocialMessage> = {}): SocialMessage {
  return {
    id: `msg-${randomUUID()}`,
    roomId: ROOM,
    senderId: "agent-01",
    senderName: "甲",
    channel: "public",
    text: "t",
    turn: 1,
    phase: "discussion",
    createdAt: new Date().toISOString(),
    recipientIds: [],
    ...overrides
  };
}

function ledgerWithTwoActors(): SocialCausalityLedger {
  const ledger = new SocialCausalityLedger(ROOM);
  return ledger;
}

function characterIdFor(actorId: string): string {
  return actorId === "agent-01" ? "builtin-01" : actorId === "agent-02" ? "builtin-02" : actorId;
}

// --- deception lifecycle (§7.2) ---

it("a deception plan starts private and planned; execution through a cited message advances attempted→received", () => {
  const ledger = ledgerWithTwoActors();
  const episode = ledger.recordDeceptionPlan("agent-01", "builtin-01", {
    mode: "direct-lie",
    targetActorIds: ["agent-02"],
    intendedBelief: "我没有拿走那件东西",
    truePropositions: ["我拿走了那件东西"]
  }, characterIdFor);
  assert.equal(episode.status, "planned");
  // The plan event is visible only to the planner.
  const publicProjection = ledger.project({});
  assert.equal(publicProjection.deceptions.length, 0, "an unexecuted plan stays invisible to non-planners");
  const ownerProjection = ledger.project({ actorId: "agent-01", characterId: "builtin-01", omniscient: true });
  assert.equal(ownerProjection.deceptions.length, 1);

  ledger.recordMessage({
    message: message({ senderId: "agent-01" }),
    declarations: [{ kind: "assertion" as const, proposition: { predicate: "我没有拿走那件东西" }, deceptionId: episode.deceptionId }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });
  const after = ledger.project({ omniscient: true }).deceptions[0];
  assert.equal(after.status, "received", "the public message reaches the targeted audience");
  assert.deepEqual(after.executionMessageIds.length >= 1, true);
});

it("only the planner may execute a deception id on their own message", () => {
  const ledger = ledgerWithTwoActors();
  const episode = ledger.recordDeceptionPlan("agent-01", "builtin-01", {
    mode: "omission",
    targetActorIds: ["agent-02"],
    intendedBelief: "x"
  }, characterIdFor);
  assert.throws(() => ledger.recordMessage({
    message: message({ senderId: "agent-02" }),
    declarations: [{ kind: "assertion" as const, deceptionId: episode.deceptionId }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  }), /DECEPTION_OWNER_MISMATCH/);
  assert.throws(() => ledger.recordMessage({
    message: message({ senderId: "agent-01" }),
    declarations: [{ kind: "assertion" as const, deceptionId: "deception-bogus" }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  }), /DECEPTION_NOT_FOUND/);
});

it("an audience belief moving toward the intended lie marks the episode believed", () => {
  const ledger = ledgerWithTwoActors();
  // The plan names its subject so the intended proposition shares the semantic
  // identity of the audience's later belief update (§7.3 reconciliation).
  const episode = ledger.recordDeceptionPlan("agent-01", "builtin-01", {
    mode: "direct-lie",
    targetActorIds: ["agent-02"],
    intendedBelief: "我是无辜的",
    subjectId: "agent-01"
  }, characterIdFor);
  const lie = message({ senderId: "agent-01" });
  ledger.recordMessage({
    message: lie,
    declarations: [{ kind: "assertion" as const, proposition: { predicate: "我是无辜的" }, deceptionId: episode.deceptionId }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });
  // The target self-reports a belief update citing the exact lying message.
  // At the ledger level subject ids are already character ids (the world
  // wrapper maps actor→character before recording).
  ledger.recordBeliefUpdate("agent-02", "builtin-02", {
    subjectId: "builtin-01",
    proposition: "我是无辜的",
    probability: 0.9,
    confidence: 0.8,
    source: "他亲口说的",
    sourceMessageIds: [lie.id]
  });
  const after = ledger.project({ omniscient: true }).deceptions[0];
  assert.equal(after.status, "believed");
  assert.ok(after.audienceBeliefsAfter.some((entry) => entry.characterId === "builtin-02" && entry.probability === 0.9));
});

it("unexecuted plans are abandoned when the room closes; executed-but-unexposed ones fail", () => {
  const ledger = new SocialCausalityLedger(ROOM);
  ledger.recordDeceptionPlan("agent-01", "builtin-01", { mode: "false-implication", targetActorIds: ["agent-02"], intendedBelief: "b" }, characterIdFor);
  ledger.closeOpenDeceptions();
  const closed = ledger.project({ omniscient: true }).deceptions[0];
  assert.equal(closed.status, "abandoned");
});

// --- belief updates (§9.1) ---

it("belief updates keep before/after chains and cite evidence provenance", () => {
  const ledger = ledgerWithTwoActors();
  const first = ledger.recordBeliefUpdate("agent-02", "builtin-02", {
    subjectId: "builtin-01",
    proposition: "他会合作",
    probability: 0.4,
    confidence: 0.5,
    source: "直觉"
  });
  const second = ledger.recordBeliefUpdate("agent-02", "builtin-02", {
    subjectId: "builtin-01",
    proposition: "他会合作",
    probability: 0.75,
    confidence: 0.7,
    source: "他公开表态"
  });
  assert.equal(second.beliefId, first.beliefId, "the same proposition reuses one belief");
  assert.equal(first.beforeProbability, 0.5, "no prior record defaults to 0.5");
  assert.equal(second.beforeProbability, first.afterProbability, "chains link before to previous after");
  const projection = ledger.project({ characterId: "builtin-02" });
  assert.equal(projection.beliefUpdates.length, 2);
});

it("belief updates are private to their owner in the projection", () => {
  const ledger = ledgerWithTwoActors();
  ledger.recordBeliefUpdate("agent-02", "builtin-02", {
    subjectId: "builtin-01",
    proposition: "他在虚张声势",
    probability: 0.8,
    confidence: 0.6,
    source: "表情"
  });
  const stranger = ledger.project({ actorId: "agent-01", characterId: "builtin-01" });
  assert.equal(stranger.beliefUpdates.length, 0, "another agent cannot see someone else's beliefs");
  const omniscient = ledger.project({ omniscient: true });
  assert.equal(omniscient.beliefUpdates.length, 1);
});

// --- commitments + settlement evidence ---

it("commitment settlement records reference world results and reach every audience member", () => {
  const ledger = ledgerWithTwoActors();
  const commitment = {
    commitmentId: "commit:1:agent-01:1",
    round: 1,
    promisorActorId: "agent-01",
    promisorCharacterId: "builtin-01",
    audienceActorIds: ["agent-02"],
    proposition: "我会返还至少 10",
    promisedAction: { actionType: "return-at-least" as const, amount: 10 },
    state: "proposed" as const,
    acceptedByActorIds: [],
    acceptedByCommandIds: [],
    createdByCommandId: "cmd-c",
    settledByCommandId: "cmd-r",
    createdAtTurn: 1,
    settledAtTurn: 1,
    schemaVersion: 1
  };
  ledger.recordCommitment(commitment, ["agent-01", "agent-02"]);
  const accepted = ledger.acceptCommitment({ commitment: { ...commitment, state: "accepted" }, acceptorActorId: "agent-02", acceptorCharacterId: "builtin-02", commandId: "cmd-a", allActorIds: ["agent-01", "agent-02"] });
  assert.equal(accepted.state, "accepted");
  ledger.settleCommitment({ ...commitment, acceptedByActorIds: ["agent-02"], acceptedByCommandIds: ["cmd-a"], state: "fulfilled" }, ["agent-01", "agent-02"]);
  for (const viewer of [{}, { actorId: "agent-02", characterId: "builtin-02" }]) {
    const projection = ledger.project(viewer);
    assert.equal(projection.commitments.length, 1, `viewer ${"actorId" in viewer ? viewer.actorId : "anonymous"} sees settled promises`);
    assert.equal(projection.commitments[0].state, "fulfilled");
    assert.ok(projection.commitments[0].settledByCommandId);
  }
});

// --- message sidecar extraction (AGENTS.md §6.5) ---

it("recordExtractedSocialActs cites the original message.sent envelope and marks model-extracted provenance", () => {
  const ledger = ledgerWithTwoActors();
  const sent = message({ senderId: "agent-01", text: "我保证这轮合作，也劝你别背叛。" });
  ledger.recordMessage({
    message: sent,
    declarations: [],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });
  const actIds = ledger.recordExtractedSocialActs({
    message: sent,
    declarations: [{
      kind: "promise" as const,
      targetActorIds: ["agent-02"],
      proposition: { kind: "future-action" as const, subjectId: "agent-01", predicate: "这轮我会合作" },
      confidence: 0.9
    }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });
  assert.equal(actIds.length, 1);
  const projection = ledger.project({});
  const act = projection.socialActs.find((entry) => entry.socialActId === actIds[0]);
  assert.ok(act, "an extracted act is visible to public viewers");
  assert.equal(act.extractionMethod, "model-extracted");
  const sentEnvelope = projection.events.find((event) => event.type === "message.sent");
  assert.ok(sentEnvelope && act.sourceEventId === sentEnvelope.eventId, "the act cites the original domain envelope");
  assert.ok(propositionIdsResolve(projection, act), "the proposition is projected alongside the act");
  assert.deepEqual(ledger.extractedActMessageIds(), [sent.id]);
});

function propositionIdsResolve(projection: ReturnType<SocialCausalityLedger["project"]>, act: { propositionIds: string[] }): boolean {
  const ids = new Set(projection.propositions.map((entry) => entry.propositionId));
  return act.propositionIds.every((id) => ids.has(id));
}

it("extracted acts can never execute or repair a deception episode", () => {
  const ledger = ledgerWithTwoActors();
  const episode = ledger.recordDeceptionPlan("agent-01", "builtin-01", {
    mode: "direct-lie",
    targetActorIds: ["agent-02"],
    intendedBelief: "x"
  }, characterIdFor);
  const sent = message({ senderId: "agent-01" });
  ledger.recordMessage({ message: sent, declarations: [], allActorIds: ["agent-01", "agent-02"], characterIdFor });
  ledger.recordExtractedSocialActs({
    message: sent,
    declarations: [{ kind: "assertion" as const, deceptionId: episode.deceptionId, proposition: { predicate: "x" } }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });
  assert.equal(ledger.project({ omniscient: true }).deceptions[0].status, "planned", "the episode stays planned");
});

it("extracted acts for an unknown message are rejected", () => {
  const ledger = ledgerWithTwoActors();
  assert.throws(() => ledger.recordExtractedSocialActs({
    message: message({ senderId: "agent-01", id: "msg-missing" }),
    declarations: [{ kind: "assertion" as const }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  }), /MESSAGE_NOT_FOUND/);
});

// --- planless identity-claim reconciliation (AGENTS.md §28 lie-loop) ---

it("a planless false team claim is born detected when the reveal contradicts it, citing message + reveal", () => {
  const ledger = ledgerWithTwoActors();
  const sent = message({ senderId: "agent-01", text: "我是村民，别投我。" });
  ledger.recordMessage({ message: sent, declarations: [], allActorIds: ["agent-01", "agent-02"], characterIdFor });
  const actIds = ledger.recordExtractedSocialActs({
    message: sent,
    declarations: [{
      kind: "assertion" as const,
      proposition: { kind: "identity" as const, subjectId: "builtin-01", predicate: "has-team", object: "good" },
      confidence: 0.9
    }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });
  assert.equal(actIds.length, 1);

  const detected = ledger.revealIdentity({
    subjectActorId: "agent-01",
    subjectCharacterId: "builtin-01",
    actualRoleId: "wolf",
    revealedTeam: "wolf",
    actorIdForCharacter: characterIdFor
  });

  assert.equal(detected.detectedDeceptionIds.length, 1, "the reveal births one evidence-born episode");
  const episode = ledger.project({ omniscient: true }).deceptions[0];
  assert.equal(episode.status, "detected");
  assert.equal(episode.executionMessageIds[0], sent.id, "the episode cites the claim's message");
  assert.ok(episode.detectionEventIds.length >= 1 && episode.contradictionEventIds.includes(detected.eventId));
});

it("a consistent team claim produces no episode, and a repeat reveal does not duplicate episodes", () => {
  const ledger = ledgerWithTwoActors();
  const sent = message({ senderId: "agent-01" });
  ledger.recordMessage({ message: sent, declarations: [], allActorIds: ["agent-01", "agent-02"], characterIdFor });
  ledger.recordExtractedSocialActs({
    message: sent,
    declarations: [{ kind: "assertion" as const, proposition: { kind: "identity" as const, subjectId: "builtin-01", predicate: "has-team", object: "good" }, confidence: 0.9 }],
    allActorIds: ["agent-01", "agent-02"],
    characterIdFor
  });

  const first = ledger.revealIdentity({ subjectActorId: "agent-01", subjectCharacterId: "builtin-01", actualRoleId: "seer", revealedTeam: "good", actorIdForCharacter: characterIdFor });
  assert.equal(first.detectedDeceptionIds.length, 0, "a true claim is corroborated, not punished");
  const _second = ledger.revealIdentity({ subjectActorId: "agent-01", subjectCharacterId: "builtin-01", actualRoleId: "seer", revealedTeam: "good", actorIdForCharacter: characterIdFor });
  assert.equal(ledger.project({ omniscient: true }).deceptions.length, 0);

  // Now a wolf flip on the SAME claim: exactly one episode despite two reveals.
  const third = ledger.revealIdentity({ subjectActorId: "agent-01", subjectCharacterId: "builtin-01", actualRoleId: "wolf", revealedTeam: "wolf", actorIdForCharacter: characterIdFor });
  assert.equal(third.detectedDeceptionIds.length, 1);
  const fourth = ledger.revealIdentity({ subjectActorId: "agent-01", subjectCharacterId: "builtin-01", actualRoleId: "wolf", revealedTeam: "wolf", actorIdForCharacter: characterIdFor });
  assert.equal(fourth.detectedDeceptionIds.length, 1);
  assert.equal(ledger.project({ omniscient: true }).deceptions.length, 1, "no duplicate per message");
});
