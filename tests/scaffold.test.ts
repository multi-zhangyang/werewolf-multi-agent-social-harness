import { describe, expect, it } from "vitest";
import {
  WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND,
  createWeightedSocialStateCandidateScorer,
  createScaffoldedActor,
  recordCommittedReceiptOutcome,
  resolveAgentActionCandidateScorers,
  type AgentActionCandidateScorer,
  type AgentActionArbitrator,
  type AgentPolicy,
  type AgentReasoner
} from "../src/harness/scaffold";
import { SocialCommunicationBus, type SocialAction, type SocialAgentProfile, type SocialChannel, type SocialMessage, type SocialObservation } from "../src/harness/social";
import {
  addSocialBetrayal,
  addSocialCoalition,
  addSocialCommitment,
  addSocialGossip,
  addSocialNorm,
  addSocialNormSanction,
  addSocialTrustRepair,
  createAgentSocialState,
  pushSocialGoal,
  updateSocialRelationship,
  updateSocialReputation,
  upsertSocialBelief
} from "../src/harness/socialState";
import { ingestVisibleSocialMessages } from "../src/harness/socialObservationIngestor";

interface TestObservation {
  turn: number;
}

interface TestPending {
  actorId: string;
  kind: string;
  phase?: string;
  day?: number;
}

interface TestCommand {
  actorId: string;
  value: string;
}

const profile: SocialAgentProfile = {
  id: "profile-a",
  model: "stub-model",
  policyId: "test-policy"
};

describe("scaffolded social actor", () => {
  it("rejects direct outcome recording for a non-committed receipt", () => {
    const social = createAgentSocialState<TestObservation, TestPending, TestCommand>({ agentId: "a", profile });
    expect(() =>
      recordCommittedReceiptOutcome(social, {
        id: "receipt-rejected",
        status: "rejected",
        traceId: "trace-rejected",
        turnIndex: 1,
        actorId: "a",
        pendingAction: { actorId: "a", kind: "act" },
        reward: 0,
        terminated: false,
        truncated: false
      })
    ).toThrow(/non-committed receipt/);
    expect(social.memory.entries).toHaveLength(0);
    expect(social.journal?.entries ?? []).toHaveLength(0);
  });

  it("requires observe before decide", async () => {
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor("a")
    });

    await expect(actor.decide({ actorId: "a", kind: "act" })).rejects.toThrow(/cannot decide before observe/);
  });

  it("uses policy as action authority and stores reasoner output only as memo", async () => {
    const reasoner: AgentReasoner<TestObservation, TestPending, TestCommand> = {
      id: "memo-only-reasoner",
      reflect(input) {
        return `memo:${input.agent.id}:${input.pendingAction.kind}:${input.observation.turn}`;
      }
    };
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor("a"),
      reasoner
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const state = actor.state;

    expect(action).toMatchObject({
      actorId: "a",
      kind: "vote",
      command: { actorId: "a", value: "policy:vote" }
    });
    expect(state.observations).toBe(1);
    expect(state.decisions).toBe(1);
    expect(state.memory.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    expect(state.social.journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "memory.appended",
      "memory.appended",
      "memory.appended"
    ]);
    expect(state.social.journal?.entries.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(state.memory[1]).toMatchObject({
      kind: "memo",
      content: "memo:a:vote:1",
      metadata: { reasonerId: "memo-only-reasoner" }
    });
    expect(state.memory[2].metadata).toMatchObject({ policyId: "policy-a" });
  });

  it("passes typed reasoner advice to the policy without granting it command authority", async () => {
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile,
      reasoner: {
        id: "typed-advice-reasoner",
        reflect(input) {
          expect(input.reasoner).toBeUndefined();
          return {
            memo: "private typed advice memo",
            advice: { preferredValue: "reasoner-proposed" }
          };
        }
      },
      policy: {
        id: "typed-advice-policy",
        decide(input) {
          expect(input.reasoner).toEqual({
            memo: "private typed advice memo",
            advice: { preferredValue: "reasoner-proposed" }
          });
          return {
            actorId: "a",
            kind: input.pendingAction.kind,
            command: {
              actorId: "a",
              // The policy deliberately rejects the advice's proposed value.
              value: "policy-authoritative"
            }
          };
        }
      }
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });

    expect(action.command.value).toBe("policy-authoritative");
    expect(actor.state.memory.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    expect(actor.state.memory[1]).toMatchObject({ content: "private typed advice memo", source: "reasoner" });
  });

  it("receipt-gates a single adapter-owned canonical state without allocating a second scaffold state", async () => {
    interface CanonicalTestState {
      actorId: string;
      observations: number;
      committedValues: string[];
      social: ReturnType<typeof createAgentSocialState<TestObservation, TestPending, TestCommand>>;
    }

    const initialCanonicalState: CanonicalTestState = {
      actorId: "a",
      observations: 0,
      committedValues: [],
      social: createAgentSocialState<TestObservation, TestPending, TestCommand>({ agentId: "a", profile })
    };
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand, CanonicalTestState, { proposal: string }>({
      id: "a",
      profile,
      initialCanonicalState,
      canonicalStateAdapter: {
        clone: (state) => structuredClone(state),
        socialState: (state) => state.social,
        observe({ state }) {
          state.observations += 1;
        },
        afterDecision({ state, action, reasonerOutput }) {
          expect(reasonerOutput).toEqual({ memo: "canonical memo", advice: { proposal: "advisory" } });
          state.committedValues.push(action.command.value);
        }
      },
      reasoner: {
        id: "canonical-state-reasoner",
        reflect() {
          return { memo: "canonical memo", advice: { proposal: "advisory" } };
        }
      },
      policy: {
        id: "canonical-state-policy",
        decide(input) {
          expect(input.agent).toMatchObject({ actorId: "a", observations: 1, committedValues: [] });
          expect(input.reasoner?.advice).toEqual({ proposal: "advisory" });
          return {
            actorId: "a",
            kind: input.pendingAction.kind,
            command: { actorId: "a", value: "policy-selected" }
          };
        }
      }
    });
    const pending: TestPending = { actorId: "a", kind: "vote" };
    const observationContext = (traceId: string, transactionId: string) => ({
      traceId,
      transactionId,
      transactional: true as const,
      turnIndex: 1,
      batchId: "canonical-state-batch",
      batchIndex: 1,
      batchSize: 1,
      schedulerMode: "aec" as const,
      pendingAction: structuredClone(pending)
    });

    actor.observe({ turn: 1 }, observationContext("canonical:rejected", "canonical-tx-rejected"));
    await actor.decide(pending);
    expect(actor.state).toEqual(initialCanonicalState);
    actor.onStepResult({
      id: "canonical-tx-rejected:rejected",
      status: "rejected",
      traceId: "canonical:rejected",
      transactionId: "canonical-tx-rejected",
      turnIndex: 1,
      actorId: "a",
      pendingAction: pending
    });
    expect(actor.state).toEqual(initialCanonicalState);

    actor.observe({ turn: 2 }, observationContext("canonical:committed", "canonical-tx-committed"));
    const action = await actor.decide(pending);
    actor.onStepResult({
      id: "canonical-tx-committed:committed",
      status: "committed",
      traceId: "canonical:committed",
      transactionId: "canonical-tx-committed",
      turnIndex: 1,
      actorId: "a",
      pendingAction: pending,
      action,
      reward: 0.75,
      terminated: false,
      truncated: false,
      info: { visibleCount: 2, status: "accepted" },
      postStateHash: "state-after-commit",
      eventSeqRange: [7, 8],
      messageSeqRange: [12, 12]
    });

    expect(actor.state).toMatchObject({
      actorId: "a",
      observations: 1,
      committedValues: ["policy-selected"]
    });
    const outcome = actor.state.social.memory.entries.find((entry) => entry.kind === "outcome");
    expect(outcome).toMatchObject({
      source: "environment",
      visibility: "private",
      pendingAction: pending,
      evidenceRefs: [{ artifact: "outcome", id: "canonical-tx-committed:committed", traceId: "canonical:committed" }],
      tags: ["receipt-feedback", "environment-committed"],
      metadata: {
        version: "harness.committed-receipt.v1",
        status: "committed",
        transactionId: "canonical-tx-committed",
        turnIndex: 1,
        reward: 0.75,
        hasInfo: true,
        infoFieldCount: 2,
        infoValueKinds: { number: 1, string: 1 },
        postStateHash: "state-after-commit",
        eventSeqRange: [7, 8],
        messageSeqRange: [12, 12]
      }
    });
    expect(actor.state.social.journal?.entries.at(-1)).toMatchObject({
      mutationKind: "memory.appended",
      traceId: "canonical:committed",
      eventSeqRange: { start: 7, end: 8 },
      messageSeqRange: { start: 12, end: 12 }
    });
  });

  it("receipt-gates typed statement attributions with the rest of durable actor state", async () => {
    const typedMessage = socialMessage({
      id: "msg-receipt-gated-tom",
      seq: 52,
      senderId: "speaker",
      visibility: "public",
      content: "opaque typed intent",
      speechActs: [
        {
          id: "act-receipt-gated-vote",
          kind: "vote_intent",
          targetId: "target-b",
          evidenceRefs: []
        }
      ]
    });
    const actor = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a")
    });
    const pending: TestPending = { actorId: "a", kind: "vote" };
    const context = (traceId: string, transactionId: string) => ({
      traceId,
      transactionId,
      transactional: true as const,
      turnIndex: 52,
      batchId: "tom-receipt-batch",
      batchIndex: 1,
      batchSize: 1,
      schedulerMode: "aec" as const,
      pendingAction: structuredClone(pending)
    });

    actor.observe(socialObservationFor("a", [typedMessage]), context("trace-tom-rejected", "tom-rejected"));
    await actor.decide(pending);
    expect(actor.state.social.theoryOfMind).toBeUndefined();
    actor.onStepResult({
      id: "tom-rejected:receipt",
      status: "rejected",
      traceId: "trace-tom-rejected",
      transactionId: "tom-rejected",
      turnIndex: 52,
      actorId: "a",
      pendingAction: pending
    });
    expect(actor.state.social.theoryOfMind).toBeUndefined();

    actor.observe(socialObservationFor("a", [typedMessage]), context("trace-tom-committed", "tom-committed"));
    const action = await actor.decide(pending);
    actor.onStepResult({
      id: "tom-committed:receipt",
      status: "committed",
      traceId: "trace-tom-committed",
      transactionId: "tom-committed",
      turnIndex: 52,
      actorId: "a",
      pendingAction: pending,
      action
    });
    expect(actor.state.social.theoryOfMind?.records["msg-receipt-gated-tom:speech-act:act-receipt-gated-vote:theory-of-mind"]).toMatchObject({
      observerId: "a",
      subjectId: "speaker",
      kind: "stated_intent",
      observedAtTraceId: "trace-tom-committed"
    });
  });

  it("records a typed private reflection only after a committed receipt using cloned, content-safe input", async () => {
    let calls = 0;
    let sawOutcomeInRecall = false;
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor("a"),
      receiptReflectionPolicy: {
        id: "test-receipt-reflection",
        reflect(input) {
          calls += 1;
          sawOutcomeInRecall = input.memoryRetrieval.selected.some((entry) => entry.kind === "outcome");
          expect("info" in input.receipt).toBe(false);
          input.agent.observations = 999;
          input.social.memory.entries[0]!.tags.push("clone-mutation-attempt");
          input.recalledMemory[0]!.content = "clone-mutation-attempt";
          input.memoryRetrieval.selected[0]!.tags.push("clone-mutation-attempt");
          return { kind: "memory_summary", content: "Controlled committed receipt summary.", confidence: 0.75 };
        }
      }
    });
    const pending: TestPending = { actorId: "a", kind: "vote" };
    const context = (traceId: string, transactionId: string) => ({
      traceId,
      transactionId,
      transactional: true as const,
      turnIndex: 4,
      batchId: transactionId,
      batchIndex: 1,
      batchSize: 1,
      schedulerMode: "aec" as const,
      pendingAction: structuredClone(pending)
    });

    actor.observe({ turn: 3 }, context("reflection-rejected", "reflection-rejected-tx"));
    await actor.decide(pending);
    actor.onStepResult({
      id: "reflection-rejected:rejected",
      status: "rejected",
      traceId: "reflection-rejected",
      transactionId: "reflection-rejected-tx",
      turnIndex: 4,
      actorId: "a",
      pendingAction: pending
    });
    expect(calls).toBe(0);
    expect(actor.state.social.memory.entries).toEqual([]);

    actor.observe({ turn: 4 }, context("reflection-committed", "reflection-committed-tx"));
    const action = await actor.decide(pending);
    actor.onStepResult({
      id: "reflection-committed:committed",
      status: "committed",
      traceId: "reflection-committed",
      transactionId: "reflection-committed-tx",
      turnIndex: 4,
      actorId: "a",
      pendingAction: pending,
      action,
      info: { privateProviderPayload: "REFLECTION_INFO_SECRET_SENTINEL" }
    });

    expect(calls).toBe(1);
    expect(sawOutcomeInRecall).toBe(true);
    expect(actor.state.observations).toBe(1);
    expect(JSON.stringify(actor.state)).not.toContain("REFLECTION_INFO_SECRET_SENTINEL");
    expect(JSON.stringify(actor.state)).not.toContain("clone-mutation-attempt");
    expect(actor.state.social.memory.entries.map((entry) => entry.kind)).toEqual(["observation", "decision", "outcome", "reflection"]);
    const reflection = actor.state.social.memory.entries.at(-1)!;
    expect(reflection).toMatchObject({
      kind: "reflection",
      source: "policy",
      visibility: "private",
      content: "Controlled committed receipt summary.",
      reflection: {
        version: "harness.reflection.v1",
        id: "a:reflection:reflection-committed",
        agentId: "a",
        createdAtTurn: 4,
        kind: "memory_summary",
        confidence: 0.75,
        visibility: "private",
        source: "policy"
      }
    });
    expect(reflection.reflection?.evidenceRefs).toEqual(reflection.evidenceRefs);
  });

  it("commits durable outcome state before surfacing a safe receipt-reflection failure", async () => {
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor("a"),
      receiptReflectionPolicy: {
        id: "failing-receipt-reflection",
        reflect() {
          throw new Error("PRIVATE_REFLECTION_FAILURE_SENTINEL");
        }
      }
    });
    const pending: TestPending = { actorId: "a", kind: "vote" };
    actor.observe({ turn: 5 }, {
      traceId: "reflection-failure",
      transactionId: "reflection-failure-tx",
      transactional: true,
      turnIndex: 5,
      batchId: "reflection-failure-batch",
      batchIndex: 1,
      batchSize: 1,
      schedulerMode: "aec",
      pendingAction: pending
    });
    const action = await actor.decide(pending);
    expect(() => actor.onStepResult({
      id: "reflection-failure:committed",
      status: "committed",
      traceId: "reflection-failure",
      transactionId: "reflection-failure-tx",
      turnIndex: 5,
      actorId: "a",
      pendingAction: pending,
      action
    })).toThrow(/safe policy boundary/);
    expect(actor.state).toMatchObject({ observations: 1, decisions: 1, lastAction: action });
    expect(actor.state.social.memory.entries.at(-1)?.kind).toBe("outcome");
    expect(JSON.stringify(actor.state)).not.toContain("PRIVATE_REFLECTION_FAILURE_SENTINEL");
  });

  it("provides deterministic cloned recall to scaffold policy and reasoner without granting store mutation", async () => {
    let reasonerRecallSeqs: number[] = [];
    let policyRecallSeqs: number[] = [];
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile,
      reasoner: {
        id: "recall-reader",
        reflect(input) {
          reasonerRecallSeqs = (input.recalledMemory ?? []).map((entry) => entry.seq);
          input.recalledMemory?.[0]?.tags.push("reasoner-mutation-attempt");
          return "private recall memo";
        }
      },
      policy: {
        id: "recall-policy",
        decide(input) {
          policyRecallSeqs = (input.recalledMemory ?? []).map((entry) => entry.seq);
          input.memoryRetrieval?.selected[0]?.tags.push("policy-mutation-attempt");
          return {
            actorId: "a",
            kind: "act",
            command: { actorId: "a", value: "recall-policy" }
          };
        }
      }
    });

    actor.observe({ turn: 1 });
    await actor.decide({ actorId: "a", kind: "act" });
    const state = actor.state;
    const decision = state.social.memory.entries.find((entry) => entry.kind === "decision");

    expect(reasonerRecallSeqs).toEqual([1]);
    expect(policyRecallSeqs).toEqual([1]);
    expect(state.social.memory.entries[0].tags).not.toContain("reasoner-mutation-attempt");
    expect(decision?.metadata?.memoryRetrieval).toMatchObject({
      version: "harness.memory-retrieval.v1",
      actorId: "a",
      selected: [{ memorySeq: 1, rank: 1, tags: [] }]
    });
    expect(decision?.metadata?.memoryRetrieval).not.toMatchObject({
      selected: [{ tags: expect.arrayContaining(["policy-mutation-attempt"]) }]
    });
  });

  it("rejects policy actions for the wrong actor id", async () => {
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy: policyFor("b")
    });

    actor.observe({ turn: 1 });
    await expect(actor.decide({ actorId: "a", kind: "act" })).rejects.toThrow(/returned action for b, expected a/);
  });

  it("ingests only actor-visible SocialObservation messages into evidence-backed social state", () => {
    const visibleCommitment = socialMessage({
      id: "msg-visible-commitment",
      seq: 11,
      senderId: "speaker",
      visibility: "public",
      content: "typed commitment evidence",
      speechActs: [
        {
          id: "act-commitment",
          kind: "commitment",
          subjectId: "speaker",
          targetId: "target-a",
          value: "vote with observer",
          confidence: 0.8,
          evidenceRefs: [],
          metadata: {
            commitmentId: "visible-commitment",
            audienceIds: ["a"],
            stance: "support observer",
            deadlinePhase: "day_vote"
          }
        }
      ]
    });
    const visibleCoalition = socialMessage({
      id: "msg-visible-coalition",
      seq: 12,
      senderId: "ally",
      visibility: "public",
      content: "typed coalition evidence",
      speechActs: [
        {
          id: "act-coalition",
          kind: "coalition_signal",
          subjectId: "ally",
          targetId: "target-b",
          value: "opaque-domain.coordination",
          confidence: 0.75,
          evidenceRefs: [],
          metadata: {
            coalitionId: "visible-coalition",
            memberIds: ["ally", "a"],
            sharedGoal: "pressure target-b",
            status: "active"
          }
        }
      ]
    });
    const visibleSocialFacts = socialMessage({
      id: "msg-visible-social-facts",
      seq: 13,
      senderId: "analyst",
      visibility: "public",
      content: "typed structured social facts",
      metadata: {
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: { trust: 0.25, suspicion: -0.1 },
            confidence: 0.7
          },
          {
            kind: "reputation",
            subjectId: "target-b",
            deltas: { honesty: -0.2, threat: 0.4 },
            confidence: 0.9
          },
          {
            kind: "relationship",
            targetId: "ignored-invalid",
            deltas: { trust: "not-a-number" }
          }
        ]
      }
    });
    const visibleNaturalLanguageOnly = socialMessage({
      id: "msg-visible-natural-only",
      seq: 14,
      senderId: "natural",
      visibility: "public",
      content: "I promise to vote with a and target-c is dangerous.",
      metadata: { kind: "public-speech" }
    });
    const hiddenStructuredMessage = socialMessage({
      id: "msg-hidden-structured",
      seq: 99,
      senderId: "hidden",
      visibility: "public",
      content: "hidden structured fact must not be ingested",
      metadata: {
        socialFacts: [
          {
            kind: "relationship",
            targetId: "hidden-target",
            deltas: { suspicion: 1 }
          },
          {
            kind: "commitment",
            id: "hidden-commitment",
            actorId: "hidden",
            stance: "hidden stance"
          }
        ]
      }
    });
    const actor = createScaffoldedActor<SocialObservation<{ turn: number; globalTranscript: SocialMessage[] }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number; globalTranscript: SocialMessage[] }, TestPending>>("a")
    });

    actor.observe(
      socialObservationFor("a", [visibleCommitment, visibleCoalition, visibleSocialFacts, visibleNaturalLanguageOnly], {
        visibleState: {
          turn: 1,
          globalTranscript: [hiddenStructuredMessage]
        }
      }),
      observationContext({ actorId: "a", kind: "vote" }, 21)
    );

    const social = actor.state.social;
    const messageEntries = social.memory.entries.filter((entry) => entry.kind === "message");
    expect(messageEntries.map((entry) => entry.metadata?.messageId)).toEqual([
      "msg-visible-commitment",
      "msg-visible-coalition",
      "msg-visible-social-facts",
      "msg-visible-natural-only"
    ]);
    expect(social.commitments?.records["visible-commitment"]).toMatchObject({
      actorId: "speaker",
      targetId: "target-a",
      evidenceRefs: [{ artifact: "message", id: "msg-visible-commitment", seq: 11, description: "table" }],
      metadata: expect.objectContaining({
        factSource: "social-message-speech-act",
        speechActId: "act-commitment",
        messageSeq: 11
      })
    });
    expect(social.coalitions?.records["visible-coalition"]).toMatchObject({
      memberIds: ["a", "ally"],
      targetId: "target-b",
      status: "active",
      formationEvidenceRefs: [{ artifact: "message", id: "msg-visible-coalition", seq: 12, description: "table" }]
    });
    expect(social.relationships.edges["target-a"]).toMatchObject({
      targetId: "target-a",
      trust: 0.25,
      suspicion: -0.1,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-social-facts", seq: 13, description: "table" }]
    });
    expect(social.reputation.records["target-b"]).toMatchObject({
      subjectId: "target-b",
      honesty: -0.2,
      threat: 0.4,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-social-facts", seq: 13, description: "table" }]
    });
    expect(social.relationships.edges["ignored-invalid"]).toBeUndefined();
    expect(social.relationships.edges["hidden-target"]).toBeUndefined();
    expect(social.commitments?.records["hidden-commitment"]).toBeUndefined();
    expect(Object.values(social.commitments?.records ?? {}).some((record) => record.actorId === "natural")).toBe(false);
    expect(Object.values(social.coalitions?.records ?? {}).some((record) => record.memberIds.includes("natural"))).toBe(false);
    expect(social.theoryOfMind?.records["msg-visible-commitment:speech-act:act-commitment:theory-of-mind"]).toMatchObject({
      observerId: "a",
      subjectId: "speaker",
      kind: "stated_commitment",
      proposition: {
        predicate: "commitment",
        subjectId: "speaker",
        targetId: "target-a",
        value: "vote with observer"
      },
      sourceMessageId: "msg-visible-commitment",
      sourceSpeechActId: "act-commitment",
      evidenceRefs: [{ artifact: "message", id: "msg-visible-commitment", seq: 11, description: "table" }]
    });
    expect(social.theoryOfMind?.records["msg-visible-coalition:speech-act:act-coalition:theory-of-mind"]).toBeUndefined();

    const journal = social.journal?.entries ?? [];
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(
      journal.filter((entry) => entry.store !== "memory").map((entry) => ({
        store: entry.store,
        kind: entry.mutationKind,
        range: entry.messageSeqRange,
        evidenceRefs: entry.evidenceRefs
      }))
    ).toEqual([
      {
        store: "theoryOfMind",
        kind: "theory_of_mind.attribution.recorded",
        range: { start: 11, end: 11 },
        evidenceRefs: [{ artifact: "message", id: "msg-visible-commitment", seq: 11, description: "table" }]
      },
      {
        store: "commitments",
        kind: "commitment.added",
        range: { start: 11, end: 11 },
        evidenceRefs: [{ artifact: "message", id: "msg-visible-commitment", seq: 11, description: "table" }]
      },
      {
        store: "coalitions",
        kind: "coalition.added",
        range: { start: 12, end: 12 },
        evidenceRefs: [{ artifact: "message", id: "msg-visible-coalition", seq: 12, description: "table" }]
      },
      {
        store: "relationships",
        kind: "relationship.updated",
        range: { start: 13, end: 13 },
        evidenceRefs: [{ artifact: "message", id: "msg-visible-social-facts", seq: 13, description: "table" }]
      },
      {
        store: "reputation",
        kind: "reputation.updated",
        range: { start: 13, end: 13 },
        evidenceRefs: [{ artifact: "message", id: "msg-visible-social-facts", seq: 13, description: "table" }]
      }
    ]);
    expect(journal.some((entry) => entry.evidenceRefs.some((ref) => ref.id === "msg-hidden-structured"))).toBe(false);
  });

  it("does not parse natural-language-only visible messages into social facts", () => {
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-language-only",
      seq: 31,
      senderId: "speaker",
      visibility: "public",
      content: "I am honest, I promise to vote with a, and target-b should be pressured.",
      metadata: { kind: "public-speech" }
    });
    const actor = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a")
    });

    actor.observe(socialObservationFor("a", [naturalLanguageOnly]), observationContext({ actorId: "a", kind: "speech" }, 22));

    const social = actor.state.social;
    const messageEntries = social.memory.entries.filter((entry) => entry.kind === "message");
    expect(messageEntries).toHaveLength(1);
    expect(messageEntries[0]).toMatchObject({
      kind: "message",
      source: "speaker",
      content: naturalLanguageOnly.content,
      tags: ["message:public-speech"]
    });
    expect(social.beliefs.claims).toEqual({});
    expect(social.relationships.edges).toEqual({});
    expect(social.reputation.records).toEqual({});
    expect(social.commitments?.records ?? {}).toEqual({});
    expect(social.coalitions?.records ?? {}).toEqual({});
    expect(social.gossip?.records ?? {}).toEqual({});
    expect(social.norms.norms).toEqual({});
    expect(social.normSanctions?.records ?? {}).toEqual({});
    expect(social.trustRepairs?.records ?? {}).toEqual({});
    expect(social.betrayals?.records ?? {}).toEqual({});
    expect(social.theoryOfMind?.records ?? {}).toEqual({});
    expect(social.journal?.entries.filter((entry) => entry.store !== "memory")).toEqual([]);
  });

  it("records only explicit visible typed declarations as scoped statement attributions", () => {
    const typed = socialMessage({
      id: "msg-typed-mental-state",
      seq: 44,
      senderId: "speaker",
      visibility: "public",
      content: "opaque transport text",
      speechActs: [
        {
          id: "act-claim",
          kind: "claim",
          subjectId: "target-b",
          value: "suspected-wolf",
          confidence: 0.7,
          evidenceRefs: []
        },
        {
          id: "act-vote",
          kind: "vote_intent",
          targetId: "target-c",
          value: "vote-target-c",
          confidence: 0.8,
          evidenceRefs: []
        },
        {
          id: "act-agreement",
          kind: "agreement",
          targetId: "ally-d",
          value: "shared-plan",
          evidenceRefs: []
        }
      ]
    });
    const naturalOnly = socialMessage({
      id: "msg-natural-mental-state",
      seq: 45,
      senderId: "natural",
      visibility: "public",
      content: "I truly know target-b is dangerous and will vote target-c.",
      metadata: { kind: "public-speech" }
    });
    const postgameTyped = socialMessage({
      id: "msg-postgame-mental-state",
      seq: 46,
      senderId: "postgame-speaker",
      visibility: "postgame",
      content: "postgame only typed statement",
      speechActs: [
        {
          id: "act-postgame",
          kind: "vote_intent",
          targetId: "target-z",
          evidenceRefs: []
        }
      ]
    });
    const hiddenTyped = socialMessage({
      id: "msg-hidden-mental-state",
      seq: 47,
      senderId: "hidden",
      visibility: "private",
      content: "not scoped to observer",
      recipientIds: ["hidden"],
      speechActs: [
        {
          id: "act-hidden",
          kind: "vote_intent",
          targetId: "target-hidden",
          evidenceRefs: []
        }
      ]
    });
    const actor = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a")
    });

    actor.observe(
      socialObservationFor("a", [typed, naturalOnly, postgameTyped]),
      observationContext({ actorId: "a", kind: "speech" }, 46)
    );
    // Re-observing cannot duplicate attributions, and a hidden message that is
    // present elsewhere in the domain is never handed to this actor's scope.
    actor.observe(
      socialObservationFor("a", [typed, naturalOnly, postgameTyped], { visibleState: { turn: 2 } }),
      observationContext({ actorId: "a", kind: "speech" }, 47)
    );

    const social = actor.state.social;
    const records = Object.values(social.theoryOfMind?.records ?? {});
    expect(records).toHaveLength(3);
    expect(records.map((record) => ({ kind: record.kind, predicate: record.proposition.predicate, targetId: record.proposition.targetId }))).toEqual([
      { kind: "stated_assertion", predicate: "claim", targetId: undefined },
      { kind: "stated_intent", predicate: "vote_intent", targetId: "target-c" },
      { kind: "stated_agreement", predicate: "agreement", targetId: "ally-d" }
    ]);
    expect(records.every((record) => record.observerId === "a" && record.subjectId === "speaker")).toBe(true);
    expect(records.every((record) => record.sourceMessageId === typed.id && record.sourceMessageSeq === typed.seq)).toBe(true);
    expect(records.every((record) => record.observedAtTraceId === "trace-scaffold-46")).toBe(true);
    expect(records.some((record) => record.sourceMessageId === naturalOnly.id)).toBe(false);
    expect(records.some((record) => record.sourceMessageId === postgameTyped.id)).toBe(false);
    expect(records.some((record) => record.sourceMessageId === hiddenTyped.id)).toBe(false);
    expect(social.beliefs.claims).toEqual({});
    expect(social.journal?.entries.filter((entry) => entry.store === "theoryOfMind")).toHaveLength(3);
    expect(social.journal?.entries.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
  });

  it("supports wrapped view.social.messages, dedupes repeated observations, and ignores bus-hidden messages", () => {
    const channels: SocialChannel[] = [
      {
        id: "table",
        kind: "public",
        participantIds: ["a", "speaker", "hidden", "target-a"],
        readableBy: "all"
      },
      {
        id: "hidden-room",
        kind: "private",
        participantIds: ["hidden", "target-a"],
        readableBy: "participants"
      }
    ];
    const bus = new SocialCommunicationBus(channels);
    const hiddenMessage = bus.publish({
      channelId: "hidden-room",
      senderId: "hidden",
      recipientIds: ["target-a"],
      visibility: "private",
      content: "hidden bus commitment",
      metadata: {
        socialFacts: [
          {
            kind: "commitment",
            id: "hidden-bus-commitment",
            actorId: "hidden",
            stance: "hidden"
          }
        ]
      }
    });
    const visibleMessage = bus.publish({
      channelId: "table",
      senderId: "speaker",
      recipientIds: ["a"],
      visibility: "public",
      content: "visible bus commitment",
      metadata: {
        socialFacts: [
          {
            kind: "commitment",
            id: "visible-bus-commitment",
            actorId: "speaker",
            audienceIds: ["a"],
            promisedAction: "vote with a",
            status: "active"
          }
        ]
      }
    });
    const scoped = bus.observe("a");
    const actor = createScaffoldedActor<any, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<any>("a")
    });
    const wrappedObservation = {
      agentId: "a",
      view: {
        you: { id: "a" },
        social: scoped,
        phase: "day_vote",
        day: 2
      }
    };

    expect(scoped.messages.map((message) => message.id)).toEqual([visibleMessage.id]);
    expect(scoped.messages.some((message) => message.id === hiddenMessage.id)).toBe(false);

    actor.observe(wrappedObservation, observationContext({ actorId: "a", kind: "vote", phase: "day_vote", day: 2 }, 23));
    actor.observe(wrappedObservation, observationContext({ actorId: "a", kind: "vote", phase: "day_vote", day: 2 }, 24));

    const social = actor.state.social;
    expect(social.memory.entries.filter((entry) => entry.kind === "message").map((entry) => entry.metadata?.messageId)).toEqual([
      visibleMessage.id
    ]);
    expect(social.commitments?.records["visible-bus-commitment"]).toMatchObject({
      actorId: "speaker",
      evidenceRefs: expect.arrayContaining([
        { artifact: "message", id: visibleMessage.id, seq: visibleMessage.seq, description: "table" },
        expect.objectContaining({
          artifact: "delivery_receipt",
          id: expect.stringContaining(`:${actor.id}`),
          seq: visibleMessage.seq
        })
      ])
    });
    expect(social.commitments?.records["hidden-bus-commitment"]).toBeUndefined();
    expect(
      social.journal?.entries.filter(
        (entry) => entry.store === "memory" && entry.afterSummary?.kind === "message" && entry.evidenceRefs[0]?.id === visibleMessage.id
      )
    ).toHaveLength(1);
    expect(social.journal?.entries.some((entry) => entry.evidenceRefs.some((ref) => ref.id === hiddenMessage.id))).toBe(false);

    const forgedObservation = structuredClone(wrappedObservation);
    forgedObservation.view.social.messages[0].deliveryReceipts =
      forgedObservation.view.social.messages[0].deliveryReceipts?.filter((receipt) => receipt.observerId !== "a");
    const forgedActor = createScaffoldedActor<any, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<any>("a")
    });
    expect(() =>
      forgedActor.observe(forgedObservation, observationContext({ actorId: "a", kind: "vote", phase: "day_vote", day: 2 }, 25))
    ).toThrow(/exactly one matching delivery receipt for observer a/);
    expect(forgedActor.state.social.memory.entries.map((entry) => entry.kind)).toEqual(["observation"]);
    expect(forgedActor.state.social.memory.entries.some((entry) => entry.kind === "message")).toBe(false);
    expect(forgedActor.state.social.commitments?.records["visible-bus-commitment"]).toBeUndefined();
    expect(forgedActor.state.social.messageIngestion?.seenMessageIds).toEqual([]);

    const legacyObservation = structuredClone(wrappedObservation);
    delete legacyObservation.view.social.messages[0].deliveryReceipts;
    const legacyActor = createScaffoldedActor<any, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<any>("a")
    });
    expect(() =>
      legacyActor.observe(legacyObservation, observationContext({ actorId: "a", kind: "vote", phase: "day_vote", day: 2 }, 26))
    ).not.toThrow();
    expect(legacyActor.state.social.memory.entries.find((entry) => entry.kind === "message")?.evidenceRefs).toEqual([
      expect.objectContaining({ artifact: "message", id: visibleMessage.id })
    ]);
  });

  it("persists exact visible-message ingestion identities across bounded-memory snapshot restore", () => {
    const firstMessage = socialMessage({
      id: "msg-durable-first",
      seq: 10,
      senderId: "speaker",
      visibility: "public",
      content: "first explicit social consequence",
      metadata: {
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: { trust: 0.25 }
          },
          {
            kind: "reputation",
            subjectId: "target-a",
            deltas: { cooperation: 0.3 }
          }
        ]
      }
    });
    const secondMessage = socialMessage({
      id: "msg-durable-second",
      seq: 20,
      senderId: "speaker",
      visibility: "public",
      content: "ordinary visible message that advances bounded memory"
    });
    const actor = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a"),
      maxMemoryEntries: 2
    });

    actor.observe(socialObservationFor("a", [firstMessage]), observationContext({ actorId: "a", kind: "observe" }, 31));
    actor.observe(
      socialObservationFor("a", [firstMessage, secondMessage], { visibleState: { turn: 2 } }),
      observationContext({ actorId: "a", kind: "observe" }, 32)
    );

    const snapshot = actor.state.social;
    expect(snapshot.memory.entries.some((entry) => entry.evidenceRefs.some((ref) => ref.id === firstMessage.id))).toBe(false);
    expect(snapshot.relationships.edges["target-a"].trust).toBe(0.25);
    expect(snapshot.reputation.records["target-a"].cooperation).toBe(0.3);
    expect(snapshot.messageIngestion).toEqual({
      schemaVersion: "harness.social-message-ingestion.v1",
      seenMessageIds: [firstMessage.id, secondMessage.id]
    });

    const delayedOlderMessage = socialMessage({
      id: "msg-durable-delayed-older",
      seq: 5,
      senderId: "late-speaker",
      visibility: "public",
      content: "newly visible older-sequence evidence",
      metadata: {
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: { trust: 0.1 }
          }
        ]
      }
    });
    const hiddenMessage = socialMessage({
      id: "msg-durable-hidden",
      seq: 4,
      senderId: "hidden-speaker",
      visibility: "private",
      content: "not present in this actor's scoped observation",
      recipientIds: ["hidden-speaker"]
    });
    const restored = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a"),
      initialSocialState: snapshot,
      maxMemoryEntries: 2
    });

    restored.observe(
      socialObservationFor("a", [firstMessage, secondMessage, delayedOlderMessage], { visibleState: { turn: 3 } }),
      observationContext({ actorId: "a", kind: "observe" }, 33)
    );

    const social = restored.state.social;
    expect(social.relationships.edges["target-a"].trust).toBe(0.35);
    expect(social.reputation.records["target-a"].cooperation).toBe(0.3);
    expect(social.messageIngestion?.seenMessageIds).toEqual([
      firstMessage.id,
      secondMessage.id,
      delayedOlderMessage.id
    ]);
    expect(social.messageIngestion?.seenMessageIds).not.toContain(hiddenMessage.id);
    expect(
      social.journal?.entries.filter(
        (entry) => entry.store === "relationships" && entry.metadata?.messageId === firstMessage.id
      )
    ).toHaveLength(1);
    expect(
      social.journal?.entries.filter(
        (entry) => entry.store === "reputation" && entry.metadata?.messageId === firstMessage.id
      )
    ).toHaveLength(1);
    expect(
      social.journal?.entries.filter(
        (entry) => entry.store === "relationships" && entry.metadata?.messageId === delayedOlderMessage.id
      )
    ).toHaveLength(1);
  });

  it("migrates retained visible-message evidence from legacy social snapshots", () => {
    const visibleMessage = socialMessage({
      id: "msg-legacy-retained",
      seq: 7,
      senderId: "speaker",
      visibility: "public",
      content: "retained legacy message"
    });
    const original = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a")
    });
    original.observe(socialObservationFor("a", [visibleMessage]), observationContext({ actorId: "a", kind: "observe" }, 34));
    const legacySnapshot = original.state.social;
    delete legacySnapshot.messageIngestion;

    const restored = createScaffoldedActor<SocialObservation<{ turn: number }, TestPending>, TestPending, TestCommand>({
      id: "a",
      profile,
      policy: policyFor<SocialObservation<{ turn: number }, TestPending>>("a"),
      initialSocialState: legacySnapshot
    });
    restored.observe(socialObservationFor("a", [visibleMessage]), observationContext({ actorId: "a", kind: "observe" }, 35));

    expect(restored.state.social.messageIngestion).toEqual({
      schemaVersion: "harness.social-message-ingestion.v1",
      seenMessageIds: [visibleMessage.id]
    });
    expect(
      restored.state.social.memory.entries.filter(
        (entry) => entry.kind === "message" && entry.evidenceRefs.some((ref) => ref.id === visibleMessage.id)
      )
    ).toHaveLength(1);
  });

  it("commits each visible-message ingestion transaction only after all store updates succeed", () => {
    const message = socialMessage({
      id: "msg-transactional-ingestion",
      seq: 41,
      senderId: "speaker",
      visibility: "public",
      content: "transactional visible message",
      metadata: {
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: { trust: 0.2 }
          }
        ]
      }
    });
    const social = createAgentSocialState<TestObservation, TestPending, TestCommand>({
      agentId: "a",
      profile
    });
    const seenMessageIds = new Set<string>();

    expect(() =>
      ingestVisibleSocialMessages({
        social,
        observerId: "a",
        messages: [message],
        seenMessageIds,
        onMessageIngested() {
          throw new Error("domain-specific ingestion failed");
        }
      })
    ).toThrow(/domain-specific ingestion failed/);

    expect(seenMessageIds).toEqual(new Set());
    expect(social.messageIngestion?.seenMessageIds).toEqual([]);
    expect(social.memory.entries).toEqual([]);
    expect(social.relationships.edges).toEqual({});
    expect(social.journal?.entries ?? []).toEqual([]);

    const retried = ingestVisibleSocialMessages({
      social,
      observerId: "a",
      messages: [message],
      seenMessageIds
    });
    expect(retried).toMatchObject({ ingestedMessageCount: 1, skippedDuplicateMessageCount: 0 });
    expect(social.messageIngestion?.seenMessageIds).toEqual([message.id]);
    expect(social.relationships.edges["target-a"].trust).toBe(0.2);
  });

  it("acts without a reasoner and keeps trimmed memory sequence ids monotonic", async () => {
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy: policyFor("a"),
      maxMemoryEntries: 2
    });

    actor.observe({ turn: 1 });
    await actor.decide({ actorId: "a", kind: "first" });
    actor.observe({ turn: 2 });
    await actor.decide({ actorId: "a", kind: "second" });

    const state = actor.state;
    expect(state.memory).toHaveLength(2);
    expect(state.memory.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(state.memory.map((entry) => entry.kind)).toEqual(["observation", "decision"]);
    expect(state.lastAction).toMatchObject({
      actorId: "a",
      kind: "second",
      command: { actorId: "a", value: "policy:second" }
    });
    expect(state.social.memory.entries.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(state.social.memory.nextSeq).toBe(5);
    expect(state.social.memory.entries.every((entry) => entry.evidenceRefs.length > 0)).toBe(true);
    expect(state.social.journal?.entries.map((entry) => entry.journalSeq)).toEqual([1, 2, 3, 4]);
    expect(state.social.journal?.entries.map((entry) => entry.afterSummary?.memorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.lastAction?.metadata?.arbitration).toBeUndefined();
    expect(state.memory.at(-1)?.tags).toEqual(["policy-decision"]);
    expect(state.memory.at(-1)?.metadata).toMatchObject({ policyId: "policy-a" });
  });

  it("keeps social stores serializable and prevents reasoner input mutation from becoming state or policy input", async () => {
    const reasoner: AgentReasoner<TestObservation, TestPending, TestCommand> = {
      id: "malicious-reasoner",
      reflect(input) {
        input.agent.memory.push({
          seq: 999,
          kind: "memo",
          content: "mutated cloned compatibility memory",
          createdAt: new Date(0).toISOString()
        });
        input.agent.social.beliefs.claims.injected = {
          id: "injected",
          subject: "b",
          predicate: "role",
          value: "wolf",
          confidence: 1,
          evidenceRefs: [{ artifact: "memory", seq: 999 }],
          contradictions: [],
          updatedAt: new Date(0).toISOString()
        };
        return "memo text only";
      }
    };
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "policy-checks-clean-input",
      decide(input): SocialAction<TestCommand> {
        return {
          actorId: "a",
          kind: input.pendingAction.kind,
          command: {
            actorId: "a",
            value: input.agent.social.beliefs.claims.injected ? "polluted" : "clean"
          }
        };
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy,
      reasoner
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const state = actor.state;

    expect(action.command.value).toBe("clean");
    expect(state.social.beliefs.claims.injected).toBeUndefined();
    expect(state.social.memory.entries.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    expect(state.social.memory.entries[1]).toMatchObject({
      source: "reasoner",
      visibility: "private",
      content: "memo text only",
      metadata: { reasonerId: "malicious-reasoner" }
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);

    state.social.memory.entries[0].content = "external mutation";
    state.social.beliefs.claims.external = {
      id: "external",
      subject: "x",
      predicate: "y",
      value: true,
      confidence: 1,
      evidenceRefs: [{ artifact: "memory", seq: 1 }],
      contradictions: [],
      updatedAt: new Date(0).toISOString()
    };
    const fresh = actor.state;
    expect(fresh.social.memory.entries[0].content).not.toBe("external mutation");
    expect(fresh.social.beliefs.claims.external).toBeUndefined();
  });

  it("arbitrates generated candidates and records a redacted summary without replacing environment authority", async () => {
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "candidate-policy",
      decide: policyFor("a").decide,
      generateCandidates(input) {
        return [
          {
            id: "low-risk-pass",
            actorId: "a",
            kind: "pass",
            source: "policy",
            action: {
              actorId: "a",
              kind: "pass",
              command: { actorId: "a", value: "pass" }
            },
            utilityScore: 0.1,
            socialScore: 0.2,
            riskPenalty: 0,
            finalScore: 0.3,
            reasons: ["preserve optionality"],
            evidenceRefs: [{ artifact: "memory", seq: 1 }]
          },
          {
            id: "press-b",
            actorId: "a",
            kind: "press",
            source: "policy",
            action: {
              actorId: "a",
              kind: "press",
              command: { actorId: "a", value: "press-b" },
              metadata: { existing: true }
            },
            utilityScore: 0.8,
            socialScore: 0.4,
            riskPenalty: 0.1,
            finalScore: 1.1,
            reasons: ["relationship evidence favors pressure"],
            evidenceRefs: [{ artifact: "trace", traceId: "trace-1" }],
            metadata: {
              privateScratchpad: "must stay out of persisted arbitration summaries"
            }
          }
        ];
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const arbitration = action.metadata?.arbitration as Record<string, any>;
    const state = actor.state;

    expect(action).toMatchObject({
      actorId: "a",
      kind: "press",
      command: { actorId: "a", value: "press-b" },
      metadata: {
        existing: true,
        arbitration: expect.objectContaining({
          version: "agent.action-arbitration.v1",
          selectedCandidateId: "press-b",
          candidateCount: 2
        })
      }
    });
    expect(arbitration.candidates).toEqual([
      expect.objectContaining({
        id: "low-risk-pass",
        kind: "pass",
        finalScore: 0.3,
        reasons: ["preserve optionality"]
      }),
      expect.objectContaining({
        id: "press-b",
        kind: "press",
        finalScore: 1.1,
        reasons: ["relationship evidence favors pressure"]
      })
    ]);
    expect(JSON.stringify(arbitration)).not.toContain("command");
    expect(JSON.stringify(arbitration)).not.toContain("privateScratchpad");
    expect(state.memory.at(-1)?.metadata).toMatchObject({
      policyId: "candidate-policy",
      arbitration: {
        version: "agent.action-arbitration.v1",
        selectedCandidateId: "press-b",
        candidateCount: 2
      }
    });
  });

  it("lets a configured action arbitrator select among candidates by id", async () => {
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "multi-candidate-policy",
      decide: policyFor("a").decide,
      generateCandidates(input) {
        return [
          {
            id: "higher-score",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "higher-score" } },
            finalScore: 10,
            reasons: ["highest utility"],
            evidenceRefs: [{ artifact: "memory", seq: 1 }]
          },
          {
            id: "human-rule",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "selected-by-arbitrator" } },
            finalScore: 1,
            reasons: ["matches explicit norm"],
            evidenceRefs: [{ artifact: "memory", seq: 1 }]
          }
        ];
      }
    };
    const actionArbitrator: AgentActionArbitrator<TestObservation, TestPending, TestCommand> = {
      id: "norm-first-arbitrator",
      arbitrate(input) {
        expect(input.reasonerMemo).toBeUndefined();
        return {
          selectedCandidateId: "human-rule",
          decisionRule: "explicit_norm_override",
          reason: "selected norm-compatible candidate",
          evidenceRefs: [{ artifact: "memory", seq: 1 }]
        };
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy,
      actionArbitrator
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });

    expect(action.command.value).toBe("selected-by-arbitrator");
    expect(action.metadata?.arbitration).toMatchObject({
      version: "agent.action-arbitration.v1",
      arbitratorId: "norm-first-arbitrator",
      selectedCandidateId: "human-rule",
      decisionRule: "explicit_norm_override",
      selectionReason: "selected norm-compatible candidate",
      selectionEvidenceRefs: [{ artifact: "memory", seq: 1 }]
    });
  });

  it("scores generated candidates from evidence-backed social state before default arbitration", async () => {
    const social = createAgentSocialState<TestObservation, TestPending, TestCommand>({
      agentId: "a",
      profile
    });
    updateSocialRelationship(social, {
      targetId: "b",
      deltas: { trust: -0.2, suspicion: 0.6, threat: 0.4 },
      evidenceRefs: [{ artifact: "message", id: "msg-relationship", seq: 1 }]
    });
    updateSocialReputation(social, {
      subjectId: "b",
      deltas: { honesty: -0.2, threat: 0.5, normCompliance: -0.3 },
      evidenceRefs: [{ artifact: "message", id: "msg-reputation", seq: 2 }]
    });
    upsertSocialBelief(social, {
      subject: "b",
      predicate: "danger",
      value: true,
      confidence: 0.8,
      evidenceRefs: [{ artifact: "memory", seq: 3 }]
    });
    pushSocialGoal(social, {
      id: "pressure-b",
      kind: "tactical",
      description: "pressure b using public evidence",
      priority: 0.7,
      evidenceRefs: [{ artifact: "memory", seq: 4 }],
      metadata: { targetId: "b" }
    });
    addSocialNorm(social, {
      id: "challenge-threats",
      kind: "obligation",
      scope: "table",
      expectedBehavior: "challenge high-threat actors",
      source: "test",
      confidence: 0.5,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm", seq: 5 }],
      metadata: { targetIds: ["b"] }
    });
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "social-scored-policy",
      decide: policyFor("a").decide,
      generateCandidates(input) {
        return [
          {
            id: "wait",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "wait" } },
            finalScore: 0.4,
            reasons: ["low information cost"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }]
          },
          {
            id: "pressure-b",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            socialTargetIds: ["b"],
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "pressure-b" } },
            finalScore: 0.05,
            reasons: ["candidate targets b"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }],
            metadata: { privateScratchpad: "social scorer must not persist this" }
          }
        ];
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy,
      initialSocialState: social,
      candidateScorers: [
        createWeightedSocialStateCandidateScorer<TestObservation, TestPending, TestCommand>({
          id: "pressure-social-state",
          relationshipWeights: { suspicion: 0.5, threat: 0.4, trust: -0.4 },
          reputationWeights: { threat: 0.3, honesty: -0.2, normCompliance: -0.2 },
          beliefPredicateWeights: { danger: 0.25 },
          activeGoalWeight: 0.2,
          activeNormWeight: 0.1
        })
      ]
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const arbitration = action.metadata?.arbitration as Record<string, any>;
    const selectedSummary = arbitration.candidates.find((candidate: Record<string, unknown>) => candidate.id === "pressure-b");

    expect(action.command.value).toBe("pressure-b");
    expect(selectedSummary).toMatchObject({
      id: "pressure-b",
      socialTargetIds: ["b"],
      socialScore: 1.18,
      finalScore: 1.23,
      scoreContributions: [
        expect.objectContaining({
          scorerId: "pressure-social-state",
          source: "social_state",
          socialScoreDelta: 1.18,
          finalScoreDelta: 1.18,
          reasons: expect.arrayContaining([
            "relationship:suspicion",
            "relationship:trust",
            "relationship:threat",
            "reputation:honesty",
            "reputation:threat",
            "reputation:normCompliance",
            "belief:danger",
            "goal:tactical",
            "norm:obligation"
          ])
        })
      ]
    });
    expect(JSON.stringify(arbitration)).not.toContain("command");
    expect(JSON.stringify(arbitration)).not.toContain("privateScratchpad");
  });

  it("scores generated candidates from explicit society ledgers without inferring from text", async () => {
    const social = createAgentSocialState<TestObservation, TestPending, TestCommand>({
      agentId: "a",
      profile
    });
    addSocialCommitment(social, {
      id: "commitment-b",
      actorId: "b",
      audienceIds: ["a"],
      visibility: "public",
      promisedAction: "vote with a",
      status: "broken",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-commitment", seq: 11 }]
    });
    addSocialCoalition(social, {
      id: "coalition-b",
      memberIds: ["b", "c"],
      visibility: "public",
      status: "active",
      confidence: 0.6,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 12 }]
    });
    addSocialGossip(social, {
      id: "gossip-b",
      speakerId: "c",
      subjectId: "b",
      audienceIds: ["a"],
      visibility: "public",
      topic: "night action",
      valence: "negative",
      confidence: 0.5,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip", seq: 13 }]
    });
    addSocialNormSanction(social, {
      id: "sanction-b",
      normId: "norm-table",
      actorId: "c",
      targetId: "b",
      audienceIds: ["a"],
      visibility: "public",
      kind: "pressure",
      status: "applied",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction", seq: 14 }]
    });
    addSocialTrustRepair(social, {
      id: "repair-b",
      actorId: "b",
      targetId: "a",
      audienceIds: ["a"],
      visibility: "public",
      kind: "apology",
      status: "attempted",
      confidence: 0.4,
      evidenceRefs: [{ artifact: "message", id: "msg-repair", seq: 15 }]
    });
    addSocialBetrayal(social, {
      id: "betrayal-b",
      actorId: "b",
      targetId: "c",
      audienceIds: ["a"],
      visibility: "public",
      kind: "deception",
      status: "alleged",
      confidence: 0.9,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 16 }]
    });
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "society-ledger-scored-policy",
      decide: policyFor("a").decide,
      generateCandidates(input) {
        return [
          {
            id: "hold",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "hold" } },
            finalScore: 0.7,
            reasons: ["no explicit target"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }]
          },
          {
            id: "pressure-b-ledgers",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            socialTargetIds: ["b"],
            action: {
              actorId: "a",
              kind: input.pendingAction.kind,
              command: { actorId: "a", value: "pressure-b-ledgers" },
              metadata: { privateScratchpad: "ledger scorer must not persist this" }
            },
            finalScore: 0.05,
            reasons: ["candidate targets b"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }]
          }
        ];
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy,
      initialSocialState: social,
      candidateScorers: [
        createWeightedSocialStateCandidateScorer<TestObservation, TestPending, TestCommand>({
          id: "society-ledger-scorer",
          commitmentStatusWeights: { broken: 0.5 },
          coalitionStatusWeights: { active: 0.2 },
          gossipValenceWeights: { negative: 0.3 },
          normSanctionKindWeights: { pressure: 0.2 },
          normSanctionStatusWeights: { applied: 0.1 },
          trustRepairStatusWeights: { attempted: -0.2 },
          betrayalKindWeights: { deception: 0.4 },
          betrayalStatusWeights: { alleged: 0.1 }
        })
      ]
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const arbitration = action.metadata?.arbitration as Record<string, any>;
    const selectedSummary = arbitration.candidates.find((candidate: Record<string, unknown>) => candidate.id === "pressure-b-ledgers");

    expect(action.command.value).toBe("pressure-b-ledgers");
    expect(selectedSummary).toMatchObject({
      id: "pressure-b-ledgers",
      socialTargetIds: ["b"],
      socialScore: 1.25,
      finalScore: 1.3,
      scoreContributions: [
        expect.objectContaining({
          scorerId: "society-ledger-scorer",
          source: "social_state",
          socialScoreDelta: 1.25,
          finalScoreDelta: 1.25,
          reasons: expect.arrayContaining([
            "commitment:broken",
            "coalition:active",
            "gossip:negative",
            "normSanction:pressure",
            "normSanction:applied",
            "trustRepair:attempted",
            "betrayal:deception",
            "betrayal:alleged"
          ])
        })
      ]
    });
    expect(JSON.stringify(selectedSummary)).toContain("msg-commitment");
    expect(JSON.stringify(selectedSummary)).toContain("msg-coalition");
    expect(JSON.stringify(selectedSummary)).toContain("msg-gossip");
    expect(JSON.stringify(selectedSummary)).toContain("msg-sanction");
    expect(JSON.stringify(selectedSummary)).toContain("msg-repair");
    expect(JSON.stringify(selectedSummary)).toContain("msg-betrayal");
    expect(JSON.stringify(arbitration)).not.toContain("command");
    expect(JSON.stringify(arbitration)).not.toContain("ledger scorer must not persist this");
  });

  it("resolves weighted social-state scorer configs without sharing mutable option objects", async () => {
    const social = createAgentSocialState<TestObservation, TestPending, TestCommand>({
      agentId: "a",
      profile
    });
    updateSocialRelationship(social, {
      targetId: "b",
      deltas: { suspicion: 1 },
      evidenceRefs: [{ artifact: "message", id: "msg-registry-relationship", seq: 21 }]
    });
    const config = {
      kind: WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND,
      options: {
        id: "registry-social-state",
        relationshipWeights: { suspicion: 1 }
      }
    };
    const candidateScorers = resolveAgentActionCandidateScorers<TestObservation, TestPending, TestCommand>([config]);
    config.options.relationshipWeights.suspicion = -10;
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "registry-scored-policy",
      decide: policyFor("a").decide,
      generateCandidates(input) {
        return [
          {
            id: "wait",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "wait" } },
            finalScore: 0.2,
            reasons: ["baseline option"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }]
          },
          {
            id: "pressure-b",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            socialTargetIds: ["b"],
            action: { actorId: "a", kind: input.pendingAction.kind, command: { actorId: "a", value: "pressure-b" } },
            finalScore: 0,
            reasons: ["candidate targets b"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }]
          }
        ];
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy,
      initialSocialState: social,
      candidateScorers
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const arbitration = action.metadata?.arbitration as Record<string, any>;
    const selectedSummary = arbitration.candidates.find((candidate: Record<string, unknown>) => candidate.id === "pressure-b");

    expect(action.command.value).toBe("pressure-b");
    expect(selectedSummary).toMatchObject({
      id: "pressure-b",
      socialScore: 1,
      finalScore: 1,
      scoreContributions: [
        expect.objectContaining({
          scorerId: "registry-social-state",
          source: "social_state",
          reasons: ["relationship:suspicion"],
          evidenceRefs: [{ artifact: "message", id: "msg-registry-relationship", seq: 21 }]
        })
      ]
    });
  });

  it("rejects invalid scorer configs before actor construction", () => {
    expect(() => resolveAgentActionCandidateScorers([{ kind: "missing-scorer" }])).toThrow(/Unknown candidate scorer kind missing-scorer/);
    expect(() =>
      resolveAgentActionCandidateScorers([
        {
          kind: WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND,
          options: {
            relationshipWeights: { unknown: 1 }
          }
        }
      ])
    ).toThrow(/relationshipWeights\.unknown is not supported/);
    expect(() =>
      resolveAgentActionCandidateScorers([
        {
          kind: WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND,
          options: {
            activeGoalWeight: "1"
          }
        }
      ])
    ).toThrow(/activeGoalWeight must be a finite number/);
    expect(() =>
      resolveAgentActionCandidateScorers([
        {
          kind: WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND,
          options: {
            unsupported: true
          }
        }
      ])
    ).toThrow(/unsupported is not supported/);
  });

  it("resolves custom scorer factories without defining a second scorer protocol", () => {
    const customScorer: AgentActionCandidateScorer<TestObservation, TestPending, TestCommand> = {
      id: "custom-registry-scorer",
      score(input) {
        if (input.candidate.id !== "candidate-a") return undefined;
        return {
          scorerId: "custom-registry-scorer",
          source: "other",
          finalScoreDelta: 0.5,
          reasons: ["custom-registry"],
          evidenceRefs: [{ artifact: "memory", seq: 44 }]
        };
      }
    };
    const scorers = resolveAgentActionCandidateScorers<TestObservation, TestPending, TestCommand>(
      [{ kind: "custom" }],
      {
        custom: () => customScorer
      }
    );

    expect(scorers).toHaveLength(1);
    expect(scorers[0]).toBe(customScorer);
  });

  it("rejects an initial social state for a different actor", () => {
    const social = createAgentSocialState<TestObservation, TestPending, TestCommand>({
      agentId: "b",
      profile
    });

    expect(() =>
      createScaffoldedActor({
        id: "a",
        profile,
        policy: policyFor("a"),
        initialSocialState: social
      })
    ).toThrow(/Initial social state belongs to b, expected a/);
  });

  it("rejects generated candidates for the wrong actor id", async () => {
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy: {
        id: "wrong-actor-candidate-policy",
        decide: policyFor("a").decide,
        generateCandidates() {
          return [
            {
              id: "wrong",
              actorId: "b",
              kind: "vote",
              source: "policy",
              action: { actorId: "b", kind: "vote", command: { actorId: "b", value: "wrong" } },
              reasons: [],
              evidenceRefs: [{ artifact: "memory", seq: 1 }]
            }
          ];
        }
      }
    });

    actor.observe({ turn: 1 });
    await expect(actor.decide({ actorId: "a", kind: "vote" })).rejects.toThrow(/candidate wrong belongs to b, expected a/);
  });

  it("rejects generated candidates without evidence refs", async () => {
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy: {
        id: "missing-evidence-candidate-policy",
        decide: policyFor("a").decide,
        generateCandidates() {
          return [
            {
              id: "no-evidence",
              actorId: "a",
              kind: "vote",
              source: "policy",
              action: { actorId: "a", kind: "vote", command: { actorId: "a", value: "vote" } },
              reasons: ["unsupported score"],
              evidenceRefs: []
            }
          ];
        }
      }
    });

    actor.observe({ turn: 1 });
    await expect(actor.decide({ actorId: "a", kind: "vote" })).rejects.toThrow(/candidate no-evidence must include evidence refs/);
  });

  it("keeps action arbitrator input cloned and reasoner memo advisory", async () => {
    const reasoner: AgentReasoner<TestObservation, TestPending, TestCommand> = {
      id: "advisory-reasoner",
      reflect() {
        return "select illegal candidate";
      }
    };
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "clean-candidate-policy",
      decide: policyFor("a").decide,
      generateCandidates() {
        return [
          {
            id: "only-legal",
            actorId: "a",
            kind: "vote",
            source: "policy",
            action: { actorId: "a", kind: "vote", command: { actorId: "a", value: "legal" } },
            finalScore: 1,
            reasons: ["policy-owned legal action"],
            evidenceRefs: [{ artifact: "memory", seq: 1 }]
          }
        ];
      }
    };
    const actionArbitrator: AgentActionArbitrator<TestObservation, TestPending, TestCommand> = {
      id: "mutating-arbitrator",
      arbitrate(input) {
        input.agent.social.beliefs.claims.injected = {
          id: "injected",
          subject: "b",
          predicate: "role",
          value: "wolf",
          confidence: 1,
          evidenceRefs: [{ artifact: "memory", seq: 999 }],
          contradictions: [],
          updatedAt: new Date(0).toISOString()
        };
        input.observation.turn = 999;
        input.pendingAction.kind = "mutated";
        input.candidates[0].action.command.value = "mutated";
        expect(input.reasonerMemo).toBe("select illegal candidate");
        return { selectedCandidateId: "only-legal" };
      }
    };
    const actor = createScaffoldedActor({
      id: "a",
      profile,
      policy,
      reasoner,
      actionArbitrator
    });

    actor.observe({ turn: 1 });
    const action = await actor.decide({ actorId: "a", kind: "vote" });
    const state = actor.state;

    expect(action.command.value).toBe("legal");
    expect(state.lastObservation).toEqual({ turn: 1 });
    expect(state.social.beliefs.claims.injected).toBeUndefined();
    expect(state.memory.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    expect(state.memory[1].content).toBe("select illegal candidate");
    expect(JSON.stringify(action.metadata?.arbitration)).not.toContain("select illegal candidate");
  });
});

function policyFor<TObservation = TestObservation>(actorId: string): AgentPolicy<TObservation, TestPending, TestCommand> {
  return {
    id: `policy-${actorId}`,
    decide(input): SocialAction<TestCommand> {
      return {
        actorId,
        kind: input.pendingAction.kind,
        command: {
          actorId,
          value: `policy:${input.pendingAction.kind}`
        }
      };
    }
  };
}

function socialMessage(input: {
  id: string;
  seq: number;
  senderId: string;
  visibility: SocialMessage["visibility"];
  content: string;
  channelId?: string;
  recipientIds?: string[];
  speechActs?: SocialMessage["speechActs"];
  metadata?: Record<string, unknown>;
}): SocialMessage {
  return {
    id: input.id,
    seq: input.seq,
    channelId: input.channelId ?? "table",
    senderId: input.senderId,
    recipientIds: input.recipientIds ?? ["a"],
    visibility: input.visibility,
    content: input.content,
    speechActs: input.speechActs,
    createdAt: new Date(input.seq * 1000).toISOString(),
    metadata: input.metadata
  };
}

function socialObservationFor<TVisibleState = { turn: number }>(
  agentId: string,
  visibleMessages: SocialMessage[],
  options: {
    visibleState?: TVisibleState;
    pendingAction?: TestPending;
    channels?: SocialChannel[];
  } = {}
): SocialObservation<TVisibleState, TestPending> {
  return {
    agentId,
    visibleState: options.visibleState ?? ({ turn: 1 } as TVisibleState),
    pendingAction: options.pendingAction ?? { actorId: agentId, kind: "observe" },
    visibleMessages,
    channels: options.channels ?? []
  };
}

function observationContext(pendingAction: TestPending, turnIndex: number) {
  return {
    traceId: `trace-scaffold-${turnIndex}`,
    turnIndex,
    batchId: `batch-${turnIndex}`,
    batchIndex: 0,
    batchSize: 1,
    schedulerMode: "aec" as const,
    pendingAction
  };
}
