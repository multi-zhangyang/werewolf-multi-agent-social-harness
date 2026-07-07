import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests } from "../src/server/store";
import type { HarnessAgentProfile, HarnessReasoner } from "../src/harness/types";

const fakeReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `server artifact speech ${input.traceId}`
        : `server artifact memo ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `server-artifact-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

const tempDirs: string[] = [];
const servers: Server[] = [];
const ARTIFACT_SET_INDEX_FILE = "artifact_sets.index.json";
const RECOVERY_AUDIT_FILE = "artifact_recovery_audits.jsonl";

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearServerStoreForTests();
});

describe("tournament artifact server API", () => {
  it("exports tournament artifacts under a configured base dir and downloads registered files only", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });

    const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["alpha", "beta"],
      games: 1,
      seed: "server-tournament-artifacts",
      maxTransitions: 0,
      exportArtifacts: true
    });

    expect(exported.status).toBe(200);
    expect(exported.body.summary).toMatchObject({
      kind: "tournament",
      ok: true,
      seed: "server-tournament-artifacts",
      artifacts: {
        artifactSetId: expect.any(String),
        experimentId: expect.any(String),
        seed: "server-tournament-artifacts",
        files: {
          manifest: "manifest.json",
          registry: "registry.json",
          specNormalized: "spec.normalized.json",
          assignment: "assignment.json",
          episodes: "episodes.jsonl",
          trajectory: "trajectory.jsonl",
          metrics: "metrics.jsonl",
          integrity: "integrity.jsonl",
          failures: "failures.jsonl",
          costLatency: "cost_latency.json",
          leaderboard: "leaderboard.json",
          benchmarkStatistics: "benchmark_statistics.json",
          summaryMarkdown: "summary.md",
          episodesCsv: "episodes.csv",
          agentsCsv: "agents.csv",
          metricsCsv: "metrics.csv",
          leaderboardCsv: "leaderboard.csv",
          matches: [expect.stringMatching(/^matches\/.+\.json$/)],
          matchesJsonl: [expect.stringMatching(/^matches\/.+\.jsonl$/)]
        }
      }
    });
    expect(exported.body.artifacts).toEqual(exported.body.summary.artifacts);
    expect(exported.body.artifacts.downloads.integrity).toBe(
      `/api/tournament-artifacts/${encodeURIComponent(exported.body.artifacts.artifactSetId)}/files/integrity.jsonl`
    );
    expect(exported.body.summary.artifacts.downloads.integrity).toBe(exported.body.artifacts.downloads.integrity);
    expect(exported.body.episodes).toHaveLength(1);
    expect(exported.body.episodes[0]).not.toHaveProperty("artifact");
    expect(exported.body.episodes[0]).not.toHaveProperty("trajectory");
    expect(exported.body.episodes[0]).not.toHaveProperty("socialEpisode");
    expect(exported.body.episodes[0]).not.toHaveProperty("evaluation");
    expect(exported.body.episodes[0]).not.toHaveProperty("evaluationReport");
    expect(exported.body.episodes[0]).not.toHaveProperty("metrics");
	    expect(exported.body.episodes[0]).not.toHaveProperty("assignment");
	    expect(exported.body.episodes[0]).not.toHaveProperty("resolvedAssignments");
	    expect(exported.body.episodes[0]).not.toHaveProperty("topMetrics");
	    expect(exported.body.episodes[0]).toMatchObject({
      index: 0,
      seed: "server-tournament-artifacts:g1",
      metricSummary: expect.any(Object),
      evaluationSummary: expect.any(Object),
      evaluationReportSummary: expect.objectContaining({
        warningCount: expect.any(Number),
        warningCodes: expect.any(Array),
        warningSeverityCounts: {
          info: expect.any(Number),
          warning: expect.any(Number)
        }
      }),
      agentCount: expect.any(Number),
      agents: expect.any(Array),
      hasArtifact: true
    });
	    expect(exported.body.episodes[0].evaluationReportSummary).not.toHaveProperty("warnings");
	    expect(exported.body.episodes[0].evaluationReportSummary).not.toHaveProperty("metadata");
	    expect(exported.body.episodes[0].evaluationSummary).not.toHaveProperty("topMetrics");
	    expect(exported.body.episodes[0].evaluationReportSummary).not.toHaveProperty("topMetrics");
	    expect(exported.body.summary).not.toHaveProperty("topMetrics");
	    expect(exported.body.summary.evaluationReports).toMatchObject({
      warningCount: expect.any(Number),
      warningCodes: expect.any(Array),
      warningSeverityCounts: {
        info: expect.any(Number),
        warning: expect.any(Number)
      },
      reportsWithWarnings: expect.any(Number)
    });
    for (const agent of exported.body.episodes[0].agents) {
      expect(Object.keys(agent).sort()).toEqual(["playerId", "seat"]);
      expect(agent).not.toHaveProperty("role");
      expect(agent).not.toHaveProperty("team");
      expect(agent).not.toHaveProperty("profileId");
      expect(agent).not.toHaveProperty("model");
      expect(agent).not.toHaveProperty("policyName");
      expect(agent).not.toHaveProperty("reward");
      expect(agent).not.toHaveProperty("won");
    }
    expect(JSON.stringify(exported.body)).not.toContain(artifactBaseDir);
    expect(JSON.stringify(exported.body)).not.toContain("outputDir");

    const artifactSetId = exported.body.artifacts.artifactSetId;
    const listed = await requestJson(baseUrl, "GET", "/api/tournament-artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifactSets).toEqual([exported.body.artifacts]);
    expect(JSON.stringify(listed.body)).not.toContain(artifactBaseDir);

    const detail = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(exported.body.artifacts);
    expect(JSON.stringify(detail.body)).not.toContain(artifactBaseDir);

    const manifest = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.contentType).toMatch(/application\/json/);
    expect(manifest.body).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament",
      seed: "server-tournament-artifacts",
      artifactIntegrityOkCount: 1,
      artifactIntegrityErrorCount: 0,
      artifactIntegrityErroredMatchCount: 0,
      files: {
        manifest: "manifest.json",
        registry: "registry.json",
        specNormalized: "spec.normalized.json",
        assignment: "assignment.json",
        integrity: "integrity.jsonl",
        costLatency: "cost_latency.json",
        benchmarkStatistics: "benchmark_statistics.json",
        summaryMarkdown: "summary.md",
        episodesCsv: "episodes.csv",
        agentsCsv: "agents.csv",
        metricsCsv: "metrics.csv",
        leaderboardCsv: "leaderboard.csv",
        matches: [expect.stringMatching(/^matches\/.+\.json$/)],
        matchesJsonl: [expect.stringMatching(/^matches\/.+\.jsonl$/)]
      },
      matches: [
        expect.objectContaining({
          path: expect.stringMatching(/^matches\/.+\.json$/),
          jsonlPath: expect.stringMatching(/^matches\/.+\.jsonl$/),
          integrityOk: true,
          integrityErrorCount: 0
        })
      ]
    });
    expect(Object.values(manifest.body.files).flat().every((file) => typeof file !== "string" || !path.isAbsolute(file))).toBe(true);

    const summaryMarkdown = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/summary.md`);
    expect(summaryMarkdown.status).toBe(200);
    expect(summaryMarkdown.contentType).toMatch(/text\/markdown/);
    expect(summaryMarkdown.text).toContain("# Tournament Summary:");
    expect(summaryMarkdown.text).toContain("server-tournament-artifacts");
    expect(summaryMarkdown.text).not.toContain(artifactBaseDir);

    const episodesCsv = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/episodes.csv`);
    expect(episodesCsv.status).toBe(200);
    expect(episodesCsv.contentType).toMatch(/text\/csv/);
    expect(episodesCsv.text).toContain("tournament_seed,episode_index,episode_seed");
    expect(episodesCsv.text).toContain("server-tournament-artifacts,0,server-tournament-artifacts:g1");
    expect(episodesCsv.text).not.toContain(artifactBaseDir);

    const agentsCsv = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/agents.csv`);
    expect(agentsCsv.status).toBe(200);
    expect(agentsCsv.contentType).toMatch(/text\/csv/);
    expect(agentsCsv.text).toContain("player_id,seat,profile_id,model");
    expect(agentsCsv.text).not.toContain(artifactBaseDir);

    const metricsCsv = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/metrics.csv`);
    expect(metricsCsv.status).toBe(200);
    expect(metricsCsv.contentType).toMatch(/text\/csv/);
    expect(metricsCsv.text).toContain("metric_id,label,evaluator_id");
    expect(metricsCsv.text).not.toContain(artifactBaseDir);

    const leaderboardCsv = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/leaderboard.csv`);
    expect(leaderboardCsv.status).toBe(200);
    expect(leaderboardCsv.contentType).toMatch(/text\/csv/);
    expect(leaderboardCsv.text).toContain("subject_type,subject_id,model");
    expect(leaderboardCsv.text).not.toContain(artifactBaseDir);

    const trajectory = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/trajectory.jsonl`);
    expect(trajectory.status).toBe(200);
    expect(trajectory.contentType).toMatch(/application\/x-ndjson/);
    expect(trajectory.text).toContain("\"type\":\"header\"");
    expect(trajectory.text).not.toContain(artifactBaseDir);

    const benchmarkStatistics = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/benchmark_statistics.json`);
    expect(benchmarkStatistics.status).toBe(200);
    expect(benchmarkStatistics.contentType).toMatch(/application\/json/);
    expect(benchmarkStatistics.body).toMatchObject({
      kind: "tournament-benchmark-statistics",
      schemaVersion: "harness.benchmark-statistics.v1",
      evaluatorId: "evaluation.benchmark-statistics.v1",
      statusDenominators: {
        gamesRequested: 1,
        episodesScheduled: 1
      },
      denominatorPolicy: {
        superiorityClaims: false
      }
    });

    const matchArtifactPath = manifest.body.files.matches[0];
    const matchJsonlPath = manifest.body.files.matchesJsonl[0];
    const matchArtifact = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/${matchArtifactPath}`);
    expect(matchArtifact.status).toBe(200);
    expect(matchArtifact.body).toMatchObject({
      artifactVersion: "harness.match.v1",
      kind: "match",
      status: "truncated"
    });
    const matchJsonl = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/${matchJsonlPath}`);
    expect(matchJsonl.status).toBe(200);
    expect(matchJsonl.contentType).toMatch(/application\/x-ndjson/);
    expect(matchJsonl.text).toContain("\"type\":\"header\"");

    const integrity = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/integrity.jsonl`);
    expect(integrity.status).toBe(200);
    expect(integrity.contentType).toMatch(/application\/x-ndjson/);
    expect(integrity.text).not.toContain(artifactBaseDir);
    const integrityRecords = parseJsonl(integrity.text);
    expect(integrityRecords).toEqual([
      expect.objectContaining({
        type: "artifact_integrity",
        episodeIndex: 0,
        tournamentEpisodeIndex: 0,
        tournamentSeed: "server-tournament-artifacts",
        episodeSeed: "server-tournament-artifacts:g1",
        runId: matchArtifact.body.runId,
        matchId: matchArtifact.body.matchId,
        status: "truncated",
        ok: true,
        errorCount: 0,
        errors: [],
        matchArtifact: matchArtifactPath,
        matchJsonl: matchJsonlPath
      })
    ]);

    const episodes = await requestText(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/episodes.jsonl`);
    const episodeRecords = parseJsonl(episodes.text);
    expect(episodeRecords[0]).toMatchObject({
      matchArtifact: expect.stringMatching(/^matches\/.+\.json$/),
      matchJsonl: expect.stringMatching(/^matches\/.+\.jsonl$/)
    });

    clearServerStoreForTests();
    const restartedBaseUrl = await startServer({ artifactBaseDir });
    const restoredDetail = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}`);
    expect(restoredDetail.status).toBe(200);
    expect(restoredDetail.body).toEqual(exported.body.artifacts);
    expect(JSON.stringify(restoredDetail.body)).not.toContain(artifactBaseDir);

    const afterClear = await requestJson(restartedBaseUrl, "GET", "/api/tournament-artifacts");
    expect(afterClear.status).toBe(200);
    expect(afterClear.body.artifactSets).toEqual([exported.body.artifacts]);
    expect(JSON.stringify(afterClear.body)).not.toContain(artifactBaseDir);

    const restoredIntegrity = await requestText(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/integrity.jsonl`);
    expect(restoredIntegrity.status).toBe(200);
    expect(restoredIntegrity.contentType).toMatch(/application\/x-ndjson/);
    expect(restoredIntegrity.text).not.toContain(artifactBaseDir);
  });

  it("rehydrates tournament artifact sets from child manifests when the server-owned index is missing", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const { artifacts, artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, "server-tournament-child-manifest-rehydrate");

    await removeArtifactSetIndex(artifactBaseDir);
    const restartedBaseUrl = await restartServerWithClearedStore(artifactBaseDir);

    const listed = await requestJson(restartedBaseUrl, "GET", "/api/tournament-artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifactSets).toEqual([artifacts]);
    expectNoArtifactPathLeak(listed.body, artifactBaseDir);

    const detail = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(artifacts);
    expectNoArtifactPathLeak(detail.body, artifactBaseDir);

    const manifest = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.contentType).toMatch(/application\/json/);
    expect(manifest.body).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament",
      seed: "server-tournament-child-manifest-rehydrate",
      files: artifacts.files
    });
    expectNoArtifactPathLeak(manifest.body, artifactBaseDir);

    const integrity = await requestText(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/integrity.jsonl`);
    expect(integrity.status).toBe(200);
    expect(integrity.contentType).toMatch(/application\/x-ndjson/);
    expect(integrity.text).toContain("\"type\":\"artifact_integrity\"");
    expectNoArtifactPathLeak(integrity.text, artifactBaseDir);

    const indexDownload = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/${ARTIFACT_SET_INDEX_FILE}`);
    expect(indexDownload.status).toBe(404);
    expectNoArtifactPathLeak(indexDownload.body, artifactBaseDir);
  });

  it("ignores malformed child manifests during artifact-set directory rehydrate", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const { artifacts, artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, "server-tournament-malformed-child-manifests");
    const badJsonId = "00000000-0000-4000-8000-000000000001";
    const badShapeId = "00000000-0000-4000-8000-000000000002";
    const badContainedNameId = "00000000-0000-4000-8000-000000000003";
    const badVersionId = "00000000-0000-4000-8000-000000000004";
    const rawContainedName = "private-experiment-label";

    await removeArtifactSetIndex(artifactBaseDir);
    await mkdir(path.join(artifactBaseDir, badJsonId), { recursive: true });
    await writeFile(path.join(artifactBaseDir, badJsonId, "manifest.json"), "{ not json", "utf8");
    await mkdir(path.join(artifactBaseDir, badShapeId), { recursive: true });
    await writeFile(
      path.join(artifactBaseDir, badShapeId, "manifest.json"),
      `${JSON.stringify({
        artifactVersion: "harness.tournament.v1",
        kind: "tournament",
        createdAt: "2026-01-01T00:00:00.000Z",
        experimentId: "bad-shape",
        seed: "bad-shape",
        files: {
          ...artifacts.files,
          manifest: "../manifest.json"
        }
      })}\n`,
      "utf8"
    );
    await mkdir(path.join(artifactBaseDir, badContainedNameId), { recursive: true });
    await writeFile(
      path.join(artifactBaseDir, badContainedNameId, "manifest.json"),
      `${JSON.stringify({
        artifactVersion: "harness.tournament.v1",
        kind: "tournament",
        createdAt: "2026-01-01T00:00:00.000Z",
        experimentId: "bad-contained-name",
        seed: "bad-contained-name",
        files: {
          ...artifacts.files,
          matches: [`matches/${rawContainedName}.json`],
          matchesJsonl: [`matches/${rawContainedName}.jsonl`]
        }
      })}\n`,
      "utf8"
    );
    await mkdir(path.join(artifactBaseDir, badVersionId), { recursive: true });
    await writeFile(
      path.join(artifactBaseDir, badVersionId, "manifest.json"),
      `${JSON.stringify({
        artifactVersion: "harness.match.v1",
        kind: "match",
        createdAt: "2026-01-01T00:00:00.000Z",
        experimentId: "bad-version",
        seed: "bad-version",
        files: artifacts.files
      })}\n`,
      "utf8"
    );

    const restartedBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/tournament-artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifactSets.map((set: any) => set.artifactSetId)).toEqual([artifactSetId]);
    expect(JSON.stringify(listed.body)).not.toContain(badJsonId);
    expect(JSON.stringify(listed.body)).not.toContain(badShapeId);
    expect(JSON.stringify(listed.body)).not.toContain(badContainedNameId);
    expect(JSON.stringify(listed.body)).not.toContain(badVersionId);
    expect(JSON.stringify(listed.body)).not.toContain(rawContainedName);
    expectNoArtifactPathLeak(listed.body, artifactBaseDir);

    const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const auditRecords = assertArtifactRecoveryAuditResponse(audits.body);
    const rejectedManifests = auditRecords.filter((record: any) => record.store === "tournament" && record.source === "manifest");
    expect(Object.fromEntries(rejectedManifests.map((record: any) => [record.artifactId, record.code]))).toEqual({
      [badJsonId]: "manifest_invalid_json",
      [badShapeId]: "manifest_file_set_invalid",
      [badContainedNameId]: "manifest_file_set_invalid",
      [badVersionId]: "manifest_invalid_shape"
    });
    expect(rejectedManifests.map((record: any) => record.relativeFile).sort()).toEqual([
      "manifest.json",
      "manifest.json",
      "manifest.json",
      "manifest.json"
    ]);
    expect(JSON.stringify(audits.body)).not.toContain(rawContainedName);
    expectNoArtifactPathLeak(audits.body, artifactBaseDir);

    const sidecarText = await readFile(path.join(artifactBaseDir, RECOVERY_AUDIT_FILE), "utf8");
    const sidecarManifestRecords = parseJsonl(sidecarText).filter((record: any) => record.store === "tournament" && record.source === "manifest");
    expect(Object.fromEntries(sidecarManifestRecords.map((record: any) => [record.artifactId, record.code]))).toEqual({
      [badJsonId]: "manifest_invalid_json",
      [badShapeId]: "manifest_file_set_invalid",
      [badContainedNameId]: "manifest_file_set_invalid",
      [badVersionId]: "manifest_invalid_shape"
    });
    expect(JSON.stringify(sidecarText)).not.toContain(rawContainedName);
    expectNoArtifactPathLeak(sidecarText, artifactBaseDir);

    const repeatedAudits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(repeatedAudits.status).toBe(200);
    const repeatedAuditRecords = assertArtifactRecoveryAuditResponse(repeatedAudits.body);
    expect(repeatedAuditRecords.map((record: any) => record.id).sort()).toEqual(auditRecords.map((record: any) => record.id).sort());
    expectNoArtifactPathLeak(repeatedAudits.body, artifactBaseDir);

    for (const badId of [badJsonId, badShapeId, badContainedNameId, badVersionId]) {
      const detail = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${badId}`);
      expect(detail.status).toBe(404);
      expectNoArtifactPathLeak(detail.body, artifactBaseDir);
      const download = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${badId}/files/manifest.json`);
      expect(download.status).toBe(404);
      expectNoArtifactPathLeak(download.body, artifactBaseDir);
    }

    const validManifest = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/manifest.json`);
    expect(validManifest.status).toBe(200);
  });

  it("repairs invalid artifact-set index JSON and shape from child manifests with recovery audits", async () => {
    for (const scenario of [
      { code: "index_invalid_json", indexContent: "{ not json" },
      {
        code: "index_invalid_shape",
        indexContent: `${JSON.stringify({
          artifactVersion: "harness.tournament-artifact-set-index.v1",
          kind: "tournament-artifact-set-index",
          updatedAt: "2026-07-05T00:00:00.000Z",
          artifactSets: "not-an-array"
        })}\n`
      }
    ]) {
      const artifactBaseDir = await makeTempDir();
      clearServerStoreForTests();
      const baseUrl = await startServer({ artifactBaseDir });
      const { artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, `server-tournament-${scenario.code}`);

      await writeFile(path.join(artifactBaseDir, ARTIFACT_SET_INDEX_FILE), scenario.indexContent, "utf8");

      const restartedBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
      const listed = await requestJson(restartedBaseUrl, "GET", "/api/tournament-artifacts");
      expect(listed.status).toBe(200);
      expect(listed.body.artifactSets.map((set: any) => set.artifactSetId)).toEqual([artifactSetId]);
      expectNoArtifactPathLeak(listed.body, artifactBaseDir);

      const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
      expect(audits.status).toBe(200);
      const indexAudits = assertArtifactRecoveryAuditResponse(audits.body).filter(
        (record: any) => record.store === "tournament" && record.source === "index" && record.code === scenario.code
      );
      expect(indexAudits).toHaveLength(1);
      expect(indexAudits[0]).toMatchObject({
        artifactId: null,
        relativeFile: ARTIFACT_SET_INDEX_FILE
      });
      expectNoArtifactPathLeak(audits.body, artifactBaseDir);

      const sidecarText = await readFile(path.join(artifactBaseDir, RECOVERY_AUDIT_FILE), "utf8");
      const sidecarRecords = parseJsonl(sidecarText);
      expect(
        sidecarRecords.some(
          (record: any) =>
            record.artifactVersion === "server.artifact-recovery-audit.v1" && record.store === "tournament" && record.code === scenario.code
        )
      ).toBe(true);
      expectNoArtifactPathLeak(sidecarText, artifactBaseDir);

      const sidecarDownload = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/${RECOVERY_AUDIT_FILE}`);
      expect(sidecarDownload.status).toBe(404);
      expectNoArtifactPathLeak(sidecarDownload.body, artifactBaseDir);

      const recoveredAuditBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
      const persistedAudits = await requestJson(recoveredAuditBaseUrl, "GET", "/api/artifact-recovery-audits");
      expect(persistedAudits.status).toBe(200);
      const persistedIndexAudits = assertArtifactRecoveryAuditResponse(persistedAudits.body).filter(
        (record: any) => record.store === "tournament" && record.source === "index" && record.code === scenario.code
      );
      expect(persistedIndexAudits).toHaveLength(1);
      expect(persistedIndexAudits[0]).toMatchObject({
        artifactId: null,
        relativeFile: ARTIFACT_SET_INDEX_FILE
      });
      expectNoArtifactPathLeak(persistedAudits.body, artifactBaseDir);
    }
  });

  it("ignores stale and malicious artifact-set index records during rehydrate", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const { artifacts, artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, "server-tournament-malicious-index-records");
    const staleId = "00000000-0000-4000-8000-000000000011";
    const traversalId = "00000000-0000-4000-8000-000000000012";
    const absoluteLikeId = "00000000-0000-4000-8000-000000000013";

    await writeArtifactSetIndex(artifactBaseDir, [
      {
        id: artifactSetId,
        createdAt: artifacts.createdAt,
        experimentId: artifacts.experimentId,
        seed: artifacts.seed,
        relativeFiles: artifacts.files
      },
      {
        id: staleId,
        createdAt: "2026-01-01T00:00:00.000Z",
        experimentId: "stale",
        seed: "stale",
        relativeFiles: artifacts.files
      },
      {
        id: traversalId,
        createdAt: "2026-01-01T00:00:00.000Z",
        experimentId: "malicious",
        seed: "malicious",
        relativeFiles: {
          ...artifacts.files,
          matches: ["matches/../manifest.json"]
        }
      },
      {
        id: absoluteLikeId,
        createdAt: "2026-01-01T00:00:00.000Z",
        experimentId: "malicious-absolute",
        seed: "malicious-absolute",
        relativeFiles: {
          ...artifacts.files,
          matches: ["/tmp/escape.json"]
        }
      }
    ]);

    const restartedBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
    const listed = await requestJson(restartedBaseUrl, "GET", "/api/tournament-artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifactSets.map((set: any) => set.artifactSetId)).toEqual([artifactSetId]);
    expect(JSON.stringify(listed.body)).not.toContain(staleId);
    expect(JSON.stringify(listed.body)).not.toContain(traversalId);
    expect(JSON.stringify(listed.body)).not.toContain(absoluteLikeId);
    expectNoArtifactPathLeak(listed.body, artifactBaseDir);

    const validManifest = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/manifest.json`);
    expect(validManifest.status).toBe(200);

    const audits = await requestJson(restartedBaseUrl, "GET", "/api/artifact-recovery-audits");
    expect(audits.status).toBe(200);
    const rejectedIndexRecords = assertArtifactRecoveryAuditResponse(audits.body).filter(
      (record: any) => record.store === "tournament" && record.source === "index" && record.code === "index_record_rejected"
    );
    expect(rejectedIndexRecords.map((record: any) => record.artifactId).sort()).toEqual([absoluteLikeId, staleId, traversalId].sort());
    expectNoArtifactPathLeak(audits.body, artifactBaseDir);

    for (const rejectedId of [staleId, traversalId, absoluteLikeId]) {
      const detail = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${rejectedId}`);
      expect(detail.status).toBe(404);
      expectNoArtifactPathLeak(detail.body, artifactBaseDir);
      const download = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${rejectedId}/files/manifest.json`);
      expect(download.status).toBe(404);
      expectNoArtifactPathLeak(download.body, artifactBaseDir);
    }
  });

  it("does not serve registered artifact files that resolve through symlinks outside the artifact set", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const { artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, "server-tournament-symlink-download");
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "outside-integrity.jsonl");
    await writeFile(outsideFile, "outside-server-file-should-not-download\n", "utf8");
    await rm(path.join(artifactBaseDir, artifactSetId, "integrity.jsonl"), { force: true });
    await symlink(outsideFile, path.join(artifactBaseDir, artifactSetId, "integrity.jsonl"));

    const restartedBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
    const detail = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}`);
    expect(detail.status).toBe(200);
    expectNoArtifactPathLeak(detail.body, artifactBaseDir);

    const manifest = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/manifest.json`);
    expect(manifest.status).toBe(200);

    const leaked = await requestText(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/integrity.jsonl`);
    expect([400, 404]).toContain(leaked.status);
    expect(leaked.text).not.toContain("outside-server-file-should-not-download");
    expect(leaked.text).not.toContain(outsideDir);
    expectNoArtifactPathLeak(leaked.text, artifactBaseDir);

    const traversal = await requestJson(restartedBaseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/..%2Foutside-integrity.jsonl`);
    expect([400, 404]).toContain(traversal.status);
    expectNoArtifactPathLeak(traversal.body, artifactBaseDir);
  });

  it("uses explicit top-level profiles for tournament runtime and exported artifacts", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const profiles = [
      { id: "wolf-pressure-lab", model: "profile-model-a", policyName: "wolf-deceiver", temperature: 0.2 },
      { id: "village-audit-lab", model: "profile-model-b", policyName: "village-analyst", temperature: 1.1 }
    ] satisfies HarnessAgentProfile[];

    const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["ignored-when-profiles-derive-runtime-models"],
      profiles,
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed: "server-tournament-explicit-profiles",
      maxTransitions: 0,
      exportArtifacts: true
    });

    expect(exported.status).toBe(200);
	    expect(exported.body.summary).toMatchObject({
	      kind: "tournament",
	      ok: true,
	      seed: "server-tournament-explicit-profiles",
	      models: ["profile-model-a", "profile-model-b"],
	      profileCount: profiles.length,
	      modelCount: 2
	    });
	    expect(exported.body.summary.models).not.toContain("ignored-when-profiles-derive-runtime-models");
	    expect(exported.body.summary).not.toHaveProperty("profiles");
	    expect(exported.body.summary).not.toHaveProperty("profileStats");
	    expect(exported.body.summary).not.toHaveProperty("modelStats");
	    expect(exported.body.summary).not.toHaveProperty("topMetrics");
	    const publicSummary = JSON.stringify(exported.body.summary);
	    expect(publicSummary).not.toContain("wolf-pressure-lab");
	    expect(publicSummary).not.toContain("village-audit-lab");
	    expect(publicSummary).not.toContain("wolf-deceiver");
	    expect(publicSummary).not.toContain("village-analyst");
	    for (const agent of exported.body.episodes[0].agents) {
      expect(Object.keys(agent).sort()).toEqual(["playerId", "seat"]);
      expect(agent).not.toHaveProperty("role");
      expect(agent).not.toHaveProperty("team");
      expect(agent).not.toHaveProperty("profileId");
      expect(agent).not.toHaveProperty("model");
      expect(agent).not.toHaveProperty("policyName");
      expect(agent).not.toHaveProperty("reward");
      expect(agent).not.toHaveProperty("won");
    }

    const artifactSetId = exported.body.artifacts.artifactSetId;
    const manifest = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.body).toMatchObject({
      seed: "server-tournament-explicit-profiles",
      models: ["profile-model-a", "profile-model-b"],
      profiles
    });

    const normalizedSpec = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/spec.normalized.json`);
    expect(normalizedSpec.status).toBe(200);
    expect(normalizedSpec.body).toMatchObject({
      seed: "server-tournament-explicit-profiles",
      models: ["profile-model-a", "profile-model-b"],
      profiles
    });

    const assignment = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/assignment.json`);
    expect(assignment.status).toBe(200);
    expect(assignment.body).toMatchObject({
      profiles,
      episodes: [
        expect.objectContaining({
          resolvedAssignments: expect.arrayContaining([
            expect.objectContaining({
              profileId: "wolf-pressure-lab",
              model: "profile-model-a",
              temperature: 0.2,
              policyName: "wolf-deceiver"
            }),
            expect.objectContaining({
              profileId: "village-audit-lab",
              model: "profile-model-b",
              temperature: 1.1,
              policyName: "village-analyst"
            })
          ]),
          agents: expect.arrayContaining([
            expect.objectContaining({
              profileId: "wolf-pressure-lab",
              model: "profile-model-a",
              temperature: 0.2,
              policyName: "wolf-deceiver"
            }),
            expect.objectContaining({
              profileId: "village-audit-lab",
              model: "profile-model-b",
              temperature: 1.1,
              policyName: "village-analyst"
            })
          ])
        })
      ]
    });

    const matchArtifactPath = manifest.body.files.matches[0];
    const matchArtifact = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/${matchArtifactPath}`);
    expect(matchArtifact.status).toBe(200);
    expect(matchArtifact.body).toMatchObject({
      models: ["profile-model-a", "profile-model-b"],
      profiles,
      resolvedAssignments: expect.arrayContaining([
        expect.objectContaining({
          profileId: "wolf-pressure-lab",
          model: "profile-model-a",
          temperature: 0.2,
          policyName: "wolf-deceiver"
        }),
        expect.objectContaining({
          profileId: "village-audit-lab",
          model: "profile-model-b",
          temperature: 1.1,
          policyName: "village-analyst"
        })
      ])
    });
    expect(JSON.stringify(exported.body)).not.toContain(artifactBaseDir);
    expect(JSON.stringify(manifest.body)).not.toContain(artifactBaseDir);
  });

  it("uses explicit profiles as the tournament failure-summary model source", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const profiles = [{ id: "profile-a", model: "profile-model-a", temperature: 0.2 }] satisfies HarnessAgentProfile[];

    const rejected = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["stale-request-model"],
      profiles,
      assignment: {
        strategy: "seat",
        seats: { "1": "missing-profile" },
        fallback: "error"
      },
      games: 1,
      seed: "server-tournament-stale-model-failure",
      maxTransitions: 0,
      exportArtifacts: false
    });

    expect(rejected.status).toBe(500);
    expect(rejected.body.summary).toMatchObject({
      kind: "tournament",
      ok: false,
      seed: "server-tournament-stale-model-failure",
      models: ["profile-model-a"],
      profileCount: 1,
      modelCount: 1
    });
    expect(rejected.body.summary.models).not.toContain("stale-request-model");
    expect(JSON.stringify(rejected.body.summary)).not.toContain("stale-request-model");
  });

  it("rejects artifact export when the server has no configured base dir", async () => {
    const previous = process.env.TOURNAMENT_ARTIFACT_BASE_DIR;
    delete process.env.TOURNAMENT_ARTIFACT_BASE_DIR;
    try {
      const baseUrl = await startServer({});
      const rejected = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
        models: ["alpha", "beta"],
        games: 1,
        seed: "server-tournament-no-base",
        maxTransitions: 0,
        exportArtifacts: true
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatch(/TOURNAMENT_ARTIFACT_BASE_DIR/);
    } finally {
      restoreEnv("TOURNAMENT_ARTIFACT_BASE_DIR", previous);
    }
  });

  it("rejects filesystem control fields on tournament export requests", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const forbiddenFields = ["outputDir", "exportDir", "path", "file", "artifactPath", "checkpointPath", "overwrite"];

    for (const field of forbiddenFields) {
      const rejected = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
        models: ["alpha", "beta"],
        games: 1,
        seed: `server-tournament-forbidden-${field}`,
        maxTransitions: 0,
        exportArtifacts: true,
        [field]: "/tmp/unsafe"
      });
      expect(rejected.status, field).toBe(400);
      expect(rejected.body.error).toMatch(/forbidden field/);
    }

    const nested = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      spec: {
        models: ["alpha", "beta"],
        games: 1,
        seed: "server-tournament-nested-forbidden",
        outputDir: "/tmp/unsafe"
      },
      exportArtifacts: true
    });
    expect(nested.status).toBe(400);
    expect(nested.body.error).toMatch(/forbidden field/);
  });

  it("rejects traversal, absolute, unknown, and unregistered artifact downloads without path leakage", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["alpha", "beta"],
      games: 1,
      seed: "server-tournament-unsafe-downloads",
      maxTransitions: 0,
      exportArtifacts: true
    });
    const artifactSetId = exported.body.artifacts.artifactSetId;

    const unknownId = await requestJson(baseUrl, "GET", "/api/tournament-artifacts/not-a-real-set/files/manifest.json");
    expect(unknownId.status).toBe(404);

    const unregistered = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/matches/not-registered.json`);
    expect(unregistered.status).toBe(404);
    expect(JSON.stringify(unregistered.body)).not.toContain(artifactBaseDir);

    const unregisteredIntegrity = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/integrity-copy.jsonl`);
    expect(unregisteredIntegrity.status).toBe(404);
    expect(JSON.stringify(unregisteredIntegrity.body)).not.toContain(artifactBaseDir);

    const unregisteredIndex = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/artifact_sets.index.json`);
    expect(unregisteredIndex.status).toBe(404);
    expect(JSON.stringify(unregisteredIndex.body)).not.toContain(artifactBaseDir);

    const unsafePaths = ["..%2Fmanifest.json", "..%2Fartifact_sets.index.json", "matches%2F..%2Fmanifest.json", "%2Fetc%2Fpasswd", "matches%5C..%5Cmanifest.json"];
    for (const unsafePath of unsafePaths) {
      const rejected = await requestJson(baseUrl, "GET", `/api/tournament-artifacts/${artifactSetId}/files/${unsafePath}`);
      expect([400, 404], unsafePath).toContain(rejected.status);
      expect(JSON.stringify(rejected.body)).not.toContain(artifactBaseDir);
    }
  });
});

async function startServer(options: { artifactBaseDir?: string }): Promise<string> {
  const app = createServerApp({
    createReasoner: () => fakeReasoner,
    tournamentArtifactBaseDir: options.artifactBaseDir
  });
  const server = await listen(app);
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
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

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "werewolf-server-tournament-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

async function exportOneTournamentArtifactSet(baseUrl: string, seed: string): Promise<{ exported: Awaited<ReturnType<typeof requestJson>>; artifactSetId: string; artifacts: any }> {
  const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
    models: ["alpha", "beta"],
    games: 1,
    seed,
    maxTransitions: 0,
    exportArtifacts: true
  });
  expect(exported.status).toBe(200);
  return {
    exported,
    artifactSetId: exported.body.artifacts.artifactSetId,
    artifacts: exported.body.artifacts
  };
}

async function restartServerWithClearedStore(artifactBaseDir: string): Promise<string> {
  clearServerStoreForTests();
  return startServer({ artifactBaseDir });
}

async function removeArtifactSetIndex(baseDir: string): Promise<void> {
  await rm(path.join(baseDir, ARTIFACT_SET_INDEX_FILE), { force: true });
}

async function writeArtifactSetIndex(baseDir: string, artifactSets: unknown[]): Promise<void> {
  await writeFile(
    path.join(baseDir, ARTIFACT_SET_INDEX_FILE),
    `${JSON.stringify(
      {
        artifactVersion: "harness.tournament-artifact-set-index.v1",
        kind: "tournament-artifact-set-index",
        updatedAt: "2026-01-01T00:00:00.000Z",
        artifactSets
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function expectNoArtifactPathLeak(value: unknown, artifactBaseDir: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(artifactBaseDir);
  expect(text).not.toContain("outputDir");
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

async function requestJson(baseUrl: string, method: string, requestPath: string, body?: unknown): Promise<{ status: number; body: any; contentType: string }> {
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

async function requestText(baseUrl: string, method: string, requestPath: string): Promise<{ status: number; text: string; contentType: string }> {
  const response = await fetch(`${baseUrl}${requestPath}`, { method });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}

function parseJsonl(text: string): any[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
