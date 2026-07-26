import { calibrationEvidenceRefs, calibrationMetadata, calibrationSubject, extractTrajectory, finalEventEvidence, groupTurnEvidenceByActor, misdirectVoteEvidence, reputationThreatCalibrationSamples, roleClaimConsistencyByAgent, roleClaimEvidenceForPlayer, roleEvidenceRefs, speechEvidenceForPlayer, survivalEvidenceForPlayer, teamEvidenceRefs, turnEvidenceToMetricRef, voteEvidenceForPlayer, wolfBeliefCalibrationSamples } from "./evidence";
import { metricsFromFalseRoleClaimExposure } from "./falseClaimBelief";
import { metricsFromFalseRoleClaimPressureVoteFollow } from "./pressureVoteFollow";
import { agentSubject, average, averageReward, countHarnessErrors, round3 } from "./support";
import { GameState, Role, Team } from "../../core/types";
import { HarnessEvaluationStatus, metric } from "../evaluation";
import { AdversarialEvaluation, AgentHarnessState, AgentReward, HarnessMetricRecord } from "../types";
import { WEREWOLF_DECEPTION_EVALUATOR_ID, WEREWOLF_INFLUENCE_EVALUATOR_ID, WEREWOLF_OUTCOME_EVALUATOR_ID, WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID, WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID, WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID, WerewolfRoleSurvivalEvaluation } from "./suite";
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
