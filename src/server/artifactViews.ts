import type { GameEvent, GameState, MatchMetrics } from "../core/types";
import { serializePublicState } from "../core/view";
import {
  type HarnessCheckpoint,
  type MatchArtifact,
  assertValidHarnessCheckpoint,
  assertValidMatchArtifactIntegrity
} from "../harness/artifacts";
import { sanitizePersistedProviderDiagnostics } from "../harness/providerFailure";
import { redactSecrets } from "../harness/redaction";
import { replayWerewolfSocialEpisode } from "../harness/replay";
import { type SocialExposureRecord, type SocialMessage, deriveSocialExposureRecords } from "../harness/social";
import type { EvidenceRef } from "../harness/socialState";
import {
  type MatchArtifactView,
  type MatchArtifactViewDto,
  type PostgameMatchProjectionDto,
  type PostgameReplayFrameDto,
  REDACTED_DELIVERY_POLICY,
  REDACTED_PRIVATE_OBSERVATION,
  REDACTED_PRIVATE_SOCIAL_OBSERVATION,
  REDACTED_SOCIAL_STEP_FAILURE,
  type RedactedAgentActionArbitrationSummaryDto,
  type RedactedAgentStateDto,
  type RedactedCommandDto,
  type RedactedHarnessStepDto,
  type RedactedPendingActionDto,
  type RedactedSocialEpisodeDto,
  type RedactedSocialMessageDraftDto,
  type RedactedSocialMessageDto,
  type RedactedSocialStepFailureDto,
  projectSocialNetwork
} from "./artifactProjection";
import { HttpError } from "./httpValidation";
import { isRecord } from "./jsonUtil";
import { projectWerewolfPostgameEventLedger } from "./werewolfReviewLedger";

/**
 * Per-artifact projection memo. Stored artifacts are immutable once written:
 * `saveMatch()` validates and stores a private clone, and every re-save or
 * disk recovery produces a NEW artifact object, so keying on object identity
 * is the invalidation. A tampered on-disk artifact is re-read into a fresh
 * object during recovery and therefore always re-validated here; the memo can
 * never mask disk tampering. Projections are deterministic (generatedAt is
 * pinned to epoch), and no API consumer mutates a projected DTO — responses
 * are serialized immediately and comparison/export builders are read-only.
 */
const matchProjectionCache = new WeakMap<MatchArtifact, Map<MatchArtifactView, MatchArtifactViewDto>>();

export function projectMatchArtifactForView(artifact: MatchArtifact, view: MatchArtifactView): MatchArtifactViewDto {
  let byView = matchProjectionCache.get(artifact);
  const cached = byView?.get(view);
  if (cached) return cached;
  // Stored artifacts are validated on write and recovery. Revalidate at this
  // projection boundary so a future store implementation cannot turn a
  // malformed canonical record into an API-visible partial truth. The memo
  // above only skips revalidation for the exact object that already passed.
  try {
    assertValidMatchArtifactIntegrity(artifact);
  } catch {
    throw new HttpError(409, "Stored match artifact failed integrity validation.", "artifact_integrity_invalid");
  }
  if (!byView) {
    byView = new Map();
    matchProjectionCache.set(artifact, byView);
  }
  const projected = computeMatchArtifactView(artifact, view, byView);
  byView.set(view, projected);
  return projected;
}

function computeMatchArtifactView(
  artifact: MatchArtifact,
  view: MatchArtifactView,
  byView: Map<MatchArtifactView, MatchArtifactViewDto>
): MatchArtifactViewDto {
  if (view === "full") return sanitizePersistedProviderDiagnostics(redactSecrets(artifact));
  let privateProjected = byView.get("postgame-redacted") as PostgameMatchProjectionDto | undefined;
  if (!privateProjected) {
    privateProjected = projectPostgameRedactedArtifact(artifact);
    byView.set("postgame-redacted", privateProjected);
  }
  if (view === "postgame-redacted") return privateProjected;
  return redactSecrets(projectTruthRedactedArtifact(privateProjected));
}

/**
 * Project a deterministic native prefix for the local postgame replay
 * cockpit. A prefix is not a MatchArtifact: it deliberately omits the parent
 * trajectory, agent snapshots, actions, observations, social topology, and
 * all evaluator/provider evidence.
 */
export function projectPostgameReplayFrame(prefix: {
  nativeStepCount: number;
  maxMessageSeq: number;
  step: { postStateHash?: string };
  episode: MatchArtifact["socialEpisode"];
  replay: ReturnType<typeof replayWerewolfSocialEpisode>;
}): PostgameReplayFrameDto {
  const state = redactStatePrivateEvents(prefix.replay.finalState);
  const eventCount = Array.isArray(state.events) ? state.events.length : 0;
  const werewolfReviewLedger = projectWerewolfPostgameEventLedger({
    // A replay frame can describe only its recorded native prefix. The parent
    // final artifact is deliberately not consulted here.
    events: prefix.replay.finalState.events,
    episode: prefix.episode,
    view: "postgame-redacted",
    authority: "native-social-episode"
  });
  return {
    artifactVersion: "server.match-replay-frame.v1",
    kind: "match-replay-frame",
    authority: "native-social-episode",
    source: "server-owned-match-artifact",
    cursor: {
      nativeStepCount: prefix.nativeStepCount,
      messageCount: prefix.episode.messages.length,
      eventCount,
      stateHash: prefix.replay.finalHash,
      recordedPostStateHash: prefix.step.postStateHash
    },
    projection: {
      view: "postgame-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: false,
      generatedAt: new Date(0).toISOString()
    },
    state,
    werewolfReviewLedger,
    replay: {
      ok: true,
      replayedSteps: prefix.replay.replayedSteps,
      replayedBatches: prefix.replay.replayedBatches,
      rejectedSteps: prefix.replay.rejectedSteps
    }
  };
}

/**
 * A checkpoint is execution authority for a future fork, but its raw state and
 * prefix contain the same private observations, role truth, and model evidence
 * as a match artifact. The API therefore projects it before serialization;
 * fork execution continues to read the canonical checkpoint from the store.
 */
export function projectHarnessCheckpointForView(
  checkpoint: HarnessCheckpoint,
  view: MatchArtifactView
): HarnessCheckpoint | Record<string, unknown> {
  try {
    assertValidHarnessCheckpoint(checkpoint);
  } catch {
    throw new HttpError(409, "Stored checkpoint failed integrity validation.", "checkpoint_integrity_invalid");
  }
  if (view === "full") return sanitizePersistedProviderDiagnostics(redactSecrets(checkpoint));

  const source = cloneJson(checkpoint);
  const privateState = redactStatePrivateEvents(source.state);
  const privateAgents = source.agents.map((agent) => redactAgentPrivateEvidence(agent));
  const privatePrefix = redactSocialEpisodePrivateEvidence(
    source.executionPrefix as MatchArtifact["socialEpisode"]
  );
  const privateProjection = {
    ...source,
    source: {
      ...source.source,
      failureReason: source.source.failureReason ? "[REDACTED checkpoint failure detail]" : undefined
    },
    state: privateState,
    agents: privateAgents,
    executionPrefix: privatePrefix,
    projection: {
      view,
      privateEvidenceRedacted: true,
      postgameTruthRedacted: view === "truth-redacted",
      generatedAt: new Date(0).toISOString()
    }
  };
  if (view === "postgame-redacted") return redactSecrets(privateProjection);

  const truthExecutionPrefix = redactSocialTopologyForTruthView({
    ...privatePrefix,
    initialState: redactPostgameTruthFromState(privatePrefix.initialState as GameState),
    finalState: redactPostgameTruthFromState(privatePrefix.finalState as GameState)
  });
  return redactSecrets({
    artifactVersion: source.artifactVersion,
    kind: source.kind,
    checkpointId: source.checkpointId,
    createdAt: source.createdAt,
    source: redactHarnessCheckpointSourceForTruthView(source.source),
    state: redactPostgameTruthFromState(privateState),
    // Agent snapshots and native steps are fork authority, not public game
    // observations. Keeping them would expose role-specific scheduling and
    // policy identity even after role/team fields have been removed.
    agents: [],
    executionPrefix: truthExecutionPrefix,
    projection: {
      view: "truth-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true,
      generatedAt: new Date(0).toISOString()
    }
  });
}

export function projectPostgameRedactedArtifact(artifact: MatchArtifact): PostgameMatchProjectionDto {
  const exposureRecords = projectSocialExposureRecords(deriveSocialExposureRecords(artifact.socialEpisode));
  const exposureSummary = summarizeProjectedSocialExposureRecords(exposureRecords);
  const source = cloneJson(artifact);
  const socialEpisode: RedactedSocialEpisodeDto = {
    ...redactSocialEpisodePrivateEvidence(source.socialEpisode),
    exposureRecords,
    exposureSummary
  };
  const werewolfReviewLedger = projectWerewolfPostgameEventLedger({
    events: artifact.finalState.events,
    episode: artifact.socialEpisode,
    view: "postgame-redacted",
    authority: "server-owned-match-artifact"
  });
  const projection: PostgameMatchProjectionDto["projection"] = {
    view: "postgame-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: false,
    generatedAt: new Date(0).toISOString()
  };
  const agents = source.agents.map(redactAgentPrivateEvidence);
  return {
    ...source,
    failureReason: source.failureReason ? "[REDACTED harness failure detail]" : undefined,
    projection,
    trajectory: source.trajectory.map(redactHarnessStepPrivateEvidence),
    socialEpisode,
    initialState: redactStatePrivateEvents(source.initialState),
    finalState: redactStatePrivateEvents(source.finalState),
    events: redactGameEventsPrivateEvidence(source.events),
    evaluation: {
      ...source.evaluation,
      trajectory: source.evaluation.trajectory.map((step) => ({
        ...step,
        intent: "[REDACTED private evaluation intent]",
        targetId: undefined
      }))
    },
    agents,
    agentSnapshotFrames: source.agentSnapshotFrames?.map((frame) => ({
      ...frame,
      agents: frame.agents.map(redactAgentPrivateEvidence)
    })),
    socialNetwork: projectSocialNetwork({ projection, agents, socialEpisode }),
    werewolfReviewLedger
  };
}

export function projectTruthRedactedArtifact(artifact: PostgameMatchProjectionDto): PostgameMatchProjectionDto {
  // No defensive clone here: every field consumed below is either an immutable
  // scalar or re-cloned/rebuilt (redactPostgameTruthFromState, cloneJson,
  // mapped projections), so the output never aliases the input DTO.
  const source = artifact;
  const initialState = redactPostgameTruthFromState(source.initialState);
  const finalState = redactPostgameTruthFromState(source.finalState);
  const werewolfReviewLedger = projectWerewolfPostgameEventLedger({
    // The strict public state is already the truth-redacted domain boundary.
    // Never pass native execution rows here: scheduler cadence is private.
    events: ((finalState as unknown as { events?: GameEvent[] }).events ?? []),
    view: "truth-redacted",
    authority: "server-owned-match-artifact"
  });
  const socialEpisode = redactSocialTopologyForTruthView({
    ...source.socialEpisode,
    initialState: redactPostgameTruthFromState(source.socialEpisode.initialState as MatchArtifact["finalState"]) as RedactedSocialEpisodeDto["initialState"],
    finalState: redactPostgameTruthFromState(source.socialEpisode.finalState as MatchArtifact["finalState"]) as RedactedSocialEpisodeDto["finalState"]
  });
  const projection: PostgameMatchProjectionDto["projection"] = {
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true,
    generatedAt: new Date(0).toISOString()
  };
  // This is a public observation DTO, not a replay/fork record.  Omit ids and
  // deterministic seeds rather than replacing them with stable aliases: the
  // current Werewolf run ids are derived from the seed and can reconstruct a
  // hidden role assignment.
  return {
    artifactVersion: source.artifactVersion,
    kind: source.kind,
    createdAt: source.createdAt,
    config: cloneJson(source.config),
    models: [],
    profiles: [],
    resolvedAssignments: redactTruthResolvedAssignments(source.resolvedAssignments),
    status: source.status,
    truncationReason: undefined,
    failureReason: undefined,
    failureStateHash: undefined,
    initialState,
    finalState,
    // Policy/trace trajectories contain private action kinds and model-backed
    // agent state. Public messages and domain events below are the allowed
    // public record instead.
    trajectory: [],
    socialEpisode,
    events: cloneJson((finalState as unknown as { events?: GameEvent[] }).events ?? []),
    // Evaluation/reward records are derived from canonical postgame truth.
    // They are intentionally absent from a public in-progress observation.
    evaluation: {} as MatchArtifact["evaluation"],
    evaluationReport: {} as MatchArtifact["evaluationReport"],
    metrics: {} as MatchArtifact["metrics"],
    agents: [],
    agentSnapshotFrames: undefined,
    socialNetwork: projectSocialNetwork({ projection, agents: [], socialEpisode }),
    werewolfReviewLedger,
    projection
  } as unknown as PostgameMatchProjectionDto;
}

/**
 * A public tournament pack does not reuse the broad MatchArtifact DTO.  This
 * is a domain-owned observation record with table-seat identities only; it
 * has no canonical run identity, assignment, execution trace, evaluator
 * result, channel topology, or provider evidence.
 */
export function projectPublicTournamentMatchArtifact(artifact: MatchArtifact, episodeIndex: number): Record<string, unknown> {
  const projected = projectMatchArtifactForView(artifact, "truth-redacted") as PostgameMatchProjectionDto;
  const finalState = projected.finalState as unknown as {
    phase?: string;
    day?: number;
    players?: Array<{
      id?: string;
      seat?: number;
      name?: string;
      alive?: boolean;
      isSheriff?: boolean;
      eliminatedAt?: { day?: number; reason?: string };
    }>;
    currentSpeakerSeat?: number;
    pendingActionCount?: number;
    publicEventCount?: number;
  };
  const seatByPlayerId = new Map<string, number>();
  for (const player of finalState.players ?? []) {
    if (typeof player.id === "string" && typeof player.seat === "number") {
      seatByPlayerId.set(player.id, player.seat);
    }
  }
  const socialEpisode = projected.socialEpisode as unknown as {
    messages?: Array<{ seq?: number; senderId?: string; content?: string }>;
  };
  return {
    artifactVersion: "harness.match.public.v1",
    kind: "public-match",
    episodeIndex,
    status: projected.status,
    state: {
      phase: finalState.phase ?? "unknown",
      day: finalState.day ?? 0,
      players: (finalState.players ?? [])
        .filter((player) => typeof player.seat === "number" && typeof player.alive === "boolean")
        .map((player) => ({
          seat: player.seat as number,
          name: player.name ?? `Seat ${player.seat as number}`,
          alive: player.alive as boolean,
          isSheriff: Boolean(player.isSheriff),
          ...(player.eliminatedAt
            ? {
                eliminatedAt: {
                  day: player.eliminatedAt.day,
                  reason: player.eliminatedAt.reason
                }
              }
            : {})
        }))
        .sort((left, right) => left.seat - right.seat),
      ...(typeof finalState.currentSpeakerSeat === "number" ? { currentSpeakerSeat: finalState.currentSpeakerSeat } : {}),
      pendingActionCount: finalState.pendingActionCount ?? 0,
      publicEventCount: finalState.publicEventCount ?? 0
    },
    events: (projected.events ?? []).map((event) => ({
      seq: event.seq,
      day: event.day,
      type: event.type
    })),
    messages: (socialEpisode.messages ?? [])
      .filter((message) => typeof message.seq === "number" && typeof message.content === "string")
      .map((message) => ({
        seq: message.seq,
        senderSeat: message.senderId ? seatByPlayerId.get(message.senderId) ?? null : null,
        content: message.content
      }))
  };
}

/**
 * A truth-redacted artifact is suitable for an untrusted/public reader.  It
 * must not retain a private or team communication topology, because channel
 * membership and delivery metadata can reveal hidden factions even after role
 * fields have been removed from game state.
 */
export function redactSocialTopologyForTruthView(episode: RedactedSocialEpisodeDto): RedactedSocialEpisodeDto {
  const publicChannels = episode.channels
    .filter((channel) => channel.kind === "public" && channel.readableBy === "all")
    .map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      readableBy: channel.readableBy
    })) as unknown as RedactedSocialEpisodeDto["channels"];
  const publicChannelIds = new Set(publicChannels.map((channel) => channel.id));
  const isPublicMessage = (message: Pick<SocialMessage, "channelId" | "visibility">): boolean =>
    message.visibility === "public" && publicChannelIds.has(message.channelId);
  const canonicalInitialMessageCount = Math.min(
    Math.max(episode.execution?.initialMessageCount ?? 0, 0),
    episode.messages.length
  );
  const initialPublicMessageIds = new Set(
    episode.messages
      .slice(0, canonicalInitialMessageCount)
      .filter(isPublicMessage)
      .map((message) => message.id)
  );
  const messages = episode.messages
    .filter(isPublicMessage)
    .map(redactPublicSocialMessageForTruthView);
  const exposureRecords: SocialExposureRecord[] = [];

  return {
    domainId: episode.domainId,
    status: episode.status,
    execution: episode.execution
      ? {
          schemaVersion: episode.execution.schemaVersion,
          started: episode.execution.started,
          initialMessageCount: messages.filter((message) => initialPublicMessageIds.has(message.id)).length,
          reasonerExecutionClass: episode.execution.reasonerExecutionClass
        }
      : undefined,
    schedulerMode: episode.schedulerMode,
    // Profiles can carry role-derived policy ids. They are not public game
    // observations, unlike the public channel/messages preserved below.
    profiles: [],
    channels: publicChannels,
    initialState: cloneJson(episode.initialState),
    finalState: cloneJson(episode.finalState),
    // A native step is private execution evidence. Even a redacted action
    // kind/actor pair identifies special roles in a hidden-information game.
    steps: [],
    messages,
    exposureRecords,
    exposureSummary: summarizeProjectedSocialExposureRecords(exposureRecords)
  } as unknown as RedactedSocialEpisodeDto;
}

export function redactPublicSocialMessageForTruthView(message: RedactedSocialMessageDto): RedactedSocialMessageDto {
  return {
    id: message.id,
    seq: message.seq,
    channelId: message.channelId,
    senderId: message.senderId,
    // A public channel is already the complete audience declaration. Avoid
    // retaining per-message routing fields that a future domain may use for a
    // narrower observer subset.
    recipientIds: [],
    visibility: "public",
    content: message.content,
    speechActs: message.speechActs?.map((act) => ({
      id: act.id,
      kind: act.kind,
      subjectId: act.subjectId,
      targetId: act.targetId,
      value: cloneJson(act.value),
      confidence: act.confidence,
      evidenceRefs: []
    })),
    createdAt: message.createdAt
  };
}

export function redactHarnessCheckpointSourceForTruthView(source: HarnessCheckpoint["source"]): Record<string, unknown> {
  return {
    sourceArtifactVersion: source.sourceArtifactVersion,
    runId: source.runId,
    matchId: source.matchId,
    rulesetId: source.rulesetId,
    status: source.status
  };
}

export function redactTruthResolvedAssignments(
  assignments: MatchArtifact["resolvedAssignments"]
): MatchArtifact["resolvedAssignments"] {
  return assignments.map(({ playerId, seat }) => ({ playerId, seat })) as MatchArtifact["resolvedAssignments"];
}

export function redactPostgameTruthFromState(state: MatchArtifact["finalState"]): MatchArtifact["finalState"] {
  const publicState = serializePublicState(cloneJson(state));
  const publicObservation: Record<string, unknown> = { ...publicState };
  for (const key of ["id", "seed", "night", "winner", "endReason"]) {
    delete publicObservation[key];
  }
  return {
    ...publicObservation,
    // `serializePublicState()` is the domain's public-state boundary. The
    // truth artifact is intentionally stricter still: it does not publish
    // postgame winner/end truth or role reveals, even if a game config would
    // reveal a role to seated players after death.
    players: publicState.players.map(({ revealedRole: _revealedRole, ...player }) => player),
    events: redactPostgameTruthFromEvents(publicState.events),
  } as unknown as MatchArtifact["finalState"];
}

export function redactPostgameTruthFromEvents(events: GameEvent[]): GameEvent[] {
  return events
    .filter((event) => event.visibility === "public")
    .map((event) => {
      const cloned = cloneJson(event);
      if (!isRecord(cloned.payload)) return cloned;
      const payload = { ...cloned.payload };
      for (const key of [
        "role",
        "team",
        "resultTeam",
        "winner",
        "sourceId",
        "seerInspection",
        "wolfVotes",
        "witch",
        "ability",
        "trueRole",
        "actualRole"
      ]) {
        delete payload[key];
      }
      if (Array.isArray(payload.deaths)) {
        payload.deaths = payload.deaths.map((death) => {
          if (!isRecord(death)) return death;
          const nextDeath = { ...death };
          delete nextDeath.sourceId;
          delete nextDeath.role;
          delete nextDeath.team;
          return nextDeath;
        });
      }
      return {
        ...cloned,
        payload
      };
    });
}

export function redactPostgameTruthFromEvaluation(evaluation: MatchArtifact["evaluation"]): MatchArtifact["evaluation"] {
  // Evaluation is computed from canonical final truth. Per-agent reward and
  // metric structures are therefore postgame evidence, not an observation a
  // public reader may receive while the game remains hidden-information.
  return {
    winner: undefined,
    teamRewards: {
      village: 0,
      werewolves: 0
    },
    agentRewards: [],
    voteAccuracyByAgent: {},
    influenceByAgent: {},
    deceptionByAgent: {},
    trajectory: []
  };
}

export function redactPostgameTruthFromEvaluationReport(
  report: MatchArtifact["evaluationReport"]
): MatchArtifact["evaluationReport"] {
  return {
    id: report.id,
    createdAt: report.createdAt,
    evaluatorIds: [],
    evaluatorRegistry: [],
    metricCount: 0,
    metrics: [],
    outputs: {},
    warnings: [],
    summary: {
      teamScores: {},
      agentScores: {},
      profileScores: {},
      modelScores: {},
      // Catalog ids and metric ids can encode role-specific evaluator names.
      // The truth view exposes no evaluation results, so retain only a stable
      // non-authoritative placeholder that keeps the cockpit DTO shape intact.
      promotion: {
        policyId: "public-redacted",
        policyVersion: "1",
        policyHash: "public-redacted",
        catalogId: "public-redacted",
        catalogVersion: "1",
        catalogHash: "public-redacted",
        catalogDomainId: "public",
        catalogEntryCount: 0,
        catalogRuleCount: 0,
        catalogRuleIds: [],
        catalogScorecardMetricIds: [],
        catalogDiagnosticMetricIds: [],
        catalogBenchmarkOnlyMetricIds: [],
        scorecardMetricCount: 0,
        diagnosticMetricCount: 0,
        weightedMetricCount: 0,
        excludedWeightedMetricCount: 0,
        excludedWeightedMetricIds: [],
        scorecardRequiresEvidence: true,
        scorecardRequiresPositiveWeight: true,
        uncatalogedMetricPolicy: "legacy_conservative_diagnostic",
        decisionStorage: "per_metric_recorded"
      }
    }
  };
}

export function redactPostgameTruthFromMetrics(metrics: MatchMetrics): MatchMetrics {
  return {
    winner: undefined,
    days: metrics.days,
    totalDeaths: metrics.totalDeaths,
    totalSpeeches: metrics.totalSpeeches,
    totalVotes: metrics.totalVotes,
    harnessTurnCount: 0,
    harnessErrorCount: 0,
    averageLatencyMs: 0,
    wolfVoteAccuracy: 0,
    villageVoteAccuracy: 0,
    deceptionSurvivalScore: 0,
    modelUsage: {}
  };
}

export function redactPostgameTruthFromAgent(agent: RedactedAgentStateDto): RedactedAgentStateDto {
  const next = cloneJson(agent);
  if (next.social?.beliefs?.claims) {
    next.social.beliefs.claims = Object.fromEntries(
      Object.entries(next.social.beliefs.claims).map(([id, claim]) => {
        if (!isRecord(claim)) return [id, claim];
        const claimRecord: Record<string, unknown> = { ...claim };
        delete claimRecord.actualRole;
        delete claimRecord.trueRole;
        delete claimRecord.resultTeam;
        if (claimRecord.predicate === "role" || claimRecord.predicate === "team") {
          claimRecord.value = "[REDACTED postgame claim value]";
        }
        return [id, claimRecord as typeof claim];
      })
    );
  }
  return next;
}

export function projectSocialExposureRecords(records: SocialExposureRecord[]): SocialExposureRecord[] {
  return records.map((record) => ({
    messageId: record.messageId,
    messageSeq: record.messageSeq,
    sourceId: record.sourceId,
    observerId: record.observerId,
    observedAtTraceId: record.observedAtTraceId,
    observedAtTurnIndex: record.observedAtTurnIndex,
    observedAtActionKind: record.observedAtActionKind,
    channelId: record.channelId,
    visibility: record.visibility,
    kind: sanitizeSocialExposureKind(record.kind),
    evidenceRefs: record.evidenceRefs.map((ref) => ({
      artifact: ref.artifact,
      id: ref.id,
      seq: ref.seq,
      traceId: ref.traceId
    }))
  }));
}

export function summarizeProjectedSocialExposureRecords(records: SocialExposureRecord[]): NonNullable<RedactedSocialEpisodeDto["exposureSummary"]> {
  const byVisibility: Record<SocialMessage["visibility"], number> = {
    private: 0,
    team: 0,
    public: 0,
    postgame: 0
  };
  for (const record of records) {
    byVisibility[record.visibility] += 1;
  }
  return {
    schemaVersion: "server.social-exposure-summary.v1",
    source: "scoped_observation",
    privateEvidenceRedacted: true,
    recordCount: records.length,
    messageCount: new Set(records.map((record) => record.messageId)).size,
    sourceCount: new Set(records.map((record) => record.sourceId)).size,
    observerCount: new Set(records.map((record) => record.observerId)).size,
    byVisibility
  };
}

export function sanitizeSocialExposureKind(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(kind) ? kind : undefined;
}

export function redactHarnessStepPrivateEvidence(step: MatchArtifact["trajectory"][number]): RedactedHarnessStepDto {
  return {
    ...step,
    pendingAction: redactPendingAction(step.pendingAction),
    observation: REDACTED_PRIVATE_OBSERVATION,
    policyPlan: {
      policyName: step.policyPlan.policyName,
      intent: "[REDACTED private policy intent]",
      confidence: step.policyPlan.confidence,
      strategyTags: [...step.policyPlan.strategyTags],
      claimedRole: step.policyPlan.claimedRole,
      command: redactCommandPayload(step.policyPlan.command)
    },
    reasonerOutput: redactReasonerOutput(step.reasonerOutput),
    command: redactCommandPayload(step.command),
    turnTrace: {
      traceId: step.turnTrace.traceId,
      playerId: step.turnTrace.playerId,
      profileId: step.turnTrace.profileId,
      model: step.turnTrace.model,
      actionKind: step.turnTrace.actionKind,
      policyName: step.turnTrace.policyName,
      commandType: step.turnTrace.commandType,
      intent: "[REDACTED private turn intent]",
      confidence: step.turnTrace.confidence,
      strategyTags: [...step.turnTrace.strategyTags],
      beliefs: {},
      privateMemo: "[REDACTED private memo]",
      publicSpeech: step.turnTrace.publicSpeech ? "[REDACTED generated speech]" : undefined,
      cognitionSource: redactCognitionSource(step.turnTrace.cognitionSource),
      latencyMs: step.turnTrace.latencyMs,
      promptTokens: step.turnTrace.promptTokens,
      completionTokens: step.turnTrace.completionTokens,
      attempts: step.turnTrace.attempts,
      agentStateHash: step.turnTrace.agentStateHash
    },
    actionArbitration: redactActionArbitrationPrivateEvidence(step.actionArbitration),
    agentSnapshotsAfterStep: undefined
  };
}

export function redactActionArbitrationPrivateEvidence(
  arbitration: MatchArtifact["trajectory"][number]["actionArbitration"]
): RedactedAgentActionArbitrationSummaryDto | undefined {
  if (!arbitration) return undefined;
  const selectedCandidateOrdinal = arbitration.candidates.findIndex(
    (candidate) => candidate.id === arbitration.selectedCandidateId
  );
  const candidates = arbitration.candidates.map((candidate, ordinal) => ({
    ordinal,
    source: safeArbitrationCandidateSource(candidate.source),
    kind: safeMetadataString(candidate.kind) ?? "unknown",
    selected: ordinal === selectedCandidateOrdinal,
    baseScore: safeMetadataNumber(candidate.baseScore),
    utilityScore: safeMetadataNumber(candidate.utilityScore),
    socialScore: safeMetadataNumber(candidate.socialScore),
    riskPenalty: safeMetadataNumber(candidate.riskPenalty),
    legalityScore: safeMetadataNumber(candidate.legalityScore),
    finalScore: safeMetadataNumber(candidate.finalScore),
    scoreContributionCount: candidate.scoreContributions?.length ?? 0,
    evidenceCount: candidate.evidenceRefs.length,
    messageCount: candidate.messageCount
  }));
  return {
    version: arbitration.version,
    arbitrator: arbitration.arbitratorId === "default-score-arbitrator" ? "default-score-arbitrator" : "custom",
    candidateCount: candidates.length,
    decisionRule:
      arbitration.decisionRule === "highest_final_score_then_candidate_id"
        ? "highest_final_score_then_candidate_id"
        : "custom",
    selectedCandidateOrdinal: selectedCandidateOrdinal >= 0 ? selectedCandidateOrdinal : undefined,
    selectedCandidateSource:
      selectedCandidateOrdinal >= 0 ? candidates[selectedCandidateOrdinal]?.source : undefined,
    candidates
  };
}

export function safeArbitrationCandidateSource(value: string): string {
  return [
    "policy",
    "reasoner",
    "memory",
    "belief",
    "relationship",
    "reputation",
    "norm",
    "goal",
    "social_state"
  ].includes(value)
    ? value
    : "other";
}

export function redactReasonerOutput(value: MatchArtifact["trajectory"][number]["reasonerOutput"]): RedactedHarnessStepDto["reasonerOutput"] {
  const cognitionSource = redactCognitionSource(value.cognitionSource);
  return {
    content: cognitionSource === "policy" ? "[REDACTED deterministic policy memo]" : "[REDACTED model reasoning output]",
    cognitionSource,
    latencyMs: value.latencyMs,
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    attempts: value.attempts
  };
}

/**
 * Cognition provenance is a closed, non-content-bearing control-plane fact.
 * Retaining it in local postgame review prevents a deterministic policy turn
 * from being misrepresented as a provider/model invocation. Historical
 * records without the field retain their legacy reasoner-backed meaning.
 */
export function redactCognitionSource(value: unknown): "reasoner" | "policy" {
  return value === "policy" ? "policy" : "reasoner";
}

export function redactPendingAction(action: unknown): RedactedPendingActionDto {
  const record = isRecord(action) ? action : {};
  return {
    kind: safeMetadataString(record.kind) ?? "unknown",
    actorId: safeMetadataString(record.actorId),
    phase: safeMetadataString(record.phase),
    redacted: true
  };
}

export function redactCommandPayload(command: unknown): RedactedCommandDto {
  const record = isRecord(command) ? command : {};
  return {
    type: safeMetadataString(record.type) ?? "unknown",
    actorId: safeMetadataString(record.actorId),
    redacted: true
  };
}

export function redactSocialEpisodePrivateEvidence(episode: MatchArtifact["socialEpisode"]): RedactedSocialEpisodeDto {
  return {
    ...episode,
    assignmentResolution: undefined,
    failureReason: episode.failureReason ? "[REDACTED social episode failure detail]" : undefined,
    error: episode.error ? "[REDACTED social episode error]" : undefined,
    initialState: redactStatePrivateEvents(episode.initialState),
    finalState: redactStatePrivateEvents(episode.finalState),
    steps: episode.steps.map((step) => ({
      ...step,
      pendingAction: redactPendingAction(step.pendingAction),
      observation: REDACTED_PRIVATE_SOCIAL_OBSERVATION,
      action: {
        ...step.action,
        command: redactCommandPayload(step.action.command),
        messages: step.action.messages?.map(redactSocialMessageDraftPrivateEvidence),
        metadata: redactSocialActionMetadata(step.action.metadata)
      },
      failure: redactSocialStepFailure(step.failure),
      error: step.error ? "[REDACTED social step error]" : undefined,
      actorSnapshotsAfterStep: undefined,
      infosByAgent: undefined
    })),
    messages: episode.messages.map(redactSocialMessagePrivateEvidence)
  };
}

export function redactSocialMessagePrivateEvidence(message: SocialMessage): RedactedSocialMessageDto {
  return {
    ...message,
    content: message.visibility === "public" ? message.content : "[REDACTED private social message]",
    speechActs: redactSocialSpeechActs(message.speechActs, message.visibility),
    metadata: redactSocialMessageMetadata(message.metadata, message.visibility),
    deliveryReceipts: message.deliveryReceipts?.map((receipt) => ({
      ...receipt,
      redactionPolicy: REDACTED_DELIVERY_POLICY
    }))
  };
}

export function redactSocialMessageDraftPrivateEvidence(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">
): RedactedSocialMessageDraftDto {
  return {
    ...message,
    content: message.visibility === "public" ? message.content : "[REDACTED private social message]",
    speechActs: redactSocialSpeechActs(message.speechActs, message.visibility),
    metadata: redactSocialMessageMetadata(message.metadata, message.visibility),
    deliveryReceipts: message.deliveryReceipts?.map((receipt) => ({
      ...receipt,
      redactionPolicy: REDACTED_DELIVERY_POLICY
    }))
  };
}

export function redactSocialSpeechActs(
  speechActs: SocialMessage["speechActs"],
  visibility: SocialMessage["visibility"]
): RedactedSocialMessageDto["speechActs"] {
  if (visibility !== "public") return undefined;
  return speechActs?.map((act) => ({
    id: act.id,
    kind: act.kind,
    subjectId: act.subjectId,
    targetId: act.targetId,
    value: cloneJson(act.value),
    confidence: act.confidence,
    evidenceRefs: act.evidenceRefs.map((ref) => ({
      artifact: ref.artifact,
      id: ref.id,
      seq: ref.seq,
      traceId: ref.traceId
    }))
  }));
}

export function redactSocialActionMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const trace = isRecord(value.turnTrace) ? value.turnTrace : undefined;
  const reasoner = isRecord(value.reasonerOutput) ? value.reasonerOutput : undefined;
  const policy = isRecord(value.policyPlan) ? value.policyPlan : undefined;
  return compactRecord({
    kind: safeMetadataString(value.kind),
    turnIndex: safeMetadataNumber(value.turnIndex),
    agentStateHash: safeMetadataString(value.agentStateHash),
    policyPlan: policy
      ? compactRecord({
          policyName: safeMetadataString(policy.policyName),
          intent: "[REDACTED private policy intent]",
          confidence: safeMetadataNumber(policy.confidence),
          strategyTags: safeMetadataStringArray(policy.strategyTags),
          command: isRecord(policy.command)
            ? redactCommandPayload(policy.command)
            : undefined
        })
      : undefined,
    reasonerOutput: reasoner
      ? redactReasonerMetadata(reasoner)
      : undefined,
    turnTrace: trace
      ? compactRecord({
          traceId: safeMetadataString(trace.traceId),
          playerId: safeMetadataString(trace.playerId),
          profileId: safeMetadataString(trace.profileId),
          model: safeMetadataString(trace.model),
          actionKind: safeMetadataString(trace.actionKind),
          policyName: safeMetadataString(trace.policyName),
          commandType: safeMetadataString(trace.commandType),
          intent: "[REDACTED private turn intent]",
          confidence: safeMetadataNumber(trace.confidence),
          strategyTags: safeMetadataStringArray(trace.strategyTags),
          beliefs: {},
          privateMemo: "[REDACTED private memo]",
          publicSpeech: trace.publicSpeech ? "[REDACTED generated speech]" : undefined,
          cognitionSource: redactCognitionSource(trace.cognitionSource),
          latencyMs: safeMetadataNumber(trace.latencyMs),
          promptTokens: safeMetadataNumber(trace.promptTokens),
          completionTokens: safeMetadataNumber(trace.completionTokens),
          attempts: safeMetadataNumber(trace.attempts),
          agentStateHash: safeMetadataString(trace.agentStateHash)
        })
      : undefined
  });
}

export function redactReasonerMetadata(reasoner: Record<string, unknown>): Record<string, unknown> {
  const cognitionSource = redactCognitionSource(reasoner.cognitionSource);
  return compactRecord({
    content: cognitionSource === "policy" ? "[REDACTED deterministic policy memo]" : "[REDACTED model reasoning output]",
    cognitionSource,
    latencyMs: safeMetadataNumber(reasoner.latencyMs),
    promptTokens: safeMetadataNumber(reasoner.promptTokens),
    completionTokens: safeMetadataNumber(reasoner.completionTokens),
    attempts: safeMetadataNumber(reasoner.attempts)
  });
}

export function redactSocialStepFailure(
  value: MatchArtifact["socialEpisode"]["steps"][number]["failure"]
): RedactedSocialStepFailureDto | undefined {
  if (!value) return undefined;
  return {
    stage: value.stage,
    message: REDACTED_SOCIAL_STEP_FAILURE,
    causeName: safeCauseName(value.causeName),
    metadata: undefined
  };
}

export function safeCauseName(value: string | undefined): string | undefined {
  return value && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : undefined;
}

export function redactSocialMessageMetadata(
  value: Record<string, unknown> | undefined,
  visibility: SocialMessage["visibility"]
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return compactRecord({
    kind: safeMetadataString(value.kind),
    traceId: safeMetadataString(value.traceId),
    turnIndex: safeMetadataNumber(value.turnIndex),
    actionKind: safeMetadataString(value.actionKind),
    phase: safeMetadataString(value.phase),
    day: safeMetadataNumber(value.day),
    redacted: visibility === "public" ? undefined : true
  });
}

export function safeMetadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

export function safeMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function safeMetadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length <= 100)) return undefined;
  return value.slice(0, 50);
}

export function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function redactStatePrivateEvents<TState>(state: TState): TState {
  if (!isRecord(state) || !Array.isArray(state.events)) return state;
  return {
    ...state,
    events: redactGameEventsPrivateEvidence(state.events as GameEvent[])
  };
}

export function redactGameEventsPrivateEvidence(events: GameEvent[]): GameEvent[] {
  return events.map((event) => cloneJson(event));
}

export function redactAgentPrivateEvidence(agent: MatchArtifact["agents"][number]): RedactedAgentStateDto {
  // Every caller passes agents from an already projection-private clone
  // (see projectPostgameRedactedArtifact / projectHarnessCheckpointForView),
  // so cloning again here only doubled the most expensive part of the DTO.
  const source = agent;
  return {
    ...source,
    beliefs: {},
    privateMemos: source.privateMemos.map(() => "[REDACTED private memo]"),
    lastIntent: source.lastIntent ? "[REDACTED private intent]" : undefined,
    social: source.social ? redactAgentSocialStatePrivateEvidence(source.social) : undefined
  };
}

export function redactAgentSocialStatePrivateEvidence(
  social: NonNullable<MatchArtifact["agents"][number]["social"]>
): NonNullable<RedactedAgentStateDto["social"]> {
  // Reached only through redactAgentPrivateEvidence, whose input is already a
  // projection-private clone; every emitted field is rebuilt or overridden.
  const source = social;
  return {
    agentId: source.agentId,
    profile: {
      id: source.profile.id,
      model: source.profile.model,
      temperature: source.profile.temperature,
      policyId: source.profile.policyId
    },
    messageIngestion: source.messageIngestion
      ? {
          ...source.messageIngestion,
          seenMessageIds: []
        }
      : undefined,
    memory: {
      ...source.memory,
      entries: source.memory.entries.map((entry) => ({
        seq: entry.seq,
        kind: entry.kind,
        source: entry.source,
        visibility: entry.visibility,
        content: entry.content ? "[REDACTED private memory]" : undefined,
        salience: entry.salience,
        importance: entry.importance,
        evidenceRefs: redactEvidenceRefs(entry.evidenceRefs),
        tags: [],
        createdAt: entry.createdAt
      }))
    },
    beliefs: {
      claims: Object.fromEntries(
        Object.entries(source.beliefs.claims).map(([id, claim]) => [
          id,
          {
            id: claim.id,
            subject: "[REDACTED private belief subject]",
            predicate: "[REDACTED private belief predicate]",
            value: "[REDACTED private belief value]",
            confidence: claim.confidence,
            evidenceRefs: redactEvidenceRefs(claim.evidenceRefs),
            contradictions: [],
            updatedAt: claim.updatedAt
          }
        ])
      )
    },
    relationships: {
      edges: Object.fromEntries(
        Object.entries(source.relationships.edges).map(([id, edge]) => [
          id,
          {
            targetId: edge.targetId,
            trust: edge.trust,
            suspicion: edge.suspicion,
            affinity: edge.affinity,
            influence: edge.influence,
            debt: edge.debt,
            respect: edge.respect,
            threat: edge.threat,
            evidenceRefs: redactEvidenceRefs(edge.evidenceRefs),
            updatedAt: edge.updatedAt
          }
        ])
      )
    },
    norms: {
      norms: {}
    },
    reputation: {
      records: Object.fromEntries(
        Object.entries(source.reputation.records).map(([id, record]) => [
          id,
          {
            subjectId: record.subjectId,
            honesty: record.honesty,
            competence: record.competence,
            cooperation: record.cooperation,
            threat: record.threat,
            normCompliance: record.normCompliance,
            evidenceRefs: redactEvidenceRefs(record.evidenceRefs),
            updatedAt: record.updatedAt
          }
        ])
      )
    },
    goals: {
      goals: []
    },
    lastPlan: source.lastPlan === undefined ? undefined : "[REDACTED private plan]",
    journal: source.journal
      ? {
          ...source.journal,
          entries: source.journal.entries.map((entry) => ({
            journalSeq: entry.journalSeq,
            agentId: entry.agentId,
            profileId: entry.profileId,
            traceId: entry.traceId,
            turnIndex: entry.turnIndex,
            phase: entry.phase,
            day: entry.day,
            store: entry.store,
            mutationKind: entry.mutationKind,
            subjectId: entry.subjectId,
            evidenceRefs: redactEvidenceRefs(entry.evidenceRefs),
            messageSeqRange: entry.messageSeqRange,
            eventSeqRange: entry.eventSeqRange,
            redactionClass: entry.redactionClass,
            hiddenTruthUsed: entry.hiddenTruthUsed,
            createdAt: entry.createdAt
          }))
        }
      : undefined
  };
}

export function redactEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  return refs.map((ref) =>
    ref.artifact === "delivery_receipt"
      ? {
          artifact: ref.artifact,
          // Receipt ids encode observer identity and audience ordering. Public
          // projections retain only the parent message sequence.
          seq: ref.seq
        }
      : {
          artifact: ref.artifact,
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId
        }
  );
}

export function cloneJson<T>(value: T): T {
  // Optional evidence fields (e.g. a speech act without a structured value)
  // must survive projection instead of crashing JSON.parse on "undefined".
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
