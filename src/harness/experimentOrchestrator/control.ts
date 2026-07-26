import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
  type HarnessExperimentRunCurrentEpisodeV3,
  type HarnessExperimentRunRecordV3
} from "../experimentRunStore";
import type { TournamentEpisodeContext } from "../tournamentRunner";
import type { GenericExperimentAttemptIdentity } from "./types";

export function requireDurableAttemptIdentity(
  value: unknown,
  context: TournamentEpisodeContext
): GenericExperimentAttemptIdentity {
  const current = requireV3CurrentEpisode(value, context);
  if (current.phase !== "started") throw new Error("Durable retry authority did not return a started attempt.");
  return { ordinal: current.ordinal, attemptId: current.attemptId };
}

export function requireDurableRetryWait(
  value: unknown,
  context: TournamentEpisodeContext
): Extract<HarnessExperimentRunCurrentEpisodeV3, { phase: "retry-wait" }> {
  const current = requireV3CurrentEpisode(value, context);
  if (current.phase !== "retry-wait") throw new Error("Durable retry authority did not return retry-wait state.");
  return current;
}

export function requireV3CurrentEpisode(
  value: unknown,
  context: TournamentEpisodeContext
): HarnessExperimentRunCurrentEpisodeV3 {
  const record = value as Partial<HarnessExperimentRunRecordV3> | undefined;
  if (
    !record || record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 ||
    record.state !== "active" || !record.currentEpisode ||
    record.currentEpisode.index !== context.index || record.currentEpisode.seed !== context.seed
  ) throw new Error("Durable retry authority returned an invalid episode attempt record.");
  return structuredClone(record.currentEpisode);
}

export async function waitForRetryEligibility(eligibleAt: string, signal: AbortSignal): Promise<void> {
  const timestamp = Date.parse(eligibleAt);
  if (!Number.isFinite(timestamp)) throw new Error("Durable retry eligibility timestamp is invalid.");
  throwIfAborted(signal);
  const delay = Math.max(0, timestamp - Date.now());
  if (delay === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Generic experiment execution was aborted.")));
    timer = setTimeout(() => finish(resolve), Math.min(delay, 2_147_483_647));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (Date.now() < timestamp) await waitForRetryEligibility(eligibleAt, signal);
}

export function timestampAtOrAfter(candidate: string, floor: string): string {
  const candidateTime = Date.parse(candidate);
  const floorTime = Date.parse(floor);
  if (!Number.isFinite(candidateTime) || !Number.isFinite(floorTime)) {
    throw new Error("Experiment retry timestamp is invalid.");
  }
  return new Date(Math.max(candidateTime, floorTime)).toISOString();
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Generic experiment execution was aborted.");
}

export function awaitWithAbort<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Generic experiment execution was aborted."));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Generic experiment execution was aborted.")));
    signal.addEventListener("abort", onAbort, { once: true });
    let result: T | Promise<T>;
    try {
      result = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

export function createExperimentDeadline(external: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(new Error("Generic experiment run deadline reached.")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", abortFromExternal);
    }
  };
}
