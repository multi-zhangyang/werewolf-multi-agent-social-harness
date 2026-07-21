import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests, createMatchRecord, saveMatch } from "../src/server/store";
import { buildMatchArtifact, resolveAgentSnapshotsAfterStep, type MatchArtifact } from "../src/harness/artifacts";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import type { HarnessReasoner } from "../src/harness/types";
import { countSocialStepCommits } from "../src/harness/social";

const fakeReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? "我按当前公开信息发言，先复盘已经发生的行动、票型和发言压力，不把没有证据的猜测当事实。"
        : `server-checkpoint:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `server-checkpoint-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

const CHECKPOINT_INDEX_FILE = "checkpoints.index.json";
const CHECKPOINT_DIR = "checkpoints";
const RECOVERY_AUDIT_FILE = "artifact_recovery_audits.jsonl";
const tempDirs: string[] = [];
let server: Server | undefined;

describe("checkpoint and fork API", () => {
  let baseUrl: string;

  beforeEach(async () => {
    clearServerStoreForTests();
    baseUrl = await startServer();
  });

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    clearServerStoreForTests();
  });

  it("creates checkpoint summaries and defaults checkpoint artifact reads to a truth-redacted projection", async () => {
    const { record } = await createStoredArtifactMatch("server-checkpoint-create");

    const created = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "api checkpoint"
    });

    expect(created.status).toBe(201);
	    expect(created.body.summary).toMatchObject({
	      kind: "checkpoint",
	      ok: true,
	      source: {
	        runId: record.id,
	        matchId: record.id,
	        rulesetId: "werewolf.classic-9-seat.v1",
	        boundaryTraceRef: expect.any(String),
	        stateHash: record.artifact?.finalState ? expect.any(String) : undefined
	      }
	    });
	    expect(created.body.summary.source).not.toHaveProperty("traceId");
	    assertPublicCheckpointResponse(created.body);

    const defaultArtifact = await requestJson(baseUrl, "GET", `/api/checkpoints/${created.body.summary.checkpointId}/artifact`);
    expect(defaultArtifact.status).toBe(200);
    expect(defaultArtifact.headers.get("cache-control")).toContain("no-store");
    expect(defaultArtifact.headers.get("x-content-type-options")).toBe("nosniff");
    expect(defaultArtifact.body).toMatchObject({
      artifactVersion: "harness.checkpoint.v2",
      kind: "checkpoint",
      checkpointId: created.body.summary.checkpointId,
	      source: expect.objectContaining({
	        runId: record.id,
	        matchId: record.id
	      }),
      projection: {
        view: "truth-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: true
      }
    });
    expect(Object.keys(defaultArtifact.body.source).sort()).toEqual(["matchId", "rulesetId", "runId", "sourceArtifactVersion", "status"]);
    expect(defaultArtifact.body.source).not.toHaveProperty("boundaryTraceId");
    expect(defaultArtifact.body.source).not.toHaveProperty("seed");
    expect(defaultArtifact.body.source).not.toHaveProperty("stateHash");
    expect(defaultArtifact.body.agents).toEqual([]);
    expect(JSON.stringify(defaultArtifact.body)).toContain("executionPrefix");
    for (const player of defaultArtifact.body.state.players) {
      expect(player).not.toHaveProperty("role");
      expect(player).not.toHaveProperty("team");
      expect(player).not.toHaveProperty("ability");
    }
    expect(JSON.stringify(defaultArtifact.body)).not.toContain("seerInspection");
    expect(defaultArtifact.body.state).not.toHaveProperty("night");
    expect(defaultArtifact.body.state).not.toHaveProperty("seed");
    const truthPrefix = defaultArtifact.body.executionPrefix;
    expect(truthPrefix.channels.length).toBeGreaterThan(0);
    expect(truthPrefix.channels.every((channel: any) => channel.kind === "public" && channel.readableBy === "all")).toBe(true);
    expect(truthPrefix.messages.every((message: any) => message.visibility === "public")).toBe(true);
    expect(truthPrefix.profiles).toEqual([]);
    expect(truthPrefix.steps).toEqual([]);
    expect(truthPrefix.exposureRecords).toEqual([]);
    expect(JSON.stringify(truthPrefix)).not.toContain("werewolf-team");
    for (const agent of record.artifact?.agents ?? []) {
      for (const memo of agent.privateMemos) expect(JSON.stringify(defaultArtifact.body)).not.toContain(memo);
    }

    const artifact = await requestJson(
      baseUrl,
      "GET",
      `/api/checkpoints/${created.body.summary.checkpointId}/artifact?view=full`
    );
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("x-robots-tag")).toContain("noindex");
    expect(artifact.body.projection).toBeUndefined();
    expect(artifact.body.state.players.some((player: { role?: string }) => Boolean(player.role))).toBe(true);

    const listed = await requestJson(baseUrl, "GET", `/api/checkpoints?matchId=${record.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.checkpoints).toHaveLength(1);
    expect(listed.body.checkpoints[0]).toMatchObject({
      checkpointId: created.body.summary.checkpointId,
      counts: {
        agents: artifact.body.agents.length,
        nativeSteps: countSocialStepCommits(artifact.body.executionPrefix.steps).nativeSteps,
        committedSteps: countSocialStepCommits(artifact.body.executionPrefix.steps).committedSteps,
        rejectedSteps: countSocialStepCommits(artifact.body.executionPrefix.steps).rejectedSteps,
        socialMessages: artifact.body.executionPrefix.messages.length,
        channels: artifact.body.executionPrefix.channels.length
      }
    });
    expect(listed.body.checkpoints[0]).not.toHaveProperty("state");
    expect(listed.body.checkpoints[0]).not.toHaveProperty("agents");
    expect(listed.body.checkpoints[0]).not.toHaveProperty("executionPrefix");

    const detail = await requestJson(baseUrl, "GET", `/api/checkpoints/${created.body.summary.checkpointId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(created.body);
    assertPublicCheckpointResponse(detail.body);

    const matchDetail = await requestJson(baseUrl, "GET", `/api/matches/${record.id}`);
    expect(matchDetail.status).toBe(200);
    expect(matchDetail.body).toMatchObject({
      id: record.id,
      hasArtifact: true,
      checkpointCount: 1
    });
    expect(matchDetail.body).not.toHaveProperty("checkpoint");
    expect(matchDetail.body).not.toHaveProperty("artifact");
    expect(JSON.stringify(matchDetail.body)).not.toContain("privateMemos");
  });

  it("rejects filesystem and raw artifact fields on checkpoint and fork requests", async () => {
    const { record } = await createStoredArtifactMatch("server-checkpoint-reject");

    const forbiddenFields = [
      "path",
      "file",
      "artifactPath",
      "checkpointPath",
      "outputDir",
      "artifact",
      "checkpoint",
      "state",
      "initialState",
      "agents",
      "initialAgentStates",
      "trajectory",
      "socialMessages",
      "initialSocialMessages",
      "stateHash",
      "trajectoryHash",
      "agentsHash",
      "socialMessagesHash",
      "agentSnapshots",
      "agentSnapshotFrames",
      "agentSnapshotsAfterStep",
      "actorSnapshotsAfterStep",
      "agentSnapshotsHashAfterStep",
      "actorSnapshotsHashAfterStep",
      "agentSnapshotFrameIdAfterStep",
      "actorSnapshotFrameIdAfterStep"
    ];

    for (const field of forbiddenFields) {
      const rejectedCreate = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
        [field]: field.endsWith("s") || field.includes("Snapshots") ? [] : `unsafe-${field}`
      });
      expect(rejectedCreate.status).toBe(400);
      expect(rejectedCreate.body.error).toMatch(/forbidden field/);
      expect(rejectedCreate.body.error).toContain(field);
    }

    const created = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "safe checkpoint"
    });
    expect(created.status).toBe(201);

    for (const field of forbiddenFields) {
      const rejectedFork = await requestJson(baseUrl, "POST", `/api/checkpoints/${created.body.summary.checkpointId}/fork`, {
        [field]: field.endsWith("s") || field.includes("Snapshots") ? [] : `unsafe-${field}`
      });
      expect(rejectedFork.status).toBe(400);
      expect(rejectedFork.body.error).toMatch(/forbidden field/);
      expect(rejectedFork.body.error).toContain(field);
    }
  });

  it("creates a prefix checkpoint by server-owned selector and forks from that boundary", async () => {
    const { record } = await createStoredArtifactMatch("server-checkpoint-prefix");
    if (!record.artifact) throw new Error("Expected stored match artifact.");
    const nativeStepCount = firstSafeNativePrefixLength(record.artifact);
    const selectedNativeStep = record.artifact.socialEpisode.steps[nativeStepCount - 1];
    const selectedStep = record.artifact.trajectory.find((step) => step.traceId === selectedNativeStep.traceId);
    if (!selectedStep) throw new Error("Expected legacy projection for selected native player step.");
    const selectedSnapshots = resolveAgentSnapshotsAfterStep(record.artifact, selectedStep);
    if (!selectedSnapshots) throw new Error("Expected selected prefix snapshot frame.");

    const created = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "api prefix checkpoint",
      nativeStepCount
    });

    expect(created.status).toBe(201);
    expect(created.body.summary).toMatchObject({
      kind: "checkpoint",
      ok: true,
      reason: "api prefix checkpoint",
      source: {
        runId: record.id,
        matchId: record.id,
        boundaryTraceRef: expect.any(String),
        boundaryTurnIndex: selectedNativeStep.turnIndex,
        nativeStepCount,
        stateHash: selectedStep.postStateHash
      },
      counts: {
        nativeSteps: nativeStepCount
      }
    });
    expect(created.body.summary.source).not.toHaveProperty("traceId");
    assertPublicCheckpointResponse(created.body);

    const checkpointArtifact = await requestJson(baseUrl, "GET", `/api/checkpoints/${created.body.summary.checkpointId}/artifact?view=full`);
    expect(checkpointArtifact.status).toBe(200);
    const checkpoint = checkpointArtifact.body;
    expect(checkpoint.source).toMatchObject({
      runId: record.id,
      matchId: record.id,
      boundaryTraceId: selectedNativeStep.traceId,
      boundaryTurnIndex: selectedNativeStep.turnIndex,
      nativeStepCount,
      stateHash: selectedStep.postStateHash
    });
    expect(checkpoint.executionPrefix.steps).toHaveLength(nativeStepCount);
    expect(checkpoint.state).not.toEqual(record.artifact.finalState);
    expect(checkpoint.agents).toEqual(selectedSnapshots);
    expect(checkpoint.agents).not.toEqual(record.artifact.agents);
    expect(checkpoint.executionPrefix.messages).toEqual(record.artifact.socialEpisode.messages.slice(0, checkpoint.source.messageCount));

    const forked = await requestJson(baseUrl, "POST", `/api/checkpoints/${checkpoint.checkpointId}/fork`, {
      reason: "api prefix fork",
      maxTransitions: 1
    });

    expect(forked.status).toBe(200);
    expect(forked.body.summary).toMatchObject({
      kind: "fork",
      checkpointId: checkpoint.checkpointId,
      forkOf: {
        checkpointId: checkpoint.checkpointId,
        parentRunId: record.id,
        parentMatchId: record.id,
        parentBoundaryTraceRef: expect.any(String),
        parentStateHash: checkpoint.source.stateHash,
        parentNativeStepCount: nativeStepCount,
        reason: "api prefix fork"
      }
    });
    expect(forked.body.summary.forkOf).not.toHaveProperty("parentBoundaryTraceId");

    const forkArtifact = await requestJson(baseUrl, "GET", `/api/matches/${forked.body.id}/artifact?view=full`);
    expect(forkArtifact.status).toBe(200);
    expect(forkArtifact.body.forkOf).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      parentBoundaryTraceId: selectedNativeStep.traceId,
      parentStateHash: checkpoint.source.stateHash,
      parentNativeStepCount: nativeStepCount
    });
    expect(forkArtifact.body.trajectory[0].preStateHash).toBe(checkpoint.source.stateHash);
    expect(forkArtifact.body.socialEpisode.messages.slice(0, checkpoint.executionPrefix.messages.length)).toEqual(checkpoint.executionPrefix.messages);
    expect(forkArtifact.body.trajectory[0].messageSeqRange?.[0]).toBe((checkpoint.source.lastMessageSeq ?? 0) + 1);
  });

  it("rejects ambiguous, unknown, and raw-state prefix checkpoint requests", async () => {
    const { record } = await createStoredArtifactMatch("server-checkpoint-prefix-reject");

    const ambiguous = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      nativeStepCount: 1,
      nativeTurnIndex: 1
    });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toMatch(/at most one prefix selector/);

    const unknownTrace = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      traceId: "unknown:harness:trace"
    });
    expect(unknownTrace.status).toBe(400);
    expect(unknownTrace.body.code).toBe("selector_not_found");
    expect(unknownTrace.body.error).toMatch(/selector did not match/);
    expect(unknownTrace.body.error).not.toContain("privateMemos");

    const outOfRange = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      nativeStepCount: 999
    });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.code).toBe("selector_not_found");
    expect(outOfRange.body.error).toMatch(/selector did not match/);

    const { record: noSnapshotRecord } = await createStoredArtifactMatch("server-checkpoint-prefix-no-snapshots", {
      recordAgentSnapshots: false
    });
    const missingSnapshots = await requestJson(baseUrl, "POST", `/api/matches/${noSnapshotRecord.id}/checkpoints`, {
      nativeStepCount: 1
    });
    expect(missingSnapshots.status).toBe(409);
    expect(missingSnapshots.body.code).toBe("missing_agent_snapshots");
    expect(missingSnapshots.body.error).toMatch(/not recorded/);
    expect(JSON.stringify(missingSnapshots.body)).not.toContain("privateMemos");

    const rawState = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      nativeStepCount: 1,
      state: record.state
    });
    expect(rawState.status).toBe(400);
    expect(rawState.body.error).toMatch(/forbidden field/);
  });

  it("forks a stored checkpoint through the API and stores fork provenance on the new match artifact", async () => {
    const { record } = await createStoredArtifactMatch("server-checkpoint-fork");
    const created = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "fork source"
    });
    const checkpointArtifact = await requestJson(baseUrl, "GET", `/api/checkpoints/${created.body.summary.checkpointId}/artifact?view=full`);
    expect(checkpointArtifact.status).toBe(200);
    const checkpoint = checkpointArtifact.body;

    const forked = await requestJson(baseUrl, "POST", `/api/checkpoints/${checkpoint.checkpointId}/fork`, {
      reason: "api fork",
      maxTransitions: 2
    });

    expect(forked.status).toBe(200);
	    expect(forked.body.summary).toMatchObject({
	      kind: "fork",
	      checkpointId: checkpoint.checkpointId,
	      forkOf: {
	        checkpointId: checkpoint.checkpointId,
	        parentRunId: record.id,
	        parentMatchId: record.id,
	        parentBoundaryTraceRef: expect.any(String),
	        parentStateHash: checkpoint.source.stateHash,
	        parentNativeStepCount: checkpoint.source.nativeStepCount,
	        reason: "api fork"
	      }
	    });
	    expect(forked.body.summary.forkOf).not.toHaveProperty("parentBoundaryTraceId");
    expect(forked.body.summary.resolvedAssignments).toHaveLength(forked.body.state.players.length);
    for (const assignment of forked.body.summary.resolvedAssignments) {
      expect(Object.keys(assignment).sort()).toEqual(["playerId", "seat"]);
      expect(assignment).not.toHaveProperty("role");
      expect(assignment).not.toHaveProperty("team");
      expect(assignment).not.toHaveProperty("profileId");
      expect(assignment).not.toHaveProperty("model");
      expect(assignment).not.toHaveProperty("temperature");
      expect(assignment).not.toHaveProperty("policyName");
    }
    expect(forked.body).toMatchObject({
      id: expect.any(String),
      hasArtifact: true,
      checkpointCount: 0
    });
    expect(JSON.stringify(forked.body)).not.toContain("LLM_API_KEY");

	    const artifactResponse = await requestJson(baseUrl, "GET", `/api/matches/${forked.body.id}/artifact`);
	    expect(artifactResponse.status).toBe(200);
	    expect(artifactResponse.body.forkOf).toMatchObject({
	      checkpointId: checkpoint.checkpointId,
	      parentRunId: record.id,
	      parentMatchId: record.id,
	      parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
	      parentStateHash: checkpoint.source.stateHash,
	      parentNativeStepCount: checkpoint.source.nativeStepCount,
	      reason: "api fork"
	    });
    expect(artifactResponse.body.forkOf).not.toHaveProperty("parentBoundaryTraceRef");
    if (artifactResponse.body.socialEpisode.steps.length > 0) {
      expect(artifactResponse.body.socialEpisode.steps[0].preStateHash).toBe(checkpoint.source.stateHash);
    }

    const lineage = await requestJson(baseUrl, "GET", `/api/matches/${forked.body.id}/fork-lineage`);
    expect(lineage.status).toBe(200);
    expect(lineage.body.summary).toMatchObject({
      kind: "fork-lineage",
      schemaVersion: "server.fork-lineage-summary.v2",
      ok: true,
      isFork: true,
      runId: forked.body.id,
      forkOf: {
        checkpointId: checkpoint.checkpointId,
        parentRunId: record.id,
        parentMatchId: record.id,
        parentBoundaryTraceRef: expect.any(String),
        parentStateHash: checkpoint.source.stateHash,
        parentNativeStepCount: checkpoint.source.nativeStepCount,
        reason: "api fork"
      },
      parent: {
        checkpointId: checkpoint.checkpointId,
        runId: record.id,
        matchId: record.id,
        boundaryTraceRef: expect.any(String),
        nativeStepCount: checkpoint.source.nativeStepCount,
        messageCount: checkpoint.source.messageCount,
        lastMessageSeq: checkpoint.source.lastMessageSeq ?? null,
        stateHash: checkpoint.source.stateHash,
        executionPrefixHash: checkpoint.source.executionPrefixHash,
        agentsHash: checkpoint.source.agentsHash,
        channelsHash: checkpoint.source.channelsHash,
        messagesHash: checkpoint.source.messagesHash,
        checkpointFound: true
      },
      child: {
        runId: forked.body.id,
        nativeStepCount: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).nativeSteps,
        committedSteps: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).committedSteps,
        rejectedSteps: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).rejectedSteps,
        socialMessages: artifactResponse.body.socialEpisode.messages.length,
        firstStepPreStateHash: artifactResponse.body.socialEpisode.steps[0]?.preStateHash ?? null
      },
      boundary: {
        status: artifactResponse.body.socialEpisode.steps.length > 0 ? "verified" : "no_child_steps",
        checkpointFound: true,
        stateHashMatches: artifactResponse.body.socialEpisode.steps.length > 0 ? true : null,
        checkpointSourceMatchesForkOf: true,
        messagePrefixMatchesCheckpoint: true,
        newNativeSteps: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).nativeSteps,
        newCommittedSteps: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).committedSteps,
        newRejectedSteps: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).rejectedSteps,
        newSocialMessages: artifactResponse.body.socialEpisode.messages.length - checkpoint.executionPrefix.messages.length
      }
    });
    expect(lineage.body.summary.forkOf).not.toHaveProperty("parentBoundaryTraceId");
    expect(lineage.body.summary.parent).not.toHaveProperty("boundaryTraceId");
    expect(JSON.stringify(lineage.body)).not.toContain("parentBoundaryTraceId");
    expect(JSON.stringify(lineage.body)).not.toContain("\"players\"");
    expect(JSON.stringify(lineage.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(lineage.body)).not.toContain("\"socialMessages\":[");

    const checkpointForks = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpoint.checkpointId}/forks`);
    expect(checkpointForks.status).toBe(200);
    expect(checkpointForks.body.summary).toMatchObject({
      kind: "checkpoint-forks",
      schemaVersion: "server.checkpoint-forks-summary.v2",
      ok: true,
      checkpoint: {
        kind: "checkpoint",
        checkpointId: checkpoint.checkpointId,
        source: {
          runId: record.id,
          matchId: record.id,
          boundaryTraceRef: expect.any(String),
          stateHash: checkpoint.source.stateHash
        }
      },
      childCount: 1,
      forks: [
        {
          runId: forked.body.id,
          matchId: forked.body.id,
          nativeStepCount: countSocialStepCommits(artifactResponse.body.socialEpisode.steps).nativeSteps,
          socialMessages: artifactResponse.body.socialEpisode.messages.length,
          forkOf: {
            checkpointId: checkpoint.checkpointId,
            parentRunId: record.id,
            parentMatchId: record.id,
            parentBoundaryTraceRef: expect.any(String)
          },
          lineage: {
            kind: "fork-lineage",
            ok: true,
            boundary: {
              checkpointFound: true,
              checkpointSourceMatchesForkOf: true,
              messagePrefixMatchesCheckpoint: true
            }
          }
        }
      ]
    });
    expect(checkpointForks.body.summary.checkpoint.source).not.toHaveProperty("traceId");
    expect(checkpointForks.body.summary.forks[0].forkOf).not.toHaveProperty("parentBoundaryTraceId");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("parentBoundaryTraceId");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("\"players\"");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("\"socialMessages\":[");

    const nonForkLineage = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/fork-lineage`);
    expect(nonForkLineage.status).toBe(200);
    expect(nonForkLineage.body.summary).toMatchObject({
      kind: "fork-lineage",
      ok: true,
      isFork: false,
      forkOf: null,
      parent: null,
      boundary: {
        status: "not_fork",
        checkpointFound: false
      }
    });
  });

  it("lists checkpoint fork children safely for missing empty and multiple-child cases", async () => {
    const missingId = "00000000-0000-4000-8000-000000000404";
    const missing = await requestJson(baseUrl, "GET", `/api/checkpoints/${missingId}/forks`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "checkpoint not found" });
    const missingTree = await requestJson(baseUrl, "GET", `/api/checkpoints/${missingId}/branch-tree`);
    expect(missingTree.status).toBe(404);
    expect(missingTree.body).toEqual({ error: "checkpoint not found" });

    const { record } = await createStoredArtifactMatch("server-checkpoint-fork-children");
    const created = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "child index source"
    });
    expect(created.status).toBe(201);
    const checkpointId = created.body.summary.checkpointId as string;

    const empty = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpointId}/forks`);
    expect(empty.status).toBe(200);
    expect(empty.body.summary).toMatchObject({
      kind: "checkpoint-forks",
      schemaVersion: "server.checkpoint-forks-summary.v2",
      ok: true,
      childCount: 0,
      forks: []
    });
    expect(empty.body.summary).not.toHaveProperty("state");
    expect(empty.body.summary.checkpoint).not.toHaveProperty("state");
    expect(empty.body.summary.checkpoint).not.toHaveProperty("agents");
    expect(empty.body.summary.checkpoint).not.toHaveProperty("trajectory");
    expect(empty.body.summary.checkpoint).not.toHaveProperty("socialMessages");

    const emptyTree = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpointId}/branch-tree`);
    expect(emptyTree.status).toBe(200);
    expect(emptyTree.body.summary).toMatchObject({
      kind: "checkpoint-branch-tree",
      schemaVersion: "server.checkpoint-branch-tree-summary.v2",
      ok: true,
      okScope: "returned",
      rootCheckpointId: checkpointId,
      counts: {
        checkpoints: 1,
        matches: 0,
        edges: 0,
        maxDepth: 0
      },
      limits: {
        maxDepth: null,
        maxNodes: null
      },
      truncation: {
        isTruncated: false,
        reasons: [],
        omittedCheckpoints: 0,
        omittedMatches: 0,
        omittedEdges: 0
      },
      checkpoints: [
        {
          depth: 0,
          checkpointId,
          createdAt: expect.any(String),
          childForkCount: 0,
          summary: {
            checkpointId
          }
        }
      ],
      matches: [],
      edges: []
    });
    expect(JSON.stringify(emptyTree.body)).not.toContain("\"state\"");
    expect(JSON.stringify(emptyTree.body)).not.toContain("\"players\"");
    expect(JSON.stringify(emptyTree.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(emptyTree.body)).not.toContain("\"socialMessages\":[");

    const firstFork = await requestJson(baseUrl, "POST", `/api/checkpoints/${checkpointId}/fork`, {
      reason: "first child",
      maxTransitions: 1
    });
    expect(firstFork.status).toBe(200);
    await delay(8);
    const secondFork = await requestJson(baseUrl, "POST", `/api/checkpoints/${checkpointId}/fork`, {
      reason: "second child",
      maxTransitions: 1
    });
    expect(secondFork.status).toBe(200);

    const listed = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpointId}/forks`);
    expect(listed.status).toBe(200);
    expect(listed.body.summary).toMatchObject({
      kind: "checkpoint-forks",
      ok: true,
      childCount: 2,
      forks: [
        {
          runId: secondFork.body.id,
          forkOf: {
            checkpointId,
            parentRunId: record.id,
            parentMatchId: record.id,
            parentBoundaryTraceRef: expect.any(String),
            reason: "second child"
          },
          lineage: {
            kind: "fork-lineage",
            boundary: {
              checkpointFound: true,
              checkpointSourceMatchesForkOf: true,
              messagePrefixMatchesCheckpoint: true
            }
          }
        },
        {
          runId: firstFork.body.id,
          forkOf: {
            checkpointId,
            reason: "first child"
          }
        }
      ]
    });
    expect(listed.body.summary.forks.map((fork: any) => fork.runId)).toEqual([secondFork.body.id, firstFork.body.id]);
    expect(listed.body.summary.forks[0].createdAt >= listed.body.summary.forks[1].createdAt).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain("parentTraceId");
    expect(JSON.stringify(listed.body)).not.toContain("\"players\"");
    expect(JSON.stringify(listed.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(listed.body)).not.toContain("\"socialMessages\":[");
  });

  it("returns a redaction-safe multi-generation checkpoint branch tree", async () => {
    const { record } = await createStoredArtifactMatch("server-checkpoint-branch-tree");
    const rootCheckpointResponse = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "root branch checkpoint"
    });
    expect(rootCheckpointResponse.status).toBe(201);
    const rootCheckpointId = rootCheckpointResponse.body.summary.checkpointId as string;

    const childFork = await requestJson(baseUrl, "POST", `/api/checkpoints/${rootCheckpointId}/fork`, {
      reason: "child branch",
      maxTransitions: 1
    });
    expect(childFork.status).toBe(200);
    const childRunId = childFork.body.id as string;

    const childCheckpointResponse = await requestJson(baseUrl, "POST", `/api/matches/${childRunId}/checkpoints`, {
      reason: "child checkpoint"
    });
    expect(childCheckpointResponse.status).toBe(201);
    const childCheckpointId = childCheckpointResponse.body.summary.checkpointId as string;

    const grandchildFork = await requestJson(baseUrl, "POST", `/api/checkpoints/${childCheckpointId}/fork`, {
      reason: "grandchild branch",
      maxTransitions: 1
    });
    expect(grandchildFork.status).toBe(200);
    const grandchildRunId = grandchildFork.body.id as string;

    const tree = await requestJson(baseUrl, "GET", `/api/checkpoints/${rootCheckpointId}/branch-tree`);
    expect(tree.status).toBe(200);
    expect(tree.body.summary).toMatchObject({
      kind: "checkpoint-branch-tree",
      schemaVersion: "server.checkpoint-branch-tree-summary.v2",
      ok: true,
      okScope: "returned",
      rootCheckpointId,
      root: {
        kind: "checkpoint",
        checkpointId: rootCheckpointId,
        source: {
          runId: record.id,
          matchId: record.id,
          boundaryTraceRef: expect.any(String)
        }
      },
      counts: {
        checkpoints: 2,
        matches: 2,
        edges: 3,
        maxDepth: 3
      },
      limits: {
        maxDepth: null,
        maxNodes: null
      },
      truncation: {
        isTruncated: false,
        reasons: [],
        omittedCheckpoints: 0,
        omittedMatches: 0,
        omittedEdges: 0
      }
    });

    const checkpointNodes = new Map(tree.body.summary.checkpoints.map((node: any) => [node.summary.checkpointId, node]));
    expect(checkpointNodes.get(rootCheckpointId)).toMatchObject({
      depth: 0,
      checkpointId: rootCheckpointId,
      createdAt: expect.any(String),
      childForkCount: 1,
      summary: {
        checkpointId: rootCheckpointId
      }
    });
    expect(checkpointNodes.get(childCheckpointId)).toMatchObject({
      depth: 2,
      checkpointId: childCheckpointId,
      createdAt: expect.any(String),
      childForkCount: 1,
      summary: {
        checkpointId: childCheckpointId,
        source: {
          runId: childRunId,
          matchId: childRunId,
          boundaryTraceRef: expect.any(String)
        }
      }
    });

    const matchNodes = new Map(tree.body.summary.matches.map((node: any) => [node.runId, node]));
    expect(matchNodes.get(childRunId)).toMatchObject({
      depth: 1,
      parentCheckpointId: rootCheckpointId,
      runId: childRunId,
      forkOf: {
        checkpointId: rootCheckpointId,
        parentBoundaryTraceRef: expect.any(String)
      },
      lineage: {
        kind: "fork-lineage",
        ok: true,
        boundary: {
          checkpointFound: true,
          checkpointSourceMatchesForkOf: true,
          messagePrefixMatchesCheckpoint: true
        }
      }
    });
    expect(matchNodes.get(grandchildRunId)).toMatchObject({
      depth: 3,
      parentCheckpointId: childCheckpointId,
      runId: grandchildRunId,
      forkOf: {
        checkpointId: childCheckpointId,
        parentBoundaryTraceRef: expect.any(String)
      }
    });

    expect(tree.body.summary.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "checkpoint-fork",
          fromCheckpointId: rootCheckpointId,
          toRunId: childRunId,
          ok: true,
          boundaryStatus: "verified"
        }),
        expect.objectContaining({
          kind: "match-checkpoint",
          fromRunId: childRunId,
          toCheckpointId: childCheckpointId
        }),
        expect.objectContaining({
          kind: "checkpoint-fork",
          fromCheckpointId: childCheckpointId,
          toRunId: grandchildRunId,
          ok: true,
          boundaryStatus: "verified"
        })
      ])
    );
    expect(JSON.stringify(tree.body)).not.toContain("parentTraceId");
    expect(JSON.stringify(tree.body)).not.toContain("\"traceId\"");
    expect(JSON.stringify(tree.body)).not.toContain("\"players\"");
    expect(JSON.stringify(tree.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(tree.body)).not.toContain("\"socialMessages\":[");
    expectBranchTreeEdgesReferenceReturnedNodes(tree.body.summary);

    const rootOnly = await requestJson(baseUrl, "GET", `/api/checkpoints/${rootCheckpointId}/branch-tree?maxDepth=0`);
    expect(rootOnly.status).toBe(200);
    expect(rootOnly.body.summary).toMatchObject({
      counts: {
        checkpoints: 1,
        matches: 0,
        edges: 0,
        maxDepth: 0
      },
      limits: {
        maxDepth: 0,
        maxNodes: null
      },
      truncation: {
        isTruncated: true,
        reasons: ["maxDepth"],
        omittedCheckpoints: 0,
        omittedMatches: 1,
        omittedEdges: 1
      }
    });
    expect(rootOnly.body.summary.checkpoints.map((node: any) => node.checkpointId)).toEqual([rootCheckpointId]);
    expect(rootOnly.body.summary.matches).toEqual([]);
    expect(rootOnly.body.summary.edges).toEqual([]);
    expect(JSON.stringify(rootOnly.body)).not.toContain("parentTraceId");
    expect(JSON.stringify(rootOnly.body)).not.toContain("\"traceId\"");
    expect(JSON.stringify(rootOnly.body)).not.toContain("\"privateMemo\"");
    expectBranchTreeEdgesReferenceReturnedNodes(rootOnly.body.summary);

    const depthLimited = await requestJson(baseUrl, "GET", `/api/checkpoints/${rootCheckpointId}/branch-tree?maxDepth=1`);
    expect(depthLimited.status).toBe(200);
    expect(depthLimited.body.summary).toMatchObject({
      counts: {
        checkpoints: 1,
        matches: 1,
        edges: 1,
        maxDepth: 1
      },
      limits: {
        maxDepth: 1,
        maxNodes: null
      },
      truncation: {
        isTruncated: true,
        reasons: ["maxDepth"],
        omittedCheckpoints: 1,
        omittedMatches: 0,
        omittedEdges: 1
      }
    });
    expect(depthLimited.body.summary.checkpoints.map((node: any) => node.checkpointId)).toEqual([rootCheckpointId]);
    expect(depthLimited.body.summary.matches.map((node: any) => node.runId)).toEqual([childRunId]);
    expect(depthLimited.body.summary.edges).toEqual([
      expect.objectContaining({
        kind: "checkpoint-fork",
        fromCheckpointId: rootCheckpointId,
        toRunId: childRunId
      })
    ]);
    expect(JSON.stringify(depthLimited.body)).not.toContain("parentTraceId");
    expect(JSON.stringify(depthLimited.body)).not.toContain("\"traceId\"");
    expect(JSON.stringify(depthLimited.body)).not.toContain("\"privateMemo\"");
    expectBranchTreeEdgesReferenceReturnedNodes(depthLimited.body.summary);

    const nodeLimited = await requestJson(baseUrl, "GET", `/api/checkpoints/${rootCheckpointId}/branch-tree?maxNodes=1`);
    expect(nodeLimited.status).toBe(200);
    expect(nodeLimited.body.summary).toMatchObject({
      counts: {
        checkpoints: 1,
        matches: 0,
        edges: 0,
        maxDepth: 0
      },
      limits: {
        maxDepth: null,
        maxNodes: 1
      },
      truncation: {
        isTruncated: true,
        reasons: ["maxNodes"],
        omittedCheckpoints: 0,
        omittedMatches: 1,
        omittedEdges: 1
      }
    });
    expect(nodeLimited.body.summary.checkpoints.map((node: any) => node.checkpointId)).toEqual([rootCheckpointId]);
    expect(nodeLimited.body.summary.matches).toEqual([]);
    expect(nodeLimited.body.summary.edges).toEqual([]);
    expectBranchTreeEdgesReferenceReturnedNodes(nodeLimited.body.summary);

    for (const query of ["maxDepth=-1", "maxDepth=101", "maxNodes=0", "maxNodes=1001", "maxNodes=1.5", "maxNodes=1&maxNodes=2"]) {
      const invalidLimit = await requestJson(baseUrl, "GET", `/api/checkpoints/${rootCheckpointId}/branch-tree?${query}`);
      expect(invalidLimit.status).toBe(400);
      expect(invalidLimit.body.error).toMatch(/Checkpoint branch tree .* parameter is (invalid|out of range)/);
      expect(JSON.stringify(invalidLimit.body)).not.toContain("parentTraceId");
      expect(JSON.stringify(invalidLimit.body)).not.toContain(rootCheckpointId);
    }
  }, 20_000);

  it("persists checkpoint files under a configured base dir and rehydrates list detail artifact and fork after restart", async () => {
    const checkpointBaseDir = await makeTempDir();
    baseUrl = await startServer({ checkpointBaseDir });
    const { record, checkpointId, checkpointResponse, checkpoint } = await createPersistedCheckpoint(baseUrl, "server-checkpoint-persisted-rehydrate");

    expectNoCheckpointPathLeak(checkpointResponse, checkpointBaseDir);
    expectNoCheckpointPathLeak(checkpoint, checkpointBaseDir);

    const index = JSON.parse(await readFile(path.join(checkpointBaseDir, CHECKPOINT_INDEX_FILE), "utf8"));
    expect(index).toMatchObject({
      artifactVersion: "harness.checkpoint-artifact-index.v2",
      kind: "checkpoint-artifact-index",
      checkpoints: [
        expect.objectContaining({
          checkpointId,
          sourceRunId: record.id,
          sourceMatchId: record.id,
          relativeFile: checkpointRelativeFile(checkpointId)
        })
      ]
    });
    expectNoCheckpointPathLeak(index, checkpointBaseDir);

    const restartedBaseUrl = await restartServerWithClearedStore(checkpointBaseDir);
    const listed = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints?matchId=${record.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.checkpoints).toEqual([checkpointResponse.summary]);
    expectNoCheckpointPathLeak(listed.body, checkpointBaseDir);

    const detail = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${checkpointId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(checkpointResponse);
    assertPublicCheckpointResponse(detail.body);
    expectNoCheckpointPathLeak(detail.body, checkpointBaseDir);

    const artifact = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${checkpointId}/artifact?view=full`);
    expect(artifact.status).toBe(200);
    expect(artifact.body).toMatchObject({
      artifactVersion: "harness.checkpoint.v2",
      kind: "checkpoint",
      checkpointId,
      source: {
        runId: record.id,
        matchId: record.id,
        stateHash: checkpoint.source.stateHash,
        executionPrefixHash: checkpoint.source.executionPrefixHash,
        agentsHash: checkpoint.source.agentsHash,
        channelsHash: checkpoint.source.channelsHash,
        messagesHash: checkpoint.source.messagesHash
      }
    });
    expect(artifact.body.source).toHaveProperty("boundaryTraceId");
    expectNoCheckpointPathLeak(artifact.body, checkpointBaseDir);

    const forked = await requestJson(restartedBaseUrl, "POST", `/api/checkpoints/${checkpointId}/fork`, {
      reason: "restored checkpoint fork",
      maxTransitions: 1
    });
    expect(forked.status).toBe(200);
    expect(forked.body.summary).toMatchObject({
      kind: "fork",
      checkpointId,
      forkOf: {
        checkpointId,
        parentRunId: record.id,
        parentMatchId: record.id,
        parentBoundaryTraceRef: expect.any(String),
        parentStateHash: checkpoint.source.stateHash,
        parentNativeStepCount: checkpoint.source.nativeStepCount,
        reason: "restored checkpoint fork"
      }
    });
    expect(forked.body.summary.forkOf).not.toHaveProperty("parentBoundaryTraceId");
    expectNoCheckpointPathLeak(forked.body, checkpointBaseDir);

    const forkArtifact = await requestJson(restartedBaseUrl, "GET", `/api/matches/${forked.body.id}/artifact?view=full`);
    expect(forkArtifact.status).toBe(200);
    expect(forkArtifact.body.forkOf).toMatchObject({
      checkpointId,
      parentRunId: record.id,
      parentMatchId: record.id,
      parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
      parentStateHash: checkpoint.source.stateHash,
      parentExecutionPrefixHash: checkpoint.source.executionPrefixHash,
      parentAgentsHash: checkpoint.source.agentsHash,
      parentChannelsHash: checkpoint.source.channelsHash,
      parentMessagesHash: checkpoint.source.messagesHash,
      parentNativeStepCount: checkpoint.source.nativeStepCount,
      reason: "restored checkpoint fork"
    });
    expect(forkArtifact.body.socialEpisode.messages.slice(0, checkpoint.executionPrefix.messages.length)).toEqual(checkpoint.executionPrefix.messages);
    if (forkArtifact.body.trajectory.length > 0) {
      expect(forkArtifact.body.trajectory[0].preStateHash).toBe(checkpoint.source.stateHash);
      if (forkArtifact.body.trajectory[0].messageSeqRange) {
        expect(forkArtifact.body.trajectory[0].messageSeqRange[0]).toBe((checkpoint.source.lastMessageSeq ?? 0) + 1);
      }
    }
    expectNoCheckpointPathLeak(forkArtifact.body, checkpointBaseDir);
  });

  it("ignores malformed checkpoint files during directory rehydrate", async () => {
    const checkpointBaseDir = await makeTempDir();
    baseUrl = await startServer({ checkpointBaseDir });
    const { checkpointId } = await createPersistedCheckpoint(baseUrl, "server-checkpoint-malformed-files");
    const badJsonId = "00000000-0000-4000-8000-000000000101";
    const badShapeId = "00000000-0000-4000-8000-000000000102";
    const badHashId = "00000000-0000-4000-8000-000000000103";
    const validArtifact = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpointId}/artifact?view=full`);
    expect(validArtifact.status).toBe(200);

    await rm(path.join(checkpointBaseDir, CHECKPOINT_INDEX_FILE), { force: true });
    await mkdir(path.join(checkpointBaseDir, CHECKPOINT_DIR), { recursive: true });
    await writeFile(path.join(checkpointBaseDir, CHECKPOINT_DIR, `${badJsonId}.json`), "{ not json", "utf8");
    await writeFile(
      path.join(checkpointBaseDir, CHECKPOINT_DIR, `${badShapeId}.json`),
      `${JSON.stringify({ artifactVersion: "harness.match.v1", kind: "match", checkpointId: badShapeId })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(checkpointBaseDir, CHECKPOINT_DIR, `${badHashId}.json`),
      `${JSON.stringify({
        ...validArtifact.body,
        checkpointId: badHashId,
        source: {
          ...validArtifact.body.source,
          stateHash: "tampered-state-hash"
        }
      })}\n`,
      "utf8"
    );

    const restartedBaseUrl = await restartServerWithClearedStore(checkpointBaseDir);
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/checkpoints");
    expect(listed.status).toBe(200);
    expect(listed.body.checkpoints.map((checkpoint: any) => checkpoint.checkpointId)).toEqual([checkpointId]);
    expect(JSON.stringify(listed.body)).not.toContain(badJsonId);
    expect(JSON.stringify(listed.body)).not.toContain(badShapeId);
    expect(JSON.stringify(listed.body)).not.toContain(badHashId);
    expectNoCheckpointPathLeak(listed.body, checkpointBaseDir);

    const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const auditRecords = assertArtifactRecoveryAuditResponse(audits.body);
    const rejectedCheckpointFiles = auditRecords.filter((record: any) => record.store === "checkpoint" && record.source === "directory");
    expect(Object.fromEntries(rejectedCheckpointFiles.map((record: any) => [record.artifactId, record.code]))).toEqual({
      [badJsonId]: "file_invalid_json",
      [badShapeId]: "file_invalid_shape",
      [badHashId]: "file_provenance_invalid"
    });
    expectNoCheckpointPathLeak(audits.body, checkpointBaseDir);

    const sidecarText = await readFile(path.join(checkpointBaseDir, RECOVERY_AUDIT_FILE), "utf8");
    const sidecarFileRecords = parseJsonl(sidecarText).filter((record: any) => record.store === "checkpoint" && record.source === "directory");
    expect(Object.fromEntries(sidecarFileRecords.map((record: any) => [record.artifactId, record.code]))).toEqual({
      [badJsonId]: "file_invalid_json",
      [badShapeId]: "file_invalid_shape",
      [badHashId]: "file_provenance_invalid"
    });
    expectNoCheckpointPathLeak(sidecarText, checkpointBaseDir);

    const repeatedAudits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(repeatedAudits.status).toBe(200);
    const repeatedAuditRecords = assertArtifactRecoveryAuditResponse(repeatedAudits.body);
    expect(repeatedAuditRecords.map((record: any) => record.id).sort()).toEqual(auditRecords.map((record: any) => record.id).sort());
    expectNoCheckpointPathLeak(repeatedAudits.body, checkpointBaseDir);

    for (const badId of [badJsonId, badShapeId, badHashId]) {
      const detail = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${badId}`);
      expect(detail.status).toBe(404);
      expectNoCheckpointPathLeak(detail.body, checkpointBaseDir);
      const fork = await requestJson(restartedBaseUrl, "POST", `/api/checkpoints/${badId}/fork`, { maxTransitions: 1 });
      expect(fork.status).toBe(404);
      expectNoCheckpointPathLeak(fork.body, checkpointBaseDir);
    }
  });

  it("ignores stale and malicious checkpoint index records during rehydrate", async () => {
    const checkpointBaseDir = await makeTempDir();
    baseUrl = await startServer({ checkpointBaseDir });
    const { checkpointId, checkpointResponse } = await createPersistedCheckpoint(baseUrl, "server-checkpoint-malicious-index");
    const staleId = "00000000-0000-4000-8000-000000000111";
    const traversalId = "00000000-0000-4000-8000-000000000112";
    const absoluteLikeId = "00000000-0000-4000-8000-000000000113";

    await writeCheckpointIndex(checkpointBaseDir, [
      {
        checkpointId,
        createdAt: checkpointResponse.summary.createdAt,
        sourceRunId: checkpointResponse.summary.source.runId,
        sourceMatchId: checkpointResponse.summary.source.matchId,
        seed: checkpointResponse.summary.source.seed,
        stateHash: checkpointResponse.summary.source.stateHash,
        executionPrefixHash: checkpointResponse.summary.source.executionPrefixHash,
        agentsHash: checkpointResponse.summary.source.agentsHash,
        channelsHash: checkpointResponse.summary.source.channelsHash,
        messagesHash: checkpointResponse.summary.source.messagesHash,
        relativeFile: checkpointRelativeFile(checkpointId)
      },
      {
        checkpointId: staleId,
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceRunId: "stale",
        sourceMatchId: "stale",
        seed: "stale",
        relativeFile: checkpointRelativeFile(staleId)
      },
      {
        checkpointId: traversalId,
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceRunId: "malicious",
        sourceMatchId: "malicious",
        seed: "malicious",
        relativeFile: "../outside.json"
      },
      {
        checkpointId: absoluteLikeId,
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceRunId: "malicious-absolute",
        sourceMatchId: "malicious-absolute",
        seed: "malicious-absolute",
        relativeFile: "/tmp/escape.json"
      }
    ]);

    const restartedBaseUrl = await restartServerWithClearedStore(checkpointBaseDir);
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/checkpoints");
    expect(listed.status).toBe(200);
    expect(listed.body.checkpoints.map((checkpoint: any) => checkpoint.checkpointId)).toEqual([checkpointId]);
    expect(JSON.stringify(listed.body)).not.toContain(staleId);
    expect(JSON.stringify(listed.body)).not.toContain(traversalId);
    expect(JSON.stringify(listed.body)).not.toContain(absoluteLikeId);
    expectNoCheckpointPathLeak(listed.body, checkpointBaseDir);

    const repairedIndex = JSON.parse(await readFile(path.join(checkpointBaseDir, CHECKPOINT_INDEX_FILE), "utf8"));
    expect(repairedIndex.checkpoints.map((checkpoint: any) => checkpoint.checkpointId)).toEqual([checkpointId]);
    expectNoCheckpointPathLeak(repairedIndex, checkpointBaseDir);

    const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const rejectedIndexRecords = assertArtifactRecoveryAuditResponse(audits.body).filter(
      (record: any) => record.store === "checkpoint" && record.source === "index" && record.code === "index_record_rejected"
    );
    expect(rejectedIndexRecords.map((record: any) => record.artifactId).sort()).toEqual([absoluteLikeId, staleId, traversalId].sort());
    expect(rejectedIndexRecords.some((record: any) => record.relativeFile === "<rejected>")).toBe(true);
    expectNoCheckpointPathLeak(audits.body, checkpointBaseDir);

    for (const rejectedId of [staleId, traversalId, absoluteLikeId]) {
      const detail = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${rejectedId}`);
      expect(detail.status).toBe(404);
      expectNoCheckpointPathLeak(detail.body, checkpointBaseDir);
      const artifact = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${rejectedId}/artifact`);
      expect(artifact.status).toBe(404);
      expectNoCheckpointPathLeak(artifact.body, checkpointBaseDir);
    }
  });

  it("repairs invalid checkpoint index JSON and shape with recovery audit records", async () => {
    for (const scenario of [
      { code: "index_invalid_json", indexContent: "{ not json" },
      {
        code: "index_invalid_shape",
        indexContent: `${JSON.stringify({
          artifactVersion: "harness.checkpoint-artifact-index.v2",
          kind: "checkpoint-artifact-index",
          updatedAt: "2026-07-05T00:00:00.000Z",
          checkpoints: "not-an-array"
        })}\n`
      }
    ]) {
      const checkpointBaseDir = await makeTempDir();
      clearServerStoreForTests();
      baseUrl = await startServer({ checkpointBaseDir });
      const { checkpointId } = await createPersistedCheckpoint(baseUrl, `server-checkpoint-${scenario.code}`);

      await writeFile(path.join(checkpointBaseDir, CHECKPOINT_INDEX_FILE), scenario.indexContent, "utf8");

      const restartedBaseUrl = await restartServerWithClearedStore(checkpointBaseDir);
      const listed = await requestJson(restartedBaseUrl, "GET", "/api/checkpoints");
      expect(listed.status).toBe(200);
      expect(listed.body.checkpoints.map((checkpoint: any) => checkpoint.checkpointId)).toEqual([checkpointId]);
      expectNoCheckpointPathLeak(listed.body, checkpointBaseDir);

      const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
      expect(audits.status).toBe(200);
      const indexAudits = assertArtifactRecoveryAuditResponse(audits.body).filter(
        (record: any) => record.store === "checkpoint" && record.source === "index" && record.code === scenario.code
      );
      expect(indexAudits).toHaveLength(1);
      expect(indexAudits[0]).toMatchObject({
        artifactId: null,
        relativeFile: CHECKPOINT_INDEX_FILE
      });
      expectNoCheckpointPathLeak(audits.body, checkpointBaseDir);

      const sidecarText = await readFile(path.join(checkpointBaseDir, RECOVERY_AUDIT_FILE), "utf8");
      const sidecarRecords = parseJsonl(sidecarText);
      expect(
        sidecarRecords.some(
          (record: any) =>
            record.artifactVersion === "server.artifact-recovery-audit.v1" && record.store === "checkpoint" && record.code === scenario.code
        )
      ).toBe(true);
      expectNoCheckpointPathLeak(sidecarText, checkpointBaseDir);

      const recoveredAuditBaseUrl = await restartServerWithClearedStore(checkpointBaseDir);
      const persistedAudits = await requestJson(recoveredAuditBaseUrl, "GET", "/api/artifact-recovery-audits");
      expect(persistedAudits.status).toBe(200);
      const persistedIndexAudits = assertArtifactRecoveryAuditResponse(persistedAudits.body).filter(
        (record: any) => record.store === "checkpoint" && record.source === "index" && record.code === scenario.code
      );
      expect(persistedIndexAudits).toHaveLength(1);
      expect(persistedIndexAudits[0]).toMatchObject({
        artifactId: null,
        relativeFile: CHECKPOINT_INDEX_FILE
      });
      expectNoCheckpointPathLeak(persistedAudits.body, checkpointBaseDir);
    }
  });

  it("does not restore or fork checkpoint files that resolve through symlinks outside the checkpoint base dir", async () => {
    const checkpointBaseDir = await makeTempDir();
    baseUrl = await startServer({ checkpointBaseDir });
    const { checkpointId } = await createPersistedCheckpoint(baseUrl, "server-checkpoint-symlink");
    const persistedFile = path.join(checkpointBaseDir, CHECKPOINT_DIR, `${checkpointId}.json`);
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "outside-checkpoint.json");
    const originalCheckpoint = JSON.parse(await readFile(persistedFile, "utf8"));
    const sentinel = "outside-server-checkpoint-should-not-download";
    await writeFile(outsideFile, `${JSON.stringify({ ...originalCheckpoint, sentinel }, null, 2)}\n`, "utf8");
    await rm(persistedFile, { force: true });
    await symlink(outsideFile, persistedFile);

    const restartedBaseUrl = await restartServerWithClearedStore(checkpointBaseDir);
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/checkpoints");
    expect(listed.status).toBe(200);
    expect(listed.body.checkpoints).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(sentinel);
    expectNoCheckpointPathLeak(listed.body, checkpointBaseDir);

    const artifact = await requestText(restartedBaseUrl, "GET", `/api/checkpoints/${checkpointId}/artifact`);
    expect(artifact.status).toBe(404);
    expect(artifact.text).not.toContain(sentinel);
    expect(artifact.text).not.toContain(outsideDir);
    expectNoCheckpointPathLeak(artifact.text, checkpointBaseDir);

    const fork = await requestText(restartedBaseUrl, "POST", `/api/checkpoints/${checkpointId}/fork`, { maxTransitions: 1 });
    expect(fork.status).toBe(404);
    expect(fork.text).not.toContain(sentinel);
    expect(fork.text).not.toContain(outsideDir);
    expectNoCheckpointPathLeak(fork.text, checkpointBaseDir);
  });

  it("replays a stored match through the server-owned artifact endpoint", async () => {
    const { record, artifact } = await createStoredArtifactMatch("server-owned-replay");

    const replayed = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay`, {});

    expect(replayed.status).toBe(200);
    expect(replayed.body.summary).toMatchObject({
      kind: "replay",
      authority: "native-social-episode",
      ok: true,
      source: "server-owned-match-artifact",
      matchId: record.id,
      runId: artifact.runId,
      nativeSteps: countSocialStepCommits(artifact.socialEpisode.steps).nativeSteps,
      committedSteps: countSocialStepCommits(artifact.socialEpisode.steps).committedSteps,
      rejectedSteps: countSocialStepCommits(artifact.socialEpisode.steps).rejectedSteps,
      finalHashMatchesArtifact: true,
      mismatchCount: 0
    });
    expect(replayed.body.replay.ok).toBe(true);
    expect(replayed.body.replay.replayedSteps).toBe(
      countSocialStepCommits(artifact.socialEpisode.steps).committedSteps
    );
    expect(replayed.body.summary.finalHash).toBe(replayed.body.replay.finalHash);
    expect(replayed.body.summary.finalHash).toBe(replayed.body.summary.expectedFinalHash);
    expect(replayed.body.replay).not.toHaveProperty("finalState");
    expect(JSON.stringify(replayed.body)).not.toContain("privateMemos");

  });

  it("derives a postgame-redacted replay frame from only a stored native prefix", async () => {
    const { record, artifact } = await createStoredArtifactMatch("server-owned-replay-frame", { recordAgentSnapshots: false });
    const selected = artifact.socialEpisode.steps[0];
    if (!selected) throw new Error("Expected a native replay step.");

    const frame = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay/frame`, {
      nativeStepCount: 1
    });

    expect(frame.status).toBe(200);
    expect(frame.headers.get("cache-control")).toContain("no-store");
    expect(frame.headers.get("x-content-type-options")).toBe("nosniff");
    expect(frame.body.frame).toMatchObject({
      artifactVersion: "server.match-replay-frame.v1",
      kind: "match-replay-frame",
      authority: "native-social-episode",
      source: "server-owned-match-artifact",
      cursor: {
        nativeStepCount: 1,
        messageCount: expect.any(Number),
        eventCount: expect.any(Number),
        stateHash: selected.postStateHash,
        recordedPostStateHash: selected.postStateHash
      },
      projection: {
        view: "postgame-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: false
      },
      replay: {
        ok: true,
        replayedSteps: 1,
        replayedBatches: 1,
        rejectedSteps: 0
      }
    });
    expect(artifact.socialEpisode.steps.length).toBeGreaterThan(1);
    expect(frame.body.frame.state).not.toEqual(artifact.finalState);
    expect(frame.body.frame).not.toHaveProperty("agents");
    expect(frame.body.frame).not.toHaveProperty("agentSnapshotFrames");
    expect(frame.body.frame).not.toHaveProperty("trajectory");
    expect(frame.body.frame).not.toHaveProperty("socialEpisode");
    expect(JSON.stringify(frame.body.frame)).not.toContain("privateMemos");
    expect(JSON.stringify(frame.body.frame)).not.toContain("providerRequestId");
    expect(JSON.stringify(frame.body.frame)).not.toContain("pendingAction");
    expect(JSON.stringify(frame.body.frame)).not.toContain("command");

    const clientAuthority = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay/frame`, {
      nativeStepCount: 1,
      artifact: artifact
    });
    expect(clientAuthority.status).toBe(400);
    expect(clientAuthority.body.error).toContain("unsupported field");

    const outOfRange = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay/frame`, {
      nativeStepCount: artifact.socialEpisode.steps.length + 1
    });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.code).toBe("replay_frame_selector_not_found");
  });

  it("rejects unavailable matches and client-submitted replay authority", async () => {
    const missing = await requestJson(baseUrl, "POST", "/api/matches/missing/replay", {});
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("match not found");

    const draft = createMatchRecord({ seed: "server-owned-replay-no-artifact", models: ["alpha"] });
    const withoutArtifact = await requestJson(baseUrl, "POST", `/api/matches/${draft.id}/replay`, {});
    expect(withoutArtifact.status).toBe(404);
    expect(withoutArtifact.body.error).toBe("match artifact not available");

    const { record } = await createStoredArtifactMatch("server-owned-replay-client-authority");
    const rejected = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay`, {
      artifact: { initialState: null, socialEpisode: { steps: [] } },
      initialState: null,
      trajectory: []
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("unsupported field");
    expect(JSON.stringify(rejected.body)).not.toContain("privateMemos");
  });
});

async function createStoredArtifactMatch(seed: string, options: { recordAgentSnapshots?: boolean } = {}) {
  const record = createMatchRecord({ seed, models: ["alpha", "beta"] });
  const profiles = profilesFromModels(["alpha", "beta"], 0.3);
  const agents = resolveAgentConfigs(record.state.players, profiles, 0, 0.3);
  const result = await runHarnessMatch({
    initialState: record.state,
    agents,
    reasoner: fakeReasoner,
    maxTransitions: 4,
    recordAgentSnapshots: options.recordAgentSnapshots
  });
  const artifact = buildMatchArtifact({
    runId: record.id,
    matchId: record.id,
    createdAt: record.createdAt,
    seed: record.state.seed,
    models: ["alpha", "beta"],
    profiles,
    resolvedAssignments: describeResolvedAssignments(record.state.players, agents),
    result
  });
  record.status = result.status === "failed" ? "failed" : "completed";
  record.error = result.status === "failed" ? result.failureReason : undefined;
  record.state = result.state;
  record.metrics = result.metrics;
  record.artifact = artifact;
  record.initialState = result.initialState;
  record.trajectory = result.trajectory;
  record.socialEpisode = result.socialEpisode;
  record.evaluation = result.evaluation;
  record.evaluationReport = result.evaluationReport;
  record.profiles = profiles;
  record.resolvedAssignments = describeResolvedAssignments(record.state.players, agents);
  saveMatch(record);
  return { record, result, artifact };
}

async function createPersistedCheckpoint(baseUrl: string, seed: string) {
  const { record, artifact } = await createStoredArtifactMatch(seed);
  const checkpointResponse = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
    reason: `${seed} checkpoint`
  });
  expect(checkpointResponse.status).toBe(201);
  const checkpointId = checkpointResponse.body.summary.checkpointId as string;
  const checkpointArtifact = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpointId}/artifact?view=full`);
  expect(checkpointArtifact.status).toBe(200);
  return {
    record,
    artifact,
    checkpointId,
    checkpointResponse: checkpointResponse.body,
    checkpoint: checkpointArtifact.body
  };
}

async function writeCheckpointIndex(checkpointBaseDir: string, checkpoints: unknown[]): Promise<void> {
  await writeFile(
    path.join(checkpointBaseDir, CHECKPOINT_INDEX_FILE),
    `${JSON.stringify(
      {
        artifactVersion: "harness.checkpoint-artifact-index.v2",
        kind: "checkpoint-artifact-index",
        updatedAt: "2026-07-05T00:00:00.000Z",
        checkpoints
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function checkpointRelativeFile(checkpointId: string): string {
  return `${CHECKPOINT_DIR}/${checkpointId}.json`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function expectNoCheckpointPathLeak(value: unknown, checkpointBaseDir: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(checkpointBaseDir);
  expect(text).not.toContain("outputDir");
  expect(text).not.toContain("baseDir");
  expect(text).not.toContain("artifactPath");
  expect(text).not.toContain("checkpointPath");
  expect(text).not.toContain("checkpoint artifact file");
}

function assertArtifactRecoveryAuditResponse(body: any): any[] {
  expect(body).toMatchObject({ records: expect.any(Array) });
  const allowedKeys = ["artifactId", "code", "createdAt", "id", "message", "relativeFile", "source", "store"].sort();
  for (const record of body.records) {
    expect(Object.keys(record).sort()).toEqual(allowedKeys);
    expect(typeof record.id).toBe("string");
    expect(record.id).toMatch(/^artifact-recovery:[0-9a-f]{24}$/);
    expect(typeof record.createdAt).toBe("string");
    expect(["match", "checkpoint", "tournament"]).toContain(record.store);
    expect(["index", "directory", "manifest", "sidecar"]).toContain(record.source);
    expect(typeof record.code).toBe("string");
    expect(record.artifactId === null || typeof record.artifactId === "string").toBe(true);
    expect(record.relativeFile === null || typeof record.relativeFile === "string").toBe(true);
    expect(typeof record.message).toBe("string");
  }
  return body.records;
}

function parseJsonl(text: string): any[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertPublicCheckpointResponse(body: any): void {
  expect(body).toMatchObject({
    summary: {
      kind: "checkpoint",
      ok: true,
      checkpointId: expect.any(String),
      source: expect.any(Object),
      counts: expect.any(Object)
    },
    artifactUrl: expect.stringMatching(/^\/api\/checkpoints\/.+\/artifact$/)
  });
  expect(body).not.toHaveProperty("checkpoint");
  expect(body).not.toHaveProperty("state");
  expect(body).not.toHaveProperty("agents");
  expect(body).not.toHaveProperty("trajectory");
  expect(body).not.toHaveProperty("socialMessages");
  const json = JSON.stringify(body);
  expect(json).not.toContain("privateMemos");
  expect(json).not.toContain("seerInspection");
  expect(json).not.toContain("wolfVotes");
  expect(json).not.toContain("resultTeam");
  expect(json).not.toContain("\"state\":");
}

function firstSafeNativePrefixLength(artifact: MatchArtifact): number {
  for (const [index, step] of artifact.socialEpisode.steps.entries()) {
    const nextStep = artifact.socialEpisode.steps[index + 1];
    if (!step.actorSnapshotFrameIdAfterStep || !step.actorSnapshotsHashAfterStep) continue;
    if (step.batchId && nextStep?.batchId === step.batchId && (step.schedulerMode !== "aec" || step.atomic)) continue;
    return index + 1;
  }
  throw new Error("Expected a safe prefix checkpoint boundary in server fixture.");
}

function expectBranchTreeEdgesReferenceReturnedNodes(summary: any): void {
  const checkpointIds = new Set((summary.checkpoints ?? []).map((node: any) => node.checkpointId));
  const runIds = new Set((summary.matches ?? []).map((node: any) => node.runId));
  expect(summary.counts.edges).toBe((summary.edges ?? []).length);
  for (const edge of summary.edges ?? []) {
    if (edge.kind === "checkpoint-fork") {
      expect(checkpointIds.has(edge.fromCheckpointId)).toBe(true);
      expect(runIds.has(edge.toRunId)).toBe(true);
    } else if (edge.kind === "match-checkpoint") {
      expect(runIds.has(edge.fromRunId)).toBe(true);
      expect(checkpointIds.has(edge.toCheckpointId)).toBe(true);
    }
  }
}

async function startServer(options: { checkpointBaseDir?: string } = {}): Promise<string> {
  if (server) {
    await close(server);
    server = undefined;
  }
  const app = createServerApp({
    createReasoner: () => fakeReasoner,
    checkpointArtifactBaseDir: options.checkpointBaseDir
  });
  server = await listen(app);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function restartServerWithClearedStore(checkpointBaseDir: string): Promise<string> {
  clearServerStoreForTests();
  return startServer({ checkpointBaseDir });
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "werewolf-server-checkpoints-"));
  tempDirs.push(dir);
  return dir;
}

async function listen(app: ReturnType<typeof createServerApp>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers
  };
}

async function requestText(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: response.status,
    text: await response.text()
  };
}
