/**
 * Society cognition layer.
 *
 * Every participant is a manager agent that owns a small team of specialist
 * SDK agents. Following the OpenAI Agents SDK orchestration guidance, the
 * specialists are exposed through `Agent.asTool()` rather than handoffs:
 * the participant keeps ownership of the final action, while each specialist
 * runs as a nested, context-isolated agent that returns a distilled private
 * brief. Specialist stream events are surfaced as `agent.thought` events so
 * observers can watch the private mind at work without seeing raw protocol
 * traffic.
 */
import {
  Agent,
  tool,
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  type RunStreamEvent,
  type Tool
} from "@openai/agents";
import { z } from "zod";
import type {
  AgentBelief,
  AgentDeliberation,
  AgentMindState,
  AgentRelationship,
  SocietyAgentContext
} from "./contracts";
import { applyEmotionDeltas, applyNeedsDeltas, applyPadDeltas, clampUnit, describeEmotions, describeNeeds, refreshMood } from "./affect";
import { contextFromRunContext } from "./world";

export interface SocialToolkit {
  all: Tool<SocietyAgentContext>[];
  recall: Tool<SocietyAgentContext>;
  innerState: Tool<SocietyAgentContext>;
}

export function createSocialTools(context: SocietyAgentContext): SocialToolkit {
  const communicate = tool({
    name: "communicate",
    description: "Send one observable message to other participants. Use public for everyone, private with recipientIds for selected participants, or team only when the scenario grants a team channel. This changes what other agents can observe.",
    parameters: z.object({
      text: z.string().min(1).max(4_000),
      channel: z.enum(["public", "private", "team"]).default("public"),
      recipientIds: z.array(z.string().min(1)).max(8).default([]),
      replyTo: z.string().max(120).optional()
    }).strict(),
    execute: async ({ text, channel, recipientIds, replyTo }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      const commit = await ctx.world.performAction(ctx.actorId, "communicate", { text, channel, recipientIds, replyTo });
      emitWorldAction(ctx, commit.action, commit.detail);
      return commit.result;
    }
  }) as Tool<SocietyAgentContext>;

  const remember = tool({
    name: "remember_experience",
    description: "Store a personally meaningful fact, promise, betrayal, inference, or outcome for later turns, tagged with your current emotional state. Use salience near 1 only for events that should strongly influence future decisions.",
    parameters: z.object({
      text: z.string().min(1).max(4_000),
      tags: z.array(z.string().min(1).max(40)).max(8).default([]),
      salience: z.number().min(0).max(1).default(0.6),
      valence: z.number().min(-1).max(1).default(0)
    }).strict(),
    execute: async ({ text, tags, salience, valence }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      const entry = await ctx.memory.remember({ text, tags, salience, valence, pad: { ...ctx.mind.mood.pad }, turn: ctx.world.snapshot().turn });
      await syncMemories(ctx);
      return { stored: true, memoryId: entry.id };
    }
  }) as Tool<SocietyAgentContext>;

  const recall = tool({
    name: "recall_memory",
    description: "Retrieve personal memories relevant to a person, promise, pattern, or decision. Results are ranked by relevance, recency, salience, and similarity to your current emotional state.",
    parameters: z.object({
      query: z.string().min(1).max(600),
      limit: z.number().int().min(1).max(12).default(6)
    }).strict(),
    execute: async ({ query, limit }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      return ctx.memory.recall(query, limit, ctx.mind.mood.pad);
    }
  }) as Tool<SocietyAgentContext>;

  const updateInnerState = createInnerStateTool(context);

  return { all: [communicate, remember, recall, updateInnerState], recall, innerState: updateInnerState };
}

/**
 * The participant's private council: three specialist agents that only the
 * participant can call. Each call is a fresh nested run — the specialist sees
 * a distilled brief plus the participant's current mind, never the full room
 * history — and returns a short private analysis to the participant.
 */
export function createDeliberationTools(context: SocietyAgentContext): Tool<SocietyAgentContext>[] {
  const social = createSocialTools(context);
  const commonSettings = {
    model: context.profile.model,
    modelSettings: {
      // Specialists are never capped: a deeper read of the room is always welcome.
      reasoning: { effort: context.profile.reasoningEffort ?? "low" } as const,
      parallelToolCalls: false
    }
  };

  const reflectionAgent = new Agent<SocietyAgentContext>({
    name: `${context.profile.displayName} reflection`,
    ...commonSettings,
    instructions: ({ context: ctx }) => reflectionInstructions(ctx),
    tools: [social.recall, social.innerState]
  });

  const mindReaderAgent = new Agent<SocietyAgentContext>({
    name: `${context.profile.displayName} mind reader`,
    ...commonSettings,
    instructions: ({ context: ctx }) => mindReaderInstructions(ctx),
    tools: [social.recall, social.innerState]
  });

  const plannerAgent = new Agent<SocietyAgentContext>({
    name: `${context.profile.displayName} planner`,
    ...commonSettings,
    instructions: ({ context: ctx }) => planningInstructions(ctx),
    tools: [social.recall, social.innerState]
  });

  return [
    specialistTool(context, reflectionAgent, "reflect_on_social_situation",
      "Run a private reflection specialist that reviews incentives, relevant memories, likely beliefs held by other participants, and strategic options. Returns a short private brief and cannot change the world.",
      "reflection"),
    specialistTool(context, mindReaderAgent, "read_the_room",
      "Run a private theory-of-mind specialist that infers what each other participant most likely wants, how trustworthy their behavior has been, what they probably believe about you, and what they might be hiding. Returns a short private brief and cannot change the world.",
      "mind-read"),
    specialistTool(context, plannerAgent, "plan_social_strategy",
      "Run a private planning specialist that turns your goals, beliefs, relationships and read of the room into a concrete, sequenced plan for this exact phase. Returns a short private brief and cannot change the world.",
      "plan")
  ];
}

function specialistTool(
  context: SocietyAgentContext,
  specialist: Agent<SocietyAgentContext>,
  toolName: string,
  toolDescription: string,
  kind: AgentDeliberation["kind"]
): Tool<SocietyAgentContext> {
  const toolInstance = specialist.asTool({
    toolName,
    toolDescription,
    onStream: ({ event }) => {
      const delta = streamEventTextDelta(event);
      if (!delta) return;
      context.emit({
        type: "agent.thought",
        roomId: context.roomId,
        actorId: context.actorId,
        specialist: kind,
        delta,
        at: new Date().toISOString()
      });
    },
    customOutputExtractor: (result) => {
      const text = String(result.finalOutput ?? "").trim();
      if (!text) return "No analysis produced.";
      recordDeliberation(context, kind, text);
      return text;
    }
  });
  return toolInstance as unknown as Tool<SocietyAgentContext>;
}

function recordDeliberation(context: SocietyAgentContext, kind: AgentDeliberation["kind"], text: string): void {
  const turn = context.world.snapshot().turn;
  const existing = context.mind.deliberations.findLast((entry) => entry.kind === kind && entry.turn === turn);
  if (existing) {
    existing.text = text;
    existing.at = new Date().toISOString();
  } else {
    context.mind.deliberations.push({ kind, text, turn, at: new Date().toISOString() });
    if (context.mind.deliberations.length > 30) context.mind.deliberations.splice(0, context.mind.deliberations.length - 30);
  }
}

function createInnerStateTool(context: SocietyAgentContext): Tool<SocietyAgentContext> {
  return tool({
    name: "update_inner_state",
    description: [
      "Appraise how recent events affect you and update your private inner state. This is your emotional homeostatis:",
      "- emotionDelta: how your six core emotions shift (0 to 1 each). Anger rises when you are wronged, fear when you are threatened, joy when you gain.",
      "- padDelta: shifts in pleasure, arousal and dominance (each -1 to 1). Losing control lowers dominance; winning raises it.",
      "- needsDelta: how your security, connection, status, autonomy and achievement needs shift (0 to 1).",
      "- energyDelta: small change to your stamina, typically negative after hard turns.",
      "- attention: what you are currently watching.",
      "Also use this tool to update relationships (trust/affinity/respect/tension deltas with a note), beliefs about others (proposition + confidence + source), and goal progress. Only call it when new information actually changes your inner model; do not spam it."
    ].join("\n"),
    parameters: z.object({
      emotionDelta: z.object({
        joy: z.number().min(-1).max(1).default(0),
        sadness: z.number().min(-1).max(1).default(0),
        anger: z.number().min(-1).max(1).default(0),
        fear: z.number().min(-1).max(1).default(0),
        surprise: z.number().min(-1).max(1).default(0),
        disgust: z.number().min(-1).max(1).default(0)
      }).strict().optional(),
      padDelta: z.object({
        pleasure: z.number().min(-1).max(1).default(0),
        arousal: z.number().min(-1).max(1).default(0),
        dominance: z.number().min(-1).max(1).default(0)
      }).strict().optional(),
      needsDelta: z.object({
        security: z.number().min(-1).max(1).default(0),
        connection: z.number().min(-1).max(1).default(0),
        status: z.number().min(-1).max(1).default(0),
        autonomy: z.number().min(-1).max(1).default(0),
        achievement: z.number().min(-1).max(1).default(0)
      }).strict().optional(),
      energyDelta: z.number().min(-0.3).max(0.3).optional(),
      attention: z.array(z.string().min(1).max(240)).max(5).optional(),
      relationship: z.object({
        agentId: z.string().min(1),
        trustDelta: z.number().min(-1).max(1).default(0),
        affinityDelta: z.number().min(-1).max(1).default(0),
        respectDelta: z.number().min(-1).max(1).default(0),
        tensionDelta: z.number().min(-1).max(1).default(0),
        note: z.string().max(1_000)
      }).strict().optional(),
      belief: z.object({
        subjectId: z.string().min(1),
        proposition: z.string().min(1).max(1_000),
        confidence: z.number().min(0).max(1),
        source: z.string().min(1).max(1_000)
      }).strict().optional(),
      goalProgress: z.object({
        goalId: z.string().min(1),
        progress: z.string().min(1).max(2_000),
        status: z.enum(["active", "satisfied", "abandoned"]).default("active")
      }).strict().optional()
    }).strict(),
    execute: async ({ emotionDelta, padDelta, needsDelta, energyDelta, attention, relationship, belief, goalProgress }, runContext) => {
      const ctx = contextFromRunContext(runContext, context);
      const turn = ctx.world.snapshot().turn;
      if (emotionDelta) ctx.mind.mood.emotions = applyEmotionDeltas(ctx.mind.mood.emotions, emotionDelta);
      if (padDelta) ctx.mind.mood.pad = applyPadDeltas(ctx.mind.mood.pad, padDelta);
      if (needsDelta) ctx.mind.mood.needs = applyNeedsDeltas(ctx.mind.mood.needs, needsDelta);
      if (energyDelta !== undefined) ctx.mind.mood.energy = clampUnit(ctx.mind.mood.energy + energyDelta);
      ctx.mind.mood = refreshMood(ctx.mind.mood, turn);
      if (attention) ctx.mind.attention = [...attention];
      if (relationship) updateRelationship(ctx.mind, relationship, turn);
      if (belief) updateBelief(ctx.mind, belief, turn);
      if (goalProgress) {
        const goal = ctx.mind.goals.find((candidate) => candidate.id === goalProgress.goalId);
        if (!goal) throw new Error(`GOAL_NOT_FOUND: '${goalProgress.goalId}' is not one of your active goals.`);
        goal.progress = goalProgress.progress;
        goal.status = goalProgress.status;
      }
      return {
        updated: true,
        mood: ctx.mind.mood.label,
        emotions: describeEmotions(ctx.mind.mood.emotions),
        needs: describeNeeds(ctx.mind.mood.needs),
        energy: Math.round(ctx.mind.mood.energy * 100) / 100
      };
    }
  }) as Tool<SocietyAgentContext>;
}

function updateRelationship(
  mind: AgentMindState,
  input: { agentId: string; trustDelta: number; affinityDelta: number; respectDelta: number; tensionDelta: number; note: string },
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

function updateBelief(mind: AgentMindState, input: Omit<AgentBelief, "updatedAtTurn">, turn: number): void {
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

async function syncMemories(context: SocietyAgentContext): Promise<void> {
  context.mind.memories = await context.memory.list(80);
}

function emitWorldAction(context: SocietyAgentContext, action: string, detail: string): void {
  context.emit({
    type: "world.action",
    roomId: context.roomId,
    actorId: context.actorId,
    action,
    detail,
    at: new Date().toISOString()
  });
}

function streamEventTextDelta(event: RunStreamEvent): string | undefined {
  if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
    return event.data.event.choices?.[0]?.delta?.content ?? undefined;
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const inner = event.data.event;
    return inner.type === "response.output_text.delta" ? inner.delta : undefined;
  }
  return undefined;
}

function reflectionInstructions(context: SocietyAgentContext): string {
  const observation = context.world.observe(context.actorId);
  return [
    "You are the private reflection specialist for one social participant.",
    "Infer incentives, likely beliefs held by others, risks, opportunities, and two concrete strategic options.",
    "Separate observed facts from uncertain inference. You cannot communicate or act in the world.",
    formatObservation(observation),
    `Goals: ${context.mind.goals.map((goal) => `${goal.id}: ${goal.description}`).join("; ")}`,
    `Current beliefs: ${context.mind.beliefs.map((belief) => `${belief.subjectId}: ${belief.proposition} (${belief.confidence.toFixed(2)})`).join("; ") || "none"}`
  ].join("\n\n");
}

function mindReaderInstructions(context: SocietyAgentContext): string {
  const observation = context.world.observe(context.actorId);
  return [
    "You are the private theory-of-mind specialist for one social participant.",
    "For every other participant, produce four items: (1) what they most likely want this round, (2) how trustworthy their public behavior has been, (3) what they probably believe about you, and (4) what they may be concealing.",
    "Treat statements as cheap talk: separate claims from committed actions and from incentives. Label each inference with confidence (high / medium / low).",
    "You cannot communicate or act in the world.",
    formatObservation(observation),
    `Your relationships: ${context.mind.relationships.map((relationship) => `${relationship.agentId}: trust ${relationship.trust.toFixed(2)}, affinity ${relationship.affinity.toFixed(2)}, tension ${relationship.tension.toFixed(2)} — ${relationship.note}`).join("; ") || "none"}`,
    `Your beliefs: ${context.mind.beliefs.map((belief) => `${belief.subjectId}: ${belief.proposition} (${belief.confidence.toFixed(2)})`).join("; ") || "none"}`
  ].join("\n\n");
}

function planningInstructions(context: SocietyAgentContext): string {
  const observation = context.world.observe(context.actorId);
  return [
    "You are the private planning specialist for one social participant.",
    "Produce a concrete plan for this exact phase: what to say, what to conceal, which tool to call, and what to watch for after the action.",
    "Ground the plan in goals, beliefs, relationships, emotional state and likely reactions from others.",
    "You cannot communicate or act in the world.",
    formatObservation(observation),
    `Goals: ${context.mind.goals.map((goal) => `${goal.id}: ${goal.description} (${goal.progress})`).join("; ")}`,
    `Current beliefs: ${context.mind.beliefs.map((belief) => `${belief.subjectId}: ${belief.proposition} (${belief.confidence.toFixed(2)})`).join("; ") || "none"}`,
    `Emotional state: ${context.mind.mood.label} — ${context.mind.mood.description}`
  ].join("\n\n");
}

export function formatObservation(observation: ReturnType<SocietyAgentContext["world"]["observe"]>): string {
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

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
