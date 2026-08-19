/**
 * Shared deterministic fixtures for room-level tests: a worst-case hanging
 * provider, a strict limiter, and a 2-seat trust-game SocietyRoom wired to a
 * fake provider. No model calls, no network — every request is scripted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assistantMessage, functionCall, modelResponse } from "@openai/agents/testing";
import type { Model, ModelProvider, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import type { OpenAIProvider } from "@openai/agents";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { ModelRegistry } from "../../src/society/models";
import { defaultCapabilities, DEFAULT_CONTEXT_POLICY_ID } from "../../src/society/models/defaults";
import { SocietyRoom } from "../../src/society/room";
import { createAgentProfiles } from "../../src/society/profiles";

/** One scripted provider call: wait, emit events, then optionally hang. */
export interface FakeStep {
  delayMs?: number;
  events?: StreamEvent[];
  /** Keep the stream open forever after emitting (ignores abort). */
  hangForever?: boolean;
}

let responseCounter = 0;

export function toolResponse(name: string, args: Record<string, unknown>, callId: string): StreamEvent {
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
 * and only ends when `releaseAll()` resolves its suspension points.
 */
export class HangingModel implements Model {
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

export function fakeProvider(model: Model): ModelProvider {
  return { getModel: () => model };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
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

export function lastEvents(room: SocietyRoom, count: number): string[] {
  const events: Array<{ seq: number; event: { type: string } }> = (room as unknown as { events: Array<{ seq: number; event: { type: string } }> }).events;
  return events.slice(-count).map((entry) => `#${entry.seq} ${entry.event.type}`);
}

export function roomError(room: SocietyRoom): string | undefined {
  return (room as unknown as { error?: string }).error;
}

export const FAST_TURNS: NodeJS.ProcessEnv = {
  SOCIETY_AGENT_TURN_TIMEOUT_MS: "150",
  SOCIETY_AGENT_TURN_GRACE_MS: "100"
};

export function installFastTurns(): void {
  process.env.SOCIETY_AGENT_TURN_TIMEOUT_MS = FAST_TURNS.SOCIETY_AGENT_TURN_TIMEOUT_MS;
  process.env.SOCIETY_AGENT_TURN_GRACE_MS = FAST_TURNS.SOCIETY_AGENT_TURN_GRACE_MS;
}

export function clearFastTurns(): void {
  for (const key of Object.keys(FAST_TURNS)) delete process.env[key];
}

/** A 2-seat trust-game room wired to a fake provider and a strict limiter. */
export function testRoom(model: Model, limiter: ActivationLimiter, options: { rounds?: number } = {}): { room: SocietyRoom; archiveDir: string; cleanup: () => void } {
  const roomId = `room-scripted-${randomUUID().slice(0, 8)}`;
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
  const archiveDir = mkdtempSync(path.join(tmpdir(), "society-scripted-"));
  const room = new SocietyRoom({
    id: roomId,
    scenarioId: "trust-game",
    profiles,
    rounds: options.rounds ?? 2,
    provider: fakeProvider(model) as unknown as OpenAIProvider,
    modelRegistry: registry,
    limiter,
    archiveDir
  });
  const cleanup = (): void => {
    room.dispose("test cleanup");
    rmSync(archiveDir, { recursive: true, force: true });
    for (const profile of profiles) {
      rmSync(path.join("data", "sessions", `${roomId}:${profile.id}.json`), { force: true });
    }
  };
  return { room, archiveDir, cleanup };
}

/** The full 2-round trust-game script used by deterministic room runs. */
export function twoRoundScript(): Array<ReturnType<typeof modelResponse>> {
  return [
    modelResponse([assistantMessage("我会先观察这轮的投资结构。")]),
    modelResponse([assistantMessage("我不会提前承诺，但会公平地看待返还。")]),
    modelResponse([functionCall("make_investment", { amount: 8, reason: "相信对方会公平返还" }, { callId: "call-inv-1" })]),
    modelResponse([assistantMessage("已完成投资。")]),
    modelResponse([functionCall("return_from_trust", { amount: 8, reason: "按约返还" }, { callId: "call-ret-1" })]),
    modelResponse([assistantMessage("已完成返还。")]),
    modelResponse([assistantMessage("这轮换我来观察对方如何对待信任。")]),
    modelResponse([assistantMessage("我会根据上一轮的真实返还来决定这轮的投资。")]),
    modelResponse([functionCall("make_investment", { amount: 6, reason: "对方上轮返还合理" }, { callId: "call-inv-2" })]),
    modelResponse([assistantMessage("已完成投资。")]),
    modelResponse([functionCall("return_from_trust", { amount: 10, reason: "继续维持公平" }, { callId: "call-ret-2" })]),
    modelResponse([assistantMessage("已完成返还。")])
  ];
}