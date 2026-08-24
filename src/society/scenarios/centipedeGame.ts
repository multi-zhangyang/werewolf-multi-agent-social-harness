import { randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  Commitment,
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
import { socialReferenceContext } from "../social/context-refs";
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
  private readonly commitments: Commitment[] = [];
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

  /**
   * Sidecar extraction hints: move statements ("我会拿走"/"我会传递")
   * become `claimed-action` propositions reconciled against the actual move.
   */
  extractionHints?(): string {
    return [
      "本局是蜈蚣博弈。行动主张判定：",
      '- 当持球者断言自己将选择的行为时输出 claims 条目：aboutSelf=true、assertedAction（只能是 "take"=拿走 或 "pass"=传递）、confidence。',
      '- 例：「我会拿走」→{aboutSelf:true, assertedAction:"take"}；「我保证继续传递」→{aboutSelf:true, assertedAction:"pass"}；「你应该传递」→ 不算主张。',
      '- 疑问、劝告、要求对方表态都不算主张。'
    ].join("\n");
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
        commitments: this.commitments,
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
        this.openCommitmentsFor(actorId).length
          ? `Open commitments:\n${this.openCommitmentsFor(actorId).map((commitment) => `- [${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("\n")}`
          : "Open commitments: none.",
        `Settled commitments: ${this.settledCommitmentsFor(actorId).map((commitment) => `[${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("; ") || "none"}.`,
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
      description: "As the player on move, commit one irreversible typed move: take now or pass the pot on.",
      parameters: z.object({
        action: z.enum(["take", "pass"]),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "centipede_move", {
          action: input.action,
          reason: input.reason
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const makeCommitment = tool({
      name: "make_commitment",
      description: "Propose a public typed promise to take or pass on your next move. It is recorded, but settles as kept or broken only if the other participant explicitly accepts it.",
      parameters: z.object({
        moveAction: z.enum(["take", "pass"]),
        proposition: z.string().min(1).max(400),
        condition: z.string().min(1).max(400).nullable().default(null)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "make_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const acceptCommitment = tool({
      name: "accept_commitment",
      description: "Explicitly accept one proposed commitment addressed to you. Acceptance makes it eligible for deterministic settlement against the sealed move.",
      parameters: z.object({ commitmentId: z.string().min(1).max(200) }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [choose, makeCommitment, acceptCommitment] as Tool<SocietyAgentContext>[];
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
    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Commitments are proposed during the negotiation.");
      const value = recordPayload(payload);
      const moveAction = value.moveAction;
      if (moveAction !== "take" && moveAction !== "pass") throw new Error("COMMITMENT_MOVE_INVALID: Promise take or pass.");
      const proposition = typeof value.proposition === "string" ? value.proposition.trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: State the promise explicitly.");
      const ownCount = this.commitments.filter((entry) => entry.round === this.move && entry.promisorActorId === actorId).length;
      if (ownCount >= 2) throw new Error("COMMITMENT_LIMIT_EXCEEDED: At most two proposals per participant per move.");
      const commandId = `cmd-${randomUUID()}`;
      const commitment: Commitment = {
        commitmentId: `commit:cg:${this.move}:${actorId}:${ownCount + 1}`,
        round: this.move,
        promisorActorId: actorId,
        promisorCharacterId: this.requireProfile(actorId).characterId,
        audienceActorIds: [...this.profiles.keys()].filter((id) => id !== actorId),
        proposition,
        promisedAction: {
          actionType: "centipede-move",
          choice: moveAction,
          ...(typeof value.condition === "string" && value.condition.trim() ? { condition: value.condition.trim() } : {})
        },
        state: "proposed",
        acceptedByActorIds: [],
        acceptedByCommandIds: [],
        createdByCommandId: commandId,
        createdAtTurn: this.move,
        schemaVersion: 1
      };
      this.commitments.push(commitment);
      this.recordSocialCommitment(commitment);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: "commitment-proposed",
          actorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promisedMove: moveAction },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 提议承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: proposition, result: { accepted: true, commitmentId: commitment.commitmentId } };
    }
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Accept commitments during the negotiation.");
      const value = recordPayload(payload);
      const commitmentId = typeof value.commitmentId === "string" ? value.commitmentId : "";
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId && entry.round === this.move);
      if (!commitment) throw new Error(`COMMITMENT_NOT_FOUND: '${commitmentId}'.`);
      if (commitment.promisorActorId === actorId || !commitment.audienceActorIds.includes(actorId)) {
        throw new Error("COMMITMENT_ACCEPTOR_INVALID: Only the other participant may accept this proposal.");
      }
      if (commitment.state !== "proposed" && commitment.state !== "accepted") {
        throw new Error(`COMMITMENT_NOT_OPEN: '${commitmentId}' is already ${commitment.state}.`);
      }
      const acceptedByActorIds = commitment.acceptedByActorIds ?? (commitment.acceptedByActorIds = []);
      const acceptedByCommandIds = commitment.acceptedByCommandIds ?? (commitment.acceptedByCommandIds = []);
      if (acceptedByActorIds.includes(actorId)) throw new Error(`COMMITMENT_ALREADY_ACCEPTED: '${commitmentId}'.`);
      const commandId = `cmd-${randomUUID()}`;
      acceptedByActorIds.push(actorId);
      acceptedByCommandIds.push(commandId);
      commitment.acceptedAtTurn = this.move;
      commitment.state = "accepted";
      this.acceptSocialCommitment(commitment, actorId, commandId);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: "commitment-accepted",
          actorId,
          targetId: commitment.promisorActorId,
          facts: { commitmentId },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 接受了承诺「${commitment.proposition}」。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: commitmentId, result: { accepted: true, commitmentId, state: commitment.state } };
    }
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
      const beat = this.settleMoveCommitments(actorId, chosen, publicResult.eventId);
      this.pendingMoveReconciliation = { commandId, actorId, move: this.move, action: chosen, pot, payoffs, ended: true, publicResultEventId: publicResult.eventId };
      this.addLog(text, this.move, beat);
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
    const beat = this.settleMoveCommitments(actorId, chosen, publicResult.eventId);
    this.pendingMoveReconciliation = { commandId, actorId, move: this.move, action: chosen, pot, payoffs: {}, ended: false, publicResultEventId: publicResult.eventId };
    this.addLog(record.text, this.move, beat);
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
        ? `The pot is ${this.pot()}. Call centipede_move exactly once: take now or pass.`
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

  private settleMoveCommitments(moverId: string, actualAction: Move, sourceEventId: string): "promise-kept" | "promise-broken" | undefined {
    // 主张对账: reconcile extracted move claims ("我会拿走") against the
    // actual sealed move.
    const moverCharacterId = this.requireProfile(moverId).characterId;
    for (const claim of this.extractedActionClaims(moverCharacterId)) {
      this.recordClaimedActionOutcome({
        propositionId: claim.propositionId,
        actualValue: actualAction,
        matches: claim.object === actualAction,
        sourceEventId
      });
    }
    const accepted = this.commitments.filter((entry) => entry.round === this.move && entry.state === "accepted");
    let anyViolated = false;
    let anyFulfilled = false;
    for (const commitment of accepted) {
      if (commitment.promisedAction.actionType !== "centipede-move") continue;
      if (commitment.promisorActorId !== moverId) continue;
      const promised = commitment.promisedAction.choice;
      if (promised !== "take" && promised !== "pass") continue;
      const fulfilled = promised === actualAction;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.move;
      commitment.settledByCommandId = commitment.createdByCommandId;
      this.settleSocialCommitment(commitment);
      if (fulfilled) anyFulfilled = true; else anyViolated = true;
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promisedMove: promised, actualMove: actualAction },
          detail: fulfilled
            ? `承诺兑现：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 承诺${promised}，实际也${actualAction}。`
            : `承诺违约：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 承诺${promised}，实际${actualAction}。`
        });
      }
    }
    for (const commitment of this.commitments.filter((entry) => entry.round === this.move && entry.state === "proposed")) {
      commitment.state = "void";
      commitment.settledAtTurn = this.move;
      this.settleSocialCommitment(commitment);
    }
    return anyViolated ? "promise-broken" as const : anyFulfilled ? "promise-kept" as const : undefined;
  }

  private openCommitmentsThisMove(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round === this.move &&
      (entry.state === "proposed" || entry.state === "accepted") &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private settledCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round < this.move &&
      entry.state !== "proposed" && entry.state !== "accepted" &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
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
