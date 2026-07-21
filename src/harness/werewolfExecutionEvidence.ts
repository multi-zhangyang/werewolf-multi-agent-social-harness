import type { SocialEpisodeArtifact, SocialHarnessStep } from "./social";
import type { HarnessTurnTrace, PolicyPlan, ReasonerOutputSummary } from "./types";

/**
 * Legacy Werewolf decision-envelope marker. It remains stable so existing
 * match artifacts and checkpoints can be decoded without migration.
 */
export const WEREWOLF_HARNESS_TURN_METADATA_KIND = "werewolf-harness-turn" as const;

/**
 * Werewolf's compatibility projection of a native social action into the
 * historical harness trace schema. This is deliberately domain-owned: its
 * policy, command, and trace fields are not a generic runner contract.
 */
export interface WerewolfHarnessTurnActionMetadata {
  kind: typeof WEREWOLF_HARNESS_TURN_METADATA_KIND;
  turnIndex?: number;
  policyPlan: PolicyPlan;
  reasonerOutput: ReasonerOutputSummary;
  turnTrace: HarnessTurnTrace;
  agentStateHash?: string;
}

export interface WerewolfHarnessTurnEvidence {
  traceId: string;
  actorId: string;
  turnIndex: number;
  step: SocialHarnessStep;
  trace: HarnessTurnTrace;
}

/**
 * Decode Werewolf's legacy trace envelope from a native social episode.
 * This intentionally includes rejected steps: provider usage and proposed
 * decision evidence remain auditable even when the environment rejects them.
 */
export function werewolfHarnessTurnEvidenceFromEpisode(episode: unknown): WerewolfHarnessTurnEvidence[] {
  const seenCognitionTraceIds = new Set<string>();
  return socialSteps(episode).flatMap((step) => {
    const metadata = record(step.action?.metadata);
    if (!metadata || metadata.kind !== WEREWOLF_HARNESS_TURN_METADATA_KIND) return [];
    const trace = record(metadata.turnTrace);
    if (!isHarnessTurnTrace(trace)) return [];
    const harnessTrace = trace as unknown as HarnessTurnTrace;
    const traceId = harnessTrace.traceId;
    // AEC batch-abort records intentionally preserve the peer's proposal so
    // native evidence and rejected actor receipts stay symmetric. That peer
    // already completed one cognition pass, however; it is not a second model
    // call. Deduplicate the compatibility trace projection by its reasoner
    // trace identity while retaining both native social steps in the episode.
    if (seenCognitionTraceIds.has(traceId)) return [];
    seenCognitionTraceIds.add(traceId);
    return [
      {
        traceId: step.traceId,
        actorId: step.actorId,
        turnIndex: step.turnIndex,
        step,
        trace: harnessTrace
      }
    ];
  });
}

export function parseWerewolfHarnessTurnActionMetadata(metadata: unknown, traceId: string): WerewolfHarnessTurnActionMetadata {
  if (!isRecord(metadata) || metadata.kind !== WEREWOLF_HARNESS_TURN_METADATA_KIND) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing werewolf harness metadata.`);
  }
  if (!isRecord(metadata.policyPlan)) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing policyPlan metadata.`);
  }
  if (!isRecord(metadata.reasonerOutput)) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing reasonerOutput metadata.`);
  }
  if (!isRecord(metadata.turnTrace)) {
    throw new Error(`Cannot project Werewolf social step ${traceId}: missing turnTrace metadata.`);
  }
  return {
    kind: WEREWOLF_HARNESS_TURN_METADATA_KIND,
    turnIndex: typeof metadata.turnIndex === "number" ? metadata.turnIndex : undefined,
    policyPlan: metadata.policyPlan as unknown as PolicyPlan,
    reasonerOutput: metadata.reasonerOutput as unknown as ReasonerOutputSummary,
    turnTrace: metadata.turnTrace as unknown as HarnessTurnTrace,
    agentStateHash: typeof metadata.agentStateHash === "string" ? metadata.agentStateHash : undefined
  };
}

export function tryParseWerewolfHarnessTurnActionMetadata(
  metadata: unknown,
  traceId?: string
): WerewolfHarnessTurnActionMetadata | undefined {
  try {
    return parseWerewolfHarnessTurnActionMetadata(metadata, traceId ?? "unknown-trace");
  } catch {
    return undefined;
  }
}

function socialSteps(value: unknown): SocialHarnessStep[] {
  const episode = record(value) as Partial<SocialEpisodeArtifact> | undefined;
  return Array.isArray(episode?.steps) ? episode.steps : [];
}

function isHarnessTurnTrace(value: Record<string, unknown> | undefined): boolean {
  return Boolean(
    value &&
      typeof value.traceId === "string" &&
      typeof value.playerId === "string" &&
      typeof value.model === "string" &&
      typeof value.actionKind === "string" &&
      typeof value.commandType === "string"
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
