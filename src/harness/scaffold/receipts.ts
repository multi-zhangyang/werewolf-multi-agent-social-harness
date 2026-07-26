import type { SocialActorObservationContext, SocialActorStepReceipt } from "../social";
import {
  appendSocialMemory,
  retrieveMemoryContext,
  REFLECTION_RECORD_VERSION,
  type AgentSocialState,
  type EvidenceRef,
  type ReflectionKind,
  type ReflectionRecord,
  type SocialStateMutationContext
} from "../socialState";
import { cloneJson, finiteNumber } from "./internals";
import type {
  AgentScaffoldState,
  ReceiptReflectionDraft,
  ReceiptReflectionInput,
  ReceiptReflectionPolicy
} from "./types";

export function createDeterministicReceiptReflectionPolicy<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>
>(): ReceiptReflectionPolicy<TObservation, TPending, TCommand, TAgentState> {
  return {
    id: "deterministic-receipt-reflection-v1",
    reflect: () => ({
      kind: "memory_summary",
      content: "Reviewed the committed environment outcome and retained its evidence for later decisions.",
      confidence: 1
    })
  };
}

/**
 * Domain-neutral bridge for actors whose canonical private state is not the
 * default {@link AgentScaffoldState}. The scaffold still owns transaction
 * staging, candidate/arbitration sequencing, and receipt-gated replacement;
 * the adapter only reduces and records its single serializable domain state.
 */

/**
 * Environment outcome feedback is actor-private state, but never a second
 * source of domain truth. Keep only receipt facts and coarse info shape here:
 * the environment owns the original `info` object and the recorded step.
 */
/**
 * Record only closed, committed environment feedback in an actor's private
 * social state. Compatibility adapters use this same reducer so legacy and
 * scaffold execution retain one agent-lifecycle contract.
 */
export function recordCommittedReceiptOutcome<TSocialObservation, TReceiptObservation, TPending, TCommand>(
  social: AgentSocialState<TSocialObservation, TPending, TCommand>,
  receipt: SocialActorStepReceipt<TReceiptObservation, TPending, TCommand>,
  context?: SocialStateMutationContext
): void {
  if (receipt.status !== "committed") {
    throw new Error("Cannot record environment outcome from a non-committed receipt.");
  }
  const infoValues = Object.values(receipt.info ?? {});
  appendSocialMemory(
    social,
    {
      kind: "outcome",
      source: "environment",
      visibility: "private",
      pendingAction: cloneJson(receipt.pendingAction),
      content: "Committed environment receipt.",
      salience: receipt.terminated || receipt.truncated ? 0.9 : 0.65,
      importance: receipt.terminated || receipt.truncated ? 0.9 : 0.65,
      evidenceRefs: [
        {
          artifact: "outcome",
          id: receipt.id,
          traceId: receipt.traceId,
          description: "committed-receipt"
        }
      ],
      tags: [
        "receipt-feedback",
        "environment-committed",
        ...(receipt.terminated ? ["terminated"] : []),
        ...(receipt.truncated ? ["truncated"] : [])
      ],
      metadata: {
        version: "harness.committed-receipt.v1",
        status: "committed",
        transactionId: receipt.transactionId,
        turnIndex: receipt.turnIndex,
        reward: finiteNumber(receipt.reward),
        terminated: Boolean(receipt.terminated),
        truncated: Boolean(receipt.truncated),
        hasInfo: receipt.info !== undefined,
        infoFieldCount: infoValues.length,
        infoValueKinds: summarizeValueKinds(infoValues),
        postStateHash: receipt.postStateHash,
        eventSeqRange: cloneJson(receipt.eventSeqRange),
        messageSeqRange: cloneJson(receipt.messageSeqRange)
      }
    },
    context ?? receiptMutationContext(receipt)
  );
}

export function recordCommittedReceiptReflection<
  TSocialObservation,
  TReceiptObservation,
  TPending,
  TCommand,
  TAgentState
>(input: {
  agentId: string;
  state: TAgentState;
  social: AgentSocialState<TSocialObservation, TPending, TCommand>;
  receipt: SocialActorStepReceipt<TReceiptObservation, TPending, TCommand>;
  policy: ReceiptReflectionPolicy<TSocialObservation, TPending, TCommand, TAgentState>;
  cloneState: (state: TAgentState) => TAgentState;
}): ReflectionRecord | undefined {
  if (input.receipt.status !== "committed") return undefined;
  const context = receiptMutationContext(input.receipt);
  const recall = retrieveMemoryContext(input.social.memory, {
    actorId: input.agentId,
    traceId: input.receipt.traceId,
    limit: 6
  });
  let draft: ReceiptReflectionDraft | undefined;
  try {
    const candidate = input.policy.reflect(cloneJson({
      agent: input.cloneState(input.state),
      social: cloneJson(input.social),
      receipt: {
        id: input.receipt.id,
        traceId: input.receipt.traceId,
        transactionId: input.receipt.transactionId,
        turnIndex: input.receipt.turnIndex,
        actorId: input.receipt.actorId,
        pendingAction: cloneJson(input.receipt.pendingAction),
        reward: finiteNumber(input.receipt.reward),
        terminated: Boolean(input.receipt.terminated),
        truncated: Boolean(input.receipt.truncated),
        postStateHash: input.receipt.postStateHash,
        eventSeqRange: cloneJson(input.receipt.eventSeqRange),
        messageSeqRange: cloneJson(input.receipt.messageSeqRange)
      },
      memoryRetrieval: cloneJson(recall.evidence),
      recalledMemory: cloneJson(recall.entries)
    }));
    if (isThenable(candidate)) {
      throw new Error("Receipt reflection policies must be synchronous.");
    }
    draft = candidate;
  } catch {
    throw new Error(`Receipt reflection policy ${input.policy.id} failed at the safe policy boundary.`);
  }
  if (!draft) return undefined;
  validateReceiptReflectionDraft(draft, input.policy.id);
  const evidenceRefs: EvidenceRef[] = [{
    artifact: "outcome",
    id: input.receipt.id,
    traceId: input.receipt.traceId,
    description: "receipt-reflection"
  }];
  const record: ReflectionRecord = {
    version: REFLECTION_RECORD_VERSION,
    id: `${input.agentId}:reflection:${input.receipt.traceId}`,
    agentId: input.agentId,
    createdAtTurn: input.receipt.turnIndex,
    kind: draft.kind,
    content: draft.content,
    evidenceRefs,
    confidence: draft.confidence,
    visibility: "private",
    source: "policy"
  };
  appendSocialMemory(input.social, {
    kind: "reflection",
    source: record.source,
    visibility: record.visibility,
    reflection: record,
    content: record.content,
    salience: 0.6,
    importance: 0.6,
    evidenceRefs,
    tags: ["receipt-reflection", record.kind],
    metadata: {
      version: "harness.receipt-reflection.v1",
      policyId: input.policy.id,
      receiptId: input.receipt.id,
      traceId: input.receipt.traceId,
      memoryRetrieval: cloneJson(recall.evidence)
    }
  }, context);
  return cloneJson(record);
}

export function validateReceiptReflectionDraft(draft: ReceiptReflectionDraft, policyId: string): void {
  const kinds: ReflectionKind[] = ["memory_summary", "belief_revision", "strategy_update", "social_risk", "goal_revision"];
  if (!kinds.includes(draft.kind)) throw new Error(`Receipt reflection policy ${policyId} returned an invalid kind.`);
  if (typeof draft.content !== "string" || !draft.content.trim()) {
    throw new Error(`Receipt reflection policy ${policyId} returned empty content.`);
  }
  if (typeof draft.confidence !== "number" || !Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
    throw new Error(`Receipt reflection policy ${policyId} returned confidence outside [0, 1].`);
  }
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof (value as { then?: unknown }).then === "function";
}

export function receiptMutationContext<TObservation, TPending, TCommand>(
  receipt: SocialActorStepReceipt<TObservation, TPending, TCommand>
): SocialStateMutationContext {
  return {
    traceId: receipt.traceId,
    turnIndex: receipt.turnIndex,
    phase: stringField(receipt.pendingAction, "phase"),
    day: numberField(receipt.pendingAction, "day"),
    eventSeqRange: socialMutationRange(receipt.eventSeqRange),
    messageSeqRange: socialMutationRange(receipt.messageSeqRange)
  };
}

export function socialMutationRange(range: [number, number] | undefined): { start: number; end: number } | undefined {
  return range ? { start: range[0], end: range[1] } : undefined;
}

export function summarizeValueKinds(values: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function scaffoldMutationContext<TPending>(context?: SocialActorObservationContext<TPending>): SocialStateMutationContext | undefined {
  if (!context) return undefined;
  return {
    traceId: context.traceId,
    turnIndex: context.actorTurnIndex ?? context.turnIndex,
    phase: stringField(context.pendingAction, "phase"),
    day: numberField(context.pendingAction, "day")
  };
}

export function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

export function numberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : undefined;
}
