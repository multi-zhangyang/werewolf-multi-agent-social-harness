import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runEvaluationRegistry } from "../src/harness/evaluation";
import { hashStableState } from "../src/harness/hash";
import { replaySocialEpisode } from "../src/harness/generic";
import { runHarnessEpisode } from "../src/harness/runner";
import { ScaffoldedSocialActor } from "../src/harness/scaffold";
import { createSocialStateEvaluator } from "../src/harness/socialEvaluator";
import { appendSocialMemory, createAgentSocialState } from "../src/harness/socialState";
import {
  HarnessCheckpointSelectionError,
  buildHarnessCheckpointAtPrefix,
  compactRecordedSocialAgentSnapshots,
  createHarnessAgentSnapshotFrameResolver,
  validateHarnessAgentSnapshotFrameRegistry,
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  validateHarnessEpisodeArtifactEnvelope,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope
} from "../src/harness/episodeArtifacts";
import { runForkedHarnessEpisode } from "../src/harness/checkpointRuntime";
import {
  runSocialEpisode,
  validateSocialEpisodeArtifact,
  type SocialAction,
  type SocialActor,
  type SocialActorStepReceipt,
  type SocialAgentProfile,
  type SocialChannel,
  type SocialEnvironment,
  type SocialMessage
} from "../src/harness/social";

type LedgerActorId = "a" | "b" | "c";

interface LedgerState {
  turn: number;
  done: boolean;
  entries: string[];
  secrets: Record<LedgerActorId, string>;
}

interface LedgerPending {
  actorId: LedgerActorId;
  kind: "record";
}

interface LedgerObservation {
  agentId: LedgerActorId;
  pendingKind: "record";
  turn: number;
  privateToken: string;
  visibleMessages?: SocialMessage[];
  channels?: SocialChannel[];
}

interface LedgerCommand {
  actorId: LedgerActorId;
  entry: string;
}

type LedgerMessageDraft = NonNullable<SocialAction<LedgerCommand>["messages"]>[number];

const publicChannel: SocialChannel = {
  id: "public-ledger",
  kind: "public",
  participantIds: ["a", "b", "c"],
  readableBy: "all"
};

const privateABChannel: SocialChannel = {
  id: "private-a-b",
  kind: "private",
  participantIds: ["a", "b"],
  readableBy: "participants"
};

describe("generic social harness contract", () => {
  it("keeps the reusable runner, replay, checkpoint, and public barrel free of Werewolf/core imports", () => {
    const genericModulePaths = [
      "../src/harness/generic.ts",
      "../src/harness/runner.ts",
      "../src/harness/socialReplay.ts",
      "../src/harness/episodeArtifacts.ts",
      "../src/harness/checkpointRuntime.ts"
    ];
    for (const relativePath of genericModulePaths) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/core|\.\/environment|\.\/artifacts|\.\/werewolfAdapter|\.\.\/server|\.\.\/components)/);
    }
  });

  it("keeps environment observations scoped, delivers messages by channel visibility, and replays a non-Werewolf episode", async () => {
    const actorA = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      command: { actorId: "a", entry: "opening" },
      messages: [
        message("public-ledger", "a", ["a", "b", "c"], "public", "A opens the ledger"),
        message("private-a-b", "a", ["b"], "private", "B receives a private token hint")
      ]
    }));
    const actorB = new LedgerActor("b", () => ({
      actorId: "b",
      kind: "record",
      command: { actorId: "b", entry: "reply" }
    }));
    const actorC = new LedgerActor("c", () => ({
      actorId: "c",
      kind: "record",
      command: { actorId: "c", entry: "close" }
    }));

    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-scoped-observation",
      environment: new LedgerEnvironment(),
      actors: [actorA, actorB, actorC],
      channels: [publicChannel, privateABChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    expect(episode.status).toBe("completed");
    expect(episode.finalState).toMatchObject({
      turn: 3,
      done: true,
      entries: ["a:opening", "b:reply", "c:close"]
    });
    expect(episode.steps.every((step) => step.commitStatus === "committed")).toBe(true);
    expect(validateSocialEpisodeArtifact(episode)).toEqual([]);

    expect(actorA.observations).toEqual([
      expect.objectContaining({ agentId: "a", privateToken: "token-a", visibleMessages: [] })
    ]);
    expect(actorB.observations).toEqual([
      expect.objectContaining({ agentId: "b", privateToken: "token-b" })
    ]);
    expect(actorC.observations).toEqual([
      expect.objectContaining({ agentId: "c", privateToken: "token-c" })
    ]);
    expect(actorB.observations[0]?.visibleMessages?.map((entry) => entry.content)).toEqual([
      "A opens the ledger",
      "B receives a private token hint"
    ]);
    expect(actorC.observations[0]?.visibleMessages?.map((entry) => entry.content)).toEqual(["A opens the ledger"]);
    expect(actorB.observations[0]?.channels?.map((channel) => channel.id)).toEqual(
      expect.arrayContaining(["public-ledger", "private-a-b"])
    );
    expect(actorC.observations[0]?.channels?.map((channel) => channel.id)).toEqual(["public-ledger"]);
    expect(actorC.observations[0]?.visibleMessages?.some((entry) => entry.channelId === "private-a-b")).toBe(false);

    const replay = replaySocialEpisode({
      episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });

    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedSteps).toBe(3);
    expect(replay.finalHash).toBe(hashStableState(episode.finalState));
    expect(replay.messages).toEqual(episode.messages);
  });

  it("records typed statement attributions in a non-Werewolf actor snapshot without replay-time inference", async () => {
    const speaker = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      command: { actorId: "a", entry: "typed-statement" },
      messages: [
        message("public-ledger", "a", ["a", "b", "c"], "public", "opaque typed vote intent", [
          {
            id: "ledger-vote-intent",
            kind: "vote_intent",
            targetId: "c",
            value: "ledger-target-c",
            confidence: 0.9,
            evidenceRefs: []
          }
        ])
      ]
    }));
    const observer = new ScaffoldedSocialActor<LedgerObservation, LedgerPending, LedgerCommand>({
      id: "b",
      profile: { id: "ledger-observer-b", model: "deterministic-b", policyId: "ledger-policy" },
      policy: {
        id: "ledger-policy",
        decide(input) {
          return {
            actorId: input.agent.id as LedgerActorId,
            kind: "record",
            command: { actorId: input.agent.id as LedgerActorId, entry: "observer-commit" }
          };
        }
      }
    });
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-theory-of-mind",
      environment: new LedgerEnvironment({ actorIds: ["a", "b"] }),
      actors: [speaker, observer],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const attribution = observer.state.social.theoryOfMind?.records[
      "msg-1:speech-act:ledger-vote-intent:theory-of-mind"
    ];
    expect(attribution).toMatchObject({
      observerId: "b",
      subjectId: "a",
      kind: "stated_intent",
      proposition: { predicate: "vote_intent", targetId: "c", value: "ledger-target-c" },
      sourceMessageId: "msg-1",
      sourceMessageSeq: 1,
      sourceSpeechActId: "ledger-vote-intent",
      sourceDeliveryReceiptId: "msg-1:delivery:2:b",
      visibility: "public"
    });
    expect(observer.state.social.beliefs.claims).toEqual({});
    expect(observer.state.social.journal?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "theoryOfMind",
          mutationKind: "theory_of_mind.attribution.recorded",
          hiddenTruthUsed: false
        })
      ])
    );

    const replay = replaySocialEpisode({
      episode,
      environment: new LedgerEnvironment({ actorIds: ["a", "b"] }),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
  });

  it("records a non-Werewolf episode and checkpoint through the generic artifact envelope", async () => {
    const agents = [{ id: "a", durableMemoryVersion: 1 }];
    const episode = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-generic-artifact-envelope",
      environment: new LedgerEnvironment({ actorIds: ["a"] }),
      actors: [
        new LedgerActor("a", () => ({
          actorId: "a",
          kind: "record",
          command: { actorId: "a", entry: "checkpoint-proof" }
        }))
      ],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => agents,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const envelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: "ledger-generic-artifact-envelope",
      createdAt: "2026-07-20T00:00:00.000Z",
      status: episode.status,
      initialState: episode.initialState,
      finalState: episode.finalState,
      socialEpisode: episode,
      agents
    } satisfies HarnessEpisodeArtifactEnvelope<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, (typeof agents)[number]>;
    expect(validateHarnessEpisodeArtifactEnvelope(envelope)).toEqual([]);

    const lastStep = episode.steps.at(-1);
    if (!lastStep) throw new Error("Expected ledger episode to record one native step.");
    const checkpoint = {
      artifactVersion: "ledger.checkpoint.v1",
      kind: "ledger-checkpoint",
      checkpointId: "ledger-checkpoint-1",
      createdAt: "2026-07-20T00:00:01.000Z",
      source: {
        sourceArtifactVersion: envelope.artifactVersion,
        runId: envelope.runId,
        status: episode.status,
        boundaryTraceId: lastStep.traceId,
        boundaryTurnIndex: lastStep.turnIndex,
        boundaryBatchId: lastStep.batchId,
        boundaryBatchIndex: lastStep.batchIndex,
        boundarySchedulerMode: lastStep.schedulerMode,
        nativeStepCount: episode.steps.length,
        messageCount: episode.messages.length,
        lastMessageSeq: episode.messages.at(-1)?.seq,
        stateHash: hashStableState(episode.finalState),
        executionPrefixHash: hashStableState(episode),
        agentsHash: hashStableState(agents),
        channelsHash: hashStableState(episode.channels),
        messagesHash: hashStableState(episode.messages)
      },
      state: episode.finalState,
      agents,
      executionPrefix: episode
    } satisfies HarnessCheckpointEnvelope<LedgerState, (typeof agents)[number], LedgerObservation, LedgerPending, LedgerCommand>;

    expect(validateHarnessCheckpointEnvelope(checkpoint)).toEqual([]);
    expect(
      validateHarnessCheckpointReplay(checkpoint, (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment({ actorIds: ["a"] }),
          hashState: hashStableState,
          hashMessages: hashStableState
        })
      )
    ).toEqual([]);

    const tampered = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    tampered.source.messagesHash = "tampered";
    expect(validateHarnessCheckpointEnvelope(tampered).join(" ")).toMatch(/source\.messagesHash mismatch/);

    const forgedActorState = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    forgedActorState.agents = [{ id: "forged", durableMemoryVersion: 999 }];
    forgedActorState.source.agentsHash = hashStableState(forgedActorState.agents);
    expect(validateHarnessCheckpointEnvelope(forgedActorState).join(" ")).toMatch(/does not match final boundary actor snapshot hash/i);

    let environmentRestores = 0;
    let actorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint: forgedActorState,
        runtime: {
          createEnvironment(initialState) {
            environmentRestores += 1;
            return new LedgerEnvironment({ initialState, actorIds: ["a"] });
          },
          restoreActors(agentStates) {
            actorRestores += 1;
            return agentStates.map((agent) => new LedgerActor(agent.id as LedgerActorId, () => ({
              actorId: agent.id as LedgerActorId,
              kind: "record",
              command: { actorId: agent.id as LedgerActorId, entry: "forbidden" }
            })));
          }
        },
        verifyCheckpointReplay: () => [],
        episode: {
          id: "ledger-forged-checkpoint-fork",
          schedulerMode: "aec",
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/final boundary actor snapshot hash/i);
    expect(environmentRestores).toBe(0);
    expect(actorRestores).toBe(0);
  });

  it("builds a generic native-prefix checkpoint, replays it without actors, and executes a restored non-Werewolf fork", async () => {
    const parentActors = new Map<LedgerActorId, CheckpointLedgerActor>(
      (["a", "b", "c"] as LedgerActorId[]).map((id) => [id, new CheckpointLedgerActor(id, `parent-${id}`)])
    );
    const parent = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-generic-prefix-parent",
      environment: new LedgerEnvironment(),
      actors: [...parentActors.values()],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => [...parentActors.values()].map((actor) => actor.snapshot())
    });
    const parentReplay = replaySocialEpisode({
      episode: parent,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(parentReplay.ok).toBe(true);
    expect(parentReplay.agentStateAudit).toMatchObject({ ok: true, checkedNativeSteps: 3, checkedSnapshots: 3 });

    const compacted = compactRecordedSocialAgentSnapshots<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerCheckpointActorState
    >({ episode: parent });
    const parentAgentStates = [...parentActors.values()].map((actor) => actor.snapshot());
    expect(parent.steps.every((step) => Array.isArray(step.actorSnapshotsAfterStep))).toBe(true);
    expect(compacted.episode.steps.every((step) => step.actorSnapshotsAfterStep === undefined)).toBe(true);
    expect(compacted.episode.steps.every((step) => Boolean(step.actorSnapshotsHashAfterStep && step.actorSnapshotFrameIdAfterStep))).toBe(true);
    expect(compacted.frames).toHaveLength(3);
    expect(
      validateHarnessAgentSnapshotFrameRegistry({
        episode: compacted.episode,
        frames: compacted.frames,
        finalAgents: parentAgentStates
      })
    ).toMatchObject({ ok: true, checkedNativeSteps: 3, checkedSnapshots: 3, mismatches: [] });
    const compactedEnvelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: parent.id,
      createdAt: "2026-07-21T00:30:00.000Z",
      status: compacted.episode.status,
      initialState: compacted.episode.initialState,
      finalState: compacted.episode.finalState,
      socialEpisode: compacted.episode,
      agents: parentAgentStates,
      agentSnapshotFrames: compacted.frames
    } satisfies HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      LedgerCheckpointActorState
    >;
    expect(validateHarnessEpisodeArtifactEnvelope(compactedEnvelope)).toEqual([]);
    const rawInlineEnvelope = {
      ...compactedEnvelope,
      socialEpisode: parent,
      agentSnapshotFrames: undefined
    };
    expect(validateHarnessEpisodeArtifactEnvelope(rawInlineEnvelope)).toEqual([]);

    const compactedWithoutRegistry = {
      ...compactedEnvelope,
      agentSnapshotFrames: undefined
    };
    expect(validateHarnessEpisodeArtifactEnvelope(compactedWithoutRegistry).join(" ")).toMatch(
      /actor snapshot frame reference requires an external frame registry/
    );

    const danglingFrameEnvelope = clone(compactedEnvelope);
    danglingFrameEnvelope.socialEpisode.steps[0]!.actorSnapshotFrameIdAfterStep = "agent-snapshot:dangling";
    expect(validateHarnessEpisodeArtifactEnvelope(danglingFrameEnvelope).join(" ")).toMatch(
      /actor snapshot frame agent-snapshot:dangling is missing/i
    );
    const compactedReplay = replaySocialEpisode({
      episode: compacted.episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      agentSnapshotFrames: compacted.frames
    });
    expect(compactedReplay.ok).toBe(true);
    expect(compactedReplay.agentStateAudit).toMatchObject({ ok: true, checkedNativeSteps: 3, checkedSnapshots: 3 });

    const checkpoint = buildHarnessCheckpointAtPrefix<LedgerState, LedgerObservation, LedgerPending, LedgerCommand, LedgerCheckpointActorState>({
      artifactVersion: "ledger.checkpoint.v1",
      kind: "ledger-checkpoint",
      checkpointId: "ledger-prefix-after-a",
      createdAt: "2026-07-21T01:00:00.000Z",
      sourceArtifactVersion: "ledger.episode.v1",
      runId: parent.id,
      sourceStatus: parent.status,
      episode: compacted.episode,
      selector: { nativeStepCount: 1 },
      resolveAgentSnapshot: createHarnessAgentSnapshotFrameResolver(compacted.frames),
      replayPrefix: (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment(),
          hashState: hashStableState,
          hashMessages: hashStableState,
          validateExpectedFinalState: false,
          agentSnapshotFrames: compacted.frames
        }),
      validateAgentSnapshot({ agents, step }) {
        return agents.some((agent) => !agent.id) || !step.traceId ? ["ledger actor state is malformed"] : [];
      }
    });

    expect(checkpoint.executionPrefix.steps).toHaveLength(1);
    expect(checkpoint.executionPrefix.messages).toEqual([]);
    expect(checkpoint.state).toMatchObject({ turn: 1, done: false, entries: ["a:parent-a"] });
    expect(checkpoint.agents).toEqual([
      { id: "a", committedEntries: ["a:parent-a"] },
      { id: "b", committedEntries: [] },
      { id: "c", committedEntries: [] }
    ]);
    expect(validateHarnessCheckpointEnvelope(checkpoint)).toEqual([]);
    expect(
      validateHarnessCheckpointReplay(checkpoint, (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment(),
          hashState: hashStableState,
          hashMessages: hashStableState,
          auditAgentSnapshots: false
        })
      )
    ).toEqual([]);

    const verifyLedgerCheckpointReplay = (candidate: typeof checkpoint) =>
      validateHarnessCheckpointReplay(candidate, (executionPrefix) =>
        replaySocialEpisode({
          episode: executionPrefix,
          environment: new LedgerEnvironment(),
          hashState: hashStableState,
          hashMessages: hashStableState,
          auditAgentSnapshots: false
        })
      );

    const forked = await runForkedHarnessEpisode({
      checkpoint,
      createdAt: "2026-07-21T01:00:01.000Z",
      reason: "ledger continuation proof",
      runtime: {
        createEnvironment(initialState) {
          return new LedgerEnvironment({ initialState });
        },
        restoreActors(agentStates) {
          return agentStates.map((state) => new CheckpointLedgerActor(state.id, `fork-${state.id}`, state));
        }
      },
      verifyCheckpointReplay: verifyLedgerCheckpointReplay,
      episode: {
        id: "ledger-generic-prefix-fork",
        schedulerMode: "aec",
        hashState: hashStableState,
        hashMessages: hashStableState
      }
    });

    expect(forked.seed.initialState).toEqual(checkpoint.state);
    expect(forked.seed.initialAgentStates).toEqual(checkpoint.agents);
    expect(forked.seed.forkOf).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      parentRunId: parent.id,
      parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
      parentStateHash: checkpoint.source.stateHash,
      parentNativeStepCount: 1,
      parentMessageCount: 0
    });
    expect(forked.socialEpisode.initialState).toEqual(checkpoint.state);
    expect(forked.socialEpisode.steps[0]).toMatchObject({ actorId: "b", preStateHash: checkpoint.source.stateHash });
    expect(forked.socialEpisode.finalState).toMatchObject({
      done: true,
      entries: ["a:parent-a", "b:fork-b", "c:fork-c"]
    });

    const structurallySelfConsistentButUnreplayable = clone(checkpoint);
    structurallySelfConsistentButUnreplayable.executionPrefix.steps[0]!.action.command.entry = "tampered-command";
    structurallySelfConsistentButUnreplayable.source.executionPrefixHash = hashStableState(
      structurallySelfConsistentButUnreplayable.executionPrefix
    );
    expect(validateHarnessCheckpointEnvelope(structurallySelfConsistentButUnreplayable)).toEqual([]);
    let environmentRestores = 0;
    let actorRestores = 0;
    await expect(
      runForkedHarnessEpisode({
        checkpoint: structurallySelfConsistentButUnreplayable,
        runtime: {
          createEnvironment(initialState) {
            environmentRestores += 1;
            return new LedgerEnvironment({ initialState });
          },
          restoreActors(agentStates) {
            actorRestores += 1;
            return agentStates.map((state) => new CheckpointLedgerActor(state.id, `forbidden-${state.id}`, state));
          }
        },
        verifyCheckpointReplay: verifyLedgerCheckpointReplay,
        episode: {
          id: "ledger-generic-prefix-invalid-fork",
          schedulerMode: "aec",
          hashState: hashStableState,
          hashMessages: hashStableState
        }
      })
    ).rejects.toThrow(/Checkpoint replay verification failed/);
    expect(environmentRestores).toBe(0);
    expect(actorRestores).toBe(0);

    const withoutSnapshot = clone(compacted.episode);
    delete withoutSnapshot.steps[0]?.actorSnapshotsHashAfterStep;
    delete withoutSnapshot.steps[0]?.actorSnapshotFrameIdAfterStep;
    expect(() =>
      buildHarnessCheckpointAtPrefix({
        artifactVersion: "ledger.checkpoint.v1",
        kind: "ledger-checkpoint",
        sourceArtifactVersion: "ledger.episode.v1",
        episode: withoutSnapshot,
        selector: { nativeStepCount: 1 },
        resolveAgentSnapshot: createHarnessAgentSnapshotFrameResolver(compacted.frames),
        replayPrefix: () => {
          throw new Error("replay must not run when durable snapshots are absent");
        }
      })
    ).toThrow(expect.objectContaining({ code: "missing_agent_snapshots" } satisfies Partial<HarnessCheckpointSelectionError>));

    const tamperedSnapshot = clone(parent);
    (tamperedSnapshot.steps[0]?.actorSnapshotsAfterStep as LedgerCheckpointActorState[])[0]!.committedEntries.push("tampered");
    const tamperedReplay = replaySocialEpisode({
      episode: tamperedSnapshot,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(tamperedReplay.ok).toBe(false);
    expect(tamperedReplay.mismatches.join(" ")).toMatch(/Recorded agent state audit: .*snapshot hash mismatch/);

    const tamperedFrameRegistry = clone(compacted.frames);
    tamperedFrameRegistry[0]!.agents[0]!.committedEntries.push("tampered-frame");
    const tamperedFrameReplay = replaySocialEpisode({
      episode: compacted.episode,
      environment: new LedgerEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      agentSnapshotFrames: tamperedFrameRegistry
    });
    expect(tamperedFrameReplay.ok).toBe(false);
    expect(tamperedFrameReplay.mismatches.join(" ")).toMatch(/resolved actor snapshot hash mismatch|frame reference cannot be resolved/);

    const danglingFrameEpisode = clone(compacted.episode);
    danglingFrameEpisode.steps[0]!.actorSnapshotFrameIdAfterStep = "agent-snapshot:dangling";
    const danglingFrameAudit = validateHarnessAgentSnapshotFrameRegistry({
      episode: danglingFrameEpisode,
      frames: compacted.frames,
      finalAgents: parentAgentStates
    });
    expect(danglingFrameAudit.ok).toBe(false);
    expect(danglingFrameAudit.mismatches.join(" ")).toMatch(/actor snapshot frame agent-snapshot:dangling is missing/i);
  });

  it("rejects a repeated policy trace before a second generic transition and preserves the first snapshot binding", async () => {
    const environment = new LedgerEnvironment({ actorIds: ["a", "a"] });
    const actor = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      traceId: "ledger-duplicate-policy-trace",
      command: { actorId: "a", entry: "duplicate-trace-attempt" }
    }));
    let snapshotCaptures = 0;
    const episode = await runHarnessEpisode<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      { id: LedgerActorId; durableMemoryVersion: number }
    >({
      id: "ledger-duplicate-trace",
      environment,
      actors: [actor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      captureAgentSnapshots: () => {
        snapshotCaptures += 1;
        return [{ id: "a", durableMemoryVersion: environment.snapshot().turn }];
      }
    });

    expect(episode.status).toBe("failed");
    expect(episode.failureReason).toMatch(/already recorded by an earlier native step/);
    expect(environment.stepCalls).toBe(1);
    expect(snapshotCaptures).toBe(1);
    expect(episode.steps).toHaveLength(2);
    expect(episode.steps[0]).toMatchObject({
      traceId: "ledger-duplicate-policy-trace",
      actorId: "a",
      commitStatus: "committed",
      actorSnapshotsAfterStep: [{ id: "a", durableMemoryVersion: 1 }]
    });
    expect(episode.steps[1]).toMatchObject({
      actorId: "system",
      commitStatus: "rejected",
      failure: { stage: "trace_identity" }
    });
    expect(episode.steps[1]?.actorSnapshotsAfterStep).toBeUndefined();
    expect(new Set(episode.steps.map((step) => step.traceId)).size).toBe(episode.steps.length);
    expect(actor.receipts.map((receipt) => receipt.status)).toEqual(["committed", "rejected"]);
    expect(actor.receipts[1]?.traceId).toBe(episode.steps[1]?.traceId);
    expect(validateSocialEpisodeArtifact(episode)).toEqual([]);

    const agents = [{ id: "a" as LedgerActorId, durableMemoryVersion: 1 }];
    const envelope = {
      artifactVersion: "ledger.episode.v1",
      kind: "ledger-episode",
      runId: episode.id,
      createdAt: "2026-07-21T02:00:00.000Z",
      status: episode.status,
      initialState: episode.initialState,
      finalState: episode.finalState,
      socialEpisode: episode,
      agents
    } satisfies HarnessEpisodeArtifactEnvelope<
      LedgerState,
      LedgerObservation,
      LedgerPending,
      LedgerCommand,
      (typeof agents)[number]
    >;
    expect(validateHarnessEpisodeArtifactEnvelope(envelope)).toEqual([]);
  });

  it("records an environment-rejected proposal without mutating state or committing its message", async () => {
    const environment = new LedgerEnvironment({ actorIds: ["a"], rejectedEntry: "forbidden" });
    const actor = new LedgerActor("a", () => ({
      actorId: "a",
      kind: "record",
      command: { actorId: "a", entry: "forbidden" },
      messages: [message("public-ledger", "a", ["a", "b", "c"], "public", "This message must not commit")]
    }));

    const episode = await runSocialEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-rejected-proposal",
      environment,
      actors: [actor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const initialState: LedgerState = {
      turn: 0,
      done: false,
      entries: [],
      secrets: { a: "token-a", b: "token-b", c: "token-c" }
    };
    expect(episode.status).toBe("failed");
    expect(episode.failureReason).toContain("ledger rejected entry forbidden");
    expect(episode.messages).toEqual([]);
    expect(episode.finalState).toEqual(initialState);
    expect(episode.steps).toHaveLength(1);
    expect(episode.steps[0]).toMatchObject({
      actorId: "a",
      commitStatus: "rejected",
      preStateHash: hashStableState(initialState),
      postStateHash: hashStableState(initialState),
      failure: { stage: "environment_validation", message: "ledger rejected entry forbidden" }
    });
    expect(episode.steps[0]?.messageSeqRange).toBeUndefined();
    expect(actor.receipts).toMatchObject([{ status: "rejected", actorId: "a" }]);

    const replayEnvironment = new LedgerEnvironment({ actorIds: ["a"], rejectedEntry: "forbidden" });
    const replay = replaySocialEpisode({
      episode,
      environment: replayEnvironment,
      hashState: hashStableState,
      hashMessages: hashStableState
    });

    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(1);
    expect(replayEnvironment.stepCalls).toBe(0);
    expect(replay.finalState).toEqual(initialState);
  });

  it("commits scaffolded agent state only after a committed environment receipt", async () => {
    const createActor = (entry: string, actionTraceId?: string) =>
      new ScaffoldedSocialActor<LedgerObservation, LedgerPending, LedgerCommand>({
        id: "a",
        profile: { id: "ledger-scaffold-a", model: "deterministic-a", policyId: "ledger-policy" },
        policy: {
          id: "ledger-policy",
          decide(input) {
            return {
              actorId: input.agent.id as LedgerActorId,
              kind: "record",
              traceId: actionTraceId,
              command: { actorId: input.agent.id as LedgerActorId, entry }
            };
          }
        },
        reasoner: {
          id: "ledger-memo",
          reflect() {
            return `memo:${entry}`;
          }
        }
      });
    const assembleObservation = (context: {
      environmentObservation: LedgerObservation;
      visibleSocial: { messages: SocialMessage[]; channels: SocialChannel[] };
    }): LedgerObservation => ({
      ...context.environmentObservation,
      visibleMessages: context.visibleSocial.messages,
      channels: context.visibleSocial.channels
    });

    const rejectedActor = createActor("forbidden");
    const rejected = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-scaffold-rejected",
      environment: new LedgerEnvironment({ actorIds: ["a"], rejectedEntry: "forbidden" }),
      actors: [rejectedActor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation
    });

    expect(rejected.steps[0]).toMatchObject({ commitStatus: "rejected", failure: { stage: "environment_validation" } });
    expect(rejectedActor.state).toMatchObject({ observations: 0, decisions: 0, memory: [] });
    expect(rejectedActor.state.lastObservation).toBeUndefined();
    expect(rejectedActor.state.lastAction).toBeUndefined();
    expect(rejectedActor.state.social.memory.entries).toEqual([]);
    expect(rejectedActor.state.social.journal?.entries ?? []).toEqual([]);

    const committedActor = createActor("opening", "ledger-policy-owned-trace");
    const committed = await runHarnessEpisode<LedgerState, LedgerObservation, LedgerPending, LedgerCommand>({
      id: "ledger-scaffold-committed",
      environment: new LedgerEnvironment({ actorIds: ["a"] }),
      actors: [committedActor],
      channels: [publicChannel],
      schedulerMode: "aec",
      hashState: hashStableState,
      hashMessages: hashStableState,
      assembleObservation
    });

    expect(committed.steps[0]).toMatchObject({
      traceId: "ledger-policy-owned-trace",
      commitStatus: "committed"
    });
    expect(committedActor.state).toMatchObject({ observations: 1, decisions: 1 });
    expect(committedActor.state.memory.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    expect(committedActor.state.social.journal?.entries.map((entry) => entry.mutationKind)).toEqual([
      "memory.appended",
      "memory.appended",
      "memory.appended"
    ]);
  });

  it("evaluates a non-Werewolf social snapshot without a game view or command contract", () => {
    const social = createAgentSocialState<LedgerObservation, LedgerPending, LedgerCommand>({
      agentId: "a",
      profile: { id: "ledger-a", model: "deterministic-a", policyId: "ledger-policy" }
    });
    appendSocialMemory(social, {
      kind: "observation",
      source: "ledger-environment",
      visibility: "private",
      content: "a observed its private ledger token",
      evidenceRefs: [{ artifact: "observation", id: "ledger-observation-1" }],
      tags: ["ledger", "private"]
    });

    const report = runEvaluationRegistry({
      id: "ledger-social-evaluation",
      context: {
        id: "ledger-social-evaluation",
        status: "completed" as const,
        initialState: { turn: 0, done: false, entries: [], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        finalState: { turn: 1, done: false, entries: ["a:opening"], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        agents: [{ id: "a", social, socialStateHash: "ledger-social-hash" }],
        trajectory: [{ turn: 1, action: "record" }],
        socialEpisode: { domainId: "ledger" }
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.outputs["social.state.v1"]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      memoryEntries: 1
    });
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent.social.memory_count",
          subjectId: "a",
          subject: expect.objectContaining({ actorId: "a", policyId: "ledger-policy" }),
          value: 1
        })
      ])
    );
  });

  it("accepts the generic scaffold state as a social evaluation snapshot without an adapter", () => {
    const actor = new ScaffoldedSocialActor<LedgerObservation, LedgerPending, LedgerCommand>({
      id: "b",
      profile: { id: "ledger-b", model: "deterministic-b", policyId: "ledger-policy" },
      policy: {
        id: "ledger-policy",
        decide(input) {
          return {
            actorId: input.agent.id as LedgerActorId,
            kind: "record",
            command: { actorId: input.agent.id as LedgerActorId, entry: "scaffolded" }
          };
        }
      }
    });

    const report = runEvaluationRegistry({
      id: "ledger-scaffold-evaluation",
      context: {
        id: "ledger-scaffold-evaluation",
        status: "completed" as const,
        initialState: { turn: 0, done: false, entries: [], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        finalState: { turn: 0, done: false, entries: [], secrets: { a: "token-a", b: "token-b", c: "token-c" } },
        agents: [actor.state],
        trajectory: []
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.outputs["social.state.v1"]).toMatchObject({ agentCount: 1, agentsWithSocialState: 1 });
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agent.social.memory_count", subjectId: "b", subject: expect.objectContaining({ actorId: "b" }) })
      ])
    );
  });
});

class LedgerActor implements SocialActor<LedgerObservation, LedgerPending, LedgerCommand> {
  readonly profile: SocialAgentProfile;
  readonly observations: LedgerObservation[] = [];
  readonly receipts: Array<SocialActorStepReceipt<LedgerObservation, LedgerPending, LedgerCommand>> = [];

  constructor(
    readonly id: LedgerActorId,
    private readonly actionForPending: (pending: LedgerPending) => SocialAction<LedgerCommand>
  ) {
    this.profile = { id, model: `deterministic-${id}` };
  }

  observe(observation: LedgerObservation): void {
    this.observations.push(clone(observation));
  }

  decide(pending: LedgerPending): SocialAction<LedgerCommand> {
    return this.actionForPending(pending);
  }

  onStepResult(receipt: SocialActorStepReceipt<LedgerObservation, LedgerPending, LedgerCommand>): void {
    this.receipts.push(clone(receipt));
  }
}

interface LedgerCheckpointActorState {
  id: LedgerActorId;
  committedEntries: string[];
}

/** A tiny durable actor used only to prove generic checkpoint restoration. */
class CheckpointLedgerActor implements SocialActor<LedgerObservation, LedgerPending, LedgerCommand> {
  readonly profile: SocialAgentProfile;
  private state: LedgerCheckpointActorState;

  constructor(
    readonly id: LedgerActorId,
    private readonly entry: string,
    restored?: LedgerCheckpointActorState
  ) {
    this.profile = { id: `checkpoint-${id}`, model: `deterministic-${id}`, policyId: "ledger-checkpoint" };
    this.state = restored ? clone(restored) : { id, committedEntries: [] };
  }

  observe(): void {
    // The Ledger environment owns observations; this fixture's durable state
    // changes exclusively at the post-environment receipt boundary.
  }

  decide(pending: LedgerPending): SocialAction<LedgerCommand> {
    return {
      actorId: this.id,
      kind: pending.kind,
      command: { actorId: this.id, entry: this.entry }
    };
  }

  onStepResult(receipt: SocialActorStepReceipt<LedgerObservation, LedgerPending, LedgerCommand>): void {
    if (receipt.status === "committed") this.state.committedEntries.push(`${this.id}:${this.entry}`);
  }

  snapshot(): LedgerCheckpointActorState {
    return clone(this.state);
  }
}

class LedgerEnvironment implements SocialEnvironment<LedgerState, LedgerObservation, LedgerPending, LedgerCommand> {
  private readonly state: LedgerState;
  stepCalls = 0;
  private readonly actorIds: LedgerActorId[];
  private readonly rejectedEntry?: string;

  constructor(options: { actorIds?: LedgerActorId[]; rejectedEntry?: string; initialState?: LedgerState } = {}) {
    this.actorIds = options.actorIds ?? ["a", "b", "c"];
    this.rejectedEntry = options.rejectedEntry;
    this.state = clone(
      options.initialState ?? {
        turn: 0,
        done: false,
        entries: [],
        secrets: { a: "token-a", b: "token-b", c: "token-c" }
      }
    );
  }

  snapshot(): LedgerState {
    return clone(this.state);
  }

  pendingActions(): LedgerPending[] {
    const actorId = this.actorIds[this.state.turn];
    return this.state.done || !actorId ? [] : [{ actorId, kind: "record" }];
  }

  observe(agentId: string, pending: LedgerPending): LedgerObservation {
    if (agentId !== pending.actorId) throw new Error(`pending actor mismatch ${agentId}`);
    return {
      agentId: pending.actorId,
      pendingKind: pending.kind,
      turn: this.state.turn,
      privateToken: this.state.secrets[pending.actorId]
    };
  }

  step(command: LedgerCommand): LedgerState {
    const pending = this.pendingActions()[0];
    if (!pending || command.actorId !== pending.actorId) throw new Error(`ledger rejects actor ${command.actorId}`);
    if (command.entry === this.rejectedEntry) throw new Error(`ledger rejected entry ${command.entry}`);
    this.stepCalls += 1;
    this.state.entries.push(`${command.actorId}:${command.entry}`);
    this.state.turn += 1;
    this.state.done = this.state.turn >= this.actorIds.length;
    return this.snapshot();
  }

  validateAction(command: LedgerCommand, pending: LedgerPending) {
    if (command.actorId !== pending.actorId) {
      return { valid: false, code: "actor-mismatch", message: `ledger rejects actor ${command.actorId}` };
    }
    if (command.entry === this.rejectedEntry) {
      return { valid: false, code: "forbidden-entry", message: `ledger rejected entry ${command.entry}` };
    }
    return { valid: true };
  }

  done(): boolean {
    return this.state.done;
  }
}

function message(
  channelId: string,
  senderId: LedgerActorId,
  recipientIds: LedgerActorId[],
  visibility: "public" | "private",
  content: string,
  speechActs?: SocialMessage["speechActs"]
): LedgerMessageDraft {
  return { channelId, senderId, recipientIds, visibility, content, speechActs };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
