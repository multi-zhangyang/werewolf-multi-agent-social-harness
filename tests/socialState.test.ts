import { describe, expect, it } from "vitest";
import {
  activeGoals,
  addBetrayal,
  addCoalition,
  addCommitment,
  addNorm,
  addGossip,
  addNormSanction,
  addTrustRepair,
  addSocialNorm,
  addSocialCoalition,
  addSocialCommitment,
  addSocialGossip,
  addSocialNormSanction,
  addSocialTrustRepair,
  addSocialBetrayal,
  appendMemory,
  appendSocialMemory,
  createAgentSocialState,
  createBetrayalLedger,
  createBeliefStore,
  createCoalitionLedger,
  createCommitmentLedger,
  createGoalStack,
  createGossipLedger,
  createMemoryStore,
  createNormState,
  createNormSanctionLedger,
  createTrustRepairLedger,
  createRelationshipGraph,
  createReputationLedger,
  pushGoal,
  pushSocialGoal,
  recordSocialStateMutation,
  recordCoalitionEvidence,
  recordBetrayalEvidence,
  recordSocialCoalitionEvidence,
  recordSocialBetrayalEvidence,
  retrieveMemory,
  setSocialLastPlan,
  updateCommitmentStatus,
  updateGoalStatus,
  updateNormStatus,
  updateNormSanctionStatus,
  updateRelationship,
  updateReputation,
  updateSocialCommitmentStatus,
  updateSocialGoalStatus,
  updateSocialNormSanctionStatus,
  updateSocialNormStatus,
  updateSocialRelationship,
  updateSocialReputation,
  updateSocialTrustRepairStatus,
  updateTrustRepairStatus,
  upsertSocialBelief,
  upsertBelief,
  type EvidenceRef
} from "../src/harness/socialState";

const evidence: EvidenceRef = {
  artifact: "message",
  id: "msg-1",
  seq: 1,
  description: "public accusation"
};

describe("agent social state stores", () => {
  it("composes social state from per-store factories without changing serialized shape", () => {
    const state = createAgentSocialState({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" },
      maxMemoryEntries: 7
    });

    expect(state).toEqual({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" },
      memory: createMemoryStore(7),
      beliefs: createBeliefStore(),
      relationships: createRelationshipGraph(),
      norms: createNormState(),
      reputation: createReputationLedger(),
      goals: createGoalStack()
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("records ordered redacted mutation journal entries through root social-state wrappers", () => {
    const state = createAgentSocialState({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" }
    });
    const context = { traceId: "trace-1", turnIndex: 1, phase: "day_speech", day: 1 };
    const rawPrivatePhrase = "raw private observation text that should not appear in the journal";

    appendSocialMemory(state, {
      kind: "observation",
      source: "environment",
      visibility: "private",
      content: rawPrivatePhrase,
      observation: { hidden: rawPrivatePhrase },
      evidenceRefs: [{ artifact: "observation", seq: 1, traceId: "trace-1" }],
      tags: ["private-observation"]
    }, context);
    upsertSocialBelief(state, {
      subject: "b",
      predicate: "claimedRole",
      value: "seer",
      confidence: 0.7,
      evidenceRefs: [evidence],
      metadata: { observerId: "a", messageId: "msg-1" }
    }, context);
    updateSocialRelationship(state, {
      targetId: "b",
      deltas: { trust: -0.2, suspicion: 0.4 },
      evidenceRefs: [evidence],
      metadata: { reason: "claim pressure" }
    }, context);
    updateSocialReputation(state, {
      subjectId: "b",
      deltas: { honesty: -0.3, threat: 0.2 },
      evidenceRefs: [evidence]
    }, context);
    const norm = addSocialNorm(state, {
      id: "public-evidence-required",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "cite evidence when accusing",
      source: "table",
      confidence: 0.8,
      status: "active",
      evidenceRefs: [evidence]
    }, context);
    updateSocialNormStatus(state, {
      id: norm.id,
      status: "violated",
      evidenceRefs: [{ artifact: "message", id: "msg-2", seq: 2 }]
    }, context);
    const goal = pushSocialGoal(state, {
      id: "verify-b",
      kind: "tactical",
      description: "verify b before voting",
      priority: 0.8,
      evidenceRefs: [evidence]
    }, context);
    updateSocialGoalStatus(state, {
      id: goal.id,
      status: "completed",
      evidenceRefs: [{ artifact: "outcome", seq: 3 }]
    }, context);
    const commitment = addSocialCommitment(state, {
      id: "commit-protect-b",
      actorId: "a",
      audienceIds: ["c", "b", "b"],
      visibility: "public",
      promisedAction: rawPrivatePhrase,
      stance: "defend b during vote",
      targetId: "b",
      deadlinePhase: "day_vote",
      deadlineDay: 1,
      confidence: 0.75,
      evidenceRefs: [{ artifact: "message", id: "msg-commit", seq: 5 }],
      metadata: { topic: "defense" }
    }, { traceId: "trace-commit", turnIndex: 5, phase: "day_speech", day: 1 });
    updateSocialCommitmentStatus(state, {
      id: commitment.id,
      status: "fulfilled",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-commit", seq: 6 }]
    }, { traceId: "trace-commit-result", turnIndex: 6, phase: "day_vote", day: 1 });
    const coalition = addSocialCoalition(state, {
      id: "coalition-a-b",
      memberIds: ["b", "a", "a"],
      visibility: "team",
      sharedGoal: rawPrivatePhrase,
      targetId: "c",
      status: "active",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 7 }],
      metadata: { channelId: "team" }
    }, { traceId: "trace-coalition", turnIndex: 7, phase: "night", day: 1 });
    recordSocialCoalitionEvidence(state, {
      id: coalition.id,
      kind: "betrayal",
      status: "betrayed",
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 8 }],
      metadata: { betrayedBy: "b" }
    }, { traceId: "trace-coalition-betrayal", turnIndex: 8, phase: "day_speech", day: 2 });
    setSocialLastPlan(state, {
      command: { type: "vote.cast", actorId: "a", targetId: "b" },
      intent: rawPrivatePhrase,
      policyName: "test-policy",
      confidence: 0.6,
      strategyTags: ["test"]
    }, [{ artifact: "trace", traceId: "trace-plan", seq: 4 }], context);

    const journal = state.journal;
    expect(journal).toBeDefined();
    expect(journal?.schemaVersion).toBe("harness.social-state-journal.v1");
    expect(journal?.entries.map((entry) => entry.journalSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(journal?.nextSeq).toBe(14);
    expect(journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "memory.appended",
      "belief.upserted",
      "relationship.updated",
      "reputation.updated",
      "norm.added",
      "norm.status.updated",
      "goal.pushed",
      "goal.status.updated",
      "commitment.added",
      "commitment.status.updated",
      "coalition.added",
      "coalition.evidence.recorded",
      "plan.updated"
    ]);
    expect(journal?.entries.every((entry) => entry.evidenceRefs.length > 0)).toBe(true);
    expect(journal?.entries.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(journal?.entries.every((entry) => entry.redactionClass === "agent_private_summary")).toBe(true);
    expect(journal?.entries[1]).toMatchObject({
      store: "beliefs",
      subjectId: "b",
      traceId: "trace-1",
      turnIndex: 1,
      phase: "day_speech",
      day: 1,
      messageSeqRange: { start: 1, end: 1 },
      afterSummary: expect.objectContaining({
        id: "b:claimedRole",
        predicate: "claimedRole",
        value: "seer",
        evidenceRefCount: 1
      })
    });
    expect(journal?.entries[0].afterSummary).toMatchObject({
      memorySeq: 1,
      kind: "observation",
      hasContent: true,
      contentLength: rawPrivatePhrase.length,
      hasObservation: true
    });
    expect(journal?.entries[8]).toMatchObject({
      store: "commitments",
      mutationKind: "commitment.added",
      subjectId: "commit-protect-b",
      traceId: "trace-commit",
      messageSeqRange: { start: 5, end: 5 },
      afterSummary: expect.objectContaining({
        id: "commit-protect-b",
        actorId: "a",
        audienceCount: 2,
        visibility: "public",
        hasPromisedAction: true,
        promisedActionLength: rawPrivatePhrase.length,
        status: "active",
        confidence: 0.75
      })
    });
    expect(journal?.entries[10]).toMatchObject({
      store: "coalitions",
      mutationKind: "coalition.added",
      subjectId: "coalition-a-b",
      traceId: "trace-coalition",
      messageSeqRange: { start: 7, end: 7 },
      afterSummary: expect.objectContaining({
        id: "coalition-a-b",
        memberCount: 2,
        visibility: "team",
        hasSharedGoal: true,
        sharedGoalLength: rawPrivatePhrase.length,
        status: "active",
        confidence: 0.7
      })
    });
    expect(journal?.entries[11]).toMatchObject({
      store: "coalitions",
      mutationKind: "coalition.evidence.recorded",
      subjectId: "coalition-a-b",
      deltaSummary: expect.objectContaining({
        evidenceKind: "betrayal",
        previousStatus: "active",
        nextStatus: "betrayed",
        evidenceAdded: 1
      }),
      afterSummary: expect.objectContaining({
        status: "betrayed",
        betrayalEvidenceRefCount: 1
      })
    });
    const serializedJournal = JSON.stringify(journal);
    expect(serializedJournal).not.toContain(rawPrivatePhrase);
    expect(serializedJournal).not.toContain("\"hidden\"");
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("sanitizes mutation journal metadata at the central write boundary", () => {
    const state = createAgentSocialState({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" }
    });

    recordSocialStateMutation(state, {
      store: "commitments",
      mutationKind: "commitment.added",
      subjectId: "commit-direct",
      evidenceRefs: [{ artifact: "message", id: "msg-direct", seq: 9 }],
      metadata: {
        observerId: "a",
        speakerId: "b",
        factSource: "social-message-speech-act",
        factKind: "commitment",
        speechActId: "act-direct",
        speechActKind: "commitment",
        speechActIndex: 0,
        channelId: "table",
        visibility: "public",
        messageId: "msg-direct",
        messageSeq: 9,
        reason: "raw private reason text",
        narrative: "raw private narrative text",
        "raw private key text": true
      }
    });

    expect(state.journal?.entries[0].metadata).toEqual({
      metadataKeys: [
        "factSource",
        "factKind",
        "observerId",
        "speakerId",
        "messageId",
        "messageSeq",
        "speechActId",
        "speechActKind",
        "speechActIndex",
        "channelId",
        "visibility"
      ],
      factSource: "social-message-speech-act",
      factKind: "commitment",
      observerId: "a",
      speakerId: "b",
      messageId: "msg-direct",
      messageSeq: 9,
      speechActId: "act-direct",
      speechActKind: "commitment",
      speechActIndex: 0,
      channelId: "table",
      visibility: "public"
    });
    expect(JSON.stringify(state.journal)).not.toMatch(/raw private reason text|raw private narrative text|raw private key text/);
  });

  it("keeps append-only memory entries retrievable, trimmed, cloned, and serializable", () => {
    const state = createAgentSocialState({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" },
      maxMemoryEntries: 2
    });

    appendMemory(state.memory, {
      kind: "observation",
      source: "environment",
      visibility: "private",
      content: "private observation",
      evidenceRefs: [{ artifact: "observation", seq: 1 }],
      tags: ["night"],
      salience: 0.4,
      importance: 0.2
    });
    appendMemory(state.memory, {
      kind: "message",
      source: "b",
      visibility: "public",
      content: "b accuses c",
      evidenceRefs: [evidence],
      tags: ["claim"],
      salience: 0.6,
      importance: 0.8
    });
    appendMemory(state.memory, {
      kind: "memo",
      source: "reasoner",
      visibility: "private",
      content: "remember b's accusation",
      evidenceRefs: [{ artifact: "memory", seq: 2 }],
      tags: ["claim"],
      salience: 0.9,
      importance: 0.9
    });

    expect(state.memory.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(state.memory.nextSeq).toBe(4);
    expect(state.memory.entries.map((entry) => entry.createdAt)).toEqual(["1970-01-01T00:00:02.000Z", "1970-01-01T00:00:03.000Z"]);

    const claimEntries = retrieveMemory(state.memory, { tags: ["claim"], limit: 1 });
    expect(claimEntries).toHaveLength(1);
    expect(claimEntries[0]).toMatchObject({
      seq: 3,
      source: "reasoner",
      visibility: "private",
      content: "remember b's accusation"
    });
    claimEntries[0].content = "mutated outside";
    expect(state.memory.entries[1].content).toBe("remember b's accusation");

    const restored = JSON.parse(JSON.stringify(state)) as typeof state;
    const appended = appendMemory(restored.memory, {
      kind: "outcome",
      source: "environment",
      visibility: "postgame",
      content: "vote succeeded",
      evidenceRefs: [{ artifact: "outcome", seq: 9 }]
    });
    expect(appended.seq).toBe(4);
    expect(() =>
      appendMemory(restored.memory, {
        kind: "memo",
        source: "agent",
        visibility: "private",
        content: "unsupported memory without evidence"
      })
    ).toThrow(/evidence ref/);
  });

  it("stores belief claims with evidence and preserves contradictions", () => {
    const state = createAgentSocialState({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" }
    });

    const first = upsertBelief(state.beliefs, {
      subject: "b",
      predicate: "claimedRole",
      value: "seer",
      confidence: 0.7,
      evidenceRefs: [evidence]
    });
    const second = upsertBelief(state.beliefs, {
      subject: "b",
      predicate: "claimedRole",
      value: "werewolf",
      confidence: 0.45,
      evidenceRefs: [{ artifact: "message", id: "msg-2", seq: 2 }]
    });

    expect(first.contradictions).toEqual([]);
    expect(second).toMatchObject({
      id: "b:claimedRole",
      subject: "b",
      predicate: "claimedRole",
      value: "werewolf",
      confidence: 0.45
    });
    expect(second.evidenceRefs).toHaveLength(2);
    expect(second.contradictions).toEqual([
      expect.objectContaining({
        value: "seer",
        confidence: 0.7,
        evidenceRefs: [evidence]
      })
    ]);
    second.value = "mutated outside";
    expect(state.beliefs.claims["b:claimedRole"].value).toBe("werewolf");
    expect(() =>
      upsertBelief(state.beliefs, {
        subject: "c",
        predicate: "alignment",
        value: "unknown",
        confidence: 0.5,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);
  });

  it("updates directed relationships, reputation, norms, and goals only through evidence-backed APIs", () => {
    const a = createAgentSocialState({
      agentId: "a",
      profile: { id: "profile-a", model: "stub-model" }
    });
    const b = createAgentSocialState({
      agentId: "b",
      profile: { id: "profile-b", model: "stub-model" }
    });

    const edge = updateRelationship(a.relationships, {
      targetId: "b",
      deltas: { trust: -0.3, suspicion: 0.5, threat: 0.2 },
      evidenceRefs: [evidence],
      metadata: { reason: "contradictory claim" }
    });
    expect(edge).toMatchObject({ targetId: "b", trust: -0.3, suspicion: 0.5, threat: 0.2 });
    expect(b.relationships.edges.a).toBeUndefined();
    expect(() => updateRelationship(a.relationships, { targetId: "c", deltas: { trust: 0.1 }, evidenceRefs: [] })).toThrow(/evidence ref/);

    const reputation = updateReputation(a.reputation, {
      subjectId: "b",
      deltas: { honesty: -0.4, cooperation: -0.1, threat: 0.3 },
      evidenceRefs: [evidence]
    });
    expect(reputation).toMatchObject({ subjectId: "b", honesty: -0.4, cooperation: -0.1, threat: 0.3 });
    expect(() => updateReputation(a.reputation, { subjectId: "b", deltas: { honesty: 0.1 }, evidenceRefs: [] })).toThrow(/evidence ref/);

    const norm = addNorm(a.norms, {
      id: "public-claims-need-evidence",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "cite evidence when making role accusations",
      source: "table",
      confidence: 0.9,
      status: "active",
      evidenceRefs: [evidence]
    });
    expect(norm.status).toBe("active");
    const violated = updateNormStatus(a.norms, {
      id: norm.id,
      status: "violated",
      evidenceRefs: [{ artifact: "message", id: "msg-3", seq: 3 }],
      metadata: { violator: "b" }
    });
    expect(violated.status).toBe("violated");
    expect(violated.evidenceRefs).toHaveLength(2);

    const goal = pushGoal(a.goals, {
      id: "verify-b-claim",
      kind: "tactical",
      description: "verify b's role claim before voting",
      priority: 0.8,
      evidenceRefs: [evidence]
    });
    pushGoal(a.goals, {
      id: "survive",
      kind: "episode",
      description: "stay alive",
      priority: 0.6,
      evidenceRefs: [{ artifact: "observation", seq: 1 }]
    });
    expect(activeGoals(a.goals).map((item) => item.id)).toEqual(["verify-b-claim", "survive"]);
    const completed = updateGoalStatus(a.goals, {
      id: goal.id,
      status: "completed",
      evidenceRefs: [{ artifact: "outcome", seq: 4 }]
    });
    expect(completed.status).toBe("completed");
    expect(activeGoals(a.goals).map((item) => item.id)).toEqual(["survive"]);
    expect(() =>
      pushGoal(a.goals, {
        id: "bad-goal",
        kind: "tactical",
        description: "missing evidence",
        priority: 1,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);
  });

  it("stores commitments and coalitions with evidence, clone protection, and lifecycle updates", () => {
    const commitments = createCommitmentLedger();
    const coalitions = createCoalitionLedger();

    const commitment = addCommitment(commitments, {
      id: "commit-a-b",
      actorId: "a",
      audienceIds: ["c", "b", "b"],
      visibility: "public",
      promisedAction: "vote with b",
      targetId: "b",
      confidence: 1.5,
      evidenceRefs: [evidence],
      metadata: { source: "public-table" }
    });
    expect(commitment).toMatchObject({
      id: "commit-a-b",
      actorId: "a",
      audienceIds: ["b", "c"],
      status: "active",
      confidence: 1
    });
    commitment.actorId = "mutated-outside";
    expect(commitments.records["commit-a-b"].actorId).toBe("a");

    const fulfilled = updateCommitmentStatus(commitments, {
      id: "commit-a-b",
      status: "fulfilled",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-1", seq: 2 }]
    });
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.evidenceRefs).toHaveLength(2);
    expect(() =>
      addCommitment(commitments, {
        id: "bad-commitment",
        actorId: "a",
        audienceIds: [],
        visibility: "public",
        confidence: 0.5,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);

    const coalition = addCoalition(coalitions, {
      id: "coalition-a-b",
      memberIds: ["b", "a", "a"],
      visibility: "team",
      sharedGoal: "pressure c",
      targetId: "c",
      confidence: -1,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 3 }]
    });
    expect(coalition).toMatchObject({
      id: "coalition-a-b",
      memberIds: ["a", "b"],
      status: "forming",
      confidence: 0,
      evidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 3 }]
    });
    coalition.memberIds.push("mutated-outside");
    expect(coalitions.records["coalition-a-b"].memberIds).toEqual(["a", "b"]);

    const betrayed = recordCoalitionEvidence(coalitions, {
      id: "coalition-a-b",
      kind: "betrayal",
      status: "betrayed",
      confidence: 0.4,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 4 }]
    });
    expect(betrayed).toMatchObject({
      status: "betrayed",
      confidence: 0.4,
      betrayalEvidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 4 }]
    });
    expect(betrayed.evidenceRefs).toHaveLength(2);
    expect(() =>
      addCoalition(coalitions, {
        id: "bad-coalition",
        memberIds: ["a"],
        visibility: "private",
        confidence: 0.5,
        formationEvidenceRefs: []
      })
    ).toThrow(/evidence ref/);
    expect(() =>
      recordCoalitionEvidence(coalitions, {
        id: "coalition-a-b",
        kind: "coordination",
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);
  });

  it("stores gossip and norm sanctions with evidence, clone protection, and redacted journal summaries", () => {
    const gossipLedger = createGossipLedger();
    const sanctionLedger = createNormSanctionLedger();
    const rawPrivatePhrase = "raw gossip and sanction text that should stay out of journal summaries";

    const gossip = addGossip(gossipLedger, {
      id: "gossip-a-b",
      speakerId: "a",
      subjectId: "b",
      audienceIds: ["c", "b", "b"],
      visibility: "public",
      topic: rawPrivatePhrase,
      claim: rawPrivatePhrase,
      sourceId: "c",
      valence: "negative",
      confidence: 1.5,
      evidenceRefs: [evidence],
      metadata: { source: "structured-fact" }
    });
    expect(gossip).toMatchObject({
      id: "gossip-a-b",
      speakerId: "a",
      subjectId: "b",
      audienceIds: ["b", "c"],
      valence: "negative",
      confidence: 1
    });
    gossip.subjectId = "mutated-outside";
    expect(gossipLedger.records["gossip-a-b"].subjectId).toBe("b");
    expect(() =>
      addGossip(gossipLedger, {
        id: "bad-gossip",
        speakerId: "a",
        subjectId: "b",
        audienceIds: ["c"],
        visibility: "public",
        confidence: 0.5,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);

    const sanction = addNormSanction(sanctionLedger, {
      id: "sanction-a-b",
      normId: "norm-public-evidence",
      actorId: "a",
      targetId: "b",
      audienceIds: ["c", "c", "b"],
      visibility: "public",
      kind: "warning",
      reason: rawPrivatePhrase,
      requestedRepair: rawPrivatePhrase,
      confidence: -1,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction", seq: 2 }]
    });
    expect(sanction).toMatchObject({
      id: "sanction-a-b",
      normId: "norm-public-evidence",
      targetId: "b",
      audienceIds: ["b", "c"],
      kind: "warning",
      status: "proposed",
      confidence: 0
    });
    sanction.targetId = "mutated-outside";
    expect(sanctionLedger.records["sanction-a-b"].targetId).toBe("b");

    const applied = updateNormSanctionStatus(sanctionLedger, {
      id: "sanction-a-b",
      status: "applied",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-sanction", seq: 3 }]
    });
    expect(applied.status).toBe("applied");
    expect(applied.evidenceRefs).toHaveLength(2);
    expect(() =>
      addNormSanction(sanctionLedger, {
        id: "bad-sanction",
        normId: "norm-public-evidence",
        actorId: "a",
        targetId: "b",
        audienceIds: ["c"],
        visibility: "public",
        kind: "pressure",
        confidence: 0.5,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);

    const state = createAgentSocialState({
      agentId: "observer",
      profile: { id: "profile-observer", model: "stub-model" }
    });
    const context = { traceId: "trace-social-records", turnIndex: 9, phase: "day_speech", day: 2 };
    const socialGossip = addSocialGossip(state, {
      id: "gossip-social",
      speakerId: "a",
      subjectId: "b",
      audienceIds: ["observer"],
      visibility: "public",
      topic: rawPrivatePhrase,
      claim: rawPrivatePhrase,
      valence: "mixed",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-social", seq: 4 }],
      metadata: { factKind: "gossip" }
    }, context);
    const socialSanction = addSocialNormSanction(state, {
      id: "sanction-social",
      normId: "norm-public-evidence",
      actorId: "a",
      targetId: "b",
      audienceIds: ["observer"],
      visibility: "public",
      kind: "reputation",
      reason: rawPrivatePhrase,
      requestedRepair: rawPrivatePhrase,
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-social", seq: 5 }],
      metadata: { factKind: "norm-sanction" }
    }, context);
    updateSocialNormSanctionStatus(state, {
      id: socialSanction.id,
      status: "applied",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-social-sanction", seq: 6 }]
    }, { traceId: "trace-social-sanction-status", turnIndex: 10, phase: "day_vote", day: 2 });

    expect(state.gossip?.records[socialGossip.id]).toMatchObject({ subjectId: "b", valence: "mixed" });
    expect(state.normSanctions?.records[socialSanction.id]).toMatchObject({ targetId: "b", status: "applied" });
    expect(state.journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "gossip.added",
      "norm_sanction.added",
      "norm_sanction.status.updated"
    ]);
    expect(state.journal?.entries[0]).toMatchObject({
      store: "gossip",
      subjectId: "gossip-social",
      messageSeqRange: { start: 4, end: 4 },
      afterSummary: expect.objectContaining({
        id: "gossip-social",
        speakerId: "a",
        subjectId: "b",
        hasTopic: true,
        topicLength: rawPrivatePhrase.length,
        hasClaim: true,
        claimLength: rawPrivatePhrase.length
      })
    });
    expect(state.journal?.entries[1]).toMatchObject({
      store: "normSanctions",
      mutationKind: "norm_sanction.added",
      subjectId: "sanction-social",
      messageSeqRange: { start: 5, end: 5 },
      afterSummary: expect.objectContaining({
        id: "sanction-social",
        normId: "norm-public-evidence",
        targetId: "b",
        kind: "reputation",
        hasReason: true,
        reasonLength: rawPrivatePhrase.length,
        hasRequestedRepair: true,
        requestedRepairLength: rawPrivatePhrase.length
      })
    });
    expect(state.journal?.entries.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(JSON.stringify(state.journal)).not.toContain(rawPrivatePhrase);
  });

  it("stores trust repairs with evidence, clone protection, and redacted journal summaries", () => {
    const ledger = createTrustRepairLedger();
    const rawRepairPhrase = "raw apology and repair explanation that should stay out of mutation summaries";

    const repair = addTrustRepair(ledger, {
      id: "repair-a-b",
      actorId: "a",
      targetId: "b",
      audienceIds: ["c", "b", "b"],
      visibility: "public",
      kind: "apology",
      triggerKind: "norm_sanction",
      triggerId: "sanction-a-b",
      relatedNormSanctionId: "sanction-a-b",
      reason: rawRepairPhrase,
      requestedRepair: rawRepairPhrase,
      offeredRepair: rawRepairPhrase,
      confidence: 1.5,
      evidenceRefs: [evidence],
      metadata: { source: "structured-trust-repair" }
    });
    expect(repair).toMatchObject({
      id: "repair-a-b",
      actorId: "a",
      targetId: "b",
      audienceIds: ["b", "c"],
      kind: "apology",
      status: "proposed",
      confidence: 1
    });
    repair.targetId = "mutated-outside";
    expect(ledger.records["repair-a-b"].targetId).toBe("b");

    const accepted = updateTrustRepairStatus(ledger, {
      id: "repair-a-b",
      status: "accepted",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-repair", seq: 2 }],
      metadata: { reviewerId: "b" }
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.evidenceRefs).toHaveLength(2);
    expect(accepted.metadata).toMatchObject({ source: "structured-trust-repair", reviewerId: "b" });
    expect(() =>
      addTrustRepair(ledger, {
        id: "bad-repair",
        actorId: "a",
        targetId: "b",
        audienceIds: ["c"],
        visibility: "public",
        kind: "correction",
        confidence: 0.5,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);
    expect(() =>
      updateTrustRepairStatus(ledger, {
        id: "repair-a-b",
        status: "completed",
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);

    const state = createAgentSocialState({
      agentId: "observer",
      profile: { id: "profile-observer", model: "stub-model" }
    });
    const socialRepair = addSocialTrustRepair(state, {
      id: "repair-social",
      actorId: "a",
      targetId: "b",
      audienceIds: ["observer", "observer"],
      visibility: "public",
      kind: "evidence_provided",
      triggerKind: "gossip",
      triggerId: "gossip-a-b",
      relatedGossipId: "gossip-a-b",
      reason: rawRepairPhrase,
      requestedRepair: rawRepairPhrase,
      offeredRepair: rawRepairPhrase,
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-repair-social", seq: 4 }],
      metadata: { factKind: "trust-repair" }
    }, { traceId: "trace-repair-social", turnIndex: 9, phase: "day_speech", day: 2 });
    updateSocialTrustRepairStatus(state, {
      id: socialRepair.id,
      status: "accepted",
      evidenceRefs: [{ artifact: "event", id: "event-social-repair", seq: 5 }]
    }, { traceId: "trace-repair-status", turnIndex: 10, phase: "day_vote", day: 2 });

    expect(state.trustRepairs?.records[socialRepair.id]).toMatchObject({ targetId: "b", status: "accepted" });
    expect(state.relationships.edges.b).toBeUndefined();
    expect(state.reputation.records.b).toBeUndefined();
    expect(state.journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "trust_repair.added",
      "trust_repair.status.updated"
    ]);
    expect(state.journal?.entries[0]).toMatchObject({
      store: "trustRepairs",
      mutationKind: "trust_repair.added",
      subjectId: "repair-social",
      traceId: "trace-repair-social",
      turnIndex: 9,
      messageSeqRange: { start: 4, end: 4 },
      afterSummary: expect.objectContaining({
        id: "repair-social",
        actorId: "a",
        targetId: "b",
        audienceCount: 1,
        visibility: "public",
        kind: "evidence_provided",
        status: "proposed",
        triggerKind: "gossip",
        triggerId: "gossip-a-b",
        relatedGossipId: "gossip-a-b",
        hasReason: true,
        reasonLength: rawRepairPhrase.length,
        hasRequestedRepair: true,
        requestedRepairLength: rawRepairPhrase.length,
        hasOfferedRepair: true,
        offeredRepairLength: rawRepairPhrase.length
      })
    });
    expect(state.journal?.entries[1]).toMatchObject({
      store: "trustRepairs",
      mutationKind: "trust_repair.status.updated",
      subjectId: "repair-social",
      eventSeqRange: { start: 5, end: 5 },
      deltaSummary: expect.objectContaining({ previousStatus: "proposed", nextStatus: "accepted" })
    });
    expect(state.journal?.entries.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(state.journal?.entries.every((entry) => entry.redactionClass === "agent_private_summary")).toBe(true);
    expect(JSON.stringify(state.journal)).not.toContain(rawRepairPhrase);
  });

  it("stores betrayals with evidence, clone protection, lifecycle evidence, and redacted journal summaries", () => {
    const ledger = createBetrayalLedger();
    const rawBetrayalPhrase = "raw betrayal allegation and impact narrative that should stay out of mutation summaries";

    const betrayal = addBetrayal(ledger, {
      id: "betrayal-a-b",
      actorId: "a",
      targetId: "b",
      audienceIds: ["c", "b", "b"],
      visibility: "public",
      kind: "commitment_broken",
      triggerKind: "commitment",
      triggerId: "commit-a-b",
      relatedCommitmentId: "commit-a-b",
      claim: rawBetrayalPhrase,
      impact: rawBetrayalPhrase,
      confidence: 1.5,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 1 }],
      metadata: { source: "public-table" }
    });
    expect(betrayal).toMatchObject({
      id: "betrayal-a-b",
      actorId: "a",
      targetId: "b",
      audienceIds: ["b", "c"],
      kind: "commitment_broken",
      status: "alleged",
      confidence: 1,
      allegationEvidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 1 }],
      corroborationEvidenceRefs: [],
      contestEvidenceRefs: [],
      repairEvidenceRefs: [],
      outcomeEvidenceRefs: []
    });
    betrayal.actorId = "mutated-outside";
    expect(ledger.records["betrayal-a-b"].actorId).toBe("a");

    const confirmed = recordBetrayalEvidence(ledger, {
      id: "betrayal-a-b",
      kind: "corroboration",
      status: "confirmed",
      confidence: -1,
      evidenceRefs: [{ artifact: "event", id: "event-betrayal", seq: 2 }]
    });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      confidence: 0,
      corroborationEvidenceRefs: [{ artifact: "event", id: "event-betrayal", seq: 2 }]
    });
    expect(confirmed.evidenceRefs).toHaveLength(2);
    expect(() =>
      addBetrayal(ledger, {
        id: "bad-betrayal",
        actorId: "a",
        targetId: "b",
        audienceIds: ["c"],
        visibility: "public",
        kind: "other",
        confidence: 0.5,
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);
    expect(() =>
      recordBetrayalEvidence(ledger, {
        id: "betrayal-a-b",
        kind: "contest",
        evidenceRefs: []
      })
    ).toThrow(/evidence ref/);

    const state = createAgentSocialState({
      agentId: "observer",
      profile: { id: "profile-observer", model: "stub-model" }
    });
    const socialBetrayal = addSocialBetrayal(state, {
      id: "betrayal-social",
      actorId: "a",
      targetId: "b",
      audienceIds: ["observer", "observer"],
      visibility: "public",
      kind: "coalition_betrayal",
      triggerKind: "coalition",
      triggerId: "coalition-a-b",
      relatedCoalitionId: "coalition-a-b",
      claim: rawBetrayalPhrase,
      impact: rawBetrayalPhrase,
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-social", seq: 3 }],
      metadata: { factKind: "betrayal" }
    }, { traceId: "trace-betrayal-social", turnIndex: 11, phase: "day_speech", day: 3 });
    recordSocialBetrayalEvidence(state, {
      id: socialBetrayal.id,
      kind: "corroboration",
      status: "confirmed",
      evidenceRefs: [{ artifact: "event", id: "event-social-betrayal", seq: 4 }]
    }, { traceId: "trace-betrayal-evidence", turnIndex: 12, phase: "day_vote", day: 3 });

    expect(state.betrayals?.records[socialBetrayal.id]).toMatchObject({ targetId: "b", status: "confirmed" });
    expect(state.relationships.edges.b).toBeUndefined();
    expect(state.reputation.records.b).toBeUndefined();
    expect(state.journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "betrayal.added",
      "betrayal.evidence.recorded"
    ]);
    expect(state.journal?.entries[0]).toMatchObject({
      store: "betrayals",
      mutationKind: "betrayal.added",
      subjectId: "betrayal-social",
      traceId: "trace-betrayal-social",
      turnIndex: 11,
      messageSeqRange: { start: 3, end: 3 },
      afterSummary: expect.objectContaining({
        id: "betrayal-social",
        actorId: "a",
        targetId: "b",
        audienceCount: 1,
        visibility: "public",
        kind: "coalition_betrayal",
        status: "alleged",
        triggerKind: "coalition",
        triggerId: "coalition-a-b",
        relatedCoalitionId: "coalition-a-b",
        hasClaim: true,
        claimLength: rawBetrayalPhrase.length,
        hasImpact: true,
        impactLength: rawBetrayalPhrase.length,
        allegationEvidenceRefCount: 1,
        corroborationEvidenceRefCount: 0,
        evidenceRefCount: 1
      })
    });
    expect(state.journal?.entries[1]).toMatchObject({
      store: "betrayals",
      mutationKind: "betrayal.evidence.recorded",
      subjectId: "betrayal-social",
      eventSeqRange: { start: 4, end: 4 },
      deltaSummary: expect.objectContaining({
        evidenceKind: "corroboration",
        previousStatus: "alleged",
        nextStatus: "confirmed",
        evidenceAdded: 1
      }),
      afterSummary: expect.objectContaining({
        status: "confirmed",
        corroborationEvidenceRefCount: 1,
        evidenceRefCount: 2
      })
    });
    expect(state.journal?.entries.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(state.journal?.entries.every((entry) => entry.redactionClass === "agent_private_summary")).toBe(true);
    expect(JSON.stringify(state.journal)).not.toContain(rawBetrayalPhrase);
  });
});
