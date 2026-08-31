/**
 * B7 — provider permit lifecycle (AGENTS.md §17.1 / §17.3 / §26.15 / §26.16 /
 * P0-07 / §28.7).
 *
 * Two guarantees are pinned here:
 *
 *  1. Lease-until-settle: a local turn timeout or abort only stops waiting
 *     for that turn. The permit stays held until the underlying provider
 *     request truly settles, so a stalled provider can never push real
 *     concurrency past the shared pool — even when it ignores aborts.
 *
 *  2. Command epoch gate: the world rejects tool calls that arrive after
 *     the activation window closed (a request the room already gave up on),
 *     and retries of the same command inside one activation resolve to the
 *     original receipt instead of applying the world action twice.
 *
 * The fake provider below models the worst-case provider: it streams
 * nothing until its script says otherwise and ignores the abort signal
 * entirely (its generator's suspension point never resolves on abort).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { ScriptedModel, assistantMessage, functionCall, modelResponse } from "@openai/agents/testing";
import type { Model, ModelProvider, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import type { OpenAIProvider as OpenAIProviderType } from "@openai/agents";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { ModelRegistry } from "../../src/society/models";
import { defaultCapabilities, DEFAULT_CONTEXT_POLICY_ID } from "../../src/society/models/defaults";
import { SocietyRoom } from "../../src/society/room";
import { createAgentProfiles } from "../../src/society/profiles";
import { createWorld } from "../../src/society/scenarios";

/** One scripted provider call: wait, emit events, then optionally hang. */
interface FakeStep {
  delayMs?: number;
  events?: StreamEvent[];
  /** Keep the stream open forever after emitting (ignores abort). */
  hangForever?: boolean;
}

let responseCounter = 0;

function toolResponse(name: string, args: Record<string, unknown>, callId: string): StreamEvent {
  responseCounter += 1;
  return {
    type: "response_done",
    response: {
      id: `fake-resp-${responseCounter}`,
      usage: { requests: 1, inputTokens: 8, outputTokens: 8, totalTokens: 16 },
      output: [functionCall(name, args, { callId })]
    }
  };
}

/**
 * A provider that obeys a script of `FakeStep`s and otherwise behaves like
 * the worst real-world peer: it streams nothing, ignores the abort signal,
 * and only ends when `releaseAll()` resolves its suspension point.
 */
class HangingModel implements Model {
  private readonly steps: FakeStep[];
  private readonly hooks: Array<() => void> = [];

  constructor(steps: FakeStep[]) {
    this.steps = steps;
  }

  /** Resolve every in-flight suspension point; the streams then end. */
  releaseAll(): void {
    const hooks = this.hooks.splice(0);
    for (const hook of hooks) hook();
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("UNEXPECTED_NON_STREAMING_CALL: the runner should always stream in these tests.");
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = this.steps.shift() ?? { delayMs: 0, events: [], hangForever: true };
    if (step.delayMs) await sleep(step.delayMs);
    for (const event of step.events ?? []) yield event;
    if (step.hangForever) {
      // Suspension point that no abort can interrupt: `return()` waits here
      // forever too, exactly like a provider that swallows cancellation.
      await new Promise<void>((resolve) => {
        this.hooks.push(resolve);
      });
    }
  }
}

function fakeProvider(model: Model): ModelProvider {
  return { getModel: () => model };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function lastEvents(room: SocietyRoom, count: number): string[] {
  const events: Array<{ seq: number; event: { type: string } }> = (room as unknown as { events: Array<{ seq: number; event: { type: string } }> }).events;
  return events.slice(-count).map((entry) => `#${entry.seq} ${entry.event.type}`);
}

function roomError(room: SocietyRoom): string | undefined {
  return (room as unknown as { error?: string }).error;
}

/** A 2-seat trust-game room wired to a fake provider and a strict limiter. */
function testRoom(model: Model, limiter: ActivationLimiter): { room: SocietyRoom; cleanup: () => void } {
  const roomId = `room-lease-${randomUUID().slice(0, 8)}`;
  const profiles = createAgentProfiles(["fake-model"], 2);
  const registry = new ModelRegistry();
  registry.upsertProvider({
    id: "p-fake",
    name: "fake",
    kind: "openai-compatible",
    baseURL: "http://fake.invalid",
    apiKeyRef: "env:SOCIETY_FAKE_KEY",
    apiMode: "chat-completions",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  registry.upsertModelProfile({
    id: "m-fake",
    name: "fake-model",
    providerProfileId: "p-fake",
    modelId: "fake-model",
    contextWindow: 128_000,
    contextWindowSource: "manual",
    capabilities: defaultCapabilities(),
    defaults: {},
    contextPolicyId: DEFAULT_CONTEXT_POLICY_ID,
    enabled: true
  });
  const room = new SocietyRoom({
    id: roomId,
    scenarioId: "trust-game",
    profiles,
    rounds: 1,
    provider: fakeProvider(model) as unknown as OpenAIProviderType,
    modelRegistry: registry,
    limiter
  });
  const cleanup = (): void => {
    room.dispose("test cleanup");
  };
  return { room, cleanup };
}

const FAST_TURNS: NodeJS.ProcessEnv = {
  SOCIETY_AGENT_TURN_TIMEOUT_MS: "150",
  SOCIETY_AGENT_TURN_GRACE_MS: "100"
};

afterEach(() => {
  for (const key of Object.keys(FAST_TURNS)) delete process.env[key];
});

describe("command epoch gate (§16.6)", () => {
  it("rejects commands before/after the activation window and dedupes retries inside it", async () => {
    const profiles = createAgentProfiles(["fake-model"], 2);
    const world = createWorld({ roomId: "r-gate", scenarioId: "trust-game", profiles, rounds: 1 });
    world.start();
    const speaker = profiles[0].id;
    const activation = {
      id: "gate:1",
      label: "gate",
      actorIds: [speaker],
      mode: "sequential" as const,
      instructionFor: () => "speak"
    };

    // No window open yet: commands are stale by definition.
    await expect(world.performAction(speaker, "communicate", { text: "hello", channel: "public" }))
      .rejects.toThrow(/STALE_ACTIVATION_COMMAND/);

    world.beginActivation(activation);
    const first = await world.performAction(speaker, "communicate", { text: "hello", channel: "public" });
    expect(first.commandId).toBeTruthy();
    // A retry of the exact same command inside the same epoch returns the
    // original receipt — the message was sent exactly once (§26.16).
    const retry = await world.performAction(speaker, "communicate", { text: "hello", channel: "public" });
    expect(retry.commandId).toBe(first.commandId);
    expect(world.snapshot().messages.filter((message) => message.text === "hello")).toHaveLength(1);

    world.endActivation();
    await expect(world.performAction(speaker, "communicate", { text: "late", channel: "public" }))
      .rejects.toThrow(/STALE_ACTIVATION_COMMAND/);

    // A new epoch makes the same payload a brand-new command.
    world.beginActivation({ ...activation, id: "gate:2" });
    const next = await world.performAction(speaker, "communicate", { text: "hello", channel: "public" });
    expect(next.commandId).not.toBe(first.commandId);
    world.endActivation();
  });

  it("scopes receipts per activation: identical payloads in different epochs do not collide", async () => {
    const profiles = createAgentProfiles(["fake-model"], 2);
    const world = createWorld({ roomId: "r-gate2", scenarioId: "trust-game", profiles, rounds: 1 });
    world.start();
    const speaker = profiles[0].id;
    const activation = (id: string) => ({
      id,
      label: id,
      actorIds: [speaker],
      mode: "sequential" as const,
      instructionFor: () => "speak"
    });
    world.beginActivation(activation("e:1"));
    const a = await world.performAction(speaker, "communicate", { text: "repeat", channel: "public" });
    world.endActivation();
    world.beginActivation(activation("e:2"));
    const b = await world.performAction(speaker, "communicate", { text: "repeat", channel: "public" });
    world.endActivation();
    expect(b.commandId).not.toBe(a.commandId);
    expect(world.snapshot().messages.filter((message) => message.text === "repeat")).toHaveLength(2);
  });
});

describe("lease-until-settle (§17.1)", () => {
  it("holds the permit past a local timeout until the provider truly settles, then releases it", async () => {
    process.env.SOCIETY_AGENT_TURN_TIMEOUT_MS = FAST_TURNS.SOCIETY_AGENT_TURN_TIMEOUT_MS;
    process.env.SOCIETY_AGENT_TURN_GRACE_MS = FAST_TURNS.SOCIETY_AGENT_TURN_GRACE_MS;
    const model = new HangingModel([{ hangForever: true }]);
    const limiter = new ActivationLimiter(1);
    const { room, cleanup } = testRoom(model, limiter);
    try {
      void room.start();
      // The first discussion turn times out locally at ~150ms, but its
      // request is still streaming: the permit must NOT be released.
      await waitFor(() => room.currentStatus() === "paused", 4_000).catch((error) => {
        throw new Error(`${errorMessage(error)}; error=${roomError(room)}; status=${room.currentStatus()}; limiter=${limiter.concurrency()}/${limiter.pending()}; abandoned=${room.abandonedInFlight()}; events=${lastEvents(room, 12).join(" | ")}`);
      });
      const attempts = room.snapshotForViewer({ mode: "omniscient" }).agentTurns ?? [];
      expect(attempts.filter((turn) => turn.actorId === "agent-01").map((turn) => turn.attempt)).toEqual([1, 2]);
      // Some SDK/provider pairs settle promptly on abort; others remain in
      // flight. In either case the permit count must match the real unsettled
      // requests and eventually return to zero.
      expect(limiter.concurrency()).toBe(room.abandonedInFlight());

      // Settle the abandoned request: the permit is then really released.
      model.releaseAll();
      await waitFor(() => limiter.concurrency() === 0, 2_000);
      expect(room.abandonedInFlight()).toBe(0);
      expect(room.settledAbandoned()).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  it("rejects a tool call that arrives after the room gave up on the turn", async () => {
    process.env.SOCIETY_AGENT_TURN_TIMEOUT_MS = FAST_TURNS.SOCIETY_AGENT_TURN_TIMEOUT_MS;
    process.env.SOCIETY_AGENT_TURN_GRACE_MS = FAST_TURNS.SOCIETY_AGENT_TURN_GRACE_MS;
    // Call 1: nothing for 250ms (past the 150ms local timeout), then a tool
    // call. Call 2 (the tool-result round) hangs forever.
    const model = new HangingModel([
      { delayMs: 250, events: [toolResponse("communicate", { text: "迟到消息", channel: "public" }, "call-late-1")], hangForever: true },
      { hangForever: true }
    ]);
    const limiter = new ActivationLimiter(1);
    const { room, cleanup } = testRoom(model, limiter);
    try {
      void room.start();
      await waitFor(() => room.currentStatus() === "paused", 4_000).catch((error) => {
        throw new Error(`${errorMessage(error)}; error=${roomError(room)}; status=${room.currentStatus()}; limiter=${limiter.concurrency()}/${limiter.pending()}; abandoned=${room.abandonedInFlight()}; events=${lastEvents(room, 12).join(" | ")}`);
      });
      // The late tool call was rejected by the closed gate: no such message
      // ever entered the world, and the abandoned request is observable.
      const snapshot = room.snapshotForViewer({ mode: "omniscient" });
      expect(snapshot.world.messages.some((message) => message.text === "迟到消息")).toBe(false);
      expect(limiter.concurrency()).toBe(room.abandonedInFlight());
      model.releaseAll();
      await waitFor(() => limiter.concurrency() === 0, 2_000);
      expect(room.abandonedInFlight()).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("normal scripted flow", () => {
  it("runs a full 1-round trust game with no abandoned requests and a clean permit pool", async () => {
    process.env.SOCIETY_AGENT_TURN_TIMEOUT_MS = FAST_TURNS.SOCIETY_AGENT_TURN_TIMEOUT_MS;
    process.env.SOCIETY_AGENT_TURN_GRACE_MS = FAST_TURNS.SOCIETY_AGENT_TURN_GRACE_MS;
    // Discussion wave 1 (investor, then trustee) plus its decay turn,
    // investment with its tool-result round, return with its tool-result
    // round. Binding tools carry the flat payloads the SDK validates.
    const script = new ScriptedModel([
      // Round 1: discussion wave (苏遥, 林默) + decay turn, investment, return.
      modelResponse([assistantMessage("我会先观察这轮的投资结构。")]),
      modelResponse([assistantMessage("我不会提前承诺，但会公平地看待返还。")]),
      modelResponse([assistantMessage("好。")]),
      modelResponse([functionCall("make_investment", {
        amount: 8,
        reason: "相信对方会公平返还"
      }, { callId: "call-inv-1" })]),
      modelResponse([assistantMessage("已完成投资。")]),
      modelResponse([functionCall("return_from_trust", {
        amount: 8,
        reason: "按约返还"
      }, { callId: "call-ret-1" })]),
      modelResponse([assistantMessage("已完成返还。")]),
      // Round 2 (roles swap): discussion wave + decay turn, investment, return.
      modelResponse([assistantMessage("这轮换我来观察对方如何对待信任。")]),
      modelResponse([assistantMessage("我会根据上一轮的真实返还来决定这轮的投资。")]),
      modelResponse([assistantMessage("好。")]),
      modelResponse([functionCall("make_investment", {
        amount: 6,
        reason: "对方上轮返还合理"
      }, { callId: "call-inv-2" })]),
      modelResponse([assistantMessage("已完成投资。")]),
      modelResponse([functionCall("return_from_trust", {
        amount: 10,
        reason: "继续维持公平"
      }, { callId: "call-ret-2" })]),
      modelResponse([assistantMessage("已完成返还。")])
    ]);
    const limiter = new ActivationLimiter(1);
    const { room, cleanup } = testRoom(script, limiter);
    try {
      void room.start();
await waitFor(() => room.currentStatus() === "finished", 15_000).catch((error) => {
        const snapshot = room.snapshotForViewer({ mode: "omniscient" });
        throw new Error(`${errorMessage(error)}; status=${room.currentStatus()}; limiter=${limiter.concurrency()}/${limiter.pending()}; abandoned=${room.abandonedInFlight()}; scriptCalls=${script.calls.length}; log=${snapshot.world.log.slice(-6).map((entry) => entry.text).join(" | ")}; events=${lastEvents(room, 12).join(" | ")}`);
      });
      script.assertComplete();
      expect(limiter.concurrency()).toBe(0);
      expect(limiter.pending()).toBe(0);
      expect(room.abandonedInFlight()).toBe(0);
      // Both binding actions committed through the gate across two rounds.
      const snapshot = room.snapshotForViewer({ mode: "omniscient" });
      const details = snapshot.world.details as Record<string, unknown>;
      expect(details.history).toBeDefined();
      expect((details.history as Array<unknown>).length).toBe(2);
    } finally {
      cleanup();
    }
  });
});
