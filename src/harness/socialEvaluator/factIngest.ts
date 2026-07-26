import { RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS, REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS } from "./lifecycleEvaluation";
import { metric } from "../evaluation";
import { confidence, hasNumericDelta, isMetadataDerivedSocialSpeechAct, isSocialSpeechActForEvaluation, ratio, socialFactsFromMessage, speechActIdForEvaluation, stringArrayMetadataValue, stringMetadataValue } from "./episodeData";
import { agentStateEvidence, evidenceFromExposureRecords, evidenceFromSocialRefs, socialAgentId, socialSubject, uniqueEvidenceRefs, withSocialHash } from "./evidence";
import { type HarnessMetricEvidenceRef, type HarnessMetricRecord } from "../types";
import { SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID, type SocialAgentSnapshot } from "./manifests";
import { type SocialStateMutationJournalEntry, socialStateRetentionWindow } from "../socialState";
import { type SocialExposureRecord, type SocialMessage, type SocialSpeechAct } from "../social";
export type SocialFactIngestCandidateKind = "commitment" | "coalition" | "relationship" | "reputation";

interface SocialFactIngestCandidate {
  kind: SocialFactIngestCandidateKind;
  recordId: string;
  messageId: string;
  messageSeq: number;
  observerId: string;
  exposureRecord: SocialExposureRecord;
  speechActId?: string;
  speechActKind?: string;
  speechActIndex?: number;
  factKind?: string;
  factIndex?: number;
}

interface SocialFactIngestRecordEvaluation {
  candidate: SocialFactIngestCandidate;
  linked: boolean;
  missingMutation: boolean;
  outsideRetainedJournalWindow: boolean;
  mutationEntries: SocialStateMutationJournalEntry[];
}

export type SocialMessageIndex = {
  byId: Map<string, SocialMessage>;
  bySeq: Map<number, SocialMessage>;
};

export function socialFactIngestEvidenceMetricsForAgent(
  agent: SocialAgentSnapshot,
  exposureRecords: SocialExposureRecord[],
  messages: SocialMessageIndex
): HarnessMetricRecord[] {
  const subject = socialSubject(agent);
  const evaluations = evaluateSocialFactIngestEvidenceForAgent(agent, exposureRecords, messages);
  return [
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "commitment", {
      countId: "agent.social.commitment_speech_act_ingest_link_count",
      rateId: "agent.social.commitment_speech_act_ingest_link_rate",
      countLabel: "Agent social commitment speech-act ingest link count",
      rateLabel: "Agent social commitment speech-act ingest link rate",
      candidateLabel: "commitmentSpeechActCandidates"
    }),
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "coalition", {
      countId: "agent.social.coalition_speech_act_ingest_link_count",
      rateId: "agent.social.coalition_speech_act_ingest_link_rate",
      countLabel: "Agent social coalition speech-act ingest link count",
      rateLabel: "Agent social coalition speech-act ingest link rate",
      candidateLabel: "coalitionSpeechActCandidates"
    }),
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "relationship", {
      countId: "agent.social.relationship_fact_ingest_link_count",
      rateId: "agent.social.relationship_fact_ingest_link_rate",
      countLabel: "Agent social relationship fact ingest link count",
      rateLabel: "Agent social relationship fact ingest link rate",
      candidateLabel: "relationshipFactCandidates"
    }),
    ...socialFactIngestEvidenceMetricPair(agent, subject, evaluations, "reputation", {
      countId: "agent.social.reputation_fact_ingest_link_count",
      rateId: "agent.social.reputation_fact_ingest_link_rate",
      countLabel: "Agent social reputation fact ingest link count",
      rateLabel: "Agent social reputation fact ingest link rate",
      candidateLabel: "reputationFactCandidates"
    })
  ];
}

function socialFactIngestEvidenceMetricPair(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evaluations: SocialFactIngestRecordEvaluation[],
  kind: SocialFactIngestCandidateKind,
  labels: {
    countId: string;
    rateId: string;
    countLabel: string;
    rateLabel: string;
    candidateLabel: string;
  }
): HarnessMetricRecord[] {
  const records = evaluations.filter((item) => item.candidate.kind === kind);
  const linkedRecords = records.filter((item) => item.linked);
  const evaluableRecords = records.filter((item) => !item.outsideRetainedJournalWindow);
  const outsideWindowRecords = records.filter((item) => item.outsideRetainedJournalWindow);
  const evidenceRefs = evidenceFromSocialFactIngestRecords(agent, linkedRecords);
  const metadata = {
    candidateKind: kind,
    [labels.candidateLabel]: records.length,
    linkedCandidates: linkedRecords.length,
    missingMutationCandidates: records.filter((item) => item.missingMutation).length,
    outsideRetainedJournalWindowCandidates: outsideWindowRecords.length,
    evaluableCandidates: evaluableRecords.length,
    sampleLinkedCandidates: sampleSocialFactIngestCandidates(linkedRecords),
    sampleMissingMutationCandidates: sampleSocialFactIngestCandidates(records.filter((item) => item.missingMutation)),
    sampleOutsideRetainedJournalWindowCandidates: sampleSocialFactIngestCandidates(outsideWindowRecords),
    coverageLevel: "explicit_scoped_exposure_to_social_state_mutation",
    causalClaim: false
  };
  return [
    socialFactIngestMetric(agent, subject, evidenceRefs, {
      id: labels.countId,
      label: labels.countLabel,
      value: linkedRecords.length,
      unit: "count",
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "sum",
      metadata
    }),
    socialFactIngestMetric(agent, subject, evidenceRefs, {
      id: labels.rateId,
      label: labels.rateLabel,
      value: ratio(linkedRecords.length, evaluableRecords.length),
      unit: "ratio",
      denominator: evaluableRecords.length,
      confidence: confidence(evaluableRecords.length),
      aggregation: "ratio",
      metadata
    })
  ];
}

function socialFactIngestMetric(
  agent: SocialAgentSnapshot,
  subject: Record<string, unknown>,
  evidenceRefs: HarnessMetricEvidenceRef[],
  options: {
    id: string;
    label: string;
    value: number;
    unit: "count" | "ratio";
    denominator: number;
    confidence: number;
    aggregation: "sum" | "ratio";
    metadata: Record<string, unknown>;
  }
): HarnessMetricRecord {
  return metric({
    id: options.id,
    label: options.label,
    scope: "agent",
    subjectId: socialAgentId(agent),
    subject,
    value: options.value,
    unit: options.unit,
    higherIsBetter: true,
    weight: 0,
    source: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
    evaluatorId: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
    evaluatorVersion: "1.0.0",
    denominator: options.denominator,
    confidence: options.confidence,
    aggregation: options.aggregation,
    evidenceRefs,
    metadata: withSocialHash(agent, options.metadata)
  });
}

export function evaluateSocialFactIngestEvidenceForAgent(
  agent: SocialAgentSnapshot,
  exposureRecords: SocialExposureRecord[],
  messages: SocialMessageIndex
): SocialFactIngestRecordEvaluation[] {
  const candidates = socialFactIngestCandidatesFromExposure(exposureRecords, messages);
  const journalEntries = agent.social?.journal?.entries ?? [];
  const window = agent.social?.journal ? socialStateRetentionWindow(agent.social.journal) : undefined;
  return candidates.map((candidate) => {
    const mutationEntries = journalEntries.filter((entry) => socialFactIngestCandidateMatchesMutation(candidate, entry));
    const outsideRetainedJournalWindow = mutationEntries.length === 0 && window?.windowComplete === false;
    return {
      candidate,
      linked: mutationEntries.length > 0,
      missingMutation: mutationEntries.length === 0 && !outsideRetainedJournalWindow,
      outsideRetainedJournalWindow,
      mutationEntries
    };
  });
}

function socialFactIngestCandidatesFromExposure(exposureRecords: SocialExposureRecord[], messages: SocialMessageIndex): SocialFactIngestCandidate[] {
  const candidates: SocialFactIngestCandidate[] = [];
  for (const exposureRecord of exposureRecords) {
    const message = messages.byId.get(exposureRecord.messageId) ?? messages.bySeq.get(exposureRecord.messageSeq);
    if (!message) continue;
    const speechActs = Array.isArray(message.speechActs) ? message.speechActs.filter(isSocialSpeechActForEvaluation) : [];
    for (const [speechActIndex, act] of speechActs.entries()) {
      const candidate = socialFactIngestCandidateFromSpeechAct(message, exposureRecord, act, speechActIndex);
      if (candidate) candidates.push(candidate);
    }
    for (const [factIndex, fact] of socialFactsFromMessage(message).entries()) {
      const candidate = socialFactIngestCandidateFromStructuredFact(message, exposureRecord, fact, factIndex);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function socialFactIngestCandidateFromSpeechAct(
  message: SocialMessage,
  exposureRecord: SocialExposureRecord,
  act: SocialSpeechAct,
  speechActIndex: number
): SocialFactIngestCandidate | undefined {
  if (isMetadataDerivedSocialSpeechAct(act)) return undefined;
  if (act.kind === "commitment") {
    const promisedAction = stringMetadataValue(act.metadata?.promisedAction) ?? stringMetadataValue(act.value);
    const stance = stringMetadataValue(act.metadata?.stance);
    if (!promisedAction && !stance) return undefined;
    const speechActId = speechActIdForEvaluation(act, speechActIndex);
    return {
      kind: "commitment",
      recordId: stringMetadataValue(act.metadata?.commitmentId) ?? `${message.id}:speech-act:${speechActId}:commitment`,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      speechActId,
      speechActKind: act.kind,
      speechActIndex
    };
  }
  if (act.kind === "coalition_signal") {
    const memberIds = stringArrayMetadataValue(act.metadata?.memberIds);
    if (!memberIds.length) return undefined;
    const speechActId = speechActIdForEvaluation(act, speechActIndex);
    return {
      kind: "coalition",
      recordId: stringMetadataValue(act.metadata?.coalitionId) ?? `${message.id}:speech-act:${speechActId}:coalition`,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      speechActId,
      speechActKind: act.kind,
      speechActIndex
    };
  }
  return undefined;
}

function socialFactIngestCandidateFromStructuredFact(
  message: SocialMessage,
  exposureRecord: SocialExposureRecord,
  fact: Record<string, unknown>,
  factIndex: number
): SocialFactIngestCandidate | undefined {
  const kind = stringMetadataValue(fact.kind);
  if (kind === "relationship") {
    const targetId = stringMetadataValue(fact.targetId);
    if (!targetId || !hasNumericDelta(fact.deltas, RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS)) return undefined;
    return {
      kind: "relationship",
      recordId: targetId,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      factKind: "relationship",
      factIndex
    };
  }
  if (kind === "reputation") {
    const subjectId = stringMetadataValue(fact.subjectId) ?? stringMetadataValue(fact.targetId);
    if (!subjectId || !hasNumericDelta(fact.deltas, REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS)) return undefined;
    return {
      kind: "reputation",
      recordId: subjectId,
      messageId: message.id,
      messageSeq: message.seq,
      observerId: exposureRecord.observerId,
      exposureRecord,
      factKind: "reputation",
      factIndex
    };
  }
  return undefined;
}

function socialFactIngestCandidateMatchesMutation(candidate: SocialFactIngestCandidate, entry: SocialStateMutationJournalEntry): boolean {
  if (entry.hiddenTruthUsed !== false) return false;
  if (entry.agentId !== candidate.observerId) return false;
  const entryObserverId = stringMetadataValue(entry.metadata?.observerId);
  if (entryObserverId && entryObserverId !== candidate.observerId) return false;
  if (!mutationMatchesCandidateStore(candidate, entry)) return false;
  if (entry.subjectId !== candidate.recordId) return false;
  if (!entryMatchesMessage(candidate, entry)) return false;
  if (candidate.speechActId && stringMetadataValue(entry.metadata?.speechActId) !== candidate.speechActId) return false;
  if (candidate.speechActKind && stringMetadataValue(entry.metadata?.speechActKind) !== candidate.speechActKind) return false;
  if (candidate.speechActIndex !== undefined && entry.metadata?.speechActIndex !== candidate.speechActIndex) return false;
  if (candidate.factKind && stringMetadataValue(entry.metadata?.factKind) !== candidate.factKind) return false;
  if (candidate.factIndex !== undefined && entry.metadata?.factIndex !== candidate.factIndex) return false;
  return true;
}

function mutationMatchesCandidateStore(candidate: SocialFactIngestCandidate, entry: SocialStateMutationJournalEntry): boolean {
  if (candidate.kind === "commitment") return entry.store === "commitments" && entry.mutationKind === "commitment.added";
  if (candidate.kind === "coalition") return entry.store === "coalitions" && entry.mutationKind === "coalition.added";
  if (candidate.kind === "relationship") return entry.store === "relationships" && entry.mutationKind === "relationship.updated";
  return entry.store === "reputation" && entry.mutationKind === "reputation.updated";
}

function entryMatchesMessage(candidate: SocialFactIngestCandidate, entry: SocialStateMutationJournalEntry): boolean {
  const metadataMessageId = stringMetadataValue(entry.metadata?.messageId);
  const metadataMessageSeq = typeof entry.metadata?.messageSeq === "number" ? entry.metadata.messageSeq : undefined;
  if (metadataMessageId !== undefined && metadataMessageId !== candidate.messageId) return false;
  if (metadataMessageSeq !== undefined && metadataMessageSeq !== candidate.messageSeq) return false;
  if (entry.evidenceRefs.some((ref) => ref.artifact === "message" && (ref.id === candidate.messageId || ref.seq === candidate.messageSeq))) return true;
  return entry.messageSeqRange?.start === candidate.messageSeq && entry.messageSeqRange.end === candidate.messageSeq;
}

function evidenceFromSocialFactIngestRecords(
  agent: SocialAgentSnapshot,
  records: SocialFactIngestRecordEvaluation[]
): HarnessMetricEvidenceRef[] {
  const exposureEvidence = records.flatMap((record) => evidenceFromExposureRecords(agent, [record.candidate.exposureRecord]));
  const mutationEvidence = records.flatMap((record) => evidenceFromSocialRefs(agent, record.mutationEntries.flatMap((entry) => entry.evidenceRefs)));
  const mutationTraceEvidence = records.flatMap((record) =>
    record.mutationEntries.flatMap((entry) => entry.traceId ? [{ artifact: "trace" as const, traceId: entry.traceId, description: entry.mutationKind }] : [])
  );
  return uniqueEvidenceRefs([...exposureEvidence, ...mutationEvidence, ...mutationTraceEvidence, ...agentStateEvidence(agent)]);
}

function sampleSocialFactIngestCandidates(records: SocialFactIngestRecordEvaluation[]): Array<{
  kind: SocialFactIngestCandidateKind;
  recordId: string;
  messageId: string;
  messageSeq: number;
  speechActId?: string;
  speechActKind?: string;
  factKind?: string;
  factIndex?: number;
}> {
  return records.slice(0, 20).map((record) => ({
    kind: record.candidate.kind,
    recordId: record.candidate.recordId,
    messageId: record.candidate.messageId,
    messageSeq: record.candidate.messageSeq,
    speechActId: record.candidate.speechActId,
    speechActKind: record.candidate.speechActKind,
    factKind: record.candidate.factKind,
    factIndex: record.candidate.factIndex
  }));
}

