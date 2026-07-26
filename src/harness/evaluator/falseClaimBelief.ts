import { agentStateEvidence, metricEvidenceFromSocialRefs } from "./evidence";
import { falseClaimExposureKey, uniqueExposureCount } from "./falseClaimReputation";
import { falseRoleClaimExposureEvidence, falseRoleClaimExposureMetadata } from "./pressureVoteFollow";
import { asRecord, groupFalseClaimExposureRecordsByObserver, numberMetadata, ratio, roleMetadata, sampleIds, socialEpisodeExposureInput, stateEvidence, stringMetadata, uniqueEvidenceRefs, uniqueStrings } from "./support";
import { GameEvent, GameState, Role, Team } from "../../core/types";
import { metric } from "../evaluation";
import { SocialEpisodeArtifact, SocialExposureRecord, SocialMessage, deriveSocialExposureRecords } from "../social";
import { SocialStateMutationJournalEntry, socialStateRetentionWindow } from "../socialState";
import { AgentHarnessState, HarnessMetricEvidenceRef, HarnessMetricRecord } from "../types";
import { DECEPTION_BELIEF_SHIFT_EVALUATOR_ID, WEREWOLF_DECEPTION_EVALUATOR_ID } from "./suite";
export interface FalseRoleClaimMessage {
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

export interface FalseRoleClaimPressureVoteFollowRecord {
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

export type SocialEpisodeExposureInput = Pick<SocialEpisodeArtifact<unknown, unknown, unknown, unknown>, "steps" | "messages">;

export function metricsFromFalseRoleClaimExposure(state: GameState, agents: AgentHarnessState[], socialEpisode?: unknown): HarnessMetricRecord[] {
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

export function falseRoleClaimMessages(state: GameState, messages: SocialMessage[]): FalseRoleClaimMessage[] {
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

export function metricsFromFalseRoleClaimBeliefTemporalAssociation(
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
  outsideRetainedJournalWindowCount: number;
}

export interface FalseRoleClaimBeliefTemporalAssociationRecord {
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
    noLaterMutationCount: 0,
    outsideRetainedJournalWindowCount: 0
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

    audit.formationOnlyCount += orderedEntries.filter((entry) => !entry.beforeSummary && entry.turnIndex <= exposure.observedAtTurnIndex).length;
    const laterShiftEntries = orderedEntries.filter(
      (entry) => entry.turnIndex > exposure.observedAtTurnIndex && journalEntryHasBeliefShift(entry)
    );
    if (!laterShiftEntries.length) {
      if (agent.social?.journal && !socialStateRetentionWindow(agent.social.journal).windowComplete) {
        audit.outsideRetainedJournalWindowCount += 1;
        continue;
      }
      audit.evaluableExposureRecords.push(exposure);
      audit.noLaterMutationCount += 1;
      continue;
    }

    audit.evaluableExposureRecords.push(exposure);

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

export function journalEntryReferencesMessage(entry: SocialStateMutationJournalEntry, messageId: string, messageSeq: number): boolean {
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
    outsideRetainedJournalWindowCount: audit.outsideRetainedJournalWindowCount,
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
