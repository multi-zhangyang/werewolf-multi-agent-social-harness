import { beforeEach, describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import { buildMatchArtifact } from "../src/harness/artifacts";
import {
  MATCH_COMPARISON_ARTIFACT_VERSION,
  type MatchComparisonArtifact
} from "../src/harness/matchComparison";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import type { HarnessReasoner } from "../src/harness/types";
import {
  clearServerStoreForTests,
  createMatchRecordFromState,
  createTournamentPublicShare,
  getComparison,
  getMatch,
  getTournamentPublicShare,
  listComparisons,
  pruneAllTournamentPublicShareEvents,
  recordTournamentPublicShareDetailView,
  recordTournamentPublicShareDownload,
  retainDownloadEvents,
  retainTimestampEvents,
  saveComparison,
  saveMatch,
  saveTournamentPublicShare,
  type StoredMatch
} from "../src/server/store";

const unusedReasoner: HarnessReasoner = {
  async think() {
    throw new Error("The one-transition store fixture must not invoke a reasoner.");
  }
};

describe("server match store authority", () => {
  beforeEach(() => {
    clearServerStoreForTests();
  });

  it("returns detached pre-artifact records instead of mutable canonical references", () => {
    const record = createMatchRecordFromState({
      state: createGame({ id: "store-pre-artifact", seed: "store-pre-artifact" }),
      models: ["store-model"]
    });
    const first = getMatch(record.id);
    if (!first) throw new Error("Expected stored pre-artifact match.");
    const originalPhase = first.state.phase;

    first.state.phase = "game_over";
    first.models.push("forged-model");

    const second = getMatch(record.id);
    expect(second?.state.phase).toBe(originalPhase);
    expect(second?.models).toEqual(["store-model"]);
  });

  it("stores a finished match as one validated artifact and derives every compatibility view from it", async () => {
    const initialState = createGame({ id: "store-finished", seed: "store-finished" });
    const profiles = profilesFromModels(["store-model"], 0);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0);
    const resolvedAssignments = describeResolvedAssignments(initialState.players, agents);
    const result = await runHarnessMatch({ initialState, agents, reasoner: unusedReasoner, maxTransitions: 1 });
    const artifact = buildMatchArtifact({
      runId: initialState.id,
      matchId: initialState.id,
      createdAt: new Date(0).toISOString(),
      seed: initialState.seed,
      models: ["store-model"],
      profiles,
      resolvedAssignments,
      result
    });
    const forgedParallelFields: StoredMatch = {
      id: initialState.id,
      createdAt: new Date().toISOString(),
      state: createGame({ id: "forged-state", seed: "forged-state" }),
      models: ["forged-model"],
      status: "running",
      trajectory: [],
      artifact
    };

    saveMatch(forgedParallelFields);

    const stored = getMatch(initialState.id);
    expect(stored).toMatchObject({
      id: artifact.matchId,
      createdAt: artifact.createdAt,
      state: artifact.finalState,
      models: artifact.models,
      status: artifact.status === "failed" ? "failed" : "completed",
      trajectory: artifact.trajectory,
      socialEpisode: artifact.socialEpisode,
      metrics: artifact.metrics
    });
    expect(stored?.state.id).toBe(initialState.id);

    if (!stored?.artifact) throw new Error("Expected artifact-backed stored match.");
    stored.state.phase = "game_over";
    stored.artifact.finalState.phase = "game_over";
    expect(getMatch(initialState.id)?.state.phase).toBe(artifact.finalState.phase);
  });

  it("rejects fake completed records and invalid artifacts", async () => {
    const initialState = createGame({ id: "store-invalid", seed: "store-invalid" });
    const record = createMatchRecordFromState({ state: initialState, models: ["store-model"] });
    expect(() => saveMatch({ ...record, status: "completed" })).toThrow(/must contain a validated match artifact/);

    const profiles = profilesFromModels(["store-model"], 0);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0);
    const result = await runHarnessMatch({ initialState, agents, reasoner: unusedReasoner, maxTransitions: 1 });
    const artifact = buildMatchArtifact({
      runId: initialState.id,
      matchId: initialState.id,
      seed: initialState.seed,
      models: ["store-model"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    artifact.finalState.phase = "game_over";

    expect(() => saveMatch({ ...record, artifact })).toThrow(/Invalid match artifact/);
    expect(getMatch(record.id)?.artifact).toBeUndefined();
  });
});

describe("tournament public share event retention", () => {
  beforeEach(() => {
    clearServerStoreForTests();
  });

  it("retains events by max count and max age", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    const timestamps = [
      "2026-06-01T00:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
      "2026-07-14T12:00:00.000Z",
      "2026-07-15T11:59:00.000Z"
    ];
    expect(
      retainTimestampEvents(timestamps, { maxEvents: 2, maxAgeMs: 24 * 60 * 60 * 1000 }, now)
    ).toEqual(["2026-07-14T12:00:00.000Z", "2026-07-15T11:59:00.000Z"]);

    const downloads = timestamps.map((at, index) => ({ at, file: `f${index}.json` }));
    expect(retainDownloadEvents(downloads, { maxEvents: 3, maxAgeMs: 48 * 60 * 60 * 1000 }, now)).toEqual([
      { at: "2026-07-14T11:00:00.000Z", file: "f1.json" },
      { at: "2026-07-14T12:00:00.000Z", file: "f2.json" },
      { at: "2026-07-15T11:59:00.000Z", file: "f3.json" }
    ]);
  });

  it("prunes stored share events and keeps totals", () => {
    const share = createTournamentPublicShare({
      artifactSetId: "pack-retention",
      label: "retention",
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    const policy = { maxEvents: 2, maxAgeMs: 24 * 60 * 60 * 1000 };

    recordTournamentPublicShareDetailView(share.id, "2026-06-01T00:00:00.000Z", policy, now);
    recordTournamentPublicShareDetailView(share.id, "2026-07-15T10:00:00.000Z", policy, now);
    recordTournamentPublicShareDetailView(share.id, "2026-07-15T11:00:00.000Z", policy, now);
    recordTournamentPublicShareDownload(share.id, "manifest.json", "2026-06-01T00:00:00.000Z", policy, now);
    recordTournamentPublicShareDownload(share.id, "leaderboard.json", "2026-07-15T10:30:00.000Z", policy, now);
    recordTournamentPublicShareDownload(share.id, "manifest.json", "2026-07-15T11:30:00.000Z", policy, now);

    const after = getTournamentPublicShare(share.id);
    expect(after?.detailViewCount).toBe(3);
    expect(after?.downloadCount).toBe(3);
    expect(after?.detailViewEvents).toEqual(["2026-07-15T10:00:00.000Z", "2026-07-15T11:00:00.000Z"]);
    expect(after?.downloadEvents).toEqual([
      { at: "2026-07-15T10:30:00.000Z", file: "leaderboard.json" },
      { at: "2026-07-15T11:30:00.000Z", file: "manifest.json" }
    ]);

    // Inject an old event and prune globally.
    saveTournamentPublicShare({
      ...after!,
      detailViewEvents: ["2026-01-01T00:00:00.000Z", ...(after?.detailViewEvents ?? [])],
      downloadEvents: [{ at: "2026-01-01T00:00:00.000Z", file: "old.json" }, ...(after?.downloadEvents ?? [])]
    });
    const pruned = pruneAllTournamentPublicShareEvents(policy, now);
    expect(pruned.prunedShareCount).toBe(1);
    expect(pruned.removedDetailViewEvents).toBe(1);
    expect(pruned.removedDownloadEvents).toBe(1);
    const finalShare = getTournamentPublicShare(share.id);
    expect(finalShare?.detailViewEvents).toEqual(["2026-07-15T10:00:00.000Z", "2026-07-15T11:00:00.000Z"]);
    expect(finalShare?.downloadEvents?.map((event) => event.file)).toEqual(["leaderboard.json", "manifest.json"]);
    expect(finalShare?.detailViewCount).toBe(3);
    expect(finalShare?.downloadCount).toBe(3);
  });
});

describe("comparison registry packMatchIds filtering", () => {
  beforeEach(() => {
    clearServerStoreForTests();
  });

  function comparisonFixture(options: {
    comparisonId: string;
    createdAt: string;
    baselineMatchId?: string;
    baselineRunId: string;
    candidateMatchId?: string;
    candidateRunId: string;
  }): MatchComparisonArtifact {
    const emptySource = {
      runId: "",
      seed: "seed",
      createdAt: options.createdAt,
      status: "completed" as const,
      models: ["store-model"],
      profileCount: 0,
      resolvedAssignmentCount: 0,
      agentCount: 0,
      trajectorySteps: 0,
      socialSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      socialMessages: 0,
      socialSpeechActs: 0,
      socialDeliveryReceipts: 0,
      socialChannels: 0,
      gameEvents: 0,
      evaluationMetricCount: 0,
      evaluationWarningCount: 0,
      evaluatorCount: 0,
      stateHash: "state-hash",
      artifactHash: "artifact-hash"
    };
    return {
      artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
      kind: "match-comparison",
      comparisonId: options.comparisonId,
      createdAt: options.createdAt,
      view: "truth-redacted",
      projection: {
        view: "truth-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: true,
        generatedAt: options.createdAt
      },
      baseline: {
        ...emptySource,
        matchId: options.baselineMatchId,
        runId: options.baselineRunId
      },
      candidate: {
        ...emptySource,
        matchId: options.candidateMatchId,
        runId: options.candidateRunId
      },
      rows: [],
      summary: {
        rowCount: 0,
        changedRowCount: 0,
        numericDeltaCount: 0,
        promotionChangedMetricCount: 0,
        scorecardMetricDelta: 0,
        diagnosticMetricDelta: 0,
        benchmarkOnlyMetricDelta: 0,
        metricKeysCompared: 0,
        metricKeysEmitted: 0,
        metricKeysTruncated: 0,
        scorecardMetricKeysCompared: 0,
        scorecardMetricKeysEmitted: 0,
        scorecardMetricKeysTruncated: 0,
        diagnosticMetricKeysCompared: 0,
        diagnosticMetricKeysEmitted: 0,
        diagnosticMetricKeysTruncated: 0,
        benchmarkOnlyMetricKeysCompared: 0,
        benchmarkOnlyMetricKeysEmitted: 0,
        benchmarkOnlyMetricKeysTruncated: 0,
        evidenceIdentityChangedMetricCount: 0,
        evidenceIdentityOnlyBaselineRefCount: 0,
        evidenceIdentityOnlyCandidateRefCount: 0,
        baselineSocialSteps: 0,
        candidateSocialSteps: 0,
        baselineCommittedSteps: 0,
        candidateCommittedSteps: 0,
        baselineRejectedSteps: 0,
        candidateRejectedSteps: 0,
        socialStepsDelta: 0,
        committedStepsDelta: 0,
        rejectedStepsDelta: 0,
        metricRowsMax: 0,
        baselineHash: "baseline-hash",
        candidateHash: "candidate-hash"
      }
    };
  }

  it("filters to comparisons whose baseline and candidate both intersect pack ids", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:pack-pair",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineMatchId: "pack-1",
        baselineRunId: "pack-1",
        candidateMatchId: "pack-2",
        candidateRunId: "pack-2"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:other-pair",
        createdAt: "2026-07-15T13:00:00.000Z",
        baselineMatchId: "old-1",
        baselineRunId: "old-1",
        candidateMatchId: "old-2",
        candidateRunId: "old-2"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:partial-pair",
        createdAt: "2026-07-15T14:00:00.000Z",
        baselineMatchId: "pack-1",
        baselineRunId: "pack-1",
        candidateMatchId: "outside",
        candidateRunId: "outside"
      })
    );

    const filtered = listComparisons({ packMatchIds: ["pack-1", "pack-2"] });
    expect(filtered.map((entry) => entry.comparisonId)).toEqual(["match-comparison:pack-pair"]);
  });

  it("ignores packMatchIds filters with fewer than two ids", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:only",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineMatchId: "pack-1",
        baselineRunId: "pack-1",
        candidateMatchId: "pack-2",
        candidateRunId: "pack-2"
      })
    );

    expect(listComparisons({ packMatchIds: ["pack-1"] }).map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:only"
    ]);
    expect(listComparisons().map((entry) => entry.comparisonId)).toEqual(["match-comparison:only"]);
  });

  it("matches runId when matchId is absent", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:run-only",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineRunId: "run-a",
        candidateRunId: "run-b"
      })
    );

    expect(listComparisons({ packMatchIds: ["run-a", "run-b"] }).map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:run-only"
    ]);
  });

  it("filters by baselineId and candidateId independently and together", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:a-b",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineMatchId: "a",
        baselineRunId: "run-a",
        candidateMatchId: "b",
        candidateRunId: "run-b"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:a-c",
        createdAt: "2026-07-15T13:00:00.000Z",
        baselineMatchId: "a",
        baselineRunId: "run-a",
        candidateMatchId: "c",
        candidateRunId: "run-c"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:d-b",
        createdAt: "2026-07-15T14:00:00.000Z",
        baselineMatchId: "d",
        baselineRunId: "run-d",
        candidateMatchId: "b",
        candidateRunId: "run-b"
      })
    );

    expect(listComparisons({ baselineId: "a" }).map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:a-c",
      "match-comparison:a-b"
    ]);
    expect(listComparisons({ candidateId: "b" }).map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:d-b",
      "match-comparison:a-b"
    ]);
    expect(
      listComparisons({ baselineId: "a", candidateId: "b" }).map((entry) => entry.comparisonId)
    ).toEqual(["match-comparison:a-b"]);
    expect(listComparisons({ baselineId: "run-d" }).map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:d-b"
    ]);
  });

  it("applies packMatchIds together with baselineId and candidateId", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:pack-a-b",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineMatchId: "pack-1",
        baselineRunId: "pack-1",
        candidateMatchId: "pack-2",
        candidateRunId: "pack-2"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:pack-a-outside",
        createdAt: "2026-07-15T13:00:00.000Z",
        baselineMatchId: "pack-1",
        baselineRunId: "pack-1",
        candidateMatchId: "outside",
        candidateRunId: "outside"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:outside-pack-2",
        createdAt: "2026-07-15T14:00:00.000Z",
        baselineMatchId: "outside",
        baselineRunId: "outside",
        candidateMatchId: "pack-2",
        candidateRunId: "pack-2"
      })
    );

    expect(
      listComparisons({
        packMatchIds: ["pack-1", "pack-2"],
        baselineId: "pack-1",
        candidateId: "pack-2"
      }).map((entry) => entry.comparisonId)
    ).toEqual(["match-comparison:pack-a-b"]);
    expect(
      listComparisons({
        packMatchIds: ["pack-1", "pack-2"],
        baselineId: "outside"
      }).map((entry) => entry.comparisonId)
    ).toEqual([]);
  });

  it("returns detached comparison clones instead of mutable registry references", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:clone",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineMatchId: "pack-1",
        baselineRunId: "pack-1",
        candidateMatchId: "pack-2",
        candidateRunId: "pack-2"
      })
    );

    const listed = listComparisons({ packMatchIds: ["pack-1", "pack-2"] });
    expect(listed).toHaveLength(1);
    listed[0]!.baseline.runId = "forged";
    listed[0]!.summary.changedRowCount = 99;

    const again = listComparisons({ packMatchIds: ["pack-1", "pack-2"] });
    expect(again[0]?.baseline.runId).toBe("pack-1");
    expect(again[0]?.summary.changedRowCount).toBe(0);
  });


  it("rejects invalid comparison artifacts and returns detached getComparison clones", () => {
    expect(() =>
      saveComparison({
        ...comparisonFixture({
          comparisonId: "match-comparison:valid",
          createdAt: "2026-07-15T12:00:00.000Z",
          baselineMatchId: "pack-1",
          baselineRunId: "pack-1",
          candidateMatchId: "pack-2",
          candidateRunId: "pack-2"
        }),
        artifactVersion: "not-a-comparison-version" as typeof MATCH_COMPARISON_ARTIFACT_VERSION
      })
    ).toThrow(/Only harness\.match-comparison\.v1/);

    expect(() =>
      saveComparison({
        ...comparisonFixture({
          comparisonId: "match-comparison:valid",
          createdAt: "2026-07-15T12:00:00.000Z",
          baselineMatchId: "pack-1",
          baselineRunId: "pack-1",
          candidateMatchId: "pack-2",
          candidateRunId: "pack-2"
        }),
        kind: "not-match-comparison" as "match-comparison"
      })
    ).toThrow(/Only harness\.match-comparison\.v1/);

    expect(() =>
      saveComparison({
        ...comparisonFixture({
          comparisonId: "match-comparison:valid",
          createdAt: "2026-07-15T12:00:00.000Z",
          baselineMatchId: "pack-1",
          baselineRunId: "pack-1",
          candidateMatchId: "pack-2",
          candidateRunId: "pack-2"
        }),
        comparisonId: ""
      })
    ).toThrow(/missing comparisonId/);

    const valid = comparisonFixture({
      comparisonId: "match-comparison:get-clone",
      createdAt: "2026-07-15T12:00:00.000Z",
      baselineMatchId: "pack-1",
      baselineRunId: "pack-1",
      candidateMatchId: "pack-2",
      candidateRunId: "pack-2"
    });
    saveComparison(valid);

    const first = getComparison("match-comparison:get-clone");
    expect(first?.comparisonId).toBe("match-comparison:get-clone");
    if (!first) throw new Error("Expected stored comparison.");
    first.baseline.runId = "forged";
    first.summary.changedRowCount = 7;

    const second = getComparison("match-comparison:get-clone");
    expect(second?.baseline.runId).toBe("pack-1");
    expect(second?.summary.changedRowCount).toBe(0);
    expect(getComparison("missing-comparison-id")).toBeUndefined();
  });

  it("clones on save so later input mutation cannot corrupt stored comparisons", () => {
    const input = comparisonFixture({
      comparisonId: "match-comparison:input-clone",
      createdAt: "2026-07-15T12:00:00.000Z",
      baselineMatchId: "pack-1",
      baselineRunId: "pack-1",
      candidateMatchId: "pack-2",
      candidateRunId: "pack-2"
    });
    saveComparison(input);

    input.baseline.runId = "mutated-after-save";
    input.summary.changedRowCount = 42;
    input.candidate.matchId = "mutated-candidate";

    const stored = getComparison("match-comparison:input-clone");
    expect(stored?.baseline.runId).toBe("pack-1");
    expect(stored?.candidate.matchId).toBe("pack-2");
    expect(stored?.summary.changedRowCount).toBe(0);

    // Overwrite with a new payload replaces the prior stored comparison.
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:input-clone",
        createdAt: "2026-07-15T13:00:00.000Z",
        baselineMatchId: "pack-9",
        baselineRunId: "pack-9",
        candidateMatchId: "pack-8",
        candidateRunId: "pack-8"
      })
    );
    const replaced = getComparison("match-comparison:input-clone");
    expect(replaced?.createdAt).toBe("2026-07-15T13:00:00.000Z");
    expect(replaced?.baseline.matchId).toBe("pack-9");
    expect(replaced?.candidate.matchId).toBe("pack-8");
    expect(listComparisons().map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:input-clone"
    ]);
  });



  it("lists comparisons newest-first and clears them with clearServerStoreForTests", () => {
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:older",
        createdAt: "2026-07-15T10:00:00.000Z",
        baselineMatchId: "a",
        baselineRunId: "a",
        candidateMatchId: "b",
        candidateRunId: "b"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:newer",
        createdAt: "2026-07-15T12:00:00.000Z",
        baselineMatchId: "c",
        baselineRunId: "c",
        candidateMatchId: "d",
        candidateRunId: "d"
      })
    );
    saveComparison(
      comparisonFixture({
        comparisonId: "match-comparison:middle",
        createdAt: "2026-07-15T11:00:00.000Z",
        baselineMatchId: "e",
        baselineRunId: "e",
        candidateMatchId: "f",
        candidateRunId: "f"
      })
    );

    expect(listComparisons().map((entry) => entry.comparisonId)).toEqual([
      "match-comparison:newer",
      "match-comparison:middle",
      "match-comparison:older"
    ]);

    clearServerStoreForTests();
    expect(listComparisons()).toEqual([]);
    expect(getComparison("match-comparison:newer")).toBeUndefined();
  });


});

