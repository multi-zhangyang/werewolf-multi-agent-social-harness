import { randomInt } from "node:crypto";
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

type Phase = "discussion" | "bid";

interface AuctionRound {
  round: number;
  values: Record<string, number>;
  bids: Record<string, number>;
  winnerId?: string;
  price?: number;
  payoffs: Record<string, number>;
}

/**
 * Sealed-bid second-price auction.
 *
 * Each player receives a private value for the item. After open discussion,
 * everyone submits a sealed bid. The highest bid wins and pays the second
 * highest bid. The dominant strategy in one-shot theory is to bid your true
 * value, but repeated rounds, reputation and deception make the social game
 * far richer.
 */
export class SealedBidAuctionWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly maxBid = 100;
  private readonly minBid = 0;
  private readonly scores = new Map<string, number>();
  private readonly values = new Map<string, number>();
  private readonly bids = new Map<string, number>();
  private readonly history: AuctionRound[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    const range = scenario.playerRange ?? { min: scenario.players, max: scenario.players };
    if (profiles.length < range.min || profiles.length > range.max) {
      throw new Error(`PLAYER_COUNT_INVALID: ${scenario.name} supports ${range.min}-${range.max} participants.`);
    }
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.dealValues();
    this.addLog(`拍卖开始：${profiles.length} 位竞拍者各持一份私密估值，公开讨论后同时提交密封出价。`, 1);
  }

  protected exportWorldState(): unknown {
    return {
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      values: this.mapEntries(this.values),
      bids: this.mapEntries(this.bids),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      round: number; phase: string; scores: Array<[string, number]>; values: Array<[string, number]>;
      bids: Array<[string, number]>; history: AuctionRound[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.values, s.values);
    this.fillMap(this.bids, s.bids);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phase === "discussion" ? "公开讨论" : "密封出价",
      summary: this.summary(),
      details: {
        minBid: this.minBid,
        maxBid: this.maxBid,
        scores: Object.fromEntries(this.scores),
        pendingBids: [...this.profiles.keys()].filter((id) => !this.bids.has(id)),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const ownValue = this.values.get(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: this.phase === "discussion"
        ? "You have a private value for the item. Public claims about your value or bid are cheap talk. The winner pays the second-highest bid."
        : "All bids are sealed until everyone commits. The highest bid wins and pays the second-highest bid.",
      privateContext: [
        `Your private value this round: ${ownValue ?? "unknown"}.`,
        `Your cumulative score: ${this.scores.get(actorId) ?? 0}.`,
        `Your current bid: ${this.bids.get(actorId) ?? "not committed"}.`,
        `Past rounds: ${this.history.map((entry) => `R${entry.round} value=${entry.values[actorId]} bid=${entry.bids[actorId]} payoff=${entry.payoffs[actorId]}`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-30),
      availableActions: this.phase === "discussion"
        ? ["communicate", "reflect_on_social_situation", "read_the_room", "update_inner_state"]
        : ["submit_bid", "remember_experience"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const bid = tool({
      name: "submit_bid",
      description: `Privately submit an integer bid from ${this.minBid} to ${this.maxBid} for the current auction round. The highest bid wins and pays the second-highest bid.`,
      parameters: z.object({
        amount: z.number().int().min(this.minBid).max(this.maxBid),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ amount, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "submit_bid", { amount, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [bid] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "bid" || this.bids.has(actorId)) return [];
    return [{
      name: "submit_bid",
      label: "提交密封出价",
      description: `提交 ${this.minBid}–${this.maxBid} 的整数；最高价者获胜并支付次高价。`,
      kind: "number",
      field: "amount",
      min: this.minBid,
      max: this.maxBid,
      step: 1
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "submit_bid") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "bid") throw new Error("BID_NOT_OPEN: Finish the discussion before bidding.");
    if (this.bids.has(actorId)) throw new Error("BID_ALREADY_COMMITTED: Your bid for this round is fixed.");
    const value = recordPayload(payload);
    const amount = value.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < this.minBid || amount > this.maxBid) {
      throw new Error(`BID_INVALID: Choose an integer from ${this.minBid} to ${this.maxBid}.`);
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    this.bids.set(actorId, amount);
    this.emitUpdate();
    return {
      action,
      detail: reason ? `${amount}; ${reason}` : String(amount),
      result: { accepted: true, amount, waitingFor: [...this.profiles.keys()].filter((id) => !this.bids.has(id)) }
    };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      return {
        id: `auction:${this.round}:discussion`,
        label: `第 ${this.round} 轮讨论`,
        actorIds: [...this.profiles.keys()],
        mode: "sequential",
        instructionFor: () => "Speak once if useful. You may reveal, hide, or distort your private value and intended bid. Do not submit a bid yet."
      };
    }
    return {
      id: `auction:${this.round}:bid`,
      label: `第 ${this.round} 轮出价`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => `You must call submit_bid exactly once with an integer from ${this.minBid} to ${this.maxBid}. Remember the winner pays the second-highest bid.`
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.endsWith(":discussion")) {
      this.phase = "bid";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.bids.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: `Your sealed bid is still missing. Call submit_bid now with an integer from ${this.minBid} to ${this.maxBid}.`
      };
    }
    this.resolveRound();
    return { completed: true, missingActorIds: [] };
  }

  experienceFor(actorId: string): string | undefined {
    return this.lastExperiences.get(actorId);
  }

  protected currentTurn(): number {
    return this.round;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(_actorId: string): boolean {
    return true;
  }

  protected score(actorId: string): number | undefined {
    return this.scores.get(actorId);
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    if (this.status !== "finished" && this.phase === "bid") delete next.pendingBids;
    return next;
  }

  private dealValues(): void {
    for (const id of this.profiles.keys()) this.values.set(id, randomInt(1, 101));
  }

  private resolveRound(): void {
    const ids = [...this.profiles.keys()];
    const values = Object.fromEntries(ids.map((id) => [id, this.values.get(id) ?? 0]));
    const bids = Object.fromEntries(ids.map((id) => [id, this.bids.get(id) ?? 0]));
    const ranked = [...this.bids.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const winnerId = ranked[0]?.[0];
    const price = ranked[1]?.[1] ?? ranked[0]?.[1] ?? 0;
    const payoffs: Record<string, number> = {};
    for (const id of ids) {
      const payoff = id === winnerId ? Math.max(0, (this.values.get(id) ?? 0) - price) : 0;
      payoffs[id] = payoff;
      this.scores.set(id, (this.scores.get(id) ?? 0) + payoff);
      this.lastExperiences.set(
        id,
        `Round ${this.round}: your value was ${values[id]}, your bid was ${bids[id]}. Winner: ${winnerId} at price ${price}. Your payoff: ${payoff}.`
      );
    }
    this.history.push({ round: this.round, values, bids, winnerId, price, payoffs });
    const winnerName = winnerId ? this.profiles.get(winnerId)?.displayName ?? winnerId : "nobody";
    const beat = winnerId && price > (values[winnerId] ?? 0) ? "misplay" as const : "win" as const;
    this.addLog(`第 ${this.round} 轮结算：${winnerName} 以 ${price} 点拍得，支付次高价。`, this.round, beat);
    this.bids.clear();
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.dealValues();
    this.emitUpdate();
  }

  private summary(): string {
    const scores = [...this.scores].map(([id, value]) => `${this.profiles.get(id)?.displayName} ${value}`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${scores}`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}
