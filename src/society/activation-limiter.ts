/**
 * Cross-room provider backpressure (多房间并发 / 提供商限流 / Agent 级背压).
 *
 * Every agent turn in every room competes for a process-wide bounded pool of
 * concurrent provider activations. A turn acquires a permit before calling
 * the model and releases it when the turn settles (success, failure or
 * abort), so N rooms × M players can never fan out more than the configured
 * concurrency at once. This is pure backpressure — it never changes what an
 * agent sees or decides, only when its call is placed.
 *
 * When no limiter is provided (embedded / single-room use), rooms run exactly
 * as before: unbounded parallel activations within the room.
 */
export class ActivationLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("ActivationLimiter requires a positive integer concurrency.");
    }
  }

  /**
   * Acquire a permit, waiting in FIFO order if the pool is full. Resolves to
   * a release function that must be called exactly once when the activation
   * settles. Throws `ACTIVATION_ABORTED` when the given signal aborts first.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.active >= this.maxConcurrent) {
      if (signal?.aborted) throw activationAborted();
      await new Promise<void>((resolve) => {
        const release = (): void => {
          const index = this.waiting.indexOf(release);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve();
        };
        this.waiting.push(release);
        signal?.addEventListener("abort", release, { once: true });
      });
    }
    if (signal?.aborted) throw activationAborted();
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }

  /** Activations currently holding a permit. */
  concurrency(): number {
    return this.active;
  }

  /** Activations queued behind the pool. */
  pending(): number {
    return this.waiting.length;
  }
}

function activationAborted(): Error {
  const error = new Error("ACTIVATION_ABORTED: The room stopped while the activation waited for a provider slot.");
  (error as Error & { code?: string }).code = "ACTIVATION_ABORTED";
  return error;
}

/** Read the shared pool size from the environment (default 8). */
export function limiterFromEnv(env: NodeJS.ProcessEnv = process.env): ActivationLimiter {
  const value = Number(env.SOCIETY_MAX_CONCURRENT_ACTIVATIONS);
  const size = Number.isInteger(value) && value >= 1 && value <= 128 ? value : 8;
  return new ActivationLimiter(size);
}