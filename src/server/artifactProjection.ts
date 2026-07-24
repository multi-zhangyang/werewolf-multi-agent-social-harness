import type { AgentSnapshotFrame, MatchArtifact } from "../harness/artifacts";
import type { GameState } from "../core/types";
import type { MatchComparisonProjection } from "../harness/matchComparison";
import type {
  SocialAction,
  SocialDeliveryReceipt,
  SocialEpisodeArtifact,
  SocialHarnessStep,
  SocialMessage,
  SocialSpeechAct,
  SocialStepFailureEvidence
} from "../harness/social";
import type {
  AgentHarnessState,
  HarnessStepRecord,
  HarnessTurnTrace,
  PolicyPlan,
  ReasonerOutputSummary
} from "../harness/types";
import type { AgentActionArbitrationSummary } from "../harness/scaffold";

export type MatchArtifactView = "full" | "postgame-redacted" | "truth-redacted";

export const REDACTED_PRIVATE_OBSERVATION = "[REDACTED private harness observation]" as const;
export const REDACTED_PRIVATE_SOCIAL_OBSERVATION = "[REDACTED private social observation]" as const;
export const REDACTED_DELIVERY_POLICY = "[REDACTED delivery redaction policy]" as const;
export const REDACTED_SOCIAL_STEP_FAILURE = "[REDACTED social step failure detail]" as const;

export interface RedactedPendingActionDto {
  kind: string;
  actorId?: string;
  phase?: string;
  redacted: true;
}

export interface RedactedCommandDto {
  type: string;
  actorId?: string;
  redacted: true;
}

export type RedactedPolicyPlanDto = Omit<PolicyPlan, "command" | "targetId" | "pressureTargetId" | "arbitration"> & {
  command: RedactedCommandDto;
  targetId?: never;
  pressureTargetId?: never;
  arbitration?: never;
};

export type RedactedReasonerOutputDto = Omit<
  ReasonerOutputSummary,
  "providerRequestId" | "retryHistory" | "stream"
> & {
  providerRequestId?: never;
  retryHistory?: never;
  stream?: never;
};

export type RedactedTurnTraceDto = Omit<
  HarnessTurnTrace,
  "targetId" | "arbitration" | "beliefs" | "providerRequestId" | "retryHistory" | "stream"
> & {
  targetId?: never;
  arbitration?: never;
  beliefs: Record<string, never>;
  providerRequestId?: never;
  retryHistory?: never;
  stream?: never;
};

/**
 * Content-free postgame projection of one action candidate. Candidate ids,
 * target ids, reasons, evidence refs, score-contribution details, metadata,
 * and action hashes are intentionally absent: each can encode actor-private
 * state or make a small legal target set brute-forceable.
 */
export interface RedactedAgentActionCandidateSummaryDto {
  ordinal: number;
  source: string;
  kind: string;
  selected: boolean;
  baseScore?: number;
  utilityScore?: number;
  socialScore?: number;
  riskPenalty?: number;
  legalityScore?: number;
  finalScore?: number;
  scoreContributionCount: number;
  evidenceCount: number;
  messageCount: number;
}

/**
 * Safe UI/audit summary derived by the server from canonical arbitration.
 * It proves that candidate arbitration happened without exposing raw candidate
 * identity or the private evidence that produced a score.
 */
export interface RedactedAgentActionArbitrationSummaryDto {
  version: AgentActionArbitrationSummary["version"];
  arbitrator: "default-score-arbitrator" | "custom";
  candidateCount: number;
  decisionRule: "highest_final_score_then_candidate_id" | "custom";
  selectedCandidateOrdinal?: number;
  selectedCandidateSource?: string;
  candidates: RedactedAgentActionCandidateSummaryDto[];
}

export type RedactedHarnessStepDto = Omit<
  HarnessStepRecord,
  | "pendingAction"
  | "observation"
  | "policyPlan"
  | "reasonerOutput"
  | "command"
  | "turnTrace"
  | "actionArbitration"
  | "agentSnapshotsAfterStep"
> & {
  pendingAction: RedactedPendingActionDto;
  observation: typeof REDACTED_PRIVATE_OBSERVATION;
  policyPlan: RedactedPolicyPlanDto;
  reasonerOutput: RedactedReasonerOutputDto;
  command: RedactedCommandDto;
  turnTrace: RedactedTurnTraceDto;
  actionArbitration?: RedactedAgentActionArbitrationSummaryDto;
  agentSnapshotsAfterStep?: never;
};

export type RedactedSocialStepFailureDto = Omit<SocialStepFailureEvidence, "metadata"> & {
  message: typeof REDACTED_SOCIAL_STEP_FAILURE;
  metadata?: never;
};

export type RedactedSocialDeliveryReceiptDto = Omit<SocialDeliveryReceipt, "redactionPolicy"> & {
  redactionPolicy: typeof REDACTED_DELIVERY_POLICY;
};

export type RedactedSocialSpeechActDto = Omit<SocialSpeechAct, "evidenceRefs" | "metadata"> & {
  evidenceRefs: Array<Omit<SocialSpeechAct["evidenceRefs"][number], "description">>;
  metadata?: never;
};

export type RedactedSocialMessageDto = Omit<SocialMessage, "speechActs" | "deliveryReceipts" | "metadata"> & {
  speechActs?: RedactedSocialSpeechActDto[];
  deliveryReceipts?: RedactedSocialDeliveryReceiptDto[];
  metadata?: Record<string, unknown>;
};

export type RedactedSocialMessageDraftDto = Omit<RedactedSocialMessageDto, "id" | "seq" | "createdAt">;

export type RedactedSocialActionDto = Omit<SocialAction<unknown>, "command" | "messages" | "metadata"> & {
  command: RedactedCommandDto;
  messages?: RedactedSocialMessageDraftDto[];
  metadata?: Record<string, unknown>;
};

export type RedactedSocialStepDto = Omit<
  SocialHarnessStep<unknown, unknown, unknown>,
  "pendingAction" | "observation" | "action" | "failure" | "actorSnapshotsAfterStep" | "infosByAgent"
> & {
  pendingAction: RedactedPendingActionDto;
  observation: typeof REDACTED_PRIVATE_SOCIAL_OBSERVATION;
  action: RedactedSocialActionDto;
  failure?: RedactedSocialStepFailureDto;
  actorSnapshotsAfterStep?: never;
  infosByAgent?: never;
};

export type RedactedSocialEpisodeDto = Omit<
  SocialEpisodeArtifact<GameState, unknown, unknown, unknown>,
  "steps" | "messages" | "assignmentResolution"
> & {
  steps: RedactedSocialStepDto[];
  messages: RedactedSocialMessageDto[];
  assignmentResolution?: never;
};

type AgentSocialStateSource = NonNullable<AgentHarnessState["social"]>;
type RedactedEvidenceRefDto = Omit<AgentSocialStateSource["memory"]["entries"][number]["evidenceRefs"][number], "description">;
type RedactedMemoryEntryDto = Omit<
  AgentSocialStateSource["memory"]["entries"][number],
  "observation" | "pendingAction" | "action" | "metadata" | "evidenceRefs"
> & {
  observation?: never;
  pendingAction?: never;
  action?: never;
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedBeliefClaimDto = Omit<
  AgentSocialStateSource["beliefs"]["claims"][string],
  "metadata" | "evidenceRefs"
> & {
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedRelationshipEdgeDto = Omit<
  AgentSocialStateSource["relationships"]["edges"][string],
  "metadata" | "evidenceRefs"
> & {
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedReputationRecordDto = Omit<
  AgentSocialStateSource["reputation"]["records"][string],
  "metadata" | "evidenceRefs"
> & {
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};
type RedactedJournalEntryDto = Omit<
  NonNullable<AgentSocialStateSource["journal"]>["entries"][number],
  "beforeSummary" | "afterSummary" | "deltaSummary" | "metadata" | "evidenceRefs"
> & {
  beforeSummary?: never;
  afterSummary?: never;
  deltaSummary?: never;
  metadata?: never;
  evidenceRefs: RedactedEvidenceRefDto[];
};

export type RedactedAgentSocialStateDto = Omit<
  AgentSocialStateSource,
  | "profile"
  | "memory"
  | "beliefs"
  | "relationships"
  | "norms"
  | "reputation"
  | "goals"
  | "commitments"
  | "coalitions"
  | "gossip"
  | "theoryOfMind"
  | "normSanctions"
  | "trustRepairs"
  | "betrayals"
  | "lastPlan"
  | "journal"
> & {
  profile: Omit<AgentSocialStateSource["profile"], "persona" | "metadata"> & {
    persona?: never;
    metadata?: never;
  };
  memory: Omit<AgentSocialStateSource["memory"], "entries"> & { entries: RedactedMemoryEntryDto[] };
  beliefs: { claims: Record<string, RedactedBeliefClaimDto> };
  relationships: { edges: Record<string, RedactedRelationshipEdgeDto> };
  norms: { norms: Record<string, never> };
  reputation: { records: Record<string, RedactedReputationRecordDto> };
  goals: { goals: [] };
  commitments?: never;
  coalitions?: never;
  gossip?: never;
  /** Second-order attributions are actor-private and never server-projected. */
  theoryOfMind?: never;
  normSanctions?: never;
  trustRepairs?: never;
  betrayals?: never;
  lastPlan?: string;
  journal?: Omit<NonNullable<AgentSocialStateSource["journal"]>, "entries"> & {
    entries: RedactedJournalEntryDto[];
  };
};

/**
 * Agent state remains useful as a postgame social-state summary, but the
 * explicitly private top-level stores are replaced with redacted values.
 */
export type RedactedAgentStateDto = Omit<AgentHarnessState, "beliefs" | "privateMemos" | "lastIntent" | "social"> & {
  beliefs: Record<string, never>;
  privateMemos: string[];
  lastIntent?: string;
  social?: RedactedAgentSocialStateDto;
};

export interface SocialNetworkNodeDto {
  id: string;
  profileId?: string;
  policyName?: string;
  sentMessageCount: number;
  deliveryCount: number;
  receivedMessageCount: number;
  observedMessageCount: number;
  observationCount: number;
  relationshipCount: number;
}

export interface SocialNetworkRelationshipEdgeDto {
  id: string;
  sourceId: string;
  targetId: string;
  trust: number;
  suspicion: number;
  affinity: number;
  influence: number;
  debt: number;
  respect: number;
  threat: number;
  evidenceRefs: Array<{
    artifact: string;
    id?: string;
    seq?: number;
    traceId?: string;
  }>;
  updatedAt: string;
}

export interface SocialNetworkCommunicationEdgeDto {
  id: string;
  sourceId: string;
  targetId: string;
  channelId: string;
  visibility: SocialMessage["visibility"];
  messageCount: number;
  messageSeqs: number[];
}

export interface SocialNetworkExposureEdgeDto {
  id: string;
  sourceId: string;
  targetId: string;
  channelId: string;
  visibility: SocialMessage["visibility"];
  kind?: string;
  uniqueMessageCount: number;
  observationCount: number;
  messageRefs: Array<{ id: string; seq: number }>;
  actionKinds: string[];
  traceIds: string[];
  turnIndexes: number[];
  evidenceCount: number;
}

export interface SocialNetworkModeAvailabilityDto {
  available: boolean;
  recordCount: number;
  reason?: string;
}

/**
 * Server-owned, content-free social-network view model for the cockpit.
 * Relationship state, message routing, and recorded observation exposure stay
 * separate so the UI cannot present delivery or visibility as social belief.
 */
export interface SocialNetworkProjectionDto {
  artifactVersion: "server.social-network-projection.v1";
  kind: "social-network-projection";
  authority: "server-owned-match-artifact";
  scope: "final-agent-snapshot";
  projection: PostgameMatchProjectionDto["projection"];
  modes: {
    relationships: SocialNetworkModeAvailabilityDto;
    communication: SocialNetworkModeAvailabilityDto;
    exposure: SocialNetworkModeAvailabilityDto;
  };
  nodes: SocialNetworkNodeDto[];
  relationshipEdges: SocialNetworkRelationshipEdgeDto[];
  communicationEdges: SocialNetworkCommunicationEdgeDto[];
  exposureEdges: SocialNetworkExposureEdgeDto[];
}

export type RedactedAgentSnapshotFrameDto = Omit<AgentSnapshotFrame, "agents"> & {
  agents: RedactedAgentStateDto[];
};

/**
 * A deliberately narrow, server-owned narrative ledger for the Werewolf
 * review board.  It is not a general GameEvent projection: raw payloads,
 * actor identities, targets, command traces, and scheduler metadata remain
 * outside this DTO.
 */
export interface WerewolfPostgameEventLedgerEntryDto {
  id: string;
  seq: number;
  day: number;
  phase: string;
  eventType: string;
  visibility: "public";
  /** Finite server allowlist label; never derived from GameEvent.payload. */
  safeLabel: string;
  /**
   * Present only in a local postgame review and only at a complete recorded
   * native scheduler boundary.  Truth-redacted readers never receive it.
   */
  nativeBoundary?: {
    nativeStepCount: number;
  };
}

export interface WerewolfPostgameEventLedgerDto {
  artifactVersion: "server.werewolf-postgame-event-ledger.v1";
  kind: "werewolf-postgame-event-ledger";
  authority: "server-owned-match-artifact" | "native-social-episode";
  projection: {
    view: "postgame-redacted" | "truth-redacted";
    privateEvidenceRedacted: true;
    postgameTruthRedacted: boolean;
  };
  entries: WerewolfPostgameEventLedgerEntryDto[];
}

export interface PostgameMatchProjectionDto
  extends Omit<
    MatchArtifact,
    | "runId"
    | "matchId"
    | "seed"
    | "trajectory"
    | "socialEpisode"
    | "evaluation"
    | "evaluationReport"
    | "metrics"
    | "agents"
    | "agentSnapshotFrames"
  > {
  /** Omitted by truth-redacted projections because current run ids are seed-derived. */
  runId?: string;
  matchId?: string;
  /** Omitted by truth-redacted projections because it can reconstruct hidden assignments. */
  seed?: string;
  projection: {
    view: "postgame-redacted" | "truth-redacted";
    privateEvidenceRedacted: boolean;
    postgameTruthRedacted: boolean;
    generatedAt: string;
  };
  trajectory: RedactedHarnessStepDto[];
  socialEpisode: RedactedSocialEpisodeDto;
  /** Truth-redacted projections intentionally expose empty evaluator records. */
  evaluation: Partial<MatchArtifact["evaluation"]>;
  evaluationReport: Partial<MatchArtifact["evaluationReport"]>;
  metrics: Partial<MatchArtifact["metrics"]>;
  agents: RedactedAgentStateDto[];
  agentSnapshotFrames?: RedactedAgentSnapshotFrameDto[];
  /** Server-owned social graph contract; the browser never derives relationship facts. */
  socialNetwork: SocialNetworkProjectionDto;
  /** Server-owned postgame narrative source for the React review timeline. */
  werewolfReviewLedger: WerewolfPostgameEventLedgerDto;
}

/**
 * A transient, server-derived frame after one complete native scheduler
 * boundary. It is intentionally not a MatchArtifact, checkpoint, or replay
 * authority: the browser receives only a redacted state projection and audit
 * counters, never commands, observations, actor state, or provider evidence.
 */
export interface PostgameReplayFrameDto {
  artifactVersion: "server.match-replay-frame.v1";
  kind: "match-replay-frame";
  authority: "native-social-episode";
  source: "server-owned-match-artifact";
  cursor: {
    nativeStepCount: number;
    messageCount: number;
    eventCount: number;
    /** Hash produced by canonical deterministic prefix replay. */
    stateHash?: string;
    /** Present when the selected recorded native step carried a post-state hash. */
    recordedPostStateHash?: string;
  };
  projection: PostgameMatchProjectionDto["projection"];
  /** Server-redacted prefix state; it is not a claim about the final artifact state. */
  state: PostgameMatchProjectionDto["finalState"];
  /** Prefix-consistent server-owned narrative ledger for this replay frame. */
  werewolfReviewLedger: WerewolfPostgameEventLedgerDto;
  replay: {
    ok: true;
    replayedSteps: number;
    replayedBatches: number;
    rejectedSteps: number;
  };
}

export type MatchArtifactViewDto = MatchArtifact | PostgameMatchProjectionDto;

export function projectSocialNetwork(source: {
  projection: PostgameMatchProjectionDto["projection"];
  agents: RedactedAgentStateDto[];
  socialEpisode: Pick<RedactedSocialEpisodeDto, "messages" | "exposureRecords">;
}): SocialNetworkProjectionDto {
  const nodes = new Map<string, SocialNetworkNodeDto>();
  const sentMessageIds = new Map<string, Set<string>>();
  const receivedMessageIds = new Map<string, Set<string>>();
  const observedMessageIds = new Map<string, Set<string>>();
  const ensureNode = (id: string, agent?: RedactedAgentStateDto): SocialNetworkNodeDto => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const node: SocialNetworkNodeDto = {
      id,
      profileId: agent?.profileId,
      policyName: agent?.policyName,
      sentMessageCount: 0,
      deliveryCount: 0,
      receivedMessageCount: 0,
      observedMessageCount: 0,
      observationCount: 0,
      relationshipCount: 0
    };
    nodes.set(id, node);
    return node;
  };

  const relationshipEdges: SocialNetworkRelationshipEdgeDto[] = [];
  for (const agent of source.agents) {
    const owner = ensureNode(agent.playerId, agent);
    const edges = agent.social?.relationships.edges ?? {};
    for (const [targetKey, edge] of Object.entries(edges)) {
      const targetId = edge.targetId || targetKey;
      ensureNode(targetId);
      owner.relationshipCount += 1;
      relationshipEdges.push({
        id: socialNetworkEdgeKey("relationship", [agent.playerId, targetId]),
        sourceId: agent.playerId,
        targetId,
        trust: edge.trust,
        suspicion: edge.suspicion,
        affinity: edge.affinity,
        influence: edge.influence,
        debt: edge.debt,
        respect: edge.respect,
        threat: edge.threat,
        evidenceRefs: edge.evidenceRefs.map((ref) => ({
          artifact: ref.artifact,
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId
        })),
        updatedAt: edge.updatedAt
      });
    }
  }

  const communication = new Map<
    string,
    SocialNetworkCommunicationEdgeDto & { messageSeqSet: Set<number> }
  >();
  for (const message of source.socialEpisode.messages) {
    const sender = ensureNode(message.senderId);
    const senderMessages = sentMessageIds.get(message.senderId) ?? new Set<string>();
    senderMessages.add(message.id);
    sentMessageIds.set(message.senderId, senderMessages);
    const recipientIds = [...new Set(message.recipientIds.filter((recipientId) => recipientId !== message.senderId))];
    sender.deliveryCount += recipientIds.length;
    for (const recipientId of recipientIds) {
      ensureNode(recipientId);
      const recipientMessages = receivedMessageIds.get(recipientId) ?? new Set<string>();
      recipientMessages.add(message.id);
      receivedMessageIds.set(recipientId, recipientMessages);
      const key = socialNetworkEdgeKey("communication", [message.senderId, recipientId, message.channelId, message.visibility]);
      const edge = communication.get(key) ?? {
        id: key,
        sourceId: message.senderId,
        targetId: recipientId,
        channelId: message.channelId,
        visibility: message.visibility,
        messageCount: 0,
        messageSeqs: [],
        messageSeqSet: new Set<number>()
      };
      edge.messageSeqSet.add(message.seq);
      communication.set(key, edge);
    }
  }

  const exposure = new Map<
    string,
    SocialNetworkExposureEdgeDto & {
      messageRefMap: Map<string, { id: string; seq: number }>;
      actionKindSet: Set<string>;
      traceIdSet: Set<string>;
      turnIndexSet: Set<number>;
    }
  >();
  for (const record of source.socialEpisode.exposureRecords ?? []) {
    ensureNode(record.sourceId);
    const observer = ensureNode(record.observerId);
    observer.observationCount += 1;
    const observerMessages = observedMessageIds.get(record.observerId) ?? new Set<string>();
    observerMessages.add(record.messageId);
    observedMessageIds.set(record.observerId, observerMessages);
    const key = socialNetworkEdgeKey("exposure", [record.sourceId, record.observerId, record.channelId, record.visibility, record.kind ?? ""]);
    const edge = exposure.get(key) ?? {
      id: key,
      sourceId: record.sourceId,
      targetId: record.observerId,
      channelId: record.channelId,
      visibility: record.visibility,
      kind: record.kind,
      uniqueMessageCount: 0,
      observationCount: 0,
      messageRefs: [],
      actionKinds: [],
      traceIds: [],
      turnIndexes: [],
      evidenceCount: 0,
      messageRefMap: new Map<string, { id: string; seq: number }>(),
      actionKindSet: new Set<string>(),
      traceIdSet: new Set<string>(),
      turnIndexSet: new Set<number>()
    };
    edge.messageRefMap.set(record.messageId, { id: record.messageId, seq: record.messageSeq });
    edge.actionKindSet.add(record.observedAtActionKind);
    edge.traceIdSet.add(record.observedAtTraceId);
    edge.turnIndexSet.add(record.observedAtTurnIndex);
    edge.observationCount += 1;
    edge.evidenceCount += record.evidenceRefs.length;
    exposure.set(key, edge);
  }

  for (const node of nodes.values()) {
    node.sentMessageCount = sentMessageIds.get(node.id)?.size ?? 0;
    node.receivedMessageCount = receivedMessageIds.get(node.id)?.size ?? 0;
    node.observedMessageCount = observedMessageIds.get(node.id)?.size ?? 0;
  }

  const communicationEdges = [...communication.values()].map((edge) => ({
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    channelId: edge.channelId,
    visibility: edge.visibility,
    messageCount: edge.messageSeqSet.size,
    messageSeqs: [...edge.messageSeqSet].sort((left, right) => left - right)
  }));
  const exposureEdges = [...exposure.values()].map((edge) => ({
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    channelId: edge.channelId,
    visibility: edge.visibility,
    kind: edge.kind,
    uniqueMessageCount: edge.messageRefMap.size,
    observationCount: edge.observationCount,
    messageRefs: [...edge.messageRefMap.values()].sort((left, right) => left.seq - right.seq),
    actionKinds: [...edge.actionKindSet].sort(),
    traceIds: [...edge.traceIdSet].sort(),
    turnIndexes: [...edge.turnIndexSet].sort((left, right) => left - right),
    evidenceCount: edge.evidenceCount
  }));

  const truthRedacted = source.projection.view === "truth-redacted";
  return {
    artifactVersion: "server.social-network-projection.v1",
    kind: "social-network-projection",
    authority: "server-owned-match-artifact",
    scope: "final-agent-snapshot",
    projection: { ...source.projection },
    modes: {
      relationships: {
        available: !truthRedacted && source.agents.length > 0,
        recordCount: relationshipEdges.length,
        reason: truthRedacted ? "当前公开投影不提供 Agent 主观关系状态。" : undefined
      },
      communication: {
        available: !truthRedacted,
        recordCount: communicationEdges.length,
        reason:
          truthRedacted && communicationEdges.length === 0
            ? "当前公开投影不提供消息收件路由。"
            : undefined
      },
      exposure: {
        available: !truthRedacted && Array.isArray(source.socialEpisode.exposureRecords),
        recordCount: exposureEdges.length,
        reason: truthRedacted ? "当前公开投影不提供 scoped observation 证据。" : undefined
      }
    },
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    relationshipEdges: relationshipEdges.sort((left, right) => left.id.localeCompare(right.id)),
    communicationEdges: communicationEdges.sort((left, right) => left.id.localeCompare(right.id)),
    exposureEdges: exposureEdges.sort((left, right) => left.id.localeCompare(right.id))
  };
}

function socialNetworkEdgeKey(kind: "relationship" | "communication" | "exposure", parts: readonly string[]): string {
  return JSON.stringify([kind, ...parts]);
}
