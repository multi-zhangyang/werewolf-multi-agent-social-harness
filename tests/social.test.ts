import { describe, expect, it } from "vitest";
import { replaySocialEpisode } from "../src/harness/replay";
import {
  countSocialStepCommits,
  countSocialStepCommitsByActor,
  deriveSocialExposureRecords,
  isSocialStepCommitted,
  runSocialEpisode,
  SocialCommunicationBus,
  validateSocialEpisodeArtifact,
  type SocialAction,
  type SocialActor,
  type SocialActorStepReceipt,
  type SocialAgentProfile,
  type SocialChannel,
  type SocialDecisionFailureStage,
  type SocialEnvironment,
  type SocialMessage,
  type SocialParallelEnvironment,
  type SocialStepFeedback
} from "../src/harness/social";
import { createScaffoldedActor, type AgentPolicy } from "../src/harness/scaffold";

interface TestState {
  tick: number;
  done: boolean;
  log: string[];
}

interface TestPending {
  actorId?: string;
  kind: string;
}

interface TestObservation {
  agentId: string;
  tick: number;
  pendingKind: string;
  visibleMessages?: SocialMessage[];
  channels?: SocialChannel[];
}

interface TestCommand {
  actorId: string;
  value: string;
  terminate?: boolean;
  truncate?: boolean;
}

const tableChannel: SocialChannel = {
  id: "table",
  kind: "public",
  participantIds: ["a", "b", "system"],
  readableBy: "all"
};


describe("isSocialStepCommitted", () => {
  it("treats committed and legacy no-error steps as committed", () => {
    expect(isSocialStepCommitted({ commitStatus: "committed" })).toBe(true);
    expect(isSocialStepCommitted({})).toBe(true);
    expect(isSocialStepCommitted({ commitStatus: "rejected" })).toBe(false);
    expect(isSocialStepCommitted({ error: "failed" })).toBe(false);
  });
});

describe("countSocialStepCommits", () => {
  it("counts committed and rejected native steps without inventing progress", () => {
    expect(
      countSocialStepCommits([
        { commitStatus: "committed" },
        { commitStatus: "rejected", error: "illegal" },
        {},
        { error: "failed" }
      ])
    ).toEqual({
      nativeSteps: 4,
      committedSteps: 2,
      rejectedSteps: 2
    });
  });

  it("returns zeros for an empty step list", () => {
    expect(countSocialStepCommits([])).toEqual({
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    });
  });
});

describe("countSocialStepCommitsByActor", () => {
  it("counts non-system actor steps by commit status", () => {
    expect(
      Object.fromEntries(
        countSocialStepCommitsByActor([
          { actorId: "system", commitStatus: "committed" },
          { actorId: "p1", commitStatus: "committed" },
          { actorId: "p1", commitStatus: "rejected", error: "illegal" },
          { actorId: "p2", error: "failed" },
          { actorId: "p2" }
        ])
      )
    ).toEqual({
      p1: { nativeSteps: 2, committedSteps: 1, rejectedSteps: 1 },
      p2: { nativeSteps: 2, committedSteps: 1, rejectedSteps: 1 }
    });
  });

  it("returns an empty map for only system or empty steps", () => {
    expect(countSocialStepCommitsByActor([])).toEqual(new Map());
    expect(
      countSocialStepCommitsByActor([{ actorId: "system", commitStatus: "committed" }])
    ).toEqual(new Map());
  });
});


describe("generic social harness scheduler contract", () => {
  it("runs AEC as a single selected actor per environment transition", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 2 });
    const actorA = new TestActor("a");
    const actorB = new TestActor("b");

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-aec",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("truncated");
    expect(artifact.truncationReason).toContain("maxTransitions 1");
    expect(environment.stepCalls).toBe(1);
    expect(actorA.observations).toHaveLength(1);
    expect(actorB.observations).toHaveLength(0);
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "a",
      schedulerMode: "aec",
      atomic: false,
      resolutionPolicy: "sequential-apply"
    });
    expect(artifact.steps[0].preStateHash).toBe(hashState({ tick: 0, done: false, log: [] }));
    expect(artifact.steps[0].postStateHash).toBe(hashState({ tick: 1, done: false, log: ["a"] }));
    expect(artifact.steps[0].eventSeqRange).toEqual([1, 1]);
  });

  it("records scaffold action arbitration summaries on social harness steps", async () => {
    const environment = new RecordingEnvironment({
      pending: [{ actorId: "a", kind: "act" }],
      doneAfterSteps: 1
    });
    const policy: AgentPolicy<TestObservation, TestPending, TestCommand> = {
      id: "scaffold-candidate-policy",
      decide(input) {
        return {
          actorId: "a",
          kind: input.pendingAction.kind,
          command: { actorId: "a", value: "legacy" }
        };
      },
      generateCandidates(input) {
        return [
          {
            id: "observe",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "policy",
            action: {
              actorId: "a",
              kind: input.pendingAction.kind,
              command: { actorId: "a", value: "observe" }
            },
            finalScore: 0.1,
            reasons: ["wait for more evidence"],
            evidenceRefs: [{ artifact: "observation", seq: 1 }]
          },
          {
            id: "selected-pressure",
            actorId: "a",
            kind: input.pendingAction.kind,
            source: "relationship",
            action: {
              actorId: "a",
              kind: input.pendingAction.kind,
              command: { actorId: "a", value: "selected-pressure", terminate: true },
              metadata: { actionTag: "selected-action" }
            },
            finalScore: 1.2,
            reasons: ["relationship evidence supports pressure"],
            evidenceRefs: [{ artifact: "memory", seq: 1 }],
            metadata: {
              privateScratchpad: "do not persist candidate-private text"
            }
          }
        ];
      }
    };
    const actor = createScaffoldedActor<TestObservation, TestPending, TestCommand>({
      id: "a",
      profile: { id: "a", model: "stub-model", policyId: policy.id },
      policy
    });

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-scaffold-arbitration",
      environment,
      actors: [actor],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(environment.commands).toEqual([{ actorId: "a", value: "selected-pressure", terminate: true }]);
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0].action).toMatchObject({
      actorId: "a",
      kind: "act",
      command: { actorId: "a", value: "selected-pressure", terminate: true },
      metadata: {
        actionTag: "selected-action",
        arbitration: {
          version: "agent.action-arbitration.v1",
          actorId: "a",
          policyId: "scaffold-candidate-policy",
          arbitratorId: "default-score-arbitrator",
          selectedCandidateId: "selected-pressure",
          candidateCount: 2,
          decisionRule: "highest_final_score_then_candidate_id"
        }
      }
    });
    const arbitration = artifact.steps[0].action.metadata?.arbitration as {
      candidates: Array<{ id: string; finalScore?: number; evidenceRefs: unknown[]; messageCount: number }>;
    };
    expect(arbitration.candidates).toEqual([
      expect.objectContaining({
        id: "observe",
        finalScore: 0.1,
        evidenceRefs: [{ artifact: "observation", seq: 1 }],
        messageCount: 0
      }),
      expect.objectContaining({
        id: "selected-pressure",
        finalScore: 1.2,
        evidenceRefs: [{ artifact: "memory", seq: 1 }],
        messageCount: 0
      })
    ]);
    expect(JSON.stringify(arbitration)).not.toContain("command");
    expect(JSON.stringify(arbitration)).not.toContain("privateScratchpad");
  });

  it("runs aec-batched-decision from one shared decision state but applies actions sequentially", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 2 });
    const actorA = new TestActor("a");
    const actorB = new TestActor("b");

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-batched",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "aec-batched-decision",
      maxTransitions: 4,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(artifact.schedulerMode).toBe("aec-batched-decision");
    expect(environment.stepCalls).toBe(2);
    expect(actorA.observations[0]).toMatchObject({ tick: 0 });
    expect(actorB.observations[0]).toMatchObject({ tick: 0 });
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0].decisionStateHash).toBe(artifact.steps[1].decisionStateHash);
    expect(artifact.steps.map((step) => step.batchSize)).toEqual([2, 2]);
    expect(artifact.steps.map((step) => step.resolutionPolicy)).toEqual([
      "sequential-apply-from-shared-decision-state",
      "sequential-apply-from-shared-decision-state"
    ]);
    expect(artifact.steps[0].preStateHash).toBe(hashState({ tick: 0, done: false, log: [] }));
    expect(artifact.steps[0].postStateHash).toBe(hashState({ tick: 1, done: false, log: ["a"] }));
    expect(artifact.steps[0].eventSeqRange).toEqual([1, 1]);
    expect(artifact.steps[1].preStateHash).toBe(hashState({ tick: 1, done: false, log: ["a"] }));
    expect(artifact.steps[1].postStateHash).toBe(hashState({ tick: 2, done: true, log: ["a", "b"] }));
    expect(artifact.steps[1].eventSeqRange).toEqual([2, 2]);
  });

  it("finishes a started aec-batched-decision batch when maxTransitions falls inside it", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 4 });
    const actorA = new TestActor("a");
    const actorB = new TestActor("b");

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-batched-max-transition-boundary",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "aec-batched-decision",
      maxTransitions: 3,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(artifact.truncationReason).toBeUndefined();
    expect(environment.stepCalls).toBe(4);
    expect(environment.snapshot()).toEqual({ tick: 4, done: true, log: ["a", "b", "a", "b"] });
    expect(actorA.observations.map((observation) => observation.tick)).toEqual([0, 2]);
    expect(actorB.observations.map((observation) => observation.tick)).toEqual([0, 2]);
    expect(artifact.steps).toHaveLength(4);
    expect(artifact.steps.map((step) => step.actorId)).toEqual(["a", "b", "a", "b"]);
    expect(artifact.steps.map((step) => step.turnIndex)).toEqual([1, 2, 3, 4]);
    expect(artifact.steps.map((step) => step.batchIndex)).toEqual([1, 1, 2, 2]);
    expect(artifact.steps.map((step) => step.batchSize)).toEqual([2, 2, 2, 2]);
    expect(artifact.steps[0].decisionStateHash).toBe(artifact.steps[1].decisionStateHash);
    expect(artifact.steps[2].decisionStateHash).toBe(artifact.steps[3].decisionStateHash);
    expect(artifact.steps[2].decisionStateHash).toBe(hashState({ tick: 2, done: false, log: ["a", "b"] }));
    expect(artifact.steps.map((step) => step.resolutionPolicy)).toEqual([
      "sequential-apply-from-shared-decision-state",
      "sequential-apply-from-shared-decision-state",
      "sequential-apply-from-shared-decision-state",
      "sequential-apply-from-shared-decision-state"
    ]);
    expect(artifact.steps[3].postStateHash).toBe(hashState(artifact.finalState));
  });

  it("keeps simultaneous-batch as a compatibility alias for aec-batched-decision", async () => {
    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-batched-alias",
      environment: new TestEnvironment({ doneAfterSteps: 1 }),
      actors: [new TestActor("a"), new TestActor("b")],
      schedulerMode: "simultaneous-batch",
      maxTransitions: 2,
      hashState
    });

    expect(artifact.schedulerMode).toBe("aec-batched-decision");
    expect(artifact.steps[0].schedulerMode).toBe("aec-batched-decision");
  });

  it("can resolve scheduler mode per batch without changing the episode default", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 3 });
    const actorA = new TestActor("a");
    const actorB = new TestActor("b");

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-resolved-scheduler",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "aec",
      schedulerModeForBatch: ({ state }) => (state.tick === 0 ? "aec" : "aec-batched-decision"),
      maxTransitions: 3,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(artifact.schedulerMode).toBe("aec");
    expect(artifact.steps.map((step) => step.actorId)).toEqual(["a", "a", "b"]);
    expect(artifact.steps.map((step) => step.schedulerMode)).toEqual(["aec", "aec-batched-decision", "aec-batched-decision"]);
    expect(artifact.steps.map((step) => step.resolutionPolicy)).toEqual([
      "sequential-apply",
      "sequential-apply-from-shared-decision-state",
      "sequential-apply-from-shared-decision-state"
    ]);
    expect(actorA.observations.map((observation) => observation.tick)).toEqual([0, 1]);
    expect(actorB.observations.map((observation) => observation.tick)).toEqual([1]);
    expect(artifact.steps[1].decisionStateHash).toBe(artifact.steps[2].decisionStateHash);
    expect(artifact.steps[1].preStateHash).toBe(hashState({ tick: 1, done: false, log: ["a"] }));
    expect(artifact.steps[2].preStateHash).toBe(hashState({ tick: 2, done: false, log: ["a", "a"] }));
  });

  it("rejects parallel scheduling unless the environment exposes stepBatch", async () => {
    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-parallel-missing",
      environment: new TestEnvironment({ doneAfterSteps: 1 }),
      actors: [new TestActor("a"), new TestActor("b")],
      schedulerMode: "parallel",
      hashState
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("stepBatch");
    expect(artifact.steps).toEqual([]);
  });

  it("runs true parallel through one environment stepBatch transition", async () => {
    const environment = new TestParallelEnvironment();

    const artifact = await runSocialEpisode({
      id: "social-parallel",
      environment,
      actors: [new TestActor("a"), new TestActor("b")],
      schedulerMode: "parallel",
      maxTransitions: 2,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(environment.batchCalls).toBe(1);
    expect(environment.stepCalls).toBe(0);
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.every((step) => step.atomic)).toBe(true);
    expect(artifact.steps.every((step) => step.resolutionPolicy === "parallel-stepBatch")).toBe(true);
    expect(new Set(artifact.steps.map((step) => step.preStateHash)).size).toBe(1);
    expect(new Set(artifact.steps.map((step) => step.postStateHash)).size).toBe(1);
    expect(artifact.steps.map((step) => step.eventSeqRange)).toEqual([
      [1, 1],
      [1, 1]
    ]);
    expect(artifact.steps[0].rewardsByAgent).toEqual({ a: 3, b: 3 });
    expect(artifact.steps[0].terminationReason).toBe("parallel terminal test");
  });

  it("rejects duplicate policy trace IDs in a parallel batch before stepBatch", async () => {
    const environment = new TestParallelEnvironment();
    const actorA = new TestActor("a", { traceId: "duplicate-policy-trace" });
    const actorB = new TestActor("b", { traceId: "duplicate-policy-trace" });

    const artifact = await runSocialEpisode({
      id: "social-parallel-duplicate-trace",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "parallel",
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toMatch(/duplicate native traceId duplicate-policy-trace/);
    expect(environment.stepCalls).toBe(0);
    expect(environment.batchCalls).toBe(0);
    expect(artifact.steps).toMatchObject([
      {
        actorId: "system",
        commitStatus: "rejected",
        schedulerMode: "parallel",
        resolutionPolicy: "scheduler-validation",
        failure: { stage: "trace_identity" }
      }
    ]);
    expect(actorA.receipts).toMatchObject([{ status: "rejected", actorId: "a", traceId: artifact.steps[0]?.traceId }]);
    expect(actorB.receipts).toMatchObject([{ status: "rejected", actorId: "b", traceId: artifact.steps[0]?.traceId }]);
    expect(actorA.receipts[0]?.action?.traceId).toBe("duplicate-policy-trace");
    expect(actorB.receipts[0]?.action?.traceId).toBe("duplicate-policy-trace");
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);
  });

  it("records a decision-collection failure as one complete rejected parallel batch", async () => {
    const environment = new TestParallelEnvironment();
    const actorA = new TestActor("a");
    const actorB = new TestActor("b", { decideFailure: "parallel b exploded" });

    const artifact = await runSocialEpisode({
      id: "social-parallel-decision-failure",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "parallel",
      maxTransitions: 2,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("parallel b exploded");
    expect(environment.stepCalls).toBe(0);
    expect(environment.batchCalls).toBe(0);
    expect(artifact.messages).toEqual([]);
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.map((step) => step.actorId)).toEqual(["a", "b"]);
    expect(artifact.steps.every((step) => step.commitStatus === "rejected")).toBe(true);
    expect(artifact.steps.every((step) => step.atomic === true)).toBe(true);
    expect(artifact.steps.every((step) => step.resolutionPolicy === "parallel-stepBatch")).toBe(true);
    expect(artifact.steps.map((step) => step.batchSize)).toEqual([2, 2]);
    expect(artifact.steps.map((step) => step.preStateHash)).toEqual([
      hashState({ tick: 0, done: false, log: [] }),
      hashState({ tick: 0, done: false, log: [] })
    ]);
    expect(artifact.steps.map((step) => step.failure?.stage).sort()).toEqual(["actor_decide", "batch_aborted"]);
    expect(actorA.receipts).toMatchObject([{ status: "rejected", actorId: "a" }]);
    expect(actorB.receipts).toMatchObject([{ status: "rejected", actorId: "b" }]);
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);

    const replayEnvironment = new TestParallelEnvironment();
    const replay = replaySocialEpisode({
      episode: artifact,
      environment: replayEnvironment,
      hashState,
      eventSeq,
      stopOnMismatch: false
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(2);
    expect(replayEnvironment.stepCalls).toBe(0);
    expect(replayEnvironment.batchCalls).toBe(0);

    const tampered = clone(artifact);
    tampered.steps[0].atomic = false;
    expect(validateSocialEpisodeArtifact(tampered).join("\n")).toMatch(/parallel step must be atomic/);
  });

  it("rejects duplicate pending actor ids before concurrent decision collection", async () => {
    const actorA = new TestActor("a");
    const batchedEnvironment = new TestEnvironment({
      pending: [
        { actorId: "a", kind: "act" },
        { actorId: "a", kind: "act" }
      ]
    });
    const batched = await runSocialEpisode({
      id: "social-batched-duplicate-pending-actor",
      environment: batchedEnvironment,
      actors: [actorA, new TestActor("b")],
      schedulerMode: "aec-batched-decision",
      hashState,
      eventSeq
    });

    expect(batched.status).toBe("failed");
    expect(batched.failureReason).toContain("multiple pending actions for actor a");
    expect(actorA.observations).toEqual([]);
    expect(actorA.decisions).toEqual([]);
    expect(batchedEnvironment.stepCalls).toBe(0);
    expect(batched.steps).toMatchObject([
      {
        actorId: "system",
        schedulerMode: "aec-batched-decision",
        resolutionPolicy: "scheduler-validation",
        commitStatus: "rejected",
        failure: { stage: "scheduler_validation" }
      }
    ]);
    expect(validateSocialEpisodeArtifact(batched)).toEqual([]);

    const parallelActor = new TestActor("a");
    const parallelEnvironment = new DuplicatePendingParallelEnvironment();
    const parallel = await runSocialEpisode({
      id: "social-parallel-duplicate-pending-actor",
      environment: parallelEnvironment,
      actors: [parallelActor, new TestActor("b")],
      schedulerMode: "parallel",
      hashState,
      eventSeq
    });

    expect(parallel.status).toBe("failed");
    expect(parallelActor.observations).toEqual([]);
    expect(parallelActor.decisions).toEqual([]);
    expect(parallelEnvironment.stepCalls).toBe(0);
    expect(parallelEnvironment.batchCalls).toBe(0);
    expect(parallel.steps).toMatchObject([
      {
        actorId: "system",
        schedulerMode: "parallel",
        atomic: false,
        resolutionPolicy: "scheduler-validation",
        commitStatus: "rejected"
      }
    ]);
    expect(validateSocialEpisodeArtifact(parallel)).toEqual([]);

    const replay = replaySocialEpisode({
      episode: parallel,
      environment: new DuplicatePendingParallelEnvironment(),
      hashState,
      eventSeq
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(1);
  });

  it("records every aec-batched proposal when decision collection fails", async () => {
    const environment = new TestEnvironment();
    const actorA = new TestActor("a");
    const actorB = new TestActor("b", { decideFailure: "batched b exploded" });

    const artifact = await runSocialEpisode({
      id: "social-batched-decision-failure",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "aec-batched-decision",
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("failed");
    expect(environment.stepCalls).toBe(0);
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.map((step) => step.actorId)).toEqual(["a", "b"]);
    expect(artifact.steps.every((step) => step.commitStatus === "rejected")).toBe(true);
    expect(artifact.steps.map((step) => step.failure?.stage)).toEqual(["batch_aborted", "actor_decide"]);
    expect(actorA.receipts[0]).toMatchObject({ status: "rejected", failure: { stage: "batch_aborted" } });
    expect(actorB.receipts[0]).toMatchObject({ status: "rejected", failure: { stage: "actor_decide" } });
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);

    const replay = replaySocialEpisode({
      episode: artifact,
      environment: new TestEnvironment(),
      hashState,
      eventSeq
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(2);
  });

  it("records abandoned aec-batched proposals after an earlier transition terminates the episode", async () => {
    const environment = new TestEnvironment();
    const actorA = new TestActor("a", { terminate: true });
    const actorB = new TestActor("b");

    const artifact = await runSocialEpisode({
      id: "social-batched-termination-aborts-peer",
      environment,
      actors: [actorA, actorB],
      schedulerMode: "aec-batched-decision",
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(environment.stepCalls).toBe(1);
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.map((step) => step.commitStatus)).toEqual(["committed", "rejected"]);
    expect(artifact.steps[1]).toMatchObject({
      actorId: "b",
      preStateHash: hashState({ tick: 1, done: true, log: ["a"] }),
      postStateHash: hashState({ tick: 1, done: true, log: ["a"] }),
      failure: { stage: "batch_aborted" }
    });
    expect(actorB.receipts[0]).toMatchObject({ status: "rejected", failure: { stage: "batch_aborted" } });
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);

    const replay = replaySocialEpisode({
      episode: artifact,
      environment: new TestEnvironment(),
      hashState,
      eventSeq
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(1);
    expect(replay.rejectedSteps).toBe(1);
  });

  it("isolates actor receipts from runner-owned action artifacts", async () => {
    const environment = new RecordingEnvironment({
      pending: [{ actorId: "a", kind: "act" }],
      doneAfterSteps: 1
    });
    const actor = new ReceiptMutatingActor("a");

    const artifact = await runSocialEpisode({
      id: "social-receipt-isolation",
      environment,
      actors: [actor],
      schedulerMode: "aec",
      hashState,
      eventSeq
    });

    expect(environment.commands).toEqual([{ actorId: "a", value: "a:act" }]);
    expect(artifact.steps[0]?.action.command).toEqual({ actorId: "a", value: "a:act" });
    expect(artifact.steps[0]?.action.metadata).toBeUndefined();
    expect(actor.receipts[0]?.action?.command).toMatchObject({ value: "receipt-mutated" });

    const replay = replaySocialEpisode({
      episode: artifact,
      environment: new RecordingEnvironment({
        pending: [{ actorId: "a", kind: "act" }],
        doneAfterSteps: 1
      }),
      hashState,
      eventSeq
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(1);
  });

  it("runs system transitions when no agent action is pending", async () => {
    const environment = new SystemThenAgentEnvironment();
    const actorA = new TestActor("a");

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-system-transition",
      environment,
      actors: [actorA],
      schedulerMode: "aec",
      maxTransitions: 3,
      hashState,
      eventSeq,
      systemTransition(context) {
        if (context.state.tick !== 0) return undefined;
        return {
          actorId: "system",
          profileId: "system",
          pendingAction: { kind: "advance" },
          observation: { agentId: "system", tick: context.state.tick, pendingKind: "advance" },
          action: {
            actorId: "system",
            kind: "system.advance",
            command: { actorId: "system", value: "advance" }
          }
        };
      }
    });

    expect(artifact.status).toBe("completed");
    expect(environment.stepCalls).toBe(2);
    expect(actorA.observations).toEqual([{ agentId: "a", tick: 1, pendingKind: "act" }]);
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      profileId: "system",
      schedulerMode: "aec",
      resolutionPolicy: "system-transition",
      pendingAction: { kind: "advance" },
      action: { actorId: "system", kind: "system.advance", command: { actorId: "system", value: "advance" } },
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 1, done: false, log: ["system"] }),
      eventSeqRange: [1, 1]
    });
    expect(artifact.steps[1]).toMatchObject({
      actorId: "a",
      resolutionPolicy: "sequential-apply",
      preStateHash: hashState({ tick: 1, done: false, log: ["system"] }),
      postStateHash: hashState({ tick: 2, done: true, log: ["system", "a"] }),
      eventSeqRange: [2, 2]
    });
  });
});

describe("generic social harness feedback and failure contract", () => {
  it("assembles bus-visible channels and messages into scoped actor observations", async () => {
    const table: SocialChannel = {
      id: "table",
      kind: "public",
      participantIds: ["a", "b", "c"],
      readableBy: "all"
    };
    const direct: SocialChannel = {
      id: "direct-a-b",
      kind: "private",
      participantIds: ["a", "b"],
      readableBy: "participants"
    };
    const actorA = new TestActor("a", {
      messages: [
        {
          channelId: "table",
          senderId: "a",
          recipientIds: ["b", "c"],
          visibility: "public",
          content: "public claim from a",
          speechActs: [
            {
              id: "",
              kind: "role_claim",
              subjectId: "a",
              value: "seer",
              confidence: 1,
              evidenceRefs: [],
              metadata: { source: "metadata.claimedRole", messageKind: "public-speech" }
            },
            {
              id: "",
              kind: "accusation",
              subjectId: "a",
              targetId: "c",
              value: "pressure_target",
              confidence: 0.8,
              evidenceRefs: [],
              metadata: { source: "metadata.pressureTargetId", messageKind: "public-speech" }
            }
          ],
          metadata: { kind: "public-speech", claimedRole: "seer", pressureTargetId: "c" }
        },
        {
          channelId: "direct-a-b",
          senderId: "a",
          recipientIds: ["b"],
          visibility: "private",
          content: "private claim for b"
        }
      ]
    });
    const actorB = new TestActor("b");
    const actorC = new TestActor("c");

    const artifact = await runSocialEpisode({
      id: "social-observation-assembler",
      environment: new SequencedEnvironment(["a", "b", "c"]),
      actors: [actorA, actorB, actorC],
      channels: [table, direct],
      schedulerMode: "aec",
      maxTransitions: 3,
      hashState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    expect(artifact.status).toBe("completed");
    expect(artifact.messages.map((message) => message.content)).toEqual(["public claim from a", "private claim for b"]);
    expect(artifact.steps[0].action.messages?.map((message) => message.content)).toEqual(["public claim from a", "private claim for b"]);
    expect(artifact.steps[0].messageSeqRange).toEqual([1, 2]);
    const firstStepDrafts = artifact.steps[0].action.messages ?? [];
    for (const draft of firstStepDrafts) {
      expect("id" in draft).toBe(false);
      expect("seq" in draft).toBe(false);
      expect("createdAt" in draft).toBe(false);
    }
    expect(artifact.messages[0]).toMatchObject({
      id: "msg-1",
      seq: 1,
      createdAt: expect.any(String),
      content: "public claim from a",
      speechActs: [
        expect.objectContaining({
          id: "msg-1:speech-act:1",
          kind: "role_claim",
          subjectId: "a",
          value: "seer",
          evidenceRefs: [expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 })]
        }),
        expect.objectContaining({
          id: "msg-1:speech-act:2",
          kind: "accusation",
          subjectId: "a",
          targetId: "c",
          evidenceRefs: [expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 })]
        })
      ],
      deliveryReceipts: [
        expect.objectContaining({ id: "msg-1:delivery:1:a", messageId: "msg-1", observerId: "a", visibility: "public" }),
        expect.objectContaining({ id: "msg-1:delivery:2:b", messageId: "msg-1", observerId: "b", visibility: "public" }),
        expect.objectContaining({ id: "msg-1:delivery:3:c", messageId: "msg-1", observerId: "c", visibility: "public" })
      ]
    });
    expect(artifact.messages[1]).toMatchObject({
      id: "msg-2",
      seq: 2,
      createdAt: expect.any(String),
      content: "private claim for b",
      deliveryReceipts: [
        expect.objectContaining({ id: "msg-2:delivery:1:a", messageId: "msg-2", observerId: "a", visibility: "private" }),
        expect.objectContaining({ id: "msg-2:delivery:2:b", messageId: "msg-2", observerId: "b", visibility: "private" })
      ]
    });
    expect(actorA.observations[0].visibleMessages).toHaveLength(0);
    expect(actorB.observations[0].visibleMessages?.map((message) => message.content)).toEqual(["public claim from a", "private claim for b"]);
    expect(actorB.observations[0].channels?.map((channel) => channel.id)).toEqual(expect.arrayContaining(["table", "direct-a-b"]));
    expect(actorC.observations[0].visibleMessages?.map((message) => message.content)).toEqual(["public claim from a"]);
    expect(actorC.observations[0].channels?.map((channel) => channel.id)).toEqual(["table"]);
    expect(artifact.steps[1].observation.visibleMessages?.map((message) => message.content)).toEqual(["public claim from a", "private claim for b"]);
    expect(artifact.steps[2].observation.visibleMessages?.map((message) => message.content)).toEqual(["public claim from a"]);
    const exposureRecords = deriveSocialExposureRecords(artifact);
    expect(exposureRecords.map((record) => [record.messageId, record.sourceId, record.observerId, record.visibility, record.observedAtActionKind])).toEqual([
      ["msg-1", "a", "b", "public", "act"],
      ["msg-2", "a", "b", "private", "act"],
      ["msg-1", "a", "c", "public", "act"]
    ]);
    expect(exposureRecords.every((record) => record.observedAtTraceId)).toBe(true);
    expect(exposureRecords.every((record) => record.evidenceRefs.some((ref) => ref.artifact === "message" && ref.id === record.messageId))).toBe(true);
    expect(exposureRecords.every((record) => record.deliveryReceipt?.observerId === record.observerId)).toBe(true);
    expect(exposureRecords.every((record) => record.evidenceRefs.some((ref) => ref.artifact === "delivery_receipt"))).toBe(true);
    expect(exposureRecords.some((record) => record.messageId === "msg-2" && record.observerId === "c")).toBe(false);
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);
  });

  it("does not infer domain speech acts from opaque message metadata", () => {
    const bus = new SocialCommunicationBus([tableChannel]);

    const message = bus.publish({
      channelId: "table",
      senderId: "a",
      recipientIds: ["b"],
      visibility: "public",
      content: "opaque domain action",
      metadata: {
        kind: "unrelated-domain-action",
        targetId: "b",
        claimedRole: "specialist"
      }
    });

    expect(message.speechActs).toBeUndefined();
  });

  it("normalizes generic structured social facts without recognizing a domain command", () => {
    const bus = new SocialCommunicationBus([tableChannel]);

    const message = bus.publish({
      channelId: "table",
      senderId: "a",
      recipientIds: ["b"],
      visibility: "public",
      content: "a makes a generic commitment",
      metadata: {
        socialFacts: [
          {
            id: "generic-commitment",
            kind: "commitment",
            actorId: "a",
            targetId: "b",
            stance: "support"
          }
        ]
      }
    });

    expect(message.speechActs).toEqual([
      expect.objectContaining({
        id: "msg-1:speech-act:1",
        kind: "commitment",
        subjectId: "a",
        targetId: "b",
        value: "support",
        metadata: { source: "metadata.socialFacts", factKind: "commitment", factId: "generic-commitment" },
        evidenceRefs: [expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 })]
      })
    ]);
  });

  it("restores an initial message prefix and continues message sequence numbers", async () => {
    const direct: SocialChannel = {
      id: "direct-a-b",
      kind: "private",
      participantIds: ["a", "b"],
      readableBy: "participants"
    };
    const initialMessages: SocialMessage[] = [
      {
        id: "msg-1",
        seq: 1,
        channelId: "table",
        senderId: "a",
        recipientIds: ["b", "c"],
        visibility: "public",
        content: "parent public",
        createdAt: "2026-07-04T00:00:00.001Z"
      },
      {
        id: "msg-2",
        seq: 2,
        channelId: "direct-a-b",
        senderId: "a",
        recipientIds: ["b"],
        visibility: "private",
        content: "parent private for b",
        createdAt: "2026-07-04T00:00:00.002Z"
      }
    ];
    const actorB = new TestActor("b", {
      messages: [
        {
          channelId: "table",
          senderId: "b",
          recipientIds: ["a", "c"],
          visibility: "public",
          content: "fork public from b"
        }
      ]
    });
    const actorC = new TestActor("c");

    const artifact = await runSocialEpisode({
      id: "social-initial-messages",
      environment: new SequencedEnvironment(["b", "c"]),
      actors: [actorB, actorC],
      channels: [tableChannel, direct],
      initialMessages,
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    expect(artifact.status).toBe("completed");
    expect(artifact.messages.map((message) => message.content)).toEqual(["parent public", "parent private for b", "fork public from b"]);
    expect(artifact.messages.at(-1)).toMatchObject({
      id: "msg-3",
      seq: 3,
      content: "fork public from b"
    });
    expect(artifact.steps[0].messageSeqRange).toEqual([3, 3]);
    expect(actorB.observations[0].visibleMessages?.map((message) => message.content)).toEqual(["parent public", "parent private for b"]);
    expect(actorC.observations[0].visibleMessages?.map((message) => message.content)).toEqual(["parent public", "fork public from b"]);
  });

  it("records SocialStepFeedback fields on step records", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1, returnFeedback: true });

    const artifact = await runSocialEpisode({
      id: "social-feedback",
      environment,
      actors: [new TestActor("a")],
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState
    });

    expect(artifact.status).toBe("completed");
    expect(artifact.steps[0]).toMatchObject({
      rewardsByAgent: { a: 2 },
      terminationsByAgent: { a: true },
      truncationsByAgent: { a: false },
      doneByAgent: { a: true },
      infosByAgent: { a: { tick: 1 } },
      episodeTerminated: true,
      episodeTruncated: false,
      terminationReason: "doneAfterSteps reached"
    });
  });

  it("delivers actor feedback only after the environment commits", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1 });
    const actor = new TestActor("a");

    const artifact = await runSocialEpisode({
      id: "social-before-step-hook",
      environment,
      actors: [actor],
      channels: [tableChannel],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("completed");
    expect(actor.receipts).toHaveLength(1);
    expect(actor.receipts[0]).toMatchObject({ status: "committed", actorId: "a", postStateHash: hashState(environment.snapshot()) });
    expect(environment.snapshot().log).toEqual(["a"]);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "a",
      commitStatus: "committed",
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 1, done: true, log: ["a"] }),
      eventSeqRange: [1, 1]
    });
  });

  it("returns failed artifacts for missing actor, observe failure, and decide failure", async () => {
    const missingActor = await runSocialEpisode({
      id: "social-missing-actor",
      environment: new TestEnvironment({ pending: [{ actorId: "ghost", kind: "act" }] }),
      actors: [new TestActor("a")],
      schedulerMode: "aec",
      hashState
    });
    expect(missingActor.status).toBe("failed");
    expect(missingActor.failureReason).toContain("Missing social actor ghost");
    expect(missingActor.steps[0].actorId).toBe("ghost");
    expect(missingActor.steps[0].error).toContain("Missing social actor ghost");

    const observeFailure = await runSocialEpisode({
      id: "social-observe-failure",
      environment: new TestEnvironment({ observeFailure: "observe exploded" }),
      actors: [new TestActor("a")],
      schedulerMode: "aec",
      hashState
    });
    expect(observeFailure.status).toBe("failed");
    expect(observeFailure.failureReason).toContain("observe exploded");
    expect(observeFailure.steps[0]).toMatchObject({ actorId: "a", error: "observe exploded" });

    const decideFailure = await runSocialEpisode({
      id: "social-decide-failure",
      environment: new TestEnvironment({ doneAfterSteps: 1 }),
      actors: [new TestActor("a", { decideFailure: "decide exploded" })],
      schedulerMode: "aec",
      hashState
    });
    expect(decideFailure.status).toBe("failed");
    expect(decideFailure.failureReason).toContain("decide exploded");
    expect(decideFailure.steps[0].observation).toMatchObject({ agentId: "a", tick: 0 });
  });

  it("runs decision failure hooks with trace identity for decide failures", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1 });
    const failures: Array<{
      actorId: string;
      profileId: string;
      traceId?: string;
      actorTurnIndex?: number;
      pendingAction: TestPending;
      observation?: TestObservation;
      decisionState: TestState;
      decisionStateHash?: string;
      preStateHash?: string;
      failureStage: SocialDecisionFailureStage;
      error: string;
    }> = [];

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-decision-failure-hook",
      environment,
      actors: [new TestActor("a", { decideFailure: "decide exploded" })],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      eventSeq,
      traceIdForDecision(context) {
        return `${context.id}:trace:${context.actorTurnIndex}:${context.actorId}:${context.pendingAction.kind}:${context.state.tick}`;
      },
      actorTurnIndexForDecision() {
        return 7;
      },
      onDecisionFailure(context) {
        failures.push({
          actorId: context.actorId,
          profileId: context.profileId,
          traceId: context.traceId,
          actorTurnIndex: context.actorTurnIndex,
          pendingAction: context.pendingAction,
          observation: context.observation,
          decisionState: context.decisionState,
          decisionStateHash: context.decisionStateHash,
          preStateHash: context.preStateHash,
          failureStage: context.failureStage,
          error: context.error instanceof Error ? context.error.message : String(context.error)
        });
        environment.recordTrace(`failure:${context.traceId ?? "missing-trace"}`);
      }
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("decide exploded");
    expect(failures).toEqual([
      {
        actorId: "a",
        profileId: "a",
        traceId: "social-decision-failure-hook:trace:7:a:act:0",
        actorTurnIndex: 7,
        pendingAction: { actorId: "a", kind: "act" },
        observation: { agentId: "a", tick: 0, pendingKind: "act" },
        decisionState: { tick: 0, done: false, log: [] },
        decisionStateHash: hashState({ tick: 0, done: false, log: [] }),
        preStateHash: hashState({ tick: 0, done: false, log: [] }),
        failureStage: "actor_decide",
        error: "decide exploded"
      }
    ]);
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]).toMatchObject({
      traceId: "social-decision-failure-hook:trace:7:a:act:0",
      actorId: "a",
      error: "decide exploded",
      failure: { stage: "actor_decide", message: "decide exploded" },
      observation: { agentId: "a", tick: 0, pendingKind: "act" },
      preStateHash: hashState({ tick: 0, done: false, log: [] })
    });
    expect(artifact.steps[0].postStateHash).toBe(
      hashState({
        tick: 0,
        done: false,
        log: ["trace:failure:social-decision-failure-hook:trace:7:a:act:0"]
      })
    );
    expect(artifact.steps[0].eventSeqRange).toEqual([1, 1]);
    expect(artifact.finalState).toEqual({
      tick: 0,
      done: false,
      log: ["trace:failure:social-decision-failure-hook:trace:7:a:act:0"]
    });
    expect(artifact.messages).toEqual([]);
  });

  it("computes decision trace identity before environment observe failures", async () => {
    const environment = new TestEnvironment({ observeFailure: "observe exploded" });
    const actor = new TestActor("a");
    const failures: Array<{
      traceId?: string;
      actorTurnIndex?: number;
      observation?: TestObservation;
      failureStage: SocialDecisionFailureStage;
      error: string;
    }> = [];

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-observe-failure-hook",
      environment,
      actors: [actor],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      eventSeq,
      traceIdForDecision(context) {
        return `${context.id}:trace:${context.actorTurnIndex}:${context.actorId}:${context.pendingAction.kind}:${context.state.tick}`;
      },
      actorTurnIndexForDecision() {
        return 11;
      },
      onDecisionFailure(context) {
        failures.push({
          traceId: context.traceId,
          actorTurnIndex: context.actorTurnIndex,
          observation: context.observation,
          failureStage: context.failureStage,
          error: context.error instanceof Error ? context.error.message : String(context.error)
        });
        environment.recordTrace(`observe-failure:${context.traceId ?? "missing-trace"}`);
      }
    });

    expect(actor.observations).toEqual([]);
    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("observe exploded");
    expect(failures).toEqual([
      {
        traceId: "social-observe-failure-hook:trace:11:a:act:0",
        actorTurnIndex: 11,
        observation: undefined,
        failureStage: "environment_observe",
        error: "observe exploded"
      }
    ]);
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]).toMatchObject({
      traceId: "social-observe-failure-hook:trace:11:a:act:0",
      actorId: "a",
      error: "observe exploded",
      preStateHash: hashState({ tick: 0, done: false, log: [] })
    });
    expect(artifact.steps[0].postStateHash).toBe(
      hashState({
        tick: 0,
        done: false,
        log: ["trace:observe-failure:social-observe-failure-hook:trace:11:a:act:0"]
      })
    );
    expect(artifact.steps[0].eventSeqRange).toEqual([1, 1]);
    expect(artifact.steps[0].observation).toBeUndefined();
    expect(artifact.finalState).toEqual({
      tick: 0,
      done: false,
      log: ["trace:observe-failure:social-observe-failure-hook:trace:11:a:act:0"]
    });
  });

  it("records the failed actor's decision turn slot for batched decision failures", async () => {
    const environment = new TestEnvironment();
    const actorA = new TestActor("a", {
      messages: [
        {
          channelId: "table",
          senderId: "a",
          recipientIds: ["b"],
          visibility: "public",
          content: "successful decision draft should not commit"
        }
      ]
    });
    const actorB = new TestActor("b", { decideFailure: "batched b exploded" });
    const failures: Array<{
      actorId: string;
      turnIndex: number;
      actorTurnIndex?: number;
      traceId?: string;
      batchIndex: number;
      batchSize: number;
    }> = [];

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-batched-decision-failure-hook",
      environment,
      actors: [actorA, actorB],
      channels: [tableChannel],
      schedulerMode: "aec-batched-decision",
      maxTransitions: 2,
      hashState,
      traceIdForDecision(context) {
        return `${context.id}:trace:${context.actorTurnIndex}:${context.actorId}:${context.turnIndex}:${context.pendingAction.kind}`;
      },
      actorTurnIndexForDecision(context) {
        return context.actorId === "a" ? 21 : 22;
      },
      onDecisionFailure(context) {
        failures.push({
          actorId: context.actorId,
          turnIndex: context.turnIndex,
          actorTurnIndex: context.actorTurnIndex,
          traceId: context.traceId,
          batchIndex: context.batchIndex,
          batchSize: context.batchSize
        });
      }
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("batched b exploded");
    expect(failures).toEqual([
      {
        actorId: "b",
        turnIndex: 2,
        actorTurnIndex: 22,
        traceId: "social-batched-decision-failure-hook:trace:22:b:2:act",
        batchIndex: 1,
        batchSize: 2
      }
    ]);
    expect(environment.stepCalls).toBe(0);
    expect(artifact.messages).toEqual([]);
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "a",
      schedulerMode: "aec-batched-decision",
      resolutionPolicy: "sequential-apply-from-shared-decision-state",
      batchIndex: 1,
      batchSize: 2,
      commitStatus: "rejected",
      failure: { stage: "batch_aborted" },
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 0, done: false, log: [] })
    });
    expect(artifact.steps[1]).toMatchObject({
      traceId: "social-batched-decision-failure-hook:trace:22:b:2:act",
      turnIndex: 2,
      actorId: "b",
      schedulerMode: "aec-batched-decision",
      resolutionPolicy: "sequential-apply-from-shared-decision-state",
      batchIndex: 1,
      batchSize: 2,
      error: "batched b exploded",
      observation: { agentId: "b", tick: 0, pendingKind: "act" },
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 0, done: false, log: [] })
    });
    expect(actorA.decisions).toEqual([{ actorId: "a", kind: "act" }]);
    expect(actorB.decisions).toEqual([{ actorId: "b", kind: "act" }]);
  });

  it("runs decision failure hooks with trace identity for observation assembly failures", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1 });
    const actor = new TestActor("a");
    const failures: Array<{
      traceId?: string;
      actorTurnIndex?: number;
      observation?: TestObservation;
      failureStage: SocialDecisionFailureStage;
      error: string;
    }> = [];

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-assemble-failure-hook",
      environment,
      actors: [actor],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      traceIdForDecision(context) {
        return `${context.id}:trace:${context.actorTurnIndex}:${context.actorId}:${context.pendingAction.kind}:${context.state.tick}`;
      },
      actorTurnIndexForDecision() {
        return 13;
      },
      assembleObservation() {
        throw new Error("assemble exploded");
      },
      onDecisionFailure(context) {
        failures.push({
          traceId: context.traceId,
          actorTurnIndex: context.actorTurnIndex,
          observation: context.observation,
          failureStage: context.failureStage,
          error: context.error instanceof Error ? context.error.message : String(context.error)
        });
      }
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("assemble exploded");
    expect(actor.observations).toEqual([]);
    expect(actor.decisions).toEqual([]);
    expect(environment.stepCalls).toBe(0);
    expect(artifact.messages).toEqual([]);
    expect(failures).toEqual([
      {
        traceId: "social-assemble-failure-hook:trace:13:a:act:0",
        actorTurnIndex: 13,
        observation: undefined,
        failureStage: "observation_assembly",
        error: "assemble exploded"
      }
    ]);
    expect(artifact.steps[0]).toMatchObject({
      traceId: "social-assemble-failure-hook:trace:13:a:act:0",
      actorId: "a",
      error: "assemble exploded",
      failure: { stage: "observation_assembly", message: "assemble exploded" },
      decisionStateHash: hashState({ tick: 0, done: false, log: [] }),
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 0, done: false, log: [] })
    });
    expect(artifact.steps[0].observation).toBeUndefined();
  });

  it("runs decision failure hooks with assembled observations for actor observe failures", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1 });
    const actor = new TestActor("a", { observeFailure: "actor observe exploded" });
    const failures: Array<{
      traceId?: string;
      actorTurnIndex?: number;
      observation?: TestObservation;
      error: string;
    }> = [];

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-actor-observe-failure-hook",
      environment,
      actors: [actor],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState,
      traceIdForDecision(context) {
        return `${context.id}:trace:${context.actorTurnIndex}:${context.actorId}:${context.pendingAction.kind}:${context.state.tick}`;
      },
      actorTurnIndexForDecision() {
        return 17;
      },
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      },
      onDecisionFailure(context) {
        failures.push({
          traceId: context.traceId,
          actorTurnIndex: context.actorTurnIndex,
          observation: context.observation,
          error: context.error instanceof Error ? context.error.message : String(context.error)
        });
      }
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("actor observe exploded");
    expect(actor.observations).toEqual([
      {
        agentId: "a",
        tick: 0,
        pendingKind: "act",
        visibleMessages: [],
        channels: []
      }
    ]);
    expect(actor.decisions).toEqual([]);
    expect(environment.stepCalls).toBe(0);
    expect(artifact.messages).toEqual([]);
    expect(failures).toEqual([
      {
        traceId: "social-actor-observe-failure-hook:trace:17:a:act:0",
        actorTurnIndex: 17,
        observation: {
          agentId: "a",
          tick: 0,
          pendingKind: "act",
          visibleMessages: [],
          channels: []
        },
        error: "actor observe exploded"
      }
    ]);
    expect(artifact.steps[0]).toMatchObject({
      traceId: "social-actor-observe-failure-hook:trace:17:a:act:0",
      actorId: "a",
      action: { actorId: "a", kind: "error" },
      error: "actor observe exploded",
      observation: {
        agentId: "a",
        tick: 0,
        pendingKind: "act",
        visibleMessages: [],
        channels: []
      },
      decisionStateHash: hashState({ tick: 0, done: false, log: [] }),
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 0, done: false, log: [] })
    });
  });

  it("returns failed artifact for environment step failure without committing messages", async () => {
    const actor = new TestActor("a", {
      messages: [
        {
          channelId: "table",
          senderId: "a",
          recipientIds: ["b"],
          visibility: "public",
          content: "this should not commit"
        }
      ]
    });

    const artifact = await runSocialEpisode({
      id: "social-step-failure",
      environment: new TestEnvironment({ stepFailure: "step exploded" }),
      actors: [actor, new TestActor("b")],
      channels: [tableChannel],
      schedulerMode: "aec",
      hashState
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("step exploded");
    expect(artifact.steps[0]).toMatchObject({
      actorId: "a",
      error: "step exploded"
    });
    expect(artifact.steps[0].messageSeqRange).toBeUndefined();
    expect(artifact.messages).toEqual([]);
  });

  it("runs environment step failure hooks and links hook side effects to the failed step", async () => {
    const environment = new TestEnvironment({ stepFailure: "step exploded" });
    const hookCalls: Array<{
      actorId: string;
      profileId: string;
      turnIndex: number;
      failureState: TestState;
      error: string;
    }> = [];
    const actor = new TestActor("a", {
      messages: [
        {
          channelId: "table",
          senderId: "a",
          recipientIds: ["b"],
          visibility: "public",
          content: "this draft should not commit"
        }
      ]
    });

    const artifact = await runSocialEpisode({
      id: "social-step-failure-hook",
      environment,
      actors: [actor, new TestActor("b")],
      channels: [tableChannel],
      schedulerMode: "aec",
      hashState,
      eventSeq,
      onEnvironmentStepFailure(context) {
        hookCalls.push({
          actorId: context.actorId,
          profileId: context.profileId,
          turnIndex: context.turnIndex,
          failureState: context.failureState,
          error: context.error instanceof Error ? context.error.message : String(context.error)
        });
        return { stage: "environment_step", message: String(context.error instanceof Error ? context.error.message : context.error) };
      }
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("step exploded");
    expect(hookCalls).toEqual([
      {
        actorId: "a",
        profileId: "a",
        turnIndex: 1,
        failureState: { tick: 0, done: false, log: [] },
        error: "step exploded"
      }
    ]);
    expect(environment.stepCalls).toBe(0);
    expect(artifact.messages).toEqual([]);
    expect(artifact.finalState).toEqual({
      tick: 0,
      done: false,
      log: []
    });
    expect(artifact.steps[0]).toMatchObject({
      actorId: "a",
      commitStatus: "rejected",
      error: "step exploded",
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 0, done: false, log: [] }),
      failure: { stage: "environment_step", message: "step exploded" }
    });
    expect(artifact.steps[0].eventSeqRange).toBeUndefined();
    expect(artifact.steps[0].messageSeqRange).toBeUndefined();
  });

  it("rejects invalid action messages before stepping the environment", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1 });
    const actor = new TestActor("a", {
      messages: [
        {
          channelId: "missing-channel",
          senderId: "a",
          recipientIds: ["b"],
          visibility: "public",
          content: "invalid message should reject before step"
        }
      ]
    });

    const artifact = await runSocialEpisode({
      id: "social-invalid-message",
      environment,
      actors: [actor, new TestActor("b")],
      channels: [tableChannel],
      schedulerMode: "aec",
      hashState
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("Unknown social channel missing-channel");
    expect(environment.stepCalls).toBe(0);
    expect(artifact.finalState).toEqual({ tick: 0, done: false, log: [] });
    expect(artifact.messages).toEqual([]);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "a",
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      error: expect.stringContaining("Unknown social channel missing-channel")
    });
    expect(artifact.steps[0].messageSeqRange).toBeUndefined();
  });

  it("rejects action and message drafts that impersonate a different scheduled actor", async () => {
    const impersonatingActionEnvironment = new TestEnvironment({ doneAfterSteps: 1 });
    const impersonatingAction = await runSocialEpisode({
      id: "social-action-ownership",
      environment: impersonatingActionEnvironment,
      actors: [new TestActor("a", { actionActorId: "b" }), new TestActor("b")],
      channels: [tableChannel],
      schedulerMode: "aec",
      hashState
    });

    expect(impersonatingAction.status).toBe("failed");
    expect(impersonatingActionEnvironment.stepCalls).toBe(0);
    expect(impersonatingAction.messages).toEqual([]);
    expect(impersonatingAction.steps[0]).toMatchObject({
      actorId: "a",
      commitStatus: "rejected",
      failure: { stage: "action_ownership" }
    });

    const impersonatingMessageEnvironment = new TestEnvironment({ doneAfterSteps: 1 });
    const actor = new TestActor("a", {
      messages: [
        {
          channelId: "table",
          senderId: "b",
          recipientIds: ["a"],
          visibility: "public",
          content: "a must not be able to publish as b"
        }
      ]
    });
    const impersonatingMessage = await runSocialEpisode({
      id: "social-message-ownership",
      environment: impersonatingMessageEnvironment,
      actors: [actor, new TestActor("b")],
      channels: [tableChannel],
      schedulerMode: "aec",
      hashState
    });

    expect(impersonatingMessage.status).toBe("failed");
    expect(impersonatingMessageEnvironment.stepCalls).toBe(0);
    expect(impersonatingMessage.messages).toEqual([]);
    expect(actor.receipts).toMatchObject([{ status: "rejected", actorId: "a" }]);
    expect(impersonatingMessage.steps[0]).toMatchObject({
      actorId: "a",
      commitStatus: "rejected",
      failure: { stage: "action_ownership" }
    });
  });

  it("records a non-atomic environment failure instead of treating it as replayable rejection", async () => {
    const environment = new NonAtomicFailureEnvironment();
    const actor = new TestActor("a", {
      messages: [
        {
          channelId: "table",
          senderId: "a",
          recipientIds: ["b"],
          visibility: "public",
          content: "this draft must remain uncommitted"
        }
      ]
    });
    const artifact = await runSocialEpisode({
      id: "social-non-atomic-environment",
      environment,
      actors: [actor, new TestActor("b")],
      channels: [tableChannel],
      schedulerMode: "aec",
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("failed");
    expect(environment.snapshot()).toEqual({ tick: 1, done: false, log: ["a"] });
    expect(artifact.messages).toEqual([]);
    expect(actor.receipts).toMatchObject([{ status: "rejected", actorId: "a" }]);
    expect(artifact.steps[0]).toMatchObject({
      commitStatus: "rejected",
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 1, done: false, log: ["a"] }),
      eventSeqRange: [1, 1],
      failure: { stage: "environment_non_atomic_failure" }
    });
    expect(validateSocialEpisodeArtifact(artifact).join("\n")).toMatch(/environment_non_atomic_failure/);

    const replay = replaySocialEpisode({
      episode: artifact,
      environment: new NonAtomicFailureEnvironment(),
      hashState,
      eventSeq,
      stopOnMismatch: false
    });
    expect(replay.ok).toBe(false);
    expect(replay.mismatches.join("\n")).toMatch(/non-atomic failure|rejected step changed domain state|rejected step changed event range/);
  });

  it("treats a state-mutating validateAction preflight as a non-replayable environment failure", async () => {
    const environment = new PreflightMutationEnvironment();
    const actor = new TestActor("a");
    const artifact = await runSocialEpisode({
      id: "social-mutating-preflight",
      environment,
      actors: [actor, new TestActor("b")],
      schedulerMode: "aec",
      hashState,
      eventSeq
    });

    expect(artifact.status).toBe("failed");
    expect(environment.stepCalls).toBe(0);
    expect(environment.snapshot()).toEqual({ tick: 1, done: false, log: ["preflight:a"] });
    expect(artifact.steps[0]).toMatchObject({
      commitStatus: "rejected",
      preStateHash: hashState({ tick: 0, done: false, log: [] }),
      postStateHash: hashState({ tick: 1, done: false, log: ["preflight:a"] }),
      failure: {
        stage: "environment_non_atomic_failure",
        message: expect.stringContaining("validateAction() mutated domain state")
      }
    });
    expect(actor.receipts).toMatchObject([{ status: "rejected", actorId: "a" }]);
    expect(validateSocialEpisodeArtifact(artifact).join("\n")).toMatch(/environment_non_atomic_failure/);

    const replay = replaySocialEpisode({
      episode: artifact,
      environment: new PreflightMutationEnvironment(),
      hashState,
      eventSeq,
      stopOnMismatch: false
    });
    expect(replay.ok).toBe(false);
    expect(replay.mismatches.join("\n")).toMatch(/non-atomic failure|rejected step changed domain state/);
  });

  it("keeps a committed transition committed when a post-step observer fails", async () => {
    const environment = new TestEnvironment({ doneAfterSteps: 1 });
    const actor = new TestActor("a");
    const artifact = await runSocialEpisode({
      id: "social-post-commit-hook-failure",
      environment,
      actors: [actor, new TestActor("b")],
      schedulerMode: "aec",
      hashState,
      afterEnvironmentStep() {
        throw new Error("snapshot sink exploded");
      }
    });

    expect(artifact.status).toBe("failed");
    expect(environment.stepCalls).toBe(1);
    expect(environment.snapshot()).toEqual({ tick: 1, done: true, log: ["a"] });
    expect(actor.receipts).toMatchObject([{ status: "committed", actorId: "a" }]);
    expect(artifact.steps[0]).toMatchObject({
      commitStatus: "committed",
      failure: { stage: "after_environment_step", message: "snapshot sink exploded" }
    });
  });

  it("returns failed artifact for system transition failure without committing messages", async () => {
    const systemChannel: SocialChannel = {
      id: "system",
      kind: "system",
      participantIds: [],
      readableBy: "all"
    };

    const artifact = await runSocialEpisode<TestState, TestObservation, TestPending, TestCommand>({
      id: "social-system-failure",
      environment: new SystemThenAgentEnvironment({ systemFailure: "system exploded" }),
      actors: [new TestActor("a")],
      channels: [systemChannel],
      schedulerMode: "aec",
      hashState,
      systemTransition(context) {
        return {
          actorId: "system",
          profileId: "system",
          pendingAction: { kind: "advance" },
          observation: { agentId: "system", tick: context.state.tick, pendingKind: "advance" },
          action: {
            actorId: "system",
            kind: "system.advance",
            command: { actorId: "system", value: "advance" },
            messages: [
              {
                channelId: "system",
                senderId: "system",
                recipientIds: ["a"],
                visibility: "public",
                content: "this system message should not commit"
              }
            ]
          }
        };
      }
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("system exploded");
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      resolutionPolicy: "system-transition",
      error: "system exploded"
    });
    expect(artifact.steps[0].messageSeqRange).toBeUndefined();
    expect(artifact.messages).toEqual([]);
  });
});

describe("social topology and runtime-identity authority", () => {
  it("owns initial channel topology, rejects duplicates, and prevents caller mutation", () => {
    const channel: SocialChannel = {
      id: "immutable-table",
      kind: "public",
      participantIds: ["a", "b"],
      readableBy: "all"
    };
    expect(
      () =>
        new SocialCommunicationBus([
          channel,
          { id: "immutable-table", kind: "public", participantIds: ["a"], readableBy: "all" }
        ])
    ).toThrow(/duplicate social channel/i);

    const bus = new SocialCommunicationBus([channel]);
    channel.participantIds.splice(1);
    channel.readableBy = "postgame";
    expect(bus.listChannels()).toEqual([
      { id: "immutable-table", kind: "public", participantIds: ["a", "b"], readableBy: "all" }
    ]);
  });

  it("keeps postgame channels and messages outside every live observation and rejects forged observation evidence", async () => {
    const postgameChannel: SocialChannel = {
      id: "postgame-review",
      kind: "private",
      participantIds: ["a", "b"],
      readableBy: "postgame"
    };
    const bus = new SocialCommunicationBus([postgameChannel], [], { runtimeActorIds: ["a", "b"] });
    const message = bus.publish({
      channelId: postgameChannel.id,
      senderId: "a",
      recipientIds: ["b"],
      visibility: "postgame",
      content: "hidden until the final review"
    });
    expect(message.deliveryReceipts).toBeUndefined();
    expect(bus.observe("a")).toEqual({ channels: [], messages: [] });
    expect(bus.observe("b")).toEqual({ channels: [], messages: [] });

    const artifact = await runSocialEpisode({
      id: "postgame-observation-proof",
      environment: new SequencedEnvironment(["a", "b"]),
      actors: [
        new TestActor("a", {
          messages: [
            {
              channelId: postgameChannel.id,
              senderId: "a",
              recipientIds: ["b"],
              visibility: "postgame",
              content: "recorded only for final review"
            }
          ]
        }),
        new TestActor("b")
      ],
      channels: [postgameChannel],
      schedulerMode: "aec",
      hashState,
      assembleObservation(context) {
        return { ...context.environmentObservation, visibleMessages: context.visibleSocial.messages, channels: context.visibleSocial.channels };
      }
    });
    expect(artifact.steps[1]?.observation.visibleMessages).toEqual([]);
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);
    const forged = clone(artifact);
    forged.steps[1]!.observation.visibleMessages = [forged.messages[0]!];
    expect(validateSocialEpisodeArtifact(forged).join(" ")).toMatch(/non-visible social message/i);
  });

  it("limits all-channel visibility to the immutable actor roster and records every actual public delivery", () => {
    const channel: SocialChannel = {
      id: "roster-public",
      kind: "public",
      participantIds: ["a"],
      readableBy: "all"
    };
    const bus = new SocialCommunicationBus([channel], [], { runtimeActorIds: ["a", "b"] });
    const message = bus.publish({
      channelId: channel.id,
      senderId: "a",
      recipientIds: ["a"],
      visibility: "public",
      content: "visible to the run roster"
    });
    expect(bus.observe("b").messages.map((entry) => entry.id)).toEqual([message.id]);
    expect(bus.observe("outside")).toEqual({ channels: [], messages: [] });
    expect(message.deliveryReceipts?.map((receipt) => receipt.observerId)).toEqual(["a", "b"]);
  });

  it("fails artifact validation when a canonical delivery receipt omits a runtime-visible actor", async () => {
    const channel: SocialChannel = {
      id: "receipt-public",
      kind: "public",
      participantIds: ["a"],
      readableBy: "all"
    };
    const artifact = await runSocialEpisode({
      id: "receipt-completeness",
      environment: new SequencedEnvironment(["a", "b"]),
      actors: [
        new TestActor("a", {
          messages: [
            {
              channelId: channel.id,
              senderId: "a",
              recipientIds: ["a"],
              visibility: "public",
              content: "the whole roster can observe this"
            }
          ]
        }),
        new TestActor("b")
      ],
      channels: [channel],
      schedulerMode: "aec",
      hashState
    });
    expect(validateSocialEpisodeArtifact(artifact)).toEqual([]);
    const forged = clone(artifact);
    forged.messages[0]!.deliveryReceipts = forged.messages[0]!.deliveryReceipts?.filter((receipt) => receipt.observerId === "a");
    expect(validateSocialEpisodeArtifact(forged).join(" ")).toMatch(/observer set does not match runtime visibility/i);
  });

  it("rejects message visibility that bypasses the declared communication topology", () => {
    const table: SocialChannel = { id: "table-only", kind: "public", participantIds: ["a", "b", "c"], readableBy: "all" };
    const bus = new SocialCommunicationBus([table], [], { runtimeActorIds: ["a", "b", "c"] });
    expect(() =>
      bus.publish({
        channelId: table.id,
        senderId: "a",
        recipientIds: ["b"],
        visibility: "private",
        content: "unauthorized direct message"
      })
    ).toThrow(/not compatible/i);
    expect(() =>
      bus.publish({
        channelId: table.id,
        senderId: "a",
        recipientIds: ["outside"],
        visibility: "public",
        content: "unauthorized recipient"
      })
    ).toThrow(/not allowed/i);
  });

  it("rejects empty or duplicate actor identities before any scheduler mode can mutate an environment", async () => {
    for (const schedulerMode of ["aec", "aec-batched-decision", "parallel"] as const) {
      const environment = new TestEnvironment({ doneAfterSteps: 1 });
      await expect(
        runSocialEpisode({
          id: `duplicate-actor-${schedulerMode}`,
          environment,
          actors: [new TestActor("a"), new TestActor("a")],
          schedulerMode,
          hashState
        })
      ).rejects.toThrow(/duplicate actor id/i);
      expect(environment.stepCalls).toBe(0);
    }
  });
});

class TestActor implements SocialActor<TestObservation, TestPending, TestCommand> {
  readonly profile: SocialAgentProfile;
  readonly observations: TestObservation[] = [];
  readonly decisions: TestPending[] = [];
  readonly receipts: Array<SocialActorStepReceipt<TestObservation, TestPending, TestCommand>> = [];

  constructor(
    readonly id: string,
    private readonly options: {
      decideFailure?: string;
      observeFailure?: string;
      messages?: SocialAction<TestCommand>["messages"];
      terminate?: boolean;
      actionActorId?: string;
      traceId?: string;
    } = {}
  ) {
    this.profile = { id, model: `${id}-model` };
  }

  observe(observation: TestObservation): void {
    this.observations.push(observation);
    if (this.options.observeFailure) throw new Error(this.options.observeFailure);
  }

  decide(pending: TestPending): SocialAction<TestCommand> {
    this.decisions.push(pending);
    if (this.options.decideFailure) throw new Error(this.options.decideFailure);
    const actionActorId = this.options.actionActorId ?? this.id;
    return {
      actorId: actionActorId,
      kind: pending.kind,
      traceId: this.options.traceId,
      command: {
        actorId: actionActorId,
        value: `${actionActorId}:${pending.kind}`,
        terminate: this.options.terminate
      },
      messages: this.options.messages
    };
  }

  onStepResult(receipt: SocialActorStepReceipt<TestObservation, TestPending, TestCommand>): void {
    this.receipts.push(receipt);
  }
}

class ReceiptMutatingActor extends TestActor {
  override onStepResult(receipt: SocialActorStepReceipt<TestObservation, TestPending, TestCommand>): void {
    super.onStepResult(receipt);
    if (!receipt.action) return;
    receipt.action.command.value = "receipt-mutated";
    receipt.action.metadata = { receiptMutated: true };
  }
}

class TestEnvironment implements SocialEnvironment<TestState, TestObservation, TestPending, TestCommand> {
  readonly state: TestState = { tick: 0, done: false, log: [] };
  readonly pending: TestPending[];
  readonly doneAfterSteps?: number;
  readonly returnFeedback: boolean;
  readonly observeFailure?: string;
  readonly stepFailure?: string;
  stepCalls = 0;

  constructor(options: {
    pending?: TestPending[];
    doneAfterSteps?: number;
    returnFeedback?: boolean;
    observeFailure?: string;
    stepFailure?: string;
  } = {}) {
    this.pending = options.pending ?? [
      { actorId: "a", kind: "act" },
      { actorId: "b", kind: "act" }
    ];
    this.doneAfterSteps = options.doneAfterSteps;
    this.returnFeedback = options.returnFeedback ?? false;
    this.observeFailure = options.observeFailure;
    this.stepFailure = options.stepFailure;
  }

  snapshot(): TestState {
    return clone(this.state);
  }

  pendingActions(): TestPending[] {
    return this.state.done ? [] : clone(this.pending);
  }

  observe(agentId: string, pending: TestPending): TestObservation {
    if (this.observeFailure) throw new Error(this.observeFailure);
    return { agentId, tick: this.state.tick, pendingKind: pending.kind };
  }

  step(command: TestCommand): TestState | SocialStepFeedback<TestState, TestObservation> {
    if (this.stepFailure) throw new Error(this.stepFailure);
    this.stepCalls += 1;
    this.state.tick += 1;
    this.state.log.push(command.actorId);
    if (command.terminate || (this.doneAfterSteps !== undefined && this.stepCalls >= this.doneAfterSteps)) {
      this.state.done = true;
    }
    const state = this.snapshot();
    if (!this.returnFeedback) return state;
    return {
      state,
      observationsByAgent: {
        [command.actorId]: { agentId: command.actorId, tick: state.tick, pendingKind: "next" }
      },
      rewardsByAgent: { [command.actorId]: 2 },
      terminationsByAgent: { [command.actorId]: state.done },
      truncationsByAgent: { [command.actorId]: false },
      infosByAgent: { [command.actorId]: { tick: state.tick } },
      episodeTerminated: state.done,
      episodeTruncated: false,
      terminationReason: state.done ? "doneAfterSteps reached" : undefined
    };
  }

  done(): boolean {
    return this.state.done;
  }

  recordTrace(actorId: string): void {
    this.state.log.push(`trace:${actorId}`);
  }
}

class RecordingEnvironment extends TestEnvironment {
  readonly commands: TestCommand[] = [];

  override step(command: TestCommand): TestState | SocialStepFeedback<TestState, TestObservation> {
    this.commands.push(clone(command));
    return super.step(command);
  }
}

class NonAtomicFailureEnvironment extends TestEnvironment {
  override step(command: TestCommand): TestState {
    this.stepCalls += 1;
    this.state.tick += 1;
    this.state.log.push(command.actorId);
    throw new Error("mutated before throwing");
  }
}

class PreflightMutationEnvironment extends TestEnvironment {
  validateAction(command: TestCommand) {
    this.state.tick += 1;
    this.state.log.push(`preflight:${command.actorId}`);
    return { valid: false, code: "preflight-mutated", message: "preflight mutated state" };
  }
}

class TestParallelEnvironment extends TestEnvironment implements SocialParallelEnvironment<TestState, TestObservation, TestPending, TestCommand> {
  batchCalls = 0;

  constructor() {
    super({ doneAfterSteps: 1, returnFeedback: true });
  }

  override step(): TestState {
    throw new Error("parallel test should not call step()");
  }

  stepBatch(commandsByAgent: Record<string, TestCommand>): SocialStepFeedback<TestState, TestObservation> {
    this.batchCalls += 1;
    const actorIds = Object.keys(commandsByAgent).sort();
    this.state.tick += 1;
    this.state.log.push(`batch:${actorIds.join(",")}`);
    this.state.done = true;
    const state = this.snapshot();
    return {
      state,
      observationsByAgent: Object.fromEntries(actorIds.map((actorId) => [actorId, { agentId: actorId, tick: state.tick, pendingKind: "next" }])),
      rewardsByAgent: Object.fromEntries(actorIds.map((actorId) => [actorId, 3])),
      terminationsByAgent: Object.fromEntries(actorIds.map((actorId) => [actorId, true])),
      truncationsByAgent: Object.fromEntries(actorIds.map((actorId) => [actorId, false])),
      infosByAgent: Object.fromEntries(actorIds.map((actorId) => [actorId, { batch: this.batchCalls }])),
      episodeTerminated: true,
      episodeTruncated: false,
      terminationReason: "parallel terminal test"
    };
  }
}

class DuplicatePendingParallelEnvironment extends TestParallelEnvironment {
  override pendingActions(): TestPending[] {
    if (this.state.done) return [];
    return [
      { actorId: "a", kind: "act" },
      { actorId: "a", kind: "act" }
    ];
  }
}

class SequencedEnvironment implements SocialEnvironment<TestState, TestObservation, TestPending, TestCommand> {
  readonly state: TestState = { tick: 0, done: false, log: [] };

  constructor(private readonly actorIds: string[]) {}

  snapshot(): TestState {
    return clone(this.state);
  }

  pendingActions(): TestPending[] {
    const actorId = this.actorIds[this.state.tick];
    return actorId && !this.state.done ? [{ actorId, kind: "act" }] : [];
  }

  observe(agentId: string, pending: TestPending): TestObservation {
    return { agentId, tick: this.state.tick, pendingKind: pending.kind };
  }

  step(command: TestCommand): TestState {
    this.state.log.push(command.actorId);
    this.state.tick += 1;
    this.state.done = this.state.tick >= this.actorIds.length;
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

class SystemThenAgentEnvironment implements SocialEnvironment<TestState, TestObservation, TestPending, TestCommand> {
  readonly state: TestState = { tick: 0, done: false, log: [] };
  stepCalls = 0;

  constructor(private readonly options: { systemFailure?: string } = {}) {}

  snapshot(): TestState {
    return clone(this.state);
  }

  pendingActions(): TestPending[] {
    if (this.state.done || this.state.tick === 0) return [];
    return [{ actorId: "a", kind: "act" }];
  }

  observe(agentId: string, pending: TestPending): TestObservation {
    return { agentId, tick: this.state.tick, pendingKind: pending.kind };
  }

  step(command: TestCommand): TestState {
    if (command.actorId === "system" && this.options.systemFailure) throw new Error(this.options.systemFailure);
    this.stepCalls += 1;
    this.state.log.push(command.actorId);
    this.state.tick += 1;
    if (command.actorId === "a") this.state.done = true;
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

function hashState(state: TestState): string {
  return JSON.stringify(state);
}

function eventSeq(state: TestState): number {
  return state.log.length;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
