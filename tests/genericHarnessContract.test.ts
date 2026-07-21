import { describe, expect, it } from "vitest";
import { runEvaluationRegistry } from "../src/harness/evaluation";
import { hashStableState } from "../src/harness/hash";
import { replaySocialEpisode } from "../src/harness/replay";
import { runHarnessEpisode } from "../src/harness/runner";
import { ScaffoldedSocialActor } from "../src/harness/scaffold";
import { createSocialStateEvaluator } from "../src/harness/socialEvaluator";
import { appendSocialMemory, createAgentSocialState } from "../src/harness/socialState";
import {
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  validateHarnessEpisodeArtifactEnvelope,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope
} from "../src/harness/episodeArtifacts";
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

  it("records a non-Werewolf episode and checkpoint through the generic artifact envelope", async () => {
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
      assembleObservation(context) {
        return {
          ...context.environmentObservation,
          visibleMessages: context.visibleSocial.messages,
          channels: context.visibleSocial.channels
        };
      }
    });

    const agents = [{ id: "a", durableMemoryVersion: 1 }];
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

class LedgerEnvironment implements SocialEnvironment<LedgerState, LedgerObservation, LedgerPending, LedgerCommand> {
  private readonly state: LedgerState = {
    turn: 0,
    done: false,
    entries: [],
    secrets: { a: "token-a", b: "token-b", c: "token-c" }
  };
  stepCalls = 0;
  private readonly actorIds: LedgerActorId[];
  private readonly rejectedEntry?: string;

  constructor(options: { actorIds?: LedgerActorId[]; rejectedEntry?: string } = {}) {
    this.actorIds = options.actorIds ?? ["a", "b", "c"];
    this.rejectedEntry = options.rejectedEntry;
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
  content: string
): LedgerMessageDraft {
  return { channelId, senderId, recipientIds, visibility, content };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
