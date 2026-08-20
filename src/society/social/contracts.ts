/**
 * Canonical social-causality contracts.
 *
 * These records never replace the raw message or the deterministic world
 * result. They connect what an actor observed or claimed to later beliefs,
 * decisions and social consequences with explicit provenance.
 */

export type EventId = string;
export type PropositionId = string;
export type EvidenceId = string;
export type SocialActId = string;
export type BeliefUpdateId = string;
export type DeceptionId = string;
export type SocialDecisionId = string;

export type ProvenanceSourceKind =
  | "world-fact"
  | "authorized-observation"
  | "message-claim"
  | "agent-self-report"
  | "system-inference"
  | "presentation";

export interface Provenance {
  sourceKind: ProvenanceSourceKind;
  sourceIds: string[];
  confidence?: number;
  createdAtLogical: number;
  schemaVersion: number;
}

export type VisibilityPolicy =
  | { kind: "public" }
  | { kind: "actors"; actorIds: string[] }
  | { kind: "operator" };

export interface EventEnvelope<T = unknown> {
  eventId: EventId;
  roomId: string;
  stream: "domain" | "social" | "agent-trace" | "presentation";
  type: string;
  sequence: number;
  logicalTime: number;
  wallTime: string;
  actorId?: string;
  characterId?: string;
  causationId?: string;
  correlationId?: string;
  visibility: VisibilityPolicy;
  schemaVersion: number;
  payload: T;
}

export interface Proposition {
  propositionId: PropositionId;
  kind:
    | "world-state"
    | "identity"
    | "past-action"
    | "future-action"
    | "preference"
    | "intention"
    | "relationship"
    | "norm"
    | "evaluation";
  subjectId?: string;
  predicate: string;
  object?: unknown;
  validFromLogicalTime?: number;
  validUntilLogicalTime?: number;
  truthStatus: "true" | "false" | "unknown" | "subjective" | "future-contingent";
  groundTruthVisibility: "public" | "private" | "hidden-until-resolution" | "no-objective-ground-truth";
  sourceEventIds: string[];
  schemaVersion: number;
}

export interface EvidenceRecord {
  evidenceId: EvidenceId;
  observerCharacterId: string;
  propositionId: PropositionId;
  sourceType:
    | "direct-observation"
    | "public-message"
    | "private-message"
    | "team-message"
    | "domain-result"
    | "memory"
    | "inference"
    | "rumor";
  sourceActorId?: string;
  sourceEventId?: string;
  sourceMessageId?: string;
  sourceMemoryId?: string;
  supports: boolean;
  strength: number;
  sourceReliability: number;
  visibility: "private" | "shared" | "public";
  logicalTime: number;
}

export type SocialActKind =
  | "assertion"
  | "denial"
  | "question"
  | "answer"
  | "promise"
  | "offer"
  | "acceptance"
  | "rejection"
  | "request"
  | "threat"
  | "accusation"
  | "defense"
  | "apology"
  | "alliance-proposal"
  | "disclosure"
  | "endorsement"
  | "warning"
  | "silence";

/** Optional structured meaning supplied by the speaking actor's typed tool. */
export interface SocialActDeclaration {
  kind: SocialActKind;
  targetActorIds?: string[];
  proposition?: {
    kind?: Proposition["kind"];
    subjectId?: string;
    predicate: string;
    object?: unknown;
  };
  confidence?: number;
  /** A private plan owned by the same actor that this message executes. */
  deceptionId?: DeceptionId;
}

export interface SocialActRecord {
  socialActId: SocialActId;
  kind: SocialActKind;
  messageId?: string;
  actorId: string;
  actorCharacterId: string;
  audienceActorIds: string[];
  targetActorIds: string[];
  propositionIds: PropositionId[];
  confidence: number;
  extractionMethod: "explicit-tool" | "model-extracted" | "rule-derived";
  logicalTime: number;
  sourceEventId: string;
  deceptionId?: DeceptionId;
}

export interface BeliefUpdateRecord {
  beliefUpdateId: BeliefUpdateId;
  beliefId: string;
  ownerCharacterId: string;
  propositionId: PropositionId;
  beforeProbability: number;
  afterProbability: number;
  confidence: number;
  addedEvidenceIds: string[];
  removedEvidenceIds: string[];
  reasonCode:
    | "new-observation"
    | "source-reliability-change"
    | "contradiction"
    | "world-resolution"
    | "memory-recall"
    | "social-influence"
    | "reflection";
  logicalTime: number;
  provenance: Provenance;
}

export interface CommitmentRecord {
  commitmentId: string;
  promisorActorId: string;
  promisorCharacterId: string;
  audienceActorIds: string[];
  propositionId: PropositionId;
  proposition: string;
  promisedAction: {
    actionType: string;
    amount?: number;
    condition?: string;
  };
  state: "proposed" | "fulfilled" | "violated" | "void";
  createdByCommandId?: string;
  settledByCommandId?: string;
  createdAtLogical: number;
  settledAtLogical?: number;
  sourceEventIds: string[];
  provenance: Provenance;
}

export interface BeliefSelfReportInput {
  subjectId: string;
  proposition: string;
  probability: number;
  confidence: number;
  source: string;
  sourceMessageIds?: string[];
  supports?: boolean;
}

export interface DeceptionPlanInput {
  mode: "direct-lie" | "omission" | "misdirection" | "selective-truth" | "false-implication" | "feigned-commitment" | "identity-performance";
  targetActorIds: string[];
  truePropositions?: string[];
  intendedBelief: string;
  motive?: string;
  expectedGain?: string;
  perceivedDetectionRisk?: number;
}

export interface DeceptionEpisode {
  deceptionId: DeceptionId;
  deceiverCharacterId: string;
  deceiverActorId: string;
  targetAudienceIds: string[];
  mode: DeceptionPlanInput["mode"];
  truePropositionIds: string[];
  intendedFalseBeliefIds: string[];
  motiveGoalIds: string[];
  expectedGain?: string;
  perceivedDetectionRisk?: number;
  plannedAtLogicalTime?: number;
  sourcePlanRecordId?: string;
  executionMessageIds: string[];
  supportingActionReceiptIds: string[];
  maintenanceMessageIds: string[];
  contradictionEventIds: string[];
  audienceBeliefsBefore: Array<{ characterId: string; beliefId: string; probability: number }>;
  audienceBeliefsAfter: Array<{ characterId: string; beliefId: string; probability: number }>;
  inducedDecisionIds: string[];
  inducedActionReceiptIds: string[];
  status: "planned" | "attempted" | "received" | "believed" | "behaviorally-effective" | "failed" | "abandoned" | "detected" | "repaired";
  detectionEventIds: string[];
  consequenceEventIds: string[];
  schemaVersion: number;
}

export interface SocialDecisionRecord {
  decisionId: SocialDecisionId;
  actorId: string;
  characterId: string;
  activationId?: string;
  logicalTime: number;
  observationRefs: string[];
  evidenceRefs: string[];
  relevantBeliefIds: string[];
  openCommitmentIds: string[];
  activeDeceptionIds: string[];
  selectedIntent: { summary: string };
  action: string;
  actionReceiptId: string;
  provenance: Provenance;
}

export interface SocialCausalityProjection {
  schemaVersion: number;
  lastSequence: number;
  events: EventEnvelope[];
  propositions: Proposition[];
  socialActs: SocialActRecord[];
  evidence: EvidenceRecord[];
  beliefUpdates: BeliefUpdateRecord[];
  commitments: CommitmentRecord[];
  decisions: SocialDecisionRecord[];
  deceptions: DeceptionEpisode[];
}

export interface SocialCausalityState extends SocialCausalityProjection {
  roomId: string;
}
