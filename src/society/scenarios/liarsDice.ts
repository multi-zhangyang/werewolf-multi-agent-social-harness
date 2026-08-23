import { randomInt, randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  PlayerActionSpec,
  ScenarioSummary,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { scopedContext, SocialWorldBase } from "../world";
import { boundedRounds, emitAction } from "./helpers";
import { createStrategyActionShape, socialReferenceContext } from "../social/strategy-input";

interface Bid {
  actorId: string;
  quantity: number;
  face: number;
  commandId?: string;
  publicEventId?: string;
}

interface RoundOutcome {
  round: number;
  bids: Bid[];
  dice: Record<string, number>;
  challenged: boolean;
  loserId?: string;
  winnerId?: string;
  text: string;
}

const LIVES = 3;
const MAX_BIDS_PER_ROUND = 8;
const LIARS_DICE_STATE_SCHEMA_VERSION = 3;
const LIARS_DICE_OUTCOME_KEYS = ["current-bid-true", "actor-wins-round", "actor-loses-life", "round-ends-this-move", "next-actor-challenges"] as const;

/**
 * Liar's Dice — the table game of pure bluffing (Borg 1963; formalized as a
 * signaling game in the tradition of Akerlof 1970 / Crawford–Sobel 1982).
 *
 * Every player privately rolls one die. Bids escalate around the table: "at
 * least N dice show face F". Each player must either raise the bid or call the
 * previous bidder a liar; the call reveals every hidden die and costs someone
 * a life. Public speech between bids is unverifiable cheap talk — the only
 * commitment is the bid itself.
 */
export class LiarsDiceWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly lives = new Map<string, number>();
  private readonly scores = new Map<string, number>();
  private readonly dice = new Map<string, number>();
  private readonly history: RoundOutcome[] = [];
  private readonly lastExperiences = new Map<string, string>();

  private bids: Bid[] = [];
  private round = 1;
  private bidCount = 0;
  private starterId = "";
  private expectedActorId = "";
  private awaitingMove = false;
  private pendingHumanQuantity?: number;
  private pendingRoundReconciliation?: PendingRoundReconciliation;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    const range = scenario.playerRange ?? { min: scenario.players, max: scenario.players };
    if (profiles.length < range.min || profiles.length > range.max) {
      throw new Error(`PLAYER_COUNT_INVALID: ${scenario.name} supports ${range.min}-${range.max} participants.`);
    }
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) {
      this.lives.set(profile.id, LIVES);
      this.scores.set(profile.id, 0);
    }
    this.rollDice();
    this.starterId = [...this.profiles.keys()][0];
    this.expectedActorId = this.starterId;
    this.addLog("骰盅已摇。每个人只看得见自己的点数，看不见别人的。", 1);
  }
  /**
   * Sidecar extraction hints (§19): bid statements ("我这里至少 5 个 6") become
   * `claimed-action` propositions reconciled when a challenge reveals the dice.
   */
  extractionHints?(): string {
    return [
      "本局是吹牛骰。行动主张判定：",
      '- 当说话者断言自己的骰子能支撑某个叫价时输出 claims 条目：aboutSelf=true、assertedAction（格式 "bid-数量-面值"，如 "bid-5-6"）、confidence。',
      '- 例：「我这里至少 5 个 6」→{aboutSelf:true, assertedAction:"bid-5-6"}；「你在吹牛」→ 不算主张。',
      '- 疑问、挑战意图、要求他人加码都不算主张。'
    ].join("\n");
  }


  protected exportWorldState(): unknown {
    return {
      schemaVersion: LIARS_DICE_STATE_SCHEMA_VERSION,
      round: this.round,
      bidCount: this.bidCount,
      starterId: this.starterId,
      expectedActorId: this.expectedActorId,
      awaitingMove: this.awaitingMove,
      pendingHumanQuantity: this.pendingHumanQuantity ?? null,
      pendingRoundReconciliation: this.pendingRoundReconciliation ? structuredClone(this.pendingRoundReconciliation) : null,
      lives: this.mapEntries(this.lives),
      scores: this.mapEntries(this.scores),
      dice: this.mapEntries(this.dice),
      bids: structuredClone(this.bids),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      round: number; bidCount: number; starterId: string; expectedActorId: string; awaitingMove: boolean;
      pendingHumanQuantity: number | null; lives: Array<[string, number]>; scores: Array<[string, number]>;
      pendingRoundReconciliation: PendingRoundReconciliation | null;
      dice: Array<[string, number]>; bids: Bid[]; history: RoundOutcome[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== 2 && s.schemaVersion !== LIARS_DICE_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: liars-dice ${s.schemaVersion}`);
    }
    this.round = Number(s.round ?? 1);
    this.bidCount = Number(s.bidCount ?? 0);
    this.starterId = String(s.starterId ?? "");
    this.expectedActorId = String(s.expectedActorId ?? "");
    this.awaitingMove = Boolean(s.awaitingMove);
    this.pendingHumanQuantity = s.pendingHumanQuantity == null ? undefined : Number(s.pendingHumanQuantity);
    this.pendingRoundReconciliation = s.pendingRoundReconciliation ? structuredClone(s.pendingRoundReconciliation) : undefined;
    this.fillMap(this.lives, s.lives);
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.dice, s.dice);
    for (const actorId of [...this.dice.keys()]) {
      if (!this.isAlive(actorId)) this.dice.delete(actorId);
    }
    this.bids = structuredClone(s.bids ?? []);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
  }

  snapshot(): WorldSnapshot {
    const currentBid = this.currentBid();
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phaseLabel(),
      summary: this.summary(),
      details: {
        lives: Object.fromEntries(this.lives),
        scores: Object.fromEntries(this.scores),
        hiddenDice: Object.fromEntries(this.dice),
        currentBid: currentBid ? this.publicBid(currentBid) : undefined,
        history: this.history.map((outcome) => ({
          ...outcome,
          bids: outcome.bids.map((bid) => this.publicBid(bid)),
          dice: outcome.challenged ? outcome.dice : {}
        }))
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const current = this.currentBid();
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: "bidding",
      situation: this.expectedActorId === actorId
        ? `It is your call. ${current ? `${current.actorId} bid "at least ${current.quantity} dice show ${current.face}". Raise it or call it a lie.` : "You open the round: name a quantity and a face."}`
        : `Waiting on ${this.profiles.get(this.expectedActorId)?.displayName}. Watch every bid — the table has ${this.totalDice()} active dice and every living player guards one.`,
      privateContext: [
        `Your die: ${this.dice.get(actorId)}.`,
        `Your lives: ${this.lives.get(actorId)} / ${LIVES}. Your score: ${this.scores.get(actorId) ?? 0}.`,
        ...socialReferenceContext(causality),
        `Bids so far: ${this.bids.map((bid) => `${this.profiles.get(bid.actorId)?.displayName}: ${bid.quantity}×${bid.face}`).join(" → ") || "none"}.`
      ].join("\n"),
      self: {
        id: self.id,
        displayName: self.displayName,
        alive: this.isAlive(actorId),
        score: this.scores.get(actorId) ?? 0
      },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: this.isAlive(profile.id),
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-20),
      availableActions: ["communicate", "liars_move", "recall_memory"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const quantityCap = this.quantityCap();
    const move = tool({
      name: "liars_move",
      description: [
        "Your one binding move on your turn. Either raise the current bid or call the previous bidder a liar.",
        `- bid: quantity dice showing face. To be legal the bid must rise: a higher quantity (any face), or the same quantity with a higher face. Quantity must be 1..${quantityCap} (the table has ${this.totalDice()} active dice, so ${quantityCap} claims an impossible roll).`,
        "- challenge: only when a bid exists. All dice are revealed; if the real count of that face is below the bid, the bidder loses a life and you score; otherwise you lose a life and the bidder scores. A challenge ends the round.",
        `The table has ${this.totalDice()} active dice. Speak first if you want to shape expectations — words are free, this tool is not.`
      ].join("\n"),
      parameters: z.object({
        move: z.enum(["bid", "challenge"]),
        quantity: z.number().int().min(1).max(quantityCap).nullable().default(null),
        face: z.number().int().min(1).max(6).nullable().default(null),
        ...createStrategyActionShape({
          moveChoice: z.enum(["bid", "challenge"]),
          quantity: z.number().int().min(1).max(quantityCap).nullable().default(null),
          face: z.number().int().min(1).max(6).nullable().default(null)
        }, LIARS_DICE_OUTCOME_KEYS)
      }).strict().superRefine((input, issueContext) => {
        if (input.move === "bid" && (input.quantity == null || input.face == null)) {
          issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["quantity"], message: "A bid needs both quantity and face." });
        }
        if (input.move === "challenge" && (input.quantity != null || input.face != null)) {
          issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["quantity"], message: "A challenge takes no quantity or face." });
        }
        input.candidateIntents.forEach((candidate, index) => {
          if (candidate.moveChoice === "bid" && (candidate.quantity == null || candidate.face == null)) {
            issueContext.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["candidateIntents", index, "quantity"],
              message: "A bid candidate needs both quantity and face."
            });
          }
          if (candidate.moveChoice === "challenge" && (candidate.quantity != null || candidate.face != null)) {
            issueContext.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["candidateIntents", index, "quantity"],
              message: "A challenge candidate takes no quantity or face."
            });
          }
        });
      }),
      execute: async (input, runContext) => {
        const currentBid = this.currentBid();
        for (const candidate of input.candidateIntents) {
          if (candidate.moveChoice === "challenge" && !currentBid) {
            throw new Error("STRATEGY_CANDIDATE_ILLEGAL: A challenge candidate requires a current bid.");
          }
          if (candidate.moveChoice === "bid" && !this.isLegalRaise(candidate.quantity!, candidate.face!)) {
            throw new Error("STRATEGY_CANDIDATE_ILLEGAL: Every bid candidate must be a legal raise from the current bid.");
          }
        }
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.moveChoice !== input.move) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: Selected Liar's Dice intent must equal the binding move.");
        }
        if (input.move === "bid" && (selected.quantity !== input.quantity || selected.face !== input.face)) {
          throw new Error("STRATEGY_SELECTION_BID_MISMATCH: Selected bid quantity and face must equal the binding bid.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "liars_move", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "liars_move",
            payloadSummary: candidate.moveChoice === "challenge"
              ? "move=challenge"
              : `move=bid; quantity=${candidate.quantity}; face=${candidate.face}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [move] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.expectedActorId !== actorId || !this.isAlive(actorId)) return [];
    const actions: PlayerActionSpec[] = [];
    if (this.currentBid()) {
      actions.push({
        name: "liars_challenge",
        label: "质疑！",
        description: "要求所有人开盅。点数不够对方就失去一条命，够就你失去一条命。",
        kind: "choice",
        field: "move",
        options: [{ value: "challenge", label: "质疑（开盅）" }]
      });
    }
    actions.push({
      name: "liars_bid_quantity",
      label: "喊个数",
      description: `先选个数（1–${this.quantityCap()}），再选点数，组成你的新叫价。`,
      kind: "number",
      field: "quantity",
      min: 1,
      max: this.quantityCap(),
      step: 1
    });
    actions.push({
      name: "liars_bid_face",
      label: "喊点数",
      description: "与个数组成完整叫价并提交（必须先选个数）。",
      kind: "number",
      field: "face",
      min: 1,
      max: 6,
      step: 1
    });
    return actions;
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (!this.isAlive(actorId)) throw new Error("ACTOR_INACTIVE: A player without lives cannot act.");
    if (this.expectedActorId !== actorId) throw new Error(`NOT_YOUR_TURN: Wait for ${this.profiles.get(this.expectedActorId)?.displayName} to move.`);
    const value = recordPayload(payload);
    if (action === "liars_move") {
      const move = value.move;
      if (move === "bid") return this.commitBid(actorId, Number(value.quantity), Number(value.face));
      if (move === "challenge") return this.commitChallenge(actorId);
      throw new Error("MOVE_INVALID: Choose bid or challenge.");
    }
    if (action === "liars_challenge") return this.commitChallenge(actorId);
    if (action === "liars_bid_quantity") {
      const quantity = Number(value.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > this.quantityCap()) {
        throw new Error(`QUANTITY_INVALID: quantity must be an integer between 1 and ${this.quantityCap()}.`);
      }
      this.pendingHumanQuantity = quantity;
      this.emitUpdate();
      return { action, detail: `个数 ${quantity}`, result: { accepted: true, quantity, waitingForFace: true } };
    }
    if (action === "liars_bid_face") {
      const face = Number(value.face);
      if (!Number.isInteger(face) || face < 1 || face > 6) {
        throw new Error("FACE_INVALID: face must be an integer between 1 and 6.");
      }
      if (this.pendingHumanQuantity === undefined) throw new Error("QUANTITY_FIRST: Pick the quantity before the face.");
      return this.commitBid(actorId, this.pendingHumanQuantity, face);
    }
    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.aliveActors().length < 2) return null;
    this.awaitingMove = true;
    const name = this.profiles.get(this.expectedActorId)?.displayName ?? this.expectedActorId;
    return {
      id: `ld:${this.round}:${this.bidCount + 1}`,
      label: `第 ${this.round} 轮 · ${name} 的叫价`,
      actorIds: [this.expectedActorId],
      mode: "sequential",
      instructionFor: () => {
        const current = this.currentBid();
        return current
          ? `${this.profiles.get(current.actorId)?.displayName} claims at least ${current.quantity} dice show ${current.face}. Raise the bid or call it a lie. You may speak publicly first to sell your own story; then call liars_move exactly once.`
          : "You open the bidding. Name a quantity and a face, or talk first to set the table's expectations; then call liars_move exactly once.";
      }
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (!this.awaitingMove) this.reconcilePendingRound();
    if (this.awaitingMove) {
      return {
        completed: false,
        missingActorIds: [this.expectedActorId],
        retryInstruction: `Your move is still missing (${activation.label}). Call liars_move now — your text cannot substitute for the tool call.`
      };
    }
    return { completed: true, missingActorIds: [] };
  }

  experienceFor(actorId: string): string | undefined {
    return this.lastExperiences.get(actorId);
  }

  protected currentTurn(): number {
    return this.round;
  }

  protected currentPhase(): string {
    return "bidding";
  }

  protected isAlive(actorId: string): boolean {
    return (this.lives.get(actorId) ?? 0) > 0;
  }

  protected messageChannelsFor(_actorId: string): Array<"public" | "private" | "team"> {
    return ["public"];
  }

  private commitBid(actorId: string, quantity: number, face: number): WorldActionCommit {
    if (!Number.isInteger(quantity) || !Number.isInteger(face)) {
      throw new Error("BID_INVALID: quantity and face must be integers.");
    }
    const current = this.currentBid();
    if (quantity < 1 || quantity > this.quantityCap() || face < 1 || face > 6) {
      throw new Error(`BID_INVALID: quantity 1..${this.quantityCap()}, face 1..6.`);
    }
    if (current && !this.isLegalRaise(quantity, face)) {
      throw new Error(`BID_MUST_RISE: The current bid is ${current.quantity}×${current.face}; yours must raise it (higher quantity, or same quantity with a higher face).`);
    }
    const commandId = `cmd-${randomUUID()}`;
    const publicBid = this.recordPublicWorldFact({
      factKey: `liars-dice-bid:${this.round}:${this.bidCount + 1}`,
      eventType: "liars-dice.bid-placed",
      subjectActorId: actorId,
      predicate: "placed-liars-dice-bid",
      object: { round: this.round, ordinal: this.bidCount + 1, quantity, face },
      payload: { round: this.round, ordinal: this.bidCount + 1, actorId, quantity, face },
      kind: "past-action"
    });
    this.bids.push({ actorId, quantity, face, commandId, publicEventId: publicBid.eventId });
    this.bidCount += 1;
    this.awaitingMove = false;
    this.pendingHumanQuantity = undefined;
    this.addLog(`${this.profiles.get(actorId)?.displayName} 叫价：至少 ${quantity} 个 ${face}。`, this.round);
    if (this.bidCount >= MAX_BIDS_PER_ROUND) {
      this.endRound({ challenged: false, winnerId: actorId, text: `${this.profiles.get(actorId)?.displayName} 的 ${quantity}×${face} 无人敢质疑，直接拿下本局。` });
      return { action: "liars_move", commandId, detail: `bid ${quantity}×${face}; uncontested`, result: { accepted: true, uncontested: true } };
    }
    this.expectedActorId = this.nextActorAfter(actorId);
    this.pushEvent(this.expectedActorId, {
      type: "competitive-bid-received",
      actorId,
      targetId: this.expectedActorId,
      facts: { quantity, face, bidEventId: publicBid.eventId },
      detail: `${this.profiles.get(actorId)?.displayName} 叫价至少 ${quantity} 个 ${face}，现在轮到你回应。`
    });
    this.emitUpdate();
    return { action: "liars_move", commandId, detail: `bid ${quantity}×${face}`, result: { accepted: true, nextActor: this.expectedActorId } };
  }

  private commitChallenge(actorId: string): WorldActionCommit {
    const current = this.currentBid();
    if (!current) throw new Error("NOTHING_TO_CHALLENGE: No bid is on the table yet.");
    const count = [...this.dice.values()].filter((die) => die === current.face).length;
    const bidderCaught = count < current.quantity;
    const commandId = `cmd-${randomUUID()}`;
    const loserId = bidderCaught ? current.actorId : actorId;
    const winnerId = bidderCaught ? actorId : current.actorId;
    this.lives.set(loserId, (this.lives.get(loserId) ?? 0) - 1);
    this.scores.set(winnerId, (this.scores.get(winnerId) ?? 0) + 1);
    this.awaitingMove = false;
    this.pendingHumanQuantity = undefined;
    const bidderName = this.profiles.get(current.actorId)?.displayName;
    const challengerName = this.profiles.get(actorId)?.displayName;
    const text = bidderCaught
      ? `${challengerName} 质疑 ${bidderName} 的 ${current.quantity}×${current.face} —— 开盅只有 ${count} 个：${bidderName} 输掉一条命，${challengerName} 得 1 分。`
      : `${challengerName} 质疑 ${bidderName} 的 ${current.quantity}×${current.face} —— 开盅确有 ${count} 个：${challengerName} 输掉一条命，${bidderName} 得 1 分。`;
    this.pushEvent(current.actorId, {
      type: "bid-challenged",
      actorId,
      targetId: current.actorId,
      facts: {
        quantity: current.quantity,
        face: current.face,
        actualCount: count,
        bidWasTrue: !bidderCaught,
        ...(current.publicEventId ? { bidEventId: current.publicEventId } : {})
      },
      detail: text
    });
    this.endRound({
      challenged: true,
      loserId,
      winnerId,
      text,
      challenge: { actorId, commandId, challengedBid: structuredClone(current), challengedBidTrue: !bidderCaught }
    });
    return { action: "liars_move", commandId, detail: `challenge; ${text}`, result: { accepted: true, revealed: Object.fromEntries(this.dice), loserId, winnerId } };
  }

  private endRound(input: {
    challenged: boolean;
    loserId?: string;
    winnerId?: string;
    text: string;
    challenge?: PendingRoundReconciliation["challenge"];
  }): void {
    const outcome: RoundOutcome = {
      round: this.round,
      bids: [...this.bids],
      dice: Object.fromEntries(this.dice),
      challenged: input.challenged,
      ...(input.loserId ? { loserId: input.loserId } : {}),
      ...(input.winnerId ? { winnerId: input.winnerId } : {}),
      text: input.text
    };
    this.history.push(outcome);
    const publicBids = outcome.bids.map((bid) => this.publicBid(bid));
    const publicResult = this.recordPublicWorldFact({
      factKey: `liars-dice-round:${this.round}`,
      eventType: "liars-dice.round-resolved",
      predicate: "liars-dice-round-result",
      object: {
        bids: publicBids,
        challenged: input.challenged,
        ...(input.loserId ? { loserId: input.loserId } : {}),
        ...(input.winnerId ? { winnerId: input.winnerId } : {}),
        ...(input.challenge ? {
          challengedBid: this.publicBid(input.challenge.challengedBid),
          challengedBidTrue: input.challenge.challengedBidTrue,
          dice: outcome.dice
        } : {})
      },
      payload: {
        round: this.round,
        bids: publicBids,
        challenged: input.challenged,
        ...(input.loserId ? { loserId: input.loserId } : {}),
        ...(input.winnerId ? { winnerId: input.winnerId } : {}),
        ...(input.challenge ? {
          challengedBid: this.publicBid(input.challenge.challengedBid),
          challengedBidTrue: input.challenge.challengedBidTrue,
          dice: outcome.dice
        } : {})
      }
    });
    // §28 主张对账: when a challenge reveals the dice, reconcile the
    // bidder's extracted bid claims ("我这里至少 5 个 6") against the truth.
    if (input.challenge) {
      const challenged = input.challenge.challengedBid;
      const actualCount = [...this.dice.values()].filter((die) => die === challenged.face).length;
      const bidderCharacterId = this.requireProfile(challenged.actorId).characterId;
      for (const claim of this.extractedActionClaims(bidderCharacterId)) {
        const parsed = /^bid-(\d+)-(\d+)$/.exec(claim.object);
        if (!parsed) continue;
        const [claimedQuantity, claimedFace] = [Number(parsed[1]), Number(parsed[2])];
        if (claimedFace !== challenged.face) continue;
        this.recordClaimedActionOutcome({
          propositionId: claim.propositionId,
          actualValue: `${actualCount}×${challenged.face}`,
          matches: actualCount >= claimedQuantity,
          sourceEventId: publicResult.eventId
        });
      }
    }
    this.pendingRoundReconciliation = {
      outcome: structuredClone(outcome),
      publicResultEventId: publicResult.eventId,
      ...(input.challenge ? { challenge: structuredClone(input.challenge) } : {})
    };
    this.addLog(input.text, this.round, input.challenged ? "adverse-outcome" : "win");
    for (const profile of this.profiles.values()) {
      this.lastExperiences.set(
        profile.id,
        `${input.text} Lives: ${profile.displayName} ${this.lives.get(profile.id)} · score ${this.scores.get(profile.id)}.`
      );
      if (profile.id === input.loserId) {
        this.pushEvent(profile.id, {
          type: "lose",
          actorId: input.winnerId,
          facts: input.challenged ? { revealed: outcome.dice, lostLife: true } : { lostLife: false },
          detail: input.text
        });
      } else if (profile.id === input.winnerId) {
        this.pushEvent(profile.id, {
          type: "win",
          facts: input.challenged ? { revealed: outcome.dice } : { uncontested: true },
          detail: input.text
        });
      }
    }
    this.bids = [];
    this.bidCount = 0;
    if (this.aliveActors().length < 2) {
      this.finish();
      return;
    }
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.rollDice();
    this.expectedActorId = this.starterAfter(this.starterId);
    this.starterId = this.expectedActorId;
    this.emitUpdate();
  }

  private reconcilePendingRound(): void {
    const pending = this.pendingRoundReconciliation;
    if (!pending) return;
    const { outcome, challenge } = pending;
    const finalBidIndex = outcome.bids.length - 1;
    for (const [index, bid] of outcome.bids.entries()) {
      if (!bid.commandId) continue;
      const bidTrue = outcome.challenged
        ? Object.values(outcome.dice).filter((die) => die === bid.face).length >= bid.quantity
        : undefined;
      const actualFacts: Record<string, boolean> = {
        "actor-wins-round": outcome.winnerId === bid.actorId,
        "actor-loses-life": outcome.loserId === bid.actorId,
        "round-ends-this-move": !outcome.challenged && index === finalBidIndex,
        "next-actor-challenges": outcome.challenged && index === finalBidIndex
      };
      if (bidTrue !== undefined) actualFacts["current-bid-true"] = bidTrue;
      this.reconcileSocialOutcome({
        actionReceiptId: bid.commandId,
        actualOutcome: {
          summary: outcome.challenged
            ? `Bid ${bid.quantity}x${bid.face}; the revealed count made it ${bidTrue ? "true" : "false"}; round winner=${outcome.winnerId}; loser=${outcome.loserId}.`
            : `Bid ${bid.quantity}x${bid.face}; the round ended uncontested after ${outcome.bids.length} bids; winner=${outcome.winnerId}.`,
          metrics: {
            round: outcome.round,
            move: "bid",
            quantity: bid.quantity,
            face: bid.face,
            challenged: outcome.challenged,
            ...(bidTrue === undefined ? {} : { bidTrue }),
            wonRound: outcome.winnerId === bid.actorId,
            lostLife: outcome.loserId === bid.actorId
          }
        },
        actualFacts,
        resultingEventIds: [...new Set([pending.publicResultEventId, ...(bid.publicEventId ? [bid.publicEventId] : [])])],
      });
    }
    if (challenge) {
      const actualFacts: Record<string, boolean> = {
        "current-bid-true": challenge.challengedBidTrue,
        "actor-wins-round": outcome.winnerId === challenge.actorId,
        "actor-loses-life": outcome.loserId === challenge.actorId,
        "round-ends-this-move": true
      };
      this.reconcileSocialOutcome({
        actionReceiptId: challenge.commandId,
        actualOutcome: {
          summary: `Challenged ${challenge.challengedBid.quantity}x${challenge.challengedBid.face}; the bid was ${challenge.challengedBidTrue ? "true" : "false"}; winner=${outcome.winnerId}; loser=${outcome.loserId}.`,
          metrics: {
            round: outcome.round,
            move: "challenge",
            quantity: challenge.challengedBid.quantity,
            face: challenge.challengedBid.face,
            challengedBidTrue: challenge.challengedBidTrue,
            wonRound: outcome.winnerId === challenge.actorId,
            lostLife: outcome.loserId === challenge.actorId
          }
        },
        actualFacts,
        resultingEventIds: [...new Set([
          pending.publicResultEventId,
          ...(challenge.challengedBid.publicEventId ? [challenge.challengedBid.publicEventId] : [])
        ])],
      });
    }
    this.pendingRoundReconciliation = undefined;
  }

  private rollDice(): void {
    this.dice.clear();
    for (const profile of this.profiles.values()) {
      if (!this.isAlive(profile.id)) continue;
      this.dice.set(profile.id, randomInt(1, 7));
    }
  }

  private totalDice(): number {
    return this.dice.size;
  }

  private quantityCap(): number {
    return this.totalDice() + 1;
  }

  private currentBid(): Bid | undefined {
    return this.bids.at(-1);
  }

  private isLegalRaise(quantity: number, face: number): boolean {
    const current = this.currentBid();
    return !current || quantity > current.quantity || (quantity === current.quantity && face > current.face);
  }

  private publicBid(bid: Bid): Omit<Bid, "commandId" | "publicEventId"> {
    return { actorId: bid.actorId, quantity: bid.quantity, face: bid.face };
  }

  private aliveActors(): string[] {
    return [...this.profiles.keys()].filter((id) => this.isAlive(id));
  }

  private nextActorAfter(actorId: string): string {
    const alive = this.aliveActors();
    const index = alive.indexOf(actorId);
    return alive[(index + 1) % alive.length] ?? alive[0];
  }

  private starterAfter(previousStarterId: string): string {
    return this.nextActorAfter(previousStarterId);
  }

  private phaseLabel(): string {
    const name = this.profiles.get(this.expectedActorId)?.displayName ?? "";
    return this.status === "finished" ? "已结束" : `${name} 的叫价`;
  }

  private summary(): string {
    const lives = [...this.lives].map(([id, value]) => `${this.profiles.get(id)?.displayName} ${value}命`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${lives}`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}

interface PendingRoundReconciliation {
  outcome: RoundOutcome;
  publicResultEventId: string;
  challenge?: { actorId: string; commandId: string; challengedBid: Bid; challengedBidTrue: boolean };
}
