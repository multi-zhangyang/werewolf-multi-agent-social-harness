import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openTournamentOrchestration,
  runTournament
} from "../src/harness/tournament";
import type { HarnessReasoner } from "../src/harness/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production Werewolf tournament V2 orchestration", () => {
  it("persists canonical episodes and projects a finalized restart without model work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "werewolf-tournament-v2-"));
    tempDirs.push(root);
    let decisions = 0;
    const reasoner: HarnessReasoner = {
      async think(input) {
        decisions += 1;
        const content = input.action.kind === "speech"
          ? `公开证据测试发言 ${input.traceId}`
          : `durable tournament memo ${input.traceId}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            attempts: 1,
            stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
          }
        };
      }
    };
    const firstAuthority = await openTournamentOrchestration({
      baseDirectory: root,
      runSetId: "production-v2"
    });
    const first = await runTournament({
      models: ["opaque/model-a"],
      profiles: [{ id: "opaque-profile", model: "opaque/model-a", temperature: 0.3 }],
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed: "production-v2-seed",
      reasoner,
      maxTransitions: 2,
      continueOnError: true,
      includeArtifacts: true,
      experiment: {
        version: "werewolf.experiment.v1",
        id: "production-v2",
        kind: "tournament",
        seed: "production-v2-seed",
        models: ["opaque/model-a"],
        profiles: [{ id: "opaque-profile", model: "opaque/model-a", temperature: 0.3 }],
        assignment: { strategy: "profile-rotation" },
        games: 1,
        maxTransitions: 2,
        jointPhaseScheduler: "aec-batched-decision",
        temperature: 0.3,
        json: "summary",
        continueOnError: true
      },
      orchestration: firstAuthority
    });

    expect(decisions).toBeGreaterThan(0);
    expect(
      first.gamesTruncated,
      JSON.stringify({
        completed: first.gamesCompleted,
        truncated: first.gamesTruncated,
        failed: first.gamesFailed,
        unstarted: first.gamesUnstarted,
        episodes: first.episodes.map((episode) => ({ status: episode.status, error: episode.error, runId: episode.runId }))
      })
    ).toBe(1);
    expect(first.artifacts).toHaveLength(1);
    expect(first.episodes.every((episode) => episode.artifact?.experiment?.specId === "production-v2")).toBe(true);
    for (const episode of first.episodes) {
      expect(episode.runId).toBeTruthy();
      await expect(firstAuthority.artifactStore.getEvaluationReport(episode.runId!))
        .resolves.toMatchObject({ id: episode.evaluationReport?.id });
    }

    const restartedAuthority = await openTournamentOrchestration({
      baseDirectory: root,
      runSetId: "production-v2"
    });
    const noRerunReasoner: HarnessReasoner = {
      async think() {
        throw new Error("finalized tournament must not call the reasoner during restart projection");
      }
    };
    const restarted = await runTournament({
      models: ["opaque/model-a"],
      profiles: [{ id: "opaque-profile", model: "opaque/model-a", temperature: 0.3 }],
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed: "production-v2-seed",
      reasoner: noRerunReasoner,
      maxTransitions: 2,
      continueOnError: true,
      includeArtifacts: true,
      experiment: first.experiment,
      orchestration: restartedAuthority
    });

    expect(restarted.episodes.map((episode) => episode.runId)).toEqual(first.episodes.map((episode) => episode.runId));
    expect(restarted.episodes.map((episode) => episode.status)).toEqual(first.episodes.map((episode) => episode.status));
    expect(restarted.modelStats).toEqual(first.modelStats);
  });
});
