import { randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  PlayerActionSpec,
  ScenarioSummary,
  SocialMessage,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { scopedContext, SocialWorldBase } from "../world";
import { conversationSignalsFromSocialActs, DiscussionDirector } from "../conversation";
import { boundedRounds, discussionPersonality, emitAction } from "./helpers";
import { createStrategyActionShape, socialReferenceContext } from "../social/strategy-input";
import type { SocialActDeclaration } from "../social/contracts";

type Move = "take" | "pass";
type Phase = "discussion" | "move";

interface MoveRecord {
  move: number;
  moverId: string;
  action: Move;
  pot: number;
  payoffs: Record<string, number>;
  text: string;
}

/**
 * Centipede game. Two players alternate control of a pot that doubles with
 * every pass. Taking ends the game with an asymmetric split; passing hands
 * the (larger) temptation to the other player. Passing all the way splits the
 * pot evenly. Every move is preceded by open negotiation.
 */
export class CentipedeGameWorld extends SocialWorldBase {
  private readonly totalMoves: number;
  private readonly scores = new Map<string, number>();
  private readonly history: MoveRecord[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private discussion: DiscussionDirector;
  private phase: Phase = "discussion";
  private move = 1;
  private ended = false;
  private pendingMoveReconciliation?: PendingMoveReconciliation;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalMoves = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    this.discussion = this.createDiscussion();
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog(`蜈蚣博弈开始：奖池从 4 点起，每传递一次翻倍。共有 ${this.totalMoves} 次机会。`, 1);
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: CENTIPEDE_STATE_SCHEMA_VERSION,
      move: this.move,
      ended: this.ended,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      pendingMoveReconciliation: this.pendingMoveReconciliation ? structuredClone(this.pendingMoveReconciliation) : null,
      discussion: this.discussion.exportState(),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      move: number; ended: boolean; phase: string; scores: Array<[string, number]>;
      pendingMoveReconciliation: PendingMoveReconciliation | null;
      discussion: ReturnType<DiscussionDirector["exportState"]>;
      history: MoveRecord[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== 2 && s.schemaVersion !== CENTIPEDE_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: centipede-game ${s.schemaVersion}`);
    }
    this.move = Number(s.move ?? 1);
    this.ended = Boolean(s.ended);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.pendingMoveReconciliation = s.pendingMoveReconciliation ? structuredClone(s.pendingMoveReconciliation) : undefined;
    this.discussion = this.createDiscussion();
    this.discussion.restoreState(s.discussion);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.move,
      totalTurns: this.totalMoves,
      phase: this.phase === "discussion" ? "谈判" : `第 ${this.move} 步 · ${this.moverId()} 抉择`,
      summary: this.summary(),
      details: {
        scores: Object.fromEntries(this.scores),
        pot: this.pot(),
        moverId: this.moverId(),
        ended: this.ended,
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const myTurn = this.moverId() === actorId;
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.move,
      phase: this.phase === "discussion" ? "negotiation" : "move",
      situation: this.phase === "discussion"
        ? `The pot holds ${this.pot()} points and will double after every pass. ${myTurn ? "It is your move after this discussion." : "The other player moves after this discussion."}`
        : `The pot holds ${this.pot()} points. ${myTurn ? "You hold the move: take it now or pass it on." : "The other player holds the move."}`,
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Payoff if you take now: ${Math.floor(this.pot() * 0.7)} points; the other player gets ${Math.floor(this.pot() * 0.2)}.`,
        `If both players pass to the end, the pot splits evenly at ${Math.floor(this.pot() / 2)} each.`,
        ...socialReferenceContext(causality),
        `Moves so far: ${this.history.map((record) => `M${record.move} ${record.moverId} ${record.action}`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-20),
      availableActions: this.phase === "discussion"
        ? ["communicate", "recall_memory", "reflect_on_social_situation"]
        : ["centipede_move", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "centipede_move",
      description: "As the player on move, compare bounded take/pass intents and predict the public transition, then commit one irreversible typed move.",
      parameters: z.object({
        action: z.enum(["take", "pass"]),
        reason: z.string().min(1).max(2_000),
        ...createStrategyActionShape({ moveAction: z.enum(["take", "pass"]) }, CENTIPEDE_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.moveAction !== input.action) throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: Selected centipede move must equal the binding action.");
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "centipede_move", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({ ...candidate, action: "centipede_move", payloadSummary: `action=${candidate.moveAction}` }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [choose] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "move" || this.moverId() !== actorId || this.ended) return [];
    return [{
      name: "centipede_move",
      label: "提交选择",
      description: `拿走 ${Math.floor(this.pot() * 0.7)} 点并结束，或传递让奖池翻倍。`,
      kind: "choice",
      field: "action",
      options: [
        { value: "take", label: "拿走" },
        { value: "pass", label: "传递" }
      ]
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "centipede_move") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "move" || this.ended) throw new Error("MOVE_NOT_OPEN: Wait until it is your move.");
    if (this.moverId() !== actorId) throw new Error("NOT_YOUR_MOVE: The other player holds the current move.");
    const value = recordPayload(payload);
    const chosen = value.action;
    if (chosen !== "take" && chosen !== "pass") throw new Error("MOVE_INVALID: Choose take or pass.");
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const pot = this.pot();
    const commandId = `cmd-${randomUUID()}`;
    if (chosen === "take" || this.move >= this.totalMoves) {
      const ids = [...this.profiles.keys()];
      const payoffs = this.move >= this.totalMoves && chosen === "pass"
        ? { [ids[0]]: Math.floor(pot / 2), [ids[1]]: Math.floor(pot / 2) }
        : { [actorId]: Math.floor(pot * 0.7), [ids.find((id) => id !== actorId)!]: Math.floor(pot * 0.2) };
      const text = this.move >= this.totalMoves && chosen === "pass"
        ? `${this.profiles.get(actorId)?.displayName} passed the final move. The pot of ${pot} splits evenly.`
        : `${this.profiles.get(actorId)?.displayName} took the pot of ${pot}.`;
      const record: MoveRecord = { move: this.move, moverId: actorId, action: chosen, pot, payoffs, text };
      this.history.push(record);
      for (const id of ids) {
        this.scores.set(id, (this.scores.get(id) ?? 0) + (payoffs[id] ?? 0));
        this.lastExperiences.set(id, `${text} Payoffs: ${ids.map((entry) => `${entry}=${payoffs[entry]}`).join(", ")}. Your total: ${this.scores.get(id)}.`);
      }
      this.ended = true;
      const publicResult = this.recordPublicWorldFact({
        factKey: `centipede-move:${this.move}`,
        eventType: "centipede.move-resolved",
        predicate: "centipede-move-result",
        object: { moverId: actorId, action: chosen, pot, payoffs, ended: true },
        payload: { move: this.move, moverId: actorId, action: chosen, pot, payoffs, ended: true }
      });
      this.pendingMoveReconciliation = { commandId, actorId, move: this.move, action: chosen, pot, payoffs, ended: true, publicResultEventId: publicResult.eventId };
      this.addLog(text, this.move);
      this.finish();
      return { action, commandId, detail: reason ? `${chosen}; ${reason}` : chosen, result: { accepted: true, action: chosen, payoffs } };
    }
    const record: MoveRecord = { move: this.move, moverId: actorId, action: chosen, pot, payoffs: {}, text: `${this.profiles.get(actorId)?.displayName} passed. The pot doubles to ${pot * 2}.` };
    this.history.push(record);
    const publicResult = this.recordPublicWorldFact({
      factKey: `centipede-move:${this.move}`,
      eventType: "centipede.move-resolved",
      predicate: "centipede-move-result",
      object: { moverId: actorId, action: chosen, pot, nextPot: pot * 2, ended: false },
      payload: { move: this.move, moverId: actorId, action: chosen, pot, nextPot: pot * 2, ended: false }
    });
    this.pendingMoveReconciliation = { commandId, actorId, move: this.move, action: chosen, pot, payoffs: {}, ended: false, publicResultEventId: publicResult.eventId };
    this.addLog(record.text, this.move);
    this.move += 1;
    this.phase = "discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
    return { action, commandId, detail: reason ? `${chosen}; ${reason}` : chosen, result: { accepted: true, action: chosen, pot: pot * 2 } };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.ended) return null;
    if (this.phase === "discussion") {
      const actors = this.discussion.nextWave();
      if (actors.length) {
        const wave = this.discussion.waveNumber;
        return {
          id: `cg:${this.move}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.move} 步谈判` : `第 ${this.move} 步谈判 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? `The pot is ${this.pot()} and doubles with every pass. Signal intent, make a typed social promise, question the other player, negotiate, or stay quiet. Do not use centipede_move until the move phase.`
            : "Respond to the actual question, threat, promise, offer or private message directed at you. Do not repeat your opening statement and do not use centipede_move yet."
        };
      }
      this.phase = "move";
      this.emitUpdate();
    }
    return {
      id: `cg:${this.move}:move`,
      label: `第 ${this.move} 步抉择`,
      actorIds: [this.moverId()],
      mode: "sequential",
      instructionFor: (actorId) => actorId === this.moverId()
        ? `The pot is ${this.pot()}. Call centipede_move exactly once with bounded candidates and public-transition predictions: take now or pass.`
        : "The other player holds the move. You will observe the outcome."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion:")) {
      this.discussion.endWave();
      return { completed: true, missingActorIds: [] };
    }
    this.reconcilePendingMove();
    if (this.ended) return { completed: true, missingActorIds: [] };
    const missingActorIds = activation.actorIds.filter((id) => id === this.moverId() && this.phase === "move");
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your move is still missing. Call centipede_move exactly once now: take or pass."
      };
    }
    return { completed: true, missingActorIds: [] };
  }

  experienceFor(actorId: string): string | undefined {
    return this.lastExperiences.get(actorId);
  }

  async sendMessage(input: {
    senderId: string;
    channel: "public" | "private" | "team";
    text: string;
    recipientIds?: string[];
    replyTo?: string;
    socialActs?: SocialActDeclaration[];
  }): Promise<SocialMessage> {
    const message = await super.sendMessage(input);
    if (this.phase === "discussion") {
      this.discussion.onMessage({
        messageId: message.id,
        senderId: message.senderId,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.channel === "public" ? {} : { targetActorIds: message.recipientIds ?? [] })
      }, conversationSignalsFromSocialActs(message.senderId, message.id, input.socialActs ?? []));
    }
    return message;
  }

  protected messageWave(): number | undefined {
    return this.phase === "discussion" ? this.discussion.waveNumber : undefined;
  }

  private reconcilePendingMove(): void {
    const pending = this.pendingMoveReconciliation;
    if (!pending) return;
    const actorPayoff = pending.payoffs[pending.actorId] ?? 0;
    const actualFacts: Record<string, boolean> = {
      "game-ends-this-move": pending.ended,
      "pot-passes": !pending.ended && pending.action === "pass"
    };
    if (pending.ended) {
      actualFacts["actor-payoff-at-least-half-pot"] = actorPayoff >= pending.pot / 2;
      actualFacts["both-receive-positive"] = Object.values(pending.payoffs).length >= 2 && Object.values(pending.payoffs).every((payoff) => payoff > 0);
    }
    this.reconcileSocialOutcome({
      actionReceiptId: pending.commandId,
      actualOutcome: {
        summary: pending.ended
          ? `Move ${pending.move}: chose ${pending.action}; game ended at pot ${pending.pot}; payoff ${actorPayoff}.`
          : `Move ${pending.move}: passed pot ${pending.pot}; next pot ${pending.pot * 2}.`,
        metrics: { move: pending.move, action: pending.action, pot: pending.pot, ended: pending.ended, actorPayoff }
      },
      actualFacts,
      resultingEventIds: [pending.publicResultEventId],
    });
    this.pendingMoveReconciliation = undefined;
  }

  protected currentTurn(): number {
    return this.move;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(_actorId: string): boolean {
    return true;
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles)
    });
  }

  private moverId(): string {
    return [...this.profiles.keys()][(this.move - 1) % 2];
  }

  private pot(): number {
    return 4 * 2 ** (this.move - 1);
  }

  private summary(): string {
    if (this.status === "finished") {
      return [...this.scores].map(([id, score]) => `${this.profiles.get(id)?.displayName}: ${score}`).join(" · ");
    }
    return `第 ${this.move} / ${this.totalMoves} 步 · 奖池 ${this.pot()} · ${this.profiles.get(this.moverId())?.displayName} 持球`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}

interface PendingMoveReconciliation {
  commandId: string;
  actorId: string;
  move: number;
  action: Move;
  pot: number;
  payoffs: Record<string, number>;
  ended: boolean;
  publicResultEventId: string;
}

const CENTIPEDE_STATE_SCHEMA_VERSION = 3;
const CENTIPEDE_OUTCOME_KEYS = ["game-ends-this-move", "pot-passes", "actor-payoff-at-least-half-pot", "both-receive-positive"] as const;
