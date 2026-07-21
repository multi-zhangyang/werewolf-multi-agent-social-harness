import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import { buildMatchArtifact, toTrajectoryJsonl, validateMatchArtifactIntegrity } from "../src/harness/artifacts";
import { evaluateAdversarialMatch } from "../src/harness/evaluator";
import { policyForRole } from "../src/harness/policy";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { replayHarnessTrajectory } from "../src/harness/replay";
import { runHarnessMatch } from "../src/harness/runtime";
import { buildWerewolfHarnessRunResultFromParts, type WerewolfResultEvaluator } from "../src/harness/werewolfResult";
import type { HarnessReasoner } from "../src/harness/types";

describe("Werewolf evaluator failure isolation", () => {
  it("keeps a replayable environment result and deterministic compatibility evaluation when an appended evaluator fails", async () => {
    const initialState = createGame({ id: "werewolf-evaluator-failure-isolation", seed: "werewolf-evaluator-failure-isolation" });
    const profiles = profilesFromModels(["deterministic-evaluation-model"], 0);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0).map((agent) => ({
      ...agent,
      policyName: policyForRole(initialState.players.find((player) => player.id === agent.playerId)!.role)
    }));
    let reasonerCalls = 0;
    const reasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls += 1;
        const content = `evaluator isolation memo:${input.agent.playerId}:${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            attempts: 1,
            stream: { enabled: true, completed: true, completedBy: "done_sentinel" }
          }
        };
      }
    };
    const original = await runHarnessMatch({ initialState, agents, reasoner, maxTransitions: 2 });
    const callsBeforeFinalization = reasonerCalls;
    const failingEvaluator: WerewolfResultEvaluator = {
      id: "test.werewolf-finalizer-throw",
      label: "Test finalizer throwing evaluator",
      version: "1.0.0",
      evaluate() {
        throw new Error("raw finalizer evaluator failure must not be persisted");
      }
    };

    const rebuilt = buildWerewolfHarnessRunResultFromParts({
      status: original.status,
      truncationReason: original.truncationReason,
      failureReason: original.failureReason,
      initialState: original.initialState,
      finalState: original.state,
      agentStates: original.agents,
      trajectory: original.trajectory,
      socialEpisode: original.socialEpisode,
      additionalEvaluators: [failingEvaluator]
    });
    const pureEvaluation = evaluateAdversarialMatch(rebuilt.state, rebuilt.agents, rebuilt.socialEpisode);
    const artifact = buildMatchArtifact({
      runId: "werewolf-evaluator-failure-isolation",
      seed: initialState.seed,
      models: ["deterministic-evaluation-model"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: rebuilt
    });
    const replay = replayHarnessTrajectory({ initialState: artifact.initialState, trajectory: artifact.trajectory });
    const evaluationRecord = JSON.parse(
      toTrajectoryJsonl(artifact)
        .trim()
        .split("\n")
        .find((line) => JSON.parse(line).type === "evaluation_report")!
    ) as Record<string, unknown>;

    expect(reasonerCalls).toBe(callsBeforeFinalization);
    expect(rebuilt.status).toBe(original.status);
    expect(rebuilt.trajectory).toEqual(original.trajectory);
    expect(rebuilt.evaluation).toEqual(pureEvaluation);
    expect(rebuilt.evaluation.agentRewards).toHaveLength(initialState.players.length);
    expect(rebuilt.evaluationReport.status).toBe("incomplete");
    expect(rebuilt.evaluationReport.failures).toEqual([
      {
        evaluatorId: "test.werewolf-finalizer-throw",
        label: "Test finalizer throwing evaluator",
        version: "1.0.0",
        stage: "evaluate",
        code: "evaluator_exception",
        message: "Evaluator execution failed; no metrics or output were recorded."
      }
    ]);
    expect(rebuilt.evaluationReport.outputs["test.werewolf-finalizer-throw"]).toBeUndefined();
    expect(JSON.stringify(rebuilt.evaluationReport)).not.toContain("raw finalizer evaluator failure");
    expect(validateMatchArtifactIntegrity(artifact)).toEqual([]);
    const tamperedCoverage = structuredClone(artifact);
    tamperedCoverage.evaluationReport.status = "completed";
    expect(validateMatchArtifactIntegrity(tamperedCoverage)).toEqual(
      expect.arrayContaining(["evaluationReport.status must be completed exactly when failures is empty."])
    );
    expect(evaluationRecord).toMatchObject({ status: "incomplete", failureCount: 1, failures: rebuilt.evaluationReport.failures });
    expect(replay.ok).toBe(true);
    expect(replay.finalHash).toBeDefined();
  });
});
