import type { GameEvent, GameState, Role, Team } from "../core/types";
import {
  metric,
  type HarnessEvaluator,
  type HarnessEvaluationContext,
  type HarnessEvaluationStatus
} from "./evaluation";
import { harnessFailureEvidenceFromEpisode } from "./executionEvidence";
import { werewolfHarnessTurnEvidenceFromEpisode } from "./werewolfExecutionEvidence";
import { deriveSocialExposureRecords, isSocialStepCommitted, type SocialEpisodeArtifact, type SocialExposureRecord, type SocialMessage } from "./social";
import type {
  AdversarialEvaluation,
  AgentHarnessState,
  AgentReward,
  AgentTrajectoryStep,
  HarnessEvaluatorManifestConfig,
  HarnessEvaluationModuleResult,
  HarnessMetricEvidenceRef,
  HarnessMetricRecord,
  HarnessStepRecord,
  HarnessTurnTrace
} from "./types";
import type { EvidenceRef, SocialStateMutationJournalEntry } from "./socialState";

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

export function evaluateAdversarialMatch(state: GameState, agents: AgentHarnessState[], socialEpisode?: unknown): AdversarialEvaluation {
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const trajectory = extractTrajectory(socialEpisode);
  const voteAccuracyByAgent = computeVoteAccuracy(state);
  const influenceByAgent = computeInfluence(state);
  const deceptionByAgent = computeDeception(state);
  const errorsByAgent = countHarnessErrors(socialEpisode);
  const agentRewards = state.players.map((player) => {
    const agent = agentByPlayer.get(player.id);
    const reward = rewardAgent({
      playerId: player.id,
      profileId: agent?.profileId,
      model: agent?.model ?? "unknown",
      role: player.role,
      team: player.team,
      won: state.winner === player.team,
      eliminatedDay: player.eliminatedAt?.day,
      finalDay: state.day,
      voteAccuracy: voteAccuracyByAgent[player.id]?.accuracy ?? 0,
      influenceRate: influenceByAgent[player.id]?.influenceRate ?? 0,
      deceptionScore: deceptionByAgent[player.id]?.score ?? 0,
      illegalActionPenalty: errorsByAgent[player.id] ?? 0
    });
    return reward;
  });

  return {
    winner: state.winner,
    teamRewards: {
      village: averageReward(agentRewards.filter((reward) => reward.team === "village")),
      werewolves: averageReward(agentRewards.filter((reward) => reward.team === "werewolves"))
    },
    agentRewards,
    voteAccuracyByAgent,
    influenceByAgent,
    deceptionByAgent,
    trajectory
  };

  function rewardAgent(input: {
    playerId: string;
    profileId?: string;
    model: string;
    role: Role;
    team: Team;
    won: boolean;
    eliminatedDay?: number;
    finalDay: number;
    voteAccuracy: number;
    influenceRate: number;
    deceptionScore: number;
    illegalActionPenalty: number;
  }): AgentReward {
    const survival = input.eliminatedDay === undefined ? 1 : Math.max(0, Math.min(1, input.eliminatedDay / Math.max(1, input.finalDay)));
    const components = {
      win: input.won ? 1 : -0.4,
      voteAccuracy: input.voteAccuracy * 0.3,
      survival: survival * 0.15,
      influence: 0,
      deception: input.team === "werewolves" ? input.deceptionScore * 0.25 : 0,
      illegalActionPenalty: -0.5 * input.illegalActionPenalty
    };
    const reward = Object.values(components).reduce((sum, value) => sum + value, 0);
    return {
      playerId: input.playerId,
      profileId: input.profileId,
      model: input.model,
      role: input.role,
      team: input.team,
      won: input.won,
      reward: round3(reward),
      components: {
        win: round3(components.win),
        voteAccuracy: round3(components.voteAccuracy),
        survival: round3(components.survival),
        influence: round3(components.influence),
        deception: round3(components.deception),
        illegalActionPenalty: round3(components.illegalActionPenalty)
      }
    };
  }

  function computeVoteAccuracy(current: GameState): AdversarialEvaluation["voteAccuracyByAgent"] {
    const stats: AdversarialEvaluation["voteAccuracyByAgent"] = {};
    for (const vote of current.votes.filter(
      (item) => (item.kind ?? "exile") === "exile" && !item.abstain && item.targetId
    )) {
      const voter = playerById.get(vote.voterId);
      const target = playerById.get(vote.targetId!);
      if (!voter || !target) continue;
      const record = (stats[voter.id] ??= { votes: 0, correct: 0, accuracy: 0 });
      record.votes += 1;
      if (voter.team === "village" && target.team === "werewolves") record.correct += 1;
      if (voter.team === "werewolves" && target.team === "village") record.correct += 1;
      record.accuracy = round3(record.correct / record.votes);
    }
    return stats;
  }

  function computeInfluence(current: GameState): AdversarialEvaluation["influenceByAgent"] {
    const influence: AdversarialEvaluation["influenceByAgent"] = {};
    for (const speech of current.speeches.filter((item) => item.pressureTargetId)) {
      const record = (influence[speech.playerId] ??= { pressureCount: 0, voteFollowCount: 0, influenceRate: 0 });
      record.pressureCount += 1;
      const laterVotes = current.votes.filter(
        (vote) =>
          (vote.kind ?? "exile") === "exile" &&
          vote.day === speech.day &&
          vote.targetId === speech.pressureTargetId &&
          vote.voterId !== speech.playerId
      );
      record.voteFollowCount += laterVotes.length;
      record.influenceRate = round3(record.voteFollowCount / Math.max(1, record.pressureCount));
    }
    return influence;
  }

  function computeDeception(current: GameState): AdversarialEvaluation["deceptionByAgent"] {
    const deception: AdversarialEvaluation["deceptionByAgent"] = {};
    for (const wolf of current.players.filter((player) => player.team === "werewolves")) {
      const wolfSurvivalDays = wolf.eliminatedAt?.day ?? current.day;
      const misdirectVotes = current.votes.filter((vote) => {
        if ((vote.kind ?? "exile") !== "exile") return false;
        const voter = playerById.get(vote.voterId);
        const target = vote.targetId ? playerById.get(vote.targetId) : undefined;
        return voter?.team === "village" && target?.team === "village";
      }).length;
      deception[wolf.id] = {
        wolfSurvivalDays,
        misdirectVotes,
        score: round3(Math.min(1, wolfSurvivalDays / Math.max(1, current.day)) * 0.6 + Math.min(1, misdirectVotes / 6) * 0.4)
      };
    }
    return deception;
  }
}

export function metricsFromAdversarialEvaluation(
  evaluation: AdversarialEvaluation,
  state: GameState,
  agents: AgentHarnessState[] = [],
  socialEpisode?: unknown,
  status: HarnessEvaluationStatus = "completed"
): HarnessMetricRecord[] {
  return [
    ...metricsFromWerewolfOutcomeEvaluation(evaluation, state, agents, socialEpisode, status),
    ...metricsFromWerewolfVoteAccuracyEvaluation(evaluation, state),
    ...metricsFromWerewolfRoleSurvivalEvaluation(evaluateRoleSurvival(state), state, agents),
    ...metricsFromWerewolfInfluenceEvaluation(evaluation, state),
    ...metricsFromWerewolfDeceptionEvaluation(evaluation, state, agents, socialEpisode)
  ];
}

export function metricsFromWerewolfOutcomeEvaluation(
  evaluation: AdversarialEvaluation,
  state: GameState,
  agents: AgentHarnessState[] = [],
  socialEpisode?: unknown,
  status: HarnessEvaluationStatus = "completed"
): HarnessMetricRecord[] {
  const metrics: HarnessMetricRecord[] = [];
  const source = WEREWOLF_OUTCOME_EVALUATOR_ID;
  const turnEvidenceByActor = groupTurnEvidenceByActor(socialEpisode);
  const eventEvidence = finalEventEvidence(state);
  metrics.push(
    metric({
      id: "episode.completed_with_winner",
      label: "Episode has a winner",
      scope: "episode",
      value: evaluation.winner ? 1 : 0,
      higherIsBetter: true,
      weight: 0.2,
      source,
      subject: { matchId: state.id },
      confidence: 1,
      aggregation: "weighted_average",
      evidenceRefs: eventEvidence,
      metadata: { winner: evaluation.winner ?? null, phase: state.phase, day: state.day, status }
    })
  );

  // Partial lifecycle artifacts retain deterministic diagnostic and execution
  // evidence, but they are not wins or losses. Suppress every reward-bearing
  // sample unless the harness completed with a legal domain winner so raw
  // metric consumers cannot accidentally aggregate a truncation/failure as a
  // defeat. The completion metric above remains available for coverage.
  if (status !== "completed" || !evaluation.winner) return metrics;

  for (const [team, value] of Object.entries(evaluation.teamRewards)) {
    const teamPlayers = state.players.filter((player) => player.team === team);
    metrics.push(
      metric({
        id: "team.reward",
        label: "Team reward",
        scope: "team",
        subjectId: team,
        subject: { team, playerCount: teamPlayers.length },
        value,
        higherIsBetter: true,
        weight: 1,
        source,
        denominator: teamPlayers.length,
        confidence: 1,
        aggregation: "average_reward",
        evidenceRefs: teamEvidenceRefs(state, teamPlayers),
        metadata: { winner: evaluation.winner ?? null }
      })
    );
  }

  for (const reward of evaluation.agentRewards) {
    const playerTurns = turnEvidenceByActor.get(reward.playerId) ?? [];
    const player = state.players.find((item) => item.id === reward.playerId);
    const evidenceRefs = playerTurns.length ? playerTurns.map(turnEvidenceToMetricRef) : player ? survivalEvidenceForPlayer(state, player) : finalEventEvidence(state);
    metrics.push(
      metric({
        id: "agent.reward",
        label: "Agent reward",
        scope: "agent",
        subjectId: reward.playerId,
        subject: agentSubject(reward),
        value: reward.reward,
        higherIsBetter: true,
        weight: 1,
        source,
        denominator: 1,
        confidence: 1,
        aggregation: "sample",
        evidenceRefs,
        metadata: {
          profileId: reward.profileId,
          model: reward.model,
          role: reward.role,
          team: reward.team,
          won: reward.won,
          components: reward.components
        }
      })
    );
    if (reward.profileId) {
      metrics.push(
        metric({
          id: "profile.agent_reward",
          label: "Profile reward sample",
          scope: "profile",
          subjectId: reward.profileId,
          subject: { profileId: reward.profileId, playerId: reward.playerId, model: reward.model, role: reward.role, team: reward.team },
          value: reward.reward,
          higherIsBetter: true,
          weight: 1,
          source,
          denominator: 1,
          confidence: 1,
          aggregation: "average_by_profile",
          evidenceRefs,
          metadata: { playerId: reward.playerId, model: reward.model, role: reward.role, team: reward.team }
        })
      );
    }
    metrics.push(
      metric({
        id: "model.agent_reward",
        label: "Model reward sample",
        scope: "model",
        subjectId: reward.model,
        subject: { model: reward.model, playerId: reward.playerId, profileId: reward.profileId, role: reward.role, team: reward.team },
        value: reward.reward,
        higherIsBetter: true,
        weight: 1,
        source,
        denominator: 1,
        confidence: 1,
        aggregation: "average_by_model",
        evidenceRefs,
        metadata: { playerId: reward.playerId, profileId: reward.profileId, role: reward.role, team: reward.team }
      })
    );
  }

  return metrics;
}

export function metricsFromWerewolfVoteAccuracyEvaluation(evaluation: AdversarialEvaluation, state: GameState): HarnessMetricRecord[] {
  const source = WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID;
  const metrics: HarnessMetricRecord[] = [];
  for (const [playerId, accuracy] of Object.entries(evaluation.voteAccuracyByAgent)) {
    const voteEvidence = voteEvidenceForPlayer(state, playerId);
    metrics.push(
      metric({
        id: "agent.vote_accuracy",
        label: "Vote accuracy",
        scope: "agent",
        subjectId: playerId,
        subject: { playerId },
        value: accuracy.accuracy,
        unit: "ratio",
        higherIsBetter: true,
        weight: 0.3,
        source,
        denominator: accuracy.votes,
        confidence: accuracy.votes ? 1 : 0,
        aggregation: "ratio",
        evidenceRefs: voteEvidence,
        metadata: { votes: accuracy.votes, correct: accuracy.correct }
      })
    );
  }
  return metrics;
}

export function metricsFromWerewolfRoleSurvivalEvaluation(
  evaluation: WerewolfRoleSurvivalEvaluation,
  state: GameState,
  agents: AgentHarnessState[] = []
): HarnessMetricRecord[] {
  const source = WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID;
  const metrics: HarnessMetricRecord[] = [];
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  for (const [playerId, survival] of Object.entries(evaluation.agentSurvivalByAgent)) {
    const player = playerById.get(playerId);
    const agent = agentByPlayer.get(playerId);
    metrics.push(
      metric({
        id: "agent.survival_rate",
        label: "Agent survival rate",
        scope: "agent",
        subjectId: playerId,
        subject: {
          playerId,
          profileId: agent?.profileId,
          model: agent?.model ?? "unknown",
          role: survival.role,
          team: survival.team
        },
        value: survival.survivalRate,
        unit: "ratio",
        higherIsBetter: true,
        weight: 0,
        source,
        denominator: Math.max(1, survival.finalDay),
        confidence: 1,
        aggregation: "ratio",
        evidenceRefs: player ? survivalEvidenceForPlayer(state, player) : finalEventEvidence(state),
        metadata: {
          alive: survival.alive,
          finalDay: survival.finalDay,
          eliminatedDay: survival.eliminatedDay ?? null
        }
      })
    );
  }
  for (const [role, survival] of Object.entries(evaluation.survivalByRole)) {
    const rolePlayers = state.players.filter((player) => player.role === role);
    metrics.push(
      metric({
        id: "role.survival_rate",
        label: "Role survival rate",
        scope: "role",
        subjectId: role,
        subject: { role, playerCount: survival.players, survivors: survival.survivors },
        value: survival.averageSurvivalRate,
        unit: "ratio",
        higherIsBetter: true,
        weight: 0,
        source,
        denominator: survival.players,
        confidence: survival.players ? 1 : 0,
        aggregation: "average_by_role",
        evidenceRefs: roleEvidenceRefs(state, rolePlayers),
        metadata: survival
      })
    );
  }
  return metrics;
}

export function metricsFromWerewolfInfluenceEvaluation(evaluation: AdversarialEvaluation, state: GameState): HarnessMetricRecord[] {
  const source = WEREWOLF_INFLUENCE_EVALUATOR_ID;
  const metrics: HarnessMetricRecord[] = [];
  for (const [playerId, influence] of Object.entries(evaluation.influenceByAgent)) {
    const speechEvidence = speechEvidenceForPlayer(state, playerId);
    metrics.push(
      metric({
        id: "agent.influence_rate",
        label: "Influence rate",
        scope: "agent",
        subjectId: playerId,
        subject: { playerId },
        value: influence.influenceRate,
        unit: "ratio",
        higherIsBetter: true,
        weight: 0,
        source,
        denominator: influence.pressureCount,
        confidence: influence.pressureCount ? 0.35 : 0,
        aggregation: "zero_weight_legacy_ratio",
        evidenceRefs: speechEvidence,
        metadata: {
          pressureCount: influence.pressureCount,
          voteFollowCount: influence.voteFollowCount,
          scopedExposureRequired: false,
          rewardBearing: false,
          limitation: "legacy_global_speech_vote_proxy_without_scoped_exposure"
        }
      })
    );
  }
  return metrics;
}

export function metricsFromWerewolfDeceptionEvaluation(
  evaluation: AdversarialEvaluation,
  state: GameState,
  agents: AgentHarnessState[] = [],
  socialEpisode?: unknown
): HarnessMetricRecord[] {
  const source = WEREWOLF_DECEPTION_EVALUATOR_ID;
  const metrics: HarnessMetricRecord[] = [];
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));
  for (const [playerId, deception] of Object.entries(evaluation.deceptionByAgent)) {
    const agent = agentByPlayer.get(playerId);
    const player = state.players.find((item) => item.id === playerId);
    metrics.push(
      metric({
        id: "agent.deception_score",
        label: "Werewolf deception score",
        scope: "agent",
        subjectId: playerId,
        subject: { playerId, role: "werewolf", model: agent?.model, profileId: agent?.profileId },
        value: deception.score,
        unit: "ratio",
        higherIsBetter: true,
        weight: 0.25,
        source,
        denominator: Math.max(1, state.day),
        confidence: 0.7,
        aggregation: "score",
        evidenceRefs: [
          ...(player ? survivalEvidenceForPlayer(state, player) : []),
          ...misdirectVoteEvidence(state)
        ],
        metadata: { wolfSurvivalDays: deception.wolfSurvivalDays, misdirectVotes: deception.misdirectVotes }
      })
    );
  }
  for (const claim of roleClaimConsistencyByAgent(state)) {
    const agent = agentByPlayer.get(claim.playerId);
    const subject = {
      playerId: claim.playerId,
      profileId: agent?.profileId,
      model: agent?.model ?? "unknown",
      role: claim.actualRole,
      team: claim.team
    };
    const evidenceRefs = roleClaimEvidenceForPlayer(state, claim.playerId);
    metrics.push(
      metric({
        id: "agent.false_role_claim_count",
        label: "Agent false role claim count",
        scope: "agent",
        subjectId: claim.playerId,
        subject,
        value: claim.falseClaims,
        unit: "count",
        higherIsBetter: false,
        weight: 0,
        source,
        denominator: claim.claims,
        confidence: claim.claims ? 1 : 0,
        aggregation: "sum",
        evidenceRefs,
        metadata: {
          actualRole: claim.actualRole,
          team: claim.team,
          claims: claim.claims,
          truthfulClaims: claim.truthfulClaims,
          falseClaims: claim.falseClaims,
          claimedRoles: claim.claimedRoles,
          falseClaimedRoles: claim.falseClaimedRoles
        }
      })
    );
    metrics.push(
      metric({
        id: "agent.false_role_claim_rate",
        label: "Agent false role claim rate",
        scope: "agent",
        subjectId: claim.playerId,
        subject,
        value: claim.claims ? round3(claim.falseClaims / claim.claims) : 0,
        unit: "ratio",
        higherIsBetter: false,
        weight: 0,
        source,
        denominator: claim.claims,
        confidence: claim.claims ? 1 : 0,
        aggregation: "ratio",
        evidenceRefs,
        metadata: {
          actualRole: claim.actualRole,
          team: claim.team,
          claims: claim.claims,
          truthfulClaims: claim.truthfulClaims,
          falseClaims: claim.falseClaims,
          claimedRoles: claim.claimedRoles,
          falseClaimedRoles: claim.falseClaimedRoles
        }
      })
    );
  }

  metrics.push(...metricsFromFalseRoleClaimExposure(state, agents, socialEpisode));
  metrics.push(...metricsFromFalseRoleClaimPressureVoteFollow(state, agents, socialEpisode));

  return metrics;
}

export function metricsFromWerewolfSocialCalibration(state: GameState, agents: AgentHarnessState[] = []): HarnessMetricRecord[] {
  const metrics: HarnessMetricRecord[] = [];
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  for (const agent of agents) {
    const beliefSamples = wolfBeliefCalibrationSamples(agent, playerById);
    if (beliefSamples.length) {
      metrics.push(
        metric({
          id: "agent.wolf_belief_brier_score",
          label: "Agent wolf belief Brier score",
          scope: "agent",
          subjectId: agent.playerId,
          subject: calibrationSubject(agent),
          value: round3(average(beliefSamples.map((sample) => sample.squaredError))),
          unit: "score",
          higherIsBetter: false,
          weight: 0,
          source: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
          denominator: beliefSamples.length,
          confidence: 1,
          aggregation: "average_brier_score",
          evidenceRefs: calibrationEvidenceRefs(agent, beliefSamples.flatMap((sample) => sample.evidenceRefs), "postgame team truth for wolf belief calibration"),
          metadata: calibrationMetadata(beliefSamples)
        })
      );
    }

    const reputationSamples = reputationThreatCalibrationSamples(agent, playerById);
    if (reputationSamples.length) {
      metrics.push(
        metric({
          id: "agent.social.reputation_threat_brier_score",
          label: "Agent social reputation threat Brier score",
          scope: "agent",
          subjectId: agent.playerId,
          subject: calibrationSubject(agent),
          value: round3(average(reputationSamples.map((sample) => sample.squaredError))),
          unit: "score",
          higherIsBetter: false,
          weight: 0,
          source: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
          denominator: reputationSamples.length,
          confidence: 1,
          aggregation: "average_brier_score",
          evidenceRefs: calibrationEvidenceRefs(
            agent,
            reputationSamples.flatMap((sample) => sample.evidenceRefs),
            "postgame team truth for reputation threat calibration"
          ),
          metadata: {
            ...calibrationMetadata(reputationSamples),
            threatScale: "signed [-1,1] normalized to wolf probability [0,1]"
          }
        })
      );
    }
  }
  return metrics;
}

export function evaluateRoleSurvival(state: GameState): WerewolfRoleSurvivalEvaluation {
  const agentSurvivalByAgent: WerewolfRoleSurvivalEvaluation["agentSurvivalByAgent"] = {};
  const roleGroups = new Map<Role, Array<{ alive: boolean; survivalRate: number }>>();
  for (const player of state.players) {
    const finalDay = Math.max(1, state.day);
    const eliminatedDay = player.eliminatedAt?.day;
    const survivalRate = eliminatedDay === undefined ? 1 : round3(Math.max(0, Math.min(1, eliminatedDay / finalDay)));
    agentSurvivalByAgent[player.id] = {
      role: player.role,
      team: player.team,
      alive: player.alive,
      finalDay,
      eliminatedDay,
      survivalRate
    };
    roleGroups.set(player.role, [...(roleGroups.get(player.role) ?? []), { alive: player.alive, survivalRate }]);
  }
  return {
    agentSurvivalByAgent,
    survivalByRole: Object.fromEntries(
      [...roleGroups.entries()].map(([role, players]) => [
        role,
        {
          players: players.length,
          survivors: players.filter((player) => player.alive).length,
          averageSurvivalRate: round3(players.reduce((sum, player) => sum + player.survivalRate, 0) / Math.max(1, players.length))
        }
      ])
    )
  };
}

function extractTrajectory(socialEpisode: unknown): AgentTrajectoryStep[] {
  return werewolfHarnessTurnEvidenceFromEpisode(socialEpisode)
    .filter(({ step }) => isSocialStepCommitted(step))
    .map(({ step, trace }) => {
    const observation = asRecord(step.observation);
    const view = asRecord(observation?.view) ?? observation;
    return {
      seq: step.turnIndex,
      day: typeof view?.day === "number" ? view.day : 0,
      phase: typeof view?.phase === "string" ? view.phase : "unknown",
      playerId: trace.playerId,
      profileId: trace.profileId,
      model: trace.model,
      actionKind: String(trace.actionKind ?? "unknown"),
      policyName: String(trace.policyName ?? "unknown"),
      commandType: String(trace.commandType ?? "unknown"),
      intent: String(trace.intent ?? ""),
      confidence: typeof trace.confidence === "number" ? trace.confidence : 0,
      targetId: trace.targetId
    };
    });
}

function groupTurnEvidenceByActor(socialEpisode: unknown): Map<string, ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>> {
  const grouped = new Map<string, ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>>();
  for (const evidence of werewolfHarnessTurnEvidenceFromEpisode(socialEpisode).filter(
    ({ step }) => isSocialStepCommitted(step)
  )) {
    grouped.set(evidence.actorId, [...(grouped.get(evidence.actorId) ?? []), evidence]);
  }
  return grouped;
}

function turnEvidenceToMetricRef(evidence: ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>[number]): HarnessMetricEvidenceRef {
  return {
    artifact: "trace",
    id: evidence.traceId,
    seq: evidence.turnIndex,
    traceId: evidence.traceId,
    description: evidence.trace.commandType
  };
}

function eventToEvidenceRef(event: GameEvent): HarnessMetricEvidenceRef {
  const trace = event.payload as Partial<HarnessTurnTrace>;
  return {
    artifact: "event",
    id: event.id,
    seq: event.seq,
    traceId: typeof trace.traceId === "string" ? trace.traceId : undefined,
    description: event.type
  };
}

function finalEventEvidence(state: GameState): HarnessMetricEvidenceRef[] {
  const finalEvent = [...state.events].reverse().find((event) => event.type === "game.ended") ?? state.events.at(-1);
  return finalEvent
    ? [eventToEvidenceRef(finalEvent)]
    : [
        stateEvidence("final game state", {
          id: state.id,
          description: `final game state: phase=${state.phase}, day=${state.day}, winner=${state.winner ?? "none"}`
        })
      ];
}

function postgameRoleTruthEvidence(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
  const refs: HarnessMetricEvidenceRef[] = [
    stateEvidence(`postgame role truth for ${playerId}`, {
      id: playerId
    })
  ];
  const ended = [...state.events].reverse().find((event) => event.type === "game.ended");
  if (ended) refs.unshift(eventToEvidenceRef(ended));
  return refs;
}

function teamEvidenceRefs(state: GameState, players: Array<{ id: string }>): HarnessMetricEvidenceRef[] {
  const refs = players.flatMap((player) => survivalEvidenceForPlayer(state, player));
  return refs.length ? refs : finalEventEvidence(state);
}

function roleEvidenceRefs(state: GameState, players: Array<{ id: string }>): HarnessMetricEvidenceRef[] {
  const refs = players.flatMap((player) => survivalEvidenceForPlayer(state, player));
  return refs.length ? refs : finalEventEvidence(state);
}

function survivalEvidenceForPlayer(state: GameState, player: { id: string }): HarnessMetricEvidenceRef[] {
  const deathEvent = state.events.find((event) => event.type === "player.died" && payloadPlayerId(event.payload) === player.id);
  return deathEvent ? [eventToEvidenceRef(deathEvent)] : finalEventEvidence(state);
}

function voteEvidenceForPlayer(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
  const refs = state.events
    .filter((event) => event.type === "vote.cast" && event.actorId === playerId)
    .map(eventToEvidenceRef);
  if (refs.length) return refs;
  const voteRecords = state.votes.filter(
    (vote) => (vote.kind ?? "exile") === "exile" && vote.voterId === playerId
  );
  if (voteRecords.length) {
    return voteRecords.map((vote, index) =>
      stateEvidence(`vote records for ${playerId}`, {
        id: `${playerId}:vote:d${vote.day}:${index + 1}`,
        description: vote.abstain
          ? `vote records for ${playerId}: day=${vote.day}, abstain=true`
          : `vote records for ${playerId}: day=${vote.day}, target=${vote.targetId ?? "none"}`
      })
    );
  }
  return [stateEvidence(`vote records for ${playerId}`, { id: playerId })];
}

function speechEvidenceForPlayer(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
  const refs = state.events
    .filter((event) => event.type === "speech.submitted" && event.actorId === playerId && Boolean(payloadPressureTargetId(event.payload)))
    .map(eventToEvidenceRef);
  if (refs.length) return refs;
  const pressureSpeeches = state.speeches.filter((speech) => speech.playerId === playerId && Boolean(speech.pressureTargetId));
  if (pressureSpeeches.length) {
    return pressureSpeeches.map((speech, index) =>
      stateEvidence(`pressure speeches for ${playerId}`, {
        id: `${playerId}:pressure:d${speech.day}:${index + 1}`,
        description: `pressure speeches for ${playerId}: day=${speech.day}, target=${speech.pressureTargetId}`
      })
    );
  }
  return [stateEvidence(`pressure speeches for ${playerId}`, { id: playerId })];
}

function misdirectVoteEvidence(state: GameState): HarnessMetricEvidenceRef[] {
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const refs = state.events
    .filter((event) => {
      if (event.type !== "vote.cast") return false;
      const payload = event.payload as { voterId?: string; targetId?: string; abstain?: boolean };
      if (payload.abstain || !payload.voterId || !payload.targetId) return false;
      const voter = playerById.get(payload.voterId);
      const target = playerById.get(payload.targetId);
      return voter?.team === "village" && target?.team === "village";
    })
    .map(eventToEvidenceRef);
  if (refs.length) return refs;
  const voteRecords = state.votes.filter((vote) => {
    if ((vote.kind ?? "exile") !== "exile") return false;
    if (vote.abstain || !vote.targetId) return false;
    const voter = playerById.get(vote.voterId);
    const target = playerById.get(vote.targetId);
    return voter?.team === "village" && target?.team === "village";
  });
  if (voteRecords.length) {
    return voteRecords.map((vote, index) =>
      stateEvidence("village-on-village misdirect votes", {
        id: `${vote.voterId}:misdirect:d${vote.day}:${index + 1}`,
        description: `village-on-village misdirect votes: day=${vote.day}, voter=${vote.voterId}, target=${vote.targetId}`
      })
    );
  }
  return [stateEvidence("village-on-village misdirect votes", { id: state.id })];
}

function roleClaimConsistencyByAgent(state: GameState): Array<{
  playerId: string;
  actualRole: Role;
  team: Team;
  claims: number;
  truthfulClaims: number;
  falseClaims: number;
  claimedRoles: Role[];
  falseClaimedRoles: Role[];
}> {
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const grouped = new Map<
    string,
    {
      playerId: string;
      actualRole: Role;
      team: Team;
      claimedRoles: Role[];
      falseClaimedRoles: Role[];
    }
  >();
  for (const speech of state.speeches.filter((item) => item.claimedRole)) {
    const player = playerById.get(speech.playerId);
    if (!player || !speech.claimedRole) continue;
    const record =
      grouped.get(speech.playerId) ??
      {
        playerId: speech.playerId,
        actualRole: player.role,
        team: player.team,
        claimedRoles: [],
        falseClaimedRoles: []
      };
    record.claimedRoles.push(speech.claimedRole);
    if (speech.claimedRole !== player.role) record.falseClaimedRoles.push(speech.claimedRole);
    grouped.set(speech.playerId, record);
  }
  return [...grouped.values()].map((record) => ({
    ...record,
    claims: record.claimedRoles.length,
    truthfulClaims: record.claimedRoles.length - record.falseClaimedRoles.length,
    falseClaims: record.falseClaimedRoles.length
  }));
}

function roleClaimEvidenceForPlayer(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
  const refs = state.events
    .filter((event) => {
      if (event.type !== "speech.submitted" || event.actorId !== playerId) return false;
      return Boolean(payloadClaimedRole(event.payload));
    })
    .map(eventToEvidenceRef);
  return refs.length ? [...refs, ...postgameRoleTruthEvidence(state, playerId)] : [stateEvidence(`role claims for ${playerId}`, { id: playerId })];
}

interface CalibrationSample {
  targetId: string;
  prediction: number;
  truth: number;
  squaredError: number;
  role: Role;
  team: Team;
  evidenceRefs: EvidenceRef[];
}

function wolfBeliefCalibrationSamples(agent: AgentHarnessState, playerById: Map<string, GameState["players"][number]>): CalibrationSample[] {
  return Object.entries(agent.beliefs).flatMap(([targetId, belief]) => {
    if (targetId === agent.playerId) return [];
    const player = playerById.get(targetId);
    if (!player || typeof belief.wolfProb !== "number") return [];
    const prediction = clamp01(belief.wolfProb);
    const truth = player.team === "werewolves" ? 1 : 0;
    return [
      {
        targetId,
        prediction,
        truth,
        squaredError: round3((prediction - truth) ** 2),
        role: player.role,
        team: player.team,
        evidenceRefs: agent.social?.beliefs.claims[`${targetId}:werewolfProbability`]?.evidenceRefs ?? []
      }
    ];
  });
}

function reputationThreatCalibrationSamples(agent: AgentHarnessState, playerById: Map<string, GameState["players"][number]>): CalibrationSample[] {
  const records = Object.values(agent.social?.reputation.records ?? {});
  return records.flatMap((record) => {
    if (record.subjectId === agent.playerId) return [];
    const player = playerById.get(record.subjectId);
    if (!player) return [];
    const prediction = signedScoreToProbability(record.threat);
    const truth = player.team === "werewolves" ? 1 : 0;
    return [
      {
        targetId: record.subjectId,
        prediction,
        truth,
        squaredError: round3((prediction - truth) ** 2),
        role: player.role,
        team: player.team,
        evidenceRefs: record.evidenceRefs
      }
    ];
  });
}

function calibrationSubject(agent: AgentHarnessState): Record<string, unknown> {
  return {
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    policyName: agent.policyName
  };
}

function calibrationEvidenceRefs(agent: AgentHarnessState, socialRefs: EvidenceRef[], stateDescription: string): HarnessMetricEvidenceRef[] {
  return uniqueEvidenceRefs([
    ...metricEvidenceFromSocialRefs(agent, socialRefs),
    agentStateEvidence(agent),
    stateEvidence(stateDescription, { id: agent.playerId })
  ]);
}

function calibrationMetadata(samples: CalibrationSample[]): Record<string, unknown> {
  return {
    sampleCount: samples.length,
    targetIds: sampleIds(samples.map((sample) => sample.targetId)),
    wolfTargetIds: sampleIds(samples.filter((sample) => sample.truth === 1).map((sample) => sample.targetId)),
    villageTargetIds: sampleIds(samples.filter((sample) => sample.truth === 0).map((sample) => sample.targetId)),
    averagePrediction: round3(average(samples.map((sample) => sample.prediction))),
    wolfTruthRate: round3(average(samples.map((sample) => sample.truth))),
    samples: samples
      .map((sample) => ({
        targetId: sample.targetId,
        prediction: sample.prediction,
        truth: sample.truth,
        squaredError: sample.squaredError,
        role: sample.role,
        team: sample.team
      }))
      .slice(0, 20)
  };
}

function agentStateEvidence(agent: AgentHarnessState): HarnessMetricEvidenceRef {
  return {
    artifact: "agent_state",
    id: agent.playerId,
    description: `socialStateHash:${agent.socialStateHash ?? "unknown"}`
  };
}

function metricEvidenceFromSocialRefs(agent: AgentHarnessState, refs: EvidenceRef[]): HarnessMetricEvidenceRef[] {
  const mapped: HarnessMetricEvidenceRef[] = [];
  for (const ref of refs) {
    if (ref.artifact === "message") {
      mapped.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "delivery_receipt") {
      mapped.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "event") {
      mapped.push({ artifact: "event", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "trace") {
      mapped.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "observation") {
      mapped.push({ artifact: "observation", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "state" || ref.artifact === "outcome") {
      mapped.push({ artifact: "state", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.traceId) {
      mapped.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: `${ref.artifact}:${ref.description ?? ""}` });
      continue;
    }
    mapped.push({ artifact: "agent_state", id: agent.playerId, seq: ref.seq, description: `${ref.artifact}:${ref.description ?? "social evidence"}` });
  }
  return uniqueEvidenceRefs(mapped);
}

function summarizeWerewolfSocialCalibration(
  metrics: HarnessMetricRecord[],
  agents: AgentHarnessState[]
): WerewolfSocialCalibrationEvaluation {
  const beliefMetrics = metrics.filter((item) => item.id === "agent.wolf_belief_brier_score" && typeof item.value === "number");
  const reputationMetrics = metrics.filter((item) => item.id === "agent.social.reputation_threat_brier_score" && typeof item.value === "number");
  return {
    agentCount: agents.length,
    agentsWithBeliefSamples: beliefMetrics.length,
    agentsWithReputationSamples: reputationMetrics.length,
    beliefSamples: beliefMetrics.reduce((sum, item) => sum + (item.denominator ?? 0), 0),
    reputationSamples: reputationMetrics.reduce((sum, item) => sum + (item.denominator ?? 0), 0),
    averageWolfBeliefBrierScore: round3(average(beliefMetrics.map((item) => Number(item.value)))),
    averageReputationThreatBrierScore: round3(average(reputationMetrics.map((item) => Number(item.value))))
  };
}

function summarizeDeceptionBeliefShift(metrics: HarnessMetricRecord[], agents: AgentHarnessState[]): DeceptionBeliefShiftEvaluation {
  const countMetrics = metrics.filter((item) => item.id === "agent.false_role_claim_belief_temporal_association_count");
  return {
    agentCount: agents.length,
    agentsWithJournal: agents.filter((agent) => (agent.social?.journal?.entries.length ?? 0) > 0).length,
    falseRoleClaimExposureRecords: sumMetricMetadata(countMetrics, "falseRoleClaimExposureCount"),
    evaluableFalseRoleClaimExposureRecords: sumMetricMetadata(countMetrics, "evaluableFalseClaimExposureCount"),
    associatedFalseRoleClaimExposures: round3(countMetrics.reduce((sum, item) => sum + (typeof item.value === "number" ? item.value : 0), 0)),
    associatedBeliefMutationRecords: sumMetricMetadata(countMetrics, "associatedMutationCount"),
    missingJournalExposureRecords: sumMetricMetadata(countMetrics, "missingJournalExposureCount"),
    ambiguousOrderingExposureRecords: sumMetricMetadata(countMetrics, "ambiguousOrderingExposureCount")
  };
}

function summarizeDeceptionReputationAssociation(metrics: HarnessMetricRecord[], agents: AgentHarnessState[]): DeceptionReputationAssociationEvaluation {
  const countMetrics = metrics.filter((item) => item.id === "agent.false_role_claim_reputation_temporal_association_count");
  return {
    agentCount: agents.length,
    agentsWithJournal: agents.filter((agent) => (agent.social?.journal?.entries.length ?? 0) > 0).length,
    falseRoleClaimExposureRecords: sumMetricMetadata(countMetrics, "falseRoleClaimExposureCount"),
    evaluableFalseRoleClaimExposureRecords: sumMetricMetadata(countMetrics, "evaluableFalseClaimExposureCount"),
    associatedFalseRoleClaimExposures: round3(countMetrics.reduce((sum, item) => sum + (typeof item.value === "number" ? item.value : 0), 0)),
    associatedReputationMutationRecords: sumMetricMetadata(countMetrics, "associatedMutationCount"),
    missingJournalExposureRecords: sumMetricMetadata(countMetrics, "missingJournalExposureCount"),
    ambiguousOrderingExposureRecords: sumMetricMetadata(countMetrics, "ambiguousOrderingExposureCount")
  };
}

interface FalseRoleClaimMessage {
  message: SocialMessage;
  sourceId: string;
  claimedRole: Role;
  actualRole: Role;
  team: Team;
  day?: number;
  pressureTargetId?: string;
  speechActId?: string;
  speechActKind?: string;
  claimSource: "speech_act" | "metadata";
}

interface RoleClaimFact {
  claimedRole: Role;
  claimSource: "speech_act" | "metadata";
  speechActId?: string;
  speechActKind?: string;
}

interface FalseRoleClaimPressureVoteFollowRecord {
  claim: FalseRoleClaimMessage;
  exposure: SocialExposureRecord;
  vote: {
    voterId: string;
    targetId?: string;
    abstain: boolean;
    day: number;
  };
  followed: boolean;
  voteEvent?: GameEvent;
}

type SocialEpisodeExposureInput = Pick<SocialEpisodeArtifact<unknown, unknown, unknown, unknown>, "steps" | "messages">;

function metricsFromFalseRoleClaimExposure(state: GameState, agents: AgentHarnessState[], socialEpisode?: unknown): HarnessMetricRecord[] {
  const exposureInput = socialEpisodeExposureInput(socialEpisode);
  if (!exposureInput) return [];

  const falseClaims = falseRoleClaimMessages(state, exposureInput.messages);
  if (!falseClaims.length) return [];

  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const falseClaimByMessageId = new Map(falseClaims.map((claim) => [claim.message.id, claim]));
  const falseClaimSpeakerIds = new Set(falseClaims.map((claim) => claim.sourceId));
  const exposureRecords = deriveSocialExposureRecords(exposureInput).filter((record) => falseClaimByMessageId.has(record.messageId));
  const recordsByObserver = groupFalseClaimExposureRecordsByObserver(exposureRecords);
  const observedFalseRoleClaimMessageCount = new Set(exposureRecords.map((record) => record.messageId)).size;

  return state.players.flatMap((player) => {
    const agent = agentByPlayer.get(player.id);
    const records = recordsByObserver.get(player.id) ?? [];
    const subject = {
      playerId: player.id,
      profileId: agent?.profileId,
      model: agent?.model ?? "unknown",
      role: player.role,
      team: player.team
    };
    const evidenceRefs = falseRoleClaimExposureEvidence(records, falseClaimByMessageId);
    const uniqueSourceIdSet = new Set(records.map((record) => record.sourceId));
    const metadata = falseRoleClaimExposureMetadata(records, falseClaimByMessageId, {
      falseRoleClaimMessages: falseClaims.length,
      falseRoleClaimSpeakers: falseClaimSpeakerIds.size,
      totalFalseRoleClaimExposureRecords: exposureRecords.length,
      observedFalseRoleClaimMessages: observedFalseRoleClaimMessageCount
    });

    return [
      metric({
        id: "agent.false_role_claim_exposure_received_count",
        label: "False role claim exposure received count",
        scope: "agent",
        subjectId: player.id,
        subject,
        value: records.length,
        unit: "count",
        higherIsBetter: false,
        weight: 0,
        source: WEREWOLF_DECEPTION_EVALUATOR_ID,
        denominator: exposureRecords.length,
        confidence: 1,
        aggregation: "sum",
        evidenceRefs: evidenceRefs.length
          ? evidenceRefs
          : [stateEvidence(`false role claim exposure records for ${player.id}`, { id: player.id })],
        metadata
      }),
      metric({
        id: "agent.false_role_claim_unique_speaker_count",
        label: "False role claim unique speaker exposure count",
        scope: "agent",
        subjectId: player.id,
        subject,
        value: uniqueSourceIdSet.size,
        unit: "count",
        higherIsBetter: false,
        weight: 0,
        source: WEREWOLF_DECEPTION_EVALUATOR_ID,
        denominator: falseClaimSpeakerIds.size,
        confidence: 1,
        aggregation: "sum",
        evidenceRefs: evidenceRefs.length
          ? evidenceRefs
          : [stateEvidence(`false role claim exposure records for ${player.id}`, { id: player.id })],
        metadata
      })
    ];
  });
}

function falseRoleClaimMessages(state: GameState, messages: SocialMessage[]): FalseRoleClaimMessage[] {
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const claims: FalseRoleClaimMessage[] = [];
  for (const message of messages) {
    const metadata = asRecord(message.metadata);
    if (message.visibility !== "public") continue;
    const roleClaim = roleClaimFactFromSpeechAct(message) ?? roleClaimFactFromMetadata(metadata);
    const player = playerById.get(message.senderId);
    if (!roleClaim || !player || roleClaim.claimedRole === player.role) continue;
    claims.push({
      message,
      sourceId: message.senderId,
      claimedRole: roleClaim.claimedRole,
      actualRole: player.role,
      team: player.team,
      day: numberMetadata(metadata?.day),
      pressureTargetId: pressureTargetIdFromSpeechActsOrMetadata(message, metadata),
      speechActId: roleClaim.speechActId,
      speechActKind: roleClaim.speechActKind,
      claimSource: roleClaim.claimSource
    });
  }
  return claims;
}

function roleClaimFactFromSpeechAct(message: SocialMessage): RoleClaimFact | undefined {
  const speechAct = (message.speechActs ?? []).find((act) => {
    if (act.kind !== "role_claim") return false;
    if (act.subjectId && act.subjectId !== message.senderId) return false;
    return roleMetadata(act.value) !== undefined;
  });
  if (!speechAct) return undefined;
  const claimedRole = roleMetadata(speechAct.value);
  if (!claimedRole) return undefined;
  return {
    claimedRole,
    speechActId: speechAct.id,
    speechActKind: speechAct.kind,
    claimSource: "speech_act"
  };
}

function roleClaimFactFromMetadata(metadata: Record<string, unknown> | undefined): RoleClaimFact | undefined {
  if (metadata?.kind !== "public-speech") return undefined;
  const claimedRole = roleMetadata(metadata.claimedRole);
  return claimedRole ? { claimedRole, claimSource: "metadata" } : undefined;
}

function pressureTargetIdFromSpeechActsOrMetadata(message: SocialMessage, metadata: Record<string, unknown> | undefined): string | undefined {
  return (
    (message.speechActs ?? []).find((act) => act.kind === "accusation" && typeof act.targetId === "string" && act.targetId.trim())?.targetId ??
    stringMetadata(metadata?.pressureTargetId)
  );
}

function metricsFromFalseRoleClaimBeliefTemporalAssociation(
  state: GameState,
  agents: AgentHarnessState[],
  socialEpisode?: unknown
): HarnessMetricRecord[] {
  const exposureInput = socialEpisodeExposureInput(socialEpisode);
  if (!exposureInput) return [];

  const falseClaims = falseRoleClaimMessages(state, exposureInput.messages);
  if (!falseClaims.length) return [];

  const falseClaimByMessageId = new Map(falseClaims.map((claim) => [claim.message.id, claim]));
  const exposureRecords = deriveSocialExposureRecords(exposureInput).filter((record) => falseClaimByMessageId.has(record.messageId));
  const recordsByObserver = groupFalseClaimExposureRecordsByObserver(exposureRecords);
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));

  return state.players.flatMap((player) => {
    const agent = agentByPlayer.get(player.id);
    const observerExposureRecords = recordsByObserver.get(player.id) ?? [];
    const audit = falseRoleClaimBeliefTemporalAssociationAudit(agent, observerExposureRecords, falseClaimByMessageId);
    const associatedExposureCount = uniqueExposureCount(audit.linkedRecords);
    const subject = {
      playerId: player.id,
      profileId: agent?.profileId,
      model: agent?.model ?? "unknown",
      role: player.role,
      team: player.team
    };

    return [
      falseRoleClaimBeliefTemporalAssociationMetric({
        id: "agent.false_role_claim_belief_temporal_association_count",
        label: "False role claim belief temporal association count",
        playerId: player.id,
        subject,
        agent,
        falseClaimByMessageId,
        audit,
        value: associatedExposureCount,
        unit: "count",
        denominator: audit.evaluableExposureRecords.length,
        aggregation: "sum"
      }),
      falseRoleClaimBeliefTemporalAssociationMetric({
        id: "agent.false_role_claim_belief_temporal_association_rate",
        label: "False role claim belief temporal association rate",
        playerId: player.id,
        subject,
        agent,
        falseClaimByMessageId,
        audit,
        value: ratio(associatedExposureCount, audit.evaluableExposureRecords.length),
        unit: "ratio",
        denominator: audit.evaluableExposureRecords.length,
        aggregation: "ratio"
      }),
      falseRoleClaimBeliefTemporalAssociationMetric({
        id: "agent.false_role_claim_belief_temporal_evaluable_exposure_rate",
        label: "False role claim belief temporal evaluable exposure rate",
        playerId: player.id,
        subject,
        agent,
        falseClaimByMessageId,
        audit,
        value: ratio(audit.evaluableExposureRecords.length, audit.exposureRecords.length),
        unit: "ratio",
        denominator: audit.exposureRecords.length,
        aggregation: "coverage_ratio"
      })
    ];
  });
}

interface FalseRoleClaimBeliefTemporalAssociationAudit {
  exposureRecords: SocialExposureRecord[];
  evaluableExposureRecords: SocialExposureRecord[];
  linkedRecords: FalseRoleClaimBeliefTemporalAssociationRecord[];
  missingJournalExposureCount: number;
  ambiguousOrderingExposureCount: number;
  formationOnlyCount: number;
  noLaterMutationCount: number;
}

interface FalseRoleClaimBeliefTemporalAssociationRecord {
  claim: FalseRoleClaimMessage;
  exposure: SocialExposureRecord;
  journalEntry: SocialStateMutationJournalEntry;
  predicate: string;
}

const BELIEF_TEMPORAL_ASSOCIATION_PREDICATES = ["claimedRole", "werewolfProbability"];

function falseRoleClaimBeliefTemporalAssociationMetric(options: {
  id: string;
  label: string;
  playerId: string;
  subject: Record<string, unknown>;
  agent?: AgentHarnessState;
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>;
  audit: FalseRoleClaimBeliefTemporalAssociationAudit;
  value: number;
  unit: "count" | "ratio";
  denominator: number;
  aggregation: "sum" | "ratio" | "coverage_ratio";
}): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: options.playerId,
    subject: options.subject,
    value: options.value,
    unit: options.unit,
    higherIsBetter: false,
    weight: 0,
    source: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.denominator ? 1 : 0,
    aggregation: options.aggregation,
    evidenceRefs: falseRoleClaimBeliefTemporalAssociationEvidence(options.agent, options.audit, options.falseClaimByMessageId),
    metadata: falseRoleClaimBeliefTemporalAssociationMetadata(options.audit)
  });
}

function falseRoleClaimBeliefTemporalAssociationAudit(
  agent: AgentHarnessState | undefined,
  exposureRecords: SocialExposureRecord[],
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>
): FalseRoleClaimBeliefTemporalAssociationAudit {
  const entries = agent?.social?.journal?.entries ?? [];
  const audit: FalseRoleClaimBeliefTemporalAssociationAudit = {
    exposureRecords,
    evaluableExposureRecords: [],
    linkedRecords: [],
    missingJournalExposureCount: 0,
    ambiguousOrderingExposureCount: 0,
    formationOnlyCount: 0,
    noLaterMutationCount: 0
  };

  if (!agent || !entries.length) {
    audit.missingJournalExposureCount = exposureRecords.length;
    return audit;
  }

  const seen = new Set<string>();
  for (const exposure of exposureRecords) {
    const claim = falseClaimByMessageId.get(exposure.messageId);
    if (!claim) continue;
    const candidateEntries = entries.filter((entry) => journalEntryMatchesFalseClaimBeliefCandidate(entry, exposure, claim));
    const orderedEntries = candidateEntries.filter((entry): entry is SocialStateMutationJournalEntry & { turnIndex: number } => typeof entry.turnIndex === "number");
    if (candidateEntries.some((entry) => typeof entry.turnIndex !== "number")) {
      audit.ambiguousOrderingExposureCount += 1;
      continue;
    }

    audit.evaluableExposureRecords.push(exposure);
    audit.formationOnlyCount += orderedEntries.filter((entry) => !entry.beforeSummary && entry.turnIndex <= exposure.observedAtTurnIndex).length;
    const laterShiftEntries = orderedEntries.filter(
      (entry) => entry.turnIndex > exposure.observedAtTurnIndex && journalEntryHasBeliefShift(entry)
    );
    if (!laterShiftEntries.length) {
      audit.noLaterMutationCount += 1;
      continue;
    }

    for (const entry of laterShiftEntries) {
      const predicate = journalEntryBeliefPredicate(entry);
      if (!predicate) continue;
      const key = `${exposure.messageId}:${exposure.observerId}:${entry.journalSeq}:beliefs`;
      if (seen.has(key)) continue;
      seen.add(key);
      audit.linkedRecords.push({ claim, exposure, journalEntry: entry, predicate });
    }
  }
  return audit;
}

function journalEntryMatchesFalseClaimBeliefCandidate(
  entry: SocialStateMutationJournalEntry,
  exposure: SocialExposureRecord,
  claim: FalseRoleClaimMessage
): boolean {
  if (entry.store !== "beliefs") return false;
  if (entry.mutationKind !== "belief.upserted") return false;
  if (entry.agentId !== exposure.observerId) return false;
  if (entry.subjectId !== claim.sourceId) return false;
  if (entry.hiddenTruthUsed !== false) return false;
  const predicate = journalEntryBeliefPredicate(entry);
  if (!predicate || !BELIEF_TEMPORAL_ASSOCIATION_PREDICATES.includes(predicate)) return false;
  return journalEntryReferencesMessage(entry, exposure.messageId, exposure.messageSeq);
}

function journalEntryBeliefPredicate(entry: SocialStateMutationJournalEntry): string | undefined {
  const predicate =
    stringMetadata(entry.afterSummary?.predicate) ?? stringMetadata(entry.deltaSummary?.predicate) ?? stringMetadata(entry.beforeSummary?.predicate);
  return predicate && BELIEF_TEMPORAL_ASSOCIATION_PREDICATES.includes(predicate) ? predicate : undefined;
}

function journalEntryHasBeliefShift(entry: SocialStateMutationJournalEntry): boolean {
  if (!entry.beforeSummary) return false;
  const confidenceDelta = numberMetadata(entry.deltaSummary?.confidenceDelta);
  const contradictionCountDelta = numberMetadata(entry.deltaSummary?.contradictionCountDelta);
  return (
    entry.deltaSummary?.valueChanged === true ||
    (confidenceDelta !== undefined && confidenceDelta !== 0) ||
    (contradictionCountDelta !== undefined && contradictionCountDelta > 0)
  );
}

function journalEntryReferencesMessage(entry: SocialStateMutationJournalEntry, messageId: string, messageSeq: number): boolean {
  if (entry.evidenceRefs.some((ref) => ref.artifact === "message" && ref.id === messageId)) return true;
  const range = entry.messageSeqRange;
  return Boolean(range && range.start <= messageSeq && messageSeq <= range.end);
}

function falseRoleClaimBeliefTemporalAssociationEvidence(
  agent: AgentHarnessState | undefined,
  audit: FalseRoleClaimBeliefTemporalAssociationAudit,
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>
): HarnessMetricEvidenceRef[] {
  const exposureEvidenceRecords = audit.linkedRecords.length ? audit.linkedRecords.map((record) => record.exposure) : audit.exposureRecords;
  const refs: HarnessMetricEvidenceRef[] = falseRoleClaimExposureEvidence(exposureEvidenceRecords, falseClaimByMessageId);
  if (agent) refs.push(agentStateEvidence(agent));
  if (agent && audit.linkedRecords.length) {
    refs.push(...metricEvidenceFromSocialRefs(agent, audit.linkedRecords.flatMap((record) => record.journalEntry.evidenceRefs)));
    refs.push(
      ...audit.linkedRecords.flatMap((record) => [
        {
          artifact: "agent_state" as const,
          id: agent.playerId,
          seq: record.journalEntry.journalSeq,
          traceId: record.journalEntry.traceId,
          description: `social_state_mutation:${record.journalEntry.mutationKind}`
        },
        ...(record.journalEntry.traceId
          ? [
              {
                artifact: "trace" as const,
                traceId: record.journalEntry.traceId,
                seq: record.journalEntry.turnIndex,
                description: `social-state journal ${record.journalEntry.mutationKind}#${record.journalEntry.journalSeq}`
              }
            ]
          : [])
      ])
    );
  }
  return uniqueEvidenceRefs(
    refs.length
      ? refs
      : [
          stateEvidence("false role claim belief temporal association records", {
            id: agent?.playerId
          })
        ]
  );
}

function falseRoleClaimBeliefTemporalAssociationMetadata(audit: FalseRoleClaimBeliefTemporalAssociationAudit): Record<string, unknown> {
  const linkedExposureKeys = new Set(audit.linkedRecords.map((record) => falseClaimExposureKey(record.exposure)));
  return {
    associationLevel: "temporal_association",
    causalClaim: false,
    truthAccessMode: "postgame_role_truth_for_false_claim_classification_only",
    exposureSource: "SocialExposureRecord",
    mutationSource: "SocialStateMutationJournalEntry",
    orderingRule: "mutation.turnIndex > exposure.observedAtTurnIndex",
    mutationStore: "beliefs",
    mutationKind: "belief.upserted",
    predicateWhitelist: BELIEF_TEMPORAL_ASSOCIATION_PREDICATES,
    excludedImmediateIngestion: true,
    falseRoleClaimExposureCount: audit.exposureRecords.length,
    evaluableFalseClaimExposureCount: audit.evaluableExposureRecords.length,
    associatedExposureCount: linkedExposureKeys.size,
    associatedMutationCount: audit.linkedRecords.length,
    unevaluableExposureCount: audit.exposureRecords.length - audit.evaluableExposureRecords.length,
    missingJournalExposureCount: audit.missingJournalExposureCount,
    ambiguousOrderingExposureCount: audit.ambiguousOrderingExposureCount,
    formationOnlyCount: audit.formationOnlyCount,
    noLaterMutationCount: audit.noLaterMutationCount,
    hiddenTruthUsedInLiveStore: audit.linkedRecords.some((record) => record.journalEntry.hiddenTruthUsed) ? true : false,
    postgameTruthUsedForFalseClaimClassification: true,
    stores: audit.linkedRecords.length ? ["beliefs"] : [],
    mutationKinds: audit.linkedRecords.length ? ["belief.upserted"] : [],
    predicates: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.predicate))),
    journalSeqs: audit.linkedRecords.map((record) => record.journalEntry.journalSeq).slice(0, 20),
    messageIds: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.exposure.messageId))),
    messageSeqs: audit.linkedRecords.map((record) => record.exposure.messageSeq).slice(0, 20),
    sourceIds: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.claim.sourceId))),
    observedAtTraceIds: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.exposure.observedAtTraceId))),
    claimFacts: audit.linkedRecords
      .map((record) => ({
        messageId: record.claim.message.id,
        messageSeq: record.claim.message.seq,
        sourceId: record.claim.sourceId,
        observerId: record.exposure.observerId,
        claimedRole: record.claim.claimedRole,
        actualRole: record.claim.actualRole,
        claimSource: record.claim.claimSource,
        speechActId: record.claim.speechActId,
        speechActKind: record.claim.speechActKind,
        predicate: record.predicate,
        store: record.journalEntry.store,
        mutationKind: record.journalEntry.mutationKind,
        journalSeq: record.journalEntry.journalSeq,
        traceId: record.journalEntry.traceId ?? null
      }))
      .slice(0, 20)
  };
}

function metricsFromFalseRoleClaimReputationTemporalAssociation(
  state: GameState,
  agents: AgentHarnessState[],
  socialEpisode?: unknown
): HarnessMetricRecord[] {
  const exposureInput = socialEpisodeExposureInput(socialEpisode);
  if (!exposureInput) return [];

  const falseClaims = falseRoleClaimMessages(state, exposureInput.messages);
  if (!falseClaims.length) return [];

  const falseClaimByMessageId = new Map(falseClaims.map((claim) => [claim.message.id, claim]));
  const exposureRecords = deriveSocialExposureRecords(exposureInput).filter((record) => falseClaimByMessageId.has(record.messageId));
  const recordsByObserver = groupFalseClaimExposureRecordsByObserver(exposureRecords);
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));

  return state.players.flatMap((player) => {
    const agent = agentByPlayer.get(player.id);
    const observerExposureRecords = recordsByObserver.get(player.id) ?? [];
    const audit = falseRoleClaimReputationTemporalAssociationAudit(agent, observerExposureRecords, falseClaimByMessageId);
    const associatedExposureCount = uniqueReputationExposureCount(audit.linkedRecords);
    const subject = {
      playerId: player.id,
      profileId: agent?.profileId,
      model: agent?.model ?? "unknown",
      role: player.role,
      team: player.team
    };

    return [
      falseRoleClaimReputationTemporalAssociationMetric({
        id: "agent.false_role_claim_reputation_temporal_association_count",
        label: "False role claim reputation temporal association count",
        playerId: player.id,
        subject,
        agent,
        falseClaimByMessageId,
        audit,
        value: associatedExposureCount,
        unit: "count",
        denominator: audit.evaluableExposureRecords.length,
        aggregation: "sum"
      }),
      falseRoleClaimReputationTemporalAssociationMetric({
        id: "agent.false_role_claim_reputation_temporal_association_rate",
        label: "False role claim reputation temporal association rate",
        playerId: player.id,
        subject,
        agent,
        falseClaimByMessageId,
        audit,
        value: ratio(associatedExposureCount, audit.evaluableExposureRecords.length),
        unit: "ratio",
        denominator: audit.evaluableExposureRecords.length,
        aggregation: "ratio"
      }),
      falseRoleClaimReputationTemporalAssociationMetric({
        id: "agent.false_role_claim_reputation_temporal_evaluable_exposure_rate",
        label: "False role claim reputation temporal evaluable exposure rate",
        playerId: player.id,
        subject,
        agent,
        falseClaimByMessageId,
        audit,
        value: ratio(audit.evaluableExposureRecords.length, audit.exposureRecords.length),
        unit: "ratio",
        denominator: audit.exposureRecords.length,
        aggregation: "coverage_ratio"
      })
    ];
  });
}

interface FalseRoleClaimReputationTemporalAssociationAudit {
  exposureRecords: SocialExposureRecord[];
  evaluableExposureRecords: SocialExposureRecord[];
  linkedRecords: FalseRoleClaimReputationTemporalAssociationRecord[];
  missingJournalExposureCount: number;
  ambiguousOrderingExposureCount: number;
  sameTurnMutationCount: number;
  noLaterMutationCount: number;
}

interface FalseRoleClaimReputationTemporalAssociationRecord {
  claim: FalseRoleClaimMessage;
  exposure: SocialExposureRecord;
  journalEntry: SocialStateMutationJournalEntry;
  reputationDimensions: string[];
}

const REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS = ["honesty", "competence", "cooperation", "threat", "normCompliance"];

function falseRoleClaimReputationTemporalAssociationMetric(options: {
  id: string;
  label: string;
  playerId: string;
  subject: Record<string, unknown>;
  agent?: AgentHarnessState;
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>;
  audit: FalseRoleClaimReputationTemporalAssociationAudit;
  value: number;
  unit: "count" | "ratio";
  denominator: number;
  aggregation: "sum" | "ratio" | "coverage_ratio";
}): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: options.playerId,
    subject: options.subject,
    value: options.value,
    unit: options.unit,
    higherIsBetter: false,
    weight: 0,
    source: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
    denominator: options.denominator,
    confidence: options.denominator ? 1 : 0,
    aggregation: options.aggregation,
    evidenceRefs: falseRoleClaimReputationTemporalAssociationEvidence(options.agent, options.audit, options.falseClaimByMessageId),
    metadata: falseRoleClaimReputationTemporalAssociationMetadata(options.audit)
  });
}

function falseRoleClaimReputationTemporalAssociationAudit(
  agent: AgentHarnessState | undefined,
  exposureRecords: SocialExposureRecord[],
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>
): FalseRoleClaimReputationTemporalAssociationAudit {
  const entries = agent?.social?.journal?.entries ?? [];
  const audit: FalseRoleClaimReputationTemporalAssociationAudit = {
    exposureRecords,
    evaluableExposureRecords: [],
    linkedRecords: [],
    missingJournalExposureCount: 0,
    ambiguousOrderingExposureCount: 0,
    sameTurnMutationCount: 0,
    noLaterMutationCount: 0
  };

  if (!agent || !entries.length) {
    audit.missingJournalExposureCount = exposureRecords.length;
    return audit;
  }

  const seen = new Set<string>();
  for (const exposure of exposureRecords) {
    const claim = falseClaimByMessageId.get(exposure.messageId);
    if (!claim) continue;
    const candidateEntries = entries.filter((entry) => journalEntryMatchesFalseClaimReputationCandidate(entry, exposure, claim));
    const orderedEntries = candidateEntries.filter((entry): entry is SocialStateMutationJournalEntry & { turnIndex: number } => typeof entry.turnIndex === "number");
    if (candidateEntries.some((entry) => typeof entry.turnIndex !== "number")) {
      audit.ambiguousOrderingExposureCount += 1;
      continue;
    }

    audit.evaluableExposureRecords.push(exposure);
    audit.sameTurnMutationCount += orderedEntries.filter((entry) => entry.turnIndex <= exposure.observedAtTurnIndex).length;
    const laterMutationEntries = orderedEntries.filter(
      (entry) => entry.turnIndex > exposure.observedAtTurnIndex && journalEntryHasReputationDelta(entry)
    );
    if (!laterMutationEntries.length) {
      audit.noLaterMutationCount += 1;
      continue;
    }

    for (const entry of laterMutationEntries) {
      const reputationDimensions = journalEntryReputationDimensions(entry);
      if (!reputationDimensions.length) continue;
      const key = `${exposure.messageId}:${exposure.observerId}:${entry.journalSeq}:reputation`;
      if (seen.has(key)) continue;
      seen.add(key);
      audit.linkedRecords.push({ claim, exposure, journalEntry: entry, reputationDimensions });
    }
  }
  return audit;
}

function journalEntryMatchesFalseClaimReputationCandidate(
  entry: SocialStateMutationJournalEntry,
  exposure: SocialExposureRecord,
  claim: FalseRoleClaimMessage
): boolean {
  if (entry.store !== "reputation") return false;
  if (entry.mutationKind !== "reputation.updated") return false;
  if (entry.agentId !== exposure.observerId) return false;
  if (entry.subjectId !== claim.sourceId) return false;
  if (entry.hiddenTruthUsed !== false) return false;
  if (!journalEntryHasReputationDelta(entry)) return false;
  return journalEntryReferencesMessage(entry, exposure.messageId, exposure.messageSeq);
}

function journalEntryHasReputationDelta(entry: SocialStateMutationJournalEntry): boolean {
  return journalEntryReputationDimensions(entry).length > 0;
}

function journalEntryReputationDimensions(entry: SocialStateMutationJournalEntry): string[] {
  return REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS.filter((dimension) => {
    const value = numberMetadata(entry.deltaSummary?.[dimension]);
    return value !== undefined && value !== 0;
  });
}

function falseRoleClaimReputationTemporalAssociationEvidence(
  agent: AgentHarnessState | undefined,
  audit: FalseRoleClaimReputationTemporalAssociationAudit,
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>
): HarnessMetricEvidenceRef[] {
  const exposureEvidenceRecords = audit.linkedRecords.length ? audit.linkedRecords.map((record) => record.exposure) : audit.exposureRecords;
  const refs: HarnessMetricEvidenceRef[] = falseRoleClaimExposureEvidence(exposureEvidenceRecords, falseClaimByMessageId);
  if (agent) refs.push(agentStateEvidence(agent));
  if (agent && audit.linkedRecords.length) {
    refs.push(...metricEvidenceFromSocialRefs(agent, audit.linkedRecords.flatMap((record) => record.journalEntry.evidenceRefs)));
    refs.push(
      ...audit.linkedRecords.flatMap((record) => [
        {
          artifact: "agent_state" as const,
          id: agent.playerId,
          seq: record.journalEntry.journalSeq,
          traceId: record.journalEntry.traceId,
          description: `social_state_mutation:${record.journalEntry.mutationKind}`
        },
        ...(record.journalEntry.traceId
          ? [
              {
                artifact: "trace" as const,
                traceId: record.journalEntry.traceId,
                seq: record.journalEntry.turnIndex,
                description: `social-state journal ${record.journalEntry.mutationKind}#${record.journalEntry.journalSeq}`
              }
            ]
          : [])
      ])
    );
  }
  return uniqueEvidenceRefs(
    refs.length
      ? refs
      : [
          stateEvidence("false role claim reputation temporal association records", {
            id: agent?.playerId
          })
        ]
  );
}

function falseRoleClaimReputationTemporalAssociationMetadata(audit: FalseRoleClaimReputationTemporalAssociationAudit): Record<string, unknown> {
  const linkedExposureKeys = new Set(audit.linkedRecords.map((record) => falseClaimExposureKey(record.exposure)));
  return {
    associationLevel: "temporal_association",
    causalClaim: false,
    truthAccessMode: "postgame_role_truth_for_false_claim_classification_only",
    exposureSource: "SocialExposureRecord",
    mutationSource: "SocialStateMutationJournalEntry",
    orderingRule: "mutation.turnIndex > exposure.observedAtTurnIndex",
    mutationStore: "reputation",
    mutationKind: "reputation.updated",
    reputationDimensionWhitelist: REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS,
    falseRoleClaimExposureCount: audit.exposureRecords.length,
    evaluableFalseClaimExposureCount: audit.evaluableExposureRecords.length,
    associatedExposureCount: linkedExposureKeys.size,
    associatedMutationCount: audit.linkedRecords.length,
    unevaluableExposureCount: audit.exposureRecords.length - audit.evaluableExposureRecords.length,
    missingJournalExposureCount: audit.missingJournalExposureCount,
    ambiguousOrderingExposureCount: audit.ambiguousOrderingExposureCount,
    sameTurnMutationCount: audit.sameTurnMutationCount,
    noLaterMutationCount: audit.noLaterMutationCount,
    hiddenTruthUsedInLiveStore: audit.linkedRecords.some((record) => record.journalEntry.hiddenTruthUsed) ? true : false,
    postgameTruthUsedForFalseClaimClassification: true,
    stores: audit.linkedRecords.length ? ["reputation"] : [],
    mutationKinds: audit.linkedRecords.length ? ["reputation.updated"] : [],
    reputationDimensions: sampleIds(uniqueStrings(audit.linkedRecords.flatMap((record) => record.reputationDimensions))),
    journalSeqs: audit.linkedRecords.map((record) => record.journalEntry.journalSeq).slice(0, 20),
    messageIds: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.exposure.messageId))),
    messageSeqs: audit.linkedRecords.map((record) => record.exposure.messageSeq).slice(0, 20),
    sourceIds: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.claim.sourceId))),
    observedAtTraceIds: sampleIds(uniqueStrings(audit.linkedRecords.map((record) => record.exposure.observedAtTraceId))),
    claimFacts: audit.linkedRecords
      .map((record) => ({
        messageId: record.claim.message.id,
        messageSeq: record.claim.message.seq,
        sourceId: record.claim.sourceId,
        observerId: record.exposure.observerId,
        claimedRole: record.claim.claimedRole,
        actualRole: record.claim.actualRole,
        claimSource: record.claim.claimSource,
        speechActId: record.claim.speechActId,
        speechActKind: record.claim.speechActKind,
        reputationDimensions: record.reputationDimensions,
        store: record.journalEntry.store,
        mutationKind: record.journalEntry.mutationKind,
        journalSeq: record.journalEntry.journalSeq,
        traceId: record.journalEntry.traceId ?? null
      }))
      .slice(0, 20)
  };
}

function uniqueReputationExposureCount(records: FalseRoleClaimReputationTemporalAssociationRecord[]): number {
  return new Set(records.map((record) => falseClaimExposureKey(record.exposure))).size;
}

function uniqueExposureCount(records: FalseRoleClaimBeliefTemporalAssociationRecord[]): number {
  return new Set(records.map((record) => falseClaimExposureKey(record.exposure))).size;
}

function falseClaimExposureKey(record: SocialExposureRecord): string {
  return `${record.messageId}:${record.observerId}:${record.observedAtTraceId}`;
}

function metricsFromFalseRoleClaimPressureVoteFollow(state: GameState, agents: AgentHarnessState[], socialEpisode?: unknown): HarnessMetricRecord[] {
  const exposureInput = socialEpisodeExposureInput(socialEpisode);
  if (!exposureInput) return [];

  const falseClaims = falseRoleClaimMessages(state, exposureInput.messages).filter((claim) => claim.pressureTargetId && claim.day !== undefined);
  if (!falseClaims.length) return [];

  const falseClaimByMessageId = new Map(falseClaims.map((claim) => [claim.message.id, claim]));
  const exposureRecords = deriveSocialExposureRecords(exposureInput).filter((record) => falseClaimByMessageId.has(record.messageId));
  const voteFollowRecords = falseRoleClaimPressureVoteFollowRecords(state, exposureInput, exposureRecords, falseClaimByMessageId);

  const recordsBySpeaker = groupPressureVoteFollowRecordsBySpeaker(voteFollowRecords);
  const falsePressureSpeakerIds = uniqueStrings(falseClaims.map((claim) => claim.sourceId));
  const agentByPlayer = new Map(agents.map((agent) => [agent.playerId, agent]));
  const playerById = new Map(state.players.map((player) => [player.id, player]));

  return falsePressureSpeakerIds.flatMap((speakerId) => {
    const player = playerById.get(speakerId);
    const agent = agentByPlayer.get(speakerId);
    const records = recordsBySpeaker.get(speakerId) ?? [];
    const followedRecords = records.filter((record) => record.followed);
    const subject = {
      playerId: speakerId,
      profileId: agent?.profileId,
      model: agent?.model ?? "unknown",
      role: player?.role ?? "unknown",
      team: player?.team ?? "unknown"
    };
    const evidenceRefs = falseRoleClaimPressureVoteFollowEvidence(records);
    const metadata = falseRoleClaimPressureVoteFollowMetadata(records, followedRecords, {
      falseRoleClaimPressureMessages: falseClaims.filter((claim) => claim.sourceId === speakerId).length,
      voteOpportunities: records.length,
      followedVotes: followedRecords.length
    });

    return [
      metric({
        id: "agent.false_role_claim_pressure_vote_follow_count",
        label: "False role claim pressure vote-follow count",
        scope: "agent",
        subjectId: speakerId,
        subject,
        value: followedRecords.length,
        unit: "count",
        higherIsBetter: false,
        weight: 0,
        source: WEREWOLF_DECEPTION_EVALUATOR_ID,
        denominator: records.length,
        confidence: records.length ? 1 : 0,
        aggregation: "sum",
        evidenceRefs: evidenceRefs.length
          ? evidenceRefs
          : [stateEvidence(`false role claim pressure vote-follow records for ${speakerId}`, { id: speakerId })],
        metadata
      }),
      metric({
        id: "agent.false_role_claim_pressure_vote_follow_rate",
        label: "False role claim pressure vote-follow rate",
        scope: "agent",
        subjectId: speakerId,
        subject,
        value: records.length ? round3(followedRecords.length / records.length) : 0,
        unit: "ratio",
        higherIsBetter: false,
        weight: 0,
        source: WEREWOLF_DECEPTION_EVALUATOR_ID,
        denominator: records.length,
        confidence: records.length ? 1 : 0,
        aggregation: "ratio",
        evidenceRefs: evidenceRefs.length
          ? evidenceRefs
          : [stateEvidence(`false role claim pressure vote-follow records for ${speakerId}`, { id: speakerId })],
        metadata
      })
    ];
  });
}

function falseRoleClaimPressureVoteFollowRecords(
  state: GameState,
  exposureInput: SocialEpisodeExposureInput,
  exposureRecords: SocialExposureRecord[],
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>
): FalseRoleClaimPressureVoteFollowRecord[] {
  const stepByTraceId = new Map(
    exposureInput.steps.flatMap((step) => {
      const record = asRecord(step);
      const traceId = typeof record?.traceId === "string" ? record.traceId : undefined;
      return traceId ? [[traceId, record] as const] : [];
    })
  );
  const records: FalseRoleClaimPressureVoteFollowRecord[] = [];
  const seen = new Set<string>();

  for (const exposure of exposureRecords) {
    const claim = falseClaimByMessageId.get(exposure.messageId);
    if (!claim?.pressureTargetId || claim.day === undefined) continue;
    const voteCommand = voteCommandFromSocialStep(stepByTraceId.get(exposure.observedAtTraceId), exposure.observerId);
    if (!voteCommand) continue;
    const vote = state.votes.find(
      (item) =>
        (item.kind ?? "exile") === "exile" &&
        item.day === claim.day &&
        item.voterId === exposure.observerId
    );
    if (!vote) continue;
    if (Boolean(vote.abstain) !== voteCommand.abstain) continue;
    if (!vote.abstain && vote.targetId !== voteCommand.targetId) continue;

    const key = `${claim.message.id}:${exposure.observerId}:${claim.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const followed = !vote.abstain && vote.targetId === claim.pressureTargetId;
    records.push({
      claim,
      exposure,
      vote: {
        voterId: vote.voterId,
        targetId: vote.targetId,
        abstain: vote.abstain,
        day: vote.day
      },
      followed,
      voteEvent: voteEventForVoteRecord(state, vote)
    });
  }

  return records;
}

function falseRoleClaimExposureEvidence(
  records: SocialExposureRecord[],
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>
): HarnessMetricEvidenceRef[] {
  const refs: HarnessMetricEvidenceRef[] = [];
  for (const record of records) {
    for (const ref of record.evidenceRefs) {
      if (ref.artifact === "message") {
        refs.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "delivery_receipt") {
        refs.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "trace") {
        refs.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "observation") {
        refs.push({
          artifact: "observation",
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId,
          description: ref.description ?? `scoped exposure of ${record.messageId}`
        });
        continue;
      }
      refs.push({
        artifact: "observation",
        id: ref.id,
        seq: ref.seq,
        traceId: ref.traceId,
        description: ref.description ?? `scoped exposure of ${record.messageId}`
      });
    }
    const claim = falseClaimByMessageId.get(record.messageId);
    if (claim) {
      refs.push(
        stateEvidence(`postgame role truth for ${claim.sourceId}`, {
          id: claim.sourceId
        })
      );
    }
  }
  return uniqueEvidenceRefs(refs);
}

function falseRoleClaimExposureMetadata(
  records: SocialExposureRecord[],
  falseClaimByMessageId: Map<string, FalseRoleClaimMessage>,
  totals: {
    falseRoleClaimMessages: number;
    falseRoleClaimSpeakers: number;
    totalFalseRoleClaimExposureRecords: number;
    observedFalseRoleClaimMessages: number;
  }
): Record<string, unknown> {
  const claims = records.flatMap((record) => {
    const claim = falseClaimByMessageId.get(record.messageId);
    return claim ? [claim] : [];
  });
  const uniqueMessageIds = uniqueStrings(records.map((record) => record.messageId));
  return {
    exposureRecords: records.length,
    falseRoleClaimExposureRecords: records.length,
    totalFalseRoleClaimExposureRecords: totals.totalFalseRoleClaimExposureRecords,
    falseRoleClaimMessages: totals.falseRoleClaimMessages,
    observedFalseRoleClaimMessages: totals.observedFalseRoleClaimMessages,
    falseRoleClaimSpeakers: totals.falseRoleClaimSpeakers,
    sourceIds: sampleIds(uniqueStrings(records.map((record) => record.sourceId))),
    messageIds: sampleIds(uniqueMessageIds),
    messageSeqs: records.map((record) => record.messageSeq).slice(0, 20),
    claimedRoles: sampleIds(claims.map((claim) => claim.claimedRole)),
    actualRoles: sampleIds(claims.map((claim) => claim.actualRole)),
    deliveryReceiptCount: records.filter((record) => record.deliveryReceipt).length,
    deliveryReceiptIds: sampleIds(uniqueStrings(records.flatMap((record) => (record.deliveryReceipt?.id ? [record.deliveryReceipt.id] : [])))),
    speechActIds: sampleIds(uniqueStrings(claims.flatMap((claim) => (claim.speechActId ? [claim.speechActId] : [])))),
    claimSources: sampleIds(uniqueStrings(claims.map((claim) => claim.claimSource))),
    observedAtTraceIds: sampleIds(uniqueStrings(records.map((record) => record.observedAtTraceId))),
    actionKinds: sampleIds(uniqueStrings(records.map((record) => record.observedAtActionKind))),
    claimFacts: uniqueMessageIds
      .flatMap((messageId) => {
        const claim = falseClaimByMessageId.get(messageId);
        return claim
          ? [
              {
                messageId: claim.message.id,
                messageSeq: claim.message.seq,
                sourceId: claim.sourceId,
                claimedRole: claim.claimedRole,
                actualRole: claim.actualRole,
                team: claim.team,
                claimSource: claim.claimSource,
                speechActId: claim.speechActId,
                speechActKind: claim.speechActKind
              }
            ]
          : [];
      })
      .slice(0, 20)
  };
}

function falseRoleClaimPressureVoteFollowEvidence(records: FalseRoleClaimPressureVoteFollowRecord[]): HarnessMetricEvidenceRef[] {
  const refs: HarnessMetricEvidenceRef[] = [];
  for (const record of records) {
    for (const ref of record.exposure.evidenceRefs) {
      if (ref.artifact === "message") {
        refs.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "delivery_receipt") {
        refs.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "trace") {
        refs.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "observation") {
        refs.push({
          artifact: "observation",
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId,
          description: ref.description ?? `scoped exposure of ${record.exposure.messageId}`
        });
        continue;
      }
      refs.push({
        artifact: "observation",
        id: ref.id,
        seq: ref.seq,
        traceId: ref.traceId,
        description: ref.description ?? `scoped exposure of ${record.exposure.messageId}`
      });
    }
    if (record.voteEvent) refs.push(eventToEvidenceRef(record.voteEvent));
    refs.push(
      stateEvidence(`postgame role truth for ${record.claim.sourceId}`, {
        id: record.claim.sourceId
      })
    );
  }
  return uniqueEvidenceRefs(refs);
}

function falseRoleClaimPressureVoteFollowMetadata(
  records: FalseRoleClaimPressureVoteFollowRecord[],
  followedRecords: FalseRoleClaimPressureVoteFollowRecord[],
  totals: {
    falseRoleClaimPressureMessages: number;
    voteOpportunities: number;
    followedVotes: number;
  }
): Record<string, unknown> {
  return {
    falseRoleClaimPressureMessages: totals.falseRoleClaimPressureMessages,
    voteOpportunities: totals.voteOpportunities,
    followedVotes: totals.followedVotes,
    nonFollowedVotes: totals.voteOpportunities - totals.followedVotes,
    messageIds: sampleIds(uniqueStrings(records.map((record) => record.claim.message.id))),
    messageSeqs: records.map((record) => record.claim.message.seq).slice(0, 20),
    followedMessageIds: sampleIds(uniqueStrings(followedRecords.map((record) => record.claim.message.id))),
    observerIds: sampleIds(uniqueStrings(records.map((record) => record.exposure.observerId))),
    followedObserverIds: sampleIds(uniqueStrings(followedRecords.map((record) => record.exposure.observerId))),
    pressureTargetIds: sampleIds(uniqueStrings(records.flatMap((record) => (record.claim.pressureTargetId ? [record.claim.pressureTargetId] : [])))),
    voteTargetIds: sampleIds(uniqueStrings(records.flatMap((record) => (record.vote.targetId ? [record.vote.targetId] : [])))),
    deliveryReceiptCount: records.filter((record) => record.exposure.deliveryReceipt).length,
    deliveryReceiptIds: sampleIds(uniqueStrings(records.flatMap((record) => (record.exposure.deliveryReceipt?.id ? [record.exposure.deliveryReceipt.id] : [])))),
    speechActIds: sampleIds(uniqueStrings(records.flatMap((record) => (record.claim.speechActId ? [record.claim.speechActId] : [])))),
    claimSources: sampleIds(uniqueStrings(records.map((record) => record.claim.claimSource))),
    voteDays: records.map((record) => record.vote.day).slice(0, 20),
    observedAtTraceIds: sampleIds(uniqueStrings(records.map((record) => record.exposure.observedAtTraceId))),
    claimFacts: records
      .map((record) => ({
        messageId: record.claim.message.id,
        messageSeq: record.claim.message.seq,
        sourceId: record.claim.sourceId,
        observerId: record.exposure.observerId,
        claimedRole: record.claim.claimedRole,
        actualRole: record.claim.actualRole,
        pressureTargetId: record.claim.pressureTargetId,
        claimSource: record.claim.claimSource,
        speechActId: record.claim.speechActId,
        speechActKind: record.claim.speechActKind,
        voteTargetId: record.vote.targetId ?? null,
        abstain: record.vote.abstain,
        followed: record.followed,
        day: record.vote.day,
        traceId: record.exposure.observedAtTraceId,
        voteEventId: record.voteEvent?.id ?? null,
        voteEventSeq: record.voteEvent?.seq ?? null
      }))
      .slice(0, 20)
  };
}

function voteCommandFromSocialStep(step: Record<string, unknown> | undefined, observerId: string): { targetId?: string; abstain: boolean } | undefined {
  const action = asRecord(step?.action);
  const command = asRecord(action?.command);
  if (command?.type !== "vote.cast") return undefined;
  const actorId = stringMetadata(command.actorId);
  if (actorId && actorId !== observerId) return undefined;
  return {
    targetId: stringMetadata(command.targetId),
    abstain: command.abstain === true
  };
}

function voteEventForVoteRecord(state: GameState, vote: { day: number; voterId: string; targetId?: string; abstain: boolean }): GameEvent | undefined {
  return state.events.find((event) => {
    if (event.type !== "vote.cast" || event.actorId !== vote.voterId || event.day !== vote.day) return false;
    const payload = asRecord(event.payload);
    if (!payload) return false;
    const abstain = payload.abstain === true;
    const targetId = stringMetadata(payload.targetId);
    return abstain === vote.abstain && (abstain || targetId === vote.targetId);
  });
}

function groupPressureVoteFollowRecordsBySpeaker(records: FalseRoleClaimPressureVoteFollowRecord[]): Map<string, FalseRoleClaimPressureVoteFollowRecord[]> {
  const grouped = new Map<string, FalseRoleClaimPressureVoteFollowRecord[]>();
  for (const record of records) {
    grouped.set(record.claim.sourceId, [...(grouped.get(record.claim.sourceId) ?? []), record]);
  }
  return grouped;
}

function socialEpisodeExposureInput(socialEpisode?: unknown): SocialEpisodeExposureInput | undefined {
  if (!socialEpisode || typeof socialEpisode !== "object") return undefined;
  const candidate = socialEpisode as Partial<SocialEpisodeExposureInput>;
  if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.messages)) return undefined;
  const messages = candidate.messages.filter(isSocialMessage);
  if (messages.length !== candidate.messages.length) return undefined;
  return {
    steps: candidate.steps,
    messages
  };
}

function groupFalseClaimExposureRecordsByObserver(records: SocialExposureRecord[]): Map<string, SocialExposureRecord[]> {
  const grouped = new Map<string, SocialExposureRecord[]>();
  for (const record of records) {
    grouped.set(record.observerId, [...(grouped.get(record.observerId) ?? []), record]);
  }
  return grouped;
}

function isSocialMessage(value: unknown): value is SocialMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.seq === "number" &&
      typeof record.channelId === "string" &&
      typeof record.senderId === "string" &&
      Array.isArray(record.recipientIds) &&
      typeof record.visibility === "string" &&
      typeof record.content === "string" &&
      typeof record.createdAt === "string"
  );
}

const WEREWOLF_ROLE_VALUES = new Set<Role>(["villager", "werewolf", "seer", "witch", "hunter"]);

function roleMetadata(value: unknown): Role | undefined {
  return typeof value === "string" && WEREWOLF_ROLE_VALUES.has(value as Role) ? (value as Role) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function payloadPlayerId(payload: unknown): string | undefined {
  return typeof payload === "object" && payload && "playerId" in payload ? String(payload.playerId) : undefined;
}

function payloadPressureTargetId(payload: unknown): string | undefined {
  return typeof payload === "object" && payload && "pressureTargetId" in payload ? String(payload.pressureTargetId) : undefined;
}

function payloadClaimedRole(payload: unknown): string | undefined {
  return typeof payload === "object" && payload && "claimedRole" in payload ? String(payload.claimedRole) : undefined;
}

function stateEvidence(
  description: string,
  options?: {
    id?: string;
    description?: string;
  }
): HarnessMetricEvidenceRef {
  return {
    artifact: "state",
    id: options?.id,
    description: options?.description ?? description
  };
}

function uniqueEvidenceRefs(refs: HarnessMetricEvidenceRef[]): HarnessMetricEvidenceRef[] {
  const seen = new Set<string>();
  const unique: HarnessMetricEvidenceRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sampleIds(ids: string[]): string[] {
  return ids.slice(0, 20);
}

function sumMetricMetadata(metrics: HarnessMetricRecord[], key: string): number {
  return metrics.reduce((sum, item) => {
    const value = item.metadata?.[key];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function agentSubject(reward: AgentReward): Record<string, unknown> {
  return {
    playerId: reward.playerId,
    profileId: reward.profileId,
    model: reward.model,
    role: reward.role,
    team: reward.team
  };
}

function countHarnessErrors(socialEpisode: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of harnessFailureEvidenceFromEpisode(socialEpisode)) {
    const playerId = failure.actorId ?? "unknown";
    counts[playerId] = (counts[playerId] ?? 0) + 1;
  }
  return counts;
}

function averageReward(rewards: AgentReward[]): number {
  if (!rewards.length) return 0;
  return round3(rewards.reduce((sum, reward) => sum + reward.reward, 0) / rewards.length);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? round3(numerator / denominator) : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function signedScoreToProbability(value: number): number {
  return round3((Math.min(1, Math.max(-1, value)) + 1) / 2);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
