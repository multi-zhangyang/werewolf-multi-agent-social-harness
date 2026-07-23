import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests } from "../src/server/store";
import { validateMatchArtifactIntegrity } from "../src/harness/artifacts";
import type { HarnessReasoner } from "../src/harness/types";
import { countSocialStepCommits } from "../src/harness/social";

const fakeReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `match persistence speech ${input.traceId}`
        : `match persistence memo ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `server-match-artifact-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

const MATCH_INDEX_FILE = "matches.index.json";
const MATCH_DIR = "matches";
const CHECKPOINT_INDEX_FILE = "checkpoints.index.json";
const RECOVERY_AUDIT_FILE = "artifact_recovery_audits.jsonl";
const tempDirs: string[] = [];
let server: Server | undefined;

describe("server-owned match artifact persistence", () => {
  beforeEach(() => {
    clearServerStoreForTests();
  });

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    clearServerStoreForTests();
  });

  it("persists match artifacts and rehydrates list detail artifact trajectory and replay after restart", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matchArtifactBaseDir });
    const { matchId, artifact } = await createPersistedMatch(baseUrl, "server-match-persisted-rehydrate");

    const index = JSON.parse(await readFile(path.join(matchArtifactBaseDir, MATCH_INDEX_FILE), "utf8"));
    expect(index).toMatchObject({
      artifactVersion: "harness.match-artifact-index.v1",
      kind: "match-artifact-index",
      matches: [
        expect.objectContaining({
          matchId,
          runId: matchId,
          seed: "server-match-persisted-rehydrate",
          status: artifact.status,
          relativeFile: matchRelativeFile(matchId),
          nativeSteps: countSocialStepCommits(artifact.socialEpisode.steps).nativeSteps,
          trajectorySteps: artifact.trajectory.length,
          socialMessages: artifact.socialEpisode.messages.length
        })
      ]
    });
    expectNoMatchPathLeak(index, matchArtifactBaseDir);

    const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir });

    const listed = await requestJson(restartedBaseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body.map((match: any) => match.id)).toEqual([matchId]);
    expect(listed.body[0]).toMatchObject({
      id: matchId,
      status: artifact.status,
      harnessStatus: artifact.status,
      truncationReason: artifact.truncationReason ?? null,
      hasArtifact: true,
      checkpointCount: 0,
      nativeSteps: countSocialStepCommits(artifact.socialEpisode.steps).nativeSteps,
      trajectorySteps: artifact.trajectory.length
    });
    assertPublicMatchResponse(listed.body[0]);
    expectNoMatchPathLeak(listed.body, matchArtifactBaseDir);

    const detail = await requestJson(restartedBaseUrl, "GET", `/api/matches/${matchId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(listed.body[0]);
    expect(detail.body).toMatchObject({
      harnessStatus: artifact.status,
      truncationReason: artifact.truncationReason ?? null
    });
    assertPublicMatchResponse(detail.body);
    expectNoMatchPathLeak(detail.body, matchArtifactBaseDir);

    const restoredArtifact = await requestJson(restartedBaseUrl, "GET", `/api/matches/${matchId}/artifact?view=full`);
    expect(restoredArtifact.status).toBe(200);
    expect(restoredArtifact.body).toMatchObject({
      artifactVersion: "harness.match.v2",
      kind: "match",
      runId: matchId,
      matchId,
      seed: "server-match-persisted-rehydrate",
      status: artifact.status
    });
    expect(validateMatchArtifactIntegrity(restoredArtifact.body)).toEqual([]);
    expect(restoredArtifact.body.trajectory).toHaveLength(artifact.trajectory.length);
    expect(restoredArtifact.body.socialEpisode.messages).toHaveLength(artifact.socialEpisode.messages.length);
    expect(restoredArtifact.body.agentSnapshotFrames?.length).toBeGreaterThan(0);
    const restoredFrameIds = new Set(restoredArtifact.body.agentSnapshotFrames.map((frame: any) => frame.frameId));
    expect(
      restoredArtifact.body.trajectory.every(
        (step: any) =>
          !("agentSnapshotsAfterStep" in step) &&
          typeof step.agentSnapshotsHashAfterStep === "string" &&
          restoredFrameIds.has(step.agentSnapshotFrameIdAfterStep)
      )
    ).toBe(true);
    expect(
      restoredArtifact.body.socialEpisode.steps.every(
        (step: any) =>
          !("actorSnapshotsAfterStep" in step) &&
          (step.actorSnapshotsHashAfterStep === undefined
            ? step.actorSnapshotFrameIdAfterStep === undefined
            : typeof step.actorSnapshotsHashAfterStep === "string" && restoredFrameIds.has(step.actorSnapshotFrameIdAfterStep))
      )
    ).toBe(true);
    expectNoMatchPathLeak(restoredArtifact.body, matchArtifactBaseDir);

    const trajectory = await requestText(restartedBaseUrl, "GET", `/api/matches/${matchId}/trajectory.jsonl`);
    expect(trajectory.status).toBe(200);
    expect(trajectory.contentType).toMatch(/application\/x-ndjson/);
    const records = parseJsonl(trajectory.text);
    expect(records[0]).toMatchObject({
      type: "header",
      artifactVersion: "harness.match.v2",
      kind: "match",
      runId: matchId,
      matchId,
      rulesetId: "werewolf.classic-9-seat.v1"
    });
    expect(records.some((record) => record.type === "match_metrics")).toBe(true);
    expect(records.some((record) => record.type === "evaluation_report")).toBe(true);
    const frameRecords = records.filter((record) => record.type === "agent_snapshot_frame");
    expect(frameRecords).toHaveLength(restoredArtifact.body.agentSnapshotFrames.length);
    expect(frameRecords[0]).toMatchObject({
      runId: matchId,
      matchId,
      frameId: expect.stringMatching(/^agent-snapshot:/),
      agentsHash: expect.any(String),
      agentCount: restoredArtifact.body.finalState.players.length
    });
    expect(frameRecords.every((record) => !("agents" in record) && !("privateMemos" in record) && !("social" in record))).toBe(true);
    expect(trajectory.text).not.toContain("agentSnapshotsAfterStep");
    expect(trajectory.text).not.toContain("actorSnapshotsAfterStep");
    expect(JSON.stringify(frameRecords)).not.toMatch(/privateMemos|journal|beliefs|social/i);
    expectNoMatchPathLeak(trajectory.text, matchArtifactBaseDir);

    const replayed = await requestJson(restartedBaseUrl, "POST", `/api/matches/${matchId}/replay`, {});
    expect(replayed.status).toBe(200);
    expect(replayed.body.summary).toMatchObject({
      kind: "replay",
      authority: "native-social-episode",
      ok: true,
      source: "server-owned-match-artifact",
      matchId,
      runId: matchId,
      nativeSteps: countSocialStepCommits(artifact.socialEpisode.steps).nativeSteps,
      committedSteps: countSocialStepCommits(artifact.socialEpisode.steps).committedSteps,
      rejectedSteps: countSocialStepCommits(artifact.socialEpisode.steps).rejectedSteps,
      finalHashMatchesArtifact: true,
      mismatchCount: 0
    });
    expect(replayed.body.replay).not.toHaveProperty("finalState");
    expect(JSON.stringify(replayed.body)).not.toContain("privateMemos");
    expectNoMatchPathLeak(replayed.body, matchArtifactBaseDir);
  }, 20_000);

  it("persists fork child match artifacts and restores fork provenance after restart", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const checkpointArtifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matchArtifactBaseDir, checkpointArtifactBaseDir });
    const { matchId: parentMatchId, artifact: parentArtifact } = await createPersistedMatch(baseUrl, "server-match-fork-persistence");

    const checkpointResponse = await requestJson(baseUrl, "POST", `/api/matches/${parentMatchId}/checkpoints`, {
      reason: "fork persistence source"
    });
    expect(checkpointResponse.status).toBe(201);
    const checkpointId = checkpointResponse.body.summary.checkpointId as string;

    const checkpointArtifact = await requestJson(baseUrl, "GET", `/api/checkpoints/${checkpointId}/artifact?view=full`);
    expect(checkpointArtifact.status).toBe(200);

    const forked = await requestJson(baseUrl, "POST", `/api/checkpoints/${checkpointId}/fork`, {
      reason: "persisted fork child",
      maxTransitions: 1
    });
    expect(forked.status).toBe(200);
    const forkMatchId = forked.body.id as string;
    expect(forked.body.summary).toMatchObject({
      kind: "fork",
      checkpointId,
      forkOf: {
        checkpointId,
        parentRunId: parentMatchId,
        parentMatchId,
        parentBoundaryTraceRef: expect.any(String),
        parentStateHash: checkpointArtifact.body.source.stateHash,
        parentNativeStepCount: checkpointArtifact.body.source.nativeStepCount,
        reason: "persisted fork child"
      }
    });
    expect(forked.body.summary.forkOf).not.toHaveProperty("parentBoundaryTraceId");
    expectNoMatchPathLeak(forked.body, matchArtifactBaseDir);

    const childCheckpointResponse = await requestJson(baseUrl, "POST", `/api/matches/${forkMatchId}/checkpoints`, {
      reason: "persisted child checkpoint"
    });
    expect(childCheckpointResponse.status).toBe(201);
    const childCheckpointId = childCheckpointResponse.body.summary.checkpointId as string;

    const grandchildFork = await requestJson(baseUrl, "POST", `/api/checkpoints/${childCheckpointId}/fork`, {
      reason: "persisted grandchild fork",
      maxTransitions: 1
    });
    expect(grandchildFork.status).toBe(200);
    const grandchildMatchId = grandchildFork.body.id as string;

    const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir, checkpointArtifactBaseDir });

    const parentDetail = await requestJson(restartedBaseUrl, "GET", `/api/matches/${parentMatchId}`);
    expect(parentDetail.status).toBe(200);
    expect(parentDetail.body).toMatchObject({
      id: parentMatchId,
      hasArtifact: true,
      checkpointCount: 1,
      nativeSteps: countSocialStepCommits(parentArtifact.socialEpisode.steps).nativeSteps,
      trajectorySteps: parentArtifact.trajectory.length
    });
    assertPublicMatchResponse(parentDetail.body);
    expectNoMatchPathLeak(parentDetail.body, matchArtifactBaseDir);
    expectNoCheckpointPathLeak(parentDetail.body, checkpointArtifactBaseDir);

    const childDetail = await requestJson(restartedBaseUrl, "GET", `/api/matches/${forkMatchId}`);
    expect(childDetail.status).toBe(200);
    expect(childDetail.body).toMatchObject({
      id: forkMatchId,
      hasArtifact: true,
      checkpointCount: 1
    });
    assertPublicMatchResponse(childDetail.body);
    expectNoMatchPathLeak(childDetail.body, matchArtifactBaseDir);

    const checkpointForks = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${checkpointId}/forks`);
    expect(checkpointForks.status).toBe(200);
    expect(checkpointForks.body.summary).toMatchObject({
      kind: "checkpoint-forks",
      schemaVersion: "server.checkpoint-forks-summary.v3",
      ok: true,
      childCount: 1,
      checkpoint: {
        kind: "checkpoint",
        checkpointId,
        source: {
          runId: parentMatchId,
          matchId: parentMatchId,
          boundaryTraceRef: expect.any(String),
          stateHash: checkpointArtifact.body.source.stateHash
        }
      },
      forks: [
        {
          runId: forkMatchId,
          matchId: forkMatchId,
          forkOf: {
            checkpointId,
            parentRunId: parentMatchId,
            parentMatchId,
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
    expect(checkpointForks.body.summary.checkpoint.source).not.toHaveProperty("boundaryTraceId");
    expect(checkpointForks.body.summary.forks[0].forkOf).not.toHaveProperty("parentBoundaryTraceId");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("parentBoundaryTraceId");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("\"players\"");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(checkpointForks.body)).not.toContain("\"socialMessages\":[");
    expectNoMatchPathLeak(checkpointForks.body, matchArtifactBaseDir);
    expectNoCheckpointPathLeak(checkpointForks.body, checkpointArtifactBaseDir);

    const branchTree = await requestJson(restartedBaseUrl, "GET", `/api/checkpoints/${checkpointId}/branch-tree`);
    expect(branchTree.status).toBe(200);
    expect(branchTree.body.summary).toMatchObject({
      kind: "checkpoint-branch-tree",
      schemaVersion: "server.checkpoint-branch-tree-summary.v3",
      ok: true,
      okScope: "returned",
      rootCheckpointId: checkpointId,
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
    const checkpointNodes = new Map(branchTree.body.summary.checkpoints.map((node: any) => [node.checkpointId, node]));
    expect(checkpointNodes.get(checkpointId)).toMatchObject({
      depth: 0,
      childForkCount: 1,
      summary: {
        checkpointId
      }
    });
    expect(checkpointNodes.get(childCheckpointId)).toMatchObject({
      depth: 2,
      childForkCount: 1,
      summary: {
        checkpointId: childCheckpointId,
        source: {
          runId: forkMatchId,
          matchId: forkMatchId,
          boundaryTraceRef: expect.any(String)
        }
      }
    });
    const matchNodes = new Map(branchTree.body.summary.matches.map((node: any) => [node.runId, node]));
    expect(matchNodes.get(forkMatchId)).toMatchObject({
      depth: 1,
      parentCheckpointId: checkpointId,
      forkOf: {
        checkpointId,
        parentBoundaryTraceRef: expect.any(String)
      }
    });
    expect(matchNodes.get(grandchildMatchId)).toMatchObject({
      depth: 3,
      parentCheckpointId: childCheckpointId,
      forkOf: {
        checkpointId: childCheckpointId,
        parentBoundaryTraceRef: expect.any(String)
      }
    });
    expect(branchTree.body.summary.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "checkpoint-fork", fromCheckpointId: checkpointId, toRunId: forkMatchId }),
        expect.objectContaining({ kind: "match-checkpoint", fromRunId: forkMatchId, toCheckpointId: childCheckpointId }),
        expect.objectContaining({ kind: "checkpoint-fork", fromCheckpointId: childCheckpointId, toRunId: grandchildMatchId })
      ])
    );
    expect(JSON.stringify(branchTree.body)).not.toContain("parentBoundaryTraceId");
    expect(JSON.stringify(branchTree.body)).not.toContain("\"boundaryTraceId\"");
    expect(JSON.stringify(branchTree.body)).not.toContain("\"players\"");
    expect(JSON.stringify(branchTree.body)).not.toContain("\"privateMemo\"");
    expect(JSON.stringify(branchTree.body)).not.toContain("\"socialMessages\":[");
    expectNoMatchPathLeak(branchTree.body, matchArtifactBaseDir);
    expectNoCheckpointPathLeak(branchTree.body, checkpointArtifactBaseDir);

    const forkArtifact = await requestJson(restartedBaseUrl, "GET", `/api/matches/${forkMatchId}/artifact?view=full`);
    expect(forkArtifact.status).toBe(200);
    expect(forkArtifact.body.forkOf).toMatchObject({
      checkpointId,
      parentRunId: parentMatchId,
      parentMatchId,
      parentBoundaryTraceId: checkpointArtifact.body.source.boundaryTraceId,
      parentStateHash: checkpointArtifact.body.source.stateHash,
      parentExecutionPrefixHash: checkpointArtifact.body.source.executionPrefixHash,
      parentAgentsHash: checkpointArtifact.body.source.agentsHash,
      parentChannelsHash: checkpointArtifact.body.source.channelsHash,
      parentMessagesHash: checkpointArtifact.body.source.messagesHash,
      parentNativeStepCount: checkpointArtifact.body.source.nativeStepCount,
      parentMessageCount: checkpointArtifact.body.source.messageCount,
      reason: "persisted fork child"
    });
    expect(forkArtifact.body.forkOf).not.toHaveProperty("parentBoundaryTraceRef");
    expect(validateMatchArtifactIntegrity(forkArtifact.body)).toEqual([]);
    expectNoMatchPathLeak(forkArtifact.body, matchArtifactBaseDir);
    expectNoCheckpointPathLeak(forkArtifact.body, checkpointArtifactBaseDir);

    const replayed = await requestJson(restartedBaseUrl, "POST", `/api/matches/${forkMatchId}/replay`, {});
    expect(replayed.status).toBe(200);
    expect(replayed.body.summary).toMatchObject({
      kind: "replay",
      ok: true,
      source: "server-owned-match-artifact",
      matchId: forkMatchId,
      runId: forkMatchId,
      finalHashMatchesArtifact: true,
      mismatchCount: 0
    });
    expectNoMatchPathLeak(replayed.body, matchArtifactBaseDir);
  }, 20_000);

  it("ignores malformed persisted match files during directory rehydrate", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matchArtifactBaseDir });
    const { matchId, artifact } = await createPersistedMatch(baseUrl, "server-match-malformed-files");
    const badJsonId = "00000000-0000-4000-8000-000000000201";
    const badShapeId = "00000000-0000-4000-8000-000000000202";
    const badIntegrityId = "00000000-0000-4000-8000-000000000203";

    await rm(path.join(matchArtifactBaseDir, MATCH_INDEX_FILE), { force: true });
    await mkdir(path.join(matchArtifactBaseDir, MATCH_DIR), { recursive: true });
    await writeFile(path.join(matchArtifactBaseDir, MATCH_DIR, `${badJsonId}.json`), "{ not json", "utf8");
    await writeFile(
      path.join(matchArtifactBaseDir, MATCH_DIR, `${badShapeId}.json`),
      `${JSON.stringify({ artifactVersion: "harness.checkpoint.v1", kind: "checkpoint", matchId: badShapeId })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(matchArtifactBaseDir, MATCH_DIR, `${badIntegrityId}.json`),
      `${JSON.stringify(
        {
          ...artifact,
          runId: badIntegrityId,
          matchId: badIntegrityId,
          evaluationReport: {
            ...artifact.evaluationReport,
            metricCount: artifact.evaluationReport.metricCount + 1
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir });
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body.map((match: any) => match.id)).toEqual([matchId]);
    expect(JSON.stringify(listed.body)).not.toContain(badJsonId);
    expect(JSON.stringify(listed.body)).not.toContain(badShapeId);
    expect(JSON.stringify(listed.body)).not.toContain(badIntegrityId);
    expectNoMatchPathLeak(listed.body, matchArtifactBaseDir);

    const repairedIndex = JSON.parse(await readFile(path.join(matchArtifactBaseDir, MATCH_INDEX_FILE), "utf8"));
    expect(repairedIndex.matches.map((match: any) => match.matchId)).toEqual([matchId]);
    expectNoMatchPathLeak(repairedIndex, matchArtifactBaseDir);

    const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const rejectedMatchFiles = assertArtifactRecoveryAuditResponse(audits.body).filter(
      (record: any) => record.store === "match" && record.source === "directory"
    );
    expect(Object.fromEntries(rejectedMatchFiles.map((record: any) => [record.artifactId, record.code]))).toEqual({
      [badJsonId]: "file_invalid_json",
      [badShapeId]: "file_invalid_shape",
      [badIntegrityId]: "file_integrity_invalid"
    });
    expectNoMatchPathLeak(audits.body, matchArtifactBaseDir);

    const filteredAudits = await requestJson(
      restartedBaseUrl,
      "GET",
      "/api/artifact-recovery-audits?store=match&source=directory&code=file_invalid_json&limit=1&offset=0"
    );
    expect(filteredAudits.status).toBe(200);
    expect(filteredAudits.body.filters).toEqual({
      store: "match",
      source: "directory",
      code: "file_invalid_json"
    });
    expect(filteredAudits.body.page).toEqual({
      total: 1,
      offset: 0,
      limit: 1,
      returned: 1,
      hasMore: false
    });
    const filteredRecords = assertArtifactRecoveryAuditResponse(filteredAudits.body);
    expect(filteredRecords).toHaveLength(1);
    expect(filteredRecords[0]).toMatchObject({
      store: "match",
      source: "directory",
      code: "file_invalid_json",
      artifactId: badJsonId,
      relativeFile: matchRelativeFile(badJsonId)
    });
    expectNoMatchPathLeak(filteredAudits.body, matchArtifactBaseDir);

    const pagedAudits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits?store=match&source=directory&limit=1");
    expect(pagedAudits.status).toBe(200);
    expect(pagedAudits.body.page).toEqual({
      total: 3,
      offset: 0,
      limit: 1,
      returned: 1,
      hasMore: true
    });
    expect(assertArtifactRecoveryAuditResponse(pagedAudits.body)).toHaveLength(1);
    expectNoMatchPathLeak(pagedAudits.body, matchArtifactBaseDir);

    for (const unsafeQuery of [
      "/api/artifact-recovery-audits?store=..%2Fprivate-audit",
      "/api/artifact-recovery-audits?source=directory&source=index",
      "/api/artifact-recovery-audits?code=raw-secret/code",
      "/api/artifact-recovery-audits?limit=501"
    ]) {
      const rejectedAuditQuery = await requestJson(restartedBaseUrl, "GET", unsafeQuery);
      expect(rejectedAuditQuery.status).toBe(400);
      expect(JSON.stringify(rejectedAuditQuery.body)).not.toContain("private-audit");
      expect(JSON.stringify(rejectedAuditQuery.body)).not.toContain("raw-secret");
      expectNoMatchPathLeak(rejectedAuditQuery.body, matchArtifactBaseDir);
    }

    const sidecarText = await readFile(path.join(matchArtifactBaseDir, RECOVERY_AUDIT_FILE), "utf8");
    const sidecarFileRecords = parseJsonl(sidecarText).filter((record: any) => record.store === "match" && record.source === "directory");
    expect(Object.fromEntries(sidecarFileRecords.map((record: any) => [record.artifactId, record.code]))).toEqual({
      [badJsonId]: "file_invalid_json",
      [badShapeId]: "file_invalid_shape",
      [badIntegrityId]: "file_integrity_invalid"
    });
    expectNoMatchPathLeak(sidecarText, matchArtifactBaseDir);

    for (const badId of [badJsonId, badShapeId, badIntegrityId]) {
      const detail = await requestJson(restartedBaseUrl, "GET", `/api/matches/${badId}`);
      expect(detail.status).toBe(404);
      expectNoMatchPathLeak(detail.body, matchArtifactBaseDir);
      const artifactResponse = await requestJson(restartedBaseUrl, "GET", `/api/matches/${badId}/artifact`);
      expect(artifactResponse.status).toBe(404);
      expectNoMatchPathLeak(artifactResponse.body, matchArtifactBaseDir);
      const trajectory = await requestText(restartedBaseUrl, "GET", `/api/matches/${badId}/trajectory.jsonl`);
      expect(trajectory.status).toBe(404);
      expectNoMatchPathLeak(trajectory.text, matchArtifactBaseDir);
      const replay = await requestJson(restartedBaseUrl, "POST", `/api/matches/${badId}/replay`, {});
      expect(replay.status).toBe(404);
      expectNoMatchPathLeak(replay.body, matchArtifactBaseDir);
    }
  }, 20_000);

  it("ignores stale and malicious match index records during rehydrate and repairs the index", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matchArtifactBaseDir });
    const { matchId, artifact } = await createPersistedMatch(baseUrl, "server-match-malicious-index");
    const staleId = "00000000-0000-4000-8000-000000000211";
    const traversalId = "00000000-0000-4000-8000-000000000212";
    const absoluteLikeId = "00000000-0000-4000-8000-000000000213";
    const backslashId = "00000000-0000-4000-8000-000000000214";
    const unsafeRawId = "/tmp/private-match-artifact";

    await writeMatchIndex(matchArtifactBaseDir, [
      {
        matchId,
        runId: matchId,
        createdAt: artifact.createdAt,
        seed: artifact.seed,
        status: artifact.status,
        relativeFile: matchRelativeFile(matchId)
      },
      {
        matchId: staleId,
        runId: staleId,
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: "stale",
        status: "completed",
        relativeFile: matchRelativeFile(staleId)
      },
      {
        matchId: traversalId,
        runId: traversalId,
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: "traversal",
        status: "completed",
        relativeFile: "../outside.json"
      },
      {
        matchId: absoluteLikeId,
        runId: absoluteLikeId,
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: "absolute",
        status: "completed",
        relativeFile: "/tmp/escape.json"
      },
      {
        matchId: backslashId,
        runId: backslashId,
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: "backslash",
        status: "completed",
        relativeFile: `matches\\${backslashId}.json`
      },
      {
        matchId: unsafeRawId,
        runId: unsafeRawId,
        createdAt: "2026-07-05T00:00:00.000Z",
        seed: "unsafe-raw-id",
        status: "completed",
        relativeFile: "/tmp/private-match-artifact.json"
      }
    ]);

    const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir });
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body.map((match: any) => match.id)).toEqual([matchId]);
    expect(JSON.stringify(listed.body)).not.toContain(staleId);
    expect(JSON.stringify(listed.body)).not.toContain(traversalId);
    expect(JSON.stringify(listed.body)).not.toContain(absoluteLikeId);
    expect(JSON.stringify(listed.body)).not.toContain(backslashId);
    expect(JSON.stringify(listed.body)).not.toContain(unsafeRawId);
    expectNoMatchPathLeak(listed.body, matchArtifactBaseDir);

    const repairedIndex = JSON.parse(await readFile(path.join(matchArtifactBaseDir, MATCH_INDEX_FILE), "utf8"));
    expect(repairedIndex.matches.map((match: any) => match.matchId)).toEqual([matchId]);
    expect(repairedIndex.matches[0]).toMatchObject({
      matchId,
      runId: matchId,
      relativeFile: matchRelativeFile(matchId)
    });
    expectNoMatchPathLeak(repairedIndex, matchArtifactBaseDir);

    const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const rejectedIndexRecords = assertArtifactRecoveryAuditResponse(audits.body).filter(
      (record: any) => record.store === "match" && record.source === "index" && record.code === "index_record_rejected"
    );
    expect(rejectedIndexRecords.map((record: any) => record.artifactId).sort()).toEqual(
      ["<rejected>", absoluteLikeId, backslashId, staleId, traversalId].sort()
    );
    expect(rejectedIndexRecords.some((record: any) => record.relativeFile === "<rejected>")).toBe(true);
    expect(JSON.stringify(audits.body)).not.toContain(unsafeRawId);
    expect(JSON.stringify(audits.body)).not.toContain("/tmp/escape.json");
    expect(JSON.stringify(audits.body)).not.toContain("../outside.json");
    expectNoMatchPathLeak(audits.body, matchArtifactBaseDir);

    for (const rejectedId of [staleId, traversalId, absoluteLikeId, backslashId]) {
      const detail = await requestJson(restartedBaseUrl, "GET", `/api/matches/${rejectedId}`);
      expect(detail.status).toBe(404);
      expectNoMatchPathLeak(detail.body, matchArtifactBaseDir);
      const replay = await requestJson(restartedBaseUrl, "POST", `/api/matches/${rejectedId}/replay`, {});
      expect(replay.status).toBe(404);
      expectNoMatchPathLeak(replay.body, matchArtifactBaseDir);
    }
  }, 20_000);

  it("repairs invalid match artifact index JSON and shape with recovery audit records", async () => {
    for (const scenario of [
      { code: "index_invalid_json", indexContent: "{ not json" },
      {
        code: "index_invalid_shape",
        indexContent: `${JSON.stringify({
          artifactVersion: "harness.match-artifact-index.v1",
          kind: "match-artifact-index",
          updatedAt: "2026-07-05T00:00:00.000Z",
          matches: "not-an-array"
        })}\n`
      }
    ]) {
      const matchArtifactBaseDir = await makeTempDir();
      clearServerStoreForTests();
      const baseUrl = await startServer({ matchArtifactBaseDir });
      const { matchId } = await createPersistedMatch(baseUrl, `server-match-${scenario.code}`);

      await writeFile(path.join(matchArtifactBaseDir, MATCH_INDEX_FILE), scenario.indexContent, "utf8");

      const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir });
      const listed = await requestJson(restartedBaseUrl, "GET", "/api/matches");
      expect(listed.status).toBe(200);
      expect(listed.body.map((match: any) => match.id)).toEqual([matchId]);
      expectNoMatchPathLeak(listed.body, matchArtifactBaseDir);

      const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
      expect(audits.status).toBe(200);
      const indexAudits = assertArtifactRecoveryAuditResponse(audits.body).filter(
        (record: any) => record.store === "match" && record.source === "index" && record.code === scenario.code
      );
      expect(indexAudits).toHaveLength(1);
      expect(indexAudits[0]).toMatchObject({
        artifactId: null,
        relativeFile: MATCH_INDEX_FILE
      });
      expectNoMatchPathLeak(audits.body, matchArtifactBaseDir);

      const sidecarText = await readFile(path.join(matchArtifactBaseDir, RECOVERY_AUDIT_FILE), "utf8");
      const sidecarRecords = parseJsonl(sidecarText);
      expect(
        sidecarRecords.some(
          (record: any) =>
            record.artifactVersion === "server.artifact-recovery-audit.v1" && record.store === "match" && record.code === scenario.code
        )
      ).toBe(true);
      expectNoMatchPathLeak(sidecarText, matchArtifactBaseDir);

      const recoveredAuditBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir });
      const persistedAudits = await requestJson(recoveredAuditBaseUrl, "GET", "/api/artifact-recovery-audits");
      expect(persistedAudits.status).toBe(200);
      const persistedIndexAudits = assertArtifactRecoveryAuditResponse(persistedAudits.body).filter(
        (record: any) => record.store === "match" && record.source === "index" && record.code === scenario.code
      );
      expect(persistedIndexAudits).toHaveLength(1);
      expect(persistedIndexAudits[0]).toMatchObject({
        artifactId: null,
        relativeFile: MATCH_INDEX_FILE
      });
      expectNoMatchPathLeak(persistedAudits.body, matchArtifactBaseDir);
    }
  }, 20_000);

  it("reports malformed recovery audit sidecar lines without exposing raw sidecar content", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const rawLineSentinel = "raw-sidecar-jsonl-secret-should-not-leak";
    const rawShapeSentinel = "raw-sidecar-shape-secret-should-not-leak";
    const rawMessageSentinel = "raw-sidecar-message-secret-should-not-leak";
    const validSidecarRecord = {
      artifactVersion: "server.artifact-recovery-audit.v1",
      id: "artifact-recovery:000000000000000000000000",
      createdAt: "2026-07-05T00:00:00.000Z",
      store: "match",
      source: "index",
      code: "index_invalid_json",
      relativeFile: MATCH_INDEX_FILE,
      message: rawMessageSentinel
    };
    await writeFile(
      path.join(matchArtifactBaseDir, RECOVERY_AUDIT_FILE),
      [
        `{ not json ${rawLineSentinel}`,
        JSON.stringify({
          artifactVersion: "server.artifact-recovery-audit.v1",
          createdAt: "not-a-safe-date",
          store: "match",
          source: "index",
          code: "index_invalid_json",
          relativeFile: MATCH_INDEX_FILE,
          message: rawShapeSentinel
        }),
        JSON.stringify(validSidecarRecord),
        JSON.stringify(validSidecarRecord)
      ].join("\n") + "\n",
      "utf8"
    );

    const baseUrl = await startServer({ matchArtifactBaseDir });
    const audits = await requestJson(baseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const records = assertArtifactRecoveryAuditResponse(audits.body);
    const sidecarRecords = records.filter((record: any) => record.store === "match" && record.source === "sidecar");
    expect(sidecarRecords.map((record: any) => record.code).sort()).toEqual(["sidecar_invalid_jsonl_line", "sidecar_invalid_record_shape"].sort());
    expect(sidecarRecords.map((record: any) => record.relativeFile)).toEqual([RECOVERY_AUDIT_FILE, RECOVERY_AUDIT_FILE]);
    expect(sidecarRecords.map((record: any) => record.artifactId)).toEqual([null, null]);

    const loadedIndexAudits = records.filter((record: any) => record.store === "match" && record.source === "index" && record.code === "index_invalid_json");
    expect(loadedIndexAudits).toHaveLength(1);
    const loadedIndexAudit = loadedIndexAudits[0];
    expect(loadedIndexAudit).toMatchObject({
      relativeFile: MATCH_INDEX_FILE,
      message: "Match artifact index contained invalid JSON and will be repaired."
    });

    const text = JSON.stringify(audits.body);
    expect(text).not.toContain(rawLineSentinel);
    expect(text).not.toContain(rawShapeSentinel);
    expect(text).not.toContain(rawMessageSentinel);
    expectNoMatchPathLeak(audits.body, matchArtifactBaseDir);

    const repeatedAudits = await requestJson(baseUrl, "GET", "/api/artifact-recovery-audits");
    expect(repeatedAudits.status).toBe(200);
    const repeatedRecords = assertArtifactRecoveryAuditResponse(repeatedAudits.body);
    expect(repeatedRecords.map((record: any) => record.id).sort()).toEqual(records.map((record: any) => record.id).sort());
    expectNoMatchPathLeak(repeatedAudits.body, matchArtifactBaseDir);
  });

  it("reports unsafe recovery audit sidecar files without blocking artifact recovery", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "outside-recovery-audit.jsonl");
    const sentinel = "outside-recovery-audit-sidecar-should-not-leak";
    await writeFile(outsideFile, `${sentinel}\n`, "utf8");
    await symlink(outsideFile, path.join(matchArtifactBaseDir, RECOVERY_AUDIT_FILE));

    const baseUrl = await startServer({ matchArtifactBaseDir });
    const listed = await requestJson(baseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
    expectNoMatchPathLeak(listed.body, matchArtifactBaseDir);

    const audits = await requestJson(baseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const records = assertArtifactRecoveryAuditResponse(audits.body);
    const sidecarRecords = records.filter((record: any) => record.store === "match" && record.source === "sidecar");
    expect(sidecarRecords).toHaveLength(1);
    expect(sidecarRecords[0]).toMatchObject({
      code: "sidecar_file_rejected",
      artifactId: null,
      relativeFile: RECOVERY_AUDIT_FILE,
      message: "Artifact recovery audit sidecar file was not a safe regular file and was ignored."
    });
    const text = JSON.stringify(audits.body);
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain(outsideDir);
    expectNoMatchPathLeak(audits.body, matchArtifactBaseDir);

    const repeatedAudits = await requestJson(baseUrl, "GET", "/api/artifact-recovery-audits");
    expect(repeatedAudits.status).toBe(200);
    const repeatedRecords = assertArtifactRecoveryAuditResponse(repeatedAudits.body);
    expect(repeatedRecords.map((record: any) => record.id).sort()).toEqual(records.map((record: any) => record.id).sort());
    expectNoMatchPathLeak(repeatedAudits.body, matchArtifactBaseDir);
  });

  it("loads distinct persisted sidecar diagnostics by hidden detail keys", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    await writeFile(
      path.join(matchArtifactBaseDir, RECOVERY_AUDIT_FILE),
      [
        JSON.stringify({
          artifactVersion: "server.artifact-recovery-audit.v1",
          createdAt: "2026-07-05T00:00:00.000Z",
          store: "match",
          source: "sidecar",
          code: "sidecar_invalid_jsonl_line",
          relativeFile: RECOVERY_AUDIT_FILE,
          detailKey: "line:10:0000000000000001",
          message: "raw persisted sidecar message should not be used"
        }),
        JSON.stringify({
          artifactVersion: "server.artifact-recovery-audit.v1",
          createdAt: "2026-07-05T00:00:01.000Z",
          store: "match",
          source: "sidecar",
          code: "sidecar_invalid_jsonl_line",
          relativeFile: RECOVERY_AUDIT_FILE,
          detailKey: "line:11:0000000000000002",
          message: "raw second persisted sidecar message should not be used"
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const baseUrl = await startServer({ matchArtifactBaseDir });
    const audits = await requestJson(baseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const records = assertArtifactRecoveryAuditResponse(audits.body);
    const sidecarRecords = records.filter(
      (record: any) => record.store === "match" && record.source === "sidecar" && record.code === "sidecar_invalid_jsonl_line"
    );
    expect(sidecarRecords).toHaveLength(2);
    expect(new Set(sidecarRecords.map((record: any) => record.id)).size).toBe(2);
    expect(sidecarRecords.map((record: any) => record.relativeFile)).toEqual([RECOVERY_AUDIT_FILE, RECOVERY_AUDIT_FILE]);
    expect(sidecarRecords.every((record: any) => record.message === "Artifact recovery audit sidecar contained an invalid JSONL line that was ignored.")).toBe(
      true
    );
    const text = JSON.stringify(audits.body);
    expect(text).not.toContain("detailKey");
    expect(text).not.toContain("raw persisted sidecar message");
    expect(text).not.toContain("raw second persisted sidecar message");
    expectNoMatchPathLeak(audits.body, matchArtifactBaseDir);
  });

  it("preserves existing persisted match and checkpoint index records when creating new artifacts after restart", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const checkpointArtifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matchArtifactBaseDir, checkpointArtifactBaseDir });
    const { matchId: firstMatchId } = await createPersistedMatch(baseUrl, "server-match-index-preserve-first");
    const firstCheckpoint = await requestJson(baseUrl, "POST", `/api/matches/${firstMatchId}/checkpoints`, {
      reason: "first checkpoint"
    });
    expect(firstCheckpoint.status).toBe(201);
    const firstCheckpointId = firstCheckpoint.body.summary.checkpointId as string;

    const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir, checkpointArtifactBaseDir });
    const secondRun = await requestJson(restartedBaseUrl, "POST", "/api/matches/run", {
      models: ["alpha", "beta"],
      seed: "server-match-index-preserve-second",
      maxTransitions: 1
    });
    expect(secondRun.status).toBe(200);
    const secondMatchId = secondRun.body.id as string;

    const matchIndex = JSON.parse(await readFile(path.join(matchArtifactBaseDir, MATCH_INDEX_FILE), "utf8"));
    expect(new Set(matchIndex.matches.map((match: any) => match.matchId))).toEqual(new Set([firstMatchId, secondMatchId]));
    expectNoMatchPathLeak(matchIndex, matchArtifactBaseDir);

    const secondCheckpoint = await requestJson(restartedBaseUrl, "POST", `/api/matches/${firstMatchId}/checkpoints`, {
      reason: "second checkpoint after restart"
    });
    expect(secondCheckpoint.status).toBe(201);
    const secondCheckpointId = secondCheckpoint.body.summary.checkpointId as string;

    const checkpointIndex = JSON.parse(await readFile(path.join(checkpointArtifactBaseDir, CHECKPOINT_INDEX_FILE), "utf8"));
    expect(new Set(checkpointIndex.checkpoints.map((checkpoint: any) => checkpoint.checkpointId))).toEqual(
      new Set([firstCheckpointId, secondCheckpointId])
    );
    expectNoCheckpointPathLeak(checkpointIndex, checkpointArtifactBaseDir);
  }, 15_000);

  it("rejects symlinked artifact write directories before writing outside the configured bases", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const outsideMatchDir = await makeTempDir();
    await symlink(outsideMatchDir, path.join(matchArtifactBaseDir, MATCH_DIR));
    let baseUrl = await startServer({ matchArtifactBaseDir });

    const rejectedMatch = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["alpha", "beta"],
      seed: "server-match-write-symlink",
      maxTransitions: 1
    });
    expect(rejectedMatch.status).toBe(500);
    expect(rejectedMatch.body).toMatchObject({
      hasArtifact: false,
      status: "failed",
      error: "Match artifact directory is not safe."
    });
    expect(await readdir(outsideMatchDir)).toEqual([]);
    expectNoMatchPathLeak(rejectedMatch.body, matchArtifactBaseDir);
    expect(JSON.stringify(rejectedMatch.body)).not.toContain(outsideMatchDir);

    const safeMatchArtifactBaseDir = await makeTempDir();
    const checkpointArtifactBaseDir = await makeTempDir();
    const outsideCheckpointDir = await makeTempDir();
    await symlink(outsideCheckpointDir, path.join(checkpointArtifactBaseDir, "checkpoints"));
    baseUrl = await startServer({ matchArtifactBaseDir: safeMatchArtifactBaseDir, checkpointArtifactBaseDir });
    const { matchId } = await createPersistedMatch(baseUrl, "server-checkpoint-write-symlink");

    const rejectedCheckpoint = await requestJson(baseUrl, "POST", `/api/matches/${matchId}/checkpoints`, {
      reason: "reject symlinked checkpoint dir"
    });
    expect(rejectedCheckpoint.status).toBe(500);
    expect(rejectedCheckpoint.body.error).toBe("Checkpoint artifact directory is not safe.");
    expect(await readdir(outsideCheckpointDir)).toEqual([]);
    expectNoCheckpointPathLeak(rejectedCheckpoint.body, checkpointArtifactBaseDir);
    expect(JSON.stringify(rejectedCheckpoint.body)).not.toContain(outsideCheckpointDir);
  });

  it("does not restore match artifacts that resolve through symlinks outside the match artifact base dir", async () => {
    const matchArtifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matchArtifactBaseDir });
    const { matchId } = await createPersistedMatch(baseUrl, "server-match-symlink");
    const persistedFile = path.join(matchArtifactBaseDir, MATCH_DIR, `${matchId}.json`);
    const originalArtifact = JSON.parse(await readFile(persistedFile, "utf8"));
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "outside-match-artifact.json");
    const sentinel = "outside-server-match-artifact-should-not-download";
    await writeFile(outsideFile, `${JSON.stringify({ ...originalArtifact, sentinel }, null, 2)}\n`, "utf8");
    await rm(persistedFile, { force: true });
    await symlink(outsideFile, persistedFile);

    const restartedBaseUrl = await restartServerWithClearedStore({ matchArtifactBaseDir });
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(sentinel);
    expectNoMatchPathLeak(listed.body, matchArtifactBaseDir);

    const detail = await requestJson(restartedBaseUrl, "GET", `/api/matches/${matchId}`);
    expect(detail.status).toBe(404);
    expect(JSON.stringify(detail.body)).not.toContain(sentinel);
    expectNoMatchPathLeak(detail.body, matchArtifactBaseDir);

    const artifact = await requestText(restartedBaseUrl, "GET", `/api/matches/${matchId}/artifact`);
    expect(artifact.status).toBe(404);
    expect(artifact.text).not.toContain(sentinel);
    expect(artifact.text).not.toContain(outsideDir);
    expectNoMatchPathLeak(artifact.text, matchArtifactBaseDir);

    const trajectory = await requestText(restartedBaseUrl, "GET", `/api/matches/${matchId}/trajectory.jsonl`);
    expect(trajectory.status).toBe(404);
    expect(trajectory.text).not.toContain(sentinel);
    expect(trajectory.text).not.toContain(outsideDir);
    expectNoMatchPathLeak(trajectory.text, matchArtifactBaseDir);

    const replay = await requestText(restartedBaseUrl, "POST", `/api/matches/${matchId}/replay`, {});
    expect(replay.status).toBe(404);
    expect(replay.text).not.toContain(sentinel);
    expect(replay.text).not.toContain(outsideDir);
    expectNoMatchPathLeak(replay.text, matchArtifactBaseDir);
  });
});

async function createPersistedMatch(baseUrl: string, seed: string, maxTransitions = 4) {
  const response = await requestJson(baseUrl, "POST", "/api/matches/run", {
    models: ["alpha", "beta"],
    seed,
    maxTransitions
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    id: expect.any(String),
    hasArtifact: true,
    summary: {
      kind: "match",
      seed,
      nativeSteps: expect.any(Number),
      committedSteps: expect.any(Number),
      rejectedSteps: expect.any(Number),
      trajectorySteps: expect.any(Number),
      evaluation: expect.objectContaining({
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      })
    }
  });
  expect(response.body.summary.resolvedAssignments).toHaveLength(response.body.state.players.length);
  const matchId = response.body.id as string;
  const artifact = await requestJson(baseUrl, "GET", `/api/matches/${matchId}/artifact?view=full`);
  expect(artifact.status).toBe(200);
  expect(artifact.body).toMatchObject({
    artifactVersion: "harness.match.v2",
    kind: "match",
    runId: matchId,
    matchId,
    seed
  });
  expect(validateMatchArtifactIntegrity(artifact.body)).toEqual([]);
  return {
    matchId,
    response: response.body,
    artifact: artifact.body
  };
}

async function startServer(options: { matchArtifactBaseDir?: string; checkpointArtifactBaseDir?: string } = {}): Promise<string> {
  if (server) {
    await close(server);
    server = undefined;
  }
  const app = createServerApp({
    createReasoner: () => fakeReasoner,
    matchArtifactBaseDir: options.matchArtifactBaseDir,
    checkpointArtifactBaseDir: options.checkpointArtifactBaseDir
  });
  server = await listen(app);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function restartServerWithClearedStore(options: { matchArtifactBaseDir?: string; checkpointArtifactBaseDir?: string }): Promise<string> {
  clearServerStoreForTests();
  return startServer(options);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "werewolf-server-match-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

async function writeMatchIndex(matchArtifactBaseDir: string, matches: unknown[]): Promise<void> {
  await writeFile(
    path.join(matchArtifactBaseDir, MATCH_INDEX_FILE),
    `${JSON.stringify(
      {
        artifactVersion: "harness.match-artifact-index.v1",
        kind: "match-artifact-index",
        updatedAt: "2026-07-05T00:00:00.000Z",
        matches
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function matchRelativeFile(matchId: string): string {
  return `${MATCH_DIR}/${matchId}.json`;
}

function assertPublicMatchResponse(body: unknown): void {
  expect(body).toMatchObject({
    id: expect.any(String),
    createdAt: expect.any(String),
    state: expect.any(Object),
    models: expect.any(Array),
    status: expect.any(String),
    hasArtifact: expect.any(Boolean),
    checkpointCount: expect.any(Number),
    profileCount: expect.any(Number),
    nativeSteps: expect.any(Number),
    committedSteps: expect.any(Number),
    rejectedSteps: expect.any(Number),
    trajectorySteps: expect.any(Number)
  });
  expect(body).toHaveProperty("harnessStatus");
  expect(body).toHaveProperty("truncationReason");
  expect(body).not.toHaveProperty("artifact");
  expect(body).not.toHaveProperty("initialState");
  expect(body).not.toHaveProperty("trajectory");
  expect(body).not.toHaveProperty("socialEpisode");
  expect(body).not.toHaveProperty("evaluation");
  expect(body).not.toHaveProperty("evaluationReport");
  expect(body).not.toHaveProperty("profiles");
  expect(body).not.toHaveProperty("assignment");
  expect(body).not.toHaveProperty("resolvedAssignments");
  const text = JSON.stringify(body);
  expect(text).not.toContain("privateMemos");
  expect(text).not.toContain("seerInspection");
  expect(text).not.toContain("wolfVotes");
  expect(text).not.toContain("resultTeam");
}

function expectNoMatchPathLeak(value: unknown, matchArtifactBaseDir: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(matchArtifactBaseDir);
  expect(text).not.toContain("outputDir");
  expect(text).not.toContain("baseDir");
  expect(text).not.toContain("artifactPath");
  expect(text).not.toContain("matchArtifactPath");
  expect(text).not.toContain("match artifact file");
}

function expectNoCheckpointPathLeak(value: unknown, checkpointArtifactBaseDir: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(checkpointArtifactBaseDir);
  expect(text).not.toContain("outputDir");
  expect(text).not.toContain("baseDir");
  expect(text).not.toContain("artifactPath");
  expect(text).not.toContain("checkpointPath");
  expect(text).not.toContain("checkpoint artifact file");
  expect(text).not.toContain(CHECKPOINT_INDEX_FILE);
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
  requestPath: string,
  body?: unknown
): Promise<{ status: number; body: any; contentType: string }> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    contentType: response.headers.get("content-type") ?? ""
  };
}

async function requestText(
  baseUrl: string,
  method: string,
  requestPath: string,
  body?: unknown
): Promise<{ status: number; text: string; contentType: string }> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}
