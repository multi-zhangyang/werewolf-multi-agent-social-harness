import { agentStateEvidence, metricEvidenceFromSocialRefs } from "./evidence";
import { FalseRoleClaimBeliefTemporalAssociationRecord, FalseRoleClaimMessage, falseRoleClaimMessages, journalEntryReferencesMessage } from "./falseClaimBelief";
import { falseRoleClaimExposureEvidence } from "./pressureVoteFollow";
import { groupFalseClaimExposureRecordsByObserver, numberMetadata, ratio, sampleIds, socialEpisodeExposureInput, stateEvidence, uniqueEvidenceRefs, uniqueStrings } from "./support";
import { GameState } from "../../core/types";
import { metric } from "../evaluation";
import { SocialExposureRecord, deriveSocialExposureRecords } from "../social";
import { SocialStateMutationJournalEntry, socialStateRetentionWindow } from "../socialState";
import { AgentHarnessState, HarnessMetricEvidenceRef, HarnessMetricRecord } from "../types";
import { DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID } from "./suite";
export function metricsFromFalseRoleClaimReputationTemporalAssociation(
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
  outsideRetainedJournalWindowCount: number;
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
    const candidateEntries = entries.filter((entry) => journalEntryMatchesFalseClaimReputationCandidate(entry, exposure, claim));
    const orderedEntries = candidateEntries.filter((entry): entry is SocialStateMutationJournalEntry & { turnIndex: number } => typeof entry.turnIndex === "number");
    if (candidateEntries.some((entry) => typeof entry.turnIndex !== "number")) {
      audit.ambiguousOrderingExposureCount += 1;
      continue;
    }

    audit.sameTurnMutationCount += orderedEntries.filter((entry) => entry.turnIndex <= exposure.observedAtTurnIndex).length;
    const laterMutationEntries = orderedEntries.filter(
      (entry) => entry.turnIndex > exposure.observedAtTurnIndex && journalEntryHasReputationDelta(entry)
    );
    if (!laterMutationEntries.length) {
      if (agent.social?.journal && !socialStateRetentionWindow(agent.social.journal).windowComplete) {
        audit.outsideRetainedJournalWindowCount += 1;
        continue;
      }
      audit.evaluableExposureRecords.push(exposure);
      audit.noLaterMutationCount += 1;
      continue;
    }

    audit.evaluableExposureRecords.push(exposure);

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
    outsideRetainedJournalWindowCount: audit.outsideRetainedJournalWindowCount,
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

export function uniqueExposureCount(records: FalseRoleClaimBeliefTemporalAssociationRecord[]): number {
  return new Set(records.map((record) => falseClaimExposureKey(record.exposure))).size;
}

export function falseClaimExposureKey(record: SocialExposureRecord): string {
  return `${record.messageId}:${record.observerId}:${record.observedAtTraceId}`;
}
