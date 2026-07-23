import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import { ModelCallError } from "../src/agents/schema";
import { buildFinalHarnessCheckpoint, buildMatchArtifact, forkHarnessRunOptions } from "../src/harness/artifacts";
import {
  DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
  DECEPTION_BELIEF_SHIFT_METRIC_IDS,
  DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
  DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
  WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
  WEREWOLF_ADVERSARIAL_METRIC_IDS,
  WEREWOLF_DECEPTION_EVALUATOR_ID,
  WEREWOLF_INFLUENCE_EVALUATOR_ID,
  WEREWOLF_OUTCOME_EVALUATOR_ID,
  WEREWOLF_OUTCOME_METRIC_IDS,
  WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
  WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
  WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
  WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID
} from "../src/harness/evaluator";
import { normalizeTournamentExperimentSpec } from "../src/harness/experiment";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import {
  BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
  COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
  COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  SOCIAL_DYNAMICS_EVALUATOR_ID,
  SOCIAL_DYNAMICS_METRIC_IDS,
  SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
  SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
  SOCIAL_STATE_EVALUATOR_ID,
  SOCIAL_STATE_METRIC_IDS,
  TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
  TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS
} from "../src/harness/socialEvaluator";
import { runTournament, type TournamentResult } from "../src/harness/tournament";
import {
  BENCHMARK_STATISTICS_EVALUATOR_ID,
  BENCHMARK_STATISTICS_EVALUATOR_VERSION,
  BENCHMARK_STATISTICS_VERSION,
  writeTournamentArtifactDirectory
} from "../src/harness/tournamentArtifacts";
import { rebuildTournamentLeaderboardFromRawRecords } from "../src/harness/tournamentLeaderboard";
import type { HarnessAgentProfile, HarnessEvaluationReport, HarnessEvaluationWarning, HarnessReasoner } from "../src/harness/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tournament artifact directory writer", () => {
  it("writes the required layout and preserves truncated harness status", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 1,
      seed: "writer-truncated",
      reasoner: deterministicReasoner,
      maxTransitions: 0,
      includeArtifacts: true
    });
    const testWarning: HarnessEvaluationWarning = {
      code: "test.warning",
      severity: "warning",
      evaluatorId: WEREWOLF_OUTCOME_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      metricId: "agent.reward",
      message: "tournament warning propagation test"
    };
    const testEvaluatorFailure = {
      evaluatorId: "test.tournament-evaluator-failure",
      label: "Test tournament evaluator failure",
      version: "1.0.0",
      stage: "evaluate" as const,
      code: "evaluator_exception" as const,
      message: "Evaluator execution failed; no metrics or output were recorded."
    };
    if (!result.episodes[0].evaluationReport) throw new Error("Expected evaluation report for warning propagation test.");
    result.episodes[0].evaluationReport.warnings = [testWarning];
    result.episodes[0].evaluationReport.status = "incomplete";
    result.episodes[0].evaluationReport.failures = [testEvaluatorFailure];
    if (result.episodes[0].artifact) {
      result.episodes[0].artifact.evaluationReport.warnings = [testWarning];
      result.episodes[0].artifact.evaluationReport.status = "incomplete";
      result.episodes[0].artifact.evaluationReport.failures = [testEvaluatorFailure];
    }
    if (result.artifacts?.[0]) {
      result.artifacts[0].artifact.evaluationReport.warnings = [testWarning];
      result.artifacts[0].artifact.evaluationReport.status = "incomplete";
      result.artifacts[0].artifact.evaluationReport.failures = [testEvaluatorFailure];
    }

    const written = await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-layout",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    await expect(writeTournamentArtifactDirectory(result, { outputDir, experimentId: "writer-layout-again" })).rejects.toThrow();

    expect(path.resolve(written.outputDir)).toBe(outputDir);
    expect(written.files.specNormalized).toBe(path.join(outputDir, "spec.normalized.json"));
    expect(written.files.assignment).toBe(path.join(outputDir, "assignment.json"));
    expect(written.files.costLatency).toBe(path.join(outputDir, "cost_latency.json"));
    expect(written.files.benchmarkStatistics).toBe(path.join(outputDir, "benchmark_statistics.json"));
    expect(written.files.tournamentComparison).toBe(path.join(outputDir, "tournament_comparison.json"));
    expect(written.files.tournamentComparisonMarkdown).toBe(path.join(outputDir, "tournament_comparison.md"));
    expect(written.files.integrity).toBe(path.join(outputDir, "integrity.jsonl"));
    expect(written.files.summaryMarkdown).toBe(path.join(outputDir, "summary.md"));
    expect(written.files.episodesCsv).toBe(path.join(outputDir, "episodes.csv"));
    expect(written.files.agentsCsv).toBe(path.join(outputDir, "agents.csv"));
    expect(written.files.metricsCsv).toBe(path.join(outputDir, "metrics.csv"));
    expect(written.files.leaderboardCsv).toBe(path.join(outputDir, "leaderboard.csv"));
    await expectRequiredFiles(outputDir);
    const matchFiles = await readdir(path.join(outputDir, "matches"));
    expect(matchFiles.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    expect(matchFiles.filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
    expect(written.files.matches).toHaveLength(1);
    expect(written.files.matchesJsonl).toHaveLength(1);
    expect(written.files.matchesJsonl[0]).toMatch(/\.jsonl$/);

    const manifest = await readJson<Record<string, any>>(path.join(outputDir, "manifest.json"));
    expect(manifest).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament",
      experimentId: "writer-layout",
      seed: "writer-truncated",
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesFailed: 0,
      gamesHarnessCompleted: 0,
      gamesTruncated: 1,
      gamesHarnessFailed: 0,
      collisionPolicy: "fail-if-exists",
      evaluationWarningCount: 1,
      evaluationWarningSeverityCounts: { info: 0, warning: 1 },
      evaluationWarningCodes: ["test.warning"],
      evaluationWarningSummary: expect.objectContaining({
        warningCount: 1,
        warningCodes: [
          expect.objectContaining({
            code: "test.warning",
            severity: "warning",
            count: 1,
            evaluatorIds: [WEREWOLF_OUTCOME_EVALUATOR_ID],
            metricIds: ["agent.reward"]
          })
        ]
      }),
      evaluationCoverage: {
        evaluationReportCount: 1,
        evaluationCompletedEpisodes: 0,
        evaluationIncompleteEpisodes: 1,
        evaluatorFailureCount: 1
      },
      artifactIntegrityOkCount: 1,
      artifactIntegrityErrorCount: 0,
      artifactIntegrityErroredMatchCount: 0,
      matchCount: 1,
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      metricCount: expect.any(Number),
      scorecardEligibleMetricCount: expect.any(Number),
      metricPromotionClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      scorecardEligibleMetricClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      })
    });
    expect(manifest.statusCounts.truncated).toBe(1);
    expect(manifest.files.specNormalized).toBe("spec.normalized.json");
    expect(manifest.files.assignment).toBe("assignment.json");
    expect(manifest.files.costLatency).toBe("cost_latency.json");
    expect(manifest.files.benchmarkStatistics).toBe("benchmark_statistics.json");
    expect(manifest.files.tournamentComparison).toBe("tournament_comparison.json");
    expect(manifest.files.tournamentComparisonMarkdown).toBe("tournament_comparison.md");
    const tournamentComparison = await readJson<Record<string, any>>(path.join(outputDir, "tournament_comparison.json"));
    expect(tournamentComparison).toMatchObject({
      artifactVersion: "harness.tournament-comparison.v1",
      kind: "tournament-comparison",
      tournamentSeed: "writer-truncated",
      gamesRequested: 1,
      artifactMatchCount: 1,
      pairCount: 0
    });
    expect(tournamentComparison.comparisonSetId).toMatch(/^tournament-comparison:[a-f0-9]{24}$/);
    expect(manifest.files.integrity).toBe("integrity.jsonl");
    expect(manifest.files.summaryMarkdown).toBe("summary.md");
    expect(manifest.files.episodesCsv).toBe("episodes.csv");
    expect(manifest.files.agentsCsv).toBe("agents.csv");
    expect(manifest.files.metricsCsv).toBe("metrics.csv");
    expect(manifest.files.leaderboardCsv).toBe("leaderboard.csv");
    expect(manifest.files.matches).toHaveLength(1);
    expect(manifest.files.matchesJsonl).toHaveLength(1);
    expect(manifest.files.matchesJsonl[0]).toMatch(/^matches\/.+\.jsonl$/);
    expect(manifest.matches[0]).toMatchObject({
      evaluationStatus: "incomplete",
      evaluatorFailureCount: 1,
      evaluationWarningCount: 1,
      evaluationWarningCodes: ["test.warning"],
      integrityOk: true,
      integrityErrorCount: 0,
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      path: expect.stringMatching(/^matches\/.+\.json$/),
      jsonlPath: expect.stringMatching(/^matches\/.+\.jsonl$/)
    });
    expect(Object.values(manifest.files).flat().every((file) => typeof file !== "string" || !path.isAbsolute(file))).toBe(true);

    const summaryMarkdown = await readFile(path.join(outputDir, "summary.md"), "utf8");
    expect(summaryMarkdown).toContain("# Tournament Summary: writer-layout");
    expect(summaryMarkdown).toContain("- Seed: writer-truncated");
    expect(summaryMarkdown).toContain("- Native steps: 0");
    expect(summaryMarkdown).toContain("- Committed steps: 0");
    expect(summaryMarkdown).toContain("- Rejected steps: 0");
    expect(summaryMarkdown).toContain("- Metric rows:");
    expect(summaryMarkdown).toContain("- Scorecard-eligible metric rows:");
    expect(summaryMarkdown).toContain("## Metric Promotion");
    expect(summaryMarkdown).toContain("| promotion_class | rows | scorecard_eligible_rows |");
    expect(summaryMarkdown).toContain("| model | seat_games | seat_wins | win_rate | avg_reward | turns | errors | native | committed | rejected |");
    expect(summaryMarkdown).toContain("| profile | model | policy | seat_games | seat_wins | win_rate | avg_reward | native | committed | rejected |");
    expect(summaryMarkdown).toContain("## Interpretation Policy");
    expect(summaryMarkdown).toContain("does not make model superiority");

    const episodesCsv = await readFile(path.join(outputDir, "episodes.csv"), "utf8");
    expect(episodesCsv).toMatch(
      /^tournament_seed,episode_index,episode_seed,run_id,match_id,status,harness_status,winner,phase,day,native_steps,committed_steps,rejected_steps,trajectory_steps,message_count,metric_count,scorecard_eligible_metric_count,scorecard_metric_count,diagnostic_metric_count,benchmark_only_metric_count,/
    );
    expect(episodesCsv).toContain("writer-truncated,0,writer-truncated:g1");
    expect(episodesCsv).toContain(",truncated,truncated,");
    expect(episodesCsv).toContain("matches/");

    const agentsCsv = await readFile(path.join(outputDir, "agents.csv"), "utf8");
    expect(agentsCsv).toMatch(/^tournament_seed,episode_index,episode_seed,run_id,match_id,status,harness_status,player_id,seat,/);
    expect(agentsCsv).toContain("reward,native_steps,committed_steps,rejected_steps");
    expect(agentsCsv.trim().split("\n")).toHaveLength(result.episodes[0].agents.length + 1);
    expect(agentsCsv).toContain(",alpha,");

    const metricsCsv = await readFile(path.join(outputDir, "metrics.csv"), "utf8");
    expect(metricsCsv).toMatch(/^tournament_seed,episode_index,episode_seed,run_id,match_id,status,harness_status,metric_id,label,/);
    expect(metricsCsv).toContain(
      "evidence_ref_count,promotion_class,scorecard_eligible,promotion_reasons,promotion_decision_id,metadata,promotion_policy_id,promotion_policy_version,promotion_policy_hash,promotion_catalog_id,promotion_catalog_version,promotion_catalog_hash,promotion_resolution"
    );
    expect(metricsCsv).not.toContain("agent.reward");
    expect(metricsCsv).toContain(WEREWOLF_OUTCOME_EVALUATOR_ID);
    expect(metricsCsv).toMatch(/episode\.completed_with_winner,.*,scorecard,/);

    const leaderboardCsv = await readFile(path.join(outputDir, "leaderboard.csv"), "utf8");
    expect(leaderboardCsv).toMatch(
      /^subject_type,subject_id,model,profile_id,policy_name,seat_games,seat_wins,win_rate,village_seat_games,village_seat_wins,werewolf_seat_games,werewolf_seat_wins,harness_turns,harness_errors,native_steps,committed_steps,rejected_steps,/
    );
    expect(leaderboardCsv).toContain("model,alpha,alpha,");

    const episodes = await readJsonl<Record<string, any>>(path.join(outputDir, "episodes.jsonl"));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      type: "episode",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      status: "truncated",
      harnessStatus: "truncated",
      seed: "writer-truncated:g1",
      evaluationWarningCount: 1,
      evaluationStatus: "incomplete",
      evaluatorFailureCount: 1,
      evaluationWarningCodes: ["test.warning"],
      warningSummary: expect.objectContaining({
        warningCount: 1,
        warningCodes: [expect.objectContaining({ code: "test.warning", count: 1 })]
      }),
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      trajectorySteps: 0,
      metricCount: expect.any(Number),
      scorecardEligibleMetricCount: expect.any(Number),
      metricPromotionClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      scorecardEligibleMetricClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      })
    });
    expect(episodes[0].matchArtifact).toMatch(/^matches\/.+\.json$/);
    expect(episodes[0].matchJsonl).toMatch(/^matches\/.+\.jsonl$/);
    expect(Array.isArray(episodes[0].agents)).toBe(true);
    expect(episodes[0].agents.length).toBeGreaterThan(0);
    const evaluatorFailures = await readJsonl<Record<string, any>>(path.join(outputDir, "failures.jsonl"));
    expect(evaluatorFailures).toEqual([
      expect.objectContaining({
        type: "evaluation_failure",
        status: "truncated",
        harnessStatus: "truncated",
        evaluationStatus: "incomplete",
        evaluatorFailure: testEvaluatorFailure
      })
    ]);
    for (const agent of episodes[0].agents) {
      expect(agent).toMatchObject({
        playerId: expect.any(String),
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      });
    }

    const matchArtifact = await readJson<Record<string, any>>(path.join(outputDir, episodes[0].matchArtifact));
    expect(matchArtifact.status).toBe("truncated");
    expect(matchArtifact.truncationReason).toContain("maxTransitions 0");
    expect(matchArtifact.failureReason).toBeUndefined();

    const matchJsonl = await readJsonl<Record<string, any>>(path.join(outputDir, episodes[0].matchJsonl));
    const matchHeader = matchJsonl.find((record) => record.type === "header");
    expect(matchHeader).toMatchObject({
      artifactVersion: "harness.match.v2",
      kind: "match",
      runId: matchArtifact.runId,
      matchId: matchArtifact.matchId,
      status: "truncated"
    });
    expect(matchHeader).not.toHaveProperty("tournamentEpisodeIndex");

    const trajectory = await readJsonl<Record<string, any>>(path.join(outputDir, "trajectory.jsonl"));
    const header = trajectory.find((record) => record.type === "header");
    expect(header).toMatchObject({
      runId: matchHeader?.runId,
      matchId: matchHeader?.matchId,
      status: "truncated",
      tournamentEpisodeIndex: 0,
      episodeIndex: 0,
      tournamentSeed: "writer-truncated",
      episodeSeed: "writer-truncated:g1"
    });
    expect(header?.truncationReason).toContain("maxTransitions 0");

    const metrics = await readJsonl<Record<string, any>>(path.join(outputDir, "metrics.jsonl"));
    expect(metrics.every((metric) => !("warnings" in metric) && !("warningSummary" in metric))).toBe(true);
    expect(metrics.map((metric) => metric.id)).toEqual(
      expect.arrayContaining([
        "episode.completed_with_winner",
        "agent.survival_rate",
        "agent.social.memory_count",
        "agent.social.commitment_status_temporal_association_count",
        "agent.social.coalition_lifecycle_temporal_association_count",
        "agent.social.coordination_message_count"
      ])
    );
    const rewardMetricIds = new Set(["team.reward", "agent.reward", "profile.agent_reward", "model.agent_reward"]);
    expect(metrics.filter((metric) => rewardMetricIds.has(String(metric.id)))).toEqual([]);
    const betrayalMetricIds = new Set<string>(BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS);
    const betrayalMetrics = metrics.filter((metric) => betrayalMetricIds.has(String(metric.id)));
    expect(betrayalMetrics.every((metric) => (metric.weight ?? 0) === 0)).toBe(true);
    expect(metrics.every((metric) => metric.episodeIndex === 0 && metric.tournamentEpisodeIndex === 0 && metric.tournamentSeed === "writer-truncated")).toBe(true);
    expect(metrics.find((metric) => metric.id === "episode.completed_with_winner")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: WEREWOLF_OUTCOME_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      value: 0,
      confidence: expect.any(Number),
      aggregation: expect.any(String),
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "event" })]),
      promotionClass: "scorecard",
      scorecardEligible: true,
      promotionReasons: expect.arrayContaining([expect.any(String)]),
      promotionDecisionId: expect.any(String),
      promotionPolicyId: "evaluation.metric-promotion.v1",
      promotionCatalogId: "werewolf.metric-promotion.catalog.v1",
      promotionResolution: "recorded"
    });
    expect(metrics.find((metric) => metric.id === "agent.survival_rate")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), role: expect.any(String), team: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "ratio",
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "event" })]),
      promotionClass: "diagnostic",
      scorecardEligible: false,
      promotionReasons: expect.arrayContaining([expect.any(String)])
    });
    expect(metrics.find((metric) => metric.id === "agent.social.memory_count")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: SOCIAL_STATE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      evidenceRefs: [expect.objectContaining({ artifact: "agent_state", id: expect.any(String) })],
      promotionClass: "diagnostic",
      scorecardEligible: false,
      promotionReasons: expect.arrayContaining([expect.any(String)])
    });
    expect(metrics.find((metric) => metric.id === "agent.social.commitment_status_temporal_association_count")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: 1,
      aggregation: "sum",
      weight: 0,
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "agent_state", id: expect.any(String) })]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "commitment_status_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation"
      })
    });
    expect(metrics.find((metric) => metric.id === "agent.social.coalition_lifecycle_temporal_association_count")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: 1,
      aggregation: "sum",
      weight: 0,
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "agent_state", id: expect.any(String) })]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "coalition_lifecycle_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation"
      })
    });
    expect(metrics.find((metric) => metric.id === "agent.social.commitment_speech_act_ingest_link_count")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      weight: 0,
      evidenceRefs: expect.any(Array),
      metadata: expect.objectContaining({
        candidateKind: "commitment",
        coverageLevel: "explicit_scoped_exposure_to_social_state_mutation",
        causalClaim: false
      })
    });
    expect(metrics.find((metric) => metric.id === "agent.social.coordination_message_count")).toMatchObject({
      type: "metric",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-truncated",
      evaluatorId: SOCIAL_DYNAMICS_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      evidenceRefs: expect.any(Array)
    });

    const integrity = await readJsonl<Record<string, any>>(path.join(outputDir, "integrity.jsonl"));
    expect(integrity).toEqual([
      expect.objectContaining({
        type: "artifact_integrity",
        episodeIndex: 0,
        tournamentEpisodeIndex: 0,
        tournamentSeed: "writer-truncated",
        episodeSeed: "writer-truncated:g1",
        runId: matchArtifact.runId,
        matchId: matchArtifact.matchId,
        status: "truncated",
        ok: true,
        errorCount: 0,
        errors: [],
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0,
        matchArtifact: expect.stringMatching(/^matches\/.+\.json$/),
        matchJsonl: expect.stringMatching(/^matches\/.+\.jsonl$/)
      })
    ]);

    const registry = await readJson<Record<string, any>>(path.join(outputDir, "registry.json"));
    expect(registry).toMatchObject({
      kind: "evaluator-registry-snapshot",
      metricPromotionPolicyId: "evaluation.metric-promotion.v1",
      metricPromotionCatalogId: "werewolf.metric-promotion.catalog.v1",
      metricPromotionPolicyVersion: expect.any(String),
      metricPromotionPolicyHash: expect.any(String),
      metricPromotionCatalogVersion: expect.any(String),
      metricPromotionCatalogHash: expect.any(String),
      mixedMetricPromotionPolicies: false,
      metricPromotionPolicies: [
        expect.objectContaining({
          policyId: "evaluation.metric-promotion.v1",
          catalogId: "werewolf.metric-promotion.catalog.v1"
        })
      ],
      metricCount: expect.any(Number),
      scorecardEligibleMetricCount: expect.any(Number),
      metricPromotionClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      scorecardEligibleMetricClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      metricPromotionCatalog: expect.objectContaining({
        catalogId: "werewolf.metric-promotion.catalog.v1",
        entryCount: expect.any(Number),
        ruleCount: expect.any(Number)
      })
    });
    expect(registry.reports[0]).toMatchObject({
      warnings: [expect.objectContaining({ code: "test.warning", severity: "warning", evaluatorId: WEREWOLF_OUTCOME_EVALUATOR_ID })],
      warningSummary: expect.objectContaining({
        warningCount: 1,
        warningCodes: [expect.objectContaining({ code: "test.warning", severity: "warning", count: 1 })]
      })
    });
    expect(registry.evaluatorIds).toEqual(
      expect.arrayContaining([
        BENCHMARK_STATISTICS_EVALUATOR_ID,
        WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
        WEREWOLF_OUTCOME_EVALUATOR_ID,
        WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID,
        WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
        WEREWOLF_INFLUENCE_EVALUATOR_ID,
        WEREWOLF_DECEPTION_EVALUATOR_ID,
        WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
        SOCIAL_STATE_EVALUATOR_ID,
        COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
        COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
        DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
        SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
        SOCIAL_DYNAMICS_EVALUATOR_ID
      ])
    );
    expect(registry.evaluators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: BENCHMARK_STATISTICS_EVALUATOR_ID,
          label: "Benchmark statistics run-set evaluator",
          version: BENCHMARK_STATISTICS_EVALUATOR_VERSION,
          inputSchema: "harness.tournament-result.v1",
          outputSchema: BENCHMARK_STATISTICS_VERSION,
          mode: "deterministic",
          metricIds: expect.arrayContaining(["benchmark.status_denominators", "benchmark.agent_seat_strata"]),
          aggregation: "run_set_denominators_and_strata",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
          label: "Werewolf adversarial summary evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.adversarial.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_ADVERSARIAL_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "compatibility_output",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_OUTCOME_EVALUATOR_ID,
          label: "Werewolf outcome and reward evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.outcome.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_OUTCOME_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "weighted_reward_summary",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
          label: "Werewolf role survival evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.role-survival.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "survival_rate_by_agent_and_role",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
          label: "Werewolf social calibration evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.social-calibration.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "postgame_calibration_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: SOCIAL_STATE_EVALUATOR_ID,
          label: "Social state evaluator",
          version: "1.0.0",
          inputSchema: "harness.social-state.evaluation-context.v1",
          outputSchema: "harness.social-state.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_STATE_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "agent_social_state_summary",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
          label: "Commitment-coalition association evaluator",
          version: "1.0.0",
          inputSchema: "harness.commitment-coalition-association.evaluation-context.v1",
          outputSchema: "harness.commitment-coalition-association.summary.v1",
          mode: "deterministic",
          metricIds: COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            socialState: "AgentSocialState.commitments, AgentSocialState.coalitions, and evidence-backed social-state records"
          },
          aggregation: "zero_weight_commitment_coalition_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Commitment-coalition lifecycle temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.commitment-coalition-lifecycle-temporal-association.evaluation-context.v1",
          outputSchema: "harness.commitment-coalition-lifecycle-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
            socialState: "AgentSocialState.commitments and AgentSocialState.coalitions for record denominators"
          },
          aggregation: "zero_weight_commitment_coalition_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_norm_sanction_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_gossip_exposure_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_trust_repair_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_trust_repair_relationship_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_trust_repair_reputation_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_betrayal_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
          metricIds: DECEPTION_BELIEF_SHIFT_METRIC_IDS,
          aggregation: "zero_weight_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
          metricIds: DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
          aggregation: "zero_weight_reputation_temporal_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
          label: "Social fact ingest evidence evaluator",
          version: "1.0.0",
          inputSchema: "harness.social-fact-ingest-evidence.evaluation-context.v1",
          outputSchema: "harness.social-fact-ingest-evidence.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            socialEpisode: "SocialEpisodeArtifact.messages and scoped SocialExposureRecord records from actor observations",
            mutationJournal:
              "AgentSocialState.journal.entries with store/mutationKind, messageSeqRange, safe provenance metadata, hiddenTruthUsed=false, and evidenceRefs",
            socialState: "AgentSocialState commitments, coalitions, relationships, and reputation records for mutation evidence"
          },
          aggregation: "zero_weight_social_fact_ingest_evidence_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: SOCIAL_DYNAMICS_EVALUATOR_ID,
          label: "Social dynamics evaluator",
          version: "1.0.0",
          inputSchema: "harness.social-dynamics.evaluation-context.v1",
          outputSchema: "harness.social-dynamics.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_DYNAMICS_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "agent_social_dynamics_summary",
          visibility: "postgame"
        })
      ])
    );
    expect(registry.reports[0].evaluatorRegistry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: WEREWOLF_ADVERSARIAL_EVALUATOR_ID, metricIds: WEREWOLF_ADVERSARIAL_METRIC_IDS }),
        expect.objectContaining({ id: WEREWOLF_OUTCOME_EVALUATOR_ID, metricIds: WEREWOLF_OUTCOME_METRIC_IDS }),
        expect.objectContaining({ id: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID, metricIds: WEREWOLF_ROLE_SURVIVAL_METRIC_IDS }),
        expect.objectContaining({ id: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID, metricIds: WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS }),
        expect.objectContaining({ id: SOCIAL_STATE_EVALUATOR_ID, metricIds: SOCIAL_STATE_METRIC_IDS }),
        expect.objectContaining({ id: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID, metricIds: COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS }),
        expect.objectContaining({
          id: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({
          id: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({
          id: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({
          id: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({
          id: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({
          id: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({
          id: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          metricIds: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({ id: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID, metricIds: DECEPTION_BELIEF_SHIFT_METRIC_IDS }),
        expect.objectContaining({
          id: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
          metricIds: DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS
        }),
        expect.objectContaining({ id: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID, metricIds: SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS }),
        expect.objectContaining({ id: SOCIAL_DYNAMICS_EVALUATOR_ID, metricIds: SOCIAL_DYNAMICS_METRIC_IDS })
      ])
    );
    expect(registry.reports[0].evaluatorIds).toEqual(
      expect.arrayContaining([BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID])
    );
    expect(registry.reports[0].evaluatorRegistry.map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining([BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID])
    );

    const specNormalized = await readJson<Record<string, any>>(path.join(outputDir, "spec.normalized.json"));
    expect(specNormalized).toEqual(JSON.parse(JSON.stringify(result.experiment)));
    expect(normalizeTournamentExperimentSpec(specNormalized)).toMatchObject({
      seed: "writer-truncated",
      models: result.models,
      profiles: result.profiles,
      games: 1,
      maxTransitions: 0
    });

    const assignment = await readJson<Record<string, any>>(path.join(outputDir, "assignment.json"));
    const firstAssignment = result.episodes[0].resolvedAssignments[0];
    expect(assignment).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament-assignment",
      seed: "writer-truncated",
      models: result.models,
      profiles: result.profiles,
      assignment: result.assignment,
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesFailed: 0,
      gamesTruncated: 1
    });
    expect(assignment.episodes).toHaveLength(1);
    expect(assignment.episodes[0]).toMatchObject({
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      seed: "writer-truncated:g1",
      status: "truncated",
      harnessStatus: "truncated",
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      matchArtifact: expect.stringMatching(/^matches\/.+\.json$/),
      matchJsonl: expect.stringMatching(/^matches\/.+\.jsonl$/),
      resolvedAssignments: expect.any(Array),
      agents: expect.any(Array)
    });
    expect(assignment.episodes[0].resolvedAssignments).toHaveLength(result.episodes[0].resolvedAssignments.length);
    expect(assignment.episodes[0].agents).toHaveLength(result.episodes[0].agents.length);
    expect(assignment.episodes[0].agents[0]).toMatchObject({
      playerId: firstAssignment.playerId,
      seat: firstAssignment.seat,
      profileId: firstAssignment.profileId,
      model: firstAssignment.model,
      temperature: firstAssignment.temperature,
      role: firstAssignment.role,
      team: firstAssignment.team,
      nativeSteps: expect.any(Number),
      committedSteps: expect.any(Number),
      rejectedSteps: expect.any(Number)
    });

    const leaderboard = await readJson<Record<string, any>>(path.join(outputDir, "leaderboard.json"));
    const benchmarkStatistics = await readJson<Record<string, any>>(path.join(outputDir, "benchmark_statistics.json"));
    expect(leaderboard).toMatchObject({
      kind: "tournament-leaderboard",
      metricCount: expect.any(Number),
      scorecardEligibleMetricCount: expect.any(Number),
      metricPromotionClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      scorecardEligibleMetricClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      })
    });
    expect(leaderboard.modelStats).toEqual(result.modelStats);
    expect(leaderboard.profileStats).toEqual(result.profileStats);
    for (const stats of Object.values(leaderboard.modelStats) as Array<Record<string, unknown>>) {
      expect(stats).toMatchObject({
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      });
      expect(stats.nativeSteps).toBe((stats.committedSteps as number) + (stats.rejectedSteps as number));
    }
    for (const stats of Object.values(leaderboard.profileStats) as Array<Record<string, unknown>>) {
      expect(stats).toMatchObject({
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      });
      expect(stats.nativeSteps).toBe((stats.committedSteps as number) + (stats.rejectedSteps as number));
    }
    expect(leaderboard.benchmarkStatistics).toEqual(benchmarkStatistics);
    expect(benchmarkStatistics).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament-benchmark-statistics",
      schemaVersion: BENCHMARK_STATISTICS_VERSION,
      evaluatorId: BENCHMARK_STATISTICS_EVALUATOR_ID,
      evaluatorVersion: BENCHMARK_STATISTICS_EVALUATOR_VERSION,
      experimentSpecHash: expect.any(String),
      visibility: "postgame",
      metricPromotionPolicyId: "evaluation.metric-promotion.v1",
      metricPromotionCatalogId: "werewolf.metric-promotion.catalog.v1",
      metricPromotionPolicyHash: expect.any(String),
      metricPromotionCatalogHash: expect.any(String),
      mixedMetricPromotionPolicies: false,
      metricCount: expect.any(Number),
      scorecardEligibleMetricCount: expect.any(Number),
      metricPromotionClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      scorecardEligibleMetricClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      inputArtifacts: expect.arrayContaining(["spec.normalized.json", "assignment.json", "episodes.jsonl", "integrity.jsonl", "matches/*.json"])
    });
    expect(benchmarkStatistics.inputArtifacts).not.toContain("leaderboard.json");
    expect(leaderboard.benchmarkStatistics).toMatchObject({
      schemaVersion: BENCHMARK_STATISTICS_VERSION,
      benchmarkId: "writer-truncated",
      runSetId: "writer-truncated:requested=1:scheduled=1",
      denominatorPolicy: {
        requestedEpisodes: "All requested tournament episodes, including unscheduled episodes after an early stop.",
        scheduledEpisodes: "Episodes present in TournamentResult.episodes.",
        completedOnlyAggregates: "Existing modelStats and profileStats aggregate only episodes with episode.status === completed.",
        failedEpisodes: "Harness and pre-harness failures remain in status denominators and failure artifacts, not in completed-only reward averages.",
        superiorityClaims: false
      },
      statusDenominators: {
        gamesRequested: 1,
        episodesScheduled: 1,
        episodesUnscheduled: 0,
        gamesCompleted: 0,
        gamesTruncated: 1,
        gamesFailed: 0,
        artifactCount: 1,
        matchArtifactCount: 1,
        completedWithEvaluation: 0,
        completedWithEvaluationReport: 0,
        truncatedWithArtifact: 1,
        truncatedWithEvaluation: 1,
        truncatedWithEvaluationReport: 1,
        failedWithArtifact: 0,
        preHarnessFailures: 0,
        harnessStatusCounts: expect.objectContaining({
          completed: 0,
          truncated: 1,
          failed: 0,
          tournamentFailed: 0
        }),
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      }
    });
    expect(leaderboard.benchmarkStatistics.stratificationDimensions).toEqual([
      "model",
      "profile",
      "role",
      "team",
      "seat",
      "episodeStatus",
      "harnessStatus"
    ]);
    expect(leaderboard.benchmarkStatistics.seedLedger).toEqual([
      expect.objectContaining({
        episodeIndex: 0,
        seed: "writer-truncated:g1",
        status: "truncated",
        harnessStatus: "truncated",
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      })
    ]);
    expect(Object.values(leaderboard.benchmarkStatistics.strata.byModel).reduce((sum: number, stats: any) => sum + stats.scheduledSeatCount, 0)).toBe(9);
    expect(Object.values(leaderboard.benchmarkStatistics.strata.byRole).reduce((sum: number, stats: any) => sum + stats.scheduledSeatCount, 0)).toBe(9);
    for (const stats of Object.values(leaderboard.benchmarkStatistics.strata.byModel) as Array<Record<string, unknown>>) {
      expect(stats).toMatchObject({
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      });
    }
    for (const stats of Object.values(leaderboard.benchmarkStatistics.strata.byProfile ?? {}) as Array<Record<string, unknown>>) {
      expect(stats).toMatchObject({
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      });
    }
    expect(leaderboard.benchmarkStatistics.strata.byTeam.village.scheduledSeatCount).toBeGreaterThan(0);
    expect(leaderboard.benchmarkStatistics.strata.byTeam.werewolves.scheduledSeatCount).toBeGreaterThan(0);
    expect(leaderboard.benchmarkStatistics.strata.bySeat["1"]).toMatchObject({
      dimension: "seat",
      key: "1",
      scheduledSeatCount: 1,
      completedSeatCount: 0,
      truncatedSeatCount: 1,
      failedSeatCount: 0,
      nativeSteps: expect.any(Number),
      committedSteps: expect.any(Number),
      rejectedSteps: expect.any(Number),
      episodeIndexes: [0]
    });
    expect(leaderboard.benchmarkStatistics.strata.byEpisodeStatus.truncated).toMatchObject({
      dimension: "episodeStatus",
      key: "truncated",
      episodeCount: 1,
      completedCount: 0,
      truncatedCount: 1,
      failedCount: 0,
      artifactCount: 1,
      evaluationReportCount: 1,
      nativeSteps: expect.any(Number),
      committedSteps: expect.any(Number),
      rejectedSteps: expect.any(Number)
    });
    expect(leaderboard.benchmarkStatistics.strata.byHarnessStatus.truncated).toMatchObject({
      dimension: "harnessStatus",
      key: "truncated",
      episodeCount: 1,
      completedCount: 0,
      truncatedCount: 1,
      failedCount: 0,
      artifactCount: 1,
      evaluationReportCount: 1,
      nativeSteps: expect.any(Number),
      committedSteps: expect.any(Number),
      rejectedSteps: expect.any(Number)
    });
  });

  it("writes multi-episode tournament comparison pairs from recorded match artifacts", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 2,
      seed: "writer-multi-compare",
      reasoner: deterministicReasoner,
      maxTransitions: 0,
      includeArtifacts: true
    });
    const written = await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-multi-compare",
      createdAt: "2026-01-02T03:04:05.000Z"
    });
    expect(written.files.tournamentComparison).toBe(path.join(outputDir, "tournament_comparison.json"));
    expect(written.files.tournamentComparisonMarkdown).toBe(path.join(outputDir, "tournament_comparison.md"));
    const tournamentComparison = await readJson<Record<string, any>>(path.join(outputDir, "tournament_comparison.json"));
    expect(tournamentComparison).toMatchObject({
      artifactVersion: "harness.tournament-comparison.v1",
      kind: "tournament-comparison",
      tournamentSeed: "writer-multi-compare",
      gamesRequested: 2,
      artifactMatchCount: 2,
      pairCount: 1
    });
    expect(tournamentComparison.pairs).toEqual([
      expect.objectContaining({
        baseline: expect.objectContaining({ episodeIndex: 0 }),
        candidate: expect.objectContaining({ episodeIndex: 1 }),
        comparisonId: expect.stringMatching(/^match-comparison:[a-f0-9]{24}$/i)
      })
    ]);
    expect(tournamentComparison.summary.pairIdentityHash).toEqual(expect.any(String));
    expect(JSON.stringify(tournamentComparison)).not.toContain(outputDir);
    const tournamentComparisonMarkdown = await readFile(path.join(outputDir, "tournament_comparison.md"), "utf8");
    expect(tournamentComparisonMarkdown).toContain("# Tournament Comparison");
    expect(tournamentComparisonMarkdown).toContain(tournamentComparison.comparisonSetId);
    expect(tournamentComparisonMarkdown).toContain("pairs=1");
    expect(tournamentComparisonMarkdown).not.toContain(outputDir);
  }, 20_000);

  it("does not misrepresent the first report policy as tournament-wide when reports use mixed promotion policies", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 2,
      seed: "writer-mixed-promotion",
      reasoner: deterministicReasoner,
      maxTransitions: 0,
      includeArtifacts: true
    });
    const secondEpisode = result.episodes[1];
    if (!secondEpisode?.evaluationReport) throw new Error("Expected a second evaluation report.");
    replacePromotionIdentityForEpisode(result, secondEpisode.index, {
      policyId: "alternate.metric-promotion.v1",
      policyVersion: "2.0.0",
      policyHash: "alternate-policy-hash",
      catalogId: "alternate.metric-promotion.catalog.v1",
      catalogVersion: "2.0.0",
      catalogHash: "alternate-catalog-hash",
      catalogDomainId: "alternate-domain"
    });

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-mixed-promotion",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const registry = await readJson<Record<string, unknown>>(path.join(outputDir, "registry.json"));
    const benchmark = await readJson<Record<string, unknown>>(path.join(outputDir, "benchmark_statistics.json"));
    for (const output of [registry, benchmark]) {
      expect(output).toMatchObject({
        mixedMetricPromotionPolicies: true,
        metricPromotionPolicyId: null,
        metricPromotionPolicyVersion: null,
        metricPromotionPolicyHash: null,
        metricPromotionCatalogId: null,
        metricPromotionCatalogVersion: null,
        metricPromotionCatalogHash: null,
        metricPromotionCatalogDomainId: null,
        metricPromotionCatalog: null
      });
      expect(output.metricPromotionPolicies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ catalogId: "werewolf.metric-promotion.catalog.v1" }),
          expect.objectContaining({ catalogId: "alternate.metric-promotion.catalog.v1" })
        ])
      );
    }

    const metricCatalogIds = new Set(
      (await readFile(path.join(outputDir, "metrics.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { promotionCatalogId?: string | null })
        .map((row) => row.promotionCatalogId)
        .filter((id): id is string => typeof id === "string")
    );
    expect([...metricCatalogIds]).toEqual(
      expect.arrayContaining(["werewolf.metric-promotion.catalog.v1", "alternate.metric-promotion.catalog.v1"])
    );
  }, 20_000);

  it("writes a minimal allowlisted public pack from a domain-owned observation projector", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 1,
      seed: "writer-public-pack",
      reasoner: deterministicReasoner,
      maxTransitions: 1,
      includeArtifacts: true
    });
    expect(result.artifacts?.length).toBe(1);
    const fullArtifact = result.artifacts![0].artifact;
    expect(fullArtifact.finalState.players.some((player) => Boolean(player.role))).toBe(true);

    const written = await writeTournamentArtifactDirectory(result, {
      outputDir,
      createdAt: "2026-01-02T03:04:05.000Z",
      visibility: "public",
      projectPublicMatchArtifact: (artifact, episodeIndex) => {
        const publicEvents = artifact.events
          .filter((event) => event.visibility === "public")
          .map((event) => ({ seq: event.seq, day: event.day, type: event.type }));
        return {
          artifactVersion: "harness.match.public.v1",
          kind: "public-match",
          episodeIndex,
          status: artifact.status,
          state: {
            phase: artifact.finalState.phase,
            day: artifact.finalState.day,
            players: artifact.finalState.players.map((player) => ({
              seat: player.seat,
              name: player.name,
              alive: player.alive,
              isSheriff: player.isSheriff,
              ...(player.eliminatedAt
                ? {
                    eliminatedAt: {
                      day: player.eliminatedAt.day,
                      reason: player.eliminatedAt.reason
                    }
                  }
                : {})
            })),
            pendingActionCount: 0,
            publicEventCount: publicEvents.length
          },
          events: publicEvents,
          messages: []
        };
      }
    });

    const manifest = await readJson<Record<string, any>>(path.join(outputDir, "manifest.json"));
    expect(written.files).toEqual({
      manifest: path.join(outputDir, "manifest.json"),
      episodes: path.join(outputDir, "episodes.jsonl"),
      matchesDir: path.join(outputDir, "matches"),
      matches: [path.join(outputDir, "matches", "episode-1.json")]
    });
    expect((await readdir(outputDir)).sort()).toEqual(["episodes.jsonl", "manifest.json", "matches"]);
    expect(await readdir(path.join(outputDir, "matches"))).toEqual(["episode-1.json"]);
    expect(manifest).toEqual({
      artifactVersion: "harness.tournament.public.v1",
      kind: "public-tournament",
      visibility: "public",
      createdAt: "2026-01-02T03:04:05.000Z",
      games: { requested: 1, completed: 0, truncated: 1, failed: 0 },
      files: {
        manifest: "manifest.json",
        episodes: "episodes.jsonl",
        matches: ["matches/episode-1.json"]
      }
    });

    const episodes = await readJsonl<Record<string, any>>(path.join(outputDir, "episodes.jsonl"));
    expect(episodes).toEqual([
      {
        kind: "public-episode",
        episodeIndex: 0,
        status: fullArtifact.status,
        match: "matches/episode-1.json",
        publicMessageCount: 0
      }
    ]);

    const matchPath = path.join(outputDir, manifest.files.matches[0]);
    const matchArtifact = await readJson<Record<string, any>>(matchPath);
    expect(Object.keys(matchArtifact).sort()).toEqual(["artifactVersion", "episodeIndex", "events", "kind", "messages", "state", "status"]);
    expect(matchArtifact).toMatchObject({
      artifactVersion: "harness.match.public.v1",
      kind: "public-match",
      episodeIndex: 0,
      state: {
        phase: expect.any(String),
        day: expect.any(Number),
        pendingActionCount: 0,
        publicEventCount: expect.any(Number),
        players: expect.any(Array)
      },
      events: expect.any(Array),
      messages: []
    });
    for (const player of matchArtifact.state.players) {
      expect(Object.keys(player).sort()).toEqual(expect.arrayContaining(["alive", "isSheriff", "name", "seat"]));
      expect(player).not.toHaveProperty("id");
      expect(player).not.toHaveProperty("role");
      expect(player).not.toHaveProperty("team");
      expect(player).not.toHaveProperty("ability");
    }
    for (const event of matchArtifact.events) {
      expect(Object.keys(event).sort()).toEqual(["day", "seq", "type"]);
    }
    const publicContents = await Promise.all(
      ["manifest.json", "episodes.jsonl", "matches/episode-1.json"].map((relativePath) =>
        readFile(path.join(outputDir, relativePath), "utf8")
      )
    );
    for (const forbidden of [
      result.seed,
      fullArtifact.seed,
      fullArtifact.runId,
      fullArtifact.matchId,
      ...result.profiles.flatMap((profile) => [profile.id, profile.policyName])
    ]) {
      expect(publicContents.join("\n")).not.toContain(forbidden);
    }
  });

  it("records corrupted match artifact integrity without inventing runtime failures", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 1,
      seed: "writer-integrity-error",
      reasoner: deterministicReasoner,
      maxTransitions: 0,
      includeArtifacts: true
    });
    const record = result.artifacts?.[0];
    if (!record) throw new Error("Expected a match artifact for integrity corruption test.");
    record.artifact.socialEpisode.status = "failed";
    const expectedIntegrityError = "socialEpisode.status mismatch: expected truncated, received failed.";

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-integrity-error",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const integrity = await readJsonl<Record<string, any>>(path.join(outputDir, "integrity.jsonl"));
    expect(integrity).toEqual([
      expect.objectContaining({
        type: "artifact_integrity",
        episodeIndex: 0,
        tournamentEpisodeIndex: 0,
        tournamentSeed: "writer-integrity-error",
        episodeSeed: "writer-integrity-error:g1",
        runId: record.runId,
        matchId: record.matchId,
        status: "truncated",
        ok: false,
        errorCount: 1,
        errors: [expectedIntegrityError],
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number),
        matchArtifact: expect.stringMatching(/^matches\/.+\.json$/),
        matchJsonl: expect.stringMatching(/^matches\/.+\.jsonl$/)
      })
    ]);

    const manifest = await readJson<Record<string, any>>(path.join(outputDir, "manifest.json"));
    expect(manifest).toMatchObject({
      matchCount: 1,
      gamesCompleted: 0,
      gamesFailed: 0,
      gamesTruncated: 1,
      artifactIntegrityOkCount: 0,
      artifactIntegrityErrorCount: 1,
      artifactIntegrityErroredMatchCount: 1,
      statusCounts: expect.objectContaining({
        truncated: 1
      }),
      matches: [
        expect.objectContaining({
          status: "truncated",
          integrityOk: false,
          integrityErrorCount: 1
        })
      ]
    });

    const failures = await readJsonl<Record<string, any>>(path.join(outputDir, "failures.jsonl"));
    expect(failures).toEqual([]);
  });

  it("preserves social exposure records in aggregate and per-match JSONL exports", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 1,
      seed: "writer-social-exposure",
      reasoner: deterministicReasoner,
      maxTransitions: 20,
      includeArtifacts: true
    });

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-social-exposure",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const episodes = await readJsonl<Record<string, any>>(path.join(outputDir, "episodes.jsonl"));
    const trajectory = await readJsonl<Record<string, any>>(path.join(outputDir, "trajectory.jsonl"));
    const metrics = await readJsonl<Record<string, any>>(path.join(outputDir, "metrics.jsonl"));
    const matchJsonl = await readJsonl<Record<string, any>>(path.join(outputDir, episodes[0].matchJsonl));
    const aggregateSocialSteps = trajectory.filter((record) => record.type === "social_step");
    const matchSocialSteps = matchJsonl.filter((record) => record.type === "social_step");
    const aggregateExposure = trajectory.filter((record) => record.type === "social_exposure");
    const matchExposure = matchJsonl.filter((record) => record.type === "social_exposure");
    const aggregateMutations = trajectory.filter((record) => record.type === "social_state_mutation");
    const matchMutations = matchJsonl.filter((record) => record.type === "social_state_mutation");

    expect(matchSocialSteps.length).toBeGreaterThan(0);
    expect(aggregateSocialSteps).toHaveLength(matchSocialSteps.length);
    expect(matchSocialSteps[0]).not.toHaveProperty("tournamentEpisodeIndex");
    expect(aggregateSocialSteps[0]).toMatchObject({
      type: "social_step",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-social-exposure",
      episodeSeed: "writer-social-exposure:g1",
      runId: matchSocialSteps[0].runId,
      matchId: matchSocialSteps[0].matchId,
      episodeId: matchSocialSteps[0].episodeId,
      traceId: matchSocialSteps[0].traceId,
      turnIndex: matchSocialSteps[0].turnIndex,
      actorId: matchSocialSteps[0].actorId,
      profileId: matchSocialSteps[0].profileId,
      schedulerMode: matchSocialSteps[0].schedulerMode,
      resolutionPolicy: matchSocialSteps[0].resolutionPolicy,
      pendingAction: matchSocialSteps[0].pendingAction,
      action: matchSocialSteps[0].action,
      decisionStateHash: matchSocialSteps[0].decisionStateHash,
      preStateHash: matchSocialSteps[0].preStateHash,
      postStateHash: matchSocialSteps[0].postStateHash,
      eventSeqRange: matchSocialSteps[0].eventSeqRange,
      messageSeqRange: matchSocialSteps[0].messageSeqRange
    });
    expect(aggregateSocialSteps.some((record) => record.schedulerMode === "aec-batched-decision" && record.batchId)).toBe(true);
    expect(matchExposure.length).toBeGreaterThan(0);
    expect(aggregateExposure).toHaveLength(matchExposure.length);
    expect(matchExposure[0]).not.toHaveProperty("tournamentEpisodeIndex");
    expect(aggregateExposure[0]).toMatchObject({
      type: "social_exposure",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-social-exposure",
      episodeSeed: "writer-social-exposure:g1",
      runId: matchExposure[0].runId,
      matchId: matchExposure[0].matchId,
      messageId: matchExposure[0].messageId,
      messageSeq: matchExposure[0].messageSeq,
      sourceId: matchExposure[0].sourceId,
      observerId: matchExposure[0].observerId,
      observedAtTraceId: matchExposure[0].observedAtTraceId,
      observedAtTurnIndex: matchExposure[0].observedAtTurnIndex,
      observedAtActionKind: matchExposure[0].observedAtActionKind,
      channelId: matchExposure[0].channelId,
      visibility: matchExposure[0].visibility,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: matchExposure[0].messageId }),
        expect.objectContaining({ artifact: "trace", traceId: matchExposure[0].observedAtTraceId }),
        expect.objectContaining({ artifact: "observation", traceId: matchExposure[0].observedAtTraceId })
      ])
    });
    expect(aggregateExposure.some((record) => record.visibility === "public" && record.sourceId !== record.observerId)).toBe(true);
    expect(matchMutations.length).toBeGreaterThan(0);
    expect(aggregateMutations).toHaveLength(matchMutations.length);
    expect(matchMutations[0]).not.toHaveProperty("tournamentEpisodeIndex");
    expect(aggregateMutations[0]).toMatchObject({
      type: "social_state_mutation",
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-social-exposure",
      episodeSeed: "writer-social-exposure:g1",
      runId: matchMutations[0].runId,
      matchId: matchMutations[0].matchId,
      agentId: matchMutations[0].agentId,
      journalSeq: matchMutations[0].journalSeq,
      store: matchMutations[0].store,
      mutationKind: matchMutations[0].mutationKind,
      evidenceRefs: expect.any(Array),
      hiddenTruthUsed: false
    });
    expect(metrics.find((metric) => metric.id === "agent.wolf_belief_brier_score")).toMatchObject({
      type: "metric",
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-social-exposure",
      evaluatorId: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      aggregation: "average_brier_score",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "agent_state", id: expect.any(String) }),
        expect.objectContaining({ artifact: "state", description: "postgame team truth for wolf belief calibration" })
      ])
    });
    expect(metrics.find((metric) => metric.id === "agent.social.journal_entry_count")).toMatchObject({
      type: "metric",
      tournamentEpisodeIndex: 0,
      tournamentSeed: "writer-social-exposure",
      evaluatorId: SOCIAL_STATE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      weight: 0,
      evidenceRefs: expect.any(Array)
    });
  }, 120000);

  it("writes returned failed harness runs as partial match artifacts and failure records without leaking secrets", async () => {
    const outputDir = await makeTempDir();
    const previous = {
      LLM_API_KEY: process.env.LLM_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    };
    process.env.LLM_API_KEY = "test-provider-key-should-not-appear";
    process.env.OPENAI_API_KEY = "test-openai-key-should-not-appear";
    try {
      const result = await runTournament({
        models: ["alpha", "beta"],
        games: 1,
        seed: "writer-failed",
        reasoner: failingOnCall(2, "Bearer test-provider-token-should-not-appear"),
        maxTransitions: 8,
        continueOnError: true,
        includeArtifacts: true
      });

      await writeTournamentArtifactDirectory(result, {
        outputDir,
        experimentId: "writer-failed",
        createdAt: "2026-01-02T03:04:05.000Z"
      });

      const failures = await readJsonl<Record<string, any>>(path.join(outputDir, "failures.jsonl"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        type: "failure",
        episodeIndex: 0,
        tournamentEpisodeIndex: 0,
        tournamentSeed: "writer-failed",
        episodeSeed: "writer-failed:g1",
        status: "failed",
        harnessStatus: "failed",
        harnessErrorCount: 1,
        nativeSteps: expect.any(Number),
        committedSteps: expect.any(Number),
        rejectedSteps: expect.any(Number)
      });
      expect(failures[0].failureReason).toContain("planned tournament writer failure");
      expect(failures[0].failureStateHash).toEqual(expect.any(String));
      expect(failures[0].partialArtifact).toMatch(/^matches\/.+\.json$/);
      expect(failures[0].partialArtifact.replace(/\.json$/, ".jsonl")).toMatch(/^matches\/.+\.jsonl$/);
      expect(failures[0].primaryFailure).toMatchObject({
        actorId: expect.any(String),
        profileId: expect.any(String),
        model: expect.any(String),
        seat: expect.any(Number),
        role: expect.any(String),
        team: expect.any(String),
        actionKind: expect.any(String),
        traceId: expect.stringContaining(":harness:"),
        eventId: null,
        eventSeq: null,
        failureKind: null,
        providerStage: null,
        providerFailure: null,
        source: "social_step_failure"
      });
      expect(failures[0].failureAttributions).toEqual([failures[0].primaryFailure]);
      expect(Array.isArray(failures[0].agents)).toBe(true);
      expect(failures[0].agents.length).toBeGreaterThan(0);
      for (const agent of failures[0].agents) {
        expect(agent).toMatchObject({
          playerId: expect.any(String),
          nativeSteps: expect.any(Number),
          committedSteps: expect.any(Number),
          rejectedSteps: expect.any(Number)
        });
      }

      const matchArtifact = await readJson<Record<string, any>>(path.join(outputDir, failures[0].partialArtifact));
      expect(matchArtifact.status).toBe("failed");
      expect(matchArtifact.failureReason).toContain("planned tournament writer failure");
      expect(matchArtifact.failureStateHash).toEqual(expect.any(String));
      expect(matchArtifact.trajectory.length).toBeGreaterThan(0);
      expect(matchArtifact.events.some((event: { type: string }) => event.type === "harness.error")).toBe(false);
      expect(matchArtifact.socialEpisode.steps.some((step: any) => step.commitStatus === "rejected" && step.failure)).toBe(true);
      expect(matchArtifact.metrics.harnessErrorCount).toBe(1);
      expect(matchArtifact.socialEpisode.status).toBe("failed");
      expect(
        matchArtifact.evaluationReport.metrics.filter((metric: { id: string }) =>
          ["team.reward", "agent.reward", "profile.agent_reward", "model.agent_reward"].includes(metric.id)
        )
      ).toEqual([]);
      expect(matchArtifact.evaluationReport.metrics.some((metric: { id: string }) => metric.id === "episode.completed_with_winner")).toBe(true);

      const trajectory = await readJsonl<Record<string, any>>(path.join(outputDir, "trajectory.jsonl"));
      expect(
        trajectory.some(
          (record) => record.type === "error" && record.failureReason === "Harness actor decision failed before a command could be committed."
        )
      ).toBe(true);
      expect(trajectory.some((record) => record.type === "step" && record.traceId && record.preStateHash && record.postStateHash)).toBe(true);

      const matchJsonl = await readJsonl<Record<string, any>>(path.join(outputDir, failures[0].partialArtifact.replace(/\.json$/, ".jsonl")));
      expect(
        matchJsonl.some(
          (record) => record.type === "error" && record.failureReason === "Harness actor decision failed before a command could be committed."
        )
      ).toBe(true);
      expect(JSON.stringify(matchJsonl)).not.toContain("test-provider-token-should-not-appear");
      expect(JSON.stringify(matchJsonl)).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/);

      const costLatency = await readJson<Record<string, any>>(path.join(outputDir, "cost_latency.json"));
      expect(costLatency).toMatchObject({
        artifactVersion: "harness.tournament.v1",
        kind: "tournament-cost-latency",
        seed: "writer-failed",
        pricing: {
          costEstimate: null,
          currency: null
        },
        totals: {
          calls: 2,
          promptTokens: 14,
          completionTokens: 18,
          totalTokens: 32,
          latencyMs: 10,
          averageLatencyMs: 5,
          harnessTurns: 1,
          harnessErrors: 1,
          nativeSteps: expect.any(Number),
          committedSteps: expect.any(Number),
          rejectedSteps: expect.any(Number),
          attempts: expect.objectContaining({
            count: 2,
            sum: 2,
            max: 1,
            missing: 0,
            average: 1
          })
        },
        episodes: [
          expect.objectContaining({
            episodeIndex: 0,
            status: "failed",
            harnessStatus: "failed",
            calls: 2,
            harnessErrors: 1,
            nativeSteps: expect.any(Number),
            committedSteps: expect.any(Number),
            rejectedSteps: expect.any(Number)
          })
        ]
      });
      expect(costLatency.totals).not.toHaveProperty("providerRequestIds");
      expect(costLatency.totals.providerFailures).toMatchObject({
        count: 0,
        byKind: {},
        byStage: {},
        byStatus: {},
        retryable: 0,
        aborted: 0,
        timeouts: 0,
        streamAborts: 0
      });
      expect(Object.values(costLatency.byModel)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            calls: 2,
            promptTokens: 14,
            completionTokens: 18,
            nativeSteps: expect.any(Number),
            committedSteps: expect.any(Number),
            rejectedSteps: expect.any(Number),
            providerFailures: expect.objectContaining({ count: 0 })
          })
        ])
      );
      for (const aggregate of Object.values(costLatency.byModel) as Array<Record<string, unknown>>) {
        expect(aggregate).not.toHaveProperty("providerRequestIds");
      }

      const allText = await readTreeText(outputDir);
      expect(allText).not.toContain("test-provider-key-should-not-appear");
      expect(allText).not.toContain("test-openai-key-should-not-appear");
      expect(allText).not.toContain("test-provider-token-should-not-appear");
      expect(allText).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/);
      expect(allText).not.toContain("LLM_API_KEY");
      expect(allText).not.toContain("OPENAI_API_KEY");
    } finally {
      restoreEnv("LLM_API_KEY", previous.LLM_API_KEY);
      restoreEnv("OPENAI_API_KEY", previous.OPENAI_API_KEY);
    }
  });

  it("records provider failure telemetry in failure records and cost reports without leaking raw provider data", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 1,
      seed: "writer-provider-failed",
      reasoner: providerFailingOnCall(2),
      maxTransitions: 8,
      continueOnError: true,
      includeArtifacts: true
    });

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-provider-failed",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const failures = await readJsonl<Record<string, any>>(path.join(outputDir, "failures.jsonl"));
    expect(failures).toHaveLength(1);
    expect(failures[0].primaryFailure).toMatchObject({
      actorId: expect.any(String),
      profileId: expect.any(String),
      model: expect.any(String),
      seat: expect.any(Number),
      role: expect.any(String),
      team: expect.any(String),
      actionKind: expect.any(String),
      traceId: expect.stringContaining(":harness:"),
      eventId: null,
      eventSeq: null,
      failureKind: "timeout",
      providerStage: "during_request",
      status: null,
      timeoutMs: 42,
      aborted: false,
      retryable: true,
      attempts: 2,
      maxAttempts: 3,
      providerFailure: {
        failureKind: "timeout",
        providerStage: "during_request",
        timeoutMs: 42,
        retryable: true,
        aborted: false,
        attempts: 2,
        maxAttempts: 3
      },
      source: "social_step_failure"
    });
    expect(failures[0].primaryFailure).not.toHaveProperty("providerRequestId");
    expect(failures[0].primaryFailure.providerFailure).not.toHaveProperty("providerRequestId");
    expect(failures[0].primaryFailure.providerFailure).not.toHaveProperty("retryCause");
    expect(failures[0].failureAttributions).toEqual([failures[0].primaryFailure]);

    const matchArtifact = await readJson<Record<string, any>>(path.join(outputDir, failures[0].partialArtifact));
    const nativeFailure = matchArtifact.socialEpisode.steps.find((step: any) => step.failure?.metadata?.providerFailure);
    expect(nativeFailure.failure.metadata.providerFailure).toMatchObject({
      failureKind: "timeout",
      providerStage: "during_request",
      timeoutMs: 42,
      attempts: 2,
      maxAttempts: 3
    });
    expect(nativeFailure.failure.metadata.providerFailure).not.toHaveProperty("providerRequestId");
    expect(JSON.stringify(nativeFailure.failure.metadata)).not.toContain("raw-provider-token-should-not-appear");
    expect(JSON.stringify(nativeFailure.failure.metadata)).not.toContain("provider raw body should not appear");

    const costLatency = await readJson<Record<string, any>>(path.join(outputDir, "cost_latency.json"));
    expect(costLatency.totals.providerFailures).toMatchObject({
      count: 1,
      byKind: { timeout: 1 },
      byStage: { during_request: 1 },
      byStatus: {},
      retryable: 1,
      aborted: 0,
      timeouts: 1,
      streamAborts: 0,
      attempts: expect.objectContaining({
        count: 1,
        sum: 2,
        max: 2,
        missing: 0,
        average: 2
      })
    });
    expect(costLatency.episodes[0].providerFailures).toMatchObject({
      count: 1,
      byKind: { timeout: 1 },
      byStage: { during_request: 1 }
    });
    expect(Object.values(costLatency.byModel)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerFailures: expect.objectContaining({
            count: 1,
            byKind: { timeout: 1 }
          })
        })
      ])
    );

    const allText = await readTreeText(outputDir);
    expect(allText).not.toContain("raw-provider-token-should-not-appear");
    expect(allText).not.toContain("provider raw body should not appear");
    expect(allText).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/);
  });

  it("records pre-harness failures without inventing match artifacts", async () => {
    const outputDir = await makeTempDir();
    const result: TournamentResult = {
      experiment: normalizeTournamentExperimentSpec({
        models: ["alpha"],
        seed: "writer-outer-failure",
        games: 1,
        assignment: { strategy: "profile-rotation" },
        continueOnError: true
      }),
      seed: "writer-outer-failure",
      models: ["alpha"],
      profiles: [{ id: "alpha", model: "alpha" }],
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesFailed: 1,
      assignment: { strategy: "profile-rotation" },
      episodes: [
        {
          index: 0,
          seed: "writer-outer-failure:g1",
          status: "failed",
          resolvedAssignments: [],
          agents: [],
          error: "planned pre-harness failure"
        }
      ],
      modelStats: {},
      profileStats: {}
    };

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-outer-failure",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const matchFiles = await readdir(path.join(outputDir, "matches"));
    expect(matchFiles).toHaveLength(0);
    const failures = await readJsonl<Record<string, any>>(path.join(outputDir, "failures.jsonl"));
    expect(failures).toEqual([
      expect.objectContaining({
        type: "failure",
        episodeIndex: 0,
        matchId: null,
        runId: null,
        failureReason: "planned pre-harness failure",
        primaryFailure: null,
        failureAttributions: [],
        partialArtifact: null
      })
    ]);
    const episodes = await readJsonl<Record<string, any>>(path.join(outputDir, "episodes.jsonl"));
    expect(episodes[0]).toMatchObject({
      status: "failed",
      harnessStatus: null,
      matchArtifact: null
    });
    const manifest = await readJson<Record<string, any>>(path.join(outputDir, "manifest.json"));
    expect(manifest.matchCount).toBe(0);
    expect(manifest.gamesFailed).toBe(1);
    expect(manifest.statusCounts.tournamentFailed).toBe(1);
    expect(manifest.artifactIntegrityOkCount).toBe(0);
    expect(manifest.artifactIntegrityErrorCount).toBe(0);
    expect(manifest.artifactIntegrityErroredMatchCount).toBe(0);
    expect(manifest.files.integrity).toBe("integrity.jsonl");
    expect(manifest.matches).toEqual([]);
    expect(manifest.files.specNormalized).toBe("spec.normalized.json");
    expect(manifest.files.assignment).toBe("assignment.json");
    const specNormalized = await readJson<Record<string, any>>(path.join(outputDir, "spec.normalized.json"));
    expect(specNormalized).toMatchObject({
      kind: "tournament",
      seed: "writer-outer-failure",
      models: ["alpha"],
      games: 1,
      continueOnError: true
    });
    const assignment = await readJson<Record<string, any>>(path.join(outputDir, "assignment.json"));
    expect(assignment).toMatchObject({
      kind: "tournament-assignment",
      seed: "writer-outer-failure",
      assignment: { strategy: "profile-rotation" },
      episodes: [
        expect.objectContaining({
          episodeIndex: 0,
          runId: null,
          matchId: null,
          status: "failed",
          harnessStatus: null,
          nativeSteps: 0,
          committedSteps: 0,
          rejectedSteps: 0,
          matchArtifact: null,
          matchJsonl: null,
          resolvedAssignments: [],
          agents: []
        })
      ]
    });

    const integrity = await readJsonl<Record<string, any>>(path.join(outputDir, "integrity.jsonl"));
    expect(integrity).toEqual([]);

    const leaderboard = await readJson<Record<string, any>>(path.join(outputDir, "leaderboard.json"));
    expect(leaderboard.benchmarkStatistics).toMatchObject({
      schemaVersion: "harness.benchmark-statistics.v1",
      statusDenominators: {
        gamesRequested: 1,
        episodesScheduled: 1,
        episodesUnscheduled: 0,
        gamesCompleted: 0,
        gamesFailed: 1,
        artifactCount: 0,
        matchArtifactCount: 0,
        failedWithArtifact: 0,
        preHarnessFailures: 1,
        harnessStatusCounts: expect.objectContaining({
          completed: 0,
          truncated: 0,
          failed: 0,
          tournamentFailed: 1
        }),
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      },
      strata: {
        byEpisodeStatus: {
          failed: expect.objectContaining({
            dimension: "episodeStatus",
            key: "failed",
            episodeCount: 1,
            artifactCount: 0,
            nativeSteps: 0,
            committedSteps: 0,
            rejectedSteps: 0
          })
        },
        byHarnessStatus: {
          tournamentFailed: expect.objectContaining({
            dimension: "harnessStatus",
            key: "tournamentFailed",
            episodeCount: 1,
            artifactCount: 0,
            nativeSteps: 0,
            committedSteps: 0,
            rejectedSteps: 0
          })
        }
      }
    });
    expect(leaderboard.benchmarkStatistics.strata.byModel).toEqual({});
    expect(leaderboard.benchmarkStatistics.strata.byRole).toEqual({});
  });

  it("surfaces fork provenance in tournament summaries without opening full match artifacts", async () => {
    const outputDir = await makeTempDir();
    const result = await buildForkedTournamentResult();
    const forkOf = result.artifacts?.[0].artifact.forkOf;
    if (!forkOf) throw new Error("Expected fork artifact provenance.");
    const forkSummary = {
      checkpointId: forkOf.checkpointId,
      parentRunId: forkOf.parentRunId ?? null,
      parentMatchId: forkOf.parentMatchId ?? null,
      parentBoundaryTraceId: forkOf.parentBoundaryTraceId ?? null,
      parentBoundaryTurnIndex: forkOf.parentBoundaryTurnIndex ?? null,
      parentStateHash: forkOf.parentStateHash,
      parentExecutionPrefixHash: forkOf.parentExecutionPrefixHash,
      parentAgentsHash: forkOf.parentAgentsHash,
      parentChannelsHash: forkOf.parentChannelsHash,
      parentMessagesHash: forkOf.parentMessagesHash,
      parentNativeStepCount: forkOf.parentNativeStepCount,
      parentMessageCount: forkOf.parentMessageCount,
      createdAt: forkOf.createdAt,
      reason: forkOf.reason ?? null
    };

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "writer-fork-lineage",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const manifest = await readJson<Record<string, any>>(path.join(outputDir, "manifest.json"));
    expect(manifest).toMatchObject({
      forkCount: 1,
      forks: [
        {
          episodeIndex: 0,
          seed: "writer-fork-lineage:g1",
          forkOf: forkSummary
        }
      ],
      matches: [
        expect.objectContaining({
          episodeIndex: 0,
          forkOf: forkSummary,
          path: expect.stringMatching(/^matches\/.+\.json$/)
        })
      ]
    });
    expect(JSON.stringify(manifest)).not.toContain("parentEvidenceTraceIds");

    const episodes = await readJsonl<Record<string, any>>(path.join(outputDir, "episodes.jsonl"));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      type: "episode",
      episodeIndex: 0,
      forkOf: forkSummary,
      matchArtifact: expect.stringMatching(/^matches\/.+\.json$/)
    });
    expect(JSON.stringify(episodes)).not.toContain("parentEvidenceTraceIds");

    const leaderboard = await readJson<Record<string, any>>(path.join(outputDir, "leaderboard.json"));
    expect(leaderboard.episodes[0]).toMatchObject({
      index: 0,
      forkOf: forkSummary,
      nativeSteps: expect.any(Number),
      committedSteps: expect.any(Number),
      rejectedSteps: expect.any(Number)
    });
    expect(JSON.stringify(leaderboard)).not.toContain("parentEvidenceTraceIds");

    const trajectory = await readJsonl<Record<string, any>>(path.join(outputDir, "trajectory.jsonl"));
    const header = trajectory.find((record) => record.type === "header");
    expect(header).toMatchObject({
      episodeIndex: 0,
      tournamentEpisodeIndex: 0,
      forkOf
    });

    const matchArtifact = await readJson<Record<string, any>>(path.join(outputDir, episodes[0].matchArtifact));
    expect(matchArtifact.forkOf).toEqual(forkOf);
  }, 15000);

  it("rebuilds research leaderboard exports from persisted raw records without an in-memory stats fallback", async () => {
    const outputDir = await makeTempDir();
    const result = await runTournament({
      models: ["alpha", "beta"],
      games: 1,
      seed: "raw-leaderboard-roundtrip",
      reasoner: deterministicReasoner,
      maxTransitions: 4,
      includeArtifacts: true
    });
    // Keep this fixture bounded; the artifact plane is deliberately tested
    // against a hand-labeled completed research row rather than requiring a
    // full 300+ transition game in every unit-test invocation.
    expect(result.episodes[0]?.status).toBe("truncated");
    if (!result.episodes[0]) throw new Error("Expected bounded tournament episode.");
    result.episodes[0].status = "completed";
    result.episodes[0].harnessStatus = "completed";
    result.gamesCompleted = 1;
    result.gamesTruncated = 0;
    poisonTournamentStats(result, 917_555_911);

    await writeTournamentArtifactDirectory(result, {
      outputDir,
      experimentId: "raw-leaderboard-roundtrip",
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    const raw = await readPersistedLeaderboardRawRecords(outputDir);
    const rebuilt = rebuildTournamentLeaderboardFromRawRecords({
      models: raw.spec.models,
      profiles: raw.spec.profiles,
      episodeRecords: raw.episodes,
      metricRecords: raw.metrics,
      costLatencyReport: raw.costLatency
    });
    const persisted = await readJson<Record<string, any>>(path.join(outputDir, "leaderboard.json"));
    expect(rebuilt.modelStats).toEqual(persisted.modelStats);
    expect(rebuilt.profileStats).toEqual(persisted.profileStats);
    expect(rebuilt.metricPromotion.metricCount).toBe(persisted.metricCount);
    expect(rebuilt.metricPromotion.scorecardEligibleCount).toBe(persisted.scorecardEligibleMetricCount);
    expect(rebuilt.metricPromotion.byClass).toEqual(persisted.metricPromotionClassCounts);
    expect(rebuilt.metricPromotion.scorecardEligibleByClass).toEqual(persisted.scorecardEligibleMetricClassCounts);
    expect(Object.values(rebuilt.modelStats).some((stats) => stats.seatGames > 0)).toBe(true);
    expect(Object.values(rebuilt.profileStats).some((stats) => stats.seatGames > 0)).toBe(true);
    expect(raw.episodes[0]?.profileExecution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: expect.any(String),
          harnessTurns: expect.any(Number),
          nativeSteps: expect.any(Number),
          committedSteps: expect.any(Number),
          rejectedSteps: expect.any(Number)
        })
      ])
    );

    const leaderboardCsv = await readFile(path.join(outputDir, "leaderboard.csv"), "utf8");
    const summaryMarkdown = await readFile(path.join(outputDir, "summary.md"), "utf8");
    expect(leaderboardCsv).not.toContain("917555911");
    expect(summaryMarkdown).not.toContain("917555911");

    const changedRaw = JSON.parse(JSON.stringify(raw)) as typeof raw;
    const completedAgentMetric = changedRaw.metrics.find(
      (metric) => metric.status === "completed" && metric.scope === "agent" && typeof metric.subjectId === "string"
    );
    if (!completedAgentMetric) throw new Error("Expected a persisted completed agent-scoped metric fixture.");
    const rewardMetric = {
      ...completedAgentMetric,
      id: "agent.reward",
      label: "Synthetic completed reward sample for raw-record rebuild",
      value: 0,
      promotionClass: "scorecard",
      scorecardEligible: true
    };
    changedRaw.metrics.push(rewardMetric);
    const priorPromotion = rebuildTournamentLeaderboardFromRawRecords({
      models: changedRaw.spec.models,
      profiles: changedRaw.spec.profiles,
      episodeRecords: changedRaw.episodes,
      metricRecords: changedRaw.metrics,
      costLatencyReport: changedRaw.costLatency
    });
    rewardMetric.value += 7;
    rewardMetric.promotionClass = "benchmark_only";
    rewardMetric.scorecardEligible = false;
    const changed = rebuildTournamentLeaderboardFromRawRecords({
      models: changedRaw.spec.models,
      profiles: changedRaw.spec.profiles,
      episodeRecords: changedRaw.episodes,
      metricRecords: changedRaw.metrics,
      costLatencyReport: changedRaw.costLatency
    });
    expect(totalReward(changed.modelStats)).toBeCloseTo(totalReward(priorPromotion.modelStats) + 7);
    expect(changed.metricPromotion.byClass.benchmark_only).toBe(priorPromotion.metricPromotion.byClass.benchmark_only + 1);
    expect(changed.metricPromotion.byClass.scorecard).toBe(priorPromotion.metricPromotion.byClass.scorecard - 1);
    expect(changed.metricPromotion.scorecardEligibleCount).toBe(priorPromotion.metricPromotion.scorecardEligibleCount - 1);

    const lifecycleRaw = JSON.parse(JSON.stringify(raw)) as typeof raw;
    const baseMetricRows = lifecycleRaw.metrics.map((metric) => ({ ...metric }));
    for (const [episodeIndex, status] of [
      [1, "truncated"],
      [2, "failed"]
    ] as const) {
      const episode = JSON.parse(JSON.stringify(lifecycleRaw.episodes[0]));
      episode.episodeIndex = episodeIndex;
      episode.index = episodeIndex;
      episode.status = status;
      episode.harnessStatus = status;
      for (const agent of episode.agents) {
        agent.nativeSteps = 909;
        agent.committedSteps = 900;
        agent.rejectedSteps = 9;
      }
      for (const profile of episode.profileExecution) {
        profile.harnessTurns = 900;
        profile.nativeSteps = 909;
        profile.committedSteps = 900;
        profile.rejectedSteps = 9;
      }
      lifecycleRaw.episodes.push(episode);
      const cost = JSON.parse(JSON.stringify(lifecycleRaw.costLatency.episodes[0]));
      cost.episodeIndex = episodeIndex;
      cost.status = status;
      cost.harnessStatus = status;
      cost.harnessErrors = 700;
      for (const usage of Object.values(cost.modelUsage) as Array<Record<string, number>>) {
        usage.calls = 700;
        usage.promptTokens = 700;
        usage.completionTokens = 700;
        usage.latencyMs = 700;
      }
      lifecycleRaw.costLatency.episodes.push(cost);
      lifecycleRaw.metrics.push(
        ...baseMetricRows.map((metric) => ({
          ...metric,
          episodeIndex,
          tournamentEpisodeIndex: episodeIndex,
          status,
          value: metric.id === "agent.reward" ? 700 : metric.value
        }))
      );
    }
    const lifecycleRebuilt = rebuildTournamentLeaderboardFromRawRecords({
      models: lifecycleRaw.spec.models,
      profiles: lifecycleRaw.spec.profiles,
      episodeRecords: lifecycleRaw.episodes,
      metricRecords: lifecycleRaw.metrics,
      costLatencyReport: lifecycleRaw.costLatency
    });
    expect(lifecycleRebuilt.modelStats).toEqual(rebuilt.modelStats);
    expect(lifecycleRebuilt.profileStats).toEqual(rebuilt.profileStats);
    expect(lifecycleRebuilt.metricPromotion.metricCount).toBe(rebuilt.metricPromotion.metricCount * 3);

    const redactedRaw = JSON.parse(JSON.stringify(raw)) as typeof raw;
    for (const episode of redactedRaw.episodes) {
      for (const agent of episode.agents) {
        delete agent.role;
        delete agent.team;
        delete agent.won;
      }
    }
    const redacted = rebuildTournamentLeaderboardFromRawRecords({
      models: redactedRaw.spec.models,
      profiles: redactedRaw.spec.profiles,
      episodeRecords: redactedRaw.episodes,
      metricRecords: redactedRaw.metrics,
      costLatencyReport: redactedRaw.costLatency
    });
    expect(Object.values(redacted.modelStats).every((stats) => stats.villageSeatGames === 0 && stats.werewolfSeatGames === 0)).toBe(true);
    expect(Object.values(redacted.profileStats).every((stats) => Object.values(stats.roleGames).every((count) => count === 0))).toBe(true);

    expect(() =>
      rebuildTournamentLeaderboardFromRawRecords({
        models: [],
        profiles: [],
        episodeRecords: [{ type: "public_episode", episodeIndex: 0 }],
        metricRecords: [],
        costLatencyReport: { kind: "public-tournament-cost-latency", episodes: [] }
      })
    ).toThrow("requires an episode record");
  });
});

const deterministicReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `public speech ${input.traceId} ${input.agent.playerId}`
        : `memo ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 4,
        usage: { promptTokens: 6, completionTokens: 8, totalTokens: 14 },
        providerRequestId: `fake-provider-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

function failingOnCall(failAt: number, providerRequestId: string): HarnessReasoner {
  let calls = 0;
  return {
    async think(input) {
      calls += 1;
      if (calls === failAt) {
        throw new Error(`planned tournament writer failure:${input.action.kind}`);
      }
      const content = `prefix ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
      return {
        content,
        completion: {
          content,
          latencyMs: 5,
          usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 },
          providerRequestId,
          attempts: 1
        }
      };
    }
  };
}

function providerFailingOnCall(failAt: number): HarnessReasoner {
  let calls = 0;
  return {
    async think(input) {
      calls += 1;
      if (calls === failAt) {
        throw new ModelCallError("LLM API request failed after 2/3 attempt(s): LLM API request exceeded 42ms.", {
          failureKind: "timeout",
          providerStage: "during_request",
          timeoutMs: 42,
          retryable: true,
          aborted: false,
          attempts: 2,
          maxAttempts: 3,
          providerRequestId: "Bearer failure-provider-token-should-not-appear",
          retryCause: "LLM API request exceeded 42ms.",
          body: "provider raw body should not appear Bearer raw-provider-token-should-not-appear",
          headers: {
            authorization: "Bearer raw-provider-token-should-not-appear"
          }
        });
      }
      const content = `provider prefix ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
      return {
        content,
        completion: {
          content,
          latencyMs: 5,
          usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 },
          providerRequestId: `provider-failure-prefix-${input.traceId}`,
          attempts: 1
        }
      };
    }
  };
}

async function buildForkedTournamentResult(): Promise<TournamentResult> {
  const initialState = createGame({ id: "writer-fork-parent", seed: "writer-fork-parent" });
  const profiles = profilesFromModels(["alpha", "beta"], 0.3);
  const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
  const parent = await runHarnessMatch({
    initialState,
    agents,
    reasoner: deterministicReasoner,
    maxTransitions: 2
  });
  const parentArtifact = buildMatchArtifact({
    runId: "writer-fork-parent-run",
    matchId: "writer-fork-parent-match",
    seed: initialState.seed,
    models: ["alpha", "beta"],
    profiles,
    resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
    result: parent
  });
  const checkpoint = buildFinalHarnessCheckpoint({
    artifact: parentArtifact,
    checkpointId: "writer-fork-checkpoint",
    createdAt: "2026-01-02T03:04:05.100Z",
    reason: "tournament fork lineage test"
  });
  const forkOptions = forkHarnessRunOptions({
    checkpoint,
    reasoner: deterministicReasoner,
    maxTransitions: 1,
    createdAt: "2026-01-02T03:04:06.000Z",
    reason: "tournament branch"
  });
  const fork = await runHarnessMatch(forkOptions);
  const resolvedAssignments = describeResolvedAssignments(fork.initialState.players, forkOptions.agents);
  const forkArtifact = buildMatchArtifact({
    runId: "writer-fork-child-run",
    matchId: "writer-fork-child-match",
    seed: "writer-fork-lineage:g1",
    models: ["alpha", "beta"],
    profiles,
    resolvedAssignments,
    result: fork
  });

  return {
    experiment: normalizeTournamentExperimentSpec({
      models: ["alpha", "beta"],
      profiles,
      seed: "writer-fork-lineage",
      games: 1,
      maxTransitions: 1,
      temperature: 0.3
    }),
    seed: "writer-fork-lineage",
    models: ["alpha", "beta"],
    profiles,
    gamesRequested: 1,
    gamesCompleted: 1,
    gamesFailed: 0,
    maxTransitions: 1,
    episodes: [
      {
        index: 0,
        seed: "writer-fork-lineage:g1",
        runId: forkArtifact.runId,
        matchId: forkArtifact.matchId,
        status: fork.status === "failed" ? "failed" : "completed",
        harnessStatus: fork.status,
        winner: fork.state.winner,
        phase: fork.state.phase,
        day: fork.state.day,
        metrics: fork.metrics,
        evaluation: fork.evaluation,
        evaluationReport: fork.evaluationReport,
        trajectory: fork.trajectory,
        socialEpisode: fork.socialEpisode,
        resolvedAssignments,
        agents: fork.state.players.map((player) => {
          const agent = forkOptions.agents.find((item) => item.playerId === player.id);
          return {
            playerId: player.id,
            seat: player.seat,
            profileId: agent?.profileId,
            model: agent?.model ?? "alpha",
            role: player.role,
            team: player.team,
            policyName: agent?.policyName,
            won: fork.state.winner ? player.team === fork.state.winner : undefined
          };
        }),
        artifact: forkArtifact
      }
    ],
    modelStats: {},
    profileStats: {},
    artifacts: [
      {
        index: 0,
        seed: "writer-fork-lineage:g1",
        runId: forkArtifact.runId,
        matchId: forkArtifact.matchId,
        artifact: forkArtifact
      }
    ]
  };
}

function replacePromotionIdentityForEpisode(
  result: TournamentResult,
  episodeIndex: number,
  identity: {
    policyId: string;
    policyVersion: string;
    policyHash: string;
    catalogId: string;
    catalogVersion: string;
    catalogHash: string;
    catalogDomainId: string;
  }
): void {
  const reports = new Set<HarnessEvaluationReport>();
  const episode = result.episodes.find((item) => item.index === episodeIndex);
  if (episode?.evaluationReport) reports.add(episode.evaluationReport);
  if (episode?.artifact?.evaluationReport) reports.add(episode.artifact.evaluationReport);
  for (const record of result.artifacts ?? []) {
    if (record.index === episodeIndex) reports.add(record.artifact.evaluationReport);
  }
  if (!reports.size) throw new Error(`Expected evaluation report for episode ${episodeIndex}.`);

  for (const report of reports) {
    Object.assign(report.summary.promotion, identity);
    for (const metric of report.metrics) {
      if (!metric.promotionDecision) throw new Error(`Expected recorded promotion decision for ${metric.id}.`);
      Object.assign(metric.promotionDecision, identity);
    }
  }
}

async function readPersistedLeaderboardRawRecords(outputDir: string): Promise<{
  spec: {
    models: string[];
    profiles: Array<Pick<HarnessAgentProfile, "id" | "model" | "policyName">>;
  };
  episodes: Array<Record<string, any>>;
  metrics: Array<Record<string, any>>;
  costLatency: Record<string, any>;
}> {
  return {
    spec: await readJson(path.join(outputDir, "spec.normalized.json")),
    episodes: await readJsonl(path.join(outputDir, "episodes.jsonl")),
    metrics: await readJsonl(path.join(outputDir, "metrics.jsonl")),
    costLatency: await readJson(path.join(outputDir, "cost_latency.json"))
  };
}

function poisonTournamentStats(result: TournamentResult, sentinel: number): void {
  const poison = (stats: Record<string, any>) => {
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === "number") {
        stats[key] = sentinel;
      } else if (value && typeof value === "object") {
        for (const nestedKey of Object.keys(value)) value[nestedKey] = sentinel;
      }
    }
  };
  for (const stats of Object.values(result.modelStats)) poison(stats as unknown as Record<string, any>);
  for (const stats of Object.values(result.profileStats)) poison(stats as unknown as Record<string, any>);
}

function totalReward(stats: Record<string, { rewardTotal: number }>): number {
  return Object.values(stats).reduce((total, item) => total + item.rewardTotal, 0);
}

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "werewolf-tournament-artifacts-"));
  tempDirs.push(root);
  return path.join(root, "artifact");
}

async function expectRequiredFiles(outputDir: string): Promise<void> {
  const entries = await readdir(outputDir);
  expect(entries).toEqual(
    expect.arrayContaining([
      "manifest.json",
      "registry.json",
      "spec.normalized.json",
      "assignment.json",
      "episodes.jsonl",
      "trajectory.jsonl",
      "metrics.jsonl",
      "integrity.jsonl",
      "failures.jsonl",
      "cost_latency.json",
      "leaderboard.json",
      "benchmark_statistics.json",
      "tournament_comparison.json",
      "tournament_comparison.md",
      "summary.md",
      "episodes.csv",
      "agents.csv",
      "metrics.csv",
      "leaderboard.csv",
      "matches"
    ])
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readTreeText(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(dir, entry.name);
      return entry.isDirectory() ? readTreeText(child) : readFile(child, "utf8");
    })
  );
  return chunks.join("\n");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
