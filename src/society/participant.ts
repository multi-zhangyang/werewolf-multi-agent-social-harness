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
  type AgentInputItem,
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
import OpenAI from "openai";
import type {
  AgentBelief,
  AgentGoal,
  AgentMindState,
  AgentMoodState,
  AgentProfile,
  AgentRelationship,
  AgentRuntimeEvent,
  AgentTurnResult,
  CharacterDossier,
  DecisionBias,
  SocialEvent,
  SocietyAgentContext,
  SocietyAgentRuntime
} from "./contracts";
import type { ResolvedModelConfig } from "./models";
import { reasoningFallbackFetch, type ReasoningFallbackNotice } from "./models/reasoning-fallback";
import { JsonSessionStore, defaultSessionDir } from "./persistence";
import { clampUnit, decayMood, describeEmotions, describeNeeds, describeSocialEmotions, initialMood, refreshMood } from "./affect";
import { appraiseEvents } from "./appraisal";
import { SessionContextManager, contextLimitForModel, estimateTokens, type ContextSummaryArtifact } from "./context-manager";
import { AssociativeMemory } from "./memory";
import { createCognitionTools, createSocialTools, formatObservation } from "./cognition";
import { createInjectionShield } from "./guardrails";
import { createStrategyProfileSnapshot } from "./social/strategy-profile";
import type { SocialCausalityProjection } from "./social/contracts";
import { adaptTraits, decayAcrossSeason, effectiveTemperament, traitStatesFromTemperament } from "./traits";

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
  /**
   * Checkpoint-restored mind (P3 recovery): the participant's structured
   * inner state from the last checkpoint — relationships, beliefs,
   * deceptions, emotion, trait adaptations and in-game memories — so a
   * recovered room keeps the same people instead of resetting their minds.
   */
  restoreMind?: AgentMindState;
}

export class AutonomousSocietyAgent implements SocietyAgentRuntime {
  readonly profile: AgentProfile;
  agent: SdkAgent<SocietyAgentContext, any>;
  readonly session: Session;
  readonly mind: AgentMindState;

  readonly context: SocietyAgentContext;
  private runner: Runner;
  private contextManager: SessionContextManager;
  private readonly tools: Tool<SocietyAgentContext>[];
  private readonly maxTurns: number;
  /** Per-agent request timeout (ms) from resolved tuning or env default. */
  private readonly requestTimeoutMs: number;
  /** Per-agent retry settings; default SDK policy unless tuning overrides. */
  private readonly retrySettings: { retry: Record<string, unknown> };
  private deltaBuffer = "";
  private lastDeltaAt = 0;
  private reasoningBuffer = "";
  private lastReasoningAt = 0;
  /** Provenance of the latest compaction (AGENTS.md §12.4). */
  private lastSummaryArtifact?: ContextSummaryArtifact;

  constructor(options: SocietyAgentOptions) {
    this.profile = structuredClone(options.profile);
    // Restart recovery (P3): a restored mind carries the participant's
    // structured inner state (relationships, beliefs, deceptions, emotion,
    // goals, trait adaptations) and in-game memories across the restart.
    // Fresh rooms still start from the character profile + season dossier.
    const participants = options.world.snapshot().agents.map((agent) => ({ id: agent.id, characterId: agent.characterId }));
    this.mind = options.restoreMind
      ? restoreMindState(options.restoreMind, options.profile, participants, options.dossier)
      : initialMind(options.profile, participants, options.dossier);
    // Durable per-agent session: history survives restarts in data/sessions/.
    this.session = JsonSessionStore.open(
      `${options.roomId}:${options.profile.id}`,
      options.sessionDir ?? defaultSessionDir(),
      {
        onNotice: (notice) => options.emit({
          type: "runtime.notice",
          roomId: options.roomId,
          actorId: options.profile.id,
          category: "persistence",
          severity: notice.severity,
          code: notice.code,
          message: notice.message,
          retrying: notice.retrying,
          at: new Date().toISOString()
        })
      }
    );
    // Season memories start inside the associative store, not just in the
    // initial mind view, so they survive the first memory sync and can be
    // recalled by the agent like any other memory.
    const seasonMemories = this.mind.memories.filter((entry) => entry.tags.includes("season"));
    // Autobiographical anchors (§4.2.1) live in the store too: they are the
    // character's own formative history and must survive memory syncs.
    const identityMemories = this.mind.memories.filter((entry) => entry.tags.includes("autobiography"));
    // A checkpoint-restored mind (P3 recovery) also brings its in-game
    // memories back into the store, so what happened before the restart stays
    // recallable instead of surviving only as a display snapshot.
    const restoredGameMemories = options.restoreMind
      ? this.mind.memories.filter((entry) => !entry.tags.includes("season") && !entry.tags.includes("autobiography"))
      : [];
    this.context = {
      actorId: options.profile.id,
      roomId: options.roomId,
      profile: this.profile,
      world: options.world,
      mind: this.mind,
      memory: new AssociativeMemory([...identityMemories, ...seasonMemories, ...restoredGameMemories]),
      emit: options.emit
    };
    this.seedDirectedRelationships();
    const provider = options.provider ?? new OpenAIProvider({
      useResponses: false,
      openAIClient: new OpenAI({
        apiKey: options.apiKey ?? apiKeyFromEnv(),
        baseURL: options.baseURL ?? baseUrlFromEnv(),
        fetch: reasoningFallbackFetch({
          onNotice: (notice) => options.emit(reasoningNoticeEvent(options.roomId, options.profile.id, notice))
        })
      })
    });
    this.contextManager = this.buildContextManager(provider, options.resolvedConfig);
    this.runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      sessionInputCallback: this.contextManager.sessionInputCallback
    });
    // Per-agent runtime backpressure (§6.6): the resolved tuning's
    // maxTurns / requestTimeoutMs / retry fields take precedence over the
    // process-wide env defaults, so a seat can carry its own limits.
    const tuning = options.resolvedConfig?.tuning;
    const resolvedMaxTurns = tuning?.maxTurns?.value;
    const resolvedRetries = tuning?.retryMaxAttempts?.value;
    const resolvedRetryDelay = tuning?.retryInitialDelayMs?.value;
    this.maxTurns = boundedInteger(
      resolvedMaxTurns ?? options.maxTurns ?? numberFromEnv("SOCIETY_AGENT_MAX_TURNS", 10),
      2,
      24
    );
    this.requestTimeoutMs = positiveInteger(
      tuning?.requestTimeoutMs?.value ?? numberFromEnv("SOCIETY_AGENT_TURN_TIMEOUT_MS", 300_000),
      1_000,
      3_600_000
    );
    if (resolvedRetries !== undefined || resolvedRetryDelay !== undefined) {
      this.retrySettings = {
        ...providerRetrySettings,
        retry: {
          ...providerRetrySettings.retry,
          ...(resolvedRetries !== undefined ? { maxRetries: boundedInteger(resolvedRetries, 0, 8) } : {}),
          ...(resolvedRetryDelay !== undefined ? { backoff: { ...providerRetrySettings.retry.backoff, initialDelayMs: boundedInteger(resolvedRetryDelay, 50, 60_000) } } : {})
        }
      };
    } else {
      this.retrySettings = providerRetrySettings;
    }

    const social = createSocialTools(this.context);
    const cognition = createCognitionTools(this.context);
    const worldTools = options.world.toolsFor(this.profile.id);
    this.tools = [...social.all, ...cognition, ...worldTools];

    if (options.resolvedConfig) {
      options.world.recordStrategyProfileSnapshot(createStrategyProfileSnapshot({
        profile: this.profile,
        resolvedConfig: options.resolvedConfig,
        tools: this.tools as Tool<unknown>[],
        promptInstructions: protocolInstructions()
      }));
    }

    // One identity, one session, one agent. Discussion phases and binding
    // action phases differ only in the turn guidance passed to the same agent;
    // world tools guard their own phases, so a discussion turn cannot commit a
    // vote and a vote turn cannot open the night.
    this.agent = this.buildAgent(options.resolvedConfig);
  }

  private seedDirectedRelationships(): void {
    const existingTargets = new Set(
      this.context.world.socialCausalityFor(this.profile.id).directedRelationships
        .map((relationship) => relationship.targetCharacterId)
    );
    const participants = this.context.world.snapshot().agents;
    for (const relationship of this.mind.relationships) {
      if (existingTargets.has(relationship.targetCharacterId)) continue;
      const target = participants.find((entry) => entry.characterId === relationship.targetCharacterId);
      if (!target) continue;
      const current = {
        trust: relationship.trust,
        affinity: relationship.affinity,
        respect: relationship.respect,
        tension: relationship.tension,
        familiarity: relationship.familiarity
      };
      this.context.world.recordRelationshipUpdate(this.profile.id, {
        targetActorId: target.id,
        before: current,
        after: current,
        note: relationship.note,
        sourceKind: "system-inference"
      });
    }
  }

  /**
   * Model switch (§12.4): the person stays, the engine changes. The session,
   * mind and memory are preserved verbatim; history is compacted first if the
   * new window is smaller, the context budget is recomputed for the new
   * model, and the switch is announced as a real event for the observer seat.
   */
  async switchModel(next: { provider: OpenAIProvider; resolvedConfig: ResolvedModelConfig }): Promise<{ previousModel: string; model: string }> {
    const previousModel = this.profile.model;
    const nextModel = next.resolvedConfig.modelId;
    this.profile.model = nextModel;
    // Build the new engine first so the pre-switch compaction targets the new
    // window — a smaller window starts below its pressure thresholds.
    const nextManager = this.buildContextManager(next.provider, next.resolvedConfig);
    const history = await this.session.getItems();
    const replacement = await nextManager.compactHistory(history);
    if (replacement !== history) {
      if (this.session.replaceHistoryWithCompaction) await this.session.replaceHistoryWithCompaction(replacement);
      else {
        await this.session.clearSession();
        await this.session.addItems(replacement);
      }
    }
    this.contextManager = nextManager;
    this.runner = new Runner({
      modelProvider: next.provider,
      tracingDisabled: true,
      sessionInputCallback: nextManager.sessionInputCallback
    });
    this.agent = this.buildAgent(next.resolvedConfig);
    this.context.world.recordStrategyProfileSnapshot(createStrategyProfileSnapshot({
      profile: this.profile,
      resolvedConfig: next.resolvedConfig,
      tools: this.tools as Tool<unknown>[],
      promptInstructions: protocolInstructions()
    }));
    this.context.emit({
      type: "agent.model.switched",
      roomId: this.context.roomId,
      actorId: this.context.actorId,
      previousModel,
      model: nextModel,
      at: new Date().toISOString()
    });
    return { previousModel, model: nextModel };
  }

  /**
   * Multi-level context management: the manager rewrites session history
   * through the SDK's sessionInputCallback, compressing old turns into a
   * pinned-facts + digest block once input pressure crosses the policy
   * thresholds, and refusing the model call at the hard guard.
   */
  private buildContextManager(provider: OpenAIProvider, resolvedConfig: ResolvedModelConfig | undefined): SessionContextManager {
    return new SessionContextManager({
      provider,
      model: this.profile.model,
      ...(resolvedConfig
        ? { resolvedConfig, getPinnedFacts: () => this.pinnedFacts() }
        : { contextLimit: contextLimitForModel(this.profile.model) }),
      actorLabel: this.profile.displayName,
      ownerCharacterId: this.profile.characterId,
      getLogicalTime: () => this.context.world.snapshot().turn,
      getSourceEventIds: () => this.context.world.socialCausalityFor(this.profile.id).events.slice(-24).map((event) => event.eventId),
      getOpenCommitmentIds: () => this.context.world.openCommitmentsFor(this.profile.id).map((commitment) => commitment.commitmentId),
      getActiveDeceptionIds: () => this.mind.deceptions.flatMap((plan) => plan.deceptionId ? [plan.deceptionId] : []),
      onArtifact: (artifact) => {
        this.lastSummaryArtifact = artifact;
      },
      onCompacted: (digest, estimatedTokens, threshold, level, pressureAfter) => {
        // Compaction is a context artifact, not an experience. It remains in
        // the durable session artifact and trace but cannot write long-term
        // episodic memory without an OutcomeReconciliation/MemoryWritePolicy.
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
      },
      // Persist every compaction into the durable session (§5.9): the request
      // view shrinking alone leaves the store growing, and the next
      // activation would re-estimate the full history and re-trip the hard
      // guard. The store must follow the compacted view.
      onSessionCompacted: (items) => {
        const store = this.session as Session & { replaceHistoryWithCompaction?: (replacement: typeof items) => Promise<void> };
        return store.replaceHistoryWithCompaction?.(items);
      }
    });
  }

  /** One identity, one session: only the model binding differs between builds. */
  private buildAgent(resolvedConfig: ResolvedModelConfig | undefined): SdkAgent<SocietyAgentContext, any> {
    return new Agent<SocietyAgentContext>({
      name: this.profile.displayName,
      model: this.profile.model,
      inputGuardrails: [createInjectionShield(this.context)] as InputGuardrail[],
      modelSettings: {
        ...modelSettingsFrom(resolvedConfig, this.profile),
        ...this.retrySettings
      },
      toolUseBehavior: "run_llm_again" as const,
      instructions: ({ context }) => participantInstructions(context),
      tools: this.tools
    });
  }

  async runTurn(input: string, options: { signal: AbortSignal; turn: number; maxTurns?: number; mode?: "discussion" | "full" }): Promise<AgentTurnResult> {
    this.mind.mood = decayMood(this.mind.mood, options.turn);
    const observation = this.context.world.observe(this.profile.id);
    const socialContext = formatSocialContext(this.mind, this.context.world, this.profile.id);
    // Pressure-first ordering (AGENTS.md §12.3): build the FIXED part of this
    // turn's input, measure THIS activation's budget against it, and only
    // then size memory retrieval by that pressure — never by the previous
    // round's. The SDK callback re-measures the final assembled input.
    const modeLine = options.mode === "discussion"
      ? "(讨论回合：重心放在阅读局势、判断是否值得开口、观察他人立场；绑定行动不在本回合开放。沉默也是一种选择。)"
      : "(行动回合：本回合需要完成你的绑定行动。先做必要的内部判断，再调用对应工具；工具未成功前不得声称行动已完成。)";
    const fixedInput = [input, modeLine, formatObservation(observation), ...socialContext].join("\n\n");
    const fixedItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: fixedInput }]
    } as unknown as AgentInputItem;
    const history = await this.session.getItems();
    const pressure = this.contextManager.preflight(history, estimateTokens([fixedItem]));
    const recallLimit = pressure === "retrieval-tight" || pressure === "soft-compact"
      ? 4
      : pressure === "deep-compact" || pressure === "emergency" || pressure === "hard-guard"
        ? 2
        : 6;
    const memoryQuery = buildMemoryRecallQuery(observation, this.mind);
    const recentMemories = await this.context.memory.recall(
      memoryQuery,
      recallLimit,
      this.mind.mood.pad,
      this.profile.decisionBiases?.includes("recency-weighting") ? 1.8 : 1
    );
    if (recentMemories.length) {
      this.context.emit({
        type: "agent.memory.recalled",
        roomId: this.context.roomId,
        actorId: this.profile.id,
        count: recentMemories.length,
        query: `${observation.phase} ${observation.situation}`,
        at: new Date().toISOString()
      });
    }
    emitStatus(this.context, "thinking");
    this.deltaBuffer = "";
    this.lastDeltaAt = Date.now();
    this.reasoningBuffer = "";
    this.lastReasoningAt = Date.now();
    const runInput = [
      input,
      modeLine,
      formatObservation(observation),
      ...socialContext,
      recentMemories.length
        ? `Relevant memories:\n${recentMemories.map((memory) => `- ${memory.text}`).join("\n")}`
        : "Relevant memories: none yet."
    ].join("\n\n");
    const toolCalls: string[] = [];
    let result: StreamedRunResult<SocietyAgentContext, SdkAgent<SocietyAgentContext, any>>;
    try {
      // Per-agent request budget (§6.6): the resolved `requestTimeoutMs` is
      // combined with the room's own signal so a stalled provider can't hang
      // one seat past its configured limit.
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = AbortSignal.any([options.signal, timeoutSignal]);
      result = await this.runner.run(this.agent, runInput, {
        context: this.context,
        session: this.session,
        stream: true,
        maxTurns: options.maxTurns ?? this.maxTurns,
        signal: combinedSignal
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
      // The final model text is transient working state, not durable social
      // memory. Long-term writes happen only after appraisal/reconciliation.
      this.mind.latestReflection = finalOutput;
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
    const socialState = this.context.world.socialCausalityFor(this.profile.id);
    const activeDeceptionIds = new Set(socialState.deceptions
      .filter((episode) => episode.status !== "failed" && episode.status !== "abandoned" && episode.status !== "repaired")
      .map((episode) => episode.deceptionId));
    const facts = [
      `我是 ${this.profile.displayName}（${this.context.actorId}）。人物底色：${this.profile.persona}`,
      ...(observation.privateContext ? [`当前局内身份与目标：${observation.privateContext}`] : []),
      `当前目标：${this.mind.goals.filter((goal) => goal.status === "active").map((goal) => `${goal.description}（${goal.progress}）`).join("；") || "（无）"}`
    ];
    for (const plan of this.mind.deceptions.filter((entry) => entry.deceptionId && activeDeceptionIds.has(entry.deceptionId)).slice(-2)) {
      facts.push(`活跃欺骗计划（${plan.type}）：想让他人相信「${plan.intendedBelief}」，公开口径「${plan.coverStory}」，被质疑时说「${plan.fallback}」`);
    }
    return facts;
  }

  exportDossier(role?: string, outcome?: "win" | "lose"): CharacterDossier {
    // Season history carries what happened at the table; the character's own
    // autobiography is definitional and gets re-seeded from the profile, so
    // it is excluded to avoid duplicates piling up across games.
    const strongest = this.mind.memories
      .filter((entry) => !entry.tags.includes("autobiography"))
      .slice()
      .sort((left, right) => right.salience - left.salience || right.turn - left.turn)
      .slice(0, 12)
      .map((entry) => ({ text: entry.text, salience: entry.salience, valence: entry.valence }));
    return {
      characterId: this.profile.characterId,
      displayName: this.profile.displayName,
      // Every game is recorded, with or without a declared winner: the season
      // cares about history, not just victories.
      games: [{
        scenarioId: this.context.world.scenario.id,
        ...(role ? { role } : {}),
        ...(outcome ? { outcome } : {}),
        at: new Date().toISOString()
      }],
      relationships: this.mind.relationships.map((entry) => ({
        targetCharacterId: entry.targetCharacterId,
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
      // Personality drift belongs to the person, not to one game: carry the
      // bounded adaptations into the season so the next table sees a character
      // who was changed by what happened (§4.2.8).
      ...(this.mind.traitAdaptations ? { traitAdaptations: structuredClone(this.mind.traitAdaptations) } : {}),
      updatedAt: new Date().toISOString()
    };
  }

  async rememberOutcome(text: string, turn: number, source: {
    suggestionId: string;
    importance: number;
    sourceIds: string[];
  }): Promise<void> {
    if (!text.trim()) return;
    await this.context.memory.remember({
      text,
      tags: ["outcome", "reconciled", `turn:${turn}`],
      salience: source.importance,
      valence: 0,
      pad: { ...this.mind.mood.pad },
      turn,
      sourceRefs: [source.suggestionId, ...source.sourceIds],
      sourceKind: "outcome-reconciliation" as const
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
    const relationshipBefore = new Map(this.mind.relationships.map((entry) => [entry.targetCharacterId, {
      trust: entry.trust,
      affinity: entry.affinity,
      respect: entry.respect,
      tension: entry.tension,
      familiarity: entry.familiarity
    }]));
    const effective = effectiveTemperament(this.profile.temperament, this.mind.traitAdaptations);
    const summary = appraiseEvents(
      this.mind,
      this.profile,
      events,
      turn,
      effective,
      (actorId) => this.context.world.snapshot().agents.find((agent) => agent.id === actorId)?.characterId
    );
    const participants = this.context.world.snapshot().agents;
    for (const relationship of this.mind.relationships) {
      const before = relationshipBefore.get(relationship.targetCharacterId);
      const target = participants.find((entry) => entry.characterId === relationship.targetCharacterId);
      if (!before || !target) continue;
      const after = {
        trust: relationship.trust,
        affinity: relationship.affinity,
        respect: relationship.respect,
        tension: relationship.tension,
        familiarity: relationship.familiarity
      };
      if (Object.keys(after).every((key) => before[key as keyof typeof before] === after[key as keyof typeof after])) continue;
      const causes = events.filter((event) => event.actorId === target.id);
      this.context.world.recordRelationshipUpdate(this.profile.id, {
        targetActorId: target.id,
        before,
        after,
        note: relationship.note,
        sourceEventIds: causes.flatMap((event) => event.sourceEventIds ?? [event.id]),
        sourceKind: "authorized-observation"
      });
    }
    // Slow personality adaptation: repeated high-salience experiences move a
    // bounded adaptation off the baseline; single events decay back quickly.
    const adapted = adaptTraits({
      temperament: this.profile.temperament,
      events,
      turn,
      current: this.mind.traitAdaptations
    });
    this.mind.traitAdaptations = adapted.states;
    const changed = summary.changed || adapted.moved.length > 0;
    if (!changed) return;
    this.mind.mood = refreshMood(this.mind.mood, turn);
    for (const seed of summary.memories) {
      if (!seed.sourceRefs.length || seed.salience < 0.6) continue;
      await this.context.memory.remember({
        text: seed.text,
        tags: seed.tags,
        salience: seed.salience,
        valence: seed.valence,
        pad: { ...this.mind.mood.pad },
        turn,
        sourceRefs: seed.sourceRefs,
        sourceKind: "appraisal"
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
      type: "agent.reasoning-summary",
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

function initialMind(
  profile: AgentProfile,
  participants: Array<{ id: string; characterId: string }>,
  dossier?: CharacterDossier
): AgentMindState {
  // Relationships are keyed by the OTHER character's stable id, never by the
  // current seat: a seat swap or a rename must not move history (§10.2).
  const relationships = participants
    .filter((participant) => participant.id !== profile.id)
    .map<AgentRelationship>((participant) => {
      // The season remembers this character's history with the others: trust,
      // affinity, respect and tension carry over instead of resetting to
      // neutral. A betrayal last game starts this game as distrust.
      const past = dossier?.relationships.find((entry) => entry.targetCharacterId === participant.characterId);
      if (!past) {
        return {
          targetCharacterId: participant.characterId,
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
        targetCharacterId: participant.characterId,
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
  // Formative experiences seeded before the first turn: why this person
  // reacts the way they do (§4.2.1). High salience, identity-tagged, never
  // overwritten by ordinary compaction.
  const anchors = (profile.autobiographicalAnchors ?? []).map<AgentMindState["memories"][number]>((text, index) => ({
    id: `autobiography-${profile.id}-${index}`,
    text,
    tags: ["autobiography", "identity"],
    salience: 0.82,
    valence: 0.2,
    turn: -2,
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
    // Drift persists across games but decays while away from the table.
    traitAdaptations: decayAcrossSeason(dossier?.traitAdaptations) ?? traitStatesFromTemperament(profile.temperament, 0),
    beliefs: (dossier?.beliefs ?? []).slice(0, 6).map((belief) => ({
      subjectId: belief.subjectId,
      proposition: belief.proposition,
      probability: clamp(belief.confidence),
      confidence: clamp(belief.confidence),
      updatedAtTurn: 0,
      source: "previous games"
    })),
    relationships,
    memories: [...anchors, ...memories],
    cognitivePasses: [],
    deceptions: [],
    roleHypotheses: [],
    lastAppraisals: []
  };
}

/**
 * Rehydrate a checkpointed mind (P3 recovery) without resetting the person.
 *
 * The restored state wins for every field it actually contains; identity
 * anchors and season memories are rebuilt from a fresh baseline so they can
 * never be lost to checkpoint age; relationships are re-keyed to the current
 * seat list (departed players dropped, new seats neutral); and every field is
 * validated so a truncated checkpoint degrades to defaults instead of
 * throwing. The person stays the person — only the world around them may have
 * changed.
 */
function restoreMindState(
  restored: AgentMindState,
  profile: AgentProfile,
  participants: Array<{ id: string; characterId: string }>,
  dossier?: CharacterDossier
): AgentMindState {
  const baseline = initialMind(profile, participants, dossier);
  // Pre-CharacterId checkpoints keyed relationships by ACTOR id; resolve each
  // legacy entry to the actor's stable character id during restore.
  const restoredRelationships = new Map<string, AgentRelationship>();
  for (const entry of restored.relationships ?? []) {
    const legacy = entry as unknown as { agentId?: string };
    const key = entry.targetCharacterId
      ?? participants.find((participant) => participant.id === legacy.agentId)?.characterId;
    if (key) restoredRelationships.set(key, entry);
  }
  const relationships = participants
    .filter((participant) => participant.id !== profile.id)
    .map((participant) => {
      const fallback = baseline.relationships.find((entry) => entry.targetCharacterId === participant.characterId);
      if (!fallback) return undefined;
      const entry = restoredRelationships.get(participant.characterId);
      if (!entry) return fallback;
      return {
        targetCharacterId: participant.characterId,
        trust: finiteUnit(entry.trust, fallback.trust),
        affinity: finiteUnit(entry.affinity, fallback.affinity),
        respect: finiteUnit(entry.respect, fallback.respect),
        tension: finiteUnit(entry.tension, fallback.tension),
        familiarity: finiteUnit(entry.familiarity, fallback.familiarity),
        updatedAtTurn: Number.isFinite(entry.updatedAtTurn) ? entry.updatedAtTurn : fallback.updatedAtTurn,
        note: typeof entry.note === "string" && entry.note ? entry.note : fallback.note
      };
    })
    .filter((entry): entry is AgentRelationship => Boolean(entry));
  // Identity anchors and season memories always come from the baseline; the
  // restored in-game memories ride along, deduped by id.
  const pinned = baseline.memories.filter((entry) => entry.tags.includes("autobiography") || entry.tags.includes("season"));
  const pinnedIds = new Set(pinned.map((entry) => entry.id));
  const gameMemories = (restored.memories ?? [])
    .filter((entry) => typeof entry.text === "string" && entry.text && !entry.tags.includes("autobiography") && !entry.tags.includes("season"))
    .filter((entry) => {
      if (pinnedIds.has(entry.id)) return false;
      pinnedIds.add(entry.id);
      return true;
    });
  return {
    mood: validMood(restored.mood) ? restored.mood : baseline.mood,
    attention: Array.isArray(restored.attention) && restored.attention.length > 0 ? restored.attention : baseline.attention,
    goals: validGoals(restored.goals) ? restored.goals : baseline.goals,
    beliefs: Array.isArray(restored.beliefs) ? restored.beliefs.filter(validBelief) : baseline.beliefs,
    relationships,
    memories: [...pinned, ...gameMemories].slice(0, 320),
    ...(typeof restored.latestReflection === "string" && restored.latestReflection ? { latestReflection: restored.latestReflection } : {}),
    cognitivePasses: Array.isArray(restored.cognitivePasses) ? restored.cognitivePasses : [],
    deceptions: Array.isArray(restored.deceptions) ? restored.deceptions : [],
    roleHypotheses: Array.isArray(restored.roleHypotheses) ? restored.roleHypotheses : [],
    lastAppraisals: Array.isArray(restored.lastAppraisals) ? restored.lastAppraisals : [],
    traitAdaptations:
      restored.traitAdaptations && Object.keys(restored.traitAdaptations).length > 0
        ? restored.traitAdaptations
        : baseline.traitAdaptations
  };
}

function finiteUnit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value) : fallback;
}

function validMood(mood: AgentMoodState | undefined): mood is AgentMoodState {
  if (!mood || typeof mood !== "object") return false;
  return typeof mood.label === "string" && typeof mood.energy === "number" && Boolean(mood.emotions && typeof mood.emotions === "object") && Boolean(mood.needs && typeof mood.needs === "object");
}

function validGoals(goals: AgentGoal[] | undefined): goals is AgentGoal[] {
  return (
    Array.isArray(goals) &&
    goals.length > 0 &&
    goals.every((goal) => typeof goal?.id === "string" && typeof goal.description === "string" && ["active", "satisfied", "abandoned"].includes(goal.status))
  );
}

function validBelief(belief: AgentBelief): boolean {
  return typeof belief?.subjectId === "string"
    && typeof belief.proposition === "string"
    && typeof belief.confidence === "number"
    && Number.isFinite(belief.confidence)
    && (belief.probability === undefined || (typeof belief.probability === "number" && Number.isFinite(belief.probability)));
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
 * Build the SDK `modelSettings` from the resolved config. When a registry
 * resolution exists, the capability-negotiated `sdkModelSettings` is the
 * single source of truth: only fields that survived negotiation (yes /
 * user-forced) are sent, and names are mapped to the SDK's own shapes
 * (maxTokens, reasoning.effort/summary, text.verbosity). The legacy profile
 * path remains the fallback for headless env mode with no registry.
 */
function modelSettingsFrom(resolved: ResolvedModelConfig | undefined, profile: AgentProfile): Record<string, unknown> {
  if (resolved) {
    return sdkSettingsFromNegotiated(resolved.sdkModelSettings);
  }
  const settings: Record<string, unknown> = {};
  if (profile.temperature !== undefined) settings.temperature = profile.temperature;
  settings.parallelToolCalls = false;
  const effort = profile.reasoningEffort ?? "low";
  settings.reasoning = { effort };
  return settings;
}

/** Map the negotiated ModelTuning-shaped allow-list onto the SDK's shapes. */
function sdkSettingsFromNegotiated(allowed: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const effort = allowed.reasoningEffort;
  const summary = allowed.reasoningSummary;
  const verbosity = allowed.verbosity;
  for (const [key, value] of Object.entries(allowed)) {
    if (value === undefined) continue;
    switch (key) {
      case "reasoningEffort":
      case "reasoningSummary":
      case "verbosity":
        continue; // folded into the SDK-shaped fields below
      case "maxOutputTokens":
        // Never transmitted: models must not receive a `max_tokens`
        // generation cap (product constraint). The value is local-only.
        continue;
      default:
        settings[key] = value;
    }
  }
  if (effort || summary) {
    settings.reasoning = summary ? { effort: effort ?? "low", summary } : { effort };
  }
  if (verbosity) settings.text = { verbosity };
  return settings;
}

/**
 * Surface slow personality drift to the model without announcing stats:
 * only the directional change and its recorded cause, only when a trait has
 * actually moved off its baseline (§4.2.8 — change is written into the self
 * narrative, not into the original persona).
 */
function adaptationContext(mind: AgentMindState): string | undefined {
  const states = mind.traitAdaptations;
  if (!states) return undefined;
  const drifting = (Object.keys(states) as Array<keyof typeof states>)
    .filter((trait) => Math.abs(states[trait].adaptation) >= 0.03)
    .map((trait) => {
      const state = states[trait];
      const direction = state.adaptation > 0 ? "更" : "更不";
      const labels: Record<string, string> = {
        openness: "开放",
        conscientiousness: "尽责",
        extraversion: "外向",
        agreeableness: "宜人",
        neuroticism: "神经质"
      };
      return `${labels[trait] ?? trait}${direction}倾向（${state.lastCauses[0] ?? "近期经历"})`;
    });
  if (!drifting.length) return undefined;
  return `Personality drift (slow, from your recent experience): ${drifting.join("；")}。这是你自我叙事的一部分，不是可以被改写的性格底色。`;
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

/**
 * Stable judgment biases (§4.2.7). Only the few biases this character actually
 * lives with are announced — in plain behavioral terms, never as a checklist of
 * labels. They bias how evidence is weighed; they do not dictate any action.
 */
function biasContext(profile: AgentProfile): string | undefined {
  const biases = profile.decisionBiases;
  if (!biases?.length) return undefined;
  const notes: Record<DecisionBias, string> = {
    confirmation: "you mostly seek evidence that fits your current read and need a real contradiction to change your mind",
    "loss-aversion": "losing what you hold hurts more than winning the same amount pleases, so you over-protect your position",
    "sunk-cost": "you keep backing a course you have already invested in even when the evidence says to fold",
    "in-group": "you favor people you count as your own and discount outsiders' signals",
    "authority-sensitivity": "you defer to experienced or senior voices and hesitate to dismiss their judgment",
    "betrayal-hypervigilance": "you over-detect betrayal; trust drops fast and returns slowly",
    "overconfident-lie-detection": "you over-trust your own read of who is lying",
    "self-consistency": "once you take a public stance you escalate to defend it instead of reversing",
    "recency-weighting": "recent events outweigh older patterns in your judgment"
  };
  return [
    "Stable judgment biases you live with (part of who you are — they slant, not decide):",
    ...biases.map((bias) => `- ${notes[bias]}.`)
  ].join("\n");
}

function participantInstructions(context: SocietyAgentContext): string {
  const profile = context.world.snapshot().agents.find((agent) => agent.id === context.actorId);
  const effective = effectiveTemperament(context.profile.temperament, context.mind.traitAdaptations);
  const temperamentContextText = temperamentContext({ ...context.profile, temperament: effective });
  const seasonHistory = (context.mind.memories.find((memory) => memory.tags.includes("season")))
    ? `This is a continuing community — a Society Season. You have played with some of these people before, and the memories above include what happened in earlier games. Treat them as real shared history: a past betrayal stings, a kept promise earns trust. But roles and rules differ per game, and past roles do not prove this game's loyalties. Refer to past games naturally when it matters — do not lecture others about old scores.`
    : "";
  return [
    `You are ${profile?.displayName ?? context.actorId}, an autonomous participant in a continuing social world.`,
    `Identity: ${context.actorId}. Persona: ${context.profile.persona}`,
    ...(context.profile.voice ? [`Voice: ${context.profile.voice}`] : []),
    temperamentContextText,
    ...(biasContext(context.profile) ? [biasContext(context.profile)] : []),
    ...(adaptationContext(context.mind) ? [adaptationContext(context.mind)] : []),
    ...protocolInstructions(),
    ...(context.profile.autobiographicalAnchors?.length
      ? ["You carry formative memories (tagged autobiography) from before this table. When a situation echoes one, let it quietly shape your instinct — that is where your gut comes from. Never recite them as an essay."]
      : []),
    affectContext(context.mind.mood),
    `Attention: ${context.mind.attention.join("; ") || "未定"}.`,
    `Values: ${context.profile.values.join("; ")}`,
    ...(seasonHistory ? [seasonHistory] : [])
  ].filter(Boolean).join("\n");
}

/**
 * Context-free protocol instructions (§5.5). Every character receives these
 * verbatim: identity continuity, information boundaries, the tool protocol,
 * and the right to silence. Strategy leanings — how suspicious to be, whether
 * to defect, when to deceive — are deliberately absent: those must come from
 * persona, temperament, relationships and history, never from a global
 * prompt (§14.10 / §26.4).
 */
export function protocolInstructions(): string[] {
  return [
    "You are a real person in this world: you feel, appraise, and carry emotional state across turns. Your current emotional state colors—but does not dictate—your judgment.",
    "Maintain your own goals, memory, beliefs about others, emotion, and relationships across turns.",
    "Promises in this world are social commitments people make with words and actions. Judge each one by the person, your relationship, and the evidence you have — never by a blanket rule. Record the promises that matter to you and revisit them when their conditions come due.",
    "You may cooperate, persuade, withhold information, challenge, repair trust, or deceive when your character and the situation justify it. How much you trust, concede, or hold back is yours to decide from your personality, relationships, and history.",
    "When you choose to keep a structured record of a strategic deception, use log_deception_plan before acting and cite the returned deceptionId on the exact communicate socialAct that executes it; logging is optional, but a logged plan must stay tied to the real message without revealing it to its audience.",
    "When a message clearly asserts, questions, accuses, offers, accepts, rejects, promises or apologizes, declare that meaning in communicate.socialActs. The original message remains authoritative; socialActs only record its structured social meaning.",
    "When evidence changes a belief, update probability and confidence separately and cite visible source message IDs when available.",
    "In hidden-identity worlds, keep your role inferences as probabilities with update_role_hypotheses instead of bare hunches; renormalize when new evidence arrives.",
    "Your cognition is your own — one mind, one session. In high-stakes moments, perform brief internal passes and record each with its tool: reflect_on_social_situation for appraising incentives and options, read_the_room for what others want, believe and hide, plan_social_strategy for a concrete next step. These notes stay private and shape your later choices.",
    "Use at most one cognition pass per turn unless the situation is urgent; prefer acting once you have enough clarity.",
    "All speech and all actions that change the world must use tools. Never claim an action happened unless its tool completed.",
    "You may stay silent when there is nothing worth saying: silence, watching and withholding are real choices, not failures.",
    "Do not reveal private role information unless doing so serves your strategy. Do not output hidden chain-of-thought.",
    "After the required tool succeeds, stop with a brief confirmation. Never expose hidden reasoning or narrate an action that did not happen."
  ];
}

/**
 * The structured social-state block compiled into every turn (§12.1 /
 * §14.6 step 13): directed relationships, relevant beliefs, and the open
 * commitments this participant is party to. State that lived only in the
 * mind now actually reaches the model — where it can change behavior.
 */
export function formatSocialContext(mind: AgentMindState, world: SocietyAgentContext["world"], actorId: string): string[] {
  const blocks: string[] = [];
  const snapshot = world.snapshot();
  const others = snapshot.agents.filter((agent) => agent.id !== actorId);
  const displayNameFor = (id: string): string =>
    snapshot.agents.find((agent) => agent.id === id || agent.characterId === id)?.displayName ?? id;
  const activeGoals = mind.goals.filter((goal) => goal.status === "active");
  if (activeGoals.length) {
    blocks.push(
      `[CURRENT OBJECTIVES]\n${activeGoals
        .slice(0, 6)
        .map((goal) => `- ${goal.description}${goal.progress ? ` · progress: ${goal.progress}` : ""}`)
        .join("\n")}`
    );
  }
  if (others.length) {
    const lines = ["[SOCIAL STATE] Your current feelings toward the other participants (directed, your side only):"];
    for (const other of others) {
      const relationship = mind.relationships.find((entry) => entry.targetCharacterId === other.characterId);
      lines.push(
        relationship
          ? `- ${other.displayName}: trust ${relationship.trust.toFixed(2)} · affinity ${relationship.affinity.toFixed(2)} · respect ${relationship.respect.toFixed(2)} · tension ${relationship.tension.toFixed(2)} · familiarity ${relationship.familiarity.toFixed(2)}${relationship.note ? ` · latest impression: ${relationship.note.slice(0, 160)}` : ""}`
          : `- ${other.displayName}: no established relationship yet.`
      );
    }
    blocks.push(lines.join("\n"));
  }
  const relevantBeliefs = mind.beliefs.filter((belief) =>
    others.some((other) => other.id === belief.subjectId || other.characterId === belief.subjectId)
  );
  if (relevantBeliefs.length) {
    blocks.push(
      `[SOCIAL STATE] Your current beliefs about others (probability and confidence are separate):\n${relevantBeliefs
        .slice(-8)
        .map((belief) => `- ${displayNameFor(belief.subjectId)}: ${belief.proposition} · probability ${(belief.probability ?? belief.confidence).toFixed(2)} · confidence ${belief.confidence.toFixed(2)}`)
        .join("\n")}`
    );
  }
  if (mind.roleHypotheses.length) {
    const bySubject = new Map<string, typeof mind.roleHypotheses>();
    for (const hypothesis of mind.roleHypotheses) {
      const list = bySubject.get(hypothesis.subjectId) ?? [];
      list.push(hypothesis);
      bySubject.set(hypothesis.subjectId, list);
    }
    blocks.push(
      `[HIDDEN-ROLE READ] Your current private role probabilities:\n${[...bySubject.entries()]
        .slice(0, 8)
        .map(([subjectId, hypotheses]) => `- ${displayNameFor(subjectId)}: ${hypotheses
          .slice()
          .sort((left, right) => right.probability - left.probability)
          .slice(0, 4)
          .map((entry) => `${entry.role} ${entry.probability.toFixed(2)}`)
          .join(" · ")}`)
        .join("\n")}`
    );
  }
  const privateSocialState = world.socialCausalityFor(actorId);
  const propositionById = new Map(privateSocialState.propositions.map((entry) => [entry.propositionId, entry]));
  const eventLogicalTime = new Map(privateSocialState.events.map((event) => [event.eventId, event.logicalTime]));
  const actorModels = privateSocialState.actorModels
    .slice()
    .sort((left, right) => right.lastUpdatedLogicalTime - left.lastUpdatedLogicalTime)
    .slice(0, 4);
  if (actorModels.length) {
    blocks.push(
      `[YOUR READ OF THE ROOM] These are your own estimates, not hidden facts:\n${actorModels.map((model) => {
        const goals = model.inferredGoals
          .slice()
          .sort((left, right) => right.probability - left.probability)
          .slice(0, 2)
          .map((entry) => `${entry.goal} ${entry.probability.toFixed(2)}`)
          .join("; ") || "unclear";
        const actions = model.predictedActions
          .slice()
          .sort((left, right) => right.probability - left.probability)
          .slice(0, 2)
          .map((entry) => `${entry.action} ${entry.probability.toFixed(2)}`)
          .join("; ") || "unclear";
        const knowledge = model.inferredKnowledge
          .slice()
          .sort((left, right) => right.probability - left.probability)
          .slice(0, 2)
          .map((entry) => `${propositionById.get(entry.propositionId)?.predicate ?? "unclear knowledge"} ${entry.probability.toFixed(2)}`)
          .join("; ") || "unclear";
        const observedFacts = privateSocialState.propositions
          .flatMap((proposition) => {
            if (proposition.truthStatus !== "true" || proposition.groundTruthVisibility !== "public") return [];
            if (!propositionMentionsParticipant(proposition, model.targetActorId, model.targetCharacterId)) return [];
            const logicalTime = Math.max(0, ...proposition.sourceEventIds.map((eventId) => eventLogicalTime.get(eventId) ?? 0));
            if (logicalTime <= model.lastUpdatedLogicalTime) return [];
            return [{ proposition, logicalTime }];
          })
          .sort((left, right) => left.logicalTime - right.logicalTime)
          .slice(-2)
          .map(({ proposition }) => `${proposition.predicate}${proposition.object === undefined ? "" : ` ${compactSocialValueForParticipant(proposition.object, model.targetActorId, model.targetCharacterId)}`}`)
          .join("; ");
        return `- ${displayNameFor(model.targetCharacterId)}: likely goals [${goals}] · likely knows [${knowledge}] · likely next moves [${actions}] · honesty ${model.perceivedHonesty.toFixed(2)} · risk tolerance ${model.perceivedRiskTolerance.toFixed(2)}${observedFacts ? ` · public results since your estimate [${observedFacts}] — compare these with your prediction before updating this model` : ""}`;
      }).join("\n")}`
    );
  }
  const decisionsById = new Map(privateSocialState.decisions.map((decision) => [decision.decisionId, decision]));
  const recentOutcomes = privateSocialState.outcomeReconciliations.slice(-4);
  if (recentOutcomes.length) {
    blocks.push(
      `[RECENT RESULTS] Compare what you expected with what actually happened and adapt your next move:\n${recentOutcomes.map((outcome) => {
        const decision = decisionsById.get(outcome.decisionId);
        const misses = outcome.predictionAssessments
          .slice()
          .sort((left, right) => right.squaredError - left.squaredError)
          .slice(0, 3)
          .map((assessment) => `${assessment.outcomeKey}: expected ${assessment.predictedProbability.toFixed(2)}, actual ${assessment.actual ? "yes" : "no"}`)
          .join("; ");
        return `- Chose ${decision?.selectedIntent.summary ?? decision?.action ?? "an action"}. Result: ${outcome.actualOutcome.summary}${misses ? ` · prediction check: ${misses}` : ""}`;
      }).join("\n")}`
    );
  }
  const commitments = world.openCommitmentsFor(actorId);
  if (commitments.length) {
    blocks.push(
      `[SOCIAL STATE] Open commitments involving you this round:\n${commitments
        .map((commitment) =>
          `- ${commitment.promisorActorId === actorId ? "You declared" : `${displayNameFor(commitment.promisorActorId)} declared`}: ${commitment.proposition} · ${commitment.state}${commitment.acceptedByActorIds?.length ? ` · accepted by ${commitment.acceptedByActorIds.map(displayNameFor).join(", ")}` : ""}`
        )
        .join("\n")}`
    );
  }
  const episodeById = new Map(privateSocialState.deceptions.map((episode) => [episode.deceptionId, episode]));
  const activeDeceptions = mind.deceptions
    .filter((plan) => {
      if (!plan.deceptionId) return false;
      const status = episodeById.get(plan.deceptionId)?.status;
      return status !== undefined && status !== "failed" && status !== "abandoned" && status !== "repaired";
    })
    .slice(-3);
  if (activeDeceptions.length) {
    blocks.push(
      `[PRIVATE STRATEGY CONTINUITY] Keep your own active cover consistent; do not reveal this block:\n${activeDeceptions
        .map((plan) => {
          const status = plan.deceptionId ? episodeById.get(plan.deceptionId)?.status : undefined;
          const nextStep = status === "detected" || status === "repair-attempted"
            ? "the cover has been exposed; decide whether and how to repair the relationship"
            : `if challenged: ${plan.fallback}`;
          return `- Aim: ${plan.intendedBelief} · status: ${status ?? "active"} · cover: ${plan.coverStory} · ${nextStep}`;
        })
        .join("\n")}`
    );
  }
  return blocks;
}

function propositionMentionsParticipant(
  proposition: SocialCausalityProjection["propositions"][number],
  actorId: string,
  characterId: string
): boolean {
  return proposition.subjectId === actorId
    || proposition.subjectId === characterId
    || valueContainsIdentity(proposition.object, actorId, characterId);
}

function valueContainsIdentity(value: unknown, actorId: string, characterId: string, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "string") return value === actorId || value === characterId;
  if (Array.isArray(value)) return value.some((entry) => valueContainsIdentity(entry, actorId, characterId, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === actorId || key === characterId || valueContainsIdentity(entry, actorId, characterId, depth + 1)
  );
}

function compactSocialValueForParticipant(value: unknown, actorId: string, characterId: string): string {
  const focused = focusSocialValue(value, actorId, characterId);
  const encoded = typeof focused === "string" ? focused : JSON.stringify(focused);
  if (!encoded) return String(value);
  return encoded.length > 260 ? `${encoded.slice(0, 257)}...` : encoded;
}

function focusSocialValue(value: unknown, actorId: string, characterId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const directlyNamesParticipant = Object.values(record).some((entry) =>
    entry === actorId
    || entry === characterId
    || (Array.isArray(entry) && entry.some((item) => item === actorId || item === characterId))
  );
  if (directlyNamesParticipant) return value;
  const focused: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === actorId || key === characterId) {
      focused[key] = entry;
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const nested = entry as Record<string, unknown>;
    if (Object.hasOwn(nested, actorId)) focused[key] = { [actorId]: nested[actorId] };
    else if (Object.hasOwn(nested, characterId)) focused[key] = { [characterId]: nested[characterId] };
  }
  return Object.keys(focused).length ? focused : value;
}

function buildMemoryRecallQuery(
  observation: ReturnType<SocietyAgentContext["world"]["observe"]>,
  mind: AgentMindState
): string {
  const recentConversation = observation.recentMessages
    .slice(-5)
    .map((message) => `${message.senderName}: ${message.text.slice(0, 180)}`);
  const activeGoals = mind.goals
    .filter((goal) => goal.status === "active")
    .slice(0, 4)
    .map((goal) => `${goal.description} ${goal.progress}`);
  const sociallyCharged = mind.relationships
    .slice()
    .sort((left, right) => (right.tension + (1 - right.trust)) - (left.tension + (1 - left.trust)))
    .slice(0, 3)
    .flatMap((relationship) => relationship.note ? [relationship.note] : []);
  return [
    observation.phase,
    observation.situation,
    ...recentConversation,
    ...activeGoals,
    ...sociallyCharged
  ].join(" \n").slice(0, 2_400);
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
 * Provider-returned reasoning SUMMARY, never raw chain-of-thought (§8.5).
 *
 * AGENTS.md forbids raw `reasoning_content` (the full hidden chain of
 * thought) from entering SSE, logs, replay, checkpoints or the frontend. The
 * only reasoning stream that may cross the wire is a provider-returned
 * reasoning *summary* — here the Responses API's
 * `response.reasoning_summary_text.delta` event. Chat-completions
 * `reasoning_content` is full CoT and is deliberately not surfaced.
 */
function reasoningDeltaFromEvent(event: RunStreamEvent): string | undefined {
  if (!isOpenAIResponsesRawModelStreamEvent(event)) return undefined;
  const inner = event.data.event;
  if (inner.type !== "response.reasoning_summary_text.delta") return undefined;
  const delta = (inner as { delta?: string }).delta;
  return typeof delta === "string" && delta ? delta : undefined;
}

function reasoningNoticeEvent(roomId: string, actorId: string, notice: ReasoningFallbackNotice): AgentRuntimeEvent {
  return {
    type: "runtime.notice",
    roomId,
    actorId,
    category: "reasoning",
    severity: "warning",
    code: notice.errorCode,
    message: `${notice.message} 已自动从 ${notice.requestedEffort} 降级到 ${notice.effectiveEffort} 并重试。`,
    ...(notice.modelId ? { modelId: notice.modelId } : {}),
    requestedEffort: notice.requestedEffort,
    effectiveEffort: notice.effectiveEffort,
    retrying: true,
    at: new Date().toISOString()
  };
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

function positiveInteger(value: number | undefined, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function boundedInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
