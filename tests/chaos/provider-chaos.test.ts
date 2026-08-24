/**
 * Provider chaos checks (AGENTS.md §19.8): seeded fuzzing of the room
 * lifecycle against a provider that randomly delays, hangs forever or goes
 * silent — the worst real-world peer. Invariants pinned per seed:
 *
 *  - the shared permit pool is never exceeded, even mid-hang;
 *  - a local timeout never releases a permit before the request settles;
 *  - the room always lands in finished or paused, never silently wedged.
 *
 * Fully deterministic (fixed seeds), offline, no real provider.
 */
import { describe, expect, it } from "vitest";
import { ScriptedModel, modelResponse } from "@openai/agents/testing";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { clearFastTurns, errorMessage, installFastTurns, lastEvents, roomError, sleep, testRoom, twoRoundScript, waitFor } from "../helpers/scripted-room";

/** Deterministic 32-bit PRNG so every CI run replays the same chaos. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Serves the deterministic two-round script through a real ScriptedModel, but
 * per call it may delay before delegating, and after the response it may hang
 * forever (ignoring abort) — a provider that delivered content but never
 * terminated the stream.
 */
class ChaosModel implements Model {
  private readonly inner: ScriptedModel;
  private readonly hooks: Array<() => void> = [];

  constructor(
    script: Array<ReturnType<typeof modelResponse>>,
    private readonly rng: () => number
  ) {
    this.inner = new ScriptedModel(script);
  }

  releaseAll(): void {
    const hooks = this.hooks.splice(0);
    for (const hook of hooks) hook();
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("UNEXPECTED_NON_STREAMING_CALL: the runner should always stream in these tests.");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.rng() < 0.35) await sleep(Math.floor(this.rng() * 120));
    yield* this.inner.getStreamedResponse(request);
    if (this.rng() < 0.25) {
      await new Promise<void>((resolve) => {
        this.hooks.push(resolve);
      });
    }
  }
}

async function runSeed(seed: number): Promise<void> {
  const rng = mulberry32(seed);
  const model = new ChaosModel(twoRoundScript(), rng);
  const limiter = new ActivationLimiter(1);
  installFastTurns();
  const { room, cleanup } = testRoom(model, limiter);
  let maxConcurrency = 0;
  try {
    void room.start();
    const deadline = Date.now() + 8_000;
    while (room.currentStatus() === "running" && Date.now() < deadline) {
      maxConcurrency = Math.max(maxConcurrency, limiter.concurrency());
      await sleep(20);
    }
    maxConcurrency = Math.max(maxConcurrency, limiter.concurrency());
    const status = room.currentStatus();
    const context = `seed=${seed} status=${status} error=${roomError(room) ?? "none"} events=${lastEvents(room, 8).join(" | ")} abandoned=${room.abandonedInFlight()}`;
    expect(status === "finished" || status === "paused", `room must land, not wedge: ${context}`).toBe(true);
    // The pool of size 1 is never exceeded, even while a request hangs.
    expect(maxConcurrency, `permit pool exceeded mid-hang: ${context}`).toBeLessThanOrEqual(1);

    if (status === "paused") {
      // Whatever the room gave up on is still in flight and holds its permit.
      model.releaseAll();
      await waitFor(() => limiter.concurrency() === 0, 2_000).catch((error) => {
        throw new Error(`${errorMessage(error)}; ${context}`);
      });
      expect(limiter.concurrency(), `lease released after settle: ${context}`).toBe(0);
    } else {
      expect(room.abandonedInFlight(), `no abandoned turns after a clean finish: ${context}`).toBe(0);
      const snapshot = room.snapshotForViewer({ mode: "omniscient" });
      const history = snapshot.world.details.history as Array<unknown> | undefined;
      expect(history && history.length >= 1, `a finished room settled at least one round: ${context}`).toBe(true);
    }
  } finally {
    model.releaseAll();
    clearFastTurns();
    cleanup();
  }
}

describe("provider chaos (§19.8)", () => {
  it("seeded fuzz: permits, lease and status survive random provider chaos", async () => {
    for (const seed of [1, 7, 13, 21, 42, 99, 137, 202]) {
      await runSeed(seed);
    }
  });
});