import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  ScenarioSummary,
  SocietyAgentContext,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { contextFromRunContext, SocialWorldBase } from "../world";
import { boundedRounds, emitAction } from "./helpers";

type Phase = "discussion" | "investment" | "return";

interface TrustRound {
  round: number;
  investorId: string;
  trusteeId: string;
  investment: number;
  multipliedAmount: number;
  returnedAmount: number;
  payoffs: Record<string, number>;
}

export class TrustGameWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly multiplier = 3;
  private readonly endowment = 10;
  private readonly scores = new Map<string, number>();
  private readonly history: TrustRound[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private round = 1;
  private investment?: number;
  private returnedAmount?: number;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    if (profiles.length !== 2) throw new Error("PLAYER_COUNT_INVALID: Trust Game requires two participants.");
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addStory("第一轮开始", "投资者先决定交出多少资源，受托者随后决定返还多少。", "neutral", 1);
  }

  snapshot(): WorldSnapshot {
    const [investorId, trusteeId] = this.rolesForRound();
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        investorId,
        trusteeId,
        multiplier: this.multiplier,
        endowment: this.endowment,
        investment: this.investment,
        multipliedAmount: this.investment === undefined ? undefined : this.investment * this.multiplier,
        returnedAmount: this.returnedAmount,
        scores: Object.fromEntries(this.scores),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const [investorId, trusteeId] = this.rolesForRound();
    const role = actorId === investorId ? "investor" : "trustee";
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: situationFor(this.phase, role, this.investment, this.multiplier),
      privateContext: [
        `Your role this round: ${role}.`,
        `Your cumulative score: ${this.scores.get(actorId) ?? 0}.`,
        `Investment: ${this.investment ?? "not committed"}. Return: ${this.returnedAmount ?? "not committed"}.`,
        `Role history: ${this.history.map((entry) => `R${entry.round} ${entry.investorId === actorId ? "investor" : "trustee"}, payoff ${entry.payoffs[actorId]}`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, role, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle",
        visibleRole: profile.id === investorId ? "investor" : "trustee"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-24),
      availableActions: this.availableActions(actorId, investorId, trusteeId)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const invest = tool({
      name: "make_investment",
      description: `As the current investor, commit an integer from 0 to ${this.endowment}. The amount is multiplied by ${this.multiplier} before the trustee decides what to return.`,
      parameters: z.object({ amount: z.number().int().min(0).max(this.endowment), reason: z.string().min(1).max(500) }).strict(),
      execute: async ({ amount, reason }, runContext) => {
        const context = contextFromRunContext(runContext);
        const [investorId] = this.rolesForRound();
        if (this.phase !== "investment") throw new Error("INVESTMENT_NOT_OPEN: make_investment is only valid during the investment phase.");
        if (actorId !== investorId) throw new Error(`ROLE_MISMATCH: The current investor is '${investorId}'.`);
        if (this.investment !== undefined) throw new Error("INVESTMENT_ALREADY_COMMITTED: The investment cannot be changed.");
        this.investment = amount;
        emitAction(context, "make_investment", `${amount}; ${reason}`);
        this.emitUpdate();
        return { accepted: true, investment: amount, trusteeReceives: amount * this.multiplier };
      }
    });
    const returnFromTrust = tool({
      name: "return_from_trust",
      description: "As the current trustee, return an integer amount to the investor from the multiplied investment. You may return none, some, or all of the available amount.",
      parameters: z.object({ amount: z.number().int().min(0), reason: z.string().min(1).max(500) }).strict(),
      execute: async ({ amount, reason }, runContext) => {
        const context = contextFromRunContext(runContext);
        const [, trusteeId] = this.rolesForRound();
        if (this.phase !== "return") throw new Error("RETURN_NOT_OPEN: return_from_trust is only valid after an investment.");
        if (actorId !== trusteeId) throw new Error(`ROLE_MISMATCH: The current trustee is '${trusteeId}'.`);
        const available = (this.investment ?? 0) * this.multiplier;
        if (amount > available) throw new Error(`RETURN_EXCEEDS_AVAILABLE: Return at most ${available}.`);
        if (this.returnedAmount !== undefined) throw new Error("RETURN_ALREADY_COMMITTED: The return cannot be changed.");
        this.returnedAmount = amount;
        emitAction(context, "return_from_trust", `${amount}; ${reason}`);
        this.emitUpdate();
        return { accepted: true, returnedAmount: amount, retainedAmount: available - amount };
      }
    });
    return [invest, returnFromTrust] as Tool<SocietyAgentContext>[];
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.round > this.totalRounds) return null;
    const [investorId, trusteeId] = this.rolesForRound();
    if (this.phase === "discussion") {
      return {
        id: `tg:${this.round}:discussion`,
        label: `第 ${this.round} 轮协商`,
        actorIds: [investorId, trusteeId],
        mode: "sequential",
        instructionFor: (actorId) => actorId === investorId
          ? "You are the investor. State or conceal what level of reciprocity would justify a larger investment. Speak once before acting."
          : "You are the trustee. You may make a non-binding promise, challenge the investor's assumptions, or preserve ambiguity. Speak once."
      };
    }
    if (this.phase === "investment") {
      return {
        id: `tg:${this.round}:investment`,
        label: `第 ${this.round} 轮投资`,
        actorIds: [investorId],
        mode: "sequential",
        instructionFor: () => "You must now call make_investment exactly once. Evaluate the trustee's promises, your relationship history, and the role reversal in future rounds."
      };
    }
    return {
      id: `tg:${this.round}:return`,
      label: `第 ${this.round} 轮返还`,
      actorIds: [trusteeId],
      mode: "sequential",
      instructionFor: () => `The investment was ${this.investment}; you control ${(this.investment ?? 0) * this.multiplier}. You must call return_from_trust exactly once.`
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.endsWith(":discussion")) {
      this.phase = "investment";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":investment")) {
      if (this.investment === undefined) {
        return { completed: false, missingActorIds: activation.actorIds, retryInstruction: "Call make_investment now with an integer from 0 to 10." };
      }
      this.phase = "return";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (this.returnedAmount === undefined) {
      return { completed: false, missingActorIds: activation.actorIds, retryInstruction: `Call return_from_trust now with an integer from 0 to ${(this.investment ?? 0) * this.multiplier}.` };
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

  protected observerRole(actorId: string): string | undefined {
    const [investorId] = this.rolesForRound();
    return actorId === investorId ? "投资者" : "受托者";
  }

  private availableActions(actorId: string, investorId: string, trusteeId: string): string[] {
    if (this.phase === "investment" && actorId === investorId) return ["make_investment", "remember_experience"];
    if (this.phase === "return" && actorId === trusteeId) return ["return_from_trust", "remember_experience"];
    return ["communicate", "reflect_on_social_situation", "update_social_model"];
  }

  private rolesForRound(): [string, string] {
    const ids = [...this.profiles.keys()];
    return this.round % 2 === 1 ? [ids[0], ids[1]] : [ids[1], ids[0]];
  }

  private resolveRound(): void {
    const [investorId, trusteeId] = this.rolesForRound();
    const investment = this.investment ?? 0;
    const multipliedAmount = investment * this.multiplier;
    const returnedAmount = this.returnedAmount ?? 0;
    const investorPayoff = this.endowment - investment + returnedAmount;
    const trusteePayoff = multipliedAmount - returnedAmount;
    this.scores.set(investorId, (this.scores.get(investorId) ?? 0) + investorPayoff);
    this.scores.set(trusteeId, (this.scores.get(trusteeId) ?? 0) + trusteePayoff);
    const payoffs = { [investorId]: investorPayoff, [trusteeId]: trusteePayoff };
    this.history.push({ round: this.round, investorId, trusteeId, investment, multipliedAmount, returnedAmount, payoffs });
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(
        id,
        `Round ${this.round}: ${investorId} invested ${investment}, creating ${multipliedAmount}; ${trusteeId} returned ${returnedAmount}. Your payoff was ${payoffs[id]}. Roles reverse on the next round.`
      );
    }
    const reciprocal = investment > 0 && returnedAmount >= investment;
    this.addStory(
      `第 ${this.round} 轮结算`,
      `投入 ${investment}，增长为 ${multipliedAmount}，返还 ${returnedAmount}。`,
      reciprocal ? "positive" : investment > 0 && returnedAmount === 0 ? "danger" : "warning",
      this.round
    );
    this.investment = undefined;
    this.returnedAmount = undefined;
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
    const scores = [...this.scores].map(([id, value]) => `${this.profiles.get(id)?.displayName} ${value}`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${scores}`;
  }
}

function phaseLabel(phase: Phase): string {
  if (phase === "discussion") return "协商";
  if (phase === "investment") return "投资";
  return "返还";
}

function situationFor(phase: Phase, role: "investor" | "trustee", investment: number | undefined, multiplier: number): string {
  if (phase === "discussion") return `You are the ${role}. Promises are not binding, and roles will reverse next round.`;
  if (phase === "investment") return role === "investor" ? "Choose how much control to transfer to the trustee." : "The investor is deciding how much to trust you.";
  return role === "trustee" ? `The investment was ${investment ?? 0}, giving you ${(investment ?? 0) * multiplier} to allocate.` : "The trustee is deciding how much of the multiplied investment to return.";
}
