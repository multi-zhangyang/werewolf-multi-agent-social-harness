import path from "node:path";
import {
  HarnessEpisodeArtifactStore,
  HarnessExperimentRunStore,
  buildHarnessCheckpointAtPrefix,
  replaySocialEpisode,
  runForkedHarnessEpisode,
  runGenericExperiment,
  runHarnessEpisode,
  validateHarnessCheckpointEnvelope,
  verifyHarnessEpisodeArtifact,
  type GenericExperimentSpecV1,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope,
  type SocialAction,
  type SocialActor,
  type SocialAssignmentActorResolution,
  type SocialChannel,
  type SocialDomainAdapterManifest,
  type SocialEnvironment,
  type SocialEpisodeArtifact,
  type SocialMessage
} from "../harness/generic";
import { runEvaluationRegistry, type HarnessEvaluator } from "../harness/evaluation";
import { hashStableState } from "../harness/hash";

export const SEALED_BID_AUCTION_DOMAIN_ID = "sealed-bid-auction";
export const SEALED_BID_AUCTION_EXECUTION_MODE = "policy-only" as const;
export const SEALED_BID_AUCTION_EVALUATOR_ID = "sealed-bid-auction.outcome.v1";
export const SEALED_BID_AUCTION_PUBLIC_CHANNEL_ID = "sealed-bid-auction.public";

export type AuctionActorId = "alpha" | "beta";
export type AuctionPolicyId = "auction.policy.truthful.v1" | "auction.policy.shade-one.v1";

export interface AuctionRoundResult {
  round: number;
  itemId: string;
  bids: Record<AuctionActorId, number>;
  winnerId: AuctionActorId;
  winningBid: number;
  winnerValue: number;
  utility: number;
}

export interface SealedBidAuctionState {
  schemaVersion: "sealed-bid-auction.state.v1";
  actorIds: AuctionActorId[];
  round: number;
  itemIds: string[];
  done: boolean;
  privateValues: Record<AuctionActorId, number[]>;
  results: AuctionRoundResult[];
  utilities: Record<AuctionActorId, number>;
}

export interface AuctionPendingAction {
  actorId: AuctionActorId;
  kind: "submit_bid";
  round: number;
  itemId: string;
}

export interface AuctionPublicRoundResult {
  round: number;
  itemId: string;
  bids: Record<AuctionActorId, number>;
  winnerId: AuctionActorId;
  winningBid: number;
}

export interface AuctionObservation {
  actorId: AuctionActorId;
  round: number;
  itemId: string;
  privateValue: number;
  ownUtility: number;
  publicResults: AuctionPublicRoundResult[];
  visibleMessages: SocialMessage[];
  channels: SocialChannel[];
}

export interface AuctionCommand {
  actorId: AuctionActorId;
  type: "submit_bid";
  round: number;
  itemId: string;
  bid: number;
}

export interface AuctionBidReceipt {
  round: number;
  itemId: string;
  bid: number;
  traceId: string;
}

export interface AuctionActorState {
  schemaVersion: "sealed-bid-auction.actor-state.v1";
  actorId: AuctionActorId;
  policyId: AuctionPolicyId;
  executionMode: typeof SEALED_BID_AUCTION_EXECUTION_MODE;
  committedRounds: number;
  bidHistory: AuctionBidReceipt[];
}

export type SealedBidAuctionSocialEpisode = SocialEpisodeArtifact<
  SealedBidAuctionState,
  AuctionObservation,
  AuctionPendingAction,
  AuctionCommand
>;

type AuctionActorStepReceipt = Parameters<
  NonNullable<SocialActor<AuctionObservation, AuctionPendingAction, AuctionCommand>["onStepResult"]>
>[0];

export type SealedBidAuctionArtifact = HarnessEpisodeArtifactEnvelope<
  SealedBidAuctionState,
  AuctionObservation,
  AuctionPendingAction,
  AuctionCommand,
  AuctionActorState
>;

export type SealedBidAuctionCheckpoint = HarnessCheckpointEnvelope<
  SealedBidAuctionState,
  AuctionActorState,
  AuctionObservation,
  AuctionPendingAction,
  AuctionCommand
>;

export interface SealedBidAuctionEpisodeResult {
  socialEpisode: SealedBidAuctionSocialEpisode;
  agents: AuctionActorState[];
}

const AUCTION_ACTOR_IDS: readonly AuctionActorId[] = ["alpha", "beta"];
const AUCTION_POLICY_BY_ACTOR: Readonly<Record<AuctionActorId, AuctionPolicyId>> = {
  alpha: "auction.policy.truthful.v1",
  beta: "auction.policy.shade-one.v1"
};

export const SEALED_BID_AUCTION_DOMAIN_ADAPTER: SocialDomainAdapterManifest = {
  schemaVersion: "harness.domain-adapter.v1",
  domainId: SEALED_BID_AUCTION_DOMAIN_ID,
  adapterId: "sealed-bid-auction.social",
  adapterVersion: "1",
  semanticHash: hashStableState({
    domain: SEALED_BID_AUCTION_DOMAIN_ID,
    version: 1,
    rules: "two-round first-price sealed bid; parallel atomic resolution; alternating deterministic tie break"
  }),
  components: [
    {
      kind: "agent_state_schema",
      id: "sealed-bid-auction.actor-state",
      version: "1",
      semanticHash: hashStableState({ fields: ["actorId", "policyId", "committedRounds", "bidHistory"] })
    },
    {
      kind: "command_codec",
      id: "sealed-bid-auction.submit-bid",
      version: "1",
      semanticHash: hashStableState({ type: "submit_bid", bid: "integer:0..10" })
    },
    {
      kind: "environment",
      id: "sealed-bid-auction.first-price",
      version: "1",
      semanticHash: hashStableState({ rounds: 2, atomic: true, tieBreak: "alternating-actor-order" })
    },
    {
      kind: "observation_projection",
      id: "sealed-bid-auction.private-value",
      version: "1",
      semanticHash: hashStableState({ ownCurrentValue: true, opponentValues: false, priorResults: "public" })
    },
    {
      kind: "scheduler",
      id: "sealed-bid-auction.parallel-round",
      version: "1",
      semanticHash: hashStableState({ mode: "parallel", completeActorSet: AUCTION_ACTOR_IDS })
    }
  ]
};

export const SEALED_BID_AUCTION_PUBLIC_CHANNEL: SocialChannel = {
  id: SEALED_BID_AUCTION_PUBLIC_CHANNEL_ID,
  kind: "public",
  participantIds: [...AUCTION_ACTOR_IDS],
  readableBy: "all"
};

/**
 * Domain truth is derived deterministically from the experiment seed. The
 * values are canonical environment state, but only one actor's current value
 * crosses the observation boundary.
 */
export function createSealedBidAuctionInitialState(seed: string): SealedBidAuctionState {
  if (!seed.trim()) throw new Error("Sealed-bid auction seed must be nonempty.");
  const digest = hashStableState({ domain: SEALED_BID_AUCTION_DOMAIN_ID, seed });
  const values = [0, 2, 4, 6].map((offset) => (Number.parseInt(digest.slice(offset, offset + 2), 16) % 10) + 1);
  return {
    schemaVersion: "sealed-bid-auction.state.v1",
    actorIds: [...AUCTION_ACTOR_IDS],
    round: 0,
    itemIds: ["artifact", "bandwidth"],
    done: false,
    privateValues: {
      alpha: [values[0]!, values[1]!],
      beta: [values[2]!, values[3]!]
    },
    results: [],
    utilities: { alpha: 0, beta: 0 }
  };
}

export class SealedBidAuctionEnvironment
  implements SocialEnvironment<SealedBidAuctionState, AuctionObservation, AuctionPendingAction, AuctionCommand>
{
  private state: SealedBidAuctionState;

  constructor(initialState: SealedBidAuctionState) {
    assertAuctionState(initialState);
    this.state = structuredClone(initialState);
  }

  snapshot(): SealedBidAuctionState {
    return structuredClone(this.state);
  }

  restore(snapshot: SealedBidAuctionState): void {
    assertAuctionState(snapshot);
    this.state = structuredClone(snapshot);
  }

  pendingActions(): AuctionPendingAction[] {
    if (this.state.done) return [];
    const itemId = this.state.itemIds[this.state.round];
    if (!itemId) throw new Error(`Auction round ${this.state.round} has no item.`);
    return this.state.actorIds.map((actorId) => ({
      actorId,
      kind: "submit_bid",
      round: this.state.round,
      itemId
    }));
  }

  observe(actorId: string, pending: AuctionPendingAction): AuctionObservation {
    assertActorId(actorId);
    if (pending.actorId !== actorId || pending.round !== this.state.round) {
      throw new Error(`Auction pending action does not belong to ${actorId}.`);
    }
    const privateValue = this.state.privateValues[actorId][this.state.round];
    if (privateValue === undefined) throw new Error(`Auction private value is missing for ${actorId}.`);
    return {
      actorId,
      round: this.state.round,
      itemId: pending.itemId,
      privateValue,
      ownUtility: this.state.utilities[actorId],
      publicResults: this.state.results.map(({ winnerValue: _winnerValue, utility: _utility, ...result }) =>
        structuredClone(result)
      ),
      visibleMessages: [],
      channels: []
    };
  }

  validateAction(command: AuctionCommand, pending: AuctionPendingAction) {
    const valid =
      command.type === "submit_bid" &&
      command.actorId === pending.actorId &&
      command.round === pending.round &&
      command.itemId === pending.itemId &&
      Number.isInteger(command.bid) &&
      command.bid >= 0 &&
      command.bid <= 10;
    return valid
      ? { valid: true }
      : {
          valid: false,
          code: "invalid_auction_bid",
          message: "Auction bid must match the pending actor/round/item and be an integer from 0 to 10."
        };
  }

  step(): SealedBidAuctionState {
    throw new Error("Sealed-bid auction rounds require one atomic stepBatch().");
  }

  stepBatch(commandsByAgent: Record<string, AuctionCommand>): SealedBidAuctionState {
    if (this.state.done) throw new Error("Sealed-bid auction is already complete.");
    const actorIds = Object.keys(commandsByAgent).sort();
    if (actorIds.join(",") !== [...AUCTION_ACTOR_IDS].sort().join(",")) {
      throw new Error("Sealed-bid auction requires one command from every actor in the parallel batch.");
    }
    const pendingByActor = new Map(this.pendingActions().map((pending) => [pending.actorId, pending]));
    for (const actorId of AUCTION_ACTOR_IDS) {
      const command = commandsByAgent[actorId];
      const pending = pendingByActor.get(actorId);
      if (!command || !pending || !this.validateAction(command, pending).valid) {
        throw new Error(`Sealed-bid auction received an invalid command for ${actorId}.`);
      }
    }

    const next = structuredClone(this.state);
    const round = next.round;
    const alphaBid = commandsByAgent.alpha!.bid;
    const betaBid = commandsByAgent.beta!.bid;
    const winnerId = resolveWinner(round, alphaBid, betaBid);
    const winningBid = commandsByAgent[winnerId]!.bid;
    const winnerValue = next.privateValues[winnerId][round]!;
    const utility = winnerValue - winningBid;
    next.results.push({
      round,
      itemId: next.itemIds[round]!,
      bids: { alpha: alphaBid, beta: betaBid },
      winnerId,
      winningBid,
      winnerValue,
      utility
    });
    next.utilities[winnerId] += utility;
    next.round += 1;
    next.done = next.round >= next.itemIds.length;
    this.state = next;
    return this.snapshot();
  }

  done(): boolean {
    return this.state.done;
  }
}

export class SealedBidAuctionPolicyActor implements SocialActor<AuctionObservation, AuctionPendingAction, AuctionCommand> {
  readonly id: AuctionActorId;
  readonly profile;
  private state: AuctionActorState;
  private currentObservation?: AuctionObservation;
  private currentTraceId?: string;

  constructor(actorId: AuctionActorId, policyId: AuctionPolicyId, restoredState?: AuctionActorState) {
    this.id = actorId;
    this.profile = {
      id: `sealed-bid-auction.profile.${actorId}`,
      version: "1",
      model: SEALED_BID_AUCTION_EXECUTION_MODE,
      policyId,
      metadata: { executionMode: SEALED_BID_AUCTION_EXECUTION_MODE }
    };
    this.state = restoredState
      ? validateAndCloneActorState(restoredState, actorId, policyId)
      : {
          schemaVersion: "sealed-bid-auction.actor-state.v1",
          actorId,
          policyId,
          executionMode: SEALED_BID_AUCTION_EXECUTION_MODE,
          committedRounds: 0,
          bidHistory: []
        };
  }

  observe(observation: AuctionObservation, context?: Parameters<SocialActor<AuctionObservation, AuctionPendingAction, AuctionCommand>["observe"]>[1]): void {
    if (observation.actorId !== this.id) throw new Error(`Auction actor ${this.id} received another actor's observation.`);
    this.currentObservation = structuredClone(observation);
    this.currentTraceId = context?.traceId;
  }

  decide(pending: AuctionPendingAction): SocialAction<AuctionCommand> {
    const observation = this.currentObservation;
    if (!observation || observation.actorId !== pending.actorId || observation.round !== pending.round) {
      throw new Error(`Auction actor ${this.id} cannot decide before its scoped observation.`);
    }
    const bid = this.state.policyId === "auction.policy.truthful.v1"
      ? observation.privateValue
      : Math.max(0, observation.privateValue - 1);
    const traceId = this.currentTraceId;
    return {
      actorId: this.id,
      kind: "submit_bid",
      command: {
        actorId: this.id,
        type: "submit_bid",
        round: pending.round,
        itemId: pending.itemId,
        bid
      },
      messages: [
        {
          channelId: SEALED_BID_AUCTION_PUBLIC_CHANNEL_ID,
          senderId: this.id,
          recipientIds: [],
          visibility: "public",
          content: `${this.id} submitted bid ${bid} for ${pending.itemId}.`,
          metadata: {
            ...(traceId ? { traceId } : {}),
            round: pending.round,
            itemId: pending.itemId,
            executionMode: SEALED_BID_AUCTION_EXECUTION_MODE
          }
        }
      ],
      metadata: {
        executionMode: SEALED_BID_AUCTION_EXECUTION_MODE,
        policyId: this.state.policyId
      }
    };
  }

  onStepResult(receipt: AuctionActorStepReceipt): void {
    if (receipt.actorId !== this.id || receipt.status !== "committed" || !receipt.action) return;
    const command = receipt.action.command;
    this.state.bidHistory.push({
      round: command.round,
      itemId: command.itemId,
      bid: command.bid,
      traceId: receipt.traceId
    });
    this.state.committedRounds = this.state.bidHistory.length;
  }

  snapshot(): AuctionActorState {
    return structuredClone(this.state);
  }
}

export async function runSealedBidAuctionEpisode(options: {
  id: string;
  initialState: SealedBidAuctionState;
  maxTransitions?: number;
  decisionTimeoutMs?: number;
  restoredAgentStates?: AuctionActorState[];
}): Promise<SealedBidAuctionEpisodeResult> {
  const actors = createAuctionActors(options.restoredAgentStates);
  const socialEpisode = await runHarnessEpisode<
    SealedBidAuctionState,
    AuctionObservation,
    AuctionPendingAction,
    AuctionCommand,
    AuctionActorState
  >({
    id: options.id,
    domainId: SEALED_BID_AUCTION_DOMAIN_ID,
    domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
    environment: new SealedBidAuctionEnvironment(options.initialState),
    actors,
    channels: [SEALED_BID_AUCTION_PUBLIC_CHANNEL],
    schedulerMode: "parallel",
    maxTransitions: options.maxTransitions ?? 4,
    executionLimits: { decisionTimeoutMs: options.decisionTimeoutMs ?? 1_000 },
    assembleObservation({ environmentObservation, visibleSocial }) {
      return {
        ...environmentObservation,
        visibleMessages: visibleSocial.messages,
        channels: visibleSocial.channels
      };
    },
    hashState: hashStableState,
    hashMessages: hashStableState,
    captureAgentSnapshots: () => actors.map((actor) => actor.snapshot())
  });
  return { socialEpisode, agents: actors.map((actor) => actor.snapshot()) };
}

export function createSealedBidAuctionArtifact(
  episode: SealedBidAuctionEpisodeResult,
  createdAt = "2026-07-23T00:00:00.000Z"
): SealedBidAuctionArtifact {
  return {
    artifactVersion: "sealed-bid-auction.episode.v1",
    kind: "sealed-bid-auction-episode",
    runId: episode.socialEpisode.id,
    createdAt,
    status: episode.socialEpisode.status,
    initialState: structuredClone(episode.socialEpisode.initialState),
    finalState: structuredClone(episode.socialEpisode.finalState),
    socialEpisode: structuredClone(episode.socialEpisode),
    agents: structuredClone(episode.agents)
  };
}

export function replaySealedBidAuctionEpisode(episode: SealedBidAuctionSocialEpisode) {
  return replaySocialEpisode<
    SealedBidAuctionState,
    AuctionObservation,
    AuctionPendingAction,
    AuctionCommand,
    AuctionActorState
  >({
    episode,
    environment: new SealedBidAuctionEnvironment(episode.initialState),
    domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
    hashState: hashStableState,
    hashMessages: hashStableState,
    validateRecordedStep: validateRecordedAuctionStep,
    validateRecordedAgentState: validateRecordedAuctionAgentState
  });
}

export function verifySealedBidAuctionArtifact(artifact: SealedBidAuctionArtifact) {
  return verifyHarnessEpisodeArtifact({
    artifact,
    runtime: {
      domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
      createEnvironment: (initialState) => new SealedBidAuctionEnvironment(initialState),
      hashState: hashStableState,
      hashMessages: hashStableState,
      validateRecordedStep: validateRecordedAuctionStep,
      recordedAgentState: { mode: "validate", validator: validateRecordedAuctionAgentState }
    }
  });
}

export function buildSealedBidAuctionCheckpoint(
  artifact: SealedBidAuctionArtifact,
  nativeStepCount: number
): SealedBidAuctionCheckpoint {
  return buildHarnessCheckpointAtPrefix({
    artifactVersion: "sealed-bid-auction.checkpoint.v1",
    kind: "sealed-bid-auction-checkpoint",
    checkpointId: `${artifact.runId}:checkpoint:native:${nativeStepCount}`,
    createdAt: artifact.createdAt,
    reason: "sealed-bid auction native parallel boundary",
    sourceArtifactVersion: artifact.artifactVersion,
    runId: artifact.runId,
    sourceStatus: artifact.status,
    episode: artifact.socialEpisode,
    selector: { nativeStepCount },
    experiment: artifact.experiment,
    recordedAgentState: {
      mode: "validate",
      validator({ agents, step }) {
        return validateCheckpointAgentStates(agents, step.action.command.round + 1);
      }
    },
    replayPrefix(executionPrefix) {
      const replay = replaySocialEpisode<
        SealedBidAuctionState,
        AuctionObservation,
        AuctionPendingAction,
        AuctionCommand,
        AuctionActorState
      >({
        episode: executionPrefix,
        environment: new SealedBidAuctionEnvironment(executionPrefix.initialState),
        domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateExpectedFinalState: false,
        validateRecordedStep: validateRecordedAuctionStep,
        validateRecordedAgentState: validateRecordedAuctionAgentState
      });
      return {
        mismatches: replay.mismatches,
        finalState: replay.finalState,
        finalHash: replay.finalHash,
        messagesHash: replay.messagesHash
      };
    }
  });
}

export async function forkSealedBidAuctionFromCheckpoint(options: {
  checkpoint: SealedBidAuctionCheckpoint;
  childRunId: string;
  reason?: string;
}) {
  return runForkedHarnessEpisode({
    checkpoint: options.checkpoint,
    createdAt: "2026-07-23T00:00:00.000Z",
    reason: options.reason ?? "continue sealed-bid auction from recorded round boundary",
    runtime: {
      domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
      createEnvironment: (initialState) => new SealedBidAuctionEnvironment(initialState),
      restoreActors: (states) => createAuctionActors(states),
      captureAgentSnapshots: (actors) => actors.map((actor) => {
        if (!(actor instanceof SealedBidAuctionPolicyActor)) {
          throw new Error("Sealed-bid auction fork restored an incompatible actor.");
        }
        return actor.snapshot();
      }),
      recordedAgentState: {
        mode: "validate",
        validator(checkpoint) {
          return validateCheckpointAgentStates(checkpoint.agents, checkpoint.state.round);
        }
      }
    },
    verifyCheckpointReplay(checkpoint) {
      return replaySocialEpisode<
        SealedBidAuctionState,
        AuctionObservation,
        AuctionPendingAction,
        AuctionCommand,
        AuctionActorState
      >({
        episode: checkpoint.executionPrefix,
        environment: new SealedBidAuctionEnvironment(checkpoint.executionPrefix.initialState),
        domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
        hashState: hashStableState,
        hashMessages: hashStableState,
        validateRecordedStep: validateRecordedAuctionStep,
        validateRecordedAgentState: validateRecordedAuctionAgentState
      }).mismatches;
    },
    validateCheckpoint(checkpoint) {
      const errors = validateHarnessCheckpointEnvelope(checkpoint);
      if (checkpoint.state.done) errors.push("Sealed-bid auction fork checkpoint must have a remaining round.");
      return errors;
    },
    episode: {
      id: options.childRunId,
      domainId: SEALED_BID_AUCTION_DOMAIN_ID,
      domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
      schedulerMode: "parallel",
      maxTransitions: 2,
      executionLimits: { decisionTimeoutMs: 1_000 },
      assembleObservation({ environmentObservation, visibleSocial }) {
        return {
          ...environmentObservation,
          visibleMessages: visibleSocial.messages,
          channels: visibleSocial.channels
        };
      },
      hashState: hashStableState,
      hashMessages: hashStableState
    }
  });
}

export const SEALED_BID_AUCTION_EVALUATOR: HarnessEvaluator<
  SealedBidAuctionState,
  undefined,
  SealedBidAuctionSocialEpisode,
  { allocativeEfficiency: number; utilities: Record<AuctionActorId, number> },
  AuctionActorState,
  never
> = {
  id: SEALED_BID_AUCTION_EVALUATOR_ID,
  label: "Sealed-bid auction deterministic outcome",
  version: "1",
  manifest: {
    inputSchema: "sealed-bid-auction.evaluation-context.v1",
    outputSchema: "sealed-bid-auction.outcome.v1",
    mode: "deterministic",
    metricIds: ["auction.allocative_efficiency", "agent.auction_utility", "auction.policy_only_execution"],
    rubric: "Scores allocation efficiency and actor utility from committed auction state; no model judge or actor self-report.",
    dependencies: { finalState: "canonical sealed-bid auction state" },
    aggregation: "episode efficiency and utility by actor",
    visibility: "postgame"
  },
  evaluate(context) {
    const finalState = context.finalState;
    const maximumValue = finalState.itemIds.reduce(
      (total, _item, round) => total + Math.max(...AUCTION_ACTOR_IDS.map((actorId) => finalState.privateValues[actorId][round]!)),
      0
    );
    const allocatedValue = finalState.results.reduce((total, result) => total + result.winnerValue, 0);
    const efficiency = maximumValue === 0 ? 0 : allocatedValue / maximumValue;
    const stateEvidence = [{ artifact: "state" as const, description: "canonical final auction state" }];
    return {
      evaluatorId: SEALED_BID_AUCTION_EVALUATOR_ID,
      label: "Sealed-bid auction deterministic outcome",
      version: "1",
      metrics: [
        {
          id: "auction.allocative_efficiency",
          label: "Allocative efficiency",
          scope: "episode",
          value: efficiency,
          denominator: maximumValue,
          unit: "ratio",
          higherIsBetter: true,
          weight: 1,
          source: SEALED_BID_AUCTION_EVALUATOR_ID,
          evidenceRefs: stateEvidence
        },
        ...AUCTION_ACTOR_IDS.map((actorId) => ({
          id: "agent.auction_utility",
          label: "Auction utility",
          scope: "agent" as const,
          subjectId: actorId,
          value: finalState.utilities[actorId],
          higherIsBetter: true,
          weight: 1,
          source: SEALED_BID_AUCTION_EVALUATOR_ID,
          evidenceRefs: stateEvidence
        })),
        {
          id: "auction.policy_only_execution",
          label: "Policy-only execution",
          scope: "episode",
          value: true,
          weight: 0,
          source: SEALED_BID_AUCTION_EVALUATOR_ID,
          evidenceRefs: [{ artifact: "state", description: "actor snapshots declare executionMode=policy-only" }]
        }
      ],
      output: {
        allocativeEfficiency: efficiency,
        utilities: structuredClone(finalState.utilities)
      }
    };
  }
};

export function createSealedBidAuctionExperimentSpec(options: {
  id?: string;
  seed?: string;
  checkpointMode?: "none" | "final" | "native-boundaries";
} = {}): GenericExperimentSpecV1 {
  return {
    version: "harness.experiment.v1",
    id: options.id ?? "sealed-bid-auction-example",
    kind: "episode",
    domainId: SEALED_BID_AUCTION_DOMAIN_ID,
    domainAdapter: SEALED_BID_AUCTION_DOMAIN_ADAPTER,
    seed: options.seed ?? "sealed-bid-auction-example-seed",
    episodeCount: 1,
    actorCount: 2,
    schedulerMode: "parallel",
    profiles: AUCTION_ACTOR_IDS.map((actorId) => ({
      id: `sealed-bid-auction.profile.${actorId}`,
      version: "1",
      policyId: AUCTION_POLICY_BY_ACTOR[actorId]
    })),
    modelAssignments: [],
    assignmentPolicy: {
      id: "sealed-bid-auction.assignment.fixed",
      version: "1",
      configuration: { actors: [...AUCTION_ACTOR_IDS] }
    },
    maxTransitions: 4,
    timeoutPolicy: {
      id: "sealed-bid-auction.timeout.local-policy",
      version: "1",
      runTimeoutMs: 10_000,
      decisionTimeoutMs: 1_000
    },
    retryPolicy: { id: "sealed-bid-auction.retry.none", version: "1", maxAttempts: 1 },
    evaluatorIds: [SEALED_BID_AUCTION_EVALUATOR_ID],
    artifactPolicy: { id: "sealed-bid-auction.artifact.research", version: "1", visibility: "research-full" },
    checkpointPolicy: {
      id: "sealed-bid-auction.checkpoint.native",
      version: "1",
      mode: options.checkpointMode ?? "native-boundaries"
    },
    continueOnError: false,
    domainConfig: {
      executionMode: SEALED_BID_AUCTION_EXECUTION_MODE,
      auctionFormat: "two-round-first-price-sealed-bid"
    }
  };
}

/**
 * Developer-facing vertical slice over the existing durable experiment,
 * artifact, checkpoint, replay, and evaluator authorities. It never reads env
 * or constructs a provider/model client.
 */
export async function runSealedBidAuctionExperiment(options: {
  baseDirectory: string;
  id?: string;
  seed?: string;
}) {
  const spec = createSealedBidAuctionExperimentSpec({ id: options.id, seed: options.seed });
  const episodeDirectory = path.join(options.baseDirectory, "episodes");
  const runDirectory = path.join(options.baseDirectory, "experiment-runs");
  const episodeStore = await HarnessEpisodeArtifactStore.open<SealedBidAuctionArtifact, SealedBidAuctionCheckpoint>({
    baseDirectory: episodeDirectory,
    verifyArtifact: verifySealedBidAuctionArtifact,
    verifyCheckpoint(checkpoint) {
      const mismatches = validateHarnessCheckpointEnvelope(checkpoint);
      return { ok: mismatches.length === 0, mismatches };
    }
  });
  const runStore = await HarnessExperimentRunStore.open<SealedBidAuctionArtifact>({
    baseDirectory: runDirectory,
    episodeStore
  });
  const execution = await runGenericExperiment({
    spec,
    artifactStore: episodeStore,
    runStore,
    adapter: {
      domainId: SEALED_BID_AUCTION_DOMAIN_ID,
      prepareEpisode(context) {
        return {
          runId: `${context.spec.id}:${context.seed}`,
          initialState: createSealedBidAuctionInitialState(context.seed)
        };
      },
      runEpisode(prepared, context) {
        return runSealedBidAuctionEpisode({
          id: prepared.runId,
          initialState: prepared.initialState,
          maxTransitions: context.spec.maxTransitions,
          decisionTimeoutMs: context.spec.timeoutPolicy.decisionTimeoutMs
        });
      },
      lifecycleOf: (result) => result.socialEpisode.status,
      artifactForEpisode: (result) => createSealedBidAuctionArtifact(result),
      assignmentResolutionForEpisode(_result, artifact): SocialAssignmentActorResolution[] {
        return (artifact.socialEpisode.runtimeActors ?? []).map((actor) => ({
          actorId: actor.actorId,
          profileId: actor.profileId,
          model: actor.model,
          domain: {
            executionMode: SEALED_BID_AUCTION_EXECUTION_MODE,
            auctionPolicy: AUCTION_POLICY_BY_ACTOR[actor.actorId as AuctionActorId]
          }
        }));
      },
      checkpointing: {
        nativeCheckpointForArtifactBoundary(artifact, boundary) {
          return buildSealedBidAuctionCheckpoint(artifact, boundary.nativeStepCount);
        }
      },
      evaluation: {
        evaluators: [SEALED_BID_AUCTION_EVALUATOR],
        contextForEpisode(result, artifact) {
          return {
            id: artifact.runId,
            status: artifact.status,
            initialState: artifact.initialState,
            finalState: artifact.finalState,
            agents: artifact.agents,
            trajectory: [] as never[],
            socialEpisode: result.socialEpisode
          };
        }
      }
    }
  });
  return { execution, episodeStore, directories: { episodes: episodeDirectory, runs: runDirectory } };
}

export function evaluateSealedBidAuctionArtifact(artifact: SealedBidAuctionArtifact) {
  return runEvaluationRegistry({
    id: `${artifact.runId}:evaluation`,
    context: {
      id: artifact.runId,
      status: artifact.status,
      initialState: artifact.initialState,
      finalState: artifact.finalState,
      agents: artifact.agents,
      trajectory: [] as never[],
      socialEpisode: artifact.socialEpisode
    },
    evaluators: [SEALED_BID_AUCTION_EVALUATOR],
    createdAt: artifact.createdAt
  });
}

function createAuctionActors(restoredStates?: AuctionActorState[]): SealedBidAuctionPolicyActor[] {
  const stateByActor = new Map((restoredStates ?? []).map((state) => [state.actorId, state]));
  if (restoredStates && stateByActor.size !== AUCTION_ACTOR_IDS.length) {
    throw new Error("Sealed-bid auction restoration requires exactly one durable state per actor.");
  }
  return AUCTION_ACTOR_IDS.map((actorId) =>
    new SealedBidAuctionPolicyActor(actorId, AUCTION_POLICY_BY_ACTOR[actorId], stateByActor.get(actorId))
  );
}

function resolveWinner(round: number, alphaBid: number, betaBid: number): AuctionActorId {
  if (alphaBid > betaBid) return "alpha";
  if (betaBid > alphaBid) return "beta";
  return round % 2 === 0 ? "alpha" : "beta";
}

function validateRecordedAuctionStep(
  step: SealedBidAuctionSocialEpisode["steps"][number],
  context: {
    state: SealedBidAuctionState;
    pendingActions: readonly AuctionPendingAction[];
  }
): readonly string[] {
  const command = step.action.command;
  const pending = context.pendingActions.find((candidate) => candidate.actorId === step.actorId);
  const errors: string[] = [];
  if (!pending) errors.push(`recorded actor ${step.actorId} was not pending`);
  if (command.actorId !== step.actorId) errors.push(`recorded command actor ${command.actorId} does not match ${step.actorId}`);
  if (command.round !== context.state.round) errors.push(`recorded round ${command.round} does not match state round ${context.state.round}`);
  if (pending && command.itemId !== pending.itemId) errors.push(`recorded item ${command.itemId} does not match ${pending.itemId}`);
  return errors;
}

function validateRecordedAuctionAgentState(input: {
  recordedAgents: readonly AuctionActorState[];
  stateAfter: SealedBidAuctionState;
}): readonly string[] {
  return validateCheckpointAgentStates(input.recordedAgents, input.stateAfter.round);
}

function validateCheckpointAgentStates(states: readonly AuctionActorState[], expectedRounds: number): string[] {
  const errors: string[] = [];
  if (states.length !== AUCTION_ACTOR_IDS.length) errors.push("auction durable state must contain exactly two actors");
  const actorIds = states.map((state) => state.actorId).sort();
  if (actorIds.join(",") !== [...AUCTION_ACTOR_IDS].sort().join(",")) errors.push("auction durable actor roster mismatch");
  for (const state of states) {
    if (state.executionMode !== SEALED_BID_AUCTION_EXECUTION_MODE) errors.push(`${state.actorId} execution mode is not policy-only`);
    if (state.policyId !== AUCTION_POLICY_BY_ACTOR[state.actorId]) errors.push(`${state.actorId} policy identity mismatch`);
    if (state.committedRounds !== expectedRounds || state.bidHistory.length !== expectedRounds) {
      errors.push(`${state.actorId} durable bid history does not match committed round ${expectedRounds}`);
    }
  }
  return errors;
}

function validateAndCloneActorState(
  state: AuctionActorState,
  actorId: AuctionActorId,
  policyId: AuctionPolicyId
): AuctionActorState {
  const valid =
    state.schemaVersion === "sealed-bid-auction.actor-state.v1" &&
    state.actorId === actorId &&
    state.policyId === policyId &&
    state.executionMode === SEALED_BID_AUCTION_EXECUTION_MODE &&
    Number.isInteger(state.committedRounds) &&
    state.committedRounds >= 0 &&
    state.committedRounds <= 2 &&
    state.bidHistory.length === state.committedRounds &&
    state.bidHistory.every(
      (receipt, round) =>
        receipt.round === round &&
        typeof receipt.itemId === "string" &&
        receipt.itemId.length > 0 &&
        Number.isInteger(receipt.bid) &&
        receipt.bid >= 0 &&
        receipt.bid <= 10 &&
        typeof receipt.traceId === "string" &&
        receipt.traceId.length > 0
    );
  if (!valid) {
    throw new Error(`Invalid restored auction actor state for ${actorId}.`);
  }
  return structuredClone(state);
}

function assertActorId(actorId: string): asserts actorId is AuctionActorId {
  if (!AUCTION_ACTOR_IDS.includes(actorId as AuctionActorId)) throw new Error(`Unknown sealed-bid auction actor ${actorId}.`);
}

function assertAuctionState(state: SealedBidAuctionState): void {
  if (state.schemaVersion !== "sealed-bid-auction.state.v1") throw new Error("Unsupported sealed-bid auction state schema.");
  if (state.actorIds.join(",") !== AUCTION_ACTOR_IDS.join(",")) throw new Error("Sealed-bid auction actor roster is invalid.");
  if (state.itemIds.length !== 2) throw new Error("Sealed-bid auction requires exactly two rounds.");
  if (!Number.isInteger(state.round) || state.round < 0 || state.round > state.itemIds.length) {
    throw new Error("Sealed-bid auction round is invalid.");
  }
  for (const actorId of AUCTION_ACTOR_IDS) {
    const values = state.privateValues[actorId];
    if (values.length !== state.itemIds.length || values.some((value) => !Number.isInteger(value) || value < 1 || value > 10)) {
      throw new Error(`Sealed-bid auction private values are invalid for ${actorId}.`);
    }
  }
}
