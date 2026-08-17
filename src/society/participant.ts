/**
 * Society participant runtime.
 *
 * A participant is one autonomous peer agent built with the OpenAI Agents SDK:
 * a single SDK Agent holding a real MemorySession and a private mind. Its
 * cognition (reflection, theory-of-mind, planning) runs as internal passes of
 * this same identity, recorded through private tools into its own mind — there
 * are no specialist sub-agents, no `Agent.asTool()` delegation, and no second
 * "discussion" identity. Only successful SDK tool calls can change the shared
 * world, and every world write goes through the tools owned by this agent.
 */
import {
  Agent,
  OpenAIProvider,
  Runner,
  retryPolicies,
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  type Agent as SdkAgent,
  type InputGuardrail,
  type RunStreamEvent,
  type Session,
  type StreamedRunResult,
  type Tool
} from "@openai/agents";
import { randomUUID } from "node:crypto";
import type {
  AgentMindState,
  AgentMoodState,
  AgentProfile,
  AgentRelationship,
  AgentRuntimeEvent,
  AgentTurnResult,
  CharacterDossier,
  SocialEvent,
  SocietyAgentContext,
  SocietyAgentRuntime
} from "./contracts";
import type { ResolvedModelConfig } from "./models";
import { JsonSessionStore, defaultSessionDir } from "./persistence";
import { clampUnit, decayMood, describeEmotions, describeNeeds, describeSocialEmotions, initialMood, refreshMood } from "./affect";
import { appraiseEvents } from "./appraisal";
import { SessionContextManager, contextLimitForModel } from "./context-manager";
import { AssociativeMemory } from "./memory";
import { createCognitionTools, createSocialTools, formatObservation } from "./cognition";
import { createInjectionShield } from "./guardrails";

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
  /** Cross-game history for this character, if the season remembers them. */
  dossier?: CharacterDossier;
  /** Final model config resolved through the registry (model, tuning, budget). */
  resolvedConfig?: ResolvedModelConfig;
  /** Where this agent's durable session file lives (default data/sessions). */
  sessionDir?: string;
}

export class AutonomousSocietyAgent implements SocietyAgentRuntime {
  readonly profile: AgentProfile;
  readonly agent: SdkAgent<SocietyAgentContext, any>;
  readonly session: Session;
  readonly mind: AgentMindState;

  readonly context: SocietyAgentContext;
  private readonly runner: Runner;
  private readonly contextManager: SessionContextManager;
  private readonly maxTurns: number;
  private deltaBuffer = "";
  private lastDeltaAt = 0;
  private reasoningBuffer = "";
  private lastReasoningAt = 0;

  constructor(options: SocietyAgentOptions) {
    this.profile = structuredClone(options.profile);
    this.mind = initialMind(options.profile, options.world.snapshot().agents.map((agent) => agent.id), options.dossier);
    // Durable per-agent session: history survives restarts in data/sessions/.
    this.session = JsonSessionStore.open(
      `${options.roomId}:${options.profile.id}`,
      options.sessionDir ?? defaultSessionDir()
    );
    // Season memories start inside the associative store, not just in the
    // initial mind view, so they survive the first memory sync and can be
    // recalled by the agent like any other memory.
    const seasonMemories = this.mind.memories.filter((entry) => entry.tags.includes("season"));
    this.context = {
      actorId: options.profile.id,
      roomId: options.roomId,
      profile: this.profile,
      world: options.world,
      mind: this.mind,
      memory: new AssociativeMemory(seasonMemories),
      emit: options.emit
    };
    const provider = options.provider ?? new OpenAIProvider({
      apiKey: options.apiKey ?? apiKeyFromEnv(),
      baseURL: options.baseURL ?? baseUrlFromEnv(),
      useResponses: false
    });
    // Multi-level context management: the manager rewrites session history
    // through the SDK's sessionInputCallback, compressing old turns into a
    // pinned-facts + digest block once input pressure crosses the policy
    // thresholds, and refusing the model call at the hard guard.
    this.contextManager = new SessionContextManager({
      provider,
      model: this.profile.model,
      ...(options.resolvedConfig
        ? { resolvedConfig: options.resolvedConfig, getPinnedFacts: () => this.pinnedFacts() }
        : { contextLimit: contextLimitForModel(this.profile.model) }),
      actorLabel: this.profile.displayName,
      onCompacted: (digest, estimatedTokens, threshold, level, pressureAfter) => {
        this.context.emit({
          type: "agent.compacted",
          roomId: this.context.roomId,
          actorId: this.profile.id,
          estimatedTokens,
          threshold,
          digest: digest.slice(0, 600),
          level,
          pressureAfter,
          at: new Date().toISOString()
        });
      },
      onPressure: (budget, level) => {
        this.context.emit({
          type: "agent.context.pressure",
          roomId: this.context.roomId,
          actorId: this.profile.id,
          level,
          pressureRatio: budget.pressureRatio,
          usableInputTokens: budget.usableInputTokens,
          currentInputTokens: budget.currentInputTokens,
          contextWindow: budget.contextWindow,
          at: new Date().toISOString()
        });
      }
    });
    this.runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      sessionInputCallback: this.contextManager.sessionInputCallback
    });
    this.maxTurns = boundedInteger(options.maxTurns ?? numberFromEnv("SOCIETY_AGENT_MAX_TURNS", 10), 2, 24);

    const social = createSocialTools(this.context);
    const cognition = createCognitionTools(this.context);
    const worldTools = options.world.toolsFor(this.profile.id);

    const baseConfig = {
      name: this.profile.displayName,
      model: this.profile.model,
      inputGuardrails: [createInjectionShield(this.context)] as InputGuardrail[],
      modelSettings: {
        ...modelSettingsFrom(options.resolvedConfig, this.profile),
        ...providerRetrySettings
      },
      toolUseBehavior: "run_llm_again" as const
    };

    // One identity, one session, one agent. Discussion phases and binding
    // action phases differ only in the turn guidance passed to the same agent;
    // world tools guard their own phases, so a discussion turn cannot commit a
    // vote and a vote turn cannot open the night.
    this.agent = new Agent<SocietyAgentContext>({
      ...baseConfig,
      instructions: ({ context }) => participantInstructions(context),
      tools: [...social.all, ...cognition, ...worldTools]
    });
  }

  async runTurn(input: string, options: { signal: AbortSignal; turn: number; maxTurns?: number; mode?: "discussion" | "full" }): Promise<AgentTurnResult> {
    this.mind.mood = decayMood(this.mind.mood, options.turn);
    const observation = this.context.world.observe(this.profile.id);
    // Context pressure tightens memory injection: fewer, higher-salience recalls.
    const pressure = this.contextManager.pressure();
    const recallLimit = pressure === "retrieval-tight" || pressure === "soft-compact"
      ? 4
      : pressure === "deep-compact" || pressure === "emergency" || pressure === "hard-guard"
        ? 2
        : 6;
    const recentMemories = await this.context.memory.recall(`${observation.phase} ${observation.situation}`, recallLimit, this.mind.mood.pad);
    emitStatus(this.context, "thinking");
    this.deltaBuffer = "";
    this.lastDeltaAt = Date.now();
    this.reasoningBuffer = "";
    this.lastReasoningAt = Date.now();
    const runInput = [
      input,
      ...(options.mode === "discussion"
        ? ["(讨论回合：重心放在阅读局势、判断是否值得开口、观察他人立场；绑定行动不在本回合开放。沉默也是一种选择。)"]
        : ["(行动回合：本回合需要完成你的绑定行动。先做必要的内部判断，再调用对应工具；工具未成功前不得声称行动已完成。)"]
      ),
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
        maxTurns: options.maxTurns ?? this.maxTurns,
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

  /**
   * Deterministic facts that must survive every context compaction: identity,
   * the current role/win-condition context, active goals and active deception
   * plans. These are preserved as a verbatim pinned block, never model-prose.
   */
  private pinnedFacts(): string[] {
    const observation = this.context.world.observe(this.profile.id);
    const facts = [
      `我是 ${this.profile.displayName}（${this.context.actorId}）。人物底色：${this.profile.persona}`,
      ...(observation.privateContext ? [`当前局内身份与目标：${observation.privateContext}`] : []),
      `当前目标：${this.mind.goals.filter((goal) => goal.status === "active").map((goal) => `${goal.description}（${goal.progress}）`).join("；") || "（无）"}`
    ];
    for (const plan of this.mind.deceptions.slice(-2)) {
      facts.push(`活跃欺骗计划（${plan.type}）：想让他人相信「${plan.intendedBelief}」，公开口径「${plan.coverStory}」，被质疑时说「${plan.fallback}」`);
    }
    return facts;
  }

  exportDossier(role?: string, outcome?: "win" | "lose"): CharacterDossier {
    const strongest = this.mind.memories
      .slice()
      .sort((left, right) => right.salience - left.salience || right.turn - left.turn)
      .slice(0, 12)
      .map((entry) => ({ text: entry.text, salience: entry.salience, valence: entry.valence }));
    return {
      characterKey: this.profile.displayName,
      // Every game is recorded, with or without a declared winner: the season
      // cares about history, not just victories.
      games: [{
        scenarioId: this.context.world.scenario.id,
        ...(role ? { role } : {}),
        ...(outcome ? { outcome } : {}),
        at: new Date().toISOString()
      }],
      relationships: this.mind.relationships.map((entry) => ({
        agentId: entry.agentId,
        trust: entry.trust,
        affinity: entry.affinity,
        respect: entry.respect,
        tension: entry.tension,
        note: entry.note
      })),
      beliefs: this.mind.beliefs.slice(0, 8).map((entry) => ({
        subjectId: entry.subjectId,
        proposition: entry.proposition,
        confidence: entry.confidence
      })),
      memories: strongest,
      updatedAt: new Date().toISOString()
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

  /**
   * The world's appraisal events are translated into state changes here: the
   * deterministic engine updates PAD / core and social emotions / needs /
   * relationships (personality-modulated), and the salient ones become
   * memories that shape future turns.
   */
  async appraise(events: SocialEvent[], turn: number): Promise<void> {
    if (!events.length) return;
    const summary = appraiseEvents(this.mind, this.profile, events, turn);
    if (!summary.changed) return;
    this.mind.mood = refreshMood(this.mind.mood, turn);
    for (const seed of summary.memories) {
      await this.context.memory.remember({
        text: seed.text,
        tags: seed.tags,
        salience: seed.salience,
        valence: seed.valence,
        pad: { ...this.mind.mood.pad },
        turn
      });
    }
    await syncMemories(this.context);
    this.context.emit({
      type: "agent.updated",
      roomId: this.context.roomId,
      actorId: this.profile.id,
      status: "idle",
      mind: structuredClone(this.mind),
      turnCount: turn,
      totalTokens: 0,
      at: new Date().toISOString()
    });
  }

  private consumeEvent(event: RunStreamEvent, toolCalls: string[]): void {
    if (event.type === "run_item_stream_event") {
      const item = event.item as unknown as Record<string, unknown>;
      if (event.name === "tool_called") {
        const name = toolName(item) ?? "unknown_tool";
        toolCalls.push(name);
        emitStatus(this.context, name === "communicate" ? "speaking" : "acting");
        emitTool(this.context, toolCallId(item), name, "started");
      } else if (event.name === "tool_output") {
        emitTool(this.context, toolCallId(item), toolName(item) ?? toolCalls.at(-1) ?? "unknown_tool", "succeeded", toolOutput(item));
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

export function createSocietyAgent(options: SocietyAgentOptions): AutonomousSocietyAgent {
  return new AutonomousSocietyAgent(options);
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

function initialMind(profile: AgentProfile, participantIds: string[], dossier?: CharacterDossier): AgentMindState {
  const relationships = participantIds
    .filter((id) => id !== profile.id)
    .map<AgentRelationship>((agentId) => {
      // The season remembers this character's history with the others: trust,
      // affinity, respect and tension carry over instead of resetting to
      // neutral. A betrayal last game starts this game as distrust.
      const past = dossier?.relationships.find((entry) => entry.agentId === agentId);
      if (!past) {
        return {
          agentId,
          trust: 0.5,
          affinity: 0.5,
          respect: 0.5,
          tension: 0.15,
          familiarity: 0.05,
          updatedAtTurn: 0,
          note: "No shared history"
        };
      }
      return {
        agentId,
        trust: clamp(past.trust),
        affinity: clamp(past.affinity),
        respect: clamp(past.respect),
        tension: clamp(past.tension),
        familiarity: Math.max(0.35, Math.min(1, past.familiarity ?? 0.5)),
        updatedAtTurn: 0,
        note: past.note || "Shared history from previous games"
      };
    });
  const memories = (dossier?.memories ?? []).slice(0, 10).map<AgentMindState["memories"][number]>((entry, index) => ({
    id: `season-${profile.id}-${index}`,
    text: entry.text,
    tags: ["season", "history"],
    salience: entry.salience,
    valence: entry.valence,
    turn: -1,
    createdAt: new Date().toISOString()
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
    beliefs: (dossier?.beliefs ?? []).slice(0, 6).map((belief) => ({
      subjectId: belief.subjectId,
      proposition: belief.proposition,
      confidence: clamp(belief.confidence),
      updatedAtTurn: 0,
      source: "previous games"
    })),
    relationships,
    memories,
    cognitivePasses: [],
    deceptions: [],
    roleHypotheses: [],
    lastAppraisals: []
  };
}

function affectContext(mood: AgentMoodState): string {
  return [
    `Emotional state: ${mood.label}（${mood.description}）`,
    `Core emotions: ${describeEmotions(mood.emotions)}.`,
    `Social emotions: ${describeSocialEmotions(mood.socialEmotions)}.`,
    `Needs: ${describeNeeds(mood.needs)}.`,
    `Energy: ${Math.round(mood.energy * 100)}/100.`
  ].join("\n");
}

/**
 * Build the SDK `modelSettings` from the resolved config. Only fields that
 * survived capability negotiation are sent; legacy profile fields remain the
 * fallback when no registry resolution was provided (headless env mode).
 */
function modelSettingsFrom(resolved: ResolvedModelConfig | undefined, profile: AgentProfile): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const tuning = resolved?.tuning;
  if (tuning?.temperature) settings.temperature = tuning.temperature.value;
  else if (!resolved && profile.temperature !== undefined) settings.temperature = profile.temperature;
  if (tuning?.topP) settings.topP = tuning.topP.value;
  if (tuning?.presencePenalty) settings.presencePenalty = tuning.presencePenalty.value;
  if (tuning?.frequencyPenalty) settings.frequencyPenalty = tuning.frequencyPenalty.value;
  if (tuning?.maxOutputTokens) settings.maxOutputTokens = tuning.maxOutputTokens.value;
  // Reasoning parameters are sent only when they survived capability
  // negotiation (or on the legacy no-registry path). Unknown = not sent.
  const effort = tuning?.reasoningEffort?.value ?? (!resolved ? profile.reasoningEffort ?? "low" : undefined);
  const summary = tuning?.reasoningSummary?.value;
  if (effort || summary) settings.reasoning = summary ? { effort: effort ?? "low", summary } : { effort };
  // Parallel tool calls default to disabled; send only when explicitly resolved.
  if (tuning?.parallelToolCalls) settings.parallelToolCalls = tuning.parallelToolCalls.value;
  else if (!resolved) settings.parallelToolCalls = false;
  if (tuning?.toolChoice) settings.toolChoice = tuning.toolChoice.value;
  if (tuning?.truncation) settings.truncation = tuning.truncation.value;
  if (tuning?.store) settings.store = tuning.store.value;
  if (tuning?.seed) settings.seed = tuning.seed.value;
  if (tuning?.stop) settings.stop = tuning.stop.value;
  return settings;
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
    ...(profile.regulation ? [regulationContext(profile.regulation)] : []),
    "Let the traits shape your risk tolerance, social warmth, and conflict style, but never announce them as stats."
  ].join("\n");
}

function regulationContext(regulation: NonNullable<AgentProfile["regulation"]>): string {
  const notes: Record<NonNullable<AgentProfile["regulation"]>, string> = {
    reappraise: "You cope with setbacks by reinterpreting them: your negative emotions fade faster and you look for the constructive angle.",
    suppress: "You keep distress inside and stay composed on the surface; the tension costs you energy and may leak as coldness.",
    ruminate: "Setbacks stay with you: you revisit slights longer than others and your grudges cool slowly.",
    "act-out": "Under pressure you externalize: anger comes fast, you push back and may act before fully weighing the cost.",
    repair: "After conflict you move to mend: you apologize, explain and offer compensation sooner than most."
  };
  return `Emotion regulation: ${notes[regulation]}`;
}

function participantInstructions(context: SocietyAgentContext): string {
  const profile = context.world.snapshot().agents.find((agent) => agent.id === context.actorId);
  const seasonHistory = (context.mind.memories.find((memory) => memory.tags.includes("season")))
    ? `This is a continuing community — a Society Season. You have played with some of these people before, and the memories above include what happened in earlier games. Treat them as real shared history: a past betrayal stings, a kept promise earns trust. But roles and rules differ per game, and past roles do not prove this game's loyalties. Refer to past games naturally when it matters — do not lecture others about old scores.`
    : "";
  return [
    `You are ${profile?.displayName ?? context.actorId}, an autonomous participant in a continuing social world.`,
    `Identity: ${context.actorId}. Persona: ${context.profile.persona}`,
    ...(context.profile.voice ? [`Voice: ${context.profile.voice}`] : []),
    temperamentContext(context.profile),
    "You are a real person in this world: you feel, appraise, and carry emotional state across turns. Your current emotional state colors—but does not dictate—your judgment.",
    "Maintain your own goals, memory, beliefs about others, emotion, and relationships across turns.",
    "Treat every promise as cheap talk until it is backed by a committed tool action: trust is earned slowly and destroyed quickly, so update your relationships asymmetrically after betrayals.",
    "You may cooperate, persuade, withhold information, bluff, challenge, repair trust, or deceive when your role and goals justify it — but weigh defection actively rather than defaulting to cooperation.",
    "When you plan a strategic deception, log it first with log_deception_plan (type, audience, the belief you want them to hold, your cover story and your fallback). Unlogged lies are sloppy; a logged deception is a plan you can keep consistent.",
    "In hidden-identity worlds, keep your role inferences as probabilities with update_role_hypotheses instead of bare hunches; renormalize when new evidence arrives.",
    "Your cognition is your own — one mind, one session. In high-stakes moments, perform brief internal passes and record each with its tool: reflect_on_social_situation for appraising incentives and options, read_the_room for what others want, believe and hide, plan_social_strategy for a concrete next step. These notes stay private and shape your later choices.",
    "Use at most one cognition pass per turn unless the situation is urgent; prefer acting once you have enough clarity.",
    "All speech and all actions that change the world must use tools. Never claim an action happened unless its tool completed.",
    "You may stay silent when there is nothing worth saying: silence, watching and withholding are real choices, not failures.",
    "Do not reveal private role information unless doing so serves your strategy. Do not output hidden chain-of-thought.",
    "After the required tool succeeds, stop with a brief confirmation. Never expose hidden reasoning or narrate an action that did not happen.",
    affectContext(context.mind.mood),
    `Attention: ${context.mind.attention.join("; ") || "未定"}.`,
    `Values: ${context.profile.values.join("; ")}`,
    ...(seasonHistory ? [seasonHistory] : [])
  ].filter(Boolean).join("\n");
}

function emitStatus(context: SocietyAgentContext, status: Extract<AgentRuntimeEvent, { type: "agent.status" }>["status"]): void {
  context.emit({ type: "agent.status", roomId: context.roomId, actorId: context.actorId, status, at: new Date().toISOString() });
}

function emitTool(
  context: SocietyAgentContext,
  toolCallId: string | undefined,
  toolName: string,
  phase: "started" | "succeeded",
  safeOutputSummary?: string
): void {
  context.emit({
    type: "agent.tool",
    roomId: context.roomId,
    actorId: context.actorId,
    toolCallId: toolCallId ?? randomUUID(),
    toolName,
    phase,
    ...(safeOutputSummary ? { safeOutputSummary } : {}),
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

function toolCallId(item: Record<string, unknown>): string | undefined {
  const raw = item.rawItem as Record<string, unknown> | undefined;
  const callId = item.callId ?? raw?.call_id;
  return typeof callId === "string" && callId ? callId : undefined;
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
 * Reasoning-capable providers stream hidden reasoning through
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
