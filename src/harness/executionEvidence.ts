import type { SocialEpisodeArtifact, SocialHarnessStep, SocialStepFailureEvidence } from "./social";
import type { HarnessErrorPayload } from "./types";

export interface HarnessFailureEvidence {
  traceId: string;
  actorId: string;
  turnIndex: number;
  step: SocialHarnessStep;
  failure: SocialStepFailureEvidence;
  payload?: HarnessErrorPayload;
}

export function harnessFailureEvidenceFromEpisode(episode: unknown): HarnessFailureEvidence[] {
  return socialSteps(episode).flatMap((step) => {
    if (!step.failure && !step.error) return [];
    const failure = step.failure ?? {
      stage: "unknown",
      message: step.error ?? "Unknown harness failure"
    };
    // A batch-aborted step is retained in the native artifact so its staged
    // proposal and rejected receipt remain auditable. It is a consequence of
    // another root failure, however, and must not inflate provider/harness
    // error counts, leaderboards, or failure summaries.
    if (failure.stage === "batch_aborted") return [];
    const payload = harnessErrorPayload(failure.metadata);
    return [
      {
        traceId: step.traceId,
        actorId: step.actorId,
        turnIndex: step.turnIndex,
        step,
        failure,
        payload
      }
    ];
  });
}

function socialSteps(value: unknown): SocialHarnessStep[] {
  const episode = record(value) as Partial<SocialEpisodeArtifact> | undefined;
  return Array.isArray(episode?.steps) ? episode.steps : [];
}

function harnessErrorPayload(value: unknown): HarnessErrorPayload | undefined {
  const payload = record(value);
  if (!payload) return undefined;
  if (typeof payload.model !== "string" || typeof payload.actionKind !== "string") return undefined;
  if (typeof payload.message !== "string" || typeof payload.traceId !== "string") return undefined;
  return payload as unknown as HarnessErrorPayload;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
