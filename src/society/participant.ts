import {
  Agent,
  MemorySession,
  OpenAIProvider,
  Runner,
  tool,
  type Agent as SdkAgent,
  type RunStreamEvent,
  type StreamedRunResult,
  type Tool
} from "@openai/agents";
import { z } from "zod";
import type {
  AgentBelief,
  AgentMindState,
  AgentProfile,
  AgentRelationship,
  AgentRuntimeEvent,
  AgentTurnResult,
  SocietyAgentContext,
  SocietyAgentRuntime
} from "./contracts";
import { AssociativeMemory } from "./memory";
import { contextFromRunContext } from "./world";

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
    this.maxTurns = boundedInteger(options.maxTurns ?? numberFromEnv("SOCIETY_AGENT_MAX_TURNS", 12), 2, 24);

    const common = commonTools(this.context);
    const reflectionAgent = new Agent<SocietyAgentContext>({
      name: `${this.profile.displayName} reflection`,
      model: this.profile.model,
      instructions: ({ context }) => reflectionInstructions(context),
      tools: [common.recall],
      modelSettings: { maxTokens: numberFromEnv("SOCIETY_REFLECTION_TOKENS", 700) }
    });
    const reflection = reflectionAgent.asTool({
      toolName: "reflect_on_social_situation",
      toolDescription: "Review current incentives, relevant memories, likely beliefs held by other participants, and strategic options. Returns private advice and cannot change the world.",
      runConfig: { modelProvider: provider, tracingDisabled: true },
      runOptions: { maxTurns: 3 }
    });

    this.agent = new Agent<SocietyAgentContext>({
      name: this.profile.displayName,
      model: this.profile.model,
      instructions: ({ context }) => participantInstructions(context),
      tools: [...common.all, reflection, ...options.world.toolsFor(this.profile.id)],
      modelSettings: {
        ...(this.profile.temperature === undefined ? {} : { temperature: this.profile.temperature }),
        maxTokens: numberFromEnv("SOCIETY_AGENT_MAX_OUTPUT_TOKENS", 1_800),
        parallelToolCalls: false
      },
      toolUseBehavior: "run_llm_again"
    });
  }

  async runTurn(input: string, options: { signal: AbortSignal; turn: number }): Promise<AgentTurnResult> {
    const observation = this.context.world.observe(this.profile.id);
    const recentMemories = await this.context.memory.recall(`${observation.phase} ${observation.situation}`, 6);
    emitStatus(this.context, "thinking");
    emitNote(this.context, "observation", observation.situation);
    this.deltaBuffer = "";
    this.lastDeltaAt = Date.now();
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
      await result.completed;
    } catch (error) {
      this.flushDelta();
      emitStatus(this.context, "error");
      throw error;
    }

    const finalOutput = String(result.finalOutput ?? "").trim();
    if (finalOutput) {
      this.mind.latestReflection = finalOutput.slice(0, 1_200);
      emitNote(this.context, "decision", finalOutput);
      await this.context.memory.remember({
        text: finalOutput.slice(0, 900),
        tags: ["decision", `turn:${options.turn}`],
        salience: 0.58,
        valence: 0,
        turn: options.turn
      });
      await syncMemories(this.context);
    }
    this.mind.energy = clamp(this.mind.energy - 0.02);
    emitStatus(this.context, "idle");
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
      text: text.slice(0, 1_200),
      tags: ["outcome", `turn:${turn}`],
      salience: 0.86,
      valence: 0,
      turn
    });
    await syncMemories(this.context);
    emitNote(this.context, "outcome", text);
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
    const delta = textDelta(event.data as unknown);
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

function commonTools(context: SocietyAgentContext): {
  all: Tool<SocietyAgentContext>[];
  recall: Tool<SocietyAgentContext>;
} {
  const communicate = tool({
    name: "communicate",
    description: "Send one observable message to other participants. Use public for everyone, private with recipientIds for selected participants, or team only when the scenario grants a team channel. This changes what other agents can observe.",
    parameters: z.object({
      text: z.string().min(1).max(800),
      channel: z.enum(["public", "private", "team"]).default("public"),
      recipientIds: z.array(z.string().min(1)).max(8).default([]),
      replyTo: z.string().max(120).optional()
    }).strict(),
    execute: async ({ text, channel, recipientIds, replyTo }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      const message = await ctx.world.sendMessage({ senderId: ctx.actorId, text, channel, recipientIds, replyTo });
      ctx.emit({ type: "agent.message", roomId: ctx.roomId, message });
      return { sent: true, messageId: message.id, channel: message.channel, recipientIds: message.recipientIds ?? [] };
    }
  }) as Tool<SocietyAgentContext>;

  const remember = tool({
    name: "remember_experience",
    description: "Store a personally meaningful fact, promise, betrayal, inference, or outcome for later turns. Use salience near 1 only for events that should strongly influence future decisions.",
    parameters: z.object({
      text: z.string().min(1).max(1_000),
      tags: z.array(z.string().min(1).max(40)).max(8).default([]),
      salience: z.number().min(0).max(1).default(0.6),
      valence: z.number().min(-1).max(1).default(0)
    }).strict(),
    execute: async ({ text, tags, salience, valence }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      const entry = await ctx.memory.remember({ text, tags, salience, valence, turn: ctx.world.snapshot().turn });
      await syncMemories(ctx);
      return { stored: true, memoryId: entry.id };
    }
  }) as Tool<SocietyAgentContext>;

  const recall = tool({
    name: "recall_memory",
    description: "Retrieve personal memories relevant to a person, promise, pattern, or decision. Results are ranked by relevance, recency, salience, and emotional intensity.",
    parameters: z.object({
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(12).default(6)
    }).strict(),
    execute: async ({ query, limit }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      return ctx.memory.recall(query, limit);
    }
  }) as Tool<SocietyAgentContext>;

  const updateSocialModel = tool({
    name: "update_social_model",
    description: "Update your private model of yourself or another participant after new social evidence. Use deltas between -1 and 1 for relationship changes; confidence is an explicit uncertainty estimate, not a fact.",
    parameters: z.object({
      mood: z.string().min(1).max(100).optional(),
      attention: z.array(z.string().min(1).max(120)).max(5).optional(),
      relationship: z.object({
        agentId: z.string().min(1),
        trustDelta: z.number().min(-1).max(1).default(0),
        affinityDelta: z.number().min(-1).max(1).default(0),
        respectDelta: z.number().min(-1).max(1).default(0),
        tensionDelta: z.number().min(-1).max(1).default(0),
        note: z.string().max(240)
      }).strict().optional(),
      belief: z.object({
        subjectId: z.string().min(1),
        proposition: z.string().min(1).max(280),
        confidence: z.number().min(0).max(1),
        source: z.string().min(1).max(240)
      }).strict().optional(),
      goalProgress: z.object({
        goalId: z.string().min(1),
        progress: z.string().min(1).max(240),
        status: z.enum(["active", "satisfied", "abandoned"]).default("active")
      }).strict().optional()
    }).strict(),
    execute: async ({ mood, attention, relationship, belief, goalProgress }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      const turn = ctx.world.snapshot().turn;
      if (mood) ctx.mind.mood = mood;
      if (attention) ctx.mind.attention = [...attention];
      if (relationship) updateRelationship(ctx.mind, relationship, turn);
      if (belief) updateBelief(ctx.mind, belief, turn);
      if (goalProgress) {
        const goal = ctx.mind.goals.find((candidate) => candidate.id === goalProgress.goalId);
        if (!goal) throw new Error(`GOAL_NOT_FOUND: '${goalProgress.goalId}' is not one of your active goals.`);
        goal.progress = goalProgress.progress;
        goal.status = goalProgress.status;
      }
      return { updated: true, mood: ctx.mind.mood, attention: ctx.mind.attention };
    }
  }) as Tool<SocietyAgentContext>;

  return { all: [communicate, remember, recall, updateSocialModel], recall };
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
    mood: "alert",
    energy: 1,
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
    memories: []
  };
}

function participantInstructions(context: SocietyAgentContext): string {
  const profile = context.world.snapshot().agents.find((agent) => agent.id === context.actorId);
  return [
    `You are ${profile?.displayName ?? context.actorId}, an autonomous participant in a continuing social world.`,
    `Identity: ${context.actorId}. Persona: ${context.profile.persona}`,
    "Maintain your own goals, memory, beliefs about others, emotion, and relationships across turns.",
    "Distinguish cheap talk from committed action. You may cooperate, persuade, withhold information, bluff, challenge, repair trust, or deceive when your role and goals justify it.",
    "All speech and all actions that change the world must use tools. Never claim an action happened unless its tool completed.",
    "Use reflect_on_social_situation when incentives or other participants' beliefs are unclear. Use update_social_model when new evidence changes your private model.",
    "Do not reveal private role information unless doing so serves your strategy. Do not output hidden chain-of-thought.",
    "After tool use, finish with a compact private decision note for the observer; do not repeat public speech there.",
    `Mood: ${context.mind.mood}. Energy: ${context.mind.energy.toFixed(2)}. Attention: ${context.mind.attention.join("; ")}.`,
    `Values: ${context.profile.values.join("; ")}`
  ].filter(Boolean).join("\n");
}

function reflectionInstructions(context: SocietyAgentContext): string {
  const observation = context.world.observe(context.actorId);
  return [
    "You are a private reflection specialist serving one social participant.",
    "Infer incentives, likely beliefs held by others, risks, opportunities, and two concrete strategic options.",
    "Separate observed facts from uncertain inference. You cannot communicate or act in the world.",
    formatObservation(observation),
    `Goals: ${context.mind.goals.map((goal) => `${goal.id}: ${goal.description}`).join("; ")}`,
    `Current beliefs: ${context.mind.beliefs.map((belief) => `${belief.subjectId}: ${belief.proposition} (${belief.confidence.toFixed(2)})`).join("; ") || "none"}`
  ].join("\n\n");
}

function formatObservation(observation: ReturnType<SocietyAgentContext["world"]["observe"]>): string {
  const messages = observation.recentMessages.slice(-16).map((message) => {
    const recipients = message.recipientIds?.length ? ` -> ${message.recipientIds.join(", ")}` : "";
    return `[${message.channel}${recipients}] ${message.senderName}: ${message.text}`;
  });
  return [
    `Turn ${observation.turn}. Phase: ${observation.phase}.`,
    `Situation: ${observation.situation}`,
    `Private context: ${observation.privateContext || "none"}`,
    `Other participants: ${observation.others.map((other) => `${other.id} (${other.displayName}, ${other.alive ? "active" : "out"})`).join(", ")}`,
    `Available actions: ${observation.availableActions.join(", ")}`,
    `Recent messages:\n${messages.join("\n") || "none"}`
  ].join("\n");
}

function updateRelationship(
  mind: AgentMindState,
  input: {
    agentId: string;
    trustDelta: number;
    affinityDelta: number;
    respectDelta: number;
    tensionDelta: number;
    note: string;
  },
  turn: number
): void {
  const relationship = mind.relationships.find((candidate) => candidate.agentId === input.agentId);
  if (!relationship) throw new Error(`RELATIONSHIP_NOT_FOUND: '${input.agentId}' is not another participant in this room.`);
  relationship.trust = clamp(relationship.trust + input.trustDelta);
  relationship.affinity = clamp(relationship.affinity + input.affinityDelta);
  relationship.respect = clamp(relationship.respect + input.respectDelta);
  relationship.tension = clamp(relationship.tension + input.tensionDelta);
  relationship.familiarity = clamp(relationship.familiarity + 0.08);
  relationship.updatedAtTurn = turn;
  relationship.note = input.note;
}

function updateBelief(
  mind: AgentMindState,
  input: Omit<AgentBelief, "updatedAtTurn">,
  turn: number
): void {
  const existing = mind.beliefs.find((belief) => belief.subjectId === input.subjectId && belief.proposition === input.proposition);
  if (existing) {
    existing.confidence = input.confidence;
    existing.source = input.source;
    existing.updatedAtTurn = turn;
    return;
  }
  mind.beliefs.push({ ...input, updatedAtTurn: turn });
  if (mind.beliefs.length > 80) mind.beliefs.splice(0, mind.beliefs.length - 80);
}

function emitStatus(context: SocietyAgentContext, status: Extract<AgentRuntimeEvent, { type: "agent.status" }>["status"]): void {
  context.emit({ type: "agent.status", roomId: context.roomId, actorId: context.actorId, status, at: new Date().toISOString() });
}

function emitNote(context: SocietyAgentContext, kind: Extract<AgentRuntimeEvent, { type: "agent.note" }>["kind"], text: string): void {
  context.emit({ type: "agent.note", roomId: context.roomId, actorId: context.actorId, kind, text: text.slice(0, 1_500), at: new Date().toISOString() });
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

function textDelta(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  if (!type.includes("output_text.delta") && !type.includes("text_delta")) return undefined;
  return typeof event.delta === "string" ? event.delta : undefined;
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
