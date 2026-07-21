import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyCommand, createGame, getPendingActions } from "../src/core/engine";
import { isAgentPendingAction } from "../src/core/pending";
import { ModelCallError } from "../src/agents/schema";
import { WerewolfAgentActor } from "../src/harness/actor";
import { buildFinalHarnessCheckpoint, buildMatchArtifact, toTrajectoryJsonl } from "../src/harness/artifacts";
import { WerewolfEnvironment } from "../src/harness/environment";
import { evaluateAdversarialMatch } from "../src/harness/evaluator";
import { hashStableState } from "../src/harness/hash";
import { harnessFailureEvidenceFromEpisode } from "../src/harness/executionEvidence";
import { werewolfHarnessTurnEvidenceFromEpisode } from "../src/harness/werewolfExecutionEvidence";
import { policyForRole } from "../src/harness/policy";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { replayHarnessTrajectory } from "../src/harness/replay";
import { probeHarnessTurn, runHarnessMatch } from "../src/harness/runtime";
import { isSocialStepCommitted } from "../src/harness/social";
import type { AgentHarnessState, HarnessReasoner, HarnessTurnTrace } from "../src/harness/types";
import type { GameCommand, GameState, PlayerState, Role } from "../src/core/types";

const execFileAsync = promisify(execFile);

async function runTsxJson<T>(source: string): Promise<T> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });
  const output = stdout.trim();
  if (!output) throw new Error("tsx script produced no JSON output.");
  return JSON.parse(output) as T;
}

function playerByRole(state: GameState, role: Role): PlayerState {
  const player = state.players.find((candidate) => candidate.role === role);
  if (!player) throw new Error(`Missing role ${role}.`);
  return player;
}

function playersByRole(state: GameState, role: Role): PlayerState[] {
  const players = state.players.filter((candidate) => candidate.role === role);
  if (!players.length) throw new Error(`Missing role ${role}.`);
  return players;
}

function livingExcept(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.alive && candidate.id !== playerId);
  if (!player) throw new Error(`Missing living player excluding ${playerId}.`);
  return player;
}

describe("harness agent-environment cycle", () => {
  it("uses one environment for pending, player view, actor plan, command, and evaluator trajectory", () => {
    const environment = new WerewolfEnvironment(createGame({ id: "harness-env-cycle", seed: "harness-env-cycle" }));

    expect(environment.pending()).toMatchObject([{ kind: "advance", actorId: "system" }]);
    environment.step({ type: "system.advance", actorId: "system" });
    expect(environment.snapshot().phase).toBe("night_seer");

    const action = environment.pendingActions().find((pending) => pending.kind === "inspect");
    if (!action) throw new Error("Expected a seer inspect action.");

    const view = environment.observe(action.actorId, action);
    const agent: AgentHarnessState = {
      playerId: action.actorId,
      model: "stub-model",
      temperature: 0,
      policyName: policyForRole(view.you.role),
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    };
    const actor = new WerewolfAgentActor(agent);
    actor.observe(view);

    const plan = actor.plan(action);
    expect(view.you.id).toBe(action.actorId);
    expect(view.pendingAction.kind).toBe("inspect");
    expect(plan.policyName).toBe("seer-information");
    expect(plan.command.type).toBe("seer.inspect");
    if (plan.command.type !== "seer.inspect") throw new Error("Expected a seer inspect command.");

    const memo = "测试备忘：inspect 使用 seer-information，命令由 actor plan 决定。";
    actor.commitTurn(plan, memo);
    const command = actor.act(plan);
    expect(command.type).toBe("seer.inspect");
    if (command.type !== "seer.inspect") throw new Error("Expected a seer inspect command.");
    expect(actor.state.observations).toBe(1);
    expect(actor.state.turns).toBe(1);
    expect(actor.state.privateMemos).toContain(memo);
    expect(actor.state.social?.agentId).toBe(action.actorId);
    expect(actor.state.socialStateHash).toEqual(expect.any(String));
    expect(actor.state.social?.memory.entries.map((entry) => entry.kind)).toEqual(["observation", "memo", "decision"]);
    expect(actor.state.social?.memory.entries.every((entry) => entry.evidenceRefs.length > 0)).toBe(true);
    expect(actor.state.social?.memory.entries[0].observation).toMatchObject({
      you: { id: action.actorId },
      pendingAction: { kind: "inspect" }
    });
    expect(actor.state.social?.memory.entries[1]).toMatchObject({ source: "reasoner", visibility: "private", content: memo });
    expect(actor.state.social?.memory.entries[2].action?.command).toEqual(command);

    const before = environment.snapshot();
    const after = environment.step(command);
    const evaluation = evaluateAdversarialMatch(after, [actor.state]);

    expect(after.phase).toBe("night_wolves");
    expect(after.night.seerInspection).toMatchObject({
      actorId: action.actorId,
      targetId: command.targetId
    });
    expect(after.events.length).toBeGreaterThan(before.events.length);
    expect(evaluation.trajectory).toEqual([]);
    expect(evaluation.agentRewards).toHaveLength(after.players.length);
  });

  it("applies true parallel wolf kill votes through stepBatch without intermediate pending leakage", () => {
    const environment = new WerewolfEnvironment(createGame({ id: "harness-step-batch-wolves", seed: "harness-step-batch-wolves" }));
    environment.step({ type: "system.advance", actorId: "system" });

    const seerAction = environment.pendingActions().find((pending) => pending.kind === "inspect");
    if (!seerAction) throw new Error("Expected seer inspect pending action.");
    const seerTarget = seerAction.legalTargetIds[0];
    if (!seerTarget) throw new Error("Expected seer legal target.");
    environment.step({ type: "seer.inspect", actorId: seerAction.actorId, targetId: seerTarget });

    expect(environment.snapshot().phase).toBe("night_wolves");
    const killPending = environment.pendingActions().filter((pending) => pending.kind === "kill");
    expect(killPending.length).toBeGreaterThanOrEqual(2);
    const preBatch = environment.snapshot();
    const commandsByAgent = Object.fromEntries(
      killPending.map((pending, index) => {
        const targetId = pending.legalTargetIds[index % pending.legalTargetIds.length];
        if (!targetId) throw new Error(`Missing legal kill target for ${pending.actorId}.`);
        return [
          pending.actorId,
          {
            type: "werewolf.killVote" as const,
            actorId: pending.actorId,
            targetId
          }
        ];
      })
    );

    // All commands must validate against the shared pre-batch decision state.
    for (const pending of killPending) {
      expect(preBatch.night.wolfVotes[pending.actorId]).toBeUndefined();
      expect(commandsByAgent[pending.actorId]).toBeDefined();
    }

    const afterBatch = environment.stepBatch(commandsByAgent);
    expect(afterBatch.phase).toBe("night_witch");
    for (const pending of killPending) {
      expect(afterBatch.night.wolfVotes[pending.actorId]).toBe(commandsByAgent[pending.actorId]?.targetId);
    }
    // No intermediate open-wolf pending remains after joint apply.
    expect(environment.pendingActions().some((pending) => pending.kind === "kill")).toBe(false);
  });

  it("rejects incomplete or mixed-phase stepBatch maps", () => {
    const environment = new WerewolfEnvironment(createGame({ id: "harness-step-batch-reject", seed: "harness-step-batch-reject" }));
    environment.step({ type: "system.advance", actorId: "system" });
    const seerAction = environment.pendingActions().find((pending) => pending.kind === "inspect");
    if (!seerAction) throw new Error("Expected seer inspect pending action.");
    environment.step({
      type: "seer.inspect",
      actorId: seerAction.actorId,
      targetId: seerAction.legalTargetIds[0] ?? livingExcept(environment.snapshot(), seerAction.actorId).id
    });

    const killPending = environment.pendingActions().filter((pending) => pending.kind === "kill");
    expect(killPending.length).toBeGreaterThanOrEqual(2);
    const [first, second] = killPending;
    const targetId = first.legalTargetIds[0];
    if (!targetId) throw new Error("Expected kill target.");

    expect(() =>
      environment.stepBatch({
        [first.actorId]: { type: "werewolf.killVote", actorId: first.actorId, targetId }
      })
    ).toThrow(/complete pending agent set|missing=/);

    expect(() =>
      environment.stepBatch({
        [first.actorId]: { type: "werewolf.killVote", actorId: first.actorId, targetId },
        [second.actorId]: { type: "werewolf.killVote", actorId: second.actorId, targetId },
        extra: { type: "werewolf.killVote", actorId: "extra", targetId }
      } as Record<string, GameCommand>)
    ).toThrow(/unexpected=/);

    expect(() =>
      environment.stepBatch({
        [first.actorId]: { type: "system.advance", actorId: first.actorId },
        [second.actorId]: { type: "werewolf.killVote", actorId: second.actorId, targetId }
      } as Record<string, GameCommand>)
    ).toThrow(/system\.advance|not accept|not legal/);
  });

  it("applies day_vote joint actions through stepBatch and advances to exile resolve path", () => {
    const environment = new WerewolfEnvironment(createGame({ id: "harness-step-batch-votes", seed: "harness-step-batch-votes" }));
    // Drive the engine to day_vote with a deterministic legal prefix.
    for (let guard = 0; guard < 64; guard += 1) {
      const phase = environment.snapshot().phase;
      if (phase === "day_vote" || phase === "game_over") break;

      const system = environment.pending().find((action) => action.kind === "advance");
      if (system) {
        environment.step({ type: "system.advance", actorId: "system" });
        continue;
      }

      const agentPending = environment.pendingActions();
      if (agentPending.length === 0) break;

      if (agentPending.every((action) => action.kind === "kill")) {
        const commands = Object.fromEntries(
          agentPending.map((action) => {
            if (action.kind !== "kill") throw new Error("Expected kill pending.");
            const targetId = action.legalTargetIds[0];
            if (!targetId) throw new Error("kill target missing");
            return [action.actorId, { type: "werewolf.killVote" as const, actorId: action.actorId, targetId }];
          })
        );
        environment.stepBatch(commands);
        continue;
      }

      const action = agentPending[0];
      if (action.kind === "inspect") {
        environment.step({ type: "seer.inspect", actorId: action.actorId, targetId: action.legalTargetIds[0]! });
        continue;
      }
      if (action.kind === "witch") {
        environment.step({ type: "witch.act", actorId: action.actorId });
        continue;
      }
      if (action.kind === "speech") {
        environment.step({ type: "speech.submit", actorId: action.actorId, text: "joint-vote setup speech" });
        continue;
      }
      if (action.kind === "last_words") {
        environment.step({ type: "lastWords.submit", actorId: action.actorId, text: "joint-vote setup last words" });
        continue;
      }
      if (action.kind === "sheriff_vote") {
        environment.step({ type: "sheriff.vote", actorId: action.actorId, targetId: action.legalTargetIds[0] });
        continue;
      }
      if (action.kind === "kill") {
        environment.step({ type: "werewolf.killVote", actorId: action.actorId, targetId: action.legalTargetIds[0]! });
        continue;
      }
      break;
    }

    expect(environment.snapshot().phase).toBe("day_vote");
    const votePending = environment.pendingActions().filter((pending) => pending.kind === "vote");
    expect(votePending.length).toBeGreaterThanOrEqual(2);
    const commandsByAgent = Object.fromEntries(
      votePending.map((pending, index) => {
        if (pending.kind !== "vote") throw new Error("Expected vote pending.");
        const targetId = pending.legalTargetIds[index % pending.legalTargetIds.length];
        return [
          pending.actorId,
          targetId
            ? { type: "vote.cast" as const, actorId: pending.actorId, targetId }
            : { type: "vote.cast" as const, actorId: pending.actorId, abstain: true }
        ];
      })
    );
    const after = environment.stepBatch(commandsByAgent);
    expect(["exile_resolve", "hunter_shot", "night_seer", "night_wolves", "game_over"]).toContain(after.phase);
    expect(environment.pendingActions().some((pending) => pending.kind === "vote")).toBe(false);
  });

  it("records harness turn trace with policyName, beliefs, and commandType", async () => {
    const result = await runTsxJson<{
      turnEventCount: number;
      trace: HarnessTurnTrace;
      playerCount: number;
      metrics: {
        harnessTurnCount: number;
        modelUsage: Record<string, { calls: number }>;
      };
      actedAgent?: { observations: number; turns: number; privateMemoCount: number };
      evaluation: {
        trajectoryLength: number;
        agentRewardCount: number;
        teamRewards: Record<string, number>;
      };
    }>(`
      import { createGame } from "./src/core/engine.ts";
      import { runHarnessMatch } from "./src/harness/runtime.ts";

      const stubReasoner = {
        async think(input) {
          const content =
            input.action.kind === "speech"
              ? "我先按公开信息发言，重点看夜晚死亡和前后票型，不急着跳身份，今天优先统一视角减少分票。"
              : "测试备忘：" + input.action.kind + " 使用 " + input.policyPlan.policyName + "，命令由 harness plan 决定。";
          return {
            content,
            completion: {
              content,
              latencyMs: 5,
              usage: {
                promptTokens: 7,
                completionTokens: 11,
                totalTokens: 18
              },
              providerRequestId: "stub-" + input.traceId,
              attempts: 1
            }
          };
        }
      };

      const initialState = createGame({ id: "harness-trace", seed: "harness-trace" });
      const result = await runHarnessMatch({
        initialState,
        agents: initialState.players.map((player) => ({
          playerId: player.id,
          model: "stub-model",
          temperature: 0
        })),
        reasoner: stubReasoner,
        maxTransitions: 2
      });
      const turnEvents = result.trajectory;
      const trace = turnEvents[0]?.turnTrace;
      const actedAgent = result.agents.find((agent) => agent.playerId === trace?.playerId);
      console.log(JSON.stringify({
        turnEventCount: turnEvents.length,
        trace,
        playerCount: result.state.players.length,
        metrics: result.metrics,
        actedAgent: actedAgent && {
          observations: actedAgent.observations,
          turns: actedAgent.turns,
          privateMemoCount: actedAgent.privateMemos.length
        },
        evaluation: {
          trajectoryLength: result.evaluation.trajectory.length,
          agentRewardCount: result.evaluation.agentRewards.length,
          teamRewards: result.evaluation.teamRewards
        }
      }));
    `);

    expect(result.turnEventCount).toBe(1);
    expect(result.trace.policyName).toBe("seer-information");
    expect(result.trace.commandType).toBe("seer.inspect");
    expect(result.trace.privateMemo).toContain("测试备忘");
    expect(Object.keys(result.trace.beliefs)).toHaveLength(result.playerCount);
    expect(result.trace.beliefs[result.trace.playerId]?.wolfProb).toBe(0);
    expect(result.metrics.harnessTurnCount).toBe(1);
    expect(result.metrics.modelUsage["stub-model"].calls).toBe(1);
    expect(result.actedAgent).toMatchObject({ observations: 1, turns: 1, privateMemoCount: 1 });
    expect(result.evaluation.trajectoryLength).toBe(1);
    expect(result.evaluation.agentRewardCount).toBe(result.playerCount);
    expect(result.evaluation.teamRewards).toHaveProperty("village");
    expect(result.evaluation.teamRewards).toHaveProperty("werewolves");
  });

  it("plans a probe turn through the adapter without applying or persisting it", async () => {
    const initialState = createGame({ id: "adapter-backed-probe", seed: "adapter-backed-probe" });
    const state = applyCommand(initialState, { type: "system.advance", actorId: "system" });
    const action = getPendingActions(state).find(isAgentPendingAction);
    if (!action) throw new Error("Expected a pending agent action for the probe.");
    const beforeHash = hashStableState(state);
    const reasonerCalls: Array<{ traceId: string; hasSocial: boolean; actionKind: string; policyName: string }> = [];
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls.push({
          traceId: input.traceId,
          hasSocial: Array.isArray(input.view.social.channels) && Array.isArray(input.view.social.messages),
          actionKind: input.action.kind,
          policyName: input.policyPlan.policyName
        });
        const content =
          input.action.kind === "speech"
            ? "我会按公开信息发言，先说明自己看到的行动线索，再推动大家围绕冲突点集中讨论。"
            : `probe memo:${input.traceId}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 3,
            usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
            providerRequestId: `probe-${input.traceId}`,
            attempts: 1,
            stream: {
              enabled: true,
              completed: true,
              completedBy: "done_sentinel"
            }
          }
        };
      }
    };

    const probe = await probeHarnessTurn({
      state,
      action,
      agent: {
        playerId: action.actorId,
        model: "probe-model",
        temperature: 0
      },
      reasoner
    });

    expect(reasonerCalls).toEqual([
      {
        traceId: `${state.id}:harness:1:${action.actorId}:${state.phase}`,
        hasSocial: true,
        actionKind: action.kind,
        policyName: "seer-information"
      }
    ]);
    expect(probe.trace).toMatchObject({
      traceId: `${state.id}:harness:1:${action.actorId}:${state.phase}`,
      playerId: action.actorId,
      model: "probe-model",
      actionKind: action.kind,
      policyName: "seer-information",
      commandType: "seer.inspect",
      promptTokens: 5,
      completionTokens: 7,
      providerRequestId: `probe-${state.id}:harness:1:${action.actorId}:${state.phase}`,
      stream: {
        enabled: true,
        completed: true,
        completedBy: "done_sentinel"
      }
    });
    expect(probe.command).toMatchObject({
      type: "seer.inspect",
      actorId: action.actorId
    });
    expect(hashStableState(state)).toBe(beforeHash);
    expect(state.phase).toBe("night_seer");
    expect(state.night.seerInspection).toBeUndefined();
    expect(state.events.some((event) => event.type === "seer.inspected")).toBe(false);
  });

  it("keeps reasoner scoped, preserves actor state, and emits replayable social trajectory", async () => {
    const result = await runTsxJson<{
      status: string;
      traceIds: string[];
      uniqueTraceIds: number;
      reasonerSawState: boolean;
      reasonerSawSocial: boolean;
      pollutedAgent?: { turns: number; observations: number; hasInjectedBelief: boolean };
      trajectory: Array<{
        traceId: string;
        commandType: string;
        command: unknown;
          hasObservation: boolean;
          hasHashes: boolean;
          agentStateHash?: string;
          eventSeqRange: [number, number];
      }>;
      socialState: {
        agentCount: number;
        actedMemoryKinds: string[];
        actedHasInjectedSocialBelief: boolean;
        actedSocialStateHash?: string;
      };
      social: {
        status: string;
        profileCount: number;
        channelKinds: string[];
        stepCount: number;
      };
    }>(`
      import { createGame } from "./src/core/engine.ts";
      import { runHarnessMatch } from "./src/harness/runtime.ts";

      let reasonerSawState = false;
      let reasonerSawSocial = false;
      const scopedReasoner = {
        async think(input) {
          reasonerSawState ||= Object.prototype.hasOwnProperty.call(input, "state");
          reasonerSawSocial ||= Object.prototype.hasOwnProperty.call(input.agent, "social");
          input.agent.turns = 999;
          input.agent.beliefs = { injected: { wolfProb: 1, rationaleTags: ["mutation-attempt"] } };
          const content =
            input.action.kind === "speech"
              ? "我按公开信息发言，重点看夜晚死亡、发言压力和票型关系，今天先统一视角，不急着扩大身份对跳。"
              : "隔离验证备忘：" + input.agent.model + "/" + input.action.kind + "/" + input.policyPlan.policyName;
          return {
            content,
            completion: {
              content,
              latencyMs: 2,
              usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
              providerRequestId: "scoped-" + input.traceId,
              attempts: 1
            }
          };
        }
      };

      const initialState = createGame({ id: "scoped-social", seed: "scoped-social" });
      const result = await runHarnessMatch({
        initialState,
        agents: initialState.players.map((player, index) => ({
          playerId: player.id,
          profileId: "profile-" + (index + 1),
          model: index % 2 ? "beta" : "alpha",
          temperature: index % 2 ? 0.35 : 0.8
        })),
        reasoner: scopedReasoner,
        maxTransitions: 4
      });
      const traceIds = result.trajectory.map((step) => step.traceId);
      const actedAgent = result.agents.find((agent) => agent.turns > 0);
      console.log(JSON.stringify({
        status: result.status,
        traceIds,
        uniqueTraceIds: new Set(traceIds).size,
        reasonerSawState,
        reasonerSawSocial,
        pollutedAgent: actedAgent && {
          turns: actedAgent.turns,
          observations: actedAgent.observations,
          hasInjectedBelief: Boolean(actedAgent.beliefs.injected)
        },
        trajectory: result.trajectory.map((step) => ({
          traceId: step.traceId,
          commandType: step.command.type,
          command: step.command,
          hasObservation: Boolean(step.observation?.pendingAction),
          hasHashes: Boolean(step.preStateHash && step.postStateHash),
          agentStateHash: step.agentStateHash,
          eventSeqRange: step.eventSeqRange
        })),
        socialState: {
          agentCount: result.agents.filter((agent) => Boolean(agent.social)).length,
          actedMemoryKinds: actedAgent?.social?.memory.entries.map((entry) => entry.kind) ?? [],
          actedHasInjectedSocialBelief: Boolean(actedAgent?.social?.beliefs.claims.injected),
          actedSocialStateHash: actedAgent?.socialStateHash
        },
        social: {
          status: result.socialEpisode.status,
          profileCount: result.socialEpisode.profiles.length,
          channelKinds: result.socialEpisode.channels.map((channel) => channel.kind),
          stepCount: result.socialEpisode.steps.length
        }
      }));
    `);

    expect(result.status).toBe("truncated");
    expect(result.reasonerSawState).toBe(false);
    expect(result.reasonerSawSocial).toBe(false);
    expect(result.traceIds.length).toBeGreaterThanOrEqual(3);
    expect(result.uniqueTraceIds).toBe(result.traceIds.length);
    expect(result.pollutedAgent).toMatchObject({ turns: 1, observations: 1, hasInjectedBelief: false });
    expect(result.socialState).toMatchObject({
      agentCount: 9,
      actedMemoryKinds: ["observation", "memo", "decision"],
      actedHasInjectedSocialBelief: false,
      actedSocialStateHash: expect.any(String)
    });
    expect(result.trajectory).toHaveLength(result.traceIds.length);
    expect(result.trajectory.every((step) => step.hasObservation && step.hasHashes)).toBe(true);
    expect(result.trajectory.every((step) => typeof step.agentStateHash === "string")).toBe(true);
    expect(result.trajectory.some((step) => step.commandType === "werewolf.killVote")).toBe(true);
    expect(result.social).toMatchObject({
      status: "truncated",
      profileCount: 9,
      stepCount: result.trajectory.length + 1
    });
    expect(result.social.channelKinds).toEqual(expect.arrayContaining(["public", "team", "private"]));
  });

  it("keeps runHarnessMatch from partially applying a wolf batch at the maxTransitions boundary", async () => {
    const initialState = createGame({ id: "production-wrapper-wolf-batch-boundary", seed: "production-wrapper-wolf-batch-boundary" });
    const wolves = initialState.players.filter((player) => player.team === "werewolves");
    expect(wolves).toHaveLength(2);
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content =
          input.action.kind === "speech"
            ? `公开发言 ${input.agent.playerId}：我按票型、夜晚信息和发言压力推进。`
            : `batch-boundary:${input.traceId}:${input.action.kind}:${input.policyPlan.policyName}`;
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

    const result = await runHarnessMatch({
      initialState,
      agents: initialState.players.map((player) => ({
        playerId: player.id,
        profileId: `profile-${player.id}`,
        model: "stub-model",
        temperature: 0
      })),
      reasoner,
      maxTransitions: 3
    });
    const replay = replayHarnessTrajectory({
      initialState: result.initialState,
      trajectory: result.trajectory
    });
    const killSteps = result.trajectory.filter((step) => step.command.type === "werewolf.killVote");
    const wolfSocialSteps = result.socialEpisode.steps.filter((step) => step.action.command.type === "werewolf.killVote");
    const turnEvents = werewolfHarnessTurnEvidenceFromEpisode(result.socialEpisode);

    expect(result.status).toBe("truncated");
    expect(result.truncationReason).toContain("maxTransitions 3");
    expect(result.state.phase).toBe("night_witch");
    expect(result.trajectory.map((step) => step.command.type)).toEqual(["seer.inspect", "werewolf.killVote", "werewolf.killVote"]);
    expect(killSteps.map((step) => step.actorId).sort()).toEqual(wolves.map((wolf) => wolf.id).sort());
    expect(killSteps.map((step) => step.turnIndex)).toEqual([2, 3]);
    expect(new Set(killSteps.map((step) => step.decisionStateHash)).size).toBe(1);
    expect(result.socialEpisode.steps.filter((step) => isSocialStepCommitted(step) && step.actorId !== "system").map((step) => step.traceId)).toEqual(
      result.trajectory.map((step) => step.traceId)
    );
    expect(wolfSocialSteps).toHaveLength(2);
    expect(new Set(wolfSocialSteps.map((step) => step.batchId)).size).toBe(1);
    expect(wolfSocialSteps.map((step) => step.schedulerMode)).toEqual(["aec-batched-decision", "aec-batched-decision"]);
    expect(wolfSocialSteps.map((step) => step.batchIndex)).toEqual([3, 3]);
    expect(wolfSocialSteps.map((step) => step.batchSize)).toEqual([2, 2]);
    expect(result.metrics).toMatchObject({ harnessTurnCount: 3, harnessErrorCount: 0 });
    expect(turnEvents).toHaveLength(3);
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.finalHash).toBe(hashStableState(result.state));
  });

  it("emits per-turn social messages with public, team, and private visibility", async () => {
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content =
          input.action.kind === "speech"
            ? "我按公开信息发言，今天重点比较夜晚死亡、发言压力和票型关系，先给出明确怀疑目标并听后置位补充。"
            : `social-message-test:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 3,
            usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
            providerRequestId: `social-message-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const initialState = createGame({ id: "social-message-artifact", seed: "social-message-artifact" });

    const result = await runHarnessMatch({
      initialState,
      agents: initialState.players.map((player) => ({
        playerId: player.id,
        profileId: `profile-${player.id}`,
        model: "stub-model",
        temperature: 0
      })),
      reasoner,
      maxTransitions: 20
    });

    const messages = result.socialEpisode.messages;
    const messagesBySeq = new Map(messages.map((message) => [message.seq, message]));
    const speechStep = result.socialEpisode.steps.find((step) => step.action.command.type === "speech.submit");
    const wolfStep = result.socialEpisode.steps.find((step) => step.action.command.type === "werewolf.killVote");
    const wolfIds = initialState.players.filter((player) => player.team === "werewolves").map((player) => player.id);
    const playerById = new Map(initialState.players.map((player) => [player.id, player]));
    const witchStep = result.trajectory.find((step) => step.command.type === "witch.act");
    const laterSpeechWithPublicContext = result.trajectory
      .filter((step) => step.command.type === "speech.submit")
      .slice(1)
      .find((step) => step.observation.social.messages.some((message) => message.metadata?.kind === "public-speech"));
    const wolfSpeechWithTeamContext = result.trajectory.find(
      (step) =>
        step.command.type === "speech.submit" &&
        wolfIds.includes(step.actorId) &&
        step.observation.social.messages.some((message) => message.metadata?.kind === "werewolf-kill-vote")
    );
    const privateMemo = messages.find((message) => message.metadata?.kind === "private-reasoner-memo");
    const publicSpeech = messages.find((message) => message.metadata?.kind === "public-speech");
    const wolfTeamMessage = messages.find((message) => message.metadata?.kind === "werewolf-kill-vote");

    expect(result.trajectory.length).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(result.trajectory.length);
    expect(privateMemo).toMatchObject({
      visibility: "private",
      channelId: expect.stringMatching(/^private-p/)
    });
    expect(publicSpeech).toMatchObject({
      visibility: "public",
      channelId: "table"
    });
    expect(wolfTeamMessage).toMatchObject({
      visibility: "team",
      channelId: "werewolf-team"
    });
    expect(wolfTeamMessage?.recipientIds.every((id) => initialState.players.find((player) => player.id === id)?.team === "werewolves")).toBe(true);
    expect(speechStep?.messageSeqRange).toBeDefined();
    expect(wolfStep?.messageSeqRange).toBeDefined();
    expect(witchStep?.observation.social.messages.some((message) => message.metadata?.kind === "werewolf-kill-vote")).toBe(false);
    expect(laterSpeechWithPublicContext).toBeDefined();
    expect(wolfSpeechWithTeamContext).toBeDefined();
    expect(result.socialEpisode.steps.filter((step) => isSocialStepCommitted(step) && step.actorId !== "system").map((step) => step.traceId)).toEqual(
      result.trajectory.map((step) => step.traceId)
    );
    for (const trajectoryStep of result.trajectory) {
      const socialStep = result.socialEpisode.steps.find((step) => step.traceId === trajectoryStep.traceId);
      expect(socialStep).toMatchObject({
        traceId: trajectoryStep.traceId,
        actorId: trajectoryStep.actorId,
        profileId: trajectoryStep.profileId ?? trajectoryStep.actorId,
        pendingAction: trajectoryStep.pendingAction,
        action: {
          actorId: trajectoryStep.actorId,
          kind: trajectoryStep.command.type,
          command: trajectoryStep.command
        },
        decisionStateHash: trajectoryStep.decisionStateHash,
        preStateHash: trajectoryStep.preStateHash,
        postStateHash: trajectoryStep.postStateHash,
        eventSeqRange: trajectoryStep.eventSeqRange,
        messageSeqRange: trajectoryStep.messageSeqRange
      });
    }
    expect(wolfStep).toMatchObject({
      schedulerMode: "aec-batched-decision",
      atomic: false,
      resolutionPolicy: "sequential-apply-from-shared-decision-state",
      batchId: expect.stringContaining(":batch:"),
      batchSize: 2
    });
    const wolfBatchSteps = result.socialEpisode.steps.filter((step) => step.action.command.type === "werewolf.killVote");
    expect(new Set(wolfBatchSteps.map((step) => step.batchId)).size).toBe(1);
    expect(wolfBatchSteps.map((step) => step.batchIndex)).toEqual([3, 3]);

    for (const step of result.socialEpisode.steps.filter((item) => item.messageSeqRange)) {
      const [start, end] = step.messageSeqRange!;
      const stepMessages = Array.from({ length: end - start + 1 }, (_, index) => messagesBySeq.get(start + index));
      expect(stepMessages.every(Boolean)).toBe(true);
      expect(stepMessages.every((message) => message?.metadata?.traceId === step.traceId)).toBe(true);
    }

    for (const step of result.trajectory) {
      for (const message of step.observation.social.messages) {
        expect(message.metadata?.role).toBeUndefined();
        expect(message.metadata?.team).toBeUndefined();
        expect(message.metadata?.policyName).toBeUndefined();
        if (message.visibility === "team") {
          expect(playerById.get(step.actorId)?.team).toBe("werewolves");
        }
        if (message.visibility === "private") {
          expect(message.senderId === step.actorId || message.recipientIds.includes(step.actorId)).toBe(true);
        }
      }
    }
  });

  it("returns a failed partial artifact when a later reasoner call fails", async () => {
    let calls = 0;
    const failingReasoner: HarnessReasoner = {
      async think(input) {
        calls += 1;
        if (calls === 2) {
          throw new Error(`planned reasoner failure at ${input.action.kind}`);
        }
        const content =
          input.action.kind === "speech"
            ? "我按公开信息发言，先比较夜晚死亡、发言压力和票型关系，今天优先统一视角减少分票。"
            : `failed-artifact-prefix:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 4,
            usage: { promptTokens: 6, completionTokens: 8, totalTokens: 14 },
            providerRequestId: `failed-prefix-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const initialState = createGame({ id: "failed-partial-artifact", seed: "failed-partial-artifact" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);

    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: failingReasoner,
      maxTransitions: 8
    });
    const artifact = buildMatchArtifact({
      runId: "failed-partial-artifact",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const replay = replayHarnessTrajectory({
      initialState: artifact.initialState,
      trajectory: artifact.trajectory
    });
    const fullFinalReplay = replayHarnessTrajectory({
      initialState: artifact.initialState,
      trajectory: artifact.trajectory,
      expectedFinalHash: artifact.failureStateHash
    });
    const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
    const firstError = harnessErrors[0]?.payload as { message?: string; actionKind?: string; traceId?: string };

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("planned reasoner failure");
    expect(result.failureStateHash).toBe(hashStableState(result.state));
    expect(result.trajectory).toHaveLength(1);
    expect(result.metrics).toMatchObject({ harnessTurnCount: 1, harnessErrorCount: 1 });
    expect(result.socialEpisode).toMatchObject({
      status: "failed",
      failureReason: result.failureReason,
      error: result.failureReason
    });
    expect(result.socialEpisode.steps.filter((step) => isSocialStepCommitted(step) && step.actorId !== "system").map((step) => step.traceId)).toEqual(
      result.trajectory.map((step) => step.traceId)
    );
    expect(result.socialEpisode.steps.at(-1)).toMatchObject({ commitStatus: "rejected", failure: expect.any(Object) });
    expect(harnessErrors).toHaveLength(1);
    expect(firstError.message).toContain("planned reasoner failure");
    expect(firstError.actionKind).toBe("kill");
    expect(firstError.traceId).toContain(":harness:");
    expect(artifact).toMatchObject({
      status: "failed",
      failureReason: result.failureReason,
      failureStateHash: result.failureStateHash
    });
    expect(harnessFailureEvidenceFromEpisode(artifact.socialEpisode)).toHaveLength(1);
    expect(artifact.socialEpisode.messages.length).toBeGreaterThan(0);
    expect(artifact.agents).toHaveLength(result.agents.length);
    expect(artifact.agents.some((agent) => agent.social?.memory.entries.length)).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.replayedCommands).toBe(artifact.trajectory.length);
    expect(replay.finalHash).toBe(artifact.trajectory.at(-1)?.postStateHash);
    expect(replay.finalHash).toBe(artifact.failureStateHash);
    expect(fullFinalReplay.ok).toBe(true);
    expect(fullFinalReplay.finalHash).toBe(replay.finalHash);
    expect(fullFinalReplay.expectedFinalHash).toBe(artifact.failureStateHash);
    expect(fullFinalReplay.mismatches).toEqual([]);
    expect(() => buildFinalHarnessCheckpoint({ artifact })).not.toThrow();
  });

  it("records environment-step failures for illegal commands without adding failed trajectory steps", async () => {
    const initialState = createGame({ id: "illegal-command-failure", seed: "illegal-command-failure" });
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

    const reasoner: HarnessReasoner = {
      async think(input) {
        expect(input.action.kind).toBe("inspect");
        const content = "illegal-command-test memo: seer has no legal inspect targets, so environment validation must reject the command.";
        return {
          content,
          completion: {
            content,
            latencyMs: 3,
            usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
            providerRequestId: `illegal-command-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const setupPending = new WerewolfEnvironment(initialState).pendingActions();

    expect(setupPending).toHaveLength(1);
    expect(setupPending[0]).toMatchObject({
      kind: "inspect",
      actorId: seer.id,
      legalTargetIds: []
    });

    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
      maxTransitions: 2
    });
    const artifact = buildMatchArtifact({
      runId: "illegal-command-failure",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const harnessTurns = werewolfHarnessTurnEvidenceFromEpisode(result.socialEpisode);
    const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
    const turnEvent = harnessTurns[0];
    const errorEvent = harnessErrors[0];
    const turnPayload = turnEvent?.trace as HarnessTurnTrace;
    const payload = errorEvent?.payload as Record<string, unknown>;
    const artifactTurns = werewolfHarnessTurnEvidenceFromEpisode(artifact.socialEpisode);
    const artifactErrors = harnessFailureEvidenceFromEpisode(artifact.socialEpisode);
    const artifactPayload = artifactErrors[0]?.payload as Record<string, unknown>;
    const replay = replayHarnessTrajectory({
      initialState: artifact.initialState,
      trajectory: artifact.trajectory
    });
    const fullFinalReplay = replayHarnessTrajectory({
      initialState: artifact.initialState,
      trajectory: artifact.trajectory,
      expectedFinalHash: artifact.failureStateHash
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("Command seer.inspect target undefined is not legal");
    expect(result.failureReason).toContain("not legal for this pending action");
    expect(result.failureReason).not.toContain("Harness turn failed");
    expect(result.failureStateHash).toBe(hashStableState(result.state));
    expect(result.state.phase).toBe("night_seer");
    expect(result.state.night.seerInspection).toBeUndefined();
    expect(result.state.events.some((event) => event.type === "seer.inspected")).toBe(false);
    expect(result.state.events.some((event) => event.type === "phase.changed" && (event.payload as { phase?: string }).phase === "night_wolves")).toBe(false);
    expect(result.trajectory).toHaveLength(0);
    expect(result.socialEpisode).toMatchObject({
      status: "failed",
      failureReason: result.failureReason,
      error: result.failureReason
    });
    expect(result.socialEpisode.steps).toHaveLength(1);
    expect(result.socialEpisode.steps[0]).toMatchObject({ commitStatus: "rejected", failure: { stage: "environment_step" } });
    expect(result.socialEpisode.messages).toHaveLength(0);
    expect(result.socialEpisode.metrics).toMatchObject({ harnessTurnCount: 0, harnessErrorCount: 1 });
    expect(result.metrics).toMatchObject({ harnessTurnCount: 0, harnessErrorCount: 1 });
    expect(harnessTurns).toHaveLength(1);
    expect(harnessErrors).toHaveLength(1);
    expect(turnEvent.turnIndex).toBeLessThanOrEqual(errorEvent.turnIndex);
    expect(turnPayload).toMatchObject({
      playerId: seer.id,
      actionKind: "inspect",
      policyName: "seer-information",
      commandType: "seer.inspect"
    });
    expect(errorEvent.actorId).toBe(seer.id);
    expect(payload).toMatchObject({
      model: turnPayload.model,
      actionKind: "inspect",
      message: result.failureReason,
      traceId: turnPayload.traceId,
      providerRequestId: turnPayload.providerRequestId,
      attempts: turnPayload.attempts
    });
    expect(payload.providerFailure).toBeUndefined();
    expect(result.metrics.modelUsage[turnPayload.model].calls).toBe(1);
    expect(artifact).toMatchObject({
      status: "failed",
      failureReason: result.failureReason,
      failureStateHash: result.failureStateHash
    });
    expect(artifact.trajectory).toHaveLength(0);
    expect(artifact.socialEpisode.steps).toHaveLength(1);
    expect(artifact.socialEpisode.messages).toHaveLength(0);
    expect(artifactTurns).toHaveLength(1);
    expect(artifactErrors).toHaveLength(1);
    expect(artifactPayload).toEqual(payload);
    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedCommands).toBe(0);
    expect(replay.finalHash).toBe(hashStableState(artifact.initialState));
    expect(replay.finalHash).toBe(artifact.failureStateHash);
    expect(fullFinalReplay.ok).toBe(true);
    expect(fullFinalReplay.finalHash).toBe(replay.finalHash);
    expect(fullFinalReplay.expectedFinalHash).toBe(artifact.failureStateHash);
    expect(fullFinalReplay.mismatches).toEqual([]);
    expect(() => buildFinalHarnessCheckpoint({ artifact })).not.toThrow();
  });

  it("rejects illegal Werewolf command families at the environment authority boundary", () => {
    const nightWolves = createGame({ id: "illegal-matrix-wolf", seed: "illegal-matrix-wolf" });
    nightWolves.phase = "night_wolves";
    nightWolves.day = 1;
    nightWolves.night = { wolfVotes: {} };
    const wolves = playersByRole(nightWolves, "werewolf");

    const nightWitch = createGame({ id: "illegal-matrix-witch", seed: "illegal-matrix-witch" });
    nightWitch.phase = "night_witch";
    nightWitch.day = 1;
    const witch = playerByRole(nightWitch, "witch");
    const wolf = playerByRole(nightWitch, "werewolf");
    const nightVictim = livingExcept(nightWitch, wolf.id);
    const illegalSaveTarget = nightWitch.players.find((player) => player.alive && player.id !== witch.id && player.id !== nightVictim.id);
    if (!illegalSaveTarget) throw new Error("Expected an illegal witch save target.");
    nightWitch.night = { wolfVotes: { [wolf.id]: nightVictim.id } };

    const daySpeech = createGame({ id: "illegal-matrix-speech", seed: "illegal-matrix-speech" });
    daySpeech.phase = "day_speech";
    daySpeech.day = 1;
    const speaker = daySpeech.players.find((player) => player.alive);
    if (!speaker) throw new Error("Expected a day speaker.");
    daySpeech.currentSpeakerSeat = speaker.seat;

    const dayVote = createGame({ id: "illegal-matrix-vote", seed: "illegal-matrix-vote" });
    dayVote.phase = "day_vote";
    dayVote.day = 1;
    const voter = dayVote.players.find((player) => player.alive);
    if (!voter) throw new Error("Expected a voter.");

    const hunterShot = createGame({ id: "illegal-matrix-hunter", seed: "illegal-matrix-hunter" });
    hunterShot.phase = "hunter_shot";
    hunterShot.day = 1;
    const hunter = playerByRole(hunterShot, "hunter");
    hunter.alive = false;
    hunter.eliminatedAt = { day: 1, phase: "night_resolve", reason: "night_kill" };
    hunterShot.pendingHunterId = hunter.id;
    hunterShot.hunterResume = "day_speech";

    const cases: Array<{
      name: string;
      state: GameState;
      command: GameCommand;
      pendingKind: string;
      actorId: string;
      assertPending: (pending: ReturnType<WerewolfEnvironment["pendingActions"]>) => void;
      error: RegExp;
    }> = [
      {
        name: "wolf cannot target another wolf",
        state: nightWolves,
        command: { type: "werewolf.killVote", actorId: wolves[0].id, targetId: wolves[1].id },
        pendingKind: "kill",
        actorId: wolves[0].id,
        assertPending(pending) {
          const action = pending.find((item) => item.kind === "kill" && item.actorId === wolves[0].id);
          expect(action).toMatchObject({ legalTargetIds: expect.not.arrayContaining([wolves[1].id]) });
        },
        error: /not legal for this pending action/
      },
      {
        name: "witch cannot save a non-victim",
        state: nightWitch,
        command: { type: "witch.act", actorId: witch.id, saveTargetId: illegalSaveTarget.id },
        pendingKind: "witch",
        actorId: witch.id,
        assertPending(pending) {
          const action = pending.find((item) => item.kind === "witch" && item.actorId === witch.id);
          expect(action).toMatchObject({ nightVictimId: nightVictim.id, canSave: true });
        },
        error: /cannot save/
      },
      {
        name: "speaker cannot pressure self",
        state: daySpeech,
        command: {
          type: "speech.submit",
          actorId: speaker.id,
          text: "我先按公开信息发言，重点比较票型和发言顺序，不制造无依据身份结论。",
          pressureTargetId: speaker.id
        },
        pendingKind: "speech",
        actorId: speaker.id,
        assertPending(pending) {
          const action = pending.find((item) => item.kind === "speech" && item.actorId === speaker.id);
          expect(action).toMatchObject({ legalPressureTargetIds: expect.not.arrayContaining([speaker.id]) });
        },
        error: /not legal for this pending action/
      },
      {
        name: "voter cannot vote self",
        state: dayVote,
        command: { type: "vote.cast", actorId: voter.id, targetId: voter.id },
        pendingKind: "vote",
        actorId: voter.id,
        assertPending(pending) {
          const action = pending.find((item) => item.kind === "vote" && item.actorId === voter.id);
          expect(action).toMatchObject({ legalTargetIds: expect.not.arrayContaining([voter.id]) });
        },
        error: /not legal for this pending action/
      },
      {
        name: "hunter cannot shoot a dead self target",
        state: hunterShot,
        command: { type: "hunter.shoot", actorId: hunter.id, targetId: hunter.id },
        pendingKind: "shoot",
        actorId: hunter.id,
        assertPending(pending) {
          const action = pending.find((item) => item.kind === "shoot" && item.actorId === hunter.id);
          expect(action).toMatchObject({ legalTargetIds: expect.not.arrayContaining([hunter.id]) });
        },
        error: /not legal for this pending action/
      }
    ];

    for (const entry of cases) {
      const environment = new WerewolfEnvironment(entry.state);
      const before = environment.snapshot();
      const pending = environment.pendingActions();
      expect(
        pending.some((action) => action.kind === entry.pendingKind && action.actorId === entry.actorId),
        entry.name
      ).toBe(true);
      entry.assertPending(pending);
      expect(() => environment.step(entry.command), entry.name).toThrow(entry.error);
      expect(environment.snapshot(), entry.name).toEqual(before);
    }
  });

  it("preserves provider failure classification on failed attempted turns without adding failed steps", async () => {
    let calls = 0;
    const providerFailingReasoner: HarnessReasoner = {
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
            providerRequestId: "Bearer provider-failure-request-id-should-not-appear",
            retryCause: "LLM API request exceeded 42ms with Bearer retry-cause-token-should-not-appear.",
            abortReason: "manual abort Bearer abort-reason-token-should-not-appear",
            causeName: "Error Bearer cause-name-token-should-not-appear",
            body: "Bearer raw-provider-token-should-not-appear",
            headers: {
              authorization: "Bearer raw-provider-token-should-not-appear"
            }
          });
        }
        const content =
          input.action.kind === "speech"
            ? "我会围绕公开票型和发言顺序分析，先找视角冲突，再推动大家集中投票。"
            : `provider-failure-prefix:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 4,
            usage: { promptTokens: 6, completionTokens: 8, totalTokens: 14 },
            providerRequestId: `provider-prefix-${input.traceId}`,
            attempts: 2,
            retryHistory: [
              {
                attempt: 1,
                failureKind: "http",
                providerStage: "http_response",
                status: 429,
                retryable: true,
                delayMs: 0,
                message: "LLM API HTTP 429: rate limited"
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
    const initialState = createGame({ id: "provider-failure-attribution", seed: "provider-failure-attribution" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);

    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: providerFailingReasoner,
      maxTransitions: 8
    });
    const artifact = buildMatchArtifact({
      runId: "provider-failure-attribution",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const harnessErrors = harnessFailureEvidenceFromEpisode(result.socialEpisode);
    const payload = harnessErrors[0]?.payload as Record<string, any>;
    const artifactPayload = harnessFailureEvidenceFromEpisode(artifact.socialEpisode)[0]?.payload as Record<string, any>;
    const replay = replayHarnessTrajectory({
      initialState: artifact.initialState,
      trajectory: artifact.trajectory
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("LLM API request failed after 2/3 attempt");
    expect(result.failureStateHash).toBe(hashStableState(result.state));
    expect(result.trajectory).toHaveLength(1);
    expect(result.trajectory[0].reasonerOutput).toMatchObject({
      attempts: 2,
      retryHistory: [
        expect.objectContaining({
          attempt: 1,
          failureKind: "http",
          providerStage: "http_response",
          status: 429,
          retryable: true
        })
      ],
      stream: {
        enabled: true,
        completed: true,
        completedBy: "done_sentinel"
      }
    });
    expect(result.trajectory[0].turnTrace).toMatchObject({
      attempts: 2,
      retryHistory: [
        expect.objectContaining({
          attempt: 1,
          failureKind: "http",
          providerStage: "http_response"
        })
      ],
      stream: {
        enabled: true,
        completed: true,
        completedBy: "done_sentinel"
      }
    });
    expect(harnessErrors).toHaveLength(1);
    expect(payload).toMatchObject({
      model: expect.any(String),
      actionKind: "kill",
      traceId: expect.stringContaining(":harness:"),
      providerFailure: {
        failureKind: "timeout",
        providerStage: "during_request",
        timeoutMs: 42,
        retryable: true,
        aborted: false,
        attempts: 2,
        maxAttempts: 3,
        providerRequestId: "Bearer [REDACTED]",
        retryCause: "LLM API request exceeded 42ms with Bearer [REDACTED]",
        abortReason: "manual abort Bearer [REDACTED]",
        causeName: "Error Bearer [REDACTED]"
      }
    });
    expect(JSON.stringify(payload)).not.toContain("raw-provider-token-should-not-appear");
    expect(JSON.stringify(payload)).not.toContain("provider-failure-request-id-should-not-appear");
    expect(JSON.stringify(payload)).not.toContain("retry-cause-token-should-not-appear");
    expect(JSON.stringify(payload)).not.toContain("abort-reason-token-should-not-appear");
    expect(JSON.stringify(payload)).not.toContain("cause-name-token-should-not-appear");
    expect(artifactPayload.providerFailure).toEqual(payload.providerFailure);
    expect(JSON.stringify(artifact)).not.toContain("raw-provider-token-should-not-appear");
    expect(JSON.stringify(artifact)).not.toContain("provider-failure-request-id-should-not-appear");
    expect(JSON.stringify(artifact)).not.toContain("retry-cause-token-should-not-appear");
    expect(toTrajectoryJsonl(artifact)).not.toContain("provider-failure-request-id-should-not-appear");
    expect(toTrajectoryJsonl(artifact)).not.toContain("retry-cause-token-should-not-appear");
    expect(replay.ok).toBe(true);
    expect(replay.finalHash).toBe(artifact.trajectory.at(-1)?.postStateHash);
    expect(replay.finalHash).toBe(artifact.failureStateHash);
  });
});
