import { summarizeDeceptionBeliefShift, summarizeDeceptionReputationAssociation, summarizeWerewolfSocialCalibration } from "./evidence";
import { metricsFromFalseRoleClaimBeliefTemporalAssociation } from "./falseClaimBelief";
import { metricsFromFalseRoleClaimReputationTemporalAssociation } from "./falseClaimReputation";
import { GameState, Role, Team } from "../../core/types";
import { HarnessEvaluationContext, HarnessEvaluator } from "../evaluation";
import { AdversarialEvaluation, AgentHarnessState, AgentReward, AgentTrajectoryStep, HarnessEvaluationModuleResult, HarnessEvaluatorManifestConfig, HarnessStepRecord } from "../types";
import { evaluateAdversarialMatch, evaluateRoleSurvival, metricsFromWerewolfDeceptionEvaluation, metricsFromWerewolfInfluenceEvaluation, metricsFromWerewolfOutcomeEvaluation, metricsFromWerewolfRoleSurvivalEvaluation, metricsFromWerewolfSocialCalibration, metricsFromWerewolfVoteAccuracyEvaluation } from "./matchMetrics";
type WerewolfEvaluationContext<TSocialEpisode = unknown> = HarnessEvaluationContext<
  GameState,
  unknown,
  TSocialEpisode,
  AgentHarnessState,
  HarnessStepRecord
>;

type WerewolfEvaluator<TOutput = unknown, TSocialEpisode = unknown> = HarnessEvaluator<
  GameState,
  unknown,
  TSocialEpisode,
  TOutput,
  AgentHarnessState,
  HarnessStepRecord
>;

export const WEREWOLF_ADVERSARIAL_EVALUATOR_ID = "werewolf.adversarial.v1";
export const WEREWOLF_OUTCOME_EVALUATOR_ID = "werewolf.outcome.v1";
export const WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID = "werewolf.vote_accuracy.v1";
export const WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID = "werewolf.role_survival.v1";
export const WEREWOLF_INFLUENCE_EVALUATOR_ID = "werewolf.influence.v1";
export const WEREWOLF_DECEPTION_EVALUATOR_ID = "werewolf.deception.v1";
export const DECEPTION_BELIEF_SHIFT_EVALUATOR_ID = "evaluation.deception-belief-shift.v1";
export const DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID = "evaluation.deception-reputation-association.v1";
export const WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID = "werewolf.social_calibration.v1";

export const WEREWOLF_ADVERSARIAL_METRIC_IDS: string[] = [];
export const WEREWOLF_OUTCOME_METRIC_IDS = [
  "episode.completed_with_winner",
  "team.reward",
  "agent.reward",
  "profile.agent_reward",
  "model.agent_reward"
];
export const WEREWOLF_VOTE_ACCURACY_METRIC_IDS = ["agent.vote_accuracy"];
export const WEREWOLF_ROLE_SURVIVAL_METRIC_IDS = ["agent.survival_rate", "role.survival_rate"];
export const WEREWOLF_INFLUENCE_METRIC_IDS = ["agent.influence_rate"];
export const WEREWOLF_DECEPTION_METRIC_IDS = [
  "agent.deception_score",
  "agent.false_role_claim_count",
  "agent.false_role_claim_rate",
  "agent.false_role_claim_exposure_received_count",
  "agent.false_role_claim_unique_speaker_count",
  "agent.false_role_claim_pressure_vote_follow_count",
  "agent.false_role_claim_pressure_vote_follow_rate"
];
export const DECEPTION_BELIEF_SHIFT_METRIC_IDS = [
  "agent.false_role_claim_belief_temporal_association_count",
  "agent.false_role_claim_belief_temporal_association_rate",
  "agent.false_role_claim_belief_temporal_evaluable_exposure_rate"
];
export const DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS = [
  "agent.false_role_claim_reputation_temporal_association_count",
  "agent.false_role_claim_reputation_temporal_association_rate",
  "agent.false_role_claim_reputation_temporal_evaluable_exposure_rate"
];
export const WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS = [
  "agent.wolf_belief_brier_score",
  "agent.social.reputation_threat_brier_score"
];
export const WEREWOLF_EVALUATOR_METRIC_IDS = [
  ...WEREWOLF_OUTCOME_METRIC_IDS,
  ...WEREWOLF_VOTE_ACCURACY_METRIC_IDS,
  ...WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  ...WEREWOLF_INFLUENCE_METRIC_IDS,
  ...WEREWOLF_DECEPTION_METRIC_IDS,
  ...WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS
];
export const WEREWOLF_ADVERSARIAL_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.adversarial.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_ADVERSARIAL_METRIC_IDS,
  rubric:
    "Compatibility summary evaluator that emits the complete postgame Werewolf adversarial evaluation output. Metric ownership lives in narrower deterministic evaluators.",
  dependencies: {},
  aggregation: "compatibility_output",
  visibility: "postgame"
};
export const WEREWOLF_OUTCOME_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.outcome.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_OUTCOME_METRIC_IDS,
  rubric: "Scores terminal outcome, team reward, and per-agent/profile/model reward samples from final Werewolf state and postgame role/team truth.",
  dependencies: {},
  aggregation: "weighted_reward_summary",
  visibility: "postgame"
};
export const WEREWOLF_VOTE_ACCURACY_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.vote-accuracy.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_VOTE_ACCURACY_METRIC_IDS,
  rubric: "Scores whether day votes targeted the opposing team, using public vote records and postgame team truth.",
  dependencies: {},
  aggregation: "ratio_by_agent",
  visibility: "postgame"
};
export const WEREWOLF_ROLE_SURVIVAL_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.role-survival.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  rubric: "Audits how long each role and agent survived relative to the final episode day.",
  dependencies: {},
  aggregation: "survival_rate_by_agent_and_role",
  visibility: "postgame"
};
export const WEREWOLF_INFLUENCE_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.influence.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_INFLUENCE_METRIC_IDS,
  rubric:
    "Legacy zero-weight proxy that counts same-day vote-following after public pressure speech from global speech/vote records. It is not scoped-exposure evidence and must not drive rewards or leaderboard claims.",
  dependencies: {
    limitation: "Does not prove observer-scoped message exposure; evidence-backed vote-follow metrics live under false-role-claim pressure evaluators."
  },
  aggregation: "zero_weight_legacy_ratio_by_agent",
  visibility: "postgame"
};
export const WEREWOLF_DECEPTION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.deception.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_DECEPTION_METRIC_IDS,
  rubric:
    "Scores werewolf survival, village-on-village misdirect votes, public role-claim consistency, scoped false-role-claim exposure, and vote-follow signals after false pressure claims from public events, social observations, and postgame role/team truth.",
  dependencies: {},
  aggregation: "score_by_werewolf_agent",
  visibility: "postgame"
};
export const DECEPTION_BELIEF_SHIFT_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.deception-belief-shift.evaluation-context.v1",
  outputSchema: "evaluation.deception-belief-shift.temporal-association.v1",
  mode: "deterministic",
  metricIds: DECEPTION_BELIEF_SHIFT_METRIC_IDS,
  rubric:
    "Deterministically audits whether scoped exposure to a postgame-false public role claim is followed by later redacted belief-state journal mutations. These metrics are temporal association and coverage signals only; they do not claim causal influence, successful deception, persuasion outcome, or reward impact.",
  dependencies: {
    exposureRecords: "SocialExposureRecord from deriveSocialExposureRecords()",
    mutationJournal: "AgentSocialState.journal.entries",
    falseClaimTruth: "postgame role truth for claim classification only"
  },
  aggregation: "zero_weight_temporal_association_by_agent",
  visibility: "postgame"
};
export const DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.deception-reputation-association.evaluation-context.v1",
  outputSchema: "evaluation.deception-reputation-association.temporal-association.v1",
  mode: "deterministic",
  metricIds: DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
  rubric:
    "Deterministically audits whether scoped exposure to a postgame-false public role claim is followed by later redacted reputation-state journal mutations for the speaker. These metrics are temporal association and coverage signals only; they do not claim causal influence, successful deception, persuasion outcome, reputation damage, trust repair, or reward impact.",
  dependencies: {
    exposureRecords: "SocialExposureRecord from deriveSocialExposureRecords()",
    mutationJournal: "AgentSocialState.journal.entries",
    falseClaimTruth: "postgame role truth for claim classification only"
  },
  aggregation: "zero_weight_reputation_temporal_association_by_agent",
  visibility: "postgame"
};
export const WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_MANIFEST: HarnessEvaluatorManifestConfig = {
  inputSchema: "werewolf.match.evaluation-context.v1",
  outputSchema: "werewolf.social-calibration.evaluation.v1",
  mode: "deterministic",
  metricIds: WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
  rubric:
    "Audits final agent wolf-probability beliefs and social reputation threat estimates against postgame team truth, using serialized agent state plus evidence-backed social records where available.",
  dependencies: {},
  aggregation: "postgame_calibration_by_agent",
  visibility: "postgame"
};

export interface WerewolfOutcomeEvaluation {
  winner?: Team;
  teamRewards: AdversarialEvaluation["teamRewards"];
  agentRewards: AgentReward[];
  trajectory: AgentTrajectoryStep[];
}

export interface WerewolfRoleSurvivalEvaluation {
  agentSurvivalByAgent: Record<
    string,
    {
      role: Role;
      team: Team;
      alive: boolean;
      finalDay: number;
      eliminatedDay?: number;
      survivalRate: number;
    }
  >;
  survivalByRole: Record<string, { players: number; survivors: number; averageSurvivalRate: number }>;
}

export interface WerewolfSocialCalibrationEvaluation {
  agentCount: number;
  agentsWithBeliefSamples: number;
  agentsWithReputationSamples: number;
  beliefSamples: number;
  reputationSamples: number;
  averageWolfBeliefBrierScore: number;
  averageReputationThreatBrierScore: number;
}

export interface DeceptionBeliefShiftEvaluation {
  agentCount: number;
  agentsWithJournal: number;
  falseRoleClaimExposureRecords: number;
  evaluableFalseRoleClaimExposureRecords: number;
  associatedFalseRoleClaimExposures: number;
  associatedBeliefMutationRecords: number;
  missingJournalExposureRecords: number;
  ambiguousOrderingExposureRecords: number;
}

export interface DeceptionReputationAssociationEvaluation {
  agentCount: number;
  agentsWithJournal: number;
  falseRoleClaimExposureRecords: number;
  evaluableFalseRoleClaimExposureRecords: number;
  associatedFalseRoleClaimExposures: number;
  associatedReputationMutationRecords: number;
  missingJournalExposureRecords: number;
  ambiguousOrderingExposureRecords: number;
}

export function createWerewolfAdversarialEvaluator(): WerewolfEvaluator<AdversarialEvaluation> {
  return {
    id: WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
    label: "Werewolf adversarial summary evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_ADVERSARIAL_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext): HarnessEvaluationModuleResult<AdversarialEvaluation> {
      const evaluation = evaluateAdversarialMatch(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
        label: "Werewolf adversarial summary evaluator",
        version: "1.0.0",
        metrics: [],
        output: evaluation
      };
    }
  };
}

export function createWerewolfOutcomeEvaluator(): WerewolfEvaluator<WerewolfOutcomeEvaluation> {
  return {
    id: WEREWOLF_OUTCOME_EVALUATOR_ID,
    label: "Werewolf outcome and reward evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_OUTCOME_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext): HarnessEvaluationModuleResult<WerewolfOutcomeEvaluation> {
      const evaluation = evaluateAdversarialMatch(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: WEREWOLF_OUTCOME_EVALUATOR_ID,
        label: "Werewolf outcome and reward evaluator",
        version: "1.0.0",
        metrics: metricsFromWerewolfOutcomeEvaluation(
          evaluation,
          context.finalState,
          context.agents,
          context.socialEpisode,
          context.status
        ),
        output: {
          winner: evaluation.winner,
          teamRewards: evaluation.teamRewards,
          agentRewards: evaluation.agentRewards,
          trajectory: evaluation.trajectory
        }
      };
    }
  };
}

export function createWerewolfVoteAccuracyEvaluator(): WerewolfEvaluator<AdversarialEvaluation["voteAccuracyByAgent"]> {
  return {
    id: WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID,
    label: "Werewolf vote accuracy evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_VOTE_ACCURACY_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext): HarnessEvaluationModuleResult<AdversarialEvaluation["voteAccuracyByAgent"]> {
      const evaluation = evaluateAdversarialMatch(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID,
        label: "Werewolf vote accuracy evaluator",
        version: "1.0.0",
        metrics: metricsFromWerewolfVoteAccuracyEvaluation(evaluation, context.finalState),
        output: evaluation.voteAccuracyByAgent
      };
    }
  };
}

export function createWerewolfRoleSurvivalEvaluator(): WerewolfEvaluator<WerewolfRoleSurvivalEvaluation> {
  return {
    id: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
    label: "Werewolf role survival evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext): HarnessEvaluationModuleResult<WerewolfRoleSurvivalEvaluation> {
      const evaluation = evaluateRoleSurvival(context.finalState);
      return {
        evaluatorId: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
        label: "Werewolf role survival evaluator",
        version: "1.0.0",
        metrics: metricsFromWerewolfRoleSurvivalEvaluation(evaluation, context.finalState, context.agents),
        output: evaluation
      };
    }
  };
}

export function createWerewolfInfluenceEvaluator(): WerewolfEvaluator<AdversarialEvaluation["influenceByAgent"]> {
  return {
    id: WEREWOLF_INFLUENCE_EVALUATOR_ID,
    label: "Werewolf influence evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_INFLUENCE_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext): HarnessEvaluationModuleResult<AdversarialEvaluation["influenceByAgent"]> {
      const evaluation = evaluateAdversarialMatch(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: WEREWOLF_INFLUENCE_EVALUATOR_ID,
        label: "Werewolf influence evaluator",
        version: "1.0.0",
        metrics: metricsFromWerewolfInfluenceEvaluation(evaluation, context.finalState),
        output: evaluation.influenceByAgent
      };
    }
  };
}

export function createWerewolfDeceptionEvaluator<TSocialEpisode = unknown>(): WerewolfEvaluator<
  AdversarialEvaluation["deceptionByAgent"],
  TSocialEpisode
> {
  return {
    id: WEREWOLF_DECEPTION_EVALUATOR_ID,
    label: "Werewolf deception evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_DECEPTION_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext<TSocialEpisode>): HarnessEvaluationModuleResult<AdversarialEvaluation["deceptionByAgent"]> {
      const evaluation = evaluateAdversarialMatch(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: WEREWOLF_DECEPTION_EVALUATOR_ID,
        label: "Werewolf deception evaluator",
        version: "1.0.0",
        metrics: metricsFromWerewolfDeceptionEvaluation(evaluation, context.finalState, context.agents, context.socialEpisode),
        output: evaluation.deceptionByAgent
      };
    }
  };
}

export function createDeceptionBeliefShiftEvaluator<TSocialEpisode = unknown>(): WerewolfEvaluator<
  DeceptionBeliefShiftEvaluation,
  TSocialEpisode
> {
  return {
    id: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
    label: "Deception belief-shift temporal association evaluator",
    version: "1.0.0",
    manifest: DECEPTION_BELIEF_SHIFT_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext<TSocialEpisode>): HarnessEvaluationModuleResult<DeceptionBeliefShiftEvaluation> {
      const metrics = metricsFromFalseRoleClaimBeliefTemporalAssociation(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
        label: "Deception belief-shift temporal association evaluator",
        version: "1.0.0",
        metrics,
        output: summarizeDeceptionBeliefShift(metrics, context.agents)
      };
    }
  };
}

export function createDeceptionReputationAssociationEvaluator<TSocialEpisode = unknown>(): WerewolfEvaluator<
  DeceptionReputationAssociationEvaluation,
  TSocialEpisode
> {
  return {
    id: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
    label: "Deception reputation temporal association evaluator",
    version: "1.0.0",
    manifest: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext<TSocialEpisode>): HarnessEvaluationModuleResult<DeceptionReputationAssociationEvaluation> {
      const metrics = metricsFromFalseRoleClaimReputationTemporalAssociation(context.finalState, context.agents, context.socialEpisode);
      return {
        evaluatorId: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
        label: "Deception reputation temporal association evaluator",
        version: "1.0.0",
        metrics,
        output: summarizeDeceptionReputationAssociation(metrics, context.agents)
      };
    }
  };
}

export function createWerewolfSocialCalibrationEvaluator(): WerewolfEvaluator<WerewolfSocialCalibrationEvaluation> {
  return {
    id: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
    label: "Werewolf social calibration evaluator",
    version: "1.0.0",
    manifest: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_MANIFEST,
    evaluate(context: WerewolfEvaluationContext): HarnessEvaluationModuleResult<WerewolfSocialCalibrationEvaluation> {
      const metrics = metricsFromWerewolfSocialCalibration(context.finalState, context.agents);
      return {
        evaluatorId: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
        label: "Werewolf social calibration evaluator",
        version: "1.0.0",
        metrics,
        output: summarizeWerewolfSocialCalibration(metrics, context.agents)
      };
    }
  };
}

export function createWerewolfEvaluationSuite(): Array<WerewolfEvaluator> {
  return [
    createWerewolfAdversarialEvaluator(),
    createWerewolfOutcomeEvaluator(),
    createWerewolfVoteAccuracyEvaluator(),
    createWerewolfRoleSurvivalEvaluator(),
    createWerewolfInfluenceEvaluator(),
    createWerewolfDeceptionEvaluator(),
    createWerewolfSocialCalibrationEvaluator()
  ];
}
