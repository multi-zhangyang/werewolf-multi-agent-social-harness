import { describe, expect, it, vi } from "vitest";
import { ModelCallError } from "../src/agents/schema";
import { applyCommand, createGame, getPendingActions } from "../src/core/engine";
import { createPlayerView } from "../src/core/view";
import type { GameCommand, GameState } from "../src/core/types";
import { WerewolfAgentActor } from "../src/harness/actor";
import { buildFinalHarnessCheckpoint, buildMatchArtifact, forkHarnessRunOptions, toTrajectoryJsonl, type MatchArtifact } from "../src/harness/artifacts";
import { hashStableState } from "../src/harness/hash";
import { harnessFailureEvidenceFromEpisode } from "../src/harness/executionEvidence";
import { werewolfHarnessTurnEvidenceFromEpisode } from "../src/harness/werewolfExecutionEvidence";
import { policyForRole } from "../src/harness/policy";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import { emptyEvaluationSummary } from "../src/harness/evaluation";
import {
  deriveSocialExposureRecords,
  isSocialStepCommitted,
  runSocialEpisode,
  SocialCommunicationBus,
  type SocialActor,
  type SocialActorObservationContext,
  type SocialAgentProfile
} from "../src/harness/social";
import {
  assembleHarnessPlayerView,
  assembleWerewolfSocialObservation,
  createWerewolfMessageDrafts,
  createWerewolfJointPhaseSchedulerResolver,
  createWerewolfSocialChannels,
  projectWerewolfSocialStepsToHarnessTrajectory,
  recordWerewolfEnvironmentStepFailure,
  runWerewolfSocialHarnessPrefix,
  runWerewolfSocialHarnessPrefixAsHarnessResult,
  werewolfEventSeq,
  werewolfLegacySchedulerModeForBatch,
  werewolfLegacyTraceId,
  werewolfSystemTransition,
  WerewolfSocialActorAdapter,
  WerewolfSocialEnvironment,
  type WerewolfSocialObservation,
  type WerewolfSocialPendingAction
} from "../src/harness/werewolfAdapter";
import { replayHarnessTrajectory } from "../src/harness/replay";
import {
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  type AgentHarnessState,
  type HarnessAgentConfig,
  type HarnessReasoner
} from "../src/harness/types";

describe("Werewolf generic social adapter", () => {
  it("drives system.advance and the next agent action through runSocialEpisode", async () => {
    const initialState = createGame({ id: "werewolf-social-adapter", seed: "werewolf-social-adapter" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const afterAdvance = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const environment = WerewolfSocialEnvironment.fromState(initialState);
    const actorState: AgentHarnessState = {
      playerId: seer.id,
      profileId: "seer-profile",
      model: "deterministic-inspect",
      temperature: 0,
      policyName: policyForRole(seer.role),
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    };
    const actor = new WerewolfAgentActor(actorState);
    const reasonerCalls: string[] = [];
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push(input.traceId);
        expect(input.action.kind).toBe("inspect");
        expect(input.view.you.id).toBe(seer.id);
        expect(input.agent.socialStateHash).toEqual(expect.any(String));
        expect(input.memoryRetrieval).toMatchObject({
          version: "harness.memory-retrieval.v1",
          actorId: seer.id,
          selected: [
            {
              memorySeq: 1,
              rank: 1,
              kind: "observation"
            }
          ]
        });
        expect(input.recalledMemory).toEqual([
          expect.objectContaining({ memorySeq: 1, kind: "observation", source: "environment" })
        ]);
        const content = `adapter memo:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `adapter-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const socialActor = new WerewolfSocialActorAdapter({ actor, reasoner, players: initialState.players, tracePrefix: "werewolf-social-adapter" });

    const artifact = await runSocialEpisode({
      id: "werewolf-social-adapter",
      environment,
      actors: [socialActor],
      channels: createWerewolfSocialChannels(initialState.players),
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition
    });

    expect(artifact.status).toBe("truncated");
    expect(artifact.truncationReason).toContain("maxTransitions 2");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      profileId: "system",
      schedulerMode: "aec",
      resolutionPolicy: "system-transition",
      pendingAction: { kind: "advance", phase: "role_reveal", actorId: "system" },
      action: {
        actorId: "system",
        kind: "system.advance",
        command: { type: "system.advance", actorId: "system" }
      },
      preStateHash: hashStableState(initialState)
    });
    expect(artifact.steps[0].postStateHash).toBe(hashStableState(afterAdvance));
    expect(artifact.steps[0].eventSeqRange).toEqual([2, 2]);
    expect(artifact.steps[1]).toMatchObject({
      actorId: seer.id,
      schedulerMode: "aec",
      resolutionPolicy: "sequential-apply",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      action: {
        actorId: seer.id,
        kind: "seer.inspect",
        command: { type: "seer.inspect", actorId: seer.id, targetId: expect.any(String) }
      }
    });
    expect(artifact.steps[1].eventSeqRange).toEqual([3, 4]);
    expect(actor.state.observations).toBe(1);
    expect(actor.state.turns).toBe(1);
    expect(actor.state.privateMemos).toEqual([expect.stringContaining("adapter memo:deterministic-inspect:inspect")]);
    expect(actor.state.socialStateHash).toEqual(expect.any(String));
    expect(actor.state.social?.memory.entries.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    const committedDecision = actor.state.social?.memory.entries.find((entry) => entry.kind === "decision");
    expect(committedDecision?.metadata?.memoryRetrieval).toMatchObject({
      version: "harness.memory-retrieval.v1",
      actorId: seer.id,
      selected: [{ memorySeq: 1, rank: 1 }]
    });
    expect(reasonerCalls).toHaveLength(1);
    expect(reasonerCalls[0]).toContain("werewolf-social-adapter:social-adapter:1");
    const seerMessage = artifact.messages.find((message) => message.metadata?.kind === "private-seer-inspect");
    const memoMessage = artifact.messages.find((message) => message.metadata?.kind === "private-reasoner-memo");
    expect(artifact.messages).toHaveLength(2);
    const inspectDraft = artifact.steps[1].action.messages?.find((message) => message.metadata?.kind === "private-seer-inspect");
    expect(inspectDraft).toMatchObject({
      speechActs: [
        {
          id: "",
          kind: "role_action",
          subjectId: seer.id,
          targetId: expect.any(String),
          value: "seer.inspect",
          confidence: 1,
          evidenceRefs: [],
          metadata: { source: "metadata.targetId", messageKind: "private-seer-inspect" }
        }
      ]
    });
    expect(seerMessage).toMatchObject({
      channelId: `private-${seer.id}`,
      senderId: seer.id,
      recipientIds: [seer.id],
      visibility: "private",
      metadata: {
        traceId: artifact.steps[1].traceId,
        turnIndex: 1,
        actionKind: "inspect",
        commandType: "seer.inspect",
        kind: "private-seer-inspect",
        targetId: expect.any(String)
      },
      speechActs: [
        {
          id: "msg-1:speech-act:1",
          kind: "role_action",
          subjectId: seer.id,
          targetId: expect.any(String),
          value: "seer.inspect",
          confidence: 1,
          evidenceRefs: [
            {
              artifact: "message",
              id: "msg-1",
              seq: 1,
              description: `private-${seer.id}`
            }
          ],
          metadata: { source: "metadata.targetId", messageKind: "private-seer-inspect" }
        }
      ]
    });
    expect(memoMessage).toMatchObject({
      channelId: `private-${seer.id}`,
      senderId: seer.id,
      recipientIds: [seer.id],
      visibility: "private",
      content: expect.stringContaining("adapter memo:deterministic-inspect:inspect"),
      metadata: {
        traceId: artifact.steps[1].traceId,
        kind: "private-reasoner-memo",
        latencyMs: 1,
        promptTokens: 2,
        completionTokens: 3,
        providerRequestId: expect.stringContaining("adapter-"),
        attempts: 1
      }
    });
    expect(artifact.steps[1].messageSeqRange).toEqual([1, 2]);
    for (const message of artifact.messages) {
      expect(message.metadata?.role).toBeUndefined();
      expect(message.metadata?.team).toBeUndefined();
      expect(message.metadata?.policyName).toBeUndefined();
    }
    expect(artifact.steps[1].observation).toMatchObject({
      kind: "player",
      agentId: seer.id,
      view: {
        phase: "night_seer",
        you: { id: seer.id, role: "seer" },
        pendingAction: { kind: "inspect" },
        social: {
          channels: expect.arrayContaining([
            expect.objectContaining({ id: "table", kind: "public" }),
            expect.objectContaining({ id: `private-${seer.id}`, kind: "private" })
          ]),
          messages: []
        }
      }
    });
    expect(artifact.finalState.phase).toBe("night_wolves");
    const harnessTurnEvents = werewolfHarnessTurnEvidenceFromEpisode(artifact);
    expect(harnessTurnEvents).toHaveLength(1);
    expect(harnessTurnEvents[0]).toMatchObject({
      turnIndex: 2,
      actorId: seer.id,
      trace: {
        traceId: artifact.steps[1].traceId,
        playerId: seer.id,
        actionKind: "inspect",
        commandType: "seer.inspect",
        memoryRetrieval: {
          version: "harness.memory-retrieval.v1",
          actorId: seer.id,
          selected: [{ memorySeq: 1, rank: 1 }]
        },
        privateMemo: expect.stringContaining("adapter memo:deterministic-inspect:inspect"),
        agentStateHash: actor.state.socialStateHash
      }
    });
    expect(harnessTurnEvents[0]?.trace.beliefs).toEqual(actor.state.beliefs);
    const inspectCommand = artifact.steps[1].action.command;
    if (inspectCommand.type !== "seer.inspect") throw new Error("Expected seer inspect command.");
    expect(artifact.finalState.night.seerInspection).toMatchObject({
      actorId: seer.id,
      targetId: inspectCommand.targetId
    });

    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(artifact.steps);
    expect(projectedTrajectory).toHaveLength(1);
    expect(projectedTrajectory[0]).toMatchObject({
      traceId: artifact.steps[1].traceId,
      actorId: seer.id,
      model: "deterministic-inspect",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      command: inspectCommand,
      policyPlan: {
        command: inspectCommand,
        policyName: "seer-information"
      },
      reasonerOutput: {
        content: expect.stringContaining("adapter memo:deterministic-inspect:inspect"),
        providerRequestId: expect.stringContaining("adapter-")
      },
      turnTrace: {
        traceId: artifact.steps[1].traceId,
        playerId: seer.id,
        commandType: "seer.inspect",
        privateMemo: expect.stringContaining("adapter memo:deterministic-inspect:inspect")
      },
      eventSeqRange: artifact.steps[1].eventSeqRange,
      messageSeqRange: artifact.steps[1].messageSeqRange
    });
    expect(projectedTrajectory[0].observation).toMatchObject({
      phase: "night_seer",
      you: { id: seer.id, role: "seer" },
      pendingAction: { kind: "inspect" },
      social: {
        channels: expect.arrayContaining([expect.objectContaining({ id: `private-${seer.id}` })]),
        messages: []
      }
    });
    const replay = replayHarnessTrajectory({
      initialState,
      trajectory: projectedTrajectory
    });
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedCommands).toBe(projectedTrajectory.length);
    expect(replay.finalHash).toBe(hashStableState(artifact.finalState));
  });

  it("cleans staged adapter state by transaction id when a tracePrefix reasoner turn fails", async () => {
    const initialState = createGame({ id: "werewolf-trace-prefix-stage-cleanup", seed: "werewolf-trace-prefix-stage-cleanup" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const nightSeerState = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const actor = new WerewolfAgentActor({
      playerId: seer.id,
      profileId: "trace-prefix-failure-profile",
      model: "trace-prefix-failure-model",
      temperature: 0,
      policyName: policyForRole(seer.role),
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    });
    const adapter = new WerewolfSocialActorAdapter({
      actor,
      reasoner: {
        async think() {
          throw new Error("trace-prefix reasoner exploded");
        }
      },
      players: nightSeerState.players,
      tracePrefix: "adapter-owned-evidence-trace"
    });

    const artifact = await runSocialEpisode({
      id: "werewolf-trace-prefix-stage-cleanup",
      environment: WerewolfSocialEnvironment.fromState(nightSeerState),
      actors: [adapter],
      channels: createWerewolfSocialChannels(nightSeerState.players),
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.steps).toMatchObject([
      {
        actorId: seer.id,
        commitStatus: "rejected",
        failure: { stage: "actor_decide", message: expect.stringContaining("trace-prefix reasoner exploded") }
      }
    ]);
    expect(actor.state).toMatchObject({ turns: 0, observations: 0, beliefs: {}, privateMemos: [] });
    expect(actor.state.social?.memory.entries).toEqual([]);
    expect(actor.state.social?.journal?.entries ?? []).toEqual([]);
    const internal = adapter as unknown as {
      stagedActors: Map<string, unknown>;
      pendingProposals: Map<string, unknown>;
    };
    expect(internal.stagedActors.size).toBe(0);
    expect(internal.pendingProposals.size).toBe(0);
  });

  it("cleans transactional proposals when a runner-owned trace-collision receipt differs from policy trace evidence", async () => {
    const initialState = createGame({ id: "werewolf-trace-collision-cleanup", seed: "werewolf-trace-collision-cleanup" });
    const nightSeerState = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const inspect = getPendingActions(nightSeerState).find((action) => action.kind === "inspect");
    if (!inspect || inspect.kind !== "inspect") throw new Error("Expected the night seer inspect action.");
    const nightWolvesState = applyCommand(nightSeerState, {
      type: "seer.inspect",
      actorId: inspect.actorId,
      targetId: inspect.legalTargetIds[0]
    });
    const wolves = nightWolvesState.players.filter((player) => player.role === "werewolf");
    expect(wolves).toHaveLength(2);

    const adapters = wolves.map(
      (wolf) =>
        new WerewolfSocialActorAdapter({
          actor: new WerewolfAgentActor({
            playerId: wolf.id,
            profileId: `${wolf.id}-trace-collision-profile`,
            model: "trace-collision-model",
            temperature: 0,
            policyName: policyForRole(wolf.role),
            turns: 0,
            observations: 0,
            beliefs: {},
            privateMemos: []
          }),
          reasoner: {
            async think(input) {
              const content = `trace collision memo:${input.traceId}:${input.agent.playerId}`;
              return {
                content,
                completion: {
                  content,
                  latencyMs: 1,
                  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                  attempts: 1
                }
              };
            }
          },
          players: nightWolvesState.players
        })
    );

    const artifact = await runSocialEpisode({
      id: "werewolf-trace-collision-cleanup",
      environment: WerewolfSocialEnvironment.fromState(nightWolvesState),
      actors: adapters,
      channels: createWerewolfSocialChannels(nightWolvesState.players),
      schedulerMode: "aec-batched-decision",
      maxTransitions: 1,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      // Deliberately collide the two policy trace ids. The generic runner
      // emits a unique scheduler-owned rejection trace id in this case.
      traceIdForDecision: () => "policy-trace-collision"
    });

    expect(artifact.status).toBe("failed");
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      traceId: expect.stringContaining("trace_identity:rejected"),
      commitStatus: "rejected",
      failure: { stage: "trace_identity" }
    });
    expect(artifact.steps[0]?.traceId).not.toBe("policy-trace-collision");
    expect(artifact.finalState).toEqual(nightWolvesState);
    for (const adapter of adapters) {
      expect(adapter.state).toMatchObject({ turns: 0, observations: 0, beliefs: {}, privateMemos: [] });
      expect(adapter.state.social?.memory.entries).toEqual([]);
      expect(adapter.state.social?.journal?.entries ?? []).toEqual([]);
      const internal = adapter as unknown as {
        stagedActors: Map<string, unknown>;
        pendingProposals: Map<string, unknown>;
        turnTraces: Map<string, unknown>;
      };
      expect(internal.stagedActors.size).toBe(0);
      expect(internal.pendingProposals.size).toBe(0);
      expect(internal.turnTraces.size).toBe(0);
    }
  });

  it("maps every Werewolf command to adapter-owned typed speech acts", () => {
    const initialState = createGame({ id: "werewolf-speech-act-mapping", seed: "werewolf-speech-act-mapping" });
    const state = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const pendingAction = getPendingActions(state).find((action) => action.kind === "inspect");
    if (!pendingAction || pendingAction.kind !== "inspect") throw new Error("Expected a seer inspect pending action.");
    const actor = state.players.find((player) => player.id === pendingAction.actorId);
    if (!actor) throw new Error("Expected the inspect actor.");
    const targetIds = state.players.filter((player) => player.id !== actor.id).map((player) => player.id);
    const [firstTargetId, secondTargetId] = targetIds;
    if (!firstTargetId || !secondTargetId) throw new Error("Expected multiple Werewolf message targets.");
    const observation = assembleHarnessPlayerView(
      createPlayerView(state, actor.id, pendingAction),
      new SocialCommunicationBus(createWerewolfSocialChannels(state.players))
    );
    const draftSpeechActs = (command: GameCommand) => {
      const [message] = createWerewolfMessageDrafts({
        players: state.players,
        traceId: "werewolf-speech-act-mapping:trace",
        turnIndex: 1,
        actorId: actor.id,
        pendingAction,
        command,
        policyPlan: {
          policyName: policyForRole(actor.role),
          command,
          intent: "mapping contract",
          confidence: 1,
          strategyTags: []
        },
        observation,
        reasonerOutput: { content: "", latencyMs: 0 }
      });
      if (!message) throw new Error(`Expected a message draft for ${command.type}.`);
      return message.speechActs;
    };

    expect(
      draftSpeechActs({
        type: "speech.submit",
        actorId: actor.id,
        text: "I claim seer and pressure the target.",
        claimedRole: "seer",
        pressureTargetId: firstTargetId
      })
    ).toMatchObject([
      { id: "", kind: "role_claim", subjectId: actor.id, value: "seer", metadata: { source: "metadata.claimedRole" } },
      {
        id: "",
        kind: "accusation",
        subjectId: actor.id,
        targetId: firstTargetId,
        value: "pressure_target",
        metadata: { source: "metadata.pressureTargetId" }
      }
    ]);
    expect(draftSpeechActs({ type: "speech.submit", actorId: actor.id, text: "No typed claim." })).toBeUndefined();
    expect(draftSpeechActs({ type: "vote.cast", actorId: actor.id, abstain: true })).toMatchObject([
      {
        id: "",
        kind: "vote_intent",
        subjectId: actor.id,
        value: "vote.abstain",
        metadata: { source: "metadata.targetId", abstain: true, messageKind: "public-vote" }
      }
    ]);
    expect(draftSpeechActs({ type: "hunter.shoot", actorId: actor.id })).toMatchObject([
      { id: "", kind: "role_action", subjectId: actor.id, value: "hunter.shoot", metadata: { source: "metadata.targetId" } }
    ]);
    expect(draftSpeechActs({ type: "werewolf.killVote", actorId: actor.id, targetId: firstTargetId })).toMatchObject([
      {
        id: "",
        kind: "coalition_signal",
        subjectId: actor.id,
        targetId: firstTargetId,
        value: "werewolf.killVote",
        metadata: { source: "metadata.targetId", messageKind: "werewolf-kill-vote" }
      }
    ]);
    expect(draftSpeechActs({ type: "werewolf.whisper", actorId: actor.id, text: "Coordinate the night target and tomorrow's cover story." })).toMatchObject([
      {
        id: "",
        kind: "coalition_signal",
        subjectId: actor.id,
        value: "werewolf.whisper",
        metadata: { source: "werewolf.whisper", messageKind: "werewolf-whisper" }
      }
    ]);
    expect(draftSpeechActs({ type: "seer.inspect", actorId: actor.id, targetId: firstTargetId })).toMatchObject([
      {
        id: "",
        kind: "role_action",
        subjectId: actor.id,
        targetId: firstTargetId,
        value: "seer.inspect",
        metadata: { source: "metadata.targetId", messageKind: "private-seer-inspect" }
      }
    ]);
    expect(
      draftSpeechActs({ type: "witch.act", actorId: actor.id, saveTargetId: firstTargetId, poisonTargetId: secondTargetId })
    ).toMatchObject([
      {
        id: "",
        kind: "role_action",
        subjectId: actor.id,
        targetId: secondTargetId,
        value: "witch.act",
        metadata: { source: "metadata.kind", hasSave: true, hasPoison: true, messageKind: "private-witch-action" }
      }
    ]);
  });

  it("delivers a committed wolf whisper to the next wolf before the kill-vote batch", async () => {
    const initialState = createGame({
      id: "werewolf-team-discussion",
      seed: "werewolf-team-discussion",
      config: { wolfDiscussion: "one_turn", lastWords: "none" }
    });
    const agents = resolveAgentConfigs(initialState.players, profilesFromModels(["team-discussion-model"], 0), 0, 0);
    const visibleWhispersByActor = new Map<string, number>();
    const reasoner: HarnessReasoner = {
      async think(input) {
        if (input.action.kind === "whisper") {
          visibleWhispersByActor.set(
            input.agent.playerId,
            input.view.social.messages.filter((message) => message.metadata?.kind === "werewolf-whisper").length
          );
        }
        const content =
          input.action.kind === "whisper"
            ? "建议今晚优先处理高影响目标，并在白天保持一致口径，避免在公开发言中暴露夜间协作。"
            : `team-discussion memo:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `team-discussion-${input.traceId}`,
            attempts: 1,
            stream: { enabled: true, completed: true, completedBy: "done_sentinel" }
          }
        };
      }
    };

    const result = await runHarnessMatch({ initialState, agents, reasoner, maxTransitions: 4 });
    const whispers = result.socialEpisode.steps.filter((step) => step.action.command.type === "werewolf.whisper");

    expect(result.status).toBe("truncated");
    expect(result.metrics.harnessErrorCount).toBe(0);
    expect(result.socialEpisode.steps.map((step) => step.action.command.type)).toEqual([
      "system.advance",
      "seer.inspect",
      "werewolf.whisper",
      "werewolf.whisper"
    ]);
    expect(whispers).toHaveLength(2);
    expect(whispers.every((step) => step.commitStatus === "committed")).toBe(true);
    expect(visibleWhispersByActor.get(whispers[0].actorId)).toBe(0);
    expect(visibleWhispersByActor.get(whispers[1].actorId)).toBe(1);
    expect(
      result.socialEpisode.messages.filter((message) => message.metadata?.kind === "werewolf-whisper").every((message) => message.visibility === "team")
    ).toBe(true);
  });

  it("can project generic Werewolf steps with legacy harness trace ids", async () => {
    const initialState = createGame({ id: "werewolf-social-legacy-trace", seed: "werewolf-social-legacy-trace" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const actor = new WerewolfAgentActor({
      playerId: seer.id,
      profileId: "seer-legacy-profile",
      model: "deterministic-legacy-trace",
      temperature: 0,
      policyName: policyForRole(seer.role),
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    });
    const reasonerCalls: string[] = [];
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push(input.traceId);
        const content = `legacy trace memo:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `legacy-trace-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };

    const artifact = await runSocialEpisode({
      id: "werewolf-social-legacy-trace",
      environment: WerewolfSocialEnvironment.fromState(initialState),
      actors: [new WerewolfSocialActorAdapter({ actor, reasoner, players: initialState.players })],
      channels: createWerewolfSocialChannels(initialState.players),
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition,
      traceIdForDecision: werewolfLegacyTraceId
    });

    const expectedTraceId = `${initialState.id}:harness:2:${seer.id}:night_seer`;
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[1].traceId).toBe(expectedTraceId);
    expect(reasonerCalls).toEqual([expectedTraceId]);
    expect(artifact.messages.every((message) => message.metadata?.traceId === expectedTraceId)).toBe(true);
    expect(werewolfHarnessTurnEvidenceFromEpisode(artifact)[0]).toMatchObject({
      trace: {
        traceId: expectedTraceId,
        privateMemo: expect.stringContaining("legacy trace memo")
      }
    });

    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(artifact.steps);
    expect(projectedTrajectory).toHaveLength(1);
    expect(projectedTrajectory[0].traceId).toBe(expectedTraceId);
    expect(projectedTrajectory[0].turnIndex).toBe(2);
    expect(projectedTrajectory[0].turnTrace.traceId).toBe(expectedTraceId);
    expect(projectedTrajectory[0].reasonerOutput.providerRequestId).toBe(`legacy-trace-${expectedTraceId}`);
    const replay = replayHarnessTrajectory({
      initialState,
      trajectory: projectedTrajectory
    });
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.finalHash).toBe(hashStableState(artifact.finalState));
  });

  it("drives Werewolf kill votes through generic aec-batched-decision semantics", async () => {
    const initialState = createGame({ id: "werewolf-social-batched", seed: "werewolf-social-batched" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const afterAdvance = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const inspectTarget = afterAdvance.players.find((player) => player.alive && player.id !== seer.id);
    if (!inspectTarget) throw new Error("Expected a seer inspect target.");
    const nightWolves = applyCommand(afterAdvance, { type: "seer.inspect", actorId: seer.id, targetId: inspectTarget.id });
    const wolves = nightWolves.players.filter((player) => player.role === "werewolf");
    expect(nightWolves.phase).toBe("night_wolves");
    expect(wolves).toHaveLength(2);

    const environment = WerewolfSocialEnvironment.fromState(nightWolves);
    const reasonerCalls: Array<{ actorId: string; traceId: string; visibleMessages: number; phase: string }> = [];
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push({
          actorId: input.agent.playerId,
          traceId: input.traceId,
          visibleMessages: input.view.social.messages.length,
          phase: input.view.phase
        });
        expect(input.action.kind).toBe("kill");
        expect(input.view.phase).toBe("night_wolves");
        expect(input.view.social.messages).toEqual([]);
        const content = `batched adapter memo:${input.agent.playerId}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `batched-adapter-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const actors = wolves.map((wolf) => {
      const actorState: AgentHarnessState = {
        playerId: wolf.id,
        profileId: `${wolf.id}-wolf-profile`,
        model: "deterministic-wolf",
        temperature: 0,
        policyName: policyForRole(wolf.role),
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      };
      return new WerewolfSocialActorAdapter({
        actor: new WerewolfAgentActor(actorState),
        reasoner,
        players: nightWolves.players,
        tracePrefix: "werewolf-social-batched"
      });
    });

    const artifact = await runSocialEpisode({
      id: "werewolf-social-batched",
      environment,
      actors,
      channels: createWerewolfSocialChannels(nightWolves.players),
      schedulerMode: "aec-batched-decision",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition
    });

    expect(artifact.status).toBe("truncated");
    expect(artifact.truncationReason).toContain("maxTransitions 2");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.map((step) => step.actorId).sort()).toEqual(wolves.map((wolf) => wolf.id).sort());
    expect(artifact.steps.every((step) => step.schedulerMode === "aec-batched-decision")).toBe(true);
    expect(artifact.steps.every((step) => step.resolutionPolicy === "sequential-apply-from-shared-decision-state")).toBe(true);
    expect(new Set(artifact.steps.map((step) => step.batchId)).size).toBe(1);
    expect(artifact.steps.map((step) => step.batchSize)).toEqual([2, 2]);
    expect(new Set(artifact.steps.map((step) => step.decisionStateHash)).size).toBe(1);
    expect(artifact.steps[0].decisionStateHash).toBe(hashStableState(nightWolves));
    expect(artifact.steps[0].preStateHash).toBe(hashStableState(nightWolves));
    expect(artifact.steps[0].postStateHash).not.toBe(hashStableState(nightWolves));
    expect(artifact.steps[0].eventSeqRange).toEqual([nightWolves.events.at(-1)!.seq + 1, nightWolves.events.at(-1)!.seq + 1]);
    expect(artifact.steps[1].preStateHash).toBe(artifact.steps[0].postStateHash);
    expect(artifact.steps[1].postStateHash).toBe(hashStableState(artifact.finalState));
    expect(artifact.steps[1].eventSeqRange?.[0]).toBe((artifact.steps[0].eventSeqRange?.[1] ?? nightWolves.events.at(-1)!.seq) + 1);
    expect(artifact.steps[1].eventSeqRange?.[1]).toBeGreaterThanOrEqual(artifact.steps[1].eventSeqRange?.[0] ?? 0);
    expect(artifact.finalState.phase).toBe("night_witch");
    for (const wolf of wolves) {
      expect(artifact.finalState.night.wolfVotes[wolf.id]).toEqual(expect.any(String));
    }

    expect(reasonerCalls).toHaveLength(2);
    expect(reasonerCalls.map((call) => call.actorId).sort()).toEqual(wolves.map((wolf) => wolf.id).sort());
    expect(reasonerCalls.every((call) => call.phase === "night_wolves" && call.visibleMessages === 0)).toBe(true);
    expect(artifact.messages).toHaveLength(4);
    const killMessages = artifact.messages.filter((message) => message.metadata?.kind === "werewolf-kill-vote");
    const memoMessages = artifact.messages.filter((message) => message.metadata?.kind === "private-reasoner-memo");
    expect(killMessages).toHaveLength(2);
    expect(memoMessages).toHaveLength(2);
    for (const message of killMessages) {
      expect(message).toMatchObject({
        channelId: "werewolf-team",
        visibility: "team",
        recipientIds: [expect.stringMatching(/^p\d+$/)],
        metadata: {
          actionKind: "kill",
          commandType: "werewolf.killVote",
          kind: "werewolf-kill-vote",
          targetId: expect.any(String)
        }
      });
      expect(message.recipientIds).not.toContain(message.senderId);
    }
    for (const message of artifact.messages) {
      expect(message.metadata?.role).toBeUndefined();
      expect(message.metadata?.team).toBeUndefined();
      expect(message.metadata?.policyName).toBeUndefined();
    }
    expect(artifact.steps.map((step) => step.messageSeqRange)).toEqual([
      [1, 2],
      [3, 4]
    ]);
    for (const actor of actors) {
      expect(actor.state.observations).toBe(1);
      expect(actor.state.turns).toBe(1);
      expect(actor.state.privateMemos).toEqual([expect.stringContaining(`batched adapter memo:${actor.id}:kill`)]);
      expect(actor.state.socialStateHash).toEqual(expect.any(String));
    }
  });

  it("drives Werewolf kill votes through true parallel stepBatch joint resolution", async () => {
    const initialState = createGame({ id: "werewolf-social-parallel", seed: "werewolf-social-parallel" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const afterAdvance = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const inspectTarget = afterAdvance.players.find((player) => player.alive && player.id !== seer.id);
    if (!inspectTarget) throw new Error("Expected a seer inspect target.");
    const nightWolves = applyCommand(afterAdvance, { type: "seer.inspect", actorId: seer.id, targetId: inspectTarget.id });
    const wolves = nightWolves.players.filter((player) => player.role === "werewolf");
    expect(nightWolves.phase).toBe("night_wolves");
    expect(wolves).toHaveLength(2);

    const environment = WerewolfSocialEnvironment.fromState(nightWolves);
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content = `parallel adapter memo:${input.agent.playerId}:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            providerRequestId: `parallel-adapter-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const actors = wolves.map((wolf) => {
      const actorState: AgentHarnessState = {
        playerId: wolf.id,
        profileId: `${wolf.id}-wolf-parallel-profile`,
        model: "deterministic-wolf-parallel",
        temperature: 0,
        policyName: policyForRole(wolf.role),
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      };
      return new WerewolfSocialActorAdapter({
        actor: new WerewolfAgentActor(actorState),
        reasoner,
        players: nightWolves.players,
        tracePrefix: "werewolf-social-parallel"
      });
    });

    const artifact = await runSocialEpisode({
      id: "werewolf-social-parallel",
      environment,
      actors,
      channels: createWerewolfSocialChannels(nightWolves.players),
      schedulerMode: "parallel",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition
    });

    expect(artifact.status).toBe("truncated");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.every((step) => step.schedulerMode === "parallel")).toBe(true);
    expect(artifact.steps.every((step) => step.resolutionPolicy === "parallel-stepBatch")).toBe(true);
    expect(artifact.steps.every((step) => step.atomic === true)).toBe(true);
    expect(new Set(artifact.steps.map((step) => step.preStateHash)).size).toBe(1);
    expect(new Set(artifact.steps.map((step) => step.postStateHash)).size).toBe(1);
    expect(artifact.steps[0].preStateHash).toBe(hashStableState(nightWolves));
    expect(artifact.steps[0].postStateHash).toBe(hashStableState(artifact.finalState));
    expect(artifact.finalState.phase).toBe("night_witch");
    for (const wolf of wolves) {
      expect(artifact.finalState.night.wolfVotes[wolf.id]).toEqual(expect.any(String));
    }
  });

  it("lets runHarnessMatch use jointPhaseScheduler parallel for wolf kill votes", async () => {
    const initialState = createGame({ id: "werewolf-joint-parallel-match", seed: "werewolf-joint-parallel-match" });
    const agents = initialState.players.map((player, index) => ({
      playerId: player.id,
      profileId: `profile-${index + 1}`,
      model: "deterministic-joint-parallel",
      temperature: 0,
      policyName: policyForRole(player.role)
    }));
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content = `joint-parallel:${input.agent.playerId}:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            providerRequestId: `joint-parallel-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };

    // seer.inspect + 2 wolf kill votes. Parallel joint apply should still reach night_witch.
    // system.advance + seer.inspect + joint 2-wolf parallel batch.
    // Parallel refuses partial batch application when maxTransitions is too low.
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });

    expect(result.status).toBe("truncated");
    expect(result.state.phase).toBe("night_witch");
    const killSteps = result.socialEpisode.steps.filter((step) => {
      const command = step.action?.command as { type?: string } | undefined;
      return command?.type === "werewolf.killVote";
    });
    expect(killSteps.length).toBe(2);
    expect(killSteps.every((step) => step.schedulerMode === "parallel")).toBe(true);
    expect(killSteps.every((step) => step.resolutionPolicy === "parallel-stepBatch")).toBe(true);
    expect(killSteps.every((step) => step.atomic === true)).toBe(true);
    expect(new Set(killSteps.map((step) => step.preStateHash)).size).toBe(1);
    expect(new Set(killSteps.map((step) => step.postStateHash)).size).toBe(1);
    expect(new Set(killSteps.map((step) => step.actorSnapshotsHashAfterStep)).size).toBe(1);
    for (const step of killSteps) {
      const snapshots = step.actorSnapshotsAfterStep as AgentHarnessState[] | undefined;
      expect(snapshots).toBeDefined();
      for (const wolf of result.state.players.filter((player) => player.role === "werewolf")) {
        expect(snapshots?.find((agent) => agent.playerId === wolf.id)).toMatchObject({
          observations: 1,
          turns: 1
        });
      }
    }
    for (const wolf of result.state.players.filter((player) => player.role === "werewolf")) {
      expect(result.state.night.wolfVotes[wolf.id]).toEqual(expect.any(String));
    }
  });

  it("keeps jointPhaseScheduler parallel as opt-in and defaults to aec-batched-decision", async () => {
    const initialState = createGame({ id: "werewolf-joint-default-match", seed: "werewolf-joint-default-match" });
    const agents = initialState.players.map((player, index) => ({
      playerId: player.id,
      profileId: `profile-${index + 1}`,
      model: "deterministic-joint-default",
      temperature: 0,
      policyName: policyForRole(player.role)
    }));
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content = `joint-default:${input.agent.playerId}:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            providerRequestId: `joint-default-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    expect(DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER).toBe("aec-batched-decision");
    const defaultResolver = createWerewolfJointPhaseSchedulerResolver();
    const parallelResolver = createWerewolfJointPhaseSchedulerResolver("parallel");
    const jointContext = {
      id: "joint-default-check",
      state: initialState,
      pendingActions: [
        { type: "agent" as const, actorId: "p1", kind: "kill" as const, legalTargetIds: ["p2"] },
        { type: "agent" as const, actorId: "p2", kind: "kill" as const, legalTargetIds: ["p1"] }
      ],
      turnIndex: 1,
      batchIndex: 0,
      defaultSchedulerMode: "aec" as const
    };
    expect(defaultResolver(jointContext as never)).toBe("aec-batched-decision");
    expect(parallelResolver(jointContext as never)).toBe("parallel");
    expect(werewolfLegacySchedulerModeForBatch(jointContext as never)).toBe("aec-batched-decision");
    expect(defaultResolver({ ...jointContext, pendingActions: [] } as never)).toBe("aec");

    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
      maxTransitions: 4
    });

    expect(result.status).toBe("truncated");
    const killSteps = result.socialEpisode.steps.filter((step) => {
      const command = step.action?.command as { type?: string } | undefined;
      return command?.type === "werewolf.killVote";
    });
    expect(killSteps.length).toBe(2);
    expect(killSteps.every((step) => step.schedulerMode === "aec-batched-decision")).toBe(true);
    expect(killSteps.some((step) => step.schedulerMode === "parallel")).toBe(false);
  });

  it("projects batched Werewolf kill votes with legacy trace ids into replayable trajectory", async () => {
    const initialState = createGame({ id: "werewolf-social-batched-legacy-trace", seed: "werewolf-social-batched-legacy-trace" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const afterAdvance = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const inspectTarget = afterAdvance.players.find((player) => player.alive && player.id !== seer.id);
    if (!inspectTarget) throw new Error("Expected a seer inspect target.");
    const nightWolves = applyCommand(afterAdvance, { type: "seer.inspect", actorId: seer.id, targetId: inspectTarget.id });
    const wolves = nightWolves.players.filter((player) => player.role === "werewolf");
    expect(wolves).toHaveLength(2);

    const reasonerCalls: Array<{ actorId: string; traceId: string }> = [];
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push({ actorId: input.agent.playerId, traceId: input.traceId });
        const content = `batched legacy trace memo:${input.agent.playerId}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `batched-legacy-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const actors = wolves.map((wolf) =>
      new WerewolfSocialActorAdapter({
        actor: new WerewolfAgentActor({
          playerId: wolf.id,
          profileId: `${wolf.id}-legacy-wolf-profile`,
          model: "deterministic-legacy-wolf",
          temperature: 0,
          policyName: policyForRole(wolf.role),
          turns: 0,
          observations: 0,
          beliefs: {},
          privateMemos: []
        }),
        reasoner,
        players: nightWolves.players
      })
    );

    const artifact = await runSocialEpisode({
      id: "werewolf-social-batched-legacy-trace",
      environment: WerewolfSocialEnvironment.fromState(nightWolves),
      actors,
      channels: createWerewolfSocialChannels(nightWolves.players),
      schedulerMode: "aec-batched-decision",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition,
      traceIdForDecision: werewolfLegacyTraceId
    });

    const expectedTraceIds = wolves.map((wolf, index) => `${nightWolves.id}:harness:${index + 1}:${wolf.id}:night_wolves`);
    expect(artifact.status).toBe("truncated");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.map((step) => step.traceId)).toEqual(expectedTraceIds);
    expect(artifact.steps.every((step) => step.schedulerMode === "aec-batched-decision")).toBe(true);
    expect(artifact.steps.every((step) => step.resolutionPolicy === "sequential-apply-from-shared-decision-state")).toBe(true);
    expect(new Set(artifact.steps.map((step) => step.decisionStateHash))).toEqual(new Set([hashStableState(nightWolves)]));
    expect(reasonerCalls).toEqual(wolves.map((wolf, index) => ({ actorId: wolf.id, traceId: expectedTraceIds[index] })));
    expect(artifact.messages.every((message) => expectedTraceIds.includes(String(message.metadata?.traceId)))).toBe(true);
    expect(werewolfHarnessTurnEvidenceFromEpisode(artifact).map((event) => event.trace.traceId)).toEqual(expectedTraceIds);

    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(artifact.steps);
    expect(projectedTrajectory).toHaveLength(2);
    expect(projectedTrajectory.map((step) => step.traceId)).toEqual(expectedTraceIds);
    expect(projectedTrajectory.map((step) => step.turnIndex)).toEqual([1, 2]);
    expect(projectedTrajectory.map((step) => step.decisionStateHash)).toEqual([hashStableState(nightWolves), hashStableState(nightWolves)]);
    expect(projectedTrajectory.map((step) => step.preStateHash)).toEqual([artifact.steps[0].preStateHash, artifact.steps[1].preStateHash]);
    expect(projectedTrajectory.map((step) => step.postStateHash)).toEqual([artifact.steps[0].postStateHash, artifact.steps[1].postStateHash]);
    expect(projectedTrajectory.map((step) => step.messageSeqRange)).toEqual([
      [1, 2],
      [3, 4]
    ]);
    expect(projectedTrajectory.every((step) => step.command.type === "werewolf.killVote")).toBe(true);
    expect(projectedTrajectory.every((step) => step.turnTrace.traceId === step.traceId)).toBe(true);
    expect(projectedTrajectory.every((step) => step.reasonerOutput.providerRequestId === `batched-legacy-${step.traceId}`)).toBe(true);

    const replay = replayHarnessTrajectory({
      initialState: nightWolves,
      trajectory: projectedTrajectory
    });
    expect(replay.mismatches).toEqual([]);
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedCommands).toBe(projectedTrajectory.length);
    expect(replay.finalHash).toBe(hashStableState(artifact.finalState));
  });

  it("publishes public speech through the generic social bus for later scoped observation", async () => {
    const daySpeech = createGame({ id: "werewolf-social-public-speech", seed: "werewolf-social-public-speech" });
    daySpeech.phase = "day_speech";
    daySpeech.day = 2;
    const speakers = daySpeech.players.filter((player) => player.alive).sort((a, b) => a.seat - b.seat).slice(0, 2);
    expect(speakers).toHaveLength(2);
    const [firstSpeaker, secondSpeaker] = speakers;
    firstSpeaker.role = "seer";
    firstSpeaker.team = "village";
    daySpeech.currentSpeakerSeat = firstSpeaker.seat;

    const environment = WerewolfSocialEnvironment.fromState(daySpeech);
    const reasonerCalls: Array<{
      actorId: string;
      visibleMessages: number;
      visibleKinds: string[];
      visibleSenderIds: string[];
    }> = [];
    const speechByActor: Record<string, string> = {
      [firstSpeaker.id]: "我先给出公开发言：今天重点看夜晚信息缺口、发言顺序和后续施压回应，暂时不急着拍身份。",
      [secondSpeaker.id]: "我接着回应上一轮公开发言：我会记录谁顺着压力走、谁回避问题，并把票型和发言一致性放在一起看。"
    };
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push({
          actorId: input.agent.playerId,
          visibleMessages: input.view.social.messages.length,
          visibleKinds: input.view.social.messages.map((message) => String(message.metadata?.kind)),
          visibleSenderIds: input.view.social.messages.map((message) => message.senderId)
        });
        expect(input.action.kind).toBe("speech");
        expect(input.view.phase).toBe("day_speech");
        if (input.agent.playerId === firstSpeaker.id) {
          expect(input.view.social.messages).toEqual([]);
        } else if (input.agent.playerId === secondSpeaker.id) {
          expect(input.view.social.messages).toHaveLength(1);
          expect(input.view.social.messages[0]).toMatchObject({
            channelId: "table",
            senderId: firstSpeaker.id,
            recipientIds: expect.arrayContaining([secondSpeaker.id]),
            visibility: "public",
            content: speechByActor[firstSpeaker.id],
            metadata: {
              kind: "public-speech",
              actionKind: "speech",
              commandType: "speech.submit",
              day: 2,
              claimedRole: "seer"
            }
          });
        } else {
          throw new Error(`Unexpected speech actor ${input.agent.playerId}.`);
        }
        const content = speechByActor[input.agent.playerId];
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `public-speech-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const actors = speakers.map((speaker) => {
      const actorState: AgentHarnessState = {
        playerId: speaker.id,
        profileId: `${speaker.id}-speech-profile`,
        model: "deterministic-public-speech",
        temperature: 0,
        policyName: policyForRole(speaker.role),
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      };
      return new WerewolfSocialActorAdapter({
        actor: new WerewolfAgentActor(actorState),
        reasoner,
        players: daySpeech.players,
        tracePrefix: "werewolf-social-public-speech"
      });
    });

    const artifact = await runSocialEpisode({
      id: "werewolf-social-public-speech",
      environment,
      actors,
      channels: createWerewolfSocialChannels(daySpeech.players),
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition
    });

    expect(artifact.status).toBe("truncated");
    expect(artifact.truncationReason).toContain("maxTransitions 2");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps.map((step) => step.actorId)).toEqual([firstSpeaker.id, secondSpeaker.id]);
    expect(artifact.steps.map((step) => step.pendingAction)).toEqual([
      expect.objectContaining({ kind: "speech", actorId: firstSpeaker.id, phase: "day_speech" }),
      expect.objectContaining({ kind: "speech", actorId: secondSpeaker.id, phase: "day_speech" })
    ]);
    expect(artifact.steps.map((step) => step.action.command)).toEqual([
      expect.objectContaining({ type: "speech.submit", actorId: firstSpeaker.id, text: speechByActor[firstSpeaker.id] }),
      expect.objectContaining({ type: "speech.submit", actorId: secondSpeaker.id, text: speechByActor[secondSpeaker.id] })
    ]);
    expect(artifact.steps.map((step) => step.messageSeqRange)).toEqual([
      [1, 2],
      [3, 4]
    ]);
    expect(artifact.steps.map((step) => step.eventSeqRange)).toEqual([
      [daySpeech.events.at(-1)!.seq + 1, daySpeech.events.at(-1)!.seq + 1],
      [daySpeech.events.at(-1)!.seq + 2, daySpeech.events.at(-1)!.seq + 2]
    ]);

    const publicSpeechMessages = artifact.messages.filter((message) => message.metadata?.kind === "public-speech");
    const privateMemoMessages = artifact.messages.filter((message) => message.metadata?.kind === "private-reasoner-memo");
    expect(publicSpeechMessages).toHaveLength(2);
    expect(privateMemoMessages).toHaveLength(2);
    expect(publicSpeechMessages[0]).toMatchObject({
      id: "msg-1",
      seq: 1,
      channelId: "table",
      senderId: firstSpeaker.id,
      recipientIds: expect.arrayContaining([secondSpeaker.id]),
      visibility: "public",
      content: speechByActor[firstSpeaker.id],
      metadata: {
        traceId: artifact.steps[0].traceId,
        turnIndex: 1,
        actionKind: "speech",
        commandType: "speech.submit",
        kind: "public-speech",
        day: 2,
        claimedRole: "seer"
      }
    });
    expect(privateMemoMessages[0]).toMatchObject({
      id: "msg-2",
      seq: 2,
      channelId: `private-${firstSpeaker.id}`,
      senderId: firstSpeaker.id,
      recipientIds: [firstSpeaker.id],
      visibility: "private",
      content: speechByActor[firstSpeaker.id],
      metadata: {
        traceId: artifact.steps[0].traceId,
        turnIndex: 1,
        kind: "private-reasoner-memo"
      }
    });
    for (const message of artifact.messages) {
      expect(message.metadata?.role).toBeUndefined();
      expect(message.metadata?.team).toBeUndefined();
      expect(message.metadata?.policyName).toBeUndefined();
    }

    const firstObservation = artifact.steps[0].observation;
    const secondObservation = artifact.steps[1].observation;
    expect(firstObservation.kind).toBe("player");
    expect(secondObservation.kind).toBe("player");
    if (firstObservation.kind !== "player" || secondObservation.kind !== "player") {
      throw new Error("Expected player observations for public speech steps.");
    }
    expect(firstObservation.view.social.messages).toEqual([]);
    expect(secondObservation.view.social.messages).toHaveLength(1);
    expect(secondObservation.view.social.messages[0]).toMatchObject({
      id: "msg-1",
      seq: 1,
      channelId: "table",
      senderId: firstSpeaker.id,
      recipientIds: expect.arrayContaining([secondSpeaker.id]),
      visibility: "public",
      content: speechByActor[firstSpeaker.id],
      metadata: { kind: "public-speech" }
    });
    expect(secondObservation.view.social.messages.some((message) => message.metadata?.kind === "private-reasoner-memo")).toBe(false);

    expect(reasonerCalls).toEqual([
      { actorId: firstSpeaker.id, visibleMessages: 0, visibleKinds: [], visibleSenderIds: [] },
      { actorId: secondSpeaker.id, visibleMessages: 1, visibleKinds: ["public-speech"], visibleSenderIds: [firstSpeaker.id] }
    ]);
    const secondActor = actors[1];
    expect(secondActor.state.observations).toBe(1);
    expect(secondActor.state.turns).toBe(1);
    const secondMemory = secondActor.state.social?.memory.entries ?? [];
    expect(secondMemory.map((entry) => entry.kind)).toEqual(["observation", "message", "memo", "decision"]);
    const observedSpeechMemory = secondMemory.find((entry) => entry.kind === "message");
    const observedPressureTargetId = observedSpeechMemory?.metadata?.pressureTargetId;
    expect(observedPressureTargetId).toEqual(expect.any(String));
    expect(observedSpeechMemory).toMatchObject({
      source: firstSpeaker.id,
      visibility: "public",
      content: speechByActor[firstSpeaker.id],
      evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1, description: "table" }],
      metadata: {
        channelId: "table",
        senderId: firstSpeaker.id,
        kind: "public-speech",
        commandType: "speech.submit",
        claimedRole: "seer",
        pressureTargetId: observedPressureTargetId
      }
    });
    expect(observedSpeechMemory?.tags).toEqual(expect.arrayContaining(["claim:role", "claim:pressure"]));
    expect(secondActor.state.social?.beliefs.claims[`${firstSpeaker.id}:claimedRole`]).toMatchObject({
      subject: firstSpeaker.id,
      predicate: "claimedRole",
      value: "seer",
      confidence: 1,
      evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1, description: "table" }],
      metadata: {
        observerId: secondSpeaker.id,
        speakerId: firstSpeaker.id,
        claimSource: "social-message",
        claimKind: "public-speech",
        channelId: "table",
        visibility: "public",
        messageId: "msg-1",
        messageSeq: 1,
        assertedClaimOnly: true
      }
    });
    expect(secondActor.state.social?.beliefs.claims[`${firstSpeaker.id}:pressuredTarget`]).toMatchObject({
      subject: firstSpeaker.id,
      predicate: "pressuredTarget",
      value: observedPressureTargetId,
      confidence: 1,
      evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1, description: "table" }],
      metadata: {
        observerId: secondSpeaker.id,
        speakerId: firstSpeaker.id,
        claimSource: "social-message",
        claimKind: "public-speech",
        channelId: "table",
        visibility: "public",
        messageId: "msg-1",
        messageSeq: 1,
        targetId: observedPressureTargetId,
        assertedClaimOnly: true
      }
    });
    expect(secondActor.state.social?.relationships.edges[firstSpeaker.id]).toBeUndefined();
    expect(secondActor.state.social?.reputation.records[firstSpeaker.id]).toBeUndefined();
    expect(
      secondActor.state.social?.journal?.entries.some(
        (entry) =>
          (entry.mutationKind === "relationship.updated" || entry.mutationKind === "reputation.updated") &&
          entry.messageSeqRange?.start === 1
      )
    ).toBe(false);
    expect(artifact.finalState.phase).toBe("day_speech");
    expect(artifact.finalState.speeches.map((speech) => speech.playerId)).toEqual([firstSpeaker.id, secondSpeaker.id]);
  });

  it("runs a controlled generic-social Werewolf prefix with reusable adapter wiring", async () => {
    const initialState = createGame({ id: "werewolf-social-controlled-prefix", seed: "werewolf-social-controlled-prefix" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const reasonerCalls: string[] = [];
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push(input.traceId);
        expect(input.action.kind).toBe("inspect");
        expect(input.view.you.id).toBe(seer.id);
        const content = `controlled prefix memo:${input.agent.playerId}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `controlled-prefix-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };

    const result = await runWerewolfSocialHarnessPrefix({
      id: "werewolf-social-controlled-prefix",
      initialState,
      agents: agentConfigsFor(initialState, "controlled-prefix-profile"),
      reasoner,
      maxTransitions: 2
    });

    const expectedTraceId = `${initialState.id}:harness:1:${seer.id}:night_seer`;
    expect(result.artifact.domainId).toBe("werewolf");
    expect(result.artifact.status).toBe("truncated");
    expect(result.artifact.steps).toHaveLength(2);
    expect(result.artifact.steps[0]).toMatchObject({
      actorId: "system",
      resolutionPolicy: "system-transition",
      action: { kind: "system.advance" }
    });
    expect(result.artifact.steps[1]).toMatchObject({
      traceId: expectedTraceId,
      actorId: seer.id,
      schedulerMode: "aec",
      resolutionPolicy: "sequential-apply",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" }
    });
    expect(reasonerCalls).toEqual([expectedTraceId]);
    expect(result.trajectory).toHaveLength(1);
    expect(result.trajectory[0]).toMatchObject({
      traceId: expectedTraceId,
      actorId: seer.id,
      model: "controlled-prefix-profile",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      reasonerOutput: {
        content: expect.stringContaining("controlled prefix memo"),
        providerRequestId: `controlled-prefix-${expectedTraceId}`
      },
      turnTrace: {
        traceId: expectedTraceId,
        playerId: seer.id,
        commandType: "seer.inspect",
        privateMemo: expect.stringContaining("controlled prefix memo")
      }
    });
    expect(result.trajectory[0].messageSeqRange).toEqual([1, 2]);
    expect(result.socialSteps).toHaveLength(1);
    expect(result.socialSteps[0]).toMatchObject({
      traceId: expectedTraceId,
      actorId: seer.id,
      schedulerMode: "aec",
      resolutionPolicy: "sequential-apply",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      observation: {
        phase: "night_seer",
        you: { id: seer.id, role: "seer" },
        social: { messages: [] }
      },
      eventSeqRange: result.trajectory[0].eventSeqRange,
      messageSeqRange: result.trajectory[0].messageSeqRange,
      preStateHash: result.trajectory[0].preStateHash,
      postStateHash: result.trajectory[0].postStateHash
    });
    expect(result.agentStates.find((agent) => agent.playerId === seer.id)).toMatchObject({
      playerId: seer.id,
      turns: 1,
      observations: 1,
      privateMemos: [expect.stringContaining("controlled prefix memo")]
    });
    const replay = replayHarnessTrajectory({
      initialState,
      trajectory: result.trajectory
    });
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.finalHash).toBe(hashStableState(result.artifact.finalState));
  });

  it("keeps failed generic-social attempted steps out of legacy projected trajectories", async () => {
    const initialState = createGame({ id: "werewolf-social-failed-prefix", seed: "werewolf-social-failed-prefix" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const reasoner: HarnessReasoner = {
      async think(input) {
        throw new Error(`planned generic social failure:${input.traceId}`);
      }
    };

    const result = await runWerewolfSocialHarnessPrefix({
      id: "werewolf-social-failed-prefix",
      initialState,
      agents: agentConfigsFor(initialState, "failed-prefix-profile"),
      reasoner,
      maxTransitions: 2
    });

    expect(result.artifact.status).toBe("failed");
    expect(result.artifact.failureReason).toContain("planned generic social failure");
    expect(result.artifact.steps).toHaveLength(2);
    expect(result.artifact.steps[0].actorId).toBe("system");
    expect(result.artifact.steps[1]).toMatchObject({
      actorId: seer.id,
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      error: expect.stringContaining("planned generic social failure")
    });
    expect(result.trajectory).toEqual([]);
    expect(projectWerewolfSocialStepsToHarnessTrajectory(result.artifact.steps)).toEqual([]);
    const failedSeerState = result.agentStates.find((agent) => agent.playerId === seer.id);
    expect(failedSeerState).toMatchObject({
      playerId: seer.id,
      turns: 0,
      observations: 0,
      privateMemos: []
    });
    expect(failedSeerState?.social?.memory.entries).toEqual([]);
    expect(failedSeerState?.social?.journal?.entries ?? []).toEqual([]);
  });

  it("records legacy harness errors for generic provider decision failures without projecting failed steps", async () => {
    let calls = 0;
    const initialState = createGame({ id: "werewolf-social-provider-failure-bridge", seed: "werewolf-social-provider-failure-bridge" });
    const agents = agentConfigsFor(initialState, "provider-failure-bridge-profile");
    const reasoner: HarnessReasoner = {
      async think(input) {
        calls += 1;
        if (calls === 2) {
          throw new ModelCallError("LLM API request failed after 2/3 attempt(s): LLM API request exceeded 42ms.", {
            failureKind: "timeout",
            providerStage: "during_request",
            timeoutMs: 42,
            retryable: true,
            aborted: false,
            attempts: 2,
            maxAttempts: 3,
            providerRequestId: "generic-provider-failure-request-id",
            retryCause: "LLM API request exceeded 42ms.",
            body: "Bearer raw-provider-token-should-not-appear",
            headers: {
              authorization: "Bearer raw-provider-token-should-not-appear"
            }
          });
        }
        const content = `provider failure bridge memo:${input.traceId}:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `provider-failure-bridge-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };

    const result = await runWerewolfSocialHarnessPrefix({
      id: initialState.id,
      initialState,
      agents,
      reasoner,
      maxTransitions: 8
    });
    const harnessErrors = harnessFailureEvidenceFromEpisode(result.artifact);
    const payload = harnessErrors[0]?.payload as Record<string, any>;
    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(result.artifact.steps);

    expect(result.artifact.status).toBe("failed");
    expect(result.artifact.failureReason).toContain("Harness turn failed");
    expect(result.artifact.failureReason).toContain("LLM API request failed after 2/3 attempt");
    expect(result.trajectory).toHaveLength(1);
    expect(projectedTrajectory).toEqual(result.trajectory);
    expect(result.socialSteps).toHaveLength(1);
    expect(harnessErrors).toHaveLength(1);
    expect(payload).toMatchObject({
      model: "provider-failure-bridge-profile",
      actionKind: "kill",
      traceId: expect.stringContaining(`${initialState.id}:harness:2:`),
      message: expect.stringContaining("Harness turn failed"),
      providerFailure: {
        failureKind: "timeout",
        providerStage: "during_request",
        timeoutMs: 42,
        retryable: true,
        aborted: false,
        attempts: 2,
        maxAttempts: 3,
        providerRequestId: "generic-provider-failure-request-id",
        retryCause: "LLM API request exceeded 42ms."
      }
    });
    expect(JSON.stringify(payload)).not.toContain("raw-provider-token-should-not-appear");
    expect(JSON.stringify(result.artifact)).not.toContain("raw-provider-token-should-not-appear");
    expect(result.artifact.messages.map((message) => message.metadata?.kind)).toEqual(["private-seer-inspect", "private-reasoner-memo"]);
    expect(result.artifact.steps.filter((step) => step.error && step.failure?.stage !== "batch_aborted")).toHaveLength(1);
    expect(result.artifact.steps.some((step) => step.failure?.stage === "batch_aborted")).toBe(true);
    expect(result.artifact.steps.some((step) => step.error && step.traceId === payload.traceId)).toBe(true);
    expect(result.artifact.steps.find((step) => step.error)?.failure).toMatchObject({
      stage: "actor_decide"
    });
  });

  it("records legacy harness errors for generic environment step failures without projecting failed steps", async () => {
    const initialState = createGame({ id: "werewolf-social-step-failure-bridge", seed: "werewolf-social-step-failure-bridge" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const actor = new InvalidInspectSocialActor(seer.id);

    const artifact = await runSocialEpisode<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>({
      id: initialState.id,
      environment: WerewolfSocialEnvironment.fromState(initialState),
      actors: [actor],
      channels: createWerewolfSocialChannels(initialState.players),
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition,
      traceIdForDecision: werewolfLegacyTraceId,
      actorTurnIndexForDecision: () => 1,
      onEnvironmentStepFailure: recordWerewolfEnvironmentStepFailure
    });
    const harnessErrors = harnessFailureEvidenceFromEpisode(artifact);
    const payload = harnessErrors[0]?.payload as Record<string, any>;
    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(artifact.steps);

    expect(artifact.status).toBe("failed");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      resolutionPolicy: "system-transition"
    });
    expect(artifact.steps[1]).toMatchObject({
      traceId: `${initialState.id}:harness:1:${seer.id}:night_seer`,
      actorId: seer.id,
      schedulerMode: "aec",
      resolutionPolicy: "sequential-apply",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      action: {
        actorId: seer.id,
        kind: "seer.inspect",
        command: { type: "seer.inspect", actorId: seer.id, targetId: seer.id }
      },
      error: expect.any(String),
      postStateHash: hashStableState(artifact.finalState),
      commitStatus: "rejected",
      failure: expect.objectContaining({ stage: "environment_step" })
    });
    expect(artifact.steps[1].error).toContain("not legal for this pending action");
    expect(projectedTrajectory).toEqual([]);
    expect(artifact.messages).toEqual([]);
    expect(harnessErrors).toHaveLength(1);
    expect(payload).toMatchObject({
      model: "invalid-step-model",
      actionKind: "inspect",
      traceId: `${initialState.id}:harness:1:${seer.id}:night_seer`,
      message: expect.stringContaining("not legal for this pending action")
    });
    expect(JSON.stringify(artifact)).not.toContain("raw-provider-token-should-not-appear");
  });

  it("records legacy harness errors for message validation failures without committing draft messages", async () => {
    const initialState = createGame({ id: "werewolf-social-message-validation-failure", seed: "werewolf-social-message-validation-failure" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const target = initialState.players.find((player) => player.alive && player.id !== seer.id);
    if (!target) throw new Error("Expected a legal seer target.");
    const actor = new InvalidMessageSocialActor(seer.id, target.id);

    const artifact = await runSocialEpisode<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>({
      id: initialState.id,
      environment: WerewolfSocialEnvironment.fromState(initialState),
      actors: [actor],
      channels: createWerewolfSocialChannels(initialState.players),
      schedulerMode: "aec",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      systemTransition: werewolfSystemTransition,
      traceIdForDecision: werewolfLegacyTraceId,
      actorTurnIndexForDecision: () => 1,
      onEnvironmentStepFailure: recordWerewolfEnvironmentStepFailure
    });
    const harnessTurns = werewolfHarnessTurnEvidenceFromEpisode(artifact);
    const harnessErrors = harnessFailureEvidenceFromEpisode(artifact);
    const payload = harnessErrors[0]?.payload as Record<string, any>;
    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(artifact.steps);

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("Unknown social channel missing-channel");
    expect(artifact.finalState.phase).toBe("night_seer");
    expect(artifact.finalState.night.seerInspection).toBeUndefined();
    expect(artifact.finalState.events.some((event) => event.type === "seer.inspected")).toBe(false);
    expect(harnessTurns).toEqual([]);
    expect(harnessErrors).toHaveLength(1);
    expect(payload).toMatchObject({
      model: "invalid-message-model",
      actionKind: "inspect",
      traceId: `${initialState.id}:harness:1:${seer.id}:night_seer`,
      message: expect.stringContaining("Unknown social channel missing-channel")
    });
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      resolutionPolicy: "system-transition"
    });
    expect(artifact.steps[1]).toMatchObject({
      traceId: `${initialState.id}:harness:1:${seer.id}:night_seer`,
      actorId: seer.id,
      schedulerMode: "aec",
      resolutionPolicy: "sequential-apply",
      pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
      action: {
        actorId: seer.id,
        kind: "seer.inspect",
        command: { type: "seer.inspect", actorId: seer.id, targetId: target.id }
      },
      error: expect.stringContaining("Unknown social channel missing-channel"),
      postStateHash: hashStableState(artifact.finalState),
      commitStatus: "rejected",
      failure: expect.objectContaining({ stage: "environment_step" })
    });
    expect(artifact.steps[1].messageSeqRange).toBeUndefined();
    expect(projectedTrajectory).toEqual([]);
    expect(artifact.messages).toEqual([]);
    expect(JSON.stringify(artifact.messages)).not.toContain("draft should never commit");
    expect(JSON.stringify(artifact.steps[1].action.messages)).toContain("draft should never commit");

    const matchArtifact = {
      artifactVersion: "harness.match.v2",
      kind: "match",
      runId: initialState.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      seed: initialState.seed,
      rulesetId: initialState.config.rulesetId,
      config: initialState.config,
      models: ["invalid-message-model"],
      profiles: [{ id: "invalid-message-profile", model: "invalid-message-model" }],
      resolvedAssignments: [],
      status: "failed",
      failureReason: artifact.failureReason,
      failureStateHash: hashStableState(artifact.finalState),
      initialState: artifact.initialState,
      finalState: artifact.finalState,
      trajectory: projectedTrajectory,
      socialEpisode: artifact,
      events: artifact.finalState.events,
      evaluation: {
        teamRewards: { village: 0, werewolves: 0 },
        agentRewards: [],
        voteAccuracyByAgent: {},
        influenceByAgent: {},
        deceptionByAgent: {},
        trajectory: []
      },
      evaluationReport: {
        id: `${initialState.id}:evaluation`,
        createdAt: "2026-07-05T00:00:00.000Z",
        evaluatorIds: [],
        evaluatorRegistry: [],
        metricCount: 0,
        metrics: [],
        outputs: {},
        summary: emptyEvaluationSummary()
      },
      metrics: {
        days: 1,
        totalDeaths: 0,
        totalSpeeches: 0,
        totalVotes: 0,
        harnessTurnCount: 0,
        harnessErrorCount: 1,
        averageLatencyMs: 0,
        wolfVoteAccuracy: 0,
        villageVoteAccuracy: 0,
        deceptionSurvivalScore: 0,
        modelUsage: {}
      },
      agents: []
    } satisfies MatchArtifact;
    const jsonlRecords = toTrajectoryJsonl(matchArtifact)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const failedSocialStep = jsonlRecords.find((record) => record.type === "social_step" && record.error);
    const messageRecords = jsonlRecords.filter((record) => record.type === "message");

    expect(failedSocialStep).toMatchObject({
      traceId: `${initialState.id}:harness:1:${seer.id}:night_seer`,
      error: expect.stringContaining("Unknown social channel missing-channel"),
      messageSeqRange: null
    });
    expect(JSON.stringify(failedSocialStep?.action?.messages)).toContain("draft should never commit");
    expect(messageRecords).toEqual([]);
    expect(JSON.stringify(messageRecords)).not.toContain("draft should never commit");
  });

  it("preserves successful batched prefix and records legacy errors for batched environment step failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-batched-step-failure-bridge", seed: "werewolf-social-batched-step-failure-bridge" });
      const seer = initialState.players.find((player) => player.role === "seer");
      if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
      const afterAdvance = applyCommand(initialState, { type: "system.advance", actorId: "system" });
      const inspectTarget = afterAdvance.players.find((player) => player.alive && player.id !== seer.id);
      if (!inspectTarget) throw new Error("Expected a seer inspect target.");
      const nightWolves = applyCommand(afterAdvance, { type: "seer.inspect", actorId: seer.id, targetId: inspectTarget.id });
      const wolves = nightWolves.players.filter((player) => player.role === "werewolf");
      expect(wolves).toHaveLength(2);
      const [validWolf, invalidWolf] = wolves;
      const reasoner: HarnessReasoner = {
      async think(input) {
        const content = `batched step failure bridge memo:${input.traceId}:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `batched-step-failure-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const validActor = new WerewolfSocialActorAdapter({
      actor: new WerewolfAgentActor({
        playerId: validWolf.id,
        profileId: `${validWolf.id}-batched-step-failure-profile`,
        model: "batched-step-failure-valid-model",
        temperature: 0,
        policyName: policyForRole(validWolf.role),
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      }),
      reasoner,
      players: nightWolves.players
    });
    const invalidActor = new InvalidKillSocialActor(invalidWolf.id, validWolf.id);
    let actorTurnIndex = 0;

    const artifact = await runSocialEpisode<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>({
      id: nightWolves.id,
      environment: WerewolfSocialEnvironment.fromState(nightWolves),
      actors: [validActor, invalidActor],
      channels: createWerewolfSocialChannels(nightWolves.players),
      schedulerMode: "aec-batched-decision",
      maxTransitions: 2,
      hashState: hashStableState,
      eventSeq: werewolfEventSeq,
      assembleObservation: assembleWerewolfSocialObservation,
      traceIdForDecision: werewolfLegacyTraceId,
      actorTurnIndexForDecision: () => {
        actorTurnIndex += 1;
        return actorTurnIndex;
      },
      onEnvironmentStepFailure: recordWerewolfEnvironmentStepFailure
    });
    const expectedTraceIds = [
      `${nightWolves.id}:harness:1:${validWolf.id}:night_wolves`,
      `${nightWolves.id}:harness:2:${invalidWolf.id}:night_wolves`
    ];
    const harnessErrors = harnessFailureEvidenceFromEpisode(artifact);
    const payload = harnessErrors[0]?.payload as Record<string, any>;
    const projectedTrajectory = projectWerewolfSocialStepsToHarnessTrajectory(artifact.steps);

    expect(artifact.status).toBe("failed");
    expect(artifact.failureReason).toContain("not legal for this pending action");
    expect(artifact.steps).toHaveLength(2);
    expect(artifact.steps[0]).toMatchObject({
      traceId: expectedTraceIds[0],
      turnIndex: 1,
      actorId: validWolf.id,
      schedulerMode: "aec-batched-decision",
      resolutionPolicy: "sequential-apply-from-shared-decision-state",
      postStateHash: expect.any(String),
      eventSeqRange: [nightWolves.events.at(-1)!.seq + 1, nightWolves.events.at(-1)!.seq + 1],
      messageSeqRange: [1, 2]
    });
    expect(artifact.steps[1]).toMatchObject({
      traceId: expectedTraceIds[1],
      turnIndex: 2,
      actorId: invalidWolf.id,
      schedulerMode: "aec-batched-decision",
      resolutionPolicy: "sequential-apply-from-shared-decision-state",
      batchIndex: 1,
      batchSize: 2,
      action: {
        actorId: invalidWolf.id,
        kind: "werewolf.killVote",
        command: { type: "werewolf.killVote", actorId: invalidWolf.id, targetId: validWolf.id }
      },
      error: expect.stringContaining("not legal for this pending action"),
      preStateHash: artifact.steps[0].postStateHash,
      postStateHash: hashStableState(artifact.finalState),
      commitStatus: "rejected",
      failure: expect.objectContaining({ stage: "environment_step" })
    });
    expect(artifact.steps[1].messageSeqRange).toBeUndefined();
    expect(artifact.messages.map((message) => message.metadata?.kind)).toEqual(["werewolf-kill-vote", "private-reasoner-memo"]);
    expect(artifact.messages.every((message) => message.metadata?.traceId === expectedTraceIds[0])).toBe(true);
    expect(harnessErrors).toHaveLength(1);
    expect(payload).toMatchObject({
      model: "invalid-kill-model",
      actionKind: "kill",
      traceId: expectedTraceIds[1],
      message: expect.stringContaining("not legal for this pending action")
    });
    expect(projectedTrajectory).toHaveLength(1);
    expect(projectedTrajectory[0]).toMatchObject({
      traceId: expectedTraceIds[0],
      actorId: validWolf.id,
      command: { type: "werewolf.killVote", actorId: validWolf.id }
    });
    const replay = replayHarnessTrajectory({
      initialState: nightWolves,
      trajectory: projectedTrajectory
    });
    expect(replay.mismatches).toEqual([]);
    expect(replay.ok).toBe(true);
    expect(replay.finalHash).toBe(projectedTrajectory[0].postStateHash);
    expect(replay.finalHash).toBe(hashStableState(artifact.finalState));
      expect(JSON.stringify(artifact)).not.toContain("raw-provider-token-should-not-appear");
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects a controlled system-advance to seer-inspect prefix into replayable legacy records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-legacy-prefix-parity", seed: "werewolf-social-legacy-prefix-parity" });
      const seer = initialState.players.find((player) => player.role === "seer");
      if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
      const agents = agentConfigsFor(initialState, "legacy-prefix-parity-profile");
      const reasoner: HarnessReasoner = {
        async think(input) {
          const content = `generic prefix memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `legacy-parity-${input.traceId}`,
              attempts: 1
            }
          };
        }
      };

      const generic = await runWerewolfSocialHarnessPrefix({
        id: initialState.id,
        initialState,
        agents,
        reasoner,
        maxTransitions: 2
      });
      const replay = replayHarnessTrajectory({
        initialState: generic.artifact.initialState,
        trajectory: generic.trajectory
      });

      const expectedTraceId = `${initialState.id}:harness:1:${seer.id}:night_seer`;
      expect(generic.artifact.status).toBe("truncated");
      expect(generic.artifact.truncationReason).toContain("maxTransitions 2");
      expect(generic.artifact.finalState.phase).toBe("night_wolves");
      expect(generic.artifact.steps).toHaveLength(2);
      expect(generic.artifact.steps[0]).toMatchObject({
        actorId: "system",
        resolutionPolicy: "system-transition",
        action: {
          kind: "system.advance",
          command: { type: "system.advance", actorId: "system" }
        }
      });
      expect(generic.trajectory).toHaveLength(1);
      expect(generic.trajectory[0].traceId).toBe(expectedTraceId);
      expect(generic.trajectory[0]).toMatchObject({
        turnIndex: 1,
        actorId: seer.id,
        command: { type: "seer.inspect", actorId: seer.id, targetId: expect.any(String) },
        pendingAction: { kind: "inspect", actorId: seer.id, phase: "night_seer" },
        eventSeqRange: [3, 4],
        messageSeqRange: [1, 2],
        turnTrace: {
          traceId: expectedTraceId,
          playerId: seer.id,
          actionKind: "inspect",
          policyName: "seer-information",
          commandType: "seer.inspect",
          providerRequestId: `legacy-parity-${expectedTraceId}`
        }
      });
      expect(generic.socialSteps.map((step) => step.traceId)).toEqual(generic.trajectory.map((step) => step.traceId));
      expect(generic.socialSteps[0]).toMatchObject({
        traceId: expectedTraceId,
        schedulerMode: "aec",
        resolutionPolicy: "sequential-apply",
        action: {
          actorId: seer.id,
          kind: "seer.inspect",
          command: generic.trajectory[0].command
        },
        messageSeqRange: [1, 2]
      });
      expect(generic.artifact.messages).toHaveLength(2);
      expect(generic.artifact.messages.map((message) => message.metadata?.kind)).toEqual([
        "private-seer-inspect",
        "private-reasoner-memo"
      ]);
      expect(generic.artifact.messages.every((message) => message.metadata?.traceId === expectedTraceId)).toBe(true);
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.finalHash).toBe(hashStableState(generic.artifact.finalState));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a Werewolf kill-vote batch complete when maxTransitions lands inside the batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-batch-boundary", seed: "werewolf-social-batch-boundary" });
      const wolves = initialState.players.filter((player) => player.role === "werewolf");
      expect(wolves).toHaveLength(2);
      const agents = agentConfigsFor(initialState, "batch-boundary-profile");
      const reasoner: HarnessReasoner = {
        async think(input) {
          const content = `batch boundary memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `batch-boundary-${input.traceId}`,
              attempts: 1
            }
          };
        }
      };

      const result = await runWerewolfSocialHarnessPrefixAsHarnessResult({
        id: initialState.id,
        initialState,
        agents,
        reasoner,
        maxTransitions: 3
      });
      const replay = replayHarnessTrajectory({
        initialState: result.initialState,
        trajectory: result.trajectory
      });
      const killSteps = result.trajectory.filter((step) => step.command.type === "werewolf.killVote");
      const socialKillSteps = result.socialEpisode.steps.filter((step) => step.action.command.type === "werewolf.killVote");
      const killMessages = result.socialEpisode.messages.filter((message) => message.metadata?.kind === "werewolf-kill-vote");

      expect(result.status).toBe("truncated");
      expect(result.truncationReason).toContain("maxTransitions 3");
      expect(result.failureReason).toBeUndefined();
      expect(result.state.phase).toBe("night_witch");
      expect(result.trajectory.map((step) => step.command.type)).toEqual(["seer.inspect", "werewolf.killVote", "werewolf.killVote"]);
      expect(killSteps).toHaveLength(2);
      expect(killSteps.map((step) => step.actorId).sort()).toEqual(wolves.map((wolf) => wolf.id).sort());
      expect(new Set(killSteps.map((step) => step.decisionStateHash)).size).toBe(1);
      expect(Object.keys(result.state.night.wolfVotes).sort()).toEqual(wolves.map((wolf) => wolf.id).sort());
      expect(socialKillSteps).toHaveLength(2);
      expect(new Set(socialKillSteps.map((step) => step.batchId)).size).toBe(1);
      expect(socialKillSteps.every((step) => step.schedulerMode === "aec-batched-decision")).toBe(true);
      expect(socialKillSteps.every((step) => step.batchId?.includes(":batch:"))).toBe(true);
      expect(socialKillSteps.map((step) => step.batchIndex)).toEqual([3, 3]);
      expect(socialKillSteps.map((step) => step.batchSize)).toEqual([2, 2]);
      expect(killMessages).toHaveLength(2);
      expect(killMessages.map((message) => message.metadata?.traceId)).toEqual(killSteps.map((step) => step.traceId));
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.finalHash).toBe(hashStableState(result.state));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a controlled mixed-scheduler prefix replayable through public speech", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-legacy-mixed-prefix-parity", seed: "werewolf-social-legacy-mixed-prefix-parity" });
      const agents = agentConfigsFor(initialState, "legacy-mixed-prefix-profile");
      const reasoner: HarnessReasoner = {
        async think(input) {
          const content =
            input.action.kind === "speech"
              ? `公开发言 ${input.agent.playerId}：我会结合夜间信息、狼队协作痕迹和公开发言顺序继续推进。`
              : `legacy mixed parity memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `legacy-mixed-parity-${input.traceId}`,
              attempts: 2,
              retryHistory: [
                {
                  attempt: 1,
                  failureKind: "http",
                  providerStage: "http_response",
                  status: 429,
                  retryable: true,
                  delayMs: 25,
                  message: "planned retry before success"
                }
              ],
              stream: {
                enabled: true,
                completed: true,
                completedBy: "done_sentinel"
              }
            }
          };
        }
      };

      const generic = await runWerewolfSocialHarnessPrefix({
        id: initialState.id,
        initialState,
        agents,
        reasoner,
        maxTransitions: 7
      });
      const replay = replayHarnessTrajectory({
        initialState: generic.artifact.initialState,
        trajectory: generic.trajectory
      });

      expect(generic.artifact.status).toBe("truncated");
      expect(generic.artifact.truncationReason).toContain("maxTransitions 7");
      expect(generic.artifact.finalState.phase).toBe("day_speech");
      expect(generic.trajectory.map((step) => step.command.type)).toEqual([
        "seer.inspect",
        "werewolf.killVote",
        "werewolf.killVote",
        "witch.act",
        "speech.submit",
        "speech.submit"
      ]);
      expect(generic.socialSteps.map((step) => step.traceId)).toEqual(generic.trajectory.map((step) => step.traceId));
      expect(generic.artifact.messages).toHaveLength(12);
      expect(generic.trajectory.every((step) => step.reasonerOutput.retryHistory?.[0]?.failureKind === "http")).toBe(true);
      expect(generic.trajectory.every((step) => step.reasonerOutput.stream?.completedBy === "done_sentinel")).toBe(true);
      const killSteps = generic.socialSteps.filter((step) => step.action.command.type === "werewolf.killVote");
      expect(killSteps).toHaveLength(2);
      expect(new Set(killSteps.map((step) => step.decisionStateHash)).size).toBe(1);
      expect(killSteps.map((step) => step.batchId)).toEqual([
        `${initialState.id}:werewolf-batch:1`,
        `${initialState.id}:werewolf-batch:1`
      ]);
      expect(killSteps.map((step) => step.batchIndex)).toEqual([1, 2]);
      expect(killSteps.map((step) => step.batchSize)).toEqual([2, 2]);
      expect(generic.socialSteps.filter((step) => step.action.command.type === "speech.submit").every((step) => step.schedulerMode === "aec")).toBe(true);
      for (const step of generic.socialSteps) {
        const [start, end] = step.messageSeqRange ?? [];
        expect(typeof start).toBe("number");
        expect(typeof end).toBe("number");
        const stepMessages = generic.artifact.messages.filter((message) => message.seq >= start! && message.seq <= end!);
        expect(stepMessages).toHaveLength(end! - start! + 1);
        expect(stepMessages.every((message) => message.metadata?.traceId === step.traceId)).toBe(true);
      }
      expect(generic.artifact.messages.filter((message) => message.metadata?.kind === "public-speech")).toHaveLength(2);
      expect(generic.artifact.messages.filter((message) => message.metadata?.kind === "werewolf-kill-vote")).toHaveLength(2);
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.replayedCommands).toBe(generic.trajectory.length);
      expect(replay.finalHash).toBe(hashStableState(generic.artifact.finalState));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the production runHarnessMatch wrapper legacy-shaped and replayable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-full-result-parity", seed: "werewolf-social-full-result-parity" });
      const agents = agentConfigsFor(initialState, "full-result-parity-profile");
      const reasoner: HarnessReasoner = {
        async think(input) {
          const content =
            input.action.kind === "speech"
              ? `公开发言 ${input.agent.playerId}：我会结合夜间信息、狼队协作痕迹和公开发言顺序继续推进。`
              : `full result parity memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `full-result-parity-${input.traceId}`,
              attempts: 2,
              retryHistory: [
                {
                  attempt: 1,
                  failureKind: "http",
                  providerStage: "http_response",
                  status: 429,
                  retryable: true,
                  delayMs: 25,
                  message: "planned retry before success"
                }
              ],
              stream: {
                enabled: true,
                completed: true,
                completedBy: "done_sentinel"
              }
            }
          };
        }
      };

      const result = await runHarnessMatch({
        initialState,
        agents,
        reasoner,
        maxTransitions: 7
      });

      const replay = replayHarnessTrajectory({
        initialState: result.initialState,
        trajectory: result.trajectory
      });
      const harnessTurns = werewolfHarnessTurnEvidenceFromEpisode(result.socialEpisode);
      const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
      const successfulSocialSteps = result.socialEpisode.steps.filter((step) => !step.error && step.actorId !== "system");

      expect(result.status).toBe("truncated");
      expect(result.truncationReason).toContain("maxTransitions 7");
      expect(result.failureReason).toBeUndefined();
      expect(result.failureStateHash).toBeUndefined();
      expect(result.forkOf).toBeUndefined();
      expect(result.initialState.id).toBe(initialState.id);
      expect(result.state.phase).toBe("day_speech");
      expect(result.metrics.harnessTurnCount).toBe(harnessTurns.length);
      expect(result.metrics.harnessErrorCount).toBe(harnessErrors.length);
      expect(result.metrics.modelUsage["full-result-parity-profile"].calls).toBe(result.trajectory.length);
      expect(result.trajectory.map((step) => step.command.type)).toEqual([
        "seer.inspect",
        "werewolf.killVote",
        "werewolf.killVote",
        "witch.act",
        "speech.submit",
        "speech.submit"
      ]);
      expect(result.trajectory.every((step) => step.command && step.actorId !== "system")).toBe(true);
      expect(result.trajectory.map((step) => step.traceId)).toEqual(successfulSocialSteps.map((step) => step.traceId));
      expect(result.socialEpisode).toMatchObject({
        status: "truncated",
        truncationReason: result.truncationReason
      });
      expect(result.socialEpisode.messages).toHaveLength(12);
      expect(result.socialEpisode.channels.map((channel) => channel.kind)).toEqual(expect.arrayContaining(["public", "team", "private"]));
      expect(result.agents).toHaveLength(initialState.players.length);
      expect(result.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(result.evaluationReport.metricCount).toBe(result.evaluationReport.metrics.length);
      expect(result.evaluationReport.metrics.length).toBeGreaterThan(0);
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.replayedCommands).toBe(result.trajectory.length);
      expect(replay.finalHash).toBe(hashStableState(result.state));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps provider-backed decision failures as failed full HarnessRunResult artifacts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-failed-result-parity", seed: "werewolf-social-failed-result-parity" });
      const agents = agentConfigsFor(initialState, "failed-result-parity-profile");
      const makeReasoner = (): HarnessReasoner => {
        let calls = 0;
        return {
          async think(input) {
            calls += 1;
            if (calls === 2) {
              throw new ModelCallError("LLM API request failed after 2/3 attempt(s): LLM API request exceeded 42ms.", {
                failureKind: "timeout",
                providerStage: "during_request",
                timeoutMs: 42,
                retryable: true,
                aborted: false,
                attempts: 2,
                maxAttempts: 3,
                providerRequestId: "failed-result-parity-request-id",
                retryCause: "LLM API request exceeded 42ms.",
                body: "Bearer raw-provider-token-should-not-appear",
                headers: {
                  authorization: "Bearer raw-provider-token-should-not-appear"
                }
              });
            }
            const content =
              input.action.kind === "speech"
                ? `公开发言 ${input.agent.playerId}：我会围绕公开票型、发言顺序和夜间结果分析，先找视角冲突再推动集中投票。`
                : `failed result parity memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
            return {
              content,
              completion: {
                content,
                latencyMs: 1,
                usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
                providerRequestId: `failed-result-parity-${input.traceId}`,
                attempts: 2,
                retryHistory: [
                  {
                    attempt: 1,
                    failureKind: "http",
                    providerStage: "http_response",
                    status: 429,
                    retryable: true,
                    delayMs: 25,
                    message: "planned retry before success"
                  }
                ],
                stream: {
                  enabled: true,
                  completed: true,
                  completedBy: "done_sentinel"
                }
              }
            };
          }
        };
      };

      const result = await runWerewolfSocialHarnessPrefixAsHarnessResult({
        id: initialState.id,
        initialState,
        agents,
        reasoner: makeReasoner(),
        maxTransitions: 8
      });
      const replay = replayHarnessTrajectory({
        initialState: result.initialState,
        trajectory: result.trajectory
      });
      const harnessTurns = werewolfHarnessTurnEvidenceFromEpisode(result.socialEpisode);
      const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
      const payload = harnessErrors[0]?.payload as Record<string, any>;

      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("LLM API request failed after 2/3 attempt(s)");
      expect(result.failureReason).toContain("exceeded 42ms");
      expect(result.failureStateHash).toBe(hashStableState(result.state));
      expect(result.forkOf).toBeUndefined();
      expect(result.metrics).toMatchObject({ harnessTurnCount: 1, harnessErrorCount: 1 });
      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0]).toMatchObject({
        turnIndex: 1,
        command: { type: "seer.inspect" },
        pendingAction: { kind: "inspect", phase: "night_seer" },
        reasonerOutput: {
          retryHistory: [expect.objectContaining({ failureKind: "http" })],
          stream: expect.objectContaining({ completedBy: "done_sentinel" })
        }
      });
      expect(result.socialEpisode).toMatchObject({
        status: "failed",
        failureReason: result.failureReason,
        error: result.failureReason
      });
      expect(result.socialEpisode.steps.filter((step) => isSocialStepCommitted(step) && step.actorId !== "system").map((step) => step.traceId)).toEqual(
        result.trajectory.map((step) => step.traceId)
      );
      expect(result.socialEpisode.steps.at(-1)).toMatchObject({ commitStatus: "rejected", failure: expect.any(Object) });
      expect(result.socialEpisode.messages).toHaveLength(2);
      expect(harnessTurns).toHaveLength(2);
      expect(harnessTurns.filter(({ step }) => isSocialStepCommitted(step))).toHaveLength(1);
      expect(harnessTurns.some(({ step }) => step.failure?.stage === "batch_aborted")).toBe(true);
      expect(harnessErrors).toHaveLength(1);
      expect(payload).toMatchObject({
        model: "failed-result-parity-profile",
        actionKind: "kill",
        message: result.failureReason,
        traceId: expect.stringContaining(`${initialState.id}:harness:2:`),
        providerFailure: {
          failureKind: "timeout",
          providerStage: "during_request",
          timeoutMs: 42,
          retryable: true,
          aborted: false,
          attempts: 2,
          maxAttempts: 3,
          providerRequestId: "failed-result-parity-request-id",
          retryCause: "LLM API request exceeded 42ms."
        }
      });
      expect(JSON.stringify(result)).not.toContain("raw-provider-token-should-not-appear");
      expect(result.agents).toHaveLength(initialState.players.length);
      expect(result.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(result.evaluationReport.metricCount).toBe(result.evaluationReport.metrics.length);
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.replayedCommands).toBe(result.trajectory.length);
      expect(replay.finalHash).toBe(result.trajectory.at(-1)?.postStateHash);
      expect(replay.finalHash).toBe(result.failureStateHash);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps generic environment-step rejection out of committed replay trajectories", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-env-rejection-parity", seed: "werewolf-social-env-rejection-parity" });
      const seer = initialState.players.find((player) => player.role === "seer");
      if (!seer) throw new Error("Expected default config to include a seer.");
      initialState.phase = "night_seer";
      initialState.day = 1;
      initialState.night = { wolfVotes: {} };
      for (const player of initialState.players) {
        if (player.id === seer.id) continue;
        player.alive = false;
        player.eliminatedAt = { day: 1, phase: "night_resolve", reason: "night_kill" };
      }
      const agents = agentConfigsFor(initialState, "env-rejection-parity-profile");
      const makeReasoner = (): HarnessReasoner => ({
        async think(input) {
          expect(input.action.kind).toBe("inspect");
          const content = `environment rejection parity memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `env-rejection-parity-${input.traceId}`,
              attempts: 1
            }
          };
        }
      });
      const setupPending = getPendingActions(initialState).filter((action) => action.kind !== "advance");
      expect(setupPending).toEqual([
        expect.objectContaining({
          kind: "inspect",
          actorId: seer.id,
          legalTargetIds: []
        })
      ]);

      const result = await runWerewolfSocialHarnessPrefixAsHarnessResult({
        id: initialState.id,
        initialState,
        agents,
        reasoner: makeReasoner(),
        maxTransitions: 2
      });
      const replay = replayHarnessTrajectory({
        initialState: result.initialState,
        trajectory: result.trajectory
      });
      const harnessTurns = werewolfHarnessTurnEvidenceFromEpisode(result.socialEpisode);
      const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
      const turnPayload = harnessTurns[0]?.trace as Record<string, any>;
      const errorPayload = harnessErrors[0]?.payload as Record<string, any>;

      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("Command seer.inspect target undefined is not legal");
      expect(result.failureReason).toContain("not legal for this pending action");
      expect(result.failureReason).not.toContain("Harness turn failed");
      expect(result.failureStateHash).toBe(hashStableState(result.state));
      expect(result.metrics).toMatchObject({ harnessTurnCount: 0, harnessErrorCount: 1 });
      expect(result.trajectory).toHaveLength(0);
      expect(result.socialEpisode.steps).toHaveLength(1);
      expect(result.socialEpisode.steps[0]).toMatchObject({ commitStatus: "rejected", failure: { stage: "environment_step" } });
      expect(result.socialEpisode.messages).toEqual([]);
      expect(result.socialEpisode).toMatchObject({
        status: "failed",
        failureReason: result.failureReason,
        error: result.failureReason
      });
      expect(result.state.phase).toBe("night_seer");
      expect(result.state.night.seerInspection).toBeUndefined();
      expect(result.state.events.some((event) => event.type === "seer.inspected")).toBe(false);
      expect(harnessTurns).toHaveLength(1);
      expect(harnessErrors).toHaveLength(1);
      expect(harnessTurns[0].turnIndex).toBeLessThanOrEqual(harnessErrors[0].turnIndex);
      expect(turnPayload).toMatchObject({
        playerId: seer.id,
        actionKind: "inspect",
        policyName: "seer-information",
        commandType: "seer.inspect"
      });
      expect(errorPayload).toMatchObject({
        model: "env-rejection-parity-profile",
        actionKind: "inspect",
        message: result.failureReason,
        traceId: turnPayload.traceId,
        providerRequestId: turnPayload.providerRequestId,
        attempts: turnPayload.attempts
      });
      expect(errorPayload.providerFailure).toBeUndefined();
      expect(result.agents).toHaveLength(initialState.players.length);
      expect(result.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(result.evaluationReport.metricCount).toBe(result.evaluationReport.metrics.length);
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.replayedCommands).toBe(0);
      expect(replay.finalHash).toBe(hashStableState(result.initialState));
      expect(replay.finalHash).toBe(result.failureStateHash);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a failed full HarnessRunResult for generic initialization failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-init-failure-parity", seed: "werewolf-social-init-failure-parity" });
      const agents = agentConfigsFor(initialState, "init-failure-parity-profile").slice(1);
      const reasonerCalls: string[] = [];
      const reasoner: HarnessReasoner = {
        async think(input) {
          reasonerCalls.push(input.traceId);
          throw new Error("initialization failure test should not call the reasoner");
        }
      };

      const result = await runWerewolfSocialHarnessPrefixAsHarnessResult({
        id: initialState.id,
        initialState,
        agents,
        reasoner,
        maxTransitions: 2
      });
      const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
      const payload = harnessErrors[0]?.payload as Record<string, any>;

      expect(reasonerCalls).toEqual([]);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain(`No harness agent config for ${initialState.players[0].id}`);
      expect(result.failureStateHash).toBe(hashStableState(result.state));
      expect(result.metrics).toMatchObject({ harnessTurnCount: 0, harnessErrorCount: 0 });
      expect(result.trajectory).toEqual([]);
      expect(result.socialEpisode.steps).toEqual([]);
      expect(result.socialEpisode.messages).toEqual([]);
      expect(result.socialEpisode).toMatchObject({
        status: "failed",
        failureReason: result.failureReason,
        error: result.failureReason
      });
      expect(result.agents).toEqual([]);
      expect(result.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(result.evaluationReport.metricCount).toBe(result.evaluationReport.metrics.length);
      expect(harnessErrors).toEqual([]);
      expect(payload).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a completed generic Werewolf HarnessRunResult artifact and JSONL contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-completed-result-parity", seed: "werewolf-social-completed-result-parity" });
      const profiles = profilesFromModels(["completed-alpha", "completed-beta"], 0);
      const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0);
      const reasoner: HarnessReasoner = {
        async think(input) {
          const content =
            input.action.kind === "speech"
              ? `公开发言 ${input.agent.playerId}：我会结合公开发言、票型压力、夜间死亡和队友行为持续推进，给出清晰怀疑目标并避免无效分票。`
              : `completed result parity memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `completed-result-parity-${input.traceId}`,
              attempts: 1
            }
          };
        }
      };

      const result = await runWerewolfSocialHarnessPrefixAsHarnessResult({
        id: initialState.id,
        initialState,
        agents,
        reasoner,
        maxTransitions: 320,
        recordAgentSnapshots: false
      });
      const artifactOptions = {
        runId: "werewolf-social-completed-result-parity",
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: initialState.seed,
        models: profiles.map((profile) => profile.model),
        profiles,
        resolvedAssignments: describeResolvedAssignments(initialState.players, agents)
      };
      const genericArtifact = buildMatchArtifact({
        ...artifactOptions,
        result
      });
      const replay = replayHarnessTrajectory({
        initialState: result.initialState,
        trajectory: result.trajectory
      });
      const jsonlRecords = toTrajectoryJsonl(genericArtifact)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });

      expect(result.status).toBe("completed");
      expect(result.failureReason).toBeUndefined();
      expect(result.failureStateHash).toBeUndefined();
      expect(result.truncationReason).toBeUndefined();
      expect(result.state.phase).toBe("game_over");
      expect(result.state.winner).toBeDefined();
      expect(result.state.events.some((event) => event.type === "game.ended")).toBe(true);
      expect(result.trajectory.length).toBeGreaterThan(0);
      expect(result.socialEpisode.status).toBe("completed");
      expect(result.socialEpisode.steps.length).toBeGreaterThan(result.trajectory.length);
      expect(result.socialEpisode.steps.filter((step) => isSocialStepCommitted(step) && step.actorId !== "system").map((step) => step.traceId)).toEqual(
        result.trajectory.map((step) => step.traceId)
      );
      expect(result.agents).toHaveLength(initialState.players.length);
      expect(result.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(result.evaluationReport.metricCount).toBe(result.evaluationReport.metrics.length);
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.replayedCommands).toBe(result.trajectory.length);
      expect(replay.finalHash).toBe(hashStableState(result.state));
      expect(genericArtifact.status).toBe("completed");
      expect(genericArtifact.failureReason).toBeUndefined();
      expect(genericArtifact.failureStateHash).toBeUndefined();
      expect(hashStableState(genericArtifact.finalState)).toBe(hashStableState(result.state));
      expect(genericArtifact.trajectory).toHaveLength(result.trajectory.length);
      expect(genericArtifact.socialEpisode.steps.length).toBeGreaterThan(genericArtifact.trajectory.length);
      expect(genericArtifact.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(genericArtifact.evaluationReport.metricCount).toBe(genericArtifact.evaluationReport.metrics.length);
      expect(jsonlRecords.filter((record) => record.type === "header")).toHaveLength(1);
      expect(jsonlRecords.filter((record) => record.type === "match_metrics")).toHaveLength(1);
      expect(jsonlRecords.filter((record) => record.type === "evaluation_report")).toHaveLength(1);
      expect(jsonlRecords.filter((record) => record.type === "channel")).toHaveLength(genericArtifact.socialEpisode.channels.length);
      expect(jsonlRecords.filter((record) => record.type === "social_step")).toHaveLength(genericArtifact.socialEpisode.steps.length);
      expect(jsonlRecords.filter((record) => record.type === "step")).toHaveLength(genericArtifact.trajectory.length);
      expect(jsonlRecords.filter((record) => record.type === "trace")).toHaveLength(genericArtifact.trajectory.length);
      expect(jsonlRecords.filter((record) => record.type === "message")).toHaveLength(genericArtifact.socialEpisode.messages.length);
      expect(jsonlRecords.filter((record) => record.type === "agent_state")).toHaveLength(genericArtifact.agents.length);
      expect(jsonlRecords.filter((record) => record.type === "metric")).toHaveLength(genericArtifact.evaluationReport.metrics.length);
      expect(jsonlRecords.filter((record) => record.type === "error")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  }, 60000);

  it("restores checkpoint society state when forking through the generic wrapper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    try {
      const initialState = createGame({ id: "werewolf-social-fork-result-parity", seed: "werewolf-social-fork-result-parity" });
      const profiles = profilesFromModels(["fork-alpha", "fork-beta"], 0);
      const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0);
      const reasoner: HarnessReasoner = {
        async think(input) {
          const content =
            input.action.kind === "speech"
              ? `公开发言 ${input.agent.playerId}：checkpoint fork 后我会基于已经可见的公开发言继续推进，保持前后一致的怀疑链和投票压力。`
              : `fork result parity memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}:prior=${input.agent.turns}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `fork-result-parity-${input.traceId}`,
              attempts: 1
            }
          };
        }
      };

      const parent = await runHarnessMatch({
        initialState,
        agents,
        reasoner,
        maxTransitions: 7
      });
      const parentArtifact = buildMatchArtifact({
        runId: "werewolf-social-fork-parent-run",
        matchId: "werewolf-social-fork-parent-match",
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: initialState.seed,
        models: profiles.map((profile) => profile.model),
        profiles,
        resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
        result: parent
      });
      const forkPending = getPendingActions(parentArtifact.finalState).filter((action) => action.kind !== "advance");
      expect(parent.status).toBe("truncated");
      expect(forkPending).toHaveLength(1);
      const nextActorId = forkPending[0].actorId;
      if (!nextActorId) throw new Error("Expected the fork checkpoint to resume on an agent action.");
      const restoredAgent = parentArtifact.agents.find((agent) => agent.playerId === nextActorId);
      if (!restoredAgent) throw new Error(`Expected restored state for ${nextActorId}.`);
      const restoredTurns = restoredAgent.turns;
      const checkpoint = buildFinalHarnessCheckpoint({
        artifact: parentArtifact,
        checkpointId: "werewolf-social-fork-checkpoint",
        createdAt: "2026-07-05T00:00:00.000Z",
        reason: "generic social fork parity"
      });

      const expectedVisibleParentMessageIds = visibleParentMessageIds(checkpoint.executionPrefix.messages, nextActorId);
      expect(expectedVisibleParentMessageIds.length).toBeGreaterThan(0);
      const forkReasonerCalls: Array<{ traceId: string; actorId: string; priorTurns: number; visibleParentMessageIds: string[] }> = [];
      const makeForkReasoner = (
        calls: Array<{ traceId: string; actorId: string; priorTurns: number; visibleParentMessageIds: string[] }>
      ): HarnessReasoner => ({
        async think(input) {
          calls.push({
            traceId: input.traceId,
            actorId: input.action.actorId,
            priorTurns: input.agent.turns,
            visibleParentMessageIds: input.view.social.messages
              .filter((message) => checkpoint.executionPrefix.messages.some((parentMessage) => parentMessage.id === message.id))
              .map((message) => message.id)
          });
          const content =
            input.action.kind === "speech"
              ? `公开发言 ${input.agent.playerId}：我从 checkpoint 恢复后继续沿用已有公开信息，明确说明怀疑来源并保持可复盘。`
              : `fork resume memo:${input.traceId}:${input.agent.playerId}:${input.action.kind}:prior=${input.agent.turns}`;
          return {
            content,
            completion: {
              content,
              latencyMs: 1,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
              providerRequestId: `fork-resume-${input.traceId}`,
              attempts: 1
            }
          };
        }
      });
      const forkOptionsBase = {
        checkpoint,
        maxTransitions: 1,
        createdAt: "2026-07-05T00:01:00.000Z",
        reason: "continue one generic social fork action"
      };
      const forkOptions = forkHarnessRunOptions({
        ...forkOptionsBase,
        reasoner: makeForkReasoner(forkReasonerCalls)
      });
      const checkpointBeforeFork = normalizeJson(checkpoint);

      const fork = await runWerewolfSocialHarnessPrefixAsHarnessResult({
        id: checkpoint.state.id,
        ...forkOptions
      });

      expect(checkpoint).toEqual(checkpointBeforeFork);
      expect(fork.status).toBe("truncated");
      expect(fork.truncationReason).toContain("maxTransitions 1");
      expect(fork.failureReason).toBeUndefined();
      expect(fork.failureStateHash).toBeUndefined();
      expect(fork.forkOf).toEqual(forkOptions.forkOf);
      expect(normalizeJson(fork.initialState)).toEqual(normalizeJson(checkpoint.state));
      expect(fork.trajectory).toHaveLength(1);
      expect(fork.socialEpisode.steps).toHaveLength(1);
      expect(fork.socialEpisode.steps[0].traceId).toBe(fork.trajectory[0].traceId);
      expect(fork.trajectory[0].preStateHash).toBe(checkpoint.source.stateHash);
      expect(fork.trajectory[0].messageSeqRange?.[0]).toBe((checkpoint.source.lastMessageSeq ?? 0) + 1);
      expect(fork.socialEpisode.messages.slice(0, checkpoint.executionPrefix.messages.length)).toEqual(checkpoint.executionPrefix.messages);
      expect(fork.socialEpisode.messages.at(-1)?.seq).toBe(fork.trajectory[0].messageSeqRange?.[1]);
      expect(fork.agents.find((agent) => agent.playerId === nextActorId)?.turns).toBe(restoredTurns + 1);
      expect(fork.metrics.harnessTurnCount).toBe(werewolfHarnessTurnEvidenceFromEpisode(fork.socialEpisode).length);
      expect(fork.evaluation.agentRewards).toHaveLength(initialState.players.length);
      expect(fork.evaluationReport.metricCount).toBe(fork.evaluationReport.metrics.length);
      expect(forkReasonerCalls).toEqual([
        {
          traceId: fork.trajectory[0].traceId,
          actorId: nextActorId,
          priorTurns: restoredTurns,
          visibleParentMessageIds: expectedVisibleParentMessageIds
        }
      ]);

      const replay = replayHarnessTrajectory({
        initialState: fork.initialState,
        trajectory: fork.trajectory
      });
      expect(replay.ok).toBe(true);
      expect(replay.mismatches).toEqual([]);
      expect(replay.replayedCommands).toBe(fork.trajectory.length);
      expect(replay.finalHash).toBe(hashStableState(fork.state));
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects a controlled generic-social Werewolf prefix with scoped exposure into replayable legacy artifacts", async () => {
    const initialState = createGame({ id: "werewolf-social-vertical-exposure", seed: "werewolf-social-vertical-exposure" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const wolfIds = initialState.players.filter((player) => player.team === "werewolves").map((player) => player.id);
    expect(wolfIds).toHaveLength(2);
    const speechByActor = new Map<string, string>();
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content =
          input.action.kind === "speech"
            ? `公开发言 ${input.agent.playerId}：我会结合夜间行动顺序、狼队可能协作痕迹和刚才公开信息继续施压。`
            : `vertical memo:${input.agent.playerId}:${input.action.kind}:${input.policyPlan.policyName}`;
        if (input.action.kind === "speech") speechByActor.set(input.agent.playerId, content);
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `vertical-exposure-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };

    const result = await runWerewolfSocialHarnessPrefix({
      id: "werewolf-social-vertical-exposure",
      initialState,
      agents: agentConfigsFor(initialState, "vertical-exposure-profile"),
      reasoner,
      maxTransitions: 7
    });
    const artifact = result.artifact;

    expect(artifact.status).toBe("truncated");
    expect(artifact.steps).toHaveLength(7);
    expect(artifact.steps[0]).toMatchObject({
      actorId: "system",
      resolutionPolicy: "system-transition",
      action: { command: { type: "system.advance", actorId: "system" } }
    });
    expect(artifact.steps.some((step) => step.action.command.type === "seer.inspect")).toBe(true);
    expect(artifact.steps.some((step) => step.action.command.type === "werewolf.killVote")).toBe(true);
    expect(artifact.steps.some((step) => step.action.command.type === "witch.act")).toBe(true);
    expect(artifact.steps.some((step) => step.action.command.type === "speech.submit")).toBe(true);
    const killSteps = artifact.steps.filter((step) => step.action.command.type === "werewolf.killVote");
    expect(killSteps).toHaveLength(2);
    expect(killSteps.map((step) => step.schedulerMode)).toEqual(["aec-batched-decision", "aec-batched-decision"]);
    expect(new Set(killSteps.map((step) => step.batchId)).size).toBe(1);
    expect(killSteps.map((step) => step.batchSize)).toEqual([2, 2]);
    expect(new Set(killSteps.map((step) => step.decisionStateHash))).toEqual(new Set([killSteps[0].decisionStateHash]));
    expect(killSteps[0].observation.kind).toBe("player");
    expect(killSteps[1].observation.kind).toBe("player");
    if (killSteps[0].observation.kind !== "player" || killSteps[1].observation.kind !== "player") {
      throw new Error("Expected player observations for kill steps.");
    }
    expect(killSteps[0].observation.view.phase).toBe("night_wolves");
    expect(killSteps[1].observation.view.phase).toBe("night_wolves");
    expect(killSteps[0].observation.view.social.messages).toEqual([]);
    expect(killSteps[1].observation.view.social.messages).toEqual([]);
    expect(result.socialSteps.filter((step) => step.action.command.type === "werewolf.killVote")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schedulerMode: "aec-batched-decision",
          resolutionPolicy: "sequential-apply-from-shared-decision-state",
          batchSize: 2
        })
      ])
    );
    const speechSteps = artifact.steps.filter((step) => step.action.command.type === "speech.submit");
    expect(speechSteps.length).toBeGreaterThan(0);
    expect(speechSteps.every((step) => step.schedulerMode === "aec")).toBe(true);
    expect(result.socialSteps.filter((step) => step.action.command.type === "speech.submit").every((step) => step.schedulerMode === "aec")).toBe(true);

    const projectedTraceIds = artifact.steps.filter((step) => step.actorId !== "system" && !step.error).map((step) => step.traceId);
    expect(result.trajectory.map((step) => step.traceId)).toEqual(projectedTraceIds);
    expect(result.socialSteps.map((step) => step.traceId)).toEqual(projectedTraceIds);
    expect(result.trajectory.every((step) => step.eventSeqRange && step.messageSeqRange)).toBe(true);
    expect(result.socialSteps.map((step) => step.eventSeqRange)).toEqual(result.trajectory.map((step) => step.eventSeqRange));
    expect(result.socialSteps.map((step) => step.messageSeqRange)).toEqual(result.trajectory.map((step) => step.messageSeqRange));

    const replay = replayHarnessTrajectory({
      initialState,
      trajectory: result.trajectory
    });
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.finalHash).toBe(hashStableState(artifact.finalState));

    const messagesBySeq = new Map(artifact.messages.map((message) => [message.seq, message]));
    for (const step of artifact.steps.filter((item) => item.actorId !== "system" && !item.error)) {
      const range = step.messageSeqRange;
      expect(range).toBeDefined();
      if (!range) continue;
      const stepMessages = Array.from({ length: range[1] - range[0] + 1 }, (_, index) => messagesBySeq.get(range[0] + index));
      expect(stepMessages.every(Boolean)).toBe(true);
      expect(stepMessages.every((message) => message?.metadata?.traceId === step.traceId)).toBe(true);
    }

    const seerInspectMessage = artifact.messages.find((message) => message.metadata?.kind === "private-seer-inspect");
    expect(seerInspectMessage).toMatchObject({
      visibility: "private",
      channelId: `private-${seer.id}`,
      recipientIds: [seer.id]
    });
    expect(
      artifact.steps.some(
        (step) =>
          step.actorId !== seer.id &&
          step.observation.kind === "player" &&
          step.observation.view.social.messages.some((message) => message.id === seerInspectMessage?.id)
      )
    ).toBe(false);

    const exposureRecords = deriveSocialExposureRecords(artifact);
    expect(exposureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          visibility: "team",
          kind: "werewolf-kill-vote"
        }),
        expect.objectContaining({
          visibility: "public",
          kind: "public-speech",
          observedAtActionKind: "speech.submit"
        })
      ])
    );
    expect(exposureRecords.some((record) => record.kind === "private-seer-inspect")).toBe(false);
    expect(exposureRecords.some((record) => record.kind === "private-reasoner-memo")).toBe(false);

    const firstPublicSpeech = artifact.messages.find((message) => message.metadata?.kind === "public-speech");
    expect(firstPublicSpeech?.content).toBe(speechByActor.get(firstPublicSpeech?.senderId ?? ""));
    const firstPublicSpeechExposures = exposureRecords.filter((record) => record.messageId === firstPublicSpeech?.id);
    expect(firstPublicSpeechExposures.length).toBeGreaterThan(0);
    expect(firstPublicSpeechExposures.length).toBeLessThan(firstPublicSpeech?.recipientIds.length ?? 0);
    expect(firstPublicSpeechExposures.every((record) => record.visibility === "public")).toBe(true);

    for (const record of exposureRecords.filter((item) => item.kind === "werewolf-kill-vote")) {
      expect(wolfIds).toContain(record.sourceId);
      expect(wolfIds).toContain(record.observerId);
    }
  });

  it("does not invent system transitions when Werewolf has agent pending actions", async () => {
    const initialState = createGame({ id: "werewolf-social-no-system", seed: "werewolf-social-no-system" });
    const environment = WerewolfSocialEnvironment.fromState(initialState);
    environment.step({ type: "system.advance", actorId: "system" });
    const stateWithAgentPending = environment.snapshot();

    expect(werewolfSystemTransition({ state: stateWithAgentPending, turnIndex: 1, schedulerMode: "aec" })).toBeUndefined();
  });
});

function agentConfigsFor(state: ReturnType<typeof createGame>, model: string): HarnessAgentConfig[] {
  return state.players.map((player) => ({
    playerId: player.id,
    profileId: `${player.id}-${model}`,
    model,
    temperature: 0,
    policyName: policyForRole(player.role)
  }));
}

class InvalidInspectSocialActor implements SocialActor<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand> {
  readonly profile: SocialAgentProfile;
  private traceId?: string;

  constructor(readonly id: string) {
    this.profile = { id: `${id}-invalid-step-profile`, model: "invalid-step-model" };
  }

  observe(_observation: WerewolfSocialObservation, context?: SocialActorObservationContext<WerewolfSocialPendingAction>): void {
    this.traceId = context?.traceId;
  }

  decide(pending: WerewolfSocialPendingAction) {
    if (pending.kind !== "inspect") throw new Error(`Expected inspect pending action, received ${pending.kind}.`);
    return {
      actorId: this.id,
      kind: "seer.inspect",
      traceId: this.traceId,
      command: {
        type: "seer.inspect" as const,
        actorId: this.id,
        targetId: this.id
      }
    };
  }
}

class InvalidMessageSocialActor implements SocialActor<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand> {
  readonly profile: SocialAgentProfile;
  private traceId?: string;

  constructor(
    readonly id: string,
    private readonly legalTargetId: string
  ) {
    this.profile = { id: `${id}-invalid-message-profile`, model: "invalid-message-model" };
  }

  observe(_observation: WerewolfSocialObservation, context?: SocialActorObservationContext<WerewolfSocialPendingAction>): void {
    this.traceId = context?.traceId;
  }

  decide(pending: WerewolfSocialPendingAction) {
    if (pending.kind !== "inspect") throw new Error(`Expected inspect pending action, received ${pending.kind}.`);
    return {
      actorId: this.id,
      kind: "seer.inspect",
      traceId: this.traceId,
      command: {
        type: "seer.inspect" as const,
        actorId: this.id,
        targetId: this.legalTargetId
      },
      messages: [
        {
          channelId: "missing-channel",
          senderId: this.id,
          recipientIds: [this.id],
          visibility: "private" as const,
          content: "draft should never commit",
          metadata: {
            kind: "invalid-private-message",
            traceId: this.traceId,
            actionKind: "inspect",
            commandType: "seer.inspect"
          }
        }
      ]
    };
  }
}

class InvalidKillSocialActor implements SocialActor<WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand> {
  readonly profile: SocialAgentProfile;
  private traceId?: string;

  constructor(
    readonly id: string,
    private readonly illegalTargetId: string
  ) {
    this.profile = { id: `${id}-invalid-kill-profile`, model: "invalid-kill-model" };
  }

  observe(_observation: WerewolfSocialObservation, context?: SocialActorObservationContext<WerewolfSocialPendingAction>): void {
    this.traceId = context?.traceId;
  }

  decide(pending: WerewolfSocialPendingAction) {
    if (pending.kind !== "kill") throw new Error(`Expected kill pending action, received ${pending.kind}.`);
    return {
      actorId: this.id,
      kind: "werewolf.killVote",
      traceId: this.traceId,
      command: {
        type: "werewolf.killVote" as const,
        actorId: this.id,
        targetId: this.illegalTargetId
      },
      messages: [
        {
          channelId: "werewolf-team",
          senderId: this.id,
          recipientIds: [this.illegalTargetId],
          visibility: "team" as const,
          content: "invalid kill draft should not commit",
          metadata: {
            kind: "werewolf-kill-vote",
            traceId: this.traceId,
            actionKind: "kill",
            commandType: "werewolf.killVote",
            targetId: this.illegalTargetId
          }
        }
      ]
    };
  }
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function visibleParentMessageIds(
  messages: Array<{ id: string; senderId: string; recipientIds: string[]; visibility: string }>,
  actorId: string
): string[] {
  return messages
    .filter((message) => {
      if (message.visibility === "postgame") return false;
      if (message.visibility === "public") return true;
      return message.senderId === actorId || message.recipientIds.includes(actorId);
    })
    .map((message) => message.id);
}
