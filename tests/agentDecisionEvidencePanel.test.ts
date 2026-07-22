import { describe, expect, it } from "vitest";
import { buildAgentDecisionEvidenceView, buildDecisionJournalEvidence } from "../src/components/cockpit/AgentDecisionEvidencePanel";
import type { RedactedHarnessStepDto, RedactedSocialStepDto } from "../src/server/artifactProjection";

describe("agent decision evidence projection", () => {
  it("whitelists only recorded safe decision evidence and never forwards private fields", () => {
    const native = {
      traceId: "trace-1",
      actorId: "p1",
      pendingAction: { kind: "seer.inspect", redacted: true },
      action: {
        kind: "inspect",
        command: { type: "seer.inspect", redacted: true },
        messages: [{ content: "must-not-render" }, { content: "also-private" }]
      },
      schedulerMode: "aec",
      decisionStateHash: "decision-hash",
      preStateHash: "pre-hash",
      postStateHash: "post-hash",
      actorSnapshotsHashAfterStep: "snapshot-hash",
      observation: "[REDACTED private social observation]",
      infosByAgent: { p1: { private: "must-not-render" } }
    } as unknown as RedactedSocialStepDto;
    const legacy = {
      traceId: "trace-1",
      model: "model-a",
      policyPlan: {
        policyName: "balanced",
        confidence: 0.8,
        strategyTags: ["evidence-led"],
        intent: "must-not-render",
        targetId: "p2",
        arbitration: { candidates: [{ targetId: "p2", reasons: ["private"] }] }
      },
      reasonerOutput: {
        content: "must-not-render",
        latencyMs: 123,
        promptTokens: 10,
        completionTokens: 20,
        providerRequestId: "must-not-render"
      },
      turnTrace: { privateMemo: "must-not-render" },
      actionArbitration: {
        version: "agent.action-arbitration.v1",
        arbitrator: "default-score-arbitrator",
        candidateCount: 2,
        decisionRule: "highest_final_score_then_candidate_id",
        selectedCandidateOrdinal: 1,
        selectedCandidateSource: "reasoner",
        selectedCandidateId: "candidate-secret-id",
        candidates: [
          {
            ordinal: 0,
            source: "policy",
            kind: "inspect",
            selected: false,
            baseScore: 0.6,
            finalScore: 0.6,
            scoreContributionCount: 0,
            evidenceCount: 2,
            messageCount: 0,
            id: "policy-target-p2",
            reasons: ["private-candidate-reason"]
          },
          {
            ordinal: 1,
            source: "reasoner",
            kind: "inspect",
            selected: true,
            baseScore: 0.9,
            finalScore: 0.9,
            scoreContributionCount: 1,
            evidenceCount: 2,
            messageCount: 0,
            id: "reasoner-target-p3",
            evidenceRefs: [{ id: "private-receipt-id" }]
          }
        ]
      }
    } as unknown as RedactedHarnessStepDto;

    const view = buildAgentDecisionEvidenceView(native, legacy);

    expect(view).toMatchObject({
      availability: "trace-linked-compatibility",
      traceId: "trace-1",
      pendingKind: "seer.inspect",
      proposal: { commandType: "seer.inspect", messageDraftCount: 2 },
      policy: { name: "balanced", confidence: 0.8, strategyTags: ["evidence-led"] },
      arbitration: {
        candidateCount: 2,
        selectedCandidateOrdinal: 1,
        selectedCandidateSource: "reasoner",
        candidates: [
          { ordinal: 0, source: "policy", selected: false, finalScore: 0.6 },
          { ordinal: 1, source: "reasoner", selected: true, finalScore: 0.9 }
        ]
      },
      cognition: { source: "reasoner", model: "model-a", latencyMs: 123, promptTokens: 10, completionTokens: 20 },
      receipt: { status: "committed", decisionStateHash: "decision-hash" }
    });
    const serialized = JSON.stringify(view);
    for (const privateValue of [
      "must-not-render",
      "p2",
      "private-candidate-reason",
      "candidate-secret-id",
      "policy-target-p2",
      "reasoner-target-p3",
      "private-receipt-id",
      "providerRequestId",
      "infosByAgent"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("does not invent policy or reasoner evidence when no committed legacy decision is linked", () => {
    const native = {
      traceId: "system-trace",
      actorId: "system",
      pendingAction: { kind: "system.advance", redacted: true },
      action: { kind: "advance", command: { type: "system.advance", redacted: true } },
      schedulerMode: "aec",
      failure: { stage: "environment", message: "[REDACTED social step failure detail]" }
    } as unknown as RedactedSocialStepDto;

    const view = buildAgentDecisionEvidenceView(native, null);

    expect(view).toMatchObject({
      availability: "native-only",
      policy: undefined,
      cognition: undefined,
      receipt: { status: "rejected", failureStage: "environment" }
    });
  });

  it("keeps policy-only cognition as provenance without inventing a model call", () => {
    const native = {
      traceId: "policy-trace",
      actorId: "p1",
      pendingAction: { kind: "speech.submit", redacted: true },
      action: { kind: "speak", command: { type: "speech.submit", redacted: true } },
      schedulerMode: "aec"
    } as unknown as RedactedSocialStepDto;
    const legacy = {
      traceId: "policy-trace",
      model: "assigned-but-not-called",
      policyPlan: { policyName: "balanced", confidence: 0.8, strategyTags: [] },
      reasonerOutput: { content: "[REDACTED deterministic policy memo]", cognitionSource: "policy", latencyMs: 0, attempts: 99 },
      turnTrace: { cognitionSource: "policy" }
    } as unknown as RedactedHarnessStepDto;

    expect(buildAgentDecisionEvidenceView(native, legacy).cognition).toEqual({ source: "policy" });
  });

  it("keeps only content-free journal identity fields for the exact actor and trace", () => {
    const journal = buildDecisionJournalEvidence(
      [
        {
          journalSeq: 3,
          agentId: "p1",
          traceId: "trace-1",
          turnIndex: 2,
          store: "relationships",
          mutationKind: "relationship.updated",
          subjectId: "p2",
          evidenceRefs: [{ id: "safe-ref", description: "must-not-render" }],
          beforeSummary: { trust: 0 },
          afterSummary: { trust: 1 },
          metadata: { private: "must-not-render" }
        },
        {
          journalSeq: 2,
          agentId: "p1",
          traceId: "different-trace",
          store: "memory",
          mutationKind: "memory.appended"
        },
        {
          journalSeq: 1,
          agentId: "p2",
          traceId: "trace-1",
          store: "memory",
          mutationKind: "memory.appended"
        }
      ],
      "p1",
      "trace-1"
    );

    expect(journal).toEqual([
      {
        journalSeq: 3,
        turnIndex: 2,
        store: "relationships",
        mutationKind: "relationship.updated",
        subjectId: "p2",
        evidenceCount: 1,
        messageSeqRange: undefined,
        eventSeqRange: undefined
      }
    ]);
    expect(JSON.stringify(journal)).not.toContain("must-not-render");
  });
});
