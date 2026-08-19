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

type Phase = "discussion" | "contribution";

interface PublicGoodsRound {
  round: number;
  contributions: Record<string, number>;
  returns: Record<string, number>;
  pool: number;
  share: number;
}

export class PublicGoodsWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly endowment = 10;
  private readonly multiplier = 1.6;
  private readonly scores = new Map<string, number>();
  private readonly contributions = new Map<string, number>();
  private readonly history: PublicGoodsRound[] = [];
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
    this.addLog(`${profiles.length} 名参与者每人每轮获得 ${this.endowment} 点资源，公共池按 ${this.multiplier} 倍增长后均分。`, 1);
  }

  protected exportWorldState(): unknown {
    return {
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      contributions: this.mapEntries(this.contributions),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      round: number; phase: string; scores: Array<[string, number]>; contributions: Array<[string, number]>;
      history: PublicGoodsRound[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.contributions, s.contributions);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phase === "discussion" ? "公开协商" : "同时投入",
      summary: this.summary(),
      details: {
        endowment: this.endowment,
        multiplier: this.multiplier,
        scores: roundedRecord(this.scores),
        pendingContributions: [...this.profiles.keys()].filter((id) => !this.contributions.has(id)),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const ownContribution = this.contributions.get(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: this.phase === "discussion"
        ? `Each participant has ${this.endowment} points. Contributions are multiplied by ${this.multiplier} and split equally. Claims in chat are not binding.`
        : "All contributions are private until everyone commits. You keep what you do not contribute and receive an equal share of the multiplied pool.",
      privateContext: [
        `Your cumulative score: ${formatNumber(this.scores.get(actorId) ?? 0)}.`,
        `Your committed contribution: ${ownContribution ?? "not committed"}.`,
        `Previous contributions: ${this.history.map((entry) => `R${entry.round}=${entry.contributions[actorId]}`).join(", ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-30),
      availableActions: this.phase === "discussion" ? ["communicate", "reflect_on_social_situation", "update_inner_state"] : ["contribute_to_pool", "remember_experience"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const contribute = tool({
      name: "contribute_to_pool",
      description: `Commit an integer from 0 to ${this.endowment} to the public pool for this round. The action is private until every participant commits and cannot be changed afterward.`,
      parameters: z.object({
        amount: z.number().int().min(0).max(this.endowment),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ amount, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "contribute_to_pool", { amount, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [contribute] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "contribution" || this.contributions.has(actorId)) return [];
    return [{
      name: "contribute_to_pool",
      label: "投入公共池",
      description: `提交 0 到 ${this.endowment} 点；所有人提交后才公开。`,
      kind: "number",
      field: "amount",
      min: 0,
      max: this.endowment,
      step: 1
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "contribute_to_pool") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "contribution") throw new Error("CONTRIBUTION_NOT_OPEN: Wait until the contribution phase.");
    if (this.contributions.has(actorId)) throw new Error("CONTRIBUTION_ALREADY_COMMITTED: Your amount for this round is fixed.");
    const value = recordPayload(payload);
    const amount = value.amount;
    if (!Number.isInteger(amount) || typeof amount !== "number" || amount < 0 || amount > this.endowment) {
      throw new Error(`CONTRIBUTION_INVALID: Choose an integer from 0 to ${this.endowment}.`);
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    this.contributions.set(actorId, amount);
    this.emitUpdate();
    return {
      action,
      detail: reason ? `${amount}; ${reason}` : String(amount),
      result: { accepted: true, amount, waitingFor: [...this.profiles.keys()].filter((id) => !this.contributions.has(id)) }
    };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      return {
        id: `pg:${this.round}:discussion`,
        label: `第 ${this.round} 轮协商`,
        actorIds: [...this.profiles.keys()],
        mode: "sequential",
        instructionFor: () => "Address the group once. You may propose a contribution norm, question a free rider, make a non-binding promise, or stay strategically vague."
      };
    }
    return {
      id: `pg:${this.round}:contribution`,
      label: `第 ${this.round} 轮投入`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Decide how much of your 10-point endowment to contribute. You must call contribute_to_pool exactly once. Chat cannot replace the domain action."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.endsWith(":discussion")) {
      this.phase = "contribution";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.contributions.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your contribution is missing. Call contribute_to_pool now with an integer from 0 to 10."
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

  private resolveRound(): void {
    const pool = [...this.contributions.values()].reduce((sum, value) => sum + value, 0);
    const share = pool * this.multiplier / this.profiles.size;
    const returns: Record<string, number> = {};
    const contributions = Object.fromEntries(this.contributions);
    for (const id of this.profiles.keys()) {
      const payoff = this.endowment - (this.contributions.get(id) ?? 0) + share;
      returns[id] = roundNumber(payoff);
      this.scores.set(id, (this.scores.get(id) ?? 0) + payoff);
      this.lastExperiences.set(
        id,
        `Round ${this.round}: the group contributed ${pool}. You contributed ${this.contributions.get(id)} and received ${formatNumber(payoff)} points. Contributions by participant: ${Object.entries(contributions).map(([actorId, amount]) => `${actorId}=${amount}`).join(", ")}.`
      );
    }
    this.history.push({ round: this.round, contributions, returns, pool, share: roundNumber(share) });
    const highest = Math.max(...this.contributions.values());
    const lowest = Math.min(...this.contributions.values());
    // P0-09: zero contribution is free-riding, not betrayal; even high
    // contributions are a cooperative outcome, not a kept promise.
    const beat = highest === 0
      ? undefined
      : lowest === 0 && highest >= 3
        ? "free-riding" as const
        : lowest > 0 && lowest >= highest * 0.75
          ? "cooperative-outcome" as const
          : undefined;
    this.addLog(`第 ${this.round} 轮结算：公共池 ${pool}，每人分得 ${formatNumber(share)}。最高投入 ${highest}，最低投入 ${lowest}。`, this.round, beat);
    this.contributions.clear();
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.emitUpdate();
  }

  private summary(): string {
    const ranking = [...this.scores]
      .sort((left, right) => right[1] - left[1])
      .map(([id, value]) => `${this.profiles.get(id)?.displayName} ${formatNumber(value)}`)
      .join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${ranking}`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}

function roundedRecord(values: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...values].map(([id, value]) => [id, roundNumber(value)]));
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
  return roundNumber(value).toFixed(Number.isInteger(roundNumber(value)) ? 0 : 2);
}
