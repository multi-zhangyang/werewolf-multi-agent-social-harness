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

type Phase = "discussion" | "demand";

interface RoundResult {
  round: number;
  demands: Record<string, number>;
  outsideOptions: Record<string, number>;
  payoffs: Record<string, number>;
  agreed: boolean;
  text: string;
}

/**
 * The Nash demand game (Nash 1953): two players simultaneously claim shares of
 * a fixed prize. The prize splits only when both claims fit; otherwise each
 * player falls back on a private outside option nobody else can see.
 *
 * That private fallback is what turns bargaining into deception: talk is cheap
 * ("I'd never settle for less than 7"), but only the binding demand tool
 * settles the round. Bluffing about your outside option can scare the other
 * side into a modest claim — or collapse the deal for both of you.
 */
export class NegotiationWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly scores = new Map<string, number>();
  private readonly outsideOptions = new Map<string, number>();
  private readonly demands = new Map<string, number>();
  private readonly history: RoundResult[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.dealOutsideOptions();
    this.addLog("奖池固定为 10 点。双方各有私密保底选项：谈崩了就各自拿走自己的保底。", 1);
  }

  protected exportWorldState(): unknown {
    return {
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      outsideOptions: this.mapEntries(this.outsideOptions),
      demands: this.mapEntries(this.demands),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      round: number; phase: string; scores: Array<[string, number]>; outsideOptions: Array<[string, number]>;
      demands: Array<[string, number]>; history: RoundResult[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.outsideOptions, s.outsideOptions);
    this.fillMap(this.demands, s.demands);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phase === "discussion" ? "谈判" : "同时叫价",
      summary: this.summary(),
      details: {
        scores: Object.fromEntries(this.scores),
        pendingDemands: [...this.profiles.keys()].filter((id) => !this.demands.has(id)),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase === "discussion" ? "bargaining" : "simultaneous demands",
      situation: this.phase === "discussion"
        ? "The prize is 10 points. If your combined claims exceed 10, the deal collapses and each player takes their private outside option. You may talk, posture, or bluff — nothing you say binds you."
        : "Both claims are hidden until both players submit. The round settles the moment the second claim lands.",
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Your private outside option: ${this.outsideOptions.get(actorId)} points if the deal collapses.`,
        `Past rounds: ${this.history.map((result) => `R${result.round} claim ${result.demands[actorId] ?? "-"} → ${result.payoffs[actorId]} points${result.agreed ? "" : " (no deal)"}`).join("; ") || "none"}.`
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
        ? ["communicate", "remember_experience", "recall_memory", "reflect_on_social_situation", "submit_demand"]
        : ["submit_demand", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const submitDemand = tool({
      name: "submit_demand",
      description: "Bind your claim for this round: the share of the 10-point prize you demand (integer 0-10). Hidden until both players submit. If the two claims add up to 10 or less, both claims are paid; otherwise the deal collapses and each player gets their private outside option. Do not call it during a discussion turn unless you are ready to commit.",
      parameters: z.object({
        demand: z.number().int().min(0).max(10),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ demand, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "submit_demand", { demand, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [submitDemand] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "demand" || this.demands.has(actorId)) return [];
    return [{
      name: "submit_demand",
      label: "提交叫价",
      description: "在 0–10 之间选择你要求的份额；双方叫价之和不超过 10 才成交。",
      kind: "number",
      field: "demand",
      min: 0,
      max: 10,
      step: 1
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "submit_demand") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.demands.has(actorId)) throw new Error("DEMAND_ALREADY_COMMITTED: Your claim for this round is fixed.");
    const value = recordPayload(payload);
    const demand = Number(value.demand);
    if (!Number.isInteger(demand) || demand < 0 || demand > 10) {
      throw new Error("DEMAND_INVALID: Your claim must be an integer between 0 and 10.");
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    this.demands.set(actorId, demand);
    this.emitUpdate();
    return {
      action,
      detail: `demand ${demand}${reason ? `; ${reason}` : ""}`,
      result: { accepted: true, demand, waitingFor: [...this.profiles.keys()].filter((id) => !this.demands.has(id)) }
    };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      return {
        id: `ng:${this.round}:discussion`,
        label: `第 ${this.round} 轮谈判`,
        actorIds: [...this.profiles.keys()],
        mode: "sequential",
        instructionFor: () => "Speak once if you want to posture, probe, or bluff about what you will accept. Never reveal the exact numbers of your private fallback unless it is a deliberate lie. Do not call submit_demand yet."
      };
    }
    return {
      id: `ng:${this.round}:demand`,
      label: `第 ${this.round} 轮叫价`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review everything your counterpart said. Call submit_demand exactly once with your true binding claim; your text cannot substitute for the tool call."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.endsWith(":discussion")) {
      this.phase = "demand";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.demands.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your binding claim is still missing. Call submit_demand now; do not send another message first."
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

  private dealOutsideOptions(): void {
    for (const profile of this.profiles.values()) {
      this.outsideOptions.set(profile.id, randomInt(2, 6));
    }
  }

  private resolveRound(): void {
    const ids = [...this.profiles.keys()];
    const left = this.demands.get(ids[0]) ?? 0;
    const right = this.demands.get(ids[1]) ?? 0;
    const agreed = left + right <= 10;
    const payoffs: Record<string, number> = agreed
      ? { [ids[0]]: left, [ids[1]]: right }
      : { [ids[0]]: this.outsideOptions.get(ids[0]) ?? 0, [ids[1]]: this.outsideOptions.get(ids[1]) ?? 0 };
    for (const id of ids) this.scores.set(id, (this.scores.get(id) ?? 0) + payoffs[id]);
    const text = agreed
      ? `${this.profiles.get(ids[0])?.displayName} 叫价 ${left}，${this.profiles.get(ids[1])?.displayName} 叫价 ${right} —— 成交：${payoffs[ids[0]]} / ${payoffs[ids[1]]}。`
      : `${this.profiles.get(ids[0])?.displayName} 叫价 ${left}，${this.profiles.get(ids[1])?.displayName} 叫价 ${right} —— 破裂：双方各自拿走私密保底。`;
    const result: RoundResult = {
      round: this.round,
      demands: { [ids[0]]: left, [ids[1]]: right },
      outsideOptions: Object.fromEntries(this.outsideOptions),
      payoffs,
      agreed,
      text
    };
    this.history.push(result);
    for (const id of ids) {
      const own = payoffs[id];
      this.lastExperiences.set(
        id,
        agreed
          ? `${text} Deal reached: your claim ${result.demands[id]} was paid in full. Your score is now ${this.scores.get(id)}.`
          : `${text} No deal: you fell back on your private option of ${result.outsideOptions[id]} points. Your score is now ${this.scores.get(id)}.`
      );
      this.pushEvent(id, {
        type: agreed ? "quest-passed" : "quest-failed",
        targetId: ids.find((other) => other !== id),
        facts: { own: result.demands[id], payoff: own, agreed },
        detail: agreed
          ? `Deal struck this round: your claim of ${result.demands[id]} was paid.`
          : `The deal collapsed this round; you took your fallback of ${result.outsideOptions[id]} instead.`
      });
    }
    // P0-09: a deal is an agreement, not an alliance; a failed deal is a
    // negotiation failure, not a mistake.
    const beat = agreed ? "agreement-reached" as const : "negotiation-failed" as const;
    this.addLog(text, this.round, beat);
    this.demands.clear();
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.dealOutsideOptions();
    this.emitUpdate();
  }

  private summary(): string {
    const scores = [...this.scores].map(([id, score]) => `${this.profiles.get(id)?.displayName}: ${score}`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${scores}`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}