/**
 * Society cognition layer.
 *
 * Every participant is one autonomous peer agent. Reflection, theory-of-mind
 * and planning are internal cognitive passes of that same identity: the agent
 * performs them inside its own session and writes the results into its own
 * private mind through typed tools. No specialist agents, no `Agent.asTool()`,
 * no nested runs — the cognition tools below only record what the owning
 * agent thinks, and each pass emits a structured ThoughtBeat so observers can
 * watch the private mind at work without raw protocol traffic.
 */
import {
  tool,
  type Tool
} from "@openai/agents";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  AgentBelief,
  AgentCognitivePass,
  AgentMindState,
  SocietyAgentContext,
  ThoughtBeat,
  ThoughtBeatKind
} from "./contracts";
import { applyEmotionDeltas, applyNeedsDeltas, applyPadDeltas, clampUnit, describeEmotions, describeNeeds, refreshMood } from "./affect";
import { scopedContext } from "./world";

export interface SocialToolkit {
  all: Tool<SocietyAgentContext>[];
  recall: Tool<SocietyAgentContext>;
  innerState: Tool<SocietyAgentContext>;
}

const socialActDeclarationSchema = z.object({
  kind: z.enum([
    "assertion", "denial", "question", "answer", "promise", "offer", "acceptance", "rejection",
    "request", "threat", "accusation", "defense", "apology", "alliance-proposal", "disclosure",
    "endorsement", "warning"
  ]),
  targetActorIds: z.array(z.string().min(1)).max(8).default([]),
  proposition: z.object({
    kind: z.enum([
      "world-state", "identity", "past-action", "future-action", "preference", "intention",
      "relationship", "norm", "evaluation"
    ]).nullable().default(null),
    subjectId: z.string().min(1).nullable().default(null),
    predicate: z.string().min(1).max(500),
    object: z.string().max(500).nullable().default(null)
  }).strict().nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  deceptionId: z.string().min(1).max(160).nullable().default(null),
  repairDeceptionId: z.string().min(1).max(160).nullable().default(null)
}).strict();

export function createSocialTools(context: SocietyAgentContext): SocialToolkit {
  const communicate = tool({
    name: "communicate",
    description: [
      "Send one observable message to other participants. Use public for everyone, private with recipientIds for selected participants, or team only when the scenario grants a team channel.",
      "Optionally declare the concrete social acts this exact message performs (claim, question, accusation, offer, promise, acceptance, etc.). These declarations interpret the message but never replace its original text and never change binding world state.",
      "For any act directed at a person, include that person's actor ID in targetActorIds so they can react to it. Use replyTo with the visible message ID when answering a specific message.",
      "A promise declaration is only communicated speech; when a scenario exposes a commitment tool, use that tool for a promise the world can settle.",
      "If this message executes a private deception plan, cite the deceptionId returned by log_deception_plan on the relevant social act.",
      "After a deception is detected, the deceiver may cite repairDeceptionId on an apology/disclosure; a targeted participant may cite it on an acceptance/endorsement to confirm repair."
    ].join("\n"),
    parameters: z.object({
      text: z.string().min(1).max(4_000),
      channel: z.enum(["public", "private", "team"]).default("public"),
      recipientIds: z.array(z.string().min(1)).max(8).default([]),
      replyTo: z.string().max(120).nullable().default(null),
      socialActs: z.array(socialActDeclarationSchema).max(6).default([])
    }).strict(),
    execute: async ({ text, channel, recipientIds, replyTo, socialActs }, runContext) => {
      const ctx = scopedContext(runContext, context.actorId, context);
      const declarations = socialActs.map((act) => ({
        kind: act.kind,
        ...(act.targetActorIds.length ? { targetActorIds: act.targetActorIds } : {}),
        ...(act.proposition
          ? {
              proposition: {
                ...(act.proposition.kind ? { kind: act.proposition.kind } : {}),
                ...(act.proposition.subjectId ? { subjectId: act.proposition.subjectId } : {}),
                predicate: act.proposition.predicate,
                ...(act.proposition.object === null ? {} : { object: act.proposition.object })
              }
            }
          : {}),
        confidence: act.confidence,
        ...(act.deceptionId ? { deceptionId: act.deceptionId } : {}),
        ...(act.repairDeceptionId ? { repairDeceptionId: act.repairDeceptionId } : {})
      }));
      const commit = await ctx.world.performAction(ctx.actorId, "communicate", {
        text,
        channel,
        recipientIds,
        ...(replyTo ? { replyTo } : {}),
        socialActs: declarations
      });
      emitWorldAction(ctx, commit.action, commit.detail);
      return commit.result;
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
      const ctx = scopedContext(runContext, context.actorId, context);
      return ctx.memory.recall(query, limit, ctx.mind.mood.pad);
    }
  }) as Tool<SocietyAgentContext>;

  const updateInnerState = createInnerStateTool(context);

  // Strategic deception is a typed, audience-aware plan — not an invisible
  // lie. The model records what it wants others to believe and how it will
  // keep the story consistent before it acts.
  const logDeception = tool({
    name: "log_deception_plan",
    description: [
      "Record a planned strategic deception BEFORE you act on it, so you can keep your story consistent. This is private: nobody else sees it.",
      "- type: lying (a false claim), bluff (threat or bid you may not honor), paltering (true words meant to mislead), omission (letting a false belief stand), or false-promise (a commitment you already plan to break).",
      "- targetIds: which participants the deception is aimed at.",
      "- intendedBelief: exactly what you want them to believe afterwards.",
      "- coverStory: the public claims that must stay consistent with the deception.",
      "- fallback: what you will say or do if challenged.",
      "Weigh the cost before lying: exposure damages your credibility with every listener. Honest moves need no ledger entry."
    ].join("\n"),
    parameters: z.object({
      type: z.enum(["lying", "bluff", "paltering", "omission", "false-promise"]),
      targetIds: z.array(z.string().min(1)).max(8),
      truePropositions: z.array(z.string().min(1).max(1_000)).max(6).default([]),
      intendedBelief: z.string().min(1).max(1_000),
      coverStory: z.string().min(1).max(1_000),
      fallback: z.string().min(1).max(1_000),
      motive: z.string().min(1).max(500).nullable().default(null),
      expectedGain: z.string().min(1).max(500).nullable().default(null),
      perceivedDetectionRisk: z.number().min(0).max(1).nullable().default(null)
    }).strict(),
    execute: async (input, runContext) => {
      const ctx = scopedContext(runContext, context.actorId, context);
      const episode = ctx.world.recordDeceptionPlan(ctx.actorId, {
        mode: input.type === "lying" ? "direct-lie"
          : input.type === "bluff" ? "false-implication"
            : input.type === "paltering" ? "selective-truth"
              : input.type === "false-promise" ? "feigned-commitment"
                : "omission",
        targetActorIds: input.targetIds,
        truePropositions: input.truePropositions,
        intendedBelief: input.intendedBelief,
        ...(input.motive ? { motive: input.motive } : {}),
        ...(input.expectedGain ? { expectedGain: input.expectedGain } : {}),
        ...(input.perceivedDetectionRisk === null ? {} : { perceivedDetectionRisk: input.perceivedDetectionRisk })
      });
      const plan = {
        deceptionId: episode.deceptionId,
        type: input.type,
        targetIds: input.targetIds,
        intendedBelief: input.intendedBelief,
        coverStory: input.coverStory,
        fallback: input.fallback,
        turn: ctx.world.snapshot().turn,
        at: new Date().toISOString()
      };
      ctx.mind.deceptions.push(plan);
      if (ctx.mind.deceptions.length > 10) ctx.mind.deceptions.splice(0, ctx.mind.deceptions.length - 10);
      return { logged: true, deceptionId: episode.deceptionId, type: input.type, targets: input.targetIds };
    }
  }) as Tool<SocietyAgentContext>;

  return { all: [communicate, recall, updateInnerState, logDeception], recall, innerState: updateInnerState };
}

/**
 * Role-probability hypotheses for hidden-identity worlds (werewolf, avalon).
 * Probabilities are per-subject and renormalized per subject, so suspicion
 * stays a distribution — not a free-text hunch. Bound per actor like every
 * world tool: the live run context decides whose mind gets updated.
 */
export function roleHypothesisTool(actorId: string): Tool<SocietyAgentContext> {
  return tool({
    name: "update_role_hypotheses",
    description: [
      "Update your probability judgments about other participants' hidden roles. This is your private belief ledger in this hidden-identity world.",
      "Give one entry per (subject, role) pair you want to revise. Probabilities are 0..1; they should sum to at most 1 per subject across all roles.",
      "Base each update on evidence: public claims, votes, team choices, quest outcomes, night information — never raise confidence without a reason.",
      "Use this instead of burying your suspicion in prose; your final actions should be consistent with these numbers."
    ].join("\n"),
    parameters: z.object({
      hypotheses: z.array(z.object({
        subjectId: z.string().min(1),
        role: z.string().min(1).max(24),
        probability: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1).default(0.6),
        source: z.string().min(1).max(500).default("role-hypothesis reflection"),
        sourceMessageIds: z.array(z.string().min(1).max(160)).max(8).default([]),
        sourceEvidenceIds: z.array(z.string().min(1).max(160)).max(8).default([])
      }).strict()).min(1).max(12)
    }).strict(),
    execute: async ({ hypotheses }, runContext) => {
      const ctx = scopedContext(runContext, actorId);
      const turn = ctx.world.snapshot().turn;
      const visibleMessageIds = new Set(ctx.world.observe(actorId).recentMessages.map((message) => message.id));
      const visibleEvidenceIds = new Set(ctx.world.socialCausalityFor(actorId).evidence.map((evidence) => evidence.evidenceId));
      for (const entry of hypotheses) {
        for (const messageId of entry.sourceMessageIds) {
          if (!visibleMessageIds.has(messageId)) {
            throw new Error(`ROLE_HYPOTHESIS_SOURCE_NOT_OBSERVED: '${messageId}' is not in the authorized observation.`);
          }
        }
        for (const evidenceId of entry.sourceEvidenceIds) {
          if (!visibleEvidenceIds.has(evidenceId)) {
            throw new Error(`ROLE_HYPOTHESIS_EVIDENCE_NOT_OBSERVED: '${evidenceId}' is not in the authorized observation.`);
          }
        }
      }
      const beliefRecords = hypotheses.map((entry) => ctx.world.recordBeliefUpdate(actorId, {
        subjectId: entry.subjectId,
        proposition: "has-role",
        kind: "identity",
        object: entry.role,
        probability: entry.probability,
        confidence: entry.confidence,
        source: entry.source,
        sourceMessageIds: entry.sourceMessageIds,
        sourceEvidenceIds: entry.sourceEvidenceIds,
        supports: true
      }));
      for (const entry of hypotheses) {
        const existing = ctx.mind.roleHypotheses.find(
          (candidate) => candidate.subjectId === entry.subjectId && candidate.role === entry.role
        );
        if (existing) {
          existing.probability = entry.probability;
          existing.updatedAtTurn = turn;
        } else {
          ctx.mind.roleHypotheses.push({ ...entry, updatedAtTurn: turn });
        }
      }
      // Renormalize per subject: probabilities across roles cap at 1, keeping
      // the ledger a valid distribution.
      const subjects = new Set(ctx.mind.roleHypotheses.map((entry) => entry.subjectId));
      for (const subjectId of subjects) {
        const entries = ctx.mind.roleHypotheses.filter((entry) => entry.subjectId === subjectId);
        const total = entries.reduce((sum, entry) => sum + entry.probability, 0);
        if (total > 1) {
          const scale = 1 / total;
          for (const entry of entries) entry.probability = Math.round(entry.probability * scale * 100) / 100;
        }
      }
      if (ctx.mind.roleHypotheses.length > 40) ctx.mind.roleHypotheses.splice(0, ctx.mind.roleHypotheses.length - 40);
      return {
        updated: true,
        beliefUpdateIds: beliefRecords.map((record) => record.beliefUpdateId),
        summary: subjects.size
          ? [...subjects].map((subjectId) => {
              const entries = ctx.mind.roleHypotheses
                .filter((entry) => entry.subjectId === subjectId)
                .sort((left, right) => right.probability - left.probability)
                .map((entry) => `${entry.role} ${Math.round(entry.probability * 100)}%`)
                .join(", ");
              return `${subjectId}: ${entries}`;
            }).join(" | ")
          : "cleared"
      };
    }
  }) as Tool<SocietyAgentContext>;
}

/**
 * The participant's private cognition tools: three internal passes the agent
 * performs itself inside its own session. Each call records a private note in
 * the agent's mind and emits one structured ThoughtBeat for the observer.
 * They can never change the world and have no identity of their own.
 */
export function createCognitionTools(context: SocietyAgentContext): Tool<SocietyAgentContext>[] {
  return [
    cognitivePassTool(context, "reflect_on_social_situation",
      [
        "Your own private reflection pass. Appraise the current situation before you act:",
        "- what incentives and risks are in play for you and for others;",
        "- which memories and relationships bear on this moment;",
        "- the two most concrete strategic options you see.",
        "Write a short private note (it stays in your mind and updates your visible ThoughtBeat). This pass cannot change the world.",
        "Use at most one cognition pass per turn unless the situation is urgent; prefer acting once you have enough clarity."
      ].join("\n"),
      "reflection", "notice", "策略反思"),
    createActorModelTool(context),
    cognitivePassTool(context, "plan_social_strategy",
      [
        "Your own private planning pass. Turn your goals, beliefs, relationships and read of the room into a concrete sequence for this exact phase:",
        "what to say, what to conceal, which tool to call, and what to watch for after the action.",
        "Write a short private note. This pass cannot change the world."
      ].join("\n"),
      "plan", "plan", "谋划行动")
  ];
}

function createActorModelTool(context: SocietyAgentContext): Tool<SocietyAgentContext> {
  return tool({
    name: "read_the_room",
    description: [
      "Update your private, evidence-linked model of relevant participants. This is your own theory of mind, never their true private state.",
      "For each target, estimate goals, likely knowledge, next actions, honesty and risk tolerance. Cite only message IDs and evidence IDs present in your current authorized context.",
      "Probabilities express uncertainty. This pass cannot change the world and cannot read another participant's private mind."
    ].join("\n"),
    parameters: z.object({
      models: z.array(z.object({
        targetActorId: z.string().min(1),
        inferredGoals: z.array(z.object({
          goal: z.string().min(1).max(500),
          probability: z.number().min(0).max(1)
        }).strict()).max(6).default([]),
        inferredKnowledge: z.array(z.object({
          proposition: z.string().min(1).max(500),
          probability: z.number().min(0).max(1)
        }).strict()).max(6).default([]),
        predictedActions: z.array(z.object({
          action: z.string().min(1).max(300),
          probability: z.number().min(0).max(1)
        }).strict()).max(6).default([]),
        perceivedStrategy: z.array(z.string().min(1).max(240)).max(6).default([]),
        perceivedHonesty: z.number().min(0).max(1),
        perceivedRiskTolerance: z.number().min(0).max(1),
        sourceMessageIds: z.array(z.string().min(1).max(160)).max(12).default([]),
        sourceEvidenceIds: z.array(z.string().min(1).max(160)).max(12).default([]),
        confidence: z.number().min(0).max(1)
      }).strict()).min(1).max(4),
      privateSummary: z.string().min(1).max(2_000)
    }).strict(),
    execute: async ({ models, privateSummary }, runContext) => {
      const ctx = scopedContext(runContext, context.actorId, context);
      const observation = ctx.world.observe(ctx.actorId);
      const visibleActors = new Set(observation.others.map((actor) => actor.id));
      const visibleMessages = new Set(observation.recentMessages.map((message) => message.id));
      const visibleEvidence = new Set(ctx.world.socialCausalityFor(ctx.actorId).evidence.map((entry) => entry.evidenceId));
      for (const model of models) {
        if (!visibleActors.has(model.targetActorId)) {
          throw new Error(`ACTOR_MODEL_TARGET_NOT_OBSERVED: '${model.targetActorId}' is not another visible participant.`);
        }
        for (const messageId of model.sourceMessageIds) {
          if (!visibleMessages.has(messageId)) {
            throw new Error(`ACTOR_MODEL_SOURCE_NOT_OBSERVED: '${messageId}' is not in the current authorized observation.`);
          }
        }
        for (const evidenceId of model.sourceEvidenceIds) {
          if (!visibleEvidence.has(evidenceId)) {
            throw new Error(`ACTOR_MODEL_EVIDENCE_NOT_OBSERVED: '${evidenceId}' is not in the current authorized social context.`);
          }
        }
      }
      const records = models.map((model) => ctx.world.recordActorModel(ctx.actorId, model));
      recordCognitivePass(ctx, "mind-read", privateSummary.trim());
      emitThoughtBeat(ctx, "hypothesis", "洞察全场", privateSummary.trim(), models.map((model) => model.targetActorId));
      return {
        recorded: true,
        kind: "mind-read",
        actorModelIds: records.map((record) => record.modelId)
      };
    }
  }) as Tool<SocietyAgentContext>;
}

function cognitivePassTool(
  context: SocietyAgentContext,
  toolName: string,
  toolDescription: string,
  passKind: AgentCognitivePass["kind"],
  beatKind: ThoughtBeatKind,
  beatTitle: string
): Tool<SocietyAgentContext> {
  return tool({
    name: toolName,
    description: toolDescription,
    parameters: z.object({
      text: z.string().min(1).max(4_000),
      targetIds: z.array(z.string().min(1)).max(8).default([])
    }).strict(),
    execute: async ({ text, targetIds }, runContext) => {
      const ctx = scopedContext(runContext, context.actorId, context);
      const note = text.trim();
      if (!note) return { recorded: false };
      recordCognitivePass(ctx, passKind, note);
      emitThoughtBeat(ctx, beatKind, beatTitle, note, targetIds);
      return { recorded: true, kind: passKind };
    }
  }) as Tool<SocietyAgentContext>;
}

function recordCognitivePass(context: SocietyAgentContext, kind: AgentCognitivePass["kind"], text: string): void {
  const turn = context.world.snapshot().turn;
  const existing = context.mind.cognitivePasses.findLast((entry) => entry.kind === kind && entry.turn === turn);
  if (existing) {
    existing.text = text;
    existing.at = new Date().toISOString();
  } else {
    context.mind.cognitivePasses.push({ kind, text, turn, at: new Date().toISOString() });
    if (context.mind.cognitivePasses.length > 30) context.mind.cognitivePasses.splice(0, context.mind.cognitivePasses.length - 30);
  }
}

/**
 * Emit one structured, observer-scoped ThoughtBeat. The beat is produced by
 * the agent whose mind recorded the pass — never synthesized after the fact.
 */
function emitThoughtBeat(
  context: SocietyAgentContext,
  kind: ThoughtBeatKind,
  title: string,
  summary: string,
  targetIds: string[]
): void {
  const beat: ThoughtBeat = {
    id: randomUUID(),
    roomId: context.roomId,
    agentId: context.actorId,
    kind,
    title,
    summary: summary.slice(0, 2_000),
    ...(targetIds.length ? { targetIds } : {}),
    visibility: "private",
    createdAt: new Date().toISOString()
  };
  context.emit({
    type: "agent.thought-beat",
    roomId: context.roomId,
    actorId: context.actorId,
    beat,
    at: beat.createdAt
  });
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
      }).strict().nullable().default(null),
      padDelta: z.object({
        pleasure: z.number().min(-1).max(1).default(0),
        arousal: z.number().min(-1).max(1).default(0),
        dominance: z.number().min(-1).max(1).default(0)
      }).strict().nullable().default(null),
      needsDelta: z.object({
        security: z.number().min(-1).max(1).default(0),
        connection: z.number().min(-1).max(1).default(0),
        status: z.number().min(-1).max(1).default(0),
        autonomy: z.number().min(-1).max(1).default(0),
        achievement: z.number().min(-1).max(1).default(0)
      }).strict().nullable().default(null),
      energyDelta: z.number().min(-0.3).max(0.3).nullable().default(null),
      attention: z.array(z.string().min(1).max(240)).max(5).nullable().default(null),
      relationship: z.object({
        agentId: z.string().min(1),
        trustDelta: z.number().min(-1).max(1).default(0),
        affinityDelta: z.number().min(-1).max(1).default(0),
        respectDelta: z.number().min(-1).max(1).default(0),
        tensionDelta: z.number().min(-1).max(1).default(0),
        note: z.string().max(1_000),
        sourceMessageIds: z.array(z.string().min(1).max(160)).max(12).default([]),
        sourceEvidenceIds: z.array(z.string().min(1).max(160)).max(12).default([])
      }).strict().nullable().default(null),
      belief: z.object({
        subjectId: z.string().min(1),
        proposition: z.string().min(1).max(1_000),
        probability: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1),
        source: z.string().min(1).max(1_000),
        sourceMessageIds: z.array(z.string().min(1).max(160)).max(12).default([]),
        supports: z.boolean().default(true)
      }).strict().nullable().default(null),
      goalProgress: z.object({
        goalId: z.string().min(1),
        progress: z.string().min(1).max(2_000),
        status: z.enum(["active", "satisfied", "abandoned"]).default("active")
      }).strict().nullable().default(null)
    }).strict(),
    execute: async ({ emotionDelta, padDelta, needsDelta, energyDelta, attention, relationship, belief, goalProgress }, runContext) => {
      const ctx = scopedContext(runContext, context.actorId, context);
      const turn = ctx.world.snapshot().turn;
      const beliefRecord = belief
        ? ctx.world.recordBeliefUpdate(ctx.actorId, {
            subjectId: belief.subjectId,
            proposition: belief.proposition,
            probability: belief.probability,
            confidence: belief.confidence,
            source: belief.source,
            sourceMessageIds: belief.sourceMessageIds,
            supports: belief.supports
          })
        : undefined;
      if (emotionDelta) ctx.mind.mood.emotions = applyEmotionDeltas(ctx.mind.mood.emotions, emotionDelta);
      if (padDelta) ctx.mind.mood.pad = applyPadDeltas(ctx.mind.mood.pad, padDelta);
      if (needsDelta) ctx.mind.mood.needs = applyNeedsDeltas(ctx.mind.mood.needs, needsDelta);
      if (energyDelta !== null) ctx.mind.mood.energy = clampUnit(ctx.mind.mood.energy + energyDelta);
      ctx.mind.mood = refreshMood(ctx.mind.mood, turn);
      if (attention) ctx.mind.attention = [...attention];
      const relationshipRecord = relationship ? updateRelationship(ctx, relationship, turn) : undefined;
      if (belief) updateBelief(ctx.mind, {
        subjectId: belief.subjectId,
        proposition: belief.proposition,
        probability: belief.probability,
        confidence: belief.confidence,
        source: belief.source
      }, turn);
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
        energy: Math.round(ctx.mind.mood.energy * 100) / 100,
        ...(beliefRecord ? { beliefUpdateId: beliefRecord.beliefUpdateId, beliefId: beliefRecord.beliefId } : {}),
        ...(relationshipRecord ? { relationshipDeltaId: relationshipRecord.relationshipDeltaId } : {})
      };
    }
  }) as Tool<SocietyAgentContext>;
}

function updateRelationship(
  ctx: SocietyAgentContext,
  input: {
    agentId: string;
    trustDelta: number;
    affinityDelta: number;
    respectDelta: number;
    tensionDelta: number;
    note: string;
    sourceMessageIds: string[];
    sourceEvidenceIds: string[];
  },
  turn: number
): import("./social/contracts").RelationshipDeltaRecord {
  const target = ctx.world.snapshot().agents.find((agent) => agent.id === input.agentId || agent.characterId === input.agentId);
  if (!target) throw new Error(`RELATIONSHIP_NOT_FOUND: '${input.agentId}' is not another participant in this room.`);
  const relationship = ctx.mind.relationships.find((candidate) => candidate.targetCharacterId === target.characterId);
  if (!relationship) throw new Error(`RELATIONSHIP_NOT_FOUND: '${input.agentId}' is not another participant in this room.`);
  const before = {
    trust: relationship.trust,
    affinity: relationship.affinity,
    respect: relationship.respect,
    tension: relationship.tension,
    familiarity: relationship.familiarity
  };
  const after = {
    trust: clamp(relationship.trust + input.trustDelta),
    affinity: clamp(relationship.affinity + input.affinityDelta),
    respect: clamp(relationship.respect + input.respectDelta),
    tension: clamp(relationship.tension + input.tensionDelta),
    familiarity: clamp(relationship.familiarity + 0.08)
  };
  const record = ctx.world.recordRelationshipUpdate(ctx.actorId, {
    targetActorId: target.id,
    before,
    after,
    note: input.note,
    sourceMessageIds: input.sourceMessageIds,
    sourceEvidenceIds: input.sourceEvidenceIds,
    sourceKind: "agent-self-report"
  });
  Object.assign(relationship, after, { updatedAtTurn: turn, note: input.note });
  return record;
}

function updateBelief(mind: AgentMindState, input: Omit<AgentBelief, "updatedAtTurn">, turn: number): void {
  const existing = mind.beliefs.find((belief) => belief.subjectId === input.subjectId && belief.proposition === input.proposition);
  if (existing) {
    existing.probability = input.probability;
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

export function formatObservation(observation: ReturnType<SocietyAgentContext["world"]["observe"]>): string {
  const visibleMessages = observation.recentMessages.slice(-16);
  const messageById = new Map(observation.recentMessages.map((message) => [message.id, message]));
  const messages = visibleMessages.map((message) => {
    const recipients = message.recipientIds?.length ? ` -> ${message.recipientIds.join(", ")}` : "";
    const reply = message.replyTo
      ? ` · reply to #${message.replyTo}${messageById.get(message.replyTo)?.senderName ? ` (${messageById.get(message.replyTo)?.senderName})` : ""}`
      : "";
    return `[#${message.id} · ${message.channel}${recipients}${reply}] ${message.senderName}: ${message.text}`;
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
