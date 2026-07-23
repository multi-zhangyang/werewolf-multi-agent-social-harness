import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openTournamentOrchestration,
  runTournament
} from "../src/harness/tournament";
import { validateHarnessCheckpoint } from "../src/harness/artifacts";
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
      const checkpoints = await firstAuthority.artifactStore.listCheckpoints(episode.runId!);
      expect(checkpoints).toHaveLength(1);
      const checkpoint = await firstAuthority.artifactStore.getCheckpoint(
        episode.runId!,
        checkpoints[0]!.checkpointId
      );
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.source.nativeStepCount).toBe(episode.artifact?.socialEpisode.steps.length);
      expect(checkpoint?.source.experiment?.specId).toBe("production-v2");
      expect(validateHarnessCheckpoint(checkpoint!)).toEqual([]);
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
    for (const episode of restarted.episodes) {
      await expect(restartedAuthority.artifactStore.listCheckpoints(episode.runId!))
        .resolves.toHaveLength(1);
    }
  }, 120_000);

  it("records zero-transition tournaments with checkpointPolicy none and does not backfill checkpoints on restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "werewolf-tournament-v2-zero-transition-"));
    tempDirs.push(root);
    let reasonerCalls = 0;
    const reasoner: HarnessReasoner = {
      async think() {
        reasonerCalls += 1;
        throw new Error("zero-transition tournament must not call the reasoner");
      }
    };
    const firstAuthority = await openTournamentOrchestration({
      baseDirectory: root,
      runSetId: "production-v2-zero-transition"
    });
    const first = await runTournament({
      models: ["opaque/model-zero-transition"],
      profiles: [{ id: "opaque-zero-transition-profile", model: "opaque/model-zero-transition", temperature: 0 }],
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed: "production-v2-zero-transition-seed",
      reasoner,
      maxTransitions: 0,
      continueOnError: true,
      includeArtifacts: true,
      orchestration: firstAuthority
    });

    expect(reasonerCalls).toBe(0);
    expect(first.gamesTruncated).toBe(1);
    expect(first.episodes).toHaveLength(1);
    const firstEpisode = first.episodes[0]!;
    expect(firstEpisode.status).toBe("truncated");
    expect(firstEpisode.artifact?.socialEpisode.steps).toEqual([]);
    expect(firstEpisode.artifact?.experiment?.spec.checkpointPolicy).toEqual({
      id: "harness.checkpoint.none.zero-transition",
      version: "1",
      mode: "none"
    });
    await expect(firstAuthority.artifactStore.listCheckpoints(firstEpisode.runId!)).resolves.toEqual([]);

    const restartedAuthority = await openTournamentOrchestration({
      baseDirectory: root,
      runSetId: "production-v2-zero-transition"
    });
    const restarted = await runTournament({
      models: ["opaque/model-zero-transition"],
      profiles: [{ id: "opaque-zero-transition-profile", model: "opaque/model-zero-transition", temperature: 0 }],
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed: "production-v2-zero-transition-seed",
      reasoner,
      maxTransitions: 0,
      continueOnError: true,
      includeArtifacts: true,
      experiment: first.experiment,
      orchestration: restartedAuthority
    });

    expect(reasonerCalls).toBe(0);
    expect(restarted.episodes.map((episode) => episode.runId)).toEqual([firstEpisode.runId]);
    expect(restarted.episodes.map((episode) => episode.status)).toEqual(["truncated"]);
    expect(restarted.episodes[0]?.artifact?.experiment?.spec.checkpointPolicy.mode).toBe("none");
    await expect(restartedAuthority.artifactStore.listCheckpoints(firstEpisode.runId!)).resolves.toEqual([]);
  }, 30_000);

  it("publishes a strongly valid final checkpoint when the last committed boundary is a system transition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "werewolf-tournament-v2-system-boundary-"));
    tempDirs.push(root);
    let reasonerCalls = 0;
    const reasoner: HarnessReasoner = {
      async think() {
        reasonerCalls += 1;
        throw new Error("the initial system transition must not call the reasoner");
      }
    };
    const authority = await openTournamentOrchestration({
      baseDirectory: root,
      runSetId: "production-v2-system-boundary"
    });
    const result = await runTournament({
      models: ["opaque/model-system-boundary"],
      profiles: [{ id: "opaque-system-boundary-profile", model: "opaque/model-system-boundary", temperature: 0 }],
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed: "production-v2-system-boundary-seed",
      reasoner,
      maxTransitions: 1,
      continueOnError: true,
      includeArtifacts: true,
      orchestration: authority
    });

    expect(reasonerCalls).toBe(0);
    expect(result.gamesTruncated).toBe(1);
    const episode = result.episodes[0]!;
    const artifact = episode.artifact!;
    expect(artifact.experiment?.spec.checkpointPolicy.mode).toBe("final");
    expect(artifact.socialEpisode.steps).toHaveLength(1);
    const boundary = artifact.socialEpisode.steps[0]!;
    expect(boundary).toMatchObject({
      actorId: "system",
      resolutionPolicy: "system-transition",
      commitStatus: "committed"
    });
    expect(boundary.action.traceId).toBe(boundary.traceId);
    expect(boundary.actorSnapshotsHashAfterStep).toBeTruthy();
    expect(boundary.actorSnapshotFrameIdAfterStep).toBeTruthy();
    const frame = artifact.agentSnapshotFrames?.find(
      (candidate) => candidate.frameId === boundary.actorSnapshotFrameIdAfterStep
    );
    expect(frame).toBeDefined();
    expect(frame?.agentsHash).toBe(boundary.actorSnapshotsHashAfterStep);
    expect(frame?.agents).toEqual(artifact.agents);

    const checkpointIndex = await authority.artifactStore.listCheckpoints(episode.runId!);
    expect(checkpointIndex).toHaveLength(1);
    const checkpoint = await authority.artifactStore.getCheckpoint(
      episode.runId!,
      checkpointIndex[0]!.checkpointId
    );
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.source.boundaryTraceId).toBe(boundary.traceId);
    expect(checkpoint?.source.nativeStepCount).toBe(1);
    expect(checkpoint?.source.agentsHash).toBe(boundary.actorSnapshotsHashAfterStep);
    expect(checkpoint?.source.agentSnapshotFrameId).toBe(boundary.actorSnapshotFrameIdAfterStep);
    expect(checkpoint?.agents).toEqual(artifact.agents);
    expect(validateHarnessCheckpoint(checkpoint!)).toEqual([]);
  }, 30_000);
});
