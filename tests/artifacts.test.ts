import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import {
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  buildMatchArtifact,
  forkHarnessRunOptions,
  HarnessCheckpointSelectionError,
  resolveAgentSnapshotsAfterStep,
  toTrajectoryJsonl,
  validateMatchArtifactIntegrity,
  type MatchArtifact
} from "../src/harness/artifacts";
import { hashStableState } from "../src/harness/hash";
import {
  DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
  DECEPTION_BELIEF_SHIFT_METRIC_IDS,
  DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
  DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
  WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
  WEREWOLF_ADVERSARIAL_METRIC_IDS,
  WEREWOLF_OUTCOME_EVALUATOR_ID,
  WEREWOLF_OUTCOME_METRIC_IDS,
  WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
  WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
  WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS
} from "../src/harness/evaluator";
import { emptyEvaluationSummary } from "../src/harness/evaluation";
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
import { deriveSocialExposureRecords, isSocialStepCommitted } from "../src/harness/social";
import {
  addSocialBetrayal,
  addSocialCoalition,
  addSocialCommitment,
  addSocialGossip,
  addSocialNorm,
  addSocialNormSanction,
  addSocialTrustRepair,
  createAgentSocialState,
  recordSocialBetrayalEvidence,
  recordSocialCoalitionEvidence,
  updateSocialCommitmentStatus,
  updateSocialNormStatus,
  updateSocialNormSanctionStatus,
  updateSocialTrustRepairStatus
} from "../src/harness/socialState";
import type { HarnessEvaluationWarning, HarnessReasoner } from "../src/harness/types";

describe("match artifact JSONL export", () => {
  it("exports society stores through agent_state and social_state_mutation records", () => {
    const state = createGame({ id: "artifact-commitment-coalition", seed: "artifact-commitment-coalition" });
    const player = state.players[0];
    const social = createAgentSocialState<any, any, any>({
      agentId: player.id,
      profile: { id: `profile-${player.id}`, model: "deterministic-test-model", policyId: "balanced" }
    });
    const commitment = addSocialCommitment(social, {
      id: "commit-artifact",
      actorId: player.id,
      audienceIds: [state.players[1].id],
      visibility: "public",
      promisedAction: "defend ally",
      targetId: state.players[1].id,
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-artifact", seq: 1 }],
      metadata: {
        observerId: player.id,
        speakerId: player.id,
        factSource: "social-message-speech-act",
        factKind: "commitment",
        speechActId: "act-commit-artifact",
        speechActKind: "commitment",
        speechActIndex: 0,
        channelId: "table",
        visibility: "public",
        messageId: "msg-commit-artifact",
        messageSeq: 1,
        reason: "raw commitment metadata artifact text",
        narrative: "raw commitment narrative artifact text"
      }
    }, { traceId: "trace-commit-artifact", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialCommitmentStatus(social, {
      id: commitment.id,
      status: "fulfilled",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-commit-artifact", seq: 2 }]
    }, { traceId: "trace-commit-outcome-artifact", turnIndex: 2, phase: "day_vote", day: 1 });
    const coalition = addSocialCoalition(social, {
      id: "coalition-artifact",
      memberIds: [player.id, state.players[1].id],
      visibility: "team",
      sharedGoal: "coordinate vote pressure",
      targetId: state.players[2].id,
      status: "active",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-artifact", seq: 3 }]
    }, { traceId: "trace-coalition-artifact", turnIndex: 3, phase: "night", day: 1 });
    recordSocialCoalitionEvidence(social, {
      id: coalition.id,
      kind: "coordination",
      evidenceRefs: [{ artifact: "message", id: "msg-coordinate-artifact", seq: 4 }]
    }, { traceId: "trace-coordinate-artifact", turnIndex: 4, phase: "night", day: 1 });
    addSocialGossip(social, {
      id: "gossip-artifact",
      speakerId: player.id,
      subjectId: state.players[2].id,
      audienceIds: [state.players[1].id],
      visibility: "public",
      topic: "credibility artifact text",
      claim: "raw gossip artifact text",
      valence: "negative",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-artifact", seq: 5 }]
    }, { traceId: "trace-gossip-artifact", turnIndex: 5, phase: "day_speech", day: 1 });
    const norm = addSocialNorm(social, {
      id: "norm-public-evidence",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "raw norm artifact text",
      sanction: "public warning",
      source: player.id,
      confidence: 0.8,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm-artifact", seq: 6 }]
    }, { traceId: "trace-norm-artifact", turnIndex: 6, phase: "day_speech", day: 1 });
    updateSocialNormStatus(social, {
      id: norm.id,
      status: "violated",
      evidenceRefs: [{ artifact: "event", id: "event-norm-artifact", seq: 7 }]
    }, { traceId: "trace-norm-status-artifact", turnIndex: 7, phase: "day_vote", day: 1 });
    const sanction = addSocialNormSanction(social, {
      id: "sanction-artifact",
      normId: "norm-public-evidence",
      actorId: player.id,
      targetId: state.players[2].id,
      audienceIds: [state.players[1].id],
      visibility: "public",
      kind: "warning",
      reason: "raw sanction artifact text",
      requestedRepair: "cite public evidence",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-artifact", seq: 8 }]
    }, { traceId: "trace-sanction-artifact", turnIndex: 8, phase: "day_speech", day: 1 });
    updateSocialNormSanctionStatus(social, {
      id: sanction.id,
      status: "applied",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-sanction-artifact", seq: 9 }]
    }, { traceId: "trace-sanction-outcome-artifact", turnIndex: 9, phase: "day_vote", day: 1 });
    const repair = addSocialTrustRepair(social, {
      id: "repair-artifact",
      actorId: state.players[2].id,
      targetId: player.id,
      audienceIds: [state.players[1].id],
      visibility: "public",
      kind: "evidence_provided",
      triggerKind: "norm_sanction",
      triggerId: "sanction-artifact",
      relatedNormSanctionId: "sanction-artifact",
      requestedRepair: "raw repair request artifact text",
      offeredRepair: "raw trust repair artifact text",
      confidence: 0.75,
      evidenceRefs: [{ artifact: "message", id: "msg-repair-artifact", seq: 10 }]
    }, { traceId: "trace-repair-artifact", turnIndex: 10, phase: "day_speech", day: 1 });
    updateSocialTrustRepairStatus(social, {
      id: repair.id,
      status: "accepted",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-repair-artifact", seq: 11 }]
    }, { traceId: "trace-repair-outcome-artifact", turnIndex: 11, phase: "day_vote", day: 1 });
    const betrayal = addSocialBetrayal(social, {
      id: "betrayal-artifact",
      actorId: state.players[1].id,
      targetId: player.id,
      audienceIds: [player.id, state.players[2].id],
      visibility: "public",
      kind: "information_leak",
      triggerKind: "coalition",
      triggerId: "coalition-artifact",
      relatedCoalitionId: "coalition-artifact",
      claim: "raw betrayal artifact text",
      impact: "raw betrayal artifact text",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-artifact", seq: 12 }]
    }, { traceId: "trace-betrayal-artifact", turnIndex: 12, phase: "day_speech", day: 1 });
    recordSocialBetrayalEvidence(social, {
      id: betrayal.id,
      kind: "corroboration",
      status: "confirmed",
      evidenceRefs: [{ artifact: "event", id: "event-betrayal-artifact", seq: 13 }]
    }, { traceId: "trace-betrayal-evidence-artifact", turnIndex: 13, phase: "day_vote", day: 1 });

    const artifact = {
      artifactVersion: "harness.match.v2",
      kind: "match",
      runId: "artifact-commitment-coalition",
      createdAt: new Date(0).toISOString(),
      seed: state.seed,
      rulesetId: state.config.rulesetId,
      config: state.config,
      models: ["deterministic-test-model"],
      profiles: [],
      resolvedAssignments: [],
      status: "completed",
      initialState: state,
      finalState: state,
      trajectory: [],
      socialEpisode: {
        id: "artifact-commitment-coalition:social",
        status: "completed",
        schedulerMode: "aec",
        profiles: [],
        channels: [],
        initialState: state,
        finalState: state,
        steps: [],
        messages: []
      },
      events: [],
      evaluation: {
        teamRewards: { village: 0, werewolves: 0 },
        agentRewards: [],
        voteAccuracyByAgent: {},
        influenceByAgent: {},
        deceptionByAgent: {},
        trajectory: []
      },
      evaluationReport: {
        id: "artifact-commitment-coalition:evaluation",
        createdAt: new Date(0).toISOString(),
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
        harnessErrorCount: 0,
        averageLatencyMs: 0,
        wolfVoteAccuracy: 0,
        villageVoteAccuracy: 0,
        deceptionSurvivalScore: 0,
        modelUsage: {}
      },
      agents: [
        {
          playerId: player.id,
          profileId: `profile-${player.id}`,
          model: "deterministic-test-model",
          temperature: 0,
          policyName: "balanced",
          turns: 0,
          observations: 0,
          beliefs: {},
          privateMemos: [],
          socialStateHash: "hash-commitment-coalition-artifact",
          social
        }
      ]
    } satisfies MatchArtifact;

    const records = parseJsonl(toTrajectoryJsonl(artifact));
    const agentState = findRecord(records, "agent_state");
    const mutations = records.filter((record) => record.type === "social_state_mutation");

    expect(agentState).toMatchObject({
      social: expect.objectContaining({
        commitments: expect.objectContaining({
          records: expect.objectContaining({
            "commit-artifact": expect.objectContaining({ status: "fulfilled", evidenceRefs: expect.any(Array) })
          })
        }),
        coalitions: expect.objectContaining({
          records: expect.objectContaining({
            "coalition-artifact": expect.objectContaining({ status: "active", coordinationEvidenceRefs: expect.any(Array) })
          })
        }),
        gossip: expect.objectContaining({
          records: expect.objectContaining({
            "gossip-artifact": expect.objectContaining({ subjectId: state.players[2].id, valence: "negative", evidenceRefs: expect.any(Array) })
          })
        }),
        norms: expect.objectContaining({
          norms: expect.objectContaining({
            "norm-public-evidence": expect.objectContaining({ status: "violated", evidenceRefs: expect.any(Array) })
          })
        }),
        normSanctions: expect.objectContaining({
          records: expect.objectContaining({
            "sanction-artifact": expect.objectContaining({ targetId: state.players[2].id, status: "applied", evidenceRefs: expect.any(Array) })
          })
        }),
        trustRepairs: expect.objectContaining({
          records: expect.objectContaining({
            "repair-artifact": expect.objectContaining({ targetId: player.id, status: "accepted", evidenceRefs: expect.any(Array) })
          })
        }),
        betrayals: expect.objectContaining({
          records: expect.objectContaining({
            "betrayal-artifact": expect.objectContaining({
              targetId: player.id,
              status: "confirmed",
              evidenceRefs: expect.any(Array),
              corroborationEvidenceRefs: expect.any(Array)
            })
          })
        })
      })
    });
    expect(mutations.map((record) => [record.store, record.mutationKind, record.subjectId])).toEqual([
      ["commitments", "commitment.added", "commit-artifact"],
      ["commitments", "commitment.status.updated", "commit-artifact"],
      ["coalitions", "coalition.added", "coalition-artifact"],
      ["coalitions", "coalition.evidence.recorded", "coalition-artifact"],
      ["gossip", "gossip.added", "gossip-artifact"],
      ["norms", "norm.added", "norm-public-evidence"],
      ["norms", "norm.status.updated", "norm-public-evidence"],
      ["normSanctions", "norm_sanction.added", "sanction-artifact"],
      ["normSanctions", "norm_sanction.status.updated", "sanction-artifact"],
      ["trustRepairs", "trust_repair.added", "repair-artifact"],
      ["trustRepairs", "trust_repair.status.updated", "repair-artifact"],
      ["betrayals", "betrayal.added", "betrayal-artifact"],
      ["betrayals", "betrayal.evidence.recorded", "betrayal-artifact"]
    ]);
    const commitmentAddedMutation = mutations.find(
      (record) => record.store === "commitments" && record.mutationKind === "commitment.added" && record.subjectId === "commit-artifact"
    );
    expect(commitmentAddedMutation).toMatchObject({
      metadata: expect.objectContaining({
        metadataKeys: [
          "factSource",
          "factKind",
          "observerId",
          "speakerId",
          "messageId",
          "messageSeq",
          "speechActId",
          "speechActKind",
          "speechActIndex",
          "channelId",
          "visibility"
        ],
        observerId: player.id,
        speakerId: player.id,
        factSource: "social-message-speech-act",
        factKind: "commitment",
        speechActId: "act-commit-artifact",
        speechActKind: "commitment",
        speechActIndex: 0,
        channelId: "table",
        visibility: "public",
        messageId: "msg-commit-artifact",
        messageSeq: 1
      })
    });
    expect(commitmentAddedMutation?.metadata).not.toHaveProperty("reason");
    expect(commitmentAddedMutation?.metadata).not.toHaveProperty("narrative");
    expect(mutations.every((record) => record.hiddenTruthUsed === false && record.redactionClass === "agent_private_summary")).toBe(true);
    const betrayalMutations = mutations.filter((record) => record.store === "betrayals");
    expect(betrayalMutations).toEqual([
      expect.objectContaining({
        mutationKind: "betrayal.added",
        subjectId: "betrayal-artifact",
        hiddenTruthUsed: false,
        redactionClass: "agent_private_summary",
        evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "message", id: "msg-betrayal-artifact", seq: 12 })])
      }),
      expect.objectContaining({
        mutationKind: "betrayal.evidence.recorded",
        subjectId: "betrayal-artifact",
        hiddenTruthUsed: false,
        redactionClass: "agent_private_summary",
        evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "event", id: "event-betrayal-artifact", seq: 13 })])
      })
    ]);
    expect(JSON.stringify(mutations)).not.toMatch(
      /defend ally|coordinate vote pressure|raw gossip artifact text|raw norm artifact text|raw sanction artifact text|raw repair request artifact text|raw trust repair artifact text|raw betrayal artifact text|raw commitment metadata artifact text|raw commitment narrative artifact text/
    );
  });

  it("exports completed run steps, traces, channels, events, messages, exposures, and metrics", async () => {
    const initialState = createGame({ id: "artifact-jsonl-completed", seed: "artifact-jsonl-completed" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 320,
      recordAgentSnapshots: false
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-jsonl-completed",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const testWarning: HarnessEvaluationWarning = {
      code: "test.warning",
      severity: "warning",
      evaluatorId: WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      metricId: "agent.reward",
      message: "artifact warning propagation test"
    };
    artifact.evaluationReport.warnings = [testWarning];
    artifact.evaluationReport.status = "incomplete";
    artifact.evaluationReport.failures = [
      {
        evaluatorId: "test.evaluator-failure",
        label: "Test evaluator failure",
        version: "1.0.0",
        stage: "evaluate",
        code: "evaluator_exception",
        message: "Evaluator execution failed; no metrics or output were recorded."
      }
    ];

    const jsonl = toTrajectoryJsonl(artifact);
    const records = parseJsonl(jsonl);
    const header = findRecord(records, "header");
    const matchMetrics = findRecord(records, "match_metrics");
    const evaluationReport = findRecord(records, "evaluation_report");
    const stepRecords = records.filter((record) => record.type === "step");
    const traceRecords = records.filter((record) => record.type === "trace");
    const socialStepRecords = records.filter((record) => record.type === "social_step");
    const channelRecords = records.filter((record) => record.type === "channel");
    const messageRecords = records.filter((record) => record.type === "message");
    const socialSpeechActRecords = records.filter((record) => record.type === "social_speech_act");
    const socialDeliveryReceiptRecords = records.filter((record) => record.type === "social_delivery_receipt");
    const socialExposureRecords = records.filter((record) => record.type === "social_exposure");
    const eventRecords = records.filter((record) => record.type === "event");
    const metricRecords = records.filter((record) => record.type === "metric");
    const agentStateRecords = records.filter((record) => record.type === "agent_state");
    const socialMutationRecords = records.filter((record) => record.type === "social_state_mutation");
    const frameRecords = records.filter((record) => record.type === "agent_snapshot_frame");

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(result.status).toBe("completed");
    expect(artifact.agentSnapshotFrames).toBeUndefined();
    expect(frameRecords).toHaveLength(0);
    expect(jsonl).not.toContain("agentSnapshotsAfterStep");
    expect(jsonl).not.toContain("actorSnapshotsAfterStep");
    expect(jsonl).not.toContain("\"agents\":[");
    expect(header).toMatchObject({
      artifactVersion: "harness.match.v2",
      kind: "match",
      runId: "artifact-jsonl-completed",
      seed: initialState.seed,
      rulesetId: initialState.config.rulesetId,
      status: "completed",
      truncationReason: null,
      failureReason: null,
      failureStateHash: null,
      forkOf: null,
      models: ["alpha", "beta"]
    });
    expect(matchMetrics).toMatchObject({
      runId: artifact.runId,
      metrics: artifact.metrics
    });
    expect(evaluationReport).toMatchObject({
      runId: artifact.runId,
      id: artifact.evaluationReport.id,
      status: "incomplete",
      failureCount: 1,
      failures: artifact.evaluationReport.failures,
      evaluatorIds: artifact.evaluationReport.evaluatorIds,
      warnings: [expect.objectContaining({ code: "test.warning", severity: "warning", evaluatorId: WEREWOLF_ADVERSARIAL_EVALUATOR_ID })],
      warningSummary: expect.objectContaining({
        warningCount: 1,
        warningSeverityCounts: { info: 0, warning: 1 },
        warningCodes: [
          expect.objectContaining({
            code: "test.warning",
            severity: "warning",
            count: 1,
            evaluatorIds: [WEREWOLF_ADVERSARIAL_EVALUATOR_ID],
            metricIds: ["agent.reward"]
          })
        ]
      }),
      evaluatorRegistry: expect.arrayContaining([
        expect.objectContaining({
          id: WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.adversarial.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_ADVERSARIAL_METRIC_IDS,
          dependencies: {},
          aggregation: "compatibility_output",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_OUTCOME_EVALUATOR_ID,
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.outcome.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_OUTCOME_METRIC_IDS,
          dependencies: {},
          aggregation: "weighted_reward_summary",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.role-survival.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
          dependencies: {},
          aggregation: "survival_rate_by_agent_and_role",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.social-calibration.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
          dependencies: {},
          aggregation: "postgame_calibration_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: SOCIAL_STATE_EVALUATOR_ID,
          inputSchema: "harness.social-state.evaluation-context.v1",
          outputSchema: "harness.social-state.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_STATE_METRIC_IDS,
          dependencies: {},
          aggregation: "agent_social_state_summary",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
          inputSchema: "harness.commitment-coalition-association.evaluation-context.v1",
          outputSchema: "harness.commitment-coalition-association.summary.v1",
          mode: "deterministic",
          metricIds: COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
          dependencies: {
            socialState: "AgentSocialState.commitments, AgentSocialState.coalitions, and evidence-backed social-state records"
          },
          aggregation: "zero_weight_commitment_coalition_association_by_agent",
          visibility: "postgame"
        }),
        expect.objectContaining({
          id: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          inputSchema: "harness.commitment-coalition-lifecycle-temporal-association.evaluation-context.v1",
          outputSchema: "harness.commitment-coalition-lifecycle-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
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
          inputSchema: "harness.social-fact-ingest-evidence.evaluation-context.v1",
          outputSchema: "harness.social-fact-ingest-evidence.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
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
          inputSchema: "harness.social-dynamics.evaluation-context.v1",
          outputSchema: "harness.social-dynamics.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_DYNAMICS_METRIC_IDS,
          dependencies: {},
          aggregation: "agent_social_dynamics_summary",
          visibility: "postgame"
        })
      ]),
      metricCount: artifact.evaluationReport.metricCount,
      summary: artifact.evaluationReport.summary
    });
    expect(channelRecords).toHaveLength(artifact.socialEpisode.channels.length);
    expect(socialStepRecords).toHaveLength(artifact.socialEpisode.steps.length);
    expect(stepRecords).toHaveLength(artifact.trajectory.length);
    expect(traceRecords).toHaveLength(artifact.trajectory.length);
    expect(messageRecords).toHaveLength(artifact.socialEpisode.messages.length);
    const expectedSocialSpeechActRecords = artifact.socialEpisode.messages.flatMap((message) => message.speechActs ?? []);
    const expectedSocialDeliveryReceiptRecords = artifact.socialEpisode.messages.flatMap((message) => message.deliveryReceipts ?? []);
    expect(socialSpeechActRecords).toHaveLength(expectedSocialSpeechActRecords.length);
    expect(socialDeliveryReceiptRecords).toHaveLength(expectedSocialDeliveryReceiptRecords.length);
    expect(socialSpeechActRecords.length).toBeGreaterThan(0);
    expect(socialDeliveryReceiptRecords.length).toBeGreaterThan(0);
    const expectedExposureRecords = deriveSocialExposureRecords(artifact.socialEpisode);
    const expectedMutationRecords = artifact.agents.flatMap((agent) => agent.social?.journal?.entries ?? []);
    expect(socialExposureRecords).toHaveLength(expectedExposureRecords.length);
    expect(socialExposureRecords.length).toBeGreaterThan(0);
    expect(eventRecords).toHaveLength(artifact.events.length);
    expect(metricRecords).toHaveLength(artifact.evaluationReport.metrics.length);
    expect(metricRecords.every((record) => !("warnings" in record) && !("warningSummary" in record))).toBe(true);
    expect(metricRecords.find((record) => record.id === "agent.social.commitment_speech_act_ingest_link_count")).toMatchObject({
      evaluatorId: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      weight: 0,
      aggregation: "sum",
      metadata: expect.objectContaining({
        coverageLevel: "explicit_scoped_exposure_to_social_state_mutation",
        causalClaim: false
      })
    });
    expect(agentStateRecords).toHaveLength(artifact.agents.length);
    expect(socialMutationRecords).toHaveLength(expectedMutationRecords.length);
    expect(socialMutationRecords.length).toBeGreaterThan(0);
    expect(records.filter((record) => record.type === "error")).toHaveLength(0);
    expect(records).toHaveLength(
      3 +
        artifact.socialEpisode.channels.length +
        artifact.socialEpisode.steps.length +
        artifact.trajectory.length +
        artifact.trajectory.length +
        artifact.socialEpisode.messages.length +
        expectedSocialSpeechActRecords.length +
        expectedSocialDeliveryReceiptRecords.length +
        expectedExposureRecords.length +
        artifact.events.length +
        artifact.agents.length +
        expectedMutationRecords.length +
        artifact.evaluationReport.metrics.length
    );
    expect(artifact.agents).toHaveLength(result.agents.length);
    expect(artifact.agents.every((agent) => agent.social && agent.socialStateHash)).toBe(true);
    expect(agentStateRecords[0]).toMatchObject({
      runId: artifact.runId,
      playerId: artifact.agents[0].playerId,
      model: artifact.agents[0].model,
      socialStateHash: artifact.agents[0].socialStateHash,
      social: expect.objectContaining({
        agentId: artifact.agents[0].playerId,
        journal: expect.objectContaining({ schemaVersion: "harness.social-state-journal.v1" })
      })
    });
    expect(socialMutationRecords[0]).toMatchObject({
      runId: artifact.runId,
      playerId: expect.any(String),
      agentId: expect.any(String),
      socialStateHash: expect.any(String),
      journalSeq: expect.any(Number),
      seq: expect.any(Number),
      store: expect.any(String),
      mutationKind: expect.any(String),
      evidenceRefs: expect.any(Array),
      redactionClass: "agent_private_summary",
      hiddenTruthUsed: false
    });
    expect(JSON.stringify(socialMutationRecords[0])).not.toMatch(/privateMemo|authorization|api[_-]?key/i);

    const firstStep = artifact.trajectory[0];
    const firstNativeStep = artifact.socialEpisode.steps.find((step) => step.traceId === firstStep.traceId);
    const firstSocialStep = artifact.socialEpisode.steps[0];
    expect(socialStepRecords[0]).toMatchObject({
      runId: artifact.runId,
      matchId: artifact.matchId ?? null,
      episodeId: artifact.socialEpisode.id,
      traceId: firstSocialStep.traceId,
      turnIndex: firstSocialStep.turnIndex,
      batchId: firstSocialStep.batchId ?? null,
      batchIndex: firstSocialStep.batchIndex ?? null,
      batchSize: firstSocialStep.batchSize ?? null,
      actorId: firstSocialStep.actorId,
      profileId: firstSocialStep.profileId,
      schedulerMode: firstSocialStep.schedulerMode,
      atomic: firstSocialStep.atomic ?? false,
      resolutionPolicy: firstSocialStep.resolutionPolicy ?? null,
      pendingAction: firstSocialStep.pendingAction,
      observation: firstSocialStep.observation,
      action: firstSocialStep.action,
      decisionStateHash: firstSocialStep.decisionStateHash ?? null,
      preStateHash: firstSocialStep.preStateHash ?? null,
      postStateHash: firstSocialStep.postStateHash ?? null,
      eventSeqRange: firstSocialStep.eventSeqRange ?? null,
      messageSeqRange: firstSocialStep.messageSeqRange ?? null,
      error: firstSocialStep.error ?? null
    });
    expect(socialStepRecords.some((record) => record.schedulerMode === "aec-batched-decision" && record.batchId)).toBe(true);
    expect(stepRecords[0]).toMatchObject({
      traceId: firstStep.traceId,
      turnIndex: firstStep.turnIndex,
      actorId: firstStep.actorId,
      model: firstStep.model,
      pendingAction: firstStep.pendingAction,
      command: firstStep.command,
      agentStateHash: firstStep.agentStateHash,
      decisionStateHash: firstStep.decisionStateHash,
      preStateHash: firstStep.preStateHash,
      postStateHash: firstStep.postStateHash,
      eventSeqRange: firstStep.eventSeqRange,
      messageSeqRange: firstStep.messageSeqRange,
      observation: firstStep.observation,
      policyPlan: firstStep.policyPlan,
      reasonerOutput: firstStep.reasonerOutput
    });
    expect(traceRecords[0]).toMatchObject({
      traceId: firstStep.traceId,
      turnIndex: firstNativeStep?.turnIndex,
      actorId: firstStep.actorId,
      model: firstStep.model,
      actionKind: firstStep.pendingAction.kind,
      commandType: firstStep.command.type,
      turnTrace: firstStep.turnTrace,
      agentStateHash: firstStep.agentStateHash,
      decisionStateHash: firstStep.decisionStateHash,
      preStateHash: firstStep.preStateHash,
      postStateHash: firstStep.postStateHash,
      eventSeqRange: firstStep.eventSeqRange
    });
    expect(traceRecords[0].turnTrace.traceId).toBe(firstStep.traceId);
    expect(traceRecords[0].turnTrace.commandType).toBe(firstStep.command.type);
    expect(eventRecords.map((event) => event.eventType)).toEqual(artifact.events.map((event) => event.type));
    expect(eventRecords.map((event) => event.seq)).toEqual(artifact.events.map((event) => event.seq));
    expect(eventRecords.some((event) => event.eventType === "game.ended")).toBe(true);
    expect(messageRecords.map((message) => message.seq)).toEqual(artifact.socialEpisode.messages.map((message) => message.seq));
    const firstMessageWithSpeechAct = artifact.socialEpisode.messages.find((message) => (message.speechActs?.length ?? 0) > 0);
    const firstSpeechAct = firstMessageWithSpeechAct?.speechActs?.[0];
    if (!firstMessageWithSpeechAct || !firstSpeechAct) throw new Error("Expected at least one social speech act record.");
    expect(socialSpeechActRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: artifact.runId,
          matchId: artifact.matchId ?? null,
          messageId: firstMessageWithSpeechAct.id,
          messageSeq: firstMessageWithSpeechAct.seq,
          channelId: firstMessageWithSpeechAct.channelId,
          senderId: firstMessageWithSpeechAct.senderId,
          visibility: firstMessageWithSpeechAct.visibility,
          speechActId: firstSpeechAct.id,
          kind: firstSpeechAct.kind,
          evidenceRefs: expect.arrayContaining([
            expect.objectContaining({ artifact: "message", id: firstMessageWithSpeechAct.id, seq: firstMessageWithSpeechAct.seq })
          ])
        })
      ])
    );
    const firstMessageWithReceipt = artifact.socialEpisode.messages.find((message) => (message.deliveryReceipts?.length ?? 0) > 0);
    const firstReceipt = firstMessageWithReceipt?.deliveryReceipts?.[0];
    if (!firstMessageWithReceipt || !firstReceipt) throw new Error("Expected at least one social delivery receipt record.");
    expect(socialDeliveryReceiptRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: artifact.runId,
          matchId: artifact.matchId ?? null,
          messageId: firstMessageWithReceipt.id,
          messageSeq: firstMessageWithReceipt.seq,
          receiptId: firstReceipt.id,
          channelId: firstMessageWithReceipt.channelId,
          senderId: firstMessageWithReceipt.senderId,
          observerId: firstReceipt.observerId,
          visibility: firstMessageWithReceipt.visibility,
          redactionPolicy: firstReceipt.redactionPolicy
        })
      ])
    );
    expect(socialExposureRecords[0]).toMatchObject({
      runId: artifact.runId,
      messageId: expectedExposureRecords[0].messageId,
      messageSeq: expectedExposureRecords[0].messageSeq,
      sourceId: expectedExposureRecords[0].sourceId,
      observerId: expectedExposureRecords[0].observerId,
      observedAtTraceId: expectedExposureRecords[0].observedAtTraceId,
      observedAtTurnIndex: expectedExposureRecords[0].observedAtTurnIndex,
      observedAtActionKind: expectedExposureRecords[0].observedAtActionKind,
      channelId: expectedExposureRecords[0].channelId,
      visibility: expectedExposureRecords[0].visibility,
      kind: expectedExposureRecords[0].kind,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: expectedExposureRecords[0].messageId }),
        ...(expectedExposureRecords[0].deliveryReceipt
          ? [expect.objectContaining({ artifact: "delivery_receipt", id: expectedExposureRecords[0].deliveryReceipt.id })]
          : []),
        expect.objectContaining({ artifact: "trace", traceId: expectedExposureRecords[0].observedAtTraceId }),
        expect.objectContaining({ artifact: "observation", traceId: expectedExposureRecords[0].observedAtTraceId })
      ])
    });
    expect(socialExposureRecords.some((record) => record.messageId && record.observerId && record.observedAtTraceId)).toBe(true);
    expect(metricRecords.every((metric) => metric.evaluationReportId === artifact.evaluationReport.id)).toBe(true);
    expect(metricRecords.map((metric) => metric.id)).toEqual(
      expect.arrayContaining([
        "team.reward",
        "agent.reward",
        "profile.agent_reward",
        "model.agent_reward",
        "agent.survival_rate",
        "agent.wolf_belief_brier_score",
        "agent.social.memory_count",
        "agent.social.journal_entry_count",
        "agent.social.commitment_status_temporal_association_count",
        "agent.social.coalition_lifecycle_temporal_association_count",
        "agent.social.coordination_message_count"
      ])
    );
    expect(metricRecords.find((metric) => metric.id === "agent.reward")).toMatchObject({
      evaluatorId: WEREWOLF_OUTCOME_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), role: expect.any(String), team: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: expect.any(String),
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "trace", traceId: expect.any(String) })])
    });
    expect(metricRecords.find((metric) => metric.id === "agent.survival_rate")).toMatchObject({
      evaluatorId: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), role: expect.any(String), team: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "ratio",
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "event" })])
    });
    expect(metricRecords.find((metric) => metric.id === "agent.wolf_belief_brier_score")).toMatchObject({
      evaluatorId: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "average_brier_score",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "agent_state", id: expect.any(String) }),
        expect.objectContaining({ artifact: "state", description: "postgame team truth for wolf belief calibration" })
      ])
    });
    expect(metricRecords.find((metric) => metric.id === "agent.social.memory_count")).toMatchObject({
      evaluatorId: SOCIAL_STATE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      evidenceRefs: [expect.objectContaining({ artifact: "agent_state", id: expect.any(String) })]
    });
    expect(metricRecords.find((metric) => metric.id === "agent.social.commitment_status_temporal_association_count")).toMatchObject({
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
    expect(metricRecords.find((metric) => metric.id === "agent.social.coalition_lifecycle_temporal_association_count")).toMatchObject({
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
    expect(metricRecords.find((metric) => metric.id === "agent.social.coordination_message_count")).toMatchObject({
      evaluatorId: SOCIAL_DYNAMICS_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      evidenceRefs: expect.any(Array)
    });
  }, 60000);

  it("exports agent snapshot frames as JSONL summaries without full snapshot payloads", async () => {
    const initialState = createGame({ id: "artifact-jsonl-snapshot-frames", seed: "artifact-jsonl-snapshot-frames" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-jsonl-snapshot-frames",
      matchId: "artifact-jsonl-snapshot-frames-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });

    expect(validateMatchArtifactIntegrity(artifact)).toEqual([]);
    expect(artifact.agentSnapshotFrames?.length).toBeGreaterThan(0);
    expect(artifact.trajectory.every((step) => !step.agentSnapshotsAfterStep && step.agentSnapshotFrameIdAfterStep)).toBe(true);
    expect(
      artifact.socialEpisode.steps
        .filter((step) => isSocialStepCommitted(step) && step.actorId !== "system")
        .every((step) => !step.actorSnapshotsAfterStep && step.actorSnapshotFrameIdAfterStep)
    ).toBe(true);

    const jsonl = toTrajectoryJsonl(artifact);
    const records = parseJsonl(jsonl);
    const frameRecords = records.filter((record) => record.type === "agent_snapshot_frame");
    const stepRecords = records.filter((record) => record.type === "step");
    const traceRecords = records.filter((record) => record.type === "trace");
    const socialStepRecords = records.filter((record) => record.type === "social_step");

    expect(frameRecords).toHaveLength(artifact.agentSnapshotFrames?.length ?? 0);
    expect(frameRecords[0]).toMatchObject({
      type: "agent_snapshot_frame",
      runId: artifact.runId,
      matchId: artifact.matchId,
      frameId: expect.stringMatching(/^agent-snapshot:/),
      agentsHash: expect.any(String),
      agentCount: artifact.finalState.players.length
    });
    for (const frameRecord of frameRecords) {
      expect(frameRecord).not.toHaveProperty("agents");
      expect(frameRecord).not.toHaveProperty("privateMemos");
      expect(frameRecord).not.toHaveProperty("social");
      expect(frameRecord).not.toHaveProperty("journal");
    }
    expect(stepRecords[0]).toMatchObject({
      agentSnapshotsHashAfterStep: artifact.trajectory[0].agentSnapshotsHashAfterStep,
      agentSnapshotFrameIdAfterStep: artifact.trajectory[0].agentSnapshotFrameIdAfterStep
    });
    expect(traceRecords[0]).toMatchObject({
      agentSnapshotsHashAfterStep: artifact.trajectory[0].agentSnapshotsHashAfterStep,
      agentSnapshotFrameIdAfterStep: artifact.trajectory[0].agentSnapshotFrameIdAfterStep
    });
    expect(socialStepRecords[0]).toMatchObject({
      actorSnapshotsHashAfterStep: artifact.socialEpisode.steps[0].actorSnapshotsHashAfterStep ?? null,
      actorSnapshotFrameIdAfterStep: artifact.socialEpisode.steps[0].actorSnapshotFrameIdAfterStep ?? null
    });
    expect(jsonl).not.toContain("agentSnapshotsAfterStep");
    expect(jsonl).not.toContain("actorSnapshotsAfterStep");
    expect(JSON.stringify(frameRecords)).not.toMatch(/privateMemos|journal|beliefs|social/i);
  });

  it("binds recorded metric-promotion decisions to report provenance and rejects tampering", async () => {
    const initialState = createGame({ id: "artifact-promotion-integrity", seed: "artifact-promotion-integrity" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-promotion-integrity",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const recordedMetricIndex = artifact.evaluationReport.metrics.findIndex((metric) => Boolean(metric.promotionDecision));
    const eligibleMetricIndex = artifact.evaluationReport.metrics.findIndex(
      (metric) => metric.promotionDecision?.eligibleForScorecard
    );
    if (recordedMetricIndex < 0 || eligibleMetricIndex < 0) {
      throw new Error("Expected a generated artifact with recorded scorecard promotion decisions.");
    }

    expect(artifact.evaluationReport.metrics.every((metric) => metric.promotionDecision?.resolution === "recorded")).toBe(true);
    expect(validateMatchArtifactIntegrity(artifact)).toEqual([]);
    const metricRecord = parseJsonl(toTrajectoryJsonl(artifact)).find(
      (record) => record.type === "metric" && record.id === artifact.evaluationReport.metrics[recordedMetricIndex]?.id
    );
    expect(metricRecord).toMatchObject({ promotionDecision: expect.objectContaining({ resolution: "recorded" }) });

    const identityTamper = cloneJson(artifact);
    identityTamper.evaluationReport.metrics[recordedMetricIndex]!.promotionDecision!.policyHash = "tampered-policy-hash";
    expect(validateMatchArtifactIntegrity(identityTamper).join("\n")).toMatch(/promotionDecision\.policyHash mismatch/);

    const missingDecision = cloneJson(artifact);
    delete missingDecision.evaluationReport.metrics[recordedMetricIndex]!.promotionDecision;
    expect(validateMatchArtifactIntegrity(missingDecision).join("\n")).toMatch(/missing promotionDecision/);

    const eligibilityTamper = cloneJson(artifact);
    eligibilityTamper.evaluationReport.metrics[eligibleMetricIndex]!.evidenceRefs = [];
    expect(validateMatchArtifactIntegrity(eligibilityTamper).join("\n")).toMatch(/scorecard-eligible decision requires evidenceRefs/);

    const aggregateTamper = cloneJson(artifact);
    aggregateTamper.evaluationReport.summary.promotion.scorecardMetricCount += 1;
    expect(validateMatchArtifactIntegrity(aggregateTamper).join("\n")).toMatch(/scorecardMetricCount mismatch/);

    const legacyCompatible = cloneJson(artifact);
    for (const metric of legacyCompatible.evaluationReport.metrics) delete metric.promotionDecision;
    delete (legacyCompatible.evaluationReport.summary.promotion as { decisionStorage?: string }).decisionStorage;
    expect(validateMatchArtifactIntegrity(legacyCompatible)).toEqual([]);
  });

  it("redacts snapshot frame payloads before committing frame hashes", async () => {
    const secretMemo = "Bearer artifactFrameSecretShouldNotLeak123456";
    const secretReasoner: HarnessReasoner = {
      async think(input) {
        const content = `frame redaction sentinel ${secretMemo} ${input.action.kind}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `frame-redaction-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const initialState = createGame({ id: "artifact-frame-redaction", seed: "artifact-frame-redaction" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: secretReasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-frame-redaction",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });

    const artifactText = JSON.stringify(artifact);
    expect(artifact.agentSnapshotFrames?.length).toBeGreaterThan(0);
    expect(artifactText).not.toContain(secretMemo);
    expect(artifactText).toContain("Bearer [REDACTED]");
    expect(validateMatchArtifactIntegrity(artifact)).toEqual([]);
    for (const step of artifact.trajectory) {
      const snapshots = resolveAgentSnapshotsAfterStep(artifact, step);
      expect(step.agentSnapshotsHashAfterStep).toBe(hashStableState(snapshots));
      expect(JSON.stringify(snapshots)).not.toContain(secretMemo);
    }
  });

  it("validates social sidecar message ranges, scoped exposure evidence, and journal ranges", async () => {
    const initialState = createGame({ id: "artifact-integrity-social-sidecar", seed: "artifact-integrity-social-sidecar" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 8
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-integrity-social-sidecar",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });

    expect(validateMatchArtifactIntegrity(artifact)).toEqual([]);
    expect(artifact.socialEpisode.messages.length).toBeGreaterThan(0);
    expect(artifact.socialEpisode.steps.some((step) => step.messageSeqRange)).toBe(true);
    expect(deriveSocialExposureRecords(artifact.socialEpisode).length).toBeGreaterThan(0);
    expect(artifact.agents.some((agent) => (agent.social?.journal?.entries.length ?? 0) > 0)).toBe(true);

    const retrievalTamper = cloneJson(artifact);
    const retrievalStep = retrievalTamper.trajectory.find((step) => step.policyPlan.memoryRetrieval);
    if (!retrievalStep?.policyPlan.memoryRetrieval?.selected[0] || !retrievalStep.turnTrace.memoryRetrieval?.selected[0]) {
      throw new Error("Expected recorded actor-memory retrieval evidence.");
    }
    retrievalStep.turnTrace.memoryRetrieval.selected[0].rank = 2;
    (retrievalStep.policyPlan.memoryRetrieval.selected[0] as unknown as Record<string, unknown>).content = "must-not-persist";
    const retrievalErrors = validateMatchArtifactIntegrity(retrievalTamper).join("\n");
    expect(retrievalErrors).toMatch(/does not match turnTrace\.memoryRetrieval/);
    expect(retrievalErrors).toMatch(/must not persist raw memory content/);

    const pendingEvidenceTamper = cloneJson(artifact);
    const inspectStep = pendingEvidenceTamper.socialEpisode.steps.find((step: any) =>
      step.commitStatus === "committed" && step.action.command.type === "seer.inspect"
    );
    if (!inspectStep) throw new Error("Expected a recorded Seer inspect step.");
    inspectStep.pendingAction = {
      kind: "vote",
      phase: "day_vote",
      actorId: inspectStep.actorId,
      legalTargetIds: []
    } as any;
    expect(validateMatchArtifactIntegrity(pendingEvidenceTamper).join("\n")).toMatch(/recorded pending\/action evidence mismatch/i);

    const seqTamper = cloneJson(artifact);
    seqTamper.socialEpisode.messages[0].seq = 99;
    expect(validateMatchArtifactIntegrity(seqTamper).join("\n")).toMatch(/socialEpisode\.messages\[0\] sequence mismatch/);

    const rangeTamper = cloneJson(artifact);
    const rangedStepIndex = rangeTamper.socialEpisode.steps.findIndex((step) => step.messageSeqRange);
    if (rangedStepIndex < 0) throw new Error("Expected a social step with a messageSeqRange.");
    rangeTamper.socialEpisode.steps[rangedStepIndex].messageSeqRange = [999, 1000];
    const rangeErrors = validateMatchArtifactIntegrity(rangeTamper).join("\n");
    expect(rangeErrors).toMatch(/messageSeqRange/);
    expect(rangeErrors).toMatch(/trajectory\[\d+\] messageSeqRange mismatch/);

    const exposureTamper = cloneJson(artifact);
    const exposureStep = exposureTamper.socialEpisode.steps.find((step: any) => step.observation?.view?.social?.messages?.length) as any;
    if (!exposureStep) throw new Error("Expected a social step with scoped social-message exposure.");
    exposureStep.observation.view.social.messages[0] = {
      ...exposureStep.observation.view.social.messages[0],
      id: "msg-does-not-exist",
      seq: 999
    };
    expect(validateMatchArtifactIntegrity(exposureTamper).join("\n")).toMatch(/observation .*references uncommitted social message/);

    const journalTamper = cloneJson(artifact);
    const agentWithJournal = journalTamper.agents.find((agent) => (agent.social?.journal?.entries.length ?? 0) > 0) as any;
    if (!agentWithJournal?.social?.journal.entries.length) throw new Error("Expected an agent social journal entry.");
    agentWithJournal.social.journal.entries[0].evidenceRefs = [];
    agentWithJournal.social.journal.entries[0].messageSeqRange = { start: 999, end: 999 };
    agentWithJournal.social.journal.entries[0].hiddenTruthUsed = true;
    const journalErrors = validateMatchArtifactIntegrity(journalTamper).join("\n");
    expect(journalErrors).toMatch(/missing evidenceRefs/);
    expect(journalErrors).toMatch(/messageSeqRange references missing seq 999/);
    expect(journalErrors).toMatch(/uses hidden truth/);
  }, 60000);

  it("validates recoverable per-step agent snapshots for prefix checkpoints", async () => {
    const initialState = createGame({ id: "artifact-agent-prefix-snapshots", seed: "artifact-agent-prefix-snapshots" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-agent-prefix-snapshots",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const playerIds = artifact.finalState.players.map((player) => player.id).sort();
    const firstStep = artifact.trajectory[0];
    const firstSnapshot = firstStep ? resolveAgentSnapshotsAfterStep(artifact, firstStep) : undefined;
    if (!firstStep || !firstSnapshot) throw new Error("Expected first step agent snapshot frame.");

    expect(validateMatchArtifactIntegrity(artifact)).toEqual([]);
    expect(artifact.agentSnapshotFrames?.length).toBeGreaterThan(0);
    expect(artifact.trajectory.every((step) => !step.agentSnapshotsAfterStep && step.agentSnapshotFrameIdAfterStep)).toBe(true);
    expect(
      artifact.socialEpisode.steps
        .filter((step) => isSocialStepCommitted(step) && step.actorId !== "system")
        .every((step) => !step.actorSnapshotsAfterStep && step.actorSnapshotFrameIdAfterStep)
    ).toBe(true);
    for (const step of artifact.trajectory) {
      const snapshots = resolveAgentSnapshotsAfterStep(artifact, step);
      expect(snapshots?.map((agent) => agent.playerId).sort()).toEqual(playerIds);
      expect(step.agentSnapshotsHashAfterStep).toBe(hashStableState(snapshots));
      const actingAgent = snapshots?.find((agent) => agent.playerId === step.actorId);
      expect(actingAgent?.socialStateHash).toBe(step.agentStateHash);
    }
    const finalStep = artifact.trajectory.at(-1);
    expect(finalStep ? resolveAgentSnapshotsAfterStep(artifact, finalStep) : undefined).toEqual(artifact.agents);

    const missingFrame = cloneJson(artifact);
    missingFrame.agentSnapshotFrames = missingFrame.agentSnapshotFrames?.filter((frame) => frame.frameId !== missingFrame.trajectory[0].agentSnapshotFrameIdAfterStep);
    expect(validateMatchArtifactIntegrity(missingFrame).join("\n")).toMatch(/agentSnapshotsAfterStep/);

    const duplicateFrameId = cloneJson(artifact);
    if (!duplicateFrameId.agentSnapshotFrames?.[0]) throw new Error("Expected a snapshot frame.");
    duplicateFrameId.agentSnapshotFrames.push(cloneJson(duplicateFrameId.agentSnapshotFrames[0]));
    expect(validateMatchArtifactIntegrity(duplicateFrameId).join("\n")).toMatch(/Duplicate agent snapshot frame id/);

    const badFrameShape = cloneJson(artifact);
    if (!badFrameShape.agentSnapshotFrames?.[0]) throw new Error("Expected a snapshot frame.");
    badFrameShape.agentSnapshotFrames[0].artifactVersion = "harness.agent-snapshot-frame.v0" as any;
    badFrameShape.agentSnapshotFrames[0].kind = "agent-snapshot" as any;
    expect(validateMatchArtifactIntegrity(badFrameShape).join("\n")).toMatch(/artifactVersion must be harness\.agent-snapshot-frame\.v1/);
    expect(validateMatchArtifactIntegrity(badFrameShape).join("\n")).toMatch(/kind must be agent-snapshot-frame/);

    const badFrameId = cloneJson(artifact);
    if (!badFrameId.agentSnapshotFrames?.[0]) throw new Error("Expected a snapshot frame.");
    badFrameId.agentSnapshotFrames[0].frameId = "agent-snapshot:wrong-frame-id";
    const badFrameIdErrors = validateMatchArtifactIntegrity(badFrameId).join("\n");
    expect(badFrameIdErrors).toMatch(/frameId mismatch for agentsHash/);
    expect(badFrameIdErrors).toMatch(/references missing agent snapshot frame/);

    const missingPlayerFrame = cloneJson(artifact);
    if (!missingPlayerFrame.agentSnapshotFrames?.[0]) throw new Error("Expected a snapshot frame.");
    const missingPlayerOldFrameId = missingPlayerFrame.agentSnapshotFrames[0].frameId;
    missingPlayerFrame.agentSnapshotFrames[0].agents.pop();
    retargetSnapshotFrameRefs(missingPlayerFrame, missingPlayerOldFrameId, missingPlayerFrame.agentSnapshotFrames[0]);
    expect(validateMatchArtifactIntegrity(missingPlayerFrame).join("\n")).toMatch(/missing agent state for player/);

    const duplicatePlayerFrame = cloneJson(artifact);
    if (!duplicatePlayerFrame.agentSnapshotFrames?.[0]?.agents[1]) throw new Error("Expected a multi-agent snapshot frame.");
    const duplicatePlayerOldFrameId = duplicatePlayerFrame.agentSnapshotFrames[0].frameId;
    duplicatePlayerFrame.agentSnapshotFrames[0].agents[1] = cloneJson(duplicatePlayerFrame.agentSnapshotFrames[0].agents[0]);
    retargetSnapshotFrameRefs(duplicatePlayerFrame, duplicatePlayerOldFrameId, duplicatePlayerFrame.agentSnapshotFrames[0]);
    expect(validateMatchArtifactIntegrity(duplicatePlayerFrame).join("\n")).toMatch(/duplicates playerId/);

    const unknownPlayerFrame = cloneJson(artifact);
    if (!unknownPlayerFrame.agentSnapshotFrames?.[0]?.agents[0]) throw new Error("Expected a snapshot frame agent.");
    const unknownPlayerOldFrameId = unknownPlayerFrame.agentSnapshotFrames[0].frameId;
    unknownPlayerFrame.agentSnapshotFrames[0].agents[0].playerId = "unknown-player-in-frame";
    retargetSnapshotFrameRefs(unknownPlayerFrame, unknownPlayerOldFrameId, unknownPlayerFrame.agentSnapshotFrames[0]);
    expect(validateMatchArtifactIntegrity(unknownPlayerFrame).join("\n")).toMatch(/references unknown player unknown-player-in-frame/);

    const firstNativeStepIndex = artifact.socialEpisode.steps.findIndex(
      (step) => step.traceId === artifact.trajectory[0].traceId
    );
    if (firstNativeStepIndex < 0) throw new Error("Expected native social step for first trajectory entry.");

    const missingStepFrameRef = cloneJson(artifact);
    missingStepFrameRef.trajectory[0].agentSnapshotFrameIdAfterStep = "agent-snapshot:missing-step-ref";
    missingStepFrameRef.socialEpisode.steps[firstNativeStepIndex].actorSnapshotFrameIdAfterStep = "agent-snapshot:missing-step-ref";
    expect(validateMatchArtifactIntegrity(missingStepFrameRef).join("\n")).toMatch(/references missing agent snapshot frame agent-snapshot:missing-step-ref/);

    const orphanFrame = cloneJson(artifact);
    if (!orphanFrame.agentSnapshotFrames?.[0]) throw new Error("Expected a snapshot frame.");
    const extraFrame = cloneJson(orphanFrame.agentSnapshotFrames[0]);
    extraFrame.agents[0].privateMemos.push("orphan frame payload");
    extraFrame.agentsHash = hashStableState(extraFrame.agents);
    extraFrame.frameId = `agent-snapshot:${extraFrame.agentsHash}`;
    orphanFrame.agentSnapshotFrames.push(extraFrame);
    expect(validateMatchArtifactIntegrity(orphanFrame).join("\n")).toMatch(/is not referenced by any trajectory or social step/);

    const wrongStepFrameHash = cloneJson(artifact);
    wrongStepFrameHash.trajectory[0].agentSnapshotsHashAfterStep = "wrong-step-snapshot-hash";
    wrongStepFrameHash.socialEpisode.steps[firstNativeStepIndex].actorSnapshotsHashAfterStep = "wrong-step-snapshot-hash";
    expect(validateMatchArtifactIntegrity(wrongStepFrameHash).join("\n")).toMatch(/agentSnapshotFrameIdAfterStep hash mismatch/);

    const socialFrameRefMismatch = cloneJson(artifact);
    socialFrameRefMismatch.socialEpisode.steps[firstNativeStepIndex].actorSnapshotFrameIdAfterStep = "agent-snapshot:missing-social-ref";
    const socialFrameRefMismatchErrors = validateMatchArtifactIntegrity(socialFrameRefMismatch).join("\n");
    expect(socialFrameRefMismatchErrors).toMatch(/agentSnapshotFrameIdAfterStep mismatch with socialEpisode step/);
    expect(socialFrameRefMismatchErrors).toMatch(/actorSnapshotFrameIdAfterStep references missing agent snapshot frame/);

    const privateMemoTamper = cloneJson(artifact);
    const firstFrame = privateMemoTamper.agentSnapshotFrames?.find((frame) => frame.frameId === privateMemoTamper.trajectory[0].agentSnapshotFrameIdAfterStep);
    if (!firstFrame) throw new Error("Expected first snapshot frame.");
    firstFrame.agents[0].privateMemos.push("future memo injected into prefix snapshot frame");
    expect(validateMatchArtifactIntegrity(privateMemoTamper).join("\n")).toMatch(/agentsHash mismatch/);

    const actingHashTamper = cloneJson(artifact);
    const actingFrame = actingHashTamper.agentSnapshotFrames?.find((frame) => frame.frameId === actingHashTamper.trajectory[0].agentSnapshotFrameIdAfterStep);
    if (!actingFrame) throw new Error("Expected acting snapshot frame.");
    const actingSnapshot = actingFrame.agents.find((agent) => agent.playerId === actingHashTamper.trajectory[0].actorId);
    if (!actingSnapshot) throw new Error("Expected acting snapshot.");
    actingSnapshot.socialStateHash = "tampered-social-state-hash";
    actingFrame.agentsHash = hashStableState(actingFrame.agents);
    actingFrame.frameId = `agent-snapshot:${actingFrame.agentsHash}`;
    actingHashTamper.trajectory[0].agentSnapshotsHashAfterStep = actingFrame.agentsHash;
    actingHashTamper.trajectory[0].agentSnapshotFrameIdAfterStep = actingFrame.frameId;
    const actingSocialStep = actingHashTamper.socialEpisode.steps.find((step) => step.traceId === actingHashTamper.trajectory[0].traceId);
    if (actingSocialStep) {
      actingSocialStep.actorSnapshotsHashAfterStep = actingFrame.agentsHash;
      actingSocialStep.actorSnapshotFrameIdAfterStep = actingFrame.frameId;
    }
    expect(validateMatchArtifactIntegrity(actingHashTamper).join("\n")).toMatch(/agentStateHash mismatch/);

    const futureTraceTamper = cloneJson(artifact);
    const safeBoundaryIndex = firstSafePrefixLength(futureTraceTamper) - 1;
    const futureTraceId = futureTraceTamper.trajectory.slice(safeBoundaryIndex + 1).at(-1)?.traceId;
    if (!futureTraceId || futureTraceId === futureTraceTamper.trajectory[safeBoundaryIndex].traceId) throw new Error("Expected a future trace id.");
    const futureTraceFrame = futureTraceTamper.agentSnapshotFrames?.find(
      (frame) => frame.frameId === futureTraceTamper.trajectory[safeBoundaryIndex].agentSnapshotFrameIdAfterStep
    );
    if (!futureTraceFrame) throw new Error("Expected future trace snapshot frame.");
    const snapshotAgentWithJournal = futureTraceFrame.agents.find((agent) => agent.social?.journal?.entries.length);
    if (!snapshotAgentWithJournal?.social?.journal?.entries.length) throw new Error("Expected snapshot social journal.");
    snapshotAgentWithJournal.social.journal.entries[0].evidenceRefs.push({
      artifact: "trace",
      traceId: futureTraceId
    });
    futureTraceFrame.agentsHash = hashStableState(futureTraceFrame.agents);
    futureTraceFrame.frameId = `agent-snapshot:${futureTraceFrame.agentsHash}`;
    futureTraceTamper.trajectory[safeBoundaryIndex].agentSnapshotsHashAfterStep = futureTraceFrame.agentsHash;
    futureTraceTamper.trajectory[safeBoundaryIndex].agentSnapshotFrameIdAfterStep = futureTraceFrame.frameId;
    const futureTraceSocialStep = futureTraceTamper.socialEpisode.steps.find(
      (step) => step.traceId === futureTraceTamper.trajectory[safeBoundaryIndex].traceId
    );
    if (futureTraceSocialStep) {
      futureTraceSocialStep.actorSnapshotsHashAfterStep = futureTraceFrame.agentsHash;
      futureTraceSocialStep.actorSnapshotFrameIdAfterStep = futureTraceFrame.frameId;
    }
    const nativeBoundaryIndex = futureTraceTamper.socialEpisode.steps.findIndex(
      (step) => step.traceId === futureTraceTamper.trajectory[safeBoundaryIndex].traceId
    );
    if (nativeBoundaryIndex < 0) throw new Error("Expected native boundary step.");
    expect(validateMatchArtifactIntegrity(futureTraceTamper)).toEqual([]);
    expect(() =>
      buildHarnessCheckpointAtPrefix({
        artifact: futureTraceTamper,
        selector: { nativeStepCount: nativeBoundaryIndex + 1 },
        checkpointId: "future-trace-tamper"
      })
    ).toThrow(/future trace/);
  }, 30000);

  it("rejects unsafe prefix checkpoint selectors and boundaries with stable error codes", async () => {
    const initialState = createGame({ id: "artifact-prefix-selector-errors", seed: "artifact-prefix-selector-errors" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-prefix-selector-errors",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });

    expectCheckpointSelectionError(
      () => buildHarnessCheckpointAtPrefix({ artifact, selector: {}, checkpointId: "prefix-no-selector" }),
      "selector_not_found",
      /exactly one selector/
    );
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact,
          selector: { traceId: artifact.trajectory[0].traceId, nativeTurnIndex: artifact.socialEpisode.steps.find((step) => step.traceId === artifact.trajectory[0].traceId)!.turnIndex },
          checkpointId: "prefix-ambiguous-selector"
        }),
      "ambiguous_selector",
      /ambiguous/
    );
    expectCheckpointSelectionError(
      () => buildHarnessCheckpointAtPrefix({ artifact, selector: { traceId: "missing-trace" }, checkpointId: "prefix-missing-trace" }),
      "selector_not_found",
      /did not match/
    );
    expectCheckpointSelectionError(
      () => buildHarnessCheckpointAtPrefix({ artifact, selector: { nativeTurnIndex: 999_999 }, checkpointId: "prefix-missing-turn" }),
      "selector_not_found",
      /did not match/
    );
    expectCheckpointSelectionError(
      () => buildHarnessCheckpointAtPrefix({ artifact, selector: { nativeStepCount: 999_999 }, checkpointId: "prefix-out-of-range" }),
      "selector_not_found",
      /did not match/
    );

    const noSnapshotState = createGame({ id: "artifact-prefix-no-snapshots", seed: "artifact-prefix-no-snapshots" });
    const noSnapshotAgents = resolveAgentConfigs(noSnapshotState.players, profiles, 0, 0.3);
    const noSnapshotResult = await runHarnessMatch({
      initialState: noSnapshotState,
      agents: noSnapshotAgents,
      reasoner: stubReasoner,
      maxTransitions: 4,
      recordAgentSnapshots: false
    });
    const noSnapshotArtifact = buildMatchArtifact({
      runId: "artifact-prefix-no-snapshots",
      seed: noSnapshotResult.initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(noSnapshotResult.initialState.players, noSnapshotAgents),
      result: noSnapshotResult
    });
    expect(noSnapshotArtifact.agentSnapshotFrames).toBeUndefined();
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact: noSnapshotArtifact,
          selector: { nativeStepCount: 1 },
          checkpointId: "prefix-missing-snapshots"
        }),
      "missing_agent_snapshots",
      /not recorded/
    );

    const wolfBatchSteps = artifact.socialEpisode.steps.filter((step) => step.action.kind === "werewolf.killVote");
    if (wolfBatchSteps.length < 2 || wolfBatchSteps[0].batchId !== wolfBatchSteps[1].batchId) {
      throw new Error("Expected a real native Werewolf decision batch.");
    }
    const firstBatchStepIndex = artifact.socialEpisode.steps.findIndex((step) => step.traceId === wolfBatchSteps[0].traceId);
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact,
          selector: { nativeStepCount: firstBatchStepIndex + 1 },
          checkpointId: "prefix-mid-batch-boundary"
        }),
      "unsafe_batch_boundary",
      /middle of a native scheduler batch/
    );
  }, 30000);

  it("rejects prefix checkpoint snapshots with future message or event evidence", async () => {
    const initialState = createGame({ id: "artifact-prefix-future-evidence", seed: "artifact-prefix-future-evidence" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-prefix-future-evidence",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const boundary = firstSafePrefixBoundaryWithFutureEvidence(artifact);

    const futureMessageRef = cloneJson(artifact);
    mutateSelectedPrefixSnapshotJournal(futureMessageRef, boundary.trajectoryLength, (entry) => {
      entry.evidenceRefs.push({ artifact: "message", seq: boundary.futureMessageSeq, id: `future-message-${boundary.futureMessageSeq}` });
    });
    expect(validateMatchArtifactIntegrity(futureMessageRef)).toEqual([]);
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact: futureMessageRef,
          selector: { nativeStepCount: boundary.nativeStepCount },
          checkpointId: "prefix-future-message-ref"
        }),
      "missing_agent_snapshots",
      /future message seq/
    );

    const futureMessageRange = cloneJson(artifact);
    mutateSelectedPrefixSnapshotJournal(futureMessageRange, boundary.trajectoryLength, (entry) => {
      entry.messageSeqRange = { start: boundary.futureMessageSeq, end: boundary.futureMessageSeq };
    });
    expect(validateMatchArtifactIntegrity(futureMessageRange)).toEqual([]);
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact: futureMessageRange,
          selector: { nativeStepCount: boundary.nativeStepCount },
          checkpointId: "prefix-future-message-range"
        }),
      "missing_agent_snapshots",
      /future social message seq/
    );

    const futureEventRef = cloneJson(artifact);
    mutateSelectedPrefixSnapshotJournal(futureEventRef, boundary.trajectoryLength, (entry) => {
      entry.evidenceRefs.push({ artifact: "event", seq: boundary.futureEventSeq, id: `future-event-${boundary.futureEventSeq}` });
    });
    expect(validateMatchArtifactIntegrity(futureEventRef)).toEqual([]);
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact: futureEventRef,
          selector: { nativeStepCount: boundary.nativeStepCount },
          checkpointId: "prefix-future-event-ref"
        }),
      "missing_agent_snapshots",
      /future event seq/
    );

    const futureEventRange = cloneJson(artifact);
    mutateSelectedPrefixSnapshotJournal(futureEventRange, boundary.trajectoryLength, (entry) => {
      entry.eventSeqRange = { start: boundary.futureEventSeq, end: boundary.futureEventSeq };
    });
    expect(validateMatchArtifactIntegrity(futureEventRange)).toEqual([]);
    expectCheckpointSelectionError(
      () =>
        buildHarnessCheckpointAtPrefix({
          artifact: futureEventRange,
          selector: { nativeStepCount: boundary.nativeStepCount },
          checkpointId: "prefix-future-event-range"
        }),
      "missing_agent_snapshots",
      /future event seq/
    );
  }, 60000);

  it("exports audit-critical records for a failed partial run", async () => {
    let calls = 0;
    const failingReasoner: HarnessReasoner = {
      async think(input) {
        calls += 1;
        if (calls === 2) throw new Error(`jsonl planned reasoner failure:${input.action.kind}`);
        const content = `jsonl-prefix:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 3,
            usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
            providerRequestId: `jsonl-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const initialState = createGame({ id: "artifact-jsonl-failed", seed: "artifact-jsonl-failed" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: failingReasoner,
      maxTransitions: 8
    });
    const artifact = buildMatchArtifact({
      runId: "artifact-jsonl-failed",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });

    const records = parseJsonl(toTrajectoryJsonl(artifact));
    const typeSet = new Set(records.map((record) => record.type));
    const header = findRecord(records, "header");
    const matchMetrics = findRecord(records, "match_metrics");
    const evaluationReport = findRecord(records, "evaluation_report");
    const step = findRecord(records, "step");
    const trace = findRecord(records, "trace");
    const event = records.find((record) => record.type === "event" && record.eventType === "harness.error");
    const error = findRecord(records, "error");
    const channelRecords = records.filter((record) => record.type === "channel");
    const socialStepRecords = records.filter((record) => record.type === "social_step");
    const metricRecords = records.filter((record) => record.type === "metric");
    const messageRecords = records.filter((record) => record.type === "message");
    const socialExposureRecords = records.filter((record) => record.type === "social_exposure");
    const agentStateRecords = records.filter((record) => record.type === "agent_state");
    const socialMutationRecords = records.filter((record) => record.type === "social_state_mutation");

    expect(result.status).toBe("failed");
    expect(Array.from(typeSet)).toEqual(
      expect.arrayContaining([
        "header",
        "match_metrics",
        "evaluation_report",
        "channel",
        "social_step",
        "step",
        "trace",
        "message",
        "event",
        "error",
        "agent_state",
        "social_state_mutation",
        "metric"
      ])
    );
    expect(socialStepRecords).toHaveLength(artifact.socialEpisode.steps.length);
    expect(socialStepRecords[0]).toMatchObject({
      runId: artifact.runId,
      episodeId: artifact.socialEpisode.id,
      traceId: artifact.socialEpisode.steps[0].traceId,
      schedulerMode: artifact.socialEpisode.steps[0].schedulerMode,
      action: artifact.socialEpisode.steps[0].action,
      eventSeqRange: artifact.socialEpisode.steps[0].eventSeqRange,
      messageSeqRange: artifact.socialEpisode.steps[0].messageSeqRange ?? null
    });
    expect(header).toMatchObject({
      status: "failed",
      failureReason: result.failureReason,
      failureStateHash: result.failureStateHash
    });
    expect(matchMetrics.metrics).toMatchObject({
      harnessTurnCount: 1,
      harnessErrorCount: 1
    });
    expect(evaluationReport).toMatchObject({
      id: artifact.evaluationReport.id,
      metricCount: artifact.evaluationReport.metricCount
    });
    expect(step).toMatchObject({
      traceId: artifact.trajectory[0].traceId,
      observation: expect.objectContaining({ pendingAction: expect.objectContaining({ kind: "inspect" }) }),
      policyPlan: expect.objectContaining({ policyName: "seer-information" }),
      reasonerOutput: expect.objectContaining({ providerRequestId: expect.stringContaining("jsonl-") }),
      decisionStateHash: artifact.trajectory[0].decisionStateHash,
      eventSeqRange: artifact.trajectory[0].eventSeqRange,
      messageSeqRange: artifact.trajectory[0].messageSeqRange
    });
    expect(trace).toMatchObject({
      traceId: artifact.trajectory[0].traceId,
      turnTrace: expect.objectContaining({ traceId: artifact.trajectory[0].traceId }),
      commandType: "seer.inspect"
    });
    expect(event).toBeUndefined();
    expect(error).toMatchObject({
      actorId: expect.any(String),
      failureReason: expect.stringContaining("jsonl planned reasoner failure")
    });
    expect(channelRecords).toHaveLength(artifact.socialEpisode.channels.length);
    expect(channelRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "table", kind: "public", readableBy: "all" }),
        expect.objectContaining({ id: "werewolf-team", kind: "team", readableBy: "participants" })
      ])
    );
    expect(metricRecords).toHaveLength(artifact.evaluationReport.metrics.length);
    expect(messageRecords).toHaveLength(artifact.socialEpisode.messages.length);
    const expectedExposureRecords = deriveSocialExposureRecords(artifact.socialEpisode);
    expect(socialExposureRecords).toHaveLength(expectedExposureRecords.length);
    expect(typeSet.has("social_exposure")).toBe(expectedExposureRecords.length > 0);
    expect(agentStateRecords).toHaveLength(artifact.agents.length);
    expect(agentStateRecords.some((record) => record.social?.memory?.entries?.length > 0)).toBe(true);
    expect(socialMutationRecords).toHaveLength(artifact.agents.flatMap((agent) => agent.social?.journal?.entries ?? []).length);
    expect(socialMutationRecords.some((record) => record.evidenceRefs?.length > 0 && record.hiddenTruthUsed === false)).toBe(true);
    expect(step.agentStateHash).toEqual(expect.any(String));
    expect(records.at(-1)?.type).toBe("metric");
  });

  it("exports fork provenance in the JSONL header", async () => {
    const initialState = createGame({ id: "artifact-jsonl-fork", seed: "artifact-jsonl-fork" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const parent = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 2
    });
    const parentArtifact = buildMatchArtifact({
      runId: "artifact-jsonl-fork-parent",
      matchId: "artifact-jsonl-fork-parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const checkpoint = buildFinalHarnessCheckpoint({
      artifact: parentArtifact,
      checkpointId: "artifact-jsonl-fork-checkpoint",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "jsonl fork source"
    });
    const forkOptions = forkHarnessRunOptions({
      checkpoint,
      reasoner: stubReasoner,
      maxTransitions: 1,
      createdAt: "2026-07-04T00:01:00.000Z",
      reason: "jsonl fork"
    });
    const fork = await runHarnessMatch(forkOptions);
    const forkArtifact = buildMatchArtifact({
      runId: "artifact-jsonl-fork-child",
      matchId: "artifact-jsonl-fork-child-match",
      seed: fork.initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(fork.initialState.players, forkOptions.agents),
      result: fork
    });

    const header = findRecord(parseJsonl(toTrajectoryJsonl(forkArtifact)), "header");

    expect(header).toMatchObject({
      type: "header",
      runId: "artifact-jsonl-fork-child",
      matchId: "artifact-jsonl-fork-child-match",
      forkOf: forkOptions.forkOf
    });
  });

  it("validates multi-generation fork artifacts with inherited parent evidence traces", async () => {
    const initialState = createGame({ id: "artifact-multi-generation-parent", seed: "artifact-multi-generation-parent" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.3);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.3);
    const parent = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 2
    });
    const parentArtifact = buildMatchArtifact({
      runId: "artifact-multi-generation-parent",
      matchId: "artifact-multi-generation-parent",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const rootCheckpoint = buildFinalHarnessCheckpoint({
      artifact: parentArtifact,
      checkpointId: "artifact-multi-generation-root-checkpoint",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "multi-generation root"
    });
    const childOptions = forkHarnessRunOptions({
      checkpoint: rootCheckpoint,
      reasoner: stubReasoner,
      maxTransitions: 1,
      createdAt: "2026-07-04T00:01:00.000Z",
      reason: "multi-generation child"
    });
    const child = await runHarnessMatch(childOptions);
    const childArtifact = buildMatchArtifact({
      runId: "artifact-multi-generation-child-run",
      matchId: "artifact-multi-generation-child-run",
      seed: child.initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(child.initialState.players, childOptions.agents),
      result: child
    });
    const childCheckpoint = buildFinalHarnessCheckpoint({
      artifact: childArtifact,
      checkpointId: "artifact-multi-generation-child-checkpoint",
      createdAt: "2026-07-04T00:02:00.000Z",
      reason: "multi-generation child checkpoint"
    });
    const grandchildOptions = forkHarnessRunOptions({
      checkpoint: childCheckpoint,
      reasoner: stubReasoner,
      maxTransitions: 1,
      createdAt: "2026-07-04T00:03:00.000Z",
      reason: "multi-generation grandchild"
    });
    const grandchild = await runHarnessMatch(grandchildOptions);
    const grandchildArtifact = buildMatchArtifact({
      runId: "artifact-multi-generation-grandchild-run",
      matchId: "artifact-multi-generation-grandchild-run",
      seed: grandchild.initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(grandchild.initialState.players, grandchildOptions.agents),
      result: grandchild
    });
    const currentTraceIds = new Set(grandchildArtifact.trajectory.map((step) => step.traceId));
    const inheritedTraceId = grandchildArtifact.agents
      .flatMap((agent) => agent.social?.journal?.entries ?? [])
      .flatMap((entry) => entry.evidenceRefs ?? [])
      .find((ref) => ref.artifact === "trace" && ref.traceId && !currentTraceIds.has(ref.traceId))?.traceId;

    expect(inheritedTraceId).toEqual(expect.any(String));
    expect(grandchildOptions.forkOf?.parentRunId).toBe("artifact-multi-generation-child-run");
    expect(grandchildOptions.forkOf?.parentEvidenceTraceIds).toContain(inheritedTraceId);
    expect(validateMatchArtifactIntegrity(grandchildArtifact)).toEqual([]);

    const tamperedArtifact = JSON.parse(JSON.stringify(grandchildArtifact)) as MatchArtifact;
    if (tamperedArtifact.forkOf) tamperedArtifact.forkOf.parentEvidenceTraceIds = [];
    expect(validateMatchArtifactIntegrity(tamperedArtifact).some((error) => error.includes("evidence references missing trace"))).toBe(true);
  });
});

const stubReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? "我按公开信息发言，重点比较夜晚死亡、发言压力和票型关系，今天先统一视角，避免无证据分票。"
        : `jsonl-completed:${input.action.kind}:${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 2,
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
        providerRequestId: `jsonl-completed-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

function parseJsonl(text: string): Array<Record<string, any>> {
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

function findRecord(records: Array<Record<string, any>>, type: string): Record<string, any> {
  const record = records.find((item) => item.type === type);
  if (!record) throw new Error(`Missing JSONL record type ${type}.`);
  return record;
}

function firstSafePrefixLength(artifact: MatchArtifact): number {
  for (const [index, step] of artifact.trajectory.entries()) {
    const socialStep = artifact.socialEpisode.steps.find((candidate: any) => candidate.traceId === step.traceId);
    const nextStep = artifact.trajectory[index + 1];
    const nextSocialStep = nextStep ? artifact.socialEpisode.steps.find((candidate: any) => candidate.traceId === nextStep.traceId) : undefined;
    if (!resolveAgentSnapshotsAfterStep(artifact, step) || !step.agentSnapshotsHashAfterStep) continue;
    if (socialStep?.schedulerMode === "parallel" || socialStep?.atomic) continue;
    if (
      socialStep?.schedulerMode === "aec-batched-decision" &&
      socialStep.batchId &&
      nextSocialStep?.batchId === socialStep.batchId
    ) {
      continue;
    }
    return index + 1;
  }
  throw new Error("Expected a safe prefix checkpoint boundary in artifact fixture.");
}

function firstSafePrefixBoundaryWithFutureEvidence(artifact: MatchArtifact): {
  trajectoryLength: number;
  nativeStepCount: number;
  futureMessageSeq: number;
  futureEventSeq: number;
} {
  for (const [index, step] of artifact.trajectory.entries()) {
    const socialStep = artifact.socialEpisode.steps.find((candidate: any) => candidate.traceId === step.traceId);
    const nextStep = artifact.trajectory[index + 1];
    const nextSocialStep = nextStep ? artifact.socialEpisode.steps.find((candidate: any) => candidate.traceId === nextStep.traceId) : undefined;
    if (!resolveAgentSnapshotsAfterStep(artifact, step) || !step.agentSnapshotsHashAfterStep) continue;
    if (socialStep?.schedulerMode === "parallel" || socialStep?.atomic) continue;
    if (
      socialStep?.schedulerMode === "aec-batched-decision" &&
      socialStep.batchId &&
      nextSocialStep?.batchId === socialStep.batchId
    ) {
      continue;
    }
    const frame = artifact.agentSnapshotFrames?.find((candidate) => candidate.frameId === step.agentSnapshotFrameIdAfterStep);
    if (!frame?.agents.some((agent) => (agent.social?.journal?.entries.length ?? 0) > 0)) continue;
    const prefix = artifact.trajectory.slice(0, index + 1);
    const maxMessageSeq = latestMessageSeqForPrefix(prefix);
    const maxEventSeq = latestEventSeqForPrefix(prefix);
    const futureMessageSeq = artifact.socialEpisode.messages.find((message) => message.seq > maxMessageSeq)?.seq;
    const futureEventSeq = artifact.events.find((event) => event.seq > maxEventSeq)?.seq;
    if (futureMessageSeq !== undefined && futureEventSeq !== undefined) {
      const nativeStepIndex = artifact.socialEpisode.steps.findIndex((candidate) => candidate.traceId === step.traceId);
      if (nativeStepIndex < 0) continue;
      return {
        trajectoryLength: index + 1,
        nativeStepCount: nativeStepIndex + 1,
        futureMessageSeq,
        futureEventSeq
      };
    }
  }
  throw new Error("Expected a safe prefix boundary with future message and event evidence.");
}

function latestMessageSeqForPrefix(trajectory: MatchArtifact["trajectory"]): number {
  return trajectory.reduce((latest, step) => Math.max(latest, step.messageSeqRange?.[1] ?? 0), 0);
}

function latestEventSeqForPrefix(trajectory: MatchArtifact["trajectory"]): number {
  return trajectory.reduce((latest, step) => Math.max(latest, step.eventSeqRange?.[1] ?? 0), 0);
}

function mutateSelectedPrefixSnapshotJournal(
  artifact: MatchArtifact,
  trajectoryLength: number,
  mutate: (entry: any) => void
): void {
  const step = artifact.trajectory[trajectoryLength - 1];
  if (!step?.agentSnapshotFrameIdAfterStep) throw new Error("Expected selected prefix step with a snapshot frame id.");
  const frame = artifact.agentSnapshotFrames?.find((candidate) => candidate.frameId === step.agentSnapshotFrameIdAfterStep);
  if (!frame) throw new Error("Expected selected prefix snapshot frame.");
  const oldFrameId = frame.frameId;
  const agent = frame.agents.find((candidate) => (candidate.social?.journal?.entries.length ?? 0) > 0);
  const entry = agent?.social?.journal?.entries[0];
  if (!entry) throw new Error("Expected selected prefix snapshot frame to contain a social journal entry.");
  mutate(entry);
  retargetSnapshotFrameRefs(artifact, oldFrameId, frame);
}

function expectCheckpointSelectionError(fn: () => unknown, code: HarnessCheckpointSelectionError["code"], message: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessCheckpointSelectionError);
    expect((error as HarnessCheckpointSelectionError).code).toBe(code);
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error(`Expected HarnessCheckpointSelectionError ${code}.`);
}

function retargetSnapshotFrameRefs(
  artifact: MatchArtifact,
  oldFrameId: string,
  frame: NonNullable<MatchArtifact["agentSnapshotFrames"]>[number]
): void {
  frame.agentsHash = hashStableState(frame.agents);
  frame.frameId = `agent-snapshot:${frame.agentsHash}`;
  for (const step of artifact.trajectory) {
    if (step.agentSnapshotFrameIdAfterStep !== oldFrameId) continue;
    step.agentSnapshotsHashAfterStep = frame.agentsHash;
    step.agentSnapshotFrameIdAfterStep = frame.frameId;
  }
  for (const step of artifact.socialEpisode.steps) {
    if (step.actorSnapshotFrameIdAfterStep !== oldFrameId) continue;
    step.actorSnapshotsHashAfterStep = frame.agentsHash;
    step.actorSnapshotFrameIdAfterStep = frame.frameId;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
