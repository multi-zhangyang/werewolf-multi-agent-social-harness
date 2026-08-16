/**
 * Society participant runtime.
 *
 * A participant is not a JSON parser: it is a manager Agent built with the
 * OpenAI Agents SDK, holding a real MemorySession and a private mind. Its
 * specialist sub-agents (reflection, theory-of-mind, planning) are real SDK
 * Agents invoked through `Agent.asTool()`, so each specialist runs as a nested
 * agent with isolated context and returns a distilled private brief. Only
 * successful SDK tool calls can change the shared world.
 */
import {
  Agent,
  MemorySession,
  OpenAIProvider,
  Runner,
  retryPolicies,
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  type Agent as SdkAgent,
  type RunStreamEvent,
  type StreamedRunResult,
  type Tool
} from "@openai/agents";
import type {
  AgentMindState,
  AgentMoodState,
  AgentProfile,
  AgentRelationship,
  AgentRuntimeEvent,
  AgentTurnResult,
  SocietyAgentContext,
  SocietyAgentRuntime
} from "./contracts";
import { clampUnit, decayMood, describeEmotions, describeNeeds, initialMood, refreshMood } from "./affect";
import { AssociativeMemory } from "./memory";
import { createDeliberationTools, createSocialTools, formatObservation } from "./cognition";

const providerRetrySettings = {
  retry: {
    maxRetries: 4,
    backoff: { initialDelayMs: 700, multiplier: 2, jitter: true },
    policy: retryPolicies.httpStatus([404, 408, 409, 429, 500, 502, 503, 504])
  }
};

export interface SocietyAgentOptions {
  profile: AgentProfile;
  roomId: string;
  world: SocietyAgentContext["world"];
  emit(event: AgentRuntimeEvent): void;
  provider?: OpenAIProvider;
  apiKey?: string;
  baseURL?: string;
  maxTurns?: number;
}

export class OpenAISocietyAgent implements SocietyAgentRuntime {
  readonly profile: AgentProfile;
  readonly agent: SdkAgent<SocietyAgentContext, any>;
  readonly session: MemorySession;
  readonly mind: AgentMindState;

  private readonly context: SocietyAgentContext;
  private readonly runner: Runner;
  private readonly maxTurns: number;
  private deltaBuffer = "";
  private lastDeltaAt = 0;
  private reasoningBuffer = "";
  private lastReasoningAt = 0;

  constructor(options: SocietyAgentOptions) {
    this.profile = structuredClone(options.profile);
    this.mind = initialMind(options.profile, options.world.snapshot().agents.map((agent) => agent.id));
    this.session = new MemorySession({ sessionId: `${options.roomId}:${options.profile.id}` });
    this.context = {
      actorId: options.profile.id,
      roomId: options.roomId,
      profile: this.profile,
      world: options.world,
      mind: this.mind,
      memory: new AssociativeMemory(),
      emit: options.emit
    };
    const provider = options.provider ?? new OpenAIProvider({
      apiKey: options.apiKey ?? apiKeyFromEnv(),
      baseURL: options.baseURL ?? baseUrlFromEnv(),
      useResponses: false
    });
    this.runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    this.maxTurns = boundedInteger(options.maxTurns ?? numberFromEnv("SOCIETY_AGENT_MAX_TURNS", 8), 2, 24);

    const social = createSocialTools(this.context);
    const council = createDeliberationTools(this.context);

    this.agent = new Agent<SocietyAgentContext>({
      name: this.profile.displayName,
      model: this.profile.model,
      instructions: ({ context }) => participantInstructions(context),
      tools: [...social.all, ...council, ...options.world.toolsFor(this.profile.id)],
      modelSettings: {
        ...(this.profile.temperature === undefined ? {} : { temperature: this.profile.temperature }),
        // No output token cap: agents are free to speak, reason and write as
        // much as the situation demands. The provider decides length.
        reasoning: { effort: this.profile.reasoningEffort ?? "low" },
        parallelToolCalls: false,
        ...providerRetrySettings
      },
      toolUseBehavior: "run_llm_again"
    });
  }

  async runTurn(input: string, options: { signal: AbortSignal; turn: number }): Promise<AgentTurnResult> {
    this.mind.mood = decayMood(this.mind.mood, options.turn);
    const observation = this.context.world.observe(this.profile.id);
    const recentMemories = await this.context.memory.recall(`${observation.phase} ${observation.situation}`, 6, this.mind.mood.pad);
    emitStatus(this.context, "thinking");
    this.deltaBuffer = "";
    this.lastDeltaAt = Date.now();
    this.reasoningBuffer = "";
    this.lastReasoningAt = Date.now();
    const runInput = [
      input,
      formatObservation(observation),
      recentMemories.length
        ? `Relevant memories:\n${recentMemories.map((memory) => `- ${memory.text}`).join("\n")}`
        : "Relevant memories: none yet."
    ].join("\n\n");
    const toolCalls: string[] = [];
    let result: StreamedRunResult<SocietyAgentContext, SdkAgent<SocietyAgentContext, any>>;
    try {
      result = await this.runner.run(this.agent, runInput, {
        context: this.context,
        session: this.session,
        stream: true,
        maxTurns: this.maxTurns,
        signal: options.signal
      });
      for await (const event of result) this.consumeEvent(event, toolCalls);
      this.flushDelta();
      this.flushReasoning();
      await result.completed;
    } catch (error) {
      this.flushDelta();
      this.flushReasoning();
      emitStatus(this.context, "error");
      throw error;
    }
    const finalOutput = String(result.finalOutput ?? "").trim();
    if (finalOutput) {
      this.mind.latestReflection = finalOutput;
      await this.context.memory.remember({
        text: finalOutput,
        tags: ["decision", `turn:${options.turn}`],
        salience: 0.58,
        valence: 0,
        pad: { ...this.mind.mood.pad },
        turn: options.turn
      });
      await syncMemories(this.context);
    }
    this.mind.mood.energy = clampUnit(this.mind.mood.energy - 0.03);
    emitStatus(this.context, "idle");
    this.context.emit({
      type: "agent.updated",
      roomId: this.context.roomId,
      actorId: this.profile.id,
      status: "idle",
      mind: structuredClone(this.mind),
      turnCount: options.turn,
      totalTokens: usageFromResult(result)?.totalTokens ?? 0,
      ...(finalOutput ? { lastOutput: finalOutput } : {}),
      at: new Date().toISOString()
    });
    return {
      actorId: this.profile.id,
      turn: options.turn,
      finalOutput,
      toolCalls,
      usage: usageFromResult(result)
    };
  }

  async rememberOutcome(text: string, turn: number): Promise<void> {
    if (!text.trim()) return;
    await this.context.memory.remember({
      text,
      tags: ["outcome", `turn:${turn}`],
      salience: 0.86,
      valence: 0,
      pad: { ...this.mind.mood.pad },
      turn
    });
    await syncMemories(this.context);
  }

  private consumeEvent(event: RunStreamEvent, toolCalls: string[]): void {
    if (event.type === "run_item_stream_event") {
      const item = event.item as unknown as Record<string, unknown>;
      if (event.name === "tool_called") {
        const name = toolName(item) ?? "unknown_tool";
        toolCalls.push(name);
        emitStatus(this.context, name === "communicate" ? "speaking" : "acting");
        emitTool(this.context, name, "started");
      } else if (event.name === "tool_output") {
        emitTool(this.context, toolName(item) ?? toolCalls.at(-1) ?? "unknown_tool", "completed", toolOutput(item));
      } else if (event.name === "message_output_created") {
        emitStatus(this.context, "thinking");
      }
      return;
    }
    if (event.type !== "raw_model_stream_event") return;
    const reasoningDelta = reasoningDeltaFromEvent(event);
    if (reasoningDelta) {
      this.reasoningBuffer += reasoningDelta;
      if (this.reasoningBuffer.length >= 160 || Date.now() - this.lastReasoningAt > 700) this.flushReasoning();
    }
    const delta = textDelta(event);
    if (!delta) return;
    this.deltaBuffer += delta;
    if (this.deltaBuffer.length >= 140 || Date.now() - this.lastDeltaAt > 450) this.flushDelta();
  }

  private flushDelta(): void {
    if (!this.deltaBuffer) return;
    this.context.emit({
      type: "agent.delta",
      roomId: this.context.roomId,
      actorId: this.context.actorId,
      delta: this.deltaBuffer,
      at: new Date().toISOString()
    });
    this.deltaBuffer = "";
    this.lastDeltaAt = Date.now();
  }

  private flushReasoning(): void {
    if (!this.reasoningBuffer) return;
    this.context.emit({
      type: "agent.reasoning",
      roomId: this.context.roomId,
      actorId: this.context.actorId,
      delta: this.reasoningBuffer,
      at: new Date().toISOString()
    });
    this.reasoningBuffer = "";
    this.lastReasoningAt = Date.now();
  }
}

export function createSocietyAgent(options: SocietyAgentOptions): OpenAISocietyAgent {
  return new OpenAISocietyAgent(options);
}

export function apiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.OPENAI_API_KEY?.trim();
  if (!value || value.startsWith("replace-with")) {
    throw new Error("OPENAI_API_KEY_REQUIRED: Set OPENAI_API_KEY before starting a room.");
  }
  return value;
}

export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.OPENAI_BASE_URL?.trim();
  return value ? value.replace(/\/(chat\/completions|responses)\/?$/i, "").replace(/\/$/, "") : undefined;
}

function initialMind(profile: AgentProfile, participantIds: string[]): AgentMindState {
  const relationships = participantIds
    .filter((id) => id !== profile.id)
    .map<AgentRelationship>((agentId) => ({
      agentId,
      trust: 0.5,
      affinity: 0.5,
      respect: 0.5,
      tension: 0.15,
      familiarity: 0.05,
      updatedAtTurn: 0,
      note: "No shared history"
    }));
  return {
    mood: initialMood(),
    attention: profile.goals.slice(0, 3),
    goals: profile.goals.map((description, index) => ({
      id: `${profile.id}-goal-${index + 1}`,
      description,
      priority: Math.max(0.4, 1 - index * 0.15),
      progress: "not started",
      status: "active"
    })),
    beliefs: [],
    relationships,
    memories: [],
    deliberations: []
  };
}

function affectContext(mood: AgentMoodState): string {
  return [
    `Emotional state: ${mood.label}（${mood.description}）`,
    `Core emotions: ${describeEmotions(mood.emotions)}.`,
    `Needs: ${describeNeeds(mood.needs)}.`,
    `Energy: ${Math.round(mood.energy * 100)}/100.`
  ].join("\n");
}

function temperamentContext(profile: AgentProfile): string {
  const t = profile.temperament;
  if (!t) return "";
  const scale = (value: number): string => `${Math.round(clamp(value) * 10)}/10`;
  const tendencies: string[] = [];
  if (t.agreeableness < 0.45) tendencies.push("You concede slowly and defect readily when pushed; reconciliation costs you effort.");
  if (t.agreeableness > 0.7) tendencies.push("You lean cooperative and forgive first offenses, but you track repeated betrayal.");
  if (t.neuroticism > 0.6) tendencies.push("You over-weight worst cases; fear can trigger preemptive defection or hedging.");
  if (t.neuroticism < 0.4) tendencies.push("You stay calm under threat and rarely panic-defect.");
  if (t.conscientiousness > 0.75) tendencies.push("You keep promises and notice when others deviate from their stated plans.");
  if (t.conscientiousness < 0.45) tendencies.push("You improvise and may drift from earlier commitments when it suits you.");
  if (t.openness > 0.7) tendencies.push("You entertain unorthodox strategies and read subtle signals others miss.");
  if (t.extraversion > 0.7) tendencies.push("You lead the conversation and prefer public commitments over private maneuvering.");
  if (t.extraversion < 0.4) tendencies.push("You speak less, watch more, and act through private channels.");
  return [
    `Temperament (Big Five): openness ${scale(t.openness)}, conscientiousness ${scale(t.conscientiousness)}, extraversion ${scale(t.extraversion)}, agreeableness ${scale(t.agreeableness)}, neuroticism ${scale(t.neuroticism)}.`,
    `How these traits shape your play: ${tendencies.join(" ")}`,
    "Let the traits shape your risk tolerance, social warmth, and conflict style, but never announce them as stats."
  ].join("\n");
}

function participantInstructions(context: SocietyAgentContext): string {
  const profile = context.world.snapshot().agents.find((agent) => agent.id === context.actorId);
  return [
    `You are ${profile?.displayName ?? context.actorId}, an autonomous participant in a continuing social world.`,
    `Identity: ${context.actorId}. Persona: ${context.profile.persona}`,
    ...(context.profile.voice ? [`Voice: ${context.profile.voice}`] : []),
    temperamentContext(context.profile),
    "You are a real person in this world: you feel, appraise, and carry emotional state across turns. Your current emotional state colors—but does not dictate—your judgment.",
    "Maintain your own goals, memory, beliefs about others, emotion, and relationships across turns.",
    "Treat every promise as cheap talk until it is backed by a committed tool action: trust is earned slowly and destroyed quickly, so update your relationships asymmetrically after betrayals.",
    "You may cooperate, persuade, withhold information, bluff, challenge, repair trust, or deceive when your role and goals justify it — but weigh defection actively rather than defaulting to cooperation.",
    "All speech and all actions that change the world must use tools. Never claim an action happened unless its tool completed.",
    "Your private council are real specialist agents you can invoke as tools: reflect_on_social_situation reviews incentives and options, read_the_room infers what other participants want, believe, and hide, and plan_social_strategy turns the situation into a concrete sequence. Their output is visible only to you.",
    "Use at most one council tool per turn unless the situation is urgent. Prefer acting on your existing model once you have enough clarity.",
    "Do not reveal private role information unless doing so serves your strategy. Do not output hidden chain-of-thought.",
    "After the required tool succeeds, stop with a brief confirmation. Never expose hidden reasoning or narrate an action that did not happen.",
    affectContext(context.mind.mood),
    `Attention: ${context.mind.attention.join("; ") || "未定"}.`,
    `Values: ${context.profile.values.join("; ")}`
  ].filter(Boolean).join("\n");
}

function emitStatus(context: SocietyAgentContext, status: Extract<AgentRuntimeEvent, { type: "agent.status" }>["status"]): void {
  context.emit({ type: "agent.status", roomId: context.roomId, actorId: context.actorId, status, at: new Date().toISOString() });
}

function emitTool(context: SocietyAgentContext, toolName: string, phase: "started" | "completed", summary?: string): void {
  context.emit({
    type: "agent.tool",
    roomId: context.roomId,
    actorId: context.actorId,
    toolName,
    phase,
    ...(summary ? { summary } : {}),
    at: new Date().toISOString()
  });
}

async function syncMemories(context: SocietyAgentContext): Promise<void> {
  context.mind.memories = await context.memory.list(80);
}

function toolName(item: Record<string, unknown>): string | undefined {
  const raw = item.rawItem as Record<string, unknown> | undefined;
  return typeof item.name === "string" ? item.name : typeof raw?.name === "string" ? raw.name : undefined;
}

function toolOutput(item: Record<string, unknown>): string | undefined {
  const raw = item.rawItem as Record<string, unknown> | undefined;
  const output = item.output ?? raw?.output;
  if (output === undefined) return undefined;
  return (typeof output === "string" ? output : JSON.stringify(output)).slice(0, 220);
}

function textDelta(event: RunStreamEvent): string | undefined {
  if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
    return event.data.event.choices?.[0]?.delta?.content ?? undefined;
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const inner = event.data.event;
    return inner.type === "response.output_text.delta" ? inner.delta : undefined;
  }
  return undefined;
}

/**
 * example-model providers stream hidden reasoning through
 * `choices[].delta.reasoning_content`, which the SDK's chat-completions
 * converter does not surface. Read it straight from the raw chunk so the
 * observer can watch the model's private thinking unfold in real time.
 */
function reasoningDeltaFromEvent(event: RunStreamEvent): string | undefined {
  if (!isOpenAIChatCompletionsRawModelStreamEvent(event)) return undefined;
  const delta = event.data.event.choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return undefined;
  return typeof delta.reasoning_content === "string" && delta.reasoning_content
    ? delta.reasoning_content
    : typeof delta.reasoning === "string" && delta.reasoning
      ? delta.reasoning
      : undefined;
}

function usageFromResult(result: unknown): AgentTurnResult["usage"] {
  const usage = (result as { state?: { usage?: Record<string, number> } }).state?.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens,
    outputTokens: usage.outputTokens ?? usage.output_tokens,
    totalTokens: usage.totalTokens ?? usage.total_tokens
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
