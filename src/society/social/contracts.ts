/**
 * Canonical social-causality contracts.
 *
 * These records never replace the raw message or the deterministic world
 * result. They connect what an actor observed or claimed to later beliefs,
 * decisions and social consequences with explicit provenance.
 */

import type { ContextPolicy, ModelCapabilities } from "../models/contracts";

export type EventId = string;
export type PropositionId = string;
export type EvidenceId = string;
export type SocialActId = string;
export type BeliefUpdateId = string;
export type DeceptionId = string;
export type SocialDecisionId = string;
export type ActorModelId = string;
export type CandidateIntentId = string;
export type StrategySelectionId = string;
export type StrategyProfileSnapshotId = string;
export type InfluenceId = string;
export type OutcomeReconciliationId = string;
export type RelationshipDeltaId = string;

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
  /** A detected episode this message explicitly repairs or accepts repair for. */
  repairDeceptionId?: DeceptionId;
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
  repairDeceptionId?: DeceptionId;
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
    choice?: string;
    condition?: string;
  };
  state: "proposed" | "accepted" | "fulfilled" | "violated" | "void";
  acceptedByActorIds: string[];
  acceptedByCommandIds: string[];
  createdByCommandId?: string;
  settledByCommandId?: string;
  createdAtLogical: number;
  acceptedAtLogical?: number;
  settledAtLogical?: number;
  sourceEventIds: string[];
  provenance: Provenance;
}

export interface BeliefSelfReportInput {
  subjectId: string;
  proposition: string;
  kind?: Proposition["kind"];
  object?: unknown;
  probability: number;
  confidence: number;
  source: string;
  sourceMessageIds?: string[];
  sourceEvidenceIds?: string[];
  supports?: boolean;
}

export interface ActorModelInput {
  targetActorId: string;
  inferredGoals: Array<{ goal: string; probability: number }>;
  inferredKnowledge: Array<{ proposition: string; probability: number }>;
  predictedActions: Array<{ action: string; probability: number }>;
  perceivedStrategy: string[];
  perceivedHonesty: number;
  perceivedRiskTolerance: number;
  sourceMessageIds?: string[];
  sourceEvidenceIds?: string[];
  confidence: number;
}

/** One actor's private, evidence-linked model of another actor. */
export interface ActorModel {
  modelId: ActorModelId;
  ownerActorId: string;
  ownerCharacterId: string;
  targetActorId: string;
  targetCharacterId: string;
  inferredGoals: Array<{ goal: string; probability: number }>;
  inferredKnowledge: Array<{ propositionId: PropositionId; probability: number }>;
  predictedActions: Array<{ action: string; probability: number }>;
  perceivedStrategy: string[];
  perceivedHonesty: number;
  perceivedRiskTolerance: number;
  evidenceIds: EvidenceId[];
  lastUpdatedLogicalTime: number;
  provenance: Provenance;
  schemaVersion: number;
}

export interface RelationshipDimensions {
  trust: number;
  affinity: number;
  respect: number;
  tension: number;
  familiarity: number;
}

/** One participant's private, directional relationship toward another. */
export interface DirectedRelationshipState extends RelationshipDimensions {
  relationshipId: string;
  ownerActorId: string;
  ownerCharacterId: string;
  targetActorId: string;
  targetCharacterId: string;
  note: string;
  sourceEventIds: string[];
  evidenceIds: EvidenceId[];
  lastUpdatedLogicalTime: number;
  provenance: Provenance;
  schemaVersion: number;
}

export interface RelationshipDeltaRecord {
  relationshipDeltaId: RelationshipDeltaId;
  relationshipId: string;
  ownerActorId: string;
  ownerCharacterId: string;
  targetActorId: string;
  targetCharacterId: string;
  before: RelationshipDimensions;
  after: RelationshipDimensions;
  delta: RelationshipDimensions;
  note: string;
  sourceEventIds: string[];
  evidenceIds: EvidenceId[];
  logicalTime: number;
  provenance: Provenance;
  schemaVersion: number;
}

export interface RelationshipUpdateInput {
  targetActorId: string;
  before: RelationshipDimensions;
  after: RelationshipDimensions;
  note: string;
  sourceMessageIds?: string[];
  sourceEventIds?: string[];
  sourceEvidenceIds?: string[];
  sourceKind: "agent-self-report" | "authorized-observation" | "system-inference";
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
  targetAudienceCharacterIds: string[];
  mode: DeceptionPlanInput["mode"];
  truePropositionIds: string[];
  intendedFalseBeliefIds: string[];
  motiveGoalIds: string[];
  expectedGain?: string;
  perceivedDetectionRisk?: number;
  plannedAtLogicalTime?: number;
  sourcePlanRecordId?: string;
  executionMessageIds: string[];
  receivedByCharacterIds: string[];
  believedByCharacterIds: string[];
  rejectedByCharacterIds: string[];
  detectedByCharacterIds: string[];
  repairMessageIds: string[];
  repairAcceptedByCharacterIds: string[];
  supportingActionReceiptIds: string[];
  maintenanceMessageIds: string[];
  contradictionEventIds: string[];
  audienceBeliefsBefore: Array<{ characterId: string; beliefId: string; probability: number }>;
  audienceBeliefsAfter: Array<{ characterId: string; beliefId: string; probability: number }>;
  inducedDecisionIds: string[];
  inducedActionReceiptIds: string[];
  status: "planned" | "attempted" | "received" | "believed" | "behaviorally-effective" | "failed" | "abandoned" | "detected" | "repair-attempted" | "repaired";
  detectionEventIds: string[];
  consequenceEventIds: string[];
  exposureVisibility?: "private" | "targets" | "public";
  schemaVersion: number;
}

export interface OutcomePrediction {
  outcomeKey: string;
  proposition: string;
  probability: number;
  horizon: "immediate" | "round" | "game" | "future-game";
}

/** A bounded option considered by the same participant that will act. */
export interface CandidateIntent {
  intentId: CandidateIntentId;
  actorId: string;
  characterId: string;
  activationId?: string;
  goal: string;
  summary: string;
  publicStrategy?: string;
  possibleActions: Array<{ action: string; payloadSummary?: string }>;
  expectedUtility?: number;
  exposureRisk?: number;
  relationshipRisk?: number;
  predictedResponses: Array<{ targetCharacterId: string; response: string; probability: number }>;
  evidenceRefs: EvidenceId[];
  beliefRefs: string[];
  actorModelRefs: ActorModelId[];
  source: "agent-self-report" | "bounded-rule";
  logicalTime: number;
  schemaVersion: number;
}

export interface StrategySelection {
  selectionId: StrategySelectionId;
  actorId: string;
  characterId: string;
  activationId?: string;
  strategyProfileSnapshotId?: StrategyProfileSnapshotId;
  candidateIntentIds: CandidateIntentId[];
  selectedIntentId: CandidateIntentId;
  selector: "agent" | "bounded-rule" | "shadow";
  selectorVersion: string;
  evidenceRefs: EvidenceId[];
  budget: { maxCandidates: number; consideredCandidates: number };
  /**
   * Non-binding deterministic audit over the Agent's own declared estimates.
   * It never changes the typed command and is not a claim about true utility.
   */
  shadowRecommendation?: {
    recommendedIntentId: CandidateIntentId;
    agentSelectedIntentId: CandidateIntentId;
    agreedWithAgent: boolean;
    score: number;
    scoreBreakdown: {
      normalizedExpectedUtility: number;
      exposurePenalty: number;
      relationshipPenalty: number;
      evidenceBonus: number;
    };
    weights: {
      utility: number;
      exposureRisk: number;
      relationshipRisk: number;
      evidence: number;
    };
    estimateSource: "agent-self-report";
    selectorVersion: string;
  };
  logicalTime: number;
  schemaVersion: number;
}

/** Immutable, secret-free runtime configuration behind one actor's decisions. */
export interface StrategyProfileSnapshot {
  strategyProfileSnapshotId: StrategyProfileSnapshotId;
  actorId: string;
  characterId: string;
  modelConfig: {
    modelProfileId: string;
    modelId: string;
    providerProfileId: string;
    contextWindow: number;
    usableInputTokens: number;
    tuning: Record<string, { value: unknown; source: string }>;
    capabilities: ModelCapabilities;
    negotiationNotes: string[];
  };
  persona: {
    text: string;
    decisionBiases: string[];
    voice?: string;
    autobiographicalAnchors: string[];
  };
  promptPolicy: {
    id: string;
    version: string;
    instructions: string[];
    instructionsHash: string;
  };
  contextPolicy: ContextPolicy;
  toolSchemas: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: boolean;
  }>;
  strategyVersion: string;
  reasoningFallback: {
    requestedEffort: string;
    order: Array<"xhigh" | "high" | "provider-default">;
    downgradeOnlyOnCapabilityError: true;
    notifyOnDowngradeOrFailure: true;
  };
  configurationHash: string;
  createdAtLogical: number;
  createdAt: string;
  schemaVersion: number;
}

export interface InfluenceLink {
  influenceId: InfluenceId;
  sourceEventId: string;
  targetCharacterId: string;
  beliefUpdateIds: BeliefUpdateId[];
  decisionId?: SocialDecisionId;
  resultingActionReceiptId?: string;
  confidence: number;
  basis:
    | "agent-cited"
    | "direct-commitment-reference"
    | "temporal-association"
    | "counterfactual-replay"
    | "observer-inferred";
  logicalTime: number;
  schemaVersion: number;
}

export interface OutcomeReconciliation {
  reconciliationId: OutcomeReconciliationId;
  decisionId: SocialDecisionId;
  actorId: string;
  characterId: string;
  actionReceiptId: string;
  predictedConsequences: OutcomePrediction[];
  actualOutcome: { summary: string; metrics: Record<string, number | string | boolean | null> };
  predictionAssessments: Array<{
    outcomeKey: string;
    predictedProbability: number;
    actual: boolean;
    squaredError: number;
  }>;
  propositionSettlements: Array<{ propositionId: PropositionId; truthStatus: "true" | "false" }>;
  influenceIds: InfluenceId[];
  memoryWriteSuggestions: Array<{
    suggestionId: string;
    summary: string;
    importance: number;
    sourceIds: string[];
    status: "candidate" | "accepted" | "rejected";
    decidedAtLogical?: number;
  }>;
  calibrationError?: number;
  resultingEventIds: string[];
  logicalTime: number;
  provenance: Provenance;
  schemaVersion: number;
}

export interface MemoryWritePolicyResult {
  evaluated: boolean;
  accepted: Array<{
    suggestionId: string;
    summary: string;
    importance: number;
    sourceIds: string[];
  }>;
}

export interface OutcomeReconciliationInput {
  actionReceiptId: string;
  actualOutcome: { summary: string; metrics: Record<string, number | string | boolean | null> };
  actualFacts: Record<string, boolean>;
  memoryWriteSuggestions?: Array<{ summary: string; importance: number; sourceIds?: string[] }>;
  resultingEventIds?: string[];
}

export interface SocialDecisionRecord {
  decisionId: SocialDecisionId;
  actorId: string;
  characterId: string;
  activationId?: string;
  strategyProfileSnapshotId?: StrategyProfileSnapshotId;
  logicalTime: number;
  observationRefs: string[];
  evidenceRefs: string[];
  relevantBeliefIds: string[];
  relevantActorModelIds: string[];
  relevantRelationshipIds: string[];
  openCommitmentIds: string[];
  activeDeceptionIds: string[];
  candidateIntentIds: CandidateIntentId[];
  strategySelectionId: StrategySelectionId;
  selectedIntent: { intentId: CandidateIntentId; summary: string; publicStrategy?: string };
  predictedConsequences: OutcomePrediction[];
  action: string;
  actionReceiptId: string;
  resultingEventIds: string[];
  outcomeReconciliationId?: OutcomeReconciliationId;
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
  actorModels: ActorModel[];
  directedRelationships: DirectedRelationshipState[];
  relationshipDeltas: RelationshipDeltaRecord[];
  commitments: CommitmentRecord[];
  candidateIntents: CandidateIntent[];
  strategyProfileSnapshots: StrategyProfileSnapshot[];
  activeStrategyProfileSnapshotIds: Record<string, StrategyProfileSnapshotId>;
  strategySelections: StrategySelection[];
  decisions: SocialDecisionRecord[];
  influenceLinks: InfluenceLink[];
  outcomeReconciliations: OutcomeReconciliation[];
  deceptions: DeceptionEpisode[];
}

export interface SocialCausalityState extends SocialCausalityProjection {
  roomId: string;
}
