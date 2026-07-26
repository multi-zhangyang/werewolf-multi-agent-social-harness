import { asRecord, average, clamp01, payloadClaimedRole, payloadPlayerId, payloadPressureTargetId, round3, sampleIds, signedScoreToProbability, stateEvidence, sumMetricMetadata, uniqueEvidenceRefs } from "./support";
import { GameEvent, GameState, Role, Team } from "../../core/types";
import { isSocialStepCommitted } from "../social";
import { EvidenceRef } from "../socialState";
import { AgentHarnessState, AgentTrajectoryStep, HarnessMetricEvidenceRef, HarnessMetricRecord, HarnessTurnTrace } from "../types";
import { werewolfHarnessTurnEvidenceFromEpisode } from "../werewolfExecutionEvidence";
import { DeceptionBeliefShiftEvaluation, DeceptionReputationAssociationEvaluation, WerewolfSocialCalibrationEvaluation } from "./suite";
export function extractTrajectory(socialEpisode: unknown): AgentTrajectoryStep[] {
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

export function groupTurnEvidenceByActor(socialEpisode: unknown): Map<string, ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>> {
  const grouped = new Map<string, ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>>();
  for (const evidence of werewolfHarnessTurnEvidenceFromEpisode(socialEpisode).filter(
    ({ step }) => isSocialStepCommitted(step)
  )) {
    grouped.set(evidence.actorId, [...(grouped.get(evidence.actorId) ?? []), evidence]);
  }
  return grouped;
}

export function turnEvidenceToMetricRef(evidence: ReturnType<typeof werewolfHarnessTurnEvidenceFromEpisode>[number]): HarnessMetricEvidenceRef {
  return {
    artifact: "trace",
    id: evidence.traceId,
    seq: evidence.turnIndex,
    traceId: evidence.traceId,
    description: evidence.trace.commandType
  };
}

export function eventToEvidenceRef(event: GameEvent): HarnessMetricEvidenceRef {
  const trace = event.payload as Partial<HarnessTurnTrace>;
  return {
    artifact: "event",
    id: event.id,
    seq: event.seq,
    traceId: typeof trace.traceId === "string" ? trace.traceId : undefined,
    description: event.type
  };
}

export function finalEventEvidence(state: GameState): HarnessMetricEvidenceRef[] {
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

export function teamEvidenceRefs(state: GameState, players: Array<{ id: string }>): HarnessMetricEvidenceRef[] {
  const refs = players.flatMap((player) => survivalEvidenceForPlayer(state, player));
  return refs.length ? refs : finalEventEvidence(state);
}

export function roleEvidenceRefs(state: GameState, players: Array<{ id: string }>): HarnessMetricEvidenceRef[] {
  const refs = players.flatMap((player) => survivalEvidenceForPlayer(state, player));
  return refs.length ? refs : finalEventEvidence(state);
}

export function survivalEvidenceForPlayer(state: GameState, player: { id: string }): HarnessMetricEvidenceRef[] {
  const deathEvent = state.events.find((event) => event.type === "player.died" && payloadPlayerId(event.payload) === player.id);
  return deathEvent ? [eventToEvidenceRef(deathEvent)] : finalEventEvidence(state);
}

export function voteEvidenceForPlayer(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
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

export function speechEvidenceForPlayer(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
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

export function misdirectVoteEvidence(state: GameState): HarnessMetricEvidenceRef[] {
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

export function roleClaimConsistencyByAgent(state: GameState): Array<{
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

export function roleClaimEvidenceForPlayer(state: GameState, playerId: string): HarnessMetricEvidenceRef[] {
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

export function wolfBeliefCalibrationSamples(agent: AgentHarnessState, playerById: Map<string, GameState["players"][number]>): CalibrationSample[] {
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

export function reputationThreatCalibrationSamples(agent: AgentHarnessState, playerById: Map<string, GameState["players"][number]>): CalibrationSample[] {
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

export function calibrationSubject(agent: AgentHarnessState): Record<string, unknown> {
  return {
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    policyName: agent.policyName
  };
}

export function calibrationEvidenceRefs(agent: AgentHarnessState, socialRefs: EvidenceRef[], stateDescription: string): HarnessMetricEvidenceRef[] {
  return uniqueEvidenceRefs([
    ...metricEvidenceFromSocialRefs(agent, socialRefs),
    agentStateEvidence(agent),
    stateEvidence(stateDescription, { id: agent.playerId })
  ]);
}

export function calibrationMetadata(samples: CalibrationSample[]): Record<string, unknown> {
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

export function agentStateEvidence(agent: AgentHarnessState): HarnessMetricEvidenceRef {
  return {
    artifact: "agent_state",
    id: agent.playerId,
    description: `socialStateHash:${agent.socialStateHash ?? "unknown"}`
  };
}

export function metricEvidenceFromSocialRefs(agent: AgentHarnessState, refs: EvidenceRef[]): HarnessMetricEvidenceRef[] {
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

export function summarizeWerewolfSocialCalibration(
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

export function summarizeDeceptionBeliefShift(metrics: HarnessMetricRecord[], agents: AgentHarnessState[]): DeceptionBeliefShiftEvaluation {
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

export function summarizeDeceptionReputationAssociation(metrics: HarnessMetricRecord[], agents: AgentHarnessState[]): DeceptionReputationAssociationEvaluation {
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
